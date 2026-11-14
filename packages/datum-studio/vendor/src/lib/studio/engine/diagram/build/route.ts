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
import { LATTICE_Y, polylineD, snap, type Sheet, type SheetNode } from "../core";
import { diagramFitNote, diagramFitRoute } from "../fit/state";
import { nudgeRoutes, offRules, routeRulesOf } from "./lanesroute";
import { activeElkRoutes } from "../elk/routes";
import { edgeConflicts, ENTRY_COLLISION_MM } from "../fit/lint";
import { flowDirectionOf, flowRanks } from "../layout-a/flow";
import { isLabelBelow, labelBelowOutline } from "../fit/text";
import { clearFirstRender, noteFirstRender } from "./autofit";
// Swarm 1.2.9 row 25 (AC-A01): end placement lives in route-ends.ts, run shaping in route-shape.ts; the names this
// module exported before the split are re-exported here unchanged (register N9-078).
import {
  type Pt,
  type Side,
  OPP,
  edgeRouteOf,
  routeStyleOfPath,
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
  type SidePair,
  belowSides,
  annotationSides,
  sideCandidates,
  diamondVertexSides,
  SHARED_BAND_CLEAR_MM,
  straightSpan,
  arcSpan,
  boxLike,
  sharedBand,
  straightEnd,
} from "./route-ends";
import {
  curvedPoints,
  viaPoints,
  viaRoute,
  blocked,
  normalEnds,
  endNormal,
  doublesBack,
  detour,
  throughEnds,
  cornerRoute,
  FANOUT_SPLIT_MIN,
  fanGroups,
  conflictsOf,
  fanRaw,
  forwardRun,
  monotone,
} from "./route-shape";
export { type EdgeRouteStyle, edgeRouteOf, routeStyleOfPath, EDGE_CLEAR_MM } from "./route-ends";
export { curvedPoints, type RouteLattice, routeLattice, viaFamily, FANOUT_SPLIT_MIN } from "./route-shape";

/** Jalur dengan lompatan silang: titik pusat (x, y) pada lintasan horizontal jalur ini. */
export interface HoppedEdge extends RoutedEdge {
  hops: ReadonlyArray<readonly [number, number]>;
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

/** Row 57c (C123 item 3): a sideways offset below this (one vertical lattice step) between facing ends is aligned. */
const JOG_ALIGN_MM = LATTICE_Y;

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
