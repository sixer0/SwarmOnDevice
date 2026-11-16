// Routes composition of the office bridge (row W4-RC; controller rulings C33, C35, C37, C38). Server-delta spec §9.1
// (pipeline order), §9.3-§9.5, §11; register rev 5 §4, §5, §7.3, §7.6; security spec SC-01..SC-07, SC-13, SC-33.
//
// One handler for both listeners (server.ts `BridgeRoutesFactory`). Per request, in this order:
//   1. header stages first (M5-F3, `admitBounded`): with a declared body, admit() runs over the headers alone and a
//      Host/Origin/CSRF/token/route rejection answers without reading the body; only a POST to a route that takes a
//      body is read (2 MiB cap, counted while streaming);
//   2. `admit()` over the full request (stages 2-13: Host, framing, OPTIONS, Origin, static branch, anti-CSRF, Content-Type, size, local
//      routes, token via the read-only `store.lookup` (C35), allow-list, query, body). Nothing below runs unless admit
//      accepted the request, so a request that fails Host/Origin never reaches the static files, and one without
//      `X-Swarm-Office` never reaches pairing, health or the upstream;
//   3. dispatch: static (redirect / file) -> static.ts; local -> health.ts or pairing.ts; proxy P1-P7 -> upstream.ts
//      (stages 14-16); P8 -> sse.ts relay over `upstream.openEvents(admission)`;
//   4. one log line per request via log.ts (method, route id, status, host, duration only; SC-33).
//
// The module internals are used as they are; this file only wires them. Electron-free (TS-RC-2).
import {
  OFFICE_BODY_LIMIT_BYTES,
  OFFICE_ERROR_FIELD_NOT_ALLOWED,
  OFFICE_ERROR_ROUTE_NOT_ALLOWED,
  OFFICE_ERROR_SWARM_UNAVAILABLE,
} from "@swarm/office-addin/constants"
import { admit, headerPairs, type Admission, type AdmitConfig } from "./admit"
import { healthResponse, type BridgeSwarmState } from "./health"
import { bridgeLogContext, bridgeLogRecord, formatBridgeLog } from "./log"
import { createPairing, type PairingResponse, type PairTimerCancel } from "./pairing"
import { createPairingStore } from "./pairing-store"
import type { BridgeRoutesContext, BridgeRoutesFactory } from "./server"
import { createSseRelay, type SseDownstream } from "./sse"
import {
  BRIDGE_SECURITY_HEADERS,
  errorResponse,
  jsonResponse,
  paneRootFor,
  sendBridgeResponse,
  serveStatic,
  type BridgeResponseTarget,
} from "./static"
import { createUpstream, type UpstreamFetch } from "./upstream"

/** The request fields the pipeline reads. `node:http` `IncomingMessage` satisfies it. */
/** @internal test seam */
export type RouteRequest = {
  method?: string
  url?: string
  rawHeaders: string[]
  headers: { host?: string }
  on(event: "data", listener: (chunk: Uint8Array) => void): unknown
  on(event: "end" | "close", listener: () => void): unknown
  on(event: "error", listener: (error: Error) => void): unknown
  off(event: "data", listener: (chunk: Uint8Array) => void): unknown
  off(event: "end" | "close", listener: () => void): unknown
  off(event: "error", listener: (error: Error) => void): unknown
  pause(): unknown
}

/** The response fields the pipeline writes. `node:http` `ServerResponse` satisfies it (SSE relay + buffered writes). */
type RouteResponse = SseDownstream & BridgeResponseTarget

type BridgeRoutesOptions = {
  /** Upstream fetch. Default: the runtime `fetch` (Node/Electron utility process; Bun in tests). */
  fetch?: UpstreamFetch
  /** Pairing clock and expiry scheduler (tests). */
  now?: () => number
  setTimer?: (callback: () => void, ms: number) => PairTimerCancel
  /** Upper bound of the `/bridge/health` upstream probe. Default 3 s (same as the desktop sidecar probe, S-9). */
  healthTimeoutMs?: number
  /** Body limit; defaults to OFFICE_BODY_LIMIT_BYTES (2 MiB). */
  bodyLimit?: number
}

