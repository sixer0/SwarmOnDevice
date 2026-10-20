import { Effect } from "effect"
import { define } from "../internal"

export const ZenmuxPlugin = define({
  id: "zenmux",
  // Upstream attribution headers (HTTP-Referer, X-Title) dropped per rebrand decision 8 / register H04:
  // Swarm does not attribute its traffic to the upstream product at third-party gateways.
  effect: Effect.fn(function* (_ctx) {}),
})
