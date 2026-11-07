// Row 151 of docs/2026-11-06_swarm_1_2_0_datum_installer (decision C130 GAP-2): the render bridge's checkPage op, and
// the two page scripts OVERLAP_CLIP relies on (`studio.measure`, `swarm.verify.overlap`), in REAL Electron 42. Earlier
// rows drove checkPage only through fake page engines (C118: a fake engine once hid a PDF op real Electron lacks).
// The test bundles row151-harness-main.ts, runs it on the repo's own Electron binary (fixture HOME/userData, mock
// keychain, dead proxy, render session offline), and then calls the datum-studio host caller `runOverlapClip`
// (packages/datum-studio/src/mcp-host/verify/overlap-clip.ts) with its DEFAULT deps: vendored measureLayout and the
// direct checkPage call travel over the real Unix socket with the per-launch token to the real dispatcher and
// createElectronEngine().evaluate. Cases: a real Studio HTML (row 123's fixture through assembleHtml) and a clean
// paged page pass with 0 findings; spec §9 B1 (overlap), B2 (clipped bottom / unbreakable too tall) and B3 (clipped
// right / box clip) are found with page and element; unreadable @page margins are UNKNOWN, never PASS.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const here = import.meta.dir
const electron = join(here, "../../node_modules/electron/dist/Electron.app/Contents/MacOS/Electron")
const runnable = existsSync(electron) && !electron.startsWith("/Applications/") && process.platform === "darwin"
const studioPkg = resolve(here, "../../../datum-studio")
const fontsDir = resolve(here, "../../datum/datum-house-style/assets/fonts")
const ownWork = !process.env.ROW151_WORK
const work = process.env.ROW151_WORK ?? mkdtempSync(join(tmpdir(), "row151-"))

type Overlap = typeof import("../../../datum-studio/src/mcp-host/verify/overlap-clip")
let oc: Overlap
let bridgeInfo: { DATUM_RENDER_SOCKET: string; DATUM_RENDER_TOKEN: string; scripts: string[]; pid: number }
let run: ReturnType<typeof Bun.spawn> | undefined
let kill: (() => void) | undefined
let studioHtml = ""
const results: Record<string, Awaited<ReturnType<Overlap["runOverlapClip"]>>> = {}

const A4 = { pageWidthMm: 210, pageHeightMm: 297 }
const doc = (css: string, body: string) =>
  `<!doctype html><html lang="id"><head><meta charset="utf-8"><title>row151</title><style>${css}</style></head><body>${body}</body></html>`
const PAGED_CSS =
  "@page{size:A4;margin:0}html,body{margin:0;background:#fff}" +
  ".page{width:210mm;height:297mm;padding:20mm;box-sizing:border-box;overflow:visible;position:relative}" +
  "p{font:10pt/1.45 serif;margin:0 0 3mm}td{font:9pt/1.3 sans-serif;border:0.3mm solid #999;padding:1mm}"
const para = (addr: string, words = 40, style = "") =>
  `<p data-block="b-${addr}" data-address="${addr}"${style ? ` style="${style}"` : ""}>${Array.from({ length: words }, (_, i) => `kata${i}`).join(" ")}</p>`
