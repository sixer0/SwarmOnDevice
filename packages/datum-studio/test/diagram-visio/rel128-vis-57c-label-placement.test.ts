// Swarm 1.2.8 row 57c (C71, C86, C101, C102, C111, C116, C119, C121, C123; M3; user item 7: connector and arrow control
// at the MS Visio minimum). Edge label placement, one geometric assertion per defect, measured on the SVG the
// production path draws (buildDiagramSvgAuto) with helpers of this file only (no row 57c export is needed to measure):
//  1. a label band covers no arrowhead and crosses no node outline (vis2_phases_v SERAH/SELESAI, vis4 ORTOGONAL,
//     vis3_process KE beside Tugas D, vis1 gallery "2" under Data D and the cylinder lid);
//  2. in a top-to-bottom flow an event left downward is labelled beside its circle and its connector starts on it (C86);
//  3. the annotation association draws no arrowhead (fixture arrow_end "none", C111) and its label covers no other
//     connector's start or end;
//  4. no stray piece beside a label: 0 GEOM_STUB_SEGMENT on vis3_process (the 0.33 mm KE stub) and the pool figures;
//  5. a label band crosses no container rule (lane rule, phase separator, pool border) no connector runs along;
//  6. the lint names the collision (kind labelCollision, GEOM_LABEL_COLLISION) so auto-fit moves it; the swimlane
//     refusal with phases names the phase (R3);
//  C123: (1) a shadowed node's shadow is drawn before the connectors; (2) a link between nodes of different heights in
//  one row is one straight run; (3) no out-and-back run under a label (vis2_phases_v A->B).
// Red at the pre-57c HEAD (77962be76e) for every defect; BASE e1f9673772 refuses the 1.2.8 fixtures.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { buildDiagramSvg } from "../../vendor/src/lib/studio/engine/diagram/build"
import { buildDiagramSvgAuto } from "../../vendor/src/lib/studio/engine/diagram/elk"
import * as lint from "../../vendor/src/lib/studio/engine/diagram/fit/lint"
import * as capacity from "../../vendor/src/lib/studio/engine/diagram/build/capacity"
import { pathPolylines } from "../../vendor/src/lib/studio/engine/chart/core/svgscan"

type J = Record<string, any>
type Pt = [number, number]
type Box = [number, number, number, number]
const fx = (name: string): J => JSON.parse(readFileSync(path.join(import.meta.dir, "..", "fixtures", "syn128", name), "utf8"))
const O = { release: false }
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v))
const w = (s: J, mm: number): J => ({ ...clone(s), width_mm: mm })
const auto = async (s: J): Promise<string> => (await buildDiagramSvgAuto(clone(s) as never, O as never, {}, () => {})).svg as string

const EV = fx("vis3_bpmn_events.json")
const GA = fx("vis3_bpmn_gallery.json")
const PV = fx("vis2_phases_v.json")
const R4 = fx("vis4_routes.json")
const G1 = fx("vis1_flowchart_gallery.json")
const PO = fx("vis2_pools_group.json")
const ES = fx("vis2_label_escape.json")
const HT = fx("htag_all_shapes.json")

/** The row 53b eye gallery (test/eye/53b/eye.ts): two rows of one labelled link, nodes of different heights in a row. */
function gallery(shape: string): J {
  const s = clone(HT[shape])
  s.title = `Gambar sintetis galeri ${shape}.`
  s.per_row = 2
  s.width_mm = 166
  s.nodes = [
    { id: "n1", label: "Langkah A", tag: "T1", shape, class: { col: 0, row: 0 } },
    { id: "n2", label: "Langkah B", sub: "Rincian sintetis", tag: "T2", shape, class: { col: 1, row: 0, accent: true } },
    { id: "n3", label: "Langkah sintetis dengan label panjang yang dibungkus menjadi dua baris", tag: "T3", shape, class: { col: 0, row: 1 } },
    { id: "n4", label: "Langkah D", shape, class: { col: 1, row: 1 } },
  ]
  s.edges = [
    { from: "n1", to: "n2", kind: "data", label: "1" },
    { from: "n3", to: "n4", kind: "data", label: "2" },
  ]
  return s
}

