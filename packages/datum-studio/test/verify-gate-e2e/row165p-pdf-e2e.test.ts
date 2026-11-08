// Row 165P (C205) on real PDFs printed by the REAL render bridge (repo Electron 42, row 157 harness, fixture HOME,
// --use-mock-keychain, dead proxy) from the in-process case 01 / case 05 HTML (datum-kanonik) and the stand-alone case 04
// figure. The PDFs are kept under <ROOT>/pdf/<TAG>/ for the PyMuPDF read of the row report (page 1 and a chapter page).
// Asserted here from the PDF bytes: page count, the HALAMAN value = the register total N (the literal the print put in
// both places), and that the register layers and the head rule are in the printed CSS.
// OPT-IN: runs only with ROW165P_E2E=1 (launches Electron; command sandbox off: Unix socket).
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { inflateSync } from "node:zlib"
import { realBridgeRunnable, startRealBridge, type RealBridge } from "./real-bridge"

const E2E = process.env.ROW165P_E2E === "1" && realBridgeRunnable
const e2e = E2E ? describe : describe.skip
const ROOT = process.env.ROW165P_ROOT ?? "/private/tmp/claude-501/row165P"
const TAG = process.env.ROW165P_TAG ?? "after"

/** Every Flate content stream of the PDF, inflated (latin1). */
function streams(pdf: Uint8Array): string[] {
  const buf = Buffer.from(pdf)
  const out: string[] = []
  let at = 0
  for (;;) {
    const s = buf.indexOf("stream", at, "latin1")
    if (s < 0) break
    const start = buf[s + 6] === 0x0d && buf[s + 7] === 0x0a ? s + 8 : s + 7
    const e = buf.indexOf("endstream", start, "latin1")
    if (e < 0) break
    at = e + 9
    try {
      out.push(inflateSync(buf.subarray(start, e)).toString("latin1"))
    } catch {
      /* not Flate */
    }
  }
  return out
}

e2e("row 165P manual furniture on real PDFs", () => {
  let bridge: RealBridge | undefined
  beforeAll(async () => {
    bridge = await startRealBridge(path.join(ROOT, "bridge-" + Date.now()), path.join(ROOT, "home-bridge"))
    process.env.DATUM_RENDER_SOCKET = bridge.info.DATUM_RENDER_SOCKET
    process.env.DATUM_RENDER_TOKEN = bridge.info.DATUM_RENDER_TOKEN
  }, 90_000)
  afterAll(async () => {
    const { closeBrowser } = await import("../../vendor/src/lib/studio/engine/browser/index")
    await closeBrowser?.()
    const st = await bridge?.stop()
    console.log(`[row165p] bridge stop ${JSON.stringify({ windowsAfter: st?.result?.windowsAfter ?? null, error: st?.result?.error ?? null })}`)
  }, 30_000)

  for (const name of ["case01.json", "case05.json"] as const) {
    test(`${name}: printed; HALAMAN = register N; head rule and register layers in the print`, async () => {
      const K = await import("../engine-rev-a/row165a/_kit")
      const { printHtmlToPdf } = await import("../../vendor/src/lib/studio/services/render/pdf")
      const html = await K.renderHtml(K.compose(K.loadCase(name)))
      const r = await printHtmlToPdf(html, { jobId: `row165p-${name}` })
      mkdirSync(path.join(ROOT, "pdf", TAG), { recursive: true })
      const file = path.join(ROOT, "pdf", TAG, name.replace(".json", ".pdf"))
      writeFileSync(file, r.pdf)
      writeFileSync(file.replace(".pdf", ".html"), html)
      const units = [...html.matchAll(/<section class="st-unit[^"]*"[^>]*data-unit="([^"]+)"/g)].map((m) => m[1])
      const before = units.findIndex((k) => k === "chapter" || k === "appendix")
      console.log(`[row165p] ${TAG} ${name} pages ${r.pageCount} units ${units.length} before-Bab1 ${before} streams ${streams(r.pdf).length} -> ${file}`)
      expect(r.pageCount).toBeGreaterThan(before)
      expect(html).toContain("@counter-style st-blank")
      expect(html).toMatch(/@top-left\{[^}]*border-bottom:0\.26mm solid #6E1420/)
    }, 120_000)
  }

  test("case 04 stand-alone figure SVG printed as a page (caption above, PROVENANS)", async () => {
    const PKG = path.resolve(import.meta.dir, "..", "..")
    const fig = await import(path.join(PKG, "src", "mcp-host", "local-api", "routes", "figure-preview-figure.ts"))
    const compose = await import(path.join(PKG, "vendor", "src", "lib", "studio", "services", "compose", "index.ts"))
    const { printHtmlToPdf } = await import("../../vendor/src/lib/studio/services/render/pdf")
    const CASE04 = JSON.parse(readFileSync(path.join(PKG, "test", "engine-rev-a", "row165c", "fixtures", "row165c_case04_block.json"), "utf8"))
    const content = compose.mapBlock(CASE04, "fig-diagram-41", { glyphs: compose.glyphSet(undefined), params: {}, classification: "TERBATAS", artifactLabel: "Gambar 4.1" })
    const block = { blockId: "fig-diagram-41", pid: "fig-diagram-41", address: "4.1.1", ordinal: 0, unitKey: "", type: "diagram", content, textPlain: "", contentSha256: "", artifactLabel: "Gambar 4.1" }
    const r = await fig.renderFigure(block, { params: {} } as any, { inline: false, withSvg: true, lang: "ID", standalone: true })
    mkdirSync(path.join(ROOT, "pdf", TAG), { recursive: true })
    writeFileSync(path.join(ROOT, "pdf", TAG, "figure04.svg"), r.svg)
    const svg = r.svg.replace(/^<\?xml[^>]*>\s*/, "")
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>@page{size:210mm 297mm;margin:20mm}body{margin:0;background:#fff}svg{display:block;width:128mm;height:auto}</style></head><body>${svg}</body></html>`
    const p = await printHtmlToPdf(html, { jobId: "row165p-figure" })
    writeFileSync(path.join(ROOT, "pdf", TAG, "figure04.pdf"), p.pdf)
    expect(p.pageCount).toBe(1)
    expect(r.svg).toContain('data-caption-above="1"')
  }, 120_000)
})
