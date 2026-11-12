/**
 * Port `layout_flow` (`HS/datum_diagram.py:482-532`): rantai berurutan, simpul
 * melebar untuk keputusan (P2 flow). `per_row` (ENH-D, E-30) membungkus rantai
 * menjadi baris (baris-dulu, kiri-kanan lalu turun); tanpa `per_row` satu kolom
 * vertikal terpusat.
 */
import type { DiagramBox, DiagramNode, DiagramSheet, LayoutResult, StudioDiagramV1 } from "../../../contract";
import { DiagramOverCapacity } from "../../figure-capacity";
import { GRAPH_EDGE_INSET_MM, type SheetEdgeInset } from "../core/sheet";
import { snapFloor } from "../core/tokens";
import { elkPlanFor, elkTierOrder, elkTierXs } from "../elk/plan";
import { diagramFitActive, diagramFitAllows, diagramFitNote } from "../fit/state";
import { fitTierWidth, grownHeight, planNodeText } from "../fit/text";
import { baselineStepMm, latticeOf, nodeSize, pyFloorDiv, pyInt, pyStr, pyTruthy, sheetHeight, snap, type Lattice } from "./geometry";

export function layoutFlow(s: StudioDiagramV1, sheet: DiagramSheet): LayoutResult {
  // Swarm 1.2.6 row 46 (T-11, N-109, C7): `direction` present = ranked flow (ranks from the edges);
  // absent = the legacy list layout below, byte-identical to 1.2.5.
  const dir = flowDirectionOf(s);
  if (dir) return layoutRankedFlow(s, sheet, dir);
  const lat = latticeOf(sheet);
  const W = sheet.widthMm;
  // D-242: dua baseline (Python: BASELINE_PT * 2 dibaca mm).
  const step = baselineStepMm(2, lat);
  const nodes: Record<string, DiagramBox> = {};
  const perRow = s.per_row;

  if (pyTruthy(perRow) && pyInt(Number(perRow)) > 0) {
    const gap = lat.x;
    // per_row adalah ATASAN: kolom dibatasi yang muat dengan lebar minimum 3 kisi.
    const kMax = pyInt(pyFloorDiv(W + gap, lat.x * 3 + gap));
    const k = Math.max(1, Math.min(pyInt(Number(perRow)), kMax));
    const rows = [];
    for (let i = 0; i < s.nodes.length; i += k) rows.push(s.nodes.slice(i, i + k));
    let y = lat.top;
    for (const group of rows) {
      const m = group.length;
      let w = snap((W - (m - 1) * gap) / m, lat.x);
      // snap bisa membulat ke atas dan meluapkan baris: susut sampai muat.
      while (m * w + (m - 1) * gap > W && w > lat.x * 3) w -= lat.x;
      w = Math.max(w, lat.x * 3);
      const hs: number[] = [];
      for (const n of group) {
        let [, h] = nodeSize(n, lat, group);
        if (n.shape === "diamond") h = snap(h * 1.25, lat.y);
        if (diagramFitActive()) {
          // FIG-02b P1-10: lebar baris sudah maksimum; bungkus label <= 3 baris, tinggi tumbuh.
          const plan = planNodeText(n, w, h);
          if (diagramFitAllows("grow")) h = grownHeight(h, plan, lat.y);
          if (plan.overflow) {
            diagramFitNote(
              "NODE_LABEL_LINES",
              `label simpul '${pyStr(n.id)}' butuh lebih dari 3 baris pada lebar ${w.toFixed(1)} mm (${m} simpul per baris)`,
              "persingkat label simpul (maks ~40 karakter); detail ke `sub`",
            );
          }
        }
        hs.push(h);
      }
      let hmax = -Infinity;
      for (const h of hs) if (h > hmax) hmax = h;
      const total = m * w + (m - 1) * gap;
      const x = snap(Math.max(0.0, (W - total) / 2.0), lat.x);
      group.forEach((n, i) => {
        const nx = x + i * (w + gap);
        const ww = Math.min(w, W - nx); // tidak boleh melewati tepi lembar
        nodes[n.id] = { x: nx, y, w: ww, h: hs[i] };
      });
      // Python: `y += hmax + snap(...)` = y + (hmax + langkah).
      y += hmax + step;
    }
    return { nodes, widthMm: W, heightMm: sheetHeight(lat, Object.values(nodes)) };
  }

  // Python juga menghitung `w = snap(W * 0.42, LATTICE_X)` di sini tetapi tidak
  // memakainya; dihilangkan tanpa efek pada koordinat.
  let y = lat.top;
  for (const n of s.nodes) {
    const [w0, nh] = nodeSize(n, lat);
    let nw = w0;
    if (n.shape === "diamond") nw = snap(nw * 1.6, lat.x);
    nodes[n.id] = { x: snap((W - nw) / 2.0, lat.x), y, w: nw, h: nh };
    y += nh + step;
  }
  return { nodes, widthMm: W, heightMm: sheetHeight(lat, Object.values(nodes)) };
}

