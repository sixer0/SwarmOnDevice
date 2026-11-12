// Row 119b: the mission tools and the mission semantics of the studio_report_* tools, through the REAL host server
// (startStudioHostServer, streamable HTTP on 127.0.0.1, MCP SDK client) over a temp store opened with
// missionGuard: true, exactly the way start.ts / the runner will after integration pass I-2.
// Mission contract §5.1, §6.2, §8 (masterplan/01_specs_mission_contract.md); decisions U19, U20, C57, C68, C71.
// Needs the command sandbox off (it binds a port; port 0 = ephemeral, no clash with other host tests).
// globalThis.fetch is a trap for the whole file: the host must never call it.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import path from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

const PKG = path.resolve(import.meta.dir, "..", "..")
const VENDOR = path.join(PKG, "vendor")
const TEMPLATES = path.join(PKG, "templates")
const BASE = process.env.ROW119B_TEST_DIR ?? "/private/tmp/claude-501/row119b/tests"
mkdirSync(BASE, { recursive: true })
const WORK = realpathSync(mkdtempSync(path.join(BASE, "row119b-")))
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
const FACTS = { home: HOME, resourcesPath: RES, execPath: path.join(WORK, "Swarm.app", "Contents", "MacOS", "Swarm") }

const realFetch = globalThis.fetch
let fetchCalls = 0
globalThis.fetch = (async () => {
  fetchCalls++
  throw new Error("row119b test: globalThis.fetch must not be called by the host")
}) as unknown as typeof fetch

/** 23 kept (row 31, U19) + 5 template tools (row 68, default since I-2) + 11 mission tools (C71). Exact names and order: 39 + studio_asset_put (row 50c, W-13) = 40. */
const EXPECTED_TOOLS = [
  "studio_registry",
  "studio_templates_list",
  "studio_template_get",
  "studio_document_create",
  "studio_chapter_import_markdown",
  "studio_chapter_submit",
  "studio_slot_fill",
  "studio_document_structure",
  "studio_document_status",
  "studio_document_get",
  "studio_render",
  "studio_file_verify",
  "studio_search",
  "studio_contracts_query",
  "studio_figure_preview",
  "studio_figure_revise",
  "studio_write",
  "studio_edit",
  "studio_report_template",
  "studio_report_check",
  "studio_report_submit",
  "studio_report_update",
  "studio_report_refresh",
  // I-2: the template tools (row 68) are registered by default before the mission tools.
  "studio_template_create",
  "studio_template_update",
  "studio_template_check",
  "studio_template_preview",
  "studio_template_archive",
  "studio_mission_create",
  "studio_mission_get",
  "studio_mission_list",
  "studio_mission_approve",
  "studio_mission_set_status",
  "studio_mission_update_row",
  "studio_mission_record_decision",
  "studio_mission_record_finding",
  "studio_mission_export",
  "studio_mission_request_decision",
  "studio_mission_answer_decision",
  // Row 50c (1.2.6, W-13): host built-in, last
  "studio_asset_put",
]

const M1 = "2026-11-07_m119b-feature"
const M2 = "2026-11-07_m119b-research"
const M0 = "2026-11-06_m119b-old"
const SES = "ses_0123456789abABCDEFGHIJKLMN" // ses_ + 12 hex + 14 base62 = 30

type Mod = typeof import("../../src/mcp-host/index.ts")
let mod: Mod
let bridge: typeof import("../../src/store-bridge/index.ts")
let store: Awaited<ReturnType<Mod["openHostStore"]>>
let host: Awaited<ReturnType<Mod["startStudioHostServer"]>>
let hostExp: Awaited<ReturnType<Mod["startStudioHostServer"]>>
let swarm: Client
let claude: Client
const logs: Array<{ level: string; source: string; message: string; context?: Record<string, unknown> }> = []
const log = (level: "info" | "warn" | "error", source: string, message: string, context?: Record<string, unknown>) => logs.push({ level, source, message, ...(context ? { context } : {}) })
const quoted: string[] = []
const quote = (label: string, v: unknown) => {
  const line = `${label}: ${JSON.stringify(v)}`
  quoted.push(line)
  console.log(`[row119b] ${line}`)
}

async function client(url: string, agent: string): Promise<Client> {
  const c = new Client({ name: "row119b-test", version: "0" })
  const t = new StreamableHTTPClientTransport(new URL(url), {
    fetch: realFetch as never,
    requestInit: { headers: { authorization: `Bearer ${TOKEN}`, "x-studio-agent": agent, "x-studio-caller-cwd": encodeURIComponent(PROJECT) } },
  })
  await c.connect(t)
  return c
}

