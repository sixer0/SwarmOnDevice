// Row 165I (C196, verification/24_row165g_security.md M1): the PDF two-pass sheet-total substitution must only touch
// Studio's own furniture CSS. Document text (caption, paragraph, title) that carries the old static marker, or a
// token-form marker, stays inert: no attribute break-out, no change to the text, no change to a CSS string.
// Real code: engine/html (case 05 through the row 165A kit) and services/render/pdf.ts. Faked: only the bridge
// transport (as row165a-pdf-sheet-totals.test.ts does). No browser, no network, no model.
import { afterAll, describe, expect, test } from "bun:test"
import { readFileSync, writeFileSync } from "node:fs"
import { useStudioEnv } from "../ported/_env"

// The shared row 143a kit sets the env only once per process (module cache); this file sets its own (row 165E lesson).
useStudioEnv()

const K = await import("../engine-rev-a/row165a/_kit")
const runtime = await import("../../vendor/src/lib/studio/engine/browser/runtime")
const { escText } = await import("../../vendor/src/lib/studio/engine/html/tables/escape")
const { armSheetTotals, printHtmlToPdf, sheetTotalPlan, withSheetTotals } = await import("../../vendor/src/lib/studio/services/render/pdf")

const MARK = "/*st-N*/counter(pages)/*/st-N*/"
const ATTACK = `Alur ${MARK} style=position:fixed;inset:0;background:white;z-index:9 x`
const TOKEN_ATTACK = `Alur /*st-N:00000000000000000000000000000000*/counter(pages)/*/st-N:00000000000000000000000000000000*/ style=x`

