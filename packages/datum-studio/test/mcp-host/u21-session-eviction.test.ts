// U21 / ECO-1 F-4: 64 sessions that a client opened and never closed locked every caller out of the Studio host (503),
// the app's own Mission Control included. Real endpoint on 127.0.0.1 (ephemeral port), a fake clock, raw HTTP.
import { afterEach, describe, expect, test } from "bun:test"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { ATTESTED_RESERVE, IDLE_EVICT_MS, MAX_SESSIONS, SessionRefused, startEndpoint } from "../../src/mcp-host/http-server.ts"

const TOKEN = "t".repeat(48)
const KEY = "k".repeat(48)
let clock = 1_000_000
let endpoint: Awaited<ReturnType<typeof startEndpoint>> | undefined
const logs: Record<string, unknown>[] = []

async function start() {
  endpoint = await startEndpoint({
    port: 0,
    token: TOKEN,
    missionControlKey: KEY,
    now: () => clock,
    log: (r) => logs.push(r),
    openSession: ({ agentId }) => {
      if (agentId === "refuse") throw new SessionRefused(403, "refused for the test")
      const server = new Server({ name: "u21", version: "0" }, { capabilities: { tools: {} } })
      return { server, close: async () => {} }
    },
  })
  return endpoint
}

afterEach(async () => {
  await endpoint?.close()
  endpoint = undefined
  logs.length = 0
})

const headers = (extra: Record<string, string> = {}) => ({
  authorization: `Bearer ${TOKEN}`,
  "x-studio-agent": "u21",
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
  ...extra,
})
const INIT = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "u21", version: "0" } } }

async function open(attested = false, extra: Record<string, string> = {}): Promise<{ status: number; sid: string | null }> {
  const r = await fetch(endpoint!.url, { method: "POST", headers: headers({ ...(attested ? { "x-swarm-mission-control-key": KEY } : {}), ...extra }), body: JSON.stringify(INIT) })
  await r.body?.cancel()
  return { status: r.status, sid: r.headers.get("mcp-session-id") }
}
async function ping(sid: string) {
  const r = await fetch(endpoint!.url, { method: "POST", headers: headers({ "mcp-session-id": sid, "mcp-protocol-version": "2025-03-26" }), body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }) })
  await r.body?.cancel()
  return r.status
}
const tick = () => new Promise((r) => setTimeout(r, 20))