type S = Record<string, any>
async function call(c: Client, name: string, args: Record<string, unknown>): Promise<S> {
  const r = await c.callTool({ name, arguments: args })
  return { ...((r.structuredContent ?? {}) as S), _isError: r.isError === true, _text: (r.content as Array<{ text?: string }>).map((x) => x.text ?? "").join("\n") }
}
const code = (r: S) => (r.ok === false ? r.code : "OK")

async function sql<T = S>(q: string, p: unknown[] = []): Promise<T[]> {
  return bridge.withStudioTx(async (tx) => tx.all(q, p as never) as T[])
}

function row(id: string, phase: string, kind: string, deps: string[] = [], over: S = {}) {
  return { id, phase, kind, title: `Row ${id}`, agent: "coder-execution", model: { tier: "thinker" }, deps, size: "S", status: "pending", output: `implementation/${id}.md`, verification: "tests pass", review: "gate", ...over }
}

function report(o: { mission?: string | null; docKey?: string | null; status?: string; taskRef?: string | null; owner?: string; title?: string }): string {
  const head = [
    `# ${o.title ?? "Laporan baris"}`,
    "",
    ...(o.mission ? [`mission: ${o.mission}`] : []),
    ...(o.docKey ? [`docKey: ${o.docKey}`] : []),
    `Status: ${o.status ?? "complete"}`,
    `Owner: ${o.owner ?? "coder-execution"}`,
    ...(o.taskRef ? [`TaskRef: ${o.taskRef}`] : []),
    "ReportedAt: 2026-11-07",
  ]
  return `${head.join("\n")}

## Ringkasan

Pekerjaan baris selesai ditulis dan diuji.

## Rincian kerja

| key | judul | status | owner | bukti |
|---|---|---|---|---|
| KUNCI-1 | Tulis kode | done | coder-execution | src/a.ts |

Kode ditulis lalu diuji.

## Bukti

Uji lulus 10 dari 10.

## Isu terbuka

Tidak ada.

## Langkah berikut

Kontroler meninjau.
`
}

const docsFor = (mission: string, docKey: string) => sql<{ id: string; current_revision_no: number }>("SELECT id, current_revision_no FROM document WHERE mission_folder = ? AND mission_doc_key = ?", [mission, docKey])
const rowStatus = async (mission: string, id: string) => (await call(swarm, "studio_mission_get", { mission, include: ["rows"] })).mission.rows.find((r: S) => r.id === id)?.status

const exportedFiles: string[] = []

beforeAll(async () => {
  mod = (await import("../../src/mcp-host/index.ts")) as Mod
  bridge = await import("../../src/store-bridge/index.ts")
  // Runner order (row 111) + row 119b: openHostStore with missionGuard -> configureTemplateSource -> start with the extension.
  store = await mod.openHostStore(STORE, { release: "1.2.0", logFile: LOG, missionGuard: true })
  mod.configureTemplateSource({ templatesDir: TEMPLATES, assetRepoRoot: VENDOR, release: "1.2.0" })
  // I-2: start.ts registers the mission tools by default (with row 120's renderer). A caller's own mission instance
  // replaces the default group: this host passes `exporter: null` (row 120 claim) so the "no renderer" case stays
  // provable; the second host passes the fake renderer.
  host = await mod.startStudioHostServer({ store, token: TOKEN, hostname: "127.0.0.1", port: 0, log, facts: FACTS, extensions: mod.missionHostExtension(store, { log, exporter: null }) })
  // A second host with a fake /docs renderer (row 120 seam) to prove the export write rules.
  const exporter = async ({ mission, files }: { mission: string; files: readonly string[] }) => files.map((f) => ({ path: f === "blueprint" ? "identification/02_structured_rows.md" : `${f}.md`, markdown: `# ${f} of ${mission}\n` }))
  hostExp = await mod.startStudioHostServer({ store, token: TOKEN, hostname: "127.0.0.1", port: 0, log, facts: FACTS, extensions: mod.missionHostExtension(store, { log, exporter }) })
  swarm = await client(host.url, "swarm")
  claude = await client(host.url, "claude")
})

afterAll(async () => {
  await swarm?.close().catch(() => undefined)
  await claude?.close().catch(() => undefined)
  await hostExp?.close()
  await host?.close()
  mod?.configureTemplateSource(null)
  if (store) await mod.closeHostStore(store)
  globalThis.fetch = realFetch
  writeFileSync(path.join(WORK, "quoted.txt"), quoted.join("\n") + "\n")
})

