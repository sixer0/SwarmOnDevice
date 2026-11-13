// Swarm 1.2.8 row 53 (AC-HTAG = H-TAG, F-VISIO 01f §5.4; register N8-218 TAG_INSET_MM values R20-C37, N8-371; AT-HTAG;
// C12 OP-18-10 / C30: the tag-on-bus check is this row's). The requirement tag of a node is drawn inside the node's
// outline with >= 0.2 mm clearance from the outline line (stadium inset by its corner radius, side bar / slant / lid insets, diamond and
// circle centred above the label), and the engine geometry lint reports a tag whose ink leaves its node's outline as
// `textOutside`. Fixture: test/fixtures/syn128/htag_all_shapes.json (every drawn shape except bus in small one-row
// figures, one notation set each; `bus` = the OP-18-10 probe). Labels synthetic.
// Red at BASE e1f9673772: the stadium tag sits at x + 1.5 pt, its ink crosses the rounded corner, and the lint reports 0
// defects; the new shape tokens are refused. Label-below shapes (BPMN events and gateways, C12 OP-18-4) carry the tag
// in their label block: row 54 draws them (test.todo below).
// Namespace imports, so the red run fails on assertions, not on a link error.
import { useStudioEnv } from "../ported/_env"
useStudioEnv()
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import * as buildMod from "../../vendor/src/lib/studio/engine/diagram/build"
import * as elkMod from "../../vendor/src/lib/studio/engine/diagram/elk"
import * as svgMod from "../../vendor/src/lib/studio/engine/diagram/core/svg"
import * as lintMod from "../../vendor/src/lib/studio/engine/diagram/fit/lint"
import * as scanMod from "../../vendor/src/lib/studio/engine/chart/core/svgscan"

type J = Record<string, any>
type Pt = [number, number]
type Box = [number, number, number, number]
const FX = JSON.parse(readFileSync(path.join(import.meta.dir, "..", "fixtures", "syn128", "htag_all_shapes.json"), "utf8")) as J
const O = { release: false }
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v))
const FIGS = ["stadium", "iso_a", "iso_b", "iso_c", "iso_d", "bpmn_inside", "doubled", "shadowed"] as const
const WIDTHS = [128, 166] as const
const CLEAR_MM = 0.2
const STROKE = 0.45

const attr = (el: string, k: string): string | undefined => new RegExp(`\\s${k}="([^"]*)"`).exec(el)?.[1]
function build(fig: string, width: number): J {
  return (buildMod as J).buildDiagramSvg({ ...clone(FX[fig]), width_mm: width }, O)
}
async function buildAuto(fig: string, width: number): Promise<J> {
  return (elkMod as J).buildDiagramSvgAuto({ ...clone(FX[fig]), width_mm: width }, O, {}, () => {})
}

/** Tag texts (role table_header: bold, tracked) with their content and lint ink box. */
function tags(svg: string): Array<{ el: string; text: string; box: Box }> {
  return [...svg.matchAll(/<text\b[^>]*font-weight="600"[^>]*letter-spacing="[^"]*"[^>]*>([^<]*)<\/text>/g)].map((m) => ({
    el: m[0],
    text: m[1],
    box: (lintMod as J).textBlockBox(
      [{ x: Number(attr(m[0], "x")), y: Number(attr(m[0], "y")), s: m[1] }],
      Number(attr(m[0], "font-size")),
      attr(m[0], "text-anchor") ?? "start",
      "struct",
      true,
      Number(attr(m[0], "letter-spacing")),
    ) as Box,
  }))
}

