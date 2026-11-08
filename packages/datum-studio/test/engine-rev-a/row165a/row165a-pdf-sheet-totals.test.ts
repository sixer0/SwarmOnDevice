// Wave 165 row 165A (C188 F113-6 / F113-3): the PDF print fills the sheet totals that only pagination knows.
// Real code: engine/html (case 01 / case 05 HTML through the kit) and services/render/pdf.ts over the row 108 bridge
// client. Faked: only the bridge transport (as test/templates-logo does); its "pdf" op answers like Chromium for this
// markup when every unit fits one sheet: one page per visible `.st-unit` (a unit hidden by the numbered-pass style is
// not printed). A real Electron print is the controller's recheck (wave 165 rebuild).
import { afterAll, describe, expect, test } from "bun:test"
import { readFileSync, writeFileSync } from "node:fs"

const K = await import("./_kit")
const runtime = await import("../../../vendor/src/lib/studio/engine/browser/runtime")
const { printHtmlToPdf, sheetTotalPlan, withSheetTotals } = await import("../../../vendor/src/lib/studio/services/render/pdf")

const printed: string[] = []
/** Unit key that the fake prints on two sheets (a contents page running over), to test the estimate check. */
let twoSheetKey: string | undefined
function fakePages(html: string): number {
  const units = [...html.matchAll(/<section class="st-unit[^"]*"[^>]*data-unit-key="([^"]+)"/g)].map((m) => m[1])
  const on = html.match(/<style data-studio="pdf-numbered-pass" media="all">([^<]*)<\/style>/)
  const hidden = new Set(on ? [...on[1].matchAll(/data-unit-key="([^"]+)"/g)].map((m) => m[1]) : [])
  return units.filter((k) => !hidden.has(k)).reduce((n, k) => n + (k === twoSheetKey ? 2 : 1), 0)
}
const pdfOf = (n: number) => Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Type /Pages /Count ${n} /Kids [] >>\nendobj\n%%EOF\n`, "latin1")

runtime.setRenderBridgeTransport(async (req: any) => {
  if (req.op === "hello") return { ok: true, electron: "42.3.3", chrome: "142.0.0.0", partition: "datum-render", sandbox: true, contextIsolation: true, nodeIntegration: false, javascriptContent: false, network: "blocked", fonts: 20, scripts: ["studio.measure"] }
  if (req.op === "pdf") {
    const html = readFileSync(req.src, "utf8")
    printed.push(html)
    writeFileSync(req.dst, pdfOf(fakePages(html)))
    return { ok: true }
  }
  return { ok: false, code: "UNKNOWN_OP", message: String(req.op) }
})
afterAll(() => runtime.setRenderBridgeTransport(null))

describe("F113-6 register DARI N = numbered sheets; F113-3 HALAMAN = printed pages", () => {
  test("case 05: two prints (numbered pass + final); the final print carries N (from Bab 1) and the page total", async () => {
    const html = await K.renderHtml(K.compose(K.loadCase("case05.json")))
    expect(sheetTotalPlan(html)).toEqual({ pages: true, numbered: true })
    const units = [...html.matchAll(/<section class="st-unit[^"]*"[^>]*data-unit="([^"]+)"/g)].map((m) => m[1])
    const before = units.findIndex((k) => k === "chapter" || k === "appendix")
    twoSheetKey = undefined
    printed.length = 0
    const r = await printHtmlToPdf(html, { jobId: "row165a-05" })
    expect(printed).toHaveLength(2)
    expect(printed[0]).toContain('<style data-studio="pdf-numbered-pass" media="all">')
    const T = units.length
    const N = units.length - before
    expect(r.pageCount).toBe(T)
    const final = printed[1]
    expect(final).not.toContain("/*st-N*/counter(pages)")
    expect(final).toContain('media="not all"')
    // Row 165P consequence edits (C205): the register is two overlapping layers (number and n bold ink900), N stays a
    // literal in the regular layer; HALAMAN = the register's N (CP-05 sheet count from Bab 1), not the page total T.
    expect(final).toMatch(new RegExp(`@bottom-left\\{content:[^}]*"LEMBAR[^"]*" counter\\(page, st-blank\\) "[^"]*DARI[^"]*" "${N}";`))
    expect(final).toContain(`:root{--st-pages-total:"${N}"}`)
    expect(N).toBeLessThan(T)
  })
  // Row 165P consequence edit (C205): HALAMAN = N is known after the numbered pass, so a contents unit that runs over two
  // sheets needs no reprint any more: still two prints, HALAMAN = N (the contents sheets are not counted).
  test("case 05, contents running over two sheets: two prints, HALAMAN = N, no reprint", async () => {
    const html = await K.renderHtml(K.compose(K.loadCase("case05.json")))
    const units = [...html.matchAll(/<section class="st-unit[^"]*"[^>]*data-unit="([^"]+)"/g)].map((m) => m[1])
    twoSheetKey = "F:toc"
    printed.length = 0
    const r = await printHtmlToPdf(html, { jobId: "row165a-05-toc2" })
    twoSheetKey = undefined
    expect(printed).toHaveLength(2)
    expect(r.pageCount).toBe(units.length + 1)
    const N = units.length - units.findIndex((k) => k === "chapter" || k === "appendix")
    expect(printed[1]).toContain(`:root{--st-pages-total:"${N}"}`)
  })
  test("withSheetTotals replaces every marked counter(pages) and adds the page total", () => {
    // Row 165I (M1): the slot is filled only inside Studio's own pages block (shell.ts PAGES_STYLE_OPEN) of the head.
    const h = `<html><head><style data-studio="pages">@page x{@bottom-center{content:counter(page) " DARI " /*st-N*/counter(pages)/*/st-N*/}}</style></head><body></body></html>`
    expect(withSheetTotals(h, 7, 4)).toContain(`counter(page) " DARI " "4"`)
    expect(withSheetTotals(h, 7, 4)).toContain(`:root{--st-pages-total:"7"}</style>\n</head>`)
    expect(withSheetTotals(h.replace('<style data-studio="pages">', "<style>"), 7, 4)).toContain("/*st-N*/counter(pages)/*/st-N*/")
  })
  test("an HTML without either marker prints once, unchanged", async () => {
    const h = `<!DOCTYPE html><html><head></head><body><section class="st-unit" data-unit-key="a"></section></body></html>`
    printed.length = 0
    const r = await printHtmlToPdf(h, { jobId: "row165a-plain" })
    expect(printed).toEqual([h])
    expect(r.pageCount).toBe(1)
  })
})
