// Row 150 (decision U24 A, C130): the output checks that need no browser: LINT, PAGE_COUNT, EMPTY_SLOTS, FIGURE_FIT
// (spec masterplan/01_specs_output_verification.md §3.1, §3.4-§3.7). One PASS and one FAIL fixture per check, the
// broken cases B7, B8 and B9 of spec §9, and UNKNOWN whenever a part cannot be measured (never a pass).
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { zipSync, strToU8 } from "fflate"
import { useStudioEnv } from "../ported/_env"
import type { LintIssue, StudioChartV1, StudioDiagramV1 } from "@/lib/studio/contract"
import { SYMBOL_DIALECTS } from "@/lib/studio/contract"
import { renderChart } from "@/lib/studio/engine/chart/core"
import { buildDiagramSvg } from "@/lib/studio/engine/diagram/build"
import { lintDiagramGeometry } from "@/lib/studio/engine/diagram/fit/lint"
import { borderXml } from "@/lib/studio/engine/docx/package/xml"
import { symbolSheetSvg } from "@/lib/studio/engine/symbols"
import {
  checkEmptySlots,
  checkFigureFit,
  checkLint,
  checkPageCount,
  DIAGRAM_FAIL_KINDS,
  FIGURE_FIT_FAIL_NOTES,
  isApplicable,
  runStaticChecks,
  VERIFY_CHECK_ORDER,
  VERIFY_MATRIX,
  type LayoutInput,
  type VerifyFormat,
} from "../../src/mcp-host/verify/static-checks"
import { findDocxPlaceholders, findHtmlFigures, findHtmlPlaceholders, SCAN_TEXT_MAX } from "../../src/mcp-host/verify/html-scan"
import { OUTPUT_VERIFICATION_SCHEMA, VERIFY_FINDINGS_CAP } from "../../src/mcp-host/verify/types"

useStudioEnv()

const FORMATS: VerifyFormat[] = ["HTML", "PDF", "DOCX", "SVG", "PNG"]

// ── fixtures ────────────────────────────────────────────────────────────

const issue = (checkId: string, status: LintIssue["status"], address?: string): LintIssue => ({ checkId, status, detail: `${checkId} ${status}`, ...(address ? { address } : {}) })
/** A stored lint report as revision.ts:136-143 writes it (JSON text in `revision.lint_report`). */
const report = (tier: string, checks: LintIssue[]): string => JSON.stringify({ tier, checks, releaseStatus: "PASS", banner: "" })
const GOOD_TERBIT = [issue("DATUM-37", "PASS"), issue("DATUM-33", "PASS"), issue("DATUM-14", "PASS"), issue("C-26b", "PASS")]

/** Minimal PDF text with a page tree root of `n` pages (what countPdfPages reads, V/services/render/pdf.ts:50). */
const pdfOf = (n: number): Uint8Array =>
  strToU8(`%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [] /Count ${n} >> endobj\n${Array.from({ length: n }, (_, k) => `${k + 3} 0 obj << /Type /Page /Parent 2 0 R >> endobj`).join("\n")}\n%%EOF`)

type El = { kind: string; page?: number; address?: string; label?: string; xMm: number; yMm: number; widthMm: number; heightMm: number; overflow?: boolean }
const el = (kind: string, page: number, extra: Partial<El> = {}): El => ({ kind, page, xMm: 20, yMm: 30, widthMm: 100, heightMm: 10, ...extra })
/** Paged layout as measureLayout returns it (V/engine/browser/index.ts:389-430). */
const paged = (pages: number, elements: El[], truncated = false): LayoutInput => ({
  metrics: {
    pageCount: pages,
    paged: true,
    pageCountSource: "elements",
    truncated,
    elements: [...Array.from({ length: pages }, (_, k) => el("page", k + 1, { xMm: 0, yMm: 0, widthMm: 210, heightMm: 297 })), ...elements] as never,
  },
})
const fullPages = (n: number): El[] => Array.from({ length: n }, (_, k) => el("text", k + 1))

const diagramSpec = (): StudioDiagramV1 =>
  ({
    $schema: "studio.diagram/v1",
    family: "layered",
    id: "4.1",
    title: "Arus data uji.",
    classification: "BIASA",
    width_mm: 166,
    apparatus: "page",
    labels_verified: true,
    sources: ["Uji"],
    nodes: [
      { id: "a", label: "Sensor", class: { tier: 0 } },
      { id: "b", label: "Gerbang", class: { tier: 1 } },
      { id: "c", label: "Server", class: { tier: 2 } },
    ],
    edges: [
      { from: "a", to: "b", kind: "data", label: "suhu" },
      { from: "b", to: "c", kind: "data", label: "paket" },
    ],
  }) as unknown as StudioDiagramV1
