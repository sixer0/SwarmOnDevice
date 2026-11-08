/**
 * Swarm addition (row 162, U24 C): when Studio uses ELK for a diagram, and the async entry the
 * render paths call (`buildDiagramSvgAuto`).
 *
 * THE RULE (stated once, applied here only):
 *  R1. Only the families laid out by `layoutLayered` that carry no order meaning: `layered`,
 *      `topology` (`stack` keeps its author order; graph/flow/swimlane/sequence/sld/rack keep
 *      their own engines).
 *  R2. The original layout is built first. When it builds and the geometry lint finds NO route
 *      defect (connector crossing, connector through a box, collinear connector segments,
 *      connector through text), that result is returned unchanged, byte for byte: ELK never runs,
 *      so figures the old router handles well do not churn.
 *  R3. Otherwise (route defects > 0, or the old build failed with DATUM-32 "detour failed"), and
 *      the spec is inside the C8 bounds (<= 24 nodes, <= 48 edges), ELK computes the tier order
 *      and node x (`./adapter.ts`), and the SAME Studio build runs with that plan (Studio sizes,
 *      tier rhythm, lattice, router, labels, Rev A apparatus).
 *  R4. The ELK build is kept only when it builds, has FEWER route defects than the original and
 *      no higher total geometry score; otherwise the original result (or its error) stands.
 *      Either way, when ELK ran, `report.geometry` carries one REPORT `ELK_LAYOUT` line.
 *  Capacity refusals (DATUM-33 / DATUM-37*, row 158) are never retried with ELK: a figure that
 *  does not fit is refused, not squeezed (U24 B).
 */
import type { StudioDiagramV1 } from "../../../contract";
import { buildDiagramSvgRaw, withCaptionAbove, type DiagramBuildOptions, type DiagramSvgResult } from "../build";
import type { DiagramGeometryIssue } from "../build/autofit";
import { lintDiagramGeometry, type DiagramGeomLint } from "../fit/lint";
import { ELK_FAMILIES, ElkUnavailable, elkLayoutPlan, elkRefusal } from "./adapter";
import { withElkPlan, type ElkPlan } from "./plan";

export { ELK_FAMILIES, ELK_TIME_BUDGET_MS, ElkUnavailable, elkLayoutPlan, elkPlanWidth, elkRefusal } from "./adapter";
export { activeElkRoutes, elkRoutesOnSheet } from "./routes";
export { elkPlanFor, elkPlanKey, withElkPlan, type ElkPlan, type ElkRoute } from "./plan";

/** Geometry-lint defect kinds that are routing defects (R2). */
export const ROUTE_DEFECT_KINDS = ["edgeCross", "edgeThroughNode", "edgeCollinear", "lineThroughText"] as const;

export function routeDefects(g: DiagramGeomLint): number {
  return ROUTE_DEFECT_KINDS.reduce((sum, k) => sum + (g.counts[k] ?? 0), 0);
}

function checkIdOf(e: unknown): string {
  const d = (e as { details?: { checkId?: string } } | null)?.details;
  return d?.checkId ?? (e as { checkId?: string } | null)?.checkId ?? "";
}

/** R3: old build failures ELK may cure (a detour the router could not find). Capacity is never one. */
export function elkMayCure(e: unknown): boolean {
  return checkIdOf(e) === "DATUM-32";
}

export interface ElkDecision {
  used: boolean;
  reason: string;
  before?: { routeDefects: number; score: number };
  after?: { routeDefects: number; score: number };
}

export interface AutoBuildDeps {
  build?: (s: StudioDiagramV1, opts: DiagramBuildOptions) => DiagramSvgResult;
  plan?: (s: StudioDiagramV1, opts: DiagramBuildOptions) => Promise<ElkPlan>;
}

function withNote(r: DiagramSvgResult, d: ElkDecision): DiagramSvgResult {
  const line: DiagramGeometryIssue = {
    checkId: "ELK_LAYOUT",
    status: "REPORT",
    detail: `${d.used ? "ELK layout used" : "ELK layout not used"}: ${d.reason}`,
    suggest: d.used ? "tidak ada" : "ubah urutan simpul dalam tingkat atau pecah menjadi 2 diagram",
  };
  return { ...r, report: { ...r.report, geometry: [...(r.report.geometry ?? []), line] } };
}

