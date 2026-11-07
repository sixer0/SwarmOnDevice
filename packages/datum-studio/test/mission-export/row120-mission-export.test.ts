// Row 120: the /docs Markdown export of a mission (mission contract §9, §10, §12 row 120; decisions U19, C77 D3),
// through the REAL host server (startStudioHostServer, streamable HTTP on 127.0.0.1, MCP SDK client) over a temp
// store, with the default exporter of missionHostExtension (the row 120 renderer, the same call start.ts makes).
//
// The sample missions are built from THIS task's hand-written files, read-only:
//   - slice: rows 72-76, 79, 80, 86, 90 (a dependency-closed slice with Execution Profile lines) + dropped row 38,
//     and 5 decisions (U14, C19, C51, U19, C71);
//   - full: every row of identification/02_structured.md and all decisions of decisions/decisions.md (§12 row 120).
// Generated tables are diffed against the hand-written lines (the diffs are quoted and written to OUT).
// Never writes into the task's docs folder: generated files go to a temp project dir and are copied to OUT.
// Needs the command sandbox off (it binds a port; port 0 = ephemeral). globalThis.fetch is a trap for the file.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs"
import path from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { BLUEPRINT_HEADER, DECISIONS_HEADER, PROFILE_HEADER, droppedRow, readBlueprint, readDecisions, toMissionRow, type HandRow, type ImportNote } from "./hand-written.ts"

const PKG = path.resolve(import.meta.dir, "..", "..")
const VENDOR = path.join(PKG, "vendor")
const TEMPLATES = path.join(PKG, "templates")
// Default: a frozen copy of the task docs (fixtures/task-docs, row 120d / C133) so the live, changing docs cannot fail the tests.
// ROW120_TASK_DIR overrides it (e.g. the live <repo parent>/docs/<task> folder).
const TASK = process.env.ROW120_TASK_DIR ?? path.join(import.meta.dir, "fixtures", "task-docs")
// The tests that read the task's hand-written files are skipped when that folder is missing.
const HAVE_TASK = existsSync(TASK)
const TASK_SKIP_REASON = `task folder not found: ${TASK} (set ROW120_TASK_DIR); tests that read the hand-written blueprint/decisions are skipped`
console.log(`[row120] task folder ${TASK} exists=${HAVE_TASK}${HAVE_TASK ? "" : `; ${TASK_SKIP_REASON}`}`)
const taskTest = test.skipIf(!HAVE_TASK)
const SCRATCH = process.env.ROW120_DIR ?? "/private/tmp/claude-501/row120"
const BASE = path.join(SCRATCH, "tests")
mkdirSync(BASE, { recursive: true })
const WORK = realpathSync(mkdtempSync(path.join(BASE, "row120-")))
const OUT = path.join(WORK, "out")
const STORE = path.join(WORK, "datum-studio")
const LOG = path.join(WORK, "logs", "store.jsonl")
const HOME = path.join(WORK, "home")
const RES = path.join(WORK, "Swarm.app", "Contents", "Resources")
const PROJECT = path.join(HOME, "project-a")
const OUTSIDE = path.join(WORK, "outside")
for (const d of [HOME, RES, PROJECT, OUT, OUTSIDE]) mkdirSync(d, { recursive: true })

function setEnv() {
  process.env.STUDIO_WORKSPACE_ROOT = STORE
  process.env.STUDIO_ASSETS_ROOT = path.join(VENDOR, "src", "lib", "studio", "assets")
  process.env.STUDIO_VENDOR_ROOT = VENDOR
  delete process.env.STUDIO_MCP_FILE_ROOTS
  delete process.env.INTERNAL_API_SECRET
}
setEnv()

/** Own the process-wide caches an earlier suite may have filled (as T-2 / I-2, C71, C73). */
async function resetProcessCaches() {
  const { resetStudioEnvCache } = await import("../../vendor/src/lib/studio/contract/env")
  const { resetBridgePdfReadiness } = await import("../../vendor/src/lib/studio/services/render")
  const { resetRenderRateLimiter } = await import("../../vendor/src/lib/studio/http/render-guard")
  resetStudioEnvCache()
  resetBridgePdfReadiness()
  resetRenderRateLimiter()
}

