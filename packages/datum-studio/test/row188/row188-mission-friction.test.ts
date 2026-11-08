// Row 188 (decision L47): the three refusals of the user's session 'Mandatory Workflow Rules', before -> after.
// (1) studio_mission_create SCHEMA_INVALID at session/ref (the agent invented a Swarm session id):
//     after, a ref the store would refuse is never a refusal; the host links the calling session (per-call
//     _meta "studio/callerSession" or the X-Studio-Caller-Session header) or skips the link, and says so.
// (2) studio_mission_update_row MISSION_NOT_APPROVED (row started before approval): still refused, and the refusal
//     names the next correct call (request a decision, or the autonomous path) and the skill mission-control.
// (3) studio_mission_approve APPROVAL_NEEDS_USER_DECISION after a controller decision: an autonomous controller
//     decision (autonomous: true) now approves, recorded as by: controller + autonomous and labelled
//     'self-approved (autonomous)'; a plain controller decision is still refused; autonomous with by: user is invalid.
// Plus: every mission refusal ends with "next: ... (skill: mission-control)"; the guide has the 6-line lifecycle.
// Through the REAL host server (port 0 on 127.0.0.1: needs the command sandbox off), like rows 119b and 169.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

const PKG = path.resolve(import.meta.dir, "..", "..")
const VENDOR = path.join(PKG, "vendor")
const TEMPLATES = path.join(PKG, "templates")
const BASE = process.env.ROW188_TEST_DIR ?? path.join(os.tmpdir(), "row188-tests")
mkdirSync(BASE, { recursive: true })
const WORK = realpathSync(mkdtempSync(path.join(BASE, "row188-")))
const STORE = path.join(WORK, "datum-studio")
const LOG = path.join(WORK, "logs", "store.jsonl")
const HOME = path.join(WORK, "home")
const RES = path.join(WORK, "Swarm.app", "Contents", "Resources")
const PROJECT = path.join(HOME, "work", "clients", "project-a")
for (const d of [HOME, RES, PROJECT]) mkdirSync(d, { recursive: true })

process.env.STUDIO_WORKSPACE_ROOT = STORE
process.env.STUDIO_ASSETS_ROOT = path.join(VENDOR, "src", "lib", "studio", "assets")
process.env.STUDIO_VENDOR_ROOT = VENDOR
delete process.env.STUDIO_MCP_FILE_ROOTS
delete process.env.INTERNAL_API_SECRET

const TOKEN = "e".repeat(16) + "0123456789abcdef".repeat(3)
const FACTS = { home: HOME, resourcesPath: RES, execPath: path.join(WORK, "Swarm.app", "Contents", "MacOS", "Swarm") }
const SES_META = "ses_0123456789abABCDEFGHIJ0123" // a well-formed Swarm session id (30 characters)
const SES_HEADER = "ses_abcdef012345ZYXWVUTSRQ9876"
type S = Record<string, any>

type Mod = typeof import("../../src/mcp-host/index.ts")
let mod: Mod
let store: Awaited<ReturnType<Mod["openHostStore"]>>
let host: Awaited<ReturnType<Mod["startStudioHostServer"]>>
let swarm: Client
let swarmWithHeader: Client

