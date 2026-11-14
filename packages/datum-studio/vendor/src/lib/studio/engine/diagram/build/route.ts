/**
 * Rute konektor (S30): port `route_edges` (:930), `_side_of` (:837), `_anchor`
 * (:852), `_rect_hit` (:870), `_blocked` (:968), `_detour` (:983) dan
 * `add_crossing_hops` (:1019) dari `HS/datum_diagram.py`.
 *
 * P5: jangkar dikipas pada sisi kotak, jalur ortogonal, detur mengelilingi
 * kotak tak terkait (gagal = DATUM-32), lompatan silang r 0,9 mm. Konektor
 * memakai sisi kotak simpul (bukan port simbol S31), sama seperti Python.
 * Simpul diiterasi dalam urutan sisip `Sheet.nodes` (dict Python): simpul
 * penghalang pertama menentukan detur.
 */
import type { DiagramEdge, RoutedEdge, StudioDiagramV1 } from "../../../contract";
import { DiagramDefect, LATTICE_Y, polylineD, snap, type Sheet, type SheetNode } from "../core";
import { diagramFitNote, diagramFitRoute } from "../fit/state";
import { nudgeRoutes, offRules, routeRulesOf } from "./lanesroute";
import { activeElkRoutes } from "../elk/routes";
import { edgeConflicts, ENTRY_COLLISION_MM, STUB_SEGMENT_MIN_MM } from "../fit/lint";
import { flowDirectionOf, flowRanks } from "../layout-a/flow";
import { ARROW_SIZES_MM, CURVE_SAMPLES } from "../core/tokens";
import { ANNOTATION_BRACKET_MM, isLabelBelow, isLabelBeside, labelBelowOutline, labelBesideBox, setLabelBeside } from "../fit/text";
import { clearFirstRender, noteFirstRender } from "./autofit";

type Pt = readonly [number, number];
type Side = "bottom" | "top" | "right" | "left";
const OPP: Readonly<Record<Side, Side>> = { bottom: "top", top: "bottom", right: "left", left: "right" };

/** Jalur dengan lompatan silang: titik pusat (x, y) pada lintasan horizontal jalur ini. */
export interface HoppedEdge extends RoutedEdge {
  hops: ReadonlyArray<readonly [number, number]>;
}

/**
 * Swarm 1.2.8 row 56 (VIS-4, AC-VIS4, 01f §3.3, register N8-254 / N8-469): the drawn route of an edge other than
 * today's orthogonal router. `orthogonal` written explicitly is the absent field (01f §3.2.2), so it gives undefined.
 */
export type EdgeRouteStyle = "straight" | "curved";

export function edgeRouteOf(e: Pick<DiagramEdge, "route"> | undefined): EdgeRouteStyle | undefined {
  const r = e?.route;
  return r === "straight" || r === "curved" ? r : undefined;
}

/** Row 56: a routed edge carries its style (spread copies in build keep it), read for `data-route` and hops. */
export function routeStyleOfPath(p: RoutedEdge): EdgeRouteStyle | undefined {
  const r = (p as RoutedEdge & { route?: unknown }).route;
  return r === "straight" || r === "curved" ? r : undefined;
}

/** Outward unit normal of a node side (sheet y grows downwards). */
const NORMAL: Readonly<Record<Side, Pt>> = { bottom: [0, 1], top: [0, -1], right: [1, 0], left: [-1, 0] };

/**
 * Row 56 (VIS-4, 01f §3.3 `curved`, D-V2): cubic Bezier P0 -> P3 with P1 = P0 + n0 k, P2 = P3 + n3 k (n = outward
 * normal of the side, k = 0.4 x chord), emitted as a polyline of `CURVE_SAMPLES` equal-parameter segments
 * (`CURVE_SAMPLES` + 1 points). The second and the second-to-last sample are projected onto the normal through their
 * end (they lie within 3h^2 x lateral offset of it, h = 1 / CURVE_SAMPLES: under 0.1 mm on an A4 figure), so the
 * first and last segments meet the sides head-on and the arrowhead keeps its tangent.
 */
export function curvedPoints(p: Pt, sa: Side, q: Pt, sb: Side, samples: number = CURVE_SAMPLES): Pt[] {
  const n0 = NORMAL[sa];
  const n3 = NORMAL[sb];
  const k = 0.4 * Math.hypot(q[0] - p[0], q[1] - p[1]);
  const p1: Pt = [p[0] + n0[0] * k, p[1] + n0[1] * k];
  const p2: Pt = [q[0] + n3[0] * k, q[1] + n3[1] * k];
  const out: Pt[] = [];
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const u = 1 - t;
    const b0 = u * u * u;
    const b1 = 3 * u * u * t;
    const b2 = 3 * u * t * t;
    const b3 = t * t * t;
    out.push([b0 * p[0] + b1 * p1[0] + b2 * p2[0] + b3 * q[0], b0 * p[1] + b1 * p1[1] + b2 * p2[1] + b3 * q[1]]);
  }
  out[0] = p;
  out[samples] = q;
  const onNormal = (end: Pt, n: Pt, s: Pt): Pt => {
    const d = (s[0] - end[0]) * n[0] + (s[1] - end[1]) * n[1];
    return [end[0] + n[0] * d, end[1] + n[1] * d];
  };
  if (samples >= 2) {
    out[1] = onNormal(p, n0, out[1]);
    out[samples - 1] = onNormal(q, n3, out[samples - 1]);
  }
  return out;
}

/**
 * Swarm 1.2.8 row 56b (VIS-5, AC-VIS5, 01f §3.1, §3.3 "Glue sides" / "Slots", register N8-256, N8-257): the side an end
 * is glued to ("auto" and absent = the router's choice) and the slot along it (0 < v < 1, only with a side). A bus keeps
 * its fixed taps (the spec refuses a side there, P1-edge-style; the router ignores it).
 */
function sideField(e: DiagramEdge, end: "from" | "to"): Side | undefined {
  const v = end === "from" ? e.from_side : e.to_side;
  return v === "top" || v === "right" || v === "bottom" || v === "left" ? v : undefined;
}

function slotField(e: DiagramEdge, end: "from" | "to"): number | undefined {
  const v = end === "from" ? e.from_slot : e.to_slot;
  return typeof v === "number" && v > 0 && v < 1 && sideField(e, end) ? v : undefined;
}

/** Row 56b (VIS-6, N8-258): bend points of an edge; absent or empty = the router owns every bend. */
function viaOf(e: DiagramEdge): ReadonlyArray<{ col: number; row: number }> | undefined {
  return Array.isArray(e.via) && e.via.length > 0 ? e.via : undefined;
}

/** Row 56b: an edge whose geometry the author fixed (side, slot or via) is never rerouted, fanned or lane-nudged. */
function glued(e: DiagramEdge): boolean {
  return sideField(e, "from") !== undefined || sideField(e, "to") !== undefined || viaOf(e) !== undefined;
}

/** Row 56b: the explicit sides of `e` over the router's pair (a bus end keeps its tap side). */
function withSides(e: DiagramEdge, pair: SidePair, a: SheetNode, b: SheetNode): SidePair {
  const sa = a.spec.shape === "bus" ? undefined : sideField(e, "from");
  const sb = b.spec.shape === "bus" ? undefined : sideField(e, "to");
  return sa === undefined && sb === undefined ? pair : [sa ?? pair[0], sb ?? pair[1]];
}

/**
 * Row 56b (VIS-5): the end at fraction `f` along `side` (left to right on top/bottom, top to bottom on left/right). An
 * event/gateway measures along its outline (row 54); `glueEnd` then moves the end from the cell onto the outline.
 */
function slotAnchor(node: SheetNode, side: Side, f: number): Pt {
  if (isLabelBelow(node.spec.shape)) {
    const o = labelBelowOutline(node);
    if (side === "right" || side === "left") return [side === "right" ? node.x + node.w : node.x, o.y + o.h * f];
    return [o.x + o.w * f, side === "top" ? node.y : node.y + node.h];
  }
  if (side === "bottom") return [node.x + node.w * f, node.y + node.h];
  if (side === "top") return [node.x + node.w * f, node.y];
  if (side === "right") return [node.x + node.w, node.y + node.h * f];
  return [node.x, node.y + node.h * f];
}

/**
 * Row 56b (VIS-6, R18-5, register N8-472): the layout lattice `via` is mapped on: x = col x col_mm, y = row x row_mm from
 * the top-left of the laid-out sheet (`geometry.ts` lattice), the sheet in whole lattice units and each node's cell.
 * The figure preview returns it as `figure.lattice`. A graph sheet fitted to its content (D-290) moves nodes and routes
 * by the same offset, so via points keep their place relative to the nodes.
 */
export interface RouteLattice {
  col_mm: number;
  row_mm: number;
  cols: number;
  rows: number;
  nodes: Record<string, [number, number, number, number]>;
}

export function routeLattice(sheet: Sheet): RouteLattice {
  const r2 = (v: number) => Math.round(v * 100) / 100;
  const nodes: Record<string, [number, number, number, number]> = {};
  for (const n of sheet.nodes.values()) nodes[n.id] = [r2(n.x / sheet.colMm), r2(n.y / sheet.rowMm), r2((n.x + n.w) / sheet.colMm), r2((n.y + n.h) / sheet.rowMm)];
  return {
    col_mm: Math.round(sheet.colMm * 1e4) / 1e4,
    row_mm: Math.round(sheet.rowMm * 1e4) / 1e4,
    cols: Math.floor(sheet.widthMm / sheet.colMm + 1e-6),
    rows: Math.floor(sheet.heightMm / sheet.rowMm + 1e-6),
    nodes,
  };
}

/** Row 56b (D-V3, 01f §3.3 "via families"): families that take `via` (the spec check P3-via-family refuses the rest). */
export function viaFamily(s: Pick<StudioDiagramV1, "family"> & { direction?: unknown }): boolean {
  return s.family === "graph" || s.family === "swimlane" || (s.family === "flow" && s.direction === undefined);
}

/**
 * Row 56b (VIS-6, 01f §3.3 "via bounds"): via points in sheet mm. Build-level P1-via: a point outside the laid-out sheet
 * is refused (BY_CONSTRUCTION_FAILED) with the sheet size in lattice units. `curved` + via is refused here too
 * (P1-edge-style; the spec check refuses it first, row 52c).
 */
function viaPoints(e: DiagramEdge, i: number, sheet: Sheet): Pt[] | undefined {
  const via = viaOf(e);
  if (!via) return undefined;
  if (edgeRouteOf(e) === "curved") {
    throw new DiagramDefect('route "curved" tidak dapat digabung dengan via; pakai orthogonal atau straight (P1-edge-style)', { checkId: "P1-edge-style", pointer: `/edges/${i}/via` });
  }
  const lat = routeLattice(sheet);
  return via.map((v, j) => {
    if (!(v.col >= 0 && v.row >= 0 && v.col <= lat.cols && v.row <= lat.rows)) {
      throw new DiagramDefect(
        `via[${j}] {col ${v.col}, row ${v.row}} pada konektor ${e.from}->${e.to} di luar lembar ${lat.cols} x ${lat.rows} kisi (col 0..${lat.cols}, row 0..${lat.rows}); lihat figure.lattice pada pratinjau (P1-via)`,
        { checkId: "P1-via", pointer: `/edges/${i}/via/${j}` },
      );
    }
    return clampIn([v.col * sheet.colMm, v.row * sheet.rowMm], sheet);
  });
}

/**
 * Swarm 1.2.8 row 68a (C166 (2); user item 7, Visio minimum: everything inside the figure): least distance (mm) of a via
 * point, and of a via leg routed round its end node, from the figure edge. A via on the sheet border (col 0, row 0, the
 * last col or row) drew its connector on the figure edge, half of the line clipped and, with the caption above, in the
 * caption band; the point moves inside by this much (half a lattice row).
 */
export const EDGE_CLEAR_MM = LATTICE_Y / 2;

/** Row 68a: `v` moved inside the sheet box by `EDGE_CLEAR_MM` (an axis too small for the margin is left as it is). */
function clampIn(v: Pt, sheet: Sheet): Pt {
  const W = sheet.widthMm;
  const H = sheet.heightMm;
  const c = EDGE_CLEAR_MM;
  const x = Number.isFinite(W) && W > 2 * c ? Math.min(W - c, Math.max(c, v[0])) : v[0];
  const y = Number.isFinite(H) && H > 2 * c ? Math.min(H - c, Math.max(c, v[1])) : v[1];
  return [x, y];
}

/**
 * Row 68a (C166 (1)): the side of `n` that faces the point `v`: the side `v` lies furthest beyond (left, right, top or
 * bottom of the node box). Used for a via edge's ends the author did not glue, so the leg to or from the via leaves the
 * node towards it instead of through it.
 */
