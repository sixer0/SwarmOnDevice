// Swarm 1.2.6 row 64 (T-08, 01e §8, register N-018 FANOUT_SPLIT_MIN, E-13 edgeCollinear; 01g §3.4 red probe):
// fan-out sub-ranking in routeWithSides. A fan group (>= FANOUT_SPLIT_MIN edges on one node side, other ends
// across the corridor) is first routed as before; only when its members conflict among themselves
// (edgeConflicts: collinear or cross) it gets sorted slots, distinct exits and staggered turn levels, kept
// only if the group conflicts strictly drop (no new edgeThroughNode / lineThroughText). Clean groups stay
// byte-identical. Also the row 46 routed request (01e §4.2): a forward edge of a ranked flow leaves
// bottom -> top in TB and right -> left in LR (flowDirectionOf / flowRanks from layout-a/flow.ts).
// Fixtures: the fig02b2 FAN fixture (ported test :27) as flow and as graph; test/fixtures/anon126/t11_k1.json
// (anonymised 14.1 topology, ranks 1-4-2-1).
import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"

const PKG = path.resolve(import.meta.dir, "..", "..")
const D = path.join(PKG, "vendor", "src", "lib", "studio", "engine", "diagram")
const build = await import(path.join(D, "build", "index.ts"))
const lint = await import(path.join(D, "fit", "lint.ts"))
const scan = await import(path.join(PKG, "vendor", "src", "lib", "studio", "engine", "chart", "core", "svgscan.ts"))

const ENTRY_COLLISION_MM = 1.5 // fit/lint.ts:83 (row 25); literal so the file also loads at base
const base = (family: string, extra: Record<string, unknown>) => ({
  $schema: "studio.diagram/v1", family, id: "9.1", title: "Uji.", classification: "BIASA", width_mm: 166,
  apparatus: "page", labels_verified: true, sources: ["Uji"], ...extra,
})
// fig02b2-layout.test.ts:27 FAN, family parameterised (01g §3.4 probe: as flow and as graph).
const FAN = (family: string) =>
  base(family, {
    nodes: [{ id: "s", label: "Sumber", class: { col: 0, row: 0 } }, ...[0, 1, 2, 3].map((i) => ({ id: `t${i}`, label: `Tujuan ${i}`, class: { col: i, row: 1 } }))],
    edges: [0, 1, 2, 3].map((i) => ({ from: "s", to: `t${i}`, kind: "data", label: `d${i}` })),
  })
const K1_PATH = path.join(PKG, "test", "fixtures", "anon126", "t11_k1.json")
const K1 = existsSync(K1_PATH) ? JSON.parse(readFileSync(K1_PATH, "utf8")) : null
const k1 = (direction: string, width_mm: number) => ({ ...structuredClone(K1), direction, width_mm })
const run = (s: unknown) => build.buildDiagramSvg(structuredClone(s), { release: false })

const attrs = (tag: string): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const m of tag.matchAll(/([A-Za-z_:][-A-Za-z0-9_:.]*)="([^"]*)"/g)) out[m[1]] = m[2]
  return out
}
type Box = { x: number; y: number; w: number; h: number }
const nodeBoxes = (svg: string): Map<string, Box> =>
  new Map(
    [...svg.matchAll(/<rect\b([^>]*\bdata-mark="node"[^>]*)\/>/g)].map((m) => {
      const a = attrs(m[1])
      return [a["data-node"], { x: +a.x, y: +a.y, w: +a.width, h: +a.height }]
    }),
  )
type P = [number, number]
/** Edge polylines in edge order (data-index), hops removed by pathPolylines' first piece chain. */
const links = (svg: string): P[][] =>
  [...svg.matchAll(/<path\b([^>]*\bdata-mark="link"[^>]*)>/g)]
    .map((m) => attrs(m[1]))
    .sort((a, b) => Number(a["data-index"] ?? 0) - Number(b["data-index"] ?? 0))
    .map((a) => (scan.pathPolylines(a.d) as P[][]).flat() as P[])
const horizontals = (pl: P[]) =>
  pl.slice(1).flatMap((q, i) => (Math.abs(q[1] - pl[i][1]) < 1e-6 && Math.abs(q[0] - pl[i][0]) > 1e-6 ? [[pl[i][1], Math.min(q[0], pl[i][0]), Math.max(q[0], pl[i][0])]] : []))

