// SearXNG stack bring-up step (row 91, PC-CMP-06). Thin by design: every lifecycle rule
// (context/project/file scoping, preconditions, health gate, label-scoped teardown,
// provenance) lives in src/stacklib.ts and is shared with the firecrawl step — the two
// compose FILES are two bring-up units under the ONE project swarm-tools (01e §3, R-1).
//
// No docker spawn, no port literal, no network primitive lives here: the runner is injected
// by the engine (StackStepContext.docker, row 93 wiring); without it the step refuses honestly.
// The host-side readiness prober (StackStepContext.readiness, 2026-10-20 healthcheck-contract
// ruling) is likewise engine-injected and forwarded verbatim — this step owns no probing itself.

import { createStepKit } from "../../stepkit.ts"
import { bringUp, runnerGuard, searxngPlan, tearDown, type StackStepContext } from "../../stacklib.ts"
import { deliverEstate } from "../../estate/deliver.ts"
import { OUTCOME } from "../../outcomes.ts"
import type { StepContext, StepModule, StepResult } from "../_template/index.ts"

type Ctx = StepContext & StackStepContext

export const step: StepModule = {
  id: "searxng",

  async install(ctx: Ctx): Promise<StepResult> {
    const guard = runnerGuard(ctx)
    if (guard) return guard
    const kit = createStepKit({ componentId: "searxng", lock: ctx.lock, state: ctx.state, dryRun: ctx.dryRun })
    // Row 263 (D-262-1): the estate render-and-deliver STAGE runs on every install of this stack,
    // after consent (the engine gates both) and before bring-up consumes the artefacts. A refusal
    // here is final for this step — bring-up would only re-report the same precondition gaps.
    const delivery = deliverEstate({ kit })
    if (delivery.token !== OUTCOME.OK) return delivery
    const out = await bringUp({ kit, plan: searxngPlan(), run: ctx.docker, ...(ctx.readiness ? { readiness: ctx.readiness } : {}) })
    return { token: out.token, message: out.message }
  },

  async remove(ctx: Ctx): Promise<StepResult> {
    const guard = runnerGuard(ctx)
    if (guard) return guard
    const kit = createStepKit({ componentId: "searxng", lock: ctx.lock, state: ctx.state, dryRun: ctx.dryRun })
    const out = await tearDown({ kit, plan: searxngPlan(), run: ctx.docker })
    return { token: out.token, message: out.message }
  },
}

export default step
