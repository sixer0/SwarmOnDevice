/**
 * Swarm addition (row 162, U24 C): ELK's orthogonal edge routes moved onto the placed,
 * lattice-snapped Studio sheet. No ELK import (pure geometry), so the route seam in
 * build/route.ts (file_requests, row 162) can call `activeElkRoutes` without loading elkjs.
 */
import type { RoutedEdge, StudioDiagramV1 } from "../../../contract";
import { LATTICE_Y, polylineD, type Sheet, type SheetNode } from "../core";
import { elkPlanFor, type ElkPlan, type ElkRoute } from "./plan";

type Pt = [number, number];

/** Piecewise-linear x map of one layer: ELK node edges -> sheet node edges, sheet bounds at the ends. */
function layerXMap(ids: readonly string[], plan: ElkPlan, nodes: ReadonlyMap<string, SheetNode>, W: number): (x: number) => number {
  const pairs: Array<[number, number]> = [];
  for (const id of ids) {
    const e = plan.box[id];
    const s = nodes.get(id);
    if (!e || !s) continue;
    pairs.push([e.x, s.x], [e.x + e.w, s.x + s.w]);
  }
  pairs.sort((a, b) => a[0] - b[0]);
  const lo: [number, number] = [Math.min(0, pairs[0]?.[0] ?? 0), 0];
  const hi: [number, number] = [Math.max(W, pairs[pairs.length - 1]?.[0] ?? W), W];
  const pts = [lo, ...pairs, hi];
  return (x: number) => {
    for (let i = 0; i + 1 < pts.length; i++) {
      const [a, sa] = pts[i];
      const [b, sb] = pts[i + 1];
      if (x >= a - 1e-9 && x <= b + 1e-9) return b - a < 1e-9 ? sa : sa + ((x - a) / (b - a)) * (sb - sa);
    }
    return x;
  };
}

const inside = (p: Pt, n: SheetNode, inset = 0.05) => p[0] > n.x + inset && p[0] < n.x + n.w - inset && p[1] > n.y + inset && p[1] < n.y + n.h - inset;

/** Does segment a-b (axis-parallel) pass through the interior of box n? */
function segHits(a: Pt, b: Pt, n: SheetNode): boolean {
  for (let k = 0; k <= 40; k++) {
    const t = k / 40;
    if (inside([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], n)) return true;
  }
  return false;
}

/**
 * ELK's orthogonal routes moved onto the placed (lattice-snapped) sheet: each vertical run keeps
 * its place relative to the nodes of the layer it leaves (end runs: relative to their own box),
 * each horizontal run keeps its relative height inside its inter-tier gap (snapped to the
 * vertical lattice). Returns undefined unless EVERY edge has an ELK route that is orthogonal,
 * starts and ends on its own boxes and crosses no box interior (its own two included); the caller
 * then keeps Studio's own router.
 */