// ---------------------------------------------------------------------------------------------
// Swarm 1.2.6 row 46 (T-11, 01e §4-§6, register N-109, N-112, N-161..N-164, C7 S17-1..S17-5):
// ranked flow. Ranks come from the edges (longest path, back edges ignored); TB puts the nodes of
// one rank side by side, LR stacks them in one column. Every x/w is a lattice multiple and every
// y/h a LATTICE_Y multiple, so `snapToLattice` never moves or clamps a ranked node; widths that do
// not fit are refused BEFORE placement (FIGURE_OVER_CAPACITY / DATUM-37-lebar), never clipped.
// ---------------------------------------------------------------------------------------------

/** N-161: minimum node width of a ranked flow, in lattice units lx (legacy flow and other families keep 3). */
export const FLOW_RANK_NODE_MIN_UNITS = 2;
/** N-162: TB distance between ranks in baselines (stub 1 + label corridor 2 + stub 1). */
export const FLOW_RANK_GAP_BASELINES = 4;
/** N-163: LR distance between rank columns, in lattice units lx. */
export const FLOW_LR_CORRIDOR_UNITS = 2;
/** N-112: most nodes one LR rank holds. */
export const FLOW_LR_MAX_PARALLEL = 6;

export type FlowDirection = "TB" | "LR";

/** Ranked-flow direction of a spec: only `flow` with exactly "TB" or "LR" (schema enum); else undefined. */
export function flowDirectionOf(s: Pick<StudioDiagramV1, "family"> & { direction?: unknown }): FlowDirection | undefined {
  if (s.family !== "flow") return undefined;
  return s.direction === "TB" || s.direction === "LR" ? s.direction : undefined;
}

export interface FlowRanks {
  /** Nodes per rank, rank 0 first, each rank in its placement order (01e §4.1 step 4). */
  ranks: DiagramNode[][];
  /** Node id -> rank index. */
  rankOf: Map<string, number>;
  /** Indices into `s.edges` of the back edges ignored for ranking (01e §4.1 step 2). */
  back: Set<number>;
}

/**
 * 01e §4.1: ranks of a flow from its edges. Deterministic: depth-first walk from the nodes without
 * incoming edge (spec order), then from any unvisited node (spec order); an edge to a node on the
 * walk stack is a back edge. Rank = longest forward path. Order inside a rank: rank 0 in spec order;
 * rank r by the mean position of its forward predecessors in rank r-1 (a node whose predecessors
 * all lie further up uses the mean position of all of them in their own ranks), ties by spec order.
 * Unknown edge ends (DATUM-24, refused by validateSpec) and self-loops are ignored.
 */
