// N8-382 (Swarm 1.2.8 row 58, AC-VIS10, VIS-10, D-V7, 01f_spec_visio.md §8.4; user item 7: "complete the usage
// skill" for diagrams and business flows at the MS Visio minimum). Checks, all on HEAD files:
//  1. the two Studio resources (studio://skema/diagram, studio://skema/diagram-visio) stay < 3000 B and together
//     name every agent-written field, token and check id of N8-230..N8-271 plus POOL_FLOW_CROSSES;
//  2. the opencode built-in skill `diagram-flow` (OC/skill/diagram-flow.md, N8-062, consts N8-476) exists, is
//     registered as a reserved built-in with triggers, points to both resources, names every 01f §7 code and the
//     row 55b/56b/56c/57c guide notes (C102, C116, C119, C125, width limits C71/D55b-1), says event and gateway
//     labels sit below the shape, carries no field or enum list, and every code / snake_case name it uses is real;
//  3. every JSON example in the two resources and the skill validates (contract) and renders through the block
//     path (compose mapBlock -> renderFigure, what studio_figure_preview runs) with 0 preview defects at 128 and
//     166 mm;
//  4. one entry per (non-OUT) row of the 01f Visio-minimum tables (§1.1, §1.2, §1.3, §3.1), each with an example
//     spec that uses the row's token or field and renders with 0 defects at 128 and 166 mm;
//  5. STUDIO-AGENT-GUIDE.md §4.1.2 carries the Visio paragraph and table (sentences pinned);
//  6. the block path keeps the four spec-level fields (lane_orientation, phases, pools, jumps): before row 58
//     compose/blocks.ts diagramSpec dropped them, so a block with phases was refused P1-containers.
// The built-in load and trigger match through the real Skill service live in the opencode test N8-356
// (test/skill/rel128-builtin-skill-pack.test.ts, describe "diagram-flow").
// Red at BASE e1f9673772: no skill, no Visio resource, no 1.2.8 fields. Synthetic labels only.
import { useStudioEnv } from "../ported/_env"
useStudioEnv()
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

type J = Record<string, any>
const PKG = path.resolve(import.meta.dir, "..", "..")
const OC_SKILL = path.join(PKG, "..", "opencode", "src", "skill")
const readOptional = (...parts: string[]) => {
  try {
    return readFileSync(path.join(...parts), "utf8")
  } catch {
    return ""
  }
}
const SKILL = readOptional(OC_SKILL, "diagram-flow.md")
const INDEX = readOptional(OC_SKILL, "index.ts")
const GUIDE = readOptional(PKG, "vendor", "docs", "STUDIO-AGENT-GUIDE.md")
const flat = (s: string) => s.replace(/\s+/g, " ")
const WIDTHS = [128, 166] as const

// Modules through namespace imports, so the BASE run fails on assertions, not on a missing export.
const G = (await import("../../src/mcp-host/diagram-guide.ts")) as J
const ENUMS = (await import("../../vendor/src/lib/studio/contract/enums")) as J
const HINTS = (await import("../../vendor/src/lib/studio/contract/schema/v2/refusal-hints")) as J
const V2 = (await import("../../vendor/src/lib/studio/contract/schema/v2/common.schema")) as J
const REQ = (await import("../../src/mcp-host/local-api/routes/figure-preview-request.ts")) as J
const BODY = (await import("../../vendor/src/lib/studio/services/revisions/v2/body")) as J
const compose = (await import("../../vendor/src/lib/studio/services/compose/index.ts")) as J
const fig = (await import("../../src/mcp-host/local-api/routes/figure-preview-figure.ts")) as J
const text = (f: string) => (typeof G[f] === "function" ? (G[f]() as string) : "")
const BASIC = text("diagramGuideText")
const VISIO = text("diagramVisioGuideText")

