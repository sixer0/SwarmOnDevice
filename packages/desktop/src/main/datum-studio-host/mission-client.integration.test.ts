// Row 127 integration: the mission control client against a REAL Studio host (test/datum-studio-host/mission-host.ts,
// packages/datum-studio host server, streamable HTTP on 127.0.0.1, own bun process). Needs the command sandbox off
// (binds an ephemeral port).
//
// Also C125: the host runs first with release "1.2.0", then with STUDIO_RELEASE (1.2.8) over the SAME store, as an
// upgraded app does; builtin templates must still pin and load (no TEMPLATE_BUILTIN_* line, same pinned versions).
//
// No model call: the fixture traps globalThis.fetch (FETCH_CALLED on stderr) and the four tools are store reads/writes.
import { Database } from "bun:sqlite"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync } from "node:fs"
import { join } from "node:path"
import { createMissionControlClient, type MissionControlClient } from "./mission-client"
import { STUDIO_RELEASE } from "./protocol"

const BUN = process.execPath
const FIXTURE = join(import.meta.dir, "..", "..", "..", "test", "datum-studio-host", "mission-host.ts")
const BASE = "/private/tmp/claude-501/row127/it"
mkdirSync(BASE, { recursive: true })
const WORK = realpathSync(mkdtempSync(join(BASE, "run-")))
const STORE = join(WORK, "data", "swarm", "datum-studio")
const HOME = join(WORK, "home")
const RES = join(WORK, "Swarm.app", "Contents", "Resources")
const PROJECT = join(HOME, "project-127")
const MC_CWD = join(WORK, "state", "swarm", "datum-studio-mission-control")
for (const d of [HOME, RES, PROJECT, join(WORK, "data", "swarm")]) mkdirSync(d, { recursive: true })
const M = "2026-11-07_m127-bridge"
// INTENT 1.2.7 U-1 (U2): the panel lists by session ids only; the mission is linked to this Swarm session at create.
const IT_SES = "ses_0127b0000001Row127Bridge01"
const quote = (label: string, v: unknown) => console.log(`[row127] ${label}: ${JSON.stringify(v)}`)

type Host = { child: ChildProcessWithoutNullStreams; url: string; token: string; stderr: () => string }

async function startHost(release: string): Promise<Host> {
  const child = spawn(BUN, [FIXTURE], {
    cwd: WORK,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME,
      TMPDIR: process.env.TMPDIR ?? "/private/tmp",
      HTTP_PROXY: "http://127.0.0.1:9",
      HTTPS_PROXY: "http://127.0.0.1:9",
      ALL_PROXY: "http://127.0.0.1:9",
      NO_PROXY: "127.0.0.1,localhost",
      MH_STORE: STORE,
      MH_HOME: HOME,
      MH_RES: RES,
      MH_RELEASE: release,
    },
  })
  let out = ""
  let err = ""
  child.stderr.on("data", (c: Buffer) => (err += c.toString()))
  const ready = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`host not ready: ${err.slice(-2000)}`)), 60_000)
    child.stdout.on("data", (c: Buffer) => {
      out += c.toString()
      const line = out.split("\n").find((l) => l.startsWith("READY "))
      if (line) {
        clearTimeout(timer)
        resolve(line)
      }
    })
    child.on("exit", (code) => {
      clearTimeout(timer)
      reject(new Error(`host exited ${code}: ${err.slice(-2000)}`))
    })
  })
  const [, url, token] = ready.split(" ")
  return { child, url: url!, token: token!, stderr: () => err }
}

async function stopHost(h: Host | undefined) {
  if (!h || h.child.exitCode !== null) return
  const exited = new Promise((r) => h.child.once("exit", r))
  h.child.kill("SIGTERM")
  await Promise.race([exited, new Promise((r) => setTimeout(r, 10_000))])
  if (h.child.exitCode === null) h.child.kill("SIGKILL")
}

/** Test-only raw MCP caller for the fixture set-up (agent "claude", project cwd): NOT the client under test. */
function raw(h: Host, agent = "claude", cwd = PROJECT) {
  let sid: string | undefined
  let id = 0
  const post = async (body: Record<string, unknown>) => {
    const headers: Record<string, string> = {
      authorization: `Bearer ${h.token}`,
      "x-studio-agent": agent,
      "x-studio-caller-cwd": encodeURIComponent(cwd),
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    }
    if (sid) headers["mcp-session-id"] = sid
    const r = await fetch(h.url, { method: "POST", headers, body: JSON.stringify(body) })
    if (body.method === "initialize") sid = r.headers.get("mcp-session-id") ?? undefined
    const text = await r.text()
    const data = text.includes("data:") ? text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("") : text
    return data ? (JSON.parse(data) as Record<string, any>) : {}
  }
  return async (name: string, args: Record<string, unknown>) => {
    if (!sid) {
      await post({ jsonrpc: "2.0", id: ++id, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "row127-setup", version: "0" } } })
      await post({ jsonrpc: "2.0", method: "notifications/initialized" })
    }
    const r = await post({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } })
    return (r.result?.structuredContent ?? { ok: false, rpc: r.error }) as Record<string, any>
  }
}

