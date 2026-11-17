// Swarm 1.3.3 row 45 (ST-3 item 6, "satu bentuk baris kunci"; gap matrix N7 "two key-row renderings"; GSP manual
// GRM-09: the legend is one row at the foot of the figure, filled from `legend[]`).
//
// Before this row a figure key had three producers with three texts for one block (replay R3 p1 Gambar 1.1):
//   SVG   engine/diagram/core/sheet.ts keyLineTexts      "KUNCI  <legend rows>" (capitals, wrapped at rows)
//   page  engine/html/tables/apparatus.ts keyRowHtml     "KUNCI  <the block's authored keyRow sentence>", and
//         engine/docx/figures/figure.ts keyRowXml        the same without the Indonesian edge-kind wording
//   block services/compose/blocks.ts diagram()           `keyRow` = the authored sentence, or absent with `legend[]`
// Now one producer (`keyRowTextOf` in core/sheet.ts) gives the text; the SVG line, the page rows and the block
// field (`blockKeyRow`, the seam compose calls) print it.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

const PKG = path.resolve(import.meta.dir, "..", "..")
const V = path.join(PKG, "vendor", "src", "lib", "studio")
const K = await import("../engine-rev-a/row165a/_kit")
const R = await import("../ported/renderers/_kit")
const core = await import(path.join(V, "engine", "diagram", "core", "index.ts"))
const build = await import(path.join(V, "engine", "diagram", "build", "index.ts"))
const figs = await import(path.join(V, "services", "render", "figures.ts"))
const compose = await import(path.join(V, "services", "compose", "index.ts"))
const inline = await import(path.join(V, "services", "compose", "inline.ts"))
const htmlApp = await import(path.join(V, "engine", "html", "tables", "apparatus.ts"))
const docxFig = await import(path.join(V, "engine", "docx", "figures", "figure.ts"))
const T = await import(path.join(V, "engine", "front", "texts.ts"))

const BLOCK = JSON.parse(readFileSync(path.join(import.meta.dir, "fixtures", "r3_p1_fig1_block.json"), "utf8"))
const BCTX = { glyphs: compose.glyphSet(undefined), params: {}, classification: "TERBATAS", artifactLabel: "Gambar 1.1" }
const ID = figs.diagramApparatusOptions("ID")

/** The composed `studio.diagram/v1` spec of the fixture block with another legend. */
function specWith(legend: string[] | undefined): any {
  const { keyRow: _k, ...noKey } = BLOCK
  const spec = { ...noKey.spec }
  if (legend) spec.legend = legend
  else delete spec.legend
  // The spec as a stand-alone figure reads it: compose's page signal dropped (the preview route's
  // `standaloneDiagramSpec` does the same), so the SVG carries its own key.
  const { keyRowOnPage: _p, ...composed } = compose.mapBlock({ ...noKey, spec }, "p1", BCTX).spec
  return { ...composed, apparatus: "page", labels_verified: true }
}

