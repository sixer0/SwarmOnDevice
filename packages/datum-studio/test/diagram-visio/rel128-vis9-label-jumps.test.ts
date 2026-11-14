// Swarm 1.2.8 row 57b (AC-VIS9, VIS-9, F-VISIO 01f §3.3 Jumps, §3.4, AT-V9-label-jumps; register N8-265, N8-266,
// N8-381, N8-471). `label_at` start / middle / end puts the label centre (its knock-out band) at LABEL_AT_FRACTION
// 0.2 / 0.5 / 0.8 of the drawn path length (+-0.1 mm); a fixed label is never moved, a forced collision is reported
// by the geometry lint; `jumps: "off"` draws no hop, `"on"` is byte-equal to the absent field; a hop on an edge with
// `weight` is stroked at that weight.
// Fixture: test/fixtures/syn128/vis9_labels_jumps.json (synthetic labels).
// Red at BASE e1f9673772: the schema refuses `label_at` and `jumps`, labels sit at the computed spot, hops always drawn.
// Namespace imports, so the red run fails on assertions, not on a link error.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { buildDiagramSvg } from "../../vendor/src/lib/studio/engine/diagram/build"
import { buildDiagramSvgAuto } from "../../vendor/src/lib/studio/engine/diagram/elk"
import * as core from "../../vendor/src/lib/studio/engine/diagram/core"
import { lintDiagramGeometry } from "../../vendor/src/lib/studio/engine/diagram/fit/lint"

type J = Record<string, any>
const C = core as J
const FX = JSON.parse(readFileSync(path.join(import.meta.dir, "..", "fixtures", "syn128", "vis9_labels_jumps.json"), "utf8")) as J
const O = { release: false }
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v))
const FRACTION: Record<string, number> = { start: 0.2, middle: 0.5, end: 0.8 }
const PAPER = "#FCFCFB"

const svgOf = (spec: J): string => (buildDiagramSvg(clone(spec) as never, O) as J).svg as string
const autoOf = async (spec: J): Promise<string> => ((await buildDiagramSvgAuto(clone(spec) as never, O as never, {}, () => {})) as J).svg as string
const linkPts = (svg: string): Array<Array<[number, number]>> =>
  [...svg.matchAll(/<path d="([^"]+)"[^>]*data-mark="link"[^>]*\/>/g)].map((m) =>
    [...m[1].matchAll(/(-?[\d.]+) (-?[\d.]+)/g)].map((p) => [Number(p[1]), Number(p[2])] as [number, number]),
  )