const chartSpec = (): StudioChartV1 =>
  ({
    $schema: "studio.chart/v1",
    kind: "P-01",
    title: "Jam kerja uji.",
    source: "Uji.",
    widthMm: 128,
    data: { shape: "categorical", points: [0, 1, 2, 3].map((i) => ({ label: `Unit ${i + 1}`, value: 10 + i })) },
    unit: "jam",
    dec: 0,
  }) as unknown as StudioChartV1

const GOOD_DIAGRAM = buildDiagramSvg(diagramSpec(), { release: true }).svg
const GOOD_CHART = renderChart(chartSpec()).svg

/** B9 diagram: the engine's own SVG with its first label drawn a second time 0.5 mm lower (two labels on top of each other). */
function overlappingLabels(svg: string): string {
  const m = /<text\b[^>]*\by="([-\d.]+)"[^>]*>[^<]+<\/text>/.exec(svg)
  if (!m) throw new Error("fixture: no <text> in the diagram")
  const twin = m[0].replace(`y="${m[1]}"`, `y="${Number(m[1]) + 0.5}"`)
  return svg.replace(m[0], m[0] + twin)
}
/** B9 chart: one label moved far past the right edge of the viewBox. */
function labelOutside(svg: string): string {
  const m = /<text\b[^>]*\bx="([-\d.]+)"[^>]*>[^<]+<\/text>/.exec(svg)
  if (!m) throw new Error("fixture: no <text> in the chart")
  return svg.replace(m[0], m[0].replace(`x="${m[1]}"`, `x="${Number(m[1]) + 400}"`))
}

/** Studio HTML markup as the engine writes it (figure.ts:217-227 container; slots.ts:173-197 placeholders; shell CSS). */
const figureHtml = (type: string, graphic: string, address = "4.1"): string =>
  `<figure class="st-figure st-figure-${type}" data-address="${address}" data-block-id="blk-${address}" data-block-type="${type}" data-figure="Gambar ${address}" data-graphic-source="store" style="margin:0"><figcaption>Gambar ${address}</figcaption><div class="st-figure-graphic">${graphic}</div></figure>`
const MISSING_FIGURE = `<div class="st-figure-missing" style="display:flex">Gambar tidak tersedia: Gambar 4.2</div>`
const page = (inner: string): string =>
  `<!doctype html><html><head><style>:is(.st-p,.st-placeholder){margin:0}.st-slot-empty{border:1px dashed}</style></head><body><section class="page"><div class="body">${inner}</div><div class="reg">reg</div></section></body></html>`
const GOOD_HTML = page(`<p class="st-p" data-address="1.1" data-block="b1">Isi.</p>${figureHtml("diagram", GOOD_DIAGRAM)}${figureHtml("chart", GOOD_CHART, "4.2")}`)
const PLACEHOLDER_HTML = page(
  `<div class="st-unit st-slot st-slot-ringkasan st-slot-empty" data-slot-key="ringkasan" data-placeholder="true"><div class="st-placeholder" role="note" data-slot-key="ringkasan"><p>Ringkasan belum diisi.</p></div></div>`,
)

/** A DOCX package with one paragraph per entry; `placeholder` paragraphs get the engine's draft border (source-register.ts:33-34, :81-90). */
function docx(paras: Array<{ text: string; placeholder?: boolean }>): Uint8Array {
  const border = { val: "dashed", sz: 4, color: "B45309", space: 4 }
  const body = paras
    .map((p) => {
      const pPr = p.placeholder ? `<w:pPr><w:pBdr>${["top", "left", "bottom", "right"].map((s) => borderXml(s, border as never)).join("")}</w:pBdr></w:pPr>` : `<w:pPr><w:spacing w:after="120"/></w:pPr>`
      return `<w:p>${pPr}<w:r><w:t xml:space="preserve">${p.text}</w:t></w:r></w:p>`
    })
    .join("")
  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr/></w:body></w:document>`
  return zipSync({ "[Content_Types].xml": strToU8("<Types/>"), "word/document.xml": strToU8(xml) })
}

const COMPLETE_REPORT = JSON.stringify({ status: "COMPLETE", slots: [{ slotKey: "ringkasan", state: "FILLED", required: true }, { slotKey: "lampiran", state: "OPTIONAL_EMPTY", required: false }], missingRequired: [] })
const EMPTY_REPORT = JSON.stringify({ status: "INCOMPLETE", slots: [{ slotKey: "ringkasan", state: "EMPTY", required: true }, { slotKey: "bab", state: "PARTIAL", required: true }, { slotKey: "lampiran", state: "OPTIONAL_EMPTY", required: false }], missingRequired: ["ringkasan", "bab:3"] })

// ── matrix and shape ─────────────────────────────────────────────────────

describe("row 150: fixed matrix (spec §3.7) and the shared types file", () => {
  it("six checks in VerifyCheckId order; NOT_APPLICABLE exactly where §3.7 says", () => {
    expect(VERIFY_CHECK_ORDER).toEqual(["LINT", "OVERLAP_CLIP", "FIDELITY", "PAGE_COUNT", "FIGURE_FIT", "EMPTY_SLOTS"])
    const na = VERIFY_CHECK_ORDER.flatMap((id) => FORMATS.filter((f) => !isApplicable(id, f)).map((f) => `${id}:${f}`))
    expect(na).toEqual(["OVERLAP_CLIP:DOCX", "OVERLAP_CLIP:SVG", "OVERLAP_CLIP:PNG", "PAGE_COUNT:DOCX", "PAGE_COUNT:SVG", "PAGE_COUNT:PNG", "EMPTY_SLOTS:SVG", "EMPTY_SLOTS:PNG"])
    expect(VERIFY_MATRIX.FIGURE_FIT.PNG).toBe("same-job-svg")
    expect(VERIFY_MATRIX.FIDELITY.PDF).toBe("same-job-html")
  })
  it("types.ts is the spec §2 file (schema id, cap) and the checks reuse Rev A instead of copying it", () => {
    expect(OUTPUT_VERIFICATION_SCHEMA).toBe("studio.output-verification/v1")
    expect(VERIFY_FINDINGS_CAP).toBe(50)
    const src = readFileSync(path.join(import.meta.dir, "../../src/mcp-host/verify/static-checks.ts"), "utf8")
    for (const name of ["releaseFor", "lintRenderedWith", "lintDiagramGeometry", "lintChartGeometry", "countPdfPages"]) {
      expect(src).toMatch(new RegExp(`import \\{[^}]*\\b${name}\\b[^}]*\\} from "\\.\\./\\.\\./\\.\\./vendor/`))
      expect(src).not.toMatch(new RegExp(`function ${name}\\b`))
    }
  })
})

