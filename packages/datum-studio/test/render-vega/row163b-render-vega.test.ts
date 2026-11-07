// Row 163b (decision C155): the Vega chart family (row 163, engine/chart/family-v) on the agent render path, through
// the REAL host (startStudioHostServer over a temp store, MCP SDK client over streamable HTTP; studio_document_create +
// studio_chapter_submit + studio_render with the row 154 verification wrapper the host installs by default):
//   - each V type (and a DF alias) in a document renders through family-v in HTML and DOCX (300 dpi PNG, 1512 px wide);
//   - the row 154 verification report of that render passes LINT and FIGURE_FIT;
//   - each type renders in studio_figure_preview (stored pid, and the catalog's inline example block);
//   - studio_registry kind=charts carries the agent-facing schema per type (meta.vega), the ajv schemas the family uses;
//   - a block carrying a Vega expression or a URL is refused (submit, preview, and at the render seam itself).
// The render bridge is a transport stub (`setRenderBridgeTransport`, as rows 32/67/151/154): Electron cannot run under
// bun. png answers a real decodable PNG of the requested pixel size; measure/overlap answer a clean page.
// Needs the command sandbox off (binds an ephemeral port). globalThis.fetch is a trap: the host must never call it.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { deflateSync } from "node:zlib"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import path from "node:path"
import { unzipSync } from "fflate"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import * as runtime from "../../vendor/src/lib/studio/engine/browser/runtime"
import { MEASURE_SCRIPT } from "../../vendor/src/lib/studio/engine/browser/measure"
import { OVERLAP_SCRIPT, OVERLAP_SCRIPT_NAME } from "../../src/mcp-host/verify/overlap-script"

const PKG = path.resolve(import.meta.dir, "..", "..")
const VENDOR = path.join(PKG, "vendor")
const TEMPLATES = path.join(PKG, "templates")
const BASE = process.env.ROW163B_TEST_DIR ?? "/private/tmp/claude-501/row163b/tests"
mkdirSync(BASE, { recursive: true })
const WORK = realpathSync(mkdtempSync(path.join(BASE, "row163b-")))
const STORE = path.join(WORK, "datum-studio")
const HOME = path.join(WORK, "home")
const RES = path.join(WORK, "Swarm.app", "Contents", "Resources")
const PROJECT = path.join(HOME, "project-163b")
for (const d of [HOME, RES, PROJECT]) mkdirSync(d, { recursive: true })

const ENV_KEYS = ["STUDIO_WORKSPACE_ROOT", "STUDIO_ASSETS_ROOT", "STUDIO_VENDOR_ROOT", "STUDIO_MCP_FILE_ROOTS", "INTERNAL_API_SECRET", "DATUM_RENDER_SOCKET", "DATUM_RENDER_TOKEN", "STUDIO_VERIFY_BUDGET_MS"] as const
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
const TOKEN = "e".repeat(16) + "0123456789abcdef".repeat(3)
const FACTS = { home: HOME, resourcesPath: RES, execPath: path.join(WORK, "Swarm.app", "Contents", "MacOS", "Swarm") }

const realFetch = globalThis.fetch
let fetchCalls = 0
globalThis.fetch = (async () => {
  fetchCalls++
  throw new Error("row163b test: globalThis.fetch must not be called by the host")
}) as unknown as typeof fetch

