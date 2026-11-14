// N9-128 AC-C01 (Swarm 1.2.9). Owner row 50; this file is created by contributor row 50b (S9-01 High, host session).
// Row 50b writes only the describe blocks named "row 50b"; row 50 adds its cases (a)-(e), the store sink and the hint.
//
// S9-01: "Attestation is bound to each request, not to the session id: a call on a session opened as attested counts
// as attested only when that request also carries `MISSION_CONTROL_KEY_HEADER` with the per-launch key (constant-time
// compare, as `missionControlKeyOk`) ... a request without it is handled as unattested." Plus: "The host never writes
// the session id of an attested session to any log line (`session_open`, `session_closed`, `tool_call`, ...); those
// lines carry `attested: true` and no `sessionId`." Synthetic fixtures only (syn129 naming); the key is never printed.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"

type S = any // eslint-disable-line @typescript-eslint/no-explicit-any

const PKG = path.resolve(import.meta.dir, "..", "..")
const VENDOR = path.join(PKG, "vendor")
const TEMPLATES = path.join(PKG, "templates")
const BASE = process.env.REL129_TEST_DIR ?? path.join(tmpdir(), "rel129-tests")
mkdirSync(BASE, { recursive: true })
const WORK = realpathSync(mkdtempSync(path.join(BASE, "c01-syn129-")))
const STORE = path.join(WORK, "datum-studio")
const LOG = path.join(WORK, "logs", "store.jsonl")
const HOME = path.join(WORK, "home")
const RES = path.join(WORK, "Swarm.app", "Contents", "Resources")
const PROJECT = path.join(HOME, "syn129-project")
for (const d of [HOME, RES, PROJECT]) mkdirSync(d, { recursive: true })

process.env.STUDIO_WORKSPACE_ROOT = STORE
process.env.STUDIO_ASSETS_ROOT = path.join(VENDOR, "src", "lib", "studio", "assets")
process.env.STUDIO_VENDOR_ROOT = VENDOR
delete process.env.STUDIO_MCP_FILE_ROOTS
delete process.env.INTERNAL_API_SECRET

const TOKEN = "d".repeat(16) + "0123456789abcdef".repeat(3)
const KEY = "7a".repeat(16) + "fedcba9876543210".repeat(2)
const WRONG = "0".repeat(64)
const FACTS = { home: HOME, resourcesPath: RES, execPath: path.join(WORK, "Swarm.app", "Contents", "MacOS", "Swarm") }
const HEADER = "x-swarm-mission-control-key"
const MISSION = "2026-11-14_syn129-c01-replay"
const SESSION_EVENTS = new Set(["session_open", "session_closed", "tool_call"])

let mod: S
let store: S
let host: S
const logs: Array<{ level: string; source: string; message: string; context?: Record<string, unknown> }> = []
const log = (level: string, source: string, message: string, context?: Record<string, unknown>) => logs.push({ level, source, message, context })
const clients: Client[] = []

async function client(agent: string, key?: string): Promise<{ c: Client; t: StreamableHTTPClientTransport }> {
  const c = new Client({ name: "c01-test", version: "0" })
  const t = new StreamableHTTPClientTransport(new URL(host.url), {
    requestInit: { headers: { authorization: `Bearer ${TOKEN}`, "x-studio-agent": agent, "x-studio-caller-cwd": encodeURIComponent(PROJECT), ...(key !== undefined ? { [HEADER]: key } : {}) } },
  })
  await c.connect(t)
  clients.push(c)
  return { c, t }
}
async function call(c: Client, name: string, args: S): Promise<S> {
  const r = await c.callTool({ name, arguments: args })
  return (r.structuredContent ?? {}) as S
}

/** A raw tools/call on an existing MCP session id (the replay: token + `mcp-session-id`, with or without the key). */
let rpcId = 1000
async function rawCall(sid: string, protocolVersion: string, name: string, args: S, key?: string): Promise<S> {
  const res = await fetch(host.url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-session-id": sid,
      "mcp-protocol-version": protocolVersion,
      ...(key !== undefined ? { [HEADER]: key } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method: "tools/call", params: { name, arguments: args } }),
  })
  const text = await res.text()
  expect(res.status).toBe(200)
  const sse = (res.headers.get("content-type") ?? "").includes("text/event-stream")
  const payload = sse
    ? text
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim())
        .filter((l) => l.length > 0)
        .pop()
    : text
  const msg = JSON.parse(payload ?? "{}") as S
  return (msg.result?.structuredContent ?? {}) as S
}

async function resetProcessCaches() {
  const { resetStudioEnvCache } = await import("../../vendor/src/lib/studio/contract/env")
  const { resetBridgePdfReadiness } = await import("../../vendor/src/lib/studio/services/render")
  const { resetRenderRateLimiter } = await import("../../vendor/src/lib/studio/http/render-guard")
  resetStudioEnvCache()
  resetBridgePdfReadiness()
  resetRenderRateLimiter()
}