const BRIDGE_HEALTH_PROBE_TIMEOUT_MS = 3_000

// The body is copied into an ArrayBuffer-backed view: `BodyInit` does not take a view over a SharedArrayBuffer.
const runtimeFetch: UpstreamFetch = (url, init) =>
  fetch(url, { ...init, body: init.body === undefined ? undefined : new Uint8Array(init.body) })

const errorName = (error: unknown) => (error instanceof Error ? error.name : "unknown")

/** Reads the body up to `limit` bytes. Past the limit it stops reading (no buffering of the rest) and reports overflow. */
function readBody(request: RouteRequest, limit: number, declared: number) {
  // A declared length over the limit is answered from the header alone (admit stage 8); nothing is read.
  if (declared > limit) return Promise.resolve({ body: undefined, overflow: true })
  return new Promise<{ body: Uint8Array | undefined; overflow: boolean }>((resolve, reject) => {
    const chunks: Uint8Array[] = []
    const state = { size: 0 }
    const cleanup = () => {
      request.off("data", onData)
      request.off("end", onEnd)
      request.off("close", onClose)
      request.off("error", onError)
    }
    const onData = (chunk: Uint8Array) => {
      state.size += chunk.byteLength
      if (state.size <= limit) return void chunks.push(chunk)
      cleanup()
      request.pause()
      resolve({ body: undefined, overflow: true })
    }
    const onEnd = () => {
      cleanup()
      resolve({ body: chunks.length === 0 ? undefined : Buffer.concat(chunks), overflow: false })
    }
    // `close` before `end`: the client went away mid-body. A partial body is never admitted.
    const onClose = () => {
      cleanup()
      reject(new Error("request aborted"))
    }
    const onError = (error: Error) => {
      cleanup()
      reject(error)
    }
    request.on("data", onData)
    request.on("end", onEnd)
    request.on("close", onClose)
    request.on("error", onError)
  })
}

/** Pairing answers carry `Cache-Control: no-store` (C37): the status body can hold the token. */
function sendPairing(response: RouteResponse, result: PairingResponse) {
  if (result.status === 204) {
    response.writeHead(204, { ...BRIDGE_SECURITY_HEADERS })
    response.end()
    return 204
  }
  sendBridgeResponse(response, jsonResponse(result.status, result.body))
  return result.status
}

function sendError(response: RouteResponse, status: number, code: string) {
  sendBridgeResponse(response, errorResponse(status, code))
  return status
}

