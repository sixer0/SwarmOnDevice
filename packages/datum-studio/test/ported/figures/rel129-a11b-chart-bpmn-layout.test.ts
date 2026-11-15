// Swarm 1.2.9 row 35 (AC-A11b, spec 01a AT-A11b, register N9-112; decisions C10(f), C42). A chart flowchart (G-04) whose
// spec has a label-below BPMN shape (event or gateway) and no `direction` is laid out by rank along its edges: the chart
// uses `direction: "TB"` (the guide's own advice for serial flows, `H/diagram-guide.ts:131`), so the engine's
// `layoutRankedFlow` orders it (`D/layout-a/flow.ts:19-20`) instead of the legacy list layout. Specs with `direction` and
// charts without a BPMN shape are unchanged: g04 and every chart parity render stay byte-identical (pins = the row 34
// pins, HEAD before row 35, equal at BASE d4282fcfd8).
// Fixture: test/fixtures/syn129/a11_chart_bpmn_flow.json (N9-155), styles datum and gallery.
// Eye defect from row 34 fixed with it: the start event's label is drawn beside its circle (as the engine marks it), so
// the a->b connector no longer runs through `Mulai`.
// Red at BASE: the `no_direction` variant is a single column (d and e, both one rank below the gateway, on different
// rows), its bytes differ from the `direction_tb` variant, and `Mulai` is drawn centred below the circle.
import { useStudioEnv } from "../_env"
useStudioEnv()
import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import * as chartMod from "../../../vendor/src/lib/studio/engine/chart/core"

type J = any
const FX = JSON.parse(readFileSync(path.join(import.meta.dir, "..", "..", "fixtures", "syn129", "a11_chart_bpmn_flow.json"), "utf8")) as J
const PARITY_CHART_DIR = path.join(import.meta.dir, "..", "_fixtures", "tests", "parity", "fixtures", "chart")
const render = (chart: J, style: string): J => (chartMod as J).renderChart({ ...structuredClone(chart), style })
const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex")

/** Centre of node `id` in the SVG: the bounding box of its outline (rect, or the points of its outline path). */
function centreOf(svg: string, id: string): { x: number; y: number } {
  const el = [...svg.matchAll(/<(rect|path) data-mark="node"[^>]*>/g)].map((m) => m[0]).find((e) => e.includes(`data-node="${id}"`))
  expect(el, `node ${id} outline`).toBeDefined()
  const num = (a: string): number => Number(new RegExp(` ${a}="(-?[\\d.]+)"`).exec(el!)![1])
  if (el!.startsWith("<rect")) return { x: num("x") + num("width") / 2, y: num("y") + num("height") / 2 }
  const d = / d="([^"]+)"/.exec(el!)![1]
  const ps: { x: number; y: number }[] = []
  for (const m of d.matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)) ps.push({ x: Number(m[1]), y: Number(m[2]) })
  for (const m of d.matchAll(/A-?[\d.]+ -?[\d.]+ \d+ \d \d (-?[\d.]+) (-?[\d.]+)/g)) ps.push({ x: Number(m[1]), y: Number(m[2]) })
  const xs = ps.map((p) => p.x)
  const ys = ps.map((p) => p.y)
  return { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 }
}

/** Longest-path rank of every node from the edges (the fixture is acyclic, so there is no back edge to drop). */
function graphRanks(spec: J): Map<string, number> {
  const rank = new Map<string, number>((spec.nodes as J[]).map((n) => [n.id, 0]))
  for (let pass = 0; pass < spec.nodes.length; pass++) {
    for (const e of spec.edges as J[]) rank.set(e.to, Math.max(rank.get(e.to)!, rank.get(e.from)! + 1))
  }
  return rank
}

describe("AC-A11b chart flowchart: BPMN ranks follow the edges (N9-155)", () => {
  for (const style of ["datum", "gallery"]) {
    test(`no_direction @${style}: every edge goes one rank down (TB) and nodes of one rank share a row`, () => {
      const chart = FX.no_direction
      expect(chart.data.spec.direction, "fixture has no direction").toBeUndefined()
      const svg = render(chart, style).svg as string
      const rank = graphRanks(chart.data.spec)
      const y = new Map((chart.data.spec.nodes as J[]).map((n) => [n.id, centreOf(svg, n.id).y]))
      const seen: string[] = []
      for (const e of chart.data.spec.edges as J[]) {
        seen.push(`${e.from}->${e.to} y ${y.get(e.from)!.toFixed(2)}->${y.get(e.to)!.toFixed(2)}`)
        expect(y.get(e.to)!, `edge ${e.from}->${e.to}`).toBeGreaterThan(y.get(e.from)!)
      }
      // Nodes on one graph rank sit on one row: d and e (both after the gateway) side by side, not stacked.
      for (const a of rank.keys()) {
        for (const b of rank.keys()) {
          if (a < b && rank.get(a) === rank.get(b)) expect(Math.abs(y.get(a)! - y.get(b)!), `same rank ${a}, ${b}: ${seen.join("; ")}`).toBeLessThanOrEqual(0.01)
          if (rank.get(a)! < rank.get(b)!) expect(y.get(a)!, `rank ${a} < rank ${b}`).toBeLessThan(y.get(b)!)
        }
      }
    })
    test(`no_direction @${style}: the start event's label sits beside its circle, clear of the a->b connector`, () => {
      // Row 34 eye note: the a->b connector ran through the `Mulai` label drawn below the circle. `routePlaced` labels an
      // event left downward beside its circle (row 57c); the chart now draws it there, start-anchored right of the rim.
      const svg = render(FX.no_direction, style).svg as string
      const c = centreOf(svg, "a")
      const el = /<text x="(-?[\d.]+)" y="(-?[\d.]+)"[^>]*text-anchor="(\w+)">Mulai<\/text>/.exec(svg)
      expect(el, "Mulai label").not.toBeNull()
      const r = Number(/A(-?[\d.]+) /.exec(/<path data-mark="node"[^>]*data-node="a"[^>]*>/.exec(svg)![0])![1])
      expect(el![3]).toBe("start")
      expect(Number(el![1]), "label left edge right of the circle").toBeGreaterThan(c.x + r)
      expect(Math.abs(Number(el![2]) - c.y), "label baseline near the circle centre height").toBeLessThan(r)
    })
    test(`no_direction @${style} renders byte-equal to direction_tb`, () => {
      expect(sha256(render(FX.no_direction, style).svg)).toBe(sha256(render(FX.direction_tb, style).svg))
    })
  }
})

