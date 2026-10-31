import path from "path"
import { readFileSync } from "fs"
import { mkdir, rename, writeFile } from "fs/promises"
import { Global } from "@opencode-ai/core/global"
import { Effect } from "effect"

export * as ModelWindow from "./model-window"

// A self-hosted model is usually configured by name alone, with no context limit. The server knows its own window, so
// Swarm asks it and, failing that, believes what it says when a request is refused. Everything that already depends on
// `limit.context` (compaction, the usage ring) then works without anyone writing the number down.

const PROBE_TIMEOUT_MS = 3_000
const RETRY_AFTER_MS = 60_000
// Below this a number is not a context window: a stray field, or a limit nobody could run an agent in.
const SMALLEST_WINDOW = 1024
const LIMIT_FIELDS = ["max_model_len", "max_context_length", "context_length", "context_window", "max_input_tokens"]
const OUTPUT_FIELDS = ["max_output_tokens", "max_completion_tokens"]

type Known = Record<string, { context: number; output?: number; at: number }>
type LimitedModel = {
  id: string
  providerID: string
  limit: { context: number; output: number; input?: number }
  api?: { id?: string; npm?: string; url?: string }
}
type Provider = {
  id: string
  /** The stored key (auth.json or the provider's env), which `options.apiKey` does not carry until a request is built. */
  key?: string
  options?: Record<string, unknown>
  models: Record<string, LimitedModel & { api: { npm: string; url?: string } }>
}

// Losing this only means asking again, so a failure is noted and nothing else changes.
const warn = (message: string, error: unknown) =>
  Effect.runFork(Effect.logWarning(message, { service: "model-window", error: String(error) }))

const file = () => path.join(Global.Path.state, "model-window.json")
const key = (providerID: string, modelID: string) => `${providerID}/${modelID}`

// Models whose limits came from here rather than from config, so a later, better answer may replace them.
const learned = new WeakSet<object>()
const attempts = new Map<string, number>()
let known: Known | undefined

const usable = (value: unknown) =>
  typeof value === "number" && Number.isInteger(value) && value >= SMALLEST_WINDOW ? value : undefined
const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value)

/** Reads a model's window from an OpenAI-style `GET /models` body. vLLM, LM Studio, llama.cpp and gateways name it differently. */
export function fromModels(body: unknown, modelID: string) {
  const rows = isRecord(body) && Array.isArray(body.data) ? body.data : []
  const row = rows.find((item) => isRecord(item) && item.id === modelID)
  if (!isRecord(row)) return undefined
  const meta = isRecord(row.meta) ? row.meta : {}
  for (const value of [...LIMIT_FIELDS.map((field) => row[field]), meta.n_ctx, meta.n_ctx_train]) {
    const found = usable(value)
    if (found) return found
  }
  return undefined
}

/** Reads how much a model may answer with, when the server says. Most servers count that inside the window and do not. */
export function outputFromModels(body: unknown, modelID: string) {
  const rows = isRecord(body) && Array.isArray(body.data) ? body.data : []
  const row = rows.find((item) => isRecord(item) && item.id === modelID)
  if (!isRecord(row)) return undefined
  return OUTPUT_FIELDS.map((field) => usable(row[field])).find((value) => value !== undefined)
}

