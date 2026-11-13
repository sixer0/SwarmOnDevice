// Row 151b of docs/2026-11-06_swarm_1_2_0_datum_installer (decision C130 GAP-1): a bare-Electron harness for the render
// bridge's `pagePng` op on the repo's own Electron 42 binary. It drives the real dispatcher (createDispatcher) over the
// real PageEngine (createElectronEngine) with the real path policy and font bundle, writes the page PNGs, samples their
// pixels with nativeImage, records refusals, writes $ROW151B_WORK/result.json and exits.
// Never the Swarm app, never /Applications, never real user data: fixture HOME, userData and crashDumps under the work
// dir, the macOS keychain mocked, the render session offline (configureRenderSession).
import { app, BrowserWindow, nativeImage } from "electron"
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { createDispatcher } from "../../src/main/datum-render/dispatch"
import { createElectronEngine } from "../../src/main/datum-render/electron-renderer"
import { buildFontBundle } from "../../src/main/datum-render/fonts"
import { defaultPolicy } from "../../src/main/datum-render/paths"
import { ScriptAllowList } from "../../src/main/datum-render/scripts"

// Never touch the macOS keychain from a fixture HOME (driver_rules.md); --use-mock-keychain is also on the command line.
app.commandLine.appendSwitch("use-mock-keychain")

const work = process.env.ROW151B_WORK
const fontsDir = process.env.ROW151B_FONTS
if (!work || !fontsDir) throw new Error("ROW151B_WORK and ROW151B_FONTS are required")
for (const d of ["userData", "crash", "in", "out", "out/a5", "out/flow", "out/a5k", "out/dpi96"]) mkdirSync(join(work, d), { recursive: true })
app.setPath("userData", join(work, "userData"))
app.setPath("crashDumps", join(work, "crash"))
app.on("window-all-closed", () => {})

const result: Record<string, unknown> = { electron: process.versions.electron, chrome: process.versions.chrome, home: homedir() }
const watchdog = setTimeout(() => {
  result.error = "watchdog timeout"
  finish(2)
}, 150_000)

function finish(code: number) {
  clearTimeout(watchdog)
  writeFileSync(join(work!, "result.json"), JSON.stringify(result, null, 2))
  app.exit(code)
  setTimeout(() => process.exit(code), 1500).unref()
}

const doc = (css: string, body: string) =>
  `<!doctype html><html lang="id"><head><meta charset="utf-8"><title>row151b</title><style>${css}</style></head><body>${body}</body></html>`

// Studio-like paged HTML (html/base/markup.ts:241 `.page` sections): screen and print CSS give different colours, so
// the centre pixel proves the print media emulation. Page n: print colour red / green / blue, screen colour magenta.
const PAGED3 = doc(
  "@page{size:A4;margin:0}html,body{margin:0;background:#fff}" +
    ".page{width:210mm;height:297mm;overflow:hidden;position:relative}" +
    "@media screen{.page{margin:10mm auto;background:#ff00ff}}" +
    "@media print{.page{margin:0;break-after:page}.p1{background:#ff0000}.p2{background:#00ff00}.p3{background:#0000ff}}",
  `<section class="page p1">Halaman satu</section><section class="page p2">Halaman dua</section><section class="page p3">Halaman tiga</section>`,
)
// Flow HTML (row 24a THREE fixture shape): no page elements, CSS breaks; a coloured band at the top of every sheet.
const FLOW3 = doc(
  "@page{size:210mm 297mm;margin:0}html,body{margin:0;background:#fff}.sheet+.sheet{break-before:page}" +
    ".band{height:20mm}.s1 .band{background:#ff0000}.s2 .band{background:#00ff00}.s3 .band{background:#0000ff}",
  `<div class="sheet s1"><div class="band"></div>Halaman satu</div><div class="sheet s2"><div class="band"></div>Halaman dua</div>` +
    `<div class="sheet s3"><div class="band"></div>Halaman tiga</div>`,
)
// CSS A5 in mm lengths; the request asks for nothing (A4 fallback), so A5 must come from @page.
const CSS_A5 = doc("@page{size:148mm 210mm;margin:0}html,body{margin:0;background:#ffff00}", `<p>A5 dari CSS</p>`)
// CSS A5 as a keyword with Studio-like page sections.
const KEYWORD_A5 = doc(
  "@page{size:A5 portrait;margin:0}html,body{margin:0}.page{width:148mm;height:210mm;background:#00ffff}",
  `<section class="page">A5</section><section class="page">A5 dua</section>`,
)

const files: Record<string, string> = { paged3: PAGED3, flow3: FLOW3, css_a5: CSS_A5, keyword_a5: KEYWORD_A5 }
for (const [name, html] of Object.entries(files)) writeFileSync(join(work, "in", `${name}.html`), html)

