// Row 119c (C77, C81; U19): with missionGuard on, studio_document_create and studio_write can no longer store a work
// report without a mission. Through the REAL host server with its DEFAULT extensions (no `extensions` passed: start.ts
// registers the template and mission groups, I-2) over a temp store opened with missionGuard: true, the way the
// desktop runner opens it (host-runner.ts, I-2 item 4). Mission contract §5.1 "One guard for every path", §6.2.
// Needs the command sandbox off (it binds a port; port 0 = ephemeral). globalThis.fetch is a trap: never called.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import path from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

const PKG = path.resolve(import.meta.dir, "..", "..")
const VENDOR = path.join(PKG, "vendor")
const TEMPLATES = path.join(PKG, "templates")
const BASE = process.env.ROW119C_TEST_DIR ?? "/private/tmp/claude-501/row119c/tests"
mkdirSync(BASE, { recursive: true })
const WORK = realpathSync(mkdtempSync(path.join(BASE, "row119c-")))
const STORE = path.join(WORK, "datum-studio")
const LOG = path.join(WORK, "logs", "store.jsonl")
const HOME = path.join(WORK, "home")
const RES = path.join(WORK, "Swarm.app", "Contents", "Resources")
const PROJECT = path.join(HOME, "project-a")
for (const d of [HOME, RES, PROJECT]) mkdirSync(d, { recursive: true })

const TOKEN = "d".repeat(16) + "0123456789abcdef".repeat(3)
const FACTS = { home: HOME, resourcesPath: RES, execPath: path.join(WORK, "Swarm.app", "Contents", "MacOS", "Swarm") }

const realFetch = globalThis.fetch
let fetchCalls = 0
globalThis.fetch = (async () => {
  fetchCalls++
  throw new Error("row119c test: globalThis.fetch must not be called by the host")
}) as unknown as typeof fetch

const M = "2026-11-07_m119c-feature"
const MD = "2026-11-07_m119c-draft"
const UNLINKED = "2026-11-07_unlinked"
const CLIENT = "2026-11-07_m119c-client"
const REPORT_TEMPLATE = "laporan-kerja-agen"

type Mod = typeof import("../../src/mcp-host/index.ts")
let mod: Mod
let bridge: typeof import("../../src/store-bridge/index.ts")
let store: Awaited<ReturnType<Mod["openHostStore"]>>
let host: Awaited<ReturnType<Mod["startStudioHostServer"]>>
let swarm: Client
let claude: Client
const logs: Array<{ level: string; source: string; message: string; context?: Record<string, unknown> }> = []
const log = (level: "info" | "warn" | "error", source: string, message: string, context?: Record<string, unknown>) => logs.push({ level, source, message, ...(context ? { context } : {}) })
const quoted: string[] = []
const quote = (label: string, v: unknown) => {
  const line = `${label}: ${JSON.stringify(v)}`
  quoted.push(line)
  console.log(`[row119c] ${line}`)
}

async function resetProcessCaches() {
  const { resetStudioEnvCache } = await import("../../vendor/src/lib/studio/contract/env")
  const { resetBridgePdfReadiness } = await import("../../vendor/src/lib/studio/services/render")
  const { resetRenderRateLimiter } = await import("../../vendor/src/lib/studio/http/render-guard")
  resetStudioEnvCache()
  resetBridgePdfReadiness()
  resetRenderRateLimiter()
  delete process.env.DATUM_RENDER_SOCKET
  delete process.env.DATUM_RENDER_TOKEN
}

