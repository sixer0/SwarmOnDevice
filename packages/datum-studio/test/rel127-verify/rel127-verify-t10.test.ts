// Swarm 1.2.7 row 45 (N7-114, CHAR-VERIFY): regression test committed from the row 9 engine probe
// ($T/test/probes/datum-studio/probe9_engine.test.ts). Must pass at BASE 04067a9d02 and at HEAD; no code change for
// this item. Synthetic inputs only: every figure and chart below is built in-test from filler words.
// AC-T10 (01_specs §4): the label gutter is capped at 0.30 W with an ellipsis, the full label sits in <title>, and
// intent.labelShort is drawn in the gutter.
import { useStudioEnv } from "../ported/_env"
useStudioEnv()
import { describe, expect, test } from "bun:test"
import path from "node:path"

type S = Record<string, any>
const PKG = path.resolve(import.meta.dir, "..", "..")
const chart = await import(path.join(PKG, "vendor", "src", "lib", "studio", "engine", "chart", "core", "index.ts"))

const chartSpec = (labels: string[], values: number[], extra: S = {}) =>
  ({ kind: "P-01", widthMm: 128, title: "Uji.", source: "Data sintetis uji.", data: { shape: "categorical", points: labels.map((label, i) => ({ label, value: values[i] })) }, unit: "ton", dec: 0, ...extra }) as S
const firstBarX = (svg: string) => Number(/\sx="([-0-9.]+)"/.exec(/<rect\b[^>]*data-mark="bar"[^>]*>/.exec(svg)![0])![1])
const LONG = "Pusatdistribusiregionalkawasantimur laut" // 40 characters, filler

describe("rel127 VERIFY T-10: label gutter", () => {
  test("a 40-character label: gutter <= 0.30 W, ellipsis drawn, full label in <title>", () => {
    expect(LONG.length).toBe(40)
    const r = chart.renderChart(chartSpec([LONG, "Kawasan barat", "Kawasan tengah"], [9, 6, 3]))
    expect(firstBarX(r.svg)).toBeLessThanOrEqual(0.3 * 128 + 0.005)
    expect(/…<\/tspan>|…<\/text>/.test(r.svg)).toBe(true)
    expect(r.svg.includes(`<title>${LONG}</title>`)).toBe(true)
  })
  test("labelShort replaces the long label in the gutter", () => {
    const r = chart.renderChart(chartSpec([LONG, "Kawasan barat"], [9, 6], { intent: { labelShort: [{ label: LONG, short: "Pusat timur" }] } }))
    const shown = /<g data-label-short="1"><title>([^<]*)<\/title><text[^>]*>([^<]*)<\/text>/.exec(r.svg)
    expect(shown?.[1]).toBe(LONG)
    expect(shown?.[2]).toBe("Pusat timur")
  })
})
