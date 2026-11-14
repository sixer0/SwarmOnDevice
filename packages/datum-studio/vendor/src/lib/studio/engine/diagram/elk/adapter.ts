/**
 * Swarm addition (row 162, U24 C): ELK (elkjs 0.12.0) as the LAYOUT engine of the layered diagram
 * family. ELK computes the order of the nodes in each tier, their x centres and orthogonal edge
 * routes; Studio keeps drawing the SVG (lattice, tier rhythm, labels, Rev A apparatus).
 *
 * Security conditions of row 160 (verification/18_row160_engine_deps_security.md section 4):
 *  - C10: `elkjs/lib/elk.bundled.js` only, `new ELK()` with NO `workerUrl` and NO `workerFactory`.
 *    The ELK graph carries generated ids (`n0`, `e0`), sizes in mm and the fixed options below;
 *    agent text (labels, ids, classes) never becomes an ELK id or option.
 *    L4: in a runtime that defines `self` but not `document` (Bun) the bundle's worker module
 *    would install `self.onmessage` and export no FakeWorker (`new ELK()` then throws). The
 *    first construction therefore hides `self` for the synchronous constructor call only, so the
 *    bundle takes its CommonJS branch; `globalThis.onmessage` is checked unchanged afterwards.
 *  - C12: no `logging` / `measureExecutionTime` options.
 *  - C8: node/edge limits (FIGURE_BOUNDS.diagramNodes / diagramEdges, the pre-render capacity
 *    bounds) checked BEFORE layout; wall-clock budget checked after the run (ELK runs
 *    synchronously in-process and cannot be pre-empted; the size bound is the real guard).
 *  - C9: the ELK graph is built from generated ids only, so no agent key reaches ELK.
 *  - Every ELK failure is a rejected promise handled here (no unhandled rejection).
 *
 * Licence (C126): elk.bundled.js is EPL-2.0 OR GPL-3.0-or-later and must ship as its own
 * byte-unmodified file with LICENSE.md and a source notice; this module only imports it.
 */
import ELK from "elkjs/lib/elk.bundled.js";
import type { ElkExtendedEdge, ElkNode } from "elkjs/lib/elk-api";
import type { DiagramNode, StudioDiagramV1 } from "../../../contract";
import { FIGURE_BOUNDS } from "../../../contract/schema/figure-bounds";
import { DiagramDefect, LATTICE_Y, Sheet, resolveDiagramGrid, type DiagramGrid } from "../core";
import { baselineStepMm, latticeOf, nodeSize } from "../layout-a/geometry";
import { LAYERED_TIER_GAP_BASELINES, tierKey, tierWidthMm } from "../layout-a/layered";
import { FLOW_LR_CORRIDOR_UNITS, FLOW_RANK_GAP_BASELINES, flowDirectionOf, flowRanks, rankedFlowSizes, type FlowDirection } from "../layout-a/flow";
import { elkPlanKey, type ElkPlan } from "./plan";

/** Diagram families whose layout ELK may compute (both use `layoutLayered`; `stack` keeps its order as meaning). */
export const ELK_FAMILIES: ReadonlySet<string> = new Set(["layered", "topology"]);

/**
 * Swarm 1.2.6 row 46 (T-11, register N-111): ELK direction per Studio direction. The key is a
 * schema-validated enum value (`flowDirectionOf`), never agent text (C10 intent, SEC-23).
 * layered/topology always pass "TB", so their option map is unchanged.
 */
export const ELK_DIRECTION: Readonly<Record<FlowDirection, string>> = Object.freeze({ TB: "DOWN", LR: "RIGHT" });

/** Wall-clock budget of one ELK layout (C8 proposal: 10 s). */
export const ELK_TIME_BUDGET_MS = 10_000;

/** Why ELK did not produce a plan (the old layout then stands). */
export class ElkUnavailable extends DiagramDefect {
  constructor(message: string) {
    super(`ELK_LAYOUT: ${message}`, { checkId: "ELK_LAYOUT" });
  }
}

let elkInstance: InstanceType<typeof ELK> | undefined;

/** One in-process ELK (no worker), constructed under the L4 guard described in the file head. */
function elk(): InstanceType<typeof ELK> {
  if (elkInstance) return elkInstance;
  const g = globalThis as Record<string, unknown>;
  const onmessage = g.onmessage;
  const selfDesc = Object.getOwnPropertyDescriptor(globalThis, "self");
  const hide = typeof (globalThis as { document?: unknown }).document === "undefined" && selfDesc !== undefined && selfDesc.configurable === true;
  if (hide) Object.defineProperty(globalThis, "self", { value: undefined, configurable: true, writable: true });
  try {
    elkInstance = new ELK();
  } finally {
    if (hide) Object.defineProperty(globalThis, "self", selfDesc!);
  }
  if (g.onmessage !== onmessage) {
    g.onmessage = onmessage;
    elkInstance = undefined;
    throw new ElkUnavailable("elk.bundled.js changed globalThis.onmessage (row 160 L4); ELK not used");
  }
  return elkInstance;
}

