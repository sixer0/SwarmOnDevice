// Request log formatter of the office bridge (row 48, plan M2-02; SEC SC-33, TA-17; test strategy U-BR-13). A
// record holds exactly five fields: method, route id, status, host and duration. It never holds a query string, a
// header value (token, Basic auth, Origin, Cookie), a body, a session id or a path. The route id is derived from the
// path here, so callers pass the raw request-target and the path never reaches the record.

import {
  OFFICE_PATH_BRIDGE_HEALTH,
  OFFICE_PATH_PAIR_REQUEST,
  OFFICE_PATH_PAIR_STATUS,
  OFFICE_PATH_PAIR_VERIFY,
  OFFICE_PATH_PANE,
  OFFICE_PATH_PROXY,
} from "@swarm/office-addin/constants"

/**
 * P1-P8 are the proxied routes of register §7.3. The bridge-local ids name the other answered routes; `unmatched`
 * is everything else (a rejected path is never logged as text).
 */
export type BridgeRouteId =
  | "P1"
  | "P2"
  | "P3"
  | "P4"
  | "P5"
  | "P6"
  | "P7"
  | "P8"
  | "root"
  | "pane"
  | "health"
  | "pair-request"
  | "pair-status"
  | "pair-verify"
  | "unmatched"

export type BridgeLogRecord = {
  method: string
  route: BridgeRouteId
  status: number
  /** The request's `Host` header after sanitising: only `[A-Za-z0-9.:[\]-]`, at most 64 chars, else `invalid`. */
  host: string
  durationMs: number
}

const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]
const HOST_RE = /^[A-Za-z0-9.:[\]-]{1,64}$/
const SEGMENT = "[^/]+"
const PROXY_ROUTES: readonly { id: BridgeRouteId; method: string; path: RegExp }[] = [
  { id: "P1", method: "GET", path: proxyPath("/global/health") },
  { id: "P2", method: "POST", path: proxyPath("/session") },
  { id: "P3", method: "GET", path: proxyPath("/session") },
  { id: "P4", method: "GET", path: proxyPath(`/session/${SEGMENT}`) },
  { id: "P5", method: "GET", path: proxyPath(`/session/${SEGMENT}/message`) },
  { id: "P6", method: "POST", path: proxyPath(`/session/${SEGMENT}/prompt_async`) },
  { id: "P7", method: "POST", path: proxyPath(`/session/${SEGMENT}/abort`) },
  { id: "P8", method: "GET", path: proxyPath("/event") },
]
const LOCAL_ROUTES: readonly { id: BridgeRouteId; path: string }[] = [
  { id: "health", path: OFFICE_PATH_BRIDGE_HEALTH },
  { id: "pair-request", path: OFFICE_PATH_PAIR_REQUEST },
  { id: "pair-status", path: OFFICE_PATH_PAIR_STATUS },
  { id: "pair-verify", path: OFFICE_PATH_PAIR_VERIFY },
]

/**
 * Route id for logging only. Admit (row M5-01) owns the authoritative allow-list match with the session-id pattern;
 * this classifier is looser on purpose and never decides access. The query is cut off before matching.
 */
export function routeIdFor(method: string, url: string): BridgeRouteId {
  const path = url.startsWith("/") ? url.split(/[?#]/, 1)[0] : ""
  if (path === "/") return "root"
  if (path === OFFICE_PATH_PANE || path.startsWith(OFFICE_PATH_PANE + "/")) return "pane"
  const local = LOCAL_ROUTES.find((route) => route.path === path)
  if (local) return local.id
  return PROXY_ROUTES.find((route) => route.method === method && route.path.test(path))?.id ?? "unmatched"
}

/** Build a record from raw request facts. Only the five fields survive; nothing else is copied. */
export function bridgeLogRecord(input: {
  method: string
  url: string
  status: number
  host: string | undefined
  durationMs: number
}): BridgeLogRecord {
  return {
    method: METHODS.includes(input.method) ? input.method : "OTHER",
    route: routeIdFor(input.method, input.url),
    status: Number.isInteger(input.status) && input.status >= 100 && input.status <= 599 ? input.status : 0,
    host: input.host && HOST_RE.test(input.host) ? input.host : "invalid",
    durationMs: Number.isFinite(input.durationMs) && input.durationMs >= 0 ? Math.round(input.durationMs) : 0,
  }
}

/** One line, fixed field order: `method=GET route=P3 status=200 host=localhost:46317 durationMs=12`. */
export function formatBridgeLog(record: BridgeLogRecord) {
  return `method=${record.method} route=${record.route} status=${record.status} host=${record.host} durationMs=${record.durationMs}`
}

/** The same five fields as a context object for `BridgeLogSink` (protocol.ts). A fresh object with no other keys. */
export function bridgeLogContext(record: BridgeLogRecord): Record<string, unknown> {
  return {
    method: record.method,
    route: record.route,
    status: record.status,
    host: record.host,
    durationMs: record.durationMs,
  }
}

function proxyPath(upstream: string) {
  return new RegExp(`^${OFFICE_PATH_PROXY}${upstream}$`)
}
