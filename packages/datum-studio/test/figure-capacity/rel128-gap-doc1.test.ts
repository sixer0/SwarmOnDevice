// Swarm 1.2.8 row 36 (AC-DOC1, DOC-1, register N8-383; ledger class PROBE). The 1.2.7 audit noted that U+200B
// travels out of a DOCX with copy-paste and that the extracted text was never measured (handoff 2026-11-13 §1, rows
// W-16/DOC1). This probe renders a table with long tokens (table-fit.ts:55-105 inserts the break hints), extracts
// the DOCX text the way a reader copies it (every `w:t` of word/document.xml, joined) and records the U+200B count:
//   - the only U+200B are the break hints of the ID list that overflows its column, each right after `,` `;` `/`;
//   - none inside a URL, a document number, a path, a fitting list or plain words;
//   - removing them gives back the source text exactly (they add no visible character);
//   - Studio's own FIDELITY check drops them (fidelity.ts transform step 2), so its verdict is not disturbed.
// Spec acceptance (01_specs.md AC-DOC1): 0 U+200B, OR the count recorded and ruled intended (C-decision). The
// count pinned here is the rule of 1.2.7 rows 40/40b/40d (C12 O-6, C39, C50). Synthetic inputs only; rendered in
// process through the row 143a kit (case01 table replaced), no browser, no store.
import { describe, expect, test } from "bun:test"
import { useStudioEnv } from "../ported/_env"

useStudioEnv()
const K = await import("../engine-rev-a/row143a/_kit")
const writeClient = await import("../../vendor/scripts/studio/mcp/write-client")
const { checkDocxFidelity, fidelityExpectationFromSnapshot, normalizeFidelityText } = await import("../../src/mcp-host/verify/fidelity")

type Rec = Record<string, any>
const ZW = "​"
const count = (s: string, needle: string): number => s.split(needle).length - 1
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x))
const ids = (n: number, sep = "/"): string => Array.from({ length: n }, (_, i) => `R-${String(i + 1).padStart(2, "0")}`).join(sep)

const LONG = ids(40) // 199 characters, wider than the 166 mm span: must break (39 separators)
const LONG_SEMI = ids(30, ";") // 149 characters
const URL = "https://contoh.example.org/arsip/2026/laporan/lampiran-uji-alfa-bravo-charlie"
const DOC_NO = "002/UJI/NT/XI/2026"
const PATH = "arsip/uji/lampiran/berkas-alfa.docx"
const FIT = ids(5) // 24 characters: fits its column, no break
const PLAIN = "alfa bravo charlie delta echo"

const block = (rows: string[][]): Rec =>
  writeClient.tableBlock(rows, "Tabel token panjang sintetis", "Sumber sintetis uji.", null, () => {}, "uji", "Bab uji", () => {}) as Rec
function docWith(columns: unknown, rows: unknown): Rec {
  const doc = clone(K.loadCase("case01.json"))
  const [{ block: tbl }] = K.blocksOfType(doc, "table").filter((x) => JSON.stringify(x.block).includes("Jumlah titik sensor"))
  tbl.columns = columns
  tbl.rows = rows
  return doc
}
/** Reader-visible DOCX text: every w:t run text of word/document.xml, joined (entities decoded). */
function docxText(xml: string): string {
  const out: string[] = []
  for (const m of xml.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)) out.push(m[1])
  return out
    .join("")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
}

const ROWS = [
  ["Daftar", "Tautan", "Nomor", "Berkas"],
  [LONG, URL, DOC_NO, PATH],
  [LONG_SEMI, FIT, PLAIN, "uji"],
]
let text = ""
let xml = ""
let bytes: Uint8Array = new Uint8Array()
let snap: unknown
async function rendered(): Promise<string> {
  if (!text) {
    const b = block(ROWS)
    snap = K.compose(docWith(b.columns, b.rows))
    bytes = await K.renderDocx(snap as never)
    xml = K.docXml(bytes)
    text = docxText(xml)
  }
  return text
}

describe("rel128 gap DOC-1: U+200B in the DOCX text of a long-token table (count recorded)", () => {
  test("recorded count: 39 + 29 = 68 U+200B, all break hints of the two overflowing lists", async () => {
    const t = await rendered()
    const n = count(t, ZW)
    // Verdict line for the ledger: the measured count.
    console.log(`DOC1 U+200B in extracted DOCX text: ${n} (xml ${count(xml, ZW)})`)
    expect(n).toBe(39 + 29)
    expect(count(t, `/${ZW}`) + count(t, `;${ZW}`) + count(t, `,${ZW}`)).toBe(n)
    expect(t).toContain(LONG.split("/").join(`/${ZW}`))
    expect(t).toContain(LONG_SEMI.split(";").join(`;${ZW}`))
  }, 60_000)

  test("no U+200B inside a URL, a document number, a path, a fitting list or plain words", async () => {
    const t = await rendered()
    for (const tok of [URL, DOC_NO, PATH, FIT, PLAIN]) expect({ tok, whole: t.includes(tok) }).toEqual({ tok, whole: true })
  }, 60_000)

  test("removing U+200B gives the source text back: no visible character is added", async () => {
    const t = (await rendered()).split(ZW).join("")
    for (const cell of ROWS.flat()) expect({ cell, present: t.includes(cell) }).toEqual({ cell, present: true })
  }, 60_000)

  test("Studio FIDELITY drops U+200B (transform step 2): the broken list compares equal to its source", async () => {
    await rendered()
    const broken = LONG.split("/").join(`/${ZW}`)
    expect(normalizeFidelityText(broken)).toBe(normalizeFidelityText(LONG))
    const check = checkDocxFidelity(bytes, fidelityExpectationFromSnapshot(snap))
    console.log(`DOC1 FIDELITY on the rendered DOCX: ${check.status} (${check.findings.length} findings)`)
    const zwFindings = check.findings.filter((f) => JSON.stringify(f).includes(ZW) || JSON.stringify(f).includes("R-0"))
    expect(zwFindings).toEqual([])
    expect(check.status).toBe("PASS")
  }, 60_000)
})
