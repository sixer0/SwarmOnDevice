/**
 * Swarm 1.2.6 row FX-11 (decision C21, finding S-115-1): parity between the figure preview (the machine gate under
 * C19a) and the render FIGURE_FIT static check. The T-03 kinds (`edgeEntryCollision`, `stubSegment`, `arrowTangent`)
 * are not in the auto-fit `score` (row 25, U3: no re-layout of existing figures), so a diagram whose only defects
 * are T-03 kinds took the score-0 early return in `autoFitDiagram` and its preview listed no T-03 defect, while
 * FIGURE_FIT failed the same SVG. Now the early return keeps the SVG and the auto-fit decision unchanged and still
 * reports the T-03 kinds (GEOM_* REPORT lines), which the preview classes as defects.
 *
 * Fixtures: synthetic legacy flows written here (no document text) and the anonymised anon126 F1 SVGs.
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { autoFitDiagram } from "@/lib/studio/engine/diagram/build/autofit"
import { lintDiagramGeometry, type DiagramDefectKind } from "@/lib/studio/engine/diagram/fit/lint"
import type { DiagramSvgResult } from "@/lib/studio/engine/diagram/build/svg"
import { checkFigureFit, DIAGRAM_FAIL_KINDS } from "../../src/mcp-host/verify/static-checks"
import { renderResolved, splitPreviewIssues } from "../../src/mcp-host/local-api/routes/figure-preview-figure"

/** GEOM_* check id per defect kind (autofit.ts CHECK, register names). */
const CHECK: Record<DiagramDefectKind, string> = {
  textOverlap: "GEOM_TEXT_OVERLAP",
  textOutside: "GEOM_TEXT_OUTSIDE",
  lineThroughText: "GEOM_LINE_TEXT",
  textOverNode: "GEOM_TEXT_NODE",
  textExceedsNode: "GEOM_LABEL_OVERFLOW",
  edgeCross: "GEOM_EDGE_CROSS",
  edgeCollinear: "GEOM_EDGE_COLLINEAR",
  edgeThroughNode: "GEOM_EDGE_NODE",
  edgeEntryCollision: "GEOM_ENTRY_COLLISION",
  stubSegment: "GEOM_STUB_SEGMENT",
  arrowTangent: "GEOM_ARROW_TANGENT",
  labelCollision: "GEOM_LABEL_COLLISION", // row 57c: new kind (INTENT, the record covers every kind)
  frameOutside: "GEOM_FRAME_OUTSIDE", // row 55c: new kind (INTENT, the record covers every kind)
  edgeOutside: "GEOM_EDGE_OUTSIDE", // row 68a: new kind (INTENT, the record covers every kind)
  edgeEndOffNode: "GEOM_EDGE_END", // row 68a: new kind (INTENT, the record covers every kind)
}
const T03: readonly DiagramDefectKind[] = ["edgeEntryCollision", "stubSegment", "arrowTangent"]

/** Kinds the render FIGURE_FIT check FAILS on for this SVG (SVG format, as the render's per-figure check). */
function gateFailKinds(svg: string): string[] {
  const c = checkFigureFit({ format: "SVG", svg, figureKind: "diagram", figureLabel: "Gambar 1.1" })
  const kinds = c.findings.filter((f) => f.code === "FIG_GEOMETRY").map((f) => (f.detail ?? "").split(":")[0])
  return [...new Set(kinds.filter((k) => DIAGRAM_FAIL_KINDS.has(k as DiagramDefectKind)))].sort()
}
const checkIdsOf = (xs: ReadonlyArray<{ checkId: string }>) => new Set(xs.map((x) => x.checkId))

// ── synthetic legacy flows (no `direction`): only T-03 defects, lint score 0 -> the early-return case ──────────
const BASE = { $schema: "studio.diagram/v1", id: "1.1", title: "Alur uji sintetis.", classification: "TERBATAS", width_mm: 166, sources: ["Sintetis"] }
const N = (id: string, label: string) => ({ id, label, class: {} })
const E = (from: string, to: string, label = "data") => ({ from, to, kind: "data", label })
const SYNTH: Record<string, Record<string, unknown>> = {
  branch_merge: { family: "flow", nodes: [N("a", "Mulai"), N("b", "Periksa"), N("c", "Setuju"), N("d", "Tolak"), N("e", "Selesai")], edges: [E("a", "b"), E("b", "c", "ya"), E("b", "d", "tidak"), E("c", "e"), E("d", "e")] },
  skip_edge: { family: "flow", nodes: [N("a", "Masuk"), N("b", "Validasi"), N("c", "Simpan"), N("d", "Kirim")], edges: [E("a", "b"), E("b", "c"), E("c", "d"), E("b", "d", "lewati")] },
  loop_back: { family: "flow", nodes: [N("a", "Permintaan"), N("b", "Telaah"), N("c", "Revisi"), N("d", "Terbit")], edges: [E("a", "b"), E("b", "c", "kurang"), E("c", "b", "ulang"), E("b", "d", "lengkap")] },
}
const preview = (spec: Record<string, unknown>) =>
  renderResolved({ block: { blockId: "fx11", address: "1.1", type: "diagram", content: {} } as never, type: "diagram", spec: { ...BASE, ...spec } as never }, { params: {} } as never, { inline: true, withSvg: true, lang: "ID" })

