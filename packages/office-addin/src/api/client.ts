// Pane API layer (plan M8-04; REG rev 5 §4, §5, §7.1, §7.3, §7.4).
//
// - Swarm routes (P1-P8) go through `@opencode-ai/sdk/v2/client`, imported by subpath only
//   (never the package root, REG §7.1), with baseUrl `https://localhost:46317/swarm`.
// - Every request carries `X-Swarm-Office: 1`; every request made while a token is stored
//   also carries `X-Swarm-Office-Token` (REG §5). The token is read per request, so pairing
//   or sign-out never needs a new client.
// - Bridge-local routes (`/pair/*`, `/bridge/health`) are plain fetch calls: they are not
//   Swarm routes and are never proxied.
// - Request bodies are minimal by construction: create sends `{title, host}` only (P2),
//   prompt_async sends `{parts}` only (P6/§7.4). The pane never sends `system`, `tools`,
//   `agent`, `model` or `permission` (C30); tests pin this.
//
// Failures never throw: every call returns `{ok: false, status, code}` where `status` is the
// HTTP status (0 for a network-level failure) and `code` the bridge error code from the
// `{error: CODE}` body (REG §7.6). The shell feeds these to the state machine as `apiError`
// / `verify` / `pairResponse` events, which own user feedback (FS §8.2).
import { createOpencodeClient, type Session, type SessionMessagesResponses } from "@opencode-ai/sdk/v2/client"
import {
  OFFICE_CSRF_HEADER,
  OFFICE_CSRF_HEADER_VALUE,
  OFFICE_HISTORY_LIMIT,
  OFFICE_ORIGIN,
  OFFICE_PATH_BRIDGE_HEALTH,
  OFFICE_PATH_PAIR_REQUEST,
  OFFICE_PATH_PAIR_STATUS,
  OFFICE_PATH_PAIR_VERIFY,
  OFFICE_PATH_PROXY,
  OFFICE_RECENT_CHATS_LIMIT,
  OFFICE_TOKEN_HEADER,
} from "../constants"
import type { OfficeHost, TextPart } from "../state/prompt"

export type Fetch = (input: Request) => Promise<Response>

export type ApiFailure = { ok: false; status: number; code?: string }
type ApiResult<T> = { ok: true; status: number; data: T } | ApiFailure

export type HistoryEntry = SessionMessagesResponses[200][number]

