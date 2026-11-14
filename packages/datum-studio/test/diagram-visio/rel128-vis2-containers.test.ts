// Swarm 1.2.8 row 55 (AC-VIS2a, F-VISIO 01f §2.1-§2.3; register N8-247, N8-248, N8-249, N8-270, N8-374, N8-475;
// SR8-23). VIS-2a swimlane phases and lane orientation: phase bands with a header row (horizontal) or header column
// (vertical), hairline separators, each node inside its lane x phase cell (asserted on coordinates), P1-containers
// on the six causes of 01f §2.2 through the render path, the capacity retry in the "time" mode only, explicit
// `lane_orientation: "horizontal"` byte-identical to absent, and phase labels with <, & and " as literal text.
// Fixtures: test/fixtures/syn128/vis2_phases_h.json, vis2_phases_v.json, vis2_label_escape.json (synthetic labels).
// Row 55b adds the describe "pools" (pool bands, group zones, the pool half of vis2_label_escape.json).
// Red at BASE e1f9673772: the engine ignores `phases`/`lane_orientation` and has no P1-containers check. Namespace
// imports, so the red run fails on assertions, not on a link error.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { buildDiagramSvg } from "../../vendor/src/lib/studio/engine/diagram/build"
import * as core from "../../vendor/src/lib/studio/engine/diagram/core"
import * as fitState from "../../vendor/src/lib/studio/engine/diagram/fit/state"
import * as layoutB from "../../vendor/src/lib/studio/engine/diagram/layout-b"
import { lintDiagramGeometry } from "../../vendor/src/lib/studio/engine/diagram/fit/lint"
import { previewIssueClass } from "../../src/mcp-host/local-api/routes/figure-preview-figure"

type J = Record<string, any>
type Box = [number, number, number, number]
const fixture = (name: string) => JSON.parse(readFileSync(path.join(import.meta.dir, "..", "fixtures", "syn128", name), "utf8")) as J
const H = fixture("vis2_phases_h.json")
const V = fixture("vis2_phases_v.json")
const ESC = fixture("vis2_label_escape.json")
/** Build options as the render path passes them outside a release gate. */
const O = { release: false }
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v))
const EPS = 0.011
/** Half a vertical lattice: the last phase row ends half a lattice below its last node. */
const LATTICE_HALF = 2.4
const INK200 = (core as J).colourOf("ink200") as string

function rects(svg: string): Map<string, Box> {
  const out = new Map<string, Box>()
  for (const m of svg.matchAll(/<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)" data-node="([^"]+)"/g)) {
    out.set(m[5], [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])])
  }
  return out
}
/** Hairline decoration lines (ink200, no data-mark). */
function hairlines(svg: string): Array<[number, number, number, number]> {
  return [...svg.matchAll(/<line x1="([\d.]+)" y1="([\d.]+)" x2="([\d.]+)" y2="([\d.]+)" fill="none" stroke="([^"]+)"[^>]*\/>/g)]
    .filter((m) => m[5] === INK200 && !m[0].includes("data-mark"))
    .map((m) => [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])])
}
const unescape = (t: string) => t.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&")
function texts(svg: string): Array<{ x: number; y: number; anchor: string; text: string }> {
  return [...svg.matchAll(/<text x="([\d.]+)" y="([\d.]+)"[^>]*text-anchor="([a-z]+)"[^>]*>([^<]*)<\/text>/g)].map((m) => ({
    x: Number(m[1]),
    y: Number(m[2]),
    anchor: m[3],
    text: unescape(m[4]),
  }))
}
const uniq = (v: number[]) => [...new Set(v.map((n) => n.toFixed(2)))].map(Number).sort((a, b) => a - b)
const laneOf = (n: J) => String(n.class.lane)
const phaseOf = (n: J) => String(n.class.phase)
/** Bands from cut positions: [cuts[i], cuts[i+1]]. */
const bands = (cuts: number[]) => cuts.slice(0, -1).map((lo, i) => [lo, cuts[i + 1]] as const)
function inside(b: Box, xs: readonly [number, number], ys: readonly [number, number]): boolean {
  return b[0] >= xs[0] - EPS && b[0] + b[2] <= xs[1] + EPS && b[1] >= ys[0] - EPS && b[1] + b[3] <= ys[1] + EPS
}
function failId(spec: J): string | undefined {
  try {
    buildDiagramSvg(spec as never, O)
    return undefined
  } catch (e) {
    return (e as J).checkId
  }
}

