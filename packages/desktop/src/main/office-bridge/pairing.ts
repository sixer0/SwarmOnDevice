// Pairing endpoints of the office bridge (plan M4-02). Server-delta spec §11.1, §11.2 "On allow"; register rev 5 §5
// (`POST /pair/request`, pair rate limit, `GET /pair/status`, `GET /pair/verify`, token format); security spec SC-13,
// SC-15, SC-16; decision C35 (store.lookup serves /swarm/*, store.verify is called ONLY here, by /pair/verify).
//
// Pure handlers over the `admit()` "local" result: admit() has already checked Host, Origin, the anti-CSRF header,
// Content-Type, size, the exact body/query shape and (for /pair/verify) the token via the read-only lookup. Nothing
// here binds a port or writes a response; the composed routes row turns `PairingResponse` into HTTP. Electron-free.
//
// Secrets: the plaintext token lives only in the approved record until the first status read (then dropped), and in
// the 202/200 body. It never reaches a log line; neither do the request id or the code (SC-19, SC-33).
import { randomBytes, randomInt } from "node:crypto"
import {
  OFFICE_ERROR_FIELD_NOT_ALLOWED,
  OFFICE_ERROR_PAIR_RATE_LIMITED,
  OFFICE_ERROR_TOKEN_INVALID,
  OFFICE_PAIR_CODE_DIGITS,
  OFFICE_PAIR_RATE_LIMIT,
  OFFICE_PAIR_RATE_WINDOW_MS,
  OFFICE_PAIR_REQUEST_TTL_MS,
  OFFICE_TOKEN_PREFIX,
} from "@swarm/office-addin/constants"
import type { Admission } from "./admit"
import type { PairingStore } from "./pairing-store"
import {
  isOfficeHost,
  type BridgeLogSink,
  type OfficeHost,
  type PairDecision,
  type PairDecisionSource,
  type PairRequestSink,
} from "./protocol"

/** How long a finished record (denied, expired, consumed) still answers its own state after `expiresAt`. */
export const PAIR_RECORD_RETAIN_MS = OFFICE_PAIR_REQUEST_TTL_MS

export type PairRequestAdmission = Extract<Admission, { kind: "local"; route: "pair-request" }>
export type PairStatusAdmission = Extract<Admission, { kind: "local"; route: "pair-status" }>
export type PairVerifyAdmission = Extract<Admission, { kind: "local"; route: "pair-verify" }>

export type PairState = "pending" | "approved" | "denied" | "expired" | "consumed"

export type PairRequestBody = { requestId: string; code: string; expiresAt: string }
export type PairStatusBody = { state: PairState; token?: string }

/** What the routes layer writes. Bodies are JSON; every pairing response must be sent with `cache-control: no-store`. */
export type PairingResponse =
  | { status: 202; body: PairRequestBody }
  | { status: 200; body: PairStatusBody }
  | { status: 204 }
  | { status: 400 | 401 | 429; body: { error: string } }

/** Cancel handle of a scheduled callback. */
export type PairTimerCancel = () => void

export type PairingOptions = {
  /** The pairing store (M4-01). Only `put`, `verify`, `revoke` and `clear` are used; `lookup` belongs to admit(). */
  store: Pick<PairingStore, "put" | "verify" | "revoke" | "clear">
  /** Bridge -> main `pair-request` (protocol.ts). Called once per accepted `POST /pair/request`. */
  pairRequests: PairRequestSink
  /** Main -> bridge `pair-decision`. Optional: a caller may feed `decide()` directly instead. */
  pairDecisions?: PairDecisionSource
  log?: BridgeLogSink
  /** Injected clock (ms since epoch); defaults to `Date.now`. */
  now?: () => number
  /** Injected scheduler for the expiry sweep; defaults to an unref'd `setTimeout`. */
  setTimer?: (callback: () => void, ms: number) => PairTimerCancel
}

type PairRecord = {
  requestId: string
  host: OfficeHost
  expiresAt: number
  /** `issuing`: allow received, the store write is in flight; status reads still answer `pending`. */
  state: PairState | "issuing"
  /** Plaintext token, present only while `approved` and unread. */
  token?: string
}