const TOKEN = "d".repeat(16) + "0123456789abcdef".repeat(3)
const FACTS = { home: HOME, resourcesPath: RES, execPath: path.join(WORK, "Swarm.app", "Contents", "MacOS", "Swarm") }

const realFetch = globalThis.fetch
let fetchCalls = 0
globalThis.fetch = (async () => {
  fetchCalls++
  throw new Error("row120 test: globalThis.fetch must not be called by the host")
}) as unknown as typeof fetch

const SLICE = "2026-11-06_swarm_1_2_0_datum_installer"
const FULL = "2026-11-07_row120-full-task"
const SLICE_ROWS = ["72", "73", "74", "75", "76", "79", "80", "86", "90"]
const SLICE_DECISIONS = ["U14", "C19", "C51", "U19", "C71"]

// a decision line is | id | text | by | date |: more than 6 parts split on an unescaped | means a raw | in the text
const hasRawPipe = (line: string) => line.split(/(?<!\\)\|/).length > 6

type S = Record<string, any>
type Mod = typeof import("../../src/mcp-host/index.ts")
let mod: Mod
let store: Awaited<ReturnType<Mod["openHostStore"]>>
let host: Awaited<ReturnType<Mod["startStudioHostServer"]>>
let hostBad: Awaited<ReturnType<Mod["startStudioHostServer"]>>
let swarm: Client
const logs: Array<{ level: string; source: string; message: string; context?: Record<string, unknown> }> = []
const log = (level: "info" | "warn" | "error", source: string, message: string, context?: Record<string, unknown>) => logs.push({ level, source, message, ...(context ? { context } : {}) })
const quoted: string[] = []
const quote = (label: string, v: unknown) => {
  const line = `${label}: ${typeof v === "string" ? v : JSON.stringify(v)}`
  quoted.push(line)
  console.log(`[row120] ${line}`)
}

async function client(url: string, agent: string, cwd = PROJECT): Promise<Client> {
  const c = new Client({ name: "row120-test", version: "0" })
  const t = new StreamableHTTPClientTransport(new URL(url), {
    fetch: realFetch as never,
    requestInit: { headers: { authorization: `Bearer ${TOKEN}`, "x-studio-agent": agent, "x-studio-caller-cwd": encodeURIComponent(cwd) } },
  })
  await c.connect(t)
  return c
}
async function call(c: Client, name: string, args: Record<string, unknown>): Promise<S> {
  const r = await c.callTool({ name, arguments: args })
  return { ...((r.structuredContent ?? {}) as S), _isError: r.isError === true, _text: (r.content as Array<{ text?: string }>).map((x) => x.text ?? "").join("\n") }
}
const code = (r: S) => (r.ok === false ? r.code : "OK")
async function ok(c: Client, name: string, args: Record<string, unknown>): Promise<S> {
  const r = await call(c, name, args)
  if (r.ok !== true) throw new Error(`${name} refused: ${JSON.stringify({ code: r.code, error: r.error })}`)
  return r
}

/** Unified diff with the system diff (exit 0 = equal, 1 = differ); both sides are written to OUT. */
function diff(name: string, expected: string[], generated: string[]): { equal: boolean; text: string } {
  const a = path.join(OUT, `${name}.hand.md`)
  const b = path.join(OUT, `${name}.generated.md`)
  writeFileSync(a, expected.join("\n") + "\n")
  writeFileSync(b, generated.join("\n") + "\n")
  const p = Bun.spawnSync(["/usr/bin/diff", "-u", "--label", `hand-written/${name}`, "--label", `generated/${name}`, a, b])
  const text = p.stdout.toString()
  writeFileSync(path.join(OUT, `${name}.diff`), text)
  return { equal: p.exitCode === 0, text }
}

/** The lines of the first table that starts with `header` in a generated file. */
function tableAfter(md: string, header: string): string[] {
  const lines = md.split("\n")
  const i = lines.indexOf(header)
  if (i < 0) throw new Error(`header not found: ${header}`)
  const out: string[] = []
  for (let j = i; j < lines.length && lines[j]!.startsWith("|"); j++) out.push(lines[j]!)
  return out
}
const lineId = (l: string) => /^\| ([^ ]+) \|/.exec(l)?.[1] ?? ""