/** The composed pipeline over one bridge start. Exported for tests; production goes through `createBridgeRoutes`. */
/** @internal test seam */
export function composeBridgeRoutes(context: BridgeRoutesContext, options: BridgeRoutesOptions = {}) {
  const log = context.log
  const limit = options.bodyLimit ?? OFFICE_BODY_LIMIT_BYTES
  const paneRoot = paneRootFor(context.config.resourcesDir)

  const store = createPairingStore({
    dir: context.paths.root,
    // The store logs only event names, hosts, dates and the quarantine path (never a token or hash).
    log: (event, fields) => log("info", "office-bridge.pairing-store", event, fields),
  })
  // Loaded once per start. Until it resolves, token checks wait; if it fails, tokens never match and pairing is 503.
  // `gate.ready` is the load, then every Disconnect queued behind it (F-1): a clear never runs before the load ends,
  // and token checks and pairing calls issued after a clear wait for it.
  const gate = { ready: Promise.resolve(false) }
  gate.ready = store.load().then(
    () => true,
    (error: unknown) => {
      log("error", "office-bridge.pairing-store", "pairing store load failed", {
        error: errorName(error),
        code: error instanceof Error && "code" in error ? String(error.code) : "unknown",
      })
      return false
    },
  )

  const relay = createSseRelay({ log })

  /**
   * Revocation sweep (M5-F1): end every open event stream whose token hash the store no longer holds. Runs after each
   * store write that can drop a hash: `clear` (Disconnect), `put` (a re-pair replaces the host's entry) and `revoke`.
   */
  const sweepStreams = () => {
    const known = new Set(store.list().map((entry) => entry.hash))
    const closed = relay.closeWhere((key) => !known.has(`sha256:${key}`))
    if (closed > 0) log("info", "office-bridge.sse", "streams of revoked tokens closed", { route: "P8", count: closed })
  }

  const pairing = createPairing({
    store: {
      put: (host, token) => store.put(host, token).finally(sweepStreams),
      verify: store.verify,
      revoke: (token) => store.revoke(token).finally(sweepStreams),
      clear: () => store.clear().finally(sweepStreams),
    },
    pairRequests: context.deps.pairRequests,
    pairDecisions: context.deps.pairDecisions,
    log,
    ...(options.now ? { now: options.now } : {}),
    ...(options.setTimer ? { setTimer: options.setTimer } : {}),
  })

  const upstream = createUpstream({
    serverUrl: context.config.serverUrl,
    username: context.config.username,
    password: context.config.password,
    workspace: context.paths.workspace,
    fetch: options.fetch ?? runtimeFetch,
    log,
  })

  /** `/bridge/health` swarm state: the P1 upstream read (`/global/health`), bounded by a timeout. */
  const swarmState = async (): Promise<BridgeSwarmState> => {
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), options.healthTimeoutMs ?? BRIDGE_HEALTH_PROBE_TIMEOUT_MS)
    // P1 sends no token upstream; the admission fields other than `route` are not used for it.
    const result = await upstream.forward({ kind: "proxy", route: "P1", token: "", tokenHost: "Word", forward: {} }, abort.signal)
    clearTimeout(timer)
    if (result.kind === "stream") await result.body.cancel().catch(() => {})
    return result.status === 200 ? "ready" : "down"
  }

  const dispatch = async (admission: Admission, method: string, url: string, response: RouteResponse) => {
    if (admission.kind === "reject") return sendError(response, admission.status, admission.code)

    if (admission.kind === "static") {
      // static.ts repeats its own path rules and the realpath prefix check (spec §9.4).
      const served = await serveStatic({ method, url }, paneRoot)
      if (!served) return sendError(response, 404, OFFICE_ERROR_ROUTE_NOT_ALLOWED)
      sendBridgeResponse(response, served)
      return served.status
    }

    if (admission.kind === "local") {
      if (admission.route === "health") {
        const health = healthResponse({ method, url }, await swarmState())
        if (!health) return sendError(response, 404, OFFICE_ERROR_ROUTE_NOT_ALLOWED)
        sendBridgeResponse(response, health)
        return health.status
      }
      if (!(await gate.ready)) return sendError(response, 503, OFFICE_ERROR_SWARM_UNAVAILABLE)
      if (admission.route === "pair-request") return sendPairing(response, await pairing.request(admission))
      if (admission.route === "pair-status") return sendPairing(response, await pairing.status(admission))
      return sendPairing(response, await pairing.verify(admission))
    }

    if (admission.route === "P8") {
      const result = await relay.relay({
        token: admission.token,
        response,
        openUpstream: upstream.openEvents(admission),
      })
      return result.kind === "rejected" ? result.status : 200
    }

    // Abort the upstream call when the client goes away before the answer (Node emits `close` on the response).
    const abort = new AbortController()
    const onClose = () => abort.abort()
    response.once("close", onClose)
    const result = await upstream.forward(admission, abort.signal)
    response.off("close", onClose)
    if (result.kind === "stream") {
      // Only P8 streams, and P8 is relayed above; anything else is a contract break, answered as unavailable.
      await result.body.cancel().catch(() => {})
      return sendError(response, 503, OFFICE_ERROR_SWARM_UNAVAILABLE)
    }
    sendBridgeResponse(response, {
      status: result.status,
      headers: result.headers,
      body: result.body.byteLength === 0 ? null : result.body,
    })
    return result.status
  }

  return {
    async handle(request: RouteRequest, response: RouteResponse) {
      const started = performance.now()
      const method = request.method ?? ""
      const url = request.url ?? ""
      const headers = headerPairs(request.rawHeaders)
      const config = {
        port: context.expectations.port,
        verifyToken: async (token: string) => ((await gate.ready) ? store.lookup(token) : undefined),
        bodyLimit: limit,
      }
      const admission = await admitBounded({ request, method, url, headers, limit, config })
      const status = await dispatch(admission, method, url, response)
      const record = bridgeLogRecord({
        method,
        url,
        status,
        host: request.headers.host,
        durationMs: performance.now() - started,
      })
      log(status >= 500 ? "warn" : "info", "office-bridge.request", formatBridgeLog(record), bridgeLogContext(record))
    },

    /** Disconnect / Disable (`pairings-cleared`): end open streams, empty the store, drop unread approvals (§11.4). */
    pairingsCleared() {
      // M5-F1: every open event stream ends now, before the clear is even queued; new ones need a token admit() accepts,
      // and the post-clear sweep closes any stream that registered in between.
      relay.closeAll()
      // Behind the load (F-1): a clear that ran during load() was undone when load() re-read the old file.
      gate.ready = gate.ready.then(async (ok) => {
        await pairing.pairingsCleared().catch((error: unknown) => {
          log("error", "office-bridge.pairing", "pairings clear failed", { error: errorName(error) })
        })
        return ok
      })
    },

    /** Bridge stop: end every SSE stream, then stop pairing timers and revoke unread tokens. */
    async stop() {
      relay.stop()
      await gate.ready
      await pairing.stop()
    },
  }
}

