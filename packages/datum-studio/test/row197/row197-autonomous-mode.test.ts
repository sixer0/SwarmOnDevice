// Row 197 (decision L57, security finding S194-01/S194-02): a self-approval is bound to Swarm's real autonomous mode.
// Before: studio_mission_record_decision accepted `autonomous: true` from any client in any session, and approve took
// any decision so marked; the condition "only in autonomous mode" lived in prompt text only (row 194 E2/E5).
// After: the host accepts `autonomous: true` (record_decision, create's decisions) and approves under such a decision
// only when the call's `_meta["studio/autonomous"]` is exactly `true` and the agent is `swarm`. Swarm sets that mark from
// its own mode setting; the model controls `arguments` only. Otherwise: AUTONOMOUS_MODE_OFF, with a next call that says
// to ask the person in Mission Control. The label of a user decision no longer claims more than the store knows.
// Through the REAL host server (port 0 on 127.0.0.1: needs the command sandbox off), like row 188.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

const PKG = path.resolve(import.meta.dir, "..", "..")
const VENDOR = path.join(PKG, "vendor")
const TEMPLATES = path.join(PKG, "templates")
const BASE = process.env.ROW197_TEST_DIR ?? path.join(os.tmpdir(), "row197-tests")
mkdirSync(BASE, { recursive: true })
const WORK = realpathSync(mkdtempSync(path.join(BASE, "row197-")))
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

const TOKEN = "f".repeat(16) + "0123456789abcdef".repeat(3)
const FACTS = { home: HOME, resourcesPath: RES, execPath: path.join(WORK, "Swarm.app", "Contents", "MacOS", "Swarm") }
const AUTO = { "studio/autonomous": true }
type S = Record<string, any>

type Mod = typeof import("../../src/mcp-host/index.ts")
let mod: Mod
let store: Awaited<ReturnType<Mod["openHostStore"]>>
let host: Awaited<ReturnType<Mod["startStudioHostServer"]>>
let swarm: Client
let claude: Client