describe("row 119b: tool list and the wrapper seam", () => {
  test("tools/list = the exact 40 names in order (23 kept + 5 template + 11 mission + studio_asset_put); wrappers keep their slot", async () => {
    const tools = (await swarm.listTools()).tools
    const names = tools.map((t) => t.name)
    quote("tool count", names.length)
    expect(names).toEqual(EXPECTED_TOOLS)
    expect(names.length).toBe(40) // W-13 / row 50c: +studio_asset_put
    const props = (n: string) => Object.keys((tools.find((t) => t.name === n)!.inputSchema as S).properties ?? {})
    expect(props("studio_report_template")).toContain("row")
    expect(props("studio_report_check")).toContain("row")
    expect(props("studio_report_submit")).toEqual(expect.arrayContaining(["row", "session", "mission", "docKey"]))
    expect(props("studio_report_update")).toContain("session")
    expect(props("studio_report_refresh")).not.toContain("row")
  })

  test("assertExtensions: a wrapper must name a kept tool, once", async () => {
    const tt = await import("../../src/mcp-host/tool-table.ts")
    const w = { name: "studio_report_submit", title: "t", description: "d", inputSchema: { type: "object" }, toolsets: ["reports"] as const, wraps: true, call: async () => ({ content: [] }) }
    expect(() => tt.assertExtensions([w])).not.toThrow()
    expect(() => tt.assertExtensions([w, w])).toThrow(/wrapped twice/)
    expect(() => tt.assertExtensions([{ ...w, name: "studio_nope" }])).toThrow(/names no kept tool/)
    expect(() => tt.assertExtensions([{ ...w, wraps: false }])).toThrow(/duplicates/)
  })
})

describe("row 119b: create, approve, sessions", () => {
  test("dryRun create stores nothing; create M0, M1 (feature-release) and M2 (research), two of them linked to one session", async () => {
    const m1 = {
      id: M1,
      title: "Row 119b feature mission",
      type: "feature-release",
      owner: "master-controller",
      project: { dir: PROJECT },
      rows: [row("1", "implementation", "implementation"), row("2", "implementation", "implementation", ["1:B"]), row("3", "verification", "review"), row("4", "verification", "test", ["2:C"])],
      decisions: [
        { id: "U1", by: "user", date: "2026-11-07", text: "Approve the 119b test mission" },
        { id: "C1", by: "controller", date: "2026-11-07", text: "Controller note" },
      ],
    }
    const dry = await call(swarm, "studio_mission_create", { mission: m1, dryRun: true })
    expect(dry.ok).toBe(true)
    expect(dry.dryRun).toBe(true)
    expect(code(await call(swarm, "studio_mission_get", { mission: M1 }))).toBe("MISSION_NOT_FOUND")
    const c1 = await call(swarm, "studio_mission_create", { mission: m1, session: { ref: SES, role: "controller" }, actor: "master-controller" })
    quote("create M1", { ok: c1.ok, id: c1.id, status: c1.status, rows: c1.rows, waves: c1.waves })
    expect(c1).toMatchObject({ ok: true, id: M1, status: "draft", rows: 4 })
    const c2 = await call(swarm, "studio_mission_create", {
      mission: { id: M2, title: "Row 119b research mission", type: "research", owner: "master-controller", project: { dir: PROJECT }, rows: [row("1", "research", "research"), row("2", "synthesis", "synthesis", ["1:B"])], decisions: [{ id: "U1", by: "user", date: "2026-11-07", text: "go" }] },
      session: { ref: SES, role: "controller" },
    })
    expect(c2.ok).toBe(true)
    const c0 = await call(swarm, "studio_mission_create", { mission: { id: M0, title: "Old mission", type: "feature-release", owner: "master-controller", project: { dir: PROJECT }, rows: [row("1", "implementation", "implementation")], decisions: [{ id: "U1", by: "user", date: "2026-11-06", text: "go" }, { id: "U3", by: "user", date: "2026-11-06", text: "replaced by 119b feature" }] } })
    expect(c0.ok).toBe(true)
    expect(code(await call(swarm, "studio_mission_create", { mission: { ...m1, rows: [] } }))).toBe("MISSION_ID_TAKEN")
    const kind = await call(swarm, "studio_mission_create", { mission: { id: "2026-11-07_m119b-bad", title: "x", type: "research", owner: "x", project: { dir: PROJECT }, rows: [row("1", "synthesis", "implementation")] } })
    quote("research mission refuses implementation row", { code: kind.code, details: kind.error?.details })
    expect(code(kind)).toBe("KIND_NOT_ALLOWED")
  })

  test("one session holds two missions: studio_mission_list {session} returns both; a foreign session.client is AGENT_ID_LOCKED", async () => {
    const l = await call(swarm, "studio_mission_list", { session: { ref: SES } })
    const ids = l.items.map((m: S) => m.id).sort()
    quote("list {session}", ids)
    expect(ids).toEqual([M1, M2].sort())
    const locked = await call(swarm, "studio_mission_record_finding", { mission: M1, finding: { id: "1-X", severity: "low", title: "t", sourceRow: "1", ownerRow: "1", status: "open" }, session: { client: "claude", ref: "abc" } })
    expect(code(locked)).toBe("AGENT_ID_LOCKED")
    const bad = await call(swarm, "studio_mission_list", { take: 500 })
    expect(code(bad)).toBe("SCHEMA_INVALID")
  })

  test("approve: controller decision refused, user decision accepted", async () => {
    const r = await call(swarm, "studio_mission_approve", { mission: M1, decision: "C1" })
    quote("approve with C1", { code: r.code, details: r.error?.details })
    expect(code(r)).toBe("APPROVAL_NEEDS_USER_DECISION")
    const ok = await call(swarm, "studio_mission_approve", { mission: M1, decision: "U1" })
    expect(ok).toMatchObject({ ok: true, status: "approved" })
    expect((await call(swarm, "studio_mission_approve", { mission: M2, decision: "U1" })).ok).toBe(true)
    expect((await call(swarm, "studio_mission_approve", { mission: M0, decision: "U1" })).ok).toBe(true)
  })
})

