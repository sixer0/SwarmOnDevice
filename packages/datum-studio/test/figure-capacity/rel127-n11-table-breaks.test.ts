// Swarm 1.2.7 row 40 (AC-N11, N7-108; C12 O-6): DT-10a counts the break opportunities inside long ID lists joined
// without spaces. A compact 3-column table whose cells are `R-01/.../R-12` (studio_write infers `text` columns) was
// refused at 201.7 mm; it now fits, and both renderers make the breaks the estimate counts: HTML `<wbr>`, DOCX U+200B
// after every separator, never inside an ID. Synthetic fixture syn127/n11_id_list_table.json; the table is rendered
// in process through the row 143a kit (case01 table replaced), no browser, no store.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

const K = await import("../engine-rev-a/row143a/_kit")
const fit = await import("../../vendor/src/lib/studio/engine/table-fit")
const writeClient = await import("../../vendor/scripts/studio/mcp/write-client")

type Rec = Record<string, any>
const FX = JSON.parse(readFileSync(path.join(import.meta.dir, "..", "fixtures", "syn127", "n11_id_list_table.json"), "utf8")) as {
  caption: string
  source: string
  variants: Record<string, string[][]>
}
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x))
const block = (rows: string[][]): Rec => writeClient.tableBlock(rows, FX.caption, FX.source, null, () => {}, "uji", "Bab uji", () => {}) as Rec
const caught = (f: () => void): Rec | null => {
  try {
    f()
    return null
  } catch (e) {
    return e as Rec
  }
}

/** case01 with its "Jumlah titik sensor" table replaced by `columns` / `rows`. */
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
const count = (s: string, needle: string): number => s.split(needle).length - 1

describe("rel127 N-11: long ID lists joined without spaces break after separators", () => {
  for (const [name, rows] of Object.entries(FX.variants)) {
    const sep = name === "slash" ? "/" : name === "comma" ? "," : ";"
    const cell = rows[1][0]
    const ids = cell.split(sep)
    const cells = rows.slice(1).flat().length

    test(`${name}: minMm <= 166 and DT-10a does not refuse`, async () => {
      const b = block(rows)
      const tpl = await K.template()
      for (const params of [{}, tpl.params]) {
        const m = fit.tableMinWidthMm(b as never, params)
        expect({ name, minMm: Math.round(m.minMm * 10) / 10, fits: m.minMm <= 166 }).toMatchObject({ name, fits: true })
        expect(caught(() => fit.assertTableFits(b as never, params, { label: "Tabel uji" }))).toBeNull()
      }
    })

    test(`${name}: HTML has <wbr> and DOCX has U+200B after every separator, never inside an ID`, async () => {
      const b = block(rows)
      const { html, xml } = await render(b.columns, b.rows)
      const htmlCell = ids.join(`${sep}<wbr>`)
      const docxCell = ids.join(`${sep}​`)
      expect(count(html, htmlCell)).toBe(cells)
      expect(count(xml, docxCell)).toBe(cells)
      // No break inside an ID: every <wbr> / U+200B follows a separator.
      expect(count(html, "<wbr>")).toBe(count(html, `${sep}<wbr>`))
      expect(count(xml, "​")).toBe(count(xml, `${sep}​`))
      expect(count(xml, "​")).toBe(cells * (ids.length - 1))
    }, 60_000)
  }

  test("breakableSegments: separator kept on the left; 16 characters or fewer stay whole", () => {
    expect(fit.TABLE_BREAK_MIN_CHARS).toBe(16)
    expect([...fit.TABLE_BREAK_AFTER]).toEqual([",", ";", "/"])
    expect(fit.breakableSegments("R-01/R-02/R-03/R-04")).toEqual(["R-01/", "R-02/", "R-03/", "R-04"])
    expect(fit.breakableSegments("R-01/R-02/R-03/R")).toEqual(["R-01/R-02/R-03/R"])
    expect(fit.breakableSegments("A1,B2,C3,D4,E5,F6;")).toEqual(["A1,", "B2,", "C3,", "D4,", "E5,", "F6;"])
  })

  test("CHAR (a): a 60-character token with no separator in 3 columns is still refused DT-10a", () => {
    const tok = "R".repeat(60)
    const e = caught(() => fit.assertTableFits(block([["Kode A", "Kode B", "Kode C"], [tok, tok, tok]]) as never, {}, { label: "Tabel uji" }))
    expect(e?.code).toBe("FIGURE_OVER_CAPACITY")
    expect(e?.details?.checkId).toBe("DT-10a")
  })

  test("the DT-10a suggestion names the ID-list break rule", () => {
    const tok = "R".repeat(60)
    const e = caught(() => fit.assertTableFits(block([["Kode A", "Kode B", "Kode C"], [tok, tok, tok]]) as never, {}, { label: "Tabel uji" }))
    expect(String(e?.details?.suggestion)).toContain("daftar ID tanpa spasi dipatah setelah , ; / bila lebih dari 16 karakter")
  })

  test("CHAR (b): short tokens (R-01/R-02, 9 characters) render with no <wbr> and no U+200B", async () => {
    const b = block([["Kode A", "Kode B", "Kode C"], ["R-01/R-02", "R-03/R-04", "R-05/R-06"]])
    const { html, xml } = await render(b.columns, b.rows)
    expect(html).toContain("R-01/R-02")
    expect(count(html, "<wbr>")).toBe(0)
    expect(count(xml, "​")).toBe(0)
  }, 60_000)

  test("CHAR (c): an id-role column with a long list keeps its nowrap width and gets no break", async () => {
    const list = FX.variants.slash[1][0]
    const columns = [{ role: "id" }, { role: "text" }]
    const rows = [
      { kind: "header", cells: [{ text: "Kode" }, { text: "Butir" }] },
      { kind: "body", cells: [{ text: list }, { text: "butir uji" }] },
    ]
    const m = fit.tableMinWidthMm({ columns, rows } as never, {})
    expect(m.columnsMm[0]).toBeCloseTo(Array.from(list).length * 0.6 * 7.8 * (25.4 / 72), 6)
    const { html, xml } = await render(columns, rows)
    expect(html).toContain(list)
    expect(count(html, "<wbr>")).toBe(0)
    expect(count(xml, "​")).toBe(0)
  }, 60_000)
})
