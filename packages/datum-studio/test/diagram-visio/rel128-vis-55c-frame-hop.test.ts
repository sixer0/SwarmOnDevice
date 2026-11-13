// Swarm 1.2.8 row 55c (C133; AC-VIS2b pools, AC-VIS9 jumps, 01f §2.3, §3.3). Two engine defects found by row 58a:
//  1. vertical pools: in a figure that fits the 128 mm text column the second pool's frame ran past the figure edge
//     (x 101.33..144) and no lint issue said so. Now the pool columns are narrowed to fit inside the figure, and a
//     container frame (pool / lane box, lane / phase / pool rule, zone / group outline) outside the figure box is the
//     lint kind `frameOutside` (GEOM_FRAME_OUTSIDE), counted in the auto-fit score and failed by FIGURE_FIT.
//  2. jumps: vis9's crossing at 128 mm lies on a repeated vertex (x = 64.0) of the horizontal link, and no hop was drawn
//     although jumps are on. The hop test now runs on the straight runs of each path; a hop next to a bend moves along
//     its run so the arc stays on the straight piece.
// Fixtures: test/fixtures/syn128/vis0_carry_a.json (row 33b, lanes moved as row 58a's `fitA`), vis9_labels_jumps.json
// (row 57b) and inline synthetic specs. Red at BASE e1f9673772 / pre-55c HEAD: frame past the edge, no frameOutside kind,
// no hop at 128 mm. Namespace imports, so the red run fails on assertions, not on a link error.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import * as build from "../../vendor/src/lib/studio/engine/diagram/build"
import * as buildSvg from "../../vendor/src/lib/studio/engine/diagram/build/svg"
import * as autofit from "../../vendor/src/lib/studio/engine/diagram/build/autofit"
import * as elk from "../../vendor/src/lib/studio/engine/diagram/elk"
import * as lint from "../../vendor/src/lib/studio/engine/diagram/fit/lint"
import * as checks from "../../src/mcp-host/verify/static-checks"

type J = Record<string, any>
const FIX = path.join(import.meta.dir, "..", "fixtures", "syn128")
const fx = (name: string): J => JSON.parse(readFileSync(path.join(FIX, `${name}.json`), "utf8"))
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v))
const O = { release: false }
const V1 = { $schema: "studio.diagram/v1", id: "1.1", title: "Alur sintetis uji.", classification: "TERBATAS", sources: ["Sumber sintetis uji."], apparatus: "page" }