// ── LINT (§3.1) ──────────────────────────────────────────────────────────

describe("row 150: LINT", () => {
  it("PASS: stored report passes at the tier, verdict PASS", () => {
    const c = checkLint({ format: "PDF", lintReport: report("TERBIT", GOOD_TERBIT), lintVerdict: "PASS", tier: "TERBIT" })
    expect(c).toMatchObject({ id: "LINT", status: "PASS", basis: "revision-lint", reason: null, findings: [], truncated: 0 })
  })
  it("FAIL: each applicable FAIL check is a LINT_FAIL finding with its checkId and address", () => {
    const c = checkLint({ format: "HTML", lintReport: report("TERBIT", [...GOOD_TERBIT, issue("DATUM-37", "FAIL", "3.2"), issue("D01", "FAIL", "5.1")]), lintVerdict: "FAIL", tier: "TERBIT" })
    expect(c.status).toBe("FAIL")
    // D01 is SERAH-only (V/registry/lint.ts): not applicable at TERBIT, so not listed.
    // Row 206 (1.2.3, AC-4): the check id is the label; the detail is "<id>: <engine message>" (the id alone when none).
    expect(c.findings).toEqual([{ code: "LINT_FAIL", page: null, address: "3.2", label: "DATUM-37", detail: "DATUM-37: DATUM-37 FAIL" }])
  })
  it("the tier decides through releaseFor: a SERAH-only failure does not fail a TERBIT document", () => {
    const c = checkLint({ format: "DOCX", lintReport: report("TERBIT", [...GOOD_TERBIT, issue("D01", "FAIL")]), lintVerdict: "PASS", tier: "TERBIT" })
    expect(c.status).toBe("PASS")
    expect(checkLint({ format: "DOCX", lintReport: report("SERAH", [...GOOD_TERBIT, issue("D01", "FAIL")]), lintVerdict: "FAIL", tier: "SERAH" }).status).toBe("FAIL")
  })
  it("UNKNOWN LINT_NOT_RUN: no stored report, verdict PENDING / NOT_RUN, or nothing applicable ran", () => {
    expect(checkLint({ format: "PDF", lintReport: null, lintVerdict: "PASS", tier: "TERBIT" })).toMatchObject({ status: "UNKNOWN", reason: "LINT_NOT_RUN" })
    expect(checkLint({ format: "PDF", lintReport: report("TERBIT", GOOD_TERBIT), lintVerdict: "PENDING", tier: "TERBIT" })).toMatchObject({ status: "UNKNOWN", reason: "LINT_NOT_RUN" })
    expect(checkLint({ format: "PDF", lintReport: report("TERBIT", GOOD_TERBIT), lintVerdict: "NOT_RUN", tier: "TERBIT" })).toMatchObject({ status: "UNKNOWN", reason: "LINT_NOT_RUN" })
    expect(checkLint({ format: "PDF", lintReport: report("TERBIT", [issue("DATUM-37", "NOT_RUN")]), lintVerdict: "PASS", tier: "TERBIT" })).toMatchObject({ status: "UNKNOWN", reason: "LINT_NOT_RUN" })
    expect(checkLint({ format: "PDF", lintReport: "{not json", lintVerdict: "PASS", tier: "TERBIT" })).toMatchObject({ status: "UNKNOWN", reason: "LINT_NOT_RUN" })
  })
  it("UNKNOWN LINT_PARTIAL: an applicable render check NOT_RUN (HTML not measured, F2) is never a pass", () => {
    const checks = [issue("DATUM-37", "NOT_RUN"), issue("DATUM-33", "PASS"), issue("C-26b", "PASS")]
    expect(checkLint({ format: "PDF", lintReport: report("TERBIT", checks), lintVerdict: "PASS", tier: "TERBIT" })).toMatchObject({ status: "UNKNOWN", reason: "LINT_PARTIAL", findings: [] })
  })
  it("a FAIL outranks the NOT_RUN parts; parsed objects are read like stored JSON text", () => {
    const parsed = JSON.parse(report("TERBIT", [issue("DATUM-37", "NOT_RUN"), issue("C-26b", "FAIL")])) as unknown
    expect(checkLint({ format: "SVG", lintReport: parsed, lintVerdict: "FAIL", tier: "TERBIT" })).toMatchObject({ status: "FAIL", findings: [{ code: "LINT_FAIL", label: "C-26b", detail: "C-26b: C-26b FAIL" }] })
  })
  it("findings are capped at VERIFY_FINDINGS_CAP with the rest counted in `truncated`", () => {
    const many = Array.from({ length: 60 }, (_, k) => issue("DATUM-17", "FAIL", `9.${k}`))
    const c = checkLint({ format: "HTML", lintReport: report("TERBIT", many), lintVerdict: "FAIL", tier: "TERBIT" })
    expect(c.findings.length).toBe(50)
    expect(c.truncated).toBe(10)
  })
})

