import type { Message, PermissionRequest } from "@opencode-ai/sdk/v2/client"

type Price = { input: number; output: number; cache?: { read?: number; write?: number } }
type Provider = { id: string; models: Record<string, { cost?: Price } | undefined> }

export type SessionSpendKey = "writing" | "fresh" | "reread" | "subagents"

/** Splits what a session paid into what a person can act on. Prices come from the catalog, the total from what was billed. */
export function sessionSpend(input: { messages: Message[]; providers: Provider[]; subagentCost: number }) {
  const totals = { writing: 0, fresh: 0, reread: 0 }
  let saved = 0
  for (const message of input.messages) {
    if (message.role !== "assistant" || !message.cost) continue
    const price = input.providers.find((item) => item.id === message.providerID)?.models[message.modelID]?.cost
    if (!price) continue
    const tokens = message.tokens
    const read = price.cache?.read ?? 0
    const write = price.cache?.write ?? price.input
    const writing = ((tokens.output + tokens.reasoning) * price.output) / 1e6
    const fresh = (tokens.input * price.input + tokens.cache.write * write) / 1e6
    const reread = (tokens.cache.read * read) / 1e6
    const listed = writing + fresh + reread
    if (listed <= 0) continue
    // A higher-priced tier or a provider's own figure can differ from list price, and what was billed is the truth.
    const scale = message.cost / listed
    totals.writing += writing * scale
    totals.fresh += fresh * scale
    totals.reread += reread * scale
    saved += (scale * (tokens.cache.read * (price.input - read) - tokens.cache.write * (write - price.input))) / 1e6
  }
  const parts = { ...totals, subagents: input.subagentCost }
  const total = parts.writing + parts.fresh + parts.reread + parts.subagents
  if (total <= 0) return undefined
  const order: SessionSpendKey[] = ["fresh", "reread", "writing", "subagents"]
  return {
    total,
    saved: Math.max(0, saved),
    segments: order
      .filter((key) => parts[key] > 0)
      .map((key) => ({ key, cost: parts[key], percent: (parts[key] / total) * 100 })),
  }
}

/** What a spend limit question carries, or undefined for any other permission request. */
export function spendLimitDetail(request: Pick<PermissionRequest, "permission" | "metadata">) {
  if (request.permission !== "spend_limit") return undefined
  const value = (key: string) => {
    const raw = request.metadata?.[key]
    return typeof raw === "number" && Number.isFinite(raw) ? raw : 0
  }
  return {
    spent: value("spent"),
    next: value("next"),
    subagents: value("subagents"),
    subagentCost: value("subagentCost"),
  }
}

export const formatUsd = (value: number, locale: string) =>
  new Intl.NumberFormat(locale, { style: "currency", currency: "USD" }).format(value)
