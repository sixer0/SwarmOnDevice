// Swarm 1.2.8 row 56c (C51, C71, C75, C101; M3; user item 7: connector/arrow control at the MS Visio minimum).
// Connector ends on the true outline, one geometric assertion per defect:
//  1. orthogonal back-jog in a narrow gap (vis4 A->B, swimlane entries running down the target outline);
//  2. decision-diamond exits in a top-to-bottom flow start on the diamond (vertices/sides), not at the box bottom;
//  3. ends on a cylinder (database) touch the curved lid, not the box top above it;
//  4. an arrowhead entering a diamond has its tip on the outline and its head clear of the slanted sides;
//  5. a straight (oblique) connector meets the target border steeply enough for its head to stand clear of it.
// Fixtures (synthetic labels): syn128/vis4_routes.json, vis2_phases_v.json, vis1_flowchart_gallery.json,
// vis56c_outline_ends.json (row 56c: `merge_lr` three sources into a decision, `tb_db` decision + database).
// Red at BASE e1f9673772: every one of the five assertions fails (back-jog stub, box-bottom exits, ends above the lid,
// tips off the outline, 26 deg straight entry). The lint check passes at both (CHAR: 0 defects before and after).
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { buildDiagramSvg } from "../../vendor/src/lib/studio/engine/diagram/build"
import { buildDiagramSvgAuto } from "../../vendor/src/lib/studio/engine/diagram/elk"
import { lintDiagramGeometry } from "../../vendor/src/lib/studio/engine/diagram/fit/lint"

type J = Record<string, any>
type Pt = [number, number]
const fx = (name: string): J => JSON.parse(readFileSync(path.join(import.meta.dir, "..", "fixtures", "syn128", name), "utf8"))
const VIS4 = fx("vis4_routes.json")
const VIS2 = fx("vis2_phases_v.json")
const GAL = fx("vis1_flowchart_gallery.json")
const OWN = fx("vis56c_outline_ends.json")
const O = { release: false }
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v))
const withWidth = (s: J, w: number): J => ({ ...clone(s), width_mm: w })
const build = (s: J, w: number): string => buildDiagramSvg(withWidth(s, w) as never, O).svg

interface Link {
  pts: Pt[]
  attrs: string
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
const attr = (el: string, k: string): string | undefined => new RegExp(`\\s${k}="([^"]*)"`).exec(el)?.[1]
const num = (el: string, k: string): number => Number(attr(el, k))
function nodeEl(svg: string, id: string): string {
  const m = new RegExp(`<(rect|polygon|path|circle)\\b[^>]*data-node="${id}"[^>]*>`).exec(svg)
  if (!m) throw new Error(`node ${id} not drawn`)
  return m[0]
}
/** Diamond from its polygon: centre and half sizes. */
function diamond(svg: string, id: string): { cx: number; cy: number; hw: number; hh: number; half: number } {
  const el = nodeEl(svg, id)
  const p = attr(el, "points")!.split(/\s+/).map((s) => s.split(",").map(Number))
  const xs = p.map((q) => q[0])
  const ys = p.map((q) => q[1])
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
  return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, hw: (x1 - x0) / 2, hh: (y1 - y0) / 2, half: num(el, "stroke-width") / 2 }
}
/** Signed distance (mm, + outside) from the diamond outline (the edge line of the point's quadrant). */
function diamondDist(d: ReturnType<typeof diamond>, p: Pt): number {
  const g = Math.abs(p[0] - d.cx) / d.hw + Math.abs(p[1] - d.cy) / d.hh - 1
  return g / Math.sqrt(1 / (d.hw * d.hw) + 1 / (d.hh * d.hh))
}
/** Ends (first or last point) of the links that lie within the node's box (+0.05 mm). */
function endsIn(svg: string, box: [number, number, number, number]): Array<{ p: Pt; prev: Pt; entry: boolean; link: Link }> {
  const [x, y, w, h] = box
  const inBox = (p: Pt) => p[0] >= x - 0.05 && p[0] <= x + w + 0.05 && p[1] >= y - 0.05 && p[1] <= y + h + 0.05
  const out: Array<{ p: Pt; prev: Pt; entry: boolean; link: Link }> = []
  for (const l of links(svg)) {
    const n = l.pts.length
    const prevOf = (k: number, step: number): Pt => {
      let j = k + step
      while (j > 0 && j < n - 1 && Math.hypot(l.pts[j][0] - l.pts[k][0], l.pts[j][1] - l.pts[k][1]) < 1e-9) j += step
      return l.pts[j]
    }
    if (inBox(l.pts[0])) out.push({ p: l.pts[0], prev: prevOf(0, 1), entry: false, link: l })
    if (inBox(l.pts[n - 1])) out.push({ p: l.pts[n - 1], prev: prevOf(n - 1, -1), entry: true, link: l })
  }
  return out
}
const diamondBox = (d: ReturnType<typeof diamond>): [number, number, number, number] => [d.cx - d.hw, d.cy - d.hh, 2 * d.hw, 2 * d.hh]

