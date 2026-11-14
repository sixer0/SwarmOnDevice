// Swarm 1.2.8 row 58a (C132; AC-VIS10 follow-up, AT-NA-VIS 01f §4.2). Every 1.2.8 diagram field goes in through every
// write channel AND is drawn by the real block path, with its effect visible in the SVG (row 33b tested storage only,
// rows 52-57c the engine only). Channels: studio_chapter_submit (object, JSON string), the markdown ```diagram fence,
// studio_write {diagram}, studio_edit append, and a studio.doc/v1 document (POST /api/studio/documents, the adapter
// services/adapt-v1/blocks.ts adaptDiagramSpec, v1 -> v2). Drawing: POST /api/studio/documents/{id}/figures/preview
// with `svg: true` (what studio_figure_preview runs: stored block -> compose mapBlock/diagramSpec -> renderFigure),
// by pid for the stored block and inline for the field-removal variants, plus studio_figure_preview over MCP.
// Fixtures: 33b's test/fixtures/syn128/vis0_carry_a.json and vis0_carry_b.json, unchanged on disk. vis0_carry_a as written
// does not fit the 128 mm text column of the client templates (FIGURE_OVER_CAPACITY DATUM-37-sheet, 3 nodes in one lane
// row); `fitA` moves only `class.lane` of the nodes (a pre-1.2.8 field) so it renders, every 1.2.8 field untouched.
// Red at the pre-58a HEAD 997c290c70: the v1 document loses lane_orientation/phases/pools/jumps (stored spec differs, its
// class.phase/class.pool name unknown ids, the drawing is not the fixture drawing). Red at BASE e1f9673772: every channel
// refuses the fields. Binds 127.0.0.1 port 0 (diagram-persist/hna-host.ts): run with the command sandbox off.
import { useStudioEnv } from "../ported/_env"
useStudioEnv()
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, readFileSync } from "node:fs"
import path from "node:path"
// Namespace imports: at BASE some names do not exist, so the red run fails on assertions, not on a link error.
import * as adapt from "../../vendor/src/lib/studio/services/adapt-v1"
import * as adaptBlocks from "../../vendor/src/lib/studio/services/adapt-v1/blocks"
import * as adaptReport from "../../vendor/src/lib/studio/services/adapt-v1/report"
import * as tokens from "../../vendor/src/lib/studio/engine/diagram/core/tokens"

type J = Record<string, any>
type HnaHost = typeof import("../diagram-persist/hna-host")
const TEST_ROOT = path.resolve(import.meta.dir, "..")
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T
const SECRET = "r".repeat(64)
const MISSION = "2026-11-14_vis58a"
const T = tokens as J
const DASH = (T.DASH_PATTERNS ?? {}) as Record<string, string | null>
const WEIGHT = (T.WEIGHT_MM ?? {}) as Record<string, number>

/** The 1.2.8 contract fields (same list as N8-369 rel128-vis0 NEW_FIELDS; 01f §2.1, §3.1). */
const NEW_FIELDS = { spec: ["lane_orientation", "phases", "pools", "jumps"], node: ["event_type"], class: ["phase", "pool"], edge: ["route", "from_side", "to_side", "from_slot", "to_slot", "via", "arrow_start", "arrow_end", "arrow_start_size", "arrow_end_size", "dash", "weight", "label_at"], zone: ["style"] } as const

