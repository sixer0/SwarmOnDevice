// Swarm 1.2.7 row 28 (U-6, decisions U1/Q3, C9; spec 01a section 8, AC-U6, register N7-001..N7-017, N7-089, K7-17).
// New mission exports write the numbered folders (01_identification .. 10_report, 11_deliverables); a mission folder
// that already holds the 1.2.6 unnumbered export keeps that layout (folderLayout: legacy); nothing is renamed, moved
// or deleted; a symlinked 09_decisions that leaves the session root is refused by the root check (SR section 3.1;
// the guard's code is PATH_OUTSIDE_ROOTS, unchanged, N7-R04).
// Runs through the REAL host server (startStudioHostServer, streamable HTTP on 127.0.0.1, MCP SDK client) over a temp
// store, with the default exporter (the same call start.ts makes). Needs the command sandbox off (it binds port 0).
// Inputs are synthetic: empty missions created by the test, no task documents are read.
//
// Red at 04067a9d02: (a) the export writes identification/... and decisions/..., (c) MISSION_DOC_FOLDERS is missing,
// (d) the old texts are present. (b) and the symlink case are CHAR (pass at the base and at HEAD); the folderLayout
// field of (b) is new and is asserted in its own test.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs"
import path from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

const PKG = path.resolve(import.meta.dir, "..", "..")
const VENDOR = path.join(PKG, "vendor")
const TEMPLATES = path.join(PKG, "templates")
const SKILLS = path.join(PKG, "..", "opencode", "src", "skill")
const BASE = path.join(process.env.REL127_U6_DIR ?? "/private/tmp/claude-501/rel127u6", "tests")
mkdirSync(BASE, { recursive: true })
const WORK = realpathSync(mkdtempSync(path.join(BASE, "u6-")))
const STORE = path.join(WORK, "datum-studio")
const LOG = path.join(WORK, "logs", "store.jsonl")
const HOME = path.join(WORK, "home")
const RES = path.join(WORK, "Swarm.app", "Contents", "Resources")
const PROJECT = path.join(HOME, "project-u6")
const OUTSIDE = path.join(WORK, "outside")
for (const d of [HOME, RES, PROJECT, OUTSIDE]) mkdirSync(d, { recursive: true })

process.env.STUDIO_WORKSPACE_ROOT = STORE
process.env.STUDIO_ASSETS_ROOT = path.join(VENDOR, "src", "lib", "studio", "assets")
process.env.STUDIO_VENDOR_ROOT = VENDOR
delete process.env.STUDIO_MCP_FILE_ROOTS
delete process.env.INTERNAL_API_SECRET

const TOKEN = "e".repeat(16) + "0123456789abcdef".repeat(3)
const FACTS = { home: HOME, resourcesPath: RES, execPath: path.join(WORK, "Swarm.app", "Contents", "MacOS", "Swarm") }

const realFetch = globalThis.fetch
globalThis.fetch = (async () => {
  throw new Error("rel127 u6 test: globalThis.fetch must not be called by the host")
}) as unknown as typeof fetch

/** The Q3 list (decision U1), in the CLAUDE.md section 3 order, then deliverables (N7-001..N7-011). */
const Q3 = ["01_identification", "02_research", "03_masterplan", "04_initialization", "05_implementation", "06_gateway_check", "07_test", "08_verification", "09_decisions", "10_report", "11_deliverables"]

type S = Record<string, any>
type Mod = typeof import("../../src/mcp-host/index.ts")
let mod: Mod
let store: Awaited<ReturnType<Mod["openHostStore"]>>
let host: Awaited<ReturnType<Mod["startStudioHostServer"]>>
let swarm: Client
const log = () => undefined

