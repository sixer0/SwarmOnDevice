// Swarm 1.2.6 row 47 (T-11 acceptance, 01e §4.3-§4.5, §7.2 A2-A6, A9-A11, A13-A15; register N-160, C7):
// the 14.1-shaped fixture (test/fixtures/anon126/t11_k1.json, ranks 1-4-2-1) renders TB at 128 mm
// with the four parallel nodes in ONE rank (no serialisation) and zero geometry lint (A6 kinds and
// the T-03 kinds, i.e. no GEOM_STUB_SEGMENT after the §4.3 jog removal); LR at 128 mm is refused
// FIGURE_OVER_CAPACITY DATUM-37-lebar with limit 3 (sync and auto paths); a ranked flow passes the
// ELK R1 gate of buildDiagramSvgAuto; a legacy flow (no direction) keeps its bytes and gains one
// FLOW_SERIALISED REPORT line.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

const PKG = path.resolve(import.meta.dir, "..", "..")
const D = path.join(PKG, "vendor", "src", "lib", "studio", "engine", "diagram")
const build = await import(path.join(D, "build", "index.ts"))
const lint = await import(path.join(D, "fit", "lint.ts"))
const elk = await import(path.join(D, "elk", "index.ts"))

const json = (p: string) => JSON.parse(readFileSync(p, "utf8"))
const K1 = json(path.join(PKG, "test", "fixtures", "anon126", "t11_k1.json"))
const LEGACY = json(path.join(PKG, "test", "row45", "fixtures", "legacy_fanout_flow.json"))
const golden = (name: string) => readFileSync(path.join(PKG, "test", "row45", "__golden__", name), "utf8")
const clone = (s: any) => structuredClone(s)
const spec = (direction: string | undefined, width_mm: number) => {
  const s = { ...clone(K1), width_mm }
  if (direction === undefined) delete s.direction
  else s.direction = direction
  return s
}
const LX = 128 / 12
const W = 128

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
const svgHeight = (svg: string) => Number(/<svg[^>]*\bheight="([\d.]+)mm"/.exec(svg)![1])
const refusal = (f: () => unknown): any => {
  try {
    f()
  } catch (e) {
    return e
  }
  return undefined
}
const RANK1 = ["n2", "n3", "n4", "n5"]
// 01e A6 kinds plus the T-03 kinds (A7: edgeEntryCollision, stubSegment, arrowTangent).
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

describe("row 47 T-11 14.1 acceptance: direction TB at 128 mm", () => {
  const r = build.buildDiagramSvg(spec("TB", W), { release: false })
  const b = nodeBoxes(r.svg)

  test("A3: n2..n5 share one y; x intervals disjoint, ordered n2 < n3 < n4 < n5, gaps >= lx", () => {
    const ys = RANK1.map((id) => b.get(id)!.y)
    for (const y of ys) expect(Math.abs(y - ys[0])).toBeLessThanOrEqual(1e-6)
    for (let i = 1; i < RANK1.length; i++) {
      const p = b.get(RANK1[i - 1])!
      const q = b.get(RANK1[i])!
      expect(q.x - (p.x + p.w)).toBeGreaterThanOrEqual(LX - 1e-2)
    }
  })

  test("A4: y(n1) < y(n2) < y(n6) = y(n7) < y(n8); n6 left of n7", () => {
    const y = (id: string) => b.get(id)!.y
    expect(y("n1")).toBeLessThan(y("n2"))
    expect(y("n2")).toBeLessThan(y("n6"))
    expect(Math.abs(y("n6") - y("n7"))).toBeLessThanOrEqual(1e-6)
    expect(y("n6")).toBeLessThan(y("n8"))
    expect(b.get("n6")!.x + b.get("n6")!.w).toBeLessThan(b.get("n7")!.x)
  })

  test("A5: every node box inside [0, W]; one width per rank (no clamp)", () => {
    expect(b.size).toBe(8)
    for (const box of b.values()) {
      expect(box.x).toBeGreaterThanOrEqual(0)
      expect(box.x + box.w).toBeLessThanOrEqual(W + 1e-6)
    }
    for (const rank of [RANK1, ["n6", "n7"]]) {
      const ws = rank.map((id) => b.get(id)!.w)
      for (const w of ws) expect(Math.abs(w - ws[0])).toBeLessThanOrEqual(1e-6)
    }
  })

  test("A6 (+ T-03 kinds): zero geometry lint, no GEOM_STUB_SEGMENT after the §4.3 jog removal", () => {
    const g = lint.lintDiagramGeometry(r.svg)
    for (const k of KINDS) expect(`${k}=${g.counts[k] ?? 0}`).toBe(`${k}=0`)
    expect(g.score).toBe(0)
    const ids = (r.report.geometry ?? []).map((i: any) => i.checkId)
    expect(ids.filter((id: string) => id.startsWith("GEOM_"))).toEqual([])
  })

  test("A9: sheet height < 200.025 mm (1.2.5 serial layout) and <= 247 mm", () => {
    const h = svgHeight(r.svg)
    expect(h).toBeLessThan(200.025)
    expect(h).toBeLessThanOrEqual(247)
  })

  test("A10: two builds give byte-identical SVG", () => {
    expect(build.buildDiagramSvg(spec("TB", W), { release: false }).svg).toBe(r.svg)
  })

  test("A11: report.geometry has no FLOW_SERIALISED and no FAIL entry", () => {
    const geo = r.report.geometry ?? []
    expect(geo.some((i: any) => i.checkId === "FLOW_SERIALISED")).toBe(false)
    expect(geo.some((i: any) => i.status === "FAIL")).toBe(false)
  })

  test("A2 + ELK R1 gate: buildDiagramSvgAuto takes the ranked flow past R1; result keeps A3 and zero lint", async () => {
    let d: any
    const a = await elk.buildDiagramSvgAuto(spec("TB", W), { release: false }, {}, (x: any) => (d = x))
    expect(String(d?.reason ?? "")).not.toMatch(/^R1:/)
    const ab = nodeBoxes(a.svg)
    const ys = RANK1.map((id) => ab.get(id)!.y)
    for (const y of ys) expect(Math.abs(y - ys[0])).toBeLessThanOrEqual(1e-6)
    if (!d.used) for (const [id, box] of b) expect(ab.get(id)!.x).toBe(box.x)
    const g = lint.lintDiagramGeometry(a.svg)
    for (const k of KINDS) expect(`${k}=${g.counts[k] ?? 0}`).toBe(`${k}=0`)
  })

  test("R1 gate: a flow without direction still stops at R1 (family flow)", async () => {
    let d: any
    await elk.buildDiagramSvgAuto(spec(undefined, W), { release: false }, {}, (x: any) => (d = x))
    expect(d).toMatchObject({ used: false, reason: "R1: family flow" })
  })
})