// ── the preview a block gets (studio_figure_preview inline: contract, compose, render) ──────────────────────────
const block = (spec: J, caption = "Contoh sintetis diagram.") => ({ type: "diagram", caption: { text: caption }, source: { text: "SUMBER: contoh sintetis." }, spec })
async function preview(b: J, widthMm: number): Promise<{ ok: boolean; widthMm?: number; defects: string[]; fails: string[]; svg: string }> {
  const parsed = REQ.parsePreviewBody({ block: structuredClone(b) })
  if (!parsed.ok) return { ok: false, defects: [`SCHEMA ${JSON.stringify(parsed.issues).slice(0, 300)}`], fails: [], svg: "" }
  const params = { "diagram.widthMm": widthMm }
  try {
    const content = compose.mapBlock(structuredClone(b), "fig-vis10", { glyphs: compose.glyphSet(undefined), params, classification: "TERBATAS", artifactLabel: "Gambar 1.1" })
    const nb = { blockId: "fig-vis10", pid: "fig-vis10", address: "1.1.1", ordinal: 0, unitKey: "", type: "diagram", content, textPlain: "", contentSha256: "", artifactLabel: "Gambar 1.1" }
    const r = await fig.renderFigure(nb, { params } as never, { inline: true, withSvg: true, lang: "ID" })
    return {
      ok: true,
      widthMm: r.size?.widthMm,
      defects: (r.defects as J[]).map((d) => `${d.checkId}: ${String(d.detail ?? "").slice(0, 160)}`),
      fails: (r.issues as J[]).filter((i) => i.status === "FAIL").map((i) => i.checkId),
      svg: r.svg as string,
    }
  } catch (err) {
    return { ok: false, defects: [`THROW ${(err as Error).message.slice(0, 300)}`], fails: [], svg: "" }
  }
}
async function expectClean(b: J, name: string) {
  for (const w of WIDTHS) {
    const r = await preview(b, w)
    expect({ name, w, ok: r.ok, widthMm: r.widthMm, defects: r.defects, fails: r.fails }).toEqual({ name, w, ok: true, widthMm: w, defects: [], fails: [] })
    for (const n of b.spec.nodes as J[]) expect(r.svg.toUpperCase(), `${name} @${w}: label ${n.label}`).toContain(String(n.label).toUpperCase())
  }
}
const jsonFences = (s: string): J[] => [...s.matchAll(/```json\n([\s\S]*?)\n```/g)].map((m) => JSON.parse(m[1]) as J)

// ── 1. the two resources ─────────────────────────────────────────────────────────────────────────────────────────
/** N8-230..N8-271 as an agent writes them (internal constants N8-245/253/255/259/264 excluded) plus N8-481. */
const AGENT_NAMES = [
  "predefined", "document", "offpage", "event_start", "event_intermediate", "event_end", "event_type", "task", "subprocess",
  "gateway_exclusive", "gateway_parallel", "gateway_inclusive", "gateway_complex", "data_object", "annotation",
  "basic-flowchart", "cross-functional", "bpmn-basic", "phases", "phase", "lane_orientation", "pools", "pool", "style",
  "route", "from_side", "to_side", "from_slot", "to_slot", "via", "arrow_start", "arrow_end", "arrow_start_size",
  "arrow_end_size", "dash", "weight", "label_at", "jumps",
  "P1-edge-style", "P1-via", "P3-via-family", "P1-containers", "P1-event_type", "POOL_FLOW_CROSSES",
]

describe("AC-VIS10 the two diagram resources", () => {
  test("both stay under 3000 B (the pins are not moved)", () => {
    console.log(`[vis10] studio://skema/diagram ${Buffer.byteLength(BASIC)} B, studio://skema/diagram-visio ${Buffer.byteLength(VISIO)} B`)
    expect(BASIC.length > 0 && VISIO.length > 0).toBe(true)
    expect(Buffer.byteLength(BASIC)).toBeLessThan(3000)
    expect(Buffer.byteLength(VISIO)).toBeLessThan(3000)
  })
  test("every agent-written name of N8-230..N8-271 and POOL_FLOW_CROSSES is in one of them", () => {
    const both = `${BASIC}\n${VISIO}`
    const word = (w: string) => new RegExp(`(?<![\\w-])${w.replace(/[-]/g, "\\-")}(?![\\w-])`)
    expect(AGENT_NAMES.filter((w) => !word(w).test(both))).toEqual([])
  })
})

// ── 2. the diagram-flow skill text ───────────────────────────────────────────────────────────────────────────────
const prose = SKILL.replace(/```[\s\S]*?```/g, "")
const SECTION7_CODES = ["SCHEMA_INVALID", "DATUM-35", "DATUM-25L", "P1-edge-style", "P1-via", "P3-via-family", "P1-containers", "P1-event_type", "P3-diamond-exits", "GEOM_"]

/** Every value set an agent could be tempted to copy: the 1.2.8 enums from the schema, plus shapes and kinds. */
function enumLists(): Array<{ name: string; values: string[] }> {
  const spec = V2.commonV2Schema?.$defs?.DiagramSpecV2 as J | undefined
  if (!spec) return []
  const node = spec.properties.nodes.items as J
  const objs: J = { spec, node, class: node.properties.class, edge: spec.properties.edges.items, zone: spec.properties.zones.items }
  const out: Array<{ name: string; values: string[] }> = []
  for (const [o, keys] of Object.entries((HINTS.DIAGRAM_VISIO_FIELDS ?? {}) as Record<string, string[]>))
    for (const k of keys) {
      const values = objs[o]?.properties?.[k]?.enum as string[] | undefined
      if (values && values.length >= 3) out.push({ name: k, values })
    }
  out.push({ name: "kind", values: [...(ENUMS.DIAGRAM_EDGE_KINDS ?? [])] }, { name: "family", values: [...(ENUMS.DIAGRAM_FAMILIES ?? [])] })
  return out
}

