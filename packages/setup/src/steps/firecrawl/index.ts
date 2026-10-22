// Firecrawl stack bring-up step (row 91, PC-CMP-07). Shares every lifecycle rule with the
// searxng step via src/stacklib.ts; the two compose files are two bring-up units under the ONE
// project swarm-tools (01e §3, R-1). Requires node + runtime (the lock's firecrawl.prerequisite).
//
// egress-proxy lift is CLEARED for this row: the squid pin (index 6a097f68… / linux-arm64
// eecf3533…) is controller-re-fetch-matched and equals tools.lock.json
// components.firecrawl.egress_proxy_image (equality asserted in test/stack_steps.test.ts against
// the controller-supplied reference; shipped code only checks the lock carries a digest-pinned
// value — no magic digest literal here). The rock's entrypoint is entrypoint.sh NOT Pebble (r77b
// correction), so the health gate is entrypoint-agnostic: it never encodes a Pebble assumption —
// whatever command form r85 rendered is what `compose up` starts, and the gate watches container
// health generically. No docker spawn, no port literal, no network primitive lives here.

import { createStepKit } from "../../stepkit.ts"
import {
  bringUp,
  egressProxyPinReady,
  firecrawlPlan,
  runnerGuard,
  tearDown,
  type StackStepContext,
} from "../../stacklib.ts"
import { deliverEstate } from "../../estate/deliver.ts"
import { OUTCOME } from "../../outcomes.ts"
import type { StepContext, StepModule, StepResult } from "../_template/index.ts"

type Ctx = StepContext & StackStepContext

export const step: StepModule = {
  id: "firecrawl",

  async install(ctx: Ctx): Promise<StepResult> {
    const guard = runnerGuard(ctx)
    if (guard) return guard
    const kit = createStepKit({ componentId: "firecrawl", lock: ctx.lock, state: ctx.state, dryRun: ctx.dryRun })

    // Fail-closed pre-check: the egress-proxy pin this stack depends on must be a digest-pinned
    // value in the lock. A null/tag-only field means the confirmed squid pin drifted out — refuse
    // rather than bring up a Firecrawl stack whose SSRF filter is unpinned (row 79 §8 cond. 3).
    const pin = egressProxyPinReady(ctx.lock)
    if (!pin.ok) {
      kit.log("error", "firecrawl: egress-proxy pin is not a confirmed digest reference", {
        context: { found: pin.found },
      })
      return {
        token: "FAILED",
        message: `egress-proxy pin unusable (${pin.found}); refusing bring-up until the controller-cleared squid digest is in tools.lock.json`,
      }
    }

    // Row 263 (D-262-1): the estate render-and-deliver STAGE runs on every install of this stack,
    // after consent and the pin pre-check and before bring-up consumes the artefacts. A refusal
    // here is final for this step — bring-up would only re-report the same precondition gaps.
    const delivery = deliverEstate({ kit })
    if (delivery.token !== OUTCOME.OK) return delivery

    // readiness (2026-10-20 healthcheck-contract ruling) rides through from the engine context;
    // with no prober wired the no-healthcheck services (api/playwright/egress-proxy once row 85
    // drops their wget checks) stay red by design — fail-closed, named per service in the verdict.
    const out = await bringUp({
      kit,
      plan: firecrawlPlan(),
      run: ctx.docker,
      ...(ctx.readiness ? { readiness: ctx.readiness } : {}),
    })
    return { token: out.token, message: out.message }
  },

  async remove(ctx: Ctx): Promise<StepResult> {
    const guard = runnerGuard(ctx)
    if (guard) return guard
    const kit = createStepKit({ componentId: "firecrawl", lock: ctx.lock, state: ctx.state, dryRun: ctx.dryRun })
    // remove() does NOT re-check the pin: teardown must always be able to clean up a stack even
    // after the lock changed underneath it. It resolves the file through the same pathsFor map.
    const out = await tearDown({ kit, plan: firecrawlPlan(), run: ctx.docker })
    return { token: out.token, message: out.message }
  },
}

export default step