const hops = (svg: string) => [...svg.matchAll(/<path d="M [\d.]+ [\d.]+ A [^"]+"[^>]*\/>/g)].map((m) => m[0])
/** Centre of the knock-out band drawn right before the label text `text` (evidence_rail labels are set in capitals). */
function bandCentre(svg: string, text: string): [number, number] {
  const re = new RegExp(`<rect x="([\\d.]+)" y="([\\d.]+)" width="([\\d.]+)" height="([\\d.]+)" fill="${PAPER}"/><text [^>]*>${text.toUpperCase()}</text>`)
  const m = re.exec(svg.replace(/\n/g, ""))
  expect(m, `knock-out band + label ${text}`).not.toBeNull()
  return [Number(m![1]) + Number(m![3]) / 2, Number(m![2]) + Number(m![4]) / 2]
}
function pointAt(pts: Array<[number, number]>, f: number): [number, number] {
  const segs = pts.slice(1).map((b, i) => [pts[i], b] as const)
  const total = segs.reduce((a, [p, q]) => a + Math.hypot(q[0] - p[0], q[1] - p[1]), 0)
  let rest = total * f
  for (const [p, q] of segs) {
    const len = Math.hypot(q[0] - p[0], q[1] - p[1])
    if (len > 0 && rest <= len) return [p[0] + ((q[0] - p[0]) * rest) / len, p[1] + ((q[1] - p[1]) * rest) / len]
    rest -= len
  }
  return pts[pts.length - 1]
}

describe("VIS-9 placed labels (label_at, N8-265, LABEL_AT_FRACTION N8-471)", () => {
  test("the spec passes validateSpec", () => {
    expect((C.validateSpec(C.loadSpec(clone(FX.placed))) as J[]).filter((i) => i.status !== "PASS")).toEqual([])
  })
  for (const mode of ["sync", "auto"] as const) {
    test(`${mode}: band centre at 0.2 / 0.5 / 0.8 of the drawn path length (+-0.1 mm)`, async () => {
      const svg = mode === "sync" ? svgOf(FX.placed) : await autoOf(FX.placed)
      const pts = linkPts(svg)
      FX.placed.edges.forEach((e: J, i: number) => {
        const [px, py] = pointAt(pts[i], FRACTION[e.label_at])
        const [cx, cy] = bandCentre(svg, e.label)
        expect(Math.abs(cx - px), `${e.label_at} x`).toBeLessThanOrEqual(0.1)
        expect(Math.abs(cy - py), `${e.label_at} y`).toBeLessThanOrEqual(0.1)
      })
    })
  }
  test("the three labels are at different heights along their (equal) paths: start above middle above end", () => {
    const svg = svgOf(FX.placed)
    const ys = FX.placed.edges.map((e: J) => bandCentre(svg, e.label)[1])
    expect(ys[0]).toBeLessThan(ys[1])
    expect(ys[1]).toBeLessThan(ys[2])
  })
  test("0 geometry defects, sync and auto", async () => {
    expect(lintDiagramGeometry(svgOf(FX.placed)).defects).toEqual([])
    expect(lintDiagramGeometry(await autoOf(FX.placed)).defects).toEqual([])
  })
})

describe("VIS-9 forced collision is reported, not moved (01f §3.4)", () => {
  for (const mode of ["sync", "auto"] as const) {
    test(`${mode}: both labels stay at the middle of their paths and the lint reports textOverlap`, async () => {
      const svg = mode === "sync" ? svgOf(FX.collision) : await autoOf(FX.collision)
      const pts = linkPts(svg)
      FX.collision.edges.forEach((e: J, i: number) => {
        const [px, py] = pointAt(pts[i], 0.5)
        const [cx, cy] = bandCentre(svg, e.label)
        expect(Math.hypot(cx - px, cy - py), e.label).toBeLessThanOrEqual(0.1)
      })
      expect(lintDiagramGeometry(svg).defects.map((d: J) => d.kind)).toContain("textOverlap")
    })
  }
})

describe("VIS-9 line jumps (jumps, N8-266)", () => {
  const on = svgOf(FX.crossing)
  test("absent: one hop arc where the horizontal connector crosses the vertical one (today's crossingHops)", () => {
    expect(hops(on).length).toBe(1)
  })
  test('jumps "on" renders byte-equal to the absent field, sync and auto', async () => {
    expect(svgOf(FX.crossing_on)).toBe(on)
    expect(await autoOf(FX.crossing_on)).toBe(await autoOf(FX.crossing))
  })
  test('jumps "off": no hop path; every other byte equals the jumps-on figure', () => {
    const off = svgOf(FX.crossing_off)
    expect(hops(off)).toEqual([])
    expect(off).toBe(on.replace(hops(on)[0], "").replace(/\n\n/g, "\n"))
  })
  test("the hop of an edge with weight thick is stroked 0.70 mm; without weight 0.45 (STROKE_PRIMARY)", () => {
    expect(hops(on)[0]).toContain('stroke-width="0.45"')
    const h = hops(svgOf(FX.crossing_thick))
    expect(h.length).toBe(1)
    expect(h[0]).toContain('stroke-width="0.7"')
  })
  test("crossing figures: no geometry defect other than the crossing itself (edgeCross)", () => {
    for (const k of ["crossing", "crossing_off", "crossing_thick"]) {
      expect(lintDiagramGeometry(svgOf(FX[k])).defects.filter((d: J) => d.kind !== "edgeCross"), k).toEqual([])
    }
  })
})
