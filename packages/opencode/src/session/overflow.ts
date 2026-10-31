import type { Config } from "@/config/config"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import type { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import type { MessageV2 } from "./message-v2"

const COMPACTION_BUFFER = 20_000
// Every step re-sends the whole conversation, so its price grows with the context. Past this size, summarizing pays for
// itself within a few steps on any paid model, even though a 1M window would still have room.
const PAID_CONTEXT_TARGET = 200_000

export function usable(input: { cfg: ConfigV1.Info; model: Provider.Model; outputTokenMax?: number }) {
  const context = input.model.limit.context
  if (context === 0) return 0

  const reserved =
    input.cfg.compaction?.reserved ??
    Math.min(COMPACTION_BUFFER, ProviderTransform.maxOutputTokens(input.model, input.outputTokenMax))
  return input.model.limit.input
    ? Math.max(0, input.model.limit.input - reserved)
    : Math.max(0, context - ProviderTransform.maxOutputTokens(input.model, input.outputTokenMax))
}

/** Where a paid model's context should stop growing, or undefined when only the window itself limits it. */
export function priceTarget(input: { cfg: ConfigV1.Info; model: Provider.Model; outputTokenMax?: number }) {
  const configured = input.cfg.compaction?.max_context
  if (configured === 0) return undefined
  const cost = input.model.cost
  if (configured === undefined && !cost?.input) return undefined
  // Crossing a priced tier raises the rate of every token in the request, so stop short of the first one.
  const tiers = (cost?.tiers ?? []).filter((item) => item.tier.type === "context").map((item) => item.tier.size)
  const limit = configured ?? Math.min(PAID_CONTEXT_TARGET, ...tiers, ...(cost?.experimentalOver200K ? [200_000] : []))
  const reserved =
    input.cfg.compaction?.reserved ??
    Math.min(COMPACTION_BUFFER, ProviderTransform.maxOutputTokens(input.model, input.outputTokenMax))
  return Math.max(0, limit - reserved)
}

function count(tokens: SessionV1.Assistant["tokens"]) {
  return tokens.total || tokens.input + tokens.output + tokens.cache.read + tokens.cache.write
}

export function isOverflow(input: {
  cfg: ConfigV1.Info
  tokens: SessionV1.Assistant["tokens"]
  model: Provider.Model
  outputTokenMax?: number
}) {
  if (input.cfg.compaction?.auto === false) return false
  if (input.model.limit.context === 0) return false
  return count(input.tokens) >= usable(input)
}

/** The context still fits but has grown past what is worth paying to re-send on every step. */
export function isOverPriceTarget(input: {
  cfg: ConfigV1.Info
  tokens: SessionV1.Assistant["tokens"]
  model: Provider.Model
  outputTokenMax?: number
}) {
  if (input.cfg.compaction?.auto === false) return false
  const target = priceTarget(input)
  return target !== undefined && target > 0 && count(input.tokens) >= target
}