const FIGS: Record<string, J> = {
  vis2_phases_v: PV.spec,
  vis3_events_tb_128: w(EV.events_tb, 128),
  vis3_process_166: w(GA.process, 166),
  vis4_routes: R4.spec,
  vis1_gallery_166: w(G1.gallery, 166),
  vis2_pools_collab_group: PO.spec,
  vis2_pools_escape: ES.pools,
}

// ── SVG readers (this file's own; the engine's are not used to measure) ─────────────────────────────────────────
const attr = (el: string, k: string): string | undefined => new RegExp(`\\s${k}="([^"]*)"`).exec(el)?.[1]
const num = (el: string, k: string): number => Number(attr(el, k))
const nums = (d: string): number[] => (d.match(/-?[\d.]+(?:e-?\d+)?/g) ?? []).map(Number)

interface Link {
  el: string
  pts: Pt[]
  at: number
}
function links(svg: string): Link[] {
  return [...svg.matchAll(/<path\b[^>]*data-mark="link"[^>]*\/>/g)].map((m) => {
    const v = nums(attr(m[0], "d") ?? "")
    const pts: Pt[] = []
    for (let i = 0; i + 1 < v.length; i += 2) pts.push([v[i], v[i + 1]])
    return { el: m[0], pts, at: m.index ?? 0 }
  })
}
/** Knock-out bands: a paper rect without stroke and mark right before an edge-label `<text>` (mono face). */
function bands(svg: string): Array<{ box: Box; text: string }> {
  return [...svg.matchAll(/<rect x="([\d.-]+)" y="([\d.-]+)" width="([\d.]+)" height="([\d.]+)" fill="#FCFCFB"\/>\s*<text\b[^>]*IBM Plex Mono[^>]*>([^<]*)<\/text>/g)].map((m) => ({
    box: [Number(m[1]), Number(m[2]), Number(m[1]) + Number(m[3]), Number(m[2]) + Number(m[4])],
    text: m[5],
  }))
}
/** Bounding boxes of the node outlines (`data-node`), grown by half their stroke. */
function nodeBoxes(svg: string): Array<{ id: string; box: Box }> {
  return [...svg.matchAll(/<(rect|polygon|path|circle)\b[^>]*data-node="([^"]+)"[^>]*\/>/g)].map((m) => {
    const el = m[0]
    const h = (Number(attr(el, "stroke-width")) || 0) / 2
    let b: Box
    if (m[1] === "rect") b = [num(el, "x"), num(el, "y"), num(el, "x") + num(el, "width"), num(el, "y") + num(el, "height")]
    else if (m[1] === "circle") b = [num(el, "cx") - num(el, "r"), num(el, "cy") - num(el, "r"), num(el, "cx") + num(el, "r"), num(el, "cy") + num(el, "r")]
    else {
      // polygon points; a path through the scanner the geometry lint has used since 1.2.6 (arcs sampled, not raw numbers)
      const pts: Array<readonly [number, number]> =
        m[1] === "polygon"
          ? nums(attr(el, "points") ?? "").flatMap((v, i, a) => (i % 2 === 0 ? [[v, a[i + 1]] as const] : []))
          : pathPolylines(attr(el, "d") ?? "").flat()
      const xs = pts.map((p) => p[0])
      const ys = pts.map((p) => p[1])
      b = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
    }
    return { id: m[2], box: [b[0] - h, b[1] - h, b[2] + h, b[3] + h] as Box }
  })
}
/** Marker sizes by id: L = markerWidth - 2, W = markerHeight - 2 (core/svg.ts arrowMarkerSvg, 1 mm margins). */
function markers(svg: string): Map<string, { L: number; W: number }> {
  return new Map([...svg.matchAll(/<marker\b[^>]*>/g)].map((m) => [attr(m[0], "id")!, { L: num(m[0], "markerWidth") - 2, W: num(m[0], "markerHeight") - 2 }]))
}
/** The region an end head covers: tip, back L along the last piece, W wide. */
function headQuads(svg: string): Pt[][] {
  const mk = markers(svg)
  const out: Pt[][] = []
  for (const l of links(svg)) {
    for (const [which, pts] of [["marker-end", l.pts], ["marker-start", [...l.pts].reverse()]] as const) {
      const id = /url\(#([^)]+)\)/.exec(attr(l.el, which) ?? "")?.[1]
      const h = id ? mk.get(id) : undefined
      if (!h) continue
      const e = pts[pts.length - 1]
      const p = [...pts].reverse().find((q) => Math.hypot(q[0] - e[0], q[1] - e[1]) > 1e-6)
      if (!p) continue
      const len = Math.hypot(e[0] - p[0], e[1] - p[1])
      const [ux, uy] = [(e[0] - p[0]) / len, (e[1] - p[1]) / len]
      const hw = h.W / 2
      const base: Pt = [e[0] - ux * h.L, e[1] - uy * h.L]
      out.push([[e[0] - uy * hw, e[1] + ux * hw], [e[0] + uy * hw, e[1] - ux * hw], [base[0] + uy * hw, base[1] - ux * hw], [base[0] - uy * hw, base[1] + ux * hw]])
    }
  }
  return out
}
const overlap = (a: Box, b: Box, eps = 0.05): boolean => a[0] < b[2] - eps && a[2] > b[0] + eps && a[1] < b[3] - eps && a[3] > b[1] + eps
/** Convex quad vs box (separating axes). */
function quadHits(q: Pt[], b: Box): boolean {
  const c: Pt[] = [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]]
  const axes: Pt[] = [[1, 0], [0, 1], ...q.map((p, i): Pt => [-(q[(i + 1) % q.length][1] - p[1]), q[(i + 1) % q.length][0] - p[0]])]
  return axes.every(([ax, ay]) => {
    const pq = q.map((p) => p[0] * ax + p[1] * ay)
    const pb = c.map((p) => p[0] * ax + p[1] * ay)
    return Math.max(...pq) > Math.min(...pb) + 1e-6 && Math.max(...pb) > Math.min(...pq) + 1e-6
  })
}
const shrink = (b: Box, d: number): Box => [b[0] + d, b[1] + d, b[2] - d, b[3] - d]
/** Container rules: solid unmarked lines, and the sides of primary-stroke unfilled rects (pool borders). */
function rules(svg: string): Array<[Pt, Pt]> {
  const out: Array<[Pt, Pt]> = []
  for (const m of svg.matchAll(/<line\b[^>]*\/>/g)) {
    const el = m[0]
    if (/data-(mark|node)=/.test(el) || /stroke-dasharray/.test(el)) continue
    out.push([[num(el, "x1"), num(el, "y1")], [num(el, "x2"), num(el, "y2")]])
  }
  for (const m of svg.matchAll(/<rect\b[^>]*fill="none"[^>]*\/>/g)) {
    const el = m[0]
    if (/data-(mark|node)=/.test(el) || /stroke-dasharray/.test(el) || !(Number(attr(el, "stroke-width")) > 0.3)) continue
    const [x, y, ww, h] = [num(el, "x"), num(el, "y"), num(el, "width"), num(el, "height")]
    const c: Pt[] = [[x, y], [x + ww, y], [x + ww, y + h], [x, y + h]]
    for (let i = 0; i < 4; i++) out.push([c[i], c[(i + 1) % 4]])
  }
  return out
}
/** An axis rule crosses the band where no connector runs along it. */
function ruleCrossesBand(r: [Pt, Pt], b: Box, ls: Link[]): boolean {
  const hor = Math.abs(r[0][1] - r[1][1]) < 1e-6
  const ver = Math.abs(r[0][0] - r[1][0]) < 1e-6
  if (!hor && !ver) return false
  const line = hor ? r[0][1] : r[0][0]
  const [lo0, hi0] = hor ? [b[1], b[3]] : [b[0], b[2]]
  if (line <= lo0 || line >= hi0) return false
  const k = hor ? 0 : 1
  const lo = Math.max(Math.min(r[0][k], r[1][k]), hor ? b[0] : b[1])
  const hi = Math.min(Math.max(r[0][k], r[1][k]), hor ? b[2] : b[3])
  if (hi - lo <= 0.05) return false
  const cover = ls
    .flatMap((l) => l.pts.slice(1).map((q, i): [Pt, Pt] => [l.pts[i], q]))
    .filter(([p, q]) => (hor ? Math.abs(p[1] - q[1]) < 1e-6 && Math.abs(p[1] - line) < 0.3 : Math.abs(p[0] - q[0]) < 1e-6 && Math.abs(p[0] - line) < 0.3))
    .map(([p, q]): [number, number] => [Math.min(p[k], q[k]), Math.max(p[k], q[k])])
    .sort((a, b2) => a[0] - b2[0])
  let reach = lo
  for (const [s, e] of cover) {
    if (s > reach + 0.05) break
    reach = Math.max(reach, e)
  }
  return reach < hi - 0.05
}