function row(id: string, deps: string[] = []) {
  return { id, phase: "implementation", kind: "implementation", title: `Row ${id}`, agent: "coder-execution", model: { tier: "thinker" }, deps, size: "S", status: "pending", output: `implementation/${id}.md`, verification: "tests pass", review: "gate" }
}

function templatesLog() {
  const dir = join(STORE, "logs")
  if (!existsSync(dir)) return ""
  return readdirSync(dir)
    .filter((f) => f.startsWith("datum-studio-templates"))
    .map((f) => readFileSync(join(dir, f), "utf8"))
    .join("\n")
}

function pinnedVersions() {
  const db = new Database(join(STORE, "datum-studio.sqlite"), { readonly: true })
  try {
    return db
      .query<{ slug: string; version_no: number; definition_sha256: string; provenance: string }, []>(
        "SELECT t.slug, v.version_no, v.definition_sha256, v.provenance FROM template_version v JOIN template t ON t.id = v.template_id WHERE t.origin = 'builtin' ORDER BY t.slug, v.version_no",
      )
      .all()
  } finally {
    db.close()
  }
}

let host: Host | undefined
let client: MissionControlClient
let pinnedAt120: ReturnType<typeof pinnedVersions> = []
const results: unknown[] = []
let docCreated = false

beforeAll(async () => {
  // Run 1: a store created and pinned by a 1.2.0 app.
  const old = await startHost("1.2.0")
  try {
    const t = await raw(old)("studio_templates_list", {})
    expect(t.ok).toBe(true)
  } finally {
    await stopHost(old)
  }
  pinnedAt120 = pinnedVersions()
  // Run 2: the same store under this build's STUDIO_RELEASE.
  host = await startHost(STUDIO_RELEASE)
  client = createMissionControlClient({ url: host.url, token: host.token, callerCwd: MC_CWD, running: () => host!.child.exitCode === null })
}, 180_000)

afterAll(async () => {
  await stopHost(host)
})