export function flowRanks(s: Pick<StudioDiagramV1, "nodes" | "edges">): FlowRanks {
  const nodes: DiagramNode[] = [];
  const index = new Map<string, number>();
  for (const n of s.nodes ?? []) {
    if (index.has(n.id)) continue; // duplicate id: validateSpec refuses it in the build
    index.set(n.id, nodes.length);
    nodes.push(n);
  }
  const N = nodes.length;
  const out: number[][] = nodes.map(() => []);
  const indeg = new Array<number>(N).fill(0);
  const edges = s.edges ?? [];
  edges.forEach((e, i) => {
    const a = index.get(e.from);
    const b = index.get(e.to);
    if (a === undefined || b === undefined || a === b) return;
    out[a].push(i);
    indeg[b] += 1;
  });
  const back = new Set<number>();
  const state = new Array<number>(N).fill(0); // 0 new, 1 on the walk stack, 2 done
  const walk = (v: number): void => {
    state[v] = 1;
    for (const i of out[v]) {
      const w = index.get(edges[i].to)!;
      if (state[w] === 1) back.add(i);
      else if (state[w] === 0) walk(w);
    }
    state[v] = 2;
  };
  for (let v = 0; v < N; v++) if (indeg[v] === 0 && state[v] === 0) walk(v);
  for (let v = 0; v < N; v++) if (state[v] === 0) walk(v);

  // Longest path over the forward edges (a DAG once back edges are dropped): Kahn order.
  const preds: number[][] = nodes.map(() => []);
  const fin = new Array<number>(N).fill(0);
  for (let v = 0; v < N; v++) {
    for (const i of out[v]) {
      if (back.has(i)) continue;
      const w = index.get(edges[i].to)!;
      preds[w].push(v);
      fin[w] += 1;
    }
  }
  const rank = new Array<number>(N).fill(0);
  const queue: number[] = [];
  for (let v = 0; v < N; v++) if (fin[v] === 0) queue.push(v);
  for (let q = 0; q < queue.length; q++) {
    const v = queue[q];
    for (const i of out[v]) {
      if (back.has(i)) continue;
      const w = index.get(edges[i].to)!;
      rank[w] = Math.max(rank[w], rank[v] + 1);
      if (--fin[w] === 0) queue.push(w);
    }
  }
  const R = N ? Math.max(...rank) + 1 : 0;
  const ranks: DiagramNode[][] = Array.from({ length: R }, () => []);
  const pos = new Array<number>(N).fill(0);
  for (let r = 0; r < R; r++) {
    const members: number[] = [];
    for (let v = 0; v < N; v++) if (rank[v] === r) members.push(v);
    if (r > 0) {
      const key = (v: number): number => {
        const near = preds[v].filter((p) => rank[p] === r - 1);
        const from = near.length ? near : preds[v];
        return from.length ? from.reduce((sum, p) => sum + pos[p], 0) / from.length : 0;
      };
      const keys = new Map(members.map((v) => [v, key(v)]));
      members.sort((a, b) => keys.get(a)! - keys.get(b)! || a - b);
    }
    members.forEach((v, i) => {
      pos[v] = i;
      ranks[r].push(nodes[v]);
    });
  }
  const rankOf = new Map<string, number>();
  ranks.forEach((g, r) => g.forEach((n) => rankOf.set(n.id, r)));
  return { ranks, rankOf, back };
}

/** Width the ranked flow may fill: the sheet minus the T-02 edge inset on both sides (N-016). */
function usableWidth(W: number): number {
  return W - 2 * GRAPH_EDGE_INSET_MM;
}

/** TB node-width cap for a rank of `m` nodes (01e §4.2 `cap_m`, on the usable width). */
export function flowTbCap(m: number, W: number, lx: number): number {
  return Math.floor((usableWidth(W) - (m - 1) * lx) / m / lx + 1e-9) * lx;
}

/** Most nodes one TB rank holds at width W (largest m with `cap_m` >= FLOW_RANK_NODE_MIN_UNITS lx). */
export function flowTbMaxPerRank(W: number, lx: number): number {
  let m = 1;
  while (flowTbCap(m + 1, W, lx) >= FLOW_RANK_NODE_MIN_UNITS * lx - 1e-9) m += 1;
  return m;
}

/** Most LR ranks at width W (all columns at the minimum width, corridors between). */
export function flowLrMaxRanks(W: number, lx: number): number {
  const minW = FLOW_RANK_NODE_MIN_UNITS * lx;
  const corr = FLOW_LR_CORRIDOR_UNITS * lx;
  return Math.max(1, Math.floor((usableWidth(W) + corr) / (minW + corr) + 1e-9));
}

/** What a ranked flow needs beyond the width capacity, or null when it fits (01e §6.5-6.7). */
export interface FlowRankOverload {
  rank: number | null;
  quantity: string;
  unit: string;
  measured: number;
  limit: number;
  message: string;
  suggestion: string;
}

export function flowRankOverload(dir: FlowDirection, ranks: readonly DiagramNode[][], W: number, lx: number): FlowRankOverload | null {
  if (dir === "TB") {
    const M = flowTbMaxPerRank(W, lx);
    const r = ranks.findIndex((g) => g.length > M);
    if (r < 0) return null;
    const m = ranks[r].length;
    const alt = W < 166 ? `width_mm 166 (maks ${flowTbMaxPerRank(166, lx)}), ` : "";
    return {
      rank: r,
      quantity: "simpul per peringkat",
      unit: "simpul",
      measured: m,
      limit: M,
      message: `DATUM-37: peringkat ${r} memuat ${m} simpul, maks ${M} pada ${W} mm (lebar simpul minimum ${(FLOW_RANK_NODE_MIN_UNITS * lx).toFixed(2)} mm)`,
      suggestion: `pakai ${alt}direction "LR" (maks ${FLOW_LR_MAX_PARALLEL} per peringkat), atau pecah menjadi 2 diagram`,
    };
  }
  const r = ranks.findIndex((g) => g.length > FLOW_LR_MAX_PARALLEL);
  if (r >= 0) {
    return {
      rank: r,
      quantity: "simpul per peringkat LR",
      unit: "simpul",
      measured: ranks[r].length,
      limit: FLOW_LR_MAX_PARALLEL,
      message: `DATUM-37: peringkat ${r} memuat ${ranks[r].length} simpul kiri-kanan, maks ${FLOW_LR_MAX_PARALLEL}`,
      suggestion: `pakai direction "TB" atau pecah menjadi 2 diagram`,
    };
  }
  const Rmax = flowLrMaxRanks(W, lx);
  if (ranks.length <= Rmax) return null;
  const alt = W < 166 ? ` atau width_mm 166 (maks ${flowLrMaxRanks(166, lx)} peringkat)` : "";
  return {
    rank: null,
    quantity: "peringkat",
    unit: "peringkat",
    measured: ranks.length,
    limit: Rmax,
    message: `DATUM-37: ${ranks.length} peringkat kiri-kanan, maks ${Rmax} pada ${W} mm`,
    suggestion: `pakai direction "TB"${alt}, atau pecah menjadi 2 diagram`,
  };
}

