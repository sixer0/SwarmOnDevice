// Row 31c: services/render {index, scope, preflight, admission, revision, artifact} vendored with the row 109
// Prisma cut, and the host routes R17 (POST /api/studio/documents/[id]/render) and
// POST /api/studio/documents/[id]/figures/preview wired in the LocalStudioApi (decisions C60, C65).
//
// What runs for real: a temp DATUM Studio store, the real host server (src/mcp-host) on 127.0.0.1, the real
// MCP SDK client, the vendored Studio services and engines, and the row 24 render bridge itself
// (desktop/src/main/datum-render startRenderBridge: Unix socket, token, request validation, path policy,
// font block, dispatch, atomic write), reached by the row 108 client over the socket.
// What is faked: ONLY the row 24 PageEngine seam (the same harness as test/render-pdf, row 32), because
// Electron cannot run under bun. Its `pdf` returns a real, parseable PDF with one page per Studio sheet/unit;
// its `png` returns a real white PNG of the requested pixel size (chart rasters for revisions with a chart);
// `evaluate` (layout measurement) refuses, so render lint runs without metrics (a logged warning).
// globalThis.fetch is a trap for the whole file; no network, no model.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { deflateSync } from "node:zlib"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync } from "node:fs"
import path from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

const PKG = path.resolve(import.meta.dir, "..", "..")
const VENDOR = path.join(PKG, "vendor")
const RENDER_DIR = path.join(VENDOR, "src", "lib", "studio", "services", "render")
const ROUTES_DIR = path.join(PKG, "src", "mcp-host", "local-api", "routes")
const TEMPLATES = path.join(PKG, "templates")
const DESKTOP = path.resolve(PKG, "..", "desktop")
const BRIDGE_DIR = path.join(DESKTOP, "src", "main", "datum-render")
const FONTS = path.join(DESKTOP, "datum", "datum-house-style", "assets", "fonts")
const BASE = process.env.ROW31C_TEST_DIR ?? "/private/tmp/claude-501/row31c/tests"
mkdirSync(BASE, { recursive: true })
const WORK = realpathSync(mkdtempSync(path.join(BASE, "row31c-")))
const STORE = path.join(WORK, "datum-studio")
const HOME = path.join(WORK, "home")
const RES = path.join(WORK, "Swarm.app", "Contents", "Resources")
const PROJECT = path.join(HOME, "project-a")
for (const d of [HOME, RES, PROJECT]) mkdirSync(d, { recursive: true })

process.env.STUDIO_WORKSPACE_ROOT = STORE
process.env.STUDIO_ASSETS_ROOT = path.join(VENDOR, "src", "lib", "studio", "assets")
process.env.STUDIO_VENDOR_ROOT = VENDOR
delete process.env.STUDIO_MCP_FILE_ROOTS
delete process.env.INTERNAL_API_SECRET
delete process.env.DATUM_RENDER_SOCKET
delete process.env.DATUM_RENDER_TOKEN

const PORT = Number(process.env.ROW31C_PORT ?? 47331)
const TOKEN = "c".repeat(16) + "0123456789abcdef".repeat(3)
const FACTS = { home: HOME, resourcesPath: RES, execPath: path.join(WORK, "Swarm.app", "Contents", "MacOS", "Swarm") }
const SECRET = "q".repeat(64)

const realFetch = globalThis.fetch
let fetchCalls = 0
globalThis.fetch = (async () => {
  fetchCalls++
  throw new Error("row31c test: globalThis.fetch must not be called by the host")
}) as unknown as typeof fetch

// ── row 24 bridge with the fake PageEngine (row 32 harness) ──────────────────────────────────────

type EngineInfo = Record<string, unknown>
type PageEngine = {
  png(job: { html: string; width: number; height: number }): Promise<Buffer>
  pdf(job: { html: string; widthMm: number; heightMm: number; preferCSSPageSize: boolean }): Promise<Buffer>
  evaluate(job: { html: string; viewportWidth: number; viewportHeight: number; expression: string }): Promise<unknown>
  info(): EngineInfo
}
type RenderBridge = { env: { DATUM_RENDER_SOCKET: string; DATUM_RENDER_TOKEN: string }; close(): Promise<void> }
type BridgeModule = {
  startRenderBridge(o: { fontsDir: string; log: (...a: unknown[]) => void; engine: PageEngine; baseDir?: string }): Promise<RenderBridge>
}
type PagesModule = { renderWebPreferences(kind: "raster" | "check"): Record<string, unknown> }