const svgOf = (spec: J): string => ((build as J).buildDiagramSvg(clone(spec), O) as J).svg as string
const autoOf = async (spec: J): Promise<J> => (await (elk as J).buildDiagramSvgAuto(clone(spec), O, {}, () => {})) as J
const lintOf = (svg: string): J => (lint as J).lintDiagramGeometry(svg) as J
const viewBox = (svg: string): [number, number] => {
  const v = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(svg)!
  return [Number(v[1]), Number(v[2])]
}
/** Unmarked stroked frame rects (pool boxes, zone / group outlines) and lines (rules) as centre-line boxes. */
function frames(svg: string): Array<{ el: string; box: [number, number, number, number] }> {
  const out: Array<{ el: string; box: [number, number, number, number] }> = []
  for (const m of svg.matchAll(/<(rect|line) ([^>]*)\/>/g)) {
    const a = m[2]
    if (/data-mark=|data-node=/.test(a) || !/ stroke="#/.test(a) || / fill="#/.test(a)) continue
    const n = (k: string) => Number(new RegExp(`\\b${k}="(-?[\\d.]+)"`).exec(a)?.[1] ?? 0)
    if (m[1] === "rect") out.push({ el: m[0], box: [n("x"), n("y"), n("x") + n("width"), n("y") + n("height")] })
    else out.push({ el: m[0], box: [Math.min(n("x1"), n("x2")), Math.min(n("y1"), n("y2")), Math.max(n("x1"), n("x2")), Math.max(n("y1"), n("y2"))] })
  }
  return out
}
const poolBoxes = (svg: string) => frames(svg).filter((f) => f.el.startsWith("<rect") && f.el.includes('stroke-width="0.45"'))

/** vis0_carry_a with the lanes moved (row 58a `fitA`): pool p1 holds Lajur 2 (a, b, c), pool p2 Lajur 1 (d, e, f). */
function carryA(): J {
  const spec = clone(fx("vis0_carry_a").spec)
  const lane: Record<string, string> = { a: "Lajur 2", b: "Lajur 2", c: "Lajur 2", d: "Lajur 1", e: "Lajur 1", f: "Lajur 1" }
  for (const n of spec.nodes as J[]) n.class.lane = lane[n.id]
  return { ...V1, width_mm: 128, ...spec }
}
/** Four vertical pools of one lane each: 4 columns + 3 pool gaps do not fit 128 mm even at 2 lattice per column. */
function fourPools(): J {
  const ids = ["p1", "p2", "p3", "p4"]
  return {
    ...V1,
    width_mm: 128,
    family: "swimlane",
    labels_verified: true,
    lane_orientation: "vertical",
    pools: ids.map((id, i) => ({ id, label: `Kolam ${i + 1}` })),
    nodes: ids.map((id, i) => ({ id: `n${i}`, label: `Langkah ${i + 1}`, class: { lane: "Lajur", pool: id } })),
    edges: [
      { from: "n0", to: "n1", kind: "control", label: "kirim" },
      { from: "n1", to: "n2", kind: "control", label: "teruskan" },
      { from: "n2", to: "n3", kind: "control", label: "balas" },
    ],
  }
}
const crossing = (w: number): J => ({ ...clone(fx("vis9_labels_jumps").crossing), width_mm: w })
const hopsOf = (svg: string): Array<[number, number, number]> =>
  [...svg.matchAll(/<path d="M ([\d.]+) ([\d.]+) A ([\d.]+) [\d.]+ 0 0 1 ([\d.]+) [\d.]+"[^>]*\/>/g)].map((m) => [
    (Number(m[1]) + Number(m[4])) / 2,
    Number(m[2]),
    Number(m[3]),
  ])

describe("55c frame: container frames stay inside the figure (C133 finding 2)", () => {
  for (const mode of ["sync", "auto"] as const) {
    test(`${mode}: vis0_carry_a (lanes moved) at 128 mm draws both pool frames inside the figure box`, async () => {
      const r = mode === "sync" ? { svg: svgOf(carryA()) } : await autoOf(carryA())
      const svg = r.svg as string
      const [W, H] = viewBox(svg)
      expect(W).toBe(128)
      const pools = poolBoxes(svg)
      expect(pools.length).toBe(2)
      for (const p of pools) expect([p.el, p.box[0] >= 0 && p.box[2] <= W - 0.225 + 1e-6]).toEqual([p.el, true])
      const outside = frames(svg).filter((f) => f.box[0] < -0.05 || f.box[1] < -0.05 || f.box[2] > W + 0.05 || f.box[3] > H + 0.05)
      expect(outside.map((f) => f.el)).toEqual([])
      expect(lintOf(svg).counts.frameOutside).toBe(0)
      // every node outline inside the figure, and inside its own pool column
      for (const m of svg.matchAll(/<(?:rect|polygon|circle)[^>]*data-node="[^"]+"[^>]*\/>/g)) {
        const xs = [...m[0].matchAll(/\b(?:x|cx)="([\d.]+)"/g)].map((v) => Number(v[1]))
        for (const x of xs) expect([m[0].slice(0, 60), x <= W]).toEqual([m[0].slice(0, 60), true])
      }
      if (mode === "auto") expect((r.report?.geometry ?? []).map((i: J) => i.checkId)).not.toContain("GEOM_FRAME_OUTSIDE")
    })
  }
  test("each pool's lane header sits centred in its (narrowed) pool column", () => {
    const svg = svgOf(carryA())
    const pools = poolBoxes(svg).map((p) => p.box)
    for (const [lbl, k] of [["LAJUR 2", 0], ["LAJUR 1", 1]] as const) {
      const t = new RegExp(`<text x="([\\d.]+)"[^>]*text-anchor="middle"[^>]*>${lbl}</text>`).exec(svg)
      expect(t, lbl).not.toBeNull()
      expect(Math.abs(Number(t![1]) - (pools[k][0] + pools[k][2]) / 2)).toBeLessThan(0.02)
    }
  })
  test("a figure whose pool columns already fit keeps its pool geometry (vertical pools at 166 mm)", () => {
    // 166 mm: the natural columns fit, the narrowing is a no-op (same frame geometry as the 1.2.8 row 55b layout)
    const svg = svgOf({ ...carryA(), width_mm: 166 })
    const pools = poolBoxes(svg).map((p) => p.box.map((v) => Number(v.toFixed(2))))
    expect(pools).toEqual([
      [37.33, 9.75, 80, 185.74],
      [101.33, 9.75, 144, 185.74],
    ])
  })
})

describe("55c lint: frameOutside / GEOM_FRAME_OUTSIDE (C133)", () => {
  const svgWith = (body: string) =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128.0 60.0" width="128mm" height="60mm">${body}</svg>`
  const pool = (x: number, w: number) => `<rect x="${x}" y="5" width="${w}" height="40" fill="none" stroke="#2B3640" stroke-width="0.45"/>`
  test("kind, constant and check id exist; a pool box past the right edge is one frameOutside defect with its overhang", () => {
    expect((lint as J).DIAGRAM_DEFECT_KINDS).toContain("frameOutside")
    expect((lint as J).FRAME_OUTSIDE_MIN_MM).toBe(0.05)
    const g = lintOf(svgWith(pool(37.33, 42.67) + pool(101.33, 42.67)))
    expect(g.counts.frameOutside).toBe(1)
    const d = g.defects.find((x: J) => x.kind === "frameOutside")
    expect(d?.amount).toBe(16)
    expect(g.score).toBeGreaterThan(0)
    const issues = (autofit as J).diagramGeometryIssues(g) as J[]
    expect(issues.map((i) => i.checkId)).toContain("GEOM_FRAME_OUTSIDE")
  })
  test("dashed zone / group outlines and rules count; edge-to-edge rules, filled bands and marked shapes do not", () => {
    const zone = `<rect x="-3" y="5" width="20" height="10" rx="1.6" ry="1.6" fill="none" stroke="#6B7783" stroke-width="0.2" stroke-dasharray="1.6 0.8 0.4 0.8"/>`
    const rule = `<line x1="10" y1="62" x2="20" y2="62" fill="none" stroke="#C3CBD1" stroke-width="0.2"/>`
    expect(lintOf(svgWith(zone)).counts.frameOutside).toBe(1)
    expect(lintOf(svgWith(rule)).counts.frameOutside).toBe(1)
    const fine = [
      `<line x1="0" y1="30" x2="128.0" y2="30" fill="none" stroke="#C3CBD1" stroke-width="0.2"/>`,
      `<rect x="0.23" y="5" width="127.55" height="40" fill="none" stroke="#2B3640" stroke-width="0.45"/>`,
      `<rect x="120" y="5" width="20" height="4" fill="#FCFCFB"/>`,
      `<rect x="120" y="20" width="20" height="10" data-node="z" fill="none" stroke="#2B3640" stroke-width="0.45" data-mark="node"/>`,
      `<rect x="127" y="40" width="3" height="3" fill="none" stroke="#C3CBD1" stroke-width="0.2"/>`, // hair solid rect = node shadow
    ].join("")
    expect(lintOf(svgWith(fine)).counts.frameOutside).toBe(0)
  })
  test("FIGURE_FIT fails a clipped frame (DIAGRAM_FAIL_KINDS)", () => {
    expect((checks as J).DIAGRAM_FAIL_KINDS.has("frameOutside")).toBe(true)
    const c = (checks as J).checkFigureFit({ format: "SVG", svg: svgWith(pool(101.33, 42.67)), figureKind: "diagram", figureLabel: "Gambar 1.1" })
    expect(c.status).toBe("FAIL")
    expect(c.findings.some((f: J) => f.code === "FIG_GEOMETRY" && /^frameOutside:/.test(f.detail ?? ""))).toBe(true)
  })
  test("four vertical pools at 128 mm cannot fit even narrowed: refused (DATUM-37), never a clipped frame", async () => {
    // the narrowing cannot help (2 lattice per column is still too wide): no clipped drawing is ever returned, the
    // capacity path refuses it (the node past the sheet is DATUM-37-sheet, which names the limit)
    let err: unknown
    try {
      await autoOf(fourPools())
    } catch (e) {
      err = e
    }
    expect(String((err as J)?.checkId ?? err)).toMatch(/^DATUM-37/)
  })
})

describe("55c jumps: a crossing on a run's vertex hops (C133 finding 1, vis9 at 128 mm)", () => {
  for (const mode of ["sync", "auto"] as const) {
    test(`${mode}: vis9 crossing at 128 mm draws one hop centred on the crossing (64.0, 33.34)`, async () => {
      const svg = mode === "sync" ? svgOf(crossing(128)) : ((await autoOf(crossing(128))).svg as string)
      const hops = hopsOf(svg)
      expect(hops.length).toBe(1)
      expect(Math.abs(hops[0][0] - 64)).toBeLessThan(0.02)
      expect(Math.abs(hops[0][1] - 33.34)).toBeLessThan(0.02)
      expect(hops[0][2]).toBe(0.9)
    })
  }
  test("jumps off still draws no hop at 128 mm; 166 mm keeps its one hop", () => {
    expect(hopsOf(svgOf({ ...crossing(128), jumps: "off" })).length).toBe(0)
    const h = hopsOf(svgOf(crossing(166)))
    expect(h.length).toBe(1)
    expect(Math.abs(h[0][0] - 80)).toBeLessThan(0.02)
  })
  const J_ = (buildSvg as J).jumpHops as (p: J[]) => J[]
  const P = (points: Array<[number, number]>) => ({ from: "a", to: "b", kind: "data", points })
  test("jumpHops: repeated and straight-through vertices; drawn path d unchanged", () => {
    expect(typeof J_).toBe("function")
    const hor = P([[0, 10], [20, 10], [20, 10], [40, 10]])
    const ver = P([[20, 0], [20, 5], [20, 15], [20, 20]])
    const out = J_([hor, ver])
    expect(out[0].hops).toEqual([[20, 10]])
    expect(out[0].d).toBe("M 0.0 10.0 L 20.0 10.0 L 20.0 10.0 L 40.0 10.0")
    // a crossing at the vertical path's straight-through vertex (y = 10) hops too
    const ver2 = P([[25, 0], [25, 10], [25, 20]])
    expect(J_([P([[0, 10], [40, 10]]), ver2])[0].hops).toEqual([[25, 10]])
    // a real U-turn vertex is not merged: no crossing invented
    expect(J_([P([[0, 10], [30, 10], [10, 10]]), P([[35, 0], [35, 20]])])[0].hops).toEqual([])
  })
  test("jumpHops: a hop within the hop radius of a bend moves along its run, off the bend; a far hop stays", () => {
    // horizontal run 0..20 then a bend down at x = 20; vertical crossing at x = 19.6 (0.4 mm from the bend, r = 0.9)
    const bent = P([[0, 10], [20, 10], [20, 30]])
    const near = J_([bent, P([[19.6, 0], [19.6, 12]])])[0].hops as Array<[number, number]>
    expect(near.length).toBe(1)
    expect(near[0][0]).toBeCloseTo(19.1, 6)
    expect(near[0][0] - 0.9 < 19.6 && 19.6 < near[0][0] + 0.9).toBe(true) // the arc still spans the crossing
    // a crossing near the path's own end (node border) is not a bend: unchanged
    expect(J_([bent, P([[0.5, 0], [0.5, 12]])])[0].hops).toEqual([[0.5, 10]])
    // far from the bend: unchanged
    expect(J_([bent, P([[10, 0], [10, 12]])])[0].hops).toEqual([[10, 10]])
  })
})

// ── C134 (M3 gate 03_gate_m3.md) extension of row 55c: G3-01, G3-02, G3-03, G3-15 ────────────────────────────────
const pg = (v: string, w: number): J => ({ ...clone(fx("vis2_pools_group")[v]), width_mm: w })
const refusal = async (spec: J): Promise<J | null> => {
  try {
    await autoOf(spec)
    return null
  } catch (e) {
    return e as J
  }
}

describe("55c G3-01: horizontal pools at 128 mm are refused DATUM-37 with the vertical-pool remedy (C116 D55b-1)", () => {
  for (const v of ["spec", "cross"] as const) {
    test(`vis2_pools_group ${v} at 128 mm: refused, never drawn with squeezed nodes or a zone past the figure`, async () => {
      const e = await refusal(pg(v, 128))
      expect(e, "refused").not.toBeNull()
      expect(e!.code).toBe("FIGURE_OVER_CAPACITY")
      expect(String(e!.details?.checkId ?? e!.checkId)).toMatch(/^DATUM-37/)
      expect(String(e!.message)).toContain("keluar kolam")
      expect(String(e!.message)).toContain('lane_orientation "vertical"')
    })
    test(`vis2_pools_group ${v} at 128 mm: the capacity line counts the pool strip (max below the measured count)`, async () => {
      const e = await refusal(pg(v, 128))
      expect(e, "refused").not.toBeNull()
      const d = e!.details ?? e!
      expect(typeof d.measured).toBe("number")
      expect(d.limit).toBeLessThan(d.measured)
      const m = /maks (\d+) per baris lajur/.exec(String(d.suggestion ?? e!.message))
      expect(m, "capacity line present").not.toBeNull()
      expect(Number(m![1])).toBeLessThan(d.measured)
    })
    test(`vis2_pools_group ${v} at 166 mm: drawn, every node and frame inside the figure`, async () => {
      const r = await autoOf(pg(v, 166))
      const [W] = viewBox(r.svg)
      expect(lintOf(r.svg).counts.frameOutside).toBe(0)
      const xs = [...(r.svg as string).matchAll(/<rect x="([\d.]+)"[^>]*width="([\d.]+)"[^>]*data-node=/g)].map((m) => Number(m[1]) + Number(m[2]))
      expect(xs.length).toBeGreaterThan(0)
      expect(xs.every((x) => x <= W - 10.6667 / 2 + 0.02)).toBe(true)
    })
  }
})

describe("55c G3-02: vertical pools at 128 mm keep every frame inside the figure", () => {
  test("vis2_pools_group vertical at 128 mm: no frame outside, lint frameOutside 0", async () => {
    const r = await autoOf(pg("vertical", 128))
    const [W, H] = viewBox(r.svg)
    expect(frames(r.svg).filter((f) => f.box[0] < -0.05 || f.box[2] > W + 0.05 || f.box[3] > H + 0.05).map((f) => f.el)).toEqual([])
    expect(lintOf(r.svg).counts.frameOutside).toBe(0)
    expect(lintOf(r.svg).counts.textOutside).toBe(0) // KOLAM Y header no longer cut
  })
})

// G3-03 (the lint counting a crossing on a run's vertex) is NOT in this row: counting it makes the capacity wrap of a
// one-lane chain (swimlane6, fig02b2 P1-14, engfix D-503) unclean, so those figures would be refused. Held for a
// controller ruling (55c report, request R1); the hop itself is drawn (describe "55c jumps" above).

describe("55c G3-15: pools whose lanes have no name draw no empty lane-header band", () => {
  // the skill's bpmn_pools example (diagram-flow.md): vertical pools, nodes without class.lane
  const bpmn = (named: boolean): J => ({
    ...V1,
    width_mm: 128,
    family: "swimlane",
    lane_orientation: "vertical",
    labels_verified: true,
    pools: [{ id: "p1", label: "Pemohon" }, { id: "p2", label: "Kantor" }],
    nodes: [
      { id: "s", label: "Mulai", shape: "event_start", class: { pool: "p1", ...(named ? { lane: "Loket" } : {}) } },
      { id: "t", label: "Kirim berkas", shape: "task", class: { pool: "p1", ...(named ? { lane: "Loket" } : {}) } },
      { id: "r", label: "Terima berkas", shape: "task", class: { pool: "p2", ...(named ? { lane: "Arsip" } : {}) } },
    ],
    edges: [
      { from: "s", to: "t", kind: "data", label: "ke" },
      { from: "t", to: "r", kind: "control", label: "berkas", arrow_start: "circle", arrow_end: "open" },
    ],
  })
  test("unnamed lanes: no hair rule under the pool header; the sheet is one lane-header row (2 lattice) shorter", () => {
    const un = svgOf(bpmn(false))
    const nm = svgOf(bpmn(true))
    const hair = (svg: string) => [...svg.matchAll(/<line x1="[\d.]+" y1="([\d.]+)" x2="[\d.]+" y2="([\d.]+)" fill="none" stroke="#C3CBD1" stroke-width="0.2"\/>/g)].filter((m) => m[1] === m[2]).length
    expect(hair(nm)).toBeGreaterThan(0)
    expect(hair(un)).toBe(0)
    expect(viewBox(nm)[1] - viewBox(un)[1]).toBeCloseTo(4.7625 * 2, 2)
  })
})