/** Refuse a ranked flow that does not fit the width (before placement, never clipped). */
function assertRankCapacity(dir: FlowDirection, ranks: readonly DiagramNode[][], W: number, lx: number): void {
  const o = flowRankOverload(dir, ranks, W, lx);
  if (!o) return;
  throw new DiagramOverCapacity(o.message, {
    checkId: "DATUM-37-lebar",
    family: "flow",
    quantity: o.quantity,
    unit: o.unit,
    measured: o.measured,
    limit: o.limit,
    suggestion: o.suggestion,
  });
}

/** Base node size of a ranked flow node (nodeSize; legacy diamond factors applied). */
function baseSize(n: DiagramNode, lat: Lattice): [number, number] {
  let [w, h] = nodeSize(n, lat);
  if (n.shape === "diamond") {
    w = snap(w * 1.6, lat.x);
    h = snap(h * 1.25, lat.y);
  }
  return [w, h];
}

export interface RankedFlowSizes {
  ranks: DiagramNode[][];
  rankOf: Map<string, number>;
  /** Node width per rank (all nodes of a rank share it). */
  widths: number[];
  /** Node height per node id (TB: the rank height; LR: the node's own height). */
  heights: Map<string, number>;
}

/**
 * 01e §4.2 sizes of a ranked flow (shared by the layout and the ELK adapter, so both agree on the
 * boxes). Throws FIGURE_OVER_CAPACITY / DATUM-37-lebar when the width capacity is exceeded.
 * With fit active (AUTO_FIT candidates) labels wrap up to 3 lines and heights grow, as in layered.
 */
export function rankedFlowSizes(s: StudioDiagramV1, lat: Lattice, W: number, dir: FlowDirection, fr: FlowRanks = flowRanks(s)): RankedFlowSizes {
  const { ranks, rankOf } = fr;
  assertRankCapacity(dir, ranks, W, lat.x);
  const minW = FLOW_RANK_NODE_MIN_UNITS * lat.x;
  const widths: number[] = [];
  const heights = new Map<string, number>();
  const fit = diagramFitActive();
  if (dir === "TB") {
    ranks.forEach((group) => {
      const m = group.length;
      const cap = Math.max(flowTbCap(m, W, lat.x), minW);
      let w = minW;
      let hmax = -Infinity;
      for (const n of group) {
        const [bw, bh] = baseSize(n, lat);
        w = Math.max(w, bw);
        hmax = Math.max(hmax, bh);
      }
      w = Math.min(w, cap);
      if (fit) {
        w = fitTierWidth(group, w, cap, lat.x, hmax).w;
        let grown = hmax;
        for (const n of group) {
          const plan = planNodeText(n, w, hmax);
          if (diagramFitAllows("grow")) grown = Math.max(grown, grownHeight(hmax, plan, lat.y));
          if (plan.overflow) noteLines(n, w, m);
        }
        hmax = grown;
      }
      widths.push(w);
      for (const n of group) heights.set(n.id, hmax);
    });
    return { ranks, rankOf, widths, heights };
  }
  // LR: one width per rank column, shrunk by whole lx (widest first) until the columns and the
  // corridors fit the usable width; never below the minimum (capacity checked above).
  const corr = FLOW_LR_CORRIDOR_UNITS * lat.x;
  const base = ranks.map((group) => group.map((n) => baseSize(n, lat)));
  ranks.forEach((_, r) => widths.push(Math.max(minW, ...base[r].map(([w]) => w))));
  const budget = usableWidth(W) - (ranks.length - 1) * corr;
  for (;;) {
    const total = widths.reduce((a, b) => a + b, 0);
    if (total <= budget + 1e-6) break;
    let widest = -1;
    widths.forEach((w, r) => {
      if (w > minW + 1e-9 && (widest < 0 || w > widths[widest] + 1e-9)) widest = r;
    });
    if (widest < 0) break; // unreachable: assertRankCapacity guarantees the minimum widths fit
    widths[widest] -= lat.x;
  }
  ranks.forEach((group, r) => {
    group.forEach((n, i) => {
      let h = base[r][i][1];
      if (fit) {
        const plan = planNodeText(n, widths[r], h);
        if (diagramFitAllows("grow")) h = grownHeight(h, plan, lat.y);
        if (plan.overflow) noteLines(n, widths[r], group.length);
      }
      heights.set(n.id, h);
    });
  });
  return { ranks, rankOf, widths, heights };
}