// Without the task folder these stay unread; every test that uses them is skipped (HAVE_TASK).
const bp = HAVE_TASK ? readBlueprint(path.join(TASK, "identification", "02_structured.md")) : (undefined as unknown as ReturnType<typeof readBlueprint>)
const dec = HAVE_TASK ? readDecisions(path.join(TASK, "decisions", "decisions.md")) : (undefined as unknown as ReturnType<typeof readDecisions>)
const handById = new Map<string, HandRow>(HAVE_TASK ? bp.rows.map((r) => [r.id, r]) : [])
const handText = (lineNo: number) => readFileSync(path.join(TASK, "identification", "02_structured.md"), "utf8").split("\n")[lineNo - 1]!

/** Row decisions of the addenda (§10.1, §4.4): 117 by C34, 118-121 by U19, 122-124 by C40. */
const ROW_DECISION: Record<string, string> = { "117": "C34", "118": "U19", "119": "U19", "120": "U19", "121": "U19", "122": "C40", "123": "C40", "124": "C40" }

/** Rows to bring to `done`: `seed` plus their B-dependency closure, in dependency order. */
function doneOrder(rows: Array<{ id: string; deps: string[] }>, seed: Iterable<string>): string[] {
  const byId = new Map(rows.map((r) => [r.id, r]))
  const out: string[] = []
  const seen = new Set<string>()
  const visit = (id: string) => {
    if (seen.has(id)) return
    seen.add(id)
    for (const d of byId.get(id)?.deps ?? []) if (d.endsWith(":B")) visit(d.slice(0, -2))
    out.push(id)
  }
  for (const id of seed) visit(id)
  return out
}
const toDone = (id: string) => [
  { id, status: "running" },
  { id, status: "needs-review" },
  { id, status: "done" },
]
const chunks = <T>(a: T[], n: number): T[][] => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, (i + 1) * n))

beforeAll(async () => {
  setEnv()
  await resetProcessCaches()
  mod = (await import("../../src/mcp-host/index.ts")) as Mod
  store = await mod.openHostStore(STORE, { release: "1.2.0", logFile: LOG, missionGuard: true })
  mod.configureTemplateSource({ templatesDir: TEMPLATES, assetRepoRoot: VENDOR, release: "1.2.0" })
  // The default exporter (no `exporter` option) = the row 120 renderer; start.ts makes the same call.
  host = await mod.startStudioHostServer({ store, token: TOKEN, hostname: "127.0.0.1", port: 0, log, facts: FACTS, extensions: mod.missionHostExtension(store, { log }) })
  // A host whose renderer tries to leave docs/<mission>/ (the seam's own path rule).
  const bad = async () => [{ path: "../../escape.md", markdown: "# escape\n" }]
  hostBad = await mod.startStudioHostServer({ store, token: TOKEN, hostname: "127.0.0.1", port: 0, log, facts: FACTS, extensions: mod.missionHostExtension(store, { log, exporter: bad }) })
  swarm = await client(host.url, "swarm")
})

afterAll(async () => {
  await swarm?.close().catch(() => undefined)
  await hostBad?.close()
  await host?.close()
  mod?.configureTemplateSource(null)
  if (store) await mod.closeHostStore(store)
  await resetProcessCaches()
  globalThis.fetch = realFetch
  writeFileSync(path.join(OUT, "quoted.txt"), quoted.join("\n") + "\n")
  // Evidence copy for the report (scratch only).
  const keep = path.join(SCRATCH, "out", "last")
  mkdirSync(keep, { recursive: true })
  for (const f of readdirSync(OUT)) copyFileSync(path.join(OUT, f), path.join(keep, f))
})

