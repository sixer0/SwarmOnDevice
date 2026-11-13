// Swarm 1.2.8 row 56d (C134 from the M3 gate: G3-06, G3-07, G3-09; user item 7, connectors at the MS Visio minimum).
// One geometric assertion per defect, on the production auto path (`buildDiagramSvgAuto`) at 166 mm:
//  G3-06a  LR start -> decision (stadium -> diamond vertex, the diagram-flow skill's flowchart example): one straight run,
//          no 2.38 mm Z-step (`L 42.67 26.19 L 42.67 28.57`);
//  G3-06b  a node with two bottom exits (the skill's connectors example: A and B each fan two ends on their bottom): the
//          single link to the node below drops straight, no jog under the source;
//  G3-07   connector runs never lie on a container rule (lane rule, phase separator, pool border): no inner run within
//          1 mm of a parallel rule over more than 1 mm (57c vis2_phases_v YA x=122.67 / TERUSKAN x=80.00, vis2_pools_escape
//          KE x=112.00);
//  G3-09   a label band leaves no stray piece: the source piece beside the band is >= 2 mm (gallery "1"/"2": 1.24 mm) and
//          a dashed connector keeps >= 1 mm of each dash the band cuts (MINTA / PESAN: 0.17 mm under the band).
// Specs are synthetic (fixtures syn128/vis2_phases_v, vis2_label_escape, vis2_pools_group, htag_all_shapes; the two skill
// examples inline). Red at the pre-56d HEAD (30168cc94c): all four describe blocks fail; green after.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { buildDiagramSvgAuto } from "../../vendor/src/lib/studio/engine/diagram/elk"
import { lintDiagramGeometry } from "../../vendor/src/lib/studio/engine/diagram/fit/lint"

type J = Record<string, any>
type Pt = [number, number]
const fx = (name: string): J => JSON.parse(readFileSync(path.join(import.meta.dir, "..", "fixtures", "syn128", name), "utf8"))
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v))

async function render(spec: J, w = 166): Promise<string> {
  const r = await buildDiagramSvgAuto({ ...clone(spec), width_mm: w } as never, { release: false } as never, {}, () => {})
  return (r as { svg: string }).svg
}

interface Link {
  index: number
  pts: Pt[]
  dash: number[]
}
function links(svg: string): Link[] {
  return [...svg.matchAll(/<path d="(M [^"]+)"([^>]*data-mark="link"[^>]*)\/>/g)].map((m) => ({
    index: Number(/data-index="(\d+)"/.exec(m[2])?.[1] ?? -1),
    dash: (/stroke-dasharray="([^"]+)"/.exec(m[2])?.[1] ?? "").split(",").filter(Boolean).map(Number),
    pts: m[1]
      .replace(/^M\s*/, "")
      .split(/\s*L\s*/)
      .map((p) => p.trim().split(/\s+/).map(Number) as Pt),
  }))
}
const linkAt = (svg: string, i: number): Link => {
  const l = links(svg).find((x) => x.index === i)
  if (!l) throw new Error(`link ${i} not drawn`)
  return l
}

/** Axis-parallel runs of a polyline (zero-length steps dropped, collinear steps merged), in path order. */
function runs(pts: readonly Pt[]): Array<{ a: Pt; b: Pt; vertical: boolean }> {
  const out: Array<{ a: Pt; b: Pt; vertical: boolean }> = []
  for (let i = 0; i + 1 < pts.length; i++) {
    const [p, q] = [pts[i], pts[i + 1]]
    if (Math.hypot(q[0] - p[0], q[1] - p[1]) < 1e-9) continue
    const vertical = Math.abs(q[0] - p[0]) < 1e-9
    const last = out[out.length - 1]
    if (last && last.vertical === vertical && (vertical ? Math.abs(last.a[0] - q[0]) < 1e-9 : Math.abs(last.a[1] - q[1]) < 1e-9)) last.b = q
    else out.push({ a: p, b: q, vertical })
  }
  return out
}