/** Property names and enum values anywhere in the v2 contract schema. */
function schemaWords(): Set<string> {
  const out = new Set<string>()
  const walk = (v: unknown) => {
    if (Array.isArray(v)) return v.forEach(walk)
    if (!v || typeof v !== "object") return
    const o = v as J
    if (o.properties) Object.keys(o.properties).forEach((k) => out.add(k))
    if (Array.isArray(o.enum)) o.enum.forEach((e: unknown) => typeof e === "string" && out.add(e))
    Object.values(o).forEach(walk)
  }
  walk(V2.commonV2Schema)
  return out
}
const MCP_DIR = path.join(PKG, "vendor", "scripts", "studio", "mcp")
const STUDIO_TOOLS = new Set(
  ["figure-tools.ts", "doc-tools.ts", "write-tools.ts", "tools.ts"].flatMap((f) => [...readOptional(MCP_DIR, f).matchAll(/"(studio_[a-z_]+)"/g)].map((m) => m[1])),
)
const LATTICE_SRC = readOptional(PKG, "vendor", "src", "lib", "studio", "engine", "diagram", "build", "route.ts")

describe("AC-VIS10 diagram-flow skill text (OC/skill/diagram-flow.md)", () => {
  test("exists as a built-in text: heading, no frontmatter, no arguments, no file mention, nothing user-specific", () => {
    console.log(`[vis10] diagram-flow.md ${Buffer.byteLength(SKILL)} B`)
    expect(SKILL.startsWith("# ")).toBe(true)
    expect(SKILL).not.toMatch(/^---/)
    expect(/\$(?:\d|ARGUMENTS)/.test(SKILL)).toBe(false)
    expect(SKILL).not.toContain("@")
    expect(SKILL).not.toMatch(/alugra|iris|gsp-budi|\/Users\/|ses_[0-9a-f]|100\.102\.|\bGSP\b|Cikupa|Gardu|\bPLN\b/i)
  })
  test("registered in index.ts: name, description, content, triggers, reserved, loaded as <built-in>", () => {
    expect(INDEX).toContain('export const DIAGRAM_FLOW_SKILL_NAME = "diagram-flow"')
    expect(INDEX).toContain('import DIAGRAM_FLOW_SKILL_BODY from "./diagram-flow.md" with { type: "text" }')
    for (const c of ["DIAGRAM_FLOW_SKILL_DESCRIPTION", "DIAGRAM_FLOW_SKILL_CONTENT", "DIAGRAM_FLOW_SKILL_TRIGGERS"]) expect(INDEX).toContain(`export const ${c}`)
    const reserved = INDEX.slice(INDEX.indexOf("export const RESERVED_SKILL_NAMES"), INDEX.indexOf("])", INDEX.indexOf("export const RESERVED_SKILL_NAMES")))
    expect(reserved).toContain("DIAGRAM_FLOW_SKILL_NAME")
    expect(flat(INDEX)).toContain("s.skills[DIAGRAM_FLOW_SKILL_NAME] = { name: DIAGRAM_FLOW_SKILL_NAME, description: DIAGRAM_FLOW_SKILL_DESCRIPTION, location: \"<built-in>\", content: DIAGRAM_FLOW_SKILL_CONTENT, triggers: DIAGRAM_FLOW_SKILL_TRIGGERS, }")
    const desc = /DIAGRAM_FLOW_SKILL_DESCRIPTION =\s*"([^"]+)"/.exec(INDEX)?.[1] ?? ""
    expect(desc.length > 0 && desc.length <= 400).toBe(true)
    expect(desc).toContain("Load it before writing a diagram spec")
  })
  test("points to both resources and the three shape sets", () => {
    for (const w of ["studio://skema/diagram", "studio://skema/diagram-visio", "basic-flowchart", "cross-functional", "bpmn-basic"]) expect(SKILL).toContain(w)
  })
  test("names every 01f §7 code, plus DATUM-37, LABEL_LEADER, GEOM_LABEL_COLLISION, POOL_FLOW_CROSSES, BY_CONSTRUCTION_FAILED", () => {
    expect([...SECTION7_CODES, "DATUM-37", "LABEL_LEADER", "GEOM_LABEL_COLLISION", "POOL_FLOW_CROSSES", "BY_CONSTRUCTION_FAILED", "DATUM-24"].filter((c) => !SKILL.includes(c))).toEqual([])
  })
  test("says event and gateway labels sit below the shape; the row 55b/56b/56c/57c notes and width limits", () => {
    const f = flat(prose)
    expect(f).toContain("Event and gateway labels sit below the shape")
    // C102: the lattice is the first layout. C116: vertical pools for wider processes; group crosses the neighbour lane; message flow kind control.
    expect(f).toContain("The lattice is the first layout; when the preview reports AUTO_FIT, preview again and re-check.")
    expect(f).toContain('For a wider process use lane_orientation "vertical" with the pools, fewer columns, or split it into two diagrams.')
    expect(f).toContain("In a swimlane a group reaches into the neighbouring lane unless its nodes sit in the first or last lane")
    expect(f).toContain('Message flow between pools: kind "control" with arrow_start "circle" and arrow_end "open".')
    // C119: enter a decision from the top, exits on the vertices. C125: one-lattice gap with a lane rule.
    expect(f).toContain("enter a diamond or gateway from the top and leave by its vertices")
    expect(f).toContain("A one-lattice gap with a lane rule across it cannot hold a label")
    // C71 / D55b-1 width limits.
    expect(f).toContain("at 166 mm three lanes or three phases fit; at 128 mm keep to two, or the figure is refused (DATUM-37).")
    expect(f).toContain("A horizontal pool figure holds two node columns at 166 mm and one at 128 mm.")
    expect(f).toContain("The figure is done only after both.")
  })
  test("no field or enum list: no a|b|c value lists, no line naming every value of an enum, at most 6 shape tokens a line", () => {
    const lists = enumLists()
    expect(lists.length).toBeGreaterThan(5)
    expect(prose).not.toMatch(/\b[a-z_]+\|[a-z_]+\b/)
    const word = (line: string, w: string) => new RegExp(`(?<![\\w-])${w}(?![\\w-])`).test(line)
    const shapes = [...(ENUMS.DIAGRAM_SHAPES ?? [])] as string[]
    for (const line of prose.split("\n")) {
      for (const l of lists) expect(l.values.every((v) => word(line, v)) ? `${l.name} listed: ${line}` : "").toBe("")
      expect(shapes.filter((s) => word(line, s)).length, line).toBeLessThanOrEqual(6)
    }
  })
  test("every code it names exists in Studio's source; every snake_case name is a contract field or value, a Studio tool or a lattice key", () => {
    const codes = [...new Set([...SKILL.matchAll(/(?<![\w-])(?:[A-Z][A-Z0-9]*_[A-Z0-9_]*[A-Z0-9]|DATUM-\d+[A-Z]?|P\d-[a-z][a-z_+-]*[a-z])(?![\w-])/g)].map((m) => m[0]))]
    expect(codes.length).toBeGreaterThan(15)
    const roots = [path.join(PKG, "src"), path.join(PKG, "vendor", "src"), path.join(PKG, "vendor", "scripts")]
    const missing = codes.filter((c) => Bun.spawnSync(["grep", "-rqF", "--include=*.ts", c, ...roots]).exitCode !== 0)
    expect(missing).toEqual([])
    const known = schemaWords()
    for (const k of ["col_mm", "row_mm"]) {
      expect(LATTICE_SRC).toContain(k)
      known.add(k)
    }
    const snake = [...new Set([...SKILL.matchAll(/(?<![\w./-])[a-z]+(?:_[a-z0-9]+)+(?![\w/-])/g)].map((m) => m[0]))]
    expect(snake.filter((w) => !known.has(w) && !STUDIO_TOOLS.has(w))).toEqual([])
    expect(snake.filter((w) => w.startsWith("studio_")).length).toBeGreaterThan(5)
  })
})

