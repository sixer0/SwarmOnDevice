// Swarm 1.2.10 row 65a (AC-B1002a, spec 01f AT-B1002a, register N10-188, N10-108; decisions C11, C19 D-2, C24).
// B10-02: the chart lint gains `chartLinksAlongNodes`, a report-only check for a connector that runs along a node outline,
// the link's own start and end nodes included (g04's two runs are on its own end nodes, so the diagram detector
// `edgesAlongOutlines`, which skips them, would find nothing). The result never enters `lintChartGeometry`'s `defects`,
// `counts` or `score`: a score above 0 sends the render into auto-fit, and g04's bytes are frozen (legacy flow path, C11).
// Block AC-B1002a (this row): the function, the g04 list measured at BASE by hand and by the red step, synthetic cases, and
// a sweep over the 46 chart parity fixtures (both styles) whose `lintChartGeometry` digest equals the BASE capture.
// Block AC-B1002b (row 65b) adds the render report line, the preview class and the FIGURE_FIT note.
// Red at BASE a3e3c4c93a: `chartLinksAlongNodes` is absent (blocks (1) and (2) fail); the sweep block is green at BASE and
// HEAD (it is the BASE comparison data).
import { useStudioEnv } from "../_env"
useStudioEnv()
import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import * as chartMod from "../../../vendor/src/lib/studio/engine/chart/core"
import * as geo from "../../../vendor/src/lib/studio/engine/chart/core/geometry"

type J = any
const PARITY_CHART_DIR = path.join(import.meta.dir, "..", "_fixtures", "tests", "parity", "fixtures", "chart")
const render = (chart: J, style: string): string => (chartMod as J).renderChart({ ...structuredClone(chart), style }).svg as string
const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex")
/** The function under test, read through the namespace so the sweep block still runs where it is absent (BASE). */
const along = (svg: string): Array<{ link: string; node: string; mm: number }> => {
  const fn = (geo as J).chartLinksAlongNodes
  expect(typeof fn, "chartLinksAlongNodes is exported by chart/core/geometry").toBe("function")
  return fn(svg)
}

/** g04 pins (rel129-a11a / rel129-a11b, equal at BASE). */
const G04_SHA: Record<string, string> = {
  datum: "37039bce2451383aa168efd9cd5fed86322be0be3ea60ddbe55c7e28ca68f07c",
  gallery: "006e6ee19675485b8b66286bff9d23957357e087bbb0e1e6cf8ddc5fb09f48e6",
}
/**
 * Measured at BASE by the red step (scratch sweep, equal to the hand computation of spec 01f AT-B1002a): link 4
 * `M83 45.3655L50.7558 45.3655L50.7558 61.4897L75.1512 61.4897` runs along s4's bottom (y 45.3655, x 63.6535..83 =
 * 19.3465 mm) and along s6's top (y 61.4897, x 63.6535..75.1512 = 11.4977 mm). No other pair in either style.
 */
const G04_ALONG = [
  { link: "4", node: "s4", mm: 19.35 },
  { link: "4", node: "s6", mm: 11.5 },
]
/** sha256 of JSON.stringify({ "<file>@<style>": lintChartGeometry(svg, CHART_LINT_OPTIONS) }) over the 46 fixtures x 2 styles, at BASE. */
const SWEEP_BASE_SHA = "8c6dedb9cfa14e4f87f042f8946b64f4c614cde72f5c3e009494800a7bbff344"

const svgDoc = (body: string): string => `<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="100mm" viewBox="0 0 100 100">\n${body}\n</svg>`
/** A rect node 20 x 10 mm at (10, 10) with the flowchart's 0.45 mm outline. */
const BOX = `<rect data-mark="node" data-series="langkah" data-index="0" x="10" y="10" width="20" height="10" fill="#FCFCFB" stroke="#101418" stroke-width="0.45" data-node="b"/>`
const link = (index: number, d: string): string =>
  `<path data-mark="link" data-series="konektor" data-index="${index}" d="${d}" fill="none" stroke="#101418" stroke-width="0.3"/>`