/** Every arrowhead of the chart: link index, tip and full head width (solid head `M tip L c1 L c2 Z`; open head `M c1 L tip L c2`). */
function heads(svg: string): { index: number; tip: { x: number; y: number }; width: number }[] {
  const byIndex = new Map<number, string[]>()
  for (const m of svg.matchAll(/<path data-mark="link" data-series="konektor" data-index="(\d+)" d="([^"]+)"/g)) byIndex.set(Number(m[1]), [...(byIndex.get(Number(m[1])) ?? []), m[2]])
  return [...byIndex].map(([index, ds]) => {
    expect(ds.length, `link ${index}: line + head`).toBe(2)
    const p = [...ds[1].matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)].map((m) => ({ x: Number(m[1]), y: Number(m[2]) }))
    const [tip, c1, c2] = ds[1].endsWith("Z") ? [p[0], p[1], p[2]] : [p[1], p[0], p[2]]
    return { index, tip, width: Math.hypot(c1.x - c2.x, c1.y - c2.y) }
  })
}

// Swarm 1.2.9 row 66b (gate 66 F2, C77). The engine fans two ends into one side of an event over the middle of its 8 mm
// outline (1.33 mm on the sheet); the chart scale (~0.42) shrank that to ~0.58 mm while the arrowheads keep their 1.26 mm
// width, so the two heads into `Selesai` read as one thick doubled head. Red at HEAD before 66b: tips 0.58 mm apart.
describe("AC-A11b chart flowchart: arrowheads into one BPMN node read as distinct (66b, N9-155)", () => {
  for (const variant of ["no_direction", "direction_tb"]) {
    for (const style of ["datum", "gallery"]) {
      test(`${variant} @${style}: tips of two arrowheads into one node are at least one head width apart`, () => {
        const chart = FX[variant]
        const svg = render(chart, style).svg as string
        const edges = chart.data.spec.edges as J[]
        const hs = heads(svg)
        expect(hs.length, "one head per edge").toBe(edges.length)
        let pairs = 0
        for (const a of hs) {
          for (const b of hs) {
            if (a.index >= b.index || edges[a.index].to !== edges[b.index].to) continue
            const gap = Math.hypot(a.tip.x - b.tip.x, a.tip.y - b.tip.y)
            const w = Math.max(a.width, b.width)
            expect(gap, `links ${a.index}, ${b.index} into ${edges[a.index].to}: tips ${gap.toFixed(4)} mm apart, head width ${w.toFixed(4)} mm`).toBeGreaterThanOrEqual(w - 1e-6)
            pairs++
          }
        }
        expect(pairs, "pairs of links into one node (d->f, e->f)").toBe(1)
      })
    }
  }
})

/** g04 pins and one digest over the 92 chart parity pins of row 34 (rel129-a11a, HEAD before row 35, equal at BASE). */
const G04_DATUM = "37039bce2451383aa168efd9cd5fed86322be0be3ea60ddbe55c7e28ca68f07c"
const G04_GALLERY = "006e6ee19675485b8b66286bff9d23957357e087bbb0e1e6cf8ddc5fb09f48e6"
const PARITY_DIGEST = "7d8c3f8d2036b338e0547b06df9b2752f5a01c29a2818fa036d8d65ac492ab5f"

describe("AC-A11b: charts without a BPMN shape are byte-identical (C10(f))", () => {
  test("g04 @datum and @gallery equal their HEAD-before-row-35 bytes", () => {
    const g04 = JSON.parse(readFileSync(path.join(PARITY_CHART_DIR, "g04.json"), "utf8"))
    expect(sha256(render(g04, "datum").svg)).toBe(G04_DATUM)
    expect(sha256(render(g04, "gallery").svg)).toBe(G04_GALLERY)
  })
  test("the 92 chart parity renders equal their HEAD-before-row-35 bytes (one digest)", () => {
    const lines: string[] = []
    for (const f of readdirSync(PARITY_CHART_DIR).filter((x) => x.endsWith(".json")).sort()) {
      const spec = JSON.parse(readFileSync(path.join(PARITY_CHART_DIR, f), "utf8"))
      for (const style of ["datum", "gallery"]) {
        let h: string
        try {
          h = sha256(render(spec, style).svg)
        } catch {
          h = "refused"
        }
        lines.push(`${f}@${style}=${h}`)
      }
    }
    expect(lines.length).toBe(92)
    expect(sha256(lines.join("\n"))).toBe(PARITY_DIGEST)
  })
})