async function resetEnvCache() {
  const { resetStudioEnvCache } = await import("../../vendor/src/lib/studio/contract/env")
  const { resetRenderRateLimiter } = await import("../../vendor/src/lib/studio/http/render-guard")
  const { resetBridgePdfReadiness } = await import("../../vendor/src/lib/studio/services/render")
  resetStudioEnvCache()
  resetRenderRateLimiter()
  resetBridgePdfReadiness()
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

// ── render bridge stub (row 154's, plus png) ─────────────────────────────────────────────────────────────────
const GOOD_INFO = { electron: "42.3.3", chrome: "142.0.0.0", partition: "datum-render", sandbox: true, contextIsolation: true, nodeIntegration: false, javascriptContent: false, network: "blocked", fonts: 16, scripts: ["studio.measure", OVERLAP_SCRIPT_NAME] }
const pngJobs: Array<{ width: number; height: number; svgHasUrl: boolean }> = []
const sheetsOf = (html: string) => Math.max(1, (html.match(/<section\b[^>]*class="[^"]*\bpage\b/g) ?? []).length)
const fakePdf = (pages: number) => Buffer.from(`%PDF-1.4\n1 0 obj<</Type /Pages /Count ${pages}>>endobj\n%%EOF\n`, "latin1")
function installBridge() {
  runtime.setRenderBridgeTransport(async (req) => {
    if (req.op === "hello") return { ok: true, ...GOOD_INFO }
    if (req.op === "png") {
      const svg = existsSync(String(req.src)) ? readFileSync(String(req.src), "utf8") : ""
      pngJobs.push({ width: Number(req.width), height: Number(req.height), svgHasUrl: /(?:href|src)\s*=\s*["'](?!#|data:)/i.test(svg) })
      writeFileSync(String(req.dst), realPng(Math.max(1, Number(req.width)), Math.max(1, Number(req.height))))
      return { ok: true, dst: req.dst }
    }
    if (req.op === "pdf") {
      const src = String(req.src ?? "")
      const html = typeof req.html === "string" ? req.html : existsSync(src) ? readFileSync(src, "utf8") : ""
      writeFileSync(String(req.dst), fakePdf(sheetsOf(html)))
      return { ok: true, electron: "42.3.3", dst: req.dst }
    }
    if (req.op === "checkPage") {
      const n = sheetsOf(String(req.html ?? ""))
      if (req.script === MEASURE_SCRIPT) {
        const elements = Array.from({ length: n }, (_, i) => [
          { kind: "page", page: i + 1, xMm: 0, yMm: i * 297, widthMm: 210, heightMm: 297, colors: ["#101418"], label: "page", overflow: false },
          { kind: "text", page: i + 1, xMm: 24, yMm: 30, widthMm: 160, heightMm: 5, address: `${i + 1}`, tag: "p", label: "st-p", fontSizePt: 10, measureMm: 160, lineCount: 1, charCount: 40, charsPerLine: 40, maxLineWidthMm: 120 },
        ]).flat()
        return { ok: true, script: "studio.measure", result: { paged: true, pageCount: n, truncated: false, elements } }
      }
      if (req.script === OVERLAP_SCRIPT) {
        return { ok: true, script: OVERLAP_SCRIPT_NAME, result: { paged: true, pageCount: n, truncated: false, marginsUnreadable: false, contentHeightMm: null, boxes: 40, findingsTotal: 0, findings: [] } }
      }
      return { ok: false, code: "SCRIPT_NOT_ALLOWED", message: "stub" }
    }
    if (req.op === "pagePng") {
      const dir = String(req.dstDir)
      const pages = (Array.isArray(req.pages) ? (req.pages as number[]) : [1]).map((p) => {
        const dst = path.join(dir, `p${String(p).padStart(3, "0")}.png`)
        const bytes = realPng(8, 8)
        writeFileSync(dst, bytes)
        return { n: p, dst, width: 8, height: 8, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }
      })
      return { ok: true, layout: "paged", media: "print", pageCount: Math.max(...pages.map((p) => p.n)), pageSizeMm: { wMm: 210, hMm: 297 }, pageSizeSource: "css", dpi: 150, pages }
    }
    return { ok: false, code: "BAD_REQUEST", message: "stub" }
  })
}

// ── host, client, helpers ────────────────────────────────────────────────────────────────────────────────────
type Mod = typeof import("../../src/mcp-host/index.ts")
let mod: Mod
let store: Awaited<ReturnType<Mod["openHostStore"]>>
let host: Awaited<ReturnType<Mod["startStudioHostServer"]>>
let c: Client

type Structured = Record<string, unknown> & { ok?: boolean; code?: string }
async function call(name: string, args: Record<string, unknown>): Promise<Structured> {
  const r = await c.callTool({ name, arguments: args })
  return (r.structuredContent ?? {}) as Structured
}

function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T[] {
  return (store as unknown as { requireReader(): { all(s: string, p?: unknown[]): unknown[] } }).requireReader().all(sql, params) as T[]
}

type Output = { id: string; format: string; role: string; sha256: string }

/** Every output row of a render: stored with sha (row sha = disk sha of rel_path under the store). */
function checkStored(outputs: Output[]): Array<{ format: string; sha256: string; relPath: string; diskSha: string }> {
  return outputs.map((o) => {
    const row = q<{ rel_path: string; sha256: string; format: string }>("SELECT rel_path, sha256, format FROM output_file WHERE id = ?", [o.id])[0]
    expect(row).toBeDefined()
    const diskSha = createHash("sha256").update(readFileSync(path.join(STORE, row.rel_path))).digest("hex")
    return { format: row.format, sha256: row.sha256, relPath: row.rel_path, diskSha }
  })
}

const evidence: Record<string, unknown> = {}

beforeAll(async () => {
  process.env.STUDIO_WORKSPACE_ROOT = STORE
  process.env.STUDIO_ASSETS_ROOT = path.join(VENDOR, "src", "lib", "studio", "assets")
  process.env.STUDIO_VENDOR_ROOT = VENDOR
  for (const k of ["STUDIO_MCP_FILE_ROOTS", "INTERNAL_API_SECRET", "DATUM_RENDER_SOCKET", "DATUM_RENDER_TOKEN", "STUDIO_VERIFY_BUDGET_MS"]) delete process.env[k]
  await resetEnvCache()
  runtime.setRenderBridgeTransport(null)
  installBridge()
  mod = await import("../../src/mcp-host/index.ts")
  store = await mod.openHostStore(STORE, { release: "1.2.1", logFile: path.join(WORK, "logs", "store.jsonl") })
  mod.configureTemplateSource({ templatesDir: TEMPLATES, assetRepoRoot: VENDOR, release: "1.2.1" })
  host = await mod.startStudioHostServer({ store, token: TOKEN, hostname: "127.0.0.1", port: 0, log: () => {}, facts: FACTS })
  c = new Client({ name: "row163b-test", version: "0" })
  await c.connect(
    new StreamableHTTPClientTransport(new URL(host.url), {
      fetch: realFetch as never,
      requestInit: { headers: { authorization: `Bearer ${TOKEN}`, "x-studio-agent": "claude", "x-studio-caller-cwd": encodeURIComponent(PROJECT) } },
    }),
  )
}, 120_000)

afterAll(async () => {
  await c?.close().catch(() => undefined)
  await host?.close()
  mod?.configureTemplateSource(null)
  if (store) await mod.closeHostStore(store)
  runtime.setRenderBridgeTransport(null)
  globalThis.fetch = realFetch
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  await resetEnvCache()
  console.log(`row163b evidence ${JSON.stringify(evidence)}`)
})

// ── Row 163b: the Vega family through studio_render, preview and the registry ─────────────────────────────────────


type S = Record<string, any>

function seq(seed: number, n: number, lo: number, hi: number): number[] {
  let x = seed >>> 0
  return Array.from({ length: n }, () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0
    return Math.round((lo + ((hi - lo) * x) / 0xffffffff) * 10) / 10
  })
}
const year = () => {
  const t0 = Date.UTC(2026, 0, 1)
  return seq(7, 365, 0, 40).map((v, i) => ({ date: new Date(t0 + i * 86_400_000).toISOString().slice(0, 10), value: v }))
}
const hierarchy7 = [
  { id: "root", label: "Anggaran" },
  { id: "a", parent: "root", label: "Operasi" },
  { id: "b", parent: "root", label: "Pembinaan" },
  { id: "c", parent: "root", label: "Dukungan" },
  { id: "a1", parent: "a", label: "Patroli", value: 40 },
  { id: "a2", parent: "a", label: "Siaga", value: 25 },
  { id: "b1", parent: "b", label: "Latihan", value: 20 },
  { id: "b2", parent: "b", label: "Kajian", value: 10 },
  { id: "c1", parent: "c", label: "Logistik", value: 18 },
  { id: "c2", parent: "c", label: "TI", value: 12 },
]
const hierarchy8 = [
  { id: "k", label: "Komandan" },
  { id: "o", parent: "k", label: "Operasi" },
  { id: "i", parent: "k", label: "Intelijen" },
  { id: "l", parent: "k", label: "Logistik" },
  { id: "o1", parent: "o", label: "Regu 1" },
  { id: "o2", parent: "o", label: "Regu 2" },
  { id: "i1", parent: "i", label: "Analis" },
  { id: "l1", parent: "l", label: "Gudang" },
]
const radar = {
  shape: "series",
  categories: ["Analisis", "Respons", "Koordinasi", "Logistik", "Pelaporan", "Pelatihan"],
  series: [
    { name: "Tim A", values: [80, 65, 70, 55, 90, 60] },
    { name: "Tim B", values: [60, 85, 50, 75, 65, 80] },
  ],
}

/** Agent-written v2 chart blocks: one per V type, plus DF-01 (radar) through the vegaChartFor alias. */
const BLOCKS: Array<{ code: string; via: string; block: S }> = [
  { code: "V-01", via: "V-01", block: { code: "V-01", unit: "insiden", data: { shape: "days", days: year() }, highlight: ["2026-08-17"], options: { weekStart: "monday" } } },
  {
    code: "V-02",
    via: "V-02",
    block: {
      code: "V-02",
      data: {
        shape: "series",
        categories: ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"],
        series: [
          { name: "Telepon", values: seq(1, 12, 20, 60) },
          { name: "Surel", values: seq(2, 12, 10, 40) },
          { name: "Aplikasi", values: seq(3, 12, 30, 90) },
        ],
      },
      highlight: ["Aplikasi"],
    },
  },
  {
    code: "V-03",
    via: "V-03",
    block: {
      code: "V-03",
      dec: 1,
      data: { shape: "matrix", rows: ["Wilayah A", "Wilayah B", "Wilayah C", "Wilayah D"], cols: ["Respons", "Tuntas", "Biaya", "Kepuasan"], values: [0, 1, 2, 3].map((i) => seq(101 + 7919 * i, 4, 10, 90)) },
      highlight: ["Wilayah C"],
    },
  },
  {
    code: "V-04",
    via: "V-04",
    block: { code: "V-04", unit: "menit", data: { shape: "distribution", groups: [{ name: "Unit utara", values: seq(21, 80, 2, 45) }, { name: "Unit selatan", values: seq(22, 60, 5, 60) }] }, highlight: ["Unit selatan"] },
  },
  {
    code: "V-05",
    via: "V-05",
    block: {
      code: "V-05",
      data: { shape: "categorical", points: [{ label: "Banjir", value: 42 }, { label: "Kebakaran", value: 18 }, { label: "Longsor", value: 25 }, { label: "Angin", value: 9 }, { label: "Kekeringan", value: 30 }] },
      highlight: ["Banjir"],
    },
  },
  { code: "V-06", via: "V-06", block: { code: "V-06", data: radar, highlight: ["Tim B"], options: { max: 100 } } },
  { code: "V-07", via: "V-07", block: { code: "V-07", data: { shape: "hierarchy", nodes: hierarchy7 }, highlight: ["a1"], options: { form: "icicle" } } },
  { code: "V-08", via: "V-08", block: { code: "V-08", data: { shape: "hierarchy", nodes: hierarchy8 }, highlight: ["i"] } },
  { code: "DF-01", via: "V-06", block: { code: "DF-01", data: radar } },
]
const pidOf = (code: string) => `vg-${code.toLowerCase()}`
const chartBlock = (b: { code: string; block: S }, i: number) => ({
  type: "chart",
  id: pidOf(b.code),
  ...b.block,
  caption: { text: `Uji keluarga Vega ${b.code} nomor ${i + 1}.` },
  source: { text: "Data uji row 163b, diolah." },
})

let vegaDoc = ""
const pngWidth = (png: Uint8Array) => Buffer.from(png).readUInt32BE(16)

describe("row 163b: Vega charts in studio_render (HTML + DOCX) through the real host", () => {
  test("every V type and the DF-01 alias render through family-v; DOCX PNGs are 300 dpi (128 mm -> 1512 px); LINT and FIGURE_FIT pass", async () => {
    const created = await call("studio_document_create", { template: "datum-nota", mission: "2026-11-08_row163b", docKey: "vega-doc", title: "Dokumen uji Vega row 163b" })
    expect(created.ok).toBe(true)
    vegaDoc = String(created.documentId)
    const sub = await call("studio_chapter_submit", {
      submission: { $schema: "studio.chapter/v2", target: { documentId: vegaDoc }, chapter: { key: "1", title: { text: "Uji Vega" }, sections: [{ title: { text: "Grafik" }, blocks: [{ type: "paragraph", text: "Bab ini memuat grafik keluarga Vega untuk uji render dokumen." }, ...BLOCKS.map(chartBlock)] }] } },
    })
    if (sub.ok !== true) console.log(`row163b submit ${JSON.stringify(sub).slice(0, 2000)}`)
    expect(sub.ok).toBe(true)
    const before = pngJobs.length
    const r = await call("studio_render", { documentId: vegaDoc, formats: ["html", "docx"] })
    if (r.ok !== true) console.log(`row163b render ${JSON.stringify(r).slice(0, 3000)}`)
    expect(r.ok).toBe(true)
    const outs = r.outputs as Output[]
    const stored = checkStored(outs)
    for (const s of stored) expect(s.diskSha).toBe(s.sha256)

    // HTML: one Vega SVG per block, the code the family drew, no Rev A refusal
    const html = readFileSync(path.join(STORE, stored.find((s) => s.format === "HTML")!.relPath), "utf8")
    const vegaSvgs = (html.match(/<svg\b[^>]*data-engine="vega"[\s\S]*?<\/svg>/g) ?? [])
    const drawn = vegaSvgs.map((sv) => /data-chart="([^"]+)"/.exec(sv)?.[1])
    expect(drawn).toEqual(BLOCKS.map((b) => b.via))
    expect(html).not.toContain("CHART_KIND_NOT_DRAWN")
    for (const sv of vegaSvgs) {
      expect(sv).not.toMatch(/<(script|image|foreignObject|a)\b/i)
      expect(sv).not.toMatch(/\bhref=|https?:\/\/(?!www\.w3\.org)/i)
    }

    // DOCX: one drawing per figure at the SVG's mm size, each embedding a PNG 1512 px wide (128 mm at 300 dpi). The fake
    // page engine paints blank PNGs of the requested size, so equal-sized figures share one media file (content hash).
    const docx = readFileSync(path.join(STORE, stored.find((s) => s.format === "DOCX")!.relPath))
    const zip = unzipSync(new Uint8Array(docx))
    const xml = Buffer.from(zip["word/document.xml"]!).toString("utf8")
    const rels = Buffer.from(zip["word/_rels/document.xml.rels"]!).toString("utf8")
    const target = (rid: string) => new RegExp(`Id="${rid}"[^>]*Target="([^"]+)"`).exec(rels)?.[1] ?? new RegExp(`Target="([^"]+)"[^>]*Id="${rid}"`).exec(rels)?.[1]
    const drawings = [...xml.matchAll(/<w:drawing>[\s\S]*?<\/w:drawing>/g)].map((m) => ({
      cy: Number(/<wp:extent cx="\d+" cy="(\d+)"/.exec(m[0])?.[1]),
      cx: Number(/<wp:extent cx="(\d+)"/.exec(m[0])?.[1]),
      media: target(/r:embed="([^"]+)"/.exec(m[0])?.[1] ?? ""),
    }))
    const sizes = vegaSvgs.map((sv) => ({ w: Number(/<svg\b[^>]*\bwidth="([\d.]+)mm"/.exec(sv)?.[1]), h: Number(/<svg\b[^>]*\bheight="([\d.]+)mm"/.exec(sv)?.[1]) }))
    const figs = sizes.map((z) => drawings.find((d) => d.cx === Math.round(z.w * 36000) && Math.abs(d.cy - Math.round(z.h * 36000)) <= 1))
    const widths = figs.map((d) => (d?.media ? pngWidth(zip[`word/${d.media}`]!) : null))
    const jobs = pngJobs.slice(before).map((j) => j.width)
    console.log(`row163b DOCX drawings ${drawings.length}, chart drawings ${figs.filter(Boolean).length}, png widths ${JSON.stringify(widths)}, bridge png jobs ${JSON.stringify(jobs)}, svg mm ${JSON.stringify(sizes)}`)
    expect(sizes.every((z) => z.w === 128)).toBe(true)
    expect(figs.every((d) => d !== undefined)).toBe(true)
    expect(widths).toEqual(BLOCKS.map(() => 1512))
    expect(jobs.length).toBeGreaterThanOrEqual(BLOCKS.length)
    expect(pngJobs.slice(before).every((j) => !j.svgHasUrl)).toBe(true)
    // row 154 verification report of this render
    const v = r.verification as S
    expect(v.$schema).toBe("studio.output-verification/v1")
    const checks = (v.outputs as S[]).map((o) => ({ format: o.format, state: o.state, checks: (o.checks as S[]).map((k) => `${k.id}:${k.status}${k.reason ? `/${k.reason}` : ""}`) }))
    console.log(`row163b verification ${JSON.stringify({ overall: v.overall, checks })}`)
    for (const f of ["HTML", "DOCX"]) {
      const o = (v.outputs as S[]).find((x) => x.format === f)!
      expect(o).toBeDefined()
      for (const id of ["LINT", "FIGURE_FIT"]) expect((o.checks as S[]).find((k) => k.id === id)!.status).toBe("PASS")
    }
    evidence.render = { drawings: drawings.length, widths, drawn, checks }
  }, 120_000)

  test("each V type (and DF-01) renders in studio_figure_preview by pid, through family-v", async () => {
    const got: string[] = []
    for (const b of BLOCKS) {
      const p = await call("studio_figure_preview", { documentId: vegaDoc, pid: pidOf(b.code) })
      if (p.rendered !== true) console.log(`row163b preview ${b.code} ${JSON.stringify(p).slice(0, 1500)}`)
      expect(p.rendered).toBe(true)
      const f = p.figure as S
      expect(f.type).toBe("chart")
      expect(f.code).toBe(b.code)
      expect(f.rendered.code).toBe(b.via)
      expect(f.size.widthMm).toBe(128)
      expect(f.data.items).toBeGreaterThan(0)
      expect(f.layoutIssueCount).toBe(0)
      got.push(`${b.code}->${f.rendered.code} ${f.size.widthMm}x${f.size.heightMm}mm issues ${f.layoutIssueCount}`)
    }
    console.log(`row163b preview ${JSON.stringify(got)}`)
    evidence.preview = got
  }, 60_000)
})

