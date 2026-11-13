// Swarm 1.2.7 row 40d (AC-N11, M2-01 / M2-08, decision C50): the ID-list break (HTML <wbr>, DOCX U+200B) is made
// only in a token that would otherwise overflow its column, the case DT-10a refused before row 40. It is never made
// in a URL (row 40b), a house-style document number (NNN/XXX/.../<roman month>/YYYY) or a path-like token: U+200B
// inside those travels with copy-paste out of Word and defeats Word's Find. The DT-10a estimate follows the same rule
// (a token that cannot break counts unbroken). The DT-10a suggestion is built from TABLE_BREAK_AFTER /
// TABLE_BREAK_MIN_CHARS. Synthetic inputs only (the document number is invented); rendered in process through the
// row 143a kit (case01 table replaced), no browser, no store.
import { describe, expect, test } from "bun:test"
import { useStudioEnv } from "../ported/_env"

// Own env scope (row 40c): the row 143a kit sets the Studio env once per process.
useStudioEnv()
const K = await import("../engine-rev-a/row143a/_kit")
const fit = await import("../../vendor/src/lib/studio/engine/table-fit")
const writeClient = await import("../../vendor/scripts/studio/mcp/write-client")

type Rec = Record<string, any>
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x))
const block = (rows: string[][]): Rec =>
  writeClient.tableBlock(rows, "Tabel berkas sintetis", "Sumber sintetis uji.", null, () => {}, "uji", "Bab uji", () => {}) as Rec
function docWith(columns: unknown, rows: unknown): Rec {
  const doc = clone(K.loadCase("case01.json"))
  const [{ block: tbl }] = K.blocksOfType(doc, "table").filter((x) => JSON.stringify(x.block).includes("Jumlah titik sensor"))
  tbl.columns = columns
  tbl.rows = rows
  return doc
}
async function render(columns: unknown, rows: unknown): Promise<{ html: string; xml: string }> {
  const snap = K.compose(docWith(columns, rows))
  return { html: await K.renderHtml(snap), xml: K.docXml(await K.renderDocx(snap)) }
}
const caught = (f: () => void): Rec | null => {
  try {
    f()
    return null
  } catch (e) {
    return e as Rec
  }
}
const count = (s: string, needle: string): number => s.split(needle).length - 1
const ZW = "\u200B"
const ids = (n: number): string => Array.from({ length: n }, (_, i) => `R-${String(i + 1).padStart(2, "0")}`).join("/")

const DOC_NO = "002/UJI/NT/XI/2026" // synthetic, house-style shape
const PATH = "packages/datum-studio/src/a.ts"
const FIT_LIST = ids(5) // 24 characters: fits its column, so no break
const LONG_LIST = ids(40) // 199 characters: wider than the 166 mm span, so it must break