function facingSide(n: SheetNode, v: Pt): Side {
  const beyond: Array<[Side, number]> = [
    ["bottom", v[1] - (n.y + n.h)],
    ["top", n.y - v[1]],
    ["right", v[0] - (n.x + n.w)],
    ["left", n.x - v[0]],
  ];
  let best = beyond[0];
  for (const b of beyond.slice(1)) if (b[1] > best[1] + 1e-9) best = b;
  return best[0];
}

/**
 * Row 68a (C166 (1), (2)): the orthogonal leg from the end `p` on `side` of node `n` to the via point `v`. When `v` lies
 * at least `STUB_SEGMENT_MIN_MM` beyond the side, the leg runs along the side's normal first and then across (the
 * row 56b leg, same points). Otherwise it would cross the node or run along its border: it leaves by a stub of one lattice
 * row along the normal, then goes across to `v`'s line when `v` lies beside the node, or round the nearer end of the
 * side (one stub clear of the node) when `v` lies behind it, and back to `v`. Bends stay inside the figure
 * (`EDGE_CLEAR_MM`). For the leg into an end, reverse the result.
 */
function legOut(n: SheetNode, side: Side, p: Pt, v: Pt, sheet: Sheet): Pt[] {
  const N = NORMAL[side];
  const k = N[0] !== 0 ? 0 : 1; // normal axis
  const l = 1 - k; // lateral axis
  const at = (nk: number, lk: number): Pt => (k === 0 ? [nk, lk] : [lk, nk]);
  if ((v[k] - p[k]) * N[k] >= STUB_SEGMENT_MIN_MM) return [p, at(v[k], p[l]), v];
  const st = snap(LATTICE_Y, LATTICE_Y);
  const dims = [sheet.widthMm, sheet.heightMm];
  const inside = (val: number, axis: number) => {
    const d = dims[axis];
    return Number.isFinite(d) && d > 2 * EDGE_CLEAR_MM ? Math.min(d - EDGE_CLEAR_MM, Math.max(EDGE_CLEAR_MM, val)) : val;
  };
  const s = inside(p[k] + N[k] * st, k);
  const lo = l === 0 ? n.x : n.y;
  const hi = l === 0 ? n.x + n.w : n.y + n.h;
  const clear = 0.5;
  if (v[l] <= lo - clear || v[l] >= hi + clear) return [p, at(s, p[l]), at(s, v[l]), v];
  const c = inside(v[l] - lo <= hi - v[l] ? lo - st : hi + st, l);
  return [p, at(s, p[l]), at(s, c), at(v[k], c), v];
}

/**
 * Row 68a (C166 (1)): the straight leg from the end `p` on `side` of node `n` to the via point `v`. A leg that meets the
 * side below `STRAIGHT_END_MIN_DEG` (its arrowhead would lie along the border) or runs back through the node gets a
 * short orthogonal approach: one lattice row along the side's normal, then straight to `v`. Otherwise `[p]` (the row 56b
 * straight leg). For the leg into an end, reverse the result.
 */
function straightLeg(n: SheetNode, side: Side, p: Pt, v: Pt): Pt[] {
  const N = NORMAL[side];
  const ahead = (v[0] - p[0]) * N[0] + (v[1] - p[1]) * N[1];
  if (ahead > 1e-9 && incidenceDeg(v, p, side) >= STRAIGHT_END_MIN_DEG) return [p];
  const st = snap(LATTICE_Y, LATTICE_Y);
  return [p, [p[0] + N[0] * st, p[1] + N[1] * st]];
}

/**
 * Row 56b (VIS-6, 01f §3.3 "via"): anchor -> via1 -> ... -> anchor. `straight` joins the points with straight segments.
 * Orthogonal joins each pair with one L-leg: the first leg horizontal first when it leaves a left/right side (vertical
 * first otherwise), each next leg turns across the direction the previous one ended in (the via point is the bend), and
 * the last leg ends along the target side's normal (horizontal first into top/bottom), so the arrowhead meets the side.
 * Swarm 1.2.8 row 68a (C166): the first and the last leg never cross their end node (`legOut`, `straightLeg`), and via
 * points stay `EDGE_CLEAR_MM` inside the figure (`clampIn`).
 */
function viaRoute(p: Pt, sa: Side, vias: readonly Pt[], q: Pt, sb: Side, straight: boolean, a: SheetNode, b: SheetNode, sheet: Sheet): Pt[] {
  const dedupe = (out: readonly Pt[]) => out.filter((c, k) => k === 0 || Math.abs(c[0] - out[k - 1][0]) > 1e-9 || Math.abs(c[1] - out[k - 1][1]) > 1e-9);
  const v0 = vias[0];
  const vn = vias[vias.length - 1];
  if (straight) {
    // Row 68a (C166 (1)): an end leg that would graze its side or run back through its node gets an orthogonal approach.
    return dedupe([...straightLeg(a, sa, p, v0), ...vias, ...straightLeg(b, sb, q, vn).reverse()]);
  }
  // Row 68a (C166 (1), (2)): the first and the last leg leave / enter their node's side along its normal and never cross
  // the node (`legOut`); the legs between via points keep the row 56b alternation.
  const out: Pt[] = dedupe(legOut(a, sa, p, v0, sheet));
  const lastPiece = (pts: readonly Pt[]) => (pts.length >= 2 ? Math.abs(pts[pts.length - 1][0] - pts[pts.length - 2][0]) < 1e-9 : !(sa === "left" || sa === "right"));
  let horizFirst = lastPiece(out); // the first leg ended vertical: the next one starts across
  for (let k = 1; k < vias.length; k++) {
    const u = vias[k - 1];
    const w = vias[k];
    if (Math.abs(u[0] - w[0]) > 1e-9 && Math.abs(u[1] - w[1]) > 1e-9) out.push(horizFirst ? [w[0], u[1]] : [u[0], w[1]]);
    horizFirst = Math.abs(out[out.length - 1][0] - w[0]) < 1e-9;
    out.push(w);
  }
  out.push(...legOut(b, sb, q, vn, sheet).reverse().slice(1));
  return dedupe(out);
}

function sideOf(a: SheetNode, b: SheetNode): Side {
  const acx = a.x + a.w / 2.0;
  const acy = a.y + a.h / 2.0;
  const bcx = b.x + b.w / 2.0;
  const bcy = b.y + b.h / 2.0;
  const dx = bcx - acx;
  const dy = bcy - acy;
  // Rel bus selebar lembar: cabang lewat sisi horizontal (P2/E-17).
  if (a.spec.shape === "bus") return bcy > acy ? "bottom" : "top";
  // FIX-B2: edge simpul -> rel keluar dari sisi simpul yang MENGHADAP rel
  // (rel di bawah = bottom). Python `_side_of` :869-870 membaliknya ("top"
  // bila rel di bawah), sehingga pencatu rel hilir dirute menembus simpulnya
  // sendiri; tidak ada fixture Garis A dengan edge simpul -> rel.
  if (b.spec.shape === "bus") return bcy > acy ? "bottom" : "top";
  if (Math.abs(dy) >= Math.abs(dx)) return dy > 0 ? "bottom" : "top";
  return dx > 0 ? "right" : "left";
}

/** Jangkar dikipas; tap rel bus mendarat di garis tengah rel (E-17). */
function anchor(node: SheetNode, side: Side, slot: number, slots: number): Pt {
  const frac = (slot + 1.0) / (slots + 1.0);
  if (node.spec.shape === "bus" && (side === "bottom" || side === "top")) {
    return [node.x + node.w * frac, node.y + node.h / 2.0];
  }
  // Swarm 1.2.8 row 54 (VIS-3a, §5.3): a BPMN event/gateway connects on its fixed outline at the top of the cell: side
  // ends at the outline's centre height, top/bottom ends fanned over the middle half of the outline width. `glueEnd`
  // then moves each end from the cell box onto the outline (a bottom end stays under the label block).
  if (isLabelBelow(node.spec.shape)) {
    const o = labelBelowOutline(node);
    // Row 54b (VIS-3b, C86): several ends on one side are spread over the middle of the outline height (+-0.45 x half
    // size), so two exits of a gateway never share its vertex; one end stays at the centre height (row 54 bytes).
    const spread = slots > 1 ? (o.h / 2) * SIDE_SPREAD_FRAC * ((2 * slot) / (slots - 1) - 1) : 0;
    if (side === "right" || side === "left") return [side === "right" ? node.x + node.w : node.x, o.y + o.h / 2 + spread];
    const x = o.x + o.w * (0.25 + 0.5 * frac);
    return [x, side === "top" ? node.y : node.y + node.h];
  }
  // Row 54b (VIS-3b, 01f §1.3): a text annotation connects on its bracket: top/bottom ends on the bracket arm.
  if (node.spec.shape === "annotation" && (side === "top" || side === "bottom")) {
    return [node.x + ANNOTATION_BRACKET_MM / 2, side === "top" ? node.y : node.y + node.h];
  }
  if (side === "bottom") return [node.x + node.w * frac, node.y + node.h];
  if (side === "top") return [node.x + node.w * frac, node.y];
  if (side === "right") return [node.x + node.w, node.y + node.h * frac];
  return [node.x, node.y + node.h * frac];
}

/** Row 54b (C86): share of the half outline height over which side ends of a label-below node are spread. */
const SIDE_SPREAD_FRAC = 0.45;

/**
 * Swarm 1.2.8 row 53 (VIS-1b, 01f §1.1, connection points): the bottom side of a document is its wave and the bottom of an
 * off-page reference its point, not the node box. A connector end on the box bottom (x inside the box) whose last piece is
 * vertical is moved up onto that outline at the same x (same fractions as `core/svg.ts`: wave a = 0.08 h around
 * y + h - a, one sine period, right half up; pentagon sides straight to 0.7 h). Other shapes and ends: unchanged.
 */
function outlineBottomY(node: SheetNode, x: number): number | null {
  const { x: nx, y, w, h } = node;
  if (!(w > 0) || x < nx - 1e-6 || x > nx + w + 1e-6) return null;
  if (node.spec.shape === "document") {
    const a = h * 0.08;
    return y + h - a - a * Math.sin((2 * Math.PI * (nx + w - x)) / w);
  }
  if (node.spec.shape === "offpage") return y + h - h * 0.3 * (Math.abs(x - (nx + w / 2)) / (w / 2));
  return null;
}
function glueEnd(pts: Pt[], node: SheetNode, atEnd: boolean): Pt[] {
  if (pts.length >= 2 && isLabelBelow(node.spec.shape)) return glueLabelBelow(pts, node, atEnd);
  if (pts.length >= 2 && OUTLINE_SHAPES.has(node.spec.shape ?? "")) return glueOutline(pts, node, atEnd);
  if (pts.length < 2 || (node.spec.shape !== "document" && node.spec.shape !== "offpage")) return pts;
  const k = atEnd ? pts.length - 1 : 0;
  const nb = atEnd ? pts.length - 2 : 1;
  const p = pts[k];
  if (Math.abs(p[1] - (node.y + node.h)) > 1e-6 || Math.abs(pts[nb][0] - p[0]) > 1e-6) return pts;
  const yy = outlineBottomY(node, p[0]);
  if (yy === null || Math.abs(yy - p[1]) < 1e-9) return pts;
  const out = [...pts];
  out[k] = [p[0], yy];
  return out;
}
/**
 * Swarm 1.2.8 row 56c (C51, C75, C101; user item 7, Visio minimum): shapes whose outline leaves the node box on a side,
 * so a connector end on the box would stop short of the drawn line. Fractions as `core/svg.ts` draws them: diamond
 * vertices at the side midpoints; cylinder lid and base = front half of an ellipse of ry = 0.16 h; circle r = min(w, h)/2
 * centred; stadium caps of radius h/2; hexagon corner inset 0.22 w; parallelogram slant 0.18 w (top edge shifted right).
 */
const OUTLINE_SHAPES: ReadonlySet<string> = new Set(["diamond", "cylinder", "circle", "stadium", "hexagon", "parallelogram"]);
/**
 * Row 56c (C101): a diamond side flatter than this (deg from the horizontal) takes no horizontal arrowhead: the head's
 * half-angle (atan(0.89 / 2) = 24 deg, row 57 `arrowMarkerSvg`) plus 10 deg clearance.
 */
const DIAMOND_HEAD_CLEAR_DEG = 34;
/**
 * Row 56c: shortest last piece of a connector re-ended on a diamond (the drop onto a shallow side, the run into a
 * neighbouring vertex): the default arrowhead (`ARROW_SIZES_MM.m`, row 57) plus 0.5 mm of line behind it.
 */
const HEAD_RUN_MM = ARROW_SIZES_MM.m + 0.5;