describe("AC-B1002a chart lint: connector along a node outline (N10-108), report data only", () => {
  for (const style of ["datum", "gallery"]) {
    test(`g04 @${style}: link 4 runs along s4 (own start node) and s6 (own end node); bytes and lint unchanged`, () => {
      const g04 = JSON.parse(readFileSync(path.join(PARITY_CHART_DIR, "g04.json"), "utf8"))
      const svg = render(g04, style)
      expect(sha256(svg), "g04 bytes frozen (C11)").toBe(G04_SHA[style])
      expect(along(svg)).toEqual(G04_ALONG)
      // Never in the lint result: the four defect kinds stay the only `counts` keys, and g04's score stays 0.
      const lint = geo.lintChartGeometry(svg, geo.CHART_LINT_OPTIONS)
      expect(Object.keys(lint.counts).sort()).toEqual(["lineThroughText", "textOutside", "textOverlap", "textStraddleMark"])
      expect(lint.defects).toEqual([])
      expect(lint.score).toBe(0)
    })
  }

  test("synthetic: a run of 0.5 mm along an outline is below EDGE_ALONG_MIN_MM (1.0) -> no entry", () => {
    expect(along(svgDoc(`${BOX}${link(0, "M15 10L15.5 10")}`))).toEqual([])
  })

  test("synthetic: 1.2 mm along at 0.2 mm offset (limit 0.15 + 0.225 + 0.1 = 0.475 mm) -> entry; 0.5 mm offset -> none", () => {
    expect(along(svgDoc(`${BOX}${link(0, "M12 9.8L13.2 9.8")}`))).toEqual([{ link: "0", node: "b", mm: 1.2 }])
    expect(along(svgDoc(`${BOX}${link(0, "M12 9.5L13.2 9.5")}`))).toEqual([])
    // A group transform applies to both shapes alike (the scanner maps `translate` like `lintChartGeometry`).
    expect(along(svgDoc(`<g transform="translate(5 3)">${BOX}${link(0, "M12 9.8L13.2 9.8")}</g>`))).toEqual([{ link: "0", node: "b", mm: 1.2 }])
  })

  test("synthetic: a head-on entry is not a run, and the arrow head (later element of the same index) is never measured", () => {
    expect(along(svgDoc(`${BOX}${link(0, "M20 0L20 10")}`))).toEqual([])
    const head = `<path data-mark="link" data-series="konektor" data-index="0" d="M12 10L28 10L20 9Z" fill="#101418"/>`
    expect(along(svgDoc(`${BOX}${link(0, "M20 0L20 10")}${head}`))).toEqual([])
  })

  test("synthetic: runs on both the start and the end node are summed per pair and listed in link, node order", () => {
    const BOX2 = BOX.replace('data-index="0"', 'data-index="1"').replace('y="10"', 'y="40"').replace('data-node="b"', 'data-node="a"')
    // link 1: 16 mm along b's bottom (x 26..10, its own start node), down x 8, then 2 mm along a's top (x 10..12, its own end node).
    const body = `${BOX}${BOX2}${link(1, "M26 20L8 20L8 40L12 40")}${link(0, "M40 0L40 5")}`
    expect(along(svgDoc(body))).toEqual([
      { link: "1", node: "a", mm: 2 },
      { link: "1", node: "b", mm: 16 },
    ])
  })

  test("synthetic: curved outlines (circle, arc path) are skipped", () => {
    const circle = `<circle data-mark="node" data-node="c" cx="50" cy="50" r="5" fill="#FCFCFB" stroke="#101418" stroke-width="0.45"/>`
    const arc = `<path data-mark="node" data-node="e" d="M60 70A5 5 0 1 0 70 70A5 5 0 1 0 60 70Z" fill="#FCFCFB" stroke="#101418" stroke-width="0.45"/>`
    expect(along(svgDoc(`${circle}${arc}${link(0, "M45 45L55 45")}${link(1, "M60 70L70 70")}`))).toEqual([])
  })

  test("sweep: lintChartGeometry of the 46 chart parity fixtures x 2 styles equals BASE; only g04 has a run", () => {
    const files = readdirSync(PARITY_CHART_DIR).filter((n) => n.endsWith(".json")).sort()
    expect(files.length).toBe(46)
    const lints: Record<string, unknown> = {}
    const withRuns: string[] = []
    const hasFn = typeof (geo as J).chartLinksAlongNodes === "function"
    for (const f of files) {
      const chart = JSON.parse(readFileSync(path.join(PARITY_CHART_DIR, f), "utf8"))
      for (const style of ["datum", "gallery"]) {
        const svg = render(chart, style)
        lints[`${f}@${style}`] = geo.lintChartGeometry(svg, geo.CHART_LINT_OPTIONS)
        if (hasFn && (geo as J).chartLinksAlongNodes(svg).length) withRuns.push(`${f}@${style}`)
      }
    }
    expect(sha256(JSON.stringify(lints)), "lintChartGeometry results byte-equal to BASE").toBe(SWEEP_BASE_SHA)
    console.log(`chartLinksAlongNodes non-empty: ${JSON.stringify(withRuns)}`)
    if (hasFn) expect(withRuns).toEqual(["g04.json@datum", "g04.json@gallery"])
  })
})