// ── PAGE_COUNT (§3.4) ────────────────────────────────────────────────────

describe("row 150: PAGE_COUNT", () => {
  it("PASS (PDF): 3 PDF pages, 3 sheets in the same-job paged HTML; pages[] = 1..3", () => {
    const r = checkPageCount({ format: "PDF", pdf: pdfOf(3), layout: paged(3, fullPages(3)) })
    expect(r.check).toMatchObject({ id: "PAGE_COUNT", status: "PASS", basis: "self", findings: [] })
    expect(r.pages).toEqual([1, 2, 3].map((n) => ({ n, png: null, findings: 0 })))
  })
  it("B7 FAIL: a 3-page PDF with a 2-page paged HTML is PAGE_COUNT_MISMATCH", () => {
    const r = checkPageCount({ format: "PDF", pdf: pdfOf(3), layout: paged(2, fullPages(2)) })
    expect(r.check.status).toBe("FAIL")
    expect(r.check.findings).toEqual([{ code: "PAGE_COUNT_MISMATCH", page: null, address: null, label: null, detail: "pdf 3 pages, same-job html 2 (paged: a sheet broke in print)", amount: 1 }])
  })
  it("FAIL NO_PAGES: a PDF with 0 pages, and an HTML layout with 0 pages", () => {
    expect(checkPageCount({ format: "PDF", pdf: pdfOf(0), layout: paged(0, []) }).check.findings.map((f) => f.code)).toEqual(["NO_PAGES"])
    expect(checkPageCount({ format: "HTML", layout: paged(0, []) }).check.findings.map((f) => f.code)).toEqual(["NO_PAGES"])
  })
  it("PASS (HTML paged) and FAIL BLANK_PAGE for a sheet with no text, figure, image or table", () => {
    expect(checkPageCount({ format: "HTML", layout: paged(2, [el("text", 1), el("table", 2)]) }).check.status).toBe("PASS")
    const r = checkPageCount({ format: "HTML", layout: paged(3, [el("text", 1), el("figure", 3)]) })
    expect(r.check.findings).toEqual([{ code: "BLANK_PAGE", page: 2, address: null, label: null, detail: "sheet 2 has no text, figure, image or table" }])
    expect(r.pages.map((p) => p.findings)).toEqual([0, 1, 0])
  })
  it("flow layout: the print count is the count; blank sheets are not judged (limit L-1)", () => {
    const flow: LayoutInput = { metrics: { pageCount: 4, paged: false, pageCountSource: "print", truncated: false, elements: [] } }
    const r = checkPageCount({ format: "HTML", layout: flow })
    expect(r.check.status).toBe("PASS")
    expect(r.pages.length).toBe(4)
  })
  it("UNKNOWN: bridge reason passed through, no same-job HTML, no print count, truncated metrics with an empty-looking sheet", () => {
    expect(checkPageCount({ format: "HTML", layout: { unknown: "BRIDGE_UNAVAILABLE" } }).check).toMatchObject({ status: "UNKNOWN", reason: "BRIDGE_UNAVAILABLE" })
    expect(checkPageCount({ format: "PDF", pdf: pdfOf(2), layout: { unknown: "QUEUE_FULL" } }).check).toMatchObject({ status: "UNKNOWN", reason: "QUEUE_FULL" })
    expect(checkPageCount({ format: "PDF", pdf: pdfOf(2), layout: null }).check).toMatchObject({ status: "UNKNOWN", reason: "SOURCE_MISSING" })
    expect(checkPageCount({ format: "PDF", pdf: null, layout: paged(2, fullPages(2)) }).check).toMatchObject({ status: "UNKNOWN", reason: "SOURCE_MISSING" })
    const none: LayoutInput = { metrics: { pageCount: 0, paged: false, pageCountSource: "none", truncated: false, elements: [] } }
    expect(checkPageCount({ format: "HTML", layout: none }).check).toMatchObject({ status: "UNKNOWN", reason: "BRIDGE_UNAVAILABLE" })
    expect(checkPageCount({ format: "HTML", layout: paged(2, [el("text", 1)], true) }).check).toMatchObject({ status: "UNKNOWN", reason: "MEASURE_TRUNCATED" })
  })
  it("a 0-page PDF fails even when the HTML count is unknown (FAIL outranks UNKNOWN)", () => {
    expect(checkPageCount({ format: "PDF", pdf: pdfOf(0), layout: { unknown: "TIMEOUT" } }).check.status).toBe("FAIL")
  })
  it("NOT_APPLICABLE for DOCX, SVG and PNG (matrix)", () => {
    for (const f of ["DOCX", "SVG", "PNG"] as const) expect(checkPageCount({ format: f, layout: null }).check).toMatchObject({ status: "NOT_APPLICABLE", findings: [] })
  })
})

