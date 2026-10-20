// SearXNG stack bring-up step (row 91, PC-CMP-06). Thin by design: every lifecycle rule
// (context/project/file scoping, preconditions, health gate, label-scoped teardown,
// provenance) lives in src/stacklib.ts and is shared with the firecrawl step — the two
// compose FILES are two bring-up units under the ONE project swarm-tools (01e §3, R-1).
//
// No docker spawn, no port literal, no network primitive lives here: the runner is injected
// by the engine (StackStepContext.docker, row 93 wiring); without it the step refuses honestly.

import { createStepKit } from "../../stepkit.ts"
import { bringUp, runnerGuard, searxngPlan, tearDown, type StackStepContext } from "../../stacklib.ts"
import type { StepContext, StepModule, StepResult } from "../_template/index.ts"

type Ctx = StepContext & StackStepContext

export const step: StepModule = {
  id: "searxng",

  async install(ctx: Ctx): Promise<StepResult> {
    const guard = runnerGuard(ctx)
    if (guard) return guard
    const kit = createStepKit({ componentId: "searxng", lock: ctx.lock, state: ctx.state, dryRun: ctx.dryRun })
    const out = await bringUp({ kit, plan: searxngPlan(), run: ctx.docker })
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
