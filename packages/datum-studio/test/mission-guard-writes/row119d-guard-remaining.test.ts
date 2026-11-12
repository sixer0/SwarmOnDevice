// Row 119d (C85; U19): with missionGuard on, the R12/R13 create path (vendor services/submit/pipeline.ts, create on a
// missing target) can no longer store a work report without a mission: studio_chapter_import_markdown,
// studio_chapter_submit and studio_slot_fill are wrapped like row 119c's two tools. Through the REAL host server with
// its DEFAULT extensions over a temp store opened with missionGuard: true (as the desktop runner opens it).
// Mission contract §5.1 "One guard for every path", §6.2. Needs the command sandbox off (binds an ephemeral port).
// globalThis.fetch is a trap: never called.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import path from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

const PKG = path.resolve(import.meta.dir, "..", "..")
const VENDOR = path.join(PKG, "vendor")
const TEMPLATES = path.join(PKG, "templates")
const BASE = process.env.ROW119D_TEST_DIR ?? "/private/tmp/claude-501/row119d/tests"
mkdirSync(BASE, { recursive: true })
const WORK = realpathSync(mkdtempSync(path.join(BASE, "row119d-")))
const STORE = path.join(WORK, "datum-studio")
const LOG = path.join(WORK, "logs", "store.jsonl")
const HOME = path.join(WORK, "home")
const RES = path.join(WORK, "Swarm.app", "Contents", "Resources")
const PROJECT = path.join(HOME, "project-a")
for (const d of [HOME, RES, PROJECT]) mkdirSync(d, { recursive: true })

const TOKEN = "e".repeat(16) + "0123456789abcdef".repeat(3)
const FACTS = { home: HOME, resourcesPath: RES, execPath: path.join(WORK, "Swarm.app", "Contents", "MacOS", "Swarm") }

const realFetch = globalThis.fetch
let fetchCalls = 0
globalThis.fetch = (async () => {
  fetchCalls++
  throw new Error("row119d test: globalThis.fetch must not be called by the host")
}) as unknown as typeof fetch

const M = "2026-11-07_m119d-feature"
const MD = "2026-11-07_m119d-draft"
const UNLINKED = "2026-11-07_m119d-unregistered"
const CLIENT = "2026-11-07_m119d-client"
const REPORT_TEMPLATE = "laporan-kerja-agen"
const CHAPTER_MD = "# Ringkasan\n\nPekerjaan baris selesai ditulis dan diuji.\n"