// ── FIGURE_FIT (§3.5) ────────────────────────────────────────────────────

describe("row 150: FIGURE_FIT", () => {
  it("the engine's own diagram and chart are clean under the reused lints (G1 for the fixtures)", () => {
    expect(lintDiagramGeometry(GOOD_DIAGRAM).score).toBe(0)
    expect(checkFigureFit({ format: "SVG", svg: GOOD_DIAGRAM, figureKind: "diagram" })).toMatchObject({ status: "PASS", basis: "self", findings: [] })
    expect(checkFigureFit({ format: "PNG", svg: GOOD_CHART, figureKind: "chart" })).toMatchObject({ status: "PASS", basis: "same-job-svg", findings: [] })
  })
  it("PASS (HTML/PDF/DOCX): inline figures of the same-job HTML clean, figure heights within the text block", () => {
    const layout = paged(1, [el("text", 1), el("figure", 1, { address: "4.1", heightMm: 120 })])
    for (const format of ["HTML", "PDF", "DOCX"] as const) {
      expect(checkFigureFit({ format, html: GOOD_HTML, layout })).toMatchObject({ status: "PASS", basis: "same-job-html", findings: [] })
    }
  })
  it("B9 FAIL: two overlapping labels in a diagram are FIG_GEOMETRY textOverlap", () => {
    const c = checkFigureFit({ format: "SVG", svg: overlappingLabels(GOOD_DIAGRAM), figureKind: "diagram", figureLabel: "Gambar 4.1" })
    expect(c.status).toBe("FAIL")
    expect(c.findings[0]).toMatchObject({ code: "FIG_GEOMETRY", label: "Gambar 4.1" })
    expect(c.findings.some((f) => f.detail.startsWith("textOverlap: "))).toBe(true)
  })
  it("B9 FAIL: a chart label outside its canvas is a chart defect, found inside the same-job HTML too", () => {
    const bad = labelOutside(GOOD_CHART)
    const svg = checkFigureFit({ format: "PNG", svg: bad, figureKind: "chart" })
    expect(svg.status).toBe("FAIL")
    expect(svg.findings.some((f) => f.code === "FIG_GEOMETRY" && f.detail.startsWith("textOutside: "))).toBe(true)
    const html = checkFigureFit({ format: "PDF", html: page(figureHtml("chart", bad, "4.2")), layout: paged(1, [el("text", 1)]) })
    expect(html.status).toBe("FAIL")
    expect(html.findings[0]).toMatchObject({ code: "FIG_GEOMETRY", address: "4.2", label: "Gambar 4.2" })
  })
  it("FAIL FIG_TOO_TALL: DATUM-33 on the measured layout (figure taller than the text block), with page and mm", () => {
    const layout = paged(2, [el("text", 1), el("figure", 2, { address: "4.1", label: "Gambar 4.1", heightMm: 300 })])
    const c = checkFigureFit({ format: "HTML", html: GOOD_HTML, layout })
    expect(c.status).toBe("FAIL")
    expect(c.findings).toEqual([{ code: "FIG_TOO_TALL", page: 2, address: "4.1", label: "Gambar 4.1", detail: "DATUM-33", amount: 300 }])
  })
  // 1.2.6 row 26 (T-03 INTENT, N-007): the three connector-end kinds join the fail set, 6 -> 9.
  it("diagram edgeCross / edgeCollinear are report-only; the other nine kinds fail (spec §3.5, T-03)", () => {
    expect([...DIAGRAM_FAIL_KINDS].sort()).toEqual(["arrowTangent", "edgeEntryCollision", "edgeThroughNode", "lineThroughText", "stubSegment", "textExceedsNode", "textOutside", "textOverNode", "textOverlap"])
  })
  it("engine fit notes CAPTION_WRAP / CAPTION_TRUNCATED fail FIGURE_FIT (1.2.6 row 28, T-01 INTENT, N-015)", () => {
    expect([...FIGURE_FIT_FAIL_NOTES].sort()).toEqual(["CAPTION_TRUNCATED", "CAPTION_WRAP"])
  })
  it("UNKNOWN: no same-job HTML / SVG, layout not measured, unknown figure kind, unparsable SVG", () => {
    expect(checkFigureFit({ format: "PDF", html: null, layout: paged(1, []) })).toMatchObject({ status: "UNKNOWN", reason: "SOURCE_MISSING" })
    expect(checkFigureFit({ format: "HTML", html: GOOD_HTML, layout: { unknown: "TIMEOUT" } })).toMatchObject({ status: "UNKNOWN", reason: "TIMEOUT" })
    expect(checkFigureFit({ format: "DOCX", html: GOOD_HTML, layout: null })).toMatchObject({ status: "UNKNOWN", reason: "SOURCE_MISSING" })
    expect(checkFigureFit({ format: "PNG", svg: null, figureKind: "chart" })).toMatchObject({ status: "UNKNOWN", reason: "SOURCE_MISSING" })
    expect(checkFigureFit({ format: "SVG", svg: GOOD_CHART, figureKind: null })).toMatchObject({ status: "UNKNOWN", reason: "NO_GEOMETRY_LINT" })
    expect(checkFigureFit({ format: "SVG", svg: "<svg", figureKind: "diagram" })).toMatchObject({ status: "UNKNOWN", reason: "PARSE_FAILED" })
    expect(checkFigureFit({ format: "PNG", svg: "<svg></svg>", figureKind: "chart" })).toMatchObject({ status: "UNKNOWN", reason: "PARSE_FAILED" })
  })
  it("a geometry FAIL is still reported when the height part could not be measured", () => {
    const c = checkFigureFit({ format: "HTML", html: page(figureHtml("diagram", overlappingLabels(GOOD_DIAGRAM))), layout: { unknown: "BRIDGE_UNAVAILABLE" } })
    expect(c.status).toBe("FAIL")
  })
  it("symbolSheet decision (spec §3.5, row 150c / C144 A): engine symbol sheets lint clean and get a measured verdict", () => {
    // Row 150c fixed the overlapping note lines and cell labels (symbols/index.ts) and the lint now reads
    // cell labels in translate-only data-symbol cells; every dialect, unfitted and fitted, lints 0.
    for (const d of SYMBOL_DIALECTS) {
      for (const fit of [false, true]) {
        expect(lintDiagramGeometry(symbolSheetSvg(d, undefined, { fit })[0]).defects).toEqual([])
      }
    }
    const sheet = symbolSheetSvg("iec", undefined, {})[0]
    expect(checkFigureFit({ format: "SVG", svg: sheet, figureKind: "symbolSheet" })).toMatchObject({ status: "PASS", findings: [] })
    expect(checkFigureFit({ format: "HTML", html: page(figureHtml("symbolSheet", sheet)), layout: paged(1, [el("figure", 1)]) })).toMatchObject({ status: "PASS" })
    // A real collision in a sheet cell (the pre-150c HS cell labels: 6 mm id over 5 mm subtitle, 3.6 mm apart) fails.
    const bad = sheet.replace(
      /(data-symbol="iec:battery">[\s\S]*?)<text [^>]*>iec:battery<\/text><text [^>]*>geometri konvensional<\/text>/,
      (_, cell: string) =>
        `${cell}<text x="26" y="28" font-family="IBM Plex Sans Condensed" font-size="6" font-weight="600" text-anchor="middle">iec:battery</text>` +
        `<text x="26" y="31.6" font-family="IBM Plex Sans Condensed" font-size="5" text-anchor="middle">geometri konvensional</text>`,
    )
    expect(bad).not.toBe(sheet)
    const c = checkFigureFit({ format: "SVG", svg: bad, figureKind: "symbolSheet" })
    expect(c.status).toBe("FAIL")
    expect(c.findings.some((f) => f.code === "FIG_GEOMETRY" && /^textOverlap: iec:battery/.test(f.detail ?? ""))).toBe(true)
  })
})

