// Connection state machine, FS §8.2 transitions T1-T17. Pure reducer with an
// injected clock: `reduce(state, event, now)` returns the next state and the list of
// effects the shell must run. No timers, storage or network here; the shell turns
// effects into calls and feeds results back as events.
import {
  OFFICE_CONNECTION_STATES,
  OFFICE_ERROR_ROUTE_NOT_ALLOWED,
  OFFICE_ERROR_SWARM_UNAVAILABLE,
  OFFICE_ERROR_TOKEN_INVALID,
  OFFICE_ERROR_BODY_TOO_LARGE,
  OFFICE_HOSTS,
  OFFICE_PAIR_POLL_MS,
  OFFICE_PAIR_REQUEST_TTL_MS,
} from "../constants"
import type { OfficeHost } from "./prompt"
import { isToken } from "./storage"

type ConnectionName = (typeof OFFICE_CONNECTION_STATES)[number]

const OFFICE_JS_TIMEOUT_MS = 10_000

export type ConnectionState = {
  name: ConnectionName
  host?: OfficeHost
  loadedAt: number
  // T2: Office global still absent after 10 s.
  officeJsMissing: boolean
  pairing?: { requestId: string; code: string; startedAt: number }
  // T13: shown in `unpaired` when arriving from an expired request.
  notice?: "office.connect.expired"
}

type ToastKey = "office.error.pairRateLimited" | "office.error.generic" | "office.error.tooLarge"

export type Effect =
  | { type: "startOfficeTimer"; ms: number }
  | { type: "checkHealth" }
  | { type: "verifyToken" }
  | { type: "pairRequest"; host: OfficeHost }
  | { type: "startPolling"; requestId: string; ms: number }
  | { type: "stopPolling" }
  | { type: "storeToken"; token: string }
  | { type: "deleteToken" }
  | { type: "deleteAllSessions" }
  | { type: "dropCurrentSession" }
  | { type: "restoreChat" }
  | { type: "markInterrupted" }
  | { type: "toast"; key: ToastKey }

export type ConnectionEvent =
  | { type: "load" }
  // Clock tick from the shell; officePresent = `typeof Office !== "undefined"`.
  | { type: "tick"; officePresent: boolean }
  | { type: "officeReady"; host: string; supported: boolean }
  // `ready` = /bridge/health answered and `swarm === "ready"`; `token` = a token is stored.
  | { type: "health"; ready: boolean; token: boolean }
  // HTTP status of GET /pair/verify, or 0 for a network failure.
  | { type: "verify"; status: number }
  | { type: "retry" }
  | { type: "connect" }
  | { type: "pairResponse"; status: number; requestId?: string; code?: string }
  | { type: "pairStatus"; state: string; token?: unknown }
  // Any /swarm/* failure: status 0 = network level; `code` = bridge error code.
  // `storedSession` marks a request on the session id restored from storage (T17).
  | { type: "apiError"; status: number; code?: string; storedSession?: boolean }
  // The event stream closed and the one immediate reconnect failed (T16).
  | { type: "streamLost" }

export type Step = { state: ConnectionState; effects: Effect[] }

export function initialState(now: number): ConnectionState {
  return { name: "loading", loadedAt: now, officeJsMissing: false }
}

// Controls the view may enable in a state (FS §8.1 "Controls enabled").
/** @internal test seam */
export function enabledControls(state: ConnectionState) {
  if (state.name === "unavailable") return ["retry"] as const
  if (state.name === "unpaired" || state.name === "denied") return ["connect"] as const
  if (state.name === "connected") return ["chat"] as const
  return [] as const
}

const isHost = (host: string): host is OfficeHost => OFFICE_HOSTS.some((item) => item === host)

const to = (state: ConnectionState, name: ConnectionName, patch: Partial<ConnectionState> = {}): ConnectionState => ({
  ...state,
  name,
  pairing: undefined,
  notice: undefined,
  ...patch,
})

const signOut: Effect[] = [{ type: "deleteToken" }, { type: "deleteAllSessions" }]

