// 1.3.3 row 68 (MC-8 items 1-2, 4, 6-7; U16): a verified studio_render copies DOCX, PDF and HTML into
// <project>/deliverables/<mission id>/ and lists them on the mission row, through the REAL host server
// (startStudioHostServer, streamable HTTP on 127.0.0.1, MCP SDK client) over a temp store opened with
// missionGuard: true, as desktop does. Harness of test/verify-render/row154-render-verify.test.ts.
// The render bridge is a transport stub (`setRenderBridgeTransport`, as rows
// 32/67/151/151b): Electron cannot run under bun. What the page scripts measure on real Electron is row 151's and
// row 151b's evidence; here the stub stands for a bridge that has (or lacks) row 152's allow-list entry.
// Needs the command sandbox off (binds an ephemeral port). globalThis.fetch is a trap: the host must never call it.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs"
import path from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { PERSON_KEY, personCaller } from "../mission-tools/_attested-person.ts"
import * as runtime from "../../vendor/src/lib/studio/engine/browser/runtime"
import { MEASURE_SCRIPT } from "../../vendor/src/lib/studio/engine/browser/measure"
import { OVERLAP_SCRIPT, OVERLAP_SCRIPT_NAME } from "../../src/mcp-host/verify/overlap-script"

const PKG = path.resolve(import.meta.dir, "..", "..")
const VENDOR = path.join(PKG, "vendor")
const TEMPLATES = path.join(PKG, "templates")
const BASE = process.env.ROW68_TEST_DIR ?? path.join(process.env.TMPDIR ?? "/private/tmp/claude-501", "row68", "tests")
mkdirSync(BASE, { recursive: true })
const WORK = realpathSync(mkdtempSync(path.join(BASE, "row68-")))
const STORE = path.join(WORK, "datum-studio")
const LOG = path.join(WORK, "logs", "store.jsonl")
const HOME = path.join(WORK, "home")
const RES = path.join(WORK, "Swarm.app", "Contents", "Resources")
const PROJECT = path.join(HOME, "project-68")
for (const d of [HOME, RES, PROJECT]) mkdirSync(d, { recursive: true })

const ENV_KEYS = ["STUDIO_WORKSPACE_ROOT", "STUDIO_ASSETS_ROOT", "STUDIO_VENDOR_ROOT", "STUDIO_MCP_FILE_ROOTS", "INTERNAL_API_SECRET", "DATUM_RENDER_SOCKET", "STUDIO_VERIFY_BUDGET_MS"] as const
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))

async function resetEnvCache() {
  const { resetStudioEnvCache } = await import("../../vendor/src/lib/studio/contract/env")
  const { resetRenderRateLimiter } = await import("../../vendor/src/lib/studio/http/render-guard")
  const { resetQueryRateLimiter } = await import("../../vendor/src/lib/studio/http/quota")
  const { resetImportRateLimiter } = await import("../../src/mcp-host/local-api/routes/import-rate.ts")
  const { resetValidateRateLimiter } = await import("../../src/mcp-host/local-api/routes/validate-rate.ts")
  resetStudioEnvCache()
  resetRenderRateLimiter()
  resetQueryRateLimiter()
  resetImportRateLimiter()
  resetValidateRateLimiter()
}

const TOKEN = "f".repeat(16) + "0123456789abcdef".repeat(3)
const FACTS = { home: HOME, resourcesPath: RES, execPath: path.join(WORK, "Swarm.app", "Contents", "MacOS", "Swarm") }
const M = "2026-11-17_m68-feature"

const realFetch = globalThis.fetch
globalThis.fetch = (async () => {
  throw new Error("row68 test: globalThis.fetch must not be called by the host")
}) as unknown as typeof fetch