describe("U21 F-4 Studio session cap", () => {
  test("a full host closes the least recently used abandoned session instead of refusing everyone", async () => {
    await start()
    const sids: string[] = []
    for (let i = 0; i < MAX_SESSIONS; i++) {
      const o = await open()
      expect(o.status).toBe(200)
      sids.push(o.sid!)
      clock += 10
    }
    await tick()
    // Not idle long enough: the old 503 still holds, nothing is closed.
    expect((await open()).status).toBe(503)
    clock += IDLE_EVICT_MS
    // Touch the oldest: now the second-oldest is the least recently used.
    expect(await ping(sids[0]!)).toBe(200)
    await tick()
    clock += 1
    const next = await open()
    expect(next.status).toBe(200)
    expect(logs.filter((l) => l.event === "session_evicted")).toHaveLength(1)
    expect(await ping(sids[1]!)).toBe(404)
    expect(await ping(sids[0]!)).toBe(200)
    expect(endpoint!.sessionCount()).toBe(MAX_SESSIONS)
  })

  test("a session holding its GET stream (a live bridge) is never closed", async () => {
    await start()
    const first = await open()
    const stream = await fetch(endpoint!.url, { method: "GET", headers: headers({ "mcp-session-id": first.sid!, "mcp-protocol-version": "2025-03-26", accept: "text/event-stream" }) })
    expect(stream.status).toBe(200)
    for (let i = 1; i < MAX_SESSIONS; i++) {
      clock += 10
      await open()
    }
    clock += IDLE_EVICT_MS * 10
    await tick()
    expect((await open()).status).toBe(200)
    expect(await ping(first.sid!)).toBe(200)
    await stream.body?.cancel()
  })

  test("Mission Control (attested) still gets in when unattested sessions fill the cap, and is never evicted", async () => {
    await start()
    for (let i = 0; i < MAX_SESSIONS; i++) await open()
    await tick()
    const mc = await open(true)
    expect(mc.status).toBe(200)
    expect(logs.filter((l) => l.event === "session_evicted")).toHaveLength(0)
    for (let i = 1; i < ATTESTED_RESERVE; i++) expect((await open(true)).status).toBe(200)
    expect((await open(true)).status).toBe(503)
    clock += IDLE_EVICT_MS * 10
    await tick()
    // An unattested caller may evict an abandoned unattested session, never an attested one.
    expect((await open()).status).toBe(200)
    expect(await ping(mc.sid!)).toBe(200)
  })

  test("a DELETE from the client is logged as session_closed", async () => {
    await start()
    const o = await open()
    const r = await fetch(endpoint!.url, { method: "DELETE", headers: headers({ "mcp-session-id": o.sid!, "mcp-protocol-version": "2025-03-26" }) })
    await r.body?.cancel()
    expect(r.status).toBe(200)
    expect(logs.some((l) => l.event === "session_closed")).toBe(true)
    expect(endpoint!.sessionCount()).toBe(0)
  })

  test("M12 G1: a malformed or refused initialize at the cap closes nobody", async () => {
    await start()
    for (let i = 0; i < MAX_SESSIONS; i++) await open()
    clock += IDLE_EVICT_MS * 10
    await tick()
    expect((await open(false, { "x-studio-agent": "bad agent!" })).status).toBe(400)
    expect((await open(false, { "x-studio-agent": "refuse" })).status).toBe(403)
    expect(logs.filter((l) => l.event === "session_evicted")).toHaveLength(0)
    expect(endpoint!.sessionCount()).toBe(MAX_SESSIONS)
    expect((await open()).status).toBe(200)
    expect(logs.filter((l) => l.event === "session_evicted")).toHaveLength(1)
  })

  test("M12 F1: the total never passes MAX_SESSIONS + ATTESTED_RESERVE, and Mission Control evicts an abandoned session at it", async () => {
    await start()
    for (let i = 0; i < MAX_SESSIONS; i++) expect((await open(true)).status).toBe(200)
    await tick()
    // Attested sessions are counted: the unattested cap is the total, and attested sessions are never evicted.
    clock += IDLE_EVICT_MS * 10
    expect((await open()).status).toBe(503)
    for (let i = 0; i < ATTESTED_RESERVE; i++) expect((await open(true)).status).toBe(200)
    expect((await open(true)).status).toBe(503)
    expect(endpoint!.sessionCount()).toBe(MAX_SESSIONS + ATTESTED_RESERVE)
  })

  test("M12 G2: at the total, Mission Control gets in by closing an abandoned unattested session", async () => {
    await start()
    for (let i = 0; i < MAX_SESSIONS; i++) await open()
    for (let i = 0; i < ATTESTED_RESERVE; i++) await open(true)
    clock += IDLE_EVICT_MS * 10
    await tick()
    expect((await open(true)).status).toBe(200)
    expect(logs.filter((l) => l.event === "session_evicted")).toHaveLength(1)
    expect(endpoint!.sessionCount()).toBe(MAX_SESSIONS + ATTESTED_RESERVE)
  })

  test("M12 S12-03: concurrent initialize requests cannot pass the cap", async () => {
    await start()
    const results = await Promise.all(Array.from({ length: MAX_SESSIONS + 10 }, () => open()))
    expect(results.filter((r) => r.status === 200)).toHaveLength(MAX_SESSIONS)
    expect(endpoint!.sessionCount()).toBe(MAX_SESSIONS)
  })
})