describe("row 119b: report tools with mission semantics", () => {
  test("studio_report_template {mission, row} fills mission, docKey, TaskRef, Owner; unknown mission/row refused early", async () => {
    const t = await call(swarm, "studio_report_template", { mission: M1, row: "1" })
    expect(t.ok).toBe(true)
    const tpl = String(t.template)
    for (const line of [`mission: ${M1}`, "docKey: row-1", "TaskRef: 1", "Owner: coder-execution"]) expect(tpl).toContain(line)
    quote("template head", tpl.split("\n").slice(2, 9))
    const j = await call(swarm, "studio_report_template", { mission: M1, row: "1", format: "json" })
    expect(String(j.template)).toContain('"taskRef": "1"')
    expect(code(await call(swarm, "studio_report_template", { mission: "2026-11-07_nope", row: "1" }))).toBe("MISSION_NOT_FOUND")
    expect(code(await call(swarm, "studio_report_template", { mission: M1, row: "99" }))).toBe("ROW_UNKNOWN")
    expect(code(await call(swarm, "studio_report_template", { row: "1" }))).toBe("MISSION_REQUIRED")
  })

  test("a report without a mission id is refused MISSION_REQUIRED and stores nothing; check reports it as an issue", async () => {
    const before = (await sql<{ n: number }>("SELECT count(*) AS n FROM document"))[0].n
    const r = await call(swarm, "studio_report_submit", { markdown: report({ docKey: "row-1", taskRef: "1" }) })
    quote("submit without mission", { code: r.code, isError: r._isError, message: r.error?.message })
    expect(code(r)).toBe("MISSION_REQUIRED")
    expect((await sql<{ n: number }>("SELECT count(*) AS n FROM document"))[0].n).toBe(before)
    const c = await call(swarm, "studio_report_check", { markdown: report({ docKey: "row-1", taskRef: "1" }), remote: false })
    expect(c.valid).toBe(false)
    expect(c.missionIssues.map((i: S) => i.code)).toContain("MISSION_REQUIRED")
  })

  test("check runs the §6.2 mission checks: clean report valid, wrong TaskRef / unknown row / B dep open are issues", async () => {
    const good = await call(swarm, "studio_report_check", { markdown: report({ mission: M1, docKey: "row-1", taskRef: "1" }), remote: false })
    expect(good.missionIssues).toEqual([])
    expect(good.valid).toBe(true)
    const wrong = await call(swarm, "studio_report_check", { markdown: report({ mission: M1, docKey: "row-1", taskRef: "3" }), remote: false })
    expect(wrong.missionIssues.map((i: S) => i.code)).toEqual(["DOC_KEY_MISMATCH"])
    const unknown = await call(swarm, "studio_report_check", { markdown: report({ mission: M1, taskRef: "9" }), row: "9", remote: false })
    expect(unknown.missionIssues.map((i: S) => i.code)).toEqual(["ROW_UNKNOWN"])
    const dep = await call(swarm, "studio_report_check", { markdown: report({ mission: M1, taskRef: "2" }), row: "2", remote: false })
    quote("check row 2 before row 1 is done", dep.missionIssues)
    expect(dep.valid).toBe(false)
    expect(dep.missionIssues.map((i: S) => i.code)).toEqual(["DEP_NOT_DONE"])
  })

  test("submit per row: row 1 complete -> needs-review, mission approved -> running; one link per document", async () => {
    const r = await call(swarm, "studio_report_submit", { markdown: report({ mission: M1, taskRef: "1" }), row: "1", session: { ref: SES, role: "driver" } })
    quote("submit row 1", { ok: r.ok, mission: r.mission, documentId: r.documentId })
    expect(r.ok).toBe(true)
    expect(r.mission).toMatchObject({ id: M1, kind: "row", row: "1", docKey: "row-1", reportStatus: "complete", rowStatus: "needs-review", missionStatus: "running" })
    const link = await sql("SELECT mission_id, kind, row_id FROM mission_report WHERE document_id = ?", [r.documentId])
    expect(link).toEqual([{ mission_id: M1, kind: "row", row_id: "1" }])
    expect(await rowStatus(M1, "1")).toBe("needs-review")
  })

  test("refusals roll back the whole job: DEP_NOT_DONE, TaskRef mismatch, docKey/row disagreement, draft mission", async () => {
    const dep = await call(swarm, "studio_report_submit", { markdown: report({ mission: M1, taskRef: "2" }), row: "2" })
    quote("submit row 2 with B dep open", { code: dep.code, details: dep.error?.details })
    expect(code(dep)).toBe("DEP_NOT_DONE")
    expect(await docsFor(M1, "row-2")).toEqual([])
    const tr = await call(swarm, "studio_report_submit", { markdown: report({ mission: M1, taskRef: "4" }), row: "3" })
    expect(code(tr)).toBe("DOC_KEY_MISMATCH")
    expect(await docsFor(M1, "row-3")).toEqual([])
    const dk = await call(swarm, "studio_report_submit", { markdown: report({ mission: M1, docKey: "row-4", taskRef: "3" }), row: "3" })
    expect(code(dk)).toBe("DOC_KEY_MISMATCH")
    await call(swarm, "studio_mission_create", { mission: { id: "2026-11-07_m119b-draft", title: "draft", type: "research", owner: "x", project: { dir: PROJECT }, rows: [row("1", "research", "research")] } })
    const draft = await call(swarm, "studio_report_submit", { markdown: report({ mission: "2026-11-07_m119b-draft", taskRef: "1" }), row: "1" })
    expect(code(draft)).toBe("MISSION_NOT_APPROVED")
    expect(await docsFor("2026-11-07_m119b-draft", "row-1")).toEqual([])
  })

  test("controller accepts row 1 (done); row 2 then reports; update with blocked moves it to blocked; a done row is ROW_CLOSED", async () => {
    expect((await call(swarm, "studio_mission_update_row", { mission: M1, rows: [{ id: "1", status: "done" }] })).ok).toBe(true)
    const r2 = await call(swarm, "studio_report_submit", { markdown: report({ mission: M1, taskRef: "2", status: "partial" }), row: "2" })
    expect(r2.mission).toMatchObject({ row: "2", rowStatus: "needs-review" })
    // refused AFTER the vendored write (stored TaskRef 4 != row 2): job rolled back, session basis restored
    const revBefore = (await docsFor(M1, "row-2"))[0].current_revision_no
    const bad = await call(swarm, "studio_report_update", { documentId: r2.documentId, markdown: report({ taskRef: "4", status: "blocked" }) })
    quote("update row 2 with TaskRef 4", { code: bad.code, details: bad.error?.details })
    expect(code(bad)).toBe("DOC_KEY_MISMATCH")
    expect((await docsFor(M1, "row-2"))[0].current_revision_no).toBe(revBefore)
    const up = await call(swarm, "studio_report_update", { documentId: r2.documentId, markdown: report({ taskRef: "2", status: "blocked" }) })
    quote("update row 2 blocked", { ok: up.ok, mission: up.mission })
    expect(up.ok).toBe(true)
    expect(up.mission).toMatchObject({ id: M1, row: "2", reportStatus: "blocked", rowStatus: "blocked", changed: true })
    const got = (await call(swarm, "studio_mission_get", { mission: M1 })).mission.rows.find((r: S) => r.id === "2")
    expect(got.note).toBe(`blocked: report ${r2.documentId} rev ${up.mission.revisionNo}`)
    const r1docs = await docsFor(M1, "row-1")
    const closed = await call(swarm, "studio_report_update", { documentId: r1docs[0].id, markdown: report({ taskRef: "1" }) })
    expect(code(closed)).toBe("ROW_CLOSED")
  })

  test("update of a document without a mission link is REPORT_NOT_IN_MISSION", async () => {
    const doc = await call(swarm, "studio_document_create", { template: "datum-gsp", mission: "2026-11-07_row119b", docKey: "client-doc", title: "Dokumen klien row 119b" })
    expect(doc.ok).toBe(true)
    const r = await call(swarm, "studio_report_update", { documentId: doc.documentId, markdown: report({ taskRef: "1" }), baseRev: 1 })
    quote("update unlinked document", { code: r.code })
    expect(code(r)).toBe("REPORT_NOT_IN_MISSION")
  })
})