async function client(url: string, agent: string, extra: Record<string, string> = {}): Promise<Client> {
  const c = new Client({ name: `row188-${agent}`, version: "1.0.0" })
  await c.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${TOKEN}`, "x-studio-agent": agent, "x-studio-caller-cwd": encodeURIComponent(PROJECT), ...extra } } }))
  return c
}
async function call(name: string, args: S, opts: { c?: Client; meta?: S } = {}): Promise<S & { text: string }> {
  const r = await (opts.c ?? swarm).callTool({ name, arguments: args, ...(opts.meta ? { _meta: opts.meta } : {}) })
  return { ...(r.structuredContent as S), text: (r.content as Array<{ text: string }>).map((c) => c.text).join("\n") }
}
const row = (id: string, over: S = {}) => ({ id, phase: "implementation", kind: "implementation", title: `Row ${id}`, agent: "coder-execution", model: { tier: "thinker" }, deps: [], size: "S", status: "pending", output: `implementation/${id}.md`, verification: "tests pass", ...over })
const mission = (id: string, over: S = {}) => ({ id, title: "Row 188", type: "feature-release", owner: "master-controller", project: { dir: PROJECT }, rows: [row("1"), row("2")], ...over })
const sessionsOf = async (id: string) => ((await call("studio_mission_get", { mission: id })).mission.sessions as S[]).map((s) => `${s.client}:${s.ref}`)

function expectNext(r: S, ...parts: string[]): void {
  expect(r.ok).toBe(false)
  expect(typeof r.next).toBe("string")
  expect(r.next.endsWith("(skill: mission-control)")).toBe(true)
  expect(r.error.skill).toBe("mission-control")
  expect(r.text.trim().split("\n").at(-1)).toBe(`next: ${r.next}`)
  for (const p of parts) expect(r.next).toContain(p)
}

beforeAll(async () => {
  mod = (await import("../../src/mcp-host/index.ts")) as Mod
  const log = () => undefined
  store = await mod.openHostStore(STORE, { release: "1.2.3", logFile: LOG, missionGuard: true })
  mod.configureTemplateSource({ templatesDir: TEMPLATES, assetRepoRoot: VENDOR, release: "1.2.3" })
  host = await mod.startStudioHostServer({ store, token: TOKEN, hostname: "127.0.0.1", port: 0, log, facts: FACTS, extensions: mod.missionHostExtension(store, { log, exporter: null }) })
  swarm = await client(host.url, "swarm")
  swarmWithHeader = await client(host.url, "swarm", { "x-studio-caller-session": SES_HEADER })
})

afterAll(async () => {
  await swarm?.close().catch(() => undefined)
  await swarmWithHeader?.close().catch(() => undefined)
  await host?.close()
  mod?.configureTemplateSource(null)
  if (store) await mod.closeHostStore(store)
})

describe("row 188 (1): the session link is the host's job", () => {
  test("before: an invented ref was SCHEMA_INVALID; after: it is replaced by the calling session (_meta) and noted", async () => {
    const r = await call("studio_mission_create", { mission: mission("2026-11-08_r188-meta"), session: { ref: "ses_invented_by_the_agent" } }, { meta: { "studio/callerSession": SES_META } })
    expect(r.ok).toBe(true)
    expect(r.sessionNotes.join(" ")).toContain("omit session; Swarm fills it")
    expect(await sessionsOf("2026-11-08_r188-meta")).toEqual([`swarm:${SES_META}`])
  })

  test("omitted session: filled from _meta, else from the X-Studio-Caller-Session header, else no link and no refusal", async () => {
    expect((await call("studio_mission_create", { mission: mission("2026-11-08_r188-omit-meta") }, { meta: { "studio/callerSession": SES_META } })).ok).toBe(true)
    expect(await sessionsOf("2026-11-08_r188-omit-meta")).toEqual([`swarm:${SES_META}`])
    expect((await call("studio_mission_create", { mission: mission("2026-11-08_r188-omit-header") }, { c: swarmWithHeader })).ok).toBe(true)
    expect(await sessionsOf("2026-11-08_r188-omit-header")).toEqual([`swarm:${SES_HEADER}`])
    const none = await call("studio_mission_create", { mission: mission("2026-11-08_r188-omit-none") })
    expect(none.ok).toBe(true)
    expect(await sessionsOf("2026-11-08_r188-omit-none")).toEqual([])
  })

  test("an invented ref with no known calling session: no refusal, no link, a note telling the agent to omit session", async () => {
    const r = await call("studio_mission_create", { mission: mission("2026-11-08_r188-invented"), session: { ref: "ses_invented" } })
    expect(r.ok).toBe(true)
    expect(r.text).toContain("omit session; Swarm fills it")
    expect(await sessionsOf("2026-11-08_r188-invented")).toEqual([])
  })

  test("an invented ref inside mission.sessions is replaced by the calling session; a valid explicit ref is kept", async () => {
    const r = await call("studio_mission_create", { mission: mission("2026-11-08_r188-doc", { sessions: [{ client: "swarm", ref: "my-session" }] }) }, { c: swarmWithHeader })
    expect(r.ok).toBe(true)
    expect(await sessionsOf("2026-11-08_r188-doc")).toEqual([`swarm:${SES_HEADER}`])
    const k = await call("studio_mission_create", { mission: mission("2026-11-08_r188-valid"), session: { ref: SES_META } }, { c: swarmWithHeader })
    expect(k.ok).toBe(true)
    expect(k.sessionNotes).toBeUndefined()
    expect(await sessionsOf("2026-11-08_r188-valid")).toEqual([`swarm:${SES_META}`])
  })

  test("the client lock stays: another agent's client is still AGENT_ID_LOCKED, with the next call", async () => {
    const r = await call("studio_mission_create", { mission: mission("2026-11-08_r188-lock"), session: { client: "claude", ref: "abc" } })
    expect(r.code).toBe("AGENT_ID_LOCKED")
    expectNext(r, "omit session")
  })
})

describe("row 188 (2): a row before approval is still refused, and the refusal names the next call", () => {
  test("MISSION_NOT_APPROVED ends with request_decision / autonomous record_decision + approve, skill mission-control", async () => {
    await call("studio_mission_create", { mission: mission("2026-11-08_r188-draft") })
    const r = await call("studio_mission_update_row", { mission: "2026-11-08_r188-draft", rows: [{ id: "1", status: "running" }] })
    expect(r.code).toBe("MISSION_NOT_APPROVED")
    expectNext(r, "studio_mission_request_decision", "autonomous: true", "studio_mission_approve")
  })
})

describe("row 188 (3): the honest autonomous approval path", () => {
  const id = "2026-11-08_r188-approve"
  test("a plain controller decision is still refused (APPROVAL_NEEDS_USER_DECISION) and never told to record by: user", async () => {
    await call("studio_mission_create", { mission: mission(id) })
    expect((await call("studio_mission_record_decision", { mission: id, decision: { id: "C1", by: "controller", date: "2026-11-08", text: "blueprint ok" } })).ok).toBe(true)
    const r = await call("studio_mission_approve", { mission: id, decision: "C1" })
    expect(r.code).toBe("APPROVAL_NEEDS_USER_DECISION")
    expectNext(r, "autonomous: true", "never record by: user")
  })

  test("autonomous: true is only valid with by: controller", async () => {
    const r = await call("studio_mission_record_decision", { mission: id, decision: { id: "U1", by: "user", autonomous: true, date: "2026-11-08", text: "x" } })
    expect(r.code).toBe("SCHEMA_INVALID")
    expectNext(r)
  })

  test("a controller decision marked autonomous approves; recorded as by: controller + autonomous, labelled self-approved", async () => {
    // Row 197 (S194-01): only with Swarm's autonomous mode mark in _meta (row197 test covers the refusals).
    const auto = { meta: { "studio/autonomous": true } }
    expect((await call("studio_mission_record_decision", { mission: id, decision: { id: "C2", by: "controller", autonomous: true, date: "2026-11-08", text: "autonomous mode: blueprint self-approved (L19)" } }, auto)).ok).toBe(true)
    const a = await call("studio_mission_approve", { mission: id, decision: "C2" }, auto)
    expect(a.ok).toBe(true)
    expect(a.text).toContain("self-approved (autonomous)")
    expect(a.approval).toEqual({ decision: "C2", by: "controller", autonomous: true, label: "self-approved (autonomous)" })
    const g = await call("studio_mission_get", { mission: id, include: ["decisions", "events"] })
    expect(g.mission.approvalDecision).toBe("C2")
    expect(g.derived.approval.label).toBe("self-approved (autonomous)")
    const c2 = (g.mission.decisions as S[]).find((d) => d.id === "C2")!
    expect(c2.by).toBe("controller")
    expect(c2.autonomous).toBe(true)
    expect((g.mission.decisions as S[]).find((d) => d.id === "C1")!.autonomous).toBeUndefined()
    const ev = (g.events as S[]).find((e) => e.verb === "approve")!
    expect(JSON.stringify(ev)).toContain("autonomous")
    // the lifecycle continues: running, then rows
    expect((await call("studio_mission_set_status", { mission: id, to: "running" })).ok).toBe(true)
    expect((await call("studio_mission_update_row", { mission: id, rows: [{ id: "1", status: "running" }] })).ok).toBe(true)
  })

  test("a user decision still approves and is labelled approved (decision by: user)", async () => {
    const u = "2026-11-08_r188-user"
    await call("studio_mission_create", { mission: mission(u), })
    await call("studio_mission_record_decision", { mission: u, decision: { id: "U1", by: "user", date: "2026-11-08", text: "approved" } })
    const a = await call("studio_mission_approve", { mission: u, decision: "U1" })
    expect(a.ok).toBe(true)
    expect(a.approval.label).toBe("approved (decision by: user)")
  })
})

describe("row 188 (c, d): every refusal names the next call; the guide has the lifecycle", () => {
  test("MISSION_NOT_FOUND, MISSION_EMPTY, DECISION_UNKNOWN, STATUS_TRANSITION all end with next ... (skill: mission-control)", async () => {
    expectNext(await call("studio_mission_get", { mission: "2026-11-08_nope" }), "studio_mission_list")
    await call("studio_mission_create", { mission: mission("2026-11-08_r188-empty", { rows: [row("1", { status: "dropped", note: "n/a" })] }) })
    expectNext(await call("studio_mission_record_decision", { mission: "2026-11-08_r188-empty", decision: { id: "C1", by: "controller", autonomous: true, date: "2026-11-08", text: "x" } }).then(() => call("studio_mission_approve", { mission: "2026-11-08_r188-empty", decision: "C1" })), "add rows")
    expectNext(await call("studio_mission_approve", { mission: "2026-11-08_r188-draft", decision: "C9" }), "studio_mission_record_decision")
    expectNext(await call("studio_mission_set_status", { mission: "2026-11-08_r188-draft", to: "done" }), "lifecycle")
  })

  test("the mission guide resource carries the 6-line lifecycle in order", async () => {
    const res = await swarm.readResource({ uri: "studio://skema/mission" })
    const text = (res.contents[0] as { text: string }).text
    const lines = text.split("\n").filter((l) => l.startsWith("Lifecycle "))
    expect(lines.length).toBe(6)
    expect(lines.map((l) => l.slice(10, 13))).toEqual(["1/6", "2/6", "3/6", "4/6", "5/6", "6/6"])
    expect(lines.join(" ")).toContain("dryRun: true")
    expect(lines.join(" ")).toContain("mission-control")
    expect(lines.join(" ")).toContain("Never record by: user yourself")
  })
})