describe("row 57c defect 1: label bands keep arrowheads and node outlines visible", () => {
  for (const [name, spec] of Object.entries(FIGS)) {
    test(`${name}: no band over an arrowhead, no band over a node outline`, async () => {
      const svg = await auto(spec)
      const bs = bands(svg)
      expect(bs.length, name).toBeGreaterThan(0)
      const heads = headQuads(svg)
      const onHead = bs.filter((b) => heads.some((q) => quadHits(q, shrink(b.box, 0.05)))).map((b) => b.text)
      const onNode = bs.filter((b) => nodeBoxes(svg).some((n) => overlap(b.box, n.box))).map((b) => b.text)
      expect({ name, onHead, onNode }).toEqual({ name, onHead: [], onNode: [] })
    })
  }
  test("vis1 gallery @166: the cylinder's label (Arsip D) starts below the lid's front rim (y + 0.32 h), first render too", async () => {
    for (const svg of [await auto(FIGS.vis1_gallery_166), buildDiagramSvg(clone(FIGS.vis1_gallery_166) as never, O).svg as string]) {
      const el = /<path\b[^>]*data-node="([^"]+)"[^>]*\/>/g
      const cyl = [...svg.matchAll(el)].map((m) => m[0]).find((e) => / a[\d.]+ [\d.]+ 0 0 0 /.test(attr(e, "d") ?? ""))!
      expect(cyl).toBeDefined()
      const pts = pathPolylines(attr(cyl, "d") ?? "").flat()
      const top = Math.min(...pts.map((p) => p[1]))
      const h = Math.max(...pts.map((p) => p[1])) - top
      const rest = svg.slice(svg.indexOf(cyl) + cyl.length)
      const t = /<text\b[^>]*>([\s\S]*?)<\/text>/.exec(rest)!
      const size = num(t[0], "font-size")
      const firstY = num(t[0], "y") || num(/<tspan\b[^>]*>/.exec(t[0])?.[0] ?? "", "y")
      expect(firstY - 0.9 * size).toBeGreaterThanOrEqual(top + 0.32 * h - 0.05)
    }
  })
})

