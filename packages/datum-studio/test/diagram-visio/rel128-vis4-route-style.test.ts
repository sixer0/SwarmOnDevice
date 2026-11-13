// Swarm 1.2.8 row 56 (AC-VIS4, F-VISIO 01f §3.2-§3.3, §7 (b); register N8-254, N8-255, N8-375, N8-469, N8-475;
// C12 OP-18-6, OP-18-8). VIS-4 connector route style: `straight` = one segment, `curved` = a Bezier sampled into
// CURVE_SAMPLES equal-parameter segments with ends normal to the sides, `data-route` on both, absent for orthogonal.
// Fixture: test/fixtures/syn128/vis4_routes.json (synthetic labels). The `curved` + `via` refusal (P1-edge-style) is
// not here: row 52c adds the spec check, row 56b closes it.
// Red at BASE e1f9673772: the engine ignores `route` (every edge orthogonal, no data-route), `curvedPoints` does not
// exist. Namespace imports, so the red run fails on assertions, not on a link error.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { buildDiagramSvg } from "../../vendor/src/lib/studio/engine/diagram/build"
import * as routeMod from "../../vendor/src/lib/studio/engine/diagram/build/route"
import { buildDiagramSvgAuto } from "../../vendor/src/lib/studio/engine/diagram/elk"
import { lintDiagramGeometry } from "../../vendor/src/lib/studio/engine/diagram/fit/lint"
import * as tokens from "../../vendor/src/lib/studio/engine/diagram/core/tokens"
import { lintRendered } from "../../vendor/src/lib/studio/engine/lint/render"

type J = Record<string, any>
type Pt = [number, number]
const R = routeMod as J
const FX = JSON.parse(readFileSync(path.join(import.meta.dir, "..", "fixtures", "syn128", "vis4_routes.json"), "utf8")) as J
/** Build options as the render path passes them outside a release gate. */
const O = { release: false }
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v))

interface Link {
  attrs: string
  pts: Pt[]
}
function links(svg: string): Link[] {
  return [...svg.matchAll(/<path d="([^"]+)"([^>]*data-mark="link"[^>]*)\/>/g)].map((m) => ({
    attrs: m[2],
    pts: m[1]
      .replace(/^M\s*/, "")
      .split(/\s*L\s*/)
      .map((p) => p.trim().split(/\s+/).map(Number) as Pt),
  }))
}
function rects(svg: string): Map<string, [number, number, number, number]> {
  const out = new Map<string, [number, number, number, number]>()
  for (const m of svg.matchAll(/<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)" data-node="([^"]+)"/g)) {
    out.set(m[5], [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])])
  }
  return out
}
/** Angle (deg) between segment a->b and the normal of the node side that `end` lies on. */
function offNormalDeg(end: Pt, next: Pt, boxes: Map<string, [number, number, number, number]>): number {
  const tol = 0.02
  for (const [x, y, w, h] of boxes.values()) {
    const inY = end[1] >= y - tol && end[1] <= y + h + tol
    const inX = end[0] >= x - tol && end[0] <= x + w + tol
    const vertSide = inY && (Math.abs(end[0] - x) < tol || Math.abs(end[0] - (x + w)) < tol)
    const horSide = inX && (Math.abs(end[1] - y) < tol || Math.abs(end[1] - (y + h)) < tol)
    if (!vertSide && !horSide) continue
    const dx = next[0] - end[0]
    const dy = next[1] - end[1]
    const along = vertSide ? Math.abs(dx) : Math.abs(dy)
    const across = vertSide ? Math.abs(dy) : Math.abs(dx)
    return (Math.atan2(across, along) * 180) / Math.PI
  }
  return Number.NaN
}