/** Row 56c: y of the drawn outline on the vertical line at x (top = upper outline), or null when x misses it. */
function outlineYAt(node: SheetNode, x: number, top: boolean): number | null {
  const { x: nx, y, w, h } = node;
  const cx = nx + w / 2;
  const cy = y + h / 2;
  const dx = Math.abs(x - cx);
  if (!(w > 0 && h > 0) || dx > w / 2 + 1e-6) return null;
  const sgn = top ? -1 : 1;
  switch (node.spec.shape) {
    case "diamond":
      return cy + sgn * (h / 2) * Math.max(0, 1 - dx / (w / 2));
    case "cylinder": {
      const ry = h * 0.16;
      const u = Math.min(1, dx / (w / 2));
      const rim = ry * Math.sqrt(1 - u * u); // front half of the lid / base ellipse
      return top ? y + ry + rim : y + h - ry + rim;
    }
    case "circle": {
      const r = Math.min(w, h) / 2;
      return dx >= r ? null : cy + sgn * Math.sqrt(r * r - dx * dx);
    }
    case "stadium": {
      const r = h / 2;
      const flat = w / 2 - r;
      if (dx <= flat) return top ? y : y + h;
      const d = dx - flat;
      return d >= r ? null : cy + sgn * Math.sqrt(r * r - d * d);
    }
    case "hexagon": {
      const k = w * 0.22;
      const edge = Math.min(x - nx, nx + w - x); // distance from the nearer side vertex column
      return edge >= k ? (top ? y : y + h) : cy + sgn * (h / 2) * Math.max(0, edge / k);
    }
    case "parallelogram": {
      const k = w * 0.18;
      if (top) return x >= nx + k ? y : y + h * Math.max(0, 1 - (x - nx) / k);
      return x <= nx + w - k ? y + h : y + h * Math.max(0, (nx + w - x) / k);
    }
    default:
      return null;
  }
}

/** Row 56c: x of the drawn outline on the horizontal line at height yy (left = left outline), or null when yy misses it. */
function outlineXAt(node: SheetNode, yy: number, left: boolean): number | null {
  const { x, y, w, h } = node;
  const cx = x + w / 2;
  const cy = y + h / 2;
  const dy = Math.abs(yy - cy);
  if (!(w > 0 && h > 0) || dy > h / 2 + 1e-6) return null;
  const sgn = left ? -1 : 1;
  switch (node.spec.shape) {
    case "diamond":
      return cx + sgn * (w / 2) * Math.max(0, 1 - dy / (h / 2));
    case "circle": {
      const r = Math.min(w, h) / 2;
      return dy >= r ? null : cx + sgn * Math.sqrt(r * r - dy * dy);
    }
    case "stadium": {
      const r = h / 2;
      return cx + sgn * (w / 2 - r + Math.sqrt(Math.max(0, r * r - dy * dy)));
    }
    case "hexagon": {
      const k = w * 0.22;
      return left ? x + k * (dy / (h / 2)) : x + w - k * (dy / (h / 2));
    }
    case "parallelogram": {
      const k = w * 0.18;
      const t = Math.min(1, Math.max(0, (yy - y) / h));
      return left ? x + k * (1 - t) : x + w - k * t;
    }
    default:
      return null; // cylinder: the body sides are the box sides
  }
}

/**
 * Row 56c (defects 2, 3): a connector end on the node box of an `OUTLINE_SHAPES` node lands on the drawn outline. An end
 * on the box top/bottom whose first piece is vertical moves along it to the outline at the same x (diamond side, the
 * front rim of a cylinder lid, a circle); an end on the box left/right whose first piece is horizontal moves to the
 * outline at the same y (diamond side, circle, stadium cap, hexagon/parallelogram slant). Both keep the piece's
 * direction, so the route stays orthogonal. Diagonal (straight) ends and ends elsewhere: unchanged.
 */
function glueOutline(pts: Pt[], node: SheetNode, atEnd: boolean): Pt[] {
  const k = atEnd ? pts.length - 1 : 0;
  const step = atEnd ? -1 : 1;
  const p = pts[k];
  let nb = k + step;
  while (nb >= 0 && nb < pts.length && Math.abs(pts[nb][0] - p[0]) < 1e-9 && Math.abs(pts[nb][1] - p[1]) < 1e-9) nb += step;
  if (nb < 0 || nb >= pts.length) return pts;
  const q = pts[nb];
  const vertical = Math.abs(q[0] - p[0]) < 1e-6;
  const horizontal = Math.abs(q[1] - p[1]) < 1e-6;
  let np: Pt | null = null;
  const onTop = Math.abs(p[1] - node.y) < 1e-6;
  const onBottom = Math.abs(p[1] - (node.y + node.h)) < 1e-6;
  const onLeft = Math.abs(p[0] - node.x) < 1e-6;
  const onRight = Math.abs(p[0] - (node.x + node.w)) < 1e-6;
  if (vertical && (onTop || onBottom) && (onTop ? q[1] < p[1] : q[1] > p[1])) {
    const yy = outlineYAt(node, p[0], onTop);
    if (yy !== null) np = [p[0], yy];
  } else if (horizontal && (onLeft || onRight) && (onLeft ? q[0] < p[0] : q[0] > p[0])) {
    const cy = node.y + node.h / 2;
    const dy = Math.abs(p[1] - cy);
    const shallow = (Math.atan2(node.h, node.w) * 180) / Math.PI < DIAMOND_HEAD_CLEAR_DEG;
    if (atEnd && node.spec.shape === "diamond" && shallow && dy > 1e-6) {
      // Row 56c (C101, defect 4): a horizontal arrowhead on a shallow diamond side would lie across the slanted line. The
      // entry turns before the outline and drops onto the side from outside (along the box normal, at 90 - slope degrees).
      // the drop ends at least half `ENTRY_COLLISION_MM` (+ 0.05) from the vertex height, so a mirrored entry stays apart
      const d = Math.min(dy - ENTRY_COLLISION_MM / 2 - 0.05, HEAD_RUN_MM);
      if (d >= HEAD_RUN_MM - 1e-9) {
        const y2 = p[1] + Math.sign(cy - p[1]) * d;
        const x2 = outlineXAt(node, y2, onLeft);
        if (x2 !== null) {
          return [...pts.slice(0, nb + 1), [x2, p[1]], [x2, y2]];
        }
      }
    }
    const xx = outlineXAt(node, p[1], onLeft);
    if (xx !== null) np = [xx, p[1]];
  }
  if (!np || Math.hypot(np[0] - p[0], np[1] - p[1]) < 1e-9) return pts;
  const out = [...pts];
  // the repeated end points of a zero-length stub move with the end
  for (let i = k; i !== nb; i += step) out[i] = np;
  return out;
}

/**
 * Row 54 (VIS-3a, §5.3): an end on the cell box of a BPMN event/gateway lands on its outline. A horizontal last piece
 * whose y crosses the outline is extended to the outline at that y (circle or diamond); one that misses it (ELK end at
 * the cell centre) is moved, with its horizontal run back to the last bend, to the outline's centre height, or gets a
 * jog at its middle when the run is the whole route. A vertical end on the cell top moves down onto the outline at the
 * same x. An end on the cell bottom stays there: moving it up would draw the connector through the label block.
 */
function glueLabelBelow(pts: Pt[], node: SheetNode, atEnd: boolean): Pt[] {
  const o = labelBelowOutline(node);
  const cx = o.x + o.w / 2;
  const cy = o.y + o.h / 2;
  const R = o.w / 2;
  const diamond = node.spec.shape?.startsWith("gateway_") === true;
  // half-width of the outline at height y (circle chord or diamond), null outside it
  const halfAt = (y: number): number | null => {
    const dy = Math.abs(y - cy);
    if (dy >= R - 1e-9) return null;
    return diamond ? R - dy : Math.sqrt(R * R - dy * dy);
  };
  const out = atEnd ? [...pts].reverse() : [...pts];
  // row 54b: repeated end points (zero-length stub pieces) do not count as the first piece
  while (out.length > 2 && Math.abs(out[1][0] - out[0][0]) < 1e-9 && Math.abs(out[1][1] - out[0][1]) < 1e-9) out.splice(1, 1);
  const p = out[0];
  const q = out[1];
  const onSide = Math.abs(p[0] - node.x) < 1e-6 || Math.abs(p[0] - (node.x + node.w)) < 1e-6;
  // Row 54b (VIS-3b): a detour can leave a side end vertically along the cell edge; it then gets a horizontal piece
  // from the outline (at its height when that is within half the outline, else at the centre height) to the cell edge.
  if (onSide && Math.abs(q[0] - p[0]) < 1e-6 && Math.abs(q[1] - p[1]) > 1e-9) {
    const sign = p[0] > cx ? 1 : -1;
    const y = halfAt(p[1]) !== null && Math.abs(p[1] - cy) <= R * 0.5 ? p[1] : cy;
    out.splice(0, 1, [cx + sign * (halfAt(y) ?? 0), y], [p[0], y]);
    return atEnd ? out.reverse() : out;
  }
  if (onSide && Math.abs(q[1] - p[1]) < 1e-6 && Math.abs(q[0] - p[0]) > 1e-9) {
    const sign = p[0] > cx ? 1 : -1;
    let y = p[1];
    if (halfAt(y) === null || Math.abs(y - cy) > R * 0.5) {
      // move the horizontal run to the centre height (keep the other end and the bends axis-aligned)
      let k = 0;
      while (k + 1 < out.length && Math.abs(out[k + 1][1] - p[1]) < 1e-6) k++;
      if (k === out.length - 1) {
        const mx = (out[0][0] + out[k][0]) / 2;
        out.splice(1, k - 1, [mx, cy], [mx, p[1]]);
        out[0] = [p[0], cy];
      } else {
        for (let i = 0; i <= k; i++) out[i] = [out[i][0], cy];
      }
      y = cy;
    }
    out[0] = [cx + sign * (halfAt(y) ?? 0), y];
    return atEnd ? out.reverse() : out;
  }
  if (Math.abs(p[1] - node.y) < 1e-6 && Math.abs(q[0] - p[0]) < 1e-6) {
    const hw = Math.abs(p[0] - cx);
    if (hw >= R - 1e-9) return pts;
    const top = diamond ? cy - (R - hw) : cy - Math.sqrt(R * R - hw * hw);
    out[0] = [p[0], top];
    return atEnd ? out.reverse() : out;
  }
  // Row 57c (C86): with the label beside the circle, a vertical end on the cell bottom moves up onto the circle.
  if (isLabelBeside(node) && Math.abs(p[1] - (node.y + node.h)) < 1e-6 && Math.abs(q[0] - p[0]) < 1e-6) {
    const hw = Math.abs(p[0] - cx);
    if (hw >= R - 1e-9) return pts;
    out[0] = [p[0], diamond ? cy + (R - hw) : cy + Math.sqrt(R * R - hw * hw)];
    return atEnd ? out.reverse() : out;
  }
  return pts;
}

/**
 * Row 57c (C86): mark the event nodes labelled beside their circle (`setLabelBeside`): an event without tag and mark,
 * at least one end on its bottom and none on its right, whose beside block stays on the sheet and clear (0.5 mm) of
 * every other node. All other label-below nodes are unmarked (labels below, as before).
 */
function markLabelBeside(sheet: Sheet, nodes: readonly SheetNode[], ends: ReadonlyArray<readonly [DiagramEdge, SidePair]>): void {
  for (const nd of nodes) {
    if (!isLabelBelow(nd.spec.shape)) continue;
    let on = nd.spec.shape?.startsWith("event_") === true && !nd.spec.tag && !nd.spec.mark;
    if (on) {
      const sidesHere = ends.flatMap(([e, [sa, sb]]) => [...(e.from === nd.id ? [sa] : []), ...(e.to === nd.id ? [sb] : [])]);
      on = sidesHere.includes("bottom") && !sidesHere.includes("right");
    }
    if (on) {
      const b = labelBesideBox(nd);
      on = b[2] <= sheet.widthMm - 0.5 && nodes.every((o) => o === nd || b[2] + 0.5 <= o.x || b[0] - 0.5 >= o.x + o.w || b[3] + 0.5 <= o.y || b[1] - 0.5 >= o.y + o.h);
    }
    setLabelBeside(nd, on);
  }
}

/** Row 53: `glueEnd` over routes built elsewhere (ELK); `d` is rebuilt only for a moved edge. */
function glueToOutlines(routes: RoutedEdge[], sheet: Sheet): RoutedEdge[] {
  return routes.map((r) => {
    const pts = r.points as Pt[];
    const glued = glueEnd(glueEnd(pts, nodeOf(sheet, r.from), false), nodeOf(sheet, r.to), true);
    return glued === pts ? r : { ...r, points: glued, d: polylineD(glued) };
  });
}