describe("row 57c defect 2: an event left downward in a TB flow is labelled beside its circle (C86)", () => {
  test("vis3 events_tb @128: the exits of Awal D and Tunggu D start on their circles; their labels are right of them", async () => {
    const svg = await auto(FIGS.vis3_events_tb_128)
    const ls = links(svg)
    for (const id of ["a", "c"]) {
      const el = new RegExp(`<circle\\b[^>]*data-node="${id}"[^>]*/>`).exec(svg)![0]
      const [cx, cy, r, sw] = [num(el, "cx"), num(el, "cy"), num(el, "r"), num(el, "stroke-width")]
      // the connector leaving below the circle starts on its rim (within the stroke)
      const out = ls.find((l) => Math.abs(l.pts[0][0] - cx) < r && l.pts[0][1] > cy)!
      expect(out, id).toBeDefined()
      expect(Math.abs(Math.hypot(out.pts[0][0] - cx, out.pts[0][1] - cy) - r), id).toBeLessThanOrEqual(sw / 2 + 0.05)
      // its label group lies right of the circle
      const g = /<g data-label-pos="below">([\s\S]*?)<\/g>/.exec(svg.slice(svg.indexOf(el)))![1]
      const x = num(/<text\b[^>]*>/.exec(g)![0], "x")
      expect(x, id).toBeGreaterThan(cx + r)
    }
  })
})

