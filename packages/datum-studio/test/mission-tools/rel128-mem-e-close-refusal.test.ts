// 1.2.8 row 39, N8-348 (AC-MEMe host half, 01e §4.3): a Swarm `done` close is refused MEMORY_INDEX_MISSING when Swarm's
// own memory lookup (`_meta["studio/memoryIndex"]`, N8-012) says the mission has no index entry; a close without a
// usable lookup succeeds with warning MEMORY_INDEX_UNCHECKED (N8-014, data.warning N8-465).
// Through the REAL host server (port 0 on 127.0.0.1: needs the command sandbox off), two clients: agent swarm and
// agent claude. The `agentId === "swarm"` trust is a compliance gate, not access control (SR8-22, R20-C05).
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

const PKG = path.resolve(import.meta.dir, "..", "..")
const VENDOR = path.join(PKG, "vendor")
const TEMPLATES = path.join(PKG, "templates")
const BASE = process.env.REL128_TEST_DIR ?? path.join(os.tmpdir(), "rel128-tests")
mkdirSync(BASE, { recursive: true })
const WORK = realpathSync(mkdtempSync(path.join(BASE, "meme-")))
const STORE = path.join(WORK, "datum-studio")
const LOG = path.join(WORK, "logs", "store.jsonl")
const HOME = path.join(WORK, "home")
const RES = path.join(WORK, "Swarm.app", "Contents", "Resources")
const PROJECT = path.join(HOME, "project-meme")
for (const d of [HOME, RES, PROJECT]) mkdirSync(d, { recursive: true })

const ENV_KEYS = ["STUDIO_WORKSPACE_ROOT", "STUDIO_ASSETS_ROOT", "STUDIO_VENDOR_ROOT", "STUDIO_MCP_FILE_ROOTS", "INTERNAL_API_SECRET"] as const
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))

const TOKEN = "f".repeat(16) + "0123456789abcdef".repeat(3)
const FACTS = { home: HOME, resourcesPath: RES, execPath: path.join(WORK, "Swarm.app", "Contents", "MacOS", "Swarm") }
const KEY = "studio/memoryIndex"
const NEXT_STEP = 'write the mission index entry first: remember {kind: "index", missionId: "<id>", text: "YYYY-MM-DD <id> | <outcome> | triggers: k1, k2 | <report path>"}, then studio_mission_set_status {to: done}'
const WARNING = "no Swarm memory check on this call; if the mission has a final report, add its index entry"
type S = Record<string, any>

type Mod = typeof import("../../src/mcp-host/index.ts")
let mod: Mod
let store: Awaited<ReturnType<Mod["openHostStore"]>>
let host: Awaited<ReturnType<Mod["startStudioHostServer"]>>
let swarm: Client
let claude: Client

async function call(c: Client, name: string, args: S, meta?: S): Promise<S & { text: string }> {
  const r = await c.callTool({ name, arguments: args, ...(meta ? { _meta: meta } : {}) })
  return { ...((r.structuredContent ?? {}) as S), text: (r.content as Array<{ text?: string }>).map((x) => x.text ?? "").join("\n") }
}
const row = (id: string) => ({ id, phase: "implementation", kind: "implementation", title: `Row ${id}`, agent: "coder-execution", model: { tier: "thinker" }, deps: [], size: "S", status: "pending", output: `implementation/${id}.md`, verification: "tests pass" })
const index = (missionId: string, present: boolean) => ({ [KEY]: { missionId, present } })
const status = async (id: string) => (await call(swarm, "studio_mission_get", { mission: id })).mission.status as string

/** A running mission; `closeRows` drops its one row so a done close passes MISSION_ROWS_OPEN. */
async function running(id: string, closeRows = true) {
  const cr = await call(swarm, "studio_mission_create", { mission: { id, title: "Rel 1.2.8 MEM-e", type: "feature-release", owner: "master-controller", project: { dir: PROJECT }, rows: [row("1")], decisions: [{ id: "U1", by: "user", date: "2026-11-14", text: "go" }] } })
  expect(cr.ok).toBe(true)
  expect((await call(swarm, "studio_mission_approve", { mission: id, decision: "U1" })).ok).toBe(true)
  expect((await call(swarm, "studio_mission_set_status", { mission: id, to: "running" })).ok).toBe(true)
  if (!closeRows) return
  const p = await call(swarm, "studio_mission_update_row", { mission: id, decision: "U1", rows: [{ id: "1", status: "dropped", note: "not needed for this check" }] })
  expect(p.ok).toBe(true)
  expect(((p.results ?? []) as S[]).every((x) => x.ok !== false)).toBe(true)
}