type Mod = typeof import("../../src/mcp-host/index.ts")
type S = Record<string, any>
let mod: Mod
let store: Awaited<ReturnType<Mod["openHostStore"]>>
let host: Awaited<ReturnType<Mod["startStudioHostServer"]>>
let c: Client
const hostLog: Array<{ level: string; source: string; message: string; context?: Record<string, unknown> }> = []
const log = (level: "info" | "warn" | "error", source: string, message: string, context?: Record<string, unknown>) => {
  hostLog.push({ level, source, message, context })
  if (level === "error") console.log(`[row68] host error ${source}: ${message} ${JSON.stringify(context ?? {}).slice(0, 400)}`)
}
const quote = (label: string, v: unknown) => console.log(`[row68] ${label}: ${JSON.stringify(v)}`)

// ── render bridge stub ───────────────────────────────────────────────────────────────────────────────────────
// A locked-down bridge (same handshake fields as row 151's stub). measure: one paged sheet per `<section class="page"`
// with one text element per sheet; pdf: a PDF whose page count equals the sheets of the HTML it was given;
// overlap: clean, a B1 overlap, or refused like an app without row 152's entry; pagePng: writes small files.
const GOOD_INFO = { electron: "42.3.3", chrome: "142.0.0.0", partition: "datum-render", sandbox: true, contextIsolation: true, nodeIntegration: false, javascriptContent: false, network: "blocked", fonts: 16, scripts: ["studio.measure", OVERLAP_SCRIPT_NAME] }
type Bridge = { overlap: "clean" | "overlap" | "not-allowed"; down: boolean; pagePng: boolean; seen: S[] }
const bridge: Bridge = { overlap: "clean", down: false, pagePng: true, seen: [] }
const sheetsOf = (html: string) => Math.max(1, (html.match(/<section\b[^>]*class="[^"]*\bpage\b/g) ?? []).length)
const fakePdf = (pages: number) => Buffer.from(`%PDF-1.4\n1 0 obj<</Type /Pages /Count ${pages}>>endobj\n%%EOF\n`, "latin1")
let overlapAddress = "1.1"

function installBridge() {
  runtime.setRenderBridgeTransport(async (req) => {
    bridge.seen.push({ op: req.op, script: req.script === MEASURE_SCRIPT ? "measure" : req.script === OVERLAP_SCRIPT ? "overlap" : undefined, pages: req.pages })
    if (bridge.down) throw new Error("connect ENOENT /no/bridge.sock")
    if (req.op === "hello") return { ok: true, ...GOOD_INFO }
    if (req.op === "pdf") {
      const src = String(req.src ?? "")
      const html = typeof req.html === "string" ? req.html : existsSync(src) ? readFileSync(src, "utf8") : ""
      writeFileSync(String(req.dst), fakePdf(sheetsOf(html)))
      return { ok: true, electron: "42.3.3", dst: req.dst }
    }
    if (req.op === "checkPage") {
      const html = String(req.html ?? "")
      const n = sheetsOf(html)
      if (req.script === MEASURE_SCRIPT) {
        const elements = Array.from({ length: n }, (_, i) => [
          { kind: "page", page: i + 1, xMm: 0, yMm: i * 297, widthMm: 210, heightMm: 297, colors: ["#101418"], label: "page", overflow: false },
          { kind: "text", page: i + 1, xMm: 24, yMm: 30, widthMm: 160, heightMm: 5, address: `${i + 1}`, tag: "p", label: "st-p", fontSizePt: 10, measureMm: 160, lineCount: 1, charCount: 40, charsPerLine: 40, maxLineWidthMm: 120 },
        ]).flat()
        return { ok: true, script: "studio.measure", result: { paged: true, pageCount: n, truncated: false, elements } }
      }
      if (req.script === OVERLAP_SCRIPT) {
        if (bridge.overlap === "not-allowed") return { ok: false, code: "SCRIPT_NOT_ALLOWED", message: "stub" }
        const findings =
          bridge.overlap === "overlap"
            ? [{ code: "OVERLAP", page: 1, address: overlapAddress, label: "st-figure", kind: "figure", address2: "1.2", label2: "st-p", kind2: "text", areaMm2: 469.5, frac: 0.4 }]
            : []
        return { ok: true, script: OVERLAP_SCRIPT_NAME, result: { paged: true, pageCount: n, truncated: false, marginsUnreadable: false, contentHeightMm: null, boxes: 40, findingsTotal: findings.length, findings } }
      }
      return { ok: false, code: "SCRIPT_NOT_ALLOWED", message: "stub" }
    }
    if (req.op === "pagePng") {
      if (!bridge.pagePng) return { ok: false, code: "BAD_REQUEST", message: "unknown op" }
      const dir = String(req.dstDir)
      const pages = (Array.isArray(req.pages) ? (req.pages as number[]) : [1]).map((p) => {
        const dst = path.join(dir, `p${String(p).padStart(3, "0")}.png`)
        const bytes = Buffer.from(`png-${p}`)
        writeFileSync(dst, bytes)
        return { n: p, dst, width: 1239, height: 1753, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }
      })
      return { ok: true, layout: "paged", media: "print", pageCount: Math.max(...pages.map((p) => p.n)), pageSizeMm: { wMm: 210, hMm: 297 }, pageSizeSource: "css", dpi: 150, pages }
    }
    return { ok: false, code: "BAD_REQUEST", message: "stub" }
  })
}
function resetBridge(o: Partial<Omit<Bridge, "seen">> = {}) {
  Object.assign(bridge, { overlap: "clean", down: false, pagePng: true }, o)
  bridge.seen.length = 0
  runtime.setRenderBridgeTransport(null) // drop the cached handshake
  installBridge()
}