export function reduce(state: ConnectionState, event: ConnectionEvent, now: number): Step {
  const same = { state, effects: [] }

  // T1
  if (event.type === "load") {
    return { state: initialState(now), effects: [{ type: "startOfficeTimer", ms: OFFICE_JS_TIMEOUT_MS }] }
  }

  if (event.type === "tick") {
    // T2: stays `loading`, shows office.error.officeJsMissing instead of the spinner.
    if (state.name === "loading" && !state.host && !event.officePresent && now - state.loadedAt >= OFFICE_JS_TIMEOUT_MS) {
      return { state: { ...state, officeJsMissing: true }, effects: [] }
    }
    // T13 (clock half): 120 s without an answer.
    if (state.name === "pairing" && state.pairing && now - state.pairing.startedAt >= OFFICE_PAIR_REQUEST_TTL_MS) {
      return { state: to(state, "unpaired", { notice: "office.connect.expired" }), effects: [{ type: "stopPolling" }] }
    }
    return same
  }

  if (event.type === "officeReady") {
    if (state.name !== "loading") return same
    // T3
    if (!isHost(event.host) || !event.supported) return { state: to(state, "unsupported-host"), effects: [] }
    return { state: { ...state, host: event.host, officeJsMissing: false }, effects: [{ type: "checkHealth" }] }
  }

  if (event.type === "health") {
    if (state.name !== "loading" || !state.host) return same
    // T4
    if (!event.ready) return { state: to(state, "unavailable"), effects: [] }
    // T5
    if (!event.token) return { state: to(state, "unpaired"), effects: [] }
    return { state, effects: [{ type: "verifyToken" }] }
  }

  if (event.type === "verify") {
    if (state.name !== "loading") return same
    // T6
    if (event.status === 204) return { state: to(state, "connected"), effects: [{ type: "restoreChat" }] }
    // T7
    if (event.status === 401) return { state: to(state, "unpaired"), effects: signOut }
    return { state: to(state, "unavailable"), effects: [] }
  }

  // T8: re-run the host-ok path (T4-T7); the host was accepted before.
  if (event.type === "retry") {
    if (state.name !== "unavailable") return same
    return { state: to(state, "loading", { loadedAt: now }), effects: [{ type: "checkHealth" }] }
  }

  // FR-30: a pair request starts only from this event.
  if (event.type === "connect") {
    if ((state.name !== "unpaired" && state.name !== "denied") || !state.host) return same
    return { state, effects: [{ type: "pairRequest", host: state.host }] }
  }

  if (event.type === "pairResponse") {
    if (state.name !== "unpaired" && state.name !== "denied") return same
    // T9
    if (event.status === 202 && event.requestId && event.code) {
      return {
        state: to(state, "pairing", { pairing: { requestId: event.requestId, code: event.code, startedAt: now } }),
        effects: [{ type: "startPolling", requestId: event.requestId, ms: OFFICE_PAIR_POLL_MS }],
      }
    }
    // T10
    if (event.status === 429) return { state, effects: [{ type: "toast", key: "office.error.pairRateLimited" }] }
    return { state, effects: [{ type: "toast", key: "office.error.generic" }] }
  }

  if (event.type === "pairStatus") {
    if (state.name !== "pairing") return same
    // T11
    if (event.state === "approved" && isToken(event.token)) {
      return {
        state: to(state, "connected"),
        effects: [{ type: "stopPolling" }, { type: "storeToken", token: event.token }, { type: "restoreChat" }],
      }
    }
    // T12
    if (event.state === "denied") return { state: to(state, "denied"), effects: [{ type: "stopPolling" }] }
    // T13
    if (event.state === "expired") {
      return { state: to(state, "unpaired", { notice: "office.connect.expired" }), effects: [{ type: "stopPolling" }] }
    }
    // T14, and an `approved` without a well-formed token (treated the same: no token was read).
    if (event.state === "consumed" || event.state === "approved") {
      return {
        state: to(state, "unpaired"),
        effects: [{ type: "stopPolling" }, { type: "toast", key: "office.error.generic" }],
      }
    }
    // `pending`: T13 clock half.
    if (state.pairing && now - state.pairing.startedAt >= OFFICE_PAIR_REQUEST_TTL_MS) {
      return { state: to(state, "unpaired", { notice: "office.connect.expired" }), effects: [{ type: "stopPolling" }] }
    }
    return same
  }

  if (event.type === "apiError") {
    if (state.name !== "connected") return same
    // T15: no pair request until a Connect event (FR-30).
    if (event.status === 401 || event.code === OFFICE_ERROR_TOKEN_INVALID) {
      return { state: to(state, "unpaired"), effects: signOut }
    }
    // T16
    if (event.status === 0 || event.status === 503 || event.code === OFFICE_ERROR_SWARM_UNAVAILABLE) {
      return { state: to(state, "unavailable"), effects: [{ type: "markInterrupted" }] }
    }
    // T17
    if (event.status === 404 && event.code === OFFICE_ERROR_ROUTE_NOT_ALLOWED && event.storedSession) {
      return { state, effects: [{ type: "dropCurrentSession" }] }
    }
    // FR-25
    if (event.status === 413 || event.code === OFFICE_ERROR_BODY_TOO_LARGE) {
      return { state, effects: [{ type: "toast", key: "office.error.tooLarge" }] }
    }
    // FR-27 (400 FIELD_NOT_ALLOWED is a defect) and everything else.
    return { state, effects: [{ type: "toast", key: "office.error.generic" }] }
  }

  // T16 (stream half)
  if (event.type === "streamLost") {
    if (state.name !== "connected") return same
    return { state: to(state, "unavailable"), effects: [{ type: "markInterrupted" }] }
  }

  return same
}