/** Container rules: hairline / border `<line>` elements and the unmarked frame rectangles (pool boxes). */
function rules(svg: string): Array<{ vertical: boolean; c: number; lo: number; hi: number }> {
  const out: Array<{ vertical: boolean; c: number; lo: number; hi: number }> = []
  for (const m of svg.matchAll(/<line x1="([\d.]+)" y1="([\d.]+)" x2="([\d.]+)" y2="([\d.]+)"/g)) {
    const [x1, y1, x2, y2] = m.slice(1, 5).map(Number)
    if (Math.abs(x1 - x2) < 1e-6) out.push({ vertical: true, c: x1, lo: Math.min(y1, y2), hi: Math.max(y1, y2) })
    else if (Math.abs(y1 - y2) < 1e-6) out.push({ vertical: false, c: y1, lo: Math.min(x1, x2), hi: Math.max(x1, x2) })
  }
  for (const m of svg.matchAll(/<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)" fill="none" stroke="[^"]+" stroke-width="[\d.]+"\/>/g)) {
    const [x, y, w, h] = m.slice(1, 5).map(Number)
    out.push({ vertical: true, c: x, lo: y, hi: y + h }, { vertical: true, c: x + w, lo: y, hi: y + h })
    out.push({ vertical: false, c: y, lo: x, hi: x + w }, { vertical: false, c: y + h, lo: x, hi: x + w })
  }
  return out
}

/** Inner runs (not the first or last) lying within 1 mm of a parallel rule over more than 1 mm. */
function runsOnRules(svg: string): string[] {
  const rs = rules(svg)
  const bad: string[] = []
  for (const l of links(svg)) {
    const rr = runs(l.pts)
    for (let i = 1; i + 1 < rr.length; i++) {
      const { a, b, vertical } = rr[i]
      const c = vertical ? a[0] : a[1]
      const lo = Math.min(vertical ? a[1] : a[0], vertical ? b[1] : b[0])
      const hi = Math.max(vertical ? a[1] : a[0], vertical ? b[1] : b[0])
      for (const r of rs) {
        if (r.vertical === vertical && Math.abs(r.c - c) < 1.0 && Math.min(r.hi, hi) - Math.max(r.lo, lo) > 1.0) bad.push(`link ${l.index} ${vertical ? "x" : "y"}=${c} on rule ${r.c}`)
      }
    }
  }
  return bad
}

