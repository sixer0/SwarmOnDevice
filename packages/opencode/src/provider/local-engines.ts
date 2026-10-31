import { totalmem } from "os"
import { sortBy } from "remeda"

export * as LocalEngines from "./local-engines"

// Engines people run models with on their own machine, found by asking them on loopback.
// Nothing leaves the machine, and a closed port answers in well under a millisecond.

export type LocalModel = {
  id: string
  family?: string
  context?: number
  tools: boolean
  vision: boolean
  reasoning: boolean
  loaded: boolean
  size?: number
}

export type LocalEngine = {
  id: "ollama" | "lmstudio" | "llamacpp"
  name: string
  baseURL: string
  models: LocalModel[]
}

const PROBE_TIMEOUT_MS = 400
const FRESH_FOR_MS = 2_000
const MAX_DETAILED_MODELS = 40

type Fetch = typeof globalThis.fetch
type Env = Record<string, string | undefined>

export async function detect(input: { env?: Env; fetch?: Fetch; totalMemory?: number } = {}): Promise<LocalEngine[]> {
  const env = input.env ?? process.env
  const fetch = input.fetch ?? globalThis.fetch
  const totalMemory = input.totalMemory ?? totalmem()
  const found = await Promise.all([ollama(env, fetch), lmStudio(env, fetch), llamaCpp(env, fetch)])
  return found
    .filter((engine): engine is LocalEngine => engine !== undefined && engine.models.length > 0)
    .map((engine) => ({ ...engine, models: rank(engine.models, totalMemory) }))
}

// The first model is the one Swarm starts with, so it has to be able to do the job: use tools, fit in
// memory, and preferably be loaded already. Among those, the largest is usually the most capable.
export function rank(models: LocalModel[], totalMemory: number) {
  return sortBy(
    models,
    (model) => (model.tools ? 0 : 1),
    (model) => (model.size !== undefined && model.size > totalMemory * 0.75 ? 1 : 0),
    (model) => (model.loaded ? 0 : 1),
    [(model) => model.size ?? 0, "desc"],
    (model) => model.id,
  )
}

// One probe at a time per process, shared by every project directory. Callers ask often (each picker
// opening, each model lookup), so an answer stays good briefly rather than re-asking every engine.
let cached: { at: number; engines: LocalEngine[] } | undefined
let inflight: Promise<LocalEngine[]> | undefined

export function current(): Promise<LocalEngine[]> {
  if (cached && Date.now() - cached.at < FRESH_FOR_MS) return Promise.resolve(cached.engines)
  if (inflight) return inflight
  inflight = detect()
    .then((engines) => {
      cached = { at: Date.now(), engines }
      return engines
    })
    .finally(() => {
      inflight = undefined
    })
  return inflight
}

export function reset() {
  cached = undefined
}

export function loopbackOrigin(value: string | undefined, fallbackPort: number) {
  if (!value) return `http://127.0.0.1:${fallbackPort}`
  const url = URL.parse(value.includes("://") ? value : `http://${value}`)
  if (!url) return undefined
  const port = url.port || String(fallbackPort)
  // 0.0.0.0 is how these servers are told to listen on all interfaces; they are still on this machine.
  if (["127.0.0.1", "localhost", "[::1]", "0.0.0.0"].includes(url.hostname)) return `http://127.0.0.1:${port}`
  // A remote host is not "on this device". It stays a job for a configured provider.
  return undefined
}

async function getJSON(fetch: Fetch, url: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) }).catch(() => undefined)
  if (!response) return unreachable
  if (!response.ok) return undefined
  return response.json().catch(() => undefined)
}

// Nothing answered, as opposed to an answer without what was asked for. A second request cannot help.
const unreachable = Symbol("unreachable")

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function list(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(record) : []
}

const text = (value: unknown) => (typeof value === "string" && value ? value : undefined)
const positive = (value: unknown) => (typeof value === "number" && value > 0 ? value : undefined)
const isEmbedding = (id: string) => /embed|bge-|nomic-|rerank/i.test(id)