type Mod = typeof import("../../src/mcp-host/index.ts")
let mod: Mod
let bridge: typeof import("../../src/store-bridge/index.ts")
let store: Awaited<ReturnType<Mod["openHostStore"]>>
let host: Awaited<ReturnType<Mod["startStudioHostServer"]>>
let claude: Client
let swarm: Client
const logs: Array<{ level: string; source: string; message: string; context?: Record<string, unknown> }> = []
const log = (level: "info" | "warn" | "error", source: string, message: string, context?: Record<string, unknown>) => logs.push({ level, source, message, ...(context ? { context } : {}) })
const quoted: string[] = []
const quote = (label: string, v: unknown) => {
  const line = `${label}: ${JSON.stringify(v)}`
  quoted.push(line)
  console.log(`[row119d] ${line}`)
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
  const c = new Client({ name: "row119d-test", version: "0" })
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

async function counts() {
  const one = async (t: string) => Number((await sql<{ n: number }>(`SELECT count(*) AS n FROM ${t}`))[0].n)
  return { document: await one("document"), revision: await one("revision"), mission_report: await one("mission_report"), mission_event: await one("mission_event") }
}

function row(id: string, phase: string, kind: string, deps: string[] = []) {
  return { id, phase, kind, title: `Row ${id}`, agent: "coder-execution", model: { tier: "thinker" }, deps, size: "S", status: "pending", output: `implementation/${id}.md`, verification: "tests pass", review: "gate" }
}
const rowStatus = async (mission: string, id: string) => (await call(swarm, "studio_mission_get", { mission, include: ["rows"] })).mission.rows.find((r: S) => r.id === id)?.status
const linkAt = (mission: string, docKey: string) =>
  sql("SELECT d.id, d.contract_kind, d.current_revision_no AS rev, r.mission_id, r.kind, r.row_id FROM document d LEFT JOIN mission_report r ON r.document_id = d.id WHERE d.mission_folder = ? AND d.mission_doc_key = ?", [mission, docKey])

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

const importArgs = (mission: string, docKey: string | null, extra: Record<string, unknown> = {}) => ({
  mission,
  ...(docKey !== null ? { docKey } : {}),
  template: REPORT_TEMPLATE,
  docTitle: "Laporan row 119d",
  chapterKey: "1",
  markdown: CHAPTER_MD,
  submit: true,
  ...extra,
})

/** A valid studio.chapter/v2 body from the vendored importer (check only, nothing stored), with a chosen target. */
let chapterBody: S
const submission = (target: S, template: string | null = REPORT_TEMPLATE): S => {
  const { target: _t, template: _tpl, baseRevisionNo: _b, ...rest } = chapterBody
  return { ...rest, target, ...(template !== null ? { template: { slug: template } } : {}) }
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

describe("row 119d: wrappers and the public flag", () => {
  test("default host: 40 tools; the three create-path tools keep their slot and carry the row 119d guard", async () => {
    const tools = (await swarm.listTools()).tools
    const names = tools.map((t) => t.name)
    const { GUARDED_CREATE_TOOLS } = await import("../../src/mcp-host/mission/index.ts")
    quote("tool count + slots", { count: names.length, slots: Object.fromEntries(GUARDED_CREATE_TOOLS.map((n) => [n, names.indexOf(n)])) })
    expect(names.length).toBe(40) // W-13 / row 50c: +studio_asset_put
    for (const n of GUARDED_CREATE_TOOLS) {
      const t = tools.find((x) => x.name === n)!
      expect(t.description).toContain("row 119d")
      expect(Object.keys((t.inputSchema as S).properties)).toContain("session")
    }
  })

  test("the wrapper reads the store's public getter missionGuardEnabled (no private field)", async () => {
    const { guardWriteWrappers, storeMissionGuard } = await import("../../src/mcp-host/mission/guard-writes.ts")
    expect((store as unknown as { missionGuardEnabled: boolean }).missionGuardEnabled).toBe(true)
    expect(storeMissionGuard(store)).toBe(true)
    expect(storeMissionGuard({ missionGuard: true })).toBe(false) // the private field name alone no longer counts
    expect(guardWriteWrappers({ missionGuardEnabled: false } as never, { log }).length).toBe(0)
    expect(guardWriteWrappers({ missionGuardEnabled: true, missions: {} } as never, { log }).map((w) => w.name)).toEqual([
      "studio_document_create",
      "studio_write",
      "studio_chapter_import_markdown",
      "studio_chapter_submit",
      "studio_slot_fill",
    ])
  })
})

describe("row 119d: setup", () => {
  test("mission M (approved; row 2 has B dep on 1) and MD (draft); a valid chapter body from the importer", async () => {
    const c = await call(swarm, "studio_mission_create", {
      mission: {
        id: M,
        title: "Row 119d feature mission",
        type: "feature-release",
        owner: "master-controller",
        project: { dir: PROJECT },
        rows: [row("1", "implementation", "implementation"), row("2", "implementation", "implementation", ["1:B"]), row("3", "verification", "review"), row("4", "verification", "review")],
        decisions: [{ id: "U1", by: "user", date: "2026-11-07", text: "Approve the 119d test mission" }],
      },
    })
    expect(c).toMatchObject({ ok: true, id: M })
    expect((await call(swarm, "studio_mission_approve", { mission: M, decision: "U1" })).ok).toBe(true)
    expect((await call(swarm, "studio_mission_create", { mission: { id: MD, title: "Row 119d draft", type: "feature-release", owner: "master-controller", project: { dir: PROJECT }, rows: [row("1", "implementation", "implementation")] } })).ok).toBe(true)
    const before = await counts()
    const check = await call(claude, "studio_chapter_import_markdown", { ...importArgs(UNLINKED, "row-1"), submit: false, detail: true })
    expect(check.ok).toBe(true)
    expect(check.submitted).toBe(false)
    expect(await counts()).toEqual(before) // check only (submit false) passes through and stores nothing
    chapterBody = check.submission
    quote("importer chapter body keys", Object.keys(chapterBody).sort())
    expect(chapterBody.$schema).toBe("studio.chapter/v2")
  })
})

describe("row 119d: report template without a registered mission is refused, nothing stored", () => {
  test("studio_chapter_import_markdown (the row 119c gap): unregistered mission -> MISSION_NOT_FOUND; docKey, row, draft mission refused", async () => {
    await refusedNothingStored("import report, mission not registered", claude, "studio_chapter_import_markdown", importArgs(UNLINKED, "row-1"), "MISSION_NOT_FOUND")
    await refusedNothingStored("import report, no docKey (docKey = template slug)", claude, "studio_chapter_import_markdown", importArgs(M, null), "DOC_KEY_MISMATCH")
    await refusedNothingStored("import report, unknown row", claude, "studio_chapter_import_markdown", importArgs(M, "row-9"), "ROW_UNKNOWN")
    await refusedNothingStored("import report, draft mission", claude, "studio_chapter_import_markdown", importArgs(MD, "row-1"), "MISSION_NOT_APPROVED")
    expect(await sql("SELECT id FROM document WHERE mission_folder IN (?, ?, ?)", [UNLINKED, M, MD])).toEqual([])
  })

  test("studio_chapter_submit: docNumber target (no mission) -> MISSION_REQUIRED; unregistered mission -> MISSION_NOT_FOUND", async () => {
    await refusedNothingStored("chapter_submit report, docNumber target without mission", claude, "studio_chapter_submit", { submission: submission({ docNumber: "UJI-119D/0001" }) }, "MISSION_REQUIRED")
    // with a basis the vendored preflight lets a docNumber target through to R12 (a create on a missing number)
    await refusedNothingStored("chapter_submit report, docNumber target with basis, without mission", claude, "studio_chapter_submit", { submission: { ...submission({ docNumber: "UJI-119D/0002" }), baseRevisionNo: 1 } }, "MISSION_REQUIRED")
    await refusedNothingStored("chapter_submit report, mission not registered", claude, "studio_chapter_submit", { submission: submission({ mission: { folder: UNLINKED }, docKey: "row-1" }) }, "MISSION_NOT_FOUND")
    await refusedNothingStored("chapter_submit report, draft mission", claude, "studio_chapter_submit", { submission: submission({ mission: { folder: MD }, docKey: "row-1" }) }, "MISSION_NOT_APPROVED")
    expect(await sql("SELECT id FROM document WHERE doc_number IN (?, ?) OR mission_folder IN (?, ?)", ["UJI-119D/0001", "UJI-119D/0002", UNLINKED, MD])).toEqual([])
  })

  test("studio_slot_fill can only target an existing document: a missing documentId runs guarded and stores nothing", async () => {
    // The vendored tool sends target {documentId} only (doc-tools.ts slotFillTool), so it has no template and no create.
    // The vendored refusal is returned unchanged (its own isError convention: a fixable 4xx is not an MCP error).
    const before = await counts()
    const r = await call(claude, "studio_slot_fill", { documentId: "c119d000000000000000000000", slot: "references", payload: { type: "sourceRegister", entries: [{ id: "S1", citation: { text: "Sumber uji" } }] }, baseRevisionNo: 1 })
    const after = await counts()
    quote("slot_fill on a missing documentId", { code: r.code ?? null, isError: r._isError, before, after })
    expect(code(r)).toBe("DOCUMENT_NOT_FOUND")
    expect(after).toEqual(before)
  })
})

describe("row 119d: with a registered mission, stored + linked + row effect in one job", () => {
  test("studio_chapter_import_markdown row 1 -> new report linked {row 1}; draft = no row change, first report starts the approved mission (§5.1)", async () => {
    const before = await counts()
    const r = await call(claude, "studio_chapter_import_markdown", importArgs(M, "row-1"))
    quote("import row 1", { ok: r.ok, code: r.code ?? null, mission: r.mission ?? null })
    expect(r.ok).toBe(true)
    expect(r.mission).toMatchObject({ id: M, kind: "row", row: "1", docKey: "row-1", reportStatus: "draft", rowStatus: "pending", missionStatus: "running", changed: true })
    const link = await linkAt(M, "row-1")
    quote("link row 1", link)
    expect(link).toMatchObject([{ contract_kind: "agentWorkReport", mission_id: M, kind: "row", row_id: "1" }])
    const after = await counts()
    expect(after.document).toBe(before.document + 1)
    expect(after.mission_report).toBe(before.mission_report + 1)
    expect(after.mission_event).toBeGreaterThan(before.mission_event) // the link's event is written in the same job
    expect(await rowStatus(M, "1")).toBe("pending")
  })

  test("studio_chapter_submit mission target row 3 and delegation -> new reports linked", async () => {
    const r3 = await call(claude, "studio_chapter_submit", { submission: submission({ mission: { folder: M }, docKey: "row-3" }) })
    quote("chapter_submit row 3", { ok: r3.ok, code: r3.code ?? null, mission: r3.mission ?? null })
    expect(r3.ok).toBe(true)
    expect(r3.mission).toMatchObject({ id: M, kind: "row", row: "3", docKey: "row-3", changed: true })
    expect(await linkAt(M, "row-3")).toMatchObject([{ contract_kind: "agentWorkReport", mission_id: M, kind: "row", row_id: "3" }])
    const del = await call(claude, "studio_chapter_submit", { submission: submission({ mission: { folder: M }, docKey: "delegation" }) })
    expect(del.ok).toBe(true)
    expect(del.mission).toMatchObject({ id: M, kind: "delegation", docKey: "delegation" })
    expect(await linkAt(M, "delegation")).toMatchObject([{ kind: "delegation", row_id: null }])
  })

  test("import row 4 -> linked draft; the row stays pending (a chapter-only create carries no record status)", async () => {
    // The status lives in the record slot (contractRecord); a report created by one chapter is a draft (§5.1: no row
    // change). Non-draft row effects come from studio_write / studio_report_submit / update (rows 119b, 119c).
    const r = await call(claude, "studio_chapter_import_markdown", importArgs(M, "row-4"))
    expect(r.ok).toBe(true)
    expect(r.mission).toMatchObject({ row: "4", reportStatus: "draft" })
    expect(await rowStatus(M, "4")).toBe("pending")
  })
})

describe("row 119d: existing documents pass through", () => {
  test("a linked report can still be edited by chapter import, chapter submit and slot fill (documentId target)", async () => {
    const [doc] = await linkAt(M, "row-1")
    const before = await counts()
    const imp = await call(claude, "studio_chapter_import_markdown", { documentId: doc.id, chapterKey: "1", markdown: "# Ringkasan\n\nPekerjaan diperbarui.\n", submit: true, baseRevisionNo: Number(doc.rev) })
    quote("edit linked report: import", { ok: imp.ok, code: imp.code ?? null, mission: imp.mission ?? null })
    expect(imp.ok).toBe(true)
    expect(imp.mission).toBeUndefined()
    const rev1 = Number((await linkAt(M, "row-1"))[0].rev)
    const sub = await call(claude, "studio_chapter_submit", { submission: { $schema: chapterBody.$schema, agentId: chapterBody.agentId, target: { documentId: doc.id }, chapter: chapterBody.chapter, baseRevisionNo: rev1 } })
    quote("edit linked report: chapter_submit", { ok: sub.ok, code: sub.code ?? null, error: sub.ok ? null : sub._text.slice(0, 600) })
    expect(sub.ok).toBe(true)
    const rev2 = Number((await linkAt(M, "row-1"))[0].rev)
    const slot = await call(claude, "studio_slot_fill", { documentId: doc.id, slot: "references", payload: { type: "sourceRegister", entries: [{ id: "S1", citation: { text: "Sumber uji row 119d" } }] }, baseRevisionNo: rev2 })
    quote("edit linked report: slot_fill references", { ok: slot.ok, code: slot.code ?? null, error: slot.ok ? null : slot._text.slice(0, 900) })
    expect(slot.ok).toBe(true)
    const after = await counts()
    const link = await linkAt(M, "row-1")
    quote("linked report after edits", { link, before, after })
    expect(after.document).toBe(before.document)
    expect(after.mission_report).toBe(before.mission_report)
    expect(after.revision).toBeGreaterThan(before.revision)
    expect(link).toMatchObject([{ id: doc.id, mission_id: M, row_id: "1" }])
  })

  test("mission + docKey target of an existing linked report passes through (an edit, not a create)", async () => {
    const [doc] = await linkAt(M, "row-3")
    const before = await counts()
    const r = await call(claude, "studio_chapter_import_markdown", { ...importArgs(M, "row-3"), baseRevisionNo: Number(doc.rev), markdown: "# Ringkasan\n\nBaris 3 diperbarui.\n" })
    quote("edit linked report by mission+docKey", { ok: r.ok, code: r.code ?? null, mission: r.mission ?? null })
    expect(r.ok).toBe(true)
    expect(r.mission).toBeUndefined()
    expect((await counts()).mission_report).toBe(before.mission_report)
  })
})

describe("row 119d: non-report documents are unchanged", () => {
  test("chapter import and chapter submit on a client template create without a mission entity", async () => {
    const imp = await call(claude, "studio_chapter_import_markdown", { mission: CLIENT, docKey: "client-1", template: "datum-gsp", docTitle: "Dokumen klien row 119d", chapterKey: "1", markdown: "# Pendahuluan\n\nIsi dokumen klien.\n", submit: true })
    quote("import client", { ok: imp.ok, code: imp.code ?? null, mission: imp.mission ?? null })
    expect(imp.ok).toBe(true)
    expect(imp.mission).toBeUndefined()
    const sub = await call(claude, "studio_chapter_submit", { submission: submission({ mission: { folder: CLIENT }, docKey: "client-2" }, "datum-gsp") })
    quote("chapter_submit client", { ok: sub.ok, code: sub.code ?? null, mission: sub.mission ?? null })
    expect(sub.ok).toBe(true)
    expect(sub.mission).toBeUndefined()
    const stored = await sql("SELECT d.mission_doc_key, d.contract_kind, r.document_id AS link FROM document d LEFT JOIN mission_report r ON r.document_id = d.id WHERE d.mission_folder = ? ORDER BY d.mission_doc_key", [CLIENT])
    quote("client documents", stored)
    expect(stored).toEqual([
      { mission_doc_key: "client-1", contract_kind: null, link: null },
      { mission_doc_key: "client-2", contract_kind: null, link: null },
    ])
  })
})

describe("row 119d: store-wide", () => {
  test("no work report without a mission link; the host never called fetch; no INTERNAL_ERROR", async () => {
    const orphans = await sql("SELECT d.id, d.mission_folder, d.mission_doc_key FROM document d LEFT JOIN mission_report r ON r.document_id = d.id WHERE d.contract_kind = 'agentWorkReport' AND r.document_id IS NULL")
    quote("work reports without link", orphans)
    expect(orphans).toEqual([])
    expect(fetchCalls).toBe(0)
    expect(logs.filter((l) => l.level === "error" && /INTERNAL_ERROR/.test(JSON.stringify(l)))).toEqual([])
  })
})