function rectHit(p: Pt, q: Pt, node: SheetNode, pad = 0.05): boolean {
  const x1 = node.x + pad;
  const y1 = node.y + pad;
  const x2 = node.x + node.w - pad;
  const y2 = node.y + node.h - pad;
  const [ax, ay] = p;
  const [bx, by] = q;
  if (Math.abs(ay - by) < 1e-9) return Math.min(ax, bx) < x2 && Math.max(ax, bx) > x1 && y1 < ay && ay < y2;
  if (Math.abs(ax - bx) < 1e-9) return Math.min(ay, by) < y2 && Math.max(ay, by) > y1 && x1 < ax && ax < x2;
  const steps = 24; // diagonal pendek: sampling
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const sx = ax + (bx - ax) * t;
    const sy = ay + (by - ay) * t;
    if (x1 < sx && sx < x2 && y1 < sy && sy < y2) return true;
  }
  return false;
}

const OUTSIDE = { id: "<luar lembar>" } as const;

function blocked(pts: readonly Pt[], ends: readonly [string, string], nodes: readonly SheetNode[], W: number): SheetNode | typeof OUTSIDE | null {
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    for (const [px, py] of [a, b]) {
      if (px < -1e-6 || px > W + 1e-6 || py < -1e-6) return OUTSIDE;
    }
    for (const nd of nodes) {
      if (nd.id === ends[0] || nd.id === ends[1]) continue;
      if (rectHit(a, b, nd)) return nd;
    }
  }
  return null;
}

/**
 * Row 68a (C166 (4)): the first visible piece of `pts` runs along the normal of `sa` and the last along the normal of
 * `sb` (repeated points skipped), i.e. the route leaves and enters its sides head-on.
 */
function normalEnds(pts: readonly Pt[], sa: Side, sb: Side): boolean {
  return endNormal(pts, sa, true) && endNormal(pts, sb, false);
}

/** Row 68a: the first (`atStart`) or the last visible piece of `pts` runs out of `side` along its normal. */
function endNormal(pts: readonly Pt[], side: Side, atStart: boolean): boolean {
  const from = atStart ? 0 : pts.length - 1;
  const step = atStart ? 1 : -1;
  const p = pts[from];
  for (let j = from + step; j >= 0 && j < pts.length; j += step) {
    const d: Pt = [pts[j][0] - p[0], pts[j][1] - p[1]];
    if (Math.hypot(d[0], d[1]) <= 1e-9) continue;
    const N = NORMAL[side];
    return Math.abs(d[0] * N[1] - d[1] * N[0]) < 1e-6 && d[0] * N[0] + d[1] * N[1] > 0;
  }
  return false;
}

/** Row 68a: two consecutive visible pieces of `pts` run in opposite directions on one line (an out-and-back spike). */
function doublesBack(pts: readonly Pt[]): boolean {
  const d: Pt[] = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const v: Pt = [pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]];
    if (Math.hypot(v[0], v[1]) > 1e-9) d.push(v);
  }
  for (let i = 0; i + 1 < d.length; i++) {
    const [a, b] = [d[i], d[i + 1]];
    if (Math.abs(a[0] * b[1] - a[1] * b[0]) < 1e-6 && a[0] * b[0] + a[1] * b[1] < 0) return true;
  }
  return false;
}

function manhattan(c: readonly Pt[]): number {
  let sum = 0;
  for (let i = 0; i + 1 < c.length; i++) sum += Math.abs(c[i + 1][0] - c[i][0]) + Math.abs(c[i + 1][1] - c[i][1]);
  return sum;
}

/** HS `_detour`: hingga 6 percobaan; kandidat bersih terpendek (min pertama); gagal = DATUM-32. */
/** `lx` = kisi horizontal lembar (`Sheet.colMm`; A4 = `LATTICE_X`, D-245). */
function detour(pts: readonly Pt[], ends: readonly [string, string], nodes: readonly SheetNode[], W: number, lx: number): Pt[] {
  let cur: Pt[] = [...pts];
  for (let attempt = 0; attempt < 6; attempt++) {
    const hit = blocked(cur, ends, nodes, W);
    if (hit === null) return cur;
    if (!("y" in hit)) break; // luar lembar: tidak ada kotak untuk dikelilingi
    const start = cur[0];
    const end = cur[cur.length - 1];
    const pad = snap(LATTICE_Y * 2, LATTICE_Y);
    const below = snap(hit.y + hit.h + pad, LATTICE_Y);
    const above = snap(hit.y - pad, LATTICE_Y);
    const right = snap(hit.x + hit.w + pad, lx);
    const left = snap(hit.x - pad, lx);
    const cands: Pt[][] = [];
    for (const cy of [below, above]) {
      if (cy >= 0) {
        cands.push([start, [start[0], cy], [end[0], cy], end]);
        cands.push([start, [start[0], cy], [right, cy], [right, end[1]], end]);
        cands.push([start, [start[0], cy], [left, cy], [left, end[1]], end]);
      }
    }
    for (const cx of [right, left]) {
      if (cx >= 0) cands.push([start, [cx, start[1]], [cx, end[1]], end]);
    }
    const ok = cands.filter((c) => blocked(c, ends, nodes, W) === null);
    if (!ok.length) break;
    let best = ok[0];
    let bestLen = manhattan(best);
    for (const c of ok.slice(1)) {
      const len = manhattan(c);
      if (len < bestLen) {
        best = c;
        bestLen = len;
      }
    }
    cur = best;
  }
  const hit = blocked(cur, ends, nodes, W);
  if (hit === null) return cur;
  throw new DiagramDefect(
    `DATUM-32: konektor ${ends[0]}->${ends[1]} terpaksa menembus kotak tak terkait '${hit.id}' dan detur gagal (P5/P8)`,
    { checkId: "DATUM-32" },
  );
}

/**
 * FIG-02b2: saat fit dengan cacat rute terukur, lintasan tengah yang dikunci kisi tetapi jatuh di
 * luar rentang kedua stub (sering tepat di garis tepi simpul) diganti titik tengah tanpa kunci kisi.
 */
function between(m: number, a: number, b: number, on: boolean): number {
  if (!on) return m;
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  if (m >= lo - 1e-6 && m <= hi + 1e-6) return m;
  return Number(((a + b) / 2.0).toFixed(3));
}

/** Python `list.index(e)`: indeks elemen pertama yang sama nilainya. */
function indexOfEdge(list: readonly DiagramEdge[], e: DiagramEdge): number {
  return list.findIndex((x) => x === e || (x.from === e.from && x.to === e.to && x.kind === e.kind && x.label === e.label));
}

function nodeOf(sheet: Sheet, id: string): SheetNode {
  const n = sheet.nodes.get(id);
  if (!n) throw new DiagramDefect(`konektor merujuk simpul yang tidak ditempatkan: ${id} (P1/P8)`, { checkId: "DATUM-24" });
  return n;
}

/**
 * FIG-02b2: rute rak di sisi kanan badan rak (hanya saat fit dan bila lint render pertama mengukur
 * garis menembus teks). Konektor keluar dari sisi kanan perangkat (jangkar dikipas), berjalan tegak
 * pada jalur sendiri di kanan rak (rentang terpendek paling dalam, tanpa silang), lalu masuk ke sisi
 * kanan perangkat tujuan. Tidak pernah melewati label perangkat di antaranya.
 */
function routeRackSide(s: StudioDiagramV1, sheet: Sheet): RoutedEdge[] {
  const edges = s.edges ?? [];
  const right = Math.max(...[...sheet.nodes.values()].map((n) => n.x + n.w));
  const per = new Map<string, DiagramEdge[]>();
  for (const e of edges) for (const id of [e.from, e.to]) per.set(id, [...(per.get(id) ?? []), e]);
  const cy = (id: string) => nodeOf(sheet, id).y + nodeOf(sheet, id).h / 2;
  const span = (e: DiagramEdge) => Math.abs(cy(e.from) - cy(e.to));
  const rank = edges.map((e, i) => ({ e, i })).sort((a, b) => span(a.e) - span(b.e) || a.i - b.i);
  const lane = new Map(rank.map((r, k) => [r.e, k]));
  const step = snap(LATTICE_Y, LATTICE_Y);
  return edges.map((e) => {
    const end = (id: string): Pt => {
      const g = per.get(id)!.slice().sort((a, b) => lane.get(a)! - lane.get(b)!);
      return anchor(nodeOf(sheet, id), "right", g.indexOf(e), g.length);
    };
    const p = end(e.from);
    const q = end(e.to);
    const lx = right + step * (lane.get(e)! + 1);
    const pts: Pt[] = [p, [lx, p[1]], [lx, q[1]], q];
    return { from: e.from, to: e.to, kind: e.kind, label: e.label, points: pts, d: polylineD(pts) };
  });
}

/**
 * Swarm patch (row 124, CP-41; manual Rev A 10.3 and DT-01b, ID p.62-63): a connector may not run
 * through the interior of its OWN two boxes either. The original `blocked` skipped both end boxes,
 * so a route whose stubs point away from each other (case 04 `srv -> op`: right side of the server,
 * left side of the console, console's left edge left of the server's right edge) doubled back
 * through the server box and ended inside the console box.
 */
function throughEnds(pts: readonly Pt[], a: SheetNode, b: SheetNode): boolean {
  // A bus tap lands on the bus centre line by design (E-17): the bus is never an end box here.
  // Row 54b (VIS-3b): an event/gateway end is glued onto its outline inside its cell, so its own box is the core of the
  // outline (half its size, centred): a glued end (on the circle, or on a diamond side within the spread band) lies outside.
  const core = (n: SheetNode): SheetNode => {
    const o = labelBelowOutline(n);
    return { ...n, x: o.x + o.w / 4, y: o.y + o.h / 4, w: o.w / 2, h: o.h / 2 };
  };
  const ends = [a, b].filter((n) => n.spec.shape !== "bus").map((n) => (isLabelBelow(n.spec.shape) ? core(n) : n));
  // Row 56c: an end glued onto an `OUTLINE_SHAPES` outline lies inside its box; it is checked from the box side it entered.
  const chk = boxEnds(boxEnds(pts, a, false), b, true);
  for (let i = 0; i + 1 < chk.length; i++) if (ends.some((n) => rectHit(chk[i], chk[i + 1], n))) return true;
  return false;
}

/** Row 56c: `glueOutline` undone for the box checks: an axis-aligned end piece entering the box ends on the box side. */
function boxEnds(pts: readonly Pt[], node: SheetNode, atEnd: boolean): readonly Pt[] {
  if (pts.length < 2 || !OUTLINE_SHAPES.has(node.spec.shape ?? "")) return pts;
  const inside = (c: Pt) => c[0] > node.x + 1e-6 && c[0] < node.x + node.w - 1e-6 && c[1] > node.y + 1e-6 && c[1] < node.y + node.h - 1e-6;
  const seq = atEnd ? [...pts].reverse() : [...pts];
  // the glued tail (one point, or the turn and drop onto a shallow diamond side) lies inside the box
  let j = 0;
  while (j + 1 < seq.length && inside(seq[j])) j++;
  if (j === 0 || j === seq.length - 1 && inside(seq[j])) return pts;
  const p = seq[j - 1];
  const q = seq[j];
  let np: Pt | null = null;
  if (Math.abs(q[0] - p[0]) < 1e-6 && (q[1] <= node.y || q[1] >= node.y + node.h)) np = [p[0], q[1] <= node.y ? node.y : node.y + node.h];
  else if (Math.abs(q[1] - p[1]) < 1e-6 && (q[0] <= node.x || q[0] >= node.x + node.w)) np = [q[0] <= node.x ? node.x : node.x + node.w, p[1]];
  if (!np) return pts;
  const out = [np, ...seq.slice(j)];
  return atEnd ? out.reverse() : out;
}

type SidePair = readonly [Side, Side];

/**
 * Swarm 1.2.8 row 54 (VIS-3a, §5.3): the bottom of a BPMN event/gateway cell is under its label block, so an end there
 * cannot touch the outline (and an arrowhead would point at the label). When the other node lies beside the outline
 * (centre offset beyond the outline half-width plus one stub), that end uses the side facing it instead: the route
 * becomes an L (`cornerRoute`) that meets the outline at its centre height. Directly above/below: unchanged.
 */
function belowSides(pair: SidePair, a: SheetNode, b: SheetNode): SidePair {
  const facing = (n: SheetNode, other: SheetNode): Side | null => {
    const o = labelBelowOutline(n);
    const dx = other.x + other.w / 2 - (o.x + o.w / 2);
    return Math.abs(dx) > o.w / 2 + LATTICE_Y ? (dx > 0 ? "right" : "left") : null;
  };
  let [sa, sb] = pair;
  if (sa === "bottom" && isLabelBelow(a.spec.shape)) sa = facing(a, b) ?? sa;
  if (sb === "bottom" && isLabelBelow(b.spec.shape)) sb = facing(b, a) ?? sb;
  return sa === pair[0] && sb === pair[1] ? pair : [sa, sb];
}

/**
 * Swarm 1.2.8 row 54b (VIS-3b, 01f §1.3): a text annotation is drawn as an open bracket on the left of its box; its right
 * side is empty paper. An end there uses the top or bottom side (toward the other node), whose end lies on the bracket arm.
 */