beforeAll(async () => {
  await resetProcessCaches()
  mod = await import("../../src/mcp-host/index.ts")
  store = await mod.openHostStore(STORE, { release: "1.2.9", logFile: LOG })
  mod.configureTemplateSource({ templatesDir: TEMPLATES, assetRepoRoot: VENDOR, release: "1.2.9" })
  host = await mod.startStudioHostServer({ store, token: TOKEN, missionControlKey: KEY, hostname: "127.0.0.1", port: 0, log, facts: FACTS } as never)
})

afterAll(async () => {
  for (const c of clients) await c.close().catch(() => undefined)
  await host?.close()
  mod?.configureTemplateSource(null)
  if (store) await mod.closeHostStore(store)
  await resetProcessCaches()
})

let attestedSid = ""

describe("N9-128 AC-C01 row 50b: S9-01 per-request key (case (d), host part)", () => {
  test("a replay of the attested session id without the key (or with a wrong key) is unattested: place refused, store unchanged; with the key it places", async () => {
    const { c: mc, t: mt } = await client("swarm", KEY)
    attestedSid = mt.sessionId ?? ""
    expect(attestedSid.length).toBeGreaterThan(0)
    const pv = mt.protocolVersion ?? "2025-06-18"

    const create = await call(mc, "studio_mission_create", { mission: { id: MISSION, title: "Syn129 replay check", type: "feature-release", owner: "master-controller", project: { dir: PROJECT }, rows: [{ id: "1", phase: "implementation", kind: "implementation", title: "Row 1", agent: "coder-execution", model: { tier: "thinker" }, deps: [], size: "S", status: "pending", output: "implementation/1.md", verification: "tests pass" }] } })
    expect(create.ok).toBe(true)
    const group = path.join(PROJECT, "Syn129Group")
    mkdirSync(path.join(group, ".swarm"), { recursive: true })
    writeFileSync(path.join(group, ".swarm", "group.json"), JSON.stringify({ version: 1, name: "Syn129Group", kind: "product", created: 1_787_184_000_000 }))
    const options = [
      { id: "join", label: "Join Syn129Group", consequence: "Moves the mission into the group", group: "Syn129Group", groupKind: "product" },
      { id: "new", label: "New group Syn129New", consequence: "Creates the folder and moves the mission", group: "Syn129New", groupKind: "institution" },
      { id: "root", label: "Keep at the root", consequence: "Nothing moves" },
    ]
    const requested = await call(mc, "studio_mission_request_decision", { mission: MISSION, request: { id: "D-1", topic: "project-placement", question: "Where should this mission live?", options, recommended: "join" } })
    expect(requested.ok, JSON.stringify(requested.error)).toBe(true)
    // Flow 1 (attested answer through the desktop client, key on every request) stays attested.
    const answered = await call(mc, "studio_mission_answer_decision", { mission: MISSION, request: "D-1", option: "join", by: "user", decisionId: "U1" })
    expect(answered.ok).toBe(true)
    expect(answered.request.answer).toEqual({ option: "join", by: "user", decision: "U1", via: "swarm", attested: true })

    const args = { mission: MISSION, projectDir: group, decision: "D-1" }
    for (const [why, key] of [["replay, no key", undefined], ["replay, wrong key", WRONG], ["replay, empty key", ""]] as const) {
      const r = await rawCall(attestedSid, pv, "studio_mission_place", args, key)
      expect(r.ok, why).toBe(false)
      expect(r.code, why).toBe("SESSION_NOT_ATTESTED")
      expect(store.missions.get(MISSION)!.mission.project.dir, why).toBe(PROJECT)
    }
    expect(existsSync(path.join(group, "docs", MISSION)) || existsSync(path.join(group, MISSION))).toBe(false)

    // Same raw path WITH the key on the request: attested, the mission places (flow 2/8 still pass).
    const placed = await rawCall(attestedSid, pv, "studio_mission_place", args, KEY)
    expect(placed.ok, JSON.stringify(placed.error ?? placed.code)).toBe(true)
    expect(store.missions.get(MISSION)!.mission.project.dir).toBe(group)
  })

  test("a replayed by: user answer on the attested session id without the key is never stored as attested", async () => {
    const { c: mc, t: mt } = await client("swarm", KEY)
    const pv = mt.protocolVersion ?? "2025-06-18"
    const options = [
      { id: "A", label: "Option A", consequence: "a" },
      { id: "B", label: "Option B", consequence: "b" },
    ]
    expect((await call(mc, "studio_mission_request_decision", { mission: MISSION, request: { id: "D-2", question: "Which one?", options } })).ok).toBe(true)
    await rawCall(mt.sessionId ?? "", pv, "studio_mission_answer_decision", { mission: MISSION, request: "D-2", option: "B", by: "user", decisionId: "U2" })
    const rows = await store.transaction(async (tx: S) => tx.all("SELECT request_id, answered_attested FROM mission_decision_request WHERE mission_id = ? AND request_id = 'D-2'", [MISSION]))
    expect(rows.length).toBe(1)
    // Row 50b: recorded unattested (0); row 50 later refuses it (stays open, null). Never 1.
    expect(rows[0].answered_attested === null ? null : Number(rows[0].answered_attested)).not.toBe(1)
    // The attested client itself, key on every request, still answers attested (flow 5/6 channel).
    expect((await call(mc, "studio_mission_request_decision", { mission: MISSION, request: { id: "D-3", question: "Again?", options } })).ok).toBe(true)
    const ok = await call(mc, "studio_mission_answer_decision", { mission: MISSION, request: "D-3", option: "A", by: "user", decisionId: "U3" })
    expect(ok.ok).toBe(true)
    expect(ok.request.answer).toMatchObject({ via: "swarm", attested: true })
  })
})