describe("row 57c defect 3: the annotation association (C101, C111)", () => {
  test("vis3 process @166: the association has no head; its label band covers no other connector's first or last 3 mm", async () => {
    const assoc = (GA.process.edges as J[]).find((e) => e.from === "a" && e.to === "t3")!
    expect(assoc.arrow_end).toBe("none")
    const svg = await auto(FIGS.vis3_process_166)
    const ls = links(svg)
    const cat = bands(svg).find((b) => b.text === "CAT")!
    expect(cat).toBeDefined()
    const own = ls.find((l) => attr(l.el, "data-index") === String((GA.process.edges as J[]).indexOf(assoc)))
    expect(own && attr(own.el, "marker-end")).toBeUndefined()
    const ends = ls.filter((l) => l !== own).flatMap((l) => [l.pts.slice(0, 2), l.pts.slice(-2).reverse()])
    const covered = ends.filter(([p, q]) => {
      const len = Math.hypot(q[0] - p[0], q[1] - p[1])
      const f = Math.min(1, 3 / Math.max(len, 1e-9))
      const e: Pt = [p[0] + (q[0] - p[0]) * f, p[1] + (q[1] - p[1]) * f]
      return [0, 0.25, 0.5, 0.75, 1].some((t) => {
        const x = p[0] + (e[0] - p[0]) * t
        const y = p[1] + (e[1] - p[1]) * t
        return x > cat.box[0] && x < cat.box[2] && y > cat.box[1] && y < cat.box[3]
      })
    })
    expect(covered.length).toBe(0)
  })
})

describe("row 57c defect 4: no stray piece beside a label (C101 KE 0.33 mm stub, C102 short-run dash)", () => {
  for (const name of ["vis3_process_166", "vis2_phases_v", "vis2_pools_collab_group", "vis2_pools_escape"]) {
    test(`${name}: 0 stubSegment`, async () => {
      expect(lint.lintDiagramGeometry(await auto(FIGS[name])).counts.stubSegment, name).toBe(0)
    })
  }
})

describe("row 57c defect 5: labels respect pool borders, lane rules and phase separators (C116)", () => {
  for (const name of ["vis2_phases_v", "vis2_pools_collab_group", "vis2_pools_escape"]) {
    test(`${name}: no label band crosses a container rule no connector runs along`, async () => {
      const svg = await auto(FIGS[name])
      const ls = links(svg)
      const crossed = bands(svg)
        .filter((b) => rules(svg).some((r) => ruleCrossesBand(r, shrink(b.box, 0.05), ls)))
        .map((b) => b.text)
      expect({ name, crossed }).toEqual({ name, crossed: [] })
    })
  }
})

