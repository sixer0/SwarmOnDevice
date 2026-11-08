// Row 169 (gateway_check/15_row168_mission_create_failures.md): the agent could not learn the MissionDoc shape.
// 1. every SCHEMA_INVALID issue names the path and what is expected (enum values, deps form, required names, type),
//    at most 10 issues per refusal;
// 2. the MissionDoc guide resource studio://skema/mission, generated from the schema and the builtin types: its
//    example validates and is accepted by studio_mission_create (dryRun), its enums equal the schema enums;
// 3. `mission` sent as a JSON string is parsed when it is a JSON object, else refused with a clear message.
// Through the REAL host server (port 0 on 127.0.0.1: needs the command sandbox off), like row 119b.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs"
import path from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

const PKG = path.resolve(import.meta.dir, "..", "..")
const VENDOR = path.join(PKG, "vendor")
const TEMPLATES = path.join(PKG, "templates")
const BASE = process.env.ROW169_TEST_DIR ?? "/private/tmp/claude-501/row169/tests"
mkdirSync(BASE, { recursive: true })
const WORK = realpathSync(mkdtempSync(path.join(BASE, "row169-")))
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

async function client(url: string, agent: string): Promise<Client> {
  const c = new Client({ name: `row169-${agent}`, version: "1.0.0" })
  await c.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${TOKEN}`, "x-studio-agent": agent, "x-studio-caller-cwd": encodeURIComponent(PROJECT) } } }))
  return c
}
async function call(name: string, args: S): Promise<S & { text: string }> {
  const r = await swarm.callTool({ name, arguments: args })
  return { ...(r.structuredContent as S), text: (r.content as Array<{ text: string }>)[0]?.text ?? "" }
}
const row = (id: string, over: S = {}) => ({ id, phase: "implementation", kind: "implementation", title: `Row ${id}`, agent: "coder-execution", model: { tier: "thinker" }, deps: [], size: "S", status: "pending", output: `implementation/${id}.md`, verification: "tests pass", ...over })
const mission = (id: string, rows: S[]) => ({ id, title: "Row 169", type: "feature-release", owner: "master-controller", project: { dir: PROJECT }, rows })

beforeAll(async () => {
  mod = (await import("../../src/mcp-host/index.ts")) as Mod
  const log = () => undefined
  store = await mod.openHostStore(STORE, { release: "1.2.0", logFile: LOG, missionGuard: true })
  mod.configureTemplateSource({ templatesDir: TEMPLATES, assetRepoRoot: VENDOR, release: "1.2.0" })
  host = await mod.startStudioHostServer({ store, token: TOKEN, hostname: "127.0.0.1", port: 0, log, facts: FACTS, extensions: mod.missionHostExtension(store, { log, exporter: null }) })
  swarm = await client(host.url, "swarm")
})

afterAll(async () => {
  await swarm?.close().catch(() => undefined)
  await host?.close()
  mod?.configureTemplateSource(null)
  if (store) await mod.closeHostStore(store)
})

describe("row 169 (1): refusals say what is expected", () => {
  test("enum issues list the values (kind, size, tier), deps pattern explains N:B / N:C, required names the field, model type, at most 10 issues", async () => {
    const r = await call("studio_mission_create", {
      dryRun: true,
      mission: mission("2026-11-08_row169-bad", [
        row("1", { kind: "analysis", size: "L", model: { tier: "high" } }),
        row("2", { deps: ["1"] }),
        row("3", { model: "thinker" }),
        ...Array.from({ length: 8 }, (_, i) => row(String(i + 4), { model: { tier: "small" } })),
      ]),
    })
    expect(r.ok).toBe(false)
    expect(r.code).toBe("SCHEMA_INVALID")
    const issues = r.error.details.issues as Array<{ path: string; keyword: string; message: string }>
    const at = (p: string) => issues.find((i) => i.path === p)?.message ?? ""
    expect(at("/rows/0/kind")).toContain("intake, research, spec")
    expect(at("/rows/0/size")).toContain("allowed values: S, M") // two schema rules on size: S, M (draft rows) and S, M, null
    expect(at("/rows/0/model/tier")).toContain("thinker, worker, worker-fast, inherit")
    expect(at("/rows/1/deps/0")).toContain('"1:B"')
    expect(at("/rows/2/model")).toContain("must be object")
    expect(issues.length).toBeLessThanOrEqual(10)
    expect(r.error.details.issuesTotal).toBeGreaterThan(10)
    expect(r.error.details.guide).toBe("studio://skema/mission")
    expect(r.text).toContain("thinker, worker, worker-fast, inherit")

    const req = await call("studio_mission_create", { dryRun: true, mission: { id: "2026-11-08_row169-req", title: "x", type: "feature-release", rows: [{ id: "1" }] } })
    const msgs = (req.error.details.issues as Array<{ message: string }>).map((i) => i.message).join("\n")
    expect(msgs).toContain("'owner'")
    expect(msgs).not.toContain("'project'") // row 181 (L32): a missing project.dir is filled with the session directory
    const extra = await call("studio_mission_create", { dryRun: true, mission: mission("2026-11-08_row169-x", [row("1", { model: { tier: "thinker", name: "opus" } })]) })
    expect(JSON.stringify(extra.error.details.issues)).toContain('additional properties: \\"name\\"')
  })
})

describe("row 169 (2): the MissionDoc guide resource", () => {
  test("listed and readable; example is accepted by studio_mission_create (dryRun)", async () => {
    const list = (await swarm.listResources()).resources
    expect(list.map((r) => r.uri)).toContain("studio://skema/mission")
    const text = ((await swarm.readResource({ uri: "studio://skema/mission" })).contents[0] as { text: string }).text
    for (const w of ["thinker", "worker-fast", "N:B", "owner", "project", "studio_mission_create"]) expect(text).toContain(w)
    const g = await import("../../src/mcp-host/mission/mission-guide.ts")
    const ex = { ...g.MISSION_GUIDE_EXAMPLE, project: { dir: PROJECT } }
    const ok = await call("studio_mission_create", { mission: ex, dryRun: true })
    expect(ok.ok).toBe(true)
    expect(text).toContain(JSON.stringify(g.MISSION_GUIDE_EXAMPLE.rows[0]))
  })

  test("the guide's facts equal the schema and the builtin types (no drift); the example validates against MissionDoc", async () => {
    const g = await import("../../src/mcp-host/mission/mission-guide.ts")
    const { MISSION_SCHEMA_V1 } = await import("../../src/store/mission/schema.ts")
    const { BUILTIN_MISSION_TYPES } = await import("../../src/store/mission/builtin-types.ts")
    const { checkMissionSchema } = await import("../../src/store/mission/validate.ts")
    const defs = (MISSION_SCHEMA_V1 as S).$defs as S
    const f = g.missionGuideFacts()
    expect(f.kind).toEqual(defs.RowKind.enum)
    expect(f.size).toEqual(defs.Row.properties.size.enum)
    expect(f.rowStatus).toEqual(defs.RowStatus.enum)
    expect(f.tier).toEqual(defs.Model.properties.tier.enum)
    expect(f.tierNeedsReason).toEqual(defs.Model.if.properties.tier.enum)
    expect(f.depPattern).toBe(defs.Dep.pattern)
    expect(defs.Row.allOf).toEqual([
      { if: { properties: { status: { enum: f.noteRequiredFor } } }, then: { required: ["note"], properties: { note: true } } },
      { if: { properties: { status: { enum: f.sizeRequiredFor } } }, then: { properties: { size: { enum: f.sizeWhenRequired } }, required: ["size"] } },
    ])
    expect(f.rowRequired).toEqual(defs.Row.required)
    for (const k of f.missionRequired) expect(defs.MissionDoc.required).toContain(k)
    expect(f.types.map((t) => t.id)).toEqual(BUILTIN_MISSION_TYPES.map((t) => t.id))
    const text = g.missionGuideText()
    for (const v of [...f.kind, ...f.tier, ...f.rowRequired, ...f.missionRequired]) expect(text).toContain(v)
    const doc = { $schema: "studio.mission/v1", typeVersion: 1, status: "draft", ...g.MISSION_GUIDE_EXAMPLE }
    expect(checkMissionSchema("MissionDoc", doc)).toEqual([])
  })

  test("studio_mission_create description points to the resource and names the tiers", async () => {
    const t = (await swarm.listTools()).tools.find((x) => x.name === "studio_mission_create")!
    expect(t.description).toContain("studio://skema/mission")
    expect(t.description).toContain("thinker")
    expect(t.description!.length).toBeLessThanOrEqual(450)
  })
})

describe("row 169 (3): mission as a JSON string", () => {
  test("a JSON object string is parsed; anything else is refused saying it must be an object", async () => {
    const ok = await call("studio_mission_create", { dryRun: true, mission: JSON.stringify(mission("2026-11-08_row169-str", [row("1")])) })
    expect(ok.ok).toBe(true)
    const bad = await call("studio_mission_create", { dryRun: true, mission: "{not json" })
    expect(bad.code).toBe("SCHEMA_INVALID")
    expect(bad.text).toContain("must be a JSON object")
    const arr = await call("studio_mission_create", { dryRun: true, mission: "[1]" })
    expect(arr.text).toContain("must be a JSON object")
  })
})