/** Outline of node `id` as a closed ring (arcs and rounded corners sampled), or a circle. */
function outlineOf(svg: string, id: string): { ring?: Pt[]; circle?: { cx: number; cy: number; r: number }; el: string } {
  const el = new RegExp(`<(rect|polygon|path|circle|line)\\b[^>]*data-node="${id}"[^>]*/>`).exec(svg)![0]
  const n = (k: string) => Number(attr(el, k))
  if (el.startsWith("<circle")) return { circle: { cx: n("cx"), cy: n("cy"), r: n("r") }, el }
  if (el.startsWith("<rect")) {
    const [x, y, w, h] = [n("x"), n("y"), n("width"), n("height")]
    const r = Math.min(Number(attr(el, "rx") ?? 0), w / 2, h / 2)
    if (!(r > 0)) return { ring: [[x, y], [x + w, y], [x + w, y + h], [x, y + h]], el }
    const ring: Pt[] = []
    const corner = (cx: number, cy: number, a0: number) => {
      for (let k = 0; k <= 16; k++) {
        const a = a0 + (Math.PI / 2) * (k / 16)
        ring.push([cx + r * Math.cos(a), cy + r * Math.sin(a)])
      }
    }
    corner(x + w - r, y + r, -Math.PI / 2)
    corner(x + w - r, y + h - r, 0)
    corner(x + r, y + h - r, Math.PI / 2)
    corner(x + r, y + r, Math.PI)
    return { ring, el }
  }
  if (el.startsWith("<polygon")) {
    const v = attr(el, "points")!.trim().split(/[\s,]+/).map(Number)
    const ring: Pt[] = []
    for (let i = 0; i + 1 < v.length; i += 2) ring.push([v[i], v[i + 1]])
    return { ring, el }
  }
  const pls = (scanMod as J).pathPolylines(attr(el, "d")!) as Pt[][]
  return { ring: pls[0], el }
}
function inRing(p: Pt, ring: Pt[]): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}
function segDist(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const L = dx * dx + dy * dy
  const t = L > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L)) : 0
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy))
}
/**
 * Clearance (mm) between the tag ink box and the outline (centre line of the stroke, the geometry the closure lint reads);
 * negative = a corner outside. The stroke edge is checked separately (> 0: the ink never touches the drawn stroke).
 */
function clearance(box: Box, o: ReturnType<typeof outlineOf>): number {
  const corners: Pt[] = [[box[0], box[1]], [box[2], box[1]], [box[2], box[3]], [box[0], box[3]]]
  if (o.circle) {
    const far = Math.max(...corners.map((c) => Math.hypot(c[0] - o.circle!.cx, c[1] - o.circle!.cy)))
    return o.circle.r - far
  }
  const ring = o.ring!
  if (!corners.every((c) => inRing(c, ring))) return -1
  // sample the box edges finely and measure to every outline segment
  let d = Infinity
  for (let k = 0; k <= 40; k++) {
    const t = k / 40
    const pts: Pt[] = [
      [box[0] + (box[2] - box[0]) * t, box[1]],
      [box[0] + (box[2] - box[0]) * t, box[3]],
      [box[0], box[1] + (box[3] - box[1]) * t],
      [box[2], box[1] + (box[3] - box[1]) * t],
    ]
    for (const p of pts) for (let i = 0; i < ring.length; i++) d = Math.min(d, segDist(p, ring[i], ring[(i + 1) % ring.length]))
  }
  return d
}
const hostOf = (fig: string, tag: string): string => (FX[fig].nodes as J[]).find((n) => n.tag === tag)!.id

