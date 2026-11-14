// Swarm 1.2.9 row 28 (AC-A05, B9-A05; register N9-104 test, N9-050 MARK_CIRCLE_GAP_MAX_MM; C2 ruling 2).
// The TERUKUR provenance mark of a circle node sits next to its circle: the gap from the mark's ink box to the circle
// outline is at most one lattice step (LATTICE_Y = 13.5 pt = 4.7625 mm, the stricter of the two lattice steps), and the
// ink does not cross the stroke (no `textOverNode` for the mark). dg_topology `s1` ("Sensor lantai 1", shape circle,
// mark TERUKUR) is the only circle node with a mark in the fixtures.
// BASE d4282fcfd8: `markGlyphAnchor` anchored the glyph at the right edge of the node's SLOT (74.44 mm wide) and
// `curvedGlyphAnchor` kept that anchor because ink far outside a circle counts as clear: mark x 74.14 vs the rim at
// 44.59, a gap of about 28.5 mm at @rel, @draft and the 166 mm preview (about 23.2 mm at 128 mm).
// Geometry is read from the SVG only: the circle from `<circle data-node="s1">`, the ink box of the mark from the lint's
// own scanner (`decorationOf([markText], W).texts[0]`), independent of the engine's anchor code.
// Negative control: the marks on other shapes (dg_graph `log` cylinder, dg_layered_good and dg_sld_good boxes) keep
// their anchors (t06_diagram_six_colours `db` is a DATUM-25 refusal fixture and draws no figure).
import { useStudioEnv } from "../ported/_env"
useStudioEnv()
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

type J = Record<string, any>
// Namespace imports, so a run on the BASE engine fails on assertions, not on a missing export.
const build = (await import("../../vendor/src/lib/studio/engine/diagram/build")) as J
const lint = (await import("../../vendor/src/lib/studio/engine/diagram/fit/lint")) as J
const tokens = (await import("../../vendor/src/lib/studio/engine/diagram/core/tokens")) as J
const svgCore = (await import("../../vendor/src/lib/studio/engine/diagram/core/svg")) as J
const fig = (await import("../../src/mcp-host/local-api/routes/figure-preview-figure.ts")) as J
const compose = (await import("../../vendor/src/lib/studio/services/compose/index.ts")) as J

/** N9-050: one lattice step, LATTICE_Y (13.5 pt). */
const MARK_CIRCLE_GAP_MAX_MM: number = tokens.LATTICE_Y
const GLYPH = "■" // tokens marks.TERUKUR

const PARITY = path.join(import.meta.dir, "..", "ported", "_fixtures", "tests", "parity", "fixtures", "diagram")
const fx = (file: string): J => JSON.parse(readFileSync(path.join(PARITY, file), "utf8"))

const num = (tag: string, k: string): number => Number(new RegExp(`\\b${k}="(-?[\\d.]+)"`).exec(tag)?.[1])
const markTexts = (svg: string): string[] => [...svg.matchAll(new RegExp(`<text [^>]*text-anchor="end"[^>]*>${GLYPH}</text>`, "g"))].map((m) => m[0])

/** Gap from the mark's ink box to the circle outline of node `id` (0 when the box straddles the rim). */
function markGap(svg: string, id: string): { gap: number; over: number; marks: number } {
  const c = new RegExp(`<circle [^>]*data-node="${id}"[^>]*>`).exec(svg)
  expect(c).not.toBeNull()
  const [cx, cy, r] = [num(c![0], "cx"), num(c![0], "cy"), num(c![0], "r")]
  const marks = markTexts(svg)
  const W = Number(/viewBox="0 0 ([\d.]+)/.exec(svg)![1])
  const b = lint.decorationOf([marks[0]], W).texts[0] as [number, number, number, number]
  const corners = [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]]
  const far = Math.max(...corners.map(([x, y]) => Math.hypot(x - cx, y - cy)))
  const near = Math.hypot(Math.max(b[0] - cx, 0, cx - b[2]), Math.max(b[1] - cy, 0, cy - b[3]))
  const gap = far <= r ? r - far : near >= r ? near - r : 0
  const over = (lint.lintDiagramGeometry(svg).defects as J[]).filter((d) => d.kind === "textOverNode" && d.text === GLYPH).length
  return { gap, over, marks: marks.length }
}

// ── the preview a stored block gets (compose mapBlock -> renderFigure, what studio_figure_preview runs) ──────────────
async function preview(spec: J, widthMm: number): Promise<string> {
  const b = { type: "diagram", caption: { text: "Topologi sintetis uji." }, source: { text: "Sumber sintetis uji." }, spec: structuredClone(spec) }
  const params = { "diagram.widthMm": widthMm }
  const content = compose.mapBlock(b, "fig-a05", { glyphs: compose.glyphSet(undefined), params, classification: "TERBATAS", artifactLabel: "Gambar 1.1" })
  const nb = { blockId: "fig-a05", pid: "fig-a05", address: "1.1.1", ordinal: 0, unitKey: "", type: "diagram", content, textPlain: "", contentSha256: "", artifactLabel: "Gambar 1.1" }
  const r = await fig.renderFigure(nb, { params } as never, { inline: true, withSvg: true, lang: "ID" })
  return r.svg as string
}

