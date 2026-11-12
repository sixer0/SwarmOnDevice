// Swarm 1.2.6 row 46 (T-11, 01e §4-§6, register N-109, N-111, N-112, N-161..N-164, C7):
// the ranked flow layout engine. A flow WITH `direction` is laid out by ranks computed from its
// edges (TB: a rank side by side; LR: a rank stacked), ELK gets ELK_DIRECTION and an ElkPlan with
// `direction`, capacity follows the lattice formulas (TB 4 @128 / 5 @166 per rank; LR 3 @128 / 4 @166
// ranks; LR 6 per rank). Fixture: test/fixtures/anon126/t11_k1.json (anonymised 14.1 topology,
// ranks 1-4-2-1). The legacy flow (no direction) stays byte-identical: row 45 A15 goldens.
// 01e assertions: A12 (LR 166), A18 (ELK direction), A20 LR part (estimate parity); engine limits
// behind A13/A14 (row 47 owns the 14.1 acceptance runs).
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

const PKG = path.resolve(import.meta.dir, "..", "..")
const STUDIO = path.join(PKG, "vendor", "src", "lib", "studio")
const D = path.join(STUDIO, "engine", "diagram")
const build = await import(path.join(D, "build", "index.ts"))
const core = await import(path.join(D, "core", "index.ts"))
const lint = await import(path.join(D, "fit", "lint.ts"))
const flow = await import(path.join(D, "layout-a", "flow.ts"))
const adapter = await import(path.join(D, "elk", "adapter.ts"))
const plans = await import(path.join(D, "elk", "plan.ts"))
const place = await import(path.join(D, "build", "place.ts"))
const estimateMod = await import(path.join(D, "core", "estimate.ts"))
const dispatch = await import(path.join(STUDIO, "contract", "dispatch.ts"))

const json = (p: string) => JSON.parse(readFileSync(p, "utf8"))
const K1 = json(path.join(PKG, "test", "fixtures", "anon126", "t11_k1.json"))
const CASE04 = json(path.join(PKG, "test", "engine-rev-a", "svg", "fixtures", "case04.studio.json"))
const clone = (s: any) => structuredClone(s)
const spec = (direction: string | undefined, width_mm: number) => {
  const s = { ...clone(K1), width_mm }
  if (direction === undefined) delete s.direction
  else s.direction = direction
  return s
}
const LX = 128 / 12

const attrs = (tag: string): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const m of tag.matchAll(/([A-Za-z_:][-A-Za-z0-9_:.]*)="([^"]*)"/g)) out[m[1]] = m[2]
  return out
}
type Box = { id: string; x: number; y: number; w: number; h: number }
const nodeBoxes = (svg: string): Map<string, Box> =>
  new Map(
    [...svg.matchAll(/<rect\b([^>]*\bdata-mark="node"[^>]*)\/>/g)].map((m) => {
      const a = attrs(m[1])
      return [a["data-node"], { id: a["data-node"], x: +a.x, y: +a.y, w: +a.width, h: +a.height }]
    }),
  )
const svgHeight = (svg: string) => Number(/<svg[^>]*\bheight="([\d.]+)mm"/.exec(svg)![1])
// 01e A6 kinds (T-03 kinds are A7, after rows 25/26).
const A6 = ["edgeCollinear", "edgeCross", "edgeThroughNode", "lineThroughText", "textOverlap", "textOutside", "textExceedsNode", "textOverNode"]

const RANK1 = ["n2", "n3", "n4", "n5"]

