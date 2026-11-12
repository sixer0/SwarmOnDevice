// Swarm 1.2.6 row 28 (T-01 gate part, register N-014/N-015, decision U3): a figure whose caption the engine had to
// wrap (CAPTION_WRAP) or cut with an ellipsis (CAPTION_TRUNCATED) FAILS the FIGURE_FIT output check, and the
// finding cites the numeric caption guide limit CAPTION_GUIDE_MAX_CHARS = 100. The same figure with a short
// caption still passes. Namespace imports keep the BASE run an assertion failure (class A), not a missing export.
import { describe, expect, it } from "bun:test"
import { useStudioEnv } from "../ported/_env"
import type { StudioChartV1, StudioDiagramV1 } from "@/lib/studio/contract"
import { renderChart } from "@/lib/studio/engine/chart/core"
import { buildDiagramSvg } from "@/lib/studio/engine/diagram/build"
import * as SC from "../../src/mcp-host/verify/static-checks"
import * as FB from "@/lib/studio/contract/schema/figure-bounds"

useStudioEnv()

const LIMIT = String((FB as Record<string, unknown>).CAPTION_GUIDE_MAX_CHARS ?? 100)
const SHORT = "Arus data uji."
const LONG =
  "Perbandingan realisasi dan target anggaran pemeliharaan infrastruktur jaringan menurut satuan kerja perangkat daerah selama tiga tahun anggaran terakhir."
const VERY_LONG = `${LONG} ${LONG} ${LONG}`

const diagram = (title: string, apparatus = "figure"): string =>
  buildDiagramSvg(
    {
      $schema: "studio.diagram/v1",
      family: "layered",
      id: "4.1",
      title,
      classification: "BIASA",
      width_mm: 128,
      apparatus,
      labels_verified: true,
      sources: ["Uji"],
      nodes: [
        { id: "a", label: "Sensor", class: { tier: 0 } },
        { id: "b", label: "Gerbang", class: { tier: 1 } },
      ],
      edges: [{ from: "a", to: "b", kind: "data", label: "suhu" }],
    } as unknown as StudioDiagramV1,
    { release: true },
  ).svg

const chart = (title: string, apparatus = "figure") =>
  renderChart({
    $schema: "studio.chart/v1",
    kind: "P-01",
    apparatus,
    id: "Gambar 8.12",
    title,
    source: "Uji.",
    widthMm: 128,
    data: { shape: "categorical", points: [0, 1, 2].map((i) => ({ label: `Unit ${i + 1}`, value: 10 + i })) },
    unit: "jam",
    dec: 0,
  } as unknown as StudioChartV1)

const page = (body: string) => `<!doctype html><html><body>${body}</body></html>`
const figureHtml = (type: string, svg: string, address = "4.1") =>
  `<figure data-block-type="${type}" data-address="${address}" data-figure="Gambar ${address}" data-graphic-source="engine">${svg}</figure>`
const oneFigurePage = {
  metrics: {
    pageCount: 1,
    paged: true,
    pageCountSource: "elements",
    truncated: false,
    elements: [
      { kind: "page", page: 1, xMm: 0, yMm: 0, widthMm: 210, heightMm: 297 },
      { kind: "figure", page: 1, xMm: 20, yMm: 30, widthMm: 128, heightMm: 60 },
    ],
  },
} as unknown as SC.LayoutInput

describe("row 28 T-01: CAPTION_WRAP / CAPTION_TRUNCATED fail FIGURE_FIT", () => {
  it("FIGURE_FIT_FAIL_NOTES is exactly {CAPTION_WRAP, CAPTION_TRUNCATED} (N-015)", () => {
    const set = (SC as Record<string, unknown>).FIGURE_FIT_FAIL_NOTES as ReadonlySet<string> | undefined
    expect(set instanceof Set).toBe(true)
    expect([...(set ?? [])].sort()).toEqual(["CAPTION_TRUNCATED", "CAPTION_WRAP"])
  })

  it("diagram (apparatus figure) with a wrapped caption: SVG FAIL CAPTION_WRAP citing 100", () => {
    const c = SC.checkFigureFit({ format: "SVG", svg: diagram(LONG), figureKind: "diagram", figureLabel: "Gambar 4.1" })
    expect(c.status).toBe("FAIL")
    const f = c.findings.find((x) => x.code === "CAPTION_WRAP")
    expect(f).toBeDefined()
    expect(f!.label).toBe("Gambar 4.1")
    expect(f!.detail).toContain(LIMIT)
    expect(f!.detail).toContain("CAPTION_GUIDE_MAX_CHARS")
    expect(f!.amount).toBe(2)
  })

  it("chart (apparatus figure) with a wrapped caption: PNG FAIL CAPTION_WRAP citing 100; the engine still notes it", () => {
    const r = chart(LONG)
    expect(r.report.issues.map((i) => i.checkId)).toContain("CAPTION_WRAP")
    const c = SC.checkFigureFit({ format: "PNG", svg: r.svg, figureKind: "chart" })
    expect(c.status).toBe("FAIL")
    const f = c.findings.find((x) => x.code === "CAPTION_WRAP")
    expect(f).toBeDefined()
    expect(f!.detail).toContain(LIMIT)
  })

  it("chart caption cut with an ellipsis: FAIL CAPTION_TRUNCATED citing 100 (beside CAPTION_WRAP)", () => {
    const r = chart(VERY_LONG)
    expect(r.report.issues.map((i) => i.checkId)).toContain("CAPTION_TRUNCATED")
    const c = SC.checkFigureFit({ format: "SVG", svg: r.svg, figureKind: "chart" })
    expect(c.status).toBe("FAIL")
    const codes = c.findings.map((x) => x.code)
    expect(codes).toContain("CAPTION_TRUNCATED")
    expect(codes).toContain("CAPTION_WRAP")
    expect(c.findings.find((x) => x.code === "CAPTION_TRUNCATED")!.detail).toContain(LIMIT)
  })

  it("the same-job HTML of a document fails on a wrapped figure caption inside the inline SVG", () => {
    for (const format of ["HTML", "PDF", "DOCX"] as const) {
      const c = SC.checkFigureFit({ format, html: page(figureHtml("chart", chart(LONG).svg)), layout: oneFigurePage })
      expect(c.status).toBe("FAIL")
      expect(c.findings.find((x) => x.code === "CAPTION_WRAP")).toMatchObject({ address: "4.1", label: "Gambar 4.1" })
    }
  })

  it("controls: one-line captions and page-apparatus figures pass with no caption finding", () => {
    expect(SC.checkFigureFit({ format: "SVG", svg: diagram(SHORT), figureKind: "diagram" })).toMatchObject({ status: "PASS", findings: [] })
    expect(SC.checkFigureFit({ format: "PNG", svg: chart(SHORT).svg, figureKind: "chart" })).toMatchObject({ status: "PASS", findings: [] })
    expect(SC.checkFigureFit({ format: "SVG", svg: diagram(LONG, "page"), figureKind: "diagram" })).toMatchObject({ status: "PASS", findings: [] })
    expect(SC.checkFigureFit({ format: "SVG", svg: chart(LONG, "page").svg, figureKind: "chart" })).toMatchObject({ status: "PASS", findings: [] })
    expect(SC.checkFigureFit({ format: "HTML", html: page(figureHtml("chart", chart(SHORT).svg)), layout: oneFigurePage })).toMatchObject({ status: "PASS" })
  })
})
