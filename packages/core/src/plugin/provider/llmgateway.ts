import { Effect } from "effect"
import { define } from "../internal"

export const LLMGatewayPlugin = define({
  id: "llmgateway",
  // Upstream attribution headers (HTTP-Referer, X-Title, X-Source) dropped per rebrand decision 8 /
  // register H04: Swarm does not attribute its traffic to the upstream product at third-party gateways. The
  // integration-service guard existed only to scope that injection and is removed with it.
  effect: Effect.fn(function* (_ctx) {}),
})
