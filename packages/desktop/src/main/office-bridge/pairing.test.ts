// Unit tests for the pairing endpoints (plan M4-02): U-PS-06..U-PS-08, ST-01 (via admit), decision handling,
// expiry of an unread approved token, late decisions, verify (C35). Real pairing store in a temp dir; injected clock.
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { OFFICE_PAIR_REQUEST_TTL_MS } from "@swarm/office-addin/constants"
import { admit, type AdmitRequest } from "./admit"
import {
  createPairing,
  generatePairToken,
  PAIR_RECORD_RETAIN_MS,
  type PairingResponse,
  type PairRequestAdmission,
} from "./pairing"
import { createPairingStore, hashToken, pairingsPath } from "./pairing-store"
import type { PairDecision, PairRequest } from "./protocol"

const START = Date.parse("2026-11-16T10:00:00.000Z")
const PORT = 46317

const roots: string[] = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))

const setup = async () => {
  const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "pairing-"))
  roots.push(root)
  const dir = join(root, "office-addin")
  // `at` is the wall clock (store timestamps, expiresAt ISO); `mono` is the monotonic clock (expiry, rate window).
  const clock = { at: START, mono: 0 }
  const store = createPairingStore({ dir, now: () => new Date(clock.at), log: () => {} })
  await store.load()
  const events: PairRequest[] = []
  const timers: { at: number; run: () => void; cancelled: boolean }[] = []
  const logs: { level: string; message: string; context?: Record<string, unknown> }[] = []
  const listeners: ((decision: PairDecision) => void)[] = []
  const pairing = createPairing({
    store,
    pairRequests: (request) => events.push(request),
    pairDecisions: {
      subscribe(listener) {
        listeners.push(listener)
        return () => listeners.splice(listeners.indexOf(listener), 1)
      },
    },
    log: (level, _source, message, context) => logs.push({ level, message, context }),
    now: () => clock.at,
    monotonic: () => clock.mono,
    setTimer: (run, ms) => {
      const timer = { at: clock.mono + ms, run, cancelled: false }
      timers.push(timer)
      return () => {
        timer.cancelled = true
      }
    },
  })
  /** Advances the clock and fires due timers. */
  const advance = async (ms: number) => {
    clock.at += ms
    clock.mono += ms
    timers.filter((timer) => !timer.cancelled && timer.at <= clock.mono).forEach((timer) => {
      timer.cancelled = true
      timer.run()
    })
    await pairing.sweep()
  }
  return { dir, clock, store, events, timers, logs, listeners, pairing, advance }
}

const word: PairRequestAdmission = { kind: "local", route: "pair-request", host: "Word" }

const body202 = (response: PairingResponse) => {
  if (response.status !== 202) throw new Error(`expected 202, got ${response.status}`)
  return response.body
}

const status = (ctx: Awaited<ReturnType<typeof setup>>, requestId: string) =>
  ctx.pairing.status({ kind: "local", route: "pair-status", requestId })

describe("U-PS-06: token format", () => {
  test("swo1_ + 43 base64url chars = 48; 1,000 tokens distinct", () => {
    const tokens = Array.from({ length: 1000 }, generatePairToken)
    tokens.forEach((token) => expect(token).toMatch(/^swo1_[A-Za-z0-9_-]{43}$/))
    tokens.forEach((token) => expect(token.length).toBe(48))
    expect(new Set(tokens).size).toBe(1000)
  })
})