// 01g §3.4 probe outcome (log test/red_logs/64_T-08-probe.log): FAN as graph edgeCollinear 0 at base (CHAR);
// FAN as legacy flow (no direction) edgeCollinear 1 at base, but a legacy flow is frozen at its 1.2.5 bytes
// (01e A15, row 45 goldens), so T-08 does not apply there. Escalation per 01g: the 14.1 topology (A8) and the
// FAN fixture as a ranked flow carry the red.
describe("row 64 T-08 FAN fixture (fig02b2-layout.test.ts:27)", () => {
  test("FAN as graph: edgeCollinear 0 (characterisation, green at base)", () => {
    expect(lint.lintDiagramGeometry(run(FAN("graph")).svg).counts.edgeCollinear).toBe(0)
  })
  test("FAN as ranked flow (TB 166): edgeCollinear 0, edgeCross 0, no edge through a node or text", () => {
    const g = lint.lintDiagramGeometry(run({ ...FAN("flow"), direction: "TB" }).svg)
    expect(g.counts.edgeCollinear).toBe(0)
    expect(g.counts.edgeCross).toBe(0)
    expect(g.counts.edgeThroughNode).toBe(0)
    expect(g.counts.lineThroughText).toBe(0)
  })
  test("FAN as graph, as legacy flow and as ranked flow: two builds give byte-identical SVG", () => {
    for (const s of [FAN("graph"), FAN("flow"), { ...FAN("flow"), direction: "TB" }]) expect(run(s).svg).toBe(run(s).svg)
  })
  test("FAN as graph keeps its 1.2.5 route quality: edgeCross <= 2 (fig02b2 P1-12)", () => {
    expect(lint.lintDiagramGeometry(run(FAN("graph")).svg).counts.edgeCross).toBeLessThanOrEqual(2)
  })
})

describe("row 64 T-08 A8 on the 14.1 topology (TB 128)", () => {
  test("the four n1 -> rank-1 edges: distinct first-point x >= ENTRY_COLLISION_MM apart, no shared horizontal run, edgeCollinear 0", () => {
    const r = run(k1("TB", 128))
    const pl = links(r.svg)
    const fan = K1.edges.map((e: any, i: number) => (e.from === "n1" ? pl[i] : null)).filter(Boolean) as P[][]
    expect(fan.length).toBe(4)
    const xs = fan.map((p) => p[0][0]).sort((a, b) => a - b)
    for (let i = 1; i < xs.length; i++) expect(xs[i] - xs[i - 1]).toBeGreaterThanOrEqual(ENTRY_COLLISION_MM - 1e-6)
    const hs = fan.map(horizontals)
    for (let i = 0; i < hs.length; i++)
      for (let j = i + 1; j < hs.length; j++)
        for (const a of hs[i]) for (const b of hs[j]) if (Math.abs(a[0] - b[0]) < 0.15) expect(Math.min(a[2], b[2]) - Math.max(a[1], b[1])).toBeLessThanOrEqual(1.0)
    const g = lint.lintDiagramGeometry(r.svg)
    expect(g.counts.edgeCollinear).toBe(0)
    expect(g.counts.edgeCross).toBe(0)
  })
})

describe("row 64 ranked flow forward sides (01e §4.2, routed by row 46)", () => {
  const sides = (direction: "TB" | "LR", width: number) => {
    const r = run(k1(direction, width))
    const boxes = nodeBoxes(r.svg)
    const pl = links(r.svg)
    K1.edges.forEach((e: any, i: number) => {
      const a = boxes.get(e.from)!
      const b = boxes.get(e.to)!
      const p = pl[i][0]
      const q = pl[i][pl[i].length - 1]
      if (direction === "TB") {
        expect([e.from, p[1]]).toEqual([e.from, expect.closeTo(a.y + a.h, 1)])
        expect([e.to, q[1]]).toEqual([e.to, expect.closeTo(b.y, 1)])
      } else {
        expect([e.from, p[0]]).toEqual([e.from, expect.closeTo(a.x + a.w, 1)])
        expect([e.to, q[0]]).toEqual([e.to, expect.closeTo(b.x, 1)])
      }
    })
    return r
  }
  test("TB 128: every forward edge leaves the bottom of its source and enters the top of its target", () => {
    sides("TB", 128)
  })
  test("LR 166: every forward edge leaves the right side and enters the left side", () => {
    sides("LR", 166)
  })
  test("TB 128 and LR 166: deterministic", () => {
    for (const [d, w] of [["TB", 128], ["LR", 166]] as const) expect(run(k1(d, w)).svg).toBe(run(k1(d, w)).svg)
  })
})

