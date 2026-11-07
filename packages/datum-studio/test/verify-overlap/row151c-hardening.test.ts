// Row 151c (decision C161 L1/L2; verification/19_row135b_verify_write_security.md): the OVERLAP_CLIP host caller no
// longer trusts a page answer that scanned no ink (host-side plausibility), the two page scripts read the DOM only
// through prototype references, and the vendored SVG sanitizer lets only SVG elements through and drops a root
// `aria-hidden`. What the scripts measure under hostile markup is proven in real Electron:
// packages/desktop/test/datum-render-electron/row151c-store-paths.test.ts (row 135b's probe now FAILs).
import { afterEach, describe, expect, it } from "bun:test"
import { useStudioEnv } from "../ported/_env"
import * as runtime from "../../vendor/src/lib/studio/engine/browser/runtime"
import { MEASURE_SCRIPT } from "../../vendor/src/lib/studio/engine/browser/measure"
import { sanitizeSvg, SVG_ALLOWED_ELEMENTS } from "../../vendor/src/lib/studio/engine/html/tables/svg"
import { implausibleOverlap, inkExpected, OVERLAP_SCRIPT, OVERLAP_SCRIPT_NAME, parseOverlapResult, runOverlapClip } from "../../src/mcp-host/verify/overlap-clip"

useStudioEnv()

const GOOD_INFO = { electron: "42.3.3", chrome: "142.0.0.0", partition: "datum-render", sandbox: true, contextIsolation: true, nodeIntegration: false, javascriptContent: false, network: "blocked", fonts: 16, scripts: ["studio.measure", OVERLAP_SCRIPT_NAME] }
function stubBridge(o: { measure: unknown; overlap: unknown }) {
  runtime.setRenderBridgeTransport(async (req) => {
    if (req.op === "hello") return { ok: true, ...GOOD_INFO }
    if (req.op === "checkPage") {
      if (req.script === MEASURE_SCRIPT) return { ok: true, script: "studio.measure", result: o.measure }
      if (req.script === OVERLAP_SCRIPT) return { ok: true, script: OVERLAP_SCRIPT_NAME, result: o.overlap }
    }
    return { ok: false, code: "BAD_REQUEST" }
  })
}
afterEach(() => runtime.setRenderBridgeTransport(null))

const page = (n: number) => ({ kind: "page", page: n, xMm: 0, yMm: 0, widthMm: 210, heightMm: 297, colors: ["#101418"], label: "page", overflow: false })
const text = (n: number) => ({ kind: "text", page: n, xMm: 24, yMm: 30, widthMm: 160, heightMm: 5, address: "1.1", tag: "p", label: "p", fontSizePt: 10, measureMm: 160, lineCount: 1, charCount: 40, charsPerLine: 40, maxLineWidthMm: 120 })
const HTML = '<!doctype html><html><head><style>@page{size:A4;margin:0}</style></head><body><div class="page"><p data-address="1.1">isi</p></div></body></html>'
const A4 = { pageWidthMm: 210, pageHeightMm: 297 }
const overlapAnswer = (boxes: number) => ({ paged: true, pageCount: 1, truncated: false, marginsUnreadable: false, contentHeightMm: null, boxes, scanned: 4, findingsTotal: 0, findings: [] })

describe("row 151c L1: host-side plausibility of the overlap answer", () => {
  it("0 ink boxes for a document with text is UNKNOWN VERIFY_INTERNAL, never PASS (row 135b: <img name=body> gave PASS, boxes 0)", async () => {
    stubBridge({ measure: { paged: true, pageCount: 1, truncated: false, elements: [page(1), text(1)] }, overlap: overlapAnswer(0) })
    const r = await runOverlapClip({ format: "HTML", html: HTML, ...A4 })
    expect(r.check).toMatchObject({ status: "UNKNOWN", reason: "VERIFY_INTERNAL" })
  })

  it("the same answer with boxes > 0 is PASS (the rule only catches an empty scan)", async () => {
    stubBridge({ measure: { paged: true, pageCount: 1, truncated: false, elements: [page(1), text(1)] }, overlap: overlapAnswer(3) })
    expect((await runOverlapClip({ format: "HTML", html: HTML, ...A4 })).check.status).toBe("PASS")
  })

  it("0 boxes is still caught when the measure itself saw no text (host reads the HTML text, which no page markup can change)", async () => {
    stubBridge({ measure: { paged: true, pageCount: 1, truncated: false, elements: [page(1)] }, overlap: overlapAnswer(0) })
    expect((await runOverlapClip({ format: "HTML", html: HTML, ...A4 })).check).toMatchObject({ status: "UNKNOWN", reason: "VERIFY_INTERNAL" })
  })

  it("the script's { untrusted } answer is not the result shape: UNKNOWN VERIFY_INTERNAL", async () => {
    expect(parseOverlapResult({ untrusted: "document members are not the document body" })).toBeNull()
    stubBridge({ measure: { paged: true, pageCount: 1, truncated: false, elements: [page(1), text(1)] }, overlap: { untrusted: "x" } })
    expect((await runOverlapClip({ format: "HTML", html: HTML, ...A4 })).check).toMatchObject({ status: "UNKNOWN", reason: "VERIFY_INTERNAL" })
  })

  it("inkExpected: text, svg or img is ink; style, script, comments, tags and &nbsp; are not", () => {
    expect(inkExpected("<html><body><p>a</p></body></html>")).toBe(true)
    expect(inkExpected('<html><body><figure><svg viewBox="0 0 1 1"></svg></figure></body></html>')).toBe(true)
    expect(inkExpected('<html><body><img alt=""></body></html>')).toBe(true)
    expect(inkExpected("<html><head><title>t</title></head><body><style>p{}</style><!-- x --><script>y</script><p>&nbsp;</p></body></html>")).toBe(false)
    expect(inkExpected("<html><body></body></html>", [{ kind: "text" }])).toBe(true)
    expect(implausibleOverlap(parseOverlapResult(overlapAnswer(0))!, "<html><body></body></html>")).toBe(false)
  })
})

