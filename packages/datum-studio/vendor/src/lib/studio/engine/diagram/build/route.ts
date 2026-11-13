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
import { nudgeRoutes } from "./lanesroute";
import { activeElkRoutes } from "../elk/routes";
import { edgeConflicts, ENTRY_COLLISION_MM } from "../fit/lint";
import { flowDirectionOf, flowRanks } from "../layout-a/flow";
import { CURVE_SAMPLES } from "../core/tokens";
import { ANNOTATION_BRACKET_MM, isLabelBelow, labelBelowOutline } from "../fit/text";
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
  return pts;
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
  for (let i = 0; i + 1 < pts.length; i++) if (ends.some((n) => rectHit(pts[i], pts[i + 1], n))) return true;
  return false;
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
    const bad = edges.findIndex((e, i) => !over.has(i) && !kept.has(i) && !edgeRouteOf(e) && throughEnds(out[i].points, nodeOf(sheet, e.from), nodeOf(sheet, e.to)));
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
  return [p, pa, corner, pb, q];
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
        if (i < 0 || e.from === e.to || edgeRouteOf(e)) continue; // row 56: styled routes never fan
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
  const sidesOf = (e: DiagramEdge, i: number): SidePair => {
    const o = over.get(i);
    if (o) return o;
    const a = nodeOf(sheet, e.from);
    const b = nodeOf(sheet, e.to);
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
    push(gk(e.from, sa), e);
    push(gk(e.to, sb), e);
  });
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
  edges.forEach((e, ei) => {
    const a = nodeOf(sheet, e.from);
    const b = nodeOf(sheet, e.to);
    const [sa, sb] = sidesOf(e, ei);
    const ga = grouped.get(gk(e.from, sa))!;
    const gb = grouped.get(gk(e.to, sb))!;
    let p = anchor(a, sa, indexOfEdge(ga, e), ga.length);
    let q = anchor(b, sb, indexOfEdge(gb, e), gb.length);
    let pts: Pt[];
    const vertA = sa === "bottom" || sa === "top";
    const vertB = sb === "bottom" || sb === "top";
    const style = edgeRouteOf(e);
    // Swarm 1.2.8 row 54b (VIS-3b): side ends of an event/gateway sit on its cell edge; the outline lies inside the cell,
    // so `glueEnd` later draws the stub from the outline to the cell edge. Here that end gets no outer stub, the middle
    // run stays between the two stubs (no back-jog in a one-column gap), and a single end whose height is within the
    // spread band of the other end takes that height, so the connector is one straight run.
    const sideA = !vertA && isLabelBelow(a.spec.shape);
    const sideB = !vertB && isLabelBelow(b.spec.shape);
    if (!style && !vertA && !vertB && (sideA || sideB)) {
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
    if (style === "straight") {
      pts = [p, q]; // row 56 (VIS-4): one segment, diagonal allowed
    } else if (style === "curved") {
      pts = curvedPoints(p, sa, q, sb); // row 56 (VIS-4): sampled Bezier, ends normal to the sides
    } else if (vertA !== vertB) {
      pts = cornerRoute(p, sa, q, sb, stub); // row 124 (CP-41): L pair
    } else if (vertA) {
      const pa: Pt = [p[0], p[1] + (sa === "bottom" ? stub : -stub)];
      // E-17: stub target arah balik dari batas (masuk dari luar).
      const pb: Pt = [q[0], q[1] + (sb === "bottom" ? stub : -stub)];
      const midy = between(snap((pa[1] + pb[1]) / 2.0, LATTICE_Y), pa[1], pb[1], laneFix);
      pts = [p, pa, [pa[0], midy], [pb[0], midy], pb, q];
    } else {
      const pa: Pt = [p[0] + (sideA ? 0 : sa === "right" ? stub : -stub), p[1]];
      const pb: Pt = [q[0] + (sideB ? 0 : sb === "right" ? stub : -stub), q[1]];
      const midx = between(snap((pa[0] + pb[0]) / 2.0, sheet.colMm), pa[0], pb[0], laneFix || sideA || sideB);
      pts = Math.abs(p[1] - q[1]) < 1e-9 && (sideA || sideB) ? [p, q] : [p, pa, [midx, pa[1]], [midx, pb[1]], pb, q];
    }
    raw.push(pts);
  });
  const out: RoutedEdge[] = [];
  const finish = (rawPts: readonly Pt[][]): { routes: Pt[][]; moved: number } => {
    let routes = edges.map((e, i) => {
      const pts = rawPts[i];
      if (edgeRouteOf(e)) return [...pts]; // row 56 (VIS-4): no detour; a crossed node is reported by the lint
      if (!laneFix) return detour(pts, [e.from, e.to], nodes, sheet.widthMm, sheet.colMm);
      // FIG-02b2: detur mulai dari ujung stub agar konektor keluar tegak lurus sisi simpul
      // (bukan menyusuri garis tepi simpul) dan segmen dalamnya dapat dipisah jalurnya.
      const inner = detour(pts.slice(1, -1), [e.from, e.to], nodes, sheet.widthMm, sheet.colMm);
      return [pts[0], ...inner, pts[pts.length - 1]];
    });
    let moved = 0;
    if (laneFix) {
      const n = nudgeRoutes(routes, edges.map((e) => [e.from, e.to] as const), nodes, sheet.widthMm);
      // Row 56 (VIS-4): lane nudging moves orthogonal segments only; styled routes keep their geometry.
      routes = n.paths.map((r, i) => (edgeRouteOf(edges[i]) ? routes[i] : r));
      moved = n.moved;
    }
    return { routes, moved };
  };
  let { routes, moved } = finish(raw);
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