describe("VIS-4 route style (N8-375)", () => {
  const built = buildDiagramSvg(FX.spec, O)
  const svg = built.svg
  const L = links(svg)

  test("CURVE_SAMPLES is 32 (R20-C42, OP-18-8)", () => {
    expect((tokens as J).CURVE_SAMPLES).toBe(32)
  })

  test("orthogonal edge (field absent) has no data-route; explicit orthogonal renders byte-identical", () => {
    expect(L.length).toBe(3)
    expect(L[0].attrs).not.toContain("data-route")
    const explicit = clone(FX.spec)
    explicit.edges[0].route = "orthogonal"
    expect(buildDiagramSvg(explicit, O).svg).toBe(svg)
  })

  test("straight = 2-point path with data-route=\"straight\"", () => {
    expect(L[1].pts.length).toBe(2)
    expect(L[1].attrs).toContain('data-route="straight"')
    expect(L[1].attrs).toContain('data-mark="link"')
  })

  test("curved = 33 points, data-route=\"curved\", end segments normal to the sides within 1 deg", () => {
    const c = L[2]
    expect(c.attrs).toContain('data-route="curved"')
    expect(c.pts.length).toBe(33)
    const boxes = rects(svg)
    const n = c.pts.length
    const a0 = offNormalDeg(c.pts[0], c.pts[1], boxes)
    const a1 = offNormalDeg(c.pts[n - 1], c.pts[n - 2], boxes)
    expect(a0).toBeLessThanOrEqual(1)
    expect(a1).toBeLessThanOrEqual(1)
    // a real curve, not a degenerate straight line: samples leave the chord by more than 1 mm
    const [p, q] = [c.pts[0], c.pts[n - 1]]
    const len = Math.hypot(q[0] - p[0], q[1] - p[1])
    const off = Math.max(...c.pts.map((s) => Math.abs((q[0] - p[0]) * (s[1] - p[1]) - (q[1] - p[1]) * (s[0] - p[0])) / len))
    expect(off).toBeGreaterThan(1)
  })

  test("engine geometry lint: 0 defects; closure lint reads the figure without DATUM-32 FAIL", () => {
    const g = lintDiagramGeometry(svg)
    expect(g.defects).toEqual([])
    const out = lintRendered({ svgs: [{ svg, widthMm: built.widthMm, heightMm: built.heightMm } as never], metrics: { pageCount: 0, elements: [] } as never })
    const d32 = out.filter((i) => i.checkId === "DATUM-32")
    expect(d32.length).toBeGreaterThan(0)
    expect(d32.some((i) => i.status === "FAIL")).toBe(false)
  })

  test("ELK not used: decision reason R1 edge geometry fields (flow and layered)", async () => {
    const reasons: string[] = []
    await buildDiagramSvgAuto(FX.spec, O, {}, (d) => reasons.push(d.reason))
    await buildDiagramSvgAuto(FX.layered, O, {}, (d) => reasons.push(d.reason))
    expect(reasons).toEqual(["R1: edge geometry fields", "R1: edge geometry fields"])
    const plain = clone(FX.layered)
    delete plain.edges[1].route
    const r2: string[] = []
    await buildDiagramSvgAuto(plain, O, {}, (d) => r2.push(d.reason))
    expect(r2[0]).not.toBe("R1: edge geometry fields")
  })

  test("a straight edge through an unrelated node is reported (edgeThroughNode, GEOM_EDGE_NODE), not rerouted", () => {
    const r = buildDiagramSvg(FX.through, O)
    const t = links(r.svg)[2]
    expect(t.pts.length).toBe(2)
    expect(t.attrs).toContain('data-route="straight"')
    const g = lintDiagramGeometry(r.svg)
    expect(g.defects.filter((d) => d.kind === "edgeThroughNode")).toEqual([{ kind: "edgeThroughNode", text: "konektor 2", other: "b" }])
    expect((r.report.geometry ?? []).some((i: J) => i.checkId === "GEOM_EDGE_NODE")).toBe(true)
    const out = lintRendered({ svgs: [{ svg: r.svg, widthMm: r.widthMm, heightMm: r.heightMm } as never], metrics: { pageCount: 0, elements: [] } as never })
    expect(out.some((i) => i.checkId === "DATUM-32" && i.status === "FAIL")).toBe(true)
  })

  test("stubSegment ignores interior pieces of a data-route=\"curved\" link (OP-18-6)", () => {
    expect(typeof R.curvedPoints).toBe("function")
    // a tight U-turn: both ends on right sides 6 mm apart, so the merged 20-deg pieces are shorter than 2 mm
    const pts: Pt[] = R.curvedPoints([20, 10], "right", [20, 16], "right")
    expect(pts.length).toBe(33)
    const d = `M ${pts.map(([x, y]) => `${x.toFixed(2)} ${y.toFixed(2)}`).join(" L ")}`
    const page = (extra: string) =>
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 30">` +
      `<rect x="2" y="6" width="18" height="6" data-node="a" fill="none" stroke="#2B3640" stroke-width="0.35"/>` +
      `<rect x="2" y="13" width="18" height="6" data-node="b" fill="none" stroke="#2B3640" stroke-width="0.35"/>` +
      `<path d="${d}" fill="none" stroke="#2B3640" stroke-width="0.45" data-mark="link"${extra}/></svg>`
    expect(lintDiagramGeometry(page("")).counts.stubSegment).toBeGreaterThan(0)
    expect(lintDiagramGeometry(page(' data-route="curved"')).counts.stubSegment).toBe(0)
  })

  test("curved connectors get no line-jump hops; an orthogonal crossing still hops", () => {
    const h = { from: "a", to: "b", kind: "control", label: "h", points: [[0, 10], [40, 10]] }
    const v = { from: "c", to: "d", kind: "control", label: "v", points: [[20, 0], [20, 20]] }
    expect(R.crossingHops([h, v])[0].hops.length).toBe(1)
    expect(R.crossingHops([h, { ...v, route: "curved" }])[0].hops.length).toBe(0)
    expect(R.crossingHops([{ ...h, route: "curved" }, v])[0].hops.length).toBe(0)
  })
})