function realPdf(n: number, wMm: number, hMm: number): Buffer {
  const w = ((wMm * 72) / 25.4).toFixed(2)
  const h = ((hMm * 72) / 25.4).toFixed(2)
  const objs: string[] = ["<< /Type /Catalog /Pages 2 0 R >>", `<< /Type /Pages /Kids [${Array.from({ length: n }, (_, i) => `${3 + i} 0 R`).join(" ")}] /Count ${n} >>`]
  for (let i = 0; i < n; i++) objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << >> >>`)
  let out = "%PDF-1.7\n%\xe2\xe3\xcf\xd3\n"
  const offsets: number[] = []
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out, "latin1"))
    out += `${i + 1} 0 obj\n${o}\nendobj\n`
  })
  const xref = Buffer.byteLength(out, "latin1")
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, "latin1")
}

function sheetsOf(html: string): number {
  const sheets = (html.match(/<section class="page[" ]/g) ?? []).length
  const units = [...html.matchAll(/<section class="(st-unit[^"]*)"/g)].filter((m) => !/\bst-flow\b/.test(m[1])).length
  return sheets + units
}

/** A real, decodable PNG (white, w x h px, 8-bit gray): signature, IHDR, IDAT (zlib), IEND with CRCs. */
function realPng(w: number, h: number): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc = (b: Buffer) => {
    let c = 0xffffffff
    for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type, "latin1"), data])
    const c = Buffer.alloc(4)
    c.writeUInt32BE(crc(td))
    return Buffer.concat([len, td, c])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 0
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w, 0xff)])
  const raw = Buffer.concat(Array.from({ length: h }, () => row))
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))])
}

const pngJobs: Array<{ width: number; height: number }> = []
const pdfJobs: Array<{ widthMm: number; heightMm: number; preferCSSPageSize: boolean }> = []
let info: EngineInfo = {}
const fakeEngine: PageEngine = {
  async png(job) {
    pngJobs.push({ width: job.width, height: job.height })
    return realPng(Math.max(1, Math.round(job.width)), Math.max(1, Math.round(job.height)))
  },
  async pdf(job) {
    pdfJobs.push({ widthMm: job.widthMm, heightMm: job.heightMm, preferCSSPageSize: job.preferCSSPageSize })
    return realPdf(Math.max(1, sheetsOf(job.html)), job.widthMm, job.heightMm)
  },
  async evaluate() {
    throw new Error("layout measurement is not part of this fake")
  },
  info: () => info,
}

// ── host, client, helpers ────────────────────────────────────────────────────────────────────────

type Mod = typeof import("../../src/mcp-host/index.ts")
let mod: Mod
let store: Awaited<ReturnType<Mod["openHostStore"]>>
let host: Awaited<ReturnType<Mod["startStudioHostServer"]>>
let bridge: RenderBridge
let c: Client
let api: { fetch: (url: string, init?: Record<string, unknown>) => Promise<{ status: number; headers: Headers; text(): Promise<string> }> }
const CHANGE = (what: string) => ({ what, why: "uji row 31c", impact: "revisi baru; revisi lama tetap" })

type Structured = Record<string, unknown> & { ok?: boolean; code?: string }
async function call(name: string, args: Record<string, unknown>): Promise<Structured> {
  const r = await c.callTool({ name, arguments: args })
  return (r.structuredContent ?? {}) as Structured
}

async function local(method: string, route: string, body?: unknown): Promise<{ status: number; headers: Headers; body: Record<string, unknown> }> {
  const r = await api.fetch(`http://127.0.0.1:1${route}`, {
    method,
    headers: { "x-internal-secret": SECRET, accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    redirect: "manual",
  })
  const text = await r.text()
  return { status: r.status, headers: r.headers, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} }
}

function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T[] {
  return (store as unknown as { requireReader(): { all(s: string, p?: unknown[]): unknown[] } }).requireReader().all(sql, params) as T[]
}

function sha256Of(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex")
}

type Output = { id: string; format: string; role: string; sha256: string; relPath?: string; bytes?: number; draft?: boolean; scope?: { kind: string; key?: string } }

/** Every output row of a render: stored with sha (row sha = disk sha of rel_path under the store). */
function checkStored(outputs: Output[]): Array<{ format: string; sha256: string; relPath: string; diskSha: string }> {
  return outputs.map((o) => {
    const row = q<{ rel_path: string; sha256: string; format: string; bytes: number }>("SELECT rel_path, sha256, format, bytes FROM output_file WHERE id = ?", [o.id])[0]
    expect(row).toBeDefined()
    const diskSha = sha256Of(path.join(STORE, row.rel_path))
    return { format: row.format, sha256: row.sha256, relPath: row.rel_path, diskSha }
  })
}

