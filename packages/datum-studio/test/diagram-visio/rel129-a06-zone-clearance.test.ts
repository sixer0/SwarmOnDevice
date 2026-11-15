// Swarm 1.2.9 row 29 (AC-A06, B9-A06; register N9-105 test, N9-051 ZONE_CLEAR_MM; C2 ruling 2, C10(b)).
// A zone frame keeps at least ZONE_CLEAR_MM = 1.5 mm from every member outline (all four sides) and from every
// non-member outline it runs beside (C10(b): the Sakelar nodes under a zone are included), measured on stroke centre
// lines (the printed coordinates; frame and outlines both carry 2 decimals, so 0.01 mm is the print tolerance).
// BASE d4282fcfd8: dg_topology put the zone's member `srv` on the left sheet edge, so the frame (half a column past the
// member, clipped to the sheet by build/svg.ts) ran 0.13 mm from its outline (x 0.10 vs 0.23); and the frame bottom
// (two lattice rows under the members) landed on the tops of the non-members `swa`/`swb` (gap 0.00 mm) because the
// topology tier gap is the same two rows. N9-151 (syn129 a06_zone_sheet_edge) reproduces both at 128 and 166 mm.
// Geometry is read from the SVG only: the frame is the dashed `fill="none"` rect without `data-node`; outlines are the
// `data-node` rect, circle, polygon and path (path bbox from the lint's own `pathPolylines`).
// Negative control: a legacy flow (family `flow` without `direction`, frozen at its 1.2.5 bytes, C10(a)/C12) keeps its
// zone frame bytes (syn128 vis0_carry_b).
import { useStudioEnv } from "../ported/_env"
useStudioEnv()
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

type J = Record<string, any>
type Box = [number, number, number, number]
// Namespace imports, so a run on the BASE engine fails on assertions, not on a missing export.
const build = (await import("../../vendor/src/lib/studio/engine/diagram/build")) as J
const fitlabels = (await import("../../vendor/src/lib/studio/engine/diagram/build/fitlabels")) as J
const svgscan = (await import("../../vendor/src/lib/studio/engine/chart/core/svgscan")) as J
const fig = (await import("../../src/mcp-host/local-api/routes/figure-preview-figure.ts")) as J
const compose = (await import("../../vendor/src/lib/studio/services/compose/index.ts")) as J

/** N9-051: 1.5 mm, as `SHARED_BAND_CLEAR_MM` in route.ts. */
const ZONE_CLEAR_MM = 1.5
/** Coordinates are printed to 0.01 mm; two rounded values can differ by one print unit. */
const PRINT_TOL = 0.01

const PARITY = path.join(import.meta.dir, "..", "ported", "_fixtures", "tests", "parity", "fixtures", "diagram")
const FIX = path.join(import.meta.dir, "..", "fixtures")
const topo = (): J => JSON.parse(readFileSync(path.join(PARITY, "dg_topology.json"), "utf8"))
const sheetEdge = (): J => JSON.parse(readFileSync(path.join(FIX, "syn129", "a06_zone_sheet_edge.json"), "utf8")).figure.spec
const legacyFlow = (): J => JSON.parse(readFileSync(path.join(FIX, "syn128", "vis0_carry_b.json"), "utf8")).spec

function attrsOf(tag: string): Record<string, string> {
  const a: Record<string, string> = {}
  for (const m of tag.matchAll(/([\w:-]+)="([^"]*)"/g)) a[m[1]] = m[2]
  return a
}

function bboxOf(pts: ReadonlyArray<readonly [number, number]>): Box {
  const xs = pts.map((p) => p[0])
  const ys = pts.map((p) => p[1])
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
}