function annotationSides(pair: SidePair, a: SheetNode, b: SheetNode): SidePair {
  const vert = (n: SheetNode, other: SheetNode): Side => (other.y + other.h / 2 < n.y + n.h / 2 ? "top" : "bottom");
  const sa = pair[0] === "right" && a.spec.shape === "annotation" ? vert(a, b) : pair[0];
  const sb = pair[1] === "right" && b.spec.shape === "annotation" ? vert(b, a) : pair[1];
  return sa === pair[0] && sb === pair[1] ? pair : [sa, sb];
}

/**
 * Row 124 (CP-41): side pairs to try for one edge, primary (`sideOf`) first, then the opposite pair
 * on the other axis, then the two corner (L) pairs. Signs follow the centre offset of the boxes.
 */
function sideCandidates(a: SheetNode, b: SheetNode): SidePair[] {
  const sa = sideOf(a, b);
  const dx = b.x + b.w / 2.0 - (a.x + a.w / 2.0);
  const dy = b.y + b.h / 2.0 - (a.y + a.h / 2.0);
  const v: Side = dy > 0 ? "bottom" : "top";
  const h: Side = dx > 0 ? "right" : "left";
  const out: SidePair[] = [[sa, OPP[sa]]];
  const push = (p: SidePair) => {
    if (!out.some((q) => q[0] === p[0] && q[1] === p[1])) out.push(p);
  };
  if (sa === "top" || sa === "bottom") push([h, OPP[h]]);
  else push([v, OPP[v]]);
  push([v, OPP[h]]); // leave vertically, enter from the side
  push([h, OPP[v]]); // leave sideways, enter from above/below
  return out;
}

/** HS `route_edges` atas lembar tertempat (keluarga selain sequence). */
export function routePlaced(s: StudioDiagramV1, sheet: Sheet): RoutedEdge[] {
  clearFirstRender(); // Swarm 1.2.8 row 35 (H-NB2): a new first-render routing starts with no recorded self-correction
  const elk = activeElkRoutes(s, sheet);
  if (elk) return glueToOutlines(elk, sheet);
  if (s.family === "rack" && diagramFitRoute("lineThroughText")) {
    diagramFitNote("RACK_ROUTE", "konektor rak dirute pada jalur di sisi kanan badan rak", "tidak ada");
    return routeRackSide(s, sheet);
  }
  const edges = s.edges ?? [];
  // Row 124 (CP-41): route as the original; an edge that runs through one of its own boxes is given
  // the first other side pair whose route is clean (no box crossed, own boxes included). Edges that
  // were clean keep their sides, so a figure without the defect is byte-identical to the original.
  // An edge with no clean alternative keeps its original route (never worse than the original;
  // the Rev A conformance check CP-41 then reports it).
  const over = new Map<number, SidePair>();
  const kept = new Set<number>();
  for (let round = 0; round < edges.length; round++) {
    const out = routeWithSides(s, sheet, over);
    // Row 56 (VIS-4): straight and curved edges are never rerouted (a crossing is reported, 01f §3.3).
    const bad = edges.findIndex((e, i) => !over.has(i) && !kept.has(i) && !edgeRouteOf(e) && !glued(e) && throughEnds(out[i].points, nodeOf(sheet, e.from), nodeOf(sheet, e.to)));
    if (bad < 0) return out;
    const e = edges[bad];
    const a = nodeOf(sheet, e.from);
    const b = nodeOf(sheet, e.to);
    const nodes = [...sheet.nodes.values()];
    let pick: SidePair | undefined;
    // Row 54 (VIS-3a): a candidate that ends on the bottom of an event/gateway cell is taken with `belowSides`.
    for (const pair of sideCandidates(a, b).slice(1).map((p) => annotationSides(belowSides(p, a, b), a, b))) {
      const trial = new Map(over).set(bad, pair);
      let pts: Pt[];
      try {
        pts = routeWithSides(s, sheet, trial)[bad].points as Pt[];
      } catch {
        continue; // this side pair makes some detour fail (DATUM-32): not a candidate
      }
      if (!throughEnds(pts, a, b) && blocked(pts, [e.from, e.to], nodes, sheet.widthMm) === null) {
        pick = pair;
        break;
      }
    }
    if (pick) over.set(bad, pick);
    else kept.add(bad);
  }
  return routeWithSides(s, sheet, over);
}

/** Corner (L) route between a vertical and a horizontal side (row 124, CP-41). */
function cornerRoute(p: Pt, sa: Side, q: Pt, sb: Side, stub: number): Pt[] {
  const out = (pt: Pt, side: Side): Pt =>
    side === "bottom" ? [pt[0], pt[1] + stub] : side === "top" ? [pt[0], pt[1] - stub] : side === "right" ? [pt[0] + stub, pt[1]] : [pt[0] - stub, pt[1]];
  const pa = out(p, sa);
  const pb = out(q, sb);
  const corner: Pt = sa === "top" || sa === "bottom" ? [pa[0], pb[1]] : [pb[0], pa[1]];
  // Swarm 1.2.8 row 56c (defect 1): a stub that would pass the corner (the corner lies outside the side, nearer than one
  // stub) is dropped, so the L does not double back over its own line; a corner behind the side keeps both stubs.
  const along = (side: Side, from: Pt): number => {
    const n = NORMAL[side];
    return (corner[0] - from[0]) * n[0] + (corner[1] - from[1]) * n[1];
  };
  const cut = (side: Side, from: Pt) => {
    const d = along(side, from);
    return d > 1e-9 && d < stub - 1e-9;
  };
  const dropA = cut(sa, p);
  const dropB = cut(sb, q);
  if (!dropA && !dropB) return [p, pa, corner, pb, q];
  const c: Pt = sa === "top" || sa === "bottom" ? [p[0], dropB ? q[1] : pb[1]] : [dropB ? q[0] : pb[0], p[1]];
  return [p, ...(dropA ? [] : [pa]), c, ...(dropB ? [] : [pb]), q];
}

/** N-018 (T-08, 01e §8): members on one node side at which fan-out (or fan-in) sub-ranking applies. */
export const FANOUT_SPLIT_MIN = 4;
/** 01e §8.4: distance between two turn levels (sub-ranks) of one fan group. */
const FAN_LEVEL_STEP = LATTICE_Y / 2.0;

interface FanGroup {
  node: string;
  side: Side;
  /** true = fan-out (the node is `from`), false = fan-in (the node is `to`). */
  out: boolean;
  /** Edge indices in the anchor slot order of that side (`grouped`). */
  members: number[];
}

/**
 * 01e §8.1: fan groups = edges sharing one node side whose other ends lie across the corridor (side pair
 * bottom/top or right/left, the far anchor beyond the near one). Fan-out groups first, then fan-in (§8.7),
 * each in `grouped` order; bus nodes keep their own tap rule (E-17) and never form a group.
 */
function fanGroups(
  edges: readonly DiagramEdge[],
  sides: readonly SidePair[],
  grouped: ReadonlyMap<string, DiagramEdge[]>,
): FanGroup[] {
  const outs: FanGroup[] = [];
  const ins: FanGroup[] = [];
  for (const [k, g] of grouped) {
    if (g.length < FANOUT_SPLIT_MIN) continue;
    const [side, node] = k.split("\u0000") as [Side, string];
    for (const out of [true, false]) {
      const members: number[] = [];
      for (const e of g) {
        const i = edges.indexOf(e);
        if (i < 0 || e.from === e.to || edgeRouteOf(e) || glued(e)) continue; // rows 56/56b: styled or glued routes never fan
        const [sa, sb] = sides[i];
        if (out ? e.from === node && sa === side && sb === OPP[side] : e.to === node && sb === side && sa === OPP[side]) members.push(i);
      }
      if (members.length >= FANOUT_SPLIT_MIN) (out ? outs : ins).push({ node, side, out, members });
    }
  }
  return [...outs, ...ins];
}

/** Collinear + crossing pairs among the routes of `idx` (lint `edgeConflicts`, E-13). */
function conflictsOf(routes: readonly Pt[][], idx: readonly number[]): number {
  const c = edgeConflicts(idx.map((i) => routes[i]));
  return c.collinear + c.cross;
}

/**
 * 01e §8.2-8.5, §8.7: new raw routes for one fan group, or null when the turn levels find no room.
 * Members are ordered by the cross coordinate of their far end's centre; a member whose far centre lies
 * inside the node side span (inset >= ENTRY_COLLISION_MM) exits there when no other member exits within
 * ENTRY_COLLISION_MM; the others keep the fanned slot of their sorted position. Bending members turn on
 * staggered levels: per direction the largest cross distance turns first, next to the node's stub end,
 * each further one FAN_LEVEL_STEP on, never past the far stub. Far ends keep their anchors.
 */
function fanRaw(
  sheet: Sheet,
  edges: readonly DiagramEdge[],
  sides: readonly SidePair[],
  grouped: ReadonlyMap<string, DiagramEdge[]>,
  gk: (id: string, side: Side) => string,
  nodeId: string,
  side: Side,
  out: boolean,
  members: readonly number[],
  raw: readonly Pt[][],
  stub: number,
): Pt[][] | null {
  const node = nodeOf(sheet, nodeId);
  if (node.spec.shape === "bus") return null;
  const vert = side === "bottom" || side === "top";
  const sgn = side === "bottom" || side === "right" ? 1 : -1; // outward from the node side
  const cross = (p: Pt) => (vert ? p[0] : p[1]);
  const lvl = (p: Pt) => (vert ? p[1] : p[0]);
  const pt = (c: number, l: number): Pt => (vert ? [c, l] : [l, c]);
  const far = (i: number) => nodeOf(sheet, out ? edges[i].to : edges[i].from);
  if (members.some((i) => far(i).spec.shape === "bus")) return null;
  const farCentre = (i: number) => (vert ? far(i).x + far(i).w / 2.0 : far(i).y + far(i).h / 2.0);
  const farAnchor = (i: number): Pt => {
    const e = edges[i];
    const fs = out ? sides[i][1] : sides[i][0];
    const g = grouped.get(gk(out ? e.to : e.from, fs))!;
    return anchor(far(i), fs, indexOfEdge(g, e), g.length);
  };
  const order = members.map((i, k) => ({ i, k })).sort((a, b) => farCentre(a.i) - farCentre(b.i) || a.k - b.k).map((m) => m.i);
  const n = order.length;
  const exit = new Map<number, number>(order.map((i, k) => [i, cross(anchor(node, side, k, n))]));
  const lo = (vert ? node.x : node.y) + ENTRY_COLLISION_MM;
  const hi = (vert ? node.x + node.w : node.y + node.h) - ENTRY_COLLISION_MM;
  for (const i of order) {
    const c = farCentre(i);
    if (c < lo || c > hi) continue;
    if (order.some((j) => j !== i && Math.abs(exit.get(j)! - c) < ENTRY_COLLISION_MM)) continue;
    exit.set(i, c);
  }
  const nearStub = lvl(anchor(node, side, 0, n)) + sgn * stub;
  const bends = (dirn: number) =>
    order
      .filter((i) => Math.sign(cross(farAnchor(i)) - exit.get(i)!) === dirn && Math.abs(cross(farAnchor(i)) - exit.get(i)!) > 1e-6)
      .sort((a, b) => Math.abs(cross(farAnchor(b)) - exit.get(b)!) - Math.abs(cross(farAnchor(a)) - exit.get(a)!) || order.indexOf(a) - order.indexOf(b));
  const level = new Map<number, number>();
  for (const dirn of [-1, 1]) bends(dirn).forEach((i, k) => level.set(i, nearStub + sgn * k * FAN_LEVEL_STEP));
  const next = raw.map((r) => [...r]);
  for (const i of order) {
    const q = farAnchor(i);
    const farStub = lvl(q) - sgn * stub;
    const L = level.get(i) ?? nearStub;
    if (sgn * (farStub - L) < -1e-6 || sgn * (farStub - nearStub) < -1e-6) return null; // §8.5 no room
    const p = pt(exit.get(i)!, lvl(anchor(node, side, 0, n)));
    const chain: Pt[] = [p, pt(cross(p), nearStub), pt(cross(p), L), pt(cross(q), L), pt(cross(q), farStub), q];
    const dedup = chain.filter((c, k) => k === 0 || Math.abs(c[0] - chain[k - 1][0]) > 1e-9 || Math.abs(c[1] - chain[k - 1][1]) > 1e-9);
    next[i] = out ? dedup : dedup.reverse();
  }
  return next;
}