const printed: string[] = []
function fakePages(html: string): number {
  const units = [...html.matchAll(/<section class="st-unit[^"]*"[^>]*data-unit-key="([^"]+)"/g)].map((m) => m[1])
  const on = html.match(/<style data-studio="pdf-numbered-pass" media="all">([^<]*)<\/style>/)
  const hidden = new Set(on ? [...on[1].matchAll(/data-unit-key="([^"]+)"/g)].map((m) => m[1]) : [])
  return units.filter((k) => !hidden.has(k)).length
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

/** case 05 with the attack text in the diagram caption, the first paragraph and (optionally) the title. */
function attackedCase(text: string, title = false): Record<string, any> {
  const doc = K.loadCase("case05.json")
  const ch = doc.sections.content.chapters[0]
  // `runs` (verbatim text; md-lite `text` would read the `*...*` of the marker as italics).
  ch.sections[2].blocks[0].caption = { runs: [{ t: text }] }
  delete ch.sections[0].blocks[0].text
  ch.sections[0].blocks[0].runs = [{ t: `Paragraf ${text}` }]
  // The chapter title reaches Studio's own pages block (running head CSS string, shell.ts runningHead).
  if (title) ch.title = { runs: [{ t: `Judul ${text}` }] }
  return doc
}

/** Values of the figure text attributes (svg aria-label, img alt) that carry the marker text. */
const ariaOf = (html: string) => [...html.matchAll(/\b(?:aria-label|alt)="([^"]*)"/g)].map((m) => m[1]).filter((a) => a.includes("st-N"))
const tagsWith = (html: string) => [...html.matchAll(/<(?:svg|img)\b[^>]*>/g)].map((m) => m[0]).filter((t) => t.includes("st-N"))
/** Attribute names of one start tag, in order, read like an HTML parser (double-quoted values skipped). */
const attrNames = (tag: string) => [...tag.slice(tag.indexOf(" ")).matchAll(/\s*([^\s=>"]+)(?:="[^"]*")?/g)].map((m) => m[1]).filter((n) => n !== ">" && n !== "/")
const attrValue = (tag: string, name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1]
/** Inline SVG figure as tables/svg.ts:274 emits it (aria-label from the caption through escText), spliced in the body. */
const withSvgFigure = (html: string, caption: string) => html.replace("</body>", `<svg class="st-figure-svg" role="img" aria-label="${escText(caption)}"></svg>\n</body>`)
const pagesBlockOf = (html: string) => html.slice(html.indexOf('<style data-studio="pages">'), html.indexOf("</style>", html.indexOf('<style data-studio="pages">')))

describe("row 165I M1: the sheet-total marker in document text stays inert", () => {
  for (const [name, text] of [
    ["static marker", ATTACK],
    ["token-form marker", TOKEN_ATTACK],
  ] as const) {
    test(`${name} in a caption and a paragraph: final print text unchanged, no attribute break-out`, async () => {
      const html = withSvgFigure(await K.renderHtml(K.compose(attackedCase(text))), text)
      expect(sheetTotalPlan(html)).toEqual({ pages: true, numbered: true })
      const ariaBefore = ariaOf(html)
      expect(ariaBefore.length).toBeGreaterThanOrEqual(2) // img alt of the diagram + the inline svg aria-label
      expect(ariaBefore).toContain(escText(text))
      const paraBefore = html.split(`Paragraf ${text.replace(/"/g, "&quot;")}`).length - 1
      printed.length = 0
      await printHtmlToPdf(html, { jobId: "row165i-m1" })
      expect(printed.length).toBe(2)
      for (const out of printed) {
        // The figure aria-label values (caption) are byte-identical to the deliverable HTML.
        expect(ariaOf(out)).toEqual(ariaBefore)
        for (const a of ariaBefore) expect(a).toContain(text.split(" style=")[0])
        // No svg element gained a style attribute; the injected declaration never leaves the attribute value.
        expect(tagsWith(out)).toEqual(tagsWith(html)) // every svg/img tag carrying the text is byte-identical
        const svg = tagsWith(out).find((t) => t.startsWith("<svg"))
        expect(svg).toBeDefined()
        // Attribute names as an HTML parser sees them (quoted values skipped): no `style` on the svg.
        expect(attrNames(svg!)).toEqual(["class", "role", "aria-label"])
        expect(attrValue(svg!, "aria-label")).toBe(escText(text))
        expect(out).not.toContain('"7" style=')
        expect(out).not.toMatch(/aria-label="Alur "/)
        // The paragraph text keeps the marker verbatim.
        expect(out.split(`Paragraf ${text.replace(/"/g, "&quot;")}`).length - 1).toBe(paraBefore)
      }
      // The Studio furniture slot itself was filled in the final print.
      const final = printed[1]
      expect(pagesBlockOf(final)).not.toContain(MARK)
      expect(pagesBlockOf(final)).not.toMatch(/\/\*st-N:[0-9a-f]{32}\*\//)
      expect(pagesBlockOf(final)).toMatch(/"[^"]*DARI[^"]*" "\d+";/)
    })
  }

  test("marker in the chapter title (inside Studio's pages block): the running-head CSS string stays intact", async () => {
    const html = await K.renderHtml(K.compose(attackedCase(ATTACK, true)))
    const before = pagesBlockOf(html)
    const titleStrings = (css: string) => [...css.matchAll(/content:"BAB [^"]*Judul [^"]*"/g)].map((m) => m[0])
    expect(titleStrings(before).length).toBeGreaterThan(0)
    expect(titleStrings(before)[0]).toContain(MARK)
    printed.length = 0
    await printHtmlToPdf(html, { jobId: "row165i-m1-title" })
    const after = pagesBlockOf(printed[1])
    expect(titleStrings(after)).toEqual(titleStrings(before))
    expect(after).not.toContain('Judul Alur "')
  })

  test("armSheetTotals: a fresh 128-bit token per print, only Studio slots armed", () => {
    const h = `<html><head><style data-studio="pages">@page x{@bottom-center{content:"T ${MARK}" counter(page) " DARI " ${MARK}}}</style></head><body><p data-x="${MARK}">${MARK}</p></body></html>`
    const a = armSheetTotals(h)
    const b = armSheetTotals(h)
    expect(a.token).toMatch(/^[0-9a-f]{32}$/)
    expect(a.token).not.toBe(b.token)
    expect(a.slots).toBe(1)
    const out = withSheetTotals(a.html, 9, 4, a.token)
    expect(out).toContain(`content:"T ${MARK}" counter(page) " DARI " "4"}`)
    expect(out).toContain(`<p data-x="${MARK}">${MARK}</p>`)
    // A slot armed under one token is not filled by another.
    expect(withSheetTotals(a.html, 9, 4, b.token)).toContain(`/*st-N:${a.token}*/`)
  })
})