type OfficeApiOptions = {
  // Returns the stored pairing token, or undefined before pairing (REG §5).
  token: () => string | undefined
  // Injected for tests; defaults to the global fetch.
  fetch?: Fetch
  // Defaults to the register origin `https://localhost:46317`.
  origin?: string
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : undefined

const errorCode = (body: unknown) => {
  const code = record(body)?.error
  return typeof code === "string" ? code : undefined
}

async function readJson(response: Response) {
  const text = await response.text().catch(() => "")
  if (!text) return undefined
  return Promise.resolve()
    .then(() => JSON.parse(text) as unknown)
    .catch(() => undefined)
}

// Adds the two Office headers to one request. Exported for the event stream, which opens
// its own fetch per subscription.
function officeFetch(base: Fetch, token: () => string | undefined): Fetch {
  return (input) => {
    const request = new Request(input)
    request.headers.set(OFFICE_CSRF_HEADER, OFFICE_CSRF_HEADER_VALUE)
    const value = token()
    if (value) request.headers.set(OFFICE_TOKEN_HEADER, value)
    return base(request)
  }
}

// The SDK option is typed as the global `fetch` (Bun's type adds `preconnect`); the pane only
// ever passes Request objects through it.
export function asGlobalFetch(fn: Fetch): typeof globalThis.fetch {
  return Object.assign((input: RequestInfo | URL, init?: RequestInit) => fn(new Request(input, init)), {
    preconnect: () => {},
  })
}

type SdkResult<T> = { data?: T; error?: unknown; response?: Response } | undefined

async function settle<T>(call: () => Promise<SdkResult<T>>): Promise<ApiResult<T>> {
  const result = await call().catch(() => undefined)
  const response = result?.response
  if (!response) return { ok: false, status: 0 }
  if (!response.ok) return { ok: false, status: response.status, code: errorCode(result?.error) }
  return { ok: true, status: response.status, data: result.data as T }
}

export function createOfficeApi(options: OfficeApiOptions) {
  const origin = options.origin ?? OFFICE_ORIGIN
  const base: Fetch = options.fetch ?? ((request) => globalThis.fetch(request))
  const send = officeFetch(base, options.token)
  const client = createOpencodeClient({
    baseUrl: `${origin}${OFFICE_PATH_PROXY}`,
    headers: { [OFFICE_CSRF_HEADER]: OFFICE_CSRF_HEADER_VALUE },
    fetch: asGlobalFetch(send),
  })

  async function local(path: string, init?: { method: "POST"; body: unknown }) {
    const request = new Request(`${origin}${path}`, {
      method: init?.method ?? "GET",
      headers: init ? { "Content-Type": "application/json" } : undefined,
      body: init ? JSON.stringify(init.body) : undefined,
    })
    const response = await send(request).catch(() => undefined)
    if (!response) return { status: 0, body: undefined }
    return { status: response.status, body: await readJson(response) }
  }

  return {
    client,
    fetch: send,
    origin,

    // GET /bridge/health -> ready when the sidecar answered `ready` (FS T4).
    async health() {
      const result = await local(OFFICE_PATH_BRIDGE_HEALTH)
      return { status: result.status, ready: result.status === 200 && record(result.body)?.swarm === "ready" }
    },

    // POST /pair/request {host} -> 202 {requestId, code, expiresAt} (REG §5).
    async pairRequest(host: OfficeHost) {
      const result = await local(OFFICE_PATH_PAIR_REQUEST, { method: "POST", body: { host } })
      const body = record(result.body)
      const requestId = typeof body?.requestId === "string" ? body.requestId : undefined
      const code = typeof body?.code === "string" ? body.code : undefined
      const expiresAt = typeof body?.expiresAt === "string" ? body.expiresAt : undefined
      return { status: result.status, requestId, code, expiresAt, error: errorCode(result.body) }
    },

    // GET /pair/status?requestId=<id> -> {state, token?}. The token is returned unchecked;
    // the state machine validates its format before storing it (M8-02 decision 2).
    async pairStatus(requestId: string) {
      const result = await local(`${OFFICE_PATH_PAIR_STATUS}?requestId=${encodeURIComponent(requestId)}`)
      const body = record(result.body)
      const state = typeof body?.state === "string" ? body.state : undefined
      return { status: result.status, state, token: body?.token }
    },

    // GET /pair/verify -> 204 known token, 401 otherwise, 0 network (FS T6/T7).
    async pairVerify() {
      const result = await local(OFFICE_PATH_PAIR_VERIFY)
      return { status: result.status }
    },

    // P2: body is exactly {title, host}. `host` is not in the SDK's create input, so it is
    // passed through the generator's `$body_` extra-field prefix.
    createSession(input: { title: string; host: OfficeHost }) {
      const parameters = { title: input.title, $body_host: input.host }
      return settle<Session>(() => client.session.create(parameters))
    },

    // P6: body is exactly {parts}.
    promptAsync(sessionID: string, parts: TextPart[]) {
      return settle<void>(() => client.session.promptAsync({ sessionID, parts }))
    },

    // P7: empty body.
    abort(sessionID: string) {
      return settle<boolean>(() => client.session.abort({ sessionID }))
    },

    // P3: the pane sends limit=20 (Recent chats).
    listSessions() {
      return settle<Session[]>(() => client.session.list({ limit: OFFICE_RECENT_CHATS_LIMIT }))
    },

    // P4.
    getSession(sessionID: string) {
      return settle<Session>(() => client.session.get({ sessionID }))
    },

    // P5: the pane sends limit=50 (history).
    messages(sessionID: string) {
      return settle<HistoryEntry[]>(() => client.session.messages({ sessionID, limit: OFFICE_HISTORY_LIMIT }))
    },
  }
}

export type OfficeApi = ReturnType<typeof createOfficeApi>
