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
}

/** Spec identity: the same plan never applies to another spec or width. */
export function elkPlanKey(s: StudioDiagramV1): string {
  return JSON.stringify([String(s.id), Number(s.width_mm), String(s.family), (s.nodes ?? []).map((n) => String(n.id))]);
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
 * Left x (mm, on the lattice `lx`) of each node of one tier, from the ELK centres: each node as near
 * its ELK centre as the lattice allows, kept `gap` apart and inside [0, W]. Undefined when the tier
 * does not fit (the caller then centres the tier as the original layout does).
 */
export function elkTierXs(plan: ElkPlan, group: readonly DiagramNode[], w: number, gap: number, W: number, lx: number): number[] | undefined {
  const m = group.length;
  if (!m || m * w + (m - 1) * gap > W + 1e-6) return undefined;
  const xs = group.map((n) => {
    const c = plan.cx[n.id];
    return Number.isFinite(c) ? snap(c - w / 2, lx) : Number.NaN;
  });
  if (xs.some((x) => !Number.isFinite(x))) return undefined;
  for (let i = 0; i < m; i++) xs[i] = Math.max(xs[i], i === 0 ? 0 : xs[i - 1] + w + gap);
  for (let i = m - 1; i >= 0; i--) xs[i] = Math.min(xs[i], i === m - 1 ? Math.floor((W - w) / lx + 1e-9) * lx : xs[i + 1] - w - gap);
  if (xs[0] < -1e-6) return undefined;
  return xs.map((x) => Number(x.toFixed(6)) || 0); // never -0 (printed as "-0.0")
}