describe("row 119b: paused, superseded, decisions, messages", () => {
  test("paused: a report on a row in flight is accepted, a pending or blocked row cannot (re)start (MISSION_PAUSED); resume", async () => {
    const docs = await docsFor(M1, "row-2")
    // row 2 is blocked (previous test): while paused, a non-blocked report would restart it -> refused by the store rule
    expect((await call(swarm, "studio_mission_set_status", { mission: M1, to: "paused", note: "owner break" })).to).toBe("paused")
    const restart = await call(swarm, "studio_report_update", { documentId: docs[0].id, markdown: report({ taskRef: "2", status: "complete" }) })
    quote("update blocked row 2 on paused mission", { code: restart.code })
    expect(code(restart)).toBe("MISSION_PAUSED")
    expect((await call(swarm, "studio_mission_set_status", { mission: M1, to: "running" })).to).toBe("running")
    const back = await call(swarm, "studio_report_update", { documentId: docs[0].id, markdown: report({ taskRef: "2", status: "complete" }) })
    expect(back.mission).toMatchObject({ row: "2", rowStatus: "needs-review" })
    expect((await call(swarm, "studio_mission_set_status", { mission: M1, to: "paused", note: "owner break 2" })).to).toBe("paused")
    const inflight = await call(swarm, "studio_report_update", { documentId: docs[0].id, markdown: report({ taskRef: "2", status: "partial" }) })
    quote("update in-flight row 2 (needs-review) on paused mission", { ok: inflight.ok, mission: inflight.mission ?? null })
    expect(inflight.mission).toMatchObject({ row: "2", rowStatus: "needs-review", missionStatus: "paused", reportStatus: "partial" })
    const pending = await call(swarm, "studio_report_submit", { markdown: report({ mission: M1, taskRef: "3" }), row: "3" })
    quote("submit pending row on paused mission", { code: pending.code })
    expect(code(pending)).toBe("MISSION_PAUSED")
    expect(await docsFor(M1, "row-3")).toEqual([])
    expect((await call(swarm, "studio_mission_set_status", { mission: M1, to: "running" })).to).toBe("running")
  })

  test("superseded: M0 cancelled with supersededBy M1; reports and writes on M0 are MISSION_CLOSED", async () => {
    const rep = await call(swarm, "studio_report_submit", { markdown: report({ mission: M0, taskRef: "1" }), row: "1" })
    expect(rep.ok).toBe(true)
    expect(code(await call(swarm, "studio_mission_set_status", { mission: M0, to: "cancelled", supersededBy: M0, decision: "U3" }))).toBe("SUPERSEDE_TARGET")
    const c = await call(swarm, "studio_mission_set_status", { mission: M0, to: "cancelled", decision: "U3", supersededBy: M1 })
    expect(c).toMatchObject({ ok: true, from: "running", to: "cancelled" })
    const g = await call(swarm, "studio_mission_get", { mission: M0 })
    quote("M0 after cancel", { status: g.mission.status, supersededBy: g.mission.supersededBy })
    expect(g.mission).toMatchObject({ status: "cancelled", supersededBy: M1 })
    const up = await call(swarm, "studio_report_update", { documentId: rep.documentId, markdown: report({ taskRef: "1", status: "partial" }) })
    expect(code(up)).toBe("MISSION_CLOSED")
    const sub = await call(swarm, "studio_report_submit", { markdown: report({ mission: M0, taskRef: "1", status: "partial" }), row: "1" })
    expect(code(sub)).toBe("MISSION_CLOSED")
    expect(code(await call(swarm, "studio_mission_update_row", { mission: M0, rows: [{ id: "1", note: "x" }] }))).toBe("MISSION_CLOSED")
  })

  test("decision request D-1 blocks row 3, then answered by the user (U2) releases it", async () => {
    const req = await call(swarm, "studio_mission_request_decision", {
      mission: M1,
      request: { id: "D-1", question: "Which reviewer checks row 3?", context: "Row 3 is the review row", options: [{ id: "A", label: "senior-code-reviewer", consequence: "deeper review" }, { id: "B", label: "verifier", consequence: "faster" }], recommended: "A", blockingRows: ["3"] },
    })
    expect(req.ok).toBe(true)
    const blocked = await call(swarm, "studio_mission_update_row", { mission: M1, rows: [{ id: "3", status: "running" }] })
    quote("row 3 while D-1 open", { code: blocked.code, details: blocked.error?.details })
    expect(code(blocked)).toBe("DECISION_PENDING")
    const chk = await call(swarm, "studio_report_check", { markdown: report({ mission: M1, taskRef: "3" }), row: "3", remote: false })
    expect(chk.missionIssues.map((i: S) => i.code)).toEqual(["DECISION_PENDING"])
    const ans = await call(claude, "studio_mission_answer_decision", { mission: M1, request: "D-1", option: "A", by: "user", decisionId: "U2" })
    quote("answer D-1", { decision: ans.decision, released: ans.released })
    expect(ans).toMatchObject({ ok: true, released: ["3"], decision: { id: "U2", by: "user" } })
    expect(code(await call(swarm, "studio_mission_answer_decision", { mission: M1, request: "D-1", option: "B", by: "user", decisionId: "U3" }))).toBe("DECISION_REQUEST_CLOSED")
    const g = await call(swarm, "studio_mission_get", { mission: M1, include: ["decisions", "requests"] })
    expect(g.mission.decisions.map((d: S) => d.id)).toContain("U2")
    expect(g.requests[0]).toMatchObject({ id: "D-1", status: "answered", answer: { option: "A", by: "user", decision: "U2" } })
    expect((await call(swarm, "studio_mission_update_row", { mission: M1, rows: [{ id: "3", status: "running" }] })).changed).toEqual(["3"])
  })

  test("owner instruction and messages are stored and read back; a checkpoint is separate from mission progress", async () => {
    const r = await call(swarm, "studio_mission_update_row", {
      mission: M1,
      rows: [{ id: "3", checkpoint: { n: 1, m: 4, label: "read inputs" } }],
      messages: [
        { from: "owner", to: "controller", kind: "instruction", text: "Stop row 4 until the review is in" },
        { from: "agent", to: "controller", kind: "question", text: "May I reuse the row 2 fixture?", row: "3" },
      ],
    })
    expect(r.ok).toBe(true)
    const g = await call(swarm, "studio_mission_get", { mission: M1, include: ["messages", "checkpoints"] })
    quote("messages read back", g.messages.map((m: S) => ({ from: m.from, to: m.to, kind: m.kind, text: m.text })))
    expect(g.messages[0]).toMatchObject({ from: "owner", to: "controller", kind: "instruction", text: "Stop row 4 until the review is in" })
    expect(g.messages[1]).toMatchObject({ from: "agent", kind: "question", row: "3" })
    expect(g.derived.checkpoints["3"]).toMatchObject({ n: 1, m: 4, label: "read inputs" })
    expect(g.derived.progress).toEqual({ done: 1, total: 4 })
  })

  test("findings and decisions through the tools; a malformed record is SCHEMA_INVALID", async () => {
    expect((await call(swarm, "studio_mission_record_decision", { mission: M1, decision: { id: "C2", by: "controller", date: "2026-11-07", text: "Row 1 accepted" } })).id).toBe("C2")
    expect(code(await call(swarm, "studio_mission_record_decision", { mission: M1, decision: { id: "C2", by: "controller", date: "2026-11-07", text: "again" } }))).toBe("DECISION_ID_TAKEN")
    expect(code(await call(swarm, "studio_mission_record_decision", { mission: M1, decision: { id: "U9", by: "controller", date: "2026-11-07", text: "bad" } }))).toBe("SCHEMA_INVALID")
    expect((await call(swarm, "studio_mission_record_finding", { mission: M1, finding: { id: "2-H1", severity: "high", title: "Leak", sourceRow: "2", ownerRow: "2", status: "open" } })).status).toBe("open")
    const l = await call(swarm, "studio_mission_list", { q: "Leak" })
    expect(l.items.map((m: S) => m.id)).toContain(M1)
  })
})

