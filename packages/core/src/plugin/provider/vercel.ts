import { Effect } from "effect"
import { define } from "../internal"

export const VercelPlugin = define({
  id: "vercel",
  effect: Effect.fn(function* (ctx) {
    // Upstream attribution headers (http-referer, x-title) dropped per rebrand decision 8 / register H04:
    // Swarm does not attribute its traffic to the upstream product at third-party gateways.
    yield* ctx.aisdk.sdk(
      Effect.fn(function* (evt) {
        if (evt.package !== "@ai-sdk/vercel") return
        const mod = yield* Effect.promise(() => import("@ai-sdk/vercel"))
        evt.sdk = mod.createVercel(evt.options)
      }),
    )
  }),
})
