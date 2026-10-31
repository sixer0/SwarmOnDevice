// What a model will cost, from the catalog's own prices. Absent means unknown: a model priced at zero
// that does not run locally is usually billed some other way (a subscription), so it is never called free.

type Tokens = { input: number; output: number; reasoning?: number; cache?: { read: number; write: number } }
type Cost = { input: number; output: number; cache?: { read: number; write: number } }
type OnDevice = { source?: string; options?: Record<string, unknown> }
type Model = { name: string; cost?: Cost; provider: OnDevice }

export const isOnDeviceProvider = (provider: OnDevice) => provider.options?.onDevice === true
export const isOnDevice = (model: { provider: OnDevice }) => isOnDeviceProvider(model.provider)

export function formatPrice(value: number) {
  if (value >= 100) return `$${Math.round(value)}`
  // Two significant figures below $1, so $0.075 does not read as $0.08.
  return `$${value < 1 ? Number(value.toPrecision(2)) : Number(value.toFixed(2))}`
}

export const hasPrice = (model: Pick<Model, "cost">) => !!model.cost && model.cost.input + model.cost.output > 0

export const priceLabel = (model: Pick<Model, "cost">) =>
  hasPrice(model) ? `${formatPrice(model.cost!.input)} / ${formatPrice(model.cost!.output)}` : undefined

// Cheapest first, so a provider's list reads as a budget ladder. Unpriced models keep their name order after
// the priced ones; local models keep the server's order, which is already ranked for this machine.
export function compareModels(a: Model, b: Model) {
  if (isOnDevice(a) && isOnDevice(b)) return 0
  const left = hasPrice(a) ? a.cost!.input + a.cost!.output : Number.POSITIVE_INFINITY
  const right = hasPrice(b) ? b.cost!.input + b.cost!.output : Number.POSITIVE_INFINITY
  if (left !== right) return left - right
  return a.name.localeCompare(b.name)
}

// A provider written into config is what this person means to use. Anything Swarm found by itself comes after it.
const isConfigured = (provider: OnDevice) => provider.source === "config" && !isOnDeviceProvider(provider)
const pickerRank = (provider: OnDevice) => (isConfigured(provider) ? 0 : isOnDeviceProvider(provider) ? 1 : 2)
const defaultRank = (provider: OnDevice) => (isConfigured(provider) ? 0 : isOnDeviceProvider(provider) ? 2 : 1)

/** Order of the picker's groups. */
export const compareProviders = (a: OnDevice, b: OnDevice) => pickerRank(a) - pickerRank(b)
/** Which connected provider a session starts on when nothing has been chosen yet. */
export const compareProviderDefaults = (a: OnDevice, b: OnDevice) => defaultRank(a) - defaultRank(b)

export function sumTokens(tokens: Tokens[]) {
  if (tokens.length === 0) return
  const total = tokens.reduce<Required<Tokens>>(
    (sum, item) => ({
      input: sum.input + item.input,
      output: sum.output + item.output,
      reasoning: sum.reasoning + (item.reasoning ?? 0),
      cache: { read: sum.cache.read + (item.cache?.read ?? 0), write: sum.cache.write + (item.cache?.write ?? 0) },
    }),
    { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  )
  return total.input + total.output + total.reasoning + total.cache.read + total.cache.write > 0 ? total : undefined
}

// The tokens this session really used, at another model's prices. Cache rates fall back to the input rate
// when the catalog has none. Long-context surcharges are ignored, so callers present this as an estimate.
export function repriceSession(tokens: Required<Tokens>, cost: Cost) {
  return (
    (tokens.input * cost.input +
      (tokens.output + tokens.reasoning) * cost.output +
      tokens.cache.read * (cost.cache?.read || cost.input) +
      tokens.cache.write * (cost.cache?.write || cost.input)) /
    1_000_000
  )
}
