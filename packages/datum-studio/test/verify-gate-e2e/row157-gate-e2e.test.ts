// Row 157 (decision U24 A; C130, C142, C147, C148, C149, C156): the output verification gate END TO END through the
// REAL Studio host (startStudioHostServer, streamable HTTP on 127.0.0.1, MCP SDK client; store opened with
// missionGuard: true as desktop does) and the REAL render bridge: the repo's Electron 42 binary running
// startRenderBridge with the app's own allow-list (packages/desktop/test/datum-render-electron/row157-harness-main.ts).
// No bridge stub anywhere: every PDF print, `studio.measure` / `swarm.verify.overlap` checkPage and `pagePng` page
// image of this file runs in real Electron (fixture HOME, --use-mock-keychain, dead proxy).
// Spec masterplan/01_specs_output_verification.md §9 B1-B14. Cases that the engine cannot produce from real input use
// the spec's test-only fault seam (`renderVerifyWrapper(store, { seam })` in a test-only host list; it changes the bytes
// the checks read, never the stored file); each case says which way it was made.
// Known-good fixture (C142): a NOTA-tier document (template datum-nota) imported from Markdown, the content row 154
// used; it truly passes LINT at its tier. The row 55c TERBIT outputs are NOT used (they correctly fail LINT).
// Mutations (spec §9 M1-M3) run this same file in a child process with ROW157_MUTATION set: the mutation is applied in
// memory by a Bun plugin (no product file is edited) and the child must FAIL.
// Needs the command sandbox off (ephemeral port, Unix socket, Electron). globalThis.fetch is a trap.
// OPT-IN: runs only with ROW157_E2E=1 (runner: see implementation/111_row157_verification_tests.md). A whole-package
// `bun test src test` skips it, as the desktop real-Electron tests are only run on purpose: it launches Electron.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { inflateSync } from "node:zlib"
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate"
import { realBridgeRunnable, startRealBridge, type RealBridge } from "./real-bridge"

const E2E = process.env.ROW157_E2E === "1"
const e2e = E2E ? describe : describe.skip
const MUTATION = process.env.ROW157_MUTATION ?? ""
const PKG = path.resolve(import.meta.dir, "..", "..")
const VENDOR = path.join(PKG, "vendor")
const TEMPLATES = path.join(PKG, "templates")
const ROOT = process.env.ROW157_ROOT ?? "/private/tmp/claude-501/row157"
const RUN = MUTATION ? `mut-${MUTATION}-${Date.now()}` : `run-${Date.now()}`
const WORK = path.join(ROOT, "w", RUN)
if (E2E) mkdirSync(WORK, { recursive: true })
const W = E2E ? realpathSync(WORK) : WORK
const STORE = path.join(W, "datum-studio")
const LOG = path.join(W, "logs", "store.jsonl")
const FIXTURE_HOME = process.env.HOME?.startsWith("/private/tmp/claude-501/") ? process.env.HOME : path.join(ROOT, "h")
const HOME = path.join(W, "home")
const RES = path.join(W, "Swarm.app", "Contents", "Resources")
const PROJECT = path.join(HOME, "project-157")
if (E2E) for (const d of [HOME, RES, PROJECT]) mkdirSync(d, { recursive: true })

// ── Mutations (in memory only; spec §9 M1-M3) ───────────────────────────────────────────────────────────────────
const MUTATIONS: Record<string, { file: RegExp; from: string; to: string }> = {
  // M1: the row gate returns early.
  M1: { file: /store\/mission\/mission-store\.ts$/, from: 'if (to === "done" && this.host.outputGate?.() === true) {', to: 'if (false && to === "done" && this.host.outputGate?.() === true) {' },
  // M2: UNKNOWN is counted as PASS in the state function.
  M2: { file: /mcp-host\/verify\/verify-outputs\.ts$/, from: 'c.status === "PASS" || c.status === "NOT_APPLICABLE"', to: 'c.status === "PASS" || c.status === "NOT_APPLICABLE" || c.status === "UNKNOWN"' },
  // M3: the wrapper skips the store write.
  M3: { file: /mcp-host\/verify\/render-wrapper\.ts$/, from: "        pageImages = res.pageImages\n        await writeRecords(store, report, verifiedBy)", to: "        pageImages = res.pageImages\n        void writeRecords" },
}
let mutationApplied = false
if (E2E && MUTATION) {
  const m = MUTATIONS[MUTATION]
  if (!m) throw new Error(`unknown ROW157_MUTATION ${MUTATION}`)
  Bun.plugin({
    name: `row157-mutation-${MUTATION}`,
    setup(build) {
      build.onLoad({ filter: m.file }, async (args) => {
        const src = await Bun.file(args.path).text()
        if (!src.includes(m.from)) throw new Error(`row157 mutation ${MUTATION}: site not found in ${args.path}`)
        mutationApplied = true
        console.log(`[row157] MUTATION_APPLIED ${MUTATION} ${path.basename(args.path)}`)
        return { contents: src.replace(m.from, m.to), loader: "ts" }
      })
    },
  })
}

const ENV_KEYS = ["STUDIO_WORKSPACE_ROOT", "STUDIO_ASSETS_ROOT", "STUDIO_VENDOR_ROOT", "STUDIO_MCP_FILE_ROOTS", "INTERNAL_API_SECRET", "DATUM_RENDER_SOCKET", "DATUM_RENDER_TOKEN", "STUDIO_VERIFY_BUDGET_MS"] as const
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
const TOKEN = "e".repeat(16) + "0123456789abcdef".repeat(3)
const FACTS = { home: HOME, resourcesPath: RES, execPath: path.join(W, "Swarm.app", "Contents", "MacOS", "Swarm") }
const M = "2026-11-08_m157-gate"

const realFetch = globalThis.fetch
if (E2E)
  globalThis.fetch = (async () => {
    throw new Error("row157 test: globalThis.fetch must not be called by the host")
  }) as unknown as typeof fetch