/** Stroke centre-line box of every `data-node` outline. */
function outlines(svg: string): Map<string, Box> {
  const out = new Map<string, Box>()
  for (const m of svg.matchAll(/<(rect|circle|polygon|path) [^>]*data-node="([^"]+)"[^>]*>/g)) {
    const a = attrsOf(m[0])
    let b: Box
    if (m[1] === "rect") b = [+a.x, +a.y, +a.x + +a.width, +a.y + +a.height]
    else if (m[1] === "circle") b = [+a.cx - +a.r, +a.cy - +a.r, +a.cx + +a.r, +a.cy + +a.r]
    else if (m[1] === "polygon") {
      const v = a.points.trim().split(/[\s,]+/).map(Number)
      const pts: Array<[number, number]> = []
      for (let i = 0; i + 1 < v.length; i += 2) pts.push([v[i], v[i + 1]])
      b = bboxOf(pts)
    } else b = bboxOf((svgscan.pathPolylines(a.d) as Array<Array<[number, number]>>).flat())
    const prev = out.get(m[2])
    out.set(m[2], prev ? [Math.min(prev[0], b[0]), Math.min(prev[1], b[1]), Math.max(prev[2], b[2]), Math.max(prev[3], b[3])] : b)
  }
  return out
}

/** The zone frames: dashed `fill="none"` rects that are not nodes. */
function frames(svg: string): string[] {
  return [...svg.matchAll(/<rect [^>]*>/g)].map((m) => m[0]).filter((t) => !t.includes("data-node=") && /fill="none"/.test(t) && /stroke-dasharray=/.test(t))
}

interface Clearance {
  frame: Box
  W: number
  /** Smallest frame-to-member distance over the four sides of the members' box. */
  member: number
  /** Smallest distance from a frame edge to a non-member outline over an overlapping span (0 = touching or crossing). */
  nonMember: number
  worst: string
}