describe("row 56c connector ends on the true outline (C51, C71, C75, C101)", () => {
  test("defect 1: an orthogonal connector with a sideways offset never runs back (vis4 A->B, swimlane B->C and D->E)", () => {
    const cases: Array<[string, Link]> = [
      ["vis4 A->B", links(build(VIS4.spec, 128))[0]],
      ["vis2 B->C", links(build(VIS2.spec, 166))[1]],
      ["vis2 D->E", links(build(VIS2.spec, 166))[3]],
    ]
    for (const [name, l] of cases) {
      const p = l.pts[0]
      const q = l.pts[l.pts.length - 1]
      const sgn = Math.sign(q[0] - p[0])
      // every step along x goes towards the target (a back step = the doubled-back stub)
      const back = l.pts.slice(1).filter((c, k) => sgn * (c[0] - l.pts[k][0]) < -1e-6).length
      expect({ name, back }).toEqual({ name, back: 0 })
    }
  })

  test("defect 2: decision exits in a TB flow start on the diamond outline, YA at the bottom vertex, TIDAK at the side vertex", () => {
    for (const [name, svg, id] of [["gallery 166", build(GAL.gallery, 166), "e"], ["tb_db 128", build(OWN.tb_db, 128), "q"]] as const) {
      const d = diamond(svg, id)
      const exits = endsIn(svg, diamondBox(d)).filter((e) => !e.entry)
      expect(exits.length, name).toBe(2)
      // on the outline within the 0.01 mm output grid (+ rounding of the polygon points)
      const on = exits.map((e) => Math.abs(diamondDist(d, e.p)) <= 0.02)
      expect({ name, on }).toEqual({ name, on: [true, true] })
      // Visio connection points: one exit leaves the bottom vertex, the other the vertex facing its target
      const atBottom = exits.filter((e) => Math.abs(e.p[0] - d.cx) <= 0.02 && Math.abs(e.p[1] - (d.cy + d.hh)) <= 0.02).length
      const atSide = exits.filter((e) => Math.abs(e.p[1] - d.cy) <= 0.02 && Math.abs(Math.abs(e.p[0] - d.cx) - d.hw) <= 0.02).length
      expect({ name, atBottom, atSide }).toEqual({ name, atBottom: 1, atSide: 1 })
    }
  })

  test("defect 3: a connector entering a cylinder from above ends on the front rim of its lid", () => {
    for (const [name, svg, id] of [["gallery 166", build(GAL.gallery, 166), "h"], ["tb_db 128", build(OWN.tb_db, 128), "db"]] as const) {
      const el = nodeEl(svg, id)
      // M x y+ry a w/2 ry 0 0 0 w 0 ... (core/svg.ts cylinder)
      const m = /^M([\d.]+) ([\d.]+) a([\d.]+) ([\d.]+) /.exec(attr(el, "d")!)!
      const [x, yr, rx, ry] = m.slice(1).map(Number)
      const box: [number, number, number, number] = [x, yr - ry, 2 * rx, 4 * ry]
      const entries = endsIn(svg, box).filter((e) => e.entry && e.prev[1] < e.p[1] - 1e-6)
      expect(entries.length, name).toBeGreaterThanOrEqual(1)
      for (const e of entries) {
        const u = (e.p[0] - (x + rx)) / rx
        const rim = yr + ry * Math.sqrt(Math.max(0, 1 - u * u))
        expect({ name, x: e.p[0], onRim: Math.abs(e.p[1] - rim) <= 0.02 }).toEqual({ name, x: e.p[0], onRim: true })
      }
    }
  })

  test("defect 4: arrowheads into a diamond: tip on the outline, head corners outside the outline stroke (merge_lr)", () => {
    const svg = build(OWN.merge_lr, 166)
    const d = diamond(svg, "d")
    const entries = endsIn(svg, diamondBox(d)).filter((e) => e.entry)
    // three sources: one per vertex (top, left, bottom), Visio's connection points
    expect(entries.length).toBe(3)
    expect(new Set(entries.map((e) => `${Math.round(e.p[0] * 10)},${Math.round(e.p[1] * 10)}`)).size).toBe(3)
    for (const e of entries) {
      const id = /marker-end="url\(#([^)]+)\)"/.exec(e.link.attrs)![1]
      const mk = new RegExp(`<marker id="${id}"([^>]*)>(.*?)</marker>`).exec(svg)!
      const refX = num(mk[1], "refX")
      const refY = num(mk[1], "refY")
      const scale = attr(mk[1], "markerUnits") === "userSpaceOnUse" ? 1 : num(e.link.attrs, "stroke-width")
      const local = [...(attr(mk[2], "d") ?? "").matchAll(/(-?[\d.]+),(-?[\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])])
      const tipX = Math.max(...local.map((q) => q[0]))
      const corners = local.filter((q) => q[0] < tipX - 1e-9)
      const len = Math.hypot(e.p[0] - e.prev[0], e.p[1] - e.prev[1])
      const u: Pt = [(e.p[0] - e.prev[0]) / len, (e.p[1] - e.prev[1]) / len]
      const v: Pt = [-u[1], u[0]]
      const world = (q: number[]): Pt => [
        e.p[0] + (q[0] - refX) * scale * u[0] + (q[1] - refY) * scale * v[0],
        e.p[1] + (q[0] - refX) * scale * u[1] + (q[1] - refY) * scale * v[1],
      ]
      const tip = Math.abs(diamondDist(d, e.p)) <= 0.02
      const clear = corners.length >= 2 && corners.every((q) => diamondDist(d, world(q)) >= d.half - 1e-6)
      expect({ end: e.p, tip, clear }).toEqual({ end: e.p, tip: true, clear: true })
    }
  })

  test("defect 5: the straight connector A->E meets E's border at >= 40 deg (head clear of the border)", () => {
    const svg = build(VIS4.spec, 128)
    const l = links(svg)[1]
    expect(l.attrs).toContain('data-route="straight"')
    const [p, q] = [l.pts[0], l.pts[l.pts.length - 1]]
    const e = nodeEl(svg, "e")
    const [x, y, w, h] = ["x", "y", "width", "height"].map((k) => num(e, k))
    const onHorizontal = Math.abs(q[1] - y) < 0.02 || Math.abs(q[1] - (y + h)) < 0.02
    const onVertical = Math.abs(q[0] - x) < 0.02 || Math.abs(q[0] - (x + w)) < 0.02
    expect(onHorizontal || onVertical).toBe(true)
    const dx = Math.abs(q[0] - p[0])
    const dy = Math.abs(q[1] - p[1])
    const deg = (Math.atan2(onHorizontal ? dy : dx, onHorizontal ? dx : dy) * 180) / Math.PI
    expect(deg).toBeGreaterThanOrEqual(40)
  })

  test("CHAR: 0 geometry-lint defects on the row 56c figures, sync and production (auto) path", async () => {
    const figs: Array<[string, J, number]> = [
      ["vis4", VIS4.spec, 128],
      ["vis2_phases_v", VIS2.spec, 166],
      ["gallery", GAL.gallery, 166],
      ["gallery", GAL.gallery, 128],
      ["merge_lr", OWN.merge_lr, 166],
      ["tb_db", OWN.tb_db, 128],
    ]
    for (const [name, s, w] of figs) {
      expect({ name, w, d: lintDiagramGeometry(build(s, w)).defects }).toEqual({ name, w, d: [] })
      const auto = (await buildDiagramSvgAuto(withWidth(s, w) as never, O, {}, () => {})) as J
      expect({ name, w, auto: lintDiagramGeometry(auto.svg).defects }).toEqual({ name, w, auto: [] })
    }
  })
})