describe("rel127 N-11d: break only a token that overflows its column; never a document number or a path", () => {
  test("token shapes: document number and path-like are recognised; ID lists and joined words are not", () => {
    for (const d of [DOC_NO, "117/GSP-DIR/SPH/IV/2025", "(002/UJI/NT/XI/2026),", "009/uji/nt/xii/2026"]) {
      expect({ d, docNo: fit.isDocumentNumberToken(d) }).toEqual({ d, docNo: true })
    }
    for (const p of [PATH, "/var/lib/studio/out.docx", "./a/b/c/d/e.md", "C:\\data\\uji\\berkas.xlsx", "~/uji/a/b"]) {
      expect({ p, path: fit.isPathToken(p) }).toEqual({ p, path: true })
    }
    for (const w of [FIT_LIST, LONG_LIST, "pengadaan/pemeliharaan", "A1,B2,C3,D4,E5,F6;", "002/UJI/NT/XIII/2026"]) {
      expect({ w, docNo: fit.isDocumentNumberToken(w), path: fit.isPathToken(w) }).toEqual({ w, docNo: false, path: false })
    }
  })

  test("breakableSegments: shape exclusions stay whole at any width; an ID list breaks only past its budget", () => {
    expect(fit.breakableSegments(DOC_NO)).toEqual([DOC_NO])
    expect(fit.breakableSegments(PATH)).toEqual([PATH])
    // No budget given (0 mm): the ID list has no room and splits, as rows 40 / 40b specify.
    expect(fit.breakableSegments(FIT_LIST)).toEqual(["R-01/", "R-02/", "R-03/", "R-04/", "R-05"])
    const w = fit.tableTokenMm(FIT_LIST)
    expect(fit.breakableSegments(FIT_LIST, w)).toEqual([FIT_LIST])
    expect(fit.breakableSegments(FIT_LIST, w - 0.01)).toEqual(["R-01/", "R-02/", "R-03/", "R-04/", "R-05"])
    expect(fit.tableBreakRuns([{ t: `${DOC_NO} ${PATH}` }], ZW)).toBeNull()
    expect(fit.tableBreakRuns([{ t: FIT_LIST }], ZW, 100)).toBeNull()
  })

  test("DT-10a estimate is honest: a document number and a path count unbroken; the fitting table is not refused", () => {
    const b = block([["Nomor", "Berkas", "Kode"], [DOC_NO, PATH, FIT_LIST], ["uji", "uji", LONG_LIST]])
    const m = fit.tableMinWidthMm(b as never, {})
    expect(m.columnsMm[0]).toBeCloseTo(fit.tableTokenMm(DOC_NO), 6)
    expect(m.columnsMm[1]).toBeCloseTo(fit.tableTokenMm(PATH), 6)
    // Column 3: the long list breaks (it overflows), the 24-character list fits and counts whole.
    expect(m.columnsMm[2]).toBeCloseTo(fit.tableTokenMm(FIT_LIST), 6)
    expect(caught(() => fit.assertTableFits(b as never, {}, { label: "Tabel uji" }))).toBeNull()
  })

  test("DOCX: document number, path and a fitting list carry no U+200B; the overflowing list still breaks", async () => {
    const b = block([["Nomor", "Berkas", "Kode"], [DOC_NO, PATH, FIT_LIST], ["uji", "uji", LONG_LIST]])
    const { html, xml } = await render(b.columns, b.rows)
    for (const tok of [DOC_NO, PATH, FIT_LIST]) {
      expect({ tok, inXml: xml.includes(tok) }).toEqual({ tok, inXml: true })
      expect({ tok, inHtml: html.includes(tok) }).toEqual({ tok, inHtml: true })
    }
    // Only the 199-character list breaks: 39 separators, each mark right after one.
    expect(count(xml, ZW)).toBe(39)
    expect(count(xml, ZW)).toBe(count(xml, `/${ZW}`))
    expect(count(html, "<wbr>")).toBe(39)
    expect(count(html, "<wbr>")).toBe(count(html, "/<wbr>"))
  }, 60_000)

  test("a table that fit before row 40 renders byte-free of breaks: a short table of fitting lists gets none", async () => {
    const b = block([["Kode A", "Kode B"], [FIT_LIST, ids(8)]])
    const { html, xml } = await render(b.columns, b.rows)
    expect(count(xml, ZW)).toBe(0)
    expect(count(html, "<wbr>")).toBe(0)
  }, 60_000)

  test("M2-08: the DT-10a suggestion is built from TABLE_BREAK_AFTER and TABLE_BREAK_MIN_CHARS", () => {
    const tok = "R".repeat(60)
    const e = caught(() => fit.assertTableFits(block([["A", "B", "C"], [tok, tok, tok]]) as never, {}, { label: "Tabel uji" }))
    const s = String(e?.details?.suggestion)
    expect(s).toContain(`dipatah setelah ${fit.TABLE_BREAK_AFTER.join(" ")} bila lebih dari ${fit.TABLE_BREAK_MIN_CHARS} karakter`)
    expect(fit.tableBreakSuggestion()).toBe(s.slice(s.indexOf("daftar ID")))
  })
})