// ── 3. every JSON example in the resources and the skill ────────────────────────────────────────────────────────
describe("AC-VIS10 JSON examples validate and render with 0 defects at 128 and 166 mm", () => {
  const examples = [...jsonFences(BASIC).map((b, i) => ({ name: `diagram resource #${i + 1}`, b })), ...jsonFences(VISIO).map((b, i) => ({ name: `visio resource #${i + 1}`, b })), ...jsonFences(SKILL).map((b, i) => ({ name: `skill #${i + 1}`, b }))]
  test("the skill carries examples for a flowchart, a cross-functional flow, a BPMN collaboration and connector styling", () => {
    const skill = jsonFences(SKILL)
    expect(skill.length).toBe(4)
    expect(skill.map((b) => b.spec?.family)).toEqual(["flow", "swimlane", "swimlane", "graph"])
    expect(skill[1].spec.phases?.length).toBe(2)
    expect(skill[2].spec.pools?.length).toBe(2)
    expect(Object.keys(Object.assign({}, ...skill[3].spec.edges)).filter((k) => (HINTS.DIAGRAM_VISIO_FIELDS?.edge ?? []).includes(k)).length).toBeGreaterThanOrEqual(7)
  })
  for (const { name, b } of examples) {
    test(`${name}: block schema valid, preview clean`, async () => {
      expect(BODY.validateBlockV2(b, "/block")).toEqual([])
      await expectClean(b, name)
    })
  }
})