// ── host ─────────────────────────────────────────────────────────────────────────────────────────────────────

async function start(extensions?: (m: Mod) => ReturnType<Mod["missionHostExtension"]>) {
  await resetEnvCache()
  store = await mod.openHostStore(STORE, { release: "1.2.1", logFile: LOG, missionGuard: true })
  mod.configureTemplateSource({ templatesDir: TEMPLATES, assetRepoRoot: VENDOR, release: "1.2.1" })
  const ext = extensions ? extensions(mod) : mod.missionHostExtension(store, { log, exporter: null })
  host = await mod.startStudioHostServer({ store, token: TOKEN, missionControlKey: PERSON_KEY, hostname: "127.0.0.1", port: 0, log, facts: FACTS, extensions: ext })
  c = new Client({ name: "row68-test", version: "0" })
  await c.connect(
    new StreamableHTTPClientTransport(new URL(host.url), {
      fetch: realFetch as never,
      requestInit: { headers: { authorization: `Bearer ${TOKEN}`, "x-studio-agent": "swarm", "x-studio-caller-cwd": encodeURIComponent(PROJECT) } },
    }),
  )
}
async function stop() {
  await c?.close().catch(() => undefined)
  await host?.close()
  mod?.configureTemplateSource(null)
  if (store) await mod.closeHostStore(store)
}

async function callRaw(name: string, args: Record<string, unknown>) {
  return c.callTool({ name, arguments: args })
}
async function call(name: string, args: Record<string, unknown>): Promise<S> {
  const r = await callRaw(name, args)
  return { ...((r.structuredContent ?? {}) as S), _isError: r.isError === true, _text: ((r.content ?? []) as S[]).map((x) => x.text).join("\n") }
}
const code = (r: S) => (r.ok === false ? r.code : "OK")
function row(id: string) {
  return { id, phase: "implementation", kind: "implementation", title: `Row ${id}`, agent: "coder-execution", model: { tier: "thinker" }, deps: [], size: "S", status: "pending", output: `implementation/${id}.md`, verification: "tests pass", review: "gate" }
}
const MARKDOWN = [
  "# Kajian uji",
  "",
  "Pengukuran titik uji dicatat tiap bulan oleh tim lapangan.",
  "",
  "Paragraf penanda UJIHILANG berisi nilai 1.250 meter yang harus tetap ada.",
  "",
  "| Titik | Nilai |",
  "| --- | --- |",
  "| A | 1.250 |",
  "| B | 2.500 |",
  "",
].join("\n")