type S = Record<string, any>
type Mod = typeof import("../../src/mcp-host/index.ts")
let mod: Mod
let runtime: typeof import("../../vendor/src/lib/studio/engine/browser/runtime")
let wrapperMod: typeof import("../../src/mcp-host/verify/render-wrapper")
let pdfMod: typeof import("../../vendor/src/lib/studio/services/render/pdf")
let store: Awaited<ReturnType<Mod["openHostStore"]>>
let host: Awaited<ReturnType<Mod["startStudioHostServer"]>>
let c: import("@modelcontextprotocol/sdk/client/index.js").Client
let bridge: RealBridge | undefined
const hostLog: Array<{ level: string; source: string; message: string; context?: Record<string, unknown> }> = []
const log = (level: "info" | "warn" | "error", source: string, message: string, context?: Record<string, unknown>) => {
  hostLog.push({ level, source, message, context })
  if (level === "error") console.log(`[row157] host error ${source}: ${message} ${JSON.stringify(context ?? {}).slice(0, 300)}`)
}
const quote = (label: string, v: unknown) => console.log(`[row157] ${label}: ${JSON.stringify(v)}`)
const timings: Array<{ label: string; wallMs: number; verifyMs: number; bridgeJobs: number; pages: number; layout: string }> = []

async function resetCaches() {
  const { resetStudioEnvCache } = await import("../../vendor/src/lib/studio/contract/env")
  const { resetRenderRateLimiter } = await import("../../vendor/src/lib/studio/http/render-guard")
  resetStudioEnvCache()
  resetRenderRateLimiter()
}