type Fx = { spec: J; caption: string; source: string }
const readFx = (name: string): Fx => JSON.parse(readFileSync(path.join(TEST_ROOT, "fixtures", "syn128", `${name}.json`), "utf8"))
/** vis0_carry_a with the lanes moved so it fits 128 mm: pool p1 holds Lajur 2 (a, b, c), pool p2 Lajur 1 (d, e, f). */
function fitA(fx: Fx): Fx {
  const out = clone(fx)
  const lane: Record<string, string> = { a: "Lajur 2", b: "Lajur 2", c: "Lajur 2", d: "Lajur 1", e: "Lajur 1", f: "Lajur 1" }
  for (const n of out.spec.nodes as J[]) n.class.lane = lane[n.id]
  return out
}
const FIXTURES: Array<{ name: string; fx: Fx }> = [
  { name: "a", fx: fitA(readFx("vis0_carry_a")) },
  { name: "b", fx: readFx("vis0_carry_b") },
  // Neither carry fixture has a crossing, so `jumps` has nothing to draw there: vis9's crossing (two edges crossing once)
  // as a v2 spec with jumps off (non-default: a dropped field draws the hop again). At 128 mm the vertical edge is glued
  // at 0.25 of its sides: centred, the crossing falls on a bend vertex of the horizontal edge and no hop is drawn even
  // with jumps on (engine residual, reported to row 59).
  { name: "c", fx: crossing() },
]
function crossing(): Fx {
  const all = JSON.parse(readFileSync(path.join(TEST_ROOT, "fixtures", "syn128", "vis9_labels_jumps.json"), "utf8")) as J
  const { $schema: _a, id: _b, title: _c, width_mm: _d, apparatus: _e, sources: _f, classification: _g, ...spec } = all.crossing as J
  spec.edges[1] = { ...spec.edges[1], from_side: "bottom", to_side: "top", from_slot: 0.25, to_slot: 0.25 }
  return { spec: { ...spec, jumps: "off" }, caption: "Alur sintetis konektor bersilang.", source: "Sumber sintetis uji." }
}

/** Every 1.2.8 field the spec uses, as "<at>.<field>". */
function fieldsOf(spec: J): Set<string> {
  const out = new Set<string>()
  const add = (at: keyof typeof NEW_FIELDS, o: unknown) => {
    if (o && typeof o === "object") for (const f of NEW_FIELDS[at]) if (Object.prototype.hasOwnProperty.call(o, f)) out.add(`${at}.${f}`)
  }
  add("spec", spec)
  for (const n of (spec.nodes ?? []) as J[]) {
    add("node", n)
    add("class", n.class)
  }
  for (const e of (spec.edges ?? []) as J[]) add("edge", e)
  for (const z of (spec.zones ?? []) as J[]) add("zone", z)
  return out
}
function canon(v: unknown): string {
  const walk = (x: unknown): unknown => (Array.isArray(x) ? x.map(walk) : x !== null && typeof x === "object" ? Object.fromEntries(Object.keys(x as J).sort().map((k) => [k, walk((x as J)[k])])) : x)
  return JSON.stringify(walk(v))
}
function diagrams(content: unknown): J[] {
  const out: J[] = []
  const walk = (x: unknown) => {
    if (Array.isArray(x)) x.forEach(walk)
    else if (x !== null && typeof x === "object") {
      if ((x as J).type === "diagram") out.push(x as J)
      else Object.values(x as J).forEach(walk)
    }
  }
  walk(content)
  return out
}

const v1Spec = (spec: J): J => ({ $schema: "studio.diagram/v1", id: "Gambar 1.1", title: "Uji.", classification: "TERBATAS", width_mm: 128, sources: ["Sumber sintetis uji."], ...clone(spec) })
/** What the adapter makes of v1Spec(spec): the v2 spec plus the v1 artefact's classification and sources. */
const asV2 = (spec: J): J => ({ ...clone(spec), classification: "TERBATAS", sources: ["Sumber sintetis uji."] })
const block = (fx: Fx): J => ({ type: "diagram", spec: clone(fx.spec), caption: { text: fx.caption }, source: { text: fx.source } })
/** A studio.doc/v1 client document (template datum-nota) whose one diagram block carries a studio.diagram/v1 spec. */
function v1Document(fx: Fx, title = "Nota uji diagram v1"): J {
  return {
    $schema: "studio.doc/v1",
    template: { slug: "datum-nota" },
    mission: { folder: MISSION },
    meta: { title, typeCode: "KT", tier: "NOTA", classification: "BIASA", language: "ID", author: "Alfa Bravo", issueDate: "2026-11-14", rev: "A" },
    chapters: [
      {
        key: "1",
        title: { text: "Uraian uji v1" },
        sections: [
          {
            title: { text: "Bagian" },
            blocks: [
              { type: "paragraph", text: "Paragraf sintetis dokumen versi satu." },
              { type: "diagram", spec: v1Spec(fx.spec), caption: { inline: { text: fx.caption } }, source: { inline: { text: fx.source } }, widthMm: 128 },
            ],
          },
        ],
      },
    ],
  }
}