describe("row 46 T-11 ranks from the edges (01e §4.1)", () => {
  test("14.1 topology ranks 1-4-2-1: [n1] [n2 n3 n4 n5] [n6 n7] [n8]", () => {
    const r = flow.flowRanks(spec("TB", 128))
    expect(r.ranks.map((g: any[]) => g.map((n) => n.id))).toEqual([["n1"], RANK1, ["n6", "n7"], ["n8"]])
    expect(r.back.size).toBe(0)
  })
  test("a back edge (n8 -> n1) and a self-loop are ignored for ranking", () => {
    const s = spec("TB", 128)
    s.edges.push({ from: "n8", to: "n1", kind: "control", label: "ulang" }, { from: "n3", to: "n3", kind: "control", label: "diri" })
    const r = flow.flowRanks(s)
    expect(r.ranks.map((g: any[]) => g.map((n) => n.id))).toEqual([["n1"], RANK1, ["n6", "n7"], ["n8"]])
    expect([...r.back]).toEqual([10])
  })
  test("order inside a rank follows the mean predecessor position (crossed pairs straighten)", () => {
    const s = {
      family: "flow",
      direction: "TB",
      nodes: ["a", "b", "x", "y"].map((id) => ({ id, label: id })),
      edges: [
        { from: "a", to: "y", kind: "control", label: "ay" },
        { from: "b", to: "x", kind: "control", label: "bx" },
      ],
    }
    expect(flow.flowRanks(s).ranks.map((g: any[]) => g.map((n) => n.id))).toEqual([["a", "b"], ["y", "x"]])
  })
})

describe("row 46 T-11 lattice capacity (01e §5)", () => {
  test("TB nodes per rank: 4 at 128 mm, 5 at 166 mm; LR ranks: 3 at 128 mm, 4 at 166 mm; LR per rank 6", () => {
    expect(flow.flowTbMaxPerRank(128, LX)).toBe(4)
    expect(flow.flowTbMaxPerRank(166, LX)).toBe(5)
    expect(flow.flowLrMaxRanks(128, LX)).toBe(3)
    expect(flow.flowLrMaxRanks(166, LX)).toBe(4)
    expect(flow.FLOW_LR_MAX_PARALLEL).toBe(6)
    expect([flow.FLOW_RANK_NODE_MIN_UNITS, flow.FLOW_RANK_GAP_BASELINES, flow.FLOW_LR_CORRIDOR_UNITS]).toEqual([2, 4, 2])
  })
  test("LR at 128 mm (4 ranks) is refused FIGURE_OVER_CAPACITY DATUM-37-lebar, peringkat measured 4 limit 3, suggestion TB", () => {
    let err: any
    try {
      build.buildDiagramSvg(spec("LR", 128), { release: false })
    } catch (e) {
      err = e
    }
    expect(err?.code).toBe("FIGURE_OVER_CAPACITY")
    expect(err.details).toMatchObject({ checkId: "DATUM-37-lebar", quantity: "peringkat", unit: "peringkat", measured: 4, limit: 3 })
    expect(err.details.suggestion).toContain('direction "TB"')
  })
  test("TB rank of 5 at 128 mm is refused (measured 5, limit 4, suggestions width_mm 166 and direction LR); fits at 166 mm", () => {
    const s = spec("TB", 128)
    s.nodes.push({ id: "n9", label: "echo uniform", class: {} })
    s.edges.push({ from: "n1", to: "n9", kind: "control", label: "Echo 88" }, { from: "n9", to: "n7", kind: "verify", label: "echo" })
    let err: any
    try {
      build.buildDiagramSvg(s, { release: false })
    } catch (e) {
      err = e
    }
    expect(err?.code).toBe("FIGURE_OVER_CAPACITY")
    expect(err.details).toMatchObject({ checkId: "DATUM-37-lebar", quantity: "simpul per peringkat", unit: "simpul", measured: 5, limit: 4 })
    expect(err.details.suggestion).toContain("width_mm 166")
    expect(err.details.suggestion).toContain('direction "LR"')
    const b = nodeBoxes(build.buildDiagramSvg({ ...s, width_mm: 166 }, { release: false }).svg)
    expect(new Set(["n2", "n3", "n4", "n5", "n9"].map((id) => b.get(id)!.y)).size).toBe(1)
  })
  test("LR rank of 7 is refused simpul per peringkat LR, limit 6", () => {
    const s = spec("LR", 166)
    for (const k of [9, 10, 11]) {
      s.nodes.push({ id: `n${k}`, label: `kilo ${k}`, class: {} })
      s.edges.push({ from: "n1", to: `n${k}`, kind: "control", label: `kilo ${k}` })
    }
    let err: any
    try {
      build.buildDiagramSvg(s, { release: false })
    } catch (e) {
      err = e
    }
    expect(err?.code).toBe("FIGURE_OVER_CAPACITY")
    expect(err.details).toMatchObject({ checkId: "DATUM-37-lebar", quantity: "simpul per peringkat LR", measured: 7, limit: 6 })
  })
})

