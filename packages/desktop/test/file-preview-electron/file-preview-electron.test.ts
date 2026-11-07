// Row 112 of docs/2026-11-06_swarm_1_2_0_datum_installer (studio spec §8.2, P1, P2, P5, P6, P7 in real Chromium).
// Runs the repo's own Electron binary on harness-main.ts with a fixture HOME and userData under the work dir; never the
// Swarm app, never /Applications, never real user data; every http(s) request is recorded and cancelled.
// Input: a real Studio HTML output (ROW112_STUDIO_HTML), else a small Studio-shaped page written here.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const here = import.meta.dir
const electron = join(here, "../../node_modules/electron/dist/Electron.app/Contents/MacOS/Electron")
const runnable = existsSync(electron) && !electron.startsWith("/Applications/") && process.platform === "darwin"
const work = process.env.ROW112_WORK ?? mkdtempSync(join(tmpdir(), "row112-preview-"))

const FALLBACK_STUDIO_HTML = `<!DOCTYPE html><html lang="id"><head><meta charset="utf-8"><title>GSP Laporan</title>
<style>@page{size:210mm 297mm;margin:20mm}.st-p{margin:0 0 4mm}.pb{break-after:page}</style></head><body>
<p class="st-p">Laporan Kerja halaman satu</p><div class="pb"></div><p class="st-p">Halaman dua</p><div class="pb"></div>
<p class="st-p">Halaman tiga</p></body></html>`

let result: any
beforeAll(async () => {
  if (!runnable) return
  mkdirSync(join(work, "renderer"), { recursive: true })
  mkdirSync(join(work, "home"), { recursive: true })
  const studioHtml = process.env.ROW112_STUDIO_HTML ?? join(work, "studio.html")
  if (!process.env.ROW112_STUDIO_HTML) writeFileSync(studioHtml, FALLBACK_STUDIO_HTML)
  const multipage = join(work, "multipage.html")
  writeFileSync(multipage, FALLBACK_STUDIO_HTML)
  const main = await Bun.build({
    entrypoints: [join(here, "harness-main.ts")],
    target: "node",
    format: "esm",
    external: ["electron"],
    outdir: join(work, "bundle"),
    naming: "main.mjs",
  })
  const renderer = await Bun.build({
    entrypoints: [join(here, "harness-renderer.ts")],
    target: "browser",
    format: "iife",
    outdir: join(work, "renderer"),
    naming: "harness.js",
  })
  if (!main.success || !renderer.success) throw new Error([...main.logs, ...renderer.logs].join("\n"))
  writeFileSync(join(work, "renderer", "preload.js"), "")
  // The app's renderer CSP, verbatim from packages/desktop/src/renderer/index.html:6.
  writeFileSync(
    join(work, "renderer", "index.html"),
    `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="script-src 'self' 'wasm-unsafe-eval'"><title>harness</title></head><body><script src="./harness.js"></script></body></html>`,
  )
  // --use-mock-keychain: never touch the macOS keychain from the fixture HOME (also appended in harness-main.ts).
  const run = Bun.spawn([electron, "--use-mock-keychain", join(work, "bundle", "main.mjs")], {
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: join(work, "home"),
      ROW112_WORK: work,
      ROW112_STUDIO_HTML: studioHtml,
      ROW112_MULTIPAGE_HTML: multipage,
      HTTP_PROXY: "http://127.0.0.1:9",
      HTTPS_PROXY: "http://127.0.0.1:9",
      ALL_PROXY: "http://127.0.0.1:9",
      NO_PROXY: "127.0.0.1,localhost",
      ELECTRON_ENABLE_LOGGING: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const kill = setTimeout(() => run.kill(), 100_000)
  const [out, err, code] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text(), run.exited])
  clearTimeout(kill)
  writeFileSync(join(work, "electron.log"), `exit ${code}\n--- stdout\n${out}\n--- stderr\n${err}`)
  result = JSON.parse(readFileSync(join(work, "result.json"), "utf8"))
  result.exit = code
}, 120_000)

