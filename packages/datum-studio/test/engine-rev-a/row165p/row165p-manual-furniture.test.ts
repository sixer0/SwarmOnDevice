// Row 165P (C205; gateway_check/14b_row113_refacts_final.md §6 judged against research/14). The bundled Rev A cases 01
// and 05 (row 143a fixtures, datum-kanonik) rendered in process to HTML and DOCX, plus the case 04 figure block and a
// nested-table derivation, pin the manual's furniture:
//  a CP-01  cover control-block labels flush left (ID p.47 DT-14 "Tumpukan di tengah adalah tanda templat");
//  b CP-05  a 0.45 mm rule above the control block (ID p.47 butir 10 "Blok kendali 4 × 2 di bawah garis 0,45 mm");
//  c CP-05  the manual's eight fields in a 4 x 2 block on every cover (ID p.47 "nomor dokumen, revisi, penyusun,
//           kustodian, ditujukan kepada, halaman, datum geodetik, dan verifikasi"), TINGKAT dropped; the lembar cover
//           kicker from the type code (ID p.15 Tabel 3.1);
//  d CP-05  HALAMAN = the register's sheet count N in both formats (DOCX formula field = register formula);
//  e CP-08/12/13  PDF head rule seal, register top rule seal + bottom ink200, number and n bold ink900; DOCX head and
//           register top rules seal;
//  f CP-11  no register on the contents page (wrapper pages carry no Register Block);
//  g CP-23  DOCX lead fixed 9 mm (also row165b, consequence edit);
//  h CP-29  DOCX derivation glyph ◈ #B45309 followed by its DITURUNKAN label;
//  i CP-28/48  stand-alone figure: caption above the drawing, SUMBER with its PROVENANS part;
//  j CP-36  no register key (internal id) in a printed derivation expression.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { strFromU8, unzipSync } from "fflate"

const K = await import("../row165a/_kit")
const T = await import("../../../vendor/src/lib/studio/engine/front/texts")
const PKG = path.resolve(import.meta.dir, "..", "..", "..")

const CASES = ["case01.json", "case05.json"] as const
const cache = new Map<string, { html: string; docx: Uint8Array; xml: string }>()
async function render(name: (typeof CASES)[number]) {
  const hit = cache.get(name)
  if (hit) return hit
  const snap = K.compose(K.loadCase(name))
  const docx = await K.renderDocx(snap)
  const out = { html: await K.renderHtml(snap), docx, xml: strFromU8(unzipSync(docx)["word/document.xml"]) }
  cache.set(name, out)
  return out
}

const MANUAL_LABELS = ["Nomor dokumen", "Revisi", "Penyusun", "Kustodian", "Ditujukan kepada", "Halaman", "Datum geodetik", "Verifikasi"]

/** Cover control table of the HTML: rows of [label, value text]. */
function htmlControl(html: string): { table: string; before: string; labels: string[][] } {
  const cover = K.unitHtml(html, "cover")
  const at = cover.indexOf('<table class="st-control"')
  const table = cover.slice(at, cover.indexOf("</table>", at))
  const labels = [...table.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((r) => [...r[1].matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/g)].map((m) => K.text(m[1])))
  return { table, before: cover.slice(Math.max(0, at - 400), at), labels }
}

