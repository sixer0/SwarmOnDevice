// 1.3.3 row 16 (MC-4 item 1, register 1.1): server-side row defaults through the REAL host server.
// 1. a mission is created from four fields (id, title, type, step titles) and the stored rows carry the defaults;
// 2. the reply names what was filled (text line and data.defaulted); a full mission gets neither;
// 3. a value the caller sent is stored as sent;
// 4. the create example of the bundled mission-control skill is accepted as printed;
// 5. a row added later (update_row add) gets the same defaults.
// Port 0 on 127.0.0.1: needs the command sandbox off, like row 119b and row 169.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { AGENT_DEFAULT, OUTPUT_DEFAULT, OWNER_DEFAULT, VERIFICATION_DEFAULT } from "../../src/mcp-host/mission/row-defaults.ts"

const PKG = path.resolve(import.meta.dir, "..", "..")
const VENDOR = path.join(PKG, "vendor")
const TEMPLATES = path.join(PKG, "templates")
const SKILL = path.resolve(PKG, "..", "opencode", "src", "skill", "mission-control.md")
const BASE = process.env.ROW16_TEST_DIR ?? path.join(process.env.TMPDIR ?? os.tmpdir(), "row16-tests")
mkdirSync(BASE, { recursive: true })
const WORK = realpathSync(mkdtempSync(path.join(BASE, "row16-")))
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

const TOKEN = "d".repeat(16) + "0123456789abcdef".repeat(3)
const FACTS = { home: HOME, resourcesPath: RES, execPath: path.join(WORK, "Swarm.app", "Contents", "MacOS", "Swarm") }
type S = Record<string, any>

type Mod = typeof import("../../src/mcp-host/index.ts")
let mod: Mod
let store: Awaited<ReturnType<Mod["openHostStore"]>>
let host: Awaited<ReturnType<Mod["startStudioHostServer"]>>
let swarm: Client

async function call(name: string, args: S): Promise<S & { text: string; isError: boolean }> {
  const r = await swarm.callTool({ name, arguments: args })
  return { ...(r.structuredContent as S), text: (r.content as Array<{ text: string }>)[0]?.text ?? "", isError: r.isError === true }
}
const rowsOf = async (mission: string): Promise<S[]> => (await call("studio_mission_get", { mission, include: ["rows"] })).mission.rows
const strip = (r: S) => Object.fromEntries(Object.entries(r).filter(([k]) => !["createdAt", "updatedAt", "deliverables", "review", "resources"].includes(k)))

beforeAll(async () => {
  mod = (await import("../../src/mcp-host/index.ts")) as Mod
  const log = () => undefined
  store = await mod.openHostStore(STORE, { release: "1.3.3", logFile: LOG, missionGuard: true })
  mod.configureTemplateSource({ templatesDir: TEMPLATES, assetRepoRoot: VENDOR, release: "1.3.3" })
  host = await mod.startStudioHostServer({ store, token: TOKEN, hostname: "127.0.0.1", port: 0, log, facts: FACTS, extensions: mod.missionHostExtension(store, { log, exporter: null }) })
  swarm = new Client({ name: "row16-swarm", version: "1.0.0" })
  await swarm.connect(new StreamableHTTPClientTransport(new URL(host.url), { requestInit: { headers: { authorization: `Bearer ${TOKEN}`, "x-studio-agent": "swarm", "x-studio-caller-cwd": encodeURIComponent(PROJECT) } } }))
})

afterAll(async () => {
  await swarm?.close().catch(() => undefined)
  await host?.close()
  mod?.configureTemplateSource(null)
  if (store) await mod.closeHostStore(store)
})

describe("row 16: a mission from id, title, type and step titles", () => {
  const ID = "2026-11-17_row16-small"
  const small = { id: ID, title: "Row 16 small", type: "feature-release", rows: [{ title: "Write the spec" }, { title: "Build it" }, { title: "Run the tests" }] }

  test("dry run then real create succeed; the stored rows carry the register's defaults", async () => {
    const dry = await call("studio_mission_create", { dryRun: true, mission: small })
    expect(dry.text).toContain(`mission ${ID} created as draft: 3 rows`)
    expect(dry.isError).toBe(false)
    const r = await call("studio_mission_create", { mission: small })
    expect(r.isError).toBe(false)
    expect(r.ok).toBe(true)
    const got = await call("studio_mission_get", { mission: ID, include: ["rows"] })
    expect(got.mission.owner).toBe(OWNER_DEFAULT)
    expect(got.mission.project.dir).toBe(PROJECT)
    const facts = (await import("../../src/mcp-host/mission/mission-guide.ts")).missionGuideFacts()
    const first = facts.types.find((t) => t.id === "feature-release")!.phases[0]
    expect(got.mission.rows.map(strip)).toEqual(
      small.rows.map((row, i) => ({ id: String(i + 1), phase: first.id, kind: first.kinds[0], title: row.title, agent: AGENT_DEFAULT, model: { tier: "inherit" }, deps: [], size: "S", status: "pending", output: OUTPUT_DEFAULT, verification: VERIFICATION_DEFAULT })),
    )
    expect(got.mission.rows.every((row: S) => row.review === "gate")).toBe(true)
  })

  test("the reply says what was filled, in one line and in data.defaulted", async () => {
    const r = await call("studio_mission_create", { dryRun: true, mission: { ...small, id: `${ID}-say` } })
    const line = r.text.split("\n").find((l) => l.startsWith("defaults filled"))
    expect(line).toBe(`defaults filled (a value you send is never replaced): mission owner "${OWNER_DEFAULT}"; rows 1-3: id, phase, kind, agent "${AGENT_DEFAULT}", model, deps, size, status, output, verification.`)
    expect(r.defaulted).toEqual({ mission: ["owner"], rows: ["1", "2", "3"].map((row) => ({ row, fields: ["id", "phase", "kind", "agent", "model", "deps", "size", "status", "output", "verification"] })) })
  })
})