// ── 4. one entry per row of the 01f Visio-minimum tables ────────────────────────────────────────────────────────
const n = (id: string, label: string, shape?: string, cls: J = {}, more: J = {}) => ({ id, label, ...(shape ? { shape } : {}), class: cls, ...more })
const e = (from: string, to: string, label: string, kind = "data", more: J = {}) => ({ from, to, kind, label, ...more })
const flowLR = (nodes: J[], edges: J[], more: J = {}) => ({ family: "flow", direction: "LR", labels_verified: true, nodes, edges, ...more })
const iso = (shape: string, label: string) => flowLR([n("a", "Mulai A", "stadium"), n("b", label, shape), n("c", "Selesai C", "stadium")], [e("a", "b", "ke"), e("b", "c", "ke")])
const bpmn = (shape: string, label: string, more: J = {}) => flowLR([n("s", "Awal A", "event_start"), n("t", label, shape, {}, more), n("z", "Akhir C", "event_end")], [e("s", "t", "ke"), e("t", "z", "ke")])
const grid = (edges: J[], more: J = {}) => ({ family: "graph", labels_verified: true, nodes: [n("a", "Langkah A", undefined, { col: 0, row: 0 }), n("b", "Langkah B", undefined, { col: 2, row: 0 }), n("c", "Langkah C", undefined, { col: 0, row: 2 }), n("d", "Langkah D", undefined, { col: 2, row: 2 })], edges, ...more })
const gate = (shape: string) => flowLR([n("s", "Awal A", "event_start"), n("g", "Cek B", shape), n("t1", "Tugas C", "task"), n("t2", "Tugas D", "task")], [e("s", "g", "ke"), e("g", "t1", "ya"), e("g", "t2", "tidak")])
const lanes = (nodes: J[], edges: J[], more: J = {}) => ({ family: "swimlane", labels_verified: true, nodes, edges, ...more })
const pools2 = { lane_orientation: "vertical", pools: [{ id: "k1", label: "Kolam X" }, { id: "k2", label: "Kolam Y" }] }

