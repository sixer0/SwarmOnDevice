// Swarm 1.2.8 row 56b (AC-VIS5, AT-V5-glue, F-VISIO 01f §3.1, §3.3 "Glue sides" / "Slots", §3.6; register N8-256,
// N8-257, N8-267, N8-376). VIS-5 connector glue: `from_side` / `to_side` other than auto put the end on that side of the
// node; `from_slot` / `to_slot` put it at that fraction along the side (+-0.05 mm). A slot without its side and an
// explicit side on a bus edge are refused P1-edge-style (spec check of row 52c, reported by the figure preview); two
// ends at one slot are reported GEOM_ENTRY_COLLISION, not moved.
// Fixture: test/fixtures/syn128/vis5_glue.json (synthetic labels, flow without direction, per_row 2).
// Red at BASE e1f9673772: the engine ignores the side and slot fields (sides from `sideOf`, fanned anchors) and has no
// P1-edge-style check.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { buildDiagramSvg } from "../../vendor/src/lib/studio/engine/diagram/build"
import { lintDiagramGeometry } from "../../vendor/src/lib/studio/engine/diagram/fit/lint"
import { renderResolved } from "../../src/mcp-host/local-api/routes/figure-preview-figure"

type J = Record<string, any>
type Pt = [number, number]
type Box = [number, number, number, number]
const FX = JSON.parse(readFileSync(path.join(import.meta.dir, "..", "fixtures", "syn128", "vis5_glue.json"), "utf8")) as J
const O = { release: false }
const TOL = 0.05
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v))

/** Link paths in drawing order (= edge order for a flow without hops). */
function links(svg: string): Pt[][] {
  return [...svg.matchAll(/<path d="([^"]+)"[^>]*data-mark="link"[^>]*\/>/g)].map((m) =>
    m[1]
      .replace(/^M\s*/, "")
      .split(/\s*L\s*/)
      .map((p) => p.trim().split(/\s+/).map(Number) as Pt),
  )
}
function rects(svg: string): Map<string, Box> {
  const out = new Map<string, Box>()
  for (const m of svg.matchAll(/<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)" data-node="([^"]+)"/g)) {
    out.set(m[5], [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])])
  }
  return out
}
/** The point of `side` of box `b` at fraction `f` (left to right on top/bottom, top to bottom on left/right). */
function sidePoint(b: Box, side: string, f: number): Pt {
  const [x, y, w, h] = b
  if (side === "top") return [x + w * f, y]
  if (side === "bottom") return [x + w * f, y + h]
  if (side === "left") return [x, y + h * f]
  return [x + w, y + h * f]
}
const near = (p: Pt, q: Pt) => Math.hypot(p[0] - q[0], p[1] - q[1]) <= TOL
/** Which side of `b` point `p` lies on (within TOL), or null. */
function sideOn(b: Box, p: Pt): string | null {
  const [x, y, w, h] = b
  const inX = p[0] >= x - TOL && p[0] <= x + w + TOL
  const inY = p[1] >= y - TOL && p[1] <= y + h + TOL
  if (inX && Math.abs(p[1] - y) <= TOL) return "top"
  if (inX && Math.abs(p[1] - (y + h)) <= TOL) return "bottom"
  if (inY && Math.abs(p[0] - x) <= TOL) return "left"
  if (inY && Math.abs(p[0] - (x + w)) <= TOL) return "right"
  return null
}

