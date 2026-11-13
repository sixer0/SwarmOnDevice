// Swarm 1.2.8 row 56b (AC-VIS6, AT-V6-via, F-VISIO 01f §3.1, §3.3 "via", "via families", "via bounds", "Lattice
// exposure"; D-V3, OP-18-3; register N8-258, N8-268, N8-269, N8-377, N8-472). VIS-6 bend points: `via` = lattice points
// {col,row} (x = col x col_mm, y = row x row_mm, origin top-left of the laid-out sheet); the path passes every point
// within 0.05 mm; orthogonal joins them with axis-parallel legs, straight with straight segments. Refused: P1-via (9
// points, a negative col, and at build level a point outside the sheet), P3-via-family (layered, ranked flow),
// curved + via (P1-edge-style). The figure preview returns `figure.lattice` for flow/graph/swimlane as structured
// content only (no text line).
// Fixtures: test/fixtures/syn128/vis6_via_graph.json, vis6_via_refused_layered.json (synthetic labels).
// Red at BASE e1f9673772: `via` is ignored, nothing is refused, the preview has no `figure.lattice`.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { buildDiagramSvg } from "../../vendor/src/lib/studio/engine/diagram/build"
import { lintDiagramGeometry } from "../../vendor/src/lib/studio/engine/diagram/fit/lint"
import { renderResolved } from "../../src/mcp-host/local-api/routes/figure-preview-figure"
import * as figureTools from "../../vendor/scripts/studio/mcp/figure-tools"

type J = Record<string, any>
type Pt = [number, number]
const DIR = path.join(import.meta.dir, "..", "fixtures", "syn128")
const FX = JSON.parse(readFileSync(path.join(DIR, "vis6_via_graph.json"), "utf8")) as J
const LAY = JSON.parse(readFileSync(path.join(DIR, "vis6_via_refused_layered.json"), "utf8")) as J
const O = { release: false }
const TOL = 0.05
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v))

function links(svg: string): Pt[][] {
  return [...svg.matchAll(/<path d="([^"]+)"[^>]*data-mark="link"[^>]*\/>/g)].map((m) =>
    m[1]
      .replace(/^M\s*/, "")
      .split(/\s*L\s*/)
      .map((p) => p.trim().split(/\s+/).map(Number) as Pt),
  )
}
function rectY(svg: string, id: string): number {
  const m = new RegExp(`<rect x="[\\d.]+" y="([\\d.]+)" width="[\\d.]+" height="[\\d.]+" data-node="${id}"`).exec(svg)
  return Number(m?.[1])
}
/** Distance of point `v` from the polyline `pts`. */
function distTo(pts: Pt[], v: Pt): number {
  let best = Number.POSITIVE_INFINITY
  for (let i = 1; i < pts.length; i++) {
    const [a, b] = [pts[i - 1], pts[i]]
    const dx = b[0] - a[0]
    const dy = b[1] - a[1]
    const L2 = dx * dx + dy * dy
    const t = L2 === 0 ? 0 : Math.max(0, Math.min(1, ((v[0] - a[0]) * dx + (v[1] - a[1]) * dy) / L2))
    best = Math.min(best, Math.hypot(a[0] + t * dx - v[0], a[1] + t * dy - v[1]))
  }
  return best
}
/** Index of the first path vertex within TOL of `v` (via points are vertices of the drawn polyline). */
const vertexAt = (pts: Pt[], v: Pt) => pts.findIndex((p) => Math.hypot(p[0] - v[0], p[1] - v[1]) <= TOL)

async function preview(spec: J) {
  return renderResolved(
    { block: { blockId: "vis6", address: "1.1", type: "diagram", content: {} } as never, type: "diagram", spec: clone(spec) as never },
    { params: {} } as never,
    { inline: true, withSvg: true, lang: "ID" },
  )
}
async function refusal(spec: J): Promise<J> {
  try {
    await preview(spec)
  } catch (e) {
    return { code: (e as J).code, details: (e as J).details, message: String((e as Error).message) }
  }
  return { code: null }
}

/**
 * Via points of edge `i` in drawn coordinates, from the preview lattice: the drawing keeps the lattice of its nodes, so a
 * graph whose sheet is fitted to its content (D-290) moves via points by the same offset as the nodes.
 */
function viaDrawn(fig: J, spec: J, i: number): Pt[] {
  const lat = fig.lattice
  const first = spec.nodes[0].id
  const dy = rectY(fig.svg, first) - lat.nodes[first][1] * lat.row_mm
  return spec.edges[i].via.map((v: J) => [v.col * lat.col_mm, v.row * lat.row_mm + dy] as Pt)
}