describe("row 47 T-11 A13/A14: capacity refusals of the 14.1 fixture", () => {
  const expectA13 = (err: any) => {
    expect(err?.code).toBe("FIGURE_OVER_CAPACITY")
    expect(err.details).toMatchObject({ checkId: "DATUM-37-lebar", quantity: "peringkat", measured: 4, limit: 3 })
    expect(err.details.suggestion).toContain('direction "TB"')
  }
  test("A13: direction LR at 128 mm is refused DATUM-37-lebar, peringkat 4 > limit 3, suggestion TB (sync build)", () => {
    expectA13(refusal(() => build.buildDiagramSvg(spec("LR", W), { release: false })))
  })
  test("A13: the auto (ELK) path refuses the same, ELK never retries a capacity refusal", async () => {
    let err: any
    try {
      await elk.buildDiagramSvgAuto(spec("LR", W), { release: false })
    } catch (e) {
      err = e
    }
    expectA13(err)
  })
  test("A14: a fifth parallel node at TB 128 mm is refused simpul per peringkat 5 > limit 4", () => {
    const s = spec("TB", W)
    s.nodes.push({ id: "n9", label: "echo uniform", class: {} })
    s.edges.push({ from: "n1", to: "n9", kind: "control", label: "Echo 88" }, { from: "n9", to: "n7", kind: "verify", label: "echo" })
    const err = refusal(() => build.buildDiagramSvg(s, { release: false }))
    expect(err?.code).toBe("FIGURE_OVER_CAPACITY")
    expect(err.details).toMatchObject({ checkId: "DATUM-37-lebar", measured: 5, limit: 4 })
    expect(err.details.suggestion).toContain("width_mm 166")
    expect(err.details.suggestion).toContain('direction "LR"')
  })
})

describe("row 47 T-11 A15: legacy flow keeps its bytes and gains one FLOW_SERIALISED note (01e §4.4)", () => {
  test("14.1 fixture without direction: exactly one FLOW_SERIALISED REPORT naming rank 1 with 4 nodes", () => {
    const r = build.buildDiagramSvg(spec(undefined, W), { release: false })
    const notes = (r.report.geometry ?? []).filter((i: any) => i.checkId === "FLOW_SERIALISED")
    expect(notes).toHaveLength(1)
    expect(notes[0].status).toBe("REPORT")
    expect(notes[0].detail).toContain("peringkat 1: 4 simpul")
    expect(notes[0].suggest).toContain('direction "TB"')
  })
  test("legacy fan-out fixture: SVG equals the 1.2.5 golden, one FLOW_SERIALISED note; per_row 3 too", () => {
    const r = build.buildDiagramSvg(clone(LEGACY), { release: false })
    expect(r.svg).toBe(golden("legacy_fanout_flow.svg"))
    expect((r.report.geometry ?? []).filter((i: any) => i.checkId === "FLOW_SERIALISED")).toHaveLength(1)
    const p = build.buildDiagramSvg({ ...clone(LEGACY), per_row: 3 }, { release: false })
    expect(p.svg).toBe(golden("legacy_fanout_flow.per_row3.svg"))
    expect((p.report.geometry ?? []).filter((i: any) => i.checkId === "FLOW_SERIALISED")).toHaveLength(1)
  })
  test("a straight chain (no rank with 2 nodes) and a ranked flow get no FLOW_SERIALISED", () => {
    const chain = {
      ...clone(LEGACY),
      edges: LEGACY.nodes.slice(1).map((n: any, i: number) => ({ from: LEGACY.nodes[i].id, to: n.id, kind: "control", label: `t${i}` })),
    }
    const r = build.buildDiagramSvg(chain, { release: false })
    expect((r.report.geometry ?? []).some((i: any) => i.checkId === "FLOW_SERIALISED")).toBe(false)
  })
})