describe("row 163b: the agent-facing catalog (studio_registry kind=charts, meta.vega)", () => {
  test("8 types with description, data + options schemas (the family's own ajv schemas), highlight rule and an example block", async () => {
    const reg = await call("studio_registry", { kind: "charts" })
    expect(reg.count).toBe(76)
    const vega = (reg.meta as S).vega as S
    expect(vega.schema).toBe("studio.chart-vega/v1")
    expect(vega.count).toBe(8)
    expect(String(vega.usage)).toContain("closed")
    const { vegaChartInputSchema } = await import("../../vendor/src/lib/studio/engine/chart/family-v/input")
    const { VEGA_CHART_REGISTRY } = await import("../../vendor/src/lib/studio/registry/charts")
    expect((vega.items as S[]).map((i) => i.code)).toEqual(VEGA_CHART_REGISTRY.map((d) => d.code))
    for (const it of vega.items as S[]) {
      expect(String(it.description).length).toBeGreaterThan(20)
      const schema = vegaChartInputSchema(it.code) as S
      expect(it.data).toEqual(schema.properties.data)
      expect(it.options).toEqual(schema.properties.options ?? null)
      expect(it.example.code).toBe(it.code)
    }
    evidence.catalog = (vega.items as S[]).map((i) => `${i.code} ${i.name}${i.replaces ? ` (${i.replaces})` : ""}`)
  })

  test("every catalog example block renders inline in studio_figure_preview", async () => {
    const reg = await call("studio_registry", { kind: "charts" })
    const out: string[] = []
    for (const it of ((reg.meta as S).vega as S).items as S[]) {
      const p = await call("studio_figure_preview", { documentId: vegaDoc, block: it.example })
      if (p.rendered !== true) console.log(`row163b example ${it.code} ${JSON.stringify(p).slice(0, 1500)}`)
      expect(p.rendered).toBe(true)
      expect((p.figure as S).rendered.code).toBe(it.code)
      out.push(String(it.code))
    }
    expect(out.length).toBe(8)
  }, 60_000)

  test("the DF codes the v2 schema accepts options for are exactly the vegaChartFor aliases", async () => {
    const { VEGA_ALIAS_CHART_CODES_V2, VEGA_CHART_CODES_V2 } = await import("../../vendor/src/lib/studio/contract/schema/v2/common.schema")
    const { VEGA_CHART_REGISTRY, vegaChartFor } = await import("../../vendor/src/lib/studio/registry/charts")
    const { VEGA_CHART_CODES } = await import("../../vendor/src/lib/studio/engine/chart/family-v/input")
    expect([...VEGA_CHART_CODES_V2]).toEqual([...VEGA_CHART_CODES])
    expect(([...VEGA_ALIAS_CHART_CODES_V2] as string[]).sort()).toEqual(VEGA_CHART_REGISTRY.flatMap((d) => (d.replaces ? [d.replaces] : [])).sort())
    for (const df of VEGA_ALIAS_CHART_CODES_V2) expect(vegaChartFor(df)).not.toBeNull()
  })
})

