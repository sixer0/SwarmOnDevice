// 1.2.8 row 45b, N8-484 (AC-SEC05, SR8-05; names N8-459, N8-460, N8-461; decision C14, C35).
// The Studio host accepts the per-launch Mission Control key (startStudioHostServer option `missionControlKey`, sent by
// the desktop mission client at initialize as `x-swarm-mission-control-key`) and marks that MCP session attested on a
// timing-safe match. `studio_mission_place` from any other session -> SESSION_NOT_ATTESTED. Every decision answer the
// host records stores `via` (the session's agent id) and `attested` (store migration 0008 columns `answered_via`,
// `answered_attested`), returned by `studio_mission_get`; an unattested by: "user" answer is recorded, not refused
// (1.2.9 backlog). Migration 0008 also moves row 45's `$request` topic/proposal into their own columns.
// Real store in a mkdtemp folder, real endpoint on 127.0.0.1 (ephemeral port), real MCP SDK client. Synthetic input only.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import type { StudioHostModule } from "../../../desktop/src/main/datum-studio-host/protocol.ts"

type S = Record<string, any>
const PKG = path.resolve(import.meta.dir, "..", "..")
const VENDOR = path.join(PKG, "vendor")
const TEMPLATES = path.join(PKG, "templates")
const BASE = process.env.REL128_TEST_DIR ?? path.join(tmpdir(), "rel128-tests")
mkdirSync(BASE, { recursive: true })
const WORK = realpathSync(mkdtempSync(path.join(BASE, "sec05-")))
const STORE = path.join(WORK, "datum-studio")
const LOG = path.join(WORK, "logs", "store.jsonl")
const HOME = path.join(WORK, "home")
const RES = path.join(WORK, "Swarm.app", "Contents", "Resources")
const PROJECT = path.join(HOME, "project-a")
for (const d of [HOME, RES, PROJECT]) mkdirSync(d, { recursive: true })

process.env.STUDIO_WORKSPACE_ROOT = STORE
process.env.STUDIO_ASSETS_ROOT = path.join(VENDOR, "src", "lib", "studio", "assets")
process.env.STUDIO_VENDOR_ROOT = VENDOR
delete process.env.STUDIO_MCP_FILE_ROOTS
delete process.env.INTERNAL_API_SECRET

const TOKEN = "c".repeat(16) + "0123456789abcdef".repeat(3)
const KEY = "5e".repeat(16) + "0123456789abcdef".repeat(2)
const FACTS = { home: HOME, resourcesPath: RES, execPath: path.join(WORK, "Swarm.app", "Contents", "MacOS", "Swarm") }
const HEADER = "x-swarm-mission-control-key"
const MISSION = "2026-11-14_sec05-place"

let mod: StudioHostModule & typeof import("../../src/mcp-host/index.ts")
let store: import("../../src/store/index.ts").SqliteStudioStore
let host: Awaited<ReturnType<typeof import("../../src/mcp-host/index.ts").startStudioHostServer>>
const logs: unknown[] = []
const log = (level: string, source: string, message: string, context?: Record<string, unknown>) => logs.push({ level, source, message, context })
const clients: Client[] = []

async function client(agent: string, key?: string): Promise<Client> {
  const c = new Client({ name: "sec05-test", version: "0" })
  const t = new StreamableHTTPClientTransport(new URL(host.url), {
    requestInit: { headers: { authorization: `Bearer ${TOKEN}`, "x-studio-agent": agent, "x-studio-caller-cwd": encodeURIComponent(PROJECT), ...(key !== undefined ? { [HEADER]: key } : {}) } },
  })
  await c.connect(t)
  clients.push(c)
  return c
}
async function call(c: Client, name: string, args: S, meta?: S): Promise<S> {
  const r = await c.callTool({ name, arguments: args, ...(meta ? { _meta: meta } : {}) })
  return (r.structuredContent ?? {}) as S
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
  mod = (await import("../../src/mcp-host/index.ts")) as typeof mod
  store = (await mod.openHostStore(STORE, { release: "1.2.8", logFile: LOG })) as typeof store
  mod.configureTemplateSource({ templatesDir: TEMPLATES, assetRepoRoot: VENDOR, release: "1.2.8" })
  host = (await mod.startStudioHostServer({ store, token: TOKEN, missionControlKey: KEY, hostname: "127.0.0.1", port: 0, log, facts: FACTS } as never)) as typeof host
})