describe("AC-A05: TERUKUR mark within one lattice step of its circle (dg_topology s1)", () => {
  test("N9-050 MARK_CIRCLE_GAP_MAX_MM = LATTICE_Y = 4.7625 mm", () => {
    expect(MARK_CIRCLE_GAP_MAX_MM).toBeCloseTo(4.7625, 6)
  })
  for (const release of [true, false]) {
    test(`@${release ? "rel" : "draft"}: gap <= 4.7625 mm and no textOverNode on the mark`, () => {
      const r = build.buildDiagramSvg(fx("dg_topology.json"), { release })
      const m = markGap(r.svg, "s1")
      expect(m.marks).toBe(1)
      expect(m.gap).toBeLessThanOrEqual(MARK_CIRCLE_GAP_MAX_MM)
      expect(m.over).toBe(0)
    })
  }
  for (const w of [128, 166]) {
    test(`preview at ${w} mm: gap <= 4.7625 mm and no textOverNode on the mark`, async () => {
      const svg = await preview(fx("dg_topology.json"), w)
      expect(Number(/viewBox="0 0 ([\d.]+)/.exec(svg)![1])).toBe(w)
      const m = markGap(svg, "s1")
      expect(m.marks).toBe(1)
      expect(m.gap).toBeLessThanOrEqual(MARK_CIRCLE_GAP_MAX_MM)
      expect(m.over).toBe(0)
    })
  }
})

// ── 1.2.9 row 66a (gate 66 finding F1, C77): the mark is off every connector axis that meets its circle ─────────────
// After row 28 the glyph sat on the ETHERNET connector's axis about 0.8 mm inside the rim, right below where the
// connector meets the circle (ink centre 0.08 mm from the axis), where it can be read as a junction dot. Each connector
// segment, and each end segment continued into the circle (its axis, 2 r long) when that end meets the circle, must be
// at least MARK_AXIS_CLEAR_MIN_MM from the centre of the mark's ink box. Geometry from the SVG only.
const MARK_AXIS_CLEAR_MIN_MM = 1

type P = [number, number]
const segDist = (p: P, a: P, b: P): number => {
  const [dx, dy] = [b[0] - a[0], b[1] - a[1]]
  const L = dx * dx + dy * dy
  const t = L > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L)) : 0
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy))
}

/** Least distance from the mark's ink centre to a connector segment or to the axis of a connector end on circle `id`. */
function markAxisClear(svg: string, id: string): number {
  const c = new RegExp(`<circle [^>]*data-node="${id}"[^>]*>`).exec(svg)!
  const [cx, cy, r] = [num(c[0], "cx"), num(c[0], "cy"), num(c[0], "r")]
  const W = Number(/viewBox="0 0 ([\d.]+)/.exec(svg)![1])
  const b = lint.decorationOf([markTexts(svg)[0]], W).texts[0] as [number, number, number, number]
  const m: P = [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2]
  let least = Infinity
  for (const t of svg.matchAll(/<path d="(M[^"]*)"[^>]*data-mark="link"[^>]*>/g)) {
    const v = (t[1].match(/-?[\d.]+/g) ?? []).map(Number)
    const pts: P[] = []
    for (let i = 0; i + 1 < v.length; i += 2) pts.push([v[i], v[i + 1]])
    for (let i = 0; i + 1 < pts.length; i++) least = Math.min(least, segDist(m, pts[i], pts[i + 1]))
    for (const [end, from] of [[0, 1], [pts.length - 1, -1]] as const) {
      const e = pts[end]
      if (Math.abs(Math.hypot(e[0] - cx, e[1] - cy) - r) > 1) continue
      let k = end + from
      while (k >= 0 && k < pts.length && Math.hypot(pts[k][0] - e[0], pts[k][1] - e[1]) < 1e-6) k += from
      if (k < 0 || k >= pts.length) continue
      const L = Math.hypot(e[0] - pts[k][0], e[1] - pts[k][1])
      const far: P = [e[0] + ((e[0] - pts[k][0]) / L) * 2 * r, e[1] + ((e[1] - pts[k][1]) / L) * 2 * r]
      least = Math.min(least, segDist(m, e, far))
    }
  }
  return least
}

describe("AC-A05 (row 66a): the mark of s1 is off every connector axis that meets its circle", () => {
  for (const release of [true, false]) {
    test(`@${release ? "rel" : "draft"}: ink centre >= 1 mm from every connector segment and end axis, gap still <= 4.7625 mm`, () => {
      const svg = build.buildDiagramSvg(fx("dg_topology.json"), { release }).svg as string
      expect(markAxisClear(svg, "s1")).toBeGreaterThanOrEqual(MARK_AXIS_CLEAR_MIN_MM)
      const m = markGap(svg, "s1")
      expect(m.gap).toBeLessThanOrEqual(MARK_CIRCLE_GAP_MAX_MM)
      expect(m.over).toBe(0)
    })
  }
  for (const w of [128, 166]) {
    test(`preview at ${w} mm: ink centre >= 1 mm from every connector segment and end axis, gap still <= 4.7625 mm`, async () => {
      const svg = await preview(fx("dg_topology.json"), w)
      expect(markAxisClear(svg, "s1")).toBeGreaterThanOrEqual(MARK_AXIS_CLEAR_MIN_MM)
      const m = markGap(svg, "s1")
      expect(m.gap).toBeLessThanOrEqual(MARK_CIRCLE_GAP_MAX_MM)
      expect(m.over).toBe(0)
    })
  }
})