async function ollama(env: Env, fetch: Fetch): Promise<LocalEngine | undefined> {
  const origin = loopbackOrigin(env.OLLAMA_HOST, 11434)
  if (!origin) return
  const tags = await getJSON(fetch, `${origin}/api/tags`)
  if (!tags || tags === unreachable) return
  const installed = list(record(tags).models).slice(0, MAX_DETAILED_MODELS)
  const models = await Promise.all(
    installed.map(async (item): Promise<LocalModel | undefined> => {
      const id = text(item.name)
      if (!id) return
      const show = record(
        await getJSON(fetch, `${origin}/api/show`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: id }),
        }),
      )
      const capabilities = Array.isArray(show.capabilities) ? show.capabilities : undefined
      if (capabilities ? !capabilities.includes("completion") : isEmbedding(id)) return
      const info = record(show.model_info)
      const contextKey = Object.keys(info).find((key) => key.endsWith(".context_length"))
      return {
        id,
        family: text(record(item.details).family),
        context: contextKey ? positive(info[contextKey]) : undefined,
        // Versions before capabilities existed: assume yes, the catalog default.
        tools: capabilities ? capabilities.includes("tools") : true,
        vision: capabilities?.includes("vision") ?? false,
        reasoning: capabilities?.includes("thinking") ?? false,
        loaded: false,
        size: positive(item.size),
      }
    }),
  )
  return {
    id: "ollama",
    name: "Ollama",
    baseURL: `${origin}/v1`,
    models: models.filter((model) => model !== undefined),
  }
}

async function lmStudio(env: Env, fetch: Fetch): Promise<LocalEngine | undefined> {
  const origin = loopbackOrigin(env.SWARM_LMSTUDIO_HOST, 1234)
  if (!origin) return
  const rich = await getJSON(fetch, `${origin}/api/v0/models`)
  if (rich === unreachable) return
  const rows = rich ? list(record(rich).data) : await openAIModels(fetch, origin)
  if (!rows) return
  return {
    id: "lmstudio",
    name: "LM Studio",
    baseURL: `${origin}/v1`,
    models: rows.flatMap((item): LocalModel[] => {
      const id = text(item.id)
      if (!id) return []
      if (text(item.type) ? item.type === "embeddings" : isEmbedding(id)) return []
      const capabilities = Array.isArray(item.capabilities) ? item.capabilities : undefined
      return [
        {
          id,
          family: text(item.arch),
          context: positive(item.max_context_length),
          tools: capabilities ? capabilities.includes("tool_use") : true,
          vision: item.type === "vlm",
          reasoning: false,
          loaded: item.state === "loaded",
        },
      ]
    }),
  }
}

async function llamaCpp(env: Env, fetch: Fetch): Promise<LocalEngine | undefined> {
  const origin = loopbackOrigin(env.SWARM_LLAMACPP_HOST, 8080)
  if (!origin) return
  const rows = await openAIModels(fetch, origin)
  // 8080 is a common port for unrelated servers: only trust one that says it is llama.cpp.
  if (!rows?.some((item) => item.owned_by === "llamacpp")) return
  return {
    id: "llamacpp",
    name: "llama.cpp",
    baseURL: `${origin}/v1`,
    models: rows.flatMap((item): LocalModel[] => {
      const id = text(item.id)
      if (!id) return []
      return [
        {
          id,
          context: positive(record(item.meta).n_ctx_train),
          tools: true,
          vision: false,
          reasoning: false,
          loaded: true,
          size: positive(record(item.meta).size),
        },
      ]
    }),
  }
}

async function openAIModels(fetch: Fetch, origin: string) {
  const body = record(await getJSON(fetch, `${origin}/v1/models`))
  return Array.isArray(body.data) ? list(body.data) : undefined
}