describe("row 163b: expressions and URLs are refused", () => {
  const bad: Array<[string, S]> = [
    ["expression key in data", { code: "V-06", data: { ...radar, series: [{ name: "Tim A", values: [1, 2, 3, 4, 5, 6], expr: "datum.x" }] } }],
    ["signal in options", { code: "V-02", data: radar, options: { signal: "width" } }],
    ["url data", { code: "V-04", data: { shape: "distribution", url: "https://example.com/data.json", groups: [{ name: "A", values: [1, 2] }] } }],
    ["Vega spec smuggled as data", { code: "V-05", data: { shape: "categorical", points: [{ label: "A", value: 1 }], transform: [{ calculate: "1", as: "x" }] } }],
    ["options on a Rev A code", { code: "P-01", data: { shape: "categorical", points: [{ label: "A", value: 1 }] }, options: { form: "icicle" } }],
  ]

  test("studio_chapter_submit refuses each bad block (SCHEMA_INVALID, nothing written)", async () => {
    const created = await call("studio_document_create", { template: "datum-gsp", mission: "2026-11-08_row163b", docKey: "vega-bad", title: "Dokumen uji tolak row 163b" })
    const id = String(created.documentId)
    for (const [name, b] of bad) {
      const sub = await call("studio_chapter_submit", {
        submission: { $schema: "studio.chapter/v2", target: { documentId: id }, chapter: { key: "1", title: { text: "Tolak" }, sections: [{ title: { text: "G" }, blocks: [chartBlock({ code: "bad-x", block: b }, 0)] }] } },
      })
      console.log(`row163b refused at submit: ${name} -> ${String(sub.code)}`)
      expect(sub.ok).not.toBe(true)
      expect(String(sub.code)).toMatch(/SCHEMA_INVALID|BY_CONSTRUCTION_FAILED/)
    }
  })

  test("studio_figure_preview refuses the same blocks inline", async () => {
    for (const [, b] of bad) {
      const p = await call("studio_figure_preview", { documentId: vegaDoc, block: chartBlock({ code: "bad-y", block: b }, 0) })
      expect(p.rendered).not.toBe(true)
    }
  })

  test("at the render seam (a stored spec that bypassed the schema): SCHEMA_INVALID before Vega runs, nothing fetched", async () => {
    const { renderVegaFigure } = await import("../../vendor/src/lib/studio/services/render/vega-figure")
    const { EMPTY_CHART_TEMPLATE } = await import("../../vendor/src/lib/studio/engine/chart/core/composite")
    const base = { $schema: "studio.chart/v1", kind: "V-06", title: "Uji.", source: "Uji.", widthMm: 128 }
    const cases: S[] = [
      { ...base, data: { ...radar, series: [{ name: "A", values: [1, 2, 3, 4, 5, 6], signal: "x" }] } },
      { ...base, data: { ...radar, url: "https://example.com/x.json" } },
      { ...base, data: radar, options: { expr: "datum.a" } },
      { ...base, data: radar, params: { binEdges: [0, 1] } },
      { ...base, data: radar, x: undefined, intent: { topN: 3 } },
      { ...base, data: { shape: "series", categories: ["a", "b", "c"], series: [{ name: "<script>alert(1)</script>", values: [1, 2, 3] }] } },
    ]
    for (const spec of cases) {
      let code = "rendered"
      try {
        await renderVegaFigure(spec as never, "V-06", EMPTY_CHART_TEMPLATE)
      } catch (e) {
        code = (e as { code?: string }).code ?? "?"
      }
      expect(code).toBe("SCHEMA_INVALID")
    }
    expect(fetchCalls).toBe(0)
  })
})