/**
 * Swarm 1.2.8 row 56c (C75 (1), C101; Visio minimum: a decision has four connection points, its vertices). Several
 * router ends on one side of a `diamond` node would be fanned over the box side, below/beside the slanted outline
 * (visible gap, and a horizontal arrowhead on a shallow side crosses it). Per side with two or more such ends the end
 * whose far node is most in line with the vertex keeps it; each other end whose far node's centre lies beyond the
 * neighbouring vertex by at least `HEAD_RUN_MM` for an entry, `STUB_SEGMENT_MIN_MM` for an exit (and beyond the vertex
 * of the side by a stub along its normal)
 * moves to that neighbouring vertex, when no end uses it yet; the route becomes an L (`cornerRoute`). Styled, glued and self edges keep
 * their sides; gateways keep row 54b's spread (C86). Ends left on a shared side are fanned and land on the outline
 * (`glueOutline`). A figure without two ends on one diamond side is unchanged.
 */
function diamondVertexSides(edges: readonly DiagramEdge[], pairs: readonly SidePair[], sheet: Sheet): SidePair[] {
  const out = pairs.map((p) => [p[0], p[1]] as [Side, Side]);
  for (const node of sheet.nodes.values()) {
    if (node.spec.shape !== "diamond") continue;
    const cx = node.x + node.w / 2;
    const cy = node.y + node.h / 2;
    const ends: { i: number; end: 0 | 1; other: SheetNode; free: boolean }[] = [];
    edges.forEach((e, i) => {
      if (e.from === e.to) return;
      const free = !edgeRouteOf(e) && !glued(e);
      if (e.from === node.id) ends.push({ i, end: 0, other: nodeOf(sheet, e.to), free });
      if (e.to === node.id) ends.push({ i, end: 1, other: nodeOf(sheet, e.from), free });
    });
    const used = (s: Side) => ends.some((x) => out[x.i][x.end] === s);
    for (const side of ["bottom", "top", "right", "left"] as const) {
      const on = ends.filter((x) => out[x.i][x.end] === side);
      if (on.length < 2) continue;
      const vert = side === "top" || side === "bottom";
      const off = (o: SheetNode) => (vert ? o.x + o.w / 2 - cx : o.y + o.h / 2 - cy);
      const half = vert ? node.w / 2 : node.h / 2;
      const ahead = (o: SheetNode) =>
        side === "bottom" ? o.y >= cy + LATTICE_Y : side === "top" ? o.y + o.h <= cy - LATTICE_Y : side === "right" ? o.x >= cx + LATTICE_Y : o.x + o.w <= cx - LATTICE_Y;
      const order = on.map((x, k) => ({ x, k })).sort((a, b) => Math.abs(off(a.x.other)) - Math.abs(off(b.x.other)) || a.k - b.k);
      for (const { x } of order.slice(1)) {
        if (!x.free) continue;
        const o = off(x.other);
        // an entry's last run carries the arrowhead; an exit's needs only a visible piece
        if (Math.abs(o) < half + (x.end === 1 ? HEAD_RUN_MM : STUB_SEGMENT_MIN_MM) || !ahead(x.other)) continue;
        const to: Side = vert ? (o > 0 ? "right" : "left") : o > 0 ? "bottom" : "top";
        if (used(to)) continue;
        out[x.i][x.end] = to;
      }
    }
  }
  return out;
}

/**
 * Row 56c (C51 (a), C71; defect 1, back-jog in a narrow gap): the Z route of a forward pair. The middle run already lies
 * between the two stub ends (`between`, also outside the fit). When the gap is narrower than two stubs the stub ends pass
 * each other and the stubs would double back over the same line: the stubs are dropped and the route bends once, at the
 * middle of the gap (rounded to 0.001 mm as `between`). `vertical`: stubs along y (bottom/top). Otherwise the original
 * six points.
 */
function forwardRun(p: Pt, pa: Pt, pb: Pt, q: Pt, mid: number, vertical: boolean): Pt[] {
  const ax = vertical ? 1 : 0;
  const dir = Math.sign(q[ax] - p[ax]);
  if (dir * (pb[ax] - pa[ax]) < -1e-9) {
    const m = Number(((p[ax] + q[ax]) / 2.0).toFixed(3));
    return vertical ? [p, [p[0], m], [q[0], m], q] : [p, [m, p[1]], [m, q[1]], q];
  }
  return vertical ? [p, pa, [pa[0], mid], [pb[0], mid], pb, q] : [p, pa, [mid, pa[1]], [mid, pb[1]], pb, q];
}

/** Row 56c (C51 (b)): a straight connector meets the target border at least this steeply, so its head stands clear of it. */
const STRAIGHT_END_MIN_DEG = 40;

/** Row 57c (C123 item 3): coordinate `k` of the points never turns back (an out-and-back run is not monotone). */
function monotone(pts: readonly Pt[], k: 0 | 1): boolean {
  let dir = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const d = pts[i + 1][k] - pts[i][k];
    if (Math.abs(d) < 1e-9) continue;
    const sgn = Math.sign(d);
    if (dir !== 0 && sgn !== dir) return false;
    dir = sgn;
  }
  return true;
}

/** Row 57c (C123 item 3): a sideways offset below this (one vertical lattice step) between facing ends is aligned. */
const JOG_ALIGN_MM = LATTICE_Y;

/** Row 57c (C123): least distance (mm) of a straightened run from the corners of either node. */
const SHARED_BAND_CLEAR_MM = 1.5;

/**
 * Row 57c (C123 item 3): the straight part [lo, hi] of a node side along which an end may move (x for top/bottom, y for
 * right/left), as core/svg.ts draws it: a box-like node its whole side; the top and bottom of a parallelogram (slant
 * 0.18 w, top edge shifted right), a hexagon (corner inset 0.22 w) and a stadium (caps of radius h/2). Null otherwise.
 */
function straightSpan(n: SheetNode, side: Side): [number, number] | null {
  const vert = side === "top" || side === "bottom";
  if (boxLike(n)) return vert ? [n.x, n.x + n.w] : [n.y, n.y + n.h];
  if (!vert) return null;
  const sh = n.spec.shape ?? "box";
  if (sh === "parallelogram") return side === "top" ? [n.x + 0.18 * n.w, n.x + n.w] : [n.x, n.x + 0.82 * n.w];
  if (sh === "hexagon") return [n.x + 0.22 * n.w, n.x + 0.78 * n.w];
  if (sh === "stadium") return [n.x + n.h / 2, n.x + n.w - n.h / 2];
  return null;
}

/**
 * Row 56d (C134 G3-06): share of the radius around the centre height over which a horizontal end may sit on the round
 * right/left side of a stadium (cap radius h/2) or a circle (radius min(w, h)/2). `glueOutline` puts the end on the arc
 * at that height; within 0.6 r the end meets the arc at most 37 deg off its normal, so the connector still reads as
 * entering the shape head-on.
 */
const ARC_SPAN_FRAC = 0.6;

/**
 * Row 56d (C134 G3-06): the band [lo, hi] (y) of a stadium's or circle's right/left side where a horizontal end may
 * move (`ARC_SPAN_FRAC`); null for other shapes and for top/bottom sides (`straightSpan` covers those).
 */
function arcSpan(n: SheetNode, side: Side): [number, number] | null {
  if (side !== "right" && side !== "left") return null;
  const sh = n.spec.shape ?? "box";
  if (sh !== "stadium" && sh !== "circle") return null;
  const r = sh === "stadium" ? n.h / 2 : Math.min(n.w, n.h) / 2;
  const cy = n.y + n.h / 2;
  return [cy - r * ARC_SPAN_FRAC, cy + r * ARC_SPAN_FRAC];
}

/** Row 57c: a node whose side is a straight border along its whole box (not an outline shape, event, bus or annotation). */
function boxLike(n: SheetNode): boolean {
  const sh = n.spec.shape ?? "box";
  return !OUTLINE_SHAPES.has(sh) && !isLabelBelow(sh) && sh !== "bus" && sh !== "annotation";
}

/**
 * Row 57c (C123 F-53b-1): the cross coordinate (y for right/left, x for bottom/top) of a straight run between facing
 * sides of two box-like nodes whose spans overlap by more than twice `SHARED_BAND_CLEAR_MM`: the middle of the shared
 * band. Null when the sides do not face each other, a node is not box-like, the ends already line up, or there is no band.
 */
function sharedBand(a: SheetNode, sa: Side, b: SheetNode, sb: Side): number | null {
  if (!boxLike(a) || !boxLike(b) || sb !== OPP[sa]) return null;
  const horiz = sa === "right" || sa === "left";
  const ahead = horiz ? (sa === "right" ? b.x >= a.x + a.w : b.x + b.w <= a.x) : sa === "bottom" ? b.y >= a.y + a.h : b.y + b.h <= a.y;
  if (!ahead) return null;
  const lo = horiz ? Math.max(a.y, b.y) : Math.max(a.x, b.x);
  const hi = horiz ? Math.min(a.y + a.h, b.y + b.h) : Math.min(a.x + a.w, b.x + b.w);
  if (hi - lo <= 2 * SHARED_BAND_CLEAR_MM) return null;
  const ca = horiz ? a.y + a.h / 2 : a.x + a.w / 2;
  const cb = horiz ? b.y + b.h / 2 : b.x + b.w / 2;
  if (Math.abs(ca - cb) < 1e-9) return null;
  return (lo + hi) / 2;
}

/** Row 56c: angle (deg, 0..90) between the segment p -> q and the border `side` it ends on. */
function incidenceDeg(p: Pt, q: Pt, side: Side): number {
  const dx = Math.abs(q[0] - p[0]);
  const dy = Math.abs(q[1] - p[1]);
  return (Math.atan2(side === "top" || side === "bottom" ? dy : dx, side === "top" || side === "bottom" ? dx : dy) * 180) / Math.PI;
}

/**
 * Row 56c (C51 (b), defect 5): the end of a `straight` connector on a box. A diagonal that meets the side at a grazing
 * angle hides its arrowhead against the border. When the router's end meets its side below `STRAIGHT_END_MIN_DEG`, the
 * end moves to the point of a box side facing the start (the side the start lies beyond), at the start's projection
 * clamped to the middle two thirds of that side, that meets its side most steeply. Ends at or above the minimum, and
 * nodes whose outline is not their box, are unchanged.
 */
function straightEnd(p: Pt, node: SheetNode, side: Side, q: Pt): Pt {
  if (incidenceDeg(p, q, side) >= STRAIGHT_END_MIN_DEG) return q;
  const shape = node.spec.shape;
  if (shape === "bus" || isLabelBelow(shape) || OUTLINE_SHAPES.has(shape ?? "") || shape === "document" || shape === "offpage" || shape === "annotation") return q;
  const clamp = (v: number, a: number, len: number) => Math.min(a + (len * 5) / 6, Math.max(a + len / 6, v));
  const cands: { pt: Pt; side: Side }[] = [{ pt: q, side }];
  if (p[1] < node.y) cands.push({ pt: [clamp(p[0], node.x, node.w), node.y], side: "top" });
  if (p[1] > node.y + node.h) cands.push({ pt: [clamp(p[0], node.x, node.w), node.y + node.h], side: "bottom" });
  if (p[0] < node.x) cands.push({ pt: [node.x, clamp(p[1], node.y, node.h)], side: "left" });
  if (p[0] > node.x + node.w) cands.push({ pt: [node.x + node.w, clamp(p[1], node.y, node.h)], side: "right" });
  let best = cands[0];
  for (const c of cands.slice(1)) if (incidenceDeg(p, c.pt, c.side) > incidenceDeg(p, best.pt, best.side) + 1e-9) best = c;
  const r2 = (v: number) => Math.round(v * 100) / 100;
  return best === cands[0] ? q : [r2(best.pt[0]), r2(best.pt[1])];
}

