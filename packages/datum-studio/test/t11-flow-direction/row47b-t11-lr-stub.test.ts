// Swarm 1.2.6 row 47b (T-11 follow-up to row 47, decision C14): the 14.1-shaped fixture
// (test/fixtures/anon126/t11_k1.json, ranks 1-4-2-1) drawn direction LR at 166 mm has zero of all
// 11 geometry lint kinds, including GEOM_STUB_SEGMENT.
// Root cause of the stub row 47 reported (measured on a tree before row 64 ae5fc66d05): the n1 fan-out
// (4 edges off one right side) bent n1->n3 at one shared column (x 33.19), and the 'Tango 88' knockout
// band cut a 0.45 mm tick off it (konektor 1, rule (c)/(d)). Row 64's T-08 fan sub-ranking gives each
// fan member its own exit and turn level (outermost first), and the tick is gone; the ranked LR
// placement in layout-a/flow.ts needs no change. This test pins the LR acceptance so the stub cannot
// come back through a later placement or routing change.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

const PKG = path.resolve(import.meta.dir, "..", "..")
const D = path.join(PKG, "vendor", "src", "lib", "studio", "engine", "diagram")
const build = await import(path.join(D, "build", "index.ts"))
const lint = await import(path.join(D, "fit", "lint.ts"))
const elk = await import(path.join(D, "elk", "index.ts"))

const K1 = JSON.parse(readFileSync(path.join(PKG, "test", "fixtures", "anon126", "t11_k1.json"), "utf8"))
const spec = () => ({ ...structuredClone(K1), direction: "LR", width_mm: 166 })
const KINDS = [
  "edgeCollinear",
  "edgeCross",
  "edgeThroughNode",
  "lineThroughText",
  "textOverlap",
  "textOutside",
  "textExceedsNode",
  "textOverNode",
  "edgeEntryCollision",
  "stubSegment",
  "arrowTangent",
]
const attrs = (tag: string): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const m of tag.matchAll(/([A-Za-z_:][-A-Za-z0-9_:.]*)="([^"]*)"/g)) out[m[1]] = m[2]
  return out
}
const nodeBoxes = (svg: string) =>
  new Map(
    [...svg.matchAll(/<rect\b([^>]*\bdata-mark="node"[^>]*)\/>/g)].map((m) => {
      const a = attrs(m[1])
      return [a["data-node"], { x: +a.x, y: +a.y, w: +a.width, h: +a.height }] as const
    }),
  )
const zero = (svg: string) => {
  const g = lint.lintDiagramGeometry(svg)
  return KINDS.map((k) => `${k}=${g.counts[k] ?? 0}`)
}
const ZERO = KINDS.map((k) => `${k}=0`)

describe("row 47b T-11: direction LR at 166 mm, no stub", () => {
  const r = build.buildDiagramSvg(spec(), { release: false })

  test("ranked LR layout: n2..n5 share one column x, stacked; n1 < n2 < n6 < n8 left to right", () => {
    const b = nodeBoxes(r.svg)
    const r1 = ["n2", "n3", "n4", "n5"].map((id) => b.get(id)!)
    for (const n of r1) expect(Math.abs(n.x - r1[0].x)).toBeLessThanOrEqual(1e-6)
    for (let i = 1; i < r1.length; i++) expect(r1[i].y).toBeGreaterThanOrEqual(r1[i - 1].y + r1[i - 1].h - 1e-6)
    const chain = ["n1", "n2", "n6", "n8"].map((id) => b.get(id)!)
    for (let i = 1; i < chain.length; i++) expect(chain[i].x).toBeGreaterThan(chain[i - 1].x + chain[i - 1].w)
  })

  test("all 11 lint kinds are 0 (incl. stubSegment); no GEOM_ line in the report", () => {
    expect(zero(r.svg)).toEqual(ZERO)
    const ids = (r.report.geometry ?? []).map((i: any) => i.checkId)
    expect(ids.filter((id: string) => id.startsWith("GEOM_"))).toEqual([])
  })

  test("release build: all 11 lint kinds are 0", () => {
    expect(zero(build.buildDiagramSvg(spec(), { release: true }).svg)).toEqual(ZERO)
  })

  test("auto path (ELK R2-R4): the original layout is kept with no route defect, all 11 kinds 0", async () => {
    let decision: any
    const a = await elk.buildDiagramSvgAuto(spec(), { release: false }, {}, (d: any) => (decision = d))
    expect(decision?.reason).toBe("R2: original layout has no route defect")
    expect(zero(a.svg)).toEqual(ZERO)
  })

  test("deterministic: two builds give byte-identical SVG", () => {
    expect(build.buildDiagramSvg(spec(), { release: false }).svg).toBe(r.svg)
  })
})