describe("U-PS-07: request lifecycle", () => {
  test("202 shape, pending -> approved returns token once -> consumed; store holds its hash", async () => {
    const ctx = await setup()
    const response = await ctx.pairing.request(word)
    const body = body202(response)
    expect(body.requestId).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(body.code).toMatch(/^[0-9]{4}$/)
    expect(body.expiresAt).toBe(new Date(START + OFFICE_PAIR_REQUEST_TTL_MS).toISOString())
    expect(ctx.events).toEqual([{ requestId: body.requestId, host: "Word", code: body.code }])

    expect(await status(ctx, body.requestId)).toEqual({ status: 200, body: { state: "pending" } })
    await ctx.pairing.decide({ requestId: body.requestId, allow: true })
    const first = await status(ctx, body.requestId)
    if (first.status !== 200) throw new Error("expected 200")
    expect(first.body.state).toBe("approved")
    const token = first.body.token ?? ""
    expect(token).toMatch(/^swo1_[A-Za-z0-9_-]{43}$/)
    expect(await status(ctx, body.requestId)).toEqual({ status: 200, body: { state: "consumed" } })
    expect(await status(ctx, body.requestId)).toEqual({ status: 200, body: { state: "consumed" } })

    const file = readFileSync(pairingsPath(ctx.dir), "utf8")
    expect(file).toContain(hashToken(token))
    expect(file).not.toContain(token)
    expect(JSON.stringify(ctx.logs)).not.toContain(token)
    expect(JSON.stringify(ctx.logs)).not.toContain(body.requestId)
  })

  test("decision via the pair-decision source subscription", async () => {
    const ctx = await setup()
    const body = body202(await ctx.pairing.request(word))
    expect(ctx.listeners.length).toBe(1)
    ctx.listeners[0]({ requestId: body.requestId, allow: false })
    await ctx.pairing.sweep()
    expect(await status(ctx, body.requestId)).toEqual({ status: 200, body: { state: "denied" } })
    await ctx.pairing.stop()
    expect(ctx.listeners.length).toBe(0)
  })

  test("120 s with no decision gives expired; a late allow is discarded and stores nothing", async () => {
    const ctx = await setup()
    const body = body202(await ctx.pairing.request(word))
    await ctx.advance(OFFICE_PAIR_REQUEST_TTL_MS - 1)
    expect(await status(ctx, body.requestId)).toEqual({ status: 200, body: { state: "pending" } })
    await ctx.advance(1)
    expect(await status(ctx, body.requestId)).toEqual({ status: 200, body: { state: "expired" } })
    await ctx.pairing.decide({ requestId: body.requestId, allow: true })
    expect(await status(ctx, body.requestId)).toEqual({ status: 200, body: { state: "expired" } })
    expect(ctx.store.list()).toEqual([])
    expect(ctx.logs.some((line) => line.message === "pair decision discarded")).toBe(true)
  })

  test("approved but unread at expiry: entry removed from the store (no orphan hash), state expired", async () => {
    const ctx = await setup()
    const body = body202(await ctx.pairing.request(word))
    await ctx.pairing.decide({ requestId: body.requestId, allow: true })
    expect(ctx.store.list().map((entry) => entry.host)).toEqual(["Word"])
    await ctx.advance(OFFICE_PAIR_REQUEST_TTL_MS)
    expect(ctx.store.list()).toEqual([])
    expect(JSON.parse(readFileSync(pairingsPath(ctx.dir), "utf8")).pairings).toEqual([])
    expect(await status(ctx, body.requestId)).toEqual({ status: 200, body: { state: "expired" } })
  })

  test("the expiry timer alone removes the unread entry (no further request needed)", async () => {
    const ctx = await setup()
    const body = body202(await ctx.pairing.request(word))
    await ctx.pairing.decide({ requestId: body.requestId, allow: true })
    ctx.clock.mono += OFFICE_PAIR_REQUEST_TTL_MS
    const due = ctx.timers.filter((timer) => !timer.cancelled && timer.at <= ctx.clock.mono)
    expect(due.length).toBe(1)
    due[0].run()
    await ctx.pairing.sweep()
    expect(ctx.store.list()).toEqual([])
  })

  test("deny, second decision and unknown ids", async () => {
    const ctx = await setup()
    const body = body202(await ctx.pairing.request(word))
    await ctx.pairing.decide({ requestId: body.requestId, allow: false })
    await ctx.pairing.decide({ requestId: body.requestId, allow: true })
    expect(await status(ctx, body.requestId)).toEqual({ status: 200, body: { state: "denied" } })
    expect(ctx.store.list()).toEqual([])
    expect(await status(ctx, "A".repeat(22))).toEqual({ status: 200, body: { state: "expired" } })
    await ctx.pairing.decide({ requestId: "B".repeat(22), allow: true })
    expect(ctx.store.list()).toEqual([])
  })

  test("finished records are forgotten after the retention window and then read as expired", async () => {
    const ctx = await setup()
    const body = body202(await ctx.pairing.request(word))
    await ctx.pairing.decide({ requestId: body.requestId, allow: true })
    await status(ctx, body.requestId)
    await ctx.advance(OFFICE_PAIR_REQUEST_TTL_MS + PAIR_RECORD_RETAIN_MS)
    expect(await status(ctx, body.requestId)).toEqual({ status: 200, body: { state: "expired" } })
    // A consumed token stays paired: retention only forgets the request record.
    expect(ctx.store.list().map((entry) => entry.host)).toEqual(["Word"])
  })

  test("pairing again for the same host replaces its entry (SC-16)", async () => {
    const ctx = await setup()
    const first = body202(await ctx.pairing.request(word))
    await ctx.pairing.decide({ requestId: first.requestId, allow: true })
    await status(ctx, first.requestId)
    const second = body202(await ctx.pairing.request(word))
    await ctx.pairing.decide({ requestId: second.requestId, allow: true })
    expect(ctx.store.list().length).toBe(1)
  })
})

