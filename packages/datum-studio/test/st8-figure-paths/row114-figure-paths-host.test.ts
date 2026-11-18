// 1.3.3 row 114 (ST-8 item 1): `studio_render` with `figures: ["svg"]` returns, per figure file, the absolute path of
// the stored file, its sha256, label and block id. Through the REAL host server (startStudioHostServer, streamable HTTP
// on 127.0.0.1, MCP SDK client) over a temp store with missionGuard, the harness of row 68
// (test/mc8-project-copy/row68-render-project-copy.test.ts): the render bridge is a transport stub, Electron cannot
// run under bun. Needs the command sandbox off (binds an ephemeral port). globalThis.fetch is a trap.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs"
import path from "node:path"
import { deflateSync } from "node:zlib"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { PERSON_KEY, personCaller } from "../mission-tools/_attested-person.ts"
import { FIXTURE, META, clone, diagramsOf } from "../diagram-persist/hna-host"
import * as runtime from "../../vendor/src/lib/studio/engine/browser/runtime"
import { MEASURE_SCRIPT } from "../../vendor/src/lib/studio/engine/browser/measure"
import { OVERLAP_SCRIPT, OVERLAP_SCRIPT_NAME } from "../../src/mcp-host/verify/overlap-script"

const PKG = path.resolve(import.meta.dir, "..", "..")
const VENDOR = path.join(PKG, "vendor")
const TEMPLATES = path.join(PKG, "templates")
const BASE = path.join(process.env.TMPDIR ?? "/private/tmp/claude-501", "row114", "tests")
mkdirSync(BASE, { recursive: true })
const WORK = realpathSync(mkdtempSync(path.join(BASE, "row114-")))
const STORE = path.join(WORK, "datum-studio")
const HOME = path.join(WORK, "home")
const RES = path.join(WORK, "Swarm.app", "Contents", "Resources")
const PROJECT = path.join(HOME, "project-114")
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

const TOKEN = "a".repeat(16) + "0123456789abcdef".repeat(3)
const FACTS = { home: HOME, resourcesPath: RES, execPath: path.join(WORK, "Swarm.app", "Contents", "MacOS", "Swarm") }
const M = "2026-11-17_m114-figures"
const realFetch = globalThis.fetch
globalThis.fetch = (async () => {
  throw new Error("row114 test: globalThis.fetch must not be called by the host")
}) as unknown as typeof fetch

type Mod = typeof import("../../src/mcp-host/index.ts")
type S = Record<string, any>
let mod: Mod
let store: Awaited<ReturnType<Mod["openHostStore"]>>
let host: Awaited<ReturnType<Mod["startStudioHostServer"]>>
let c: Client
const log = (level: "info" | "warn" | "error", source: string, message: string, context?: Record<string, unknown>) => {
  if (level === "error") console.log(`[row114] host error ${source}: ${message} ${JSON.stringify(context ?? {}).slice(0, 400)}`)
}
const quote = (label: string, v: unknown) => console.log(`[row114] ${label}: ${JSON.stringify(v)}`)

// Render bridge stub (row 68's): measure one sheet per page section, PDF page count, clean overlap, small page PNGs.
const GOOD_INFO = { electron: "42.3.3", chrome: "142.0.0.0", partition: "datum-render", sandbox: true, contextIsolation: true, nodeIntegration: false, javascriptContent: false, network: "blocked", fonts: 16, scripts: ["studio.measure", OVERLAP_SCRIPT_NAME] }
const sheetsOf = (html: string) => Math.max(1, (html.match(/<section\b[^>]*class="[^"]*\bpage\b/g) ?? []).length)
function installBridge() {
  runtime.setRenderBridgeTransport(async (req) => {
    if (req.op === "hello") return { ok: true, ...GOOD_INFO }
    if (req.op === "pdf") {
      const src = String(req.src ?? "")
      const html = typeof req.html === "string" ? req.html : existsSync(src) ? readFileSync(src, "utf8") : ""
      writeFileSync(String(req.dst), Buffer.from(`%PDF-1.4\n1 0 obj<</Type /Pages /Count ${sheetsOf(html)}>>endobj\n%%EOF\n`, "latin1"))
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
      if (req.script === OVERLAP_SCRIPT) return { ok: true, script: OVERLAP_SCRIPT_NAME, result: { paged: true, pageCount: n, truncated: false, marginsUnreadable: false, contentHeightMm: null, boxes: 40, findingsTotal: 0, findings: [] } }
      return { ok: false, code: "SCRIPT_NOT_ALLOWED", message: "stub" }
    }
    // figure raster (runtime.ts `op: "png"`): a blank PNG of the asked size at dst
    if (req.op === "png") {
      writeFileSync(String(req.dst), blankPng(Number(req.width), Number(req.height)))
      return { ok: true, dst: req.dst }
    }
    if (req.op === "pagePng") {
      const pages = (Array.isArray(req.pages) ? (req.pages as number[]) : [1]).map((p) => {
        const dst = path.join(String(req.dstDir), `p${String(p).padStart(3, "0")}.png`)
        const bytes = Buffer.from(`png-${p}`)
        writeFileSync(dst, bytes)
        return { n: p, dst, width: 1239, height: 1753, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }
      })
      return { ok: true, layout: "paged", media: "print", pageCount: Math.max(...pages.map((p) => p.n)), pageSizeMm: { wMm: 210, hMm: 297 }, pageSizeSource: "css", dpi: 150, pages }
    }
    return { ok: false, code: "BAD_REQUEST", message: "stub" }
  })
}
function blankPng(w: number, h: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const td = Buffer.concat([Buffer.from(type, "latin1"), data])
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(Bun.hash.crc32(td) >>> 0)
    return Buffer.concat([len, td, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr.set([8, 0, 0, 0, 0], 8) // 8-bit greyscale
  const raw = Buffer.alloc((w + 1) * h, 0xff)
  for (let y = 0; y < h; y++) raw[y * (w + 1)] = 0
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))])
}
function resetBridge() {
  runtime.setRenderBridgeTransport(null)
  installBridge()
}