describe("AC-A05 (row 66a): any slot holding a circle of the dg_topology size, not only dg_topology", () => {
  // Slots w 16..64 mm x h 14.29 mm (r 7.14 mm). A vertical connector meets the rim straight above the centre of the
  // glyph's row 28 place (its ink centre); the mark must leave that axis by >= 1 mm and keep the AC-A05 rule.
  test("ink centre >= 1 mm from the axis, gap <= 4.7625 mm and no textOverNode for every slot", () => {
    const misses: string[] = []
    for (let w = 16; w <= 64; w += 2) {
      const nd = { id: "s1", x: 10, y: 10, w, h: 14.29, spec: { id: "s1", label: "x", shape: "circle", mark: "TERUKUR" } }
      const r = Math.min(nd.w, nd.h) / 2
      const [cx, cy] = [nd.x + nd.w / 2, nd.y + nd.h / 2]
      const plain = `<svg viewBox="0 0 100 50">${svgCore.shapeSvg(nd, "ink700", "none")}${svgCore.markGlyphSvg(nd)}</svg>`
      const b0 = lint.decorationOf([markTexts(plain)[0]], 100).texts[0] as number[]
      const ax = (b0[0] + b0[2]) / 2
      const end: P = [ax, cy - Math.sqrt(r * r - (ax - cx) ** 2)]
      const ends = [[[ax, end[1] - 4.7625], end]]
      const svg = `<svg viewBox="0 0 100 50">${svgCore.shapeSvg(nd, "ink700", "none")}${svgCore.markGlyphSvg(nd, ends)}</svg>`
      const b = lint.decorationOf([markTexts(svg)[0]], 100).texts[0] as number[]
      const clear = segDist([(b[0] + b[2]) / 2, (b[1] + b[3]) / 2], [ax, end[1] - 4.7625], [ax, end[1] + 2 * r])
      const m = markGap(svg, "s1")
      if (!(clear >= MARK_AXIS_CLEAR_MIN_MM) || !(m.gap <= MARK_CIRCLE_GAP_MAX_MM) || m.over) misses.push(`${w}: axis ${clear.toFixed(2)} mm, gap ${m.gap.toFixed(2)} mm`)
    }
    expect(misses).toEqual([])
  })
})

describe("AC-A05: any circle slot (the row 61b size sweep), not only dg_topology", () => {
  // Slots w 8..64 mm x h 4.76..19.05 mm (row 61b sweep): the circle has r = min(w, h) / 2 and sits in the middle.
  const WIDTHS = Array.from({ length: 29 }, (_, i) => 8 + 2 * i)
  const HEIGHTS = [4.76, 7.14, 9.52, 14.29, 19.05]
  test("gap <= 4.7625 mm and no textOverNode for every slot", () => {
    const misses: string[] = []
    for (const w of WIDTHS) {
      for (const h of HEIGHTS) {
        const nd = { id: "s1", x: 10, y: 10, w, h, spec: { id: "s1", label: "x", shape: "circle", mark: "TERUKUR" } }
        const svg = `<svg viewBox="0 0 100 50">${svgCore.shapeSvg(nd, "ink700", "none")}${svgCore.markGlyphSvg(nd)}</svg>`
        const m = markGap(svg, "s1")
        if (!(m.gap <= MARK_CIRCLE_GAP_MAX_MM) || m.over) misses.push(`${w}x${h}: ${m.gap.toFixed(2)} mm`)
      }
    }
    expect(misses).toEqual([])
  })
})

describe("AC-A05 negative control: marks on other shapes keep their anchors", () => {
  // Anchors at BASE d4282fcfd8 (text x, y of the mark glyph); only the circle branch changes.
  const KEEP: Array<[string, string, string, number, number]> = [
    ["dg_graph.json", "log (cylinder)", "◈", 138.14, 9.64],
    ["dg_layered_good.json", "sensor (box)", "■", 138.14, 12.21],
    ["dg_sld_good.json", "load (box)", "◇", 116.8, 31.26],
  ]
  for (const [file, node, glyph, x, y] of KEEP) {
    for (const release of [true, false]) {
      test(`${file} ${node} @${release ? "rel" : "draft"} keeps x ${x} y ${y}`, () => {
        const svg = build.buildDiagramSvg(fx(file), { release }).svg as string
        const tags = [...svg.matchAll(/<text [^>]*text-anchor="end"[^>]*>([■◈◇△])<\/text>/g)]
        expect(tags.map((m) => [m[1], num(m[0], "x"), num(m[0], "y")])).toEqual([[glyph, x, y]])
      })
    }
  }
})