const PAGED_CLEAN = doc(PAGED_CSS, `<div class="page">${para("1.1")}${para("1.2")}</div><div class="page">${para("2.1")}${para("2.2")}</div>`)
// B1 fault seam (spec §9): one block pulled up over the block before it.
const PAGED_OVERLAP = doc(PAGED_CSS, `<div class="page">${para("1.1")}${para("1.2")}</div><div class="page">${para("2.1")}${para("2.2", 40, "margin-top:-12mm")}</div>`)
// B2 fault seam: one block 400 mm tall on a 297 mm sheet.
const PAGED_BOTTOM = doc(PAGED_CSS, `<div class="page">${para("1.1")}<div data-block="b-1.3" data-address="1.3" style="height:400mm">tinggi</div></div><div class="page">${para("2.1")}</div>`)
// B3: a 300-character unbreakable token in a table cell clipped by its own box, and a block wider than the sheet.
const TOKEN = "X".repeat(300)
const PAGED_RIGHT = doc(
  PAGED_CSS,
  `<div class="page">${para("1.1")}<table data-block="b-1.2" data-address="1.2" style="table-layout:fixed;width:120mm"><tr><td>a</td>` +
    `<td style="white-space:nowrap;overflow:hidden">${TOKEN}</td></tr></table>` +
    `<div data-block="b-1.3" data-address="1.3" style="width:240mm;font:10pt serif">lebar</div></div>`,
)
// B2 in flow layout: a table row taller than the page content height (297 - 20 - 25 = 252 mm).
const FLOW_CSS = "@page{size:A4;margin:20mm 20mm 25mm 20mm}html,body{margin:0;background:#fff}p{font:10pt/1.45 serif}"
const FLOW_TALL_ROW = doc(FLOW_CSS, `${para("1.1")}<table data-block="b-1.2" data-address="1.2"><tr><td><div style="height:300mm">isi sel</div></td></tr></table>`)
const FLOW_CLEAN = doc(FLOW_CSS, `${para("1.1")}<table data-block="b-1.2" data-address="1.2"><tr><td>a</td><td>b</td></tr></table>${para("1.3")}`)
// No @page margin anywhere, and a table row to judge: the content height cannot be known.
const FLOW_NO_MARGINS = doc("html,body{margin:0}", `${para("1.1")}<table data-block="b-1.2" data-address="1.2"><tr><td>a</td></tr></table>`)

/** B1 on the real Studio HTML: the first figure pulled 30 mm up over the text before it (spec §9 fault seam). */
function studioWithOverlap(html: string): { html: string; address: string } {
  const m = /<figure\b[^>]*\bdata-address="([^"]+)"/.exec(html)
  if (!m) throw new Error("no figure in the Studio fixture")
  const rule = `<style>figure[data-address="${m[1]}"]{margin-top:-30mm !important}</style>`
  return { html: html.replace("</head>", `${rule}</head>`), address: m[1] }
}

beforeAll(async () => {
  if (!runnable) return
  const home = process.env.ROW151_HOME ?? join(work, "home")
  mkdirSync(home, { recursive: true })
  const env = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
    HTTP_PROXY: "http://127.0.0.1:9",
    HTTPS_PROXY: "http://127.0.0.1:9",
    ALL_PROXY: "http://127.0.0.1:9",
    NO_PROXY: "127.0.0.1,localhost",
  }
  // 1. The real Studio HTML, made by the datum-studio engine in its own package (no network, no browser).
  const studioFile = join(work, "studio_terbit.html")
  const gen = Bun.spawnSync([process.execPath, "test/verify-overlap/make-studio-fixture.ts", studioFile], { cwd: studioPkg, env, stdout: "pipe", stderr: "pipe" })
  if (gen.exitCode !== 0) throw new Error(`studio fixture: ${gen.stderr.toString()}`)
  studioHtml = readFileSync(studioFile, "utf8")

  // 2. The harness on the repo's Electron binary.
  const main = await Bun.build({ entrypoints: [join(here, "row151-harness-main.ts")], target: "node", format: "esm", external: ["electron"], outdir: join(work, "bundle"), naming: "main.mjs" })
  if (!main.success) throw new Error(main.logs.join("\n"))
  // --use-mock-keychain: never touch the macOS keychain from the fixture HOME (also appended in the harness).
  run = Bun.spawn([electron, "--use-mock-keychain", join(work, "bundle", "main.mjs")], {
    env: { ...env, ROW151_WORK: work, ROW151_FONTS: fontsDir, ELECTRON_ENABLE_LOGGING: "1" },
    stdout: "pipe",
    stderr: "pipe",
  })
  writeFileSync(join(work, "electron.pid"), String(run.pid))
  const child = run
  kill = () => {
    if (child.exitCode === null && !child.killed) child.kill("SIGKILL")
  }
  process.on("exit", () => kill?.())
  const deadline = Date.now() + 60_000
  while (!existsSync(join(work, "bridge.json"))) {
    if (child.exitCode !== null) throw new Error(`harness exited early (${child.exitCode}): ${existsSync(join(work, "result.json")) ? readFileSync(join(work, "result.json"), "utf8") : ""}`)
    if (Date.now() > deadline) throw new Error("bridge did not start in 60 s")
    await Bun.sleep(100)
  }
  bridgeInfo = JSON.parse(readFileSync(join(work, "bridge.json"), "utf8"))

  // 3. The datum-studio host caller, default deps, over the real socket.
  process.env.DATUM_RENDER_SOCKET = bridgeInfo.DATUM_RENDER_SOCKET
  process.env.DATUM_RENDER_TOKEN = bridgeInfo.DATUM_RENDER_TOKEN
  process.env.STUDIO_ASSETS_ROOT ??= join(studioPkg, "vendor", "src", "lib", "studio", "assets")
  if (!process.env.STUDIO_WORKSPACE_ROOT) {
    const ws = join(work, "ws")
    mkdirSync(ws, { recursive: true })
    process.env.STUDIO_WORKSPACE_ROOT = ws
  }
  oc = await import("../../../datum-studio/src/mcp-host/verify/overlap-clip")
  const cases: Record<string, string> = {
    paged_clean: PAGED_CLEAN,
    paged_overlap: PAGED_OVERLAP,
    paged_bottom: PAGED_BOTTOM,
    paged_right: PAGED_RIGHT,
    flow_clean: FLOW_CLEAN,
    flow_tall_row: FLOW_TALL_ROW,
    flow_no_margins: FLOW_NO_MARGINS,
    studio_clean: studioHtml,
    studio_overlap: studioWithOverlap(studioHtml).html,
  }
  for (const [name, html] of Object.entries(cases)) {
    const t0 = Date.now()
    results[name] = await oc.runOverlapClip({ format: name === "studio_clean" ? "PDF" : "HTML", html, ...A4 })
    ;(results[name] as unknown as { wallMs: number }).wallMs = Date.now() - t0
  }
  writeFileSync(join(work, "checks.json"), JSON.stringify(results, (k, v) => (k === "elements" ? `[${(v as unknown[]).length} elements]` : v), 2))
}, 240_000)