// ── SVG readers ─────────────────────────────────────────────────────────────
const links = (svg: string): string[] => [...svg.matchAll(/<path d="[^"]+"([^>]*data-mark="link"[^>]*)\/>/g)].map((m) => m[1])
const attr = (s: string, k: string): string | undefined => new RegExp(`\\b${k}="([^"]*)"`).exec(s)?.[1]
const markerIds = (svg: string): string[] => [...svg.matchAll(/<marker id="([^"]+)"/g)].map((m) => m[1])
const hops = (svg: string): string[] => [...svg.matchAll(/<path d="M [\d.]+ [\d.]+ A [^"]+"[^>]*\/>/g)].map((m) => m[0])
const texts = (svg: string): string[] => [...svg.matchAll(/<text\b[^>]*>([^<]*)<\/text>/g)].map((m) => m[1])
/** Markup from the outline of node `id` to its label (the outline's own decorations, e.g. an event marker). */
function decoOf(svg: string, id: string): string {
  const at = svg.search(new RegExp(`data-node="${id}"`))
  expect(at, `node ${id} drawn`).toBeGreaterThan(-1)
  const rest = svg.slice(at)
  const end = rest.search(/<g data-label-pos="below">|<text /)
  return rest.slice(0, end < 0 ? undefined : end)
}

/** The visible effect of each 1.2.8 field the fixture sets (the drawing, not the stored JSON). */
function expectEffects(name: string, fx: Fx, svg: string): void {
  const s = fx.spec
  const L = links(svg)
  expect(L.length, `${name}: one link per edge`).toBe((s.edges as J[]).length)
  const tx = texts(svg)
  if (s.phases) for (const p of s.phases as J[]) expect(tx, `${name}: phase header ${p.label}`).toContain(String(p.label).toUpperCase())
  if (s.phases) expect(svg, `${name}: phase separator rule`).toMatch(/<line x1="0" y1="[\d.]+" x2="[\d.]+" y2="[\d.]+" fill="none" stroke="#C3CBD1" stroke-width="0.2"\/>/)
  if (s.pools) for (const p of s.pools as J[]) expect(tx, `${name}: pool header ${p.label}`).toContain(String(p.label).toUpperCase())
  if (s.lane_orientation === "vertical") {
    // vertical lanes: each lane header is centred over its column
    for (const lane of new Set((s.nodes as J[]).map((n) => String(n.class.lane).toUpperCase()))) expect(svg, `${name}: column header ${lane}`).toMatch(new RegExp(`text-anchor="middle"[^>]*>${lane}</text>`))
  }
  if (s.jumps === "off") expect(hops(svg), `${name}: jumps off draws no hop`).toEqual([])
  if (s.jumps === "on" && name.startsWith("c")) expect(hops(svg).length, `${name}: jumps on draws a hop at the crossing`).toBeGreaterThan(0)
  for (const n of s.nodes as J[]) {
    if (n.event_type === "message") expect(decoOf(svg, n.id), `${name}: envelope in ${n.id}`).toMatch(/<rect [^>]*stroke-width="0.2"\/><path d="M [^"]+" fill="none"/)
    // timer: inner ring + clock face circle after the outline, and the clock hands
    if (n.event_type === "timer") expect(decoOf(svg, n.id), `${name}: clock in ${n.id}`).toMatch(/(<circle [^>]*\/>){2}<path d="M [^"]+" fill="none"/)
    if (n.event_type === "none") expect(decoOf(svg, n.id), `${name}: no marker in ${n.id}`).not.toContain("<path")
  }
  for (const z of (s.zones ?? []) as J[]) {
    const g = new RegExp(`<rect [^>]*rx="1.6"[^>]*stroke-dasharray="${DASH.dashdot}"\\/>\\s*<text [^>]*>${String(z.label).toUpperCase()}</text>`)
    if (z.style === "group") expect(svg, `${name}: BPMN group ${z.id} rounded dash-dot`).toMatch(g)
    else expect(svg, `${name}: zone ${z.id} is not a group`).not.toMatch(g)
  }
  ;(s.edges as J[]).forEach((e, i) => {
    const l = L[i]
    const what = `${name} edge ${i} ${e.from}->${e.to}`
    if (e.route === "straight" || e.route === "curved") expect(attr(l, "data-route"), `${what}: route`).toBe(e.route)
    else expect(attr(l, "data-route"), `${what}: orthogonal`).toBeUndefined()
    if (e.dash) expect(attr(l, "stroke-dasharray") ?? null, `${what}: dash ${e.dash}`).toBe(DASH[e.dash] ?? null)
    if (e.weight) expect(Number(attr(l, "stroke-width")), `${what}: weight ${e.weight}`).toBe(WEIGHT[e.weight])
    const ref = (k: string) => /url\(#([^)]+)\)/.exec(attr(l, k) ?? "")?.[1]
    if (e.arrow_start && e.arrow_start !== "none") expect(ref("marker-start"), `${what}: start head`).toStartWith(`arrow-start-${e.arrow_start}-${e.arrow_start_size ?? "m"}-${e.kind}`)
    if (e.arrow_end === "none") expect(ref("marker-end"), `${what}: no end head`).toBeUndefined()
    else if (e.arrow_end && e.arrow_end !== "triangle" && e.arrow_end !== "open") expect(ref("marker-end"), `${what}: end head`).toStartWith(`arrow-end-${e.arrow_end}-${e.arrow_end_size ?? "m"}-${e.kind}`)
    else if (e.arrow_end_size && e.arrow_end_size !== "m") expect(ref("marker-end"), `${what}: end head size`).toStartWith(`arrow-end-${e.arrow_end ?? "triangle"}-${e.arrow_end_size}-${e.kind}`)
    for (const id of [ref("marker-start"), ref("marker-end")]) if (id) expect(markerIds(svg), `${what}: marker ${id} defined`).toContain(id)
  })
}

// ── value variants: each 1.2.8 value, changed to another allowed value (or removed), changes the drawing ──
type Variant = { key: string; field: string; spec: J; isDefault: boolean }
/** Values that equal absence by contract ("an explicit default draws the same bytes as the absent field"). */
const DEFAULTS: Record<string, unknown> = { route: "orthogonal", from_side: "auto", to_side: "auto", dash: "solid", weight: "normal", arrow_start_size: "m", arrow_end_size: "m", event_type: "none", style: "zone" }
/** Another allowed value for each field value (what the drawing is compared with). */
const OTHER: Record<string, Record<string, unknown>> = {
  route: { orthogonal: "straight", straight: "curved", curved: "straight" },
  from_side: { top: "bottom", bottom: "top", left: "right", right: "left", auto: "top" },
  to_side: { top: "bottom", bottom: "top", left: "right", right: "left", auto: "left" },
  arrow_start: { none: "triangle", triangle: "diamond", open: "circle", diamond: "circle", circle: "diamond" },
  arrow_end: { none: "triangle", triangle: "diamond", open: "circle", diamond: "circle", circle: "diamond" },
  arrow_start_size: { s: "l", m: "l", l: "s" },
  arrow_end_size: { s: "l", m: "l", l: "s" },
  dash: { solid: "dotted", dashed: "dotted", dotted: "dashed", longdash: "dashdot", dashdot: "longdash" },
  weight: { thin: "thick", normal: "thick", thick: "thin" },
  label_at: { start: "end", middle: "start", end: "start" },
  event_type: { none: "message", message: "timer", timer: "message" },
  style: { zone: "group", group: "zone" },
  jumps: { on: "off", off: "on" },
  lane_orientation: { vertical: "horizontal", horizontal: "vertical" },
}
function variants(spec: J): Variant[] {
  const out: Variant[] = []
  const edit = (mut: (s: J) => void): J => {
    const s = clone(spec)
    mut(s)
    return s
  }
  const push = (key: string, field: string, isDefault: boolean, mut: (s: J) => void) => out.push({ key, field, isDefault, spec: edit(mut) })
  for (const f of ["lane_orientation", "jumps"] as const) if (spec[f] !== undefined) push(`spec.${f}=${spec[f]}->${OTHER[f][spec[f]]}`, `spec.${f}`, false, (s) => (s[f] = OTHER[f][spec[f]]))
  // phases/pools are all-or-none with class.phase/class.pool (P1-containers): the bands go with the members' ids
  for (const f of ["phases", "pools"] as const)
    if (spec[f] !== undefined)
      push(`spec.${f} removed`, `spec.${f}`, false, (s) => {
        delete s[f]
        for (const n of s.nodes) delete n.class[f === "phases" ? "phase" : "pool"]
      })
  ;(spec.nodes as J[]).forEach((n, i) => {
    if (n.event_type !== undefined) push(`node[${n.id}].event_type=${n.event_type}->${OTHER.event_type[n.event_type]}`, "node.event_type", false, (s) => (s.nodes[i].event_type = OTHER.event_type[n.event_type]))
    if (n.event_type !== undefined && DEFAULTS.event_type === n.event_type) push(`node[${n.id}].event_type=${n.event_type} removed`, "node.event_type", true, (s) => delete s.nodes[i].event_type)
  })
  ;(spec.edges as J[]).forEach((e, i) => {
    for (const f of NEW_FIELDS.edge) {
      if (e[f] === undefined) continue
      if (f === "via") {
        push(`edge[${i}].via removed`, "edge.via", false, (s) => delete s.edges[i].via)
        continue
      }
      if (f === "from_slot" || f === "to_slot") {
        push(`edge[${i}].${f}=${e[f]}->${e[f] === 0.5 ? 0.25 : 0.5}`, `edge.${f}`, false, (s) => (s.edges[i][f] = e[f] === 0.5 ? 0.25 : 0.5))
        continue
      }
      // dash/weight: every edge drawn in the same line style changes together (DATUM-25L caps the styles per figure)
      const same = (x: J) => f !== "dash" && f !== "weight" ? x === e : x.kind === e.kind && x.dash === e.dash && x.weight === e.weight
      push(`edge[${i}].${f}=${e[f]}->${OTHER[f][e[f]]}`, `edge.${f}`, false, (s) => s.edges.forEach((x: J, k: number) => same((spec.edges as J[])[k]) && (x[f] = OTHER[f][e[f]])))
      // a slot needs its side (P1-edge-style): only a side without a slot can be removed
      const slot = f === "from_side" ? "from_slot" : f === "to_side" ? "to_slot" : undefined
      if (DEFAULTS[f] === e[f] && !(slot && e[slot] !== undefined)) push(`edge[${i}].${f}=${e[f]} removed`, `edge.${f}`, true, (s) => delete s.edges[i][f])
    }
  })
  ;((spec.zones ?? []) as J[]).forEach((z, i) => {
    if (z.style === undefined) return
    push(`zone[${z.id}].style=${z.style}->${OTHER.style[z.style]}`, "zone.style", false, (s) => (s.zones[i].style = OTHER.style[z.style]))
    if (DEFAULTS.style === z.style) push(`zone[${z.id}].style=${z.style} removed`, "zone.style", true, (s) => delete s.zones[i].style)
  })
  return out
}

// ── adapter (v1 -> v2), no host ─────────────────────────────────────────────
describe("adapter v1 -> v2: adaptDiagramSpec keeps every 1.2.8 field", () => {
  const A = adaptBlocks as J
  const rec = () => new (adaptReport as J).AdaptRecorder("strip")
  test("guard: the three subjects together use every 1.2.8 field", () => {
    const used = new Set(FIXTURES.flatMap(({ fx }) => [...fieldsOf(fx.spec)]))
    const all = Object.entries(NEW_FIELDS).flatMap(([at, fs]) => fs.map((f) => `${at}.${f}`))
    expect(all.filter((f) => !used.has(f))).toEqual([])
  })
  for (const { name, fx } of FIXTURES) {
    test(`${name}: v1 spec -> DiagramSpecV2 equals the v2 spec (every field), none of them counted as stripped`, () => {
      const r = rec()
      const out = A.adaptDiagramSpec(v1Spec(fx.spec), "/s", r)
      expect(canon(out)).toBe(canon(asV2(fx.spec)))
      expect([...fieldsOf(out)].sort()).toEqual([...fieldsOf(fx.spec)].sort())
      const stripped = r.finish().stripped as Record<string, number>
      for (const f of NEW_FIELDS.spec) expect(stripped[f], `stripped ${f}`).toBeUndefined()
      // what the v1 artefact has and v2 does not (id, title, width_mm) is still accounted for
      expect(Object.keys(stripped).sort()).toEqual(["id", "title", "width_mm"])
    })
    test(`${name}: adaptV1 of a studio.doc/v1 document keeps the fields (report strips none of them)`, () => {
      const r = (adapt as J).adaptV1({ document: v1Document(fx) }, "strip", false)
      const ds = diagrams(r.doc.sections ?? r.doc)
      expect(ds).toHaveLength(1)
      expect(canon(ds[0].spec)).toBe(canon(asV2(fx.spec)))
      for (const f of NEW_FIELDS.spec) expect((r.report.stripped as J)[f], `report stripped ${f}`).toBeUndefined()
    })
  }
  test("a spec without the 1.2.8 fields adapts byte-identical (same keys in the same order as before row 58a)", () => {
    const legacy = { family: "flow", labels_verified: true, direction: "TB", nodes: [{ id: "a", label: "A", class: { col: 0, row: 0 } }, { id: "b", label: "B", class: { col: 0, row: 1 } }], edges: [{ from: "a", to: "b", kind: "data", label: "" }], notes: ["n"] }
    const out = A.adaptDiagramSpec(v1Spec(legacy), "/s", rec())
    expect(JSON.stringify(out)).toBe(JSON.stringify({ family: "flow", nodes: legacy.nodes, classification: "TERBATAS", labels_verified: true, sources: ["Sumber sintetis uji."], edges: legacy.edges, notes: ["n"], direction: "TB" }))
    for (const f of NEW_FIELDS.spec) expect(Object.prototype.hasOwnProperty.call(out, f), f).toBe(false)
  })
  test("node, edge and zone fields (node tag too) ride with nodes/edges/zones unchanged", () => {
    const spec = clone(FIXTURES[0].fx.spec)
    spec.nodes[1].tag = "T-1"
    const out = A.adaptDiagramSpec(v1Spec(spec), "/s", rec())
    expect(out.nodes[1].tag).toBe("T-1")
    expect(canon(out.nodes)).toBe(canon(spec.nodes))
    expect(canon(out.edges)).toBe(canon(spec.edges))
    expect(canon(out.zones)).toBe(canon(spec.zones))
  })
})

// ── end to end: every channel, drawn by the real block path ─────────────────
describe("e2e: every 1.2.8 field through every channel, rendered with its effect visible", () => {
  let hh: HnaHost
  let h: Awaited<ReturnType<HnaHost["startHost"]>>
  let api: { fetch: (url: string, init?: Record<string, unknown>) => Promise<{ status: number; text(): Promise<string> }> }
  beforeAll(async () => {
    hh = await import("../diagram-persist/hna-host")
    h = await hh.startHost("e2e58a")
    // the figure route logs into the store's api log directory
    if (process.env.STUDIO_WORKSPACE_ROOT) mkdirSync(path.join(process.env.STUDIO_WORKSPACE_ROOT, "logs", "api"), { recursive: true })
    const { createLocalStudioApi } = await import("../../src/mcp-host/local-api/router.ts")
    const { LOCAL_ROUTES } = await import("../../src/mcp-host/local-api/routes.ts")
    api = createLocalStudioApi({ baseUrl: "http://127.0.0.1:1", secret: SECRET, agentId: "swarm", routes: LOCAL_ROUTES }) as never
  }, 120_000)
  afterAll(async () => {
    await h?.close()
  })

  async function local(method: string, route: string, body?: unknown): Promise<{ status: number; body: J }> {
    const r = await api.fetch(`http://127.0.0.1:1${route}`, {
      method,
      headers: { "x-internal-secret": SECRET, accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      redirect: "manual",
    })
    const text = await r.text()
    return { status: r.status, body: text ? (JSON.parse(text) as J) : {} }
  }
  /** The figure preview route, svg on: the stored (pid) or inline block drawn by compose + renderFigure. */
  async function draw(documentId: string, target: { pid: string } | { block: J }): Promise<{ svg: string; issues: J[]; error?: J }> {
    const r = await local("POST", `/api/studio/documents/${documentId}/figures/preview`, { ...target, svg: true })
    expect(r.status, JSON.stringify(r.body).slice(0, 400)).toBe(200)
    if (r.body.rendered !== true) return { svg: "", issues: [], error: r.body.error ?? r.body }
    return { svg: String(r.body.figure.svg), issues: (r.body.figure.issues ?? []) as J[] }
  }
  const ok = (r: J, what: string) => expect(r.ok, `${what}: ${String(r._text).slice(0, 600)}`).not.toBe(false)
  const noFail = (issues: J[], what: string) => expect(issues.filter((i) => i.status === "FAIL").map((i) => `${i.checkId}: ${i.detail}`), what).toEqual([])

  for (const { name, fx } of FIXTURES) {
    let ref = ""

    test(`${name}: reference drawing of the fixture block shows every field's effect; removing any non-default value changes it`, async () => {
      const refDoc = await hh.newClientDoc(h, `vis58a-${name}-ref`)
      const d = await draw(refDoc, { block: block(fx) })
      expect(d.error, `${name}: reference renders`).toBeUndefined()
      noFail(d.issues, `${name}: reference`)
      ref = d.svg
      expectEffects(name, fx, ref)
      const vs = variants(fx.spec)
      // every 1.2.8 field the fixture uses has a removal variant (class.phase/pool go with spec.phases/pools)
      const covered = new Set(vs.map((v) => v.field))
      expect([...fieldsOf(fx.spec)].filter((f) => !f.startsWith("class.") && !covered.has(f))).toEqual([])
      const wrong: string[] = []
      const seen: string[] = []
      for (const v of vs) {
        const r = await draw(refDoc, { block: { ...block(fx), spec: v.spec } })
        // vis0_carry_a with horizontal lanes does not fit 128 mm: the refusal itself shows the field is read
        if (r.error && v.field === "spec.lane_orientation" && r.error.code === "FIGURE_OVER_CAPACITY") {
          seen.push(`${v.key}: refused FIGURE_OVER_CAPACITY`)
          continue
        }
        if (r.error) wrong.push(`${v.key}: variant refused ${r.error.code} ${String(r.error.message).slice(0, 160)}`)
        else if (v.isDefault && r.svg !== ref) wrong.push(`${v.key}: explicit default draws differently from absence`)
        // no crossing in the drawing: jumps has nothing to draw (fixture c checks it on a crossing)
        else if (!v.isDefault && r.svg === ref && !(v.field === "spec.jumps" && hops(ref).length === 0 && hops(r.svg).length === 0 && name !== "c")) wrong.push(`${v.key}: the other value draws the same`)
        else seen.push(`${v.key}: ${v.isDefault ? "same as absent" : "drawing changes"}`)
      }
      expect(wrong).toEqual([])
      if (name === "c") expect(seen, "c: jumps off -> on draws the hop").toContain("spec.jumps=off->on: drawing changes")
    }, 180_000)

    /** Every stored diagram of the document is the fixture spec and draws byte-identical to the reference. */
    async function expectDrawn(documentId: string, n: number, channel: string): Promise<void> {
      expect(ref, "reference drawn first").not.toBe("")
      const ds = hh.diagramsOf(await h.content(documentId))
      expect(ds.length, channel).toBe(n)
      for (const d of ds) {
        expect(canon(d.spec), `${channel}: stored spec`).toBe(canon(fx.spec))
        const r = await draw(documentId, { pid: String(d.id) })
        expect(r.error, `${channel}: stored block renders`).toBeUndefined()
        noFail(r.issues, channel)
        expectEffects(`${name} ${channel}`, fx, r.svg)
        expect(r.svg === ref, `${channel}: stored block draws the reference drawing`).toBe(true)
      }
    }

    test(`${name}: studio_chapter_submit (object, then JSON string) -> drawn`, async () => {
      const doc = await hh.newClientDoc(h, `vis58a-${name}-submit`)
      const submission = () => ({
        $schema: "studio.chapter/v2",
        target: { documentId: doc },
        chapter: { key: "1", title: { text: "Uraian uji gambar" }, sections: [{ title: { text: "Bagian uji" }, blocks: [{ type: "paragraph", text: "Paragraf sintetis alfa bravo." }, block(fx)] }] },
      })
      ok(await h.call("studio_chapter_submit", { submission: submission() }), "submit object")
      await expectDrawn(doc, 1, "submit object")
      ok(await h.call("studio_chapter_submit", { submission: JSON.stringify(submission()) }), "submit string")
      await expectDrawn(doc, 1, "submit string")
    }, 180_000)

    test(`${name}: markdown diagram fence (studio_chapter_import_markdown submit=true) -> drawn`, async () => {
      const doc = await hh.newClientDoc(h, `vis58a-${name}-import`)
      const markdown = ["# Bab uji impor gambar", "", "Paragraf sintetis charlie delta.", "", "```diagram", JSON.stringify(fx.spec, null, 2), "```", "", `Gambar: ${fx.caption}`, "", `Sumber: ${fx.source}`, ""].join("\n")
      const r = await h.call("studio_chapter_import_markdown", { markdown, chapterKey: "2", documentId: doc, submit: true, change: hh.CHANGE })
      ok(r, "import")
      expect(r.importSummary?.keptAsCode, "import keptAsCode").toBe(0)
      await expectDrawn(doc, 1, "import fence")
    }, 180_000)

    test(`${name}: studio_write {diagram}, then studio_edit append [{diagram}] -> drawn; studio_figure_preview over MCP has no FAIL`, async () => {
      const sections = [
        { heading: "Pendahuluan", blocks: ["Paragraf pembuka sintetis alfa bravo charlie."] },
        { heading: "Uraian uji gambar", blocks: ["Paragraf sintetis sebelum diagram.", { diagram: { spec: clone(fx.spec), caption: fx.caption, source: fx.source } }] },
      ]
      const w = await h.call("studio_write", { mission: MISSION, docKey: `vis58a-${name}-write`, template: "datum-nota", meta: hh.META, sections })
      ok(w, "write")
      const doc = String(w.documentId)
      await expectDrawn(doc, 1, "write")
      const e = await h.call("studio_edit", { documentId: doc, edits: [{ section: "Pendahuluan", append: [{ diagram: { spec: clone(fx.spec), caption: fx.caption, source: fx.source } }] }], change: hh.CHANGE })
      ok(e, "edit append")
      await expectDrawn(doc, 2, "edit append")
      for (const d of hh.diagramsOf(await h.content(doc))) {
        const p = await h.call("studio_figure_preview", { documentId: doc, pid: String(d.id) })
        ok(p, "studio_figure_preview")
        expect(p._isError, "studio_figure_preview").toBe(false)
        noFail((p.figure?.issues ?? []) as J[], "studio_figure_preview")
      }
    }, 180_000)

    test(`${name}: a studio.doc/v1 document (adapter v1 -> v2) keeps every field and is drawn`, async () => {
      const r = await local("POST", "/api/studio/documents", { document: v1Document(fx, `Nota uji diagram v1 ${name}`) })
      expect([200, 201], JSON.stringify(r.body).slice(0, 600)).toContain(r.status)
      const documentId = String(r.body.document?.id ?? r.body.documentId ?? "")
      expect(documentId).not.toBe("")
      const ds = hh.diagramsOf(await h.content(documentId))
      expect(ds).toHaveLength(1)
      expect([...fieldsOf(ds[0].spec)].sort(), "v1: 1.2.8 fields kept").toEqual([...fieldsOf(fx.spec)].sort())
      expect(canon(ds[0].spec), "v1: stored spec").toBe(canon(asV2(fx.spec)))
      const d = await draw(documentId, { pid: String(ds[0].id) })
      expect(d.error, "v1: stored block renders").toBeUndefined()
      noFail(d.issues, "v1 document")
      expectEffects(`${name} v1 document`, fx, d.svg)
      // same drawing as the v2 block of the same spec (classification and sources included) in that document
      const same = await draw(documentId, { block: { ...block(fx), spec: asV2(fx.spec) } })
      expect(same.error).toBeUndefined()
      expect(d.svg === same.svg, "v1: stored block draws as the v2 block").toBe(true)
    }, 180_000)
  }
})