async function deliverable(docKey: string, title: string): Promise<string> {
  const d = await call("studio_document_create", { template: "datum-nota", mission: M, docKey, title })
  expect(d.ok).toBe(true)
  const id = String(d.documentId)
  const imp = await call("studio_chapter_import_markdown", { documentId: id, chapterKey: "1", markdown: MARKDOWN, submit: true, baseRevisionNo: 1 })
  expect(imp.ok).toBe(true)
  return id
}
async function render(documentId: string, formats: string[], extra: Record<string, unknown> = {}): Promise<S> {
  const rev = (await store.revisionVerification(documentId, "latest")).revisionNo
  const r = await call("studio_render", { documentId, revisionNo: rev, formats, ...extra })
  const v = r.verification as S | undefined
  quote(`render ${formats.join("+")}`, {
    ok: r.ok,
    isError: r._isError,
    outputs: (r.outputs ?? []).map((o: S) => o.format),
    overall: v?.overall,
    formatsAdded: v?.formatsAdded,
    states: (v?.outputs ?? []).map((o: S) => ({ format: o.format, state: o.state, checks: (o.checks as S[]).map((k) => `${k.id}:${k.status}${k.reason ? `/${k.reason}` : ""}`) })),
  })
  return r
}


const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex")
const DEST = path.join(PROJECT, "deliverables", M)
const listDest = () => (existsSync(DEST) ? readdirSync(DEST).sort() : [])
async function meta(documentId: string): Promise<{ docNumber: string; docRev: string; revisionNo: number }> {
  return store.transaction(async (tx: S) => {
    const r = tx.get("SELECT d.doc_number, r.doc_rev, r.revision_no FROM document d JOIN revision r ON r.document_id = d.id AND r.revision_no = d.current_revision_no WHERE d.id = ?", [documentId]) as S
    return { docNumber: String(r.doc_number).replaceAll("/", "-"), docRev: String(r.doc_rev), revisionNo: Number(r.revision_no) }
  })
}
const nameOf = (m: { docNumber: string; docRev: string; revisionNo: number }, ext: string) => `${m.docNumber} Rev${m.docRev} rev${m.revisionNo}.${ext}`
const rowDeliverables = () => (store as unknown as { missions: { rowContract(m: string, r: string): { deliverables: S[] } } }).missions.rowContract(M, "1").deliverables

let doc = ""
let first: Awaited<ReturnType<typeof meta>>

beforeAll(async () => {
  process.env.STUDIO_WORKSPACE_ROOT = STORE
  process.env.STUDIO_ASSETS_ROOT = path.join(VENDOR, "src", "lib", "studio", "assets")
  process.env.STUDIO_VENDOR_ROOT = VENDOR
  delete process.env.STUDIO_MCP_FILE_ROOTS
  delete process.env.INTERNAL_API_SECRET
  delete process.env.STUDIO_VERIFY_BUDGET_MS
  mod = (await import("../../src/mcp-host/index.ts")) as Mod
  resetBridge()
  await start()
  const cr = await personCaller({ url: host.url, token: TOKEN, cwd: PROJECT, fetchImpl: realFetch })("studio_mission_create", {
    mission: { id: M, title: "Row 68 mission", type: "feature-release", owner: "master-controller", project: { dir: PROJECT }, rows: ["1", "2"].map(row), decisions: [{ id: "U1", by: "user", date: "2026-11-17", text: "go" }] },
  })
  expect(cr.ok).toBe(true)
  expect((await call("studio_mission_approve", { mission: M, decision: "U1" })).ok).toBe(true)
  expect((await call("studio_mission_set_status", { mission: M, to: "running" })).ok).toBe(true)
}, 120_000)

afterEach(() => resetBridge())

afterAll(async () => {
  await stop()
  runtime.setRenderBridgeTransport(null)
  globalThis.fetch = realFetch
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  await resetEnvCache()
})