describe("N9-128 AC-C01 row 50b: S9-01 no attested session id in session_open / session_closed / tool_call", () => {
  test("host lines of an attested session carry attested: true and no sessionId; its id is in none of them", async () => {
    // An unattested session for contrast (its lines keep the session id).
    const { c: plain, t: pt } = await client("claude")
    expect((await call(plain, "studio_mission_list", {})).ok).not.toBe(undefined)
    const unattestedSid = pt.sessionId ?? ""

    const lines = logs.filter((l) => SESSION_EVENTS.has(l.message))
    const attestedLines = lines.filter((l) => l.context?.attested === true)
    expect(attestedLines.filter((l) => l.message === "session_open").length).toBeGreaterThanOrEqual(2)
    expect(attestedLines.filter((l) => l.message === "tool_call").length).toBeGreaterThanOrEqual(3)
    const withId = attestedLines.filter((l) => l.context !== undefined && "sessionId" in l.context)
    expect(withId.length).toBe(0)
    expect(lines.filter((l) => JSON.stringify(l).includes(attestedSid)).length).toBe(0)
    // Contrast: the unattested session's open line keeps its id (debuggable, not a secret).
    expect(lines.some((l) => l.message === "session_open" && l.context?.sessionId === unattestedSid)).toBe(true)

    // The durable JSONL lines say the same.
    const files: string[] = []
    const walk = (d: string) => {
      for (const n of readdirSync(d)) {
        const p = path.join(d, n)
        if (statSync(p).isDirectory()) walk(p)
        else if (/\.(jsonl|log)$/.test(n)) files.push(p)
      }
    }
    walk(WORK)
    let checked = 0
    for (const f of files) {
      for (const raw of readFileSync(f, "utf8").split("\n")) {
        if (!raw.trim()) continue
        let e: S
        try {
          e = JSON.parse(raw)
        } catch {
          continue
        }
        if (!SESSION_EVENTS.has(e.message)) continue
        checked++
        if (e.context?.attested === true) expect("sessionId" in e.context).toBe(false)
        expect(raw.includes(attestedSid)).toBe(false)
      }
    }
    expect(checked).toBeGreaterThan(0)
    // The key itself is in no log call and no log file.
    expect(JSON.stringify(logs).includes(KEY)).toBe(false)
    for (const f of files) expect(readFileSync(f, "utf8").includes(KEY)).toBe(false)
  })

  test("endpoint: session_closed of an attested session carries attested: true and no sessionId", async () => {
    const { startEndpoint } = await import("../../src/mcp-host/http-server.ts")
    const epLogs: Array<Record<string, unknown>> = []
    const servers: Array<{ attested: boolean; server: Server; sessionId: string }> = []
    const ep = await startEndpoint({
      port: 0,
      token: TOKEN,
      missionControlKey: KEY,
      log: (r) => epLogs.push(r),
      openSession: ({ sessionId, attested }) => {
        const server = new Server({ name: "c01-endpoint", version: "0" }, { capabilities: {} })
        servers.push({ attested: attested === true, server, sessionId })
        return { server, close: () => server.close() }
      },
    })
    try {
      for (const key of [KEY, undefined]) {
        const c = new Client({ name: "c01-endpoint-client", version: "0" })
        await c.connect(new StreamableHTTPClientTransport(new URL(ep.url), { requestInit: { headers: { authorization: `Bearer ${TOKEN}`, "x-studio-agent": "swarm", ...(key !== undefined ? { [HEADER]: key } : {}) } } }))
      }
      expect(servers.map((s) => s.attested)).toEqual([true, false])
      for (const s of servers) await s.server.close()
      const att = servers[0]!
      const plain = servers[1]!
      const of = (event: string, attested: boolean) => epLogs.filter((r) => r.event === event && JSON.stringify(r).includes(attested ? '"attested":true' : plain.sessionId))
      for (const event of ["session_open", "session_closed"]) {
        const a = of(event, true)
        expect(a.length, event).toBe(1)
        expect("sessionId" in a[0]!, event).toBe(false)
        expect(of(event, false).length, event).toBe(1)
      }
      expect(epLogs.filter((r) => JSON.stringify(r).includes(att.sessionId)).length).toBe(0)
      expect(JSON.stringify(epLogs).includes(KEY)).toBe(false)
    } finally {
      await ep.close()
    }
  })
})
