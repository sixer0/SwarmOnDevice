// Row 162b (C153): the real host (studio_render over the real store, MCP client, row 24 bridge with the fake PageEngine,
// same harness as test/render-port/row31c-render.test.ts) renders a document whose diagram is messy (route defects in the
// original layout) and the render now goes through buildDiagramSvgAuto, so ELK lays it out. Evidence: the stored DOCX/HTML
// figure svg differs from the plain buildDiagramSvg output and has fewer route defects (geometry lint), plus a clean diagram
// keeps its original svg byte for byte.
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
const BASE = process.env.ROW162B_TEST_DIR ?? "/private/tmp/claude-501/row162b/tests"
mkdirSync(BASE, { recursive: true })
const WORK = realpathSync(mkdtempSync(path.join(BASE, "row162b-")))
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

const PORT = Number(process.env.ROW162B_PORT ?? 47362)
const TOKEN = "c".repeat(16) + "0123456789abcdef".repeat(3)
const FACTS = { home: HOME, resourcesPath: RES, execPath: path.join(WORK, "Swarm.app", "Contents", "MacOS", "Swarm") }
const SECRET = "q".repeat(64)

const realFetch = globalThis.fetch
let fetchCalls = 0
globalThis.fetch = (async () => {
  fetchCalls++
  throw new Error("row162b test: globalThis.fetch must not be called by the host")
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
  info = { electron: "fake-row162b", chrome: "fake-row162b", partition: "datum-render", sandbox: raster.sandbox, contextIsolation: raster.contextIsolation, nodeIntegration: raster.nodeIntegration, javascriptContent: raster.javascript, network: "blocked" }
  bridge = await bridgeMod.startRenderBridge({ fontsDir: FONTS, log: () => {}, engine: fakeEngine, baseDir: WORK })
  process.env.DATUM_RENDER_SOCKET = bridge.env.DATUM_RENDER_SOCKET
  process.env.DATUM_RENDER_TOKEN = bridge.env.DATUM_RENDER_TOKEN

  mod = await import("../../src/mcp-host/index.ts")
  store = await mod.openHostStore(STORE, { release: "1.2.0", logFile: path.join(WORK, "logs", "store.jsonl") })
  mod.configureTemplateSource({ templatesDir: TEMPLATES, assetRepoRoot: VENDOR, release: "1.2.0" })
  host = await mod.startStudioHostServer({ store, token: TOKEN, hostname: "127.0.0.1", port: PORT, log: () => {}, facts: FACTS })
  c = new Client({ name: "row162b-test", version: "0" })
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
  console.log(`row162b evidence ${JSON.stringify(evidence)}`)
})

// ── ELK reaches studio_render ────────────────────────────────────────────────────────────────────

const E = path.join(VENDOR, "src", "lib", "studio", "engine", "diagram")
// Synthetic messy figure: 4 tiers x 3 nodes, one data edge per node plus 5 control edges (LCG seed 27). The plain build
// (buildDiagramSvg on the composed spec at 128 mm) has 5 edge crossings; ELK (R3/R4) leaves 2 route defects, 0 crossings.
function messy(seed: number) {
  const tiers = [3, 3, 3, 3]
  const nodes: unknown[] = []
  tiers.forEach((m, t) => { for (let i = 0; i < m; i++) nodes.push({ id: `t${t}n${i}`, label: `Unit ${t}.${i}`, sub: "node", class: { tier: t } }) })
  const edges: unknown[] = []
  let r = seed
  const rnd = () => { r = (r * 1103515245 + 12345) % 2147483648; return r / 2147483648 }
  for (let t = 0; t < 3; t++) for (let i = 0; i < tiers[t]; i++) edges.push({ from: `t${t}n${i}`, to: `t${t + 1}n${Math.floor(rnd() * tiers[t + 1])}`, kind: "data", label: "L" })
  for (let i = 0; i < 5; i++) { const t = Math.floor(rnd() * 3); edges.push({ from: `t${t}n${Math.floor(rnd() * tiers[t])}`, to: `t${t + 1}n${Math.floor(rnd() * tiers[t + 1])}`, kind: "control", label: "C" }) }
  return { family: "layered", classification: "TERBATAS", sources: ["uji row 162b"], notes: [], nodes, edges, legend: ["data = aliran data", "control = kendali"] }
}