describe("row 127: mission bridge against the real host", () => {
  beforeAll(async () => {
    const call = raw(host!)
    const created = await call("studio_mission_create", {
      mission: { id: M, title: "Row 127 bridge mission", type: "feature-release", owner: "master-controller", project: { dir: PROJECT }, sessions: [{ client: "swarm", ref: IT_SES }], rows: [row("1"), row("2", ["1:B"])], decisions: [{ id: "U1", by: "user", date: "2026-11-07", text: "go" }] },
    })
    if (!created.ok) quote("mission create refused", created)
    expect(created.ok).toBe(true)
    expect((await call("studio_mission_approve", { mission: M, decision: "U1" })).ok).toBe(true)
    expect((await call("studio_mission_set_status", { mission: M, to: "running" })).ok).toBe(true)
    const req = await call("studio_mission_request_decision", {
      mission: M,
      request: { id: "D-1", question: "Which reviewer checks row 2?", options: [{ id: "A", label: "senior-code-reviewer", consequence: "deeper" }, { id: "B", label: "verifier", consequence: "faster" }], recommended: "A", blockingRows: ["2"] },
    })
    expect(req.ok).toBe(true)
    // A deliverable on a builtin template: proves the builtin loads under STUDIO_RELEASE (C125) and feeds G1.
    const doc = await call("studio_document_create", { template: "datum-nota", mission: M, docKey: "row-1-kajian", title: "Kajian row 127" })
    quote("document_create on builtin datum-nota", { ok: doc.ok, code: doc.code ?? null })
    docCreated = doc.ok === true
    expect(doc.ok).toBe(true)
    expect((await call("studio_mission_update_row", { mission: M, messages: [{ from: "agent", to: "controller", kind: "report", text: "row 1 started", row: "1" }] })).ok).toBe(true)
  }, 60_000)

  test("list returns the session's missions as JSON", async () => {
    const r = await client.list({ directory: PROJECT, sessions: [IT_SES] })
    results.push(r)
    quote("list", r.ok ? { items: r.data.items.map((i) => ({ id: i.id, status: i.status, activityAt: i.activityAt })) } : r)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data.items.map((i) => i.id)).toEqual([M])
    expect(r.data.items[0]).toMatchObject({ id: M, status: "running" })
    expect(await client.list({ directory: PROJECT, sessions: ["ses_0127b0000002Row127Other002"] })).toEqual({ ok: true, data: { items: [] } })
  })

  test("get returns mission, derived, requests, messages, deliverables", async () => {
    const r = await client.get({ mission: M })
    results.push(r)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    quote("get keys", { keys: Object.keys(r.data), rows: r.data.mission.rows?.length, requests: r.data.requests.map((q) => [q.id, q.status]), messages: r.data.messages.length, deliverables: r.data.deliverables.length })
    expect(Object.keys(r.data).sort()).toEqual(["deliverables", "derived", "messages", "mission", "requests"])
    expect(r.data.mission.id).toBe(M)
    expect(r.data.requests[0]).toMatchObject({ id: "D-1", status: "open" })
    expect(r.data.messages.map((m) => m.text)).toEqual(["row 1 started"])
    expect(r.data.deliverables.map((d) => [d.docKey, d.rowId, d.title])).toEqual([["row-1-kajian", "1", "Kajian row 127"]])
  })

  test("answer records U2 by user with actor mission-control; a second answer is refused", async () => {
    const r = await client.answer({ mission: M, request: "D-1", option: "B" })
    results.push(r)
    quote("answer", r)
    // released = rows the store releases now; row 2 still waits for row 1 (dep 1:B), so none here.
    expect(r).toEqual({ ok: true, data: { decision: "U2", released: [] } })
    const again = await client.answer({ mission: M, request: "D-1", option: "A" })
    results.push(again)
    expect(again).toMatchObject({ ok: false, code: "DECISION_REQUEST_CLOSED" })
    const g = await raw(host!)("studio_mission_get", { mission: M, include: ["decisions", "requests", "events"] })
    expect(g.requests[0]).toMatchObject({ status: "answered", answer: { option: "B", by: "user", decision: "U2" } })
    const actors = (g.events as Array<{ actor?: string }>).map((e) => e.actor)
    expect(actors).toContain("mission-control")
  })

  test("instruct stores an owner instruction (no row patch) and get shows it", async () => {
    const r = await client.instruct({ mission: M, text: "  Prioritise row 2  ", row: "2" })
    results.push(r)
    quote("instruct", r)
    expect(r.ok).toBe(true)
    const g = await client.get({ mission: M })
    expect(g.ok).toBe(true)
    if (!g.ok) return
    expect(g.data.messages.at(-1)).toMatchObject({ from: "owner", to: "controller", kind: "instruction", text: "Prioritise row 2", row: "2" })
    expect(g.data.mission.rows?.find((x) => x.id === "2")?.status).toBe("pending")
    const ev = await raw(host!)("studio_mission_get", { mission: M, include: ["events"] })
    // An owner instruction is a message, not an event; the newest event is the answer above, written by mission-control.
    const last = (ev.events as Array<{ actor?: string; verb?: string }>).at(-1)
    quote("last event", last)
    expect(last?.actor).toBe("mission-control")
  })

  test("a non-allow-listed tool is refused before any request; bad input never reaches the host", async () => {
    await expect(client.callTool("studio_mission_set_status", { mission: M, to: "done" })).rejects.toMatchObject({ code: "TOOL_NOT_ALLOWED" })
    await expect(client.callTool("studio_render", {})).rejects.toMatchObject({ code: "TOOL_NOT_ALLOWED" })
    expect(await client.get({ mission: "../" + M })).toMatchObject({ ok: false, code: "BAD_ARGUMENT" })
    const g = await raw(host!)("studio_mission_get", { mission: M })
    expect(g.mission.status).toBe("running")
  })

  test("no token in any result; no outbound fetch by the host (no model call); caller cwd folder is 0700", () => {
    expect(JSON.stringify(results)).not.toContain(host!.token)
    expect(host!.stderr()).not.toContain("FETCH_CALLED")
    // The only error-level host line is the tool_call record of the intended second answer (DECISION_REQUEST_CLOSED).
    const errors = host!.stderr().split("\n").filter((l) => l.startsWith("HOST_ERROR"))
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('"event":"tool_call","tool":"studio_mission_answer_decision","ok":false')
    const { statSync } = require("node:fs") as typeof import("node:fs")
    expect((statSync(MC_CWD).mode & 0o777).toString(8)).toBe("700")
  })
})

describe("C125: STUDIO_RELEASE 1.2.8 over a 1.2.0 store", () => {
  test("STUDIO_RELEASE follows the app release", () => {
    expect(STUDIO_RELEASE).toBe("1.2.8")
  })

  test("builtin templates still list and load; no TEMPLATE_BUILTIN_* line; pinned versions unchanged", async () => {
    const call = raw(host!)
    const list = await call("studio_templates_list", {})
    expect(list.ok).toBe(true)
    const items = (list.templates ?? list.items ?? []) as Array<Record<string, unknown>>
    quote("templates after upgrade", { count: items.length, slugs: items.map((t) => t.slug).slice(0, 6) })
    expect(items.length).toBeGreaterThan(0)
    // The builtin was also resolved by studio_document_create in the mission set-up (deliverable row-1-kajian).
    expect(docCreated).toBe(true)
    expect(pinnedAt120.length).toBeGreaterThan(0)
    const now = pinnedVersions()
    expect(now.map((v) => [v.slug, v.version_no, v.definition_sha256])).toEqual(pinnedAt120.map((v) => [v.slug, v.version_no, v.definition_sha256]))
    expect(new Set(now.map((v) => (JSON.parse(v.provenance) as { release: string }).release))).toEqual(new Set(["1.2.0"]))
    const log = templatesLog()
    expect(log).not.toMatch(/TEMPLATE_BUILTIN_[A-Z_]+/)
    expect(log).not.toMatch(/TEMPLATE_SKELETON_SHA_MISMATCH/)
    quote("builtin pins (slug count, versions)", { slugs: new Set(now.map((v) => v.slug)).size, versions: now.length, templatesLogBytes: log.length })
  })
})
