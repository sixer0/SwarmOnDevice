// Swarm 1.2.8 row 36 (AC-HN11, H-N11, register N8-384; ledger class PROBE). The 1.2.7 audit measured the comma
// break path only (U+200B after commas) and had no sample for `;` and `/` (handoff 2026-11-13 §1, row N-11). This
// probe measures the two separators against the comma on the same samples: `a;b;c` / `x/y/z` (short), 40-character
// tokens (breakableSegments, no column budget) and rendered table cells (HTML <wbr>, DOCX U+200B) whose lists
// overflow their column. A cell must break after `;` and `/` exactly where it breaks after `,`. Synthetic inputs
// only; rendered in process through the row 143a kit (case01 table replaced), no browser, no store.
import { describe, expect, test } from "bun:test"
import { useStudioEnv } from "../ported/_env"

useStudioEnv()
const K = await import("../engine-rev-a/row143a/_kit")
const fit = await import("../../vendor/src/lib/studio/engine/table-fit")
const writeClient = await import("../../vendor/scripts/studio/mcp/write-client")

type Rec = Record<string, any>
const SEPS = [",", ";", "/"] as const
const ZW = "​"
const WORDS = ["alfa", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet", "kilo", "lima"]
const count = (s: string, needle: string): number => s.split(needle).length - 1
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x))

/** The shortest run of WORDS joined by `sep` that is at least `min` characters long, and its words. */
function token(sep: string, min: number): { tok: string; words: string[] } {
  const words: string[] = []
  for (let i = 0; words.join(sep).length < min; i++) words.push(`${WORDS[i % WORDS.length]}${Math.floor(i / WORDS.length) || ""}`)
  return { tok: words.join(sep), words }
}
const expected = (words: string[], sep: string): string[] => words.map((w, i) => (i < words.length - 1 ? `${w}${sep}` : w))

const block = (rows: string[][]): Rec =>
  writeClient.tableBlock(rows, "Tabel pemisah sintetis", "Sumber sintetis uji.", null, () => {}, "uji", "Bab uji", () => {}) as Rec
function docWith(columns: unknown, rows: unknown): Rec {
  const doc = clone(K.loadCase("case01.json"))
  const [{ block: tbl }] = K.blocksOfType(doc, "table").filter((x) => JSON.stringify(x.block).includes("Jumlah titik sensor"))
  tbl.columns = columns
  tbl.rows = rows
  return doc
}
async function render(rows: string[][]): Promise<{ html: string; xml: string }> {
  const b = block(rows)
  const snap = K.compose(docWith(b.columns, b.rows))
  return { html: await K.renderHtml(snap), xml: K.docXml(await K.renderDocx(snap)) }
}

describe("rel128 probe H-N11: a cell breaks after `;` and `/` like after `,`", () => {
  test("the separator set holds all three", () => {
    expect([...fit.TABLE_BREAK_AFTER].sort()).toEqual([...SEPS].sort())
  })

  test("short samples a;b;c and x/y/z stay whole, exactly like a,b,c (16 characters or fewer)", () => {
    for (const s of ["a,b,c", "a;b;c", "x/y/z", "x,y,z"]) expect({ s, seg: fit.breakableSegments(s) }).toEqual({ s, seg: [s] })
  })

  for (const sep of SEPS) {
    test(`40-character token joined by '${sep}': one segment per word, separator kept on the left`, () => {
      const { tok, words } = token(sep, 40)
      expect(tok.length).toBeGreaterThanOrEqual(40)
      expect(fit.isUrlToken(tok) || fit.isDocumentNumberToken(tok) || fit.isPathToken(tok)).toBe(false)
      expect(fit.breakableSegments(tok)).toEqual(expected(words, sep))
    })

    test(`single-letter list '${sep}' of 39 characters breaks after every '${sep}'`, () => {
      const letters = "abcdefghijklmnopqrst".split("")
      const tok = letters.join(sep)
      expect(tok.length).toBe(39)
      expect(fit.breakableSegments(tok)).toEqual(expected(letters, sep))
    })
  }

  test("the three separators give the same segment count on the same words", () => {
    const n = SEPS.map((sep) => fit.breakableSegments(token(sep, 40).tok).length)
    expect(new Set(n).size).toBe(1)
  })

  test("render: overflowing cells break after every ',' ';' '/' (HTML <wbr>, DOCX U+200B), never inside a word", async () => {
    const cells = SEPS.map((sep) => token(sep, 200))
    const { html, xml } = await render([["Koma", "Titik koma", "Garis miring"], cells.map((c) => c.tok)])
    for (const [i, sep] of SEPS.entries()) {
      const { words } = cells[i]
      expect({ sep, docx: count(xml, words.join(`${sep}${ZW}`)) }).toEqual({ sep, docx: 1 })
      expect({ sep, html: count(html, words.join(`${sep}<wbr>`)) }).toEqual({ sep, html: 1 })
    }
    const marks = SEPS.reduce((n, sep) => n + count(xml, `${sep}${ZW}`), 0)
    expect(count(xml, ZW)).toBe(marks)
    expect(count(xml, ZW)).toBe(cells.reduce((n, c) => n + c.words.length - 1, 0))
    expect(count(html, "<wbr>")).toBe(SEPS.reduce((n, sep) => n + count(html, `${sep}<wbr>`), 0))
  }, 60_000)
})