afterAll(async () => {
  for (const c of clients) await c.close().catch(() => undefined)
  await host?.close()
  mod?.configureTemplateSource(null)
  if (store) await mod.closeHostStore(store)
  await resetProcessCaches()
})

describe("N8-484 SEC05: attested Mission Control session and answer provenance", () => {
  test("names: header const N8-459, SESSION_NOT_ATTESTED next step; a malformed or token-equal key is a config error", async () => {
    const http = (await import("../../src/mcp-host/http-server.ts")) as S
    expect(http.MISSION_CONTROL_KEY_HEADER).toBe(HEADER)
    expect(http.missionControlKeyOk(KEY, KEY)).toBe(true)
    for (const [h, k] of [[undefined, KEY], ["", KEY], [KEY.slice(1), KEY], [KEY.toUpperCase(), KEY], [[KEY, KEY], KEY], [KEY, undefined], [KEY, ""]] as const) {
      expect(http.missionControlKeyOk(h, k)).toBe(false)
    }
    const { nextCall } = await import("../../src/mcp-host/mission/next-call.ts")
    expect(nextCall("SESSION_NOT_ATTESTED")).toContain("agents never move a mission")
    for (const bad of ["short", KEY.toUpperCase(), TOKEN, 42]) {
      let code = ""
      try {
        await mod.startStudioHostServer({ store, token: TOKEN, missionControlKey: bad, hostname: "127.0.0.1", port: 0, log, facts: FACTS } as never)
      } catch (e) {
        code = (e as { code?: string }).code ?? ""
      }
      expect(code, String(bad)).toBe("CONFIG_INVALID")
    }
  })

  test("place: no key, a wrong key, another agent or _meta cannot attest -> SESSION_NOT_ATTESTED; the Mission Control key places", async () => {
    const mc = await client("swarm", KEY)
    const create = await call(mc, "studio_mission_create", { mission: { id: MISSION, title: "Lumen sensor rollout", type: "feature-release", owner: "master-controller", project: { dir: PROJECT }, rows: [{ id: "1", phase: "implementation", kind: "implementation", title: "Row 1", agent: "coder-execution", model: { tier: "thinker" }, deps: [], size: "S", status: "pending", output: "implementation/1.md", verification: "tests pass" }] } })
    expect(create.ok).toBe(true)
    mkdirSync(path.join(PROJECT, "Lumen", ".swarm"), { recursive: true })
    writeFileSync(path.join(PROJECT, "Lumen", ".swarm", "group.json"), JSON.stringify({ version: 1, name: "Lumen", kind: "product", created: 1_787_184_000_000 }))
    const options = [
      { id: "join", label: "Join Lumen", consequence: "Moves the mission into the group", group: "Lumen", groupKind: "product" },
      { id: "new", label: "New group Kemenkeu", consequence: "Creates the folder and moves the mission", group: "Kemenkeu", groupKind: "institution" },
      { id: "root", label: "Keep at the root", consequence: "Nothing moves" },
    ]
    const requested = await call(mc, "studio_mission_request_decision", { mission: MISSION, request: { id: "D-1", topic: "project-placement", question: "Where should this mission live?", options, recommended: "join" } })
    expect(requested.ok, JSON.stringify(requested.error)).toBe(true)
    const answered = await call(mc, "studio_mission_answer_decision", { mission: MISSION, request: "D-1", option: "join", by: "user", decisionId: "U1" })
    expect(answered.ok).toBe(true)
    expect(answered.request.answer).toEqual({ option: "join", by: "user", decision: "U1", via: "swarm", attested: true })

    const lumen = path.join(PROJECT, "Lumen")
    const args = { mission: MISSION, projectDir: lumen, decision: "D-1" }
    const tries: Array<[string, Client, S | undefined]> = [
      ["swarm, no key", await client("swarm"), undefined],
      ["swarm, wrong key", await client("swarm", "0".repeat(64)), undefined],
      ["swarm, empty key", await client("swarm", ""), undefined],
      ["claude, no key", await client("claude"), undefined],
      ["swarm, _meta claims", await client("swarm"), { "studio/attested": true, attested: true, "studio/missionControlKey": KEY }],
    ]
    for (const [why, c, meta] of tries) {
      const r = await call(c, "studio_mission_place", args, meta)
      expect(r.ok, why).toBe(false)
      expect(r.code, why).toBe("SESSION_NOT_ATTESTED")
    }
    expect(store.missions.get(MISSION)!.mission.project.dir).toBe(PROJECT)
    const placed = await call(mc, "studio_mission_place", args)
    expect(placed.ok).toBe(true)
    expect(placed.to).toBe(lumen)
    expect(store.missions.get(MISSION)!.mission.project.dir).toBe(lumen)
  })

  test("an unattested by: user answer is recorded (not refused) with via and attested: false; studio_mission_get returns both", async () => {
    const agent = await client("claude")
    const options = [
      { id: "A", label: "Option A", consequence: "a" },
      { id: "B", label: "Option B", consequence: "b" },
    ]
    expect((await call(agent, "studio_mission_request_decision", { mission: MISSION, request: { id: "D-2", question: "Which one?", options } })).ok).toBe(true)
    const r = await call(agent, "studio_mission_answer_decision", { mission: MISSION, request: "D-2", option: "A", by: "user", decisionId: "U2" })
    expect(r.ok).toBe(true)
    expect(r.request.answer).toEqual({ option: "A", by: "user", decision: "U2", via: "claude", attested: false })
    // The arguments cannot set provenance (unknown fields are refused by the schema).
    expect((await call(agent, "studio_mission_request_decision", { mission: MISSION, request: { id: "D-3", question: "Again?", options } })).ok).toBe(true)
    const forged = await call(agent, "studio_mission_answer_decision", { mission: MISSION, request: "D-3", option: "B", by: "user", decisionId: "U3", attested: true, via: "swarm" })
    expect(forged.ok).toBe(false)
    expect(forged.code).toBe("SCHEMA_INVALID")
    const got = await call(agent, "studio_mission_get", { mission: MISSION, include: ["requests"] })
    const byId = Object.fromEntries((got.requests as S[]).map((q) => [q.id, q]))
    expect(byId["D-1"].answer).toMatchObject({ via: "swarm", attested: true })
    expect(byId["D-2"].answer).toMatchObject({ via: "claude", attested: false })
    expect(byId["D-3"].status).toBe("open")
    expect(byId["D-1"].topic).toBe("project-placement")
    expect(byId["D-1"].options[0]).toEqual({ id: "join", label: "Join Lumen", consequence: "Moves the mission into the group", group: "Lumen", groupKind: "product" })
    // Stored columns (migration 0008): provenance and topic in their own columns; options carry no "$request" key.
    const rows = await store.transaction(async (tx) => tx.all<S>("SELECT request_id, answered_via, answered_attested, topic, proposal, options FROM mission_decision_request WHERE mission_id = ? ORDER BY request_id", [MISSION]))
    expect(rows.map((x: S) => [x.request_id, x.answered_via, x.answered_attested === null ? null : Number(x.answered_attested), x.topic])).toEqual([
      ["D-1", "swarm", 1, "project-placement"],
      ["D-2", "claude", 0, null],
      ["D-3", null, null, null],
    ])
    expect(rows.every((x: S) => !String(x.options).includes("$request"))).toBe(true)
  })

  test("the key never appears in a log call or a log file", async () => {
    expect(JSON.stringify(logs)).not.toContain(KEY)
    expect(JSON.stringify(logs)).toContain("SESSION_NOT_ATTESTED")
    const files: string[] = []
    const walk = (d: string) => {
      for (const n of readdirSync(d)) {
        const p = path.join(d, n)
        if (statSync(p).isDirectory()) walk(p)
        else if (/\.(jsonl|log|json|txt)$/.test(n)) files.push(p)
      }
    }
    walk(WORK)
    for (const f of files) expect(readFileSync(f, "utf8").includes(KEY), f).toBe(false)
  })
})

