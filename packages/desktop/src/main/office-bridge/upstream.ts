// Upstream builder and response filter of the office bridge (plan M5-02). Server-delta spec §6 (URL and password from
// `start`), §9.1 stages 14-16, §9.2 (upstream request), §9.3 (response); register rev 5 §7.1-§7.3, §7.6; security spec
// SC-05, SC-07, SC-28, SC-29, SC-35. Decisions C30, C35.
//
// Input is the `proxy` admission from `admit()` (M5-01): route P1-P8 with its already validated fields. This module
// never sees the client's raw request, so nothing from it can reach the sidecar except what admit extracted:
// - URL: only the sidecar origin from `start` (SC-35, `http://127.0.0.1:<port>`), the register upstream path, and a
//   query the bridge builds itself (forced `directory`, `roots=true` on P3, `limit` on P3/P5; SC-29).
// - Headers: an allow-list. From the client only `Accept` and `Last-Event-ID` (admit's `forward`); the bridge sets
//   `Authorization: Basic`, `Accept-Encoding: identity` and `Content-Type: application/json` on a body (SC-28).
//   `Host` and `Content-Length` come from the URL and the byte body.
// - Body: re-serialised from the validated object. P2 is forced to `{ title?, permission: OFFICE_SESSION_RULESET,
//   metadata: { swarm.origin, swarm.office.host } }`; P6 is `{ parts }`; every other route sends no body.
// Before P4-P7 the bridge reads `GET /session/:id` upstream and forwards only for an Office session (stage 14, REG §7.2).
// P3 is filtered by the same predicate. An upstream 401 or a connect error answers `503 SWARM_UNAVAILABLE`, so the pane
// never sees `www-authenticate` (spec §6). Responses keep only `Content-Type` from upstream and carry the bridge's own
// security headers (SC-05, SC-07). Electron-free; the fetch is injected (tests stub it, production passes `fetch`).
import {
  OFFICE_ERROR_ROUTE_NOT_ALLOWED,
  OFFICE_ERROR_SWARM_UNAVAILABLE,
  OFFICE_HOST_METADATA_KEY,
  OFFICE_ORIGIN_METADATA_KEY,
  OFFICE_ORIGIN_VALUE,
  OFFICE_SESSION_RULESET,
} from "@swarm/office-addin/constants"
import type { Admission } from "./admit"
import type { BridgeLogSink } from "./protocol"

/** @internal test seam */
export type ProxyAdmission = Extract<Admission, { kind: "proxy" }>
type ProxyRoute = ProxyAdmission["route"]

/** @internal test seam */
export type UpstreamInit = {
  method: "GET" | "POST"
  headers: Record<string, string>
  body?: Uint8Array
  signal?: AbortSignal
  /** Never follow a redirect: the only target is the `start` URL (SC-35). */
  redirect: "error"
  /**
   * P8 only: `false` disables the runtime's fetch timeout (Bun `timeout: false`; spec §9.5 timeouts 0). Node/undici
   * ignores this key; its idle body timeout (300 s between chunks) is kept alive by the 10 s server heartbeat (S-19).
   */
  timeout?: false
}

/** The injected fetch. Production passes the runtime `fetch`; tests pass a stub that records the request. */
export type UpstreamFetch = (url: string, init: UpstreamInit) => Promise<Response>

type UpstreamConfig = {
  /** `serverUrl` from `start`; must be `http://127.0.0.1:<port>` (SC-35). Anything else fails closed with 503. */
  serverUrl: string
  /** Sidecar Basic-auth user and password from `start`. Never logged (spec §6). */
  username: string
  password: string
  /** The Office workspace directory (`BridgeDataPaths.workspace`, REG §7.1). */
  workspace: string
  fetch: UpstreamFetch
  log?: BridgeLogSink
}

/** A buffered response, ready for `writeHead(status, headers)` + `end(body)`. */
type UpstreamBuffered = { kind: "buffered"; status: number; headers: Record<string, string>; body: Uint8Array }
/** P8 only: the upstream event stream, unread, with the downstream headers. Piping and teardown belong to sse.ts. */
type UpstreamStream = {
  kind: "stream"
  status: number
  headers: Record<string, string>
  body: ReadableStream<Uint8Array>
}
/** @internal test seam */
export type UpstreamResult = UpstreamBuffered | UpstreamStream

/** Upstream request for one admission (exported for tests and sse.ts). */
type UpstreamRequest = { url: string; init: UpstreamInit }

// ── Register values ──