function noteLines(n: DiagramNode, w: number, m: number): void {
  diagramFitNote(
    "NODE_LABEL_LINES",
    `label simpul '${pyStr(n.id)}' butuh lebih dari 3 baris pada lebar ${w.toFixed(1)} mm (${m} simpul seperingkat)`,
    "persingkat label simpul (maks ~40 karakter); detail ke `sub`",
  );
}

/**
 * The ranked flow layout (01e §4.2). TB: ranks top-down, nodes of a rank side by side `lx` apart,
 * rank row centred (`snapFloor`), ranks FLOW_RANK_GAP_BASELINES apart. LR: rank columns left to
 * right FLOW_LR_CORRIDOR_UNITS lx apart, nodes of a rank stacked 2 baselines apart, each column
 * block centred vertically on the tallest block. With an active ELK plan for this spec (direction
 * in the plan key) the order inside each rank comes from ELK, and in TB also the node x (as the
 * layered family takes it); sizes, rank positions, snap and routing stay Studio's.
 * The sheet gets the T-02 edge inset request (row 59 hook, unit "rank").
 */
function layoutRankedFlow(s: StudioDiagramV1, sheet: DiagramSheet, dir: FlowDirection): LayoutResult {
  const lat = latticeOf(sheet);
  const W = sheet.widthMm;
  const fr = flowRanks(s);
  const { ranks, rankOf, widths, heights } = rankedFlowSizes(s, lat, W, dir, fr);
  (sheet as DiagramSheet & { edgeInset?: SheetEdgeInset }).edgeInset = { unit: "rank", groupOf: rankOf };
  const elk = elkPlanFor(s, W);
  const ordered = ranks.map((g, r) => (elk ? elkTierOrder(elk, String(r), g) : g));
  const boxes = new Map<string, DiagramBox>();
  if (dir === "TB") {
    const gap = lat.x;
    const step = baselineStepMm(FLOW_RANK_GAP_BASELINES, lat);
    let y = lat.top;
    ordered.forEach((group, r) => {
      const m = group.length;
      const w = widths[r];
      const h = heights.get(group[0].id)!;
      const total = m * w + (m - 1) * gap;
      const x0 = snapFloor((W - total) / 2, lat.x);
      const xs = elk ? elkTierXs(elk, group, w, gap, W, lat.x) : undefined;
      group.forEach((n, i) => boxes.set(n.id, { x: xs ? xs[i] : x0 + i * (w + gap), y, w, h }));
      y += h + step;
    });
  } else {
    const corr = FLOW_LR_CORRIDOR_UNITS * lat.x;
    const step = baselineStepMm(2, lat);
    const blockH = ordered.map((group) => group.reduce((sum, n) => sum + heights.get(n.id)!, 0) + (group.length - 1) * step);
    const tallest = Math.max(...blockH);
    const total = widths.reduce((a, b) => a + b, 0) + (ordered.length - 1) * corr;
    let x = snapFloor((W - total) / 2, lat.x);
    ordered.forEach((group, r) => {
      let y = lat.top + snapFloor((tallest - blockH[r]) / 2, lat.y);
      for (const n of group) {
        const h = heights.get(n.id)!;
        boxes.set(n.id, { x, y, w: widths[r], h });
        y += h + step;
      }
      x += widths[r] + corr;
    });
  }
  // Spec order (deterministic sheet insertion order, as the legacy branch).
  const nodes: Record<string, DiagramBox> = {};
  for (const n of s.nodes) {
    const b = boxes.get(n.id);
    if (b && !Object.prototype.hasOwnProperty.call(nodes, n.id)) nodes[n.id] = b;
  }
  return { nodes, widthMm: W, heightMm: sheetHeight(lat, Object.values(nodes)) };
}