/** The first `w:tbl` of the DOCX body whose first cell reads "Nomor dokumen" (the cover control block). */
function docxControl(xml: string): { tbl: string; rows: string[][] } {
  for (const m of xml.matchAll(/<w:tbl>[\s\S]*?<\/w:tbl>/g)) {
    const rows = [...m[0].matchAll(/<w:tr\b[\s\S]*?<\/w:tr>/g)].map((tr) => [...tr[0].matchAll(/<w:tc>[\s\S]*?<\/w:tc>/g)].map((tc) => [...tc[0].matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((t) => t[1]).join("")))
    if (rows[0]?.[0] === "Nomor dokumen") return { tbl: m[0], rows }
  }
  return { tbl: "", rows: [] }
}

describe("a/b CP-01, CP-05: control-block labels left, 0.45 mm rule above the block", () => {
  for (const name of CASES) {
    test(`${name}: HTML labels flush left; an SVG rule of 0.45 mm in the wrapper ink right before the table`, async () => {
      const { html } = await render(name)
      expect(html).toContain(".st-control-label{text-align:left}")
      const c = htmlControl(html)
      expect(c.before).toMatch(/<svg class="st-control-rule"[^>]*height="0\.45mm"[^>]*><rect x="0" y="0" width="166" height="0\.45" fill="#14110F"\/><\/svg>$/)
    })

    test(`${name}: DOCX first control row carries the top rule (w:sz 10 = 0.44 mm, wrapper ink)`, async () => {
      const { xml } = await render(name)
      const { tbl } = docxControl(xml)
      const firstRow = /<w:tr\b[\s\S]*?<\/w:tr>/.exec(tbl)![0]
      expect((firstRow.match(/<w:top w:val="single" w:sz="10" w:space="0" w:color="14110F"\/>/g) ?? []).length).toBe(4)
    })
  }
})

describe("c CP-05: the manual's eight fields, 4 x 2, on every cover; lembar kicker", () => {
  for (const name of CASES) {
    test(`${name}: HTML and DOCX control blocks hold the eight fields in the manual's order, no TINGKAT`, async () => {
      const { html, xml } = await render(name)
      const h = htmlControl(html)
      expect(h.labels.length).toBe(4)
      expect(h.labels.flat().map((l) => l.toLowerCase())).toEqual(MANUAL_LABELS.map((l) => l.toLowerCase()))
      expect(h.table).not.toMatch(/>Tingkat</i)
      const d = docxControl(xml)
      expect(d.rows.length).toBe(4)
      expect(d.rows.flatMap((r) => [r[0], r[2]])).toEqual(MANUAL_LABELS)
      expect(xml).not.toContain(">Tingkat<")
    })
  }

  test("case 01 keeps every written value; no typed sheet count (HALAMAN is the engine field)", async () => {
    const { html, xml } = await render("case01.json")
    const h = K.text(htmlControl(html).table)
    for (const v of ["012/GSP/KT/XI/2026", "A · 6 November 2026", "Divisi Engineering", "ENG-UJI-01", "Kepala Balai Konservasi Arsip Kota Arunika", "V2 · lulus"]) {
      expect(h).toContain(v)
      expect(docxControl(xml).rows.flat().join(" | ")).toContain(v)
    }
    expect(htmlControl(html).table).toContain('data-field="NUMPAGES"')
  })

  test("case 05 (lembar, auto cover): empty KUSTODIAN / DITUJUKAN KEPADA cells, nothing invented; kicker = Tabel 3.1 type of KT", async () => {
    const { html, xml } = await render("case05.json")
    const d = docxControl(xml)
    expect(d.rows[1][3]).toBe("")
    expect(d.rows[2][1]).toBe("")
    expect(K.unitHtml(html, "cover")).toContain('data-role="wrapper.kicker">Kajian dan analisis teknis</p>')
    expect(xml).toContain(">Kajian dan analisis teknis<")
  })

  test("helper controlRowsManualFields: drops TINGKAT, keeps written values, unknown label = block as written, fill false = empty", () => {
    const meta = { docNumber: "012/GSP/KT/XI/2026", rev: "A", issueDate: "2026-11-06", author: "X", classification: "Terbatas", language: "ID", title: "t", tier: "TERBIT" } as never
    const c = (t: string) => ({ text: t })
    const rows = [
      [c("Nomor dokumen"), c("012/GSP/KT/XI/2026"), c("Revisi"), c("A")],
      [c("Tingkat"), c("TERBIT"), c("Halaman"), c("6")],
    ] as never
    const out = T.controlRowsManualFields(rows, meta, { "cover.controlBlock.geodeticDatum": "WGS 84" }, "ID", { sheets: T.CONTROL_FIELD_SHEETS_FIELD })
    const flat = out.flat().map((x: any) => ("text" in x ? x.text : x.runs.map((r: any) => r.t ?? `{${r.field}}`).join("")))
    expect(flat).toEqual(["Nomor dokumen", "012/GSP/KT/XI/2026", "Revisi", "A", "Penyusun", "X", "Kustodian", "", "Ditujukan kepada", "", "Halaman", "{NUMPAGES}", "Datum geodetik", "WGS 84", "Verifikasi", ""])
    const bare = T.controlRowsManualFields(rows, meta, { "cover.controlBlock.geodeticDatum": "WGS 84" }, "ID", { sheets: T.CONTROL_FIELD_SHEETS_FIELD }, false)
    expect(bare.flat().map((x: any) => ("text" in x ? x.text : "{F}"))).toEqual(["Nomor dokumen", "012/GSP/KT/XI/2026", "Revisi", "A", "Penyusun", "", "Kustodian", "", "Ditujukan kepada", "", "Halaman", "{F}", "Datum geodetik", "", "Verifikasi", ""])
    const unknown = [[c("Proyek"), c("UPK-70"), c("Revisi"), c("A")]] as never
    expect(T.controlRowsManualFields(unknown, meta, {}, "ID", {})).toEqual(unknown)
  })
})

describe("d CP-05: HALAMAN = the register's sheet count N in DOCX and PDF", () => {
  for (const name of CASES) {
    test(`${name}: DOCX HALAMAN is the register's formula { = NUMPAGES - PAGEREF _StSheet0 }`, async () => {
      const { xml } = await render(name)
      const { tbl } = docxControl(xml)
      const cell = [...tbl.matchAll(/<w:tc>[\s\S]*?<\/w:tc>/g)].map((m) => m[0])
      const i = cell.findIndex((c) => c.includes(">Halaman<"))
      const value = cell[i + 1]
      expect(value).toContain('<w:instrText xml:space="preserve"> = </w:instrText>')
      expect(value).toContain(" NUMPAGES ")
      expect(value).toContain(" PAGEREF _StSheet0 ")
      expect(value).not.toContain("<w:fldSimple")
    })
  }

  test("PDF print: a document numbered from Bab 1 fills HALAMAN with N (withSheetTotals total = numbered)", async () => {
    const pdf = await import("../../../vendor/src/lib/studio/services/render/pdf")
    const src = readFileSync(path.join(PKG, "vendor", "src", "lib", "studio", "services", "render", "pdf.ts"), "utf8")
    expect(src).toContain("if (plan.numbered && numbered > 0) return print(withSheetTotals(armed.html, numbered, numbered, armed.token));")
    const out = pdf.withSheetTotals('<html><head><style data-studio="pages">x</style></head></html>', 2, 2)
    expect(out).toContain('--st-pages-total:"2"')
  })
})

describe("e/f CP-08, CP-12, CP-13, CP-11: page furniture", () => {
  test("PDF CSS: head rule seal under the head line, register rules (top seal, bottom ink200), number and n bold ink900", async () => {
    const { html } = await render("case01.json")
    const css = html.slice(html.indexOf('<style data-studio="pages">'), html.indexOf("</style>", html.indexOf('<style data-studio="pages">')))
    const unit = /@page st-u-3\{([\s\S]*?)\}\n/.exec(css)![1]
    expect(unit).toMatch(/@top-left\{[^}]*border-bottom:0\.26mm solid #6E1420;margin-bottom:9\.9mm;/)
    expect(unit).toMatch(/@top-center\{content:"[^"]*";[^}]*border-bottom:0\.26mm solid #6E1420/)
    const left = /@bottom-left\{([^}]*)\}/.exec(unit)![1]
    const center = /@bottom-center\{([^}]*)\}/.exec(unit)![1]
    expect(left).toContain("border-top:0.35mm solid #6E1420;border-bottom:0.2mm solid #C3CBD1")
    expect(left).toContain("counter(page, st-blank)")
    expect(left).not.toContain("012/GSP/KT/XI/2026")
    expect(center).toContain('"012/GSP/KT/XI/2026"')
    expect(center).toContain("color:#101418;font-weight:600")
    expect(center).toMatch(/counter\(page\)/)
    expect(css).toContain("@counter-style st-blank{system:numeric;")
  })

  test("CP-11: the contents unit (before Bab 1) prints no register block", async () => {
    const { html } = await render("case01.json")
    const tocUnit = /\.st-unit\[data-unit-key="F:toc"\]\{page:(st-u-\d+)\}/.exec(html)![1]
    const rule = new RegExp(`@page ${tocUnit}\\{([\\s\\S]*?)\\}\\n`).exec(html)![1]
    expect(rule).toContain("@bottom-left{content:none}")
    expect(rule).toContain("@bottom-center{content:none}")
    expect(rule).toContain("@bottom-right{content:none}")
  })

  test("DOCX: running-head rule and register top rule are seal #6E1420", async () => {
    const files = unzipSync((await render("case01.json")).docx)
    const headers = Object.keys(files).filter((f) => /^word\/header\d+\.xml$/.test(f)).map((f) => strFromU8(files[f]))
    const footers = Object.keys(files).filter((f) => /^word\/footer\d+\.xml$/.test(f)).map((f) => strFromU8(files[f]))
    const heads = headers.filter((h) => h.includes("<w:pBdr>"))
    expect(heads.length).toBeGreaterThan(0)
    for (const h of heads) expect(h).toContain('<w:bottom w:val="single" w:sz="6" w:space="1" w:color="6E1420"/>')
    const regs = footers.filter((f) => f.includes("LEMBAR"))
    expect(regs.length).toBeGreaterThan(0)
    for (const f of regs) {
      expect(f).toContain('<w:top w:val="single" w:sz="8" w:space="0" w:color="6E1420"/>')
      expect(f).not.toContain('w:sz="8" w:space="0" w:color="101418"')
    }
  })
})

describe("h CP-29: DOCX derivation result glyph in its Table 7.1 colour with its label", () => {
  test("case 01: ◈ #B45309 then a no-break space and DITURUNKAN (Cond capitals), as the PDF prints it", async () => {
    const { xml } = await render("case01.json")
    const m = /<w:r><w:rPr>(?:(?!<\/w:rPr>).)*?<w:color w:val="([0-9A-F]{6})"\/>(?:(?!<\/w:rPr>).)*?<\/w:rPr><w:t(?: xml:space="preserve")?>◈<\/w:t><\/w:r><w:r><w:rPr>((?:(?!<\/w:rPr>).)*?)<\/w:rPr><w:t(?: xml:space="preserve")?> DITURUNKAN<\/w:t><\/w:r>/s.exec(xml)
    expect(m).not.toBeNull()
    expect(m![1]).toBe("B45309")
    expect(m![2]).toContain("<w:caps/>")
    expect(m![2]).toContain("IBM Plex Sans Condensed")
  })
})

const fig = await import(path.join(PKG, "src", "mcp-host", "local-api", "routes", "figure-preview-figure.ts"))
const compose = await import(path.join(PKG, "vendor", "src", "lib", "studio", "services", "compose", "index.ts"))
describe("i CP-28/48: stand-alone figure apparatus", () => {
  const CASE04 = JSON.parse(readFileSync(path.join(PKG, "test", "engine-rev-a", "row165c", "fixtures", "row165c_case04_block.json"), "utf8"))
  const content = compose.mapBlock(CASE04, "fig-diagram-41", { glyphs: compose.glyphSet(undefined), params: {}, classification: "TERBATAS", artifactLabel: "Gambar 4.1" })
  const block = { blockId: "fig-diagram-41", pid: "fig-diagram-41", address: "4.1.1", ordinal: 0, unitKey: "", type: "diagram", content, textPlain: "", contentSha256: "", artifactLabel: "Gambar 4.1" }

  test("caption above the drawing (its baseline above every node), height unchanged, lint-clean placement", async () => {
    const r = await fig.renderFigure(block, { params: {} } as any, { inline: false, withSvg: true, lang: "ID", standalone: true })
    const cap = /<text data-caption-above="1"[^>]*\by="([0-9.]+)"[^>]*>([\s\S]*?)<\/text>/.exec(r.svg)!
    expect(cap[2].replace(/<[^>]+>/g, "")).toBe("GAMBAR 4.1  Arsitektur sistem pemantauan iklim ruang simpan arsip.")
    const g = /<g transform="translate\(0 ([0-9.]+)\)">/.exec(r.svg)!
    const nodeTops = [...r.svg.slice(r.svg.indexOf(g[0])).matchAll(/<rect [^>]*\by="([0-9.]+)"[^>]*data-node=/g)].map((m) => Number(m[1]) + Number(g[1]))
    expect(nodeTops.length).toBeGreaterThan(0)
    expect(Number(cap[1])).toBeLessThan(Math.min(...nodeTops))
    expect(r.svg).not.toContain('data-st-caption="1"')
    // Under the drawing: KUNCI, then SUMBER/PROVENANS as the lowest line (page apparatus order).
    const yOf = (start: string) => Number(/\by="([0-9.]+)"/.exec((r.svg.match(/<text\b[^>]*>[\s\S]*?<\/text>/g) ?? []).find((t: string) => t.replace(/<[^>]+>/g, "").startsWith(start))!)![1])
    expect(yOf("SUMBER")).toBeGreaterThan(yOf("KUNCI"))
  })

  test("SUMBER ends with the PROVENANS part of the block's marks (glyph in mark colour + label)", async () => {
    const r = await fig.renderFigure(block, { params: {} } as any, { inline: false, withSvg: true, lang: "ID", standalone: true })
    const src = (r.svg.match(/<text\b[^>]*>[\s\S]*?<\/text>/g) ?? []).find((t: string) => t.includes("SUMBER"))!
    expect(src.replace(/<[^>]+>/g, "")).toContain("PROVENANS  ■ TERUKUR · ◇ PEMASOK")
    expect(src).toContain('<tspan font-weight="600">PROVENANS</tspan>')
    expect(src).toMatch(/<tspan fill="#[0-9A-Fa-f]{6}">◇<\/tspan>/)
  })

  test("standaloneProvenance: block SUMBER marks first, else node marks, Table 7.1 order", () => {
    expect(fig.standaloneProvenance(CASE04.spec, block, "ID")).toEqual({ label: "PROVENANS", marks: [{ mark: "TERUKUR", text: "TERUKUR" }, { mark: "PEMASOK", text: "PEMASOK" }] })
    const noSrc = { ...block, content: { ...content, source: { text: "x" } } }
    expect(fig.standaloneProvenance(CASE04.spec, noSrc, "ID")!.marks.map((m: any) => m.mark)).toEqual(["TERUKUR", "DITURUNKAN", "PEMASOK"])
  })
})

describe("j CP-36: a printed derivation expression names no register key", () => {
  test("nestedTable result line prints the values, not energi_baterai / beban_puncak", async () => {
    const snap = K.compose(K.loadCase("case01.json"))
    const tpl = await K.kanonikTemplate()
    const R = await import("../../ported/renderers/_kit")
    const { assembleHtml } = await import("../../../vendor/src/lib/studio/engine/html/assemble")
    const nested = { ...tpl, params: { ...tpl.params, "render.derivation.renderer": "nestedTable" } }
    const html = await assembleHtml(R.makeCtx(snap, nested as never).ctx, { preview: false })
    expect(html).toContain('data-renderer="nestedTable"')
    expect(html).not.toContain("energi_baterai")
    expect(html).not.toContain("beban_puncak")
    expect(html).toContain("= 216,0 × 0,85 ÷ 492,6 × 60")
  })
})