/** Fixed Studio layout options (C10, C12). Numbers are mm; nothing comes from the spec. */
function layoutOptions(gapMm: number, layerGapMm: number, direction: FlowDirection = "TB"): Record<string, string> {
  return {
    "elk.algorithm": "layered",
    "elk.direction": ELK_DIRECTION[direction] ?? ELK_DIRECTION.TB,
    "elk.edgeRouting": "ORTHOGONAL",
    "elk.randomSeed": "1",
    // one component: every tier stays one ELK layer even when part of the graph is disconnected
    "elk.separateConnectedComponents": "false",
    // Studio tiers are the layers: interactive layering keeps the given y (tier) of every node.
    "elk.layered.layering.strategy": "INTERACTIVE",
    "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
    "elk.layered.nodePlacement.strategy": "SIMPLE",
    "elk.spacing.nodeNode": String(gapMm),
    "elk.layered.spacing.nodeNodeBetweenLayers": String(layerGapMm),
    "elk.spacing.edgeEdge": String(LATTICE_Y),
    "elk.spacing.edgeNode": String(LATTICE_Y),
    "elk.layered.spacing.edgeEdgeBetweenLayers": String(LATTICE_Y),
    "elk.layered.spacing.edgeNodeBetweenLayers": String(LATTICE_Y),
    "elk.padding": "[top=0.0,left=0.0,bottom=0.0,right=0.0]",
  };
}

export interface ElkPlanOptions {
  grid?: DiagramGrid;
}

/**
 * Can ELK lay this spec out at all (family and C8 bounds)? Reason when not. Row 46 (T-11): a ranked
 * flow (`flow` with `direction` "TB"/"LR") is eligible beside ELK_FAMILIES; a flow without
 * `direction` keeps the family refusal.
 */
/**
 * Swarm 1.2.8 row 56 (VIS-4, 01f §3.2.5): an edge that sets its own geometry (a route other than orthogonal, a side
 * other than auto, a slot, or bend points) makes the figure ELK-ineligible: ELK routes orthogonally and owns the ports
 * (`elkGraphFor` below). Explicit defaults count as absent, so every spec without these fields keeps its decision.
 */
export const ELK_EDGE_GEOMETRY_REASON = "edge geometry fields";

export function elkEdgeGeometry(s: StudioDiagramV1): boolean {
  return (s.edges ?? []).some((e) => {
    const g = e as { route?: unknown; from_side?: unknown; to_side?: unknown; from_slot?: unknown; to_slot?: unknown; via?: unknown };
    return (
      (g.route !== undefined && g.route !== "orthogonal") ||
      (g.from_side !== undefined && g.from_side !== "auto") ||
      (g.to_side !== undefined && g.to_side !== "auto") ||
      g.from_slot !== undefined ||
      g.to_slot !== undefined ||
      (Array.isArray(g.via) && g.via.length > 0)
    );
  });
}

export function elkRefusal(s: StudioDiagramV1): string | null {
  if (elkEdgeGeometry(s)) return ELK_EDGE_GEOMETRY_REASON;
  if (!ELK_FAMILIES.has(String(s.family)) && !flowDirectionOf(s)) return `family '${String(s.family)}' is not laid out by ELK`;
  const n = (s.nodes ?? []).length;
  const e = (s.edges ?? []).length;
  if (n > FIGURE_BOUNDS.diagramNodes) return `${n} nodes > ${FIGURE_BOUNDS.diagramNodes} (capacity bound)`;
  if (e > FIGURE_BOUNDS.diagramEdges) return `${e} edges > ${FIGURE_BOUNDS.diagramEdges} (capacity bound)`;
  return null;
}

/** What `elkGraphFor` hands to ELK and what the plan needs to map ELK's answer back. */
export interface ElkInput {
  graph: ElkNode;
  W: number;
  tiers: DiagramNode[][];
  tierIndex: Map<string, number>;
  back: Map<string, DiagramNode>;
  meta: Array<{ edge: number; reversed: boolean }>;
}

/**
 * The ELK graph of a layered/topology spec (pure; exported for the C10 test): generated ids
 * (`n<k>`, `e<k>`), mm sizes from Studio's own sizing, fixed options. Intra-tier edges are left out
 * (Studio routes them); an upward edge is given to ELK reversed so the tiers stay top-down.
 */
