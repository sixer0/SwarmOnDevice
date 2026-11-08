// Wave 165 row 165A (decisions C188/C189): cover, control sheet and page furniture of the Rev A wrapper.
//   F56-1   (shape changed by row 165O, C204 item 3: CP-05 4 x 2 grid; scorer CV-12 failed "5 baris (> 4)") Klasifikasi
//           is its own LINE inside the "Nomor dokumen" value cell, directly under the number: a separate w:p in DOCX, a
//           separate block line in HTML/PDF; no extra row. CR-2/NU-02 reading the whole cell = DEVIATION-SCORER.
//   F113-3  the HTML/PDF cover prints the DOCX fields: template address line, HALAMAN; 4 x 2 grid with a gap.
//   F113-4  three signature columns across the span, one signature line each; method statement (ID p.48).
//   F113-5  ID p.48 "Lembar kendali ... memuat ... tiga kolom tanda tangan": the signatures sit on the control
//           sheet; no separate signatures unit (pinned here).
//   F113-6  LEMBAR n DARI N: N = numbered sheets (PDF two-pass print; DOCX NUMPAGES minus the wrapper sheets).
//   F113-7  the contents page carries the register block, without a sheet number (unnumbered, ID p.48).
// Material: the row 143a copies of the adapted case 01 / case 05 (fixtures/SHA256SUMS there), datum-kanonik overrides.
import { describe, expect, test } from "bun:test"
import { strFromU8, unzipSync } from "fflate"

const K = await import("./_kit")
const T = await import("../../../vendor/src/lib/studio/engine/front/texts")

const html01 = await K.renderHtml(K.compose(K.loadCase("case01.json")))
const html05 = await K.renderHtml(K.compose(K.loadCase("case05.json")))
const docx01 = await K.renderDocx(K.compose(K.loadCase("case01.json")))
const docx05 = await K.renderDocx(K.compose(K.loadCase("case05.json")))
const doc01 = K.docXml(docx01)
const doc05 = K.docXml(docx05)

/** Rows of the cover control table (HTML) as arrays of cell texts. */
function controlRowsHtml(html: string): string[][] {
  const cover = K.unitHtml(html, "cover")
  const t = cover.slice(cover.indexOf('<table class="st-control"'), cover.indexOf("</table>", cover.indexOf('<table class="st-control"')))
  return [...t.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((m) => [...m[1].matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/g)].map((c) => K.text(c[1])))
}

/** Rows of the first DOCX table whose first cell reads "Nomor dokumen" (the cover control block). */
function controlRowsDocx(xml: string): string[][] {
  for (const t of xml.match(/<w:tbl>[\s\S]*?<\/w:tbl>/g) ?? []) {
    const rows = (t.match(/<w:tr\b[\s\S]*?<\/w:tr>/g) ?? []).map((r) =>
      (r.match(/<w:tc>[\s\S]*?<\/w:tc>/g) ?? []).map((c) => (c.match(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g) ?? []).map((x) => x.replace(/<[^>]+>/g, "")).join("")),
    )
    if (rows[0]?.[0] === "Nomor dokumen") return rows
  }
  return []
}

function under(rows: string[][], label: string): { row: number; col: number } | undefined {
  for (let r = 0; r < rows.length; r++) for (let c = 0; c < rows[r].length; c += 2) if (rows[r][c] === label) return { row: r, col: c }
  return undefined
}

/** Row 165O: the number cell's lines (HTML `div.st-control-line`; DOCX `w:p`) of the cover control table. */
function numberCellLinesHtml(html: string): string[] {
  const cover = K.unitHtml(html, "cover")
  const t = cover.slice(cover.indexOf('<table class="st-control"'), cover.indexOf("</table>", cover.indexOf('<table class="st-control"')))
  const cell = t.match(/Nomor dokumen<\/th><td[^>]*>([\s\S]*?)<\/td>/)![1]
  return [...cell.matchAll(/<div class="st-control-line">([\s\S]*?)<\/div>/g)].map((m) => K.text(m[1]))
}
function numberCellDocx(xml: string): { paragraphs: string[]; hasBr: boolean } {
  for (const t of xml.match(/<w:tbl>[\s\S]*?<\/w:tbl>/g) ?? []) {
    const cells = t.match(/<w:tc>[\s\S]*?<\/w:tc>/g) ?? []
    const i = cells.findIndex((c) => /<w:t(?: [^>]*)?>Nomor dokumen<\/w:t>/.test(c))
    if (i !== 0) continue
    const v = cells[1]
    const paragraphs = (v.match(/<w:p\b[\s\S]*?<\/w:p>/g) ?? []).map((p) => (p.match(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g) ?? []).map((x) => x.replace(/<[^>]+>/g, "")).join(""))
    return { paragraphs, hasBr: v.includes("<w:br") }
  }
  return { paragraphs: [], hasBr: false }
}