async function connect(name: string, agent: string): Promise<Client> {
  const c = new Client({ name, version: "1.0.0" })
  await c.connect(new StreamableHTTPClientTransport(new URL(host.url), { requestInit: { headers: { authorization: `Bearer ${TOKEN}`, "x-studio-agent": agent, "x-studio-caller-cwd": encodeURIComponent(PROJECT) } } }))
  return c
}

beforeAll(async () => {
  process.env.STUDIO_WORKSPACE_ROOT = STORE
  process.env.STUDIO_ASSETS_ROOT = path.join(VENDOR, "src", "lib", "studio", "assets")
  process.env.STUDIO_VENDOR_ROOT = VENDOR
  delete process.env.STUDIO_MCP_FILE_ROOTS
  delete process.env.INTERNAL_API_SECRET
  ;(await import("../../vendor/src/lib/studio/contract/env")).resetStudioEnvCache()
  mod = (await import("../../src/mcp-host/index.ts")) as Mod
  const log = () => undefined
  store = await mod.openHostStore(STORE, { release: "1.2.8", logFile: LOG, missionGuard: true })
  mod.configureTemplateSource({ templatesDir: TEMPLATES, assetRepoRoot: VENDOR, release: "1.2.8" })
  host = await mod.startStudioHostServer({ store, token: TOKEN, hostname: "127.0.0.1", port: 0, log, facts: FACTS, extensions: mod.missionHostExtension(store, { log, exporter: null }) })
  swarm = await connect("rel128-meme-swarm", "swarm")
  claude = await connect("rel128-meme-claude", "claude")
}, 60_000)

afterAll(async () => {
  await swarm?.close().catch(() => undefined)
  await claude?.close().catch(() => undefined)
  await host?.close()
  mod?.configureTemplateSource(null)
  if (store) await mod.closeHostStore(store)
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  ;(await import("../../vendor/src/lib/studio/contract/env")).resetStudioEnvCache()
})