async function call(c: Client, name: string, args: Record<string, unknown>): Promise<S> {
  const r = await c.callTool({ name, arguments: args })
  return { ...((r.structuredContent ?? {}) as S), _text: (r.content as Array<{ text?: string }>).map((x) => x.text ?? "").join("\n") }
}
async function ok(c: Client, name: string, args: Record<string, unknown>): Promise<S> {
  const r = await call(c, name, args)
  if (r.ok !== true) throw new Error(`${name} refused: ${JSON.stringify({ code: r.code, error: r.error })}`)
  return r
}
const createMission = (id: string) =>
  ok(swarm, "studio_mission_create", { mission: { id, title: `U-6 probe ${id}`, type: "research", owner: "master-controller", project: { dir: PROJECT }, rows: [] } })

/** Every entry under `dir` (relative, sorted), symlinks listed but not followed. */
function tree(dir: string, rel = ""): string[] {
  const out: string[] = []
  for (const n of readdirSync(path.join(dir, rel)).sort()) {
    const r = rel ? `${rel}/${n}` : n
    out.push(r)
    const st = lstatSync(path.join(dir, r))
    if (st.isDirectory() && !st.isSymbolicLink()) out.push(...tree(dir, r))
  }
  return out
}

beforeAll(async () => {
  ;(await import("../../vendor/src/lib/studio/contract/env")).resetStudioEnvCache()
  mod = (await import("../../src/mcp-host/index.ts")) as Mod
  store = await mod.openHostStore(STORE, { release: "1.2.7", logFile: LOG, missionGuard: true })
  mod.configureTemplateSource({ templatesDir: TEMPLATES, assetRepoRoot: VENDOR, release: "1.2.7" })
  host = await mod.startStudioHostServer({ store, token: TOKEN, hostname: "127.0.0.1", port: 0, log, facts: FACTS, extensions: mod.missionHostExtension(store, { log }) })
  swarm = new Client({ name: "rel127-u6-test", version: "0" })
  await swarm.connect(
    new StreamableHTTPClientTransport(new URL(host.url), {
      fetch: realFetch as never,
      requestInit: { headers: { authorization: `Bearer ${TOKEN}`, "x-studio-agent": "swarm", "x-studio-caller-cwd": encodeURIComponent(PROJECT) } },
    }),
  )
})

afterAll(async () => {
  await swarm?.close().catch(() => undefined)
  await host?.close()
  mod?.configureTemplateSource(null)
  if (store) await mod.closeHostStore(store)
  ;(await import("../../vendor/src/lib/studio/contract/env")).resetStudioEnvCache()
  globalThis.fetch = realFetch
})

describe("rel127 U-6 (a): a new mission export writes the numbered folders", () => {
  test("write: true -> 01_identification/02_structured_rows.md, 09_decisions/decisions.md, 2 root files; folderLayout numbered", async () => {
    const M = "2026-11-13_u6-fresh"
    await createMission(M)
    const w = await ok(swarm, "studio_mission_export", { mission: M, write: true })
    expect(w.files.map((f: S) => f.path)).toEqual([
      `docs/${M}/01_identification/02_structured_rows.md`,
      `docs/${M}/status_tasks.md`,
      `docs/${M}/09_decisions/decisions.md`,
      `docs/${M}/delegation_progress_report.md`,
    ])
    expect(w.folderLayout).toBe("numbered")
    expect(w._text).toContain("(folders: numbered)")
    for (const f of w.files) expect(readFileSync(path.join(PROJECT, f.path), "utf8")).toBe(f.markdown)
    // exactly those files; no unnumbered folder and no empty phase folder is created
    expect(tree(path.join(PROJECT, "docs", M))).toEqual(["01_identification", "01_identification/02_structured_rows.md", "09_decisions", "09_decisions/decisions.md", "delegation_progress_report.md", "status_tasks.md"])
  })

  test("a mission folder with other unnumbered folders but no 1.2.6 export is numbered; its files are untouched", async () => {
    const M = "2026-11-13_u6-notes"
    await createMission(M)
    const dir = path.join(PROJECT, "docs", M)
    mkdirSync(path.join(dir, "research"), { recursive: true })
    writeFileSync(path.join(dir, "research", "01_explore.md"), "# notes\n")
    const w = await ok(swarm, "studio_mission_export", { mission: M, write: true })
    expect(w.folderLayout).toBe("numbered")
    expect(w.files.map((f: S) => f.path)).toContain(`docs/${M}/09_decisions/decisions.md`)
    expect(readFileSync(path.join(dir, "research", "01_explore.md"), "utf8")).toBe("# notes\n")
    expect(existsSync(path.join(dir, "identification"))).toBe(false)
    expect(existsSync(path.join(dir, "decisions"))).toBe(false)
  })

  test("preview (write: false) of a new mission names the numbered paths and writes nothing", async () => {
    const M = "2026-11-13_u6-preview"
    await createMission(M)
    const p = await ok(swarm, "studio_mission_export", { mission: M, files: ["decisions"] })
    expect(p.written).toBe(false)
    expect(p.files.map((f: S) => f.path)).toEqual([`docs/${M}/09_decisions/decisions.md`])
    expect(existsSync(path.join(PROJECT, "docs", M))).toBe(false)
  })
})