describe("row 120: renderer units", () => {
  taskTest("cell escaping, id ranges, phase cells, header constants equal the hand-written headers", async () => {
    const r = await import("../../src/mcp-host/mission/export/render.ts")
    expect(r.cell("a|b|c")).toBe("a\\|b\\|c")
    expect(r.cell("x\ny")).toBe("x y")
    expect(r.collapseIds(["65", "3", "1", "2", "63", "108a", "21", "4", "20"])).toBe("1-4, 20-21, 63, 65, 108a")
    expect(r.phaseCell([{ id: "1", status: "done" }, { id: "2", status: "done" }, { id: "118", status: "running" }, { id: "5", status: "pending" }])).toBe("done: 1-2; running: 118; pending: 5")
    expect(r.phaseCell([])).toBe("-")
    // byte-identical headers (§9): the renderer constants equal today's hand-written header lines
    expect(r.BLUEPRINT_HEADER).toBe(handText(bp.headerLines.bp[0]!))
    expect(r.BLUEPRINT_RULE).toBe(handText(bp.headerLines.bp[0]! + 1))
    expect(r.PROFILE_HEADER).toBe(handText(bp.headerLines.profile[0]!))
    expect(r.PROFILE_RULE).toBe(handText(bp.headerLines.profile[0]! + 1))
    expect([r.DECISIONS_HEADER, r.DECISIONS_RULE]).toEqual(dec.header.map((h) => h.line))
    const status = readFileSync(path.join(TASK, "status_tasks.md"), "utf8").split("\n")
    expect([r.STATUS_HEADER, r.STATUS_RULE]).toEqual([status[2], status[3]])
    quote("headers", { blueprint: bp.headerLines.bp, profile: bp.headerLines.profile, decisions: dec.header.map((h) => h.lineNo), status: [3, 4] })
  })
})