async function call(name: string, args: Record<string, unknown>): Promise<S> {
  const r = await c.callTool({ name, arguments: args })
  return { ...((r.structuredContent ?? {}) as S), _isError: r.isError === true, _text: ((r.content ?? []) as S[]).map((x) => x.text).join("\n"), _bytes: Buffer.byteLength(JSON.stringify(r)) }
}
const row = (id: string) => ({ id, phase: "implementation", kind: "implementation", title: `Row ${id}`, agent: "coder-execution", model: { tier: "thinker" }, deps: [], size: "S", status: "pending", output: `implementation/${id}.md`, verification: "tests pass", review: "gate" })
const diagram = (n: number): S => {
  const b = clone(FIXTURE.writeBlock)
  b.diagram.spec.nodes[0].label = `Mulai ${n}`
  return b
}
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex")
const latest = async (documentId: string) => (await store.revisionVerification(documentId, "latest")).revisionNo

let doc = ""
let blockIds: string[] = []

beforeAll(async () => {
  process.env.STUDIO_WORKSPACE_ROOT = STORE
  process.env.STUDIO_ASSETS_ROOT = path.join(VENDOR, "src", "lib", "studio", "assets")
  process.env.STUDIO_VENDOR_ROOT = VENDOR
  delete process.env.STUDIO_MCP_FILE_ROOTS
  delete process.env.INTERNAL_API_SECRET
  delete process.env.STUDIO_VERIFY_BUDGET_MS
  mod = (await import("../../src/mcp-host/index.ts")) as Mod
  resetBridge()
  await resetEnvCache()
  store = await mod.openHostStore(STORE, { release: "1.2.1", logFile: path.join(WORK, "logs", "store.jsonl"), missionGuard: true })
  mod.configureTemplateSource({ templatesDir: TEMPLATES, assetRepoRoot: VENDOR, release: "1.2.1" })
  host = await mod.startStudioHostServer({ store, token: TOKEN, missionControlKey: PERSON_KEY, hostname: "127.0.0.1", port: 0, log, facts: FACTS, extensions: mod.missionHostExtension(store, { log, exporter: null }) })
  c = new Client({ name: "row114-test", version: "0" })
  await c.connect(
    new StreamableHTTPClientTransport(new URL(host.url), {
      fetch: realFetch as never,
      requestInit: { headers: { authorization: `Bearer ${TOKEN}`, "x-studio-agent": "swarm", "x-studio-caller-cwd": encodeURIComponent(PROJECT) } },
    }),
  )
  const cr = await personCaller({ url: host.url, token: TOKEN, cwd: PROJECT, fetchImpl: realFetch })("studio_mission_create", {
    mission: { id: M, title: "Row 114 mission", type: "feature-release", owner: "master-controller", project: { dir: PROJECT }, rows: ["1"].map(row), decisions: [{ id: "U1", by: "user", date: "2026-11-17", text: "go" }] },
  })
  expect(cr.ok).toBe(true)
  expect((await call("studio_mission_approve", { mission: M, decision: "U1" })).ok).toBe(true)
  expect((await call("studio_mission_set_status", { mission: M, to: "running" })).ok).toBe(true)
  const w = await call("studio_write", {
    mission: M,
    docKey: "row-1-gambar",
    template: "datum-nota",
    meta: META,
    sections: [
      { heading: "Pendahuluan", blocks: ["Paragraf pembuka sintetis alfa bravo charlie.", diagram(1)] },
      { heading: "Proses", blocks: ["Paragraf kedua sintetis delta echo foxtrot.", diagram(2)] },
      { heading: "Penutup", blocks: ["Paragraf ketiga sintetis golf hotel india.", diagram(3)] },
    ],
  })
  expect(w.ok, w._text).not.toBe(false)
  doc = String(w.documentId)
  const g = await call("studio_document_get", { documentId: doc, view: "content" })
  blockIds = diagramsOf(g.content as S).map((d) => String(d.id))
  expect(blockIds).toHaveLength(3)
}, 120_000)

