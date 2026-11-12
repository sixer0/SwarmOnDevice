// Swarm 1.2.6 row 66 (T-10, register N-030, R12): the left label gutter of a bar chart is capped
// at LABEL_GUTTER_CAP_FRAC = 0.30 of the plot width W (38.4 mm at 128 mm), replacing the inline
// 0.42 (53.76 mm). A longer label wraps or is cut with an ellipsis and keeps its full text in
// <title>; a given labelShort is drawn in the gutter with the full label in <title>.
// Before (e363918a69): a 37-character label gave a 48.1 mm gutter (gallery) and 45.9 mm (datum).
// Fixture labels are filler text written for this test (01g G2/G3), not real data.
import { describe, expect, test } from "bun:test"
import { useStudioEnv } from "../ported/_env"
useStudioEnv()
import type { StudioChartV1 } from "../../vendor/src/lib/studio/contract"
import { renderChart } from "../../vendor/src/lib/studio/engine/chart/core"

const W = 128
const CAP_MM = 0.3 * W // 38.4 mm
const OLD_CAP_MM = 0.42 * W // 53.76 mm
const LONG = "PENGAWASANKOORDINASIOPERASIONAL TIMUR" // 37 characters
const LONG_B = "KOORDINASIPENGAWASANOPERASIONAL BARAT" // 37 characters

function spec(style: "datum" | "gallery", labels: string[], extra: Record<string, unknown> = {}): StudioChartV1 {
  return {
    kind: "P-01",
    widthMm: W,
    style,
    title: "Uji.",
    source: "Data uji sintetis.",
    data: { shape: "categorical", points: labels.map((label, i) => ({ label, value: 5 - i })) },
    unit: "unit",
    dec: 0,
    ...extra,
  } as unknown as StudioChartV1
}

/** The gutter is where the bars start: every bar rect has the same x. */
function gutterMm(svg: string): number {
  const xs = [...svg.matchAll(/<rect\b[^>]*data-mark="bar"[^>]*>/g)].map((m) => Number(/\sx="([-0-9.]+)"/.exec(m[0])![1]))
  expect(xs.length).toBeGreaterThan(0)
  expect(new Set(xs).size).toBe(1)
  return xs[0]
}

function titles(svg: string): string[] {
  return [...svg.matchAll(/<title>([^<]*)<\/title>/g)].map((m) => m[1])
}

describe("T-10 label gutter cap 0.30 W (N-030)", () => {
  test("a 37-character label: gutter at most 38.4 mm at 128 mm, cut text keeps the full label in <title>", () => {
    expect(LONG).toHaveLength(37)
    for (const style of ["gallery", "datum"] as const) {
      const r = renderChart(spec(style, [LONG, "Wilayah Barat", "Wilayah Tengah"]))
      const g = gutterMm(r.svg)
      expect(g, style).toBeLessThanOrEqual(CAP_MM + 0.005)
      expect(g, style).toBeLessThan(OLD_CAP_MM)
      // The 31-character word cannot wrap under the cap: it is cut with an ellipsis and <title> keeps the full label.
      expect(r.svg, style).not.toMatch(new RegExp(`<text[^>]*>${LONG}</text>`))
      expect(r.svg, style).toMatch(/<tspan[^>]*>PENGAWASANKOORDINASIOPER[A-Z]*…<\/tspan>/)
      expect(titles(r.svg), style).toContain(LONG)
      expect(r.report.issues.some((i) => i.status === "FAIL"), style).toBe(false)
    }
  })

  test("labelShort is used in the gutter and the full label stays in <title>; the other long label is capped", () => {
    for (const style of ["gallery", "datum"] as const) {
      const r = renderChart(spec(style, [LONG, LONG_B, "Wilayah Tengah"], { intent: { labelShort: [{ label: LONG, short: "Pengawasan Timur" }] } }))
      const g = gutterMm(r.svg)
      expect(g, style).toBeLessThanOrEqual(CAP_MM + 0.005)
      expect(r.svg, style).toMatch(/<g data-label-short="1"><title>PENGAWASANKOORDINASIOPERASIONAL TIMUR<\/title><text[^>]*>Pengawasan Timur<\/text><\/g>/)
      expect(r.svg, style).not.toMatch(new RegExp(`<text[^>]*>${LONG}</text>`))
      expect(r.svg, style).not.toMatch(new RegExp(`<text[^>]*>${LONG_B}</text>`))
      expect(r.report.issues.some((i) => i.checkId === "INTENT_APPLIED"), style).toBe(true)
      expect(r.report.issues.some((i) => i.status === "FAIL"), style).toBe(false)
    }
  })

  test("short labels keep the old gutter (no change below the cap)", () => {
    const r = renderChart(spec("gallery", ["Wilayah Barat", "Wilayah Tengah"]))
    expect(gutterMm(r.svg)).toBeLessThan(CAP_MM)
    expect(titles(r.svg)).toHaveLength(0)
  })
})
