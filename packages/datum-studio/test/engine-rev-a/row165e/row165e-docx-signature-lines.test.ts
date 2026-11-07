// Wave 165 row 165E (decision C193 ruling 4, F113-4 DOCX half): the DOCX signature block prints one signature line
// per column - three separate lines with a gap between them - not one continuous line across the 166 mm span.
// Before: the holder row carried a `w:tcBorders/w:top` on every cell, and adjacent cell borders join into one line.
// After: the line is the holder paragraph's own top border (`w:pBdr/w:top`), which spans only the paragraph's width
// (cell width minus the right cell margin), so each column has its own line and the columns' gutters stay blank.
// Material: the row 143a adapted case 01 / case 05 through the row 165A kit (datum-kanonik template), in process.
import { describe, expect, test } from "bun:test"
import { useStudioEnv } from "../../ported/_env"

// The kit module is cached across files; another file's afterAll may have restored the env, so set it here too.
useStudioEnv()
const K = await import("../row165a/_kit")

const doc01 = K.docXml(await K.renderDocx(K.compose(K.loadCase("case01.json"))))
const doc05 = K.docXml(await K.renderDocx(K.compose(K.loadCase("case05.json"))))

/** The DOCX signature table: the first table whose first row reads Penyusun / Diperiksa / Disetujui. */
function signatureTable(xml: string): string {
  for (const t of xml.match(/<w:tbl>[\s\S]*?<\/w:tbl>/g) ?? []) {
    const first = t.match(/<w:tr\b[\s\S]*?<\/w:tr>/)?.[0] ?? ""
    const texts = (first.match(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g) ?? []).map((x) => x.replace(/<[^>]+>/g, "")).join(" ")
    if (texts === "Penyusun Diperiksa Disetujui") return t
  }
  return ""
}

describe("row 165E: DOCX signature block, one line per column", () => {
  for (const [name, xml] of [
    ["case01", doc01],
    ["case05", doc05],
  ] as const) {
    test(`${name}: three holder cells, each with its own paragraph top line; no cell top border joins them`, () => {
      const tbl = signatureTable(xml)
      expect(tbl).not.toBe("")
      const rows = tbl.match(/<w:tr\b[\s\S]*?<\/w:tr>/g) ?? []
      expect(rows.length).toBeGreaterThanOrEqual(3)
      const holder = rows[2]
      const cells = holder.match(/<w:tc>[\s\S]*?<\/w:tc>/g) ?? []
      expect(cells).toHaveLength(3)
      for (const cell of cells) {
        // No cell-level top border: a cell border spans the whole cell and meets the next cell's border.
        expect(cell).not.toMatch(/<w:tcBorders>[\s\S]*?<w:top w:val="single"/)
        // The line is the paragraph's own top border, inside the cell's text area.
        expect(cell).toMatch(/<w:pBdr><w:top w:val="single" w:sz="5" w:space="1" w:color="[0-9A-F]{6}"\/><\/w:pBdr>/)
        // A right cell margin keeps a gap between this column's line and the next one.
        const right = Number(cell.match(/<w:tcMar>[\s\S]*?<w:right w:w="(\d+)"/)?.[1] ?? "0")
        expect(right).toBeGreaterThan(0)
      }
      // No other row of the signature table carries a joined line either.
      expect((tbl.match(/<w:tcBorders>[\s\S]*?<w:top w:val="single"[\s\S]*?<\/w:tcBorders>/g) ?? []).length).toBe(0)
    })
  }
})