describe("FX-11: preview of a diagram whose only defects are T-03 kinds (score-0 early return)", () => {
  for (const [name, spec] of Object.entries(SYNTH)) {
    test(`${name}: lint score 0, FIGURE_FIT fails on a T-03 kind, and the preview lists that kind as a defect`, async () => {
      const p = await preview(spec)
      const g = lintDiagramGeometry(p.svg!)
      expect(g.score).toBe(0) // the early-return case (auto-fit untouched)
      const failing = gateFailKinds(p.svg!)
      expect(failing.length).toBeGreaterThan(0)
      expect(failing.every((k) => (T03 as readonly string[]).includes(k))).toBe(true)
      const defects = checkIdsOf(p.defects)
      for (const k of failing) expect([k, defects.has(CHECK[k as DiagramDefectKind])]).toEqual([k, true])
      expect(p.layoutIssueCount).toBeGreaterThan(0)
    })
  }
})

// ── early return keeps the figure: same SVG object bytes, no re-render, no AUTO_FIT line ──────────────────────
const svgOf = (body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 80">\n<rect x="0" y="0" width="100" height="80" fill="#FCFCFB"/>\n${body}\n</svg>`
const link = (d: string) => `<path d="${d}" fill="none" stroke="#101418" stroke-width="0.45" marker-end="url(#head-data)" data-mark="link"/>`
const box = (id: string, x: number, y: number, w: number, h: number) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" data-node="${id}" fill="none" stroke="#2B3640" stroke-width="0.45" data-mark="node"/>`
const SVG_CASES: Record<string, string> = {
  edgeEntryCollision: svgOf([link("M 30 10 L 30 50"), link("M 31 10 L 31 50"), box("n1", 20, 50, 30, 10)].join("\n")),
  stubSegment: svgOf([box("a", 20, 5, 20, 10), link("M 30 15 L 30 30 L 31 30 L 31 50"), box("b", 21, 50, 20, 10)].join("\n")),
  arrowTangent: svgOf([link("M 40 70 L 40 25"), box("n1", 40, 20, 30, 10)].join("\n")),
}
const resultOf = (svg: string): DiagramSvgResult => ({ svg, widthMm: 100, heightMm: 80, report: { checksRun: [], issues: [] } }) as unknown as DiagramSvgResult
const noRerender = () => {
  throw new Error("rerender must not run on the score-0 path")
}

describe("FX-11: autoFitDiagram score-0 path reports T-03 kinds without re-rendering", () => {
  for (const [kind, svg] of Object.entries(SVG_CASES)) {
    test(`${kind}: SVG kept byte for byte, ${CHECK[kind as DiagramDefectKind]} REPORT line present, no AUTO_FIT`, () => {
      expect(lintDiagramGeometry(svg).score).toBe(0)
      const first = resultOf(svg)
      const out = autoFitDiagram(first, noRerender)
      expect(out.svg).toBe(svg)
      const geo = (out.report as { geometry?: Array<{ checkId: string; status: string }> }).geometry ?? []
      expect(geo.map((g) => g.checkId)).toContain(CHECK[kind as DiagramDefectKind])
      expect(geo.every((g) => g.status === "REPORT")).toBe(true)
      expect(geo.map((g) => g.checkId)).not.toContain("AUTO_FIT")
      expect(splitPreviewIssues(geo).defects.map((d) => d.checkId)).toContain(CHECK[kind as DiagramDefectKind])
    })
  }
  test("a clean render is returned as is (same object)", () => {
    const clean = resultOf(svgOf([box("a", 20, 5, 20, 10), link("M 30 15 L 30 50"), box("b", 20, 50, 20, 10)].join("\n")))
    expect(autoFitDiagram(clean, noRerender)).toBe(clean)
  })
})

// ── parity: preview defects ⊇ render FIGURE_FIT fail kinds (anon126 F1 + negative controls + synthetic) ──────
const FIX = path.join(import.meta.dir, "..", "fixtures", "anon126")
const F1 = ["t03_k1", "t03_k2", "t03_k3", "t03_k4", "t03_k5", "t03_k6", "t03_k7", "t03_n1", "t03_n2"]

/** The preview defect list the engine path yields for this SVG as a first render (autofit -> report.geometry -> split). */
function previewDefectIds(svg: string): Set<string> {
  const g0 = lintDiagramGeometry(svg)
  // A figure with layout defects (score > 0) re-renders; here the rerender is the same SVG, so the first render is kept.
  const out = autoFitDiagram(resultOf(svg), () => resultOf(svg))
  expect(g0.score === 0 ? out.svg === svg : true).toBe(true)
  const geo = ((out.report as { geometry?: Array<{ checkId: string; status: string }> }).geometry ?? []).filter((i) => i.status !== "PASS")
  return checkIdsOf(splitPreviewIssues(geo).defects)
}

describe("FX-11 parity: preview.defects ⊇ FIGURE_FIT fail kinds", () => {
  for (const name of F1) {
    test(`anon126 ${name}`, () => {
      const svg = readFileSync(path.join(FIX, `${name}.svg`), "utf8")
      const failing = gateFailKinds(svg)
      const defects = previewDefectIds(svg)
      for (const k of failing) expect([name, k, defects.has(CHECK[k as DiagramDefectKind])]).toEqual([name, k, true])
    })
  }
  for (const [kind, svg] of Object.entries(SVG_CASES)) {
    test(`synthetic SVG ${kind}`, () => {
      const failing = gateFailKinds(svg)
      expect(failing).toContain(kind)
      const defects = previewDefectIds(svg)
      for (const k of failing) expect([k, defects.has(CHECK[k as DiagramDefectKind])]).toEqual([k, true])
    })
  }
  for (const [name, spec] of Object.entries(SYNTH)) {
    test(`synthetic flow ${name} through the preview route`, async () => {
      const p = await preview(spec)
      const failing = gateFailKinds(p.svg!)
      const defects = checkIdsOf(p.defects)
      for (const k of failing) expect([name, k, defects.has(CHECK[k as DiagramDefectKind])]).toEqual([name, k, true])
    })
  }
})