describe.skipIf(!HAVE_TASK)("row 120: slice mission (9 rows + dropped 38, 5 decisions) through the real host", () => {
  const notes: ImportNote[] = []
  let files: S[] = []

  test("create, approve, move rows, export with write: true -> the four files under <session root>/docs/<mission>/", async () => {
    const rows = SLICE_ROWS.map((id) => toMissionRow(handById.get(id)!, notes))
    const decisions = dec.decisions.filter((d) => SLICE_DECISIONS.includes(d.id)).map(({ line: _l, ...d }) => d)
    expect(decisions.map((d) => d.id)).toEqual(["U14", "C19", "U19", "C51", "C71"]) // recorded (file) order
    await ok(swarm, "studio_mission_create", {
      mission: {
        id: SLICE,
        title: "Swarm 1.2.0 with DATUM built in, full dmg installer",
        type: "feature-release",
        owner: "master-controller",
        project: { dir: PROJECT },
        rows: [...rows.slice(0, 5), droppedRow("38"), ...rows.slice(5)],
        decisions,
      },
    })
    await ok(swarm, "studio_mission_approve", { mission: SLICE, decision: "U14" })
    await ok(swarm, "studio_mission_update_row", {
      mission: SLICE,
      rows: [...toDone("72"), ...toDone("73"), { id: "74", status: "running", acquire: ["heavy-host"] }, { id: "90", status: "blocked", note: "waits for the clone review input" }],
    })
    const w = await ok(swarm, "studio_mission_export", { mission: SLICE, write: true })
    files = w.files
    quote("slice export", { written: w.written, files: files.map((f) => ({ path: f.path, bytes: f.bytes, sha256: f.sha256 })) })
    expect(files.map((f) => f.path)).toEqual([
      `docs/${SLICE}/identification/02_structured_rows.md`,
      `docs/${SLICE}/status_tasks.md`,
      `docs/${SLICE}/decisions/decisions.md`,
      `docs/${SLICE}/delegation_progress_report.md`,
    ])
    for (const f of files) {
      const abs = path.join(PROJECT, f.path)
      expect(readFileSync(abs, "utf8")).toBe(f.markdown)
      copyFileSync(abs, path.join(OUT, `slice_${path.basename(f.path)}`))
    }
    // nothing outside the session root: the task's real docs folder has no generated rows file
    expect(existsSync(path.join(TASK, "identification", "02_structured_rows.md"))).toBe(false)
  })

  test("blueprint and profile tables: byte-identical to the hand-written lines of the slice (diff quoted)", () => {
    const md = files[0]!.markdown as string
    const genBp = tableAfter(md, BLUEPRINT_HEADER)
    const genPf = tableAfter(md, PROFILE_HEADER)
    const handBp = [handText(bp.headerLines.bp[0]!), handText(bp.headerLines.bp[0]! + 1), ...SLICE_ROWS.map((id) => handById.get(id)!.bpLine.line)]
    const handPf = [handText(bp.headerLines.profile[0]!), handText(bp.headerLines.profile[0]! + 1), ...SLICE_ROWS.map((id) => handById.get(id)!.profileLine!.line)]
    const d1 = diff("slice_blueprint", handBp, genBp)
    const d2 = diff("slice_profile", handPf, genPf)
    quote("slice blueprint diff (hand lines " + SLICE_ROWS.map((id) => handById.get(id)!.bpLine.lineNo).join(",") + ")", d1.equal ? "EQUAL (diff exit 0)" : d1.text)
    quote("slice profile diff (hand lines " + SLICE_ROWS.map((id) => handById.get(id)!.profileLine!.lineNo).join(",") + ")", d2.equal ? "EQUAL (diff exit 0)" : d2.text)
    expect(d1.equal).toBe(true)
    expect(d2.equal).toBe(true)
    expect(md.split("\n")).toContain("Dropped: 38 (C19)")
    expect(notes).toEqual([])
  })

  test("decisions table: equal except a raw | in a hand-written text, which the export escapes", () => {
    const md = files[2]!.markdown as string
    const gen = tableAfter(md, DECISIONS_HEADER)
    const hand = [...dec.header.map((h) => h.line), ...dec.decisions.filter((d) => SLICE_DECISIONS.includes(d.id)).map((d) => d.line.line)]
    const d = diff("slice_decisions", hand, gen)
    quote("slice decisions diff", d.text)
    const differing = gen.filter((l, i) => l !== hand[i])
    // a hand-written decision differs only when its text holds a raw | (computed from the live file)
    const rawPipe = dec.decisions.filter((x) => SLICE_DECISIONS.includes(x.id) && hasRawPipe(x.line.line)).map((x) => x.id)
    expect(differing.map(lineId)).toEqual(rawPipe)
    quote("slice decisions with a raw | in the live file (none is valid)", rawPipe)
    // the only change is the escape: unescaping the generated line gives the hand-written line back
    for (const l of differing) expect(l.replace(/\\\|/g, "|")).toBe(hand[gen.indexOf(l)]!)
    expect(md.startsWith("# Decisions\n\n| # | Decision | By | Date |\n|---|---|---|---|\n")).toBe(true)
  })

  test("status file: generated per phase from the export snapshot; counts quoted; the snapshot is stored", async () => {
    const md = files[1]!.markdown as string
    quote("slice status_tasks.md", md)
    expect(md.startsWith("# Status\n")).toBe(true)
    expect(tableAfter(md, "| Phase | Status |")).toEqual([
      "| Phase | Status |",
      "|---|---|",
      "| identification | - |",
      "| research | done: 72-73; running: 74; pending: 75-76, 79-80 |",
      "| implementation | dropped: 38 |",
      "| verification | blocked: 90; pending: 86 |",
      "| release | - |",
    ])
    expect(md).toContain("Locks: heavy-host (row 74, swarm)")
    expect(md).toMatch(/^Ready: 75, 76, 79, 80$/m)
    const got = await ok(swarm, "studio_mission_get", { mission: SLICE, include: ["snapshots"] })
    const snaps = got.snapshots.filter((s: S) => s.reason === "export")
    expect(snaps.length).toBe(1)
    expect(md).toContain(`Snapshot ${snaps[0].id} `)
    quote("slice export snapshot counts", snaps[0].body.counts)
    expect(snaps[0].body.counts).toEqual({ pending: 5, running: 1, "needs-review": 0, blocked: 1, done: 2, dropped: 1 })
  })

  test("delegation trail: one line per mission_event, in seq order", async () => {
    const md = files[3]!.markdown as string
    const got = await ok(swarm, "studio_mission_get", { mission: SLICE, include: ["events"] })
    const lines = tableAfter(md, "| Time (UTC) | Row | Actor | Event | From → To | Decision |")
    expect(lines.length - 2).toBe(got.events.length)
    quote("slice delegation trail head", lines.slice(0, 6).join("\n"))
    expect(lines[2]).toMatch(/^\| \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \| - \| swarm \| create \| - → draft \| - \|$/)
    expect(lines.some((l) => / \| 72 \| swarm \| [a-z_-]+ \| needs-review → done \| - \|$/.test(l))).toBe(true)
    expect(lines.some((l) => / \| approve \| draft → approved \| U14 \|$/.test(l))).toBe(true)
  })

  test("write rules: FILE_EXISTS without overwrite; overwrite makes a .bak; preview (write: false) writes nothing", async () => {
    const again = await call(swarm, "studio_mission_export", { mission: SLICE, write: true })
    quote("second write", { code: code(again), files: again.error?.details?.files })
    expect(code(again)).toBe("FILE_EXISTS")
    const over = await ok(swarm, "studio_mission_export", { mission: SLICE, files: ["status"], write: true, overwrite: true })
    expect(over.files.length).toBe(1)
    expect(readdirSync(path.join(PROJECT, "docs", SLICE)).some((n) => n.startsWith("status_tasks.md.bak-"))).toBe(true)
    const before = readdirSync(path.join(PROJECT, "docs", SLICE)).length
    const preview = await ok(swarm, "studio_mission_export", { mission: SLICE, files: ["decisions"] })
    expect(preview.written).toBe(false)
    expect(preview.files.map((f: S) => f.path)).toEqual([`docs/${SLICE}/decisions/decisions.md`])
    expect(readdirSync(path.join(PROJECT, "docs", SLICE)).length).toBe(before)
  })

  test("paths outside the session root are refused: a symlinked docs/<mission>, a renderer path with .., an unknown mission", async () => {
    // 1. docs/<mission> is a symlink to a folder outside the session root
    const M2 = "2026-11-07_row120-symlink"
    await ok(swarm, "studio_mission_create", { mission: { id: M2, title: "Symlink probe", type: "research", owner: "master-controller", project: { dir: PROJECT }, rows: [] } })
    mkdirSync(path.join(PROJECT, "docs"), { recursive: true })
    symlinkSync(OUTSIDE, path.join(PROJECT, "docs", M2))
    expect(lstatSync(path.join(PROJECT, "docs", M2)).isSymbolicLink()).toBe(true)
    const sym = await call(swarm, "studio_mission_export", { mission: M2, write: true })
    quote("export through a symlink out of the root", { code: code(sym), message: sym.error?.message })
    expect(sym.ok).toBe(false)
    expect(readdirSync(OUTSIDE)).toEqual([])
    // 2. a renderer path that leaves docs/<mission>/
    const c = await client(hostBad.url, "swarm")
    try {
      const esc = await call(c, "studio_mission_export", { mission: SLICE, write: true })
      quote("renderer path ../../escape.md", { code: code(esc) })
      expect(code(esc)).toBe("PATH_OUTSIDE_ROOT")
      expect(existsSync(path.join(PROJECT, "escape.md"))).toBe(false)
    } finally {
      await c.close().catch(() => undefined)
    }
    // 2b. start.ts's own default extensions (no `extensions` passed, I-2): the export is installed there too
    const hostDefault = await mod.startStudioHostServer({ store, token: TOKEN, hostname: "127.0.0.1", port: 0, log, facts: FACTS })
    const c3 = await client(hostDefault.url, "claude")
    try {
      const names = (await c3.listTools()).tools.map((t) => t.name)
      const pre = await call(c3, "studio_mission_export", { mission: SLICE, files: ["blueprint"] })
      quote("start.ts default host", { tools: names.length, export: code(pre), files: pre.files?.map((f: S) => f.path) })
      expect(names).toContain("studio_mission_export")
      expect(pre.ok).toBe(true)
      expect(pre.files[0].markdown).toContain(BLUEPRINT_HEADER)
    } finally {
      await c3.close().catch(() => undefined)
      await hostDefault.close()
    }
    // 3. a mission that does not exist
    expect(code(await call(swarm, "studio_mission_export", { mission: "2026-11-07_row120-nope" }))).toBe("MISSION_NOT_FOUND")
    // 4. a caller directory that may not be a session root (HOME itself, the app's Resources) gets no session at all
    for (const [label, cwd] of [
      ["HOME", HOME],
      ["Resources", RES],
    ] as const) {
      let refused = ""
      try {
        const c2 = await client(host.url, "swarm", cwd)
        await c2.close().catch(() => undefined)
      } catch (e) {
        refused = e instanceof Error ? e.message : String(e)
      }
      quote(`session with caller cwd = ${label}`, refused.slice(0, 160) || "accepted")
      expect(refused).not.toBe("")
    }
  })
})

