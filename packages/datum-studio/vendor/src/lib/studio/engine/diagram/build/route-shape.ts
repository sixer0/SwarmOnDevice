/**
 * Connector run shaping (Swarm 1.2.9 row 25, AC-A01, register N9-081): styled and via runs, detours round blocking
 * nodes, corner routes and fan groups, moved verbatim from `route.ts` (03a lines 107-117). Imports end placement from
 * `route-ends.ts` only, nothing from `route.ts` (one way: ends <- shape <- route); `route.ts` re-exports the names it
 * exported before the split.
 */
import type { DiagramEdge, StudioDiagramV1 } from "../../../contract";
import { DiagramDefect, LATTICE_Y, snap, type Sheet, type SheetNode } from "../core";
import { edgeConflicts, ENTRY_COLLISION_MM, STUB_SEGMENT_MIN_MM } from "../fit/lint";
import { CURVE_SAMPLES } from "../core/tokens";
import { isLabelBelow, labelBelowOutline } from "../fit/text";
import {
  type Pt,
  type Side,
  OPP,
  edgeRouteOf,
  NORMAL,
  viaOf,
  glued,
  EDGE_CLEAR_MM,
  clampIn,
  anchor,
  indexOfEdge,
  nodeOf,
  boxEnds,
  type SidePair,
  STRAIGHT_END_MIN_DEG,
  incidenceDeg,
} from "./route-ends";

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

export {
  viaPoints,
  viaRoute,
  blocked,
  normalEnds,
  endNormal,
  doublesBack,
  detour,
  throughEnds,
  cornerRoute,
  fanGroups,
  conflictsOf,
  fanRaw,
  forwardRun,
  monotone,
};