/** [01f section, Visio row (tag + name), what the spec must use: shape token, field path, or family/kind, example spec]. */
const ROWS: Array<[string, string, string, J]> = [
  // §1.1 Basic Flowchart (Manual input, delay: OUT, D-V6)
  ["1.1", "V A1 Start/End", "shape:stadium", iso("box", "Langkah B")],
  ["1.1", "V A2 Process", "shape:box", iso("box", "Langkah B")],
  ["1.1", "V A3 Decision", "shape:diamond", flowLR([n("a", "Mulai A", "stadium"), n("b", "Cek B", "diamond"), n("c", "Langkah C"), n("d", "Selesai D", "stadium")], [e("a", "b", "ke"), e("b", "c", "ya"), e("b", "d", "tidak")])],
  ["1.1", "V A4 Subprocess (predefined process)", "shape:predefined", iso("predefined", "Proses B")],
  ["1.1", "V A5 Document", "shape:document", iso("document", "Laporan B")],
  ["1.1", "V A6 Data", "shape:parallelogram", iso("parallelogram", "Masukan B")],
  ["1.1", "V A7 On-page reference", "shape:circle", iso("circle", "1")],
  ["1.1", "V A8 Off-page reference", "shape:offpage", iso("offpage", "Hal. 2")],
  ["1.1", "H A10 Preparation", "shape:hexagon", iso("hexagon", "Siapkan B")],
  ["1.1", "H A10 Database", "shape:cylinder", iso("cylinder", "Arsip B")],
  // §1.2 Cross-Functional (rotate label, resize lane, move separator: OUT)
  ["1.2", "V B1 Cross-Functional Flowchart template", "family:swimlane", lanes([n("a", "Langkah A", undefined, { lane: "Lajur 1" }), n("b", "Langkah B", undefined, { lane: "Lajur 2" })], [e("a", "b", "serah", "control")])],
  ["1.2", "V B4 Swimlane (lane)", "class.lane", lanes([n("a", "Langkah A", undefined, { lane: "Lajur 1" }), n("b", "Langkah B", undefined, { lane: "Lajur 2" }), n("c", "Langkah C", undefined, { lane: "Lajur 1" })], [e("a", "b", "serah", "control"), e("b", "c", "balik", "control")])],
  ["1.2", "V B2 Orientation horizontal / vertical", "lane_orientation", lanes([n("a", "Langkah A", undefined, { lane: "Lajur 1" }), n("b", "Langkah B", undefined, { lane: "Lajur 1" }), n("c", "Langkah C", undefined, { lane: "Lajur 2" })], [e("a", "b", "ke", "control"), e("b", "c", "serah", "control")], { lane_orientation: "vertical" })],
  ["1.2", "V B7 Separator = phase", "phases", lanes([n("a", "Langkah A", undefined, { lane: "Lajur 1", phase: "f1" }), n("b", "Langkah B", undefined, { lane: "Lajur 2", phase: "f2" })], [e("a", "b", "serah", "control")], { phases: [{ id: "f1", label: "Fase 1" }, { id: "f2", label: "Fase 2" }] })],
  // §1.3 BPMN Basic (other triggers, expanded sub-process, event-based gateway: OUT)
  ["1.3", "V C2 Start event", "shape:event_start", bpmn("task", "Tugas B")],
  ["1.3", "V C2 Intermediate event", "shape:event_intermediate", bpmn("event_intermediate", "Tunggu B")],
  ["1.3", "V C2 End event", "shape:event_end", bpmn("task", "Tugas B")],
  ["1.3", "V C3 Event trigger message / timer", "event_type", flowLR([n("s", "Surat A", "event_start", {}, { event_type: "message" }), n("w", "Tunggu B", "event_intermediate", {}, { event_type: "timer" }), n("z", "Akhir C", "event_end")], [e("s", "w", "ke"), e("w", "z", "ke")])],
  ["1.3", "V C4 Task", "shape:task", bpmn("task", "Tugas B")],
  ["1.3", "V C6 Sub-process (collapsed)", "shape:subprocess", bpmn("subprocess", "Sub B")],
  ["1.3", "V C7 Exclusive gateway", "shape:gateway_exclusive", gate("gateway_exclusive")],
  ["1.3", "V C9 Parallel gateway", "shape:gateway_parallel", gate("gateway_parallel")],
  ["1.3", "V C8 Inclusive gateway", "shape:gateway_inclusive", gate("gateway_inclusive")],
  ["1.3", "V C10 Complex gateway", "shape:gateway_complex", gate("gateway_complex")],
  ["1.3", "V C7 Gateway without marker", "shape:diamond", gate("diamond")],
  ["1.3", "V C15 Data object", "shape:data_object", flowLR([n("s", "Awal A", "event_start"), n("t", "Tugas B", "task"), n("d", "Data C", "data_object")], [e("s", "t", "ke"), e("t", "d", "tulis", "sync", { arrow_end: "none" })])],
  ["1.3", "V C15 Data store", "shape:cylinder", flowLR([n("s", "Awal A", "event_start"), n("t", "Tugas B", "task"), n("d", "Arsip C", "cylinder")], [e("s", "t", "ke"), e("t", "d", "simpan", "sync", { arrow_end: "none" })])],
  ["1.3", "V C18 Text annotation", "shape:annotation", flowLR([n("s", "Awal A", "event_start"), n("t", "Tugas B", "task"), n("c", "Catatan C", "annotation")], [e("s", "t", "ke"), e("t", "c", "cat", "sync", { arrow_end: "none" })])],
  ["1.3", "V C19 Group", "zones.style", flowLR([n("s", "Awal A", "event_start"), n("t", "Tugas B", "task"), n("z", "Akhir C", "event_end")], [e("s", "t", "ke"), e("t", "z", "ke")], { zones: [{ id: "g1", label: "Grup 1", members: ["t"], style: "group" }] })],
  ["1.3", "V C16 Pool", "pools", lanes([n("a", "Tugas A", "task", { lane: "Lajur 1", pool: "k1" }), n("b", "Tugas B", "task", { lane: "Lajur 1", pool: "k1" }), n("c", "Tugas C", "task", { pool: "k2" })], [e("a", "b", "ke"), e("b", "c", "minta", "control", { arrow_start: "circle", arrow_end: "open" })], pools2)],
  ["1.3", "V C17 Lane", "class.lane", lanes([n("s", "Awal A", "event_start", { lane: "Lajur 1" }), n("t", "Tugas B", "task", { lane: "Lajur 2" }), n("z", "Akhir C", "event_end", { lane: "Lajur 2" })], [e("s", "t", "ke"), e("t", "z", "ke")])],
  ["1.3", "V C12 Sequence flow", "kind:data", bpmn("task", "Tugas B")],
  ["1.3", "V C13 Message flow", "arrow_start", lanes([n("a", "Kirim A", "task", { pool: "k1" }), n("b", "Terima B", "task", { pool: "k2" })], [e("a", "b", "pesan", "control", { arrow_start: "circle", arrow_end: "open" })], pools2)],
  ["1.3", "V C14 Association", "arrow_end", flowLR([n("t", "Tugas A", "task"), n("c", "Catatan B", "annotation")], [e("t", "c", "cat", "sync", { arrow_end: "none" })])],
  // §3.1 connector fields
  ["3.1", "V D1, D2 route", "route", grid([e("a", "b", "lurus", "control", { route: "straight" }), e("a", "c", "siku", "control", { route: "orthogonal" }), e("b", "d", "lengkung", "control", { route: "curved" })])],
  ["3.1", "V D3-D5 from_side, to_side", "from_side", grid([e("a", "d", "satu", "control", { from_side: "right", to_side: "top" })])],
  ["3.1", "V D3 from_slot, to_slot", "from_slot", grid([e("a", "c", "satu", "control", { from_side: "bottom", from_slot: 0.3, to_side: "top", to_slot: 0.3 }), e("a", "c", "dua", "control", { from_side: "bottom", from_slot: 0.7, to_side: "top", to_slot: 0.7 })])],
  ["3.1", "SWARM D-V3 via", "via", grid([e("a", "b", "putar", "control", { from_side: "bottom", to_side: "bottom", via: [{ col: 6, row: 8 }] })])],
  ["3.1", "V D14, D16 arrow_start, arrow_end", "arrow_start", grid([e("a", "b", "satu", "control", { arrow_start: "diamond", arrow_end: "triangle" }), e("c", "d", "dua", "control", { arrow_end: "circle" })])],
  ["3.1", "V D14 arrow_start_size, arrow_end_size", "arrow_end_size", grid([e("a", "b", "besar", "data", { arrow_end_size: "l" }), e("c", "d", "kecil", "data", { arrow_start: "open", arrow_start_size: "s" })])],
  ["3.1", "V D17, D18 dash", "dash", grid([e("a", "b", "putus", "data", { dash: "dashed" }), e("c", "d", "titik", "data", { dash: "dotted" })])],
  ["3.1", "V D17, D18 weight", "weight", grid([e("a", "b", "tebal", "data", { weight: "thick" }), e("c", "d", "tipis", "data", { weight: "thin" })])],
  ["3.1", "V D19 label_at", "label_at", grid([e("a", "c", "tengah", "data", { label_at: "middle" }), e("b", "d", "akhir", "data", { label_at: "end" })])],
  ["3.1", "V D10-D12 jumps", "jumps", grid([e("a", "d", "satu", "data"), e("b", "c", "dua", "control")], { jumps: "off" })],
]