/** Response headers kept from upstream (SC-05). `Cache-Control` is always replaced by the bridge's own value (§9.3). */
const OFFICE_UPSTREAM_RESPONSE_HEADERS = ["content-type"] as const

/** Security headers on every non-static bridge response (SC-07, REG §4.1). */
const OFFICE_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "x-content-type-options": "nosniff",
  "cross-origin-resource-policy": "same-origin",
  "referrer-policy": "no-referrer",
}
const OFFICE_CACHE_CONTROL = "no-store"
const OFFICE_SSE_CACHE_CONTROL = "no-cache, no-transform"
const OFFICE_SSE_CONTENT_TYPE = "text/event-stream"
const JSON_TYPE = "application/json"
const ERROR_TYPE = "application/json; charset=utf-8"

const encoder = new TextEncoder()

/** `http://127.0.0.1:<port>` from the `start` URL, or undefined for anything else (SC-35). */
/** @internal test seam */
export function sidecarOrigin(serverUrl: string) {
  const url = (() => {
    try {
      return new URL(serverUrl)
    } catch {
      return
    }
  })()
  if (!url) return
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.port === "") return
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") return
  if (url.pathname !== "/" && url.pathname !== "") return
  return url.origin
}

/** Register §7.3 upstream path for a route. Session ids were validated by admit (`OFFICE_SESSION_ID_PATTERN`). */
/** @internal test seam */
export function upstreamPath(admission: ProxyAdmission) {
  if (admission.route === "P1") return "/global/health"
  if (admission.route === "P2" || admission.route === "P3") return "/session"
  if (admission.route === "P4") return `/session/${admission.sessionID}`
  if (admission.route === "P5") return `/session/${admission.sessionID}/message`
  if (admission.route === "P6") return `/session/${admission.sessionID}/prompt_async`
  if (admission.route === "P7") return `/session/${admission.sessionID}/abort`
  return "/event"
}

/** The query the bridge builds (SC-29): forced `directory` on every route (REG §7.1), `roots=true` on P3, `limit`. */
function upstreamQuery(admission: ProxyAdmission, workspace: string) {
  const query = new URLSearchParams()
  query.set("directory", workspace)
  if (admission.route === "P3") query.set("roots", "true")
  if ((admission.route === "P3" || admission.route === "P5") && admission.limit !== undefined)
    query.set("limit", String(admission.limit))
  return query.toString()
}

/** The bridge-built body (§9.2): P2 forced to ruleset + metadata, P6 `{ parts }`, nothing on other routes. */
function upstreamBody(admission: ProxyAdmission) {
  if (admission.route === "P2")
    return {
      ...(admission.title === undefined ? {} : { title: admission.title }),
      permission: OFFICE_SESSION_RULESET,
      metadata: { [OFFICE_ORIGIN_METADATA_KEY]: OFFICE_ORIGIN_VALUE, [OFFICE_HOST_METADATA_KEY]: admission.host },
    }
  if (admission.route === "P6")
    return { parts: admission.parts.map((part) => ({ type: "text" as const, text: part.text })) }
  return
}