describe("row 120: this task's whole blueprint and decisions as one mission (§12 row 120)", () => {
  const notes: ImportNote[] = []
  const refusedDecisions: Array<{ id: string; by: string; issues: string[] }> = []
  let blueprint = ""
  let decisionsMd = ""
  let statusMd = ""

  taskTest("load every row and decision, approve, bring the size-less rows (and their B closure) to done, export", async () => {
    const rows = bp.rows.map((r) => toMissionRow(r, notes))
    for (const r of rows) if (ROW_DECISION[r.id]) (r as S).decision = ROW_DECISION[r.id]
    // size is null only for rows recorded without one (rows 1-19 range line, 63, 65): they are history, so done.
    // A row is created pending, which needs a size: S stands in until the row is done, then size is set back to null.
    const sizeless = rows.filter((r) => r.size === null).map((r) => r.id)
    for (const r of rows) if (r.size === null) r.size = "S"
    // A decision the contract refuses (§5.2) is a hand error: reported, never copied or repaired.
    const { checkMissionSchema } = await import("../../src/store/mission/index.ts")
    const decisions = dec.decisions.map(({ line: _l, ...d }) => d).filter((d) => {
      const issues = checkMissionSchema("Decision", d)
      if (issues.length > 0) refusedDecisions.push({ id: d.id, by: d.by, issues: issues.map((i) => `${i.path} ${i.message}`) })
      return issues.length === 0
    })
    quote("hand-written decisions refused by studio.mission/v1 Decision", refusedDecisions)
    await ok(swarm, "studio_mission_create", {
      mission: {
        id: FULL,
        title: "Swarm 1.2.0 with DATUM built in, full dmg installer",
        type: "feature-release",
        owner: "master-controller",
        project: { dir: PROJECT },
        rows: [...rows.slice(0, 37), ...["38", "39", "40", "41"].map(droppedRow), ...rows.slice(37)],
        decisions,
      },
    })
    await ok(swarm, "studio_mission_approve", { mission: FULL, decision: "U14" })
    const order = doneOrder(rows, sizeless)
    for (const part of chunks(order.flatMap(toDone), 198)) await ok(swarm, "studio_mission_update_row", { mission: FULL, rows: part })
    await ok(swarm, "studio_mission_update_row", { mission: FULL, decision: "C19", rows: sizeless.map((id) => ({ id, set: { size: null } })) })
    const w = await ok(swarm, "studio_mission_export", { mission: FULL, files: ["blueprint", "status", "decisions"] })
    ;[blueprint, statusMd, decisionsMd] = w.files.map((f: S) => f.markdown)
    for (const f of w.files) writeFileSync(path.join(OUT, `full_${path.basename(f.path)}`), f.markdown)
    quote("full load", { rows: rows.length, dropped: 4, decisions: decisions.length, sizeless: sizeless.join(","), done: order.length })
    quote("full import notes", notes.map((n) => `${n.row}: ${n.note}`).filter((n) => !/range line/.test(n)))
  })

  taskTest("blueprint table: only the six rows of §10.3.1 differ, and only in Depends On (profile deps are the complete ones)", () => {
    const gen = tableAfter(blueprint, BLUEPRINT_HEADER).slice(2)
    const genById = new Map(gen.map((l) => [lineId(l), l]))
    const ids = bp.rows.map((r) => r.id)
    expect([...genById.keys()]).toEqual(ids)
    const differ = ids.filter((id) => genById.get(id) !== handById.get(id)!.bpLine.line)
    const d = diff(
      "full_blueprint",
      bp.rows.map((r) => r.bpLine.line),
      gen,
    )
    quote(`full blueprint: ${ids.length - differ.length} of ${ids.length} lines byte-equal; differ`, differ)
    quote("full blueprint diff", d.text)
    // explained: exactly the rows whose profile deps disagree with the table deps (§10.3.1; today 54, 82-84, 106, 118)
    // plus (row 120d) rows whose table Depends On holds a non-row token such as U23 (a decision id): skipped, so the cell differs.
    const lagging = [...new Set(notes.filter((n) => /^profile deps .* != table deps|is not a row id/.test(n.note)).map((n) => n.row))].sort((a, b) => ids.indexOf(a) - ids.indexOf(b))
    expect(differ).toEqual(lagging)
    for (const id of differ) {
      const g = genById.get(id)!.split(" | ")
      const h = handById.get(id)!.bpLine.line.split(" | ")
      expect(g.filter((c, i) => c !== h[i]).length).toBe(1) // one cell
      expect(g.findIndex((c, i) => c !== h[i])).toBe(4) // Depends On
    }
    expect(blueprint.split("\n")).toContain("Dropped: 38, 39, 40, 41 (C19)")
  })

  taskTest("profile table: every row that has a profile table line is byte-equal except the explained ones", () => {
    const gen = tableAfter(blueprint, PROFILE_HEADER).slice(2)
    const genById = new Map(gen.map((l) => [lineId(l), l]))
    const withLine = bp.rows.filter((r) => r.profileLine)
    const differ = withLine.filter((r) => genById.get(r.id) !== r.profileLine!.line).map((r) => r.id)
    const d = diff(
      "full_profile",
      withLine.map((r) => r.profileLine!.line),
      withLine.map((r) => genById.get(r.id)!),
    )
    quote(`full profile: ${withLine.length - differ.length} of ${withLine.length} table lines byte-equal; differ`, differ)
    quote("full profile diff", d.text)
    quote("profile rows without a table line (range line 1-19 or Profile: prose)", bp.rows.filter((r) => !r.profileLine).map((r) => r.id).join(","))
    // explained (today 48, 49, 63, 65): unparseable deps text -> table deps as B (48, 49); profile deps "-" while the
    // table has deps, and Model "-" -> tier inherit (63, 65). Every other profile table line is byte-equal.
    const explained = withLine
      .filter((r) => {
        const p = r.profile!
        return notes.some((n) => n.row === r.id && /not parseable/.test(n.note)) || (p.deps === "-" && r.bp[4].split(", ").some((d) => /^[1-9][0-9]{0,3}[a-z]?$/.test(d))) || p.model === "-"
      })
      .map((r) => r.id)
    expect(differ).toEqual(explained)
  })

  taskTest("decisions table: every decision the contract refuses is missing; a raw | differs only by the escape", () => {
    const gen = tableAfter(decisionsMd, DECISIONS_HEADER)
    const hand = [...dec.header.map((h) => h.line), ...dec.decisions.map((x) => x.line.line)]
    const d = diff("full_decisions", hand, gen)
    const genById = new Map(gen.slice(2).map((l) => [lineId(l), l]))
    const missing = dec.decisions.filter((x) => !genById.has(x.id)).map((x) => x.id)
    const differing = dec.decisions.filter((x) => genById.has(x.id) && genById.get(x.id) !== x.line.line).map((x) => x.id)
    quote(`full decisions: ${dec.decisions.length - missing.length - differing.length} of ${dec.decisions.length} lines byte-equal; missing`, missing)
    quote("full decisions: differing", differing)
    quote("full decisions diff", d.text)
    expect(gen.slice(0, 2)).toEqual(hand.slice(0, 2))
    expect(refusedDecisions.map((x) => x.id)).toEqual(missing)
    // explained: the contract refuses what studio.mission/v1 Decision rejects (e.g. a C id By User, §5.2); the refused list is
    // computed from the live file above, so none refused is valid; a raw | is escaped
    expect(differing).toEqual(dec.decisions.filter((x) => !missing.includes(x.id) && hasRawPipe(x.line.line)).map((x) => x.id))
    for (const id of differing) expect(genById.get(id)!.replace(/\\\|/g, "|")).toBe(dec.decisions.find((x) => x.id === id)!.line.line)
    // recorded order kept: the generated ids are the hand ids without the refused ones, in file order
    expect([...genById.keys()]).toEqual(dec.decisions.map((x) => x.id).filter((id) => !missing.includes(id)))
  })

  taskTest("status file of the whole task: counts quoted", () => {
    quote("full status_tasks.md", statusMd)
    expect(tableAfter(statusMd, "| Phase | Status |").length).toBe(2 + 5)
    expect(statusMd).toMatch(/^Snapshot [0-9a-z-]+ \(.+, reason export\); counts done \d+, running 0, blocked 0, needs-review 0, pending \d+, dropped 4\.$/m)
  })

  test("the host never called globalThis.fetch and logged no INTERNAL_ERROR", () => {
    expect(fetchCalls).toBe(0)
    expect(logs.filter((l) => l.level === "error" && /INTERNAL_ERROR/.test(JSON.stringify(l)))).toEqual([])
  })
})