describe("row 16: explicit values", () => {
  test("a full mission is stored as sent and the reply names no default", async () => {
    const ID = "2026-11-17_row16-full"
    const row = { id: "3", phase: "verification", kind: "test", title: "Full row", agent: "verifier", model: { tier: "worker", reason: "mechanical run" }, deps: [], size: "M", status: "pending", output: "07_test/01_test_report.md", verification: "suite green" }
    const r = await call("studio_mission_create", { mission: { id: ID, title: "Full", type: "feature-release", owner: "master-controller", project: { dir: PROJECT }, rows: [row] } })
    expect(r.isError).toBe(false)
    expect(r.text).not.toContain("defaults filled")
    expect("defaulted" in r).toBe(false)
    const got = await call("studio_mission_get", { mission: ID, include: ["rows"] })
    expect(got.mission.owner).toBe("master-controller")
    expect(got.mission.rows.map(strip)).toEqual([row])
  })

  test("a wrong value the caller sent is still refused: a default never hides it", async () => {
    const r = await call("studio_mission_create", { dryRun: true, mission: { id: "2026-11-17_row16-bad", title: "Bad", type: "feature-release", rows: [{ title: "x", model: { tier: "worker" } }, { title: "y", size: "L" }] } })
    expect(r.isError).toBe(true)
    expect(r.error.code).toBe("SCHEMA_INVALID")
  })
})

describe("row 16: the bundled skill's create example", () => {
  test("is accepted exactly as printed, and its sent values are the stored values", async () => {
    const example = JSON.parse(readFileSync(SKILL, "utf8").match(/### datum-studio_studio_mission_create\n```json\n([\s\S]*?)```/)![1]) as S
    expect(example.dryRun).toBe(true)
    expect(Object.keys(example.mission).sort()).toEqual(["id", "rows", "title", "type"])
    expect(example.mission.rows[0]).toEqual({ title: "Write the spec" })
    const dry = await call("studio_mission_create", example)
    expect(dry.isError).toBe(false)
    const real = await call("studio_mission_create", { mission: example.mission })
    expect(real.isError).toBe(false)
    const rows = await rowsOf(example.mission.id)
    expect(rows.map((r) => r.id)).toEqual(["1", "2", "3"])
    for (const [i, sent] of (example.mission.rows as S[]).entries()) expect(rows[i]).toMatchObject(sent)
    // The printed tier table: coder -> worker (with the reason a tier below thinker needs), verifier -> thinker.
    expect(rows[1].model).toEqual({ tier: "worker", reason: "Swarm tier map: coder runs on worker" })
    expect(rows[2].model).toEqual({ tier: "thinker" })
    expect(rows[0]).toMatchObject({ agent: AGENT_DEFAULT, model: { tier: "inherit" }, size: "S", deps: [], status: "pending" })
  })
})

describe("row 16: a row added later", () => {
  test("update_row add with a title only gets the defaults; the reply names them", async () => {
    const ID = "2026-11-17_row16-add"
    await call("studio_mission_create", { mission: { id: ID, title: "Add", type: "feature-release", rows: [{ title: "One" }] } })
    const r = await call("studio_mission_update_row", { mission: ID, rows: [{ id: "2", add: { title: "Two", agent: "explore", phase: "verification" } }] })
    expect(r.isError).toBe(false)
    expect(r.results).toEqual([{ id: "2", ok: true }])
    expect(r.text).toContain("defaults filled (a value you send is never replaced): row 2: id, kind, model, deps, size, status, output, verification.")
    expect(r.defaulted).toEqual({ mission: [], rows: [{ row: "2", fields: ["id", "kind", "model", "deps", "size", "status", "output", "verification"] }] })
    const added = (await rowsOf(ID)).find((row) => row.id === "2")!
    expect(added).toMatchObject({ title: "Two", agent: "explore", phase: "verification", model: { tier: "worker-fast", reason: "Swarm tier map: explore runs on worker-fast" }, size: "S", deps: [], status: "pending", output: OUTPUT_DEFAULT, verification: VERIFICATION_DEFAULT })
  })

  test("a patch without add is untouched and names no default", async () => {
    const r = await call("studio_mission_update_row", { mission: "2026-11-17_row16-add", rows: [{ id: "1", note: "a note" }] })
    expect(r.isError).toBe(false)
    expect(r.text).not.toContain("defaults filled")
    expect("defaulted" in r).toBe(false)
  })
})
