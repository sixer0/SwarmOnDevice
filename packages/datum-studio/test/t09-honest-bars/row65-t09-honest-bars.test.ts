// Swarm 1.2.6 row 65 (T-09, U14 reverses D-322): honest bar geometry for the datum bar family.
// A bar chart with few categories keeps the DC body (n x 7.2 + 6 mm) and the DC bar tokens
// (pitch 7.2 mm, thickness 4.4 mm); a body below BAR_MIN_BODY_MM (32 mm, now a threshold)
// is flagged with one BAR_SUBMIN REPORT note instead of being raised to 32 mm.
// Before (e363918a69): FIX-H8 raised the n = 2 body to 32 mm, thickened the bars to 7.94 mm,
// barRows(2).scaled was true and the note was BAR_MIN_HEIGHT.
// CHAR-T09-zero (characterisation, green at base too): a zero value draws a zero-length bar.
import { describe, expect, test } from "bun:test"
import { useStudioEnv } from "../ported/_env"
useStudioEnv()
import type { StudioChartV1 } from "../../vendor/src/lib/studio/contract"
import { BAR_MIN_BODY_MM, barRows, estimateHeightMm, renderChart } from "../../vendor/src/lib/studio/engine/chart/core"

function spec(kind: string, values: number[], extra: Record<string, unknown> = {}): StudioChartV1 {
  const points = values.map((value, i) => ({ label: `Kategori ${i + 1}`, value }))
  return {
    kind,
    widthMm: 128,
    title: "Uji.",
    source: "Data uji sintetis.",
    data: { shape: "categorical", points },
    unit: "unit",
    dec: 0,
    ...extra,
  } as unknown as StudioChartV1
}

function bars(svg: string): Array<{ x: number; y: number; w: number; h: number }> {
  return [...svg.matchAll(/<rect\b[^>]*data-mark="bar"[^>]*>/g)].map((m) => ({
    x: Number(/\sx="([-0-9.]+)"/.exec(m[0])![1]),
    y: Number(/\sy="([-0-9.]+)"/.exec(m[0])![1]),
    w: Number(/\swidth="([-0-9.]+)"/.exec(m[0])![1]),
    h: Number(/\sheight="([-0-9.]+)"/.exec(m[0])![1]),
  }))
}

describe("T-09 honest bar geometry (U14)", () => {
  test("two categories: scaled false, DC body 20.4 mm, DC bars, exactly one BAR_SUBMIN note", () => {
    expect(BAR_MIN_BODY_MM).toBe(32)
    expect(barRows(2).scaled).toBe(false)
    expect(barRows(2)).toEqual({ pitch: 7.2, thick: 4.4, inset: 0, scaled: false })
    const s = spec("P-01", [6, 3])
    expect(estimateHeightMm(s)).toBeCloseTo(20.4, 9)
    const r = renderChart(s)
    expect(r.heightMm).toBeCloseTo(20.4, 9)
    const b = bars(r.svg)
    expect(b).toHaveLength(2)
    for (const x of b) expect(x.h).toBeCloseTo(4.4, 6)
    expect(b[1].y - b[0].y).toBeCloseTo(7.2, 6)
    // Bar lengths stay proportional to the data (6 : 3).
    expect(b[0].w / b[1].w).toBeCloseTo(2, 3)
    const sub = r.report.issues.filter((i) => i.checkId === "BAR_SUBMIN")
    expect(sub).toHaveLength(1)
    expect(sub[0].status).toBe("REPORT")
    expect(sub[0].detail).toContain("20.4 mm")
    expect(sub[0].detail).toContain("32 mm")
    expect(r.report.issues.some((i) => i.checkId === "BAR_MIN_HEIGHT")).toBe(false)
  })

  test("one and three categories, threshold P-11: no inflation, one BAR_SUBMIN each", () => {
    for (const [kind, values, body, extra] of [
      ["P-01", [5], 13.2, {}],
      ["P-01", [9, 6, 3], 27.6, {}],
      ["P-11", [9, 6], 20.4 + 5, { limit: 7 }],
    ] as Array<[string, number[], number, Record<string, unknown>]>) {
      expect(barRows(values.length).scaled).toBe(false)
      const r = renderChart(spec(kind, values, extra))
      expect(r.heightMm).toBeCloseTo(body, 9)
      expect(bars(r.svg).every((x) => Math.abs(x.h - 4.4) < 1e-6)).toBe(true)
      expect(r.report.issues.filter((i) => i.checkId === "BAR_SUBMIN")).toHaveLength(1)
    }
  })

  test("four categories (body 34.8 mm >= 32 mm): no BAR_SUBMIN", () => {
    const r = renderChart(spec("P-01", [12, 9, 6, 3]))
    expect(r.heightMm).toBeCloseTo(34.8, 9)
    expect(r.report.issues.some((i) => i.checkId === "BAR_SUBMIN")).toBe(false)
  })

  test("CHAR-T09-zero: a zero value draws a zero-length bar", () => {
    const r = renderChart(spec("P-01", [8, 0, 4, 2]))
    // P-01 sorts descending by default, so the widths come out as 8, 4, 2, 0.
    const w = bars(r.svg).map((x) => x.w)
    expect(w).toHaveLength(4)
    expect(w.filter((x) => x === 0)).toHaveLength(1)
    expect(w[w.length - 1]).toBe(0)
    expect(w[0] / w[1]).toBeCloseTo(2, 3)
    expect(w[1] / w[2]).toBeCloseTo(2, 3)
  })
})