describe("rel127 U-6 (b): a 1.2.6 unnumbered export keeps its layout; nothing renamed, moved or deleted", () => {
  const M = "2026-11-13_u6-legacy"
  const dir = path.join(PROJECT, "docs", M)
  const OLD_BP = "# old blueprint (1.2.6)\n"
  const OLD_DEC = "# old decisions (1.2.6)\n"
  const OTHER = "# report written by an agent\n"
  let before: string[] = []
  let w: S

  test("CHAR: overwrite writes the legacy paths, keeps .bak copies, creates no numbered folder, keeps every other file", async () => {
    await createMission(M)
    mkdirSync(path.join(dir, "identification"), { recursive: true })
    mkdirSync(path.join(dir, "decisions"), { recursive: true })
    mkdirSync(path.join(dir, "report"), { recursive: true })
    writeFileSync(path.join(dir, "identification", "02_structured_rows.md"), OLD_BP)
    writeFileSync(path.join(dir, "decisions", "decisions.md"), OLD_DEC)
    writeFileSync(path.join(dir, "report", "report.md"), OTHER)
    before = tree(dir)
    w = await ok(swarm, "studio_mission_export", { mission: M, write: true, overwrite: true })
    expect(w.files.map((f: S) => f.path)).toEqual([
      `docs/${M}/identification/02_structured_rows.md`,
      `docs/${M}/status_tasks.md`,
      `docs/${M}/decisions/decisions.md`,
      `docs/${M}/delegation_progress_report.md`,
    ])
    expect(existsSync(path.join(dir, "01_identification"))).toBe(false)
    expect(existsSync(path.join(dir, "09_decisions"))).toBe(false)
    // the old files' backups exist in <dir>/.bak/ and hold the old bytes
    const bakBp = readdirSync(path.join(dir, "identification", ".bak")).filter((n) => n.startsWith("02_structured_rows.md.bak-"))
    const bakDec = readdirSync(path.join(dir, "decisions", ".bak")).filter((n) => n.startsWith("decisions.md.bak-"))
    expect(bakBp.length).toBe(1)
    expect(bakDec.length).toBe(1)
    expect(readFileSync(path.join(dir, "identification", ".bak", bakBp[0]!), "utf8")).toBe(OLD_BP)
    expect(readFileSync(path.join(dir, "decisions", ".bak", bakDec[0]!), "utf8")).toBe(OLD_DEC)
    // nothing renamed, moved or deleted: every entry that existed before still exists; the agent's file is unchanged
    const after = tree(dir)
    for (const p of before) expect(after).toContain(p)
    expect(readFileSync(path.join(dir, "report", "report.md"), "utf8")).toBe(OTHER)
  })

  test("the result reports folderLayout legacy and the text names it", () => {
    expect(w.folderLayout).toBe("legacy")
    expect(w._text).toContain("(folders: legacy)")
  })
})