describe("row 46 T-11 A12: direction LR at 166 mm", () => {
  const s = spec("LR", 166)
  const r = build.buildDiagramSvg(clone(s), { release: false })
  const b = nodeBoxes(r.svg)
  test("rank 1 (n2..n5) shares one x; y intervals disjoint and ordered", () => {
    const xs = RANK1.map((id) => b.get(id)!.x)
    for (const x of xs) expect(Math.abs(x - xs[0])).toBeLessThanOrEqual(1e-6)
    for (let i = 1; i < RANK1.length; i++) {
      const p = b.get(RANK1[i - 1])!
      const q = b.get(RANK1[i])!
      expect(q.y).toBeGreaterThanOrEqual(p.y + p.h - 1e-6)
    }
  })
  test("rank x strictly increasing n1 < n2 < n6 < n8 (columns left to right, no overlap)", () => {
    const chain = ["n1", "n2", "n6", "n8"].map((id) => b.get(id)!)
    for (let i = 1; i < chain.length; i++) expect(chain[i].x).toBeGreaterThan(chain[i - 1].x + chain[i - 1].w)
    expect(b.get("n6")!.x).toBe(b.get("n7")!.x)
  })
  test("every node inside the T-02 edge inset (2 mm) of the 166 mm canvas", () => {
    for (const n of b.values()) {
      expect(n.x).toBeGreaterThanOrEqual(2 - 1e-6)
      expect(n.x + n.w).toBeLessThanOrEqual(166 - 2 + 1e-6)
    }
  })
  test("A6 geometry lint kinds are 0", () => {
    const g = lint.lintDiagramGeometry(r.svg)
    for (const k of A6) expect([k, g.counts[k] ?? 0]).toEqual([k, 0])
  })
  test("deterministic: two builds give byte-identical SVG", () => {
    expect(build.buildDiagramSvg(clone(s), { release: false }).svg).toBe(r.svg)
  })
  test("A20 (LR): estimate height equals the build; layout boxes equal up to the one T-02 translate", () => {
    const e = estimateMod.estimate(clone(s), dispatch.DIAGRAM_LAYOUTS.flow)
    expect(e.heightMm).toBeCloseTo(svgHeight(r.svg), 3)
    const lay = dispatch.DIAGRAM_LAYOUTS.flow(clone(s), new core.Sheet(166))
    const dx = b.get("n1")!.x - lay.nodes.n1.x
    for (const [id, n] of b) {
      const l = lay.nodes[id]
      expect(Math.abs(l.x + dx - n.x)).toBeLessThan(0.01)
      expect(Math.abs(l.y - n.y)).toBeLessThan(0.01)
      expect(Math.abs(l.w - n.w)).toBeLessThan(0.01)
      expect(Math.abs(l.h - n.h)).toBeLessThan(0.01)
    }
  })
})

describe("row 46 T-11 direction TB: a rank side by side (engine; 14.1 acceptance is row 47)", () => {
  test("TB at 128 mm: n2..n5 share one y, x disjoint and ordered, gaps >= lx; ranks top-down", () => {
    const b = nodeBoxes(build.buildDiagramSvg(spec("TB", 128), { release: false }).svg)
    const r1 = RANK1.map((id) => b.get(id)!)
    for (const n of r1) expect(Math.abs(n.y - r1[0].y)).toBeLessThanOrEqual(1e-6)
    for (let i = 1; i < r1.length; i++) expect(r1[i].x - (r1[i - 1].x + r1[i - 1].w)).toBeGreaterThanOrEqual(LX - 0.01)
    expect(b.get("n1")!.y).toBeLessThan(r1[0].y)
    expect(b.get("n6")!.y).toBe(b.get("n7")!.y)
    expect(r1[0].y).toBeLessThan(b.get("n6")!.y)
    expect(b.get("n6")!.y).toBeLessThan(b.get("n8")!.y)
    expect(b.get("n6")!.x).toBeLessThan(b.get("n7")!.x)
    for (const n of b.values()) expect(n.x >= 2 - 1e-6 && n.x + n.w <= 126 + 1e-6).toBe(true)
  })
})

