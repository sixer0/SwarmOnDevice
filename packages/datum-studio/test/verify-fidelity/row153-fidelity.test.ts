// Row 153 (spec masterplan/01_specs_output_verification.md §3.3, §9 B4-B6 and G1; decision C130): FIDELITY check.
//
// What runs for real: the vendored Studio engines (normalizeDocument / composeV2 -> assembleHtml / assembleDocx,
// renderChart / buildDiagramSvg) render real outputs in process, and src/mcp-host/verify/fidelity.ts checks them
// against the expectation built from the same snapshot (blockRowsFromSnapshot). Defects are made by changing the
// bytes the check reads (the §9 fault-seam idea), never the engine. No browser, no store, no network, no model.
//
// G1 (false-positive gate): every known-good render gives PASS with 0 findings: the 4 parity doc fixtures, the
// DATUM manual (manual000, image blocks removed: their assets are not in the repo), the Rev A HTML/DOCX fixtures,
// a v2 composed document in ID and EN, and the 118 parity chart/diagram SVGs.
import { afterAll, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate"
import { useStudioEnv } from "../ported/_env"
import type { NormDocSnapshot, ResolvedTemplate } from "../../vendor/src/lib/studio/contract"
import {
  canonicalNumber,
  checkDocxFidelity,
  checkFidelity,
  checkHtmlFidelity,
  checkSvgFidelity,
  FIDELITY_TRANSFORMS,
  fidelityExpectationFromSnapshot,
  normalizeFidelityText,
  type FidelityExpectation,
} from "../../src/mcp-host/verify/fidelity"
import type { VerifyCheck } from "../../src/mcp-host/verify/types"

useStudioEnv()
const K = await import("../ported/renderers/_kit")
const S = await import("../ported/structure/_kit")
const { parityRenders } = await import("../ported/figures/_svgManifest")
const { PARITY_CHART_DIR, PARITY_DIAGRAM_DIR } = await import("../ported/figures/_helpers")
const RA_HTML = await import("../engine-rev-a/html/_kit")
const RA_DOCX = await import("../engine-rev-a/docx/_kit")
const { composeV2 } = await import("../../vendor/src/lib/studio/services/compose")
const { assembleDocxDetailed } = await import("../../vendor/src/lib/studio/engine/docx/assemble")
const { assembleHtml } = await import("../../vendor/src/lib/studio/engine/html/assemble")

const PKG = path.resolve(import.meta.dir, "..", "..")
const timings: string[] = []
afterAll(() => {
  if (timings.length) console.log(`[row153 timing] ${timings.join(" ; ")}`)
})

async function render(snap: NormDocSnapshot, tpl: ResolvedTemplate): Promise<{ html: string; docx: Uint8Array }> {
  const html = await assembleHtml(K.makeCtx(snap, tpl).ctx, { preview: false })
  const { bytes } = await assembleDocxDetailed(K.makeCtx(snap, tpl).ctx)
  return { html, docx: bytes }
}

function docXml(docx: Uint8Array): string {
  return strFromU8(unzipSync(docx)["word/document.xml"])
}
/** DOCX with word/document.xml replaced (every other part kept byte for byte). */
function withDocXml(docx: Uint8Array, xml: string): Uint8Array {
  const files = unzipSync(docx)
  files["word/document.xml"] = strToU8(xml)
  return zipSync(files)
}

const codes = (c: VerifyCheck) => c.findings.map((f) => f.code)
const clean = (c: VerifyCheck, what: string) => {
  expect({ what, status: c.status, findings: c.findings }).toEqual({ what, status: "PASS", findings: [] })
  expect(c.id).toBe("FIDELITY")
  expect(c.reason).toBeNull()
  expect(c.truncated).toBe(0)
}

const stripImages = (n: unknown): unknown =>
  Array.isArray(n)
    ? n.filter((x) => !(x && typeof x === "object" && (x as { type?: unknown }).type === "image")).map(stripImages)
    : n && typeof n === "object"
      ? Object.fromEntries(Object.entries(n).map(([k, v]) => [k, stripImages(v)]))
      : n

// ── the defect document (v2, composed like a Swarm agent submission) ─────────────────────────────────────────

const t = (text: string) => ({ text })
const PARA_NUM = "Nilai kontrak Rp 1.250.000,5 dengan efisiensi 25 % pada tahap pertama [TERUKUR] menurut berita acara."
const PARA_DROP = "Paragraf ini dihapus dari keluaran oleh uji B4 dan harus dilaporkan hilang."
const PARA_QUOTE = 'Operator menyebut ruang itu "dingin" -- catatan lapangan.'

function defectDoc(lang: "ID" | "EN"): Record<string, unknown> {
  const d = S.e1()
  d.meta = { ...d.meta, language: lang }
  d.sections.content.chapters[1].sections[0].blocks = [
    { type: "paragraph", text: PARA_NUM },
    { type: "paragraph", text: PARA_DROP },
    { type: "paragraph", text: PARA_QUOTE },
    {
      type: "table",
      caption: t("Nilai pos pekerjaan tahap pertama"),
      columns: [{ role: "id" }, { role: "numeral" }, { role: "text" }],
      rows: [
        { kind: "header", cells: [t("Pos"), t("Nilai"), t("Keterangan")] },
        { cells: [t("A"), t("1.250"), t("Pekerjaan sipil")] },
        { cells: [t("B"), t("2.500,75"), t("Instalasi listrik")] },
        { cells: [t("C"), t("25 %"), t("Cadangan biaya")] },
      ],
      source: { text: "Berita acara pemeriksaan 2026-10-20", provenance: ["TERUKUR"] },
    },
  ]
  return d
}

function composeDefect(lang: "ID" | "EN"): NormDocSnapshot {
  const slots = S.datumSlots()
  return composeV2({ source: S.merge(defectDoc(lang), undefined, { slots }).doc, skeleton: S.skeletonInput(slots), params: S.defaultParams() }).snapshot as unknown as NormDocSnapshot
}

const tpl = await K.canonicalTemplate()
const defectSnap = composeDefect("ID")
const defectExp = fidelityExpectationFromSnapshot(defectSnap)
const defect = await render(defectSnap, tpl)
const blockOf = (exp: FidelityExpectation, needle: string) => {
  const b = exp.blocks.find((x) => JSON.stringify(x.content).includes(needle))
  if (!b) throw new Error(`fixture block not found: ${needle}`)
  return b
}
const numBlock = blockOf(defectExp, "Nilai kontrak")
const dropBlock = blockOf(defectExp, "Paragraf ini dihapus")
const tableBlock = blockOf(defectExp, "Nilai pos pekerjaan")

/** Remove the HTML element (with its subtree) that carries `attr="value"`; the engine output is well formed. */
function removeHtmlElement(html: string, attrName: string, value: string): string {
  const open = new RegExp(`<([a-z0-9]+)\\b[^>]*\\b${attrName}="${value}"[^>]*>`)
  const m = open.exec(html)
  if (!m) throw new Error(`no element ${attrName}=${value}`)
  const tag = m[1]
  let depth = 0
  const re = new RegExp(`<(/?)${tag}\\b[^>]*>`, "g")
  re.lastIndex = m.index
  for (let x = re.exec(html); x; x = re.exec(html)) {
    depth += x[1] === "/" ? -1 : 1
    if (depth === 0) return html.slice(0, m.index) + html.slice(x.index + x[0].length)
  }
  throw new Error("unbalanced element")
}

// ── G1: known-good renders give 0 findings ──────────────────────────────────────────────────────────────────

describe("G1: an exact render reports 0 differences", () => {
  test("defect document as rendered (ID), before any fault: HTML, PDF-through-HTML and DOCX", () => {
    clean(checkHtmlFidelity(defect.html, defectExp), "html")
    clean(checkFidelity({ format: "PDF", source: defect.html, expected: defectExp }), "pdf")
    expect(checkFidelity({ format: "PDF", source: defect.html, expected: defectExp }).basis).toBe("same-job-html")
    clean(checkDocxFidelity(defect.docx, defectExp), "docx")
    expect(defectExp.blocks.length).toBeGreaterThan(10)
  })

  test("the 4 parity doc fixtures with their own templates (HTML + DOCX)", async () => {
    for (const name of K.FIXTURES) {
      const snap = K.snapshotOf(K.loadFixtureDoc(name))
      const exp = fidelityExpectationFromSnapshot(snap)
      const out = await render(snap, await K.fixtureTemplate(name))
      clean(checkHtmlFidelity(out.html, exp), `${name} html`)
      clean(checkDocxFidelity(out.docx, exp), `${name} docx`)
    }
  }, 60_000)

  test("v2 composed document in ID and EN (HTML + DOCX)", async () => {
    for (const lang of ["ID", "EN"] as const) {
      const snap = composeDefect(lang)
      const exp = fidelityExpectationFromSnapshot(snap)
      expect(exp.language).toBe(lang)
      const out = await render(snap, tpl)
      clean(checkHtmlFidelity(out.html, exp), `v2 ${lang} html`)
      clean(checkDocxFidelity(out.docx, exp), `v2 ${lang} docx`)
    }
  }, 60_000)

  test("Rev A fixtures: HTML (terbit_rev_a_html, key row localised KEY -> KUNCI) and DOCX (terbit_rev_a)", async () => {
    const h = await RA_HTML.renderHtml()
    clean(checkHtmlFidelity(h.html, fidelityExpectationFromSnapshot(RA_HTML.snapshotOf(RA_HTML.loadFixture()))), "rev-a html")
    const d = await RA_DOCX.renderDocx()
    clean(checkDocxFidelity(d.bytes, fidelityExpectationFromSnapshot(RA_DOCX.snapshotOf(RA_DOCX.loadFixture()))), "rev-a docx")
  }, 60_000)

  test("DATUM manual000 (369 addressed blocks, 90 tables; image blocks removed): HTML + DOCX, timed", async () => {
    const doc = stripImages(JSON.parse(readFileSync(path.join(PKG, "test/ported/_fixtures/benchmark/manual000/doc.json"), "utf8")))
    const snap = RA_HTML.snapshotOf(doc as never)
    const exp = fidelityExpectationFromSnapshot(snap)
    expect(exp.blocks.length).toBe(369)
    const html = await assembleHtml(RA_HTML.makeCtx(snap, await RA_HTML.canonicalTemplate()).ctx, { preview: false })
    const docx = (await RA_DOCX.renderDocx(doc as never)).bytes
    const h = checkHtmlFidelity(html, exp)
    const d = checkDocxFidelity(docx, exp)
    clean(h, "manual html")
    clean(d, "manual docx")
    timings.push(`manual000 HTML ${(html.length / 1e6).toFixed(1)} MB ${h.ms} ms`, `manual000 DOCX ${d.ms} ms`)
    expect(h.ms).toBeLessThan(1000) // spec §4 H-2: static checks < 1 s
    expect(d.ms).toBeLessThan(1000)
  }, 60_000)

  test("118 parity chart and diagram SVGs (datum + gallery, release + draft) give PASS", () => {
    let n = 0
    for (const r of parityRenders()) {
      const kind = r.id.split("/")[0]
      const file = r.id.slice(kind.length + 1).split("@")[0]
      const spec = JSON.parse(readFileSync(path.join(kind === "chart" ? PARITY_CHART_DIR : PARITY_DIAGRAM_DIR, file), "utf8"))
      const exp: FidelityExpectation = { language: "ID", blocks: [{ blockId: "b1", address: "1.1.1", type: kind, content: { spec }, artifactLabel: "Gambar 1.1" }] }
      const c = checkSvgFidelity(r.svg, exp, "Gambar 1.1")
      expect({ id: r.id, status: c.status, findings: c.findings }).toEqual({ id: r.id, status: "PASS", findings: [] })
      n++
    }
    expect(n).toBe(118)
  })
})

// ── B4: dropped paragraph ─────────────────────────────────────────────────────────────────────────────────────

describe("B4: a dropped paragraph is reported with its address", () => {
  test("HTML: the element of one data-block removed -> BLOCK_MISSING", () => {
    const html = removeHtmlElement(defect.html, "data-block", dropBlock.blockId)
    const c = checkHtmlFidelity(html, defectExp)
    expect(c.status).toBe("FAIL")
    expect(c.findings).toEqual([expect.objectContaining({ code: "BLOCK_MISSING", address: dropBlock.address, page: null })])
  })

  test("PDF (same-job HTML) inherits the same finding, basis same-job-html", () => {
    const c = checkFidelity({ format: "PDF", source: removeHtmlElement(defect.html, "data-block", dropBlock.blockId), expected: defectExp })
    expect(c.basis).toBe("same-job-html")
    expect(codes(c)).toEqual(["BLOCK_MISSING"])
  })

  test("DOCX: the w:p of that paragraph removed -> BLOCK_MISSING", () => {
    const xml = docXml(defect.docx)
    const at = xml.indexOf("Paragraf ini dihapus")
    const start = xml.lastIndexOf("<w:p>", at) >= xml.lastIndexOf("<w:p ", at) ? xml.lastIndexOf("<w:p>", at) : xml.lastIndexOf("<w:p ", at)
    const end = xml.indexOf("</w:p>", at) + "</w:p>".length
    const c = checkDocxFidelity(withDocXml(defect.docx, xml.slice(0, start) + xml.slice(end)), defectExp)
    expect(c.status).toBe("FAIL")
    expect(c.findings).toEqual([expect.objectContaining({ code: "BLOCK_MISSING", address: dropBlock.address })])
  })
})

// ── B5: changed number ────────────────────────────────────────────────────────────────────────────────────────

describe("B5: a changed number is reported (Indonesian formats)", () => {
  test("HTML table cell 1.250 -> 1.205: NUMBER_CHANGED at row 2, column 2", () => {
    const html = defect.html.replace(/>1\.250</, ">1.205<")
    expect(html).not.toBe(defect.html)
    const c = checkHtmlFidelity(html, defectExp)
    expect(c.status).toBe("FAIL")
    expect(c.findings).toEqual([expect.objectContaining({ code: "NUMBER_CHANGED", address: tableBlock.address })])
    expect(c.findings[0].detail).toContain("row 2, column 2")
    expect(c.findings[0].detail).toContain("1.205")
  })

  test("DOCX table cell 1.250 -> 1.205: NUMBER_CHANGED at row 2, column 2", () => {
    const xml = docXml(defect.docx)
    const c = checkDocxFidelity(withDocXml(defect.docx, xml.replace(/>1\.250</, ">1.205<")), defectExp)
    expect(c.findings).toEqual([expect.objectContaining({ code: "NUMBER_CHANGED", address: tableBlock.address })])
    expect(c.findings[0].detail).toContain("row 2, column 2")
  })

  test("prose: 1.250.000,5 -> 1.250.000,6 and 25 % -> 52 % are NUMBER_CHANGED (HTML and DOCX)", () => {
    for (const [from, to] of [["1.250.000,5", "1.250.000,6"], ["25 %", "52 %"]]) {
      const h = checkHtmlFidelity(defect.html.replace(from, to), defectExp)
      expect(h.findings).toEqual([expect.objectContaining({ code: "NUMBER_CHANGED", address: numBlock.address })])
      const x = docXml(defect.docx)
      const d = checkDocxFidelity(withDocXml(defect.docx, x.replace(from, to)), defectExp)
      expect(d.findings).toEqual([expect.objectContaining({ code: "NUMBER_CHANGED", address: numBlock.address })])
    }
  })

  test("same value, other grouping (1.250.000,5 -> 1&#160;250&#160;000,5; 25 % with NBSP) is not a change", () => {
    const html = defect.html.replace("1.250.000,5", "1&#160;250&#160;000,5").replace("25 %", "25&#160;%")
    expect(html).not.toBe(defect.html)
    clean(checkHtmlFidelity(html, defectExp), "regrouped")
  })

  test("canonical values per language (spec §3.3)", () => {
    expect(canonicalNumber("1.250.000,5", "ID")).toBe("1250000.5")
    expect(canonicalNumber("1 250 000,50", "ID")).toBe("1250000.5")
    expect(canonicalNumber("1,250,000.5", "EN")).toBe("1250000.5")
    expect(canonicalNumber("25%", "ID")).toBe("25%")
    expect(canonicalNumber("1.205", "ID")).toBe("1205")
    expect(canonicalNumber("1.205", "EN")).toBe("1.205")
    expect(canonicalNumber("1.2.2", "ID")).toBeNull() // a section reference is not a number
    expect(canonicalNumber("1,2,5", "ID")).toBeNull()
    expect(canonicalNumber("12", "FR")).toBeNull() // A-6: only ID and EN
  })

  test("a changed token that cannot be read gives UNKNOWN NUMBER_UNPARSED, never a skip", () => {
    const c = checkHtmlFidelity(defect.html.replace("1.250.000,5", "1.250.00,5"), defectExp)
    expect(c.status).toBe("UNKNOWN")
    expect(c.reason).toBe("NUMBER_UNPARSED")
  })
})

// ── B6: missing table row ─────────────────────────────────────────────────────────────────────────────────────

describe("B6: a missing table row is reported as TABLE_SHAPE", () => {
  test("HTML: one tr removed", () => {
    const at = defect.html.indexOf(">2.500,75<")
    const start = defect.html.lastIndexOf("<tr ", at)
    const end = defect.html.indexOf("</tr>", at) + "</tr>".length
    const c = checkHtmlFidelity(defect.html.slice(0, start) + defect.html.slice(end), defectExp)
    expect(c.status).toBe("FAIL")
    expect(c.findings).toEqual([expect.objectContaining({ code: "TABLE_SHAPE", address: tableBlock.address, detail: "expected 4 rows x 3 columns, found 3 x 3" })])
  })

  test("DOCX: one w:tr removed", () => {
    const xml = docXml(defect.docx)
    const at = xml.indexOf(">2.500,75<")
    const start = Math.max(xml.lastIndexOf("<w:tr>", at), xml.lastIndexOf("<w:tr ", at))
    const end = xml.indexOf("</w:tr>", at) + "</w:tr>".length
    const c = checkDocxFidelity(withDocXml(defect.docx, xml.slice(0, start) + xml.slice(end)), defectExp)
    expect(c.status).toBe("FAIL")
    expect(codes(c)).toContain("TABLE_SHAPE")
    expect(c.findings.find((f) => f.code === "TABLE_SHAPE")?.address).toBe(tableBlock.address)
  })

  test("HTML: a cell's text changed -> TABLE_CELL_CHANGED with row and column", () => {
    const c = checkHtmlFidelity(defect.html.replace(">Instalasi listrik<", ">Instalasi air<"), defectExp)
    expect(c.findings).toEqual([expect.objectContaining({ code: "TABLE_CELL_CHANGED", address: tableBlock.address })])
    expect(c.findings[0].detail).toContain("row 3, column 3")
  })
})

// ── truncation and typography ─────────────────────────────────────────────────────────────────────────────────

describe("truncated text is a loss; legitimate typography is not", () => {
  test('"[TERUKUR] menurut ..." cut to "[TERUKU" -> TEXT_CHANGED that says where the output stops (HTML and DOCX)', () => {
    const cut = (s: string) => s.replace(/\[TERUKUR\] menurut berita acara\./, "[TERUKU")
    const h = checkHtmlFidelity(cut(defect.html), defectExp)
    expect(h.findings).toEqual([expect.objectContaining({ code: "TEXT_CHANGED", address: numBlock.address })])
    const expectedLen = normalizeFidelityText(PARA_NUM).length
    const kept = normalizeFidelityText(PARA_NUM).indexOf("[TERUKU") + "[TERUKU".length
    expect(h.findings[0].detail).toContain(`after ${kept} of ${expectedLen} characters`)
    expect(h.findings[0].amount).toBe(expectedLen - kept)
    const d = checkDocxFidelity(withDocXml(defect.docx, cut(docXml(defect.docx))), defectExp)
    expect(d.findings).toEqual([expect.objectContaining({ code: "TEXT_CHANGED", address: numBlock.address })])
  })

  test("NBSP, soft hyphen, zero-width space, smart quotes and line breaks in the output are not flagged", () => {
    const html = defect.html
      .replace("Nilai kontrak Rp", "Nilai&#160;kon&#173;trak​ Rp")
      .replace("&quot;dingin&quot;", "“dingin”")
      .replace("menurut berita acara", "menurut<br>berita\nacara")
    expect(html).not.toBe(defect.html)
    clean(checkHtmlFidelity(html, defectExp), "typography")
  })

  test("a dash replacing the submitted hyphen pair is reported (dashes are not folded)", () => {
    const c = checkHtmlFidelity(defect.html.replace(" -- catatan", " — catatan"), defectExp)
    expect(codes(c)).toEqual(["TEXT_CHANGED"])
  })

  test("transform table lists exactly the spec steps plus the quote fold", () => {
    expect(FIDELITY_TRANSFORMS.map((x) => x.step)).toEqual([1, 2, 3, 4, 5])
    expect(normalizeFidelityText("  a b c­d​e ‘q’ “w”\n\tz ")).toBe("a b cde 'q' \"w\" z")
  })

  test("the cover issue stamp the engine rebuilds (U+2014) is never compared", () => {
    const stamp = defect.html.match(/\/\/ \d{8} [A-Z]{2} [A-Z] — [^<]+/)
    expect(stamp).not.toBeNull()
    clean(checkHtmlFidelity(defect.html, defectExp), "stamp")
  })
})

// ── SVG / PNG and the entry point ─────────────────────────────────────────────────────────────────────────────

describe("SVG labels and the checkFidelity entry point", () => {
  const dg = parityRenders().find((r) => r.id === "diagram/dg_flow.json@rel")!
  const spec = JSON.parse(readFileSync(path.join(PARITY_DIAGRAM_DIR, "dg_flow.json"), "utf8"))
  const exp: FidelityExpectation = { language: "ID", blocks: [{ blockId: "b9", address: "2.1.3", type: "diagram", content: { spec }, artifactLabel: "Gambar 2.1" }] }

  test("a node label dropped from the SVG -> LABEL_MISSING with the figure address; PNG reads the same-job SVG", () => {
    const svg = dg.svg.replace(">Baca suhu terakhir<", "><")
    expect(svg).not.toBe(dg.svg)
    const c = checkSvgFidelity(svg, exp, "Gambar 2.1")
    expect(c.findings).toEqual([expect.objectContaining({ code: "LABEL_MISSING", address: "2.1.3", label: "Gambar 2.1" })])
    const p = checkFidelity({ format: "PNG", source: svg, expected: exp, figureLabel: "Gambar 2.1" })
    expect(p.basis).toBe("same-job-svg")
    expect(codes(p)).toEqual(["LABEL_MISSING"])
  })

  test("an artifact-referenced spec without the resolved spec is UNKNOWN, with it the labels are checked", () => {
    const ref: FidelityExpectation = { language: "ID", blocks: [{ ...exp.blocks[0], content: { spec: { artifactId: "fig-x" } } }] }
    expect(checkSvgFidelity(dg.svg, ref, "Gambar 2.1")).toMatchObject({ status: "UNKNOWN", reason: "SOURCE_MISSING" })
    expect(checkFidelity({ format: "SVG", source: dg.svg, expected: ref, figureLabel: "Gambar 2.1", figureSpec: spec }).status).toBe("PASS")
  })

  test("missing source -> UNKNOWN SOURCE_MISSING; unreadable DOCX -> UNKNOWN PARSE_FAILED; never PASS", () => {
    expect(checkFidelity({ format: "PDF", source: null, expected: defectExp })).toMatchObject({ status: "UNKNOWN", reason: "SOURCE_MISSING", basis: "same-job-html" })
    expect(checkFidelity({ format: "PNG", source: null, expected: exp, figureLabel: "Gambar 2.1" })).toMatchObject({ status: "UNKNOWN", reason: "SOURCE_MISSING" })
    expect(checkFidelity({ format: "DOCX", source: new Uint8Array([1, 2, 3]), expected: defectExp })).toMatchObject({ status: "UNKNOWN", reason: "PARSE_FAILED" })
    expect(checkFidelity({ format: "SVG", source: dg.svg, expected: exp, figureLabel: "Gambar 9.9" })).toMatchObject({ status: "UNKNOWN", reason: "SOURCE_MISSING" })
  })

  test("findings are capped at VERIFY_FINDINGS_CAP with the rest counted in truncated", () => {
    const many: FidelityExpectation = {
      language: "ID",
      blocks: Array.from({ length: 60 }, (_, i) => ({ blockId: `gone-${i}`, address: `9.9.${i + 1}`, type: "paragraph", content: { type: "paragraph", text: `teks ${i}` } })),
    }
    const c = checkHtmlFidelity(defect.html, many)
    expect(c.findings.length).toBe(50)
    expect(c.truncated).toBe(10)
    expect(c.status).toBe("FAIL")
  })
})
