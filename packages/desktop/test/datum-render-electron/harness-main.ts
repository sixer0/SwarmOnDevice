// Row 24a of docs/2026-11-06_swarm_1_2_0_datum_installer (F55-1, decision C118): a bare-Electron harness that drives
// the render bridge's real PageEngine (createElectronEngine, src/main/datum-render/electron-renderer.ts) in the repo's
// own Electron 42 binary. It prints HTML to PDF with the engine's `pdf` op and makes one PNG, writes the outputs and
// $ROW24A_WORK/result.json, and exits. The bun test next to this file parses the PDFs and asserts them.
// Never the Swarm app, never /Applications, never real user data: fixture HOME, userData and crashDumps under the
// work dir, the macOS keychain mocked, the render session offline (configureRenderSession).
import { app, BrowserWindow } from "electron"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createElectronEngine } from "../../src/main/datum-render/electron-renderer"
import { htmlWithFonts } from "../../src/main/datum-render/pages"

// Never touch the macOS keychain from a fixture HOME (driver_rules.md); --use-mock-keychain is also on the command line.
app.commandLine.appendSwitch("use-mock-keychain")

const work = process.env.ROW24A_WORK
if (!work) throw new Error("ROW24A_WORK is required")
mkdirSync(join(work, "userData"), { recursive: true })
mkdirSync(join(work, "crash"), { recursive: true })
mkdirSync(join(work, "out"), { recursive: true })
app.setPath("userData", join(work, "userData"))
app.setPath("crashDumps", join(work, "crash"))
// The engine destroys its window after each job; without this listener Electron would quit between jobs.
app.on("window-all-closed", () => {})

const result: Record<string, unknown> = { electron: process.versions.electron, chrome: process.versions.chrome }
const logs: unknown[] = []
const watchdog = setTimeout(() => {
  result.error = "watchdog timeout"
  finish(2)
}, 90_000)

function finish(code: number) {
  clearTimeout(watchdog)
  result.logs = logs
  writeFileSync(join(work!, "result.json"), JSON.stringify(result, null, 2))
  app.exit(code)
  setTimeout(() => process.exit(code), 1500).unref()
}

const page = (css: string, body: string) =>
  `<!doctype html><html lang="id"><head><meta charset="utf-8"><title>row24a</title><style>${css}</style></head>` +
  `<body>${body}</body></html>`

const A4_ONE = page(
  "@page{size:A4;margin:0}html,body{margin:0}body{font:12pt serif;background:#fff}.sheet{padding:20mm}",
  `<div class="sheet"><h1>Laporan satu halaman</h1><p>Isi halaman A4 tunggal.</p></div>`,
)
const THREE = page(
  "@page{size:210mm 297mm;margin:0}html,body{margin:0}.sheet{padding:20mm}.sheet+.sheet{break-before:page}",
  `<div class="sheet">Halaman satu</div><div class="sheet">Halaman dua</div><div class="sheet">Halaman tiga</div>`,
)
// A CSS page size that differs from the paper the caller asks for (A5 in CSS, A4 paper in the request).
const CSS_A5 = page("@page{size:148mm 210mm;margin:0}html,body{margin:0}.sheet{padding:10mm}", `<div class="sheet">A5 dari CSS</div>`)

type Case = { name: string; html: string; widthMm: number; heightMm: number; preferCSSPageSize: boolean }
const cases: Case[] = [
  { name: "a4_one", html: A4_ONE, widthMm: 210, heightMm: 297, preferCSSPageSize: true },
  { name: "three_pages", html: THREE, widthMm: 210, heightMm: 297, preferCSSPageSize: true },
  { name: "css_a5_prefer", html: CSS_A5, widthMm: 210, heightMm: 297, preferCSSPageSize: true },
  { name: "css_a5_paper", html: CSS_A5, widthMm: 210, heightMm: 297, preferCSSPageSize: false },
]

app.whenReady().then(async () => {
  try {
    app.dock?.hide()
    result.userData = app.getPath("userData")
    // No allowed files: data:, about:blank only, as for an HTML print with fonts inlined.
    const engine = createElectronEngine(new Set(), (level, source, message, extra) => logs.push({ level, source, message, extra }))
    result.info = engine.info()
    const pdfs: Record<string, unknown> = {}
    for (const c of cases) {
      const started = Date.now()
      try {
        // The bridge's own HTML preparation (dispatch.ts pdf): CSP meta + font block prepended (no fonts here).
        const bytes = await engine.pdf({
          html: htmlWithFonts(c.html, ""),
          widthMm: c.widthMm,
          heightMm: c.heightMm,
          preferCSSPageSize: c.preferCSSPageSize,
        })
        const file = join(work, "out", `${c.name}.pdf`)
        writeFileSync(file, bytes)
        pdfs[c.name] = { ok: true, file, bytes: bytes.length, isBuffer: Buffer.isBuffer(bytes), ms: Date.now() - started }
      } catch (e) {
        pdfs[c.name] = { ok: false, error: e instanceof Error ? e.message : String(e), ms: Date.now() - started }
      }
    }
    result.pdfs = pdfs
    try {
      const png = await engine.png({
        html: page("html,body{margin:0;background:#fff}div{width:40px;height:20px;background:#123456}", "<div></div>"),
        width: 40,
        height: 20,
      })
      writeFileSync(join(work, "out", "smoke.png"), png)
      result.png = { ok: true, bytes: png.length, head: png.subarray(0, 8).toString("hex") }
    } catch (e) {
      result.png = { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
    result.windowsAfter = BrowserWindow.getAllWindows().length
    finish(0)
  } catch (e) {
    result.error = e instanceof Error ? (e.stack ?? e.message) : String(e)
    finish(1)
  }
})