describe("phases", () => {
  const lanes = ["Lajur 1", "Lajur 2", "Lajur 3"]
  const phases = H.spec.phases.map((p: J) => p.id) as string[]

  test("horizontal: phase header row, separators across all lanes, each node inside its lane x phase cell", () => {
    const r = buildDiagramSvg(H.spec, O)
    const svg = r.svg
    const box = rects(svg)
    expect(box.size).toBe(6)
    const lines = hairlines(svg)
    // lane rules: horizontal lines across the sheet (today's rule), one per lane
    const laneY = uniq(lines.filter((l) => l[1] === l[3] && l[0] === 0 && Math.abs(l[2] - r.widthMm) < EPS).map((l) => l[1]))
    expect(laneY.length).toBe(3)
    // phase separators: vertical lines from the header row top to the last lane, other than the lane-label gutter
    const nodeTop = Math.min(...[...box.values()].map((b) => b[1]))
    const nodeBottom = Math.max(...[...box.values()].map((b) => b[1] + b[3]))
    const seps = lines.filter((l) => l[0] === l[2] && l[1] < laneY[0] - EPS && l[3] >= nodeBottom - EPS)
    const sepX = uniq(seps.map((l) => l[0]))
    expect(sepX.length).toBe(2)
    const gutter = 32
    const phaseBands = bands([gutter, ...sepX, r.widthMm])
    const laneBands = bands([...laneY, nodeBottom + 1])
    for (const n of H.spec.nodes) {
      const b = box.get(n.id)!
      expect(inside(b, phaseBands[phases.indexOf(phaseOf(n))], laneBands[lanes.indexOf(laneOf(n))])).toBe(true)
    }
    // headers: centred in their band, in the row above the first lane, table_header role (upper case)
    const heads = texts(svg).filter((t) => /^FASE \d$/.test(t.text))
    expect(heads.map((t) => t.text)).toEqual(["FASE 1", "FASE 2", "FASE 3"])
    heads.forEach((t, i) => {
      expect(t.anchor).toBe("middle")
      expect(Math.abs(t.x - (phaseBands[i][0] + phaseBands[i][1]) / 2)).toBeLessThan(EPS)
      expect(t.y).toBeLessThan(laneY[0])
      expect(t.y).toBeLessThan(nodeTop)
    })
    // separators line up: one x per separator, the same for every lane
    expect(seps.length).toBe(2)
    // a node sits in the middle of the one-lattice gap's far side: separators never touch a node
    for (const x of sepX) for (const b of box.values()) expect(x > b[0] + b[2] + EPS || x < b[0] - EPS).toBe(true)
    expect(lintDiagramGeometry(svg).defects).toEqual([])
    expect(r.report.issues.filter((i: J) => i.status === "FAIL")).toEqual([])
  })

  test("vertical: lanes are columns with a header row on top, phases are rows with a header column on the left", () => {
    const r = buildDiagramSvg(V.spec, O)
    const svg = r.svg
    const box = rects(svg)
    expect(box.size).toBe(6)
    const lines = hairlines(svg)
    const nodeTop = Math.min(...[...box.values()].map((b) => b[1]))
    const nodeBottom = Math.max(...[...box.values()].map((b) => b[1] + b[3]))
    // lane rules: vertical lines from the header row top to below the last node
    const laneX = uniq(lines.filter((l) => l[0] === l[2] && l[1] < nodeTop && l[3] >= nodeBottom - EPS).map((l) => l[0]))
    expect(laneX.length).toBe(3)
    // header row bottom: short horizontal lines, one per lane, between the lane rules
    const headBottom = uniq(lines.filter((l) => l[1] === l[3] && l[0] >= laneX[0] - EPS && l[2] - l[0] < r.widthMm - laneX[0] + EPS && l[0] > 0).map((l) => l[1]))
    expect(headBottom.length).toBe(1)
    // phase separators: horizontal lines across the sheet
    const phaseY = uniq(lines.filter((l) => l[1] === l[3] && l[0] === 0 && Math.abs(l[2] - r.widthMm) < EPS).map((l) => l[1]))
    expect(phaseY.length).toBe(2)
    const laneBands = bands([...laneX, r.widthMm])
    const phaseBands = bands([headBottom[0], ...phaseY, nodeBottom + LATTICE_HALF])
    for (const n of V.spec.nodes) {
      const b = box.get(n.id)!
      expect(inside(b, laneBands[lanes.indexOf(laneOf(n))], phaseBands[phases.indexOf(phaseOf(n))])).toBe(true)
    }
    // lane headers centred on top of their column; phase headers start-anchored in the left column, inside their row
    const all = texts(svg)
    const laneHeads = all.filter((t) => /^LAJUR \d$/.test(t.text))
    expect(laneHeads.map((t) => t.text)).toEqual(["LAJUR 1", "LAJUR 2", "LAJUR 3"])
    laneHeads.forEach((t, i) => {
      expect(t.anchor).toBe("middle")
      expect(Math.abs(t.x - (laneBands[i][0] + laneBands[i][1]) / 2)).toBeLessThan(EPS)
      expect(t.y).toBeLessThan(headBottom[0])
    })
    const phaseHeads = all.filter((t) => /^FASE \d$/.test(t.text))
    expect(phaseHeads.map((t) => t.text)).toEqual(["FASE 1", "FASE 2", "FASE 3"])
    phaseHeads.forEach((t, i) => {
      expect(t.anchor).toBe("start")
      expect(t.x).toBeLessThan(laneX[0])
      expect(t.y > phaseBands[i][0] && t.y < phaseBands[i][1]).toBe(true)
    })
    // separators never touch a node
    for (const y of phaseY) for (const b of box.values()) expect(y > b[1] + b[3] + EPS || y < b[1] - EPS).toBe(true)
    for (const x of laneX) for (const b of box.values()) expect(x > b[0] + b[2] + EPS || x < b[0] - EPS).toBe(true)
    expect(lintDiagramGeometry(svg).defects).toEqual([])
    expect(r.report.issues.filter((i: J) => i.status === "FAIL")).toEqual([])
  })

  test("vertical without phases: lane header row, no phase separators; the same nodes in their lane columns", () => {
    const s = clone(V.spec)
    delete s.phases
    for (const n of s.nodes) delete n.class.phase
    const r = buildDiagramSvg(s, O)
    const lines = hairlines(r.svg)
    expect(lines.filter((l) => l[1] === l[3] && l[0] === 0 && Math.abs(l[2] - r.widthMm) < EPS).length).toBe(0)
    const box = rects(r.svg)
    const heads = texts(r.svg).filter((t) => /^LAJUR \d$/.test(t.text))
    expect(heads.length).toBe(3)
    for (const n of s.nodes) {
      const h = heads[lanes.indexOf(laneOf(n))]
      const b = box.get(n.id)!
      expect(b[1]).toBeGreaterThan(h.y)
      expect(h.x > b[0] - 16 && h.x < b[0] + b[2] + 16).toBe(true)
    }
    expect(texts(r.svg).some((t) => /^FASE/.test(t.text))).toBe(false)
    // no connector through or text on a lane header (the diagonal c -> d keeps the router's own arrowTangent report,
    // the narrow-gap router item of C51 / row 56c, not a frame defect)
    const frameKinds = lintDiagramGeometry(r.svg).defects.filter((d: J) => /LAJUR/.test(`${d.text} ${d.other ?? ""}`))
    expect(frameKinds).toEqual([])
  })

  test("explicit lane_orientation horizontal without phases renders byte-identical to absent (CHAR)", () => {
    const s = clone(H.spec)
    delete s.phases
    for (const n of s.nodes) delete n.class.phase
    const plain = buildDiagramSvg(s, O).svg
    expect(texts(plain).some((t) => /^FASE/.test(t.text))).toBe(false)
    const explicit = clone(s)
    explicit.lane_orientation = "horizontal"
    expect(buildDiagramSvg(explicit, O).svg).toBe(plain)
  })

  test("P1-containers on the six causes of 01f §2.2 through the render path (cause 6 is allowed)", () => {
    // 1. phases or lane_orientation with a family other than swimlane
    const flow = clone(H.spec)
    flow.family = "flow"
    for (const n of flow.nodes) delete n.class.lane
    expect(failId(flow)).toBe("P1-containers")
    const flowV = clone(flow)
    delete flowV.phases
    for (const n of flowV.nodes) delete n.class.phase
    flowV.lane_orientation = "vertical"
    expect(failId(flowV)).toBe("P1-containers")
    // 2. duplicate phase id
    const dup = clone(H.spec)
    dup.phases.push({ id: "f1", label: "Fase lagi" })
    expect(failId(dup)).toBe("P1-containers")
    // 3. class.phase naming an unknown id
    const unknown = clone(H.spec)
    unknown.nodes[2].class.phase = "f9"
    expect(failId(unknown)).toBe("P1-containers")
    // 4. phases present but a node without class.phase (all or nothing)
    const partial = clone(H.spec)
    delete partial.nodes[3].class.phase
    expect(failId(partial)).toBe("P1-containers")
    // 5. over PHASES_MAX
    const many = clone(H.spec)
    many.phases = Array.from({ length: (core as J).LIMITS.max_phases + 1 }, (_, i) => ({ id: `f${i + 1}`, label: `Fase ${i + 1}` }))
    expect(failId(many)).toBe("P1-containers")
    // 6. a pool whose nodes carry no class.lane is allowed (one unnamed lane in that pool)
    const pool = clone(H.spec)
    pool.pools = [{ id: "k1", label: "Kolam X" }]
    // row 55b (INTENT): pools are drawn now; pool strip + lane header + 3 phases need more than 166 mm (D55b-1)
    pool.phases = pool.phases.slice(0, 2)
    for (const n of pool.nodes) if (n.class.phase === "f3") n.class.phase = "f2"
    for (const n of pool.nodes) {
      delete n.class.lane
      n.class.pool = "k1"
    }
    expect(failId(pool)).toBeUndefined()
  })

  test("capacity: a phase overflow adapts in the time mode only (pack = time), nodes stay in their cells", () => {
    const s = clone(H.spec)
    s.nodes.splice(1, 0, { id: "a2", label: "Langkah A dua", class: { lane: "Lajur 1", phase: "f1" } }, { id: "a3", label: "Langkah A tiga", class: { lane: "Lajur 1", phase: "f1" } })
    const r = buildDiagramSvg(s, O)
    const notes = (r.report.geometry ?? []).filter((i: J) => i.checkId === "CAPACITY_ADAPT")
    expect(notes.length).toBe(1)
    expect(notes[0].detail).toContain("mode waktu")
    expect(notes[0].suggest).toContain("kurangi simpul per fase")
    expect(r.report.issues.filter((i: J) => i.status === "FAIL")).toEqual([])
    expect((r.report.geometry ?? []).find((i: J) => i.checkId === "AUTO_FIT")?.detail ?? "").not.toContain("pack")
    const box = rects(r.svg)
    const lines = hairlines(r.svg)
    const laneY = uniq(lines.filter((l) => l[1] === l[3] && l[0] === 0 && Math.abs(l[2] - r.widthMm) < EPS).map((l) => l[1]))
    const nodeBottom = Math.max(...[...box.values()].map((b) => b[1] + b[3]))
    const sepX = uniq(lines.filter((l) => l[0] === l[2] && l[1] < laneY[0] - EPS && l[3] >= nodeBottom - EPS).map((l) => l[0]))
    const phaseBands = bands([32, ...sepX, r.widthMm])
    const laneBands = bands([...laneY, nodeBottom + 1])
    for (const n of s.nodes) expect(inside(box.get(n.id)!, phaseBands[phases.indexOf(phaseOf(n))], laneBands[lanes.indexOf(laneOf(n))])).toBe(true)
    // the layout ignores the "pack" mode with phases: both capacity modes give the same boxes
    const run = (capMode: string) =>
      (fitState as J).withDiagramFit({ notes: [], grow: true, numbered: true, capacity: true, capMode, defects: {} }, () =>
        (layoutB as J).layoutSwimlane(s, new (core as J).Sheet(166)).nodes,
      )
    expect(run("pack")).toEqual(run("time"))
  })

  test("SR8-23: a phase label with <, & and \" renders as literal text through the lane-label text path", () => {
    const r = buildDiagramSvg(ESC.spec, O)
    const label = ESC.spec.phases[0].label as string
    expect(label).toContain("<")
    const t = texts(r.svg).filter((x) => x.text === label.toUpperCase())
    expect(t.length).toBe(1)
    expect(r.svg).not.toContain("<1>")
    expect(r.svg).toContain("&lt;1&gt; &amp;")
    // same role as the lane labels (table_header, ink400)
    const lane = r.svg.match(/<text[^>]*>LAJUR 1<\/text>/)![0]
    const phase = r.svg.match(/<text[^>]*>FASE &lt;1&gt;[^<]*<\/text>/)![0]
    const attrs = (el: string) => el.replace(/ x="[^"]*" y="[^"]*"/, "").replace(/ text-anchor="[^"]*"/, "").replace(/>[^<]*</, "><")
    expect(attrs(phase)).toBe(attrs(lane))
  })
})


