// Row 127 unit tests: allow-list, argument validation (spec §3.3), token isolation, the answer id rule and the
// session handling of the mission control client. The host is a recording fake fetch; the real host is in
// mission-client.integration.test.ts.
import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { join } from "node:path"
import {
  createMissionControlClient,
  loopbackMcpUrl,
  MISSION_CONTROL_TOOLS,
  parseAnswerInput,
  parseGetInput,
  parseInstructInput,
  parseListInput,
  type FetchLike,
} from "./mission-client"

const SCRATCH = "/private/tmp/claude-501/row127"
const dir = mkdtempSync(join(SCRATCH, "unit-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const TOKEN = "f".repeat(64)
const URL_OK = "http://127.0.0.1:47999/mcp"
const MISSION = "2026-11-07_kasus-07"

type Call = { url: string; headers: Record<string, string>; body: Record<string, unknown> }
type ToolReply = (name: string, args: Record<string, unknown>) => Record<string, unknown>

function fakeHost(reply: ToolReply, opts: { sse?: boolean; status?: (n: number, body: Record<string, unknown>) => number | undefined } = {}) {
  const calls: Call[] = []
  let sessions = 0
  const fetch: FetchLike = async (url, init) => {
    const body = JSON.parse(init.body ?? "{}") as Record<string, unknown>
    calls.push({ url, headers: init.headers, body })
    const forced = opts.status?.(calls.length, body)
    if (forced) return new Response("", { status: forced })
    if (body.method === "initialize") {
      sessions++
      const msg = { jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18", serverInfo: { name: "fake" }, capabilities: {} } }
      return new Response(JSON.stringify(msg), { status: 200, headers: { "content-type": "application/json", "mcp-session-id": `s${sessions}` } })
    }
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 })
    const params = body.params as { name: string; arguments: Record<string, unknown> }
    const structured = reply(params.name, params.arguments)
    const msg = { jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "x" }], structuredContent: structured } }
    if (opts.sse)
      return new Response(`event: message\ndata: ${JSON.stringify(msg)}\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } })
    return new Response(JSON.stringify(msg), { status: 200, headers: { "content-type": "application/json" } })
  }
  return { fetch, calls, toolCalls: () => calls.filter((c) => c.body.method === "tools/call") }
}

const client = (fetch: FetchLike, extra: Partial<Parameters<typeof createMissionControlClient>[0]> = {}) =>
  createMissionControlClient({ url: URL_OK, token: TOKEN, callerCwd: join(dir, "mc"), fetch, ...extra })

describe("allow-list", () => {
  test("exactly the four tools of spec §3.3", () => {
    expect([...MISSION_CONTROL_TOOLS]).toEqual([
      "studio_mission_list",
      "studio_mission_get",
      "studio_mission_answer_decision",
      "studio_mission_update_row",
    ])
  })

  for (const name of ["studio_render", "studio_mission_create", "studio_mission_set_status", "studio_document_get", "studio_mission_list ", "", "__proto__"]) {
    test(`refuses ${JSON.stringify(name)} before any request`, async () => {
      const host = fakeHost(() => ({ ok: true }))
      const c = client(host.fetch)
      await expect(c.callTool(name, {})).rejects.toMatchObject({ code: "TOOL_NOT_ALLOWED" })
      expect(host.calls).toHaveLength(0)
    })
  }

  test("each public method calls exactly its one tool with main-built arguments", async () => {
    const host = fakeHost((name) => {
      if (name === "studio_mission_list") return { ok: true, tool: name, items: [{ id: MISSION }], nextCursor: null }
      if (name === "studio_mission_get") return { ok: true, tool: name, mission: { id: MISSION, decisions: [] }, derived: {}, requests: [], messages: [], deliverables: [] }
      if (name === "studio_mission_answer_decision") return { ok: true, tool: name, decision: { id: "U1" }, released: ["3"], dryRun: false }
      return { ok: true, tool: name, changed: [], waves: [], ready: [], checkpoints: [], messages: [{ seq: 7 }], dryRun: false }
    })
    const c = client(host.fetch)
    // INTENT 1.2.7 U-1: list sends the session ids and no projectDir; U-4 (N7-031): messagesTail 50.
    expect(await c.list({ directory: "/Users/x/proj", sessions: ["ses_abc123"] })).toEqual({ ok: true, data: { items: [{ id: MISSION }] as never } })
    expect((await c.get({ mission: MISSION })).ok).toBe(true)
    expect(await c.answer({ mission: MISSION, request: "D-1", option: "A" })).toEqual({ ok: true, data: { decision: "U1", released: ["3"] } })
    expect(await c.instruct({ mission: MISSION, text: "  hurry up  ", row: "4a" })).toEqual({ ok: true, data: { seq: 7 } })
    const tc = host.toolCalls().map((x) => x.body.params as { name: string; arguments: Record<string, unknown> })
    expect(tc.map((x) => x.name)).toEqual([
      "studio_mission_list",
      "studio_mission_get",
      "studio_mission_get",
      "studio_mission_answer_decision",
      "studio_mission_update_row",
    ])
    expect(tc[0].arguments).toEqual({ status: ["draft", "approved", "running", "paused", "done"], take: 20, sessions: ["ses_abc123"] })
    expect(tc[1].arguments).toEqual({ mission: MISSION, include: ["rows", "decisions", "requests", "messages", "deliverables"], messagesTail: 50 })
    expect(tc[2].arguments).toEqual({ mission: MISSION, include: ["decisions"] })
    expect(tc[3].arguments).toEqual({ mission: MISSION, request: "D-1", option: "A", by: "user", decisionId: "U1", actor: "mission-control" })
    expect(tc[4].arguments).toEqual({
      mission: MISSION,
      messages: [{ from: "owner", to: "controller", kind: "instruction", text: "hurry up", row: "4a" }],
      actor: "mission-control",
    })
    expect("rows" in tc[4].arguments).toBe(false)
  })
})

describe("argument checks (spec §3.3): BAD_ARGUMENT, no host call", () => {
  const badLists = [undefined, null, "x", [], {}, { directory: "" }, { directory: "rel/dir" }, { directory: "/a\u0000b" }, { directory: "/a\nb" }, { directory: "/" + "a".repeat(4096) }, { directory: 5 }, { directory: "/a", extra: 1 }]
  test.each(badLists.map((v) => [JSON.stringify(v) ?? "undefined", v]))("list %s", (_n, v) => {
    expect(parseListInput(v)).toMatchObject({ ok: false, code: "BAD_ARGUMENT" })
  })
  test("list accepts an absolute directory unchanged (no normalisation, spec §4.1)", () => {
    expect(parseListInput({ directory: "/private/tmp/x/" })).toEqual({ ok: true, value: { directory: "/private/tmp/x/" } })
  })

  const badMissions = ["", "kasus", "2026-11-07", "2026-11-07_", "2026-11-07_Kasus", "2026-11-07_k" + "a".repeat(81), "../2026-11-07_x", "2026-11-07_x/..", 3]
  test.each(badMissions.map((m) => [String(m), m]))("get mission %s", (_n, mission) => {
    expect(parseGetInput({ mission })).toMatchObject({ ok: false, code: "BAD_ARGUMENT" })
  })
  test("get accepts a mission id and nothing else", () => {
    expect(parseGetInput({ mission: MISSION })).toEqual({ ok: true, value: { mission: MISSION } })
    expect(parseGetInput({ mission: MISSION, include: ["events"] })).toMatchObject({ ok: false })
  })

  test("answer: request, option and extra keys", () => {
    const ok = { mission: MISSION, request: "D-12", option: "opt_b" }
    expect(parseAnswerInput(ok)).toEqual({ ok: true, value: ok })
    for (const request of ["D-", "D-123456", "d-1", "U1", "D-1 "]) expect(parseAnswerInput({ ...ok, request }).ok).toBe(false)
    for (const option of ["", "-a", "a".repeat(33), "a b", "ä"]) expect(parseAnswerInput({ ...ok, option }).ok).toBe(false)
    expect(parseAnswerInput({ ...ok, by: "controller" }).ok).toBe(false)
    expect(parseAnswerInput({ ...ok, decisionId: "C9" }).ok).toBe(false)
  })

  test("instruct: text trimmed, 1-2000, no control characters; row pattern; no rows patches", () => {
    expect(parseInstructInput({ mission: MISSION, text: "  go  " })).toEqual({ ok: true, value: { mission: MISSION, text: "go" } })
    expect(parseInstructInput({ mission: MISSION, text: "a".repeat(2000), row: "12b" }).ok).toBe(true)
    expect(parseInstructInput({ mission: MISSION, text: "go", row: undefined })).toEqual({ ok: true, value: { mission: MISSION, text: "go" } })
    for (const text of ["", "   ", "a".repeat(2001), "a\nb", "a\u0007b", "a\u0085b", "a\u007fb", 5])
      expect(parseInstructInput({ mission: MISSION, text }).ok).toBe(false)
    for (const row of ["0", "12345", "1-2", "A", ""]) expect(parseInstructInput({ mission: MISSION, text: "go", row }).ok).toBe(false)
    expect(parseInstructInput({ mission: MISSION, text: "go", rows: [{ id: "1", status: "done" }] }).ok).toBe(false)
  })

  test("public methods refuse bad input without a request", async () => {
    const host = fakeHost(() => ({ ok: true }))
    const c = client(host.fetch)
    const r = await Promise.all([
      c.list({ directory: "relative" }),
      c.get({ mission: "../../etc" }),
      c.answer({ mission: MISSION, request: "D-1", option: "A b" }),
      c.instruct({ mission: MISSION, text: "" }),
      c.instruct({ mission: MISSION, text: "go", rows: [] } as never),
    ])
    for (const x of r) expect(x).toMatchObject({ ok: false, code: "BAD_ARGUMENT" })
    expect(host.calls).toHaveLength(0)
  })
})

describe("token isolation", () => {
  test("token only in the Authorization header to the loopback /mcp; caller cwd is main's folder", async () => {
    const host = fakeHost(() => ({ ok: true, tool: "studio_mission_list", items: [] }))
    const cwd = join(dir, "mission-control-cwd")
    const c = client(host.fetch, { callerCwd: cwd })
    const r = await c.list({ directory: "/Users/x/proj", sessions: ["ses_abc123"] })
    expect(JSON.stringify(r)).not.toContain(TOKEN)
    for (const call of host.calls) {
      expect(call.url).toBe(URL_OK)
      expect(call.headers.authorization).toBe(`Bearer ${TOKEN}`)
      expect(call.headers["x-studio-agent"]).toBe("swarm")
      expect(decodeURIComponent(call.headers["x-studio-caller-cwd"])).toBe(cwd)
      expect(JSON.stringify(call.body)).not.toContain(TOKEN)
    }
    expect((statSync(cwd).mode & 0o777).toString(8)).toBe("700")
  })

  test("a host refusal is code + message only; details dropped; token scrubbed", async () => {
    const host = fakeHost((name) => ({ ok: false, tool: name, code: "MISSION_NOT_FOUND", error: { code: "MISSION_NOT_FOUND", message: `unknown ${TOKEN}`, details: { secret: TOKEN } } }))
    const logs: unknown[] = []
    const r = await client(host.fetch, { log: (...a) => void logs.push(a) }).get({ mission: MISSION })
    expect(r).toEqual({ ok: false, code: "MISSION_NOT_FOUND", message: "unknown [token]" })
    expect(JSON.stringify(logs)).not.toContain(TOKEN)
  })

  test("transport errors and logs never carry the token", async () => {
    const logs: unknown[] = []
    const c = client(async () => {
      throw new Error(`connect failed ${TOKEN}`)
    }, { log: (...a) => void logs.push(a) })
    const r = await c.list({ directory: "/a", sessions: ["ses_abc123"] })
    expect(r).toMatchObject({ ok: false, code: "HOST_UNAVAILABLE" })
    expect(JSON.stringify(r) + JSON.stringify(logs)).not.toContain(TOKEN)
  })

  test("a non-loopback endpoint is never contacted", async () => {
    for (const bad of ["http://localhost:1/mcp", "https://127.0.0.1:1/mcp", "http://127.0.0.1:1/other", "http://u:p@127.0.0.1:1/mcp", "http://127.0.0.1/mcp", "http://10.0.0.1:1/mcp", "nonsense"]) {
      expect(loopbackMcpUrl(bad)).toBeNull()
      const host = fakeHost(() => ({ ok: true }))
      const r = await createMissionControlClient({ url: bad, token: TOKEN, callerCwd: join(dir, "mc"), fetch: host.fetch }).list({ directory: "/a", sessions: ["ses_abc123"] })
      expect(r).toMatchObject({ ok: false, code: "HOST_UNAVAILABLE" })
      expect(host.calls).toHaveLength(0)
    }
  })

  test("renderer-side API (preload, channels, types) has no token, no host URL and no generic tool channel (Grep)", () => {
    const preload = readFileSync(join(import.meta.dir, "..", "..", "preload", "index.ts"), "utf8")
    const block = preload.slice(preload.indexOf("missions: {"), preload.indexOf("consumeInitialDeepLinks"))
    expect(block.length).toBeGreaterThan(100)
    const channels = readFileSync(join(import.meta.dir, "..", "..", "preload", "mission-control-channels.ts"), "utf8")
    const types = readFileSync(join(import.meta.dir, "..", "..", "preload", "types.ts"), "utf8")
    const typeBlock = types.slice(types.indexOf("// Mission control (row 127"), types.indexOf("export type LinuxDisplayBackend"))
    for (const text of [block, channels, typeBlock]) {
      expect(text).not.toMatch(/token|bearer|authorization|datum-studio\.env|127\.0\.0\.1|callTool|tools\/call/i)
    }
    expect(channels.match(/"mission-control:[a-z]+"/g)).toEqual(['"mission-control:list"', '"mission-control:get"', '"mission-control:answer"', '"mission-control:instruct"'])
    expect(preload).not.toMatch(/datum-studio-host|mission-client/)
  })
})

describe("answer id rule and session handling", () => {
  test("decision id is U<max+1> of the mission's U decisions; DECISION_ID_TAKEN re-reads and retries once", async () => {
    let answers = 0
    let decisions = [{ id: "U2" }, { id: "C7" }, { id: "U10" }]
    const host = fakeHost((name, args) => {
      if (name === "studio_mission_get") return { ok: true, tool: name, mission: { id: MISSION, decisions }, derived: {} }
      answers++
      if (answers === 1) {
        decisions = [...decisions, { id: "U11" }]
        return { ok: false, tool: name, code: "DECISION_ID_TAKEN", error: { code: "DECISION_ID_TAKEN", message: "taken", details: {} } }
      }
      return { ok: true, tool: name, decision: { id: args.decisionId }, released: [] }
    })
    const r = await client(host.fetch).answer({ mission: MISSION, request: "D-3", option: "B" })
    expect(r).toEqual({ ok: true, data: { decision: "U12", released: [] } })
    const ids = host.toolCalls().map((c) => (c.body.params as { arguments: Record<string, unknown> }).arguments.decisionId).filter(Boolean)
    expect(ids).toEqual(["U11", "U12"])
  })

  test("a second DECISION_ID_TAKEN is returned, not looped", async () => {
    const host = fakeHost((name) =>
      name === "studio_mission_get"
        ? { ok: true, tool: name, mission: { id: MISSION, decisions: [] }, derived: {} }
        : { ok: false, tool: name, code: "DECISION_ID_TAKEN", error: { code: "DECISION_ID_TAKEN", message: "taken" } },
    )
    expect(await client(host.fetch).answer({ mission: MISSION, request: "D-3", option: "B" })).toMatchObject({ ok: false, code: "DECISION_ID_TAKEN" })
    expect(host.toolCalls()).toHaveLength(4)
  })

  test("one initialize per client; session id and protocol version ride on later calls; SSE replies are read", async () => {
    const host = fakeHost((name) => ({ ok: true, tool: name, items: [] }), { sse: true })
    const c = client(host.fetch)
    await Promise.all([c.list({ directory: "/a", sessions: ["ses_abc123"] }), c.list({ directory: "/b", sessions: ["ses_abc123"] })])
    expect(host.calls.filter((x) => x.body.method === "initialize")).toHaveLength(1)
    for (const call of host.toolCalls()) {
      expect(call.headers["mcp-session-id"]).toBe("s1")
      expect(call.headers["mcp-protocol-version"]).toBe("2025-06-18")
    }
  })

  test("404 on a call re-initialises once", async () => {
    const host = fakeHost((name) => ({ ok: true, tool: name, items: [] }), { status: (n) => (n === 3 ? 404 : undefined) })
    expect(await client(host.fetch).list({ directory: "/a", sessions: ["ses_abc123"] })).toEqual({ ok: true, data: { items: [] } })
    expect(host.calls.filter((x) => x.body.method === "initialize")).toHaveLength(2)
  })

  test("401 means HOST_UNAVAILABLE; a stopped host is not contacted; a slow host times out", async () => {
    const h401 = fakeHost(() => ({ ok: true }), { status: () => 401 })
    expect(await client(h401.fetch).list({ directory: "/a", sessions: ["ses_abc123"] })).toMatchObject({ ok: false, code: "HOST_UNAVAILABLE" })
    const stopped = fakeHost(() => ({ ok: true }))
    expect(await client(stopped.fetch, { running: () => false }).list({ directory: "/a", sessions: ["ses_abc123"] })).toMatchObject({ ok: false, code: "HOST_UNAVAILABLE" })
    expect(stopped.calls).toHaveLength(0)
    const slow: FetchLike = (_u, init) =>
      new Promise((_r, reject) => init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))))
    expect(await client(slow, { timeoutMs: 50 }).list({ directory: "/a", sessions: ["ses_abc123"] })).toMatchObject({ ok: false, code: "TIMEOUT" })
  })

  test("row 136 M1: a hung tool call (SSE headers sent, body never ends) times out; the session stays usable", async () => {
    // As the MCP SDK streamable HTTP host: headers first, the tool result later (here never). The stream ignores abort.
    let hang = true
    const host = fakeHost((name) => ({ ok: true, tool: name, items: [] }))
    const fetch: FetchLike = async (u, init) => {
      const body = JSON.parse(init.body ?? "{}") as Record<string, unknown>
      if (hang && body.method === "tools/call")
        return new Response(new ReadableStream({ start() {} }), { status: 200, headers: { "content-type": "text/event-stream" } })
      return host.fetch(u, init)
    }
    const c = client(fetch, { timeoutMs: 100 })
    const t0 = Date.now()
    const r = await Promise.race([c.list({ directory: "/a", sessions: ["ses_abc123"] }), Bun.sleep(1500).then(() => "STILL_PENDING" as const)])
    expect(r).toMatchObject({ ok: false, code: "TIMEOUT" })
    expect(Date.now() - t0).toBeLessThan(1000)
    hang = false
    expect(await c.list({ directory: "/a", sessions: ["ses_abc123"] })).toEqual({ ok: true, data: { items: [] } })
  })

  test("row 136 M1: a hung initialize body also times out", async () => {
    const fetch: FetchLike = async () =>
      new Response(new ReadableStream({ start() {} }), { status: 200, headers: { "content-type": "application/json", "mcp-session-id": "s1" } })
    const r = await Promise.race([client(fetch, { timeoutMs: 100 }).list({ directory: "/a", sessions: ["ses_abc123"] }), Bun.sleep(1500).then(() => "STILL_PENDING" as const)])
    expect(r).toMatchObject({ ok: false, code: "TIMEOUT" })
  })
})
