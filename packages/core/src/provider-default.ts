// A model the config set up with no price is what this person means to use, and one that bills per request stays a choice
// they make, whatever order the config lists them in. A provider that has both kinds is judged by model, not by name: its
// one free model must not carry its priced ones in, and it comes after a provider with no prices at all.

type Priced = { cost?: { input: number; output: number } }

const free = (model: Priced) => !model.cost || model.cost.input + model.cost.output === 0

export function freeDefault<P extends { models: Record<string, Priced> }>(
  providers: readonly P[],
): { provider: P; models: P["models"] } | undefined {
  const modelsOf = (provider: P) => Object.entries(provider.models)
  const whole = providers.find((provider) => modelsOf(provider).length > 0 && modelsOf(provider).every(([, m]) => free(m)))
  if (whole) return { provider: whole, models: whole.models }
  const mixed = providers.find((provider) => modelsOf(provider).some(([, m]) => free(m)))
  if (!mixed) return undefined
  return { provider: mixed, models: Object.fromEntries(modelsOf(mixed).filter(([, m]) => free(m))) as P["models"] }
}