/** Text of every `<text>` of an SVG, in document order. */
const svgTexts = (svg: string): string[] => (svg.match(/<text\b[^>]*>[\s\S]*?<\/text>/g) ?? []).map((t) => t.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&"))
/** The key lines an SVG draws (the line that opens with the label and the lines after it). */
function svgKeyLines(svg: string, label: string): string[] {
  const all = svgTexts(svg)
  const at = all.findIndex((t) => t.startsWith(`${label}  `))
  return at < 0 ? [] : all.slice(at)
}
/** The block field as compose writes a key text (`apparatusInline`, label run + one text run). */
const blockField = (text: string) => inline.apparatusInline({ text }, "key", BCTX)
const plain = (i: { runs: { t: string }[] }): string => i.runs.map((r) => r.t).join("")
/** Printed text of the HTML key row: tags dropped, no-break spaces as spaces, nothing collapsed. */
const htmlText = (h: string): string => h.replace(/<[^>]+>/g, "").replace(/&#160;|&nbsp;/g, " ").replace(/&amp;/g, "&")
const docxText = (x: string): string => [...x.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]).join("").replace(/&amp;/g, "&")

async function pageCtx() {
  return R.makeCtx(K.compose(K.loadCase("case01.json")), await K.kanonikTemplate()).ctx
}

const SHORT = ["DATA = aliran data", "CONTROL = kendali Mb/s"]

describe("row 45: one producer of the key row text (core/sheet.ts)", () => {
  test("keyRowTextOf = legendRows joined by KEY_ROW_SEP; no rows = empty", () => {
    const s = specWith(SHORT)
    expect(core.legendRows(s)).toEqual(SHORT)
    expect(core.keyRowTextOf(s)).toBe("DATA = aliran data  ·  CONTROL = kendali Mb/s")
    expect(core.keyRowTextOf(s, ID.keyRowText)).toBe("PENUH = aliran data  ·  PUTUS-PUTUS = kendali Mb/s")
    expect(core.keyRowTextOf(specWith(undefined))).toBe("")
  })

  test("keyLineTexts: a key that fits is the label plus keyRowTextOf (the line the SVG draws)", () => {
    const s = specWith(SHORT)
    expect(core.keyLineTexts(s, s.width_mm, "KUNCI", ID.keyRowText)).toEqual([`KUNCI  ${core.keyRowTextOf(s, ID.keyRowText)}`])
    expect(core.keyLineTexts(s, s.width_mm)).toEqual([`KEY  ${core.keyRowTextOf(s)}`])
  })

  test("keyLineTexts: a key that wraps at row boundaries is the same text, rows on separate lines", () => {
    const s = specWith(undefined === BLOCK.spec.legend ? SHORT : BLOCK.spec.legend)
    const lines = core.keyLineTexts(s, s.width_mm, "KUNCI", ID.keyRowText)
    expect(lines.length).toBeGreaterThan(1)
    expect(lines.join(core.KEY_ROW_SEP)).toBe(`KUNCI  ${core.keyRowTextOf(s, ID.keyRowText)}`)
  })

  test("mapKeyRowText words a joined text exactly as the rows are worded one by one", () => {
    const word = (row: string) => T.keyLineText(row, "ID")
    for (const rows of [SHORT, ["KEY = kata kunci", "SYNC = sinkron · DATA = x", "ALERT=alarm"], BLOCK.spec.legend as string[]]) {
      expect(core.mapKeyRowText(rows.join(core.KEY_ROW_SEP), word)).toBe(rows.map(word).join(core.KEY_ROW_SEP))
    }
  })

  test("blockKeyRow: spec rows are the key; an authored keyRow is the key only without spec rows", () => {
    const authored = BLOCK.keyRow.text as string
    const s = specWith(BLOCK.spec.legend)
    expect(core.blockKeyRow(s, authored)).toEqual({ text: core.keyRowTextOf(s), source: "legend", authoredSuperseded: true })
    expect(core.blockKeyRow(s)).toEqual({ text: core.keyRowTextOf(s), source: "legend", authoredSuperseded: false })
    expect(core.blockKeyRow(s, core.keyRowTextOf(s))).toEqual({ text: core.keyRowTextOf(s), source: "legend", authoredSuperseded: false })
    expect(core.blockKeyRow(specWith(undefined), ` ${authored} `)).toEqual({ text: authored, source: "authored", authoredSuperseded: false })
    expect(core.blockKeyRow(specWith(undefined))).toEqual({ text: "", source: "none", authoredSuperseded: false })
  })
})

describe("row 45: the same spec gives the same key row text in the SVG, on the page and in the block", () => {
  for (const [name, legend] of [
    ["short key, DATUM edge kinds (one SVG line)", SHORT],
    ["replay R3 p1 Gambar 1.1 legend (SVG wraps at rows)", BLOCK.spec.legend as string[]],
  ] as const) {
    test(name, async () => {
      const s = specWith([...legend])
      const ctx = await pageCtx()
      const want = `KUNCI  ${core.keyRowTextOf(s, ID.keyRowText)}`

      // block: the field compose carries (label run + the producer's text, unworded: wording is a print step)
      const field = blockField(core.blockKeyRow(s, BLOCK.keyRow.text).text)
      expect(plain(field)).toBe(`KUNCI  ${core.keyRowTextOf(s)}`)

      // SVG (stand-alone or a document figure whose page prints no key): label + worded rows. The role
      // `table_header` still draws capitals (ST-3.4, row 43, owns letter case), so letters are compared folded.
      const svg = build.buildDiagramSvg(s, { ...ID }).svg
      const lines = svgKeyLines(svg, "KUNCI")
      expect(lines.length).toBeGreaterThan(0)
      expect(lines.join(core.KEY_ROW_SEP).toUpperCase()).toBe(want.toUpperCase())

      // page, HTML/PDF and DOCX: the block field printed
      expect(htmlText(htmlApp.keyRowHtml(field, ctx))).toBe(want)
      expect(docxText(docxFig.keyRowXml(field, ctx))).toBe(want)

      // and with the page printing the row, the SVG draws none (one row, not two forms)
      expect(svgKeyLines(build.buildDiagramSvg({ ...s, keyRowOnPage: true }, { ...ID }).svg, "KUNCI")).toEqual([])
    })
  }

  test("an EN document: KEY label, rows as written, same text in the three outputs", async () => {
    const s = specWith(SHORT)
    const EN = figs.diagramApparatusOptions("EN")
    expect(EN.keyRowText).toBeUndefined()
    const want = `KEY  ${core.keyRowTextOf(s)}`
    expect(svgKeyLines(build.buildDiagramSvg(s, { ...EN }).svg, "KEY").join(core.KEY_ROW_SEP).toUpperCase()).toBe(want.toUpperCase())
  })

})

describe("row 45: compose and render carry the one key row (document path)", () => {
  const { keyRow: AUTHORED, ...NO_KEY } = BLOCK
  const { legend: LEGEND, ...SPEC_NO_LEGEND } = BLOCK.spec
  const map = (b: unknown) => compose.mapBlock(b, "p1", BCTX)

  test("legend only: block.keyRow = label run + keyRowTextOf(spec); spec marked keyRowOnPage", () => {
    const c = map(NO_KEY)
    expect(c.keyRow).toEqual({ runs: [{ t: "KUNCI  " }, { t: (LEGEND as string[]).join(core.KEY_ROW_SEP) }] })
    expect(plain(c.keyRow)).toBe(`KUNCI  ${core.keyRowTextOf(c.spec)}`)
    expect(c.spec.keyRowOnPage).toBe(true)
    expect(c.spec.legend).toEqual(LEGEND) // DATUM-34 still reads the legend
  })

  test("legend and an authored keyRow: the legend rows are the key, the same block as legend only", () => {
    const both = map(BLOCK)
    expect(both.keyRow).toEqual(map(NO_KEY).keyRow)
    expect(plain(both.keyRow)).not.toContain(AUTHORED.text)
  })

  test("authored keyRow without legend: printed as written (unchanged); neither: no key row, no signal", () => {
    const authored = map({ ...BLOCK, spec: SPEC_NO_LEGEND })
    expect(authored.keyRow).toEqual({ runs: [{ t: "KUNCI  " }, { t: AUTHORED.text }] })
    expect(authored.spec.keyRowOnPage).toBe(true)
    const none = map({ ...NO_KEY, spec: SPEC_NO_LEGEND })
    expect(none.keyRow).toBeUndefined()
    expect(none.spec.keyRowOnPage).toBeUndefined()
  })

  test("document: the page row, the DOCX row and the stand-alone SVG print one text; the document SVG draws no key", async () => {
    const c = map(NO_KEY)
    const ctx = await pageCtx()
    const docSpec = { ...c.spec, apparatus: "page", labels_verified: true }
    const want = `KUNCI  ${core.keyRowTextOf(docSpec, ID.keyRowText)}`
    expect(htmlText(htmlApp.keyRowHtml(c.keyRow, ctx))).toBe(want)
    expect(docxText(docxFig.keyRowXml(c.keyRow, ctx))).toBe(want)
    expect(svgKeyLines(build.buildDiagramSvg(docSpec, { ...ID }).svg, "KUNCI")).toEqual([])
    const { keyRowOnPage: _p, ...solo } = docSpec
    expect(svgKeyLines(build.buildDiagramSvg(solo, { ...ID }).svg, "KUNCI").join(core.KEY_ROW_SEP).toUpperCase()).toBe(want.toUpperCase())
  })

  test("artefact reference: the artefact's rows become the block key row of the build; spec copy marked, artefact untouched", () => {
    const art = specWith([...SHORT])
    const content: Record<string, unknown> = { spec: { artifactId: "art-1" } }
    expect(figs.artifactBlockKeyRow(art, content)).toEqual({ runs: [{ t: "KUNCI  " }, { t: core.keyRowTextOf(art) }] })
    const built = figs.diagramSpecForBlock(art, content)
    expect(built.keyRowOnPage).toBe(true)
    expect(art.keyRowOnPage).toBeUndefined()
    expect(content.keyRow).toEqual({ runs: [{ t: "KUNCI  " }, { t: core.keyRowTextOf(art) }] })
    // an authored keyRow on the reference is superseded by the artefact's rows; a second call changes nothing
    const both: Record<string, unknown> = { spec: { artifactId: "art-1" }, keyRow: { runs: [{ t: "KUNCI  " }, { t: "kalimat penulis" }] } }
    figs.diagramSpecForBlock(art, both)
    expect(both.keyRow).toEqual(content.keyRow)
    figs.diagramSpecForBlock(art, both)
    expect(both.keyRow).toEqual(content.keyRow)
    // artefact without rows: an authored keyRow stays; no keyRow, no signal
    const bare = specWith(undefined)
    const kept: Record<string, unknown> = { spec: { artifactId: "art-1" }, keyRow: { runs: [{ t: "KUNCI  " }, { t: "kalimat penulis" }] } }
    expect(figs.diagramSpecForBlock(bare, kept).keyRowOnPage).toBe(true)
    expect(kept.keyRow).toEqual({ runs: [{ t: "KUNCI  " }, { t: "kalimat penulis" }] })
    expect(figs.diagramSpecForBlock(bare, { spec: { artifactId: "art-1" } })).toBe(bare)
    // content that cannot be written: earlier behaviour, the key stays in the SVG
    expect(figs.diagramSpecForBlock(art, Object.freeze({ spec: { artifactId: "art-1" } }))).toBe(art)
    // inline spec: compose owns the signal, nothing is added here
    const inlineContent: Record<string, unknown> = { spec: art }
    expect(figs.diagramSpecForBlock(art, inlineContent)).toBe(art)
    expect(inlineContent.keyRow).toBeUndefined()
  })
})