/** POST routes that take a JSON body (P2, P6, P7, `/pair/request`). Matching here only decides whether to read. */
const BODY_ROUTE = /^\/(pair\/request|swarm\/session|swarm\/session\/[^/?#]+\/(prompt_async|abort))(\?|$)/

/**
 * Header stages first (M5-F3): when a body is declared, admit() runs once over the headers alone, with the framing
 * headers removed so stages 7-8 and the body checks cannot fire. A rejection there that is not a 400 (Host 421,
 * OPTIONS/Origin/CSRF 403, token 401, route 404) is final and the body is never read. Then the body is read (2 MiB cap,
 * a larger declared length is not read at all) only for a POST to a route that takes one, and admit() runs again over
 * the full request; that second pass is the authoritative one (framing, Content-Type, size, body shape). A declared
 * body on any other non-static route is refused without reading it.
 */
async function admitBounded(input: {
  request: RouteRequest
  method: string
  url: string
  headers: (readonly [string, string])[]
  limit: number
  config: AdmitConfig
}): Promise<Admission> {
  const lengths = input.headers.filter((pair) => pair[0].toLowerCase() === "content-length").map((pair) => pair[1].trim())
  const chunked = input.headers.some((pair) => pair[0].toLowerCase() === "transfer-encoding")
  const declared = lengths.length === 1 && /^[0-9]+$/.test(lengths[0]) ? Number(lengths[0]) : 0
  const full = { method: input.method, target: input.url, headers: input.headers }
  // No body declared (no Transfer-Encoding, Content-Length absent or 0): nothing to read.
  if (!chunked && lengths.every((value) => value === "0")) return admit(full, input.config)

  const framing = (name: string) => name.toLowerCase() === "content-length" || name.toLowerCase() === "transfer-encoding"
  const first = await admit(
    { method: input.method, target: input.url, headers: input.headers.filter((pair) => !framing(pair[0])) },
    input.config,
  )
  if (first.kind === "reject" && first.status !== 400) return first
  if (first.kind === "static") return admit(full, input.config)
  if (input.method.toUpperCase() !== "POST" || !BODY_ROUTE.test(input.url))
    return { kind: "reject", status: 400, code: OFFICE_ERROR_FIELD_NOT_ALLOWED }
  const read = await readBody(input.request, input.limit, declared)
  return admit({ ...full, body: read.body, bodyOverflow: read.overflow }, input.config)
}

/** The `BridgeRoutesFactory` server.ts takes (`createOfficeBridgeFactory({ routes })`). */
export function createBridgeRoutes(options: BridgeRoutesOptions = {}): BridgeRoutesFactory {
  return (context) => composeBridgeRoutes(context, options)
}