/** The original `route_edges` body; `over` = side pair per edge index chosen by row 124 (CP-41). */
function routeWithSides(s: StudioDiagramV1, sheet: Sheet, over: ReadonlyMap<number, SidePair>): RoutedEdge[] {
  const edges = s.edges ?? [];
  const nodes = [...sheet.nodes.values()];
  // 1.2.6 row 64 (01e §4.2, routed by row 46): a forward edge of a ranked flow (rank(from) < rank(to))
  // has fixed sides, bottom -> top in TB and right -> left in LR. `sideOf` would turn the outer edges of a
  // wide TB rank (|dx| > |dy|) to right/left. Back and intra-rank edges keep `sideOf`; a flow without
  // `direction` (legacy) is untouched.
  const dir = flowDirectionOf(s as StudioDiagramV1 & { direction?: unknown });
  const rankOf = dir ? flowRanks(s).rankOf : undefined;
  // Row 56b (VIS-5): explicit sides win over the router's pair.
  const sidesOf0 = (e: DiagramEdge, i: number): SidePair => withSides(e, autoSides(e, i), nodeOf(sheet, e.from), nodeOf(sheet, e.to));
  // Row 56c (C75 (1), C101): a decision diamond connects at its four vertices, one end per vertex where the far node allows.
  let vertexSides: SidePair[] | undefined;
  const sidesOf = (e: DiagramEdge, i: number): SidePair => {
    vertexSides ??= diamondVertexSides(edges, edges.map((x, j) => sidesOf0(x, j)), sheet);
    return vertexSides[i];
  };
  const autoSides = (e: DiagramEdge, i: number): SidePair => {
    const o = over.get(i);
    if (o) return o;
    const a = nodeOf(sheet, e.from);
    const b = nodeOf(sheet, e.to);
    // Swarm 1.2.8 row 68a (C166 (1)): an unglued end of a via edge takes the side facing its nearest via point, so the leg
    // to or from the via never starts through the node (a bus keeps its tap side; explicit sides win in `withSides`).
    const via = viaOf(e);
    if (via) {
      const at = (v: { col: number; row: number }): Pt => clampIn([v.col * sheet.colMm, v.row * sheet.rowMm], sheet);
      const s0 = sideOf(a, b);
      return [a.spec.shape === "bus" ? s0 : facingSide(a, at(via[0])), b.spec.shape === "bus" ? OPP[s0] : facingSide(b, at(via[via.length - 1]))];
    }
    if (rankOf) {
      const ra = rankOf.get(e.from);
      const rb = rankOf.get(e.to);
      if (ra !== undefined && rb !== undefined && ra < rb) {
        const fixed: SidePair = dir === "LR" ? ["right", "left"] : ["bottom", "top"];
        // Row 54b (VIS-3b, C86): a gateway exit in a TB flow leaves by the vertex facing a node beside it (not under its label).
        const gw = a.spec.shape?.startsWith("gateway_") === true || b.spec.shape?.startsWith("gateway_") === true;
        return annotationSides(gw ? belowSides(fixed, a, b) : fixed, a, b);
      }
    }
    const sa = sideOf(a, b);
    return annotationSides(belowSides([sa, OPP[sa]], a, b), a, b);
  };
  const grouped = new Map<string, DiagramEdge[]>();
  const gk = (id: string, side: Side) => `${side}\u0000${id}`;
  const push = (k: string, e: DiagramEdge) => {
    const g = grouped.get(k);
    if (g) g.push(e);
    else grouped.set(k, [e]);
  };
  edges.forEach((e, i) => {
    const [sa, sb] = sidesOf(e, i);
    // Row 56b (VIS-5): a slotted end takes no fan position on its side.
    if (slotField(e, "from") === undefined) push(gk(e.from, sa), e);
    if (slotField(e, "to") === undefined) push(gk(e.to, sb), e);
  });
  // Row 57c (C86): an event left downward (an end on its bottom, none on its right) with room on its right is labelled
  // beside the circle, so the bottom end starts on the circle (`glueLabelBelow`) instead of under the label block.
  markLabelBeside(sheet, nodes, edges.map((e, i) => [e, sidesOf(e, i)] as const));
  // Row 54b (VIS-3b, C86): the spread side ends of an event/gateway are ordered by the other node's centre height, so
  // the upper end goes to the upper node and the two runs do not cross. Other nodes keep the edge order.
  for (const [k, g] of grouped) {
    const [side, id] = k.split("\u0000");
    if (g.length < 2 || (side !== "left" && side !== "right") || !isLabelBelow(nodeOf(sheet, id).spec.shape)) continue;
    const cyOf = (e: DiagramEdge) => {
      const o = nodeOf(sheet, e.from === id ? e.to : e.from);
      return isLabelBelow(o.spec.shape) ? labelBelowOutline(o).y + labelBelowOutline(o).h / 2 : o.y + o.h / 2;
    };
    const idx = new Map(g.map((e, i) => [e, i]));
    g.sort((a, b) => cyOf(a) - cyOf(b) || idx.get(a)! - idx.get(b)!);
  }
  // FIG-02b2 P1-12: saat fit dengan cacat rute terukur, slot jangkar per sisi diurutkan menurut
  // pusat simpul di ujung lain (x untuk sisi atas/bawah, y untuk kiri/kanan) agar kipas tidak bersilang.
  const laneFix = diagramFitRoute("edgeCollinear", "edgeCross");
  // Row 56d (C134 G3-06): a fan side with a member whose other end is the single end on the facing side of a node beyond
  // it (that end moves in line with the fan slot below) is ordered by the other nodes' centres on the first render too,
  // so the straightened drop does not cross a sibling. Other fan sides keep the edge order (auto-fit sorts them above).
  if (!laneFix) {
    const ahead = (n: SheetNode, side: Side, o: SheetNode) =>
      side === "bottom" ? o.y >= n.y + n.h : side === "top" ? o.y + o.h <= n.y : side === "right" ? o.x >= n.x + n.w : o.x + o.w <= n.x;
    for (const [k, g] of grouped) {
      const [side, id] = k.split("\u0000") as [Side, string];
      if (g.length < 2 || isLabelBelow(nodeOf(sheet, id).spec.shape)) continue;
      const n = nodeOf(sheet, id);
      const faces = g.some((e) => {
        const out = e.from === id;
        const oid = out ? e.to : e.from;
        if (oid === id || edgeRouteOf(e) || glued(e) || viaOf(e)) return false;
        const [sa, sb] = sidesOf(e, edges.indexOf(e));
        const oSide = out ? sb : sa;
        return (out ? sa : sb) === side && oSide === OPP[side] && grouped.get(gk(oid, oSide))?.length === 1 && ahead(n, side, nodeOf(sheet, oid));
      });
      if (!faces) continue;
      const other = (e: DiagramEdge) => nodeOf(sheet, e.from === id ? e.to : e.from);
      const key = (e: DiagramEdge) => (side === "top" || side === "bottom" ? other(e).x + other(e).w / 2 : other(e).y + other(e).h / 2);
      const idx = new Map(g.map((e, i) => [e, i]));
      g.sort((a, b) => key(a) - key(b) || idx.get(a)! - idx.get(b)!);
    }
  }
  if (laneFix) {
    for (const [k, g] of grouped) {
      const [side, id] = k.split("\u0000");
      const other = (e: DiagramEdge) => nodeOf(sheet, e.from === id ? e.to : e.from);
      const key = (e: DiagramEdge) => (side === "top" || side === "bottom" ? other(e).x + other(e).w / 2 : other(e).y + other(e).h / 2);
      const idx = new Map(g.map((e, i) => [e, i]));
      g.sort((a, b) => key(a) - key(b) || idx.get(a)! - idx.get(b)!);
    }
  }
  const stub = snap(LATTICE_Y, LATTICE_Y);
  const raw: Pt[][] = [];
  const alignedAlt = new Map<number, Pt[]>(); // row 56d: fan-aligned edge -> its route from the unaligned ends
  edges.forEach((e, ei) => {
    const a = nodeOf(sheet, e.from);
    const b = nodeOf(sheet, e.to);
    const [sa, sb] = sidesOf(e, ei);
    const ga = grouped.get(gk(e.from, sa)) ?? [e]; // row 56b: a side of slotted ends only has no fan group
    const gb = grouped.get(gk(e.to, sb)) ?? [e];
    let p = anchor(a, sa, indexOfEdge(ga, e), ga.length);
    let q = anchor(b, sb, indexOfEdge(gb, e), gb.length);
    let unaligned: [Pt, Pt] | undefined; // row 56d: the ends before a fan alignment
    const vertA = sa === "bottom" || sa === "top";
    const vertB = sb === "bottom" || sb === "top";
    const style = edgeRouteOf(e);
    // Swarm 1.2.8 row 54b (VIS-3b): side ends of an event/gateway sit on its cell edge; the outline lies inside the cell,
    // so `glueEnd` later draws the stub from the outline to the cell edge. Here that end gets no outer stub, the middle
    // run stays between the two stubs (no back-jog in a one-column gap), and a single end whose height is within the
    // spread band of the other end takes that height, so the connector is one straight run.
    const sideA = !vertA && isLabelBelow(a.spec.shape);
    const sideB = !vertB && isLabelBelow(b.spec.shape);
    if (!style && !glued(e) && !vertA && !vertB && (sideA || sideB)) {
      // the end may take the other end's height when that lies within the spread band of its outline and keeps
      // ENTRY_COLLISION_MM from the spread ends of the other edges on the same side
      const fits = (n: SheetNode, side: Side, g: DiagramEdge[], own: Pt, y: number) => {
        const o = labelBelowOutline(n);
        if (Math.abs(y - (o.y + o.h / 2)) > (o.h / 2) * SIDE_SPREAD_FRAC + 1e-9) return false;
        const k = indexOfEdge(g, e);
        return g.every((_, j) => j === k || Math.abs(anchor(n, side, j, g.length)[1] - y) >= ENTRY_COLLISION_MM) && Math.abs(own[1] - y) > 1e-9;
      };
      if (sideB && fits(b, sb, gb, q, p[1])) q = [q[0], p[1]];
      else if (sideA && fits(a, sa, ga, p, q[1])) p = [p[0], q[1]];
    }
    // Swarm 1.2.8 row 57c (C123 F-53b-1): two box-like nodes side by side whose spans overlap (same row, different
    // heights) are joined by one straight run in the middle of the shared band, not by a Z with two short stubs; only
    // single ends on facing sides, so no fan position moves.
    if (!style && !glued(e) && ga.length === 1 && gb.length === 1) {
      const band = sharedBand(a, sa, b, sb);
      if (band !== null) {
        if (vertA) {
          p = [band, p[1]];
          q = [band, q[1]];
        } else {
          p = [p[0], band];
          q = [q[0], band];
        }
      }
    }
    // Row 57c (C123 item 3): facing ends offset sideways by less than `JOG_ALIGN_MM` draw a short jog the reader sees as a
    // stray piece (`stubSegment` (a) below 2 mm, a dash fragment above); a single end on a box-like node moves in line
    // with the other end when that stays `SHARED_BAND_CLEAR_MM` inside its side, so the run is straight.
    if (!style && !glued(e) && sb === OPP[sa]) {
      const k = vertA ? 0 : 1;
      const off = Math.abs(p[k] - q[k]);
      // Row 56d (C134 G3-06): a stadium's or circle's round side also takes the end (`arcSpan`), so an LR start ->
      // decision link (the diamond has one vertex, the stadium no straight right side) is one straight run.
      const inSide = (n: SheetNode, side: Side, v: number) => {
        const span = straightSpan(n, side) ?? arcSpan(n, side);
        return span !== null && v >= span[0] + SHARED_BAND_CLEAR_MM && v <= span[1] - SHARED_BAND_CLEAR_MM;
      };
      // Row 56d (C134 G3-06): the other end is fanned (one of several on its side, so it cannot move) and lies ahead
      // across the gap: the single end moves in line with it when that stays inside its side, at any offset, so a node
      // with two bottom exits drops straight onto the node below instead of jogging under it.
      const ahead = (sa === "bottom" && q[1] > p[1]) || (sa === "top" && q[1] < p[1]) || (sa === "right" && q[0] > p[0]) || (sa === "left" && q[0] < p[0]);
      if (off > 1e-9 && off < JOG_ALIGN_MM) {
        if (gb.length === 1 && inSide(b, sb, p[k])) q = k === 0 ? [p[0], q[1]] : [q[0], p[1]];
        else if (ga.length === 1 && inSide(a, sa, q[k])) p = k === 0 ? [q[0], p[1]] : [p[0], q[1]];
      } else if (off > 1e-9 && ahead && !viaOf(e) && slotField(e, "from") === undefined && slotField(e, "to") === undefined) {
        // only when the straight run is free: a route that detours round other nodes keeps its ends
        const free = (u: Pt, v: Pt) => blocked([u, v], [e.from, e.to], nodes, sheet.widthMm) === null;
        const qa: Pt = k === 0 ? [p[0], q[1]] : [q[0], p[1]];
        const pa: Pt = k === 0 ? [q[0], p[1]] : [p[0], q[1]];
        if (ga.length > 1 && gb.length === 1 && inSide(b, sb, p[k]) && free(p, qa)) {
          unaligned = [p, q];
          q = qa;
        } else if (gb.length > 1 && ga.length === 1 && inSide(a, sa, q[k]) && free(pa, q)) {
          unaligned = [p, q];
          p = pa;
        }
      }
    }
    // Row 56d: the route from the two ends (also built from the unaligned ends, for the crossing check below).
    const buildPts = (p: Pt, q: Pt): Pt[] => {
      let pts: Pt[];
      // Swarm 1.2.8 row 56b (VIS-5/VIS-6): a slot puts the end at that fraction of its side; `via` bends the route there.
      const slotA = slotField(e, "from");
      const slotB = slotField(e, "to");
      if (slotA !== undefined) p = slotAnchor(a, sa, slotA);
      if (slotB !== undefined) q = slotAnchor(b, sb, slotB);
      const vias = viaPoints(e, ei, sheet);
      if (vias) {
        pts = viaRoute(p, sa, vias, q, sb, style === "straight", a, b, sheet);
      } else if (style === "straight") {
        // row 56 (VIS-4): one segment, diagonal allowed; row 56c: its end meets the border steeply (glued ends stay)
        pts = [p, sideField(e, "to") === undefined ? straightEnd(p, b, sb, q) : q];
      } else if (style === "curved") {
        pts = curvedPoints(p, sa, q, sb); // row 56 (VIS-4): sampled Bezier, ends normal to the sides
      } else if (vertA !== vertB) {
        pts = cornerRoute(p, sa, q, sb, stub); // row 124 (CP-41): L pair
      } else if (vertA) {
        const pa: Pt = [p[0], p[1] + (sa === "bottom" ? stub : -stub)];
        // E-17: stub target arah balik dari batas (masuk dari luar).
        const pb: Pt = [q[0], q[1] + (sb === "bottom" ? stub : -stub)];
        // Row 56b (VIS-5): a glued same-side pair (top to top, bottom to bottom) runs beyond the outer stub, not between.
        const same = sa === sb && glued(e);
        // Row 56c (C51 (a), defect 1): a forward pair (bottom -> top below it, top -> bottom above it) with a sideways offset
        // never runs back (an end-on pair, same x, overlays its own line and keeps its route).
        const fwd = !same && Math.abs(p[0] - q[0]) > 1e-9 && ((sa === "bottom" && sb === "top" && q[1] > p[1]) || (sa === "top" && sb === "bottom" && q[1] < p[1]));
        const midy = same ? (sa === "bottom" ? Math.max(pa[1], pb[1]) : Math.min(pa[1], pb[1])) : between(snap((pa[1] + pb[1]) / 2.0, LATTICE_Y), pa[1], pb[1], laneFix || fwd);
        // Row 57c (C123 item 3): an end-on facing pair whose stubs cross (a gap narrower than two stubs) is one run, not a
        // run out and back under its label.
        const endOn = !same && Math.abs(p[0] - q[0]) < 1e-9 && ((sa === "bottom" && sb === "top" && q[1] > p[1]) || (sa === "top" && sb === "bottom" && q[1] < p[1]));
        const run: Pt[] = fwd ? forwardRun(p, pa, pb, q, midy, true) : [p, pa, [pa[0], midy], [pb[0], midy], pb, q];
        pts = endOn && !monotone(run, 1) ? [p, q] : run;
      } else {
        const pa: Pt = [p[0] + (sideA ? 0 : sa === "right" ? stub : -stub), p[1]];
        const pb: Pt = [q[0] + (sideB ? 0 : sb === "right" ? stub : -stub), q[1]];
        const same = sa === sb && glued(e); // row 56b: left to left / right to right beyond the outer stub
        // Row 56c (C51 (a), defect 1): a forward pair (right -> left beyond it, left -> right before it) with a height offset
        // never runs back (an end-on pair, same y, overlays its own line and keeps its route).
        const fwd = !same && Math.abs(p[1] - q[1]) > 1e-9 && ((sa === "right" && sb === "left" && q[0] > p[0]) || (sa === "left" && sb === "right" && q[0] < p[0]));
        const midx = same ? (sa === "right" ? Math.max(pa[0], pb[0]) : Math.min(pa[0], pb[0])) : between(snap((pa[0] + pb[0]) / 2.0, sheet.colMm), pa[0], pb[0], laneFix || sideA || sideB || fwd);
        // Row 57c (C123 item 3): an end-on facing pair whose stubs cross is one run (no out-and-back under its label).
        const endOn = !same && Math.abs(p[1] - q[1]) < 1e-9 && ((sa === "right" && sb === "left" && q[0] > p[0]) || (sa === "left" && sb === "right" && q[0] < p[0]));
        const run: Pt[] = fwd ? forwardRun(p, pa, pb, q, midx, false) : [p, pa, [midx, pa[1]], [midx, pb[1]], pb, q];
        pts = Math.abs(p[1] - q[1]) < 1e-9 && (sideA || sideB) ? [p, q] : endOn && !monotone(run, 0) ? [p, q] : run;
      }
      return pts;
    };
    raw.push(buildPts(p, q));
    if (unaligned) alignedAlt.set(ei, buildPts(unaligned[0], unaligned[1]));
  });
  const out: RoutedEdge[] = [];
  const finish = (rawPts: readonly Pt[][]): { routes: Pt[][]; moved: number } => {
    let routes = edges.map((e, i) => {
      const pts = rawPts[i];
      if (edgeRouteOf(e) || viaOf(e)) return [...pts]; // rows 56/56b: no detour (styled or via); a crossed node is reported by the lint
      if (!laneFix) {
        const r = detour(pts, [e.from, e.to], nodes, sheet.widthMm, sheet.colMm);
        // Swarm 1.2.8 row 68a (C166 (4)): a detour joins the two ends directly, so a route whose ends left and entered their
        // sides along the normal can come out running along a side (the end lands beside a diamond vertex, on a container
        // frame, or along the box). Then the detour starts and ends at the stub ends instead (as in the fit, below); kept
        // when that is clean, keeps both ends on their normals and never turns straight back on itself.
        const [sa, sb] = sidesOf(e, i);
        if (pts.length < 4 || !normalEnds(pts, sa, sb) || normalEnds(r, sa, sb)) return r;
        // only where the end lands off the drawn outline (a shape whose outline is not its box); a box end that runs
        // along its side stays as it was (reported GEOM_ARROW_TANGENT; legacy flows keep their bytes, row 45 A15)
        const off = (n: SheetNode, side: Side, atStart: boolean) => !boxLike(n) && !endNormal(r, side, atStart);
        if (!off(nodeOf(sheet, e.from), sa, true) && !off(nodeOf(sheet, e.to), sb, false)) return r;
        try {
          const alt = [pts[0], ...detour(pts.slice(1, -1), [e.from, e.to], nodes, sheet.widthMm, sheet.colMm), pts[pts.length - 1]];
          return normalEnds(alt, sa, sb) && !doublesBack(alt) ? alt : r;
        } catch {
          return r;
        }
      }
      // FIG-02b2: detur mulai dari ujung stub agar konektor keluar tegak lurus sisi simpul
      // (bukan menyusuri garis tepi simpul) dan segmen dalamnya dapat dipisah jalurnya.
      const inner = detour(pts.slice(1, -1), [e.from, e.to], nodes, sheet.widthMm, sheet.colMm);
      return [pts[0], ...inner, pts[pts.length - 1]];
    });
    let moved = 0;
    if (laneFix) {
      const n = nudgeRoutes(routes, edges.map((e) => [e.from, e.to] as const), nodes, sheet.widthMm);
      // Row 56 (VIS-4): lane nudging moves orthogonal segments only; styled routes keep their geometry.
      routes = n.paths.map((r, i) => (edgeRouteOf(edges[i]) || glued(edges[i]) ? routes[i] : r)); // row 56b: glued ends stay put
      moved = n.moved;
    }
    // Swarm 1.2.8 row 56d (C134 G3-07): inner runs lying on a lane / phase / pool rule move off it (swimlanes only);
    // styled, glued and via routes keep their geometry.
    routes = offRules(routes, routeRulesOf(sheet), edges.map((e) => [e.from, e.to] as const), nodes, sheet.widthMm, edges.map((e) => !!edgeRouteOf(e) || glued(e) || !!viaOf(e)));
    return { routes, moved };
  };
  let { routes, moved } = finish(raw);
  // Row 56d (C134 G3-06, C137): a straightened drop that crosses another finished route where its jogged route did not
  // is undone (prefer no new crossing; f6_fan_in spec 5), edge by edge in edge order.
  for (const [i, alt] of alignedAlt) {
    const trialRaw = raw.map((r, j) => (j === i ? alt : r));
    const trial = finish(trialRaw);
    if (edgeConflicts(trial.routes).cross < edgeConflicts(routes).cross) {
      raw[i] = alt;
      ({ routes, moved } = trial);
    }
  }
  // 1.2.6 row 64 (T-08, 01e §8): fan groups whose members conflict get sorted slots, distinct exits and
  // staggered turn levels; kept per group only if the group's conflicts strictly drop and the figure's
  // do not rise. A figure without a conflicting fan group never enters the loop body (byte-identical).
  // A flow without `direction` (legacy serial layout) is frozen at its 1.2.5 bytes (01e A15): no T-08.
  const sides = edges.map((e, i) => sidesOf(e, i));
  const fanned = new Set<number>();
  let fanKept = 0;
  const legacyFlow = s.family === "flow" && !dir;
  for (const g of legacyFlow ? [] : fanGroups(edges, sides, grouped)) {
    const members = g.members.filter((i) => !fanned.has(i));
    if (members.length < FANOUT_SPLIT_MIN) continue;
    const before = conflictsOf(routes, members);
    if (before === 0) continue;
    const alt = fanRaw(sheet, edges, sides, grouped, gk, g.node, g.side, g.out, members, raw, stub);
    if (!alt) continue; // no room for the turn levels: the group keeps its routes (§8.5)
    let trial: { routes: Pt[][]; moved: number };
    try {
      trial = finish(alt);
    } catch {
      continue; // a detour fails (DATUM-32) with the new routes: keep the original
    }
    const ok =
      conflictsOf(trial.routes, members) < before &&
      conflictsOf(trial.routes, edges.map((_, i) => i)) <= conflictsOf(routes, edges.map((_, i) => i)) &&
      members.every((i) => !throughEnds(trial.routes[i], nodeOf(sheet, edges[i].from), nodeOf(sheet, edges[i].to)));
    if (!ok) continue;
    for (const i of members) {
      raw[i] = alt[i];
      fanned.add(i);
    }
    routes = trial.routes;
    moved = trial.moved;
    fanKept += members.length;
  }
  if (laneFix && moved) diagramFitNote("EDGE_LANES", `${moved} segmen konektor berimpit dipindah ke jalur sendiri`, "kurangi konektor yang berbagi kanal bila jalur terlalu rapat");
  const fanNote = { checkId: "EDGE_LANES", detail: `${fanKept} konektor kipas diberi titik keluar dan tingkat belok sendiri`, suggest: "kurangi cabang dari satu sisi simpul bila kipas terlalu rapat" };
  if (fanKept) diagramFitNote(fanNote.checkId, fanNote.detail, fanNote.suggest);
  // Swarm 1.2.8 row 35 (H-NB2, AC-HNB2): the fan split also runs on the first render, where diagramFitNote records
  // nothing; this pass's record (the last pass is the one drawn) goes to autoFitDiagram. No-op inside the fit.
  noteFirstRender(s, fanKept ? [fanNote] : []);
  edges.forEach((e, i) => {
    // Swarm 1.2.8 row 53 (VIS-1b): an end on the bottom side of a document / offpage lands on the wave / point.
    const pts = glueEnd(glueEnd(routes[i], nodeOf(sheet, e.from), false), nodeOf(sheet, e.to), true);
    const style = edgeRouteOf(e);
    // Row 56: the style rides on the routed edge (absent for orthogonal, so old objects are unchanged).
    if (style) out.push({ from: e.from, to: e.to, kind: e.kind, label: e.label, points: pts, d: polylineD(pts), route: style } as RoutedEdge);
    else out.push({ from: e.from, to: e.to, kind: e.kind, label: e.label, points: pts, d: polylineD(pts) });
  });
  return out;
}