/**
 * Build a diagram SVG, using ELK under the rule in the file head. Synchronous callers keep
 * `buildDiagramSvg` (original layout always); render paths that may use ELK await this.
 * `onDecision` receives what was decided (for tests and logs).
 */
export async function buildDiagramSvgAuto(
  s: StudioDiagramV1,
  opts: DiagramBuildOptions,
  deps: AutoBuildDeps = {},
  onDecision?: (d: ElkDecision) => void,
): Promise<DiagramSvgResult> {
  // Swarm row 165P (C205, CP-28/48): the layouts are linted and compared on the sheet as drawn (caption at the foot,
  // `buildDiagramSvgRaw`); the pick then gets its caption above the drawing (`withCaptionAbove`, idempotent).
  return withCaptionAbove(await buildDiagramSvgAutoRaw(s, opts, deps, onDecision));
}

async function buildDiagramSvgAutoRaw(
  s: StudioDiagramV1,
  opts: DiagramBuildOptions,
  deps: AutoBuildDeps,
  onDecision?: (d: ElkDecision) => void,
): Promise<DiagramSvgResult> {
  const build = deps.build ?? buildDiagramSvgRaw;
  const decide = (d: ElkDecision) => {
    onDecision?.(d);
    return d;
  };
  if (!ELK_FAMILIES.has(String(s.family))) {
    decide({ used: false, reason: `R1: family ${String(s.family)}` });
    return build(s, opts);
  }
  let first: DiagramSvgResult | undefined;
  let firstErr: unknown;
  try {
    first = build(s, opts);
  } catch (e) {
    if (!elkMayCure(e)) throw e;
    firstErr = e;
  }
  const g0 = first ? lintDiagramGeometry(first.svg) : undefined;
  const d0 = g0 ? routeDefects(g0) : Number.POSITIVE_INFINITY;
  if (first && d0 === 0) {
    decide({ used: false, reason: "R2: original layout has no route defect" });
    return first;
  }
  const refusal = elkRefusal(s);
  const before = g0 ? { routeDefects: d0, score: g0.score } : undefined;
  const keepFirst = (reason: string): DiagramSvgResult => {
    const d = decide({ used: false, reason, before });
    if (first) return withNote(first, d);
    throw firstErr;
  };
  if (refusal) return keepFirst(`R3: ${refusal}`);
  let plan: ElkPlan;
  try {
    plan = await (deps.plan ?? ((sp, o) => elkLayoutPlan(sp, { grid: o.grid })))(s, opts);
  } catch (e) {
    return keepFirst(e instanceof ElkUnavailable ? e.message : `ELK_LAYOUT: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`);
  }
  // Two ELK candidates: ELK positions + ELK routes (used only where the route seam takes them) and
  // ELK positions + Studio's router. The one with fewer route defects (then lower score) competes in R4.
  let second: DiagramSvgResult | undefined;
  let g1: DiagramGeomLint | undefined;
  let lastErr: unknown;
  for (const routes of [true, false]) {
    let r: DiagramSvgResult;
    try {
      r = withElkPlan({ ...plan, routes }, () => build(s, opts));
    } catch (e) {
      lastErr = e;
      continue;
    }
    if (second && r.svg === second.svg) continue;
    const g = lintDiagramGeometry(r.svg);
    if (!g1 || routeDefects(g) < routeDefects(g1) || (routeDefects(g) === routeDefects(g1) && g.score < g1.score)) {
      second = r;
      g1 = g;
    }
  }
  if (!second || !g1) {
    return keepFirst(`R4: ELK build failed (${checkIdOf(lastErr) || (lastErr instanceof Error ? lastErr.message.slice(0, 120) : String(lastErr))})`);
  }
  const after = { routeDefects: routeDefects(g1), score: g1.score };
  const better = !first || (after.routeDefects < d0 && g1.score <= (g0?.score ?? Number.POSITIVE_INFINITY));
  if (!better) {
    const d = decide({ used: false, reason: `R4: ELK not better (route defects ${d0} -> ${after.routeDefects}, score ${g0?.score} -> ${after.score})`, before, after });
    return withNote(first!, d);
  }
  const d = decide({
    used: true,
    reason: first ? `R3/R4: route defects ${d0} -> ${after.routeDefects}, geometry score ${g0!.score} -> ${after.score}` : `R3/R4: original failed DATUM-32; ELK route defects ${after.routeDefects}`,
    before,
    after,
  });
  return withNote(second, d);
}