async function preview(spec: J) {
  return renderResolved(
    { block: { blockId: "vis5", address: "1.1", type: "diagram", content: {} } as never, type: "diagram", spec: clone(spec) as never },
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

describe("VIS-5 glue to sides and slots (N8-376)", () => {
  const built = buildDiagramSvg(clone(FX.spec), O)
  const L = links(built.svg)
  const B = rects(built.svg)

  test("every end lies on the requested side at the slot fraction of the node cell (+-0.05 mm)", async () => {
    expect(L.length).toBe(FX.spec.edges.length)
    // The node cell (layout box) from the preview lattice; a flow sheet is drawn in layout coordinates. A box on the
    // sheet edge is drawn inset by half its stroke, so the cell (not the drawn rect) carries the fraction.
    const f = (await preview(FX.spec)) as J
    const lat = f.lattice
    const cell = (id: string): Box => {
      const [c0, r0, c1, r1] = lat.nodes[id]
      return [c0 * lat.col_mm, r0 * lat.row_mm, (c1 - c0) * lat.col_mm, (r1 - r0) * lat.row_mm]
    }
    FX.spec.edges.forEach((e: J, i: number) => {
      const pts = L[i]
      const p = pts[0]
      const q = pts[pts.length - 1]
      expect(near(p, sidePoint(cell(e.from), e.from_side, e.from_slot))).toBe(true)
      expect(near(q, sidePoint(cell(e.to), e.to_side, e.to_slot))).toBe(true)
      // and on the drawn side of the box
      expect(sideOn(B.get(e.from)!, p)).toBe(e.from_side)
      expect(sideOn(B.get(e.to)!, q)).toBe(e.to_side)
    })
  })

  test("the first and last pieces leave and enter their side head-on (arrowhead along the normal)", () => {
    FX.spec.edges.forEach((e: J, i: number) => {
      const pts = L[i]
      const n = pts.length
      const vert = (s: string) => s === "top" || s === "bottom"
      const dx0 = Math.abs(pts[1][0] - pts[0][0])
      const dy0 = Math.abs(pts[1][1] - pts[0][1])
      const dx1 = Math.abs(pts[n - 1][0] - pts[n - 2][0])
      const dy1 = Math.abs(pts[n - 1][1] - pts[n - 2][1])
      expect(vert(e.from_side) ? dx0 : dy0).toBeLessThan(1e-6)
      expect(vert(e.to_side) ? dx1 : dy1).toBeLessThan(1e-6)
    })
  })

  test("same-side pairs (top to top, right to right) loop outside both nodes, no back-jog", () => {
    for (const i of [2, 3]) {
      const e = FX.spec.edges[i]
      const pts = L[i]
      const a = B.get(e.from)!
      const b = B.get(e.to)!
      if (e.from_side === "top") {
        const top = Math.min(...pts.map((p) => p[1]))
        expect(top).toBeLessThan(Math.min(a[1], b[1]) - 1)
        // the run leaves upward and never comes back below the node tops between the ends
        expect(pts.slice(1, -1).every((p) => p[1] <= Math.min(a[1], b[1]) + 1e-6)).toBe(true)
      } else {
        const right = Math.max(...pts.map((p) => p[0]))
        expect(right).toBeGreaterThan(Math.max(a[0] + a[2], b[0] + b[2]) + 1)
        expect(pts.slice(1, -1).every((p) => p[0] >= Math.max(a[0] + a[2], b[0] + b[2]) - 1e-6)).toBe(true)
      }
    }
  })

  test("a side without a slot is honoured on both ends (bottom to bottom, not the auto right/left)", () => {
    const r = buildDiagramSvg(clone(FX.side_only), O)
    const pts = links(r.svg)[0]
    const b = rects(r.svg)
    expect(sideOn(b.get("a")!, pts[0])).toBe("bottom")
    expect(sideOn(b.get("b")!, pts[pts.length - 1])).toBe("bottom")
  })

  test("engine geometry lint: 0 defects for the glued figure", () => {
    expect(lintDiagramGeometry(built.svg).defects).toEqual([])
  })

  test("explicit side auto renders byte-identical to the absent field", () => {
    const plain = clone(FX.side_only)
    delete plain.edges[0].from_side
    delete plain.edges[0].to_side
    const auto = clone(plain)
    auto.edges[0].from_side = "auto"
    auto.edges[0].to_side = "auto"
    expect(buildDiagramSvg(auto, O).svg).toBe(buildDiagramSvg(plain, O).svg)
  })

  test("slot without its side: refused P1-edge-style, and the figure preview reports it", async () => {
    const r = await refusal(FX.slot_no_side)
    expect(r.code).toBe("BY_CONSTRUCTION_FAILED")
    expect(r.details?.checkId).toBe("P1-edge-style")
    expect(r.details?.pointer).toBe("/edges/0/from_slot")
  })

  test("explicit side on an edge to a bus node: refused P1-edge-style", async () => {
    const r = await refusal(FX.bus)
    expect(r.code).toBe("BY_CONSTRUCTION_FAILED")
    expect(r.details?.checkId).toBe("P1-edge-style")
    expect(r.details?.pointer).toBe("/edges/0/from_side")
  })

  test("two arrivals at one slot: kept where asked and reported GEOM_ENTRY_COLLISION in the preview", async () => {
    const p = await preview(FX.collide)
    const pts = links(p.svg as string)
    const b = rects(p.svg as string)
    expect(pts.length).toBe(2)
    const ends = pts.map((path) => path[path.length - 1])
    expect(near(ends[0], ends[1])).toBe(true)
    for (const q of ends) expect(sideOn(b.get("c")!, q)).toBe("top")
    const lat = (p as J).lattice
    expect(Math.abs(ends[0][0] - ((lat.nodes.c[0] + lat.nodes.c[2]) / 2) * lat.col_mm)).toBeLessThanOrEqual(TOL)
    expect(lintDiagramGeometry(p.svg as string).counts.edgeEntryCollision ?? 0).toBeGreaterThanOrEqual(1)
    expect(p.defects.some((d) => d.checkId === "GEOM_ENTRY_COLLISION")).toBe(true)
  })
})