// 01e §8 on ranked flows: the fan rule makes the FIRST render clean, so AUTO_FIT is not needed for the fan
// (with fixed sides alone the lane nudge of AUTO_FIT had to repair it; at 1.2.6 HEAD before row 64 the
// 5-wide fans kept edgeCross 1 / edgeCollinear 1 and arrowTangent > 0).
const fanOut = (n: number, extra: Record<string, unknown>) =>
  base("flow", {
    nodes: [{ id: "s", label: "Sumber", class: {} }, ...Array.from({ length: n }, (_, i) => ({ id: `t${i}`, label: `Tujuan ${i}`, class: {} }))],
    edges: Array.from({ length: n }, (_, i) => ({ from: "s", to: `t${i}`, kind: "data", label: `d${i}` })),
    ...extra,
  })
const fanIn = (n: number, extra: Record<string, unknown>) =>
  base("flow", {
    nodes: [...Array.from({ length: n }, (_, i) => ({ id: `t${i}`, label: `Asal ${i}`, class: {} })), { id: "j", label: "Gabung", class: {} }],
    edges: Array.from({ length: n }, (_, i) => ({ from: `t${i}`, to: "j", kind: "data", label: `d${i}` })),
    ...extra,
  })
const CLEAN = ["edgeCollinear", "edgeCross", "edgeThroughNode", "lineThroughText", "arrowTangent", "edgeEntryCollision", "stubSegment"]

describe("row 64 T-08 sub-ranking on ranked flows (01e §8.2-8.7)", () => {
  const cases: Array<[string, unknown]> = [
    ["fan-out 4, TB 166", fanOut(4, { direction: "TB" })],
    ["fan-out 4, TB 128", fanOut(4, { direction: "TB", width_mm: 128 })],
    ["fan-out 5, TB 166 (5-wide rank, §8.4 levels)", fanOut(5, { direction: "TB" })],
    ["fan-out 6, LR 166", fanOut(6, { direction: "LR" })],
    ["fan-in 5, TB 166 (§8.7 mirror)", fanIn(5, { direction: "TB" })],
    ["fan-in 4, LR 166 (§8.7 mirror)", fanIn(4, { direction: "LR" })],
  ]
  for (const [name, s] of cases) {
    test(`${name}: zero GEOM_EDGE_COLLINEAR, no conflict kind, clean without AUTO_FIT, deterministic`, () => {
      const r = run(s)
      const ids = (r.report.geometry ?? []).map((g: any) => g.checkId)
      expect(ids).not.toContain("GEOM_EDGE_COLLINEAR")
      expect(ids).not.toContain("AUTO_FIT")
      const c = lint.lintDiagramGeometry(r.svg).counts
      for (const k of CLEAN) expect([k, c[k] ?? 0]).toEqual([k, 0])
      expect(run(s).svg).toBe(r.svg)
    })
  }
})

// 01e A21 (shared router, graph): the 5-target variant (source col 1, targets cols 0-4 at 166 mm) is refused
// DATUM-37 by graph capacity at 1.2.6 HEAD, so the 4-target variant is pinned as a characterisation.
describe("row 64 A21 graph fan (characterisation)", () => {
  test("graph 166, source col 1, 4 targets cols 0-3: edgeCollinear 0, edgeCross not above base (1)", () => {
    const s = base("graph", {
      nodes: [{ id: "s", label: "Sumber", class: { col: 1, row: 0 } }, ...[0, 1, 2, 3].map((i) => ({ id: `t${i}`, label: `Tujuan ${i}`, class: { col: i, row: 1 } }))],
      edges: [0, 1, 2, 3].map((i) => ({ from: "s", to: `t${i}`, kind: "data", label: `d${i}` })),
    })
    const c = lint.lintDiagramGeometry(run(s).svg).counts
    expect(c.edgeCollinear).toBe(0)
    expect(c.edgeCross).toBeLessThanOrEqual(1)
  })
})
