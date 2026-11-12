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

type Pt = readonly [number, number];
type Side = "bottom" | "top" | "right" | "left";
const OPP: Readonly<Record<Side, Side>> = { bottom: "top", top: "bottom", right: "left", left: "right" };

/** Jalur dengan lompatan silang: titik pusat (x, y) pada lintasan horizontal jalur ini. */
export interface HoppedEdge extends RoutedEdge {
  hops: ReadonlyArray<readonly [number, number]>;
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
  if (side === "bottom") return [node.x + node.w * frac, node.y + node.h];
  if (side === "top") return [node.x + node.w * frac, node.y];
  if (side === "right") return [node.x + node.w, node.y + node.h * frac];
  return [node.x, node.y + node.h * frac];
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
  const ends = [a, b].filter((n) => n.spec.shape !== "bus");
  for (let i = 0; i + 1 < pts.length; i++) if (ends.some((n) => rectHit(pts[i], pts[i + 1], n))) return true;
  return false;
}

type SidePair = readonly [Side, Side];

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
  const elk = activeElkRoutes(s, sheet);
  if (elk) return elk;
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
    const bad = edges.findIndex((e, i) => !over.has(i) && !kept.has(i) && throughEnds(out[i].points, nodeOf(sheet, e.from), nodeOf(sheet, e.to)));
    if (bad < 0) return out;
    const e = edges[bad];
    const a = nodeOf(sheet, e.from);
    const b = nodeOf(sheet, e.to);
    const nodes = [...sheet.nodes.values()];
    let pick: SidePair | undefined;
    for (const pair of sideCandidates(a, b).slice(1)) {
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
        if (i < 0 || e.from === e.to) continue;
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
    if (rankOf) {
      const ra = rankOf.get(e.from);
      const rb = rankOf.get(e.to);
      if (ra !== undefined && rb !== undefined && ra < rb) return dir === "LR" ? ["right", "left"] : ["bottom", "top"];
    }
    const sa = sideOf(nodeOf(sheet, e.from), nodeOf(sheet, e.to));
    return [sa, OPP[sa]];
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
    const p = anchor(a, sa, indexOfEdge(ga, e), ga.length);
    const q = anchor(b, sb, indexOfEdge(gb, e), gb.length);
    let pts: Pt[];
    const vertA = sa === "bottom" || sa === "top";
    const vertB = sb === "bottom" || sb === "top";
    if (vertA !== vertB) {
      pts = cornerRoute(p, sa, q, sb, stub); // row 124 (CP-41): L pair
    } else if (vertA) {
      const pa: Pt = [p[0], p[1] + (sa === "bottom" ? stub : -stub)];
      // E-17: stub target arah balik dari batas (masuk dari luar).
      const pb: Pt = [q[0], q[1] + (sb === "bottom" ? stub : -stub)];
      const midy = between(snap((pa[1] + pb[1]) / 2.0, LATTICE_Y), pa[1], pb[1], laneFix);
      pts = [p, pa, [pa[0], midy], [pb[0], midy], pb, q];
    } else {
      const pa: Pt = [p[0] + (sa === "right" ? stub : -stub), p[1]];
      const pb: Pt = [q[0] + (sb === "right" ? stub : -stub), q[1]];
      const midx = between(snap((pa[0] + pb[0]) / 2.0, sheet.colMm), pa[0], pb[0], laneFix);
      pts = [p, pa, [midx, pa[1]], [midx, pb[1]], pb, q];
    }
    raw.push(pts);
  });
  const out: RoutedEdge[] = [];
  const finish = (rawPts: readonly Pt[][]): { routes: Pt[][]; moved: number } => {
    let routes = edges.map((e, i) => {
      const pts = rawPts[i];
      if (!laneFix) return detour(pts, [e.from, e.to], nodes, sheet.widthMm, sheet.colMm);
      // FIG-02b2: detur mulai dari ujung stub agar konektor keluar tegak lurus sisi simpul
      // (bukan menyusuri garis tepi simpul) dan segmen dalamnya dapat dipisah jalurnya.
      const inner = detour(pts.slice(1, -1), [e.from, e.to], nodes, sheet.widthMm, sheet.colMm);
      return [pts[0], ...inner, pts[pts.length - 1]];
    });
    let moved = 0;
    if (laneFix) {
      const n = nudgeRoutes(routes, edges.map((e) => [e.from, e.to] as const), nodes, sheet.widthMm);
      routes = n.paths;
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
  if (fanKept) diagramFitNote("EDGE_LANES", `${fanKept} konektor kipas diberi titik keluar dan tingkat belok sendiri`, "kurangi cabang dari satu sisi simpul bila kipas terlalu rapat");
  edges.forEach((e, i) => {
    const pts = routes[i];
    out.push({ from: e.from, to: e.to, kind: e.kind, label: e.label, points: pts, d: polylineD(pts) });
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
    for (let j = i + 1; j < paths.length; j++) {
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