// Row 55b (AC-VIS2b, 01f §2.3, C12 OP-18-5; N8-250, N8-251, N8-252, N8-481). Fixture vis2_pools_group.json:
// `spec` = 2 pools, 3 lanes, a group zone, a message flow (kind control) across the pools; `cross` = the cross-pool edge
// as kind data; `vertical` = `spec` transposed.
describe("pools", () => {
  const P = fixture("vis2_pools_group.json")
  const INK700 = (core as J).colourOf("ink700") as string
  const INK400 = (core as J).colourOf("ink400") as string
  const PRIMARY = (core as J).STROKE_PRIMARY as number
  const DASHDOT = (core as J).DASH_PATTERNS.dashdot as string
  /** Pool borders: unmarked rects in the node-outline colour at the primary stroke, without radius or dash. */
  const poolRects = (svg: string): Box[] =>
    [...svg.matchAll(/<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)" fill="none" stroke="([^"]+)" stroke-width="([\d.]+)"\/>/g)]
      .filter((m) => m[5] === INK700 && Math.abs(Number(m[6]) - PRIMARY) < 0.006)
      .map((m) => [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])])
  const contains = (o: Box, b: Box, pad = 0) => b[0] >= o[0] + pad - EPS && b[1] >= o[1] + pad - EPS && b[0] + b[2] <= o[0] + o[2] - pad + EPS && b[1] + b[3] <= o[1] + o[3] - pad + EPS
  const poolOf = (spec: J) => new Map((spec.nodes as J[]).map((n) => [n.id as string, n.class.pool as string]))
  const geometry = (r: J): J[] => r.report.geometry ?? []
  const crossing = (r: J) => geometry(r).filter((g) => g.checkId === "POOL_FLOW_CROSSES")
  /** The preview's notice/defect split (route figure-preview-figure.ts) applied to the build issues. */
  const previewDefects = (r: J) => [...r.report.issues, ...geometry(r)].filter((i: J) => i.status !== "PASS" && previewIssueClass(i.checkId, i.status) === "defect")

  test("horizontal: each pool band contains its lanes; pool header strip left of the lane headers; 0 defects", () => {
    const r = buildDiagramSvg(P.spec, O)
    const box = rects(r.svg)
    expect(box.size).toBe(6)
    const pools = poolRects(r.svg)
    expect(pools.length).toBe(2)
    const order = (P.spec.pools as J[]).map((p) => p.id as string)
    const pool = poolOf(P.spec)
    // pools stacked in pools[] order with a gap; every node inside its own pool, away from the border, outside the other
    expect(pools[0][1] + pools[0][3]).toBeLessThan(pools[1][1])
    for (const [id, b] of box) {
      const i = order.indexOf(pool.get(id)!)
      expect(contains(pools[i], b, 1.0)).toBe(true)
      expect(contains(pools[1 - i], b)).toBe(false)
    }
    // lane bands nest in the pools: lane rules between the lanes of one pool only
    const all = texts(r.svg)
    const poolHeads = all.filter((t) => /^KOLAM [XY]$/.test(t.text))
    const laneHeads = all.filter((t) => /^LAJUR \d$/.test(t.text))
    expect(poolHeads.map((t) => t.text)).toEqual(["KOLAM X", "KOLAM Y"])
    // Kolam Y has one unnamed lane (cause 6): no lane header there
    expect(laneHeads.map((t) => t.text)).toEqual(["LAJUR 1", "LAJUR 2"])
    // header strip: a primary vertical rule per pool between the pool label and the lane labels
    const strip = [...r.svg.matchAll(/<line x1="([\d.]+)" y1="([\d.]+)" x2="([\d.]+)" y2="([\d.]+)" fill="none" stroke="([^"]+)" stroke-width="([\d.]+)"\/>/g)]
      .filter((m) => m[5] === INK700 && m[1] === m[3] && Math.abs(Number(m[6]) - PRIMARY) < 0.006)
      .map((m) => Number(m[1]))
    expect(strip.length).toBe(2)
    for (const t of poolHeads) {
      expect(t.anchor).toBe("start")
      expect(t.x).toBeLessThan(strip[0])
    }
    for (const t of laneHeads) expect(t.x).toBeGreaterThan(strip[0])
    const lanesOfPool = [[0, 1], []]
    poolHeads.forEach((t, i) => {
      expect(t.y).toBeGreaterThan(pools[i][1])
      expect(t.y).toBeLessThan(pools[i][1] + pools[i][3])
      for (const j of lanesOfPool[i]) expect(laneHeads[j].y).toBeGreaterThan(pools[i][1])
    })
    // nodes start right of the lane header column
    for (const b of box.values()) expect(b[0]).toBeGreaterThan(Math.max(...laneHeads.map((t) => t.x)))
    expect(r.report.issues.some((i: J) => i.status === "FAIL")).toBe(false)
    expect(lintDiagramGeometry(r.svg).defects.length).toBe(0)
    // Swarm 1.2.8 row 57c (C116, INTENT): CEK and ISI run 4.8 mm between rows with a lane rule across the run, so no
    // spot on or beside the line keeps the 3.2 mm head visible; they take a leader (LABEL_LEADER, a preview defect).
    expect(previewDefects(r).map((i: J) => i.checkId)).toEqual(["LABEL_LEADER", "LABEL_LEADER"])
    // decoration carries no data-mark (G-2)
    expect((r.svg.match(/data-mark="node"/g) ?? []).length).toBe(6)
  })

  test("group zone: rounded rect (rx 1.6 mm) with the dashdot pattern in the zone colour around its members", () => {
    const r = buildDiagramSvg(P.spec, O)
    const m = [...r.svg.matchAll(/<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)" rx="([\d.]+)" ry="([\d.]+)" fill="none" stroke="([^"]+)" stroke-width="([\d.]+)" stroke-dasharray="([^"]+)"\/>/g)]
    expect(m.length).toBe(1)
    const g = m[0]
    expect(Number(g[5])).toBe(1.6)
    expect(Number(g[6])).toBe(1.6)
    expect(g[7]).toBe(INK400)
    expect(g[9]).toBe(DASHDOT)
    const zone: Box = [Number(g[1]), Number(g[2]), Number(g[3]), Number(g[4])]
    const box = rects(r.svg)
    for (const id of P.spec.zones[0].members as string[]) expect(contains(zone, box.get(id)!)).toBe(true)
    expect(contains(zone, box.get("a")!)).toBe(false)
    expect(texts(r.svg).some((t) => t.text === "GRUP G")).toBe(true)
    // a plain zone keeps today's dashed square rect
    const plain = clone(P.spec)
    delete plain.zones[0].style
    const z = buildDiagramSvg(plain, O).svg
    expect(z).not.toContain('rx="1.6"')
    expect(z).toContain(`stroke="${INK400}" stroke-width="${(core as J).STROKE_HAIR}" stroke-dasharray="${(core as J).DASH_PATTERNS.dashed}"/>`)
  })

  test("POOL_FLOW_CROSSES: a non-control edge across pools is a warning (notice), not a refusal; control gives none", () => {
    const r = buildDiagramSvg(P.cross, O)
    const w = crossing(r)
    expect(w.length).toBe(1)
    expect(w[0].status).toBe("REPORT")
    expect(w[0].detail).toBe("aliran urutan d -> f melintasi kolam; antarkolam pakai kind control (aliran pesan)")
    expect(typeof w[0].suggest).toBe("string")
    expect(previewIssueClass("POOL_FLOW_CROSSES", "REPORT")).toBe("notice")
    // row 57c (INTENT): the same two leaders as the collaboration figure
    expect(previewDefects(r).map((i: J) => i.checkId)).toEqual(["LABEL_LEADER", "LABEL_LEADER"])
    expect(lintDiagramGeometry(r.svg).defects.length).toBe(0)
    // the control twin (message flow) gives none
    expect(crossing(buildDiagramSvg(P.spec, O)).length).toBe(0)
    // an edge inside one pool gives none, whatever its kind; every crossing non-control edge is named once
    const two = clone(P.cross)
    two.edges.push({ from: "b", to: "e", kind: "data", label: "dua" })
    expect(crossing(buildDiagramSvg(two, O)).map((g) => g.detail.split(" melintasi")[0])).toEqual(["aliran urutan d -> f", "aliran urutan b -> e"])
    // no pools: no warning
    expect(crossing(buildDiagramSvg(H.spec, O)).length).toBe(0)
  })

  test("vertical: pool header row above the lane header row; lanes as columns inside their pool; 0 defects", () => {
    const r = buildDiagramSvg(P.vertical, O)
    const box = rects(r.svg)
    const pools = poolRects(r.svg)
    expect(pools.length).toBe(2)
    expect(pools[0][0] + pools[0][2]).toBeLessThan(pools[1][0])
    const pool = poolOf(P.vertical)
    const order = (P.vertical.pools as J[]).map((p) => p.id as string)
    for (const [id, b] of box) expect(contains(pools[order.indexOf(pool.get(id)!)], b, 1.0)).toBe(true)
    const all = texts(r.svg)
    const poolHeads = all.filter((t) => /^KOLAM [XY]$/.test(t.text))
    const laneHeads = all.filter((t) => /^LAJUR \d$/.test(t.text))
    expect(poolHeads.length).toBe(2)
    expect(laneHeads.length).toBe(2)
    for (const t of poolHeads) for (const l of laneHeads) expect(t.y).toBeLessThan(l.y)
    poolHeads.forEach((t, i) => {
      expect(t.anchor).toBe("middle")
      expect(Math.abs(t.x - (pools[i][0] + pools[i][2] / 2))).toBeLessThan(EPS)
    })
    for (const b of box.values()) expect(b[1]).toBeGreaterThan(Math.max(...laneHeads.map((t) => t.y)))
    expect(lintDiagramGeometry(r.svg).defects.length).toBe(0)
    expect(previewDefects(r).length).toBe(0)
  })

  test("cause 6: a pool without class.lane is one unnamed lane; a lane name repeated across pools is two lanes", () => {
    const s = clone(P.spec)
    expect((s.nodes as J[]).filter((n) => n.class.pool === "k2").every((n) => n.class.lane === undefined)).toBe(true)
    const r = buildDiagramSvg(s, O)
    expect(texts(r.svg).some((t) => /TANPA LAJUR/.test(t.text))).toBe(false)
    expect(texts(r.svg).filter((t) => /^LAJUR \d$/.test(t.text)).length).toBe(2)
    expect(poolRects(r.svg).length).toBe(2)
    const rep = clone(P.spec)
    for (const n of rep.nodes as J[]) if (n.class.pool === "k2") n.class.lane = "Lajur 1"
    const lay = (layoutB as J).layoutSwimlane(rep, new (core as J).Sheet(166))
    expect(lay.frame.lanes.length).toBe(3)
    expect(lay.frame.lanes.map((b: J) => b.label)).toEqual(["Lajur 1", "Lajur 2", "Lajur 1"])
    expect(lay.frame.pools.map((p: J) => p.lanes)).toEqual([[0, 1], [2]])
    const rr = buildDiagramSvg(rep, O)
    expect(texts(rr.svg).filter((t) => t.text === "LAJUR 1").length).toBe(2)
  })

  test("SR8-23: a pool label with <, & and \" renders as literal text with the lane-label attributes", () => {
    const r = buildDiagramSvg(ESC.pools, O)
    const label = ESC.pools.pools[0].label as string
    expect(label).toContain("&")
    expect(texts(r.svg).filter((x) => x.text === label.toUpperCase()).length).toBe(1)
    expect(r.svg).not.toContain("<X>")
    expect(r.svg).toContain("KOLAM &lt;X&gt; &amp;")
    const lane = r.svg.match(/<text[^>]*>LAJUR 1<\/text>/)![0]
    const pool = r.svg.match(/<text[^>]*>KOLAM &lt;X&gt;[^<]*<\/text>/)![0]
    const attrs = (el: string) => el.replace(/ x="[^"]*" y="[^"]*"/, "").replace(/ text-anchor="[^"]*"/, "").replace(/>[^<]*</, "><")
    expect(attrs(pool)).toBe(attrs(lane))
    expect(lintDiagramGeometry(r.svg).defects.length).toBe(0)
  })

  test("without pools the engine output is unchanged by row 55b (no pool rect, no warning)", () => {
    for (const s of [H.spec, V.spec, ESC.spec]) {
      const r = buildDiagramSvg(s, O)
      expect(poolRects(r.svg).length).toBe(0)
      expect(crossing(r).length).toBe(0)
    }
  })
})