export function elkRoutesOnSheet(
  plan: ElkPlan,
  s: StudioDiagramV1,
  nodes: ReadonlyMap<string, SheetNode>,
  W: number,
  onReject?: (why: string) => void,
): ElkRoute[] | undefined {
  const no = (why: string): undefined => {
    onReject?.(why);
    return undefined;
  };
  const edges = s.edges ?? [];
  if (plan.sections.length !== edges.length) return no("an intra-tier edge has no ELK route");
  const layerOf = new Map<string, number>();
  plan.layers.forEach((ids, i) => ids.forEach((id) => layerOf.set(id, i)));
  const maps = plan.layers.map((ids) => layerXMap(ids, plan, nodes, W));
  const elkRow = plan.layers.map((ids) => ({ top: Math.min(...ids.map((id) => plan.box[id].y)), bottom: Math.max(...ids.map((id) => plan.box[id].y + plan.box[id].h)) }));
  const sheetRow = plan.layers.map((ids) => ({
    top: Math.min(...ids.map((id) => nodes.get(id)?.y ?? Infinity)),
    bottom: Math.max(...ids.map((id) => (nodes.get(id) ? nodes.get(id)!.y + nodes.get(id)!.h : -Infinity))),
  }));
  const mapY = (y: number): number => {
    for (let i = 0; i + 1 < elkRow.length; i++) {
      const a = elkRow[i].bottom;
      const b = elkRow[i + 1].top;
      if (y >= a - 1e-9 && y <= b + 1e-9) {
        const sa = sheetRow[i].bottom;
        const sb = sheetRow[i + 1].top;
        const v = sa + ((y - a) / Math.max(b - a, 1e-9)) * (sb - sa);
        const snapped = Math.round(v / LATTICE_Y) * LATTICE_Y;
        return snapped > sa + 1e-6 && snapped < sb - 1e-6 ? snapped : v;
      }
    }
    return Number.NaN;
  };
  const out: ElkRoute[] = [];
  for (const sec of [...plan.sections].sort((p, q) => p.edge - q.edge)) {
    const e = edges[sec.edge];
    const a = nodes.get(e.from);
    const b = nodes.get(e.to);
    const ea = plan.box[e.from];
    const eb = plan.box[e.to];
    if (!a || !b || !ea || !eb) return no(`edge ${sec.edge}: end box missing`);
    let pts = sec.points;
    if (pts.length < 2) return no(`edge ${sec.edge}: no points`);
    if (pts.length === 2 && Math.abs(pts[0][0] - pts[1][0]) < 1e-6) {
      // straight ELK edge: give it a mid-gap jog so both ends can follow their (snapped) boxes
      const ym = (pts[0][1] + pts[1][1]) / 2;
      pts = [pts[0], [pts[0][0], ym], [pts[1][0], ym], pts[1]];
    }
    // Runs: consecutive points share x (vertical) or y (horizontal).
    const xs: number[] = [];
    const ys: number[] = [];
    const last = pts.length - 1;
    for (let i = 0; i <= last; i++) {
      const [x, y] = pts[i];
      // x: the run touching an end box maps relative to that box; else by the layer the run starts in
      const onA = Math.abs(x - pts[0][0]) < 1e-6 && i <= 1;
      const onB = Math.abs(x - pts[last][0]) < 1e-6 && i >= last - 1;
      if (onA) xs.push(a.x + ((x - ea.x) / Math.max(ea.w, 1e-9)) * a.w);
      else if (onB) xs.push(b.x + ((x - eb.x) / Math.max(eb.w, 1e-9)) * b.w);
      else {
        // the vertical run this point belongs to, and the ELK layer (or the gap above it) it crosses
        const j = i > 0 && Math.abs(pts[i - 1][0] - x) < 1e-6 ? i - 1 : i + 1;
        const mid = (y + pts[Math.min(j, last)][1]) / 2;
        let layer = elkRow.findIndex((r) => mid >= r.top - 1e-6 && mid <= r.bottom + 1e-6);
        if (layer < 0) layer = Math.max(0, elkRow.findIndex((r, k) => k + 1 < elkRow.length && mid >= r.bottom - 1e-6 && mid <= elkRow[k + 1].top + 1e-6));
        xs.push(maps[layer](x));
      }
      // y: the end points sit on their boxes; interior points lie in inter-tier gaps
      if (i === 0) ys.push(Math.abs(y - (ea.y + ea.h)) < 1e-6 ? a.y + a.h : a.y);
      else if (i === last) ys.push(Math.abs(y - eb.y) < 1e-6 ? b.y : b.y + b.h);
      else ys.push(mapY(y));
    }
    const mapped: Pt[] = xs.map((x, i) => [Number(x.toFixed(4)), Number(ys[i].toFixed(4))]);
    // Keep orthogonality: a run that was horizontal in ELK shares y (a zero-length ELK step becomes
    // a horizontal jog), a vertical run shares x.
    for (let i = 0; i + 1 < pts.length; i++) {
      if (Math.abs(pts[i][1] - pts[i + 1][1]) < 1e-6) mapped[i + 1][1] = mapped[i][1];
      else if (Math.abs(pts[i][0] - pts[i + 1][0]) < 1e-6) mapped[i + 1][0] = mapped[i][0];
      else return no(`edge ${sec.edge}: ELK route not orthogonal`);
    }
    if (mapped.some(([x, y]) => !Number.isFinite(x) || !Number.isFinite(y) || x < -1e-6 || x > W + 1e-6)) return no(`edge ${sec.edge}: point outside the sheet`);
    // End points on their own boxes; no interior crossing of any box.
    const onEdge = (p: Pt, n: SheetNode) => p[0] >= n.x - 1e-3 && p[0] <= n.x + n.w + 1e-3 && p[1] >= n.y - 1e-3 && p[1] <= n.y + n.h + 1e-3 && !inside(p, n, 1e-3);
    if (!onEdge(mapped[0], a) || !onEdge(mapped[mapped.length - 1], b)) return no(`edge ${sec.edge}: end not on its box ${JSON.stringify(mapped)}`);
    for (let i = 0; i + 1 < mapped.length; i++) for (const n of nodes.values()) if (segHits(mapped[i], mapped[i + 1], n)) return no(`edge ${sec.edge}: segment ${i} crosses box ${n.id}`);
    out.push({ edge: sec.edge, points: mapped });
  }
  return out;
}


/**
 * The route seam (to be called first in build/route.ts `routePlaced`, file_requests row 162):
 * ELK routes for every edge of `s` when an ELK plan for `s` is active and every mapped route is
 * clean; undefined otherwise (Studio's router then routes as before).
 */
export function activeElkRoutes(s: StudioDiagramV1, sheet: Sheet): RoutedEdge[] | undefined {
  const plan = elkPlanFor(s, sheet.widthMm);
  if (!plan || plan.routes === false) return undefined;
  const r = elkRoutesOnSheet(plan, s, sheet.nodes, sheet.widthMm);
  if (!r) return undefined;
  const edges = s.edges ?? [];
  return r.map(({ edge, points }) => ({ from: edges[edge].from, to: edges[edge].to, kind: edges[edge].kind, label: edges[edge].label, points, d: polylineD(points) }));
}