describe("row 68: project copy after a verified render", () => {
  test("an unverified render copies nothing and says so", async () => {
    doc = await deliverable("row-1-kajian", "Kajian row 68")
    resetBridge({ overlap: "overlap" })
    const r = await render(doc, ["pdf", "docx"])
    expect(r.ok).toBe(true)
    expect((r.verification as S).overall).toBe("unverified")
    expect(r.projectCopy).toMatchObject({ ok: false, skipped: true, reason: "not-verified" })
    expect(r._text).toContain("project copy: none (not-verified")
    expect(existsSync(path.join(PROJECT, "deliverables"))).toBe(false)
    expect(rowDeliverables()).toEqual([])
  })

  test("verified render, no downloadDir: three files at the register path, sha256 equal to the store, listed on the row", async () => {
    const r = await render(doc, ["docx", "pdf", "html"])
    expect(r.ok).toBe(true)
    expect((r.verification as S).overall).toBe("verified")
    first = await meta(doc)
    const copy = r.projectCopy as S
    quote("projectCopy", copy)
    expect(copy).toMatchObject({ ok: true, dir: DEST, row: "1", recorded: true })
    expect(listDest()).toEqual(["docx", "html", "pdf"].map((e) => nameOf(first, e)))
    for (const o of r.outputs as S[]) {
      const f = (copy.files as S[]).find((x) => x.format === o.format)!
      expect(f).toMatchObject({ path: `deliverables/${M}/${nameOf(first, String(o.format).toLowerCase())}`, sha256: o.sha256, docRev: first.docRev, revisionNo: first.revisionNo, latest: true, documentId: doc })
      expect(sha(readFileSync(path.join(PROJECT, f.path)))).toBe(o.sha256)
      // the Studio store file is the same bytes
      expect(sha(await store.readOutputVerified(o.id))).toBe(o.sha256)
    }
    expect(rowDeliverables()).toEqual(copy.files)
    expect(r._text).toContain(`project copy: OK 3 files in deliverables/${M}/ (row 1 deliverables updated)`)
    for (const name of listDest()) expect(name).not.toMatch(/[0-9a-f]{8}\.|\d{4}-\d{2}-\d{2}T|Kajian/)
  })

  test("the same revision again: files left alone, list unchanged", async () => {
    const before = rowDeliverables()
    const r = await render(doc, ["docx", "pdf", "html"])
    expect(r.projectCopy).toMatchObject({ ok: true, recorded: true })
    expect(rowDeliverables()).toEqual(before)
    expect(listDest()).toHaveLength(3)
  })

  test("a second Studio revision adds files and moves `latest`; the old files stay", async () => {
    const imp = await call("studio_chapter_import_markdown", { documentId: doc, chapterKey: "1", markdown: MARKDOWN.replace("1.250 meter", "1.251 meter"), submit: true, baseRevisionNo: first.revisionNo })
    expect(imp.ok).toBe(true)
    const r = await render(doc, ["docx", "pdf", "html"])
    expect((r.verification as S).overall).toBe("verified")
    const second = await meta(doc)
    expect(second.revisionNo).toBeGreaterThan(first.revisionNo)
    expect(r.projectCopy).toMatchObject({ ok: true, recorded: true })
    expect(listDest()).toEqual([...["docx", "html", "pdf"].map((e) => nameOf(first, e)), ...["docx", "html", "pdf"].map((e) => nameOf(second, e))].sort())
    const list = rowDeliverables()
    expect(list).toHaveLength(6)
    expect(list.filter((d) => d.latest).map((d) => d.revisionNo)).toEqual([second.revisionNo, second.revisionNo, second.revisionNo])
    expect(list.filter((d) => !d.latest).map((d) => d.revisionNo)).toEqual([first.revisionNo, first.revisionNo, first.revisionNo])
    for (const d of list) expect(sha(readFileSync(path.join(PROJECT, d.path)))).toBe(d.sha256)
  })

  test("a folder that cannot be written: PROJECT_UNWRITABLE with the path; the render result still lists the store files", async () => {
    const imp = await call("studio_chapter_import_markdown", { documentId: doc, chapterKey: "1", markdown: MARKDOWN.replace("1.250 meter", "1.252 meter"), submit: true, baseRevisionNo: (await meta(doc)).revisionNo })
    expect(imp.ok).toBe(true)
    const before = rowDeliverables()
    chmodSync(DEST, 0o555)
    const r = await render(doc, ["docx", "pdf", "html"]).finally(() => chmodSync(DEST, 0o755))
    expect(r.ok).toBe(true)
    expect(r._isError).toBe(false)
    expect((r.outputs as S[]).map((o) => o.format).sort()).toEqual(["DOCX", "HTML", "PDF"])
    expect((r.verification as S).overall).toBe("verified")
    expect(r.projectCopy).toMatchObject({ ok: false, code: "PROJECT_UNWRITABLE", dir: PROJECT })
    expect(r._text).toContain("project copy: FAILED PROJECT_UNWRITABLE")
    expect(r._text).toContain(`folder: ${PROJECT}`)
    expect(listDest()).toHaveLength(6)
    expect(rowDeliverables()).toEqual(before)
    expect(hostLog.some((l) => l.level === "error" && l.source === "studio_render.projectCopy" && l.context?.code === "PROJECT_UNWRITABLE")).toBe(true)
    // the folder is writable again: the same render now lands the copy
    const again = await render(doc, ["docx", "pdf", "html"])
    expect(again.projectCopy).toMatchObject({ ok: true, recorded: true })
    expect(listDest()).toHaveLength(9)
  })

  test("a file of the same name with other content is not overwritten (OUTPUT_EXISTS)", async () => {
    const m = await meta(doc)
    const target = path.join(DEST, nameOf(m, "pdf"))
    chmodSync(target, 0o644)
    writeFileSync(target, "edited by hand")
    const r = await render(doc, ["docx", "pdf", "html"])
    expect(r.ok).toBe(true)
    expect(r.projectCopy).toMatchObject({ ok: false, code: "OUTPUT_EXISTS" })
    expect(readFileSync(target, "utf8")).toBe("edited by hand")
  })

  test("a document of the mission that names no row: copied, said as not recorded", async () => {
    const other = await deliverable("lampiran-bebas", "Lampiran row 68")
    const r = await render(other, ["pdf"])
    expect((r.verification as S).overall).toBe("verified")
    expect(r.projectCopy).toMatchObject({ ok: true, row: null, recorded: false })
    const m = await meta(other)
    expect(existsSync(path.join(DEST, nameOf(m, "pdf")))).toBe(true)
    expect(r._text).toContain("not recorded on a row")
  })

  test("a document that belongs to no mission: no copy, said in the result, no folder guessed", async () => {
    const loose = await deliverable("row-2-lepas", "Lepas row 68")
    await store.transaction(async (tx: S) => tx.run("UPDATE document SET mission_folder = NULL, mission_doc_key = NULL WHERE id = ?", [loose]))
    const before = listDest()
    const r = await render(loose, ["pdf"])
    quote("no mission", { ok: r.ok, overall: (r.verification as S | undefined)?.overall, projectCopy: r.projectCopy })
    expect(r.ok).toBe(true)
    expect(r.projectCopy).toMatchObject({ ok: false, skipped: true, reason: "no-mission" })
    expect(r._text).toContain("project copy: none (no-mission")
    expect(listDest()).toEqual(before)
    expect(existsSync(path.join(HOME, "deliverables"))).toBe(false)
  })

  test("tool input cannot move the copy: extra arguments are refused or ignored, nothing lands outside the folder", async () => {
    const m = await meta(doc)
    const rev = m.revisionNo
    const r = await call("studio_render", { documentId: doc, revisionNo: rev, formats: ["pdf"], downloadDir: path.join(WORK, "elsewhere"), projectDir: WORK, mission: "../../x" })
    quote("extra args", { ok: r.ok, code: r.code, projectCopy: r.projectCopy })
    expect(existsSync(path.join(WORK, "elsewhere"))).toBe(false)
    expect(existsSync(path.join(WORK, "deliverables"))).toBe(false)
  })
})