describe("VIS-6 bend points on the layout lattice (N8-377)", () => {
  test("preview figure.lattice for graph, flow and swimlane: { col_mm, row_mm, cols, rows, nodes }", async () => {
    for (const k of ["graph", "flow", "swimlane"]) {
      const f = (await preview(FX[k])) as J
      const lat = f.lattice
      expect(lat).toBeDefined()
      expect(Object.keys(lat).sort()).toEqual(["col_mm", "cols", "nodes", "row_mm", "rows"])
      expect(lat.col_mm).toBeCloseTo(128 / 12, 3)
      expect(lat.row_mm).toBeCloseTo((13.5 * 25.4) / 72, 3) // baseline 13.5 pt
      expect(lat.cols).toBe(12)
      expect(lat.rows).toBeGreaterThan(8)
      expect(Object.keys(lat.nodes).sort()).toEqual(FX[k].nodes.map((n: J) => n.id).sort())
      for (const box of Object.values(lat.nodes) as number[][]) {
        expect(box.length).toBe(4)
        expect(box[2]).toBeGreaterThan(box[0])
        expect(box[3]).toBeGreaterThan(box[1])
      }
    }
  })

  test("graph: orthogonal via and straight via pass every point within 0.05 mm, in order", async () => {
    const f = (await preview(FX.graph)) as J
    const L = links(f.svg)
    FX.graph.edges.forEach((_e: J, i: number) => {
      const vs = viaDrawn(f, FX.graph, i)
      let last = -1
      for (const v of vs) {
        expect(distTo(L[i], v)).toBeLessThanOrEqual(TOL)
        const k = vertexAt(L[i], v)
        expect(k).toBeGreaterThan(last)
        last = k
      }
    })
    // orthogonal: every piece axis-parallel; straight with via: the polyline is anchor, via..., anchor
    const ortho = L[0]
    for (let k = 1; k < ortho.length; k++) {
      const dx = Math.abs(ortho[k][0] - ortho[k - 1][0])
      const dy = Math.abs(ortho[k][1] - ortho[k - 1][1])
      expect(Math.min(dx, dy)).toBeLessThan(1e-6)
    }
    expect(L[1].length).toBe(FX.graph.edges[1].via.length + 2)
    expect(lintDiagramGeometry(f.svg).defects.filter((d) => d.kind === "edgeThroughNode")).toEqual([])
  })

  test("flow and swimlane: the path passes every via point within 0.05 mm", async () => {
    for (const k of ["flow", "swimlane"]) {
      const f = (await preview(FX[k])) as J
      const L = links(f.svg)
      const i = FX[k].edges.findIndex((e: J) => Array.isArray(e.via))
      for (const v of viaDrawn(f, FX[k], i)) expect(distTo(L[i], v)).toBeLessThanOrEqual(TOL)
    }
  })

  test("P1-via: 9 points and a negative col refused at spec level", async () => {
    const nine = await refusal(FX.nine)
    expect(nine.code).toBe("BY_CONSTRUCTION_FAILED")
    expect(nine.details?.checkId).toBe("P1-via")
    const neg = await refusal(FX.negative)
    expect(neg.details?.checkId).toBe("P1-via")
    expect(neg.details?.pointer).toBe("/edges/0/via/0")
  })

  test("P1-via at build level: a point outside the laid-out sheet, message names the sheet in lattice units", async () => {
    const r = await refusal(FX.outside)
    expect(r.code).toBe("BY_CONSTRUCTION_FAILED")
    expect(r.details?.checkId).toBe("P1-via")
    expect(r.details?.pointer).toBe("/edges/0/via/0")
    expect(r.message).toMatch(/12 x \d+/)
    expect(() => buildDiagramSvg(clone(FX.outside), O)).toThrow(/P1-via|lembar/)
  })

  test("P3-via-family (D-V3): via refused in layered and in ranked flow (flow + direction)", async () => {
    for (const k of ["layered", "ranked"]) {
      const r = await refusal(LAY[k])
      expect(r.code).toBe("BY_CONSTRUCTION_FAILED")
      expect(r.details?.checkId).toBe("P3-via-family")
      expect(r.message).toContain(k === "ranked" ? "flow + direction" : "layered")
    }
  })

  test("curved + via refused P1-edge-style (/edges/0/via)", async () => {
    const r = await refusal(FX.curved)
    expect(r.code).toBe("BY_CONSTRUCTION_FAILED")
    expect(r.details?.checkId).toBe("P1-edge-style")
    expect(r.details?.pointer).toBe("/edges/0/via")
  })

  test("figure.lattice is structured content only: the preview text has no added line", async () => {
    const f = (await preview(FX.graph)) as J
    const body = { revisionNo: 1, currentRevisionNo: 1, rendered: true, figure: f }
    const without = { ...body, figure: { ...f, lattice: undefined } }
    const P = figureTools as J
    expect(P.previewLines("doc1", body)).toEqual(P.previewLines("doc1", without))
    expect(f.lattice).toBeDefined()
  })

  test("no lattice for a family that places nodes itself (layered)", async () => {
    const plain = clone(LAY.layered)
    delete plain.edges[1].via
    const f = (await preview(plain)) as J
    expect(f.lattice).toBeUndefined()
  })
})