describe("H-TAG tag inset (N8-218, N8-371)", () => {
  test("TAG_INSET_MM and tagAnchor exist; stadium inset >= its corner radius (REG N8-218)", () => {
    const S = svgMod as J
    expect(S.TAG_INSET_MM).toBeDefined()
    expect(S.TAG_INSET_MM.fixed).toBeCloseTo(0.53, 2)
    expect(typeof S.tagAnchor).toBe("function")
    const nd = { x: 10, y: 20, w: 40, h: 12.7, spec: { id: "s", label: "Langkah A", shape: "stadium", tag: "T1" } }
    expect(S.tagAnchor(nd, null).x - nd.x).toBeGreaterThanOrEqual(nd.h / 2)
  })

  for (const W of WIDTHS) {
    test(`every tag @${W} lies inside its node outline with >= ${CLEAR_MM} mm clearance (all drawn shapes but bus)`, () => {
      const seen = new Set<string>()
      for (const fig of FIGS) {
        const svg = build(fig, W).svg as string
        const ts = tags(svg)
        expect(ts.length, fig).toBe((FX[fig].nodes as J[]).length)
        for (const t of ts) {
          const id = hostOf(fig, t.text)
          const shape = (FX[fig].nodes as J[]).find((n) => n.id === id)!.shape ?? "box"
          seen.add(shape)
          const c = clearance(t.box, outlineOf(svg, id))
          expect({ fig, shape, ok: c >= CLEAR_MM }, `${fig} ${shape} clearance ${c.toFixed(2)}`).toEqual({ fig, shape, ok: true })
          expect(c - STROKE / 2, `${fig} ${shape} ink vs stroke edge`).toBeGreaterThan(0)
        }
      }
      expect([...seen].sort()).toEqual(
        ["annotation", "box", "circle", "cylinder", "data_object", "diamond", "document", "doubled", "hexagon", "offpage", "parallelogram", "predefined", "shadowed", "stadium", "subprocess", "task"].sort(),
      )
    })

    test(`0 geometry defects @${W} for every tag figure, sync and production (auto) path`, async () => {
      for (const fig of FIGS) {
        for (const r of [build(fig, W), await buildAuto(fig, W)]) {
          expect((lintMod as J).lintDiagramGeometry(r.svg).defects, fig).toEqual([])
          expect(((r.report.geometry ?? []) as J[]).map((i) => i.checkId), fig).toEqual([])
        }
      }
    })
  }

  test("diamond and circle: tag centred above the label (text-anchor middle, x = node centre, above the label ink)", () => {
    for (const [fig, id] of [["iso_d", "n1"], ["iso_c", "n2"]] as const) {
      const svg = build(fig, 128).svg as string
      const t = tags(svg).find((x) => hostOf(fig, x.text) === id)!
      expect(attr(t.el, "text-anchor")).toBe("middle")
      const o = outlineOf(svg, id)
      const cx = o.circle ? o.circle.cx : (Math.min(...o.ring!.map((p) => p[0])) + Math.max(...o.ring!.map((p) => p[0]))) / 2
      expect(Number(attr(t.el, "x"))).toBeCloseTo(cx, 1)
      const label = (FX[fig].nodes as J[]).find((n) => n.id === id)!.label as string
      const lab = new RegExp(`<text\\b[^>]*>${label}</text>`).exec(svg)![0]
      expect(t.box[3]).toBeLessThanOrEqual(Number(attr(lab, "y")) - 1.5)
    }
  })

  test("doubled and predefined: tag inside the inner rectangle / between the side bars (decorations, >= 0.2 mm)", () => {
    for (const [fig, id, tag] of [["doubled", "n1", "T1"], ["iso_b", "n1", "T1"]] as const) {
      const svg = build(fig, 128).svg as string
      const t = tags(svg).find((x) => x.text === tag)!
      const el = new RegExp(`<rect\\b[^>]*data-node="${id}"[^>]*/>`).exec(svg)![0]
      const [x, y] = [Number(attr(el, "x")), Number(attr(el, "y"))]
      expect(t.box[0] - (x + 1.2), fig).toBeGreaterThanOrEqual(CLEAR_MM)
      if (fig === "doubled") expect(t.box[1] - (y + 1.2), fig).toBeGreaterThanOrEqual(CLEAR_MM)
    }
  })

  test("cylinder: tag below the lid, label block below the tag line", () => {
    const svg = build("iso_c", 128).svg as string
    const t = tags(svg).find((x) => hostOf("iso_c", x.text) === "n1")!
    const label = (FX.iso_c.nodes as J[])[0].label as string
    const lab = new RegExp(`<text\\b[^>]*>${label}</text>`).exec(svg)![0]
    const lb = (lintMod as J).textBlockBox([{ x: Number(attr(lab, "x")), y: Number(attr(lab, "y")), s: label }], Number(attr(lab, "font-size")), "middle", "struct", false, 0) as Box
    expect(lb[1]).toBeGreaterThanOrEqual(t.box[3])
  })

  test("the lint reports a misplaced tag as textOutside naming the node (tag moved back to x + 1.5 pt on a stadium)", () => {
    const svg = build("stadium", 128).svg as string
    expect((lintMod as J).lintDiagramGeometry(svg).defects).toEqual([])
    const t = tags(svg).find((x) => x.text === "T1")!
    const el = new RegExp(`<rect\\b[^>]*data-node="n1"[^>]*/>`).exec(svg)![0]
    const x = Number(attr(el, "x"))
    const moved = svg.replace(t.el, t.el.replace(/ x="[^"]*"/, ` x="${(x + 0.53).toFixed(2)}"`))
    const d = ((lintMod as J).lintDiagramGeometry(moved).defects as J[]).filter((k) => k.kind === "textOutside")
    expect(d.length).toBe(1)
    expect(d[0].text).toBe("T1")
    expect(d[0].other).toBe("n1")
    expect(d[0].amount).toBeGreaterThan(0.3)
  })

  test("a tag placed past a diamond's side is reported too (polygon outline)", () => {
    const svg = build("iso_d", 128).svg as string
    const t = tags(svg).find((x) => x.text === "T1")!
    const el = new RegExp(`<polygon\\b[^>]*data-node="n1"[^>]*/>`).exec(svg)![0]
    const v = attr(el, "points")!.trim().split(/[\s,]+/).map(Number)
    const left = Math.min(v[0], v[2], v[4], v[6])
    const top = Math.min(v[1], v[3], v[5], v[7])
    const moved = svg.replace(t.el, t.el.replace(/ x="[^"]*"/, ` x="${(left + 0.53).toFixed(2)}"`).replace(/ y="[^"]*"/, ` y="${(top + 2.68).toFixed(2)}"`).replace('text-anchor="middle"', 'text-anchor="start"'))
    const d = ((lintMod as J).lintDiagramGeometry(moved).defects as J[]).filter((k) => k.kind === "textOutside" && k.other === "n1")
    expect(d.length).toBe(1)
  })

  test("OP-18-10 bus: the tag sits in the bus box above the rail (>= 0.2 mm from the heavy rail), 0 defects", () => {
    for (const W of WIDTHS) {
      const r = (buildMod as J).buildDiagramSvg({ ...clone(FX.bus), width_mm: W }, O)
      const svg = r.svg as string
      const t = tags(svg).find((x) => x.text === "B1")!
      const rail = /<line\b[^>]*data-mark="node"[^>]*\/>/.exec(svg)![0]
      const ry = Number(attr(rail, "y1"))
      const half = Number(attr(rail, "stroke-width")) / 2
      expect(ry - half - t.box[3]).toBeGreaterThanOrEqual(CLEAR_MM)
      expect(t.box[0]).toBeGreaterThanOrEqual(Number(attr(rail, "x1")))
      expect((lintMod as J).lintDiagramGeometry(svg).defects).toEqual([])
    }
  })

  // Row 54 (AC-VIS3a, C75): the events part of the former test.todo; gateways follow with row 54b (VIS-3b).
  test("label-below events (C12 OP-18-4) carry the tag in their label block, centred one line above the label text, 0 defects", () => {
    const shapes = ["event_start", "event_intermediate", "event_end"]
    const spec = {
      $schema: "studio.diagram/v1", family: "flow", direction: "LR", id: "9.9", title: "Uji tag peristiwa.", classification: "BIASA",
      apparatus: "page", labels_verified: true, sources: ["Sumber sintetis uji"],
      nodes: shapes.map((s, i) => ({ id: `n${i + 1}`, label: `Alfa ${i + 1}`, shape: s, tag: `T${i + 1}`, class: {} })),
      edges: [{ from: "n1", to: "n2", kind: "data", label: "lanjut" }, { from: "n2", to: "n3", kind: "data", label: "lanjut" }],
    }
    for (const W of WIDTHS) {
      const svg = (buildMod as J).buildDiagramSvg({ ...clone(spec), width_mm: W }, O).svg as string
      shapes.forEach((_, i) => {
        const circle = new RegExp(`<circle\\b[^>]*data-node="n${i + 1}"[^>]*/>`).exec(svg)![0]
        const group = /<g data-label-pos="below">([\s\S]*?)<\/g>/.exec(svg.slice(svg.indexOf(circle)))![1]
        const t = tags(group).find((x) => x.text === `T${i + 1}`)!
        expect(t, `T${i + 1}`).toBeDefined()
        expect(attr(t.el, "text-anchor")).toBe("middle")
        expect(Number(attr(t.el, "x"))).toBeCloseTo(Number(attr(circle, "cx")), 1)
        const cyBottom = Number(attr(circle, "cy")) + Number(attr(circle, "r")) + Number(attr(circle, "stroke-width")) / 2
        expect(t.box[1]).toBeGreaterThanOrEqual(cyBottom + 1.0 - 1e-6)
        const label = new RegExp(`<text\\b[^>]*>Alfa ${i + 1}</text>`).exec(group)![0]
        expect(Number(attr(label, "y")) - Number(attr(t.el, "y"))).toBeCloseTo(2.68 * 1.2, 1) // one tag line (caption x 1.2)
      })
      expect((lintMod as J).lintDiagramGeometry(svg).defects).toEqual([])
    }
  })
  test.todo("label-below gateways carry the tag in their label block above the label text (row 54b, AC-VIS3b)", () => {})
})