/** Engine log entries of a render job (`render_job.engine.log`). */
function jobLog(jobId: string): Array<{ code?: string; message: string; context?: Record<string, unknown> }> {
  const row = q<{ engine: string }>("SELECT engine FROM render_job WHERE id = ?", [jobId])[0]
  const eng = JSON.parse(row.engine) as { log?: Array<{ code?: string; message: string; context?: Record<string, unknown> }> }
  return eng.log ?? []
}

function pinnedOf(jobId: string): Record<string, unknown> | undefined {
  return jobLog(jobId).find((e) => e.code === "TEMPLATE_PINNED")?.context
}

let documentId = ""
let reportRev = 0
const evidence: Record<string, unknown> = {}

beforeAll(async () => {
  // T-2 (C71): an earlier suite in the same process may have cached its own STUDIO_WORKSPACE_ROOT
  // (contract/env.ts getStudioEnv), bridge readiness, and render-bucket charges of the same internal caller
  // (http/render-guard.ts process-wide limiter, 30 per 60 s); own all three before the store is opened.
  const { resetStudioEnvCache } = await import("../../vendor/src/lib/studio/contract/env")
  const { resetBridgePdfReadiness } = await import("../../vendor/src/lib/studio/services/render")
  const { resetRenderRateLimiter } = await import("../../vendor/src/lib/studio/http/render-guard")
  process.env.STUDIO_WORKSPACE_ROOT = STORE
  process.env.STUDIO_ASSETS_ROOT = path.join(VENDOR, "src", "lib", "studio", "assets")
  resetStudioEnvCache()
  resetBridgePdfReadiness()
  resetRenderRateLimiter()
  const bridgeMod = (await import(path.join(BRIDGE_DIR, "index.ts"))) as BridgeModule
  const pages = (await import(path.join(BRIDGE_DIR, "pages.ts"))) as PagesModule
  const raster = pages.renderWebPreferences("raster")
  info = { electron: "fake-row31c", chrome: "fake-row31c", partition: "datum-render", sandbox: raster.sandbox, contextIsolation: raster.contextIsolation, nodeIntegration: raster.nodeIntegration, javascriptContent: raster.javascript, network: "blocked" }
  bridge = await bridgeMod.startRenderBridge({ fontsDir: FONTS, log: () => {}, engine: fakeEngine, baseDir: WORK })
  process.env.DATUM_RENDER_SOCKET = bridge.env.DATUM_RENDER_SOCKET
  process.env.DATUM_RENDER_TOKEN = bridge.env.DATUM_RENDER_TOKEN

  mod = await import("../../src/mcp-host/index.ts")
  store = await mod.openHostStore(STORE, { release: "1.2.0", logFile: path.join(WORK, "logs", "store.jsonl") })
  mod.configureTemplateSource({ templatesDir: TEMPLATES, assetRepoRoot: VENDOR, release: "1.2.0" })
  host = await mod.startStudioHostServer({ store, token: TOKEN, hostname: "127.0.0.1", port: PORT, log: () => {}, facts: FACTS })
  c = new Client({ name: "row31c-test", version: "0" })
  await c.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`), {
      fetch: realFetch as never,
      requestInit: { headers: { authorization: `Bearer ${TOKEN}`, "x-studio-agent": "claude", "x-studio-caller-cwd": encodeURIComponent(PROJECT) } },
    }),
  )
  const { createLocalStudioApi } = await import("../../src/mcp-host/local-api/router.ts")
  const { LOCAL_ROUTES } = await import("../../src/mcp-host/local-api/routes.ts")
  api = createLocalStudioApi({ baseUrl: "http://127.0.0.1:1", secret: SECRET, agentId: "claude", routes: LOCAL_ROUTES }) as unknown as typeof api
})

afterAll(async () => {
  await c?.close()
  await host?.close()
  mod?.configureTemplateSource(null)
  if (store) await mod.closeHostStore(store)
  if (bridge) await bridge.close()
  globalThis.fetch = realFetch
  // T-2: leave neither this suite's root, its bridge readiness nor its render charges for the next suite.
  const { resetStudioEnvCache } = await import("../../vendor/src/lib/studio/contract/env")
  const { resetBridgePdfReadiness } = await import("../../vendor/src/lib/studio/services/render")
  const { resetRenderRateLimiter } = await import("../../vendor/src/lib/studio/http/render-guard")
  resetStudioEnvCache()
  resetBridgePdfReadiness()
  resetRenderRateLimiter()
  delete process.env.DATUM_RENDER_SOCKET
  delete process.env.DATUM_RENDER_TOKEN
  console.log(`row31c evidence ${JSON.stringify(evidence)}`)
})

// ── static checks ────────────────────────────────────────────────────────────────────────────────

const MY_FILES = [
  ...["index", "scope", "preflight", "admission", "revision", "artifact", "readiness"].map((f) => path.join(RENDER_DIR, `${f}.ts`)),
  ...["r17-render", "r17-handler", "r17-request", "r17-service", "figure-preview", "figure-preview-figure", "figure-preview-load", "figure-preview-request"].map((f) => path.join(ROUTES_DIR, `${f}.ts`)),
]

describe("row 31c: ported files", () => {
  test("no Prisma import and no reference to the desktop-office PDF engine", () => {
    const prisma = /(?:import|export)[^;]*?from\s*["'](?:@prisma\/client|@\/lib\/prisma)["']|import\(\s*["'](?:@prisma\/client|@\/lib\/prisma)["']\s*\)/
    expect(MY_FILES.filter((f) => prisma.test(readFileSync(f, "utf8"))).map((f) => path.basename(f))).toEqual([])
    expect(MY_FILES.filter((f) => /soffice/i.test(readFileSync(f, "utf8"))).map((f) => path.basename(f))).toEqual([])
    expect(MY_FILES.length).toBe(15)
  })

  test("routes table: R17 and figure-preview are wired, nothing answers ROUTE_NOT_AVAILABLE", async () => {
    const { LOCAL_ROUTES } = await import("../../src/mcp-host/local-api/routes.ts")
    const src = readFileSync(path.join(PKG, "src", "mcp-host", "local-api", "routes.ts"), "utf8")
    expect(src).not.toMatch(/notAvailable\("/)
    expect(LOCAL_ROUTES.find((r) => r.id === "R17")?.methods.POST).toBeDefined()
    expect(LOCAL_ROUTES.find((r) => r.id === "figure-preview")?.methods.POST).toBeDefined()
  })
})

// ── R17 / studio_render over the real store ──────────────────────────────────────────────────────

describe("row 31c: R17 over the real host server, store and render bridge", () => {
  test("studio_write: a complete work report is rendered through R17 (report default HTML) and verified by sha (R10)", async () => {
    const sections = [
      { heading: "Ringkasan", blocks: ["Kalibrasi sensor stasiun selesai untuk semua titik."] },
      { heading: "Rincian kerja", blocks: [[["pekerjaan", "status"], ["Kalibrasi sensor", "selesai"]]] },
      { heading: "Bukti", blocks: ["Catatan kalibrasi ada di buku log stasiun."] },
      { heading: "Isu terbuka", blocks: ["Tidak ada isu terbuka."] },
      { heading: "Langkah berikut", blocks: ["Kalibrasi berikutnya bulan depan."] },
    ]
    const r = await call("studio_write", { mission: "2026-11-07_row31c", docKey: "lap-render", title: "Laporan uji render row 31c", sections })
    evidence.studioWrite = { ok: r.ok, code: r.code ?? null, render: r.render ?? null, completeness: r.completeness ?? null, renderError: r.renderError ?? null }
    expect(r.ok).toBe(true)
    documentId = String(r.documentId)
    expect(documentId.length).toBeGreaterThan(10)
    reportRev = Number(q<{ n: number }>("SELECT current_revision_no AS n FROM document WHERE id = ?", [documentId])[0].n)
    const render = r.render as { fileId: string; format: string; sha256: string; verified: boolean } | null
    expect(r.renderError ?? null).toBeNull()
    expect((r.completeness as { status: string }).status).toBe("COMPLETE")
    // studio-report.ts:1667 (report path) renders R17 with its default format HTML, then R10 re-hashes the download.
    expect(render?.format).toBe("HTML")
    expect(render?.verified).toBe(true)
    const stored = checkStored([{ id: render!.fileId, format: "HTML", role: "PRIMARY", sha256: render!.sha256 }])
    expect(stored[0].sha256).toBe(render!.sha256)
    expect(stored[0].diskSha).toBe(render!.sha256)
  })

  test("studio_render document [docx, html, pdf]: SUCCEEDED, three outputs stored with sha, PDF printed by the bridge", async () => {
    const before = pdfJobs.length
    const r = await call("studio_render", { documentId, formats: ["docx", "html", "pdf"] })
    expect(r.ok).toBe(true)
    const job = r.job as { id: string; status: string; formats: string[] }
    const outputs = r.outputs as Output[]
    expect(job.status).toBe("SUCCEEDED")
    expect(r.partial).toBe(false)
    expect(r.failedFormats).toEqual([])
    expect(outputs.map((o) => o.format).sort()).toEqual(["DOCX", "HTML", "PDF"])
    const stored = checkStored(outputs)
    for (const s of stored) expect(s.diskSha).toBe(s.sha256)
    expect(pdfJobs.length).toBe(before + 1)
    expect(pdfJobs.at(-1)?.preferCSSPageSize).toBe(true)
    const pdf = stored.find((s) => s.format === "PDF")!
    const head = readFileSync(path.join(STORE, pdf.relPath)).subarray(0, 5).toString("latin1")
    expect(head).toBe("%PDF-")
    const docx = readFileSync(path.join(STORE, stored.find((s) => s.format === "DOCX")!.relPath))
    expect(docx.subarray(0, 2).toString("latin1")).toBe("PK")
    const html = readFileSync(path.join(STORE, stored.find((s) => s.format === "HTML")!.relPath), "utf8")
    expect(html).toContain("<html")
    const jobRow = q<{ status: string; revision_id: string; scope_kind: string }>("SELECT status, revision_id, scope_kind FROM render_job WHERE id = ?", [job.id])[0]
    expect(jobRow.status).toBe("SUCCEEDED")
    expect(jobRow.scope_kind).toBe("DOCUMENT")
    const rel = q<{ release_status: string }>("SELECT release_status FROM revision WHERE id = ?", [jobRow.revision_id])[0]
    expect(["PASS", "FAIL"]).toContain(rel.release_status)
    expect(pinnedOf(job.id)?.versionNo).toBe(1)
    evidence.render = { jobId: job.id, status: job.status, outputs: stored.map((s) => ({ format: s.format, sha256: s.sha256, relPath: s.relPath })), releaseStatus: rel.release_status, pdfJobs: pdfJobs.length }
  })

  test("R17 direct: chapter scope is a draft in rev-<n>/bab-<k>/ with scope columns; header X-Studio-Render-Status", async () => {
    const snap = q<{ snapshot: string }>("SELECT snapshot FROM revision WHERE document_id = ? AND revision_no = ?", [documentId, reportRev])[0]
    const units = (JSON.parse(snap.snapshot) as { units?: Array<{ unitKey?: string; kind?: string }> }).units ?? []
    const chapterKey = units.map((u) => u.unitKey ?? "").find((k) => /^\d+$/.test(k)) ?? "1"
    const r = await local("POST", `/api/studio/documents/${documentId}/render`, { scope: "chapter", key: chapterKey, formats: ["html"] })
    evidence.chapter = { status: r.status, code: r.body.code ?? null, key: chapterKey }
    expect(r.status).toBe(200)
    expect(r.headers.get("x-studio-render-status")).toBe("SUCCEEDED")
    const job = r.body.job as { id: string; draft: boolean; scope: { kind: string; key: string } }
    expect(job.draft).toBe(true)
    expect(job.scope).toEqual({ kind: "CHAPTER", key: chapterKey })
    const outputs = r.body.outputs as Output[]
    expect(outputs.length).toBe(1)
    const row = q<{ scope_kind: string; scope_key: string; draft: number; rel_path: string }>("SELECT scope_kind, scope_key, draft, rel_path FROM output_file WHERE id = ?", [outputs[0].id])[0]
    expect(row.scope_kind).toBe("CHAPTER")
    expect(row.scope_key).toBe(chapterKey)
    expect(row.draft).toBe(1)
    expect(row.rel_path).toContain(`/rev-${reportRev}/bab-`)
  })

  test("R17 errors: 400 SCHEMA_INVALID, 404 DOCUMENT_NOT_FOUND / REVISION_NOT_FOUND, never 501", async () => {
    const bad = await local("POST", `/api/studio/documents/${documentId}/render`, { scope: "everything" })
    expect(bad.status).toBe(400)
    expect(bad.body.code).toBe("SCHEMA_INVALID")
    const missingDoc = await local("POST", "/api/studio/documents/cnotadoc0000000000000000/render", { scope: "document", formats: ["docx"] })
    expect(missingDoc.status).toBe(404)
    expect(missingDoc.body.code).toBe("DOCUMENT_NOT_FOUND")
    const missingRev = await local("POST", `/api/studio/documents/${documentId}/render`, { scope: "document", formats: ["docx"], revisionNo: 999 })
    expect(missingRev.status).toBe(404)
    expect(missingRev.body.code).toBe("REVISION_NOT_FOUND")
  })
})

// ── figure preview / revise ──────────────────────────────────────────────────────────────────────

const CHART = {
  type: "chart",
  code: "P-02",
  data: { shape: "categorical", points: [{ label: "Jan", value: 12 }, { label: "Feb", value: 15 }, { label: "Mar", value: 9 }] },
  unit: "titik",
  caption: { text: "Titik kalibrasi per bulan" },
  source: { text: "Buku log stasiun" },
}

describe("row 31c: figure preview and revise", () => {
  let chartPid = ""

  test("studio_figure_preview with an inline v2 chart block returns a rendered figure (read only: no job, no file)", async () => {
    const jobs = q<{ n: number }>("SELECT count(*) AS n FROM render_job")[0].n
    const files = q<{ n: number }>("SELECT count(*) AS n FROM output_file")[0].n
    const r = await call("studio_figure_preview", { documentId, block: CHART, includeSvg: true })
    evidence.previewInline = { ok: r.ok, code: r.code ?? null, rendered: r.rendered, issueCount: r.issueCount ?? null }
    expect(r.ok).toBe(true)
    expect(r.rendered).toBe(true)
    const fig = r.figure as { type: string; code: string; size: { widthMm: number; heightMm: number; svgBytes: number }; svg?: string }
    expect(fig.type).toBe("chart")
    expect(fig.code).toBe("P-02")
    expect(fig.size.widthMm).toBeGreaterThan(0)
    expect(fig.size.svgBytes).toBeGreaterThan(100)
    expect(String(fig.svg)).toContain("<svg")
    expect(q<{ n: number }>("SELECT count(*) AS n FROM render_job")[0].n).toBe(jobs)
    expect(q<{ n: number }>("SELECT count(*) AS n FROM output_file")[0].n).toBe(files)
  })

  test("a chart inserted by R16 is previewed by pid, then studio_figure_revise changes its caption at revision n+1", async () => {
    const cur = Number(q<{ n: number }>("SELECT current_revision_no AS n FROM document WHERE id = ?", [documentId])[0].n)
    const snap = JSON.parse(q<{ snapshot: string }>("SELECT snapshot FROM revision WHERE document_id = ? AND revision_no = ?", [documentId, cur])[0].snapshot) as { blocks: Array<{ pid?: string; type: string }> }
    const para = snap.blocks.find((b) => b.type === "paragraph" && typeof b.pid === "string")
    expect(para).toBeDefined()
    const ins = await local("PATCH", `/api/studio/documents/${documentId}/paragraphs/${para!.pid}`, { op: "insertAfter", baseRevisionNo: cur, block: CHART, change: CHANGE("Grafik kalibrasi ditambah") })
    evidence.insertChart = { status: ins.status, code: ins.body.code ?? null }
    expect(ins.status).toBe(200)
    chartPid = String(ins.body.newPid ?? ins.body.pid)
    const afterInsert = Number((ins.body.revision as { revisionNo: number }).revisionNo)

    const pv = await call("studio_figure_preview", { documentId, pid: chartPid })
    expect(pv.ok).toBe(true)
    expect(pv.rendered).toBe(true)
    expect((pv.figure as { pid: string }).pid).toBe(chartPid)
    expect(pv.revisionNo).toBe(afterInsert)

    const rv = await call("studio_figure_revise", { documentId, pid: chartPid, patch: { caption: "Titik kalibrasi per bulan (direvisi)" }, baseRevisionNo: afterInsert, change: CHANGE("Caption grafik diperbaiki") })
    evidence.figureRevise = { ok: rv.ok, code: rv.code ?? null, revisionNo: rv.revisionNo ?? null, figureRendered: (rv.figure as { rendered?: boolean } | undefined)?.rendered ?? null }
    expect(rv.ok).toBe(true)
    expect(rv.revisionNo).toBe(afterInsert + 1)
    expect((rv.figure as { type: string }).type).toBe("chart")
    const g = await local("GET", `/api/studio/documents/${documentId}/paragraphs/${chartPid}`)
    expect(JSON.stringify(g.body.content)).toContain("direvisi")
    const old = await local("GET", `/api/studio/documents/${documentId}/paragraphs/${chartPid}?rev=${afterInsert}`)
    expect(JSON.stringify(old.body.content)).not.toContain("direvisi")
  })

  test("figure preview errors: 404 PID_NOT_FOUND, 422 BLOCK_TYPE_NOT_ADMITTED, 400 SCHEMA_INVALID", async () => {
    const snap = JSON.parse(q<{ snapshot: string }>("SELECT snapshot FROM revision WHERE document_id = ? ORDER BY revision_no DESC LIMIT 1", [documentId])[0].snapshot) as { blocks: Array<{ pid?: string; type: string }> }
    const para = snap.blocks.find((b) => b.type === "paragraph" && typeof b.pid === "string")!
    const notFig = await local("POST", `/api/studio/documents/${documentId}/figures/preview`, { pid: para.pid })
    expect(notFig.status).toBe(422)
    expect(notFig.body.code).toBe("BLOCK_TYPE_NOT_ADMITTED")
    const missing = await local("POST", `/api/studio/documents/${documentId}/figures/preview`, { pid: "p_zzzzzzzzzzzz" })
    expect([400, 404]).toContain(missing.status)
    const empty = await local("POST", `/api/studio/documents/${documentId}/figures/preview`, {})
    expect(empty.status).toBe(400)
    expect(empty.body.code).toBe("SCHEMA_INVALID")
  })
})

// ── template version of an old revision ──────────────────────────────────────────────────────────

describe("row 31c: a re-render of an old revision keeps that revision's template version", () => {
  test("pin v2, then render the old revision (R17 revisionNo and rerenderRevision): job resolves v1; current resolves v2", async () => {
    // A second version of the document's template (same params; only id and number differ). Builtin templates take
    // no new versions through the store API (TEMPLATE_READ_ONLY), so the test appends the row with SQL (append-only
    // table, D-06); `latest_version_no` is left alone (the op and resolveTemplate look the version up by number).
    const doc = q<{ template_id: string; current_revision_no: number }>("SELECT template_id, current_revision_no FROM document WHERE id = ?", [documentId])[0]
    const v1 = q<{ id: string; version_no: number }>(
      "SELECT v.id, v.version_no FROM template_version v JOIN revision r ON r.template_version_id = v.id WHERE r.document_id = ? AND r.revision_no = ?",
      [documentId, doc.current_revision_no],
    )[0]
    const templateId = q<{ template_id: string }>("SELECT template_id FROM template_version WHERE id = ?", [v1.id])[0].template_id
    const maxNo = q<{ n: number }>("SELECT max(version_no) AS n FROM template_version WHERE template_id = ?", [templateId])[0].n
    const v2No = maxNo + 1
    await store.transaction(async (tx) => {
      tx.run(
        `INSERT INTO template_version (id, template_id, version_no, base_version_id, definition, definition_sha256, overrides, resolved_params, params_sha256,
           role_formats, section_plan, assets, provenance, skeleton, skeleton_sha256, change_note, created_by, time_created)
         SELECT ?, template_id, ?, id, definition, definition_sha256, overrides, resolved_params, params_sha256, role_formats, section_plan, assets, provenance,
           skeleton, skeleton_sha256, 'row 31c test version', 'row31c-test', ? FROM template_version WHERE id = ?`,
        [`tv_row31c_${v2No}`, v2No, Date.now(), v1.id],
      )
    })
    const oldRev = doc.current_revision_no
    const pin = await local("PATCH", `/api/studio/documents/${documentId}/structure`, { op: "templateVersion", baseRevisionNo: oldRev, versionNo: v2No, change: CHANGE("Templat versi baru") })
    evidence.pinV2 = { status: pin.status, code: pin.body.code ?? null, v1: v1.version_no, v2: v2No }
    expect(pin.status).toBe(200)
    const newRev = Number((pin.body.revision as { revisionNo: number }).revisionNo)
    expect(newRev).toBe(oldRev + 1)
    const pinnedNew = q<{ version_no: number }>("SELECT v.version_no FROM template_version v JOIN revision r ON r.template_version_id = v.id WHERE r.document_id = ? AND r.revision_no = ?", [documentId, newRev])[0]
    expect(pinnedNew.version_no).toBe(v2No)

    // Old revision through R17 (scope document, revisionNo = old).
    const rOld = await local("POST", `/api/studio/documents/${documentId}/render`, { scope: "document", formats: ["html"], revisionNo: oldRev })
    expect(rOld.status).toBe(200)
    const oldJob = (rOld.body.job as { id: string; status: string }).id
    expect((rOld.body.job as { status: string }).status).toBe("SUCCEEDED")
    expect(pinnedOf(oldJob)).toMatchObject({ versionNo: v1.version_no, versionId: v1.id, resolvedVersionId: v1.id, revisionNo: oldRev })
    expect(jobLog(oldJob).some((e) => e.code === "TEMPLATE_VERSION_MISMATCH")).toBe(false)

    // Current revision resolves v2.
    const rNew = await local("POST", `/api/studio/documents/${documentId}/render`, { scope: "document", formats: ["html"] })
    expect(rNew.status).toBe(200)
    const newJob = (rNew.body.job as { id: string }).id
    expect((rNew.body.job as { status: string }).status).toBe("SUCCEEDED")
    expect(pinnedOf(newJob)).toMatchObject({ versionNo: v2No, resolvedVersionId: `tv_row31c_${v2No}`, revisionNo: newRev })

    // Old revision through the vendored rerenderRevision (row 31b seam now the real services/render).
    const revisions = await import("../../vendor/src/lib/studio/services/revisions")
    const rr = await revisions.rerenderRevision(documentId, oldRev, ["HTML"])
    expect(rr.job.status).toBe("SUCCEEDED")
    expect(pinnedOf(rr.job.id)).toMatchObject({ versionNo: v1.version_no, versionId: v1.id, revisionNo: oldRev })
    expect(rr.identical).toBe(true)
    evidence.oldRevision = { pngJobs: pngJobs.length, oldRev, newRev, v1: v1.version_no, v2: v2No, r17OldJob: oldJob, r17NewJob: newJob, rerenderJob: rr.job.id, identical: rr.identical }
  })
})

// ── PDF preflight (bridge readiness) ─────────────────────────────────────────────────────────────

describe("row 31c: PDF preflight follows the render bridge", () => {
  test("bridge unreachable: pdf -> 503 PDF_ENGINE_UNAVAILABLE stage preflight with Retry-After, no job; docx of a chart-free revision still renders", async () => {
    const { resetBridgePdfReadiness } = await import("../../vendor/src/lib/studio/services/render")
    const socket = process.env.DATUM_RENDER_SOCKET
    process.env.DATUM_RENDER_SOCKET = path.join(WORK, "no-bridge.sock")
    resetBridgePdfReadiness()
    try {
      const jobs = q<{ n: number }>("SELECT count(*) AS n FROM render_job")[0].n
      const r = await local("POST", `/api/studio/documents/${documentId}/render`, { scope: "document", formats: ["pdf"] })
      expect(r.status).toBe(503)
      expect(r.body.code).toBe("PDF_ENGINE_UNAVAILABLE")
      const d = r.body.details as { stage: string; jobCreated: boolean; suggestedFormats: string[]; causes: Array<{ code: string }> }
      expect(d.stage).toBe("preflight")
      expect(d.jobCreated).toBe(false)
      expect(d.suggestedFormats).toEqual(["docx", "html"])
      expect(d.causes.map((x) => x.code)).toEqual(["PDF_ENGINE_MISSING"])
      expect(Number(r.headers.get("retry-after"))).toBe(30)
      expect(q<{ n: number }>("SELECT count(*) AS n FROM render_job")[0].n).toBe(jobs)
      const tool = await call("studio_render", { documentId, formats: ["pdf"] })
      expect(tool.ok).toBe(false)
      expect(tool.code).toBe("PDF_ENGINE_UNAVAILABLE")
      // DOCX needs no bridge unless the revision has a chart (its raster goes through the bridge `png` op), so the
      // chart-free report revision is used here.
      const docx = await local("POST", `/api/studio/documents/${documentId}/render`, { scope: "document", formats: ["docx"], revisionNo: reportRev })
      expect(docx.status).toBe(200)
      expect((docx.body.job as { status: string }).status).toBe("SUCCEEDED")
      evidence.preflight = { status: r.status, causes: d.causes, retryAfter: r.headers.get("retry-after"), docxAfter: (docx.body.job as { status: string }).status }
    } finally {
      process.env.DATUM_RENDER_SOCKET = socket
      resetBridgePdfReadiness()
    }
  })

  test("artifacts: renderArtifact refuses with ARTIFACT_NOT_FOUND (store M07), no job", async () => {
    const render = await import("../../vendor/src/lib/studio/services/render")
    const jobs = q<{ n: number }>("SELECT count(*) AS n FROM render_job")[0].n
    await expect(render.renderArtifact("cnotanartifact00000000000", ["SVG"], { kind: "INTERNAL_AGENT", requester: "agent:row31c", canWriteClassK: false })).rejects.toMatchObject({ code: "ARTIFACT_NOT_FOUND" })
    expect(q<{ n: number }>("SELECT count(*) AS n FROM render_job")[0].n).toBe(jobs)
    expect(fetchCalls).toBe(0)
  })

  test("durable logs: route events under <store>/logs/api, render jobs persisted with their engine log", () => {
    const apiLogs = path.join(STORE, "logs", "api")
    const files = readdirSync(apiLogs)
    const text = files.map((f) => readFileSync(path.join(apiLogs, f), "utf8")).join("\n")
    expect(text).toContain("studio.api.render")
    expect(text).toContain("studio.api.fig03b")
    const rows = q<{ n: number }>("SELECT count(*) AS n FROM render_job WHERE engine IS NOT NULL")[0].n
    expect(rows).toBeGreaterThan(3)
    evidence.logs = { apiLogFiles: files, renderJobs: rows }
  })
})