describe("U-PS-08: limits", () => {
  test("a second pending request gives 429 PAIR_RATE_LIMITED", async () => {
    const ctx = await setup()
    body202(await ctx.pairing.request(word))
    expect(await ctx.pairing.request({ ...word, host: "Excel" })).toEqual({
      status: 429,
      body: { error: "PAIR_RATE_LIMITED" },
    })
    expect(ctx.events.length).toBe(1)
  })

  test("6th request in 60 s gives 429; the 61st second allows it again", async () => {
    const ctx = await setup()
    for (const _ of [1, 2, 3, 4, 5]) {
      const body = body202(await ctx.pairing.request(word))
      await ctx.pairing.decide({ requestId: body.requestId, allow: false })
      await ctx.advance(1000)
    }
    expect(await ctx.pairing.request(word)).toEqual({ status: 429, body: { error: "PAIR_RATE_LIMITED" } })
    expect(ctx.events.length).toBe(5)
    // First accepted request was at monotonic 0; at 60 s it leaves the window.
    ctx.clock.mono = 59_999
    expect((await ctx.pairing.request(word)).status).toBe(429)
    ctx.clock.mono = 60_000
    expect((await ctx.pairing.request(word)).status).toBe(202)
  })

  test("an expired pending request no longer blocks a new one", async () => {
    const ctx = await setup()
    body202(await ctx.pairing.request(word))
    await ctx.advance(OFFICE_PAIR_REQUEST_TTL_MS)
    expect((await ctx.pairing.request(word)).status).toBe(202)
  })
})

describe("/pair/verify (C35: store.verify only here)", () => {
  test("204 for a paired token and lastUsedAt updated; 401 TOKEN_INVALID otherwise", async () => {
    const ctx = await setup()
    const body = body202(await ctx.pairing.request(word))
    await ctx.pairing.decide({ requestId: body.requestId, allow: true })
    const read = await status(ctx, body.requestId)
    if (read.status !== 200) throw new Error("expected 200")
    const token = read.body.token ?? ""
    ctx.clock.at += 5000
    expect(await ctx.pairing.verify({ kind: "local", route: "pair-verify", host: "Word", token })).toEqual({ status: 204 })
    expect(ctx.store.list()[0].lastUsedAt).toBe(new Date(ctx.clock.at).toISOString())
    const other = generatePairToken()
    expect(await ctx.pairing.verify({ kind: "local", route: "pair-verify", host: "Word", token: other })).toEqual({
      status: 401,
      body: { error: "TOKEN_INVALID" },
    })
  })
})