/** Label knock-out bands (small background-coloured rects, not the page). */
function bands(svg: string): Array<[number, number, number, number]> {
  return [...svg.matchAll(/<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)" fill="#FCFCFB"\/>/g)]
    .map((m) => m.slice(1, 5).map(Number))
    .filter(([, , w, h]) => w < 30 && h < 5)
    .map(([x, y, w, h]) => [x, y, x + w, y + h] as [number, number, number, number])
}

const BASE = { $schema: "studio.diagram/v1", classification: "BIASA", apparatus: "page", labels_verified: true, sources: ["Sumber sintetis uji"] }
const FLOWCHART = {
  ...BASE,
  id: "9.56",
  family: "flow",
  direction: "LR",
  title: "Permohonan diperiksa sebelum diproses.",
  nodes: [
    { id: "a", label: "Mulai", shape: "stadium", class: {} },
    { id: "b", label: "Lengkap?", shape: "diamond", class: {} },
    { id: "c", label: "Proses", class: {} },
    { id: "d", label: "Tolak", shape: "stadium", class: {} },
  ],
  edges: [
    { from: "a", to: "b", kind: "data", label: "masuk" },
    { from: "b", to: "c", kind: "data", label: "ya" },
    { from: "b", to: "d", kind: "data", label: "tidak" },
  ],
}
const CONNECTORS = {
  ...BASE,
  id: "9.57",
  family: "graph",
  title: "Konektor diatur sisi, titik belok, kepala dan posisi label.",
  nodes: [
    { id: "a", label: "Langkah A", class: { col: 0, row: 0 } },
    { id: "b", label: "Langkah B", class: { col: 2, row: 0 } },
    { id: "c", label: "Langkah C", class: { col: 0, row: 2 } },
    { id: "d", label: "Langkah D", class: { col: 2, row: 2 } },
  ],
  edges: [
    { from: "a", to: "b", kind: "control", label: "putar", from_side: "bottom", to_side: "bottom", via: [{ col: 6, row: 8 }] },
    { from: "a", to: "c", kind: "data", label: "awal", label_at: "start", dash: "dashed" },
    { from: "b", to: "d", kind: "data", label: "kepala", arrow_start: "diamond", arrow_end_size: "l" },
  ],
}

describe("row 56d G3-06: no jog where one end cannot move", () => {
  test("LR stadium -> decision vertex is one straight run (was a 2.38 mm Z-step)", async () => {
    const svg = await render(FLOWCHART)
    const ys = new Set(linkAt(svg, 0).pts.map((p) => p[1].toFixed(2)))
    expect([...ys]).toHaveLength(1)
    expect(lintDiagramGeometry(svg).defects).toHaveLength(0)
  })
  test("a node with two bottom exits drops straight onto the node below (AWAL, KEPALA)", async () => {
    const svg = await render(CONNECTORS)
    for (const i of [1, 2]) expect(new Set(linkAt(svg, i).pts.map((p) => p[0].toFixed(2))).size).toBe(1)
    // the straightened drop crosses no sibling (fan slots ordered by the nodes below): no hop arc drawn
    expect(/<path d="M [\d.]+ [\d.]+ A /.test(svg)).toBe(false)
    expect(lintDiagramGeometry(svg).defects).toHaveLength(0)
  })
})

describe("row 56d G3-07: connector runs stay off lane / phase / pool rules", () => {
  test("vis2_phases_v and vis2_pools_escape: no inner run within 1 mm of a parallel rule", async () => {
    const phases = await render(fx("vis2_phases_v.json").spec)
    const escape = await render(fx("vis2_label_escape.json").pools)
    expect(runsOnRules(phases)).toEqual([])
    expect(runsOnRules(escape)).toEqual([])
    expect(lintDiagramGeometry(phases).defects).toHaveLength(0)
    expect(lintDiagramGeometry(escape).defects).toHaveLength(0)
  })
})

describe("row 56d G3-09: a label band leaves no stray piece", () => {
  test("short runs: the source piece beside the band is a sliver or at least 2 mm (gallery 1/2)", async () => {
    const ht = fx("htag_all_shapes.json")
    const s = clone(ht.shadowed)
    s.per_row = 2
    s.nodes = [
      { id: "n1", label: "Langkah A", tag: "T1", shape: "shadowed", class: { col: 0, row: 0 } },
      { id: "n2", label: "Langkah B", sub: "Rincian sintetis", tag: "T2", shape: "shadowed", class: { col: 1, row: 0, accent: true } },
      { id: "n3", label: "Langkah sintetis dengan label panjang yang dibungkus menjadi dua baris", tag: "T3", shape: "shadowed", class: { col: 0, row: 1 } },
      { id: "n4", label: "Langkah D", shape: "shadowed", class: { col: 1, row: 1 } },
    ]
    s.edges = [
      { from: "n1", to: "n2", kind: "data", label: "1" },
      { from: "n3", to: "n4", kind: "data", label: "2" },
    ]
    const svg = await render(s)
    const bs = bands(svg)
    let checked = 0
    for (const l of links(svg)) {
      const [p, q] = [l.pts[0], l.pts[l.pts.length - 1]]
      const b = bs.find((r) => r[0] >= p[0] - 0.05 && r[2] <= q[0] + 0.05 && r[1] < p[1] && r[3] > p[1])
      if (!b) continue
      const piece = b[0] - p[0]
      expect(piece <= 0.25 || piece >= 2.0 - 1e-9).toBe(true)
      checked++
    }
    expect(checked).toBe(2)
  })
  test("dashed connectors: every dash cut by a band keeps at least 1 mm beside it (MINTA, PESAN)", async () => {
    const svg = await render(fx("vis2_pools_group.json").spec)
    const bs = bands(svg)
    const frags: number[] = []
    let cut = 0
    for (const l of links(svg)) {
      if (l.dash.length < 2 || !runs(l.pts).every((r) => r.vertical)) continue
      const period = l.dash[0] + l.dash[1]
      const x = l.pts[0][0]
      const y0 = l.pts[0][1]
      const y1 = l.pts[l.pts.length - 1][1]
      for (const b of bs) {
        if (!(b[0] < x && b[2] > x && b[1] > y0 && b[3] < y1)) continue
        cut++
        for (const [y, before] of [
          [b[1], true],
          [b[3], false],
        ] as const) {
          const ph = (y - y0) % period
          if (ph > 1e-6 && ph < l.dash[0] - 1e-6) frags.push(before ? ph : l.dash[0] - ph)
        }
      }
    }
    expect(cut).toBe(2)
    for (const f of frags) expect(f).toBeGreaterThanOrEqual(1.0 - 1e-6)
  })
})