function uses(spec: J, what: string): boolean {
  const [k, v] = what.split(":")
  const nodes = spec.nodes as J[]
  const edges = (spec.edges ?? []) as J[]
  if (k === "shape") return nodes.some((x) => x.shape === v || (v === "box" && x.shape === undefined))
  if (k === "family") return spec.family === v
  if (k === "kind") return edges.some((x) => x.kind === v)
  if (k === "class.lane") return nodes.some((x) => x.class?.lane !== undefined)
  if (k === "zones.style") return (spec.zones ?? []).some((z: J) => z.style === "group")
  if (k in spec) return true
  return nodes.some((x) => k in x || k in (x.class ?? {})) || edges.some((x) => k in x)
}

describe("AC-VIS10 one entry per row of the 01f Visio-minimum tables, 0 defects at 128 and 166 mm", () => {
  test("entries cover every token of the three sets and every 1.2.8 field", () => {
    expect(ROWS.length).toBe(44)
    expect(ROWS.filter(([s]) => s === "1.1").length).toBe(10)
    expect(ROWS.filter(([s]) => s === "1.2").length).toBe(4)
    expect(ROWS.filter(([s]) => s === "1.3").length).toBe(20)
    expect(ROWS.filter(([s]) => s === "3.1").length).toBe(10)
    const all = JSON.stringify(ROWS.map((r) => r[3]))
    for (const t of ["stadium", "box", "diamond", "predefined", "document", "parallelogram", "circle", "offpage", "hexagon", "cylinder", "event_start", "event_intermediate", "event_end", "task", "subprocess", "gateway_exclusive", "gateway_parallel", "gateway_inclusive", "gateway_complex", "data_object", "annotation"])
      expect(all.includes(`"shape":"${t}"`) || t === "box").toBe(true)
    for (const f of Object.values((HINTS.DIAGRAM_VISIO_FIELDS ?? {}) as Record<string, string[]>).flat()) expect(all, f).toContain(`"${f}":`)
    expect(Object.keys(HINTS.DIAGRAM_VISIO_FIELDS ?? {}).length).toBe(5)
  })
  for (const [sec, row, what, spec] of ROWS) {
    test(`§${sec} ${row}: uses ${what}; preview clean at 128 and 166 mm`, async () => {
      expect(uses(spec, what)).toBe(true)
      await expectClean(block(spec), row)
    })
  }
})