type Seam = { fault?: (format: string, bytes: Uint8Array) => Uint8Array; addFormats?: false }
async function start(seam?: Seam) {
  await resetCaches()
  store = await mod.openHostStore(STORE, { release: "1.2.1", logFile: LOG, missionGuard: true })
  mod.configureTemplateSource({ templatesDir: TEMPLATES, assetRepoRoot: VENDOR, release: "1.2.1" })
  const prod = mod.missionHostExtension(store, { log, exporter: null })
  // Test-only host list: the production list with its studio_render wrapper replaced by one carrying the §9 seam.
  const ext = seam
    ? prod.map((e) => (e.name === "studio_render" && e.wraps ? wrapperMod.renderVerifyWrapper(store as never, { log, seam: seam as never }) : e))
    : prod
  host = await mod.startStudioHostServer({ store, token: TOKEN, hostname: "127.0.0.1", port: 0, log, facts: FACTS, extensions: ext })
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js")
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js")
  c = new Client({ name: "row157-test", version: "0" })
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
async function withSeam<T>(seam: Seam, fn: () => Promise<T>): Promise<T> {
  await stop()
  await start(seam)
  try {
    return await fn()
  } finally {
    await stop()
    await start()
  }
}
function bridgeUp(up: boolean) {
  if (up && bridge) {
    process.env.DATUM_RENDER_SOCKET = bridge.info.DATUM_RENDER_SOCKET
    process.env.DATUM_RENDER_TOKEN = bridge.info.DATUM_RENDER_TOKEN
  } else {
    delete process.env.DATUM_RENDER_SOCKET
    delete process.env.DATUM_RENDER_TOKEN
  }
  runtime.setRenderBridgeTransport(null) // the real socket transport; drops the cached handshake
}

async function call(name: string, args: Record<string, unknown>): Promise<S> {
  const r = await c.callTool({ name, arguments: args })
  return { ...((r.structuredContent ?? {}) as S), _isError: r.isError === true, _text: ((r.content ?? []) as S[]).map((x) => x.text).join("\n") }
}
const code = (r: S) => (r.ok === false ? r.code ?? r.error?.code : "OK")
const setRow = (id: string, status: string, extra: Record<string, unknown> = {}) => call("studio_mission_update_row", { mission: M, rows: [{ id, status, ...extra }] })
const ROW_IDS = Array.from({ length: 14 }, (_, i) => String(i + 1))
function row(id: string) {
  return { id, phase: "implementation", kind: "implementation", title: `Row ${id}`, agent: "coder-execution", model: { tier: "opus" }, deps: [], size: "S", status: "pending", output: `implementation/${id}.md`, verification: "tests pass", review: "gate" }
}
async function toReview(id: string) {
  expect(code(await setRow(id, "running"))).toBe("OK")
  expect(code(await setRow(id, "needs-review"))).toBe("OK")
}
async function refusedDone(id: string, label: string): Promise<S> {
  const r = await setRow(id, "done")
  const err = r.error ?? r
  quote(`${label} row ${id} done`, { code: code(r), details: err.details })
  expect(code(r)).toBe("OUTPUT_UNVERIFIED")
  const st = await call("studio_mission_get", { mission: M })
  const rr = ((st.mission?.rows ?? st.rows ?? []) as S[]).find((x) => x.id === id)
  if (rr) expect(rr.status).toBe("needs-review")
  return err.details as S
}
const reasonsOf = (details: S) => (details.deliverables as S[]).flatMap((d) => (d.outputs as S[]).map((o) => o.reason))

// Known-good NOTA content (C142: passes LINT at its tier). B4/B5/B6 faults target its marked paragraph / cells.
const GOOD_MD = [
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
  "| C | 3.750 |",
  "",
].join("\n")
const words = (n: number) => Array.from({ length: n }, (_, i) => `kata${i % 97}`).join(" ")
// B2 real input (spec): a table row with one ~3 000-character cell, made longer (12 000) so the row is taller than a page.
const B2_MD = ["# Tabel panjang", "", "Tabel berikut memuat satu sel yang sangat panjang.", "", "| No | Uraian |", "| --- | --- |", `| 1 | ${words(1700)} |`, "| 2 | pendek |", ""].join("\n")
// B3 real input (spec): a 300-character unbreakable token in a table cell.
const B3_MD = ["# Token panjang", "", "Tabel berikut memuat satu token tanpa spasi.", "", "| No | Kode |", "| --- | --- |", `| 1 | ${"X".repeat(300)} |`, "| 2 | AB |", ""].join("\n")

async function deliverable(docKey: string, title: string, md = GOOD_MD): Promise<string> {
  const d = await call("studio_document_create", { template: "datum-nota", mission: M, docKey, title })
  expect(d.ok).toBe(true)
  const id = String(d.documentId)
  if (md) {
    const imp = await call("studio_chapter_import_markdown", { documentId: id, chapterKey: "1", markdown: md, submit: true, baseRevisionNo: 1 })
    expect(imp.ok).toBe(true)
  }
  return id
}
async function render(label: string, documentId: string, formats: string[] | null, extra: Record<string, unknown> = {}): Promise<S> {
  await resetCaches()
  const rev = (await store.revisionVerification(documentId, "latest")).revisionNo
  const t0 = performance.now()
  const r = await call("studio_render", { documentId, ...(extra.scope ? {} : { revisionNo: rev }), ...(formats ? { formats } : {}), ...extra })
  const wallMs = Math.round(performance.now() - t0)
  const v = r.verification as S | undefined
  quote(`${label} render`, {
    ok: r.ok,
    code: r.code,
    isError: r._isError,
    outputs: (r.outputs ?? []).map((o: S) => o.format),
    overall: v?.overall,
    layout: v?.layout,
    formatsAdded: v?.formatsAdded,
    states: (v?.outputs ?? []).map((o: S) => ({ format: o.format, state: o.state, checks: (o.checks as S[]).map((k) => `${k.id}:${k.status}${k.reason ? `/${k.reason}` : ""}`) })),
  })
  if (v) timings.push({ label, wallMs, verifyMs: v.ms, bridgeJobs: v.bridgeJobs, pages: Math.max(0, ...(v.outputs as S[]).map((o) => o.pages.length)), layout: v.layout })
  return r
}
const outOf = (v: S, format: string) => (v.outputs as S[]).find((o) => o.format === format)!
const checkOf = (v: S, format: string, id: string) => (outOf(v, format).checks as S[]).find((k) => k.id === id)!
const allChecks = (o: S) => Object.fromEntries((o.checks as S[]).map((k) => [k.id, k.status]))
const docs: Record<string, string> = {}
const stateLog: string[] = []

beforeAll(async () => {
  if (!E2E) return
  if (!realBridgeRunnable) throw new Error("row157 needs the repo Electron binary on darwin (packages/desktop/node_modules/electron)")
  process.env.STUDIO_WORKSPACE_ROOT = STORE
  process.env.STUDIO_ASSETS_ROOT = path.join(VENDOR, "src", "lib", "studio", "assets")
  process.env.STUDIO_VENDOR_ROOT = VENDOR
  delete process.env.STUDIO_MCP_FILE_ROOTS
  delete process.env.INTERNAL_API_SECRET
  delete process.env.STUDIO_VERIFY_BUDGET_MS
  bridge = await startRealBridge(path.join(ROOT, "w", `bridge-${RUN}`), FIXTURE_HOME)
  quote("bridge", { scripts: bridge.info.scripts, electronPid: bridge.info.pid, owned: bridge.owned })
  mod = (await import("../../src/mcp-host/index.ts")) as Mod
  runtime = await import("../../vendor/src/lib/studio/engine/browser/runtime")
  wrapperMod = await import("../../src/mcp-host/verify/render-wrapper")
  pdfMod = await import("../../vendor/src/lib/studio/services/render/pdf")
  bridgeUp(true)
  await start()
  const cr = await call("studio_mission_create", {
    mission: { id: M, title: "Row 157 gate e2e", type: "feature-release", owner: "master-controller", project: { dir: PROJECT }, rows: ROW_IDS.map(row), decisions: [{ id: "U1", by: "user", date: "2026-11-08", text: "go" }] },
  })
  expect(cr.ok).toBe(true)
  expect((await call("studio_mission_approve", { mission: M, decision: "U1" })).ok).toBe(true)
  expect((await call("studio_mission_set_status", { mission: M, to: "running" })).ok).toBe(true)
}, 180_000)

afterAll(async () => {
  if (!E2E) return
  await stop().catch(() => undefined)
  runtime?.setRenderBridgeTransport(null)
  globalThis.fetch = realFetch
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  quote("timings", timings)
  if (MUTATION) quote("mutation", { MUTATION, applied: mutationApplied })
  // The mutation children leave the parent's bridge running; only the run that owns Electron stops it.
  if (bridge?.owned && !process.env.ROW157_KEEP_BRIDGE) {
    const { result } = await bridge.stop()
    quote("electron result", { electron: result?.electron, windowsAfter: result?.windowsAfter, error: result?.error ?? null, userData: result?.userData })
  }
}, 120_000)

e2e("row 157: production wiring", () => {
  test("GOOD: the host's studio_render has exactly one wrapper and no fault seam; the real bridge serves the app allow-list", async () => {
    if (MUTATION) expect(mutationApplied || MUTATION === "M3").toBe(true)
    const tools = (await c.listTools()).tools
    expect(tools.filter((t) => t.name === "studio_render")).toHaveLength(1)
    const w = mod.missionHostExtension(store, { log, exporter: null }).filter((e) => e.name === "studio_render")
    expect(w).toHaveLength(1)
    expect(w[0]!.wraps).toBe(true)
    expect((w[0] as unknown as { faultSeam: boolean }).faultSeam).toBe(false)
    expect(bridge!.info.scripts).toEqual(expect.arrayContaining(["studio.measure", "swarm.verify.overlap"]))
  })
})

e2e("row 157: good render on the real bridge", () => {
  test("GOOD: pdf -> html added; all six checks PASS on HTML and PDF; verified; page PNGs exist with the right count; row done", async () => {
    docs.good = await deliverable("row-1-kajian", "Kajian baik row 157")
    const r = await render("GOOD", docs.good, ["pdf"])
    expect(r._isError).toBe(false)
    expect(r.ok).toBe(true)
    const v = r.verification as S
    expect(v.$schema).toBe("studio.output-verification/v1")
    expect(v.formatsAdded).toEqual(["html"])
    expect(v.bridgeJobs).toBeGreaterThanOrEqual(2)
    for (const f of ["HTML", "PDF"]) {
      const o = outOf(v, f)
      expect((o.checks as S[]).map((k) => k.id)).toEqual(["LINT", "OVERLAP_CLIP", "FIDELITY", "PAGE_COUNT", "FIGURE_FIT", "EMPTY_SLOTS"])
      expect(allChecks(o)).toEqual({ LINT: "PASS", OVERLAP_CLIP: "PASS", FIDELITY: "PASS", PAGE_COUNT: "PASS", FIGURE_FIT: "PASS", EMPTY_SLOTS: "PASS" })
      expect(o.state).toBe("verified")
    }
    expect(v.overall).toBe("verified")
    expect(v.layoutWitness).toBe(true)
    expect(r._text).toContain("verification: VERIFIED (2/2 outputs verified)")

    // Page images: real PNGs made by real Electron (pagePng), one per printed page (<= 12), same files for HTML and PDF.
    const html = outOf(v, "HTML")
    const pdf = outOf(v, "PDF")
    const pdfBytes = await store.readOutputVerified(pdf.outputId)
    const pdfPages = pdfMod.countPdfPages(pdfBytes)
    const imaged = (html.pages as S[]).filter((p) => p.png)
    quote("GOOD pages", { pdfPages, listed: html.pages.length, imaged: imaged.map((p) => p.png) })
    expect(pdfPages).toBeGreaterThanOrEqual(1)
    expect(html.pages.length).toBe(pdfPages)
    expect(imaged.length).toBe(Math.min(12, pdfPages))
    expect(pdf.pages.map((p: S) => p.png)).toEqual(html.pages.map((p: S) => p.png))
    for (const p of imaged) {
      expect(p.png).toBe(path.join(store.rootDir, "verify", html.outputId, `p${String(p.n).padStart(3, "0")}.png`))
      const b = readFileSync(p.png)
      expect(b.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a")
      const w = b.readUInt32BE(16)
      const h = b.readUInt32BE(20)
      quote(`GOOD p${p.n} png`, { bytes: b.length, w, h })
      expect(Math.abs(w / h - 210 / 297)).toBeLessThan(0.01) // A4 portrait
      expect(w).toBeGreaterThan(1000) // 150 dpi: 1239 px wide
    }
    for (const o of v.outputs as S[]) expect(await store.getOutputVerification(o.outputId)).toMatchObject({ state: "verified", fail_count: 0, unknown_count: 0, output_sha256: o.sha256 })
    expect((await store.revisionVerification(docs.good, "latest")).final).toBe(true)

    await toReview("1")
    const done = await setRow("1", "done")
    quote("GOOD row 1 done", { code: code(done) })
    expect(code(done)).toBe("OK")
  }, 180_000)
})

e2e("row 157: good multi-page render on the real bridge", () => {
  test("GOOD: a NOTA document of several pages -> verified; one real PNG per printed page, distinct, pages[] = 1..PDF page count; row done", async () => {
    const LONG_MD = ["# Kajian panjang", "", ...Array.from({ length: 36 }, (_, i) => `Paragraf ${i + 1} mencatat hasil pengukuran lapangan pada titik uji yang berbeda setiap bulan oleh tim. ${words(70)}\n`), "| Titik | Nilai |", "| --- | --- |", "| A | 1.250 |", "| B | 2.500 |", ""].join("\n")
    docs.long = await deliverable("row-14-panjang", "Kajian panjang row 157", LONG_MD)
    const v = (await render("GOOD long", docs.long, ["pdf"])).verification as S
    for (const o of v.outputs as S[]) expect(allChecks(o)).toEqual({ LINT: "PASS", OVERLAP_CLIP: "PASS", FIDELITY: "PASS", PAGE_COUNT: "PASS", FIGURE_FIT: "PASS", EMPTY_SLOTS: "PASS" })
    expect(v.overall).toBe("verified")
    const html = outOf(v, "HTML")
    const pdfPages = pdfMod.countPdfPages(await store.readOutputVerified(outOf(v, "PDF").outputId))
    const pngs = (html.pages as S[]).filter((p) => p.png).map((p) => readFileSync(p.png))
    const hashes = new Set(pngs.map((b) => new Bun.CryptoHasher("sha256").update(b).digest("hex")))
    quote("GOOD long pages", { pdfPages, listed: (html.pages as S[]).map((p) => p.n), imaged: pngs.length, distinct: hashes.size, sizes: pngs.map((b) => `${b.readUInt32BE(16)}x${b.readUInt32BE(20)}`) })
    expect(pdfPages).toBeGreaterThanOrEqual(2)
    expect((html.pages as S[]).map((p) => p.n)).toEqual(Array.from({ length: pdfPages }, (_, i) => i + 1))
    expect(pngs.length).toBeGreaterThanOrEqual(2)
    expect(hashes.size).toBe(pngs.length)
    for (const b of pngs) expect(b.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a")
    longPages = { pdfPages, pngs, layout: v.layout }
    await toReview("14")
    expect(code(await setRow("14", "done"))).toBe("OK")
  }, 180_000)

  // DEFECT-157-1 (found by this row; failing on purpose until fixed). Studio's NOTA HTML is FLOW layout on the real
  // bridge (report layout "flow"), but the pagePng flow cut ignores the @page margins and the @page background:
  // desktop/src/main/datum-render/page-images.ts:155 (H = full @page height), :188-189 (count = docH / H, rects at n*H);
  // verify-outputs.ts:289-291 then leaves the extra printed page's png null with reason null. Row 151b's limit
  // L-151b-2 assumed "Studio HTML is paged" (implementation/105b_row151b_page_png.md:53); for NOTA it is not.
  test("DEFECT-157-1: flow-layout page images match the printed PDF: one image per PDF page and the page's light background", () => {
    expect(longPages).not.toBeNull()
    const lp = longPages!
    const px = lp.pngs.map(firstPixel)
    quote("DEFECT-157-1", { layout: lp.layout, pdfPages: lp.pdfPages, images: lp.pngs.length, firstPixelRgb: px })
    expect({ images: lp.pngs.length, firstPixelLight: px.every((p) => Math.min(...p) >= 200) }).toEqual({ images: Math.min(12, lp.pdfPages), firstPixelLight: true })
  })
})

let longPages: { pdfPages: number; pngs: Buffer[]; layout: string } | null = null
/** RGB of pixel (0,0) of an 8-bit RGB/RGBA PNG: on row 0 every PNG filter leaves the first pixel's bytes raw. */
function firstPixel(b: Buffer): number[] {
  const chunks: Buffer[] = []
  for (let o = 8; o < b.length; o += 12 + b.readUInt32BE(o)) if (b.toString("latin1", o + 4, o + 8) === "IDAT") chunks.push(b.subarray(o + 8, o + 8 + b.readUInt32BE(o)))
  const raw = inflateSync(Buffer.concat(chunks))
  return [raw[1]!, raw[2]!, raw[3]!]
}

e2e("row 157: deliberately broken renders (spec §9)", () => {
  test("B1: overlap (fault seam: a block pulled 30 mm up) -> OVERLAP_CLIP FAIL OVERLAP with both addresses; unverified; row done refused CHECK_FAILED", async () => {
    // Real input first (spec): Studio's NOTA has no figure in this content and its captions wrap, so no real overlap
    // can be made from Markdown; the spec's seam is used on the HTML the checks read.
    docs.b1 = await deliverable("row-2-laporan", "Laporan B1 row 157")
    const pullUp = (s: string) => {
      const m = /<p\b[^>]*\bdata-address="([^"]+)"[^>]*>[^<]*UJIHILANG/.exec(s)
      if (!m) throw new Error("B1 seam: marked paragraph not found")
      return s.replace("</head>", `<style>[data-address="${m[1]}"]{margin-top:-30mm !important}</style></head>`)
    }
    const fault = (format: string, bytes: Uint8Array) => (format === "HTML" ? strToU8(pullUp(strFromU8(bytes))) : bytes)
    const v = (await withSeam({ fault }, async () => (await render("B1", docs.b1, ["pdf"])).verification)) as S
    for (const f of ["HTML", "PDF"]) {
      const k = checkOf(v, f, "OVERLAP_CLIP")
      quote(`B1 ${f} OVERLAP_CLIP`, { status: k.status, findings: k.findings.slice(0, 3) })
      expect(k.status).toBe("FAIL")
      const o = (k.findings as S[]).find((x) => x.code === "OVERLAP")
      expect(o).toBeDefined()
      expect(o!.address).toBeTruthy()
      expect(o!.detail).toMatch(/\d/) // carries the second address and the area
      expect(outOf(v, f).state).toBe("unverified")
    }
    expect(v.overall).toBe("unverified")
    // The stored file was not changed by the seam.
    expect(strFromU8(await store.readOutputVerified(outOf(v, "HTML").outputId))).not.toContain("margin-top:-30mm")
    await toReview("2")
    expect(reasonsOf(await refusedDone("2", "B1"))).toContain("CHECK_FAILED")
  }, 240_000)

  test("B11: B1 fixed (render again without the fault) -> all verified, overall verified -> row done accepted", async () => {
    const r = await render("B11", docs.b1, ["pdf"])
    const v = r.verification as S
    for (const o of v.outputs as S[]) expect(o.state).toBe("verified")
    expect(v.overall).toBe("verified")
    const set = await store.revisionVerification(docs.b1, "latest")
    quote("B11 set", { final: set.final, outputs: set.outputs.map((o) => [o.format, o.state, (o as S).outputId]) })
    expect(set.final).toBe(true)
    const done = await setRow("2", "done")
    quote("B11 row 2 done", { code: code(done) })
    expect(code(done)).toBe("OK")
  }, 180_000)

  test("B2: clipped page, real input (table row with a 12 000-character cell) -> OVERLAP_CLIP FAIL (OVERFLOW_BOTTOM / UNBREAKABLE_TOO_TALL / BOX_CLIP) with address; row refused", async () => {
    docs.b2 = await deliverable("row-3-tabel", "Tabel panjang row 157", B2_MD)
    let v = (await render("B2 real", docs.b2, ["pdf"])).verification as S
    let how = "real input"
    if (checkOf(v, "HTML", "OVERLAP_CLIP").status !== "FAIL") {
      // The engine broke the row across pages: real input does not clip. Spec fallback: fault seam height:400mm.
      how = "fault seam height:400mm (real input did not clip)"
      const tall = (s: string) => {
        const m = /<p\b[^>]*\bdata-address="([^"]+)"/.exec(s)
        return s.replace("</head>", `<style>[data-address="${m![1]}"]{height:400mm !important;display:block}</style></head>`)
      }
      v = (await withSeam({ fault: (f, b) => (f === "HTML" ? strToU8(tall(strFromU8(b))) : b) }, async () => (await render("B2 seam", docs.b2, ["pdf"])).verification)) as S
    }
    const k = checkOf(v, "HTML", "OVERLAP_CLIP")
    quote("B2 HTML OVERLAP_CLIP", { how, layout: v.layout, status: k.status, findings: (k.findings as S[]).slice(0, 4) })
    expect(k.status).toBe("FAIL")
    const f = (k.findings as S[]).find((x) => ["OVERFLOW_BOTTOM", "UNBREAKABLE_TOO_TALL", "BOX_CLIP", "TABLE_OVERFLOW"].includes(x.code))
    expect(f).toBeDefined()
    expect(f!.address ?? f!.page).toBeTruthy()
    if (v.layout === "paged") expect(f!.page).toBeGreaterThanOrEqual(1)
    expect(typeof f!.amount === "number" || f!.code === "BOX_CLIP").toBe(true)
    expect(outOf(v, "PDF").state).toBe("unverified")
    await toReview("3")
    expect(reasonsOf(await refusedDone("3", "B2"))).toContain("CHECK_FAILED")
  }, 240_000)

  test("B3: clipped right, real input (300-character token in a table cell) -> OVERLAP_CLIP FAIL (OVERFLOW_RIGHT / BOX_CLIP / TABLE_OVERFLOW); row refused", async () => {
    docs.b3 = await deliverable("row-4-token", "Token panjang row 157", B3_MD)
    let v = (await render("B3 real", docs.b3, ["pdf"])).verification as S
    let how = "real input"
    if (checkOf(v, "HTML", "OVERLAP_CLIP").status !== "FAIL") {
      how = "fault seam white-space:nowrap;overflow:hidden on the cell (real input wrapped)"
      const nowrap = (s: string) => s.replace("</head>", "<style>td,th{white-space:nowrap !important;overflow:hidden !important;overflow-wrap:normal !important;word-break:normal !important;max-width:40mm}</style></head>")
      v = (await withSeam({ fault: (f, b) => (f === "HTML" ? strToU8(nowrap(strFromU8(b))) : b) }, async () => (await render("B3 seam", docs.b3, ["pdf"])).verification)) as S
    }
    const k = checkOf(v, "HTML", "OVERLAP_CLIP")
    quote("B3 HTML OVERLAP_CLIP", { how, layout: v.layout, status: k.status, findings: (k.findings as S[]).slice(0, 4) })
    expect(k.status).toBe("FAIL")
    expect((k.findings as S[]).some((x) => ["OVERFLOW_RIGHT", "BOX_CLIP", "TABLE_OVERFLOW"].includes(x.code))).toBe(true)
    await toReview("4")
    expect(reasonsOf(await refusedDone("4", "B3"))).toContain("CHECK_FAILED")
  }, 240_000)

  // DOCX fault helper: rewrite word/document.xml inside the zip the checks read.
  const docx = (bytes: Uint8Array, edit: (xml: string) => string) => {
    const z = unzipSync(bytes)
    z["word/document.xml"] = strToU8(edit(strFromU8(z["word/document.xml"]!)))
    return zipSync(z)
  }

  test("B4: dropped paragraph (fault seam: one data-block element / one w:p removed) -> FIDELITY FAIL BLOCK_MISSING with the address on HTML, PDF and DOCX; row refused", async () => {
    docs.b4 = await deliverable("row-5-hilang", "Paragraf hilang row 157")
    const html = (s: string) => s.replace(/<p\b[^>]*>[^<]*UJIHILANG[^<]*<\/p>/, "")
    const word = (x: string) => x.replace(/<w:p\b(?:(?!<w:p\b)[\s\S])*?UJIHILANG[\s\S]*?<\/w:p>/, "")
    const fault = (f: string, b: Uint8Array) => (f === "HTML" ? strToU8(html(strFromU8(b))) : f === "DOCX" ? docx(b, word) : b)
    const v = (await withSeam({ fault }, async () => (await render("B4", docs.b4, ["pdf", "docx"])).verification)) as S
    for (const f of ["HTML", "PDF", "DOCX"]) {
      const k = checkOf(v, f, "FIDELITY")
      quote(`B4 ${f} FIDELITY`, { status: k.status, findings: k.findings })
      expect(k.status).toBe("FAIL")
      expect((k.findings as S[]).find((x) => x.code === "BLOCK_MISSING")?.address).toBeTruthy()
      expect(outOf(v, f).state).toBe("unverified")
    }
    await toReview("5")
    expect(reasonsOf(await refusedDone("5", "B4"))).toContain("CHECK_FAILED")
  }, 240_000)

  test("B5: changed number 2.500 -> 2.050 in one table cell (fault seam) -> FIDELITY FAIL NUMBER_CHANGED / TABLE_CELL_CHANGED with row/column; row refused", async () => {
    docs.b5 = await deliverable("row-6-angka", "Angka berubah row 157")
    const swap = (s: string) => {
      const out = s.replace(/>2\.500</, ">2.050<")
      if (out === s) throw new Error("B5 seam: 2.500 not found")
      return out
    }
    const fault = (f: string, b: Uint8Array) => (f === "HTML" ? strToU8(swap(strFromU8(b))) : f === "DOCX" ? docx(b, swap) : b)
    const v = (await withSeam({ fault }, async () => (await render("B5", docs.b5, ["pdf", "docx"])).verification)) as S
    for (const f of ["HTML", "PDF", "DOCX"]) {
      const k = checkOf(v, f, "FIDELITY")
      quote(`B5 ${f} FIDELITY`, { status: k.status, findings: k.findings })
      expect(k.status).toBe("FAIL")
      const hit = (k.findings as S[]).find((x) => x.code === "NUMBER_CHANGED" || x.code === "TABLE_CELL_CHANGED")
      expect(hit).toBeDefined()
      expect(hit!.address).toBeTruthy()
      if (f !== "DOCX") expect(hit!.detail).toMatch(/row \d+, column \d+/)
    }
    await toReview("6")
    expect(reasonsOf(await refusedDone("6", "B5"))).toContain("CHECK_FAILED")
  }, 240_000)

  test("B6: missing table row (fault seam: one tr / w:tr removed) -> FIDELITY FAIL TABLE_SHAPE; row refused", async () => {
    docs.b6 = await deliverable("row-7-baris", "Baris hilang row 157")
    const html = (s: string) => {
      const out = s.replace(/<tr\b(?:(?!<tr\b)[\s\S])*?>3\.750<[\s\S]*?<\/tr>/, "")
      if (out === s) throw new Error("B6 seam: tr not found")
      return out
    }
    const word = (x: string) => {
      const out = x.replace(/<w:tr\b(?:(?!<w:tr\b)[\s\S])*?3\.750[\s\S]*?<\/w:tr>/, "")
      if (out === x) throw new Error("B6 seam: w:tr not found")
      return out
    }
    const fault = (f: string, b: Uint8Array) => (f === "HTML" ? strToU8(html(strFromU8(b))) : f === "DOCX" ? docx(b, word) : b)
    const v = (await withSeam({ fault }, async () => (await render("B6", docs.b6, ["pdf", "docx"])).verification)) as S
    for (const f of ["HTML", "PDF", "DOCX"]) {
      const k = checkOf(v, f, "FIDELITY")
      quote(`B6 ${f} FIDELITY`, { status: k.status, findings: k.findings })
      expect(k.status).toBe("FAIL")
      expect((k.findings as S[]).some((x) => x.code === "TABLE_SHAPE")).toBe(true)
    }
    await toReview("7")
    expect(reasonsOf(await refusedDone("7", "B6"))).toContain("CHECK_FAILED")
  }, 240_000)

  test("B7: PDF/HTML page mismatch (fault seam: the PDF read by the check claims one more page) -> PAGE_COUNT FAIL PAGE_COUNT_MISMATCH on the PDF; row refused", async () => {
    docs.b7 = await deliverable("row-8-halaman", "Halaman row 157")
    const morePages = (b: Uint8Array) => {
      const s = Buffer.from(b).toString("latin1")
      const n = pdfMod.countPdfPages(b)
      return new Uint8Array(Buffer.from(`${s}\n9999 0 obj<</Type /Pages /Count ${n + 1}>>endobj\n`, "latin1"))
    }
    const v = (await withSeam({ fault: (f, b) => (f === "PDF" ? morePages(b) : b) }, async () => (await render("B7", docs.b7, ["pdf"])).verification)) as S
    const k = checkOf(v, "PDF", "PAGE_COUNT")
    quote("B7 PDF PAGE_COUNT", { status: k.status, findings: k.findings })
    expect(k.status).toBe("FAIL")
    expect((k.findings as S[]).some((x) => x.code === "PAGE_COUNT_MISMATCH")).toBe(true)
    expect(checkOf(v, "HTML", "PAGE_COUNT").status).toBe("PASS")
    expect(outOf(v, "PDF").state).toBe("unverified")
    await toReview("8")
    expect(reasonsOf(await refusedDone("8", "B7"))).toContain("CHECK_FAILED")
  }, 240_000)

  test("B8: slot-scope draft render of the empty required slot 'content' -> EMPTY_SLOTS FAIL (PLACEHOLDER_IN_OUTPUT / SLOT_EMPTY); draft never makes Final; row refused", async () => {
    // A NOTA document with nothing submitted: its required slot `content` is EMPTY (templates/datum-nota.json skeleton).
    // A full render is refused (409 DOCUMENT_INCOMPLETE, tools.ts:826); the slot-scope draft renders the placeholder.
    docs.b8 = await deliverable("row-9-draf", "Draf kosong row 157", "")
    const r = await render("B8", docs.b8, ["html"], { scope: "slot", key: "content" })
    quote("B8 raw", { ok: r.ok, code: r.code, text: r._text.slice(0, 300) })
    expect(r.ok).toBe(true)
    const v = r.verification as S
    expect(v.draft).toBe(true)
    const k = checkOf(v, "HTML", "EMPTY_SLOTS")
    quote("B8 HTML EMPTY_SLOTS", { status: k.status, findings: k.findings })
    expect(k.status).toBe("FAIL")
    expect((k.findings as S[]).some((x) => x.code === "PLACEHOLDER_IN_OUTPUT" || x.code === "SLOT_EMPTY")).toBe(true)
    expect(outOf(v, "HTML").state).toBe("unverified")
    expect((await store.revisionVerification(docs.b8, "latest")).final).toBe(false)
    await toReview("9")
    expect(reasonsOf(await refusedDone("9", "B8"))).toContain("NOT_RENDERED")
  }, 240_000)

  test("B10: bridge down (no DATUM_RENDER_SOCKET) -> OVERLAP_CLIP UNKNOWN BRIDGE_UNAVAILABLE, unverified; row refused CHECK_UNKNOWN; store and SQL CHECK refuse a verified record with unknown_count 1", async () => {
    docs.b10 = await deliverable("row-10-tanpa", "Tanpa bridge row 157")
    bridgeUp(false)
    let r: S
    try {
      r = await render("B10", docs.b10, ["docx", "html"]) // pdf would itself need the bridge
    } finally {
      bridgeUp(true)
    }
    expect(r._isError).toBe(false)
    const v = r.verification as S
    for (const o of v.outputs as S[]) expect(o.state).toBe("unverified")
    expect(v.overall).toBe("unverified")
    expect(checkOf(v, "HTML", "OVERLAP_CLIP")).toMatchObject({ status: "UNKNOWN", reason: "BRIDGE_UNAVAILABLE" })
    expect((v.outputs as S[]).flatMap((o) => o.pages).every((p: S) => p.png === null)).toBe(true)
    await toReview("10")
    const reasons = reasonsOf(await refusedDone("10", "B10"))
    expect(reasons).toContain("CHECK_UNKNOWN")
    expect(reasons).not.toContain("CHECK_FAILED")

    // Store API refuses a verified record with an UNKNOWN; the SQL CHECK refuses the raw row too.
    const html = outOf(v, "HTML")
    const put = store
      .transaction(async (tx) =>
        store.putOutputVerification(tx, { outputFileId: html.outputId, outputSha256: html.sha256, renderJobId: v.renderJobId, state: "verified", checksVersion: 1, failCount: 0, unknownCount: 1, report: { x: 1 }, verifiedBy: "row157" }),
      )
      .then(
        () => "accepted",
        (e: S) => e.code ?? String(e.message),
      )
    const raw = store
      .transaction(async (tx) => tx.run("UPDATE output_verification SET state = 'verified' WHERE output_file_id = ?", [html.outputId]))
      .then(
        () => "accepted",
        (e: S) => `${e.code ?? ""} ${String(e.message)}`,
      )
    const got = { put: await put, raw: await raw }
    quote("B10 store refusals", got)
    expect(got.put).toBe("VERIFY_STATE_INVALID")
    expect(got.raw).not.toBe("accepted")
    expect((await store.getOutputVerification(html.outputId))!.state).toBe("unverified")
  }, 240_000)

  test("B12: deliverable created, never rendered -> row done refused NOT_RENDERED", async () => {
    docs.b12 = await deliverable("row-11-laporan", "Belum dirender row 157")
    await toReview("11")
    expect(reasonsOf(await refusedDone("11", "B12"))).toContain("NOT_RENDERED")
  }, 60_000)

  test("B13: DOCX only (fault seam suppresses the wrapper's html add-on) -> no layout witness -> row refused NO_LAYOUT_WITNESS", async () => {
    docs.b13 = await deliverable("row-12-docx", "DOCX saja row 157")
    const v = (await withSeam({ addFormats: false }, async () => (await render("B13", docs.b13, ["docx"])).verification)) as S
    expect(v.formatsAdded).toEqual([])
    expect((v.outputs as S[]).map((o) => o.format)).toEqual(["DOCX"])
    const d = outOf(v, "DOCX")
    quote("B13 DOCX", { state: d.state, checks: d.checks.map((k: S) => `${k.id}:${k.status}${k.reason ? `/${k.reason}` : ""}`) })
    expect(checkOf(v, "DOCX", "OVERLAP_CLIP").status).toBe("NOT_APPLICABLE")
    expect(checkOf(v, "DOCX", "PAGE_COUNT").status).toBe("NOT_APPLICABLE")
    expect(v.layoutWitness).toBe(false)
    expect(v.overall).toBe("unverified")
    await toReview("12")
    const reasons = reasonsOf(await refusedDone("12", "B13"))
    expect(reasons).toContain("NO_LAYOUT_WITNESS")
    stateLog.push(`B13 DOCX state ${d.state}; reasons ${JSON.stringify(reasons)}`)
  }, 240_000)

  test("B14: stale: verified, then a new revision -> not Final, row refused until re-rendered and verified, then done", async () => {
    docs.b14 = await deliverable("row-13-revisi", "Revisi row 157")
    const v1 = (await render("B14 first", docs.b14, ["pdf"])).verification as S
    expect(v1.overall).toBe("verified")
    expect((await store.revisionVerification(docs.b14, "latest")).final).toBe(true)
    const rev = (await store.revisionVerification(docs.b14, "latest")).revisionNo
    const imp = await call("studio_chapter_import_markdown", { documentId: docs.b14, chapterKey: "1", markdown: GOOD_MD.replace("tiap bulan", "tiap pekan"), submit: true, baseRevisionNo: rev })
    expect(imp.ok).toBe(true)
    const after = await store.revisionVerification(docs.b14, "latest")
    quote("B14 after new revision", { revisionNo: after.revisionNo, final: after.final, reasons: after.reasons, outputs: after.outputs.length })
    expect(after.revisionNo).toBeGreaterThan(rev)
    expect(after.final).toBe(false)
    await toReview("13")
    const reasons = reasonsOf(await refusedDone("13", "B14"))
    expect(reasons.some((x) => x === "NOT_RENDERED" || x === "NOT_CHECKED" || x === "STALE")).toBe(true)
    const v2 = (await render("B14 again", docs.b14, ["pdf"])).verification as S
    expect(v2.overall).toBe("verified")
    expect(v2.revisionNo).toBe(after.revisionNo)
    const done = await setRow("13", "done")
    quote("B14 row 13 done after re-verify", { code: code(done) })
    expect(code(done)).toBe("OK")
  }, 300_000)
})