describe("M4-02a: monotonic clock (CP-M4 F-2)", () => {
  const HOUR = 60 * 60 * 1000

  test("wall clock set back 1 h: a pending request still expires at 120 s monotonic", async () => {
    const ctx = await setup()
    const body = body202(await ctx.pairing.request(word))
    ctx.clock.at -= HOUR
    await ctx.advance(OFFICE_PAIR_REQUEST_TTL_MS - 1)
    expect(await status(ctx, body.requestId)).toEqual({ status: 200, body: { state: "pending" } })
    await ctx.advance(1)
    expect(await status(ctx, body.requestId)).toEqual({ status: 200, body: { state: "expired" } })
    // Pairing is not blocked: the expired request no longer counts as pending.
    expect((await ctx.pairing.request(word)).status).toBe(202)
  })

  test("wall clock set back 1 h: the 5/60 s window still reopens after 60 s monotonic", async () => {
    const ctx = await setup()
    for (const _ of [1, 2, 3, 4, 5]) {
      const body = body202(await ctx.pairing.request(word))
      await ctx.pairing.decide({ requestId: body.requestId, allow: false })
    }
    ctx.clock.at -= HOUR
    expect((await ctx.pairing.request(word)).status).toBe(429)
    ctx.clock.mono = 60_000
    expect((await ctx.pairing.request(word)).status).toBe(202)
  })

  test("wall clock set forward 1 h does not expire a pending request early; expiresAt follows the wall clock", async () => {
    const ctx = await setup()
    const first = body202(await ctx.pairing.request(word))
    expect(first.expiresAt).toBe(new Date(START + OFFICE_PAIR_REQUEST_TTL_MS).toISOString())
    ctx.clock.at += HOUR
    await ctx.pairing.sweep()
    expect(await status(ctx, first.requestId)).toEqual({ status: 200, body: { state: "pending" } })
    await ctx.pairing.decide({ requestId: first.requestId, allow: true })
    const read = await status(ctx, first.requestId)
    expect(read.status === 200 && read.body.state).toBe("approved")
  })
})

describe("Disconnect and stop", () => {
  test("pairingsCleared empties the store and drops an unread token", async () => {
    const ctx = await setup()
    const body = body202(await ctx.pairing.request(word))
    await ctx.pairing.decide({ requestId: body.requestId, allow: true })
    await ctx.pairing.pairingsCleared()
    expect(ctx.store.list()).toEqual([])
    expect(await status(ctx, body.requestId)).toEqual({ status: 200, body: { state: "expired" } })
  })

  test("stop revokes an unread token, cancels timers, and refuses new requests", async () => {
    const ctx = await setup()
    const body = body202(await ctx.pairing.request(word))
    await ctx.pairing.decide({ requestId: body.requestId, allow: true })
    await ctx.pairing.stop()
    expect(ctx.store.list()).toEqual([])
    expect(ctx.timers.every((timer) => timer.cancelled)).toBe(true)
    expect((await ctx.pairing.request(word)).status).toBe(429)
  })
})

describe("ST-01: pair-request events only after admit() passes", () => {
  const request = (headers: Record<string, string>): AdmitRequest => {
    const text = JSON.stringify({ host: "Word" })
    return {
      method: "POST",
      target: "/pair/request",
      headers: Object.entries({
        host: `localhost:${PORT}`,
        origin: `https://localhost:${PORT}`,
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(text)),
        ...headers,
      }),
      body: new TextEncoder().encode(text),
    }
  }
  const run = async (ctx: Awaited<ReturnType<typeof setup>>, req: AdmitRequest) => {
    const admission = await admit(req, { port: PORT, verifyToken: () => undefined })
    if (admission.kind !== "local" || admission.route !== "pair-request") return admission
    return ctx.pairing.request(admission)
  }

  test("missing or wrong X-Swarm-Office: 403 and zero pair-request events", async () => {
    const ctx = await setup()
    expect(await run(ctx, request({}))).toEqual({ kind: "reject", status: 403, code: "CSRF_HEADER_MISSING" })
    expect(await run(ctx, request({ "X-Swarm-Office": "0" }))).toEqual({
      kind: "reject",
      status: 403,
      code: "CSRF_HEADER_MISSING",
    })
    expect(ctx.events.length).toBe(0)
  })

  test("control: with the header, exactly one event", async () => {
    const ctx = await setup()
    const response = await run(ctx, request({ "X-Swarm-Office": "1" }))
    expect("status" in response && response.status).toBe(202)
    expect(ctx.events.length).toBe(1)
  })
})