afterAll(() => {
  if (runnable) console.log(`row112 harness work dir: ${work}`)
})

const web = (url: string) => /^(https?|wss?|ftp):/i.test(url)

describe.skipIf(!runnable)("file-tab preview in real Electron/Chromium", () => {
  test("the harness ran to the end on Electron 42", () => {
    expect(result.error).toBeUndefined()
    expect(result.exit).toBe(0)
    expect(result.electron).toBe("42.3.3")
  })

  test("P5: the window was built from mainWindowWebPreferences (isolation, no node, sandbox, plugins)", () => {
    expect(result.prefs).toMatchObject({ contextIsolation: true, nodeIntegration: false, sandbox: true, plugins: true })
    expect("webviewTag" in result.prefs).toBe(false)
  })

  test("P1: a Studio PDF loads in Chromium's built-in viewer from a blob: URL, page count equal to the PDF's", () => {
    expect(result.pdf.head).toBe("%PDF-")
    expect(result.pdf.pages).toBeGreaterThan(0)
    expect(result.pdfPreview.opened.url).toMatch(/^blob:oc:\/\/renderer\//)
    expect(result.pdfPreview.opened.pages).toBe(result.pdf.pages)
    expect(result.pdfPreview.viewerFrame?.origin).toBe("chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai")
    const counts = (result.pdfPreview.viewerPageCount.value?.found ?? []).map((f: { value: number }) => f.value)
    expect(counts).toContain(result.pdf.pages)
  })

  test("P1: a three-page PDF shows three pages in the viewer, equal to the count the tab computes", () => {
    expect(result.multipage.pages).toBe(3)
    expect(result.multipage.opened.pages).toBe(3)
    const counts = (result.multipage.viewerPageCount.value?.found ?? []).map((f: { value: number }) => f.value)
    expect(counts.length).toBeGreaterThan(0)
    expect(new Set(counts)).toEqual(new Set([3]))
  })

  test("P7: the blob URL resolves while open and not after the preview closes", () => {
    expect(result.pdfPreview.blobReadableBeforeClose).toBe(true)
    expect(result.multipage.firstBlobReadableAfterReplace).toBe(false)
    expect(result.blobReadableAfterClose).toBe(false)
  })

  test("P2: the HTML preview did not run the script and made 0 network requests", () => {
    // Chromium refuses even a devtools-injected script in the sandboxed frame: scripting is off there.
    expect(result.htmlPreview.frameTitle).toEqual({ error: "Script not run" })
    expect(result.htmlPreview.appTitle).toBe("harness")
    expect(result.htmlPreview.srcdoc).toMatchObject({
      sandbox: "",
      csp: "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:",
      scripts: 0,
      remote: false,
    })
    const shipped = result.requests.filter((r: { phase: string }) => !r.phase.startsWith("contrast") && r.phase !== "print")
    expect(shipped.filter((r: { url: string }) => web(r.url))).toEqual([])
    // file: requests are only the renderer's own files (served like windows.ts does), never the previewed document's.
    expect(shipped.filter((r: { url: string }) => r.url.startsWith("file:") && !r.url.startsWith(result.rendererFiles))).toEqual([])
  })

  test("P6: clicking the link and navigating the preview frames neither navigates the app nor opens a window", () => {
    expect(result.htmlPreview.srcdoc.linkHref).toBeNull()
    expect(result.htmlPreview.srcdoc.linkText).toBe("CLICK")
    expect(result.mainUrlAfter).toBe(result.mainUrlBefore)
    expect(result.navigations.filter((n: { kind: string }) => n.kind === "window-open")).toEqual([])
    expect(result.navigations.filter((n: { kind: string; url: string }) => n.kind === "did-navigate-frame" && web(n.url))).toEqual([])
    const refused = result.blocked.map((b: { url: string }) => b.url)
    expect(refused).toContain("https://example.invalid/from-pdf")
    expect(refused).toContain("https://example.invalid/from-html")
    expect(result.windowsAfter).toBe(1)
  })
})
