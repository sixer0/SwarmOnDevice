import { Effect } from "effect"
import { define } from "../internal"

export const CerebrasPlugin = define({
  id: "cerebras",
  effect: Effect.fn(function* (ctx) {
    // Upstream attribution header (X-Cerebras-3rd-Party-Integration) dropped per rebrand decision 8 /
    // register H04: Swarm does not attribute its traffic to the upstream product at third-party gateways.
    yield* ctx.aisdk.sdk(
      Effect.fn(function* (evt) {
        if (evt.package !== "@ai-sdk/cerebras") return
        const mod = yield* Effect.promise(() => import("@ai-sdk/cerebras"))
        evt.sdk = mod.createCerebras(evt.options)
      }),
    )
  }),
})
