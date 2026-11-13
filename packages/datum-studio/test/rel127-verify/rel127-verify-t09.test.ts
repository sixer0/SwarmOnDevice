// Swarm 1.2.7 row 45 (N7-114, CHAR-VERIFY): regression test committed from the row 9 engine probe
// ($T/test/probes/datum-studio/probe9_engine.test.ts). Must pass at BASE 04067a9d02 and at HEAD; no code change for
// this item. Synthetic inputs only: every figure and chart below is built in-test from filler words.
// AC-T09 (01_specs §4): a bar body below the minimum stays honest (not raised): one BAR_SUBMIN with status REPORT,
// zero BAR_MIN_HEIGHT, equal bar thickness, bar lengths proportional to the values.
import { useStudioEnv } from "../ported/_env"
useStudioEnv()
import { describe, expect, test } from "bun:test"
import path from "node:path"

type S = Record<string, any>
const PKG = path.resolve(import.meta.dir, "..", "..")
const chart = await import(path.join(PKG, "vendor", "src", "lib", "studio", "engine", "chart", "core", "index.ts"))

const chartSpec = (labels: string[], values: number[]) =>
  ({ kind: "P-01", widthMm: 128, title: "Uji.", source: "Data sintetis uji.", data: { shape: "categorical", points: labels.map((label, i) => ({ label, value: values[i] })) }, unit: "ton", dec: 0 }) as S
const bars = (svg: string) =>
  [...svg.matchAll(/<rect\b[^>]*data-mark="bar"[^>]*>/g)].map((m) => ({ h: Number(/\sheight="([-0-9.]+)"/.exec(m[0])![1]), w: Number(/\swidth="([-0-9.]+)"/.exec(m[0])![1]) }))

describe("rel127 VERIFY T-09: bar minimum is reported, never faked", () => {
  test("two categories: body below 32 mm, BAR_SUBMIN 1 REPORT, BAR_MIN_HEIGHT 0, honest bars", () => {
    const r = chart.renderChart(chartSpec(["Gudang utara", "Gudang selatan"], [40, 25]))
    const issues = r.report.issues as S[]
    const sub = issues.filter((i) => i.checkId === "BAR_SUBMIN")
    const b = bars(r.svg)
    expect(r.heightMm).toBeLessThan(32)
    expect(sub.length).toBe(1)
    expect(sub[0].status).toBe("REPORT")
    expect(issues.filter((i) => i.checkId === "BAR_MIN_HEIGHT").length).toBe(0)
    expect(b.length).toBe(2)
    expect(b.every((x) => Math.abs(x.h - b[0].h) < 1e-6)).toBe(true)
    expect(b[0].w / b[1].w).toBeCloseTo(40 / 25, 2)
  })
})