async function client(url: string, agent: string): Promise<Client> {
  const c = new Client({ name: "row119c-test", version: "0" })
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

/** Rows of every table a refused write could touch. */
async function counts() {
  const one = async (t: string) => Number((await sql<{ n: number }>(`SELECT count(*) AS n FROM ${t}`))[0].n)
  return { document: await one("document"), revision: await one("revision"), mission_report: await one("mission_report"), mission_event: await one("mission_event") }
}

function row(id: string, phase: string, kind: string, deps: string[] = []) {
  return { id, phase, kind, title: `Row ${id}`, agent: "coder-execution", model: { tier: "thinker" }, deps, size: "S", status: "pending", output: `implementation/${id}.md`, verification: "tests pass", review: "gate" }
}

const SECTIONS = [
  { heading: "Ringkasan", blocks: ["Pekerjaan baris selesai ditulis dan diuji."] },
  { heading: "Rincian kerja", blocks: [[["judul", "status"], ["Tulis kode", "selesai"]]] },
  { heading: "Bukti", blocks: ["Uji lulus 10 dari 10."] },
  { heading: "Isu terbuka", blocks: ["Tidak ada."] },
  { heading: "Langkah berikut", blocks: ["Kontroler meninjau."] },
]
const rowStatus = async (mission: string, id: string) => (await call(swarm, "studio_mission_get", { mission, include: ["rows"] })).mission.rows.find((r: S) => r.id === id)?.status

/** A refused call must store nothing: every count equal before and after. */
async function refusedNothingStored(label: string, c: Client, tool: string, args: Record<string, unknown>, expected: string) {
  const before = await counts()
  const r = await call(c, tool, args)
  const after = await counts()
  quote(label, { code: r.code ?? null, isError: r._isError, before, after })
  expect(code(r)).toBe(expected)
  expect(r._isError).toBe(true)
  expect(after).toEqual(before)
  return r
}

beforeAll(async () => {
  await resetProcessCaches()
  process.env.STUDIO_WORKSPACE_ROOT = STORE
  process.env.STUDIO_ASSETS_ROOT = path.join(VENDOR, "src", "lib", "studio", "assets")
  process.env.STUDIO_VENDOR_ROOT = VENDOR
  delete process.env.STUDIO_MCP_FILE_ROOTS
  delete process.env.INTERNAL_API_SECRET
  mod = (await import("../../src/mcp-host/index.ts")) as Mod
  bridge = await import("../../src/store-bridge/index.ts")
  // Runner order (row 111) with the desktop's store option (I-2 item 4): missionGuard true. Default extensions.
  store = await mod.openHostStore(STORE, { release: "1.2.0", logFile: LOG, missionGuard: true })
  mod.configureTemplateSource({ templatesDir: TEMPLATES, assetRepoRoot: VENDOR, release: "1.2.0" })
  host = await mod.startStudioHostServer({ store, token: TOKEN, hostname: "127.0.0.1", port: 0, log, facts: FACTS })
  swarm = await client(host.url, "swarm")
  claude = await client(host.url, "claude")
})

afterAll(async () => {
  await swarm?.close().catch(() => undefined)
  await claude?.close().catch(() => undefined)
  await host?.close()
  mod?.configureTemplateSource(null)
  if (store) await mod.closeHostStore(store)
  globalThis.fetch = realFetch
  await resetProcessCaches()
  writeFileSync(path.join(WORK, "quoted.txt"), quoted.join("\n") + "\n")
})

describe("row 119c: the wrappers and the report-kind rule", () => {
  test("default host: 39 tools, studio_document_create / studio_write keep their slot and carry the row 119c guard", async () => {
    const tools = (await swarm.listTools()).tools
    const names = tools.map((t) => t.name)
    quote("tool count", names.length)
    expect(names.length).toBe(39)
    expect(names.indexOf("studio_document_create")).toBe(3)
    expect(names.indexOf("studio_write")).toBe(16)
    for (const n of ["studio_document_create", "studio_write"]) {
      const t = tools.find((x) => x.name === n)!
      expect(t.description).toContain("row 119c")
      expect(Object.keys((t.inputSchema as S).properties)).toEqual(expect.arrayContaining(["mission", "docKey", "session"]))
    }
  })

  test("report kind = the template's stored contract kind is the registry work-report kind (+ the registry's own slug)", async () => {
    const { getContractKindDef } = await import("../../vendor/src/lib/studio/registry/contracts")
    const { CONTRACT_KINDS } = await import("../../vendor/src/lib/studio/contract/enums")
    const { WORK_REPORT_CONTRACT_KIND } = await import("../../src/store/mission/index.ts")
    const { isReportTemplate } = await import("../../src/mcp-host/mission/guard-writes.ts")
    expect(CONTRACT_KINDS as readonly string[]).toContain(WORK_REPORT_CONTRACT_KIND)
    expect(getContractKindDef(WORK_REPORT_CONTRACT_KIND)?.templateSlug).toBe(REPORT_TEMPLATE)
    // Built-in template rows are seeded on first use, so here the table may still be empty: the registry slug alone
    // must already count (fail closed).
    const seeded = await sql<{ n: number }>("SELECT count(*) AS n FROM template")
    const verdict = await bridge.withStudioTx(async (tx) => ({ report: isReportTemplate(tx, REPORT_TEMPLATE), client: isReportTemplate(tx, "datum-gsp"), unknown: isReportTemplate(tx, "user-tidak-ada") }))
    quote("isReportTemplate before seeding", { templateRows: seeded[0].n, ...verdict })
    expect(verdict).toEqual({ report: true, client: false, unknown: false })
    // The column rule (any slug, e.g. a user copy): exactly the stored contract_kind.
    const fakeTx = (kind: string | null) => ({ get: () => ({ contract_kind: kind }) }) as never
    expect(isReportTemplate(fakeTx(WORK_REPORT_CONTRACT_KIND), "user-salinan-laporan")).toBe(true)
    expect(isReportTemplate(fakeTx(null), "user-nota")).toBe(false)
  })

  test("a store opened without missionGuard gets no write wrappers (row 119a D5 opt-in)", async () => {
    const { guardWriteWrappers, storeMissionGuard } = await import("../../src/mcp-host/mission/guard-writes.ts")
    expect(storeMissionGuard(store)).toBe(true)
    expect(storeMissionGuard({ missionGuard: false })).toBe(false)
    expect(guardWriteWrappers({ missionGuard: false } as never, { log }).length).toBe(0)
  })
})

describe("row 119c: setup", () => {
  test("mission M (feature-release, approved) and MD (draft)", async () => {
    const c = await call(swarm, "studio_mission_create", {
      mission: {
        id: M,
        title: "Row 119c feature mission",
        type: "feature-release",
        owner: "master-controller",
        project: { dir: PROJECT },
        rows: [row("1", "implementation", "implementation"), row("2", "implementation", "implementation", ["1:B"]), row("3", "verification", "review")],
        decisions: [{ id: "U1", by: "user", date: "2026-11-07", text: "Approve the 119c test mission" }],
      },
    })
    expect(c).toMatchObject({ ok: true, id: M, status: "draft" })
    expect((await call(swarm, "studio_mission_approve", { mission: M, decision: "U1" })).ok).toBe(true)
    const d = await call(swarm, "studio_mission_create", { mission: { id: MD, title: "Row 119c draft", type: "feature-release", owner: "master-controller", project: { dir: PROJECT }, rows: [row("1", "implementation", "implementation")] } })
    expect(d.ok).toBe(true)
  })
})

describe("row 119c: refusals store nothing", () => {
  test("studio_document_create on the report template: no mission -> MISSION_REQUIRED; unknown mission -> MISSION_NOT_FOUND", async () => {
    await refusedNothingStored("document_create report, mission absent", claude, "studio_document_create", { template: REPORT_TEMPLATE, docKey: "row-1", title: "Laporan tanpa misi" }, "MISSION_REQUIRED")
    await refusedNothingStored("document_create report, mission empty", claude, "studio_document_create", { template: REPORT_TEMPLATE, mission: "", docKey: "row-1", title: "Laporan tanpa misi" }, "MISSION_REQUIRED")
    await refusedNothingStored("document_create report, mission not registered (row 119b gap case)", claude, "studio_document_create", { template: REPORT_TEMPLATE, mission: UNLINKED, docKey: "row-1", title: "Laporan tanpa misi" }, "MISSION_NOT_FOUND")
    await refusedNothingStored("document_create report, docKey not row-<n>/delegation", claude, "studio_document_create", { template: REPORT_TEMPLATE, mission: M, docKey: "lap-1", title: "Laporan" }, "DOC_KEY_MISMATCH")
    await refusedNothingStored("document_create report, unknown row", claude, "studio_document_create", { template: REPORT_TEMPLATE, mission: M, docKey: "row-9", title: "Laporan" }, "ROW_UNKNOWN")
    await refusedNothingStored("document_create report, draft mission", claude, "studio_document_create", { template: REPORT_TEMPLATE, mission: MD, docKey: "row-1", title: "Laporan" }, "MISSION_NOT_APPROVED")
    const left = await sql("SELECT id FROM document WHERE mission_folder IN (?, ?, ?)", [UNLINKED, M, MD])
    expect(left).toEqual([])
  })

  test("studio_write work report (no template): no mission -> MISSION_REQUIRED; unknown mission, TaskRef, deps, draft refused", async () => {
    await refusedNothingStored("write report, mission absent", swarm, "studio_write", { docKey: "row-1", meta: { status: "complete", taskRef: "1" }, sections: SECTIONS }, "MISSION_REQUIRED")
    await refusedNothingStored("write report, mission not registered", swarm, "studio_write", { mission: UNLINKED, docKey: "row-1", meta: { status: "complete", taskRef: "1" }, sections: SECTIONS }, "MISSION_NOT_FOUND")
    // the vendored alias missionFolder is seen as the mission (normalizeWriteArgs on a copy)
    await refusedNothingStored("write report, alias missionFolder not registered", swarm, "studio_write", { missionFolder: UNLINKED, docKey: "row-1", meta: { status: "complete", taskRef: "1" }, sections: SECTIONS }, "MISSION_NOT_FOUND")
    await refusedNothingStored("write report, TaskRef missing", swarm, "studio_write", { mission: M, docKey: "row-1", meta: { status: "complete" }, sections: SECTIONS }, "DOC_KEY_MISMATCH")
    await refusedNothingStored("write report, B dep open", swarm, "studio_write", { mission: M, docKey: "row-2", meta: { status: "complete", taskRef: "2" }, sections: SECTIONS }, "DEP_NOT_DONE")
    await refusedNothingStored("write report, draft mission", swarm, "studio_write", { mission: MD, docKey: "row-1", meta: { status: "complete", taskRef: "1" }, sections: SECTIONS }, "MISSION_NOT_APPROVED")
    expect(await rowStatus(M, "1")).toBe("pending")
  })
})

describe("row 119c: with a mission, stored and linked in one job, row effect applied", () => {
  test("studio_write row 1 complete -> link {row 1}, row needs-review, mission running", async () => {
    const before = await counts()
    const r = await call(swarm, "studio_write", { mission: M, docKey: "row-1", meta: { status: "complete", taskRef: "1" }, sections: SECTIONS })
    quote("write row 1", { ok: r.ok, code: r.code ?? null, mission: r.mission })
    expect(r.ok).toBe(true)
    expect(r.mission).toMatchObject({ id: M, kind: "row", row: "1", docKey: "row-1", reportStatus: "complete", rowStatus: "needs-review", missionStatus: "running", changed: true })
    const link = await sql("SELECT r.mission_id, r.kind, r.row_id, d.contract_kind, d.contract_task_ref FROM mission_report r JOIN document d ON d.id = r.document_id WHERE d.mission_folder = ? AND d.mission_doc_key = ?", [M, "row-1"])
    quote("link row 1", link)
    expect(link).toEqual([{ mission_id: M, kind: "row", row_id: "1", contract_kind: "agentWorkReport", contract_task_ref: "1" }])
    const after = await counts()
    expect(after.document).toBe(before.document + 1)
    expect(after.mission_report).toBe(before.mission_report + 1)
    expect(await rowStatus(M, "1")).toBe("needs-review")
  })

  test("studio_write again on row 1 (rewrite of a linked report) -> applyReport: blocked", async () => {
    const r = await call(swarm, "studio_write", { mission: M, docKey: "row-1", meta: { status: "blocked", taskRef: "1" }, sections: SECTIONS.map((s, i) => (i === 3 ? { heading: s.heading, blocks: ["Menunggu keputusan."] } : s)) })
    quote("rewrite row 1 blocked", { ok: r.ok, code: r.code ?? null, mission: r.mission })
    expect(r.ok).toBe(true)
    expect(r.mission).toMatchObject({ id: M, row: "1", reportStatus: "blocked", rowStatus: "blocked", changed: true })
    expect(await rowStatus(M, "1")).toBe("blocked")
    expect((await sql("SELECT count(*) AS n FROM mission_report r JOIN document d ON d.id = r.document_id WHERE d.mission_folder = ?", [M]))[0].n).toBe(1)
  })

  test("studio_document_create on the report template for row 3 -> stored and linked, draft = no row effect; repeat is unchanged", async () => {
    const before = await counts()
    const r = await call(claude, "studio_document_create", { template: REPORT_TEMPLATE, mission: M, docKey: "row-3", title: "Laporan baris 3" })
    quote("document_create row 3", { ok: r.ok, code: r.code ?? null, mission: r.mission })
    expect(r.ok).toBe(true)
    expect(r.mission).toMatchObject({ id: M, kind: "row", row: "3", docKey: "row-3", reportStatus: "draft", changed: true })
    const link = await sql("SELECT r.kind, r.row_id FROM mission_report r JOIN document d ON d.id = r.document_id WHERE d.mission_folder = ? AND d.mission_doc_key = ?", [M, "row-3"])
    expect(link).toEqual([{ kind: "row", row_id: "3" }])
    expect(await rowStatus(M, "3")).toBe("pending")
    expect((await counts()).document).toBe(before.document + 1)
    const again = await call(claude, "studio_document_create", { template: REPORT_TEMPLATE, mission: M, docKey: "row-3", title: "Laporan baris 3" })
    quote("document_create row 3 again", { ok: again.ok, mission: again.mission })
    expect(again.ok).toBe(true)
    expect(again.mission).toMatchObject({ row: "3", changed: false })
    expect((await counts()).document).toBe(before.document + 1)
  })

  test("studio_document_create delegation report -> link kind delegation", async () => {
    const r = await call(claude, "studio_document_create", { template: REPORT_TEMPLATE, mission: M, docKey: "delegation", title: "Laporan delegasi" })
    expect(r.ok).toBe(true)
    expect(r.mission).toMatchObject({ id: M, kind: "delegation", docKey: "delegation" })
    const link = await sql("SELECT r.kind, r.row_id FROM mission_report r JOIN document d ON d.id = r.document_id WHERE d.mission_folder = ? AND d.mission_doc_key = ?", [M, "delegation"])
    expect(link).toEqual([{ kind: "delegation", row_id: null }])
  })
})

describe("row 119c: non-report documents are unchanged", () => {
  test("studio_document_create datum-gsp and studio_write template latest create without a mission entity", async () => {
    const d = await call(swarm, "studio_document_create", { template: "datum-gsp", mission: CLIENT, docKey: "client-doc", title: "Dokumen klien row 119c" })
    quote("document_create client", { ok: d.ok, code: d.code ?? null, mission: d.mission ?? null })
    expect(d.ok).toBe(true)
    expect(d.mission).toBeUndefined()
    const w = await call(swarm, "studio_write", { mission: CLIENT, docKey: "nota-1", template: "latest", meta: { title: "Nota klien row 119c", author: "Agen Uji", number: "UJI-119C/2026" }, sections: [{ heading: "Isi", blocks: ["Nota uji untuk dokumen klien."] }] })
    quote("write client", { ok: w.ok, code: w.code ?? null, mission: w.mission ?? null })
    expect(w.ok).toBe(true)
    expect(w.mission).toBeUndefined()
    const stored = await sql("SELECT d.mission_doc_key, d.contract_kind, r.document_id AS link FROM document d LEFT JOIN mission_report r ON r.document_id = d.id WHERE d.mission_folder = ? ORDER BY d.mission_doc_key", [CLIENT])
    quote("client documents", stored)
    expect(stored).toEqual([
      { mission_doc_key: "client-doc", contract_kind: null, link: null },
      { mission_doc_key: "nota-1", contract_kind: null, link: null },
    ])
  })
})

describe("row 119c: outside this row's two tools (gap filed by row 119c, closed by row 119d)", () => {
  test("studio_chapter_import_markdown {mission, docKey, template: report} on an unregistered mission -> MISSION_NOT_FOUND, nothing stored (was the KNOWN GAP)", async () => {
    // Row 119d (C85): this test recorded the gap (ok, an unlinked agentWorkReport stored); it is now the refusal test.
    const before = await counts()
    const r = await call(claude, "studio_chapter_import_markdown", { mission: "2026-11-07_unlinked-import", docKey: "row-1", template: REPORT_TEMPLATE, docTitle: "Laporan lewat impor bab", chapterKey: "1", markdown: "# Ringkasan\n\nPekerjaan selesai.\n", submit: true })
    const stored = await sql("SELECT d.contract_kind, r.document_id AS link FROM document d LEFT JOIN mission_report r ON r.document_id = d.id WHERE d.mission_folder = ?", ["2026-11-07_unlinked-import"])
    const after = await counts()
    quote("chapter_import_markdown on the report template, unregistered mission (gap closed by row 119d)", { ok: r.ok, code: r.code ?? null, stored, before, after })
    expect(code(r)).toBe("MISSION_NOT_FOUND")
    expect(stored).toEqual([])
    expect(after).toEqual(before)
  })
})

describe("row 119c: store-wide", () => {
  test("no work report without a mission link; the host never called fetch; no INTERNAL_ERROR", async () => {
    const orphans = await sql("SELECT d.id, d.mission_folder, d.mission_doc_key FROM document d LEFT JOIN mission_report r ON r.document_id = d.id WHERE d.contract_kind = 'agentWorkReport' AND r.document_id IS NULL")
    quote("work reports without link", orphans)
    expect(orphans).toEqual([])
    // after seeding, the only template with a contract kind is the registry's work-report template
    const kinds = await sql("SELECT slug, contract_kind FROM template WHERE contract_kind IS NOT NULL ORDER BY slug")
    quote("templates with a contract kind (seeded)", kinds)
    expect(kinds).toEqual([{ slug: REPORT_TEMPLATE, contract_kind: "agentWorkReport" }])
    expect(fetchCalls).toBe(0)
    expect(logs.filter((l) => l.level === "error" && /INTERNAL_ERROR/.test(JSON.stringify(l)))).toEqual([])
  })
})