export function elkGraphFor(s: StudioDiagramV1, o: ElkPlanOptions = {}): ElkInput {
  const grid = resolveDiagramGrid(o.grid);
  const W = Number(s.width_mm);
  const lat = latticeOf(new Sheet(W, undefined, grid.latticeXMm));
  const dir = flowDirectionOf(s);
  if (dir) return elkGraphForRankedFlow(s, W, lat, dir);
  const gap = lat.x;
  const layerGap = baselineStepMm(s.family === "layered" ? LAYERED_TIER_GAP_BASELINES : 2, lat);

  // Tiers in spec order, as layoutLayered groups them.
  const tierIndex = new Map<string, number>();
  const tiers: DiagramNode[][] = [];
  const tierOfNode = new Map<string, number>();
  for (const n of s.nodes ?? []) {
    const t = tierKey(n);
    let i = tierIndex.get(t);
    if (i === undefined) {
      i = tiers.length;
      tierIndex.set(t, i);
      tiers.push([]);
    }
    tiers[i].push(n);
    if (!tierOfNode.has(n.id)) tierOfNode.set(n.id, i);
  }

  // Generated ids only (C10): n<k> per node, e<k> per edge.
  const gid = new Map<string, string>();
  const back = new Map<string, DiagramNode>();
  const children: ElkNode[] = [];
  let y0 = 0;
  tiers.forEach((group) => {
    const w = tierWidthMm(group.length, W, lat);
    let h = 0;
    for (const n of group) h = Math.max(h, nodeSize(n, lat, group)[1]);
    group.forEach((n, i) => {
      if (gid.has(n.id)) return; // duplicate id: validateSpec refuses it in the build
      const id = `n${gid.size}`;
      gid.set(n.id, id);
      back.set(id, n);
      children.push({ id, x: i * (w + gap), y: y0, width: w, height: h });
    });
    y0 += h + layerGap; // initial y only orders the layers (interactive layering)
  });
  const edges: ElkExtendedEdge[] = [];
  const meta: Array<{ edge: number; reversed: boolean }> = [];
  (s.edges ?? []).forEach((e, i) => {
    const a = gid.get(e.from);
    const b = gid.get(e.to);
    const ta = tierOfNode.get(e.from);
    const tb = tierOfNode.get(e.to);
    if (!a || !b || ta === undefined || tb === undefined || ta === tb) return; // intra-tier: Studio routes it
    const reversed = ta > tb;
    edges.push({ id: `e${edges.length}`, sources: [reversed ? b : a], targets: [reversed ? a : b] });
    meta.push({ edge: i, reversed });
  });

  const graph: ElkNode = { id: "root", layoutOptions: layoutOptions(gap, layerGap), children, edges };
  return { graph, W, tiers, tierIndex, back, meta };
}

/**
 * Row 46 (T-11, 01e §4.5): the ELK graph of a ranked flow. Layers = Studio ranks (`flowRanks`),
 * sizes = the ranked layout's own sizes (`rankedFlowSizes`), initial position along the main axis =
 * the rank offset (interactive layering keeps the ranks). TB: layers top-down, nodes `lx` apart,
 * ranks FLOW_RANK_GAP_BASELINES apart. LR: layers left to right FLOW_LR_CORRIDOR_UNITS lx apart,
 * nodes 2 baselines apart. Intra-rank edges are left out; a back edge is given reversed.
 */
function elkGraphForRankedFlow(s: StudioDiagramV1, W: number, lat: ReturnType<typeof latticeOf>, dir: FlowDirection): ElkInput {
  const fr = flowRanks(s);
  const { ranks, rankOf, widths, heights } = rankedFlowSizes(s, lat, W, dir, fr);
  const tb = dir === "TB";
  const gap = tb ? lat.x : baselineStepMm(2, lat);
  const layerGap = tb ? baselineStepMm(FLOW_RANK_GAP_BASELINES, lat) : FLOW_LR_CORRIDOR_UNITS * lat.x;
  const tierIndex = new Map<string, number>();
  const gid = new Map<string, string>();
  const back = new Map<string, DiagramNode>();
  const children: ElkNode[] = [];
  let main = 0;
  ranks.forEach((group, r) => {
    tierIndex.set(String(r), r);
    let cross = 0;
    let extent = 0;
    for (const n of group) {
      const id = `n${gid.size}`;
      gid.set(n.id, id);
      back.set(id, n);
      const w = widths[r];
      const h = heights.get(n.id)!;
      children.push(tb ? { id, x: cross, y: main, width: w, height: h } : { id, x: main, y: cross, width: w, height: h });
      cross += (tb ? w : h) + gap;
      extent = Math.max(extent, tb ? h : w);
    }
    main += extent + layerGap; // initial main-axis position only orders the layers (interactive layering)
  });
  const edges: ElkExtendedEdge[] = [];
  const meta: Array<{ edge: number; reversed: boolean }> = [];
  (s.edges ?? []).forEach((e, i) => {
    const a = gid.get(e.from);
    const b = gid.get(e.to);
    const ra = rankOf.get(e.from);
    const rb = rankOf.get(e.to);
    if (!a || !b || ra === undefined || rb === undefined || ra === rb) return; // intra-rank: Studio routes it
    const reversed = ra > rb;
    edges.push({ id: `e${edges.length}`, sources: [reversed ? b : a], targets: [reversed ? a : b] });
    meta.push({ edge: i, reversed });
  });
  const graph: ElkNode = { id: "root", layoutOptions: layoutOptions(gap, layerGap, dir), children, edges };
  return { graph, W, tiers: ranks, tierIndex, back, meta };
}