afterAll(async () => {
  if (!runnable || !run) return
  writeFileSync(join(work, "stop"), "")
  const t = setTimeout(() => kill?.(), 10_000)
  const [out, err, code] = await Promise.all([new Response(run.stdout as ReadableStream).text(), new Response(run.stderr as ReadableStream).text(), run.exited])
  clearTimeout(t)
  kill?.()
  writeFileSync(join(work, "electron.log"), `pid ${run.pid} exit ${code}\n--- stdout\n${out}\n--- stderr\n${err}`)
  console.log(`row151 harness work dir: ${work} (electron pid ${run.pid}, exit ${code})`)
  // Best effort: remove the folder only when this file created it (the env var was unset).
  if (ownWork) rmSync(work, { recursive: true, force: true })
}, 30_000)

const summary = (name: string) => results[name].check.findings.map((f) => `${f.code} p${f.page ?? "-"} ${f.address ?? "-"} ${f.amount ?? ""}`)

describe.skipIf(!runnable)("row 151: checkPage and the OVERLAP_CLIP scripts in real Electron 42 (GAP-2)", () => {
  test("the real bridge runs on Electron 42 with both fixed scripts allow-listed by this harness", () => {
    expect(bridgeInfo.scripts.sort()).toEqual(["studio.measure", "swarm.verify.overlap"])
    expect(bridgeInfo.DATUM_RENDER_SOCKET.startsWith(work)).toBe(true)
  })

  test("checkPage/evaluate works: both scripts returned real measurements (not UNKNOWN) on a clean paged page", () => {
    const r = results.paged_clean
    expect(r.check).toMatchObject({ status: "PASS", reason: null, findings: [] })
    expect(r.layout && "metrics" in r.layout).toBe(true)
    if (r.layout && "metrics" in r.layout) {
      expect(r.layout.metrics.paged).toBe(true)
      expect(r.layout.metrics.pageCount).toBe(2)
      expect(r.layout.metrics.elements.filter((e) => e.kind === "text").length).toBeGreaterThanOrEqual(4)
    }
    expect(r.overlap).toMatchObject({ paged: true, pageCount: 2, truncated: false, findingsTotal: 0 })
    expect(r.overlap!.boxes).toBeGreaterThan(4)
  })

  test("a real Studio HTML (row 123 fixture, flow layout) passes with 0 findings, checked as a PDF's same-job HTML", () => {
    const r = results.studio_clean
    expect(summary("studio_clean")).toEqual([])
    expect(r.check).toMatchObject({ status: "PASS", basis: "same-job-html", reason: null })
    expect(r.overlap!.paged).toBe(false)
    expect(r.overlap!.contentHeightMm).toBe(247)
    expect(r.overlap!.boxes).toBeGreaterThan(100)
  })

  test("a clean flow page with readable @page margins passes", () => {
    expect(summary("flow_clean")).toEqual([])
    expect(results.flow_clean.check.status).toBe("PASS")
    expect(results.flow_clean.overlap!.contentHeightMm).toBe(252)
  })

  test("B1 overlap: the pulled-up block on sheet 2 is OVERLAP with page 2 and both addresses", () => {
    const r = results.paged_overlap
    expect(r.check.status).toBe("FAIL")
    const f = r.check.findings.filter((x) => x.code === "OVERLAP")
    expect(f.length).toBe(1)
    expect(f[0]).toMatchObject({ page: 2, address: "2.1" })
    expect(f[0].detail).toContain("2.2")
    expect(f[0].amount!).toBeGreaterThan(1)
  })

  test("B1 on the real Studio HTML: a figure pulled 30 mm up is OVERLAP with the figure's address", () => {
    const { address } = studioWithOverlap(studioHtml)
    const r = results.studio_overlap
    expect(r.check.status).toBe("FAIL")
    const f = r.check.findings.filter((x) => x.code === "OVERLAP")
    expect(f.length).toBeGreaterThanOrEqual(1)
    expect(f.some((x) => x.address === address || x.detail.includes(address))).toBe(true)
    expect(f.every((x) => x.page === null)).toBe(true) // flow layout: no printed page number (L-1)
  })

  test("B2 clipped page (bottom): the 400 mm block is OVERFLOW_BOTTOM on sheet 1 with its address and mm", () => {
    const r = results.paged_bottom
    expect(r.check.status).toBe("FAIL")
    const f = r.check.findings.find((x) => x.code === "OVERFLOW_BOTTOM")!
    expect(f).toMatchObject({ page: 1, address: "1.3" })
    expect(f.amount!).toBeGreaterThan(100)
  })

  test("B2 flow layout: the row taller than the page content height is UNBREAKABLE_TOO_TALL", () => {
    const r = results.flow_tall_row
    expect(r.check.status).toBe("FAIL")
    const f = r.check.findings.filter((x) => x.code === "UNBREAKABLE_TOO_TALL")
    expect(f.length).toBeGreaterThanOrEqual(1)
    expect(f[0]).toMatchObject({ page: null, address: "1.2" })
    expect(f[0].amount!).toBeGreaterThan(40)
  })

  test("B3 clipped right / box clip: the clipped cell is BOX_CLIP and the 240 mm block is OVERFLOW_RIGHT, on sheet 1", () => {
    const r = results.paged_right
    expect(r.check.status).toBe("FAIL")
    const codes = new Set(r.check.findings.map((x) => x.code))
    expect(codes.has("BOX_CLIP")).toBe(true)
    expect(codes.has("OVERFLOW_RIGHT")).toBe(true)
    // The clipped cell itself (studio.measure kind "clip", measure.ts:169). The sheet, overflow visible, is also reported
    // as BOX_CLIP because the 240 mm block makes it scroll wider: measure.ts flags any scrollWidth > clientWidth.
    expect(r.check.findings.some((x) => x.code === "BOX_CLIP" && x.page === 1 && x.address === "1.2" && x.label === "td")).toBe(true)
    expect(r.check.findings.find((x) => x.code === "OVERFLOW_RIGHT")).toMatchObject({ page: 1, address: "1.3" })
  })

  test("unmeasurable: no @page margin to read in flow layout is UNKNOWN MARGINS_UNREADABLE, not PASS", () => {
    expect(results.flow_no_margins.check).toMatchObject({ status: "UNKNOWN", reason: "MARGINS_UNREADABLE", findings: [] })
  })
})