async function client(url: string, agent: string): Promise<Client> {
  const c = new Client({ name: `row197-${agent}`, version: "1.0.0" })
  await c.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${TOKEN}`, "x-studio-agent": agent, "x-studio-caller-cwd": encodeURIComponent(PROJECT) } } }))
  return c
}
async function call(name: string, args: S, opts: { c?: Client; meta?: S } = {}): Promise<S & { text: string }> {
  const r = await (opts.c ?? swarm).callTool({ name, arguments: args, ...(opts.meta ? { _meta: opts.meta } : {}) })
  return { ...(r.structuredContent as S), text: (r.content as Array<{ text: string }>).map((c) => c.text).join("\n") }
}
const row = (id: string) => ({ id, phase: "implementation", kind: "implementation", title: `Row ${id}`, agent: "coder-execution", model: { tier: "thinker" }, deps: [], size: "S", status: "pending", output: `implementation/${id}.md`, verification: "tests pass" })
const mission = (id: string, over: S = {}) => ({ id, title: "Row 197", type: "feature-release", owner: "master-controller", project: { dir: PROJECT }, rows: [row("1")], ...over })
const selfDecision = (id: string) => ({ id, by: "controller", autonomous: true, date: "2026-11-08", text: "blueprint self-approved" })

function expectModeOff(r: S): void {
  expect(r.ok).toBe(false)
  expect(r.code).toBe("AUTONOMOUS_MODE_OFF")
  expect(r.error.message).toContain("the person turns it on")
  expect(r.next).toContain("ask the person in Mission Control")
  expect(r.next).toContain("studio_mission_request_decision")
  expect(r.next).not.toMatch(/record .*by: user(?! yourself)/)
  expect(r.next.endsWith("(skill: mission-control)")).toBe(true)
}

beforeAll(async () => {
  mod = (await import("../../src/mcp-host/index.ts")) as Mod
  const log = () => undefined
  store = await mod.openHostStore(STORE, { release: "1.2.3", logFile: LOG, missionGuard: true })
  mod.configureTemplateSource({ templatesDir: TEMPLATES, assetRepoRoot: VENDOR, release: "1.2.3" })
  host = await mod.startStudioHostServer({ store, token: TOKEN, hostname: "127.0.0.1", port: 0, log, facts: FACTS, extensions: mod.missionHostExtension(store, { log, exporter: null }) })
  swarm = await client(host.url, "swarm")
  claude = await client(host.url, "claude")
})

afterAll(async () => {
  await swarm?.close().catch(() => undefined)
  await claude?.close().catch(() => undefined)
  await host?.close()
  mod?.configureTemplateSource(null)
  if (store) await mod.closeHostStore(store)
})

describe("row 197 (S194-01): autonomous: true needs Swarm's autonomous mode mark", () => {
  test("a forged autonomous: true without the mark is refused AUTONOMOUS_MODE_OFF, and nothing is written", async () => {
    const id = "2026-11-08_r197-forged"
    expect((await call("studio_mission_create", { mission: mission(id) })).ok).toBe(true)
    expectModeOff(await call("studio_mission_record_decision", { mission: id, decision: selfDecision("C1") }))
    const g = await call("studio_mission_get", { mission: id, include: ["decisions"] })
    expect(g.mission.decisions ?? []).toEqual([])
    expect(g.mission.status).toBe("draft")
  })

  test("a mark that is not exactly true counts as off (string, 1, nested)", async () => {
    const id = "2026-11-08_r197-shape"
    await call("studio_mission_create", { mission: mission(id) })
    for (const meta of [{ "studio/autonomous": "true" }, { "studio/autonomous": 1 }, { studio: { autonomous: true } }]) {
      expectModeOff(await call("studio_mission_record_decision", { mission: id, decision: selfDecision("C1") }, { meta }))
    }
  })

  test("a model-written argument cannot stand in for the mark", async () => {
    const id = "2026-11-08_r197-args"
    await call("studio_mission_create", { mission: mission(id) })
    const r = await call("studio_mission_record_decision", { mission: id, decision: selfDecision("C1"), _meta: AUTO, "studio/autonomous": true })
    expect(r.ok).toBe(false)
    expect(["AUTONOMOUS_MODE_OFF", "SCHEMA_INVALID"]).toContain(r.code)
  })

  test("create cannot smuggle an autonomous decision in mission.decisions without the mark", async () => {
    expectModeOff(await call("studio_mission_create", { mission: mission("2026-11-08_r197-create", { decisions: [selfDecision("C1")] }) }))
    expect((await call("studio_mission_get", { mission: "2026-11-08_r197-create" })).code).toBe("MISSION_NOT_FOUND")
  })

  test("with the mark: record and approve pass, labelled self-approved (autonomous)", async () => {
    const id = "2026-11-08_r197-on"
    await call("studio_mission_create", { mission: mission(id) })
    expect((await call("studio_mission_record_decision", { mission: id, decision: selfDecision("C1") }, { meta: AUTO })).ok).toBe(true)
    const a = await call("studio_mission_approve", { mission: id, decision: "C1" }, { meta: AUTO })
    expect(a.ok).toBe(true)
    expect(a.approval).toEqual({ decision: "C1", by: "controller", autonomous: true, label: "self-approved (autonomous)" })
  })

  test("mode switched off between the decision and the approval: approve is refused AUTONOMOUS_MODE_OFF", async () => {
    const id = "2026-11-08_r197-switched-off"
    await call("studio_mission_create", { mission: mission(id) })
    expect((await call("studio_mission_record_decision", { mission: id, decision: selfDecision("C1") }, { meta: AUTO })).ok).toBe(true)
    expectModeOff(await call("studio_mission_approve", { mission: id, decision: "C1" }))
    expect((await call("studio_mission_get", { mission: id })).mission.status).toBe("draft")
    // the mark of one call never carries into the next
    expect((await call("studio_mission_approve", { mission: id, decision: "C1" }, { meta: AUTO })).ok).toBe(true)
  })

  test("agent claude is refused even with the mark (the mode is Swarm's)", async () => {
    const id = "2026-11-08_r197-claude"
    expect((await call("studio_mission_create", { mission: mission(id) }, { c: claude })).ok).toBe(true)
    expectModeOff(await call("studio_mission_record_decision", { mission: id, decision: selfDecision("C1") }, { c: claude, meta: AUTO }))
  })

  test("a dry run is judged the same way", async () => {
    const id = "2026-11-08_r197-dry"
    await call("studio_mission_create", { mission: mission(id) })
    expectModeOff(await call("studio_mission_record_decision", { mission: id, decision: selfDecision("C1"), dryRun: true }))
  })

  test("decisions without autonomous are untouched by the mode (user approval path still works without the mark)", async () => {
    const id = "2026-11-08_r197-user"
    await call("studio_mission_create", { mission: mission(id) })
    expect((await call("studio_mission_record_decision", { mission: id, decision: { id: "U1", by: "user", date: "2026-11-08", text: "ok" } })).ok).toBe(true)
    const a = await call("studio_mission_approve", { mission: id, decision: "U1" })
    expect(a.ok).toBe(true)
    // S194-02: the label says what the record says, not who pressed the button
    expect(a.approval.label).toBe("approved (decision by: user)")
  })
})

describe("row 197: the hints name the setting, not 'the person said'", () => {
  test("MISSION_NOT_APPROVED names Swarm's autonomous mode setting", async () => {
    const id = "2026-11-08_r197-hint"
    await call("studio_mission_create", { mission: mission(id) })
    const r = await call("studio_mission_update_row", { mission: id, rows: [{ id: "1", status: "running" }] })
    expect(r.code).toBe("MISSION_NOT_APPROVED")
    expect(r.next).toContain("Swarm's autonomous mode setting is on (the person turns it on)")
  })
})