e2e("row 157: the deliverables read equals the store", () => {
  test("GOOD: every deliverable's outputs[].verified and final from studio_mission_get equal the store records and revisionVerification", async () => {
    const g = await call("studio_mission_get", { mission: M, include: ["deliverables"] })
    const list = g.deliverables as S[]
    let compared = 0
    for (const [name, id] of Object.entries(docs)) {
      const d = list.find((x) => x.documentId === id)
      expect(d).toBeDefined()
      const set = await store.revisionVerification(id, "latest")
      const rows: S[] = []
      for (const o of d!.outputs as S[]) {
        const id = String(o.fileId)
        const rec = await store.getOutputVerification(id)
        const out = await store.getOutput(id)
        const storeVerified = rec?.state === "verified" && rec.output_sha256 === out!.sha256
        rows.push({ id, format: o.format, read: o.verified, store: storeVerified, rec: rec?.state ?? null, rev: out?.revision_id, draft: out?.draft, scope: out?.scope_kind })
        compared++
      }
      quote(`read=store ${name}`, { final: d!.final, storeFinal: set.final, setIds: set.outputs.map((o) => (o as S).outputId), outputs: rows })
      for (const x of rows) expect({ id: x.id, verified: x.read }).toEqual({ id: x.id, verified: x.store })
      expect(d!.final).toBe(set.final)
      // The read lists exactly the store's §7.1 set (newest per role/format/figure label of the current revision).
      expect(rows.map((x) => x.id).sort()).toEqual(set.outputs.map((o) => String((o as S).outputId)).sort())
    }
    expect(compared).toBeGreaterThanOrEqual(10)
  }, 60_000)
})