afterEach(() => resetBridge())

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
})

describe("row 114: studio_render figures returns the path of each figure file", () => {
  test('figures: ["svg"] on a document with three figures: three items, each path an existing file with the stated sha256', async () => {
    const r = await call("studio_render", { documentId: doc, revisionNo: await latest(doc), formats: ["html"], figures: ["svg"] })
    quote("figures", r.figures)
    quote("render errors", r.errors)
    quote("reply bytes", r._bytes)
    expect(r.ok === true ? true : r._text).toBe(true)
    const figs = r.figures as S[]
    expect(figs).toHaveLength(3)
    const svgOutputs = (r.outputs as S[]).filter((o) => o.role === "FIGURE" && o.format === "SVG")
    expect(figs.map((f) => f.outputId)).toEqual(svgOutputs.map((o) => o.id))
    for (const f of figs) {
      expect(f.format).toBe("SVG")
      expect(path.isAbsolute(f.path)).toBe(true)
      expect(f.path.startsWith(realpathSync(STORE) + path.sep) || f.path.startsWith(STORE + path.sep)).toBe(true)
      expect(lstatSync(f.path).isFile()).toBe(true)
      expect(sha(readFileSync(f.path))).toBe(f.sha256)
      expect(readFileSync(f.path, "utf8")).toContain("<svg")
      expect(typeof f.label).toBe("string")
    }
    // one item per figure block, in document order, each naming its block
    expect(figs.map((f) => f.blockId)).toEqual(blockIds)
    expect(new Set(figs.map((f) => f.label)).size).toBe(3)
    expect(r.untrustedFields).toContain("figures[].label")
    expect(r._text).toContain("figures: 3 files")
    for (const f of figs) expect(r._text).toContain(`${f.path} sha256=${f.sha256}`)
    // the reply stays far below the host's 8 MiB message cap (no other size pin applies to tool results)
    expect(r._bytes).toBeLessThan(256 * 1024)
  })

  test("png requested: svg is added by the wrapper; one item per file, both formats, all paths exist", async () => {
    const r = await call("studio_render", { documentId: doc, revisionNo: await latest(doc), formats: ["html"], figures: ["png"] })
    const figs = r.figures as S[]
    quote("png figures", figs.map((f) => ({ format: f.format, label: f.label, exists: f.path ? existsSync(f.path) : null })))
    const files = (r.outputs as S[]).filter((o) => o.role === "FIGURE")
    expect(figs).toHaveLength(files.length)
    expect(figs.filter((f) => f.format === "SVG")).toHaveLength(3)
    for (const f of figs) {
      expect(lstatSync(f.path).isFile()).toBe(true)
      expect(sha(readFileSync(f.path))).toBe(f.sha256)
    }
  })

  test("without the figures option the reply carries no figures field and no figures line", async () => {
    const r = await call("studio_render", { documentId: doc, revisionNo: await latest(doc), formats: ["html"] })
    expect(r.ok === true ? true : r._text).toBe(true)
    expect("figures" in r).toBe(false)
    expect("figuresTruncated" in r).toBe(false)
    expect(r._text).not.toContain("figures:")
    expect(r.untrustedFields).not.toContain("figures[].label")
    expect(r.projectCopy).toBeDefined()
  })

  test("figure files are not copied into the project folder", async () => {
    const dest = path.join(PROJECT, "deliverables")
    const walk = (d: string): string[] => (existsSync(d) ? readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [e.name])) : [])
    expect(walk(dest).filter((n) => n.endsWith(".svg") || n.endsWith(".png"))).toEqual([])
    expect(existsSync(path.join(dest, M, "figur"))).toBe(false)
  })
})