// ── EMPTY_SLOTS (§3.6) ───────────────────────────────────────────────────

describe("row 150: EMPTY_SLOTS", () => {
  it("PASS: complete revision, no placeholder in HTML / PDF (same-job HTML) / DOCX; CSS selectors are not elements", () => {
    expect(GOOD_HTML).toContain(".st-placeholder")
    for (const format of ["HTML", "PDF"] as const) {
      expect(checkEmptySlots({ format, completeness: "COMPLETE", completenessReport: COMPLETE_REPORT, html: GOOD_HTML })).toMatchObject({ status: "PASS", findings: [] })
    }
    expect(checkEmptySlots({ format: "DOCX", completeness: "COMPLETE", completenessReport: COMPLETE_REPORT, docx: docx([{ text: "Isi." }]) })).toMatchObject({ status: "PASS", basis: "self" })
    // v1 / work report: no report, the revision part passes on COMPLETE.
    expect(checkEmptySlots({ format: "HTML", completeness: "COMPLETE", completenessReport: null, html: GOOD_HTML }).status).toBe("PASS")
  })
  it("B8 FAIL SLOT_EMPTY: a required slot EMPTY or PARTIAL in the revision report (optional slots ignored)", () => {
    const c = checkEmptySlots({ format: "HTML", completeness: "INCOMPLETE", completenessReport: EMPTY_REPORT, html: GOOD_HTML })
    expect(c.status).toBe("FAIL")
    expect(c.findings.map((f) => [f.code, f.label, f.detail])).toEqual([
      ["SLOT_EMPTY", "ringkasan", "EMPTY"],
      ["SLOT_EMPTY", "bab", "PARTIAL"],
    ])
  })
  it("FAIL SLOT_EMPTY: INCOMPLETE revision without a report (or with no open slot listed)", () => {
    expect(checkEmptySlots({ format: "HTML", completeness: "INCOMPLETE", completenessReport: null, html: GOOD_HTML }).findings).toEqual([
      { code: "SLOT_EMPTY", page: null, address: null, label: null, detail: "revision completeness INCOMPLETE" },
    ])
    const listedOnlyMissing = JSON.stringify({ status: "INCOMPLETE", slots: [], missingRequired: ["bab:2"] })
    expect(checkEmptySlots({ format: "HTML", completeness: "INCOMPLETE", completenessReport: listedOnlyMissing, html: GOOD_HTML }).findings.map((f) => f.label)).toEqual(["bab:2"])
  })
  it("B8 FAIL PLACEHOLDER_IN_OUTPUT: a draft placeholder unit is one finding per slot, in HTML and through a PDF's same-job HTML", () => {
    for (const format of ["HTML", "PDF"] as const) {
      const c = checkEmptySlots({ format, completeness: "COMPLETE", completenessReport: COMPLETE_REPORT, html: PLACEHOLDER_HTML })
      expect(c.status).toBe("FAIL")
      expect(c.findings).toEqual([{ code: "PLACEHOLDER_IN_OUTPUT", page: null, address: null, label: "ringkasan", detail: "both" }])
      expect(c.basis).toBe(format === "HTML" ? "self" : "same-job-html")
    }
  })
  it("FAIL FIGURE_PLACEHOLDER: a figure block with no svg or img (the labelled placeholder of figure.ts)", () => {
    const html = page(figureHtml("diagram", MISSING_FIGURE, "4.2").replace('data-graphic-source="store"', 'data-graphic-source="missing"'))
    const c = checkEmptySlots({ format: "HTML", completeness: "COMPLETE", completenessReport: COMPLETE_REPORT, html })
    expect(c.findings).toEqual([{ code: "FIGURE_PLACEHOLDER", page: null, address: "4.2", label: "Gambar 4.2", detail: "diagram figure has no svg or img (missing)" }])
  })
  it("FAIL PLACEHOLDER_IN_OUTPUT (DOCX): the dashed B45309 paragraph border written by the engine's own borderXml", () => {
    const c = checkEmptySlots({ format: "DOCX", completeness: "COMPLETE", completenessReport: COMPLETE_REPORT, docx: docx([{ text: "Isi." }, { text: "Ringkasan belum diisi.", placeholder: true }]) })
    expect(c.status).toBe("FAIL")
    expect(c.findings).toEqual([{ code: "PLACEHOLDER_IN_OUTPUT", page: null, address: null, label: "Ringkasan belum diisi.", detail: "docx paragraph 2 has the draft placeholder border" }])
  })
  it("UNKNOWN: PDF without same-job HTML (SOURCE_MISSING), DOCX that is not a package (PARSE_FAILED)", () => {
    expect(checkEmptySlots({ format: "PDF", completeness: "COMPLETE", completenessReport: COMPLETE_REPORT, html: null })).toMatchObject({ status: "UNKNOWN", reason: "SOURCE_MISSING" })
    expect(checkEmptySlots({ format: "DOCX", completeness: "COMPLETE", completenessReport: COMPLETE_REPORT, docx: strToU8("not a zip") })).toMatchObject({ status: "UNKNOWN", reason: "PARSE_FAILED" })
    expect(checkEmptySlots({ format: "DOCX", completeness: "COMPLETE", completenessReport: COMPLETE_REPORT, docx: zipSync({ "a.txt": strToU8("x") }) })).toMatchObject({ status: "UNKNOWN", reason: "PARSE_FAILED" })
  })
  it("the revision part still FAILs when the output part is UNKNOWN", () => {
    expect(checkEmptySlots({ format: "PDF", completeness: "INCOMPLETE", completenessReport: EMPTY_REPORT, html: null }).status).toBe("FAIL")
  })
  it("NOT_APPLICABLE for SVG and PNG (matrix)", () => {
    for (const f of ["SVG", "PNG"] as const) expect(checkEmptySlots({ format: f, completeness: "INCOMPLETE", completenessReport: EMPTY_REPORT })).toMatchObject({ status: "NOT_APPLICABLE" })
  })
})