describe("row 119b: export seam (row 120 renderer)", () => {
  test("without a renderer: EXPORT_NOT_AVAILABLE", async () => {
    expect(code(await call(swarm, "studio_mission_export", { mission: M1 }))).toBe("EXPORT_NOT_AVAILABLE")
  })

  test("with a renderer: files under <session root>/docs/<mission>/ only, FILE_EXISTS without overwrite, .bak with overwrite", async () => {
    const c = await client(hostExp.url, "swarm")
    try {
      const preview = await call(c, "studio_mission_export", { mission: M1, files: ["decisions"] })
      expect(preview.written).toBe(false)
      expect(existsSync(path.join(PROJECT, "docs"))).toBe(false)
      const w = await call(c, "studio_mission_export", { mission: M1, write: true })
      expect(w.files.map((f: S) => f.path)).toEqual([`docs/${M1}/identification/02_structured_rows.md`, `docs/${M1}/status.md`, `docs/${M1}/decisions.md`, `docs/${M1}/delegation.md`])
      for (const f of w.files) exportedFiles.push(f.path)
      expect(readFileSync(path.join(PROJECT, "docs", M1, "decisions.md"), "utf8")).toBe(`# decisions of ${M1}\n`)
      expect(code(await call(c, "studio_mission_export", { mission: M1, write: true }))).toBe("FILE_EXISTS")
      expect((await call(c, "studio_mission_export", { mission: M1, files: ["decisions"], write: true, overwrite: true })).ok).toBe(true)
      // 1.2.6 row 89 (T-17, INTENT dirname only): the backup sits in <dir>/.bak/, not beside the file.
      expect(readdirSync(path.join(PROJECT, "docs", M1, ".bak")).some((n) => n.startsWith("decisions.md.bak-"))).toBe(true)
    } finally {
      await c.close().catch(() => undefined)
    }
  })
})