const SOURCE = "office-bridge.pairing"

/** `swo1_` + base64url(32 random bytes), 48 characters (register §5). */
export function generatePairToken() {
  return OFFICE_TOKEN_PREFIX + randomBytes(32).toString("base64url")
}

/** base64url of 16 random bytes, 22 characters (register §5). */
export function generatePairRequestId() {
  return randomBytes(16).toString("base64url")
}

/** 4 uniformly random decimal digits (register §5; not a secret, for visual matching only). */
export function generatePairCode() {
  return randomInt(0, 10 ** OFFICE_PAIR_CODE_DIGITS)
    .toString()
    .padStart(OFFICE_PAIR_CODE_DIGITS, "0")
}

const defaultTimer = (callback: () => void, ms: number): PairTimerCancel => {
  const handle = setTimeout(callback, ms)
  handle.unref?.()
  return () => clearTimeout(handle)
}

const noLog: BridgeLogSink = () => {}

const error = (status: 400 | 401 | 429, code: string): PairingResponse => ({ status, body: { error: code } })

export function createPairing(options: PairingOptions) {
  const now = options.now ?? Date.now
  const setTimer = options.setTimer ?? defaultTimer
  const log = options.log ?? noLog
  const records = new Map<string, PairRecord>()
  const timers = new Map<string, PairTimerCancel>()
  /** Times of accepted (202) requests inside the rate window. Rejected requests do not count. */
  const accepted: number[] = []
  const state = { stopped: false }

  /** Revokes still in flight; every sweep waits for them, so a sweep started by a timer is never half-seen. */
  const inflight = new Set<Promise<boolean>>()

  const revoke = (token: string, host: OfficeHost) => {
    const run = options.store.revoke(token).catch((cause: unknown) => {
      log("error", SOURCE, "revoke of an unread pairing failed", {
        host,
        error: cause instanceof Error ? cause.message : "unknown",
      })
      return false
    })
    inflight.add(run)
    void run.finally(() => inflight.delete(run))
    return run
  }

  /** Expires due records (an unread approved token is revoked from the store) and drops old finished records. */
  const sweep = async () => {
    const at = now()
    const revokes = [...records.values()].flatMap((record) => {
      if (at >= record.expiresAt + PAIR_RECORD_RETAIN_MS) {
        records.delete(record.requestId)
        timers.get(record.requestId)?.()
        timers.delete(record.requestId)
      }
      if (at < record.expiresAt) return []
      if (record.state === "pending") {
        record.state = "expired"
        log("info", SOURCE, "pairing request expired", { host: record.host })
        return []
      }
      if (record.state !== "approved" || record.token === undefined) return []
      const token = record.token
      record.state = "expired"
      record.token = undefined
      log("warn", SOURCE, "approved pairing expired unread; entry removed", { host: record.host })
      return [revoke(token, record.host)]
    })
    await Promise.all([...revokes, ...inflight])
  }

  const schedule = (record: PairRecord) => {
    timers.set(
      record.requestId,
      setTimer(
        () => {
          timers.delete(record.requestId)
          void sweep()
        },
        Math.max(0, record.expiresAt - now()),
      ),
    )
  }

  /** The user's answer from main. Unknown, finished or late decisions are discarded (spec §11.2 DLG-1). */
  const decide = async (decision: PairDecision) => {
    await sweep()
    const record = records.get(decision.requestId)
    if (!record || record.state !== "pending") {
      log("warn", SOURCE, "pair decision discarded", { reason: record ? `state-${record.state}` : "unknown-or-late" })
      return
    }
    if (!decision.allow) {
      record.state = "denied"
      log("info", SOURCE, "pairing denied", { host: record.host })
      return
    }
    record.state = "issuing"
    const token = generatePairToken()
    const stored = await options.store.put(record.host, token).then(
      () => true,
      (cause: unknown) => {
        log("error", SOURCE, "pairing store write failed", {
          host: record.host,
          error: cause instanceof Error ? cause.message : "unknown",
        })
        return false
      },
    )
    // put() updates memory before the disk write, so a failed write or a request that expired (or a Disconnect /
    // stop) meanwhile must not leave a valid hash with no one to deliver its token to.
    if (!stored || record.state !== "issuing" || now() >= record.expiresAt || state.stopped) {
      if (record.state === "issuing") record.state = "expired"
      await revoke(token, record.host)
      return
    }
    record.state = "approved"
    record.token = token
    log("info", SOURCE, "pairing approved", { host: record.host })
  }

  const unsubscribe = options.pairDecisions?.subscribe((decision) => {
    void decide(decision)
  })

  return {
    /** `POST /pair/request`: 1 pending at a time and 5 accepted per 60 s, else `429 PAIR_RATE_LIMITED`. */
    async request(admission: PairRequestAdmission): Promise<PairingResponse> {
      if (!isOfficeHost(admission.host)) return error(400, OFFICE_ERROR_FIELD_NOT_ALLOWED)
      await sweep()
      const at = now()
      const pending = [...records.values()].some((record) => record.state === "pending" || record.state === "issuing")
      while (accepted.length > 0 && at - accepted[0] >= OFFICE_PAIR_RATE_WINDOW_MS) accepted.shift()
      if (pending || accepted.length >= OFFICE_PAIR_RATE_LIMIT || state.stopped) {
        log("warn", SOURCE, "pairing request rate limited", { host: admission.host, reason: pending ? "pending" : "window" })
        return error(429, OFFICE_ERROR_PAIR_RATE_LIMITED)
      }
      accepted.push(at)
      const record: PairRecord = {
        requestId: generatePairRequestId(),
        host: admission.host,
        expiresAt: at + OFFICE_PAIR_REQUEST_TTL_MS,
        state: "pending",
      }
      records.set(record.requestId, record)
      schedule(record)
      const code = generatePairCode()
      log("info", SOURCE, "pairing requested", { host: record.host })
      options.pairRequests({ requestId: record.requestId, host: record.host, code })
      return {
        status: 202,
        body: { requestId: record.requestId, code, expiresAt: new Date(record.expiresAt).toISOString() },
      }
    },

    /** `GET /pair/status`: the token exactly once, then `consumed`; an unknown id answers `expired`. */
    async status(admission: PairStatusAdmission): Promise<PairingResponse> {
      await sweep()
      const record = records.get(admission.requestId)
      if (!record) return { status: 200, body: { state: "expired" } }
      if (record.state === "issuing") return { status: 200, body: { state: "pending" } }
      if (record.state !== "approved" || record.token === undefined) return { status: 200, body: { state: record.state } }
      const token = record.token
      record.token = undefined
      record.state = "consumed"
      log("info", SOURCE, "pairing token delivered", { host: record.host })
      return { status: 200, body: { state: "approved", token } }
    },

    /** `GET /pair/verify`: the only caller of `store.verify` (writes `lastUsedAt`, C35). 204 or 401. */
    async verify(admission: PairVerifyAdmission): Promise<PairingResponse> {
      const host = await options.store.verify(admission.token)
      if (!host) return error(401, OFFICE_ERROR_TOKEN_INVALID)
      return { status: 204 }
    },

    decide,

    /** Runs the expiry sweep now (also runs on every call and on each request's expiry timer). */
    sweep,

    /** Disconnect (`pairings-cleared`, spec §11.4): empty the store; an approved token not yet read is dropped. */
    async pairingsCleared() {
      records.forEach((record) => {
        if (record.state !== "approved") return
        record.state = "expired"
        record.token = undefined
      })
      await options.store.clear()
    },

    /** Stops timers and the decision subscription. Unread tokens are dropped and revoked. */
    async stop() {
      state.stopped = true
      unsubscribe?.()
      timers.forEach((cancel) => cancel())
      timers.clear()
      const revokes = [...records.values()].flatMap((record) => {
        if (record.state !== "approved" || record.token === undefined) return []
        const token = record.token
        record.token = undefined
        record.state = "expired"
        return [revoke(token, record.host)]
      })
      await Promise.all(revokes)
    },
  }
}

export type Pairing = ReturnType<typeof createPairing>