describe("F56-1 (row 165O shape) Klasifikasi is its own line under the number, inside the number cell; 4 x 2 grid", () => {
  test("helper: number cell = number, br, 'Klasifikasi : ' + bold seal TERBATAS; no extra row; lines split at br", () => {
    const rows = T.controlBlockRowsText({ docNumber: "012/GSP/KT/XI/2026", rev: "A", issueDate: "2026-11-06", author: "X", classification: "Terbatas", language: "ID", title: "t", tier: "TERBIT" } as never, {}, "ID")!
    const inl = rows.map((r) => r.map((t) => ({ text: t }))) as never
    const out = T.controlRowsWithClassificationLine(inl, { classification: "Terbatas", language: "ID" } as never, {}, "ID")
    expect(out.length).toBe(rows.length)
    const runs = (out[0][1] as any).runs
    expect(runs[0]).toEqual({ t: "012/GSP/KT/XI/2026" })
    expect(runs[1]).toEqual({ br: "line" })
    expect(runs[2]).toEqual({ t: "Klasifikasi : " })
    expect(runs[3]).toMatchObject({ t: "TERBATAS", b: true, color: "6E1420" })
    const lines = T.controlCellLines(out[0][1])
    expect(lines).toEqual([{ runs: [{ t: "012/GSP/KT/XI/2026" }] }, { runs: [runs[2], runs[3]] }])
    expect(T.controlCellLines({ text: "x" })).toEqual([{ text: "x" }])
    expect(out.flat().some((c: any) => ("text" in c ? c.text : "") === "Klasifikasi")).toBe(false)
  })
  for (const [name, html, xml, number, nRows] of [
    ["case 01 (explicit control rows)", html01, doc01, "012/GSP/KT/XI/2026", 4],
    // Row 165P consequence edit (C205, CP-05): every cover holds the manual's eight fields, so case 05 has 4 rows too.
    ["case 05 (auto control block)", html05, doc05, "013/GSP/KT/XI/2026", 4],
  ] as const) {
    test(`${name}: HTML (= PDF source) ${nRows} rows; number cell = [number, Klasifikasi : TERBATAS] as block lines`, () => {
      const rows = controlRowsHtml(html)
      expect(rows.length).toBe(nRows)
      expect(under(rows, "Klasifikasi")).toBeUndefined()
      expect(numberCellLinesHtml(html)).toEqual([number, "Klasifikasi : TERBATAS"])
      expect(K.unitHtml(html, "cover")).toContain('<div class="st-control-line">Klasifikasi : <span class="st-b" style="color:#6E1420">TERBATAS</span></div>')
    })
    test(`${name}: DOCX ${nRows} rows; number cell = two w:p, no w:br`, () => {
      const rows = controlRowsDocx(xml)
      expect(rows.length).toBe(nRows)
      expect(under(rows, "Klasifikasi")).toBeUndefined()
      expect(numberCellDocx(xml)).toEqual({ paragraphs: [number, "Klasifikasi : TERBATAS"], hasBr: false })
    })
  }
})

describe("F113-3 PDF/HTML cover prints the DOCX fields with a gap", () => {
  test("case 05: template address line on the HTML cover, as in the DOCX", () => {
    expect(doc05).toContain("Bangka")
    expect(K.text(K.unitHtml(html05, "cover"))).toContain("Jl. Bangka Raya No. 27")
  })
  test("HALAMAN printed in HTML (NUMPAGES field span) as in the DOCX", () => {
    for (const [html, xml] of [[html01, doc01], [html05, doc05]] as const) {
      expect(xml).toContain(">Halaman<")
      expect(under(controlRowsHtml(html), "Halaman")).toBeDefined()
    }
    // Row 165P consequence edit (C205, CP-05): both covers print the engine's sheet count (case 01's typed "6" is
    // replaced); in the DOCX it is the register's formula field { = NUMPAGES - PAGEREF _StSheet0 } (N from Bab 1).
    for (const [html, xml] of [[html01, doc01], [html05, doc05]] as const) {
      expect(K.unitHtml(html, "cover")).toMatch(/Halaman<\/th><td[^>]*><span class="st-field"[^>]*data-field="NUMPAGES"><\/span>/)
      expect(xml).toMatch(/Halaman[\s\S]{0,2400}<w:instrText xml:space="preserve"> NUMPAGES <\/w:instrText>/)
    }
  })
  test("4 x 2 grid across the span (DOCX shares) and a 3 mm gap after each value", () => {
    const cover = K.unitHtml(html05, "cover")
    const cg = cover.slice(cover.indexOf('<table class="st-control"')).match(/<colgroup>([\s\S]*?)<\/colgroup>/)![1]
    const w = [...cg.matchAll(/width:([0-9.]+)%/g)].map((m) => Number(m[1]))
    expect(w.length).toBe(4)
    expect(Math.abs(w.reduce((a, b) => a + b, 0) - 100)).toBeLessThan(0.01)
    expect(html05).toContain(".st-control,.st-signature{width:100%}")
    expect(html05).toContain(".st-control-value{padding-right:3mm}")
  })
})

