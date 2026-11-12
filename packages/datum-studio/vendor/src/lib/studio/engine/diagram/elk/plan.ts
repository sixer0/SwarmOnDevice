/**
 * Swarm addition (row 162, U24 C): the ELK layout plan as the synchronous diagram build reads it.
 *
 * ELK (elkjs) runs asynchronously (`./adapter.ts`); the Studio diagram build is synchronous. The
 * adapter therefore computes a plan first, and the build runs inside `withElkPlan(plan, ...)`;
 * `layout-a/layered.ts` asks `elkPlanFor(s, W)` and, when a plan for exactly this spec and sheet
 * width is active, takes the tier ORDER and the node x CENTRES from ELK. Everything else (tier y,
 * node width and height, label fit, lattice snap, routing, apparatus, Rev A drawing) stays Studio's.
 *
 * This module has no ELK import and no build import (no import cycle through contract/dispatch).
 */
import type { DiagramNode, StudioDiagramV1 } from "../../../contract";
import { snap } from "../core/geometry";

/** One ELK edge route in sheet mm, for the route seam (file_requests, row 162). */
export interface ElkRoute {
  /** Index into `s.edges`. */
  edge: number;
  points: Array<[number, number]>;
}

export interface ElkPlan {
  /** Spec identity the plan was computed for (id + width + node ids in spec order). */
  key: string;
  widthMm: number;
  /** Tier key (as layered.ts `tierKey`) -> node ids in ELK order (left to right). */
  order: Record<string, string[]>;
  /** ELK node centre x in mm (ELK frame shifted so the widest layer starts at the sheet's left edge). */
  cx: Record<string, number>;
  /** ELK node boxes in ELK frame (mm), for route mapping. */
  box: Record<string, { x: number; y: number; w: number; h: number }>;
  /** ELK orthogonal edge sections in ELK frame (mm); intra-tier edges are absent (Studio routes them). */
  sections: Array<{ edge: number; reversed: boolean; points: Array<[number, number]> }>;
  /** Node ids per ELK layer, top to bottom (= Studio tiers in order). */
  layers: string[][];
  /** false = positions only (Studio's router routes); absent/true = ELK routes when the route seam asks. */
  routes?: boolean;
  /**
   * Swarm 1.2.6 row 46 (T-11, register N-164): layout direction ELK ran in. "TB" (= absent, every
   * layered/topology plan) or "LR" (ranked flow `direction: "LR"`). Layers are the Studio tiers or
   * the ranked-flow ranks; `order` is sorted by ELK x (TB) or ELK y (LR) and `cx` is the CROSS-axis
   * centre (x for TB, y for LR). An LR plan carries no edge sections (ELK route import is TB-only).
   */
  direction?: "TB" | "LR";
}

/**
 * Spec identity: the same plan never applies to another spec or width. Row 46 (T-11): a spec with
 * `direction` adds it, so a TB plan never applies to an LR copy of the spec (a spec without
 * `direction` keeps the 1.2.5 key).
 */
export function elkPlanKey(s: StudioDiagramV1): string {
  const base = [String(s.id), Number(s.width_mm), String(s.family), (s.nodes ?? []).map((n) => String(n.id))];
  const dir = (s as { direction?: unknown }).direction;
  return JSON.stringify(dir === undefined ? base : [...base, String(dir)]);
}

let active: ElkPlan | undefined;

/** Run `fn` (a synchronous build) with `plan` active; always cleared afterwards. */
export function withElkPlan<T>(plan: ElkPlan, fn: () => T): T {
  const prev = active;
  active = plan;
  try {
    return fn();
  } finally {
    active = prev;
  }
}

/** The active plan when it was computed for this spec at this sheet width; else undefined. */
export function elkPlanFor(s: StudioDiagramV1, widthMm: number): ElkPlan | undefined {
  if (!active) return undefined;
  if (Math.abs(active.widthMm - widthMm) > 1e-6) return undefined;
  return active.key === elkPlanKey(s) ? active : undefined;
}

/** Tier group in ELK order (nodes ELK did not see keep their spec order, after the ELK ones). */
export function elkTierOrder(plan: ElkPlan, tier: string, group: readonly DiagramNode[]): DiagramNode[] {
  const ids = plan.order[tier];
  if (!ids) return [...group];
  const rank = new Map(ids.map((id, i) => [id, i]));
  return group
    .map((n, i) => ({ n, i }))
    .sort((a, b) => (rank.get(a.n.id) ?? ids.length + a.i) - (rank.get(b.n.id) ?? ids.length + b.i) || a.i - b.i)
    .map((x) => x.n);
}

/**
 * Swarm 1.2.6 (FX-7, M2 S3): the one two-pass clamp of a tier's left x values (mm), used by the ELK
 * tier placement below and by the ranked-flow TB placement (layout-a/flow.ts `underPredecessors`).
 * Left to right each x is pushed to >= 0 and >= its left neighbour + `w + gap`; right to left it is
 * pulled to <= `xMax` (the last node) and <= its right neighbour - `w - gap`. `xMax` is the caller's
 * explicit window (largest left x of a node). Mutates and returns `xs`; undefined when the first x
 * still falls left of 0 (the tier does not fit the window).
 */
export function clampTierXs(xs: number[], w: number, gap: number, xMax: number): number[] | undefined {
  const m = xs.length;
  for (let i = 0; i < m; i++) xs[i] = Math.max(xs[i], i === 0 ? 0 : xs[i - 1] + w + gap);
  for (let i = m - 1; i >= 0; i--) xs[i] = Math.min(xs[i], i === m - 1 ? xMax : xs[i + 1] - w - gap);
  return m && xs[0] < -1e-6 ? undefined : xs;
}

/**
 * Left x (mm, on the lattice `lx`) of each node of one tier, from the ELK centres: each node as near
 * its ELK centre as the lattice allows, kept `gap` apart and inside [0, W]. Undefined when the tier
 * does not fit (the caller then centres the tier as the original layout does).
 * FX-7 (M2 S3): `win` = explicit lattice window [0, win] for the node boxes (ranked flow TB passes the
 * T-02 inset window); absent = the full sheet width W as before (layered/topology bytes unchanged).
 */
export function elkTierXs(plan: ElkPlan, group: readonly DiagramNode[], w: number, gap: number, W: number, lx: number, win?: number): number[] | undefined {
  const m = group.length;
  const fit = win ?? W;
  if (!m || m * w + (m - 1) * gap > fit + 1e-6) return undefined;
  const xs = group.map((n) => {
    const c = plan.cx[n.id];
    return Number.isFinite(c) ? snap(c - w / 2, lx) : Number.NaN;
  });
  if (xs.some((x) => !Number.isFinite(x))) return undefined;
  const out = clampTierXs(xs, w, gap, win === undefined ? Math.floor((W - w) / lx + 1e-9) * lx : win - w);
  return out?.map((x) => Number(x.toFixed(6)) || 0); // never -0 (printed as "-0.0")
}