describe("N8-348 MEM-e host half: the done close and the mission index entry", () => {
  test("N8-012 constant and the mission id pattern the host checks", async () => {
    const table = (await import("../../src/mcp-host/tool-table.ts")) as S
    const { MISSION_ID_PATTERN } = await import("../../src/mcp-host/mission/schemas.ts")
    expect(table.MEMORY_INDEX_META).toBe(KEY)
    const re = new RegExp(MISSION_ID_PATTERN)
    for (const id of ["2026-11-14_meme-a", "2026-11-14-x", "2026-11-14_A", "x", "2026-11-14_", `2026-11-14_${"a".repeat(81)}`, `2026-11-14_${"a".repeat(82)}`]) {
      const s = table.sessionForCall({ sessionId: "s", agentId: "swarm", fileRoot: WORK }, { [KEY]: { missionId: id, present: true } }) as S
      expect(s.memoryIndex !== undefined, id).toBe(re.test(id))
    }
  })

  test("Swarm + present:false -> MEMORY_INDEX_MISSING with the next step; mission still running, also with dryRun", async () => {
    const id = "2026-11-14_meme-missing"
    await running(id)
    for (const dryRun of [true, false]) {
      const r = await call(swarm, "studio_mission_set_status", { mission: id, to: "done", ...(dryRun ? { dryRun } : {}) }, index(id, false))
      expect(r.ok).toBe(false)
      expect(r.code).toBe("MEMORY_INDEX_MISSING")
      expect(r.text).toContain(`${NEXT_STEP} (skill: mission-control)`)
      expect(await status(id)).toBe("running")
    }
  })

  test("Swarm + present:true -> done, no warning", async () => {
    const id = "2026-11-14_meme-present"
    await running(id)
    const r = await call(swarm, "studio_mission_set_status", { mission: id, to: "done" }, index(id, true))
    expect(r.ok).toBe(true)
    expect(r.to).toBe("done")
    expect(r.warning).toBeUndefined()
    expect(r.text).not.toContain("MEMORY_INDEX_UNCHECKED")
    expect(await status(id)).toBe("done")
  })

  test("agent claude, with or without the meta -> done + data.warning MEMORY_INDEX_UNCHECKED", async () => {
    for (const [id, meta] of [
      ["2026-11-14_meme-claude-none", undefined],
      ["2026-11-14_meme-claude-meta", index("2026-11-14_meme-claude-meta", false)],
    ] as const) {
      await running(id)
      const r = await call(claude, "studio_mission_set_status", { mission: id, to: "done" }, meta)
      expect(r.ok, id).toBe(true)
      expect(r.to).toBe("done")
      expect(r.warning).toEqual({ code: "MEMORY_INDEX_UNCHECKED", message: WARNING })
      expect(r.text).toContain(`warning MEMORY_INDEX_UNCHECKED: ${WARNING}`)
      expect(await status(id)).toBe("done")
    }
  })

  test("Swarm with no meta, a malformed meta or another mission's id -> done + warning", async () => {
    const cases: Array<[string, S | undefined]> = [
      ["2026-11-14_meme-nometa", undefined],
      ["2026-11-14_meme-bad-present", { [KEY]: { missionId: "2026-11-14_meme-bad-present", present: "no" } }],
      ["2026-11-14_meme-bad-shape", { [KEY]: [false] }],
      ["2026-11-14_meme-bad-id", { [KEY]: { missionId: "not a mission", present: false } }],
      ["2026-11-14_meme-other", index("2026-11-14_meme-someone-else", false)],
    ]
    for (const [id, meta] of cases) {
      await running(id)
      const r = await call(swarm, "studio_mission_set_status", { mission: id, to: "done" }, meta)
      expect(r.ok, id).toBe(true)
      expect(r.warning?.code, id).toBe("MEMORY_INDEX_UNCHECKED")
    }
  })

  test("open rows -> MISSION_ROWS_OPEN first; a repeated done is unchanged and never checked", async () => {
    const open = "2026-11-14_meme-open"
    await running(open, false)
    const r = await call(swarm, "studio_mission_set_status", { mission: open, to: "done" }, index(open, false))
    expect(r.code).toBe("MISSION_ROWS_OPEN")

    // A no-op move (the status the mission has) is unchanged and never checked, whatever the meta says.
    const id = "2026-11-14_meme-repeat"
    await running(id)
    const same = await call(swarm, "studio_mission_set_status", { mission: id, to: "running" }, index(id, false))
    expect(same.ok).toBe(true)
    expect(same.unchanged).toBe(true)
    expect(same.warning).toBeUndefined()
    expect((await call(swarm, "studio_mission_set_status", { mission: id, to: "done" }, index(id, true))).ok).toBe(true)
    // A repeated done meets the closed mission (MISSION_CLOSED, unchanged since 1.2.6), never the memory check.
    const again = await call(swarm, "studio_mission_set_status", { mission: id, to: "done" }, index(id, false))
    expect(again.code).toBe("MISSION_CLOSED")
    expect(await status(id)).toBe("done")
  })

  test("the set_status description and the guide line 6/6 name the check", async () => {
    const t = (await swarm.listTools()).tools.find((x) => x.name === "studio_mission_set_status")!
    expect(t.description).toContain("A Swarm close is refused MEMORY_INDEX_MISSING until the project memory holds the mission's index entry; other callers get warning MEMORY_INDEX_UNCHECKED.")
    const res = await swarm.readResource({ uri: "studio://skema/mission" })
    const text = (res.contents[0] as { text: string }).text
    expect(text).toContain("Lifecycle 6/6 done: every row done or dropped (MISSION_ROWS_OPEN otherwise), the final report written and its mission index entry remembered (MEMORY_INDEX_MISSING otherwise, Swarm only), then one studio_mission_set_status {to: done}.")
  })
})