function clearance(svg: string, members: readonly string[]): Clearance {
  const fs = frames(svg)
  expect(fs.length).toBe(1)
  const a = attrsOf(fs[0])
  const f: Box = [+a.x, +a.y, +a.x + +a.width, +a.y + +a.height]
  const W = Number(/viewBox="0 0 ([\d.]+)/.exec(svg)![1])
  const nodes = outlines(svg)
  const mb = members.map((id) => nodes.get(id)!)
  expect(mb.every((b) => b !== undefined)).toBe(true)
  const m: Box = [Math.min(...mb.map((b) => b[0])), Math.min(...mb.map((b) => b[1])), Math.max(...mb.map((b) => b[2])), Math.max(...mb.map((b) => b[3]))]
  const sides: Array<[string, number]> = [["left", m[0] - f[0]], ["top", m[1] - f[1]], ["right", f[2] - m[2]], ["bottom", f[3] - m[3]]]
  let worst = sides.reduce((w, s) => (s[1] < w[1] ? s : w))
  const member = worst[1]
  let nonMember = Infinity
  let nmWorst = ""
  for (const [id, b] of nodes) {
    if (members.includes(id)) continue
    // horizontal edges (top, bottom) against a node overlapping their x span; vertical edges against a y overlap
    const edges: Array<[string, number, number, number, boolean]> = [
      ["top", f[1], f[0], f[2], true],
      ["bottom", f[3], f[0], f[2], true],
      ["left", f[0], f[1], f[3], false],
      ["right", f[2], f[1], f[3], false],
    ]
    for (const [name, at, lo, hi, horiz] of edges) {
      const [s0, s1, n0, n1] = horiz ? [b[0], b[2], b[1], b[3]] : [b[1], b[3], b[0], b[2]]
      if (!(s0 < hi && s1 > lo)) continue
      const d = at >= n0 && at <= n1 ? 0 : Math.min(Math.abs(at - n0), Math.abs(at - n1))
      if (d < nonMember) {
        nonMember = d
        nmWorst = `${name} edge ${d.toFixed(2)} mm from non-member ${id}`
      }
    }
  }
  return { frame: f, W, member, nonMember, worst: `${worst[0]} ${member.toFixed(2)} mm from members; ${nmWorst || "no non-member beside a frame edge"}` }
}

// ── the preview a stored block gets (compose mapBlock -> renderFigure, what studio_figure_preview runs) ──────────────
async function preview(spec: J, widthMm: number): Promise<string> {
  const b = { type: "diagram", caption: { text: "Topologi sintetis uji." }, source: { text: "Sumber sintetis uji." }, spec: structuredClone(spec) }
  const params = { "diagram.widthMm": widthMm }
  const content = compose.mapBlock(b, "fig-a06", { glyphs: compose.glyphSet(undefined), params, classification: "TERBATAS", artifactLabel: "Gambar 1.1" })
  const nb = { blockId: "fig-a06", pid: "fig-a06", address: "1.1.1", ordinal: 0, unitKey: "", type: "diagram", content, textPlain: "", contentSha256: "", artifactLabel: "Gambar 1.1" }
  const r = await fig.renderFigure(nb, { params } as never, { inline: true, withSvg: true, lang: "ID" })
  return r.svg as string
}

function expectClear(svg: string, members: readonly string[]): void {
  const c = clearance(svg, members)
  // members are not clipped at the sheet edge: the whole frame lies on the sheet
  expect(c.frame[0]).toBeGreaterThanOrEqual(0)
  expect(c.frame[2]).toBeLessThanOrEqual(c.W)
  expect({ member: c.member >= ZONE_CLEAR_MM - PRINT_TOL, nonMember: c.nonMember >= ZONE_CLEAR_MM - PRINT_TOL, worst: c.worst }).toEqual({
    member: true,
    nonMember: true,
    worst: c.worst,
  })
}

describe("AC-A06: zone frame at least 1.5 mm from member and non-member outlines", () => {
  test("N9-051 ZONE_CLEAR_MM = 1.5 mm, exported by the engine", () => {
    expect(fitlabels.ZONE_CLEAR_MM).toBe(ZONE_CLEAR_MM)
  })
  for (const release of [true, false]) {
    test(`dg_topology @${release ? "rel" : "draft"}`, () => {
      expectClear(build.buildDiagramSvg(topo(), { release }).svg as string, ["srv", "arsip"])
    })
  }
  for (const w of [128, 166]) {
    test(`dg_topology preview at ${w} mm`, async () => {
      const svg = await preview(topo(), w)
      expect(Number(/viewBox="0 0 ([\d.]+)/.exec(svg)![1])).toBe(w)
      expectClear(svg, ["srv", "arsip"])
    })
    test(`N9-151 a06_zone_sheet_edge preview at ${w} mm`, async () => {
      const svg = await preview(sheetEdge(), w)
      expect(Number(/viewBox="0 0 ([\d.]+)/.exec(svg)![1])).toBe(w)
      expectClear(svg, ["srv", "arsip"])
    })
  }
})

describe("AC-A06 negative control: a legacy flow keeps its zone frame bytes (C10(a), C12)", () => {
  // BASE d4282fcfd8 frame of syn128 vis0_carry_b (family flow, no `direction`; serialised). Its frame touches the
  // non-members `a` (top) and `d` (bottom) at 0.00 mm: a release-note known limit with A02/A04/A08, not changed here.
  const KEEP: Record<number, string> = {
    128: '<rect x="37.33" y="23.81" width="42.67" height="57.15" fill="none" stroke="#6B7783" stroke-width="0.2" stroke-dasharray="3.2,1.6"/>',
    166: '<rect x="58.67" y="23.81" width="42.67" height="57.15" fill="none" stroke="#6B7783" stroke-width="0.2" stroke-dasharray="3.2,1.6"/>',
  }
  for (const w of [128, 166]) {
    test(`vis0_carry_b preview at ${w} mm: frame unchanged`, async () => {
      expect(frames(await preview(legacyFlow(), w))).toEqual([KEEP[w]])
    })
  }
})