describe("row 119b: store-level checks and gaps", () => {
  test("every stored work report of a mission has its mission_report link; the event trail holds the report events", async () => {
    const orphans = await sql("SELECT d.id, d.mission_folder, d.mission_doc_key FROM document d LEFT JOIN mission_report r ON r.document_id = d.id WHERE d.contract_kind = 'agentWorkReport' AND r.document_id IS NULL")
    quote("work reports without link", orphans)
    expect(orphans).toEqual([])
    const ev = (await call(swarm, "studio_mission_get", { mission: M1, include: ["events"] })).events.filter((e: S) => e.verb === "report").length
    expect(ev).toBeGreaterThan(3)
  })

  test("refresh is unchanged: a write outside the session root is refused", async () => {
    const docs = await docsFor(M1, "row-2")
    const r = await call(swarm, "studio_report_refresh", { documentId: docs[0].id, markdown: report({ taskRef: "2" }), outPath: "/private/tmp/claude-501/row119b/outside.md" })
    expect(code(r)).toBe("PATH_OUTSIDE_ROOTS")
  })

  test("GAP CLOSED (row 119c): a work report document made by studio_document_create for an unregistered mission is refused, nothing stored", async () => {
    // claude client: its own rate bucket (the swarm agent created many documents above)
    const r = await call(claude, "studio_document_create", { template: "laporan-kerja-agen", mission: "2026-11-07_unlinked", docKey: "row-1", title: "Laporan tanpa misi" })
    const stored = await sql("SELECT d.contract_kind, r.document_id AS link FROM document d LEFT JOIN mission_report r ON r.document_id = d.id WHERE d.mission_folder = ?", ["2026-11-07_unlinked"])
    quote("GAP document_create laporan-kerja-agen for an unknown mission (guard on)", { ok: r.ok, code: r.code ?? null, stored })
    // Row 119c (C81) closed the gap with the studio_document_create wrapper: refused MISSION_NOT_FOUND, nothing stored.
    expect(r.ok).toBe(false)
    expect(r.code).toBe("MISSION_NOT_FOUND")
    expect(stored.length).toBe(0)
  })

  test("the host never called globalThis.fetch", () => {
    expect(fetchCalls).toBe(0)
    const errors = logs.filter((l) => l.level === "error" && /INTERNAL_ERROR/.test(JSON.stringify(l)))
    expect(errors).toEqual([])
  })
})