// ── 5. STUDIO-AGENT-GUIDE.md §4.1.2 ──────────────────────────────────────────────────────────────────────────────
const S412 = (() => {
  const s = GUIDE.indexOf("#### 4.1.2 ")
  return s < 0 ? "" : GUIDE.slice(s, GUIDE.indexOf("\n### 4.2 ", s))
})()

describe("AC-VIS10 STUDIO-AGENT-GUIDE.md §4.1.2: Visio paragraph and table", () => {
  const f = flat(S412)
  test("pinned sentences", () => {
    for (const s of [
      "**Bentuk dan konektor setara Visio.** Studio mencakup tiga set bentuk Visio: Basic Flowchart (`basic-flowchart`), Cross-Functional (`cross-functional`) dan BPMN Basic (`bpmn-basic`).",
      "Katalog medan lengkap, nilai dan bawaannya ada di resource MCP `studio://skema/diagram-visio`; baca bersama `studio://skema/diagram` sebelum spec pertama.",
      "Agen Swarm memuat skill bawaan `diagram-flow` untuk resep dan perbaikan galat.",
      "Satu notasi per gambar (`DATUM-35`): bentuk ISO 5807 atau BPMN, tidak dicampur;",
      "Label event dan gateway berada di bawah bentuknya",
      "kisi dipusatkan per lebar dan berasal dari tata letak pertama, jadi setelah notice `AUTO_FIT` pratinjau ulang.",
      "Lebar: pada 166 mm tiga lajur atau tiga fase muat, pada 128 mm dua;",
      "Celah satu kisi yang dilintasi garis lajur tidak memuat label (`LABEL_LEADER`)",
      "Masuki keputusan dari atas; keluaran berangkat dari sudutnya.",
    ])
      expect(f).toContain(s)
  })
  test("the paragraph sits after step 5 and before the direction paragraph; the table names every token, field and code", () => {
    const at = f.indexOf("**Bentuk dan konektor setara Visio.**")
    expect(at).toBeGreaterThan(f.indexOf("5. **Lihat PNG-nya.**"))
    expect(at).toBeLessThan(f.indexOf("**Cabang paralel: `direction`.**"))
    const tableNames = AGENT_NAMES.filter((w) => !["basic-flowchart", "cross-functional", "bpmn-basic", "phase", "pool", "style"].includes(w))
    expect(tableNames.filter((w) => !f.includes(`\`${w}\``))).toEqual([])
    for (const w of ["`class.phase`", "`class.pool`", "`zones[].style`", "`P3-diamond-exits`", "`DATUM-25L`", "`GEOM_EDGE_CROSS`", "`DATUM-37`"]) expect(f).toContain(w)
    expect(S412.split("\n").filter((l) => l.startsWith("| ") && !l.startsWith("| Visio") && !l.startsWith("|---") && !l.startsWith("| Pratinjau") && !l.startsWith("| `GEOM_")).length).toBe(17)
  })
})

// ── 6. the block path keeps the four spec-level fields ──────────────────────────────────────────────────────────
describe("AC-VIS10 block path (compose diagramSpec) keeps lane_orientation, phases, pools and jumps", () => {
  test("mapBlock copies the four fields; absent stays absent", () => {
    const params = { "diagram.widthMm": 166 }
    const ctx = { glyphs: compose.glyphSet(undefined), params, classification: "TERBATAS", artifactLabel: "Gambar 1.1" }
    const spec = { family: "swimlane", lane_orientation: "vertical", jumps: "off", phases: [{ id: "f1", label: "Fase 1" }], pools: [{ id: "k1", label: "Kolam X" }], nodes: [n("a", "Langkah A", undefined, { lane: "Lajur 1", phase: "f1", pool: "k1" })], edges: [] }
    const out = compose.mapBlock(block(spec), "fig-vis10", ctx).spec as J
    expect([out.lane_orientation, out.jumps, out.phases, out.pools]).toEqual([spec.lane_orientation, spec.jumps, spec.phases, spec.pools])
    const plain = compose.mapBlock(block({ family: "swimlane", nodes: [n("a", "Langkah A", undefined, { lane: "Lajur 1" })] }), "fig-vis10", ctx).spec as J
    expect(["lane_orientation", "jumps", "phases", "pools"].filter((k) => k in plain)).toEqual([])
  })
})
