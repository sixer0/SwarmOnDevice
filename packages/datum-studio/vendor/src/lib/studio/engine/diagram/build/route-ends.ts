/**
 * Connector end placement (Swarm 1.2.9 row 25, AC-A01, register N9-080): the shared point/side types and helpers, the
 * side choice and the glue of connector ends onto node outlines, moved verbatim from `route.ts` (03a lines 107-117).
 * Imports nothing from `route-shape.ts` or `route.ts` (one way: ends <- shape <- route); `route.ts` re-exports the
 * names it exported before the split, so its readers are unchanged.
 */
import type { DiagramEdge, RoutedEdge } from "../../../contract";
import { DiagramDefect, LATTICE_Y, polylineD, type Sheet, type SheetNode } from "../core";
import { ENTRY_COLLISION_MM, STUB_SEGMENT_MIN_MM } from "../fit/lint";
import { ARROW_SIZES_MM } from "../core/tokens";
import { ANNOTATION_BRACKET_MM, isLabelBelow, isLabelBeside, labelBelowOutline, labelBesideBox, setLabelBeside } from "../fit/text";

type Pt = readonly [number, number];
type Side = "bottom" | "top" | "right" | "left";
const OPP: Readonly<Record<Side, Side>> = { bottom: "top", top: "bottom", right: "left", left: "right" };

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

/** Row 56c (C51 (b)): a straight connector meets the target border at least this steeply, so its head stands clear of it. */
const STRAIGHT_END_MIN_DEG = 40;

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

export {
  type Pt,
  type Side,
  OPP,
  NORMAL,
  sideField,
  slotField,
  viaOf,
  glued,
  withSides,
  slotAnchor,
  clampIn,
  facingSide,
  sideOf,
  anchor,
  SIDE_SPREAD_FRAC,
  glueEnd,
  markLabelBeside,
  glueToOutlines,
  between,
  indexOfEdge,
  nodeOf,
  boxEnds,
  type SidePair,
  belowSides,
  annotationSides,
  sideCandidates,
  diamondVertexSides,
  STRAIGHT_END_MIN_DEG,
  SHARED_BAND_CLEAR_MM,
  straightSpan,
  arcSpan,
  boxLike,
  sharedBand,
  incidenceDeg,
  straightEnd,
};