type Sample = { x: number; y: number; rgb: string }
function inspect(path: string, points: Array<[number, number]>) {
  const img = nativeImage.createFromBuffer(readFileSync(path))
  const { width, height } = img.getSize()
  const bmp = img.toBitmap() // BGRA, row-major
  const samples: Sample[] = points.map(([fx, fy]) => {
    const x = Math.min(width - 1, Math.round(fx * width))
    const y = Math.min(height - 1, Math.round(fy * height))
    const i = (y * width + x) * 4
    const hex = (v: number) => v.toString(16).padStart(2, "0")
    return { x, y, rgb: `#${hex(bmp[i + 2])}${hex(bmp[i + 1])}${hex(bmp[i])}` }
  })
  return { width, height, samples }
}

app.whenReady().then(async () => {
  try {
    app.dock?.hide()
    result.userData = app.getPath("userData")
    const log: unknown[] = []
    const fonts = buildFontBundle(fontsDir)
    const engine = createElectronEngine(new Set(fonts.files), (level, source, message, extra) => log.push({ level, source, message, extra }))
    const policy = defaultPolicy(homedir())
    result.policy = policy
    const dispatch = createDispatcher({ engine, policy, fonts: () => fonts, scripts: new ScriptAllowList() })
    const call = async (body: Record<string, unknown>) => {
      const started = Date.now()
      try {
        return { ok: true, ms: Date.now() - started, ...(await dispatch(body)) }
      } catch (e) {
        const err = e as { code?: string; message?: string }
        return { ok: false, ms: Date.now() - started, code: err.code ?? "THROWN", message: err.message ?? String(e) }
      }
    }
    const runs: Record<string, any> = {}
    const src = (n: string) => join(work, "in", `${n}.html`)
    runs.paged3 = await call({ op: "pagePng", src: src("paged3"), dstDir: join(work, "out") })
    runs.flow3 = await call({ op: "pagePng", src: src("flow3"), dstDir: join(work, "out", "flow") })
    runs.css_a5 = await call({ op: "pagePng", src: src("css_a5"), dstDir: join(work, "out", "a5") })
    runs.keyword_a5 = await call({ op: "pagePng", src: src("keyword_a5"), dstDir: join(work, "out", "a5k") })
    runs.dpi96_p2 = await call({ op: "pagePng", src: src("paged3"), dstDir: join(work, "out", "dpi96"), dpi: 96, pages: [2] })

    // Pixels: centre of each paged page; the band (10 mm from the top) of each flow page; the A5 pages' centres.
    const pix: Record<string, unknown> = {}
    for (const name of ["paged3", "flow3", "css_a5", "keyword_a5", "dpi96_p2"]) {
      const r = runs[name]
      if (!r.ok) continue
      pix[name] = r.pages.map((p: { dst: string }) =>
        inspect(p.dst, name === "flow3" ? [[0.5, 10 / 297], [0.5, 0.5]] : [[0.5, 0.5]]),
      )
    }
    result.pixels = pix

    // Refusals through the same dispatcher (allow-list and path policy).
    const ssh = join(homedir(), ".ssh")
    mkdirSync(ssh, { recursive: true })
    writeFileSync(join(ssh, "id.html"), "<p>fixture, not a key</p>")
    mkdirSync(join(work, "out", "link"), { recursive: true })
    symlinkSync(join(work, "out", "elsewhere.png"), join(work, "out", "link", "witness-p001.png"))
    const refused: Record<string, unknown> = {}
    refused.protectedDst = await call({ op: "pagePng", src: src("paged3"), dstDir: ssh })
    refused.relativeDst = await call({ op: "pagePng", src: src("paged3"), dstDir: "out" })
    refused.outsideRoots = await call({ op: "pagePng", src: src("paged3"), dstDir: "/usr/share" })
    refused.dotdotDst = await call({ op: "pagePng", src: src("paged3"), dstDir: `${work}/out/../out` })
    refused.missingDst = await call({ op: "pagePng", src: src("paged3"), dstDir: join(work, "nope") })
    refused.symlinkDst = await call({ op: "pagePng", src: src("paged3"), dstDir: join(work, "out", "link") })
    refused.svgSrc = await call({ op: "pagePng", src: resolve(work, "in", "x.svg"), dstDir: join(work, "out") })
    refused.protectedSrc = await call({ op: "pagePng", src: join(ssh, "id.html"), dstDir: join(work, "out") })
    refused.tooManyPages = await call({ op: "pagePng", src: src("paged3"), dstDir: join(work, "out"), pages: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13] })
    refused.badDpi = await call({ op: "pagePng", src: src("paged3"), dstDir: join(work, "out"), dpi: 1200 })
    refused.extraField = await call({ op: "pagePng", src: src("paged3"), dstDir: join(work, "out"), script: "x" })
    result.runs = runs
    result.refused = refused
    result.log = log
    result.windowsAfter = BrowserWindow.getAllWindows().length
    finish(0)
  } catch (e) {
    result.error = e instanceof Error ? (e.stack ?? e.message) : String(e)
    finish(1)
  }
})