describe("rel127 U-6: a symlinked 09_decisions that leaves the session root (SR section 3.1, CHAR)", () => {
  test("refused PATH_OUTSIDE_ROOTS (the unchanged root guard) and nothing is written outside", async () => {
    const M = "2026-11-13_u6-symlink"
    await createMission(M)
    const dir = path.join(PROJECT, "docs", M)
    mkdirSync(dir, { recursive: true })
    const out = path.join(OUTSIDE, "decisions-target")
    mkdirSync(out, { recursive: true })
    symlinkSync(out, path.join(dir, "09_decisions"))
    // the 1.2.6 folder name points out too, so the same refusal holds for either layout
    symlinkSync(out, path.join(dir, "decisions"))
    expect(lstatSync(path.join(dir, "09_decisions")).isSymbolicLink()).toBe(true)
    const r = await call(swarm, "studio_mission_export", { mission: M, write: true })
    expect(r.ok).toBe(false)
    // The refusal is the guarded-write root check (vendor safety.ts resolveAllowedPath), unchanged (N7-R04): its code
    // is PATH_OUTSIDE_ROOTS. PATH_OUTSIDE_ROOT (no S) is the tool's own check of a renderer path with "..".
    expect(r.code).toBe("PATH_OUTSIDE_ROOTS")
    expect(readdirSync(out)).toEqual([])
    // the links themselves are not touched
    expect(lstatSync(path.join(dir, "09_decisions")).isSymbolicLink()).toBe(true)
    expect(lstatSync(path.join(dir, "decisions")).isSymbolicLink()).toBe(true)
  })
})

describe("rel127 U-6 (c): the folder constants", () => {
  test("MISSION_DOC_FOLDERS equals the Q3 list in order; EXPORT_PATHS numbered; LEGACY_EXPORT_PATHS frozen 1.2.6", async () => {
    const r = (await import("../../src/mcp-host/mission/export/render.ts")) as S
    expect(r.MISSION_DOC_FOLDERS).toEqual(Q3)
    expect(r.EXPORT_PATHS).toEqual({ blueprint: "01_identification/02_structured_rows.md", status: "status_tasks.md", decisions: "09_decisions/decisions.md", delegation: "delegation_progress_report.md" })
    expect(r.LEGACY_EXPORT_PATHS).toEqual({ blueprint: "identification/02_structured_rows.md", status: "status_tasks.md", decisions: "decisions/decisions.md", delegation: "delegation_progress_report.md" })
    const idx = (await import("../../src/mcp-host/mission/export/index.ts")) as S
    expect(idx.MISSION_DOC_FOLDERS).toBe(r.MISSION_DOC_FOLDERS)
  })
})

describe("rel127 U-6 (d): the guide and both skill texts name the numbered layout (C9)", () => {
  test("guide, mission-control and swarm-workflow say 09_decisions/decisions.md, never docs/<mission>/decisions/decisions.md", async () => {
    const { missionGuideText } = await import("../../src/mcp-host/mission/mission-guide.ts")
    const texts: Record<string, string> = {
      guide: missionGuideText(),
      "mission-control.md": readFileSync(path.join(SKILLS, "mission-control.md"), "utf8"),
      "swarm-workflow.md": readFileSync(path.join(SKILLS, "swarm-workflow.md"), "utf8"),
    }
    for (const [name, t] of Object.entries(texts)) {
      expect(t.includes("09_decisions/decisions.md") ? name : `${name} lacks 09_decisions/decisions.md`).toBe(name)
      expect(t.includes("docs/<mission>/decisions/decisions.md") ? `${name} still names docs/<mission>/decisions/decisions.md` : name).toBe(name)
    }
    // the light layout of swarm-workflow (ruling R-3) and the deliverables folder
    expect(texts["swarm-workflow.md"]).toContain("01_identification/plan.md")
    expect(texts["swarm-workflow.md"]).toContain("10_report/report.md")
    expect(texts["swarm-workflow.md"]).toContain("11_deliverables/")
    expect(texts["mission-control.md"]).toContain('studio_file_verify, downloadDir "docs/<mission>/11_deliverables"')
    expect(texts.guide).toContain("01_identification")
  })
})
