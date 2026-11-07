// Row 143a (decision C177, finding F143-1 of verification/16_row143_app_studio_1_2_1.md): the three engine faults the
// output verification gate found in the 1.2.1 build, each tested at its cause on the row 55b adapted Rev A material
// (copied, see fixtures/SHA256SUMS; the frozen material is not read) rendered in process to HTML and DOCX.
//   (a) derivation lines silently cut at 54 characters (engine/bind/derivation.ts monoLine);
//   (b) case 01 Table 3.1 wider than the 166 mm span (a spanning total cell kept on one line), and the refusal of a
//       table that truly cannot fit (FIGURE_OVER_CAPACITY, figure "table", DT-10a);
//   (c) derivation titles renumbered by the engine ("Turunan D-4.2" printed as D-4.1, B-FIX "F-1.1" as D-1.1).
// FIDELITY (src/mcp-host/verify/fidelity.ts, unchanged) is the oracle for (a) and (c). OVERLAP_CLIP needs the real
// render bridge (Electron); it runs on case 01 in test/verify-row143a/row143a-cases-e2e.test.ts (opt-in).
import { describe, expect, test } from "bun:test"
import type { NormDocSnapshot } from "../../../vendor/src/lib/studio/contract"
import { StudioEngineError } from "../../../vendor/src/lib/studio/contract/errors"
import { checkDocxFidelity, checkHtmlFidelity, fidelityExpectationFromSnapshot, normalizeFidelityText } from "../../../src/mcp-host/verify/fidelity"

const K = await import("./_kit")
const { DERIVATION_DEFAULT_WIDTH, DERIVATION_VALUE_WIDTH, derivationTitleId, monoLine, wrapMonoCp } = await import("../../../vendor/src/lib/studio/engine/bind")
const { assertTableFits, tableMinWidthMm, tableSpanLimitMm } = await import("../../../vendor/src/lib/studio/engine/table-fit")

const W = DERIVATION_DEFAULT_WIDTH
const FULL = DERIVATION_DEFAULT_WIDTH + DERIVATION_VALUE_WIDTH
const cps = (s: string) => Array.from(s).length
const squash = (s: string) => s.replace(/\s+/g, "")
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x))