describe("row 46 T-11 A18: ELK direction (N-111, N-164)", () => {
  test("ELK_DIRECTION = { TB: DOWN, LR: RIGHT }", () => {
    expect({ ...adapter.ELK_DIRECTION }).toEqual({ TB: "DOWN", LR: "RIGHT" })
  })
  test('elkGraphFor: LR 166 -> elk.direction "RIGHT", TB -> "DOWN", layered CASE04 still "DOWN"; option key set unchanged', () => {
    const lr = adapter.elkGraphFor(spec("LR", 166)).graph.layoutOptions
    const tb = adapter.elkGraphFor(spec("TB", 128)).graph.layoutOptions
    const layered = adapter.elkGraphFor(clone(CASE04)).graph.layoutOptions
    expect(lr["elk.direction"]).toBe("RIGHT")
    expect(tb["elk.direction"]).toBe("DOWN")
    expect(layered["elk.direction"]).toBe("DOWN")
    expect(Object.keys(lr).sort()).toEqual(Object.keys(layered).sort())
  })
  test("elkGraphFor ranked flow: layers are the ranks, generated ids only, intra-rank edges left out", () => {
    const g = adapter.elkGraphFor(spec("LR", 166))
    expect(g.tiers.map((t: any[]) => t.map((n) => n.id))).toEqual([["n1"], RANK1, ["n6", "n7"], ["n8"]])
    expect(g.graph.children.every((c: any) => /^n\d+$/.test(c.id))).toBe(true)
    expect(g.graph.edges.length).toBe(10)
  })
  test("elkPlanKey differs between TB and LR copies of one spec; a spec without direction keeps the 1.2.5 key", () => {
    expect(plans.elkPlanKey(spec("TB", 166))).not.toBe(plans.elkPlanKey(spec("LR", 166)))
    const legacy = spec(undefined, 166)
    expect(plans.elkPlanKey(legacy)).toBe(JSON.stringify(["1.1", 166, "flow", legacy.nodes.map((n: any) => n.id)]))
  })
  test("elkRefusal: ranked flow eligible; flow without direction keeps the family refusal", () => {
    expect(adapter.elkRefusal(spec("LR", 166))).toBeNull()
    expect(adapter.elkRefusal(spec("TB", 128))).toBeNull()
    expect(adapter.elkRefusal(spec(undefined, 128))).toBe("family 'flow' is not laid out by ELK")
  })
  test("elkLayoutPlan LR: direction LR, one ELK column per rank, no edge sections (route import TB-only); the plan applies only to LR", async () => {
    const s = spec("LR", 166)
    const plan = await adapter.elkLayoutPlan(s)
    expect(plan.direction).toBe("LR")
    expect(plan.layers.map((ids: string[]) => [...ids].sort())).toEqual([["n1"], RANK1, ["n6", "n7"], ["n8"]])
    expect(plan.sections).toEqual([])
    expect(plans.withElkPlan(plan, () => plans.elkPlanFor(s, 166))).toBe(plan)
    expect(plans.withElkPlan(plan, () => plans.elkPlanFor(spec("TB", 166), 166))).toBeUndefined()
    // Studio build with the LR plan: ELK order inside the ranks, ranks still columns.
    const sheet = plans.withElkPlan(plan, () => place.placeDiagram(clone(s), new core.Sheet(166), dispatch.DIAGRAM_LAYOUTS).sheet)
    const ys = plan.order["1"].map((id: string) => sheet.nodes.get(id).y)
    expect([...ys].sort((a, b) => a - b)).toEqual(ys)
    expect(new Set(RANK1.map((id) => sheet.nodes.get(id).x)).size).toBe(1)
  })
  test("elkLayoutPlan TB: direction TB, sections present (TB route import unchanged)", async () => {
    const plan = await adapter.elkLayoutPlan(spec("TB", 128))
    expect(plan.direction).toBe("TB")
    expect(plan.sections.length).toBe(10)
  })
})