describe("row 57c defect 6: the lint names the collision, auto-fit moves it; R3 refusal wording", () => {
  test("a band over an arrowhead is labelCollision (GEOM_LABEL_COLLISION in the auto-fit score)", () => {
    const svg = [
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 40">`,
      `<defs><marker id="head-data" markerUnits="userSpaceOnUse" markerWidth="5.2" markerHeight="4.85" refX="4.2" refY="2.42" orient="auto"><path d="M1,1 L4.2,2.42 L1,3.85 Z"/></marker></defs>`,
      `<path d="M 30 20 L 60 20" fill="none" stroke="#101418" stroke-width="0.45" marker-end="url(#head-data)" data-mark="link"/>`,
      `<rect x="55" y="17" width="8" height="3.54" fill="#FCFCFB"/><text x="59" y="19.4" font-family="IBM Plex Mono" font-size="2.081">KE</text>`,
      `<rect x="60" y="10" width="20" height="20" data-node="b" fill="none" stroke="#2B3640" stroke-width="0.45" data-mark="node"/>`,
      `</svg>`,
    ].join("\n")
    const g = lint.lintDiagramGeometry(svg) as J
    expect(g.counts.labelCollision).toBeGreaterThan(0)
    expect(g.score).toBeGreaterThan(0)
    expect(g.defects.some((d: J) => d.kind === "labelCollision" && d.other === "b")).toBe(true)
  })
  test("R3: a swimlane refused with phases names the phase; horizontal pools point to vertical pools", () => {
    const base = { family: "swimlane", width_mm: 166, nodes: [], edges: [] }
    const ph = capacity.capacityAction({ ...base, phases: [{ id: "f1", label: "Fase 1" }] } as never, "DATUM-37-sheet")
    expect(ph).toMatch(/per fase/)
    const po = capacity.capacityAction({ ...base, pools: [{ id: "p", label: "Kolam" }] } as never, "DATUM-37-sheet")
    expect(po).toMatch(/lane_orientation "vertical"/)
    expect(capacity.capacityAction(base as never, "DATUM-37-sheet")).toBe("kurangi simpul per lajur, bagi lajur, atau pecah menjadi 2 diagram (lebar 166 mm)")
  })
})

describe("row 57c C123 (row 53b findings)", () => {
  test("(1) shadowed gallery @166: every shadow rect is drawn before the first connector", async () => {
    const svg = await auto(gallery("shadowed"))
    const first = Math.min(...links(svg).map((l) => l.at))
    const shadows = [...svg.matchAll(/<rect\b[^>]*fill="none" stroke="#C3CBD1" stroke-width="0.2"\/>/g)].map((m) => m.index ?? 0)
    expect(shadows.length).toBe(4)
    expect(shadows.every((i) => i < first)).toBe(true)
  })
  test("(2) doubled and shadowed galleries @166: the link between nodes of different heights in one row is one straight run", async () => {
    for (const shape of ["shadowed", "doubled"]) {
      const svg = buildDiagramSvg(gallery(shape) as never, O).svg as string
      for (const l of links(svg)) {
        const ys = l.pts.map((p) => p[1])
        expect([shape, Math.max(...ys) - Math.min(...ys)]).toEqual([shape, 0])
      }
    }
  })
  test("(3) vis2_phases_v: the A -> B connector never runs back under its label (x monotone)", async () => {
    const svg = await auto(PV.spec)
    for (const l of links(svg)) {
      const xs = l.pts.map((p) => p[0])
      let dir = 0
      let back = false
      for (let i = 1; i < xs.length; i++) {
        const d = Math.sign(Math.round((xs[i] - xs[i - 1]) * 100))
        if (d === 0) continue
        if (dir !== 0 && d !== dir && Math.abs(l.pts[i][1] - l.pts[i - 1][1]) < 1e-6 && Math.abs(l.pts[0][1] - l.pts[l.pts.length - 1][1]) < 1e-6) back = true
        dir = d
      }
      expect(back, attr(l.el, "data-index")).toBe(false)
    }
  })
})