/**
 * Compute the ELK plan for a layered/topology spec on the sheet the build will use (same width
 * and lattice). Rejects with `ElkUnavailable` (never an unhandled rejection) when ELK cannot help.
 */
export async function elkLayoutPlan(s: StudioDiagramV1, o: ElkPlanOptions = {}): Promise<ElkPlan> {
  const refusal = elkRefusal(s);
  if (refusal) throw new ElkUnavailable(refusal);
  const { graph, W, tiers, tierIndex, back, meta } = elkGraphFor(s, o);
  const t0 = Date.now();
  let out: ElkNode;
  try {
    out = await elk().layout(graph);
  } catch (err) {
    if (err instanceof ElkUnavailable) throw err;
    throw new ElkUnavailable(`layout failed: ${err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200)}`);
  }
  const ms = Date.now() - t0;
  if (ms > ELK_TIME_BUDGET_MS) throw new ElkUnavailable(`layout took ${ms} ms > ${ELK_TIME_BUDGET_MS} ms`);

  const placed = out.children ?? [];
  // Row 46 (T-11): LR (ranked flow) has its cross axis on y; the TB frame shift and route import do not apply.
  const lr = flowDirectionOf(s) === "LR";
  let minX = Infinity;
  let maxX = -Infinity;
  for (const c of placed) {
    minX = Math.min(minX, c.x ?? 0);
    maxX = Math.max(maxX, (c.x ?? 0) + (c.width ?? 0));
  }
  if (!Number.isFinite(minX)) throw new ElkUnavailable("ELK returned no nodes");
  const shift = lr ? 0 : (W - (maxX - minX)) / 2 - minX; // ELK frame centred on the sheet, as the original centres tiers

  const cx: Record<string, number> = {};
  const box: ElkPlan["box"] = {};
  for (const c of placed) {
    const n = back.get(c.id);
    if (!n) continue;
    cx[n.id] = lr ? (c.y ?? 0) + (c.height ?? 0) / 2 : (c.x ?? 0) + (c.width ?? 0) / 2 + shift; // cross-axis centre
    box[n.id] = { x: (c.x ?? 0) + shift, y: c.y ?? 0, w: c.width ?? 0, h: c.height ?? 0 };
  }
  // Layers = tiers / ranks (interactive layering keeps them); order inside each by ELK x (TB) or y (LR).
  const order: Record<string, string[]> = {};
  const layers: string[][] = [];
  for (const [t, i] of tierIndex) {
    const ids = tiers[i].filter((n) => box[n.id]).map((n) => n.id);
    ids.sort((p, q) => (lr ? box[p].y - box[q].y : box[p].x - box[q].x));
    order[t] = ids;
    layers.push(ids);
  }
  // Interactive layering must have kept each tier in one ELK row (TB) / column (LR); otherwise the plan is not used.
  for (const ids of layers) {
    const ys = new Set(ids.map((id) => (lr ? box[id].x : box[id].y).toFixed(3)));
    if (ys.size > 1) throw new ElkUnavailable("ELK split a tier over two layers");
  }
  const sections: ElkPlan["sections"] = [];
  // Row 46 (T-11, 01e §4.5): ELK route import stays TB-only; an LR plan has no sections, so
  // `elkRoutesOnSheet` (sections.length !== edges.length) leaves routing to Studio's router.
  if (!lr) (out.edges ?? []).forEach((e, k) => {
    const sec = (e as ElkExtendedEdge).sections?.[0];
    if (!sec) return;
    const pts: Array<[number, number]> = [sec.startPoint, ...(sec.bendPoints ?? []), sec.endPoint].map((p) => [p.x + shift, p.y]);
    sections.push({ edge: meta[k].edge, reversed: meta[k].reversed, points: meta[k].reversed ? pts.reverse() : pts });
  });
  return { key: elkPlanKey(s), widthMm: W, order, cx, box, sections, layers, ...(flowDirectionOf(s) ? { direction: flowDirectionOf(s) } : {}) };
}

/** ELK frame width of a plan's widest layer (mm), for reports. */
export function elkPlanWidth(plan: ElkPlan): number {
  const xs = Object.values(plan.box);
  if (!xs.length) return 0;
  return Math.max(...xs.map((b) => b.x + b.w)) - Math.min(...xs.map((b) => b.x));
}