describe("row 151c L1: the page scripts never read a document or element member by name", () => {
  for (const [name, text] of [["swarm.verify.overlap", OVERLAP_SCRIPT], ["studio.measure", MEASURE_SCRIPT]] as const) {
    it(`${name}: no document.<member>, no el.closest/.tagName/.className/.parentElement/.querySelector*; body checked`, () => {
      const code = text.replace(/\/\/[^\n]*/g, "")
      expect(code.match(/document\.[A-Za-z]+/g)).toBeNull()
      expect(code.match(/\b(?:el|e|p|s|t|im|tbl|host|reg|scope|root|a)\.(?:closest|tagName|className|parentElement|querySelector|querySelectorAll|getAttribute|getBoundingClientRect|getClientRects|contains|firstChild|nextSibling|clientWidth|scrollWidth|textContent|id)\b/g)).toBeNull()
      expect(code).toContain("instanceof HTMLBodyElement")
      expect(code).toContain("Document.prototype")
      expect(() => new Function(`return ${text}`)).not.toThrow()
    })
  }

  it("swarm.verify.overlap: aria-hidden is no longer a skip marker (L2)", () => {
    expect(OVERLAP_SCRIPT).toContain("var SKIP = '.reg,.st-screen,.st-draft-mark';")
    expect(OVERLAP_SCRIPT).not.toContain('[aria-hidden="true"]')
  })
})

describe("row 151c L1/L2: the vendored SVG sanitizer (row 135b sanitize_run.txt cases)", () => {
  const S = (svg: string) => sanitizeSvg(svg, { idPrefix: "fig-b1", widthMm: 50, heightMm: 30, ariaLabel: "x" })
  it("HTML breakout elements are dropped with their subtree: img, div, form, p, span, table, font", () => {
    for (const inner of ['<img name="body"/>', '<img id="body"/>', '<div class="reg" style="position:fixed;top:0">x</div>', '<form name="querySelectorAll"></form>', "<p>x</p>", "<span>y</span>", "<table><tr><td>z</td></tr></table>", '<font color="red">w</font>']) {
      const r = S(`<svg viewBox="0 0 10 10">${inner}<rect width="5" height="5"/></svg>`)
      expect([inner, /<(img|div|form|p|span|table|tr|td|font)\b/.test(r.svg)]).toEqual([inner, false])
      expect(r.svg).toContain("<rect")
      expect(r.removed.elements).toBeGreaterThan(0)
    }
  })
  it("a root aria-hidden is dropped; other root attributes and inner SVG structure stay", () => {
    const r = S('<svg viewBox="0 0 10 10" aria-hidden="true"><defs><clipPath id="c"><rect width="1" height="1"/></clipPath><linearGradient id="g"><stop offset="0"/></linearGradient></defs><g clip-path="url(#c)"><text><tspan>t</tspan><textPath href="#p">u</textPath></text><path id="p" d="M0 0"/></g></svg>')
    expect(r.svg).not.toContain("aria-hidden")
    for (const t of ["<clipPath", "<linearGradient", "<stop", "<g ", "<text>", "<tspan>", "<textPath", "<path"]) expect(r.svg).toContain(t)
    expect(r.svg).toContain('viewBox="0 0 10 10"')
  })
  it("the allow-list is SVG element names only (no HTML breakout name)", () => {
    for (const n of ["img", "div", "p", "span", "table", "font", "form", "input", "body", "html", "b", "br", "pre"]) expect(SVG_ALLOWED_ELEMENTS).not.toContain(n)
  })
})