// ── scans and composition ───────────────────────────────────────────────

describe("row 150: scans and runStaticChecks", () => {
  it("document-derived strings are cut to SCAN_TEXT_MAX (untrusted, report size)", () => {
    const long = "x".repeat(500)
    const ph = findHtmlPlaceholders(page(`<div class="st-placeholder" data-slot-key="${long}"></div>`))
    expect(ph[0].slotKey?.length).toBe(500)
    const c = checkEmptySlots({ format: "HTML", completeness: "COMPLETE", completenessReport: null, html: page(`<div class="st-placeholder" data-slot-key="${long}"></div>`) })
    expect(c.findings[0].label?.length).toBe(SCAN_TEXT_MAX)
    expect(findDocxPlaceholders(`<w:body><w:p><w:pPr><w:pBdr><w:top w:val="dashed" w:sz="4" w:space="4" w:color="b45309"/></w:pBdr></w:pPr><w:r><w:t>${long}</w:t></w:r></w:p></w:body>`)[0].text?.length).toBe(SCAN_TEXT_MAX)
  })
  it("figure scan reads the engine container attributes and every inline svg", () => {
    expect(findHtmlFigures(GOOD_HTML).map((f) => [f.type, f.address, f.label, f.svgs.length, f.hasImg])).toEqual([
      ["diagram", "4.1", "Gambar 4.1", 1, false],
      ["chart", "4.2", "Gambar 4.2", 1, false],
    ])
  })
  it("runStaticChecks: a good PDF gives four PASS checks; a broken one names each failing check", () => {
    const good = runStaticChecks({
      format: "PDF",
      lint: { lintReport: report("TERBIT", GOOD_TERBIT), lintVerdict: "PASS", tier: "TERBIT" },
      completeness: { completeness: "COMPLETE", completenessReport: COMPLETE_REPORT },
      html: GOOD_HTML,
      bytes: pdfOf(1),
      layout: paged(1, [el("text", 1), el("figure", 1, { address: "4.1", heightMm: 100 })]),
    })
    expect(Object.values(good.checks).map((c) => `${c!.id}:${c!.status}`)).toEqual(["LINT:PASS", "PAGE_COUNT:PASS", "FIGURE_FIT:PASS", "EMPTY_SLOTS:PASS"])
    expect(good.pages).toEqual([{ n: 1, png: null, findings: 0 }])
    const bad = runStaticChecks({
      format: "PDF",
      lint: { lintReport: report("TERBIT", [issue("DATUM-37", "FAIL")]), lintVerdict: "FAIL", tier: "TERBIT" },
      completeness: { completeness: "INCOMPLETE", completenessReport: EMPTY_REPORT },
      html: page(figureHtml("diagram", overlappingLabels(GOOD_DIAGRAM))),
      bytes: pdfOf(3),
      layout: paged(2, fullPages(2)),
    })
    expect(Object.values(bad.checks).map((c) => `${c!.id}:${c!.status}`)).toEqual(["LINT:FAIL", "PAGE_COUNT:FAIL", "FIGURE_FIT:FAIL", "EMPTY_SLOTS:FAIL"])
  })
  it("runStaticChecks without a layout: every bridge-dependent part is UNKNOWN, never PASS (B10 at unit level)", () => {
    const r = runStaticChecks({
      format: "HTML",
      lint: { lintReport: report("TERBIT", GOOD_TERBIT), lintVerdict: "PASS", tier: "TERBIT" },
      completeness: { completeness: "COMPLETE", completenessReport: COMPLETE_REPORT },
      html: GOOD_HTML,
    })
    expect(r.checks.PAGE_COUNT).toMatchObject({ status: "UNKNOWN", reason: "BRIDGE_UNAVAILABLE" })
    expect(r.checks.FIGURE_FIT).toMatchObject({ status: "UNKNOWN", reason: "BRIDGE_UNAVAILABLE" })
    expect(r.checks.LINT!.status).toBe("PASS")
    expect(r.checks.EMPTY_SLOTS!.status).toBe("PASS")
  })
})