function authorization(username: string, password: string) {
  return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`
}

/** Headers sent upstream: the allow-list of SC-28, nothing else. */
function upstreamHeaders(admission: ProxyAdmission, auth: string, hasBody: boolean) {
  const accept = admission.forward.accept ?? (admission.route === "P8" ? OFFICE_SSE_CONTENT_TYPE : JSON_TYPE)
  return {
    authorization: auth,
    accept,
    "accept-encoding": "identity",
    ...(admission.forward.lastEventId === undefined ? {} : { "last-event-id": admission.forward.lastEventId }),
    ...(hasBody ? { "content-type": JSON_TYPE } : {}),
  }
}

/**
 * Builds the upstream request for one admission. Returns undefined when the `start` URL is not the loopback sidecar
 * (SC-35); the caller answers 503.
 */
/** @internal test seam */
export function buildUpstreamRequest(
  admission: ProxyAdmission,
  config: Pick<UpstreamConfig, "serverUrl" | "username" | "password" | "workspace">,
  signal?: AbortSignal,
): UpstreamRequest | undefined {
  const origin = sidecarOrigin(config.serverUrl)
  if (!origin) return
  const object = upstreamBody(admission)
  const body = object === undefined ? undefined : encoder.encode(JSON.stringify(object))
  const method = admission.route === "P2" || admission.route === "P6" || admission.route === "P7" ? "POST" : "GET"
  return {
    url: `${origin}${upstreamPath(admission)}?${upstreamQuery(admission, config.workspace)}`,
    init: {
      method,
      headers: upstreamHeaders(admission, authorization(config.username, config.password), body !== undefined),
      ...(body === undefined ? {} : { body }),
      ...(signal === undefined ? {} : { signal }),
      redirect: "error",
      ...(admission.route === "P8" ? { timeout: false as const } : {}),
    },
  }
}

// ── Ownership (stage 14, REG §7.2) ──

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** Exact deep equality with `OFFICE_SESSION_RULESET`: same order, each rule exactly `{permission, pattern, action}`. */
function isOfficeRuleset(value: unknown) {
  if (!Array.isArray(value) || value.length !== OFFICE_SESSION_RULESET.length) return false
  return OFFICE_SESSION_RULESET.every((rule, index) => {
    const other: unknown = value[index]
    if (!isRecord(other) || Object.keys(other).length !== 3) return false
    return other.permission === rule.permission && other.pattern === rule.pattern && other.action === rule.action
  })
}

/**
 * True only for a session the bridge created: `directory` equals the Office workspace, `metadata["swarm.origin"]` is
 * `office-addin`, and `permission` deep-equals the ruleset. Anything else, including a malformed value, is not owned.
 */
export function isOfficeSession(value: unknown, workspace: string) {
  if (!isRecord(value)) return false
  if (value.directory !== workspace) return false
  if (!isRecord(value.metadata) || value.metadata[OFFICE_ORIGIN_METADATA_KEY] !== OFFICE_ORIGIN_VALUE) return false
  return isOfficeRuleset(value.permission)
}

// ── Responses (§9.3) ──

/** Downstream headers: `Content-Type` from upstream only, plus the bridge's cache and security headers (SC-05, SC-07). */
export function responseHeaders(upstream: Headers | undefined, length: number | undefined, sse = false) {
  const type = sse ? OFFICE_SSE_CONTENT_TYPE : upstream?.get("content-type")
  return {
    ...(type ? { "content-type": type } : {}),
    "cache-control": sse ? OFFICE_SSE_CACHE_CONTROL : OFFICE_CACHE_CONTROL,
    ...OFFICE_SECURITY_HEADERS,
    ...(length === undefined ? {} : { "content-length": String(length) }),
  }
}

/** Bridge error response `{ "error": CODE }` (REG §7.6) with the same header set. */
export function errorResult(status: number, code: string): UpstreamBuffered {
  const body = encoder.encode(JSON.stringify({ error: code }))
  return {
    kind: "buffered",
    status,
    headers: { ...responseHeaders(undefined, body.length), "content-type": ERROR_TYPE },
    body,
  }
}

/** A buffered response. 204 and 304 carry no body and no `Content-Length`. */
function buffered(status: number, upstream: Headers | undefined, body: Uint8Array): UpstreamBuffered {
  const empty = status === 204 || status === 304
  return {
    kind: "buffered",
    status,
    headers: responseHeaders(upstream, empty ? undefined : body.length),
    body: empty ? new Uint8Array() : body,
  }
}

function jsonResult(status: number, upstream: Headers, value: unknown) {
  const body = encoder.encode(JSON.stringify(value))
  const result = buffered(status, upstream, body)
  return { ...result, headers: { ...result.headers, "content-type": upstream.get("content-type") ?? JSON_TYPE } }
}

const unavailable = () => errorResult(503, OFFICE_ERROR_SWARM_UNAVAILABLE)
const notAllowed = () => errorResult(404, OFFICE_ERROR_ROUTE_NOT_ALLOWED)

async function readJson(response: Response) {
  const text = await response.text()
  try {
    return { value: JSON.parse(text) as unknown }
  } catch {
    return
  }
}

// ── Forwarding ──

type P8Admission = Extract<ProxyAdmission, { route: "P8" }>

/** The opener sse.ts (M5-03) calls: `OpenUpstream = (signal: AbortSignal) => Promise<Response>`. */
type UpstreamEventOpener = (signal: AbortSignal) => Promise<Response>

type Upstream = {
  /** Stages 14-16 for one proxied admission. Never throws: failures become a bridge error result. */
  forward(admission: ProxyAdmission, signal?: AbortSignal): Promise<UpstreamResult>
  /**
   * P8 opener for the SSE relay: `GET /event?directory=<workspace>` on the start URL, allow-listed headers, Basic auth,
   * the relay's `signal` passed to fetch (abort tears the upstream down), fetch timeout disabled. Returns the raw
   * upstream Response; the relay maps a non-2xx (including 401) or a rejection to 503 and sends its own fixed headers.
   * Rejects when the start URL is not the loopback sidecar (SC-35), without calling fetch.
   */
  openEvents(admission: P8Admission): UpstreamEventOpener
}

export function createUpstream(config: UpstreamConfig): Upstream {
  const log = config.log ?? (() => {})
  const origin = sidecarOrigin(config.serverUrl)
  if (!origin)
    log("error", "office-bridge.upstream", "start url is not the loopback sidecar", { code: "UPSTREAM_URL_REJECTED" })

  /** One upstream call; undefined on a connect error, abort or redirect (all answer 503). */
  const call = async (request: UpstreamRequest, route: ProxyRoute, step: string) => {
    try {
      return await config.fetch(request.url, request.init)
    } catch (error) {
      log("warn", "office-bridge.upstream", "upstream request failed", {
        route,
        step,
        error: error instanceof Error ? error.name : "unknown",
      })
      return
    }
  }

  /** Stage 14: the session as upstream reports it, or a bridge error result. */
  const owned = async (admission: ProxyAdmission & { sessionID: string }, signal: AbortSignal | undefined) => {
    // The lookup is a bare P4 read: no client `Accept` or `Last-Event-ID` reaches it.
    const read: ProxyAdmission = {
      kind: "proxy",
      route: "P4",
      token: admission.token,
      tokenHost: admission.tokenHost,
      forward: {},
      sessionID: admission.sessionID,
    }
    const lookup = buildUpstreamRequest(read, config, signal)
    if (!lookup) return { ok: false as const, result: unavailable() }
    const response = await call(lookup, admission.route, "ownership")
    if (!response || response.status === 401 || response.status >= 500) {
      await response?.body?.cancel().catch(() => {})
      return { ok: false as const, result: unavailable() }
    }
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => {})
      return { ok: false as const, result: notAllowed() }
    }
    const parsed = await readJson(response).catch(() => undefined)
    if (!parsed || !isOfficeSession(parsed.value, config.workspace)) {
      log("warn", "office-bridge.upstream", "ownership check failed", { route: admission.route })
      return { ok: false as const, result: notAllowed() }
    }
    return { ok: true as const, response, session: parsed.value }
  }

  const forward = async (admission: ProxyAdmission, signal?: AbortSignal): Promise<UpstreamResult> => {
    if (!origin) return unavailable()

    if (admission.route === "P4" || admission.route === "P5" || admission.route === "P6" || admission.route === "P7") {
      const check = await owned(admission, signal)
      if (!check.ok) return check.result
      // P4 is the ownership read itself: answer from it instead of reading the session twice.
      if (admission.route === "P4") return jsonResult(200, check.response.headers, check.session)
    }

    const request = buildUpstreamRequest(admission, config, signal)
    if (!request) return unavailable()
    const response = await call(request, admission.route, "forward")
    if (!response) return unavailable()
    // Upstream 401 means the bridge's own credentials failed: never pass it (or `www-authenticate`) to the pane.
    if (response.status === 401) {
      await response.body?.cancel().catch(() => {})
      log("error", "office-bridge.upstream", "upstream rejected bridge credentials", { route: admission.route })
      return unavailable()
    }
    // M5-02a (CP-M5 M5-F2): any upstream 5xx is the sidecar failing, on every route: the bridge's own 503 body, never
    // the upstream status or body (same rule as the ownership read).
    if (response.status >= 500) {
      await response.body?.cancel().catch(() => {})
      log("warn", "office-bridge.upstream", "upstream server error", { route: admission.route, status: response.status })
      return unavailable()
    }

    if (admission.route === "P8" && response.status === 200 && response.body)
      return { kind: "stream", status: 200, headers: responseHeaders(response.headers, undefined, true), body: response.body }

    if (admission.route === "P3" && response.status === 200) {
      const parsed = await readJson(response).catch(() => undefined)
      if (!parsed || !Array.isArray(parsed.value)) {
        log("warn", "office-bridge.upstream", "session list unreadable", { route: "P3" })
        return unavailable()
      }
      const list = parsed.value.filter((session: unknown) => isOfficeSession(session, config.workspace))
      return jsonResult(200, response.headers, list)
    }

    const body = await response
      .arrayBuffer()
      .then((buffer) => new Uint8Array(buffer))
      .catch(() => undefined)
    if (!body) return unavailable()
    return buffered(response.status, response.headers, body)
  }

  const openEvents = (admission: P8Admission): UpstreamEventOpener => async (signal) => {
    const request = buildUpstreamRequest(admission, config, signal)
    if (!request) throw new Error("UPSTREAM_URL_REJECTED")
    return config.fetch(request.url, request.init)
  }

  return { forward, openEvents }
}