// ── Mutations: run this file again in a child with each mutation; the child must fail ────────────────────────────
;(E2E && !MUTATION ? describe : describe.skip)("row 157: mutations M1-M3 fail the suite", () => {
  const runChild = (mutation: string, pattern: string) => {
    const bj = path.join(bridge!.work, "bridge.json")
    const p = Bun.spawnSync([process.execPath, "test", import.meta.path, "-t", pattern, "--timeout", "300000"], {
      cwd: PKG,
      env: { ...process.env, ROW157_MUTATION: mutation, ROW157_BRIDGE_JSON: bj, ROW157_ROOT: ROOT },
      stdout: "pipe",
      stderr: "pipe",
    })
    const out = p.stdout.toString() + p.stderr.toString()
    writeFileSync(path.join(W, `mutation-${mutation}.log`), out)
    const fails = [...out.matchAll(/\(fail\) ([^\n]+)/g)].map((m) => m[1]!.replace(/ \[[\d.]+m?s\]$/, ""))
    const summary = /(\d+) pass\s+(?:\d+ skip\s+)?(\d+) fail/.exec(out)
    return { exit: p.exitCode, applied: out.includes(`MUTATION_APPLIED ${mutation}`), fails, summary: summary?.[0]?.replace(/\s+/g, " ") ?? null }
  }
  test("M1 (row gate returns early): B1 / B10 / B12 refusals no longer happen -> child fails", () => {
    const r = runChild("M1", "B1:|B10:|B12:")
    quote("M1 child", r)
    expect(r.applied).toBe(true)
    expect(r.exit).not.toBe(0)
    expect(r.fails.some((f) => f.includes("B1:"))).toBe(true)
    expect(r.fails.some((f) => f.includes("B10:"))).toBe(true)
    expect(r.fails.some((f) => f.includes("B12:"))).toBe(true)
  }, 900_000)
  test("M2 (UNKNOWN counted as PASS in the state function): B10 no longer behaves -> child fails", () => {
    const r = runChild("M2", "B10:")
    quote("M2 child", r)
    expect(r.applied).toBe(true)
    expect(r.exit).not.toBe(0)
    expect(r.fails.some((f) => f.includes("B10:"))).toBe(true)
  }, 900_000)
  test("M3 (wrapper skips the store write): Final is never reached -> child fails", () => {
    const r = runChild("M3", "GOOD:|B11:|B1:")
    quote("M3 child", r)
    expect(r.applied).toBe(true)
    expect(r.exit).not.toBe(0)
    expect(r.fails.some((f) => f.includes("GOOD:") || f.includes("B11:"))).toBe(true)
  }, 900_000)
})