/**
 * HS `add_crossing_hops`: lintasan horizontal jalur i melompati lintasan
 * vertikal jalur j > i. Lompatan dicatat pada jalur i dalam urutan Python
 * (i, j, segmen q, segmen p) sehingga urutan gambar busur setara.
 */
export function crossingHops(paths: readonly RoutedEdge[]): HoppedEdge[] {
  const hops: Array<Array<readonly [number, number]>> = paths.map(() => []);
  for (let i = 0; i < paths.length; i++) {
    const pp = paths[i].points;
    if (routeStyleOfPath(paths[i]) === "curved") continue; // row 56 (01f §3.3 Jumps): curved connectors get no hops
    for (let j = i + 1; j < paths.length; j++) {
      if (routeStyleOfPath(paths[j]) === "curved") continue;
      const qp = paths[j].points;
      for (let t = 0; t + 1 < qp.length; t++) {
        const [cx, cy] = qp[t];
        const [dx, dy] = qp[t + 1];
        for (let u = 0; u + 1 < pp.length; u++) {
          const [ax, ay] = pp[u];
          const [bx, by] = pp[u + 1];
          const hor = Math.abs(ay - by) < 1e-9;
          const ver = Math.abs(cx - dx) < 1e-9;
          if (!(hor && ver)) continue;
          if (Math.min(ax, bx) < cx && cx < Math.max(ax, bx) && Math.min(cy, dy) < ay && ay < Math.max(cy, dy)) {
            hops[i].push([cx, ay]);
          }
        }
      }
    }
  }
  return paths.map((p, i) => ({ ...p, d: p.d ?? polylineD(p.points), hops: hops[i] }));
}