describe("N8-484 SEC05: store migration 0008", () => {
  test("0008 is the last migration; old answers read without provenance; row 45 '$request' meta moves into the columns", async () => {
    const migrations = (await import("../../src/store/migrations/index.ts")) as S
    const { MIGRATION_0008_ID } = (await import("../../src/store/migrations/0008_datum_decision_provenance.ts")) as S
    expect(MIGRATION_0008_ID).toBe("20261114000000_datum_decision_provenance")
    expect(migrations.MIGRATIONS.at(-1)).toMatchObject({ seq: 8, id: MIGRATION_0008_ID })
    expect(migrations.latestSchemaId()).toBe(MIGRATION_0008_ID)

    const { Database } = await import("bun:sqlite")
    const raw = new Database(":memory:")
    const db = {
      exec: (sql: string) => raw.exec(sql),
      run: (sql: string, p: unknown[] = []) => raw.query(sql).run(...(p as never[])),
      get: <T>(sql: string, p: unknown[] = []) => (raw.query(sql).get(...(p as never[])) ?? undefined) as T | undefined,
      all: <T>(sql: string, p: unknown[] = []) => raw.query(sql).all(...(p as never[])) as T[],
    }
    let t = 1_800_000_000_000
    const now = () => ++t
    expect(migrations.applyMigrations(db, { release: "1.2.7", now }, migrations.MIGRATIONS.filter((m: S) => m.seq <= 7)).length).toBe(7)
    // Foreign keys are off on this bare connection: no mission type is seeded here (the store seeds it at open).
    db.run("INSERT INTO mission (id, title, type_id, type_version, owner, project_dir, time_created, time_updated) VALUES ('m', 't', 'feature-release', 1, 'o', '/p', 1, 1)")
    db.run("INSERT INTO mission_decision (mission_id, decision_id, by, date, text, time_created) VALUES ('m', 'U1', 'user', '2026-11-14', 'x', 1)")
    const tidyOptions = JSON.stringify([{ id: "approve", label: "Approve", consequence: "c", $request: { topic: "project-tidy", proposal: [{ mission: "2026-11-14_x", group: null }] } }, { id: "decline", label: "No", consequence: "d" }])
    const plain = JSON.stringify([{ id: "A", label: "a", consequence: "c" }, { id: "B", label: "b", consequence: "d" }])
    db.run("INSERT INTO mission_decision_request (mission_id, request_id, question, options, status, requested_by, answer_option, answered_by, answer_decision_id, time_created, time_closed) VALUES ('m', 'D-1', 'q', ?, 'answered', 'a', 'approve', 'user', 'U1', 1, 2)", [tidyOptions])
    db.run("INSERT INTO mission_decision_request (mission_id, request_id, question, options, status, requested_by, time_created) VALUES ('m', 'D-2', 'q', ?, 'open', 'a', 1)", [plain])
    expect(migrations.applyMigrations(db, { release: "1.2.8", now })).toEqual([MIGRATION_0008_ID])
    const rows = db.all<S>("SELECT request_id, options, topic, proposal, answered_via, answered_attested FROM mission_decision_request ORDER BY request_id")
    expect(JSON.parse(rows[0]!.options)).toEqual([{ id: "approve", label: "Approve", consequence: "c" }, { id: "decline", label: "No", consequence: "d" }])
    expect(rows[0]!.topic).toBe("project-tidy")
    expect(JSON.parse(rows[0]!.proposal)).toEqual([{ mission: "2026-11-14_x", group: null }])
    expect([rows[0]!.answered_via, rows[0]!.answered_attested]).toEqual([null, null])
    expect(rows[1]!.options).toBe(plain)
    expect([rows[1]!.topic, rows[1]!.proposal]).toEqual([null, null])
    // The closed-request trigger is back: an answered request cannot be changed.
    expect(() => db.run("UPDATE mission_decision_request SET answered_via = 'x' WHERE request_id = 'D-1'")).toThrow("DECISION_REQUEST_CLOSED")
    // Column checks: attested needs via; via only on an answered request; proposal only on a tidy topic.
    expect(() => db.run("UPDATE mission_decision_request SET answered_attested = 1 WHERE request_id = 'D-2'")).toThrow()
    expect(() => db.run("UPDATE mission_decision_request SET answered_via = 'swarm' WHERE request_id = 'D-2'")).toThrow()
    expect(() => db.run("UPDATE mission_decision_request SET proposal = '[]' WHERE request_id = 'D-2'")).toThrow()
    raw.close()
  })
})