describe("F113-4 signature block and method statement", () => {
  test("three columns across 166 mm, one signature line each", () => {
    const cs = K.unitHtml(html01, "controlSheet")
    const sig = cs.slice(cs.indexOf('<table class="st-signature"'))
    expect(K.text(sig.slice(0, sig.indexOf("</thead>")))).toBe("Penyusun Diperiksa Disetujui")
    const w = [...sig.match(/<colgroup>([\s\S]*?)<\/colgroup>/)![1].matchAll(/width:([0-9.]+)%/g)].map((m) => Number(m[1]))
    expect(w).toHaveLength(3)
    expect(Math.max(...w) - Math.min(...w)).toBeLessThan(1)
    expect(sig).toMatch(/style="--st-sign-rule:#[0-9A-F]{6}"/)
    expect((sig.match(/class="st-signature-holder/g) ?? []).length).toBe(3)
    // Wave 165 row 165J consequence edit (F165H-3): the line is a CSS border on ::before (vector), no longer a gradient.
    expect(html01).toContain(".st-signature-holder::before{content:\"\";display:block;border-top:0.22mm solid var(--st-sign-rule")
  })
  test("method statement paragraph between the verification chain and the signatures (HTML and DOCX)", () => {
    for (const [html, xml] of [[html01, doc01], [html05, doc05]] as const) {
      const cs = K.text(K.unitHtml(html, "controlSheet"))
      expect(cs).toMatch(/C · Pernyataan metode|Pernyataan metode/)
      expect(cs).toContain("Dokumen ini diperiksa melalui rantai verifikasi tiga lapis: V1")
      expect(cs.indexOf("Rantai verifikasi")).toBeLessThan(cs.indexOf("Dokumen ini diperiksa"))
      expect(cs.indexOf("Dokumen ini diperiksa")).toBeLessThan(cs.indexOf("Penyusun Diperiksa Disetujui"))
      expect(xml).toContain("Dokumen ini diperiksa melalui rantai verifikasi tiga lapis: V1")
    }
  })
})

describe("F113-5 signatures on the control sheet (ID p.48), no separate page", () => {
  test("unit order cover, controlSheet (with the signature table), toc; no signature unit", () => {
    const kinds = [...html01.matchAll(/<section class="st-unit[^"]*" data-unit="([^"]+)"/g)].map((m) => m[1])
    expect(kinds.slice(0, 3)).toEqual(["cover", "controlSheet", "toc"])
    expect(kinds).not.toContain("signature")
    expect(K.unitHtml(html01, "controlSheet")).toContain('<table class="st-signature"')
  })
})

describe("F113-6 / F113-7 register foot: numbered-sheet total and the contents page", () => {
  test("HTML: the register N is marked for the PDF numbered pass; the pass style hides the wrapper units", () => {
    expect(html01).toContain("/*st-N*/counter(pages)/*/st-N*/")
    expect(html01).toMatch(/<style data-studio="pdf-numbered-pass" media="not all">[^<]*\.st-unit\[data-unit-key="F:cover"\]/)
    expect(html01).not.toMatch(/<style data-studio="pdf-numbered-pass"[^>]*>[^<]*F:toc[^<]*display:none[^<]*<\/style>[\s\S]*F:ch/)
  })
  // Row 165P consequence edit (C205, controller correction of F113-7; CP-11 "Wrapper pages carry no Register Block"):
  // the contents unit prints no register foot (= DOCX); its sheets still count 0 (counter-set) and stay unnumbered.
  test("HTML: the contents unit carries no register foot (CP-11)", () => {
    const pages = html01.slice(html01.indexOf('<style data-studio="pages">'))
    const tocName = pages.match(/\.st-unit\[data-unit-key="F:toc"\]\{page:(st-u-\d+)\}/)![1]
    const rule = pages.match(new RegExp(`@page ${tocName}\\{[^]*?\\}\\}`))![0]
    expect(rule).toContain("@bottom-left{content:none}")
    expect(rule).toContain("@bottom-center{content:none}")
    expect(rule).toContain("@bottom-right{content:none}")
    expect(rule).toContain("counter-set:page 0")
  })
  test("DOCX: register N = NUMPAGES minus the sheets before Bab 1 (PAGEREF of the wrapper-end bookmark)", () => {
    const files = unzipSync(docx01)
    const footers = Object.keys(files).filter((f) => /^word\/footer\d+\.xml$/.test(f)).map((f) => strFromU8(files[f]))
    const reg = footers.filter((x) => x.includes("NUMPAGES"))
    expect(reg.length).toBeGreaterThan(0)
    for (const f of reg) {
      expect(f).toContain("<w:instrText xml:space=\"preserve\"> = </w:instrText>")
      expect(f).toContain("<w:instrText xml:space=\"preserve\"> PAGEREF _StSheet0 </w:instrText>")
      expect(f.indexOf(" PAGE ")).toBeLessThan(f.indexOf(" NUMPAGES "))
    }
    expect(doc01).toMatch(/<w:bookmarkStart w:id="900000" w:name="_StSheet0"\/><w:bookmarkEnd w:id="900000"\/><\/w:p>/)
    // Row 165P consequence edit (C205, CP-05): the cover HALAMAN field refers to the same bookmark (one more use).
    expect((doc01.match(/name="_StSheet0"/g) ?? []).length).toBe(1)
    expect((doc01.match(/_StSheet0/g) ?? []).length).toBe(2)
  })
})