/** Plain text of the HTML (tags dropped, entities for the characters used here decoded). */
function htmlText(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&#160;|&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
}
function docxText(docx: Uint8Array): string {
  return K.docXml(docx)
    .replace(/<w:br\/>/g, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
}
/** HTML of one derivation block (by its data-derivation-id). */
function derivationHtml(html: string, id: string): string {
  const at = html.indexOf(`data-derivation-id="${id}"`)
  if (at < 0) throw new Error(`no derivation ${id}`)
  return html.slice(at, html.indexOf("st-derivation-note", at))
}
const findingsOf = (c: { findings: Array<{ code: string; address: string | null; detail: string }> }) => c.findings.map((f) => `${f.code} ${f.address} ${f.detail}`)

async function renderBoth(doc: Record<string, any>): Promise<{ snap: NormDocSnapshot; html: string; docx: Uint8Array }> {
  const snap = K.compose(doc)
  return { snap, html: await K.renderHtml(snap), docx: await K.renderDocx(snap) }
}

// ── (a) derivation lines are wrapped, never cut ──────────────────────────────────────────────────────────────────

describe("(a) derivation mono lines keep every character", () => {
  test("monoLine: a label within 54 gives the Python line byte for byte (54 + 18)", () => {
    const l = monoLine("nilai basis", "Rp 1.250.000")
    expect(l).toBe("nilai basis".padEnd(W) + "Rp 1.250.000".padStart(DERIVATION_VALUE_WIDTH))
    expect(cps(l)).toBe(FULL)
    expect(l.includes("\n")).toBe(false)
  })

  test("monoLine: a label-only line of 55..72 code points stays one line, uncut (case 01 5.1.2, case 05 4.2.1)", () => {
    const label = "Sensor ruang              48 × 1,2 W   =    57,6  W   [PEMASOK B2]"
    expect(cps(label)).toBeGreaterThan(W)
    const l = monoLine(label, "")
    expect(l.includes("\n")).toBe(false)
    expect(l.trimEnd()).toBe(label)
    expect(cps(l)).toBe(FULL)
  })

  test("monoLine: longer labels wrap at a space; the value stays right-aligned on the last line; nothing is lost", () => {
    const label = "Kebutuhan daya total untuk seluruh perangkat ruang simpan dan gerbang data bersama cadangan dua puluh lima persen"
    const l = monoLine(label, "684,2 VA")
    const lines = l.split("\n")
    expect(lines.length).toBeGreaterThan(1)
    for (const x of lines.slice(0, -1)) expect(cps(x)).toBeLessThanOrEqual(W)
    expect(lines[lines.length - 1].endsWith("684,2 VA")).toBe(true)
    expect(cps(lines[lines.length - 1])).toBe(FULL)
    expect(squash(l)).toBe(squash(label + "684,2 VA"))
    // Label only, > 72: wraps at the full line.
    const only = monoLine(label + " " + label, "")
    for (const x of only.split("\n")) expect(cps(x)).toBeLessThanOrEqual(FULL)
    expect(squash(only)).toBe(squash(label + label))
  })

  test("wrapMonoCp: a word longer than the width is split, not dropped", () => {
    const word = "X".repeat(130)
    const parts = wrapMonoCp(word, 54)
    expect(parts.map(cps)).toEqual([54, 54, 22])
    expect(parts.join("")).toBe(word)
  })

  test("case 01 and case 05 derivations: every submitted line is in the HTML and the DOCX; FIDELITY PASS (whole document)", async () => {
    for (const [name, id] of [["case01.json", "Turunan D-5.1"], ["case05.json", "Turunan D-4.2"]] as const) {
      const doc = K.loadCase(name)
      const { snap, html, docx } = await renderBoth(doc)
      const exp = fidelityExpectationFromSnapshot(snap)
      const [{ block }] = K.blocksOfType(doc, "derivation")
      const block2 = derivationHtml(html, id)
      const hText = normalizeFidelityText(htmlText(block2))
      const dText = normalizeFidelityText(docxText(docx))
      for (const ln of block.lines) {
        const want = normalizeFidelityText(ln.label.text)
        expect({ name, line: want, html: hText.includes(want) }).toEqual({ name, line: want, html: true })
        expect({ name, line: want, docx: dText.includes(want) }).toEqual({ name, line: want, docx: true })
      }
      const h = checkHtmlFidelity(html, exp)
      const d = checkDocxFidelity(docx, exp)
      expect({ name, html: h.status, findings: findingsOf(h) }).toEqual({ name, html: "PASS", findings: [] })
      expect({ name, docx: d.status, findings: findingsOf(d) }).toEqual({ name, docx: "PASS", findings: [] })
    }
  }, 60_000)

  test("a long derivation line (label + value, 120+ characters) keeps every character in HTML and DOCX and wraps; FIDELITY PASS", async () => {
    const doc = clone(K.loadCase("case01.json"))
    const [{ block }] = K.blocksOfType(doc, "derivation")
    const long = "Energi baterai terpasang pada dua blok baterai VRLA 12 V 9 Ah di rak UPS ruang server, dikurangi rugi inverter dan kedalaman lepas muatan"
    block.lines.push({ label: { text: long }, value: { registerKey: "energi_baterai" } })
    const { snap, html, docx } = await renderBoth(doc)
    const part = derivationHtml(html, "Turunan D-5.1")
    // The wrapped row is one span whose text holds a line break per continuation (white-space:pre container).
    const row = [...part.matchAll(/<span class="st-derivation-line st-derivation-line"[^>]*>([^<]*)/g)].map((m) => m[1]).find((t) => t.includes("Energi baterai terpasang"))!
    expect(row.split("\n").length).toBeGreaterThan(2)
    for (const x of row.split("\n")) expect(cps(x)).toBeLessThanOrEqual(FULL)
    expect(squash(row)).toBe(squash(`${long}216,0 Wh`))
    const xml = K.docXml(docx)
    expect(xml.includes("<w:r><w:br/></w:r>")).toBe(true)
    expect(squash(normalizeFidelityText(docxText(docx))).includes(squash(long))).toBe(true)
    const exp = fidelityExpectationFromSnapshot(snap)
    expect(findingsOf(checkHtmlFidelity(html, exp))).toEqual([])
    expect(findingsOf(checkDocxFidelity(docx, exp))).toEqual([])
  }, 60_000)
})

// ── (b) tables fit the 166 mm span, or are refused ───────────────────────────────────────────────────────────────

describe("(b) tables fit the 166 mm span (DT-10a) or are refused with FIGURE_OVER_CAPACITY", () => {
  test("case 01 Table 3.1: the spanning total label wraps (no white-space:pre); numeral/id cells stay unbroken; lower bound within 166 mm", async () => {
    const doc = K.loadCase("case01.json")
    const { html } = await renderBoth(doc)
    const at = html.indexOf('data-label="Tabel 3.1"')
    expect(at).toBeGreaterThan(0)
    const table = html.slice(at, html.indexOf("</table>", at))
    const total = /<td colspan="2"[^>]*><p style="([^"]*)">Jumlah titik sensor, empat ruang/.exec(table)
    expect(total).not.toBeNull()
    expect(total![1].includes("white-space:pre;")).toBe(false)
    expect(/white-space:pre"?$/.test(total![1])).toBe(false)
    // A single-column numeral cell keeps its nowrap.
    expect(/white-space:pre">520,0</.test(table)).toBe(true)
    const t = K.blocksOfType(doc, "table").find((x) => JSON.stringify(x.block).includes("Jumlah titik sensor"))!.block
    const tpl = await K.template()
    const m = tableMinWidthMm(t as never, tpl.params)
    expect(tableSpanLimitMm(tpl.params)).toBe(166)
    expect(m.minMm).toBeLessThan(166)
    expect(() => assertTableFits(t as never, tpl.params)).not.toThrow()
  }, 60_000)

  test("a table whose unbreakable numerals alone exceed 166 mm is refused in HTML and DOCX (code, details, suggestion)", async () => {
    const doc = clone(K.loadCase("case01.json"))
    const [{ block: tbl }] = K.blocksOfType(doc, "table").filter((x) => JSON.stringify(x.block).includes("Jumlah titik sensor"))
    const n = 9
    tbl.columns = [{ role: "id" }, ...Array.from({ length: n }, () => ({ role: "numeral" }))]
    tbl.rows = [
      { kind: "header", cells: [{ text: "Ruang" }, ...Array.from({ length: n }, (_, i) => ({ text: `K${i + 1} (Rp)` }))] },
      { kind: "body", cells: [{ text: "R1" }, ...Array.from({ length: n }, () => ({ text: "1.234.567.890.123" }))] },
    ]
    const snap = K.compose(doc)
    for (const [fmt, run] of [["html", () => K.renderHtml(snap)], ["docx", () => K.renderDocx(snap)]] as const) {
      let err: unknown
      try {
        await run()
      } catch (e) {
        err = e
      }
      expect(err instanceof StudioEngineError).toBe(true)
      // The HTML assembler wraps every block renderer error as HTML_RENDER_FAILED with `details.causeCode` and the
      // original error as `cause` (html/assemble/index.ts:105-127, as for a derivation's BY_CONSTRUCTION_FAILED); the
      // DOCX path throws the refusal itself.
      const top = err as StudioEngineError & { details: Record<string, unknown>; cause?: unknown }
      if (fmt === "html") {
        expect(top.code).toBe("HTML_RENDER_FAILED")
        expect(top.details.causeCode).toBe("FIGURE_OVER_CAPACITY")
        expect(top.message).toContain("; saran:")
      }
      const e = (fmt === "html" ? top.cause : top) as StudioEngineError & { details: Record<string, unknown> }
      expect({ fmt, code: e.code }).toEqual({ fmt, code: "FIGURE_OVER_CAPACITY" })
      expect(e.details.figure).toBe("table")
      expect(e.details.checkId).toBe("DT-10a")
      expect(e.details.unit).toBe("mm")
      expect(e.details.limit).toBe(166)
      expect(Number(e.details.measured)).toBeGreaterThan(166)
      expect(String(e.details.suggestion)).toContain("pecah tabel")
      expect(e.message).toContain("Tabel 3.1")
      expect(e.message).toContain("; saran:")
    }
  }, 60_000)

  test("the lower bound never refuses the Rev A material's tables (cases 01 and 05, all tables)", async () => {
    const tpl = await K.template()
    for (const name of ["case01.json", "case05.json"] as const) {
      for (const { block } of K.blocksOfType(K.loadCase(name), "table")) {
        expect(tableMinWidthMm(block as never, tpl.params).minMm).toBeLessThan(166)
      }
    }
  })
})

// ── (c) derivation titles keep their own label ───────────────────────────────────────────────────────────────────

describe("(c) a derivation title's own label is kept (Manual Rev A ID p.40)", () => {
  test("derivationTitleId reads the label form of p.40 and the engine form; plain titles have none", () => {
    expect(derivationTitleId("Turunan D-4.2 · Panjang kabel dan batas bus")).toBe("D-4.2")
    expect(derivationTitleId("Turunan F-1.1 · Nilai fiksur")).toBe("F-1.1")
    expect(derivationTitleId("Turunan 7.5a · Kapasitas simpan rekaman CCTV")).toBe("7.5a")
    expect(derivationTitleId("Derivation D-2.3: storage")).toBe("D-2.3")
    expect(derivationTitleId("Beban puncak perangkat")).toBeUndefined()
    expect(derivationTitleId("Turunan beban 2026")).toBeUndefined()
    expect(derivationTitleId(undefined)).toBeUndefined()
  })

  test("case 05 prints Turunan D-4.2 (its register entries cite D-4.2), B-FIX prints Turunan F-1.1, case 01 D-5.1; HTML and DOCX; FIDELITY PASS", async () => {
    for (const [name, want] of [["case05.json", "Turunan D-4.2 · Panjang kabel dan batas bus"], ["bfix-datum-kanonik-ID.studio.json", "Turunan F-1.1 · Nilai fiksur"], ["case01.json", "Turunan D-5.1 · Beban puncak dan otonomi UPS"]] as const) {
      const doc = K.loadCase(name)
      const { snap, html, docx } = await renderBoth(doc)
      expect({ name, html: normalizeFidelityText(htmlText(html)).includes(want) }).toEqual({ name, html: true })
      expect({ name, docx: normalizeFidelityText(docxText(docx)).includes(want) }).toEqual({ name, docx: true })
      const exp = fidelityExpectationFromSnapshot(snap)
      expect({ name, html: findingsOf(checkHtmlFidelity(html, exp)) }).toEqual({ name, html: [] })
      expect({ name, docx: findingsOf(checkDocxFidelity(docx, exp)) }).toEqual({ name, docx: [] })
    }
    const reg = K.loadCase("case05.json").register as Record<string, { src?: string }>
    expect(Object.values(reg).some((e) => String(e.src ?? "").startsWith("D-4.2"))).toBe(true)
  }, 60_000)

  test("an unlabelled derivation is still numbered D-C.n by the engine", async () => {
    const doc = clone(K.loadCase("case05.json"))
    const [{ block }] = K.blocksOfType(doc, "derivation")
    block.title = { text: "Panjang kabel dan batas bus" }
    const { html, docx } = await renderBoth(doc)
    const want = "Turunan D-4.1 · Panjang kabel dan batas bus"
    expect(normalizeFidelityText(htmlText(html)).includes(want)).toBe(true)
    expect(normalizeFidelityText(docxText(docx)).includes(want)).toBe(true)
  }, 60_000)
})