/** Reads the window out of a refusal, when the server states it. */
export function fromError(message: string) {
  const match =
    /maximum context length (?:is|of) ([\d,]+)/i.exec(message) ??
    /configured context size is ([\d,]+)/i.exec(message) ??
    /with ([\d,]+) maximum context length/i.exec(message) ??
    /context (?:length|size|window) (?:is |of |\(|is only )([\d,]+)/i.exec(message) ??
    /"?n_ctx"?\s*[:=]\s*(\d+)/i.exec(message)
  return match ? usable(Number(match[1].replaceAll(",", ""))) : undefined
}

// A small file, read once, so the first read after a restart already knows and no percentage flickers in later.
function load() {
  if (known) return known
  try {
    const parsed: unknown = JSON.parse(readFileSync(file(), "utf8"))
    known = isRecord(parsed) ? (parsed as Known) : {}
  } catch {
    known = {}
  }
  return known
}

async function save() {
  try {
    await mkdir(Global.Path.state, { recursive: true })
    const temporary = `${file()}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`
    await writeFile(temporary, JSON.stringify(known ?? {}, null, 2))
    await rename(temporary, file())
  } catch (error) {
    warn("could not save model windows", error)
  }
}

function remember(providerID: string, modelID: string, context: number, output?: number) {
  const store = load()
  const id = key(providerID, modelID)
  if (store[id]?.context === context && store[id]?.output === output) return
  store[id] = { context, ...(output ? { output } : {}), at: Date.now() }
  void save()
}

/** True when config did not say how large this model's context is. */
export const undeclared = (model: LimitedModel) => model.limit.context === 0 || learned.has(model)

/** Gives a model with undeclared limits what has been learned about it. Declared limits are never touched. */
export function apply<M extends LimitedModel>(model: M) {
  if (!undeclared(model)) return model
  const found = load()[key(model.providerID, model.id)]
  const context = found?.context
  if (!context) return model
  // What the server stated, or else the same split as a local engine's models: leaves room to answer.
  const output = found.output ?? Math.min(Math.floor(context / 4), 16_384)
  if (model.limit.context === context && model.limit.output === output) return model
  learned.add(model)
  model.limit = { ...model.limit, context, output }
  return model
}

/** A request was refused as too large: keep the window it stated, or else the largest prompt the server has accepted. */
export function learnFromRefusal(model: LimitedModel, message: string, accepted?: number) {
  if (!undeclared(model)) return
  const context = fromError(message) ?? usable(accepted)
  if (!context) return
  remember(model.providerID, model.id, context)
  apply(model)
}

async function probe(provider: Provider, baseURL: string, models: LimitedModel[]) {
  const apiKey = provider.options?.apiKey ?? provider.key
  const headers = new Headers(isRecord(provider.options?.headers) ? (provider.options.headers as HeadersInit) : {})
  if (typeof apiKey === "string" && apiKey && !headers.has("authorization"))
    headers.set("authorization", `Bearer ${apiKey}`)
  // The credentials are for this provider's own address, so a redirect elsewhere is treated as no answer.
  const response = await fetch(`${baseURL.replace(/\/+$/, "")}/models`, {
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    headers,
    redirect: [...headers].length > 0 ? "manual" : "follow",
  }).catch(() => undefined)
  if (!response?.ok) return
  // It answered, so its answer stands for as long as Swarm runs. Only an unreachable server is asked again.
  attempts.set(provider.id, Number.POSITIVE_INFINITY)
  const body: unknown = await response.json().catch(() => undefined)
  for (const model of models) {
    // The name in config can differ from the name the server knows it by.
    const id = model.api?.id ?? model.id
    const context = fromModels(body, id)
    if (context) remember(provider.id, model.id, context, outputFromModels(body, id))
  }
}

/**
 * Asks a configured OpenAI-compatible server about the models config left undeclared. Never waits on the network: a
 * server that is down must not slow anything, and what was learned last time is already there.
 */
export function discover(provider: Provider) {
  const models = Object.values(provider.models).filter(
    (model) => undeclared(model) && model.api.npm === "@ai-sdk/openai-compatible",
  )
  if (models.length === 0) return
  const baseURL = provider.options?.baseURL ?? models[0].api.url
  if (typeof baseURL !== "string" || !baseURL || baseURL.includes("${")) return
  const last = attempts.get(provider.id)
  if (last !== undefined && Date.now() - last < RETRY_AFTER_MS) return
  attempts.set(provider.id, Date.now())
  void probe(provider, baseURL, models).catch((error) => warn("window probe failed", error))
}

export function reset() {
  known = undefined
  attempts.clear()
}