const ROUTE_KINDS = ["edgeCross", "edgeCollinear", "edgeThroughNode", "lineThroughText"] as const
const defectsOf = (counts: Record<string, number>) => ROUTE_KINDS.reduce((n, k) => n + (counts[k] ?? 0), 0)

describe("row 162b: studio_render uses ELK for a messy diagram", () => {
  test("a messy layered diagram rendered by studio_render has fewer route defects than the plain build (ELK used); a clean one is unchanged", async () => {
    const lint = await import(path.join(E, "fit", "lint.ts"))
    const comp = await import(path.join(VENDOR, "src", "lib", "studio", "services", "compose", "blocks.ts"))
    const bd = await import(path.join(E, "build", "index.ts"))
    const created = await call("studio_document_create", { template: "datum-gsp", mission: "2026-11-07_row162b", docKey: "elk-doc", title: "Dokumen uji ELK row 162b" })
    documentId = String(created.documentId)
    const spec = messy(27)
    const block = { type: "diagram", id: "elk-d1", spec, caption: { text: "Uji tata letak ELK." }, source: { text: "uji row 162b" } }
    const sub = await call("studio_chapter_submit", { submission: { $schema: "studio.chapter/v2", target: { documentId }, chapter: { key: "1", title: { text: "Uji ELK" }, sections: [{ title: { text: "Diagram" }, blocks: [block] }] } } })
    expect(sub.ok).toBe(true)
    const r = await call("studio_render", { documentId, scope: "chapter", key: "1", formats: ["html"] })
    expect(r.ok).toBe(true)
    const stored = checkStored(r.outputs as Output[])
    const html = readFileSync(path.join(STORE, stored.find((s) => s.format === "HTML")!.relPath), "utf8")
    const svgs = (html.match(/<svg[\s\S]*?<\/svg>/g) ?? []).filter((sv) => sv.includes("Unit 0.0"))
    expect(svgs.length).toBe(1)
    const rendered = lint.lintDiagramGeometry(svgs[0]) as { counts: Record<string, number>; score: number }
    const plainSpec = comp.diagramSpec(spec, "Uji tata letak ELK.", "uji row 162b", 128, { artifactLabel: "1.1", classification: "TERBATAS" })
    const plain = lint.lintDiagramGeometry(bd.buildDiagramSvg(plainSpec, { release: false }).svg) as { counts: Record<string, number>; score: number }
    console.log(`row162b ELK in studio_render: plain route defects ${defectsOf(plain.counts)} (edgeCross ${plain.counts.edgeCross}) -> rendered ${defectsOf(rendered.counts)} (edgeCross ${rendered.counts.edgeCross})`)
    expect(defectsOf(plain.counts)).toBe(5)
    expect(defectsOf(rendered.counts)).toBeLessThan(defectsOf(plain.counts))
    expect(rendered.counts.edgeCross).toBe(0)
    expect(rendered.score).toBeLessThan(plain.score)
  })

  test("a clean diagram rendered by studio_render keeps the plain build's route defects at 0 (R2, original layout)", async () => {
    const lint = await import(path.join(E, "fit", "lint.ts"))
    const created = await call("studio_document_create", { template: "datum-gsp", mission: "2026-11-07_row162b", docKey: "clean-doc", title: "Dokumen uji bersih row 162b" })
    const id = String(created.documentId)
    const spec = messy(1)
    const sub = await call("studio_chapter_submit", { submission: { $schema: "studio.chapter/v2", target: { documentId: id }, chapter: { key: "1", title: { text: "Uji" }, sections: [{ title: { text: "Diagram" }, blocks: [{ type: "diagram", id: "clean-d1", spec, caption: { text: "Uji bersih." }, source: { text: "uji row 162b" } }] }] } } })
    expect(sub.ok).toBe(true)
    const r = await call("studio_render", { documentId: id, scope: "chapter", key: "1", formats: ["html"] })
    expect(r.ok).toBe(true)
    const stored = checkStored(r.outputs as Output[])
    const html = readFileSync(path.join(STORE, stored.find((s) => s.format === "HTML")!.relPath), "utf8")
    const svgs = (html.match(/<svg[\s\S]*?<\/svg>/g) ?? []).filter((sv) => sv.includes("Unit 0.0"))
    expect(svgs.length).toBe(1)
    expect(defectsOf((lint.lintDiagramGeometry(svgs[0]) as { counts: Record<string, number> }).counts)).toBe(0)
  })
})
