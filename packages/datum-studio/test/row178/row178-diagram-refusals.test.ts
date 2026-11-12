// Row 178 (gateway_check/16_row177_split_builders_ab.md): agents in the row 146b/177 runs were refused 9-26 diagram
// calls per run. The refusals named only the field sent, never the fields allowed there, so agents guessed node
// `class` fields (40+ different names) and edge styles. Every block below is a refused input from those runs (stores
// read-only under /private/tmp/claude-501/row177/*/ev/final/drive_out.json and row146b/ev/final/calls_reader.jsonl).
// BEFORE = the server message the run got (verbatim); AFTER = what Studio says now. The schema is not loosened:
// every block is still refused. Plus the diagram guide (studio://skema/diagram): enums equal the schema, example
// validates and renders, resource listed and readable on the host.
import { useStudioEnv } from "../ported/_env"
useStudioEnv()
import { describe, expect, test } from "bun:test"
import path from "node:path"
import { parsePreviewBody } from "../../src/mcp-host/local-api/routes/figure-preview-request.ts"
import { validateBlockV2, validateChapterV2 } from "../../vendor/src/lib/studio/services/revisions/v2/body"
import { DIAGRAM_EDGE_KINDS, DIAGRAM_FAMILIES, DIAGRAM_SHAPES, PROVENANCE_MARKS } from "../../vendor/src/lib/studio/contract/enums"
import { DIAGRAM_ALIASES } from "../../vendor/src/lib/studio/contract/schema/v2/refusal-hints"
import { commonV2Schema } from "../../vendor/src/lib/studio/contract/schema/v2/common.schema"
import { DIAGRAM_GUIDE_EXAMPLE, DIAGRAM_GUIDE_URI, diagramGuideFacts, diagramGuideText } from "../../src/mcp-host/diagram-guide.ts"

const GUIDE = "guide: studio://skema/diagram"
type Issue = { pointer: string; keyword: string; message: string }
const cap = { text: "Uji." }
const src = { text: "SUMBER: uji." }
const node = (over: Record<string, unknown> = {}) => ({ id: "a", label: "A", class: {}, ...over })
const diag = (spec: Record<string, unknown>, over: Record<string, unknown> = {}) => ({ type: "diagram", caption: cap, source: src, spec: { family: "layered", nodes: [node()], ...spec }, ...over })
function issuesOf(block: unknown): Issue[] {
  const r = parsePreviewBody({ block })
  expect(r.ok).toBe(false) // never loosened: the run's input is still refused
  return r.ok ? [] : (r.issues as Issue[])
}
const at = (issues: Issue[], pointer: string, word = "") => issues.find((i) => i.pointer === pointer && i.message.includes(word))?.message ?? `(no issue at ${pointer}: ${JSON.stringify(issues)})`

// [class, runs, refused calls with this class in the runs (one call can carry several classes; B and J are shared rows), block, pointer, BEFORE (run message), AFTER must contain]
const CASES: Array<[string, string, number, unknown, string, string, string[]]> = [
  ["node placement field on the node (col/row/tier/lane/x/y/rank/layer)", "a1,a3,b1,b3", 7, diag({ nodes: [node({ col: 1 })] }), "/block/spec/nodes/0",
    'must NOT have additional properties: "col"', ["allowed here: id, label, sub, shape, mark, tag, u, external, symbol, class", "class.col", GUIDE]],
  ["node field put inside class (shape/mark/tag/sub/symbol/label)", "a2,a3,b1,b3", 16, diag({ nodes: [node({ class: { shape: "box" } })] }), "/block/spec/nodes/0/class",
    'must NOT have additional properties: "shape"', ["allowed here: tier, lane, col, row, accent, secondary, external", '"shape" belongs one level up (node)', GUIDE]],
  ["guessed class field (type/kind/code/notation/role/group/...)", "a2,a3,b1,b3", 16, diag({ nodes: [node({ class: { notation: "iec" } })] }), "/block/spec/nodes/0/class",
    'must NOT have additional properties: "notation"', ["allowed here: tier, lane, col, row, accent, secondary, external", GUIDE]],
  ["edge style alias (color/width/dash/pattern/type)", "b1,b3", 3, diag({ edges: [{ from: "a", to: "a", kind: "data", label: "", color: "red" }] }), "/block/spec/edges/0/color",
    'must NOT have additional properties: "width"', ["allowed here: from, to, kind, label", 'for "color" use "kind" (accent, alert, control, data, sync, verify)', GUIDE]],
  // Swarm 1.2.6 row 48 (T-11, N-110, intended change listed in 01g): `direction` is a spec field now (row 45), so the
  // allowed list ends with it and the alias `orientation` names `direction` (TB, LR) instead of `family`.
  ["spec field that is not a diagram field (title/orientation/direction/lang/id)", "a1,a3,b1,b3", 12, diag({ orientation: "LR" }), "/block/spec",
    'must NOT have additional properties: "orientation"', ["allowed here: family, classification, labels_verified, sources, nodes, edges, zones, legend, notes, per_row, direction", 'for "orientation" use "direction" (TB, LR)', GUIDE]],
  ["spec fields sent on the block (family/nodes/edges/labels_verified/classification)", "a1,a2,b1,b3", 6, { type: "diagram", caption: cap, source: src, family: "layered", spec: { family: "layered", nodes: [node()] } }, "/block",
    'must NOT have additional properties: "family"', ["allowed here: type, id, spec, artifactId, caption, source, keyRow", "spec.family", GUIDE]],
  ["display field in a diagram (width_mm/apparatus/layout/style)", "a1,a3,b1,b3", 12, diag({ width_mm: 128 }), "/block/spec/width_mm",
    "medan tampilan tidak diterima; tampilan diatur templat", ["allowed here: family, classification", GUIDE]], // second issue, same pointer
  ["class sent as a string", "a1,a2,a3,b1,b3", 12, diag({ nodes: [node({ class: "box" })] }), "/block/spec/nodes/0/class",
    "must be object", ["must be object {tier, lane, col, row, accent, secondary, external}", GUIDE]],
  ["diagram block without spec or artifactId", "a1,a2,b1,b3", 34, { type: "diagram", caption: cap, source: src }, "/block",
    "must match exactly one schema in oneOf", ['"spec" | "artifactId"', "tidak ada yang diberikan", GUIDE]],
  ["required field missing (class/kind/label/nodes)", "a1,a2,a3,b1,b3", 20, diag({ nodes: [{ id: "a", label: "A" }] }), "/block/spec/nodes/0",
    "must have required property 'class'", ["'class'", GUIDE]],
  ["enum (family/edge kind/mark/shape)", "a1,b1,b3", 10, diag({ nodes: [node({ mark: "PRIMER" })] }), "/block/spec/nodes/0/mark",
    'must be equal to one of the allowed values: "TERUKUR", "DITURUNKAN", "PEMASOK", "ASUMSI"', ['"TERUKUR", "DITURUNKAN", "PEMASOK", "ASUMSI"', GUIDE]],
  ["sources/legend/notes item not a string", "a1,a2,a3,b1,b3", 12, diag({ sources: [{ text: "x" }] }), "/block/spec/sources/0",
    "must be string", ["must be string", GUIDE]],
]

describe("row 178: each refusal class from the runs now names the fix", () => {
  for (const [name, runs, n, block, pointer, before, after] of CASES) {
    test(`${name} (runs ${runs}, ${n} refusals)`, () => {
      const word = name.startsWith("diagram block without") ? "tidak ada" : pointer.endsWith("/width_mm") || pointer.endsWith("/color") ? "allowed here" : ""
      const msg = at(issuesOf(block), pointer, word)
      console.log(`[row178] ${name}\n  before: ${before}\n  after:  ${msg}`)
      // before: the run's message carried no allowed names and no guide
      expect(before).not.toContain("allowed here")
      expect(before).not.toContain(GUIDE)
      for (const w of after) expect(msg).toContain(w)
    })
  }

  test("spec|artifactId: the required halves of that oneOf are not repeated next to the named message", () => {
    const issues = issuesOf({ type: "diagram", caption: cap, source: src })
    expect(issues.filter((i) => i.keyword === "required" && /spec|artifactId/.test(i.message))).toEqual([])
  })

  test("chapter: an unknown block type lists the block types; a diagram inside a chapter gets the same hints", () => {
    const issues = validateChapterV2({ key: "1", title: { text: "x" }, sections: [{ title: { text: "x" }, blocks: [{ type: "figure" }, diag({ nodes: [node({ row: 1 })] })] }] }) as Issue[]
    expect(at(issues, "/chapter/sections/0/blocks/0")).toContain("type: paragraph, list, aside")
    expect(at(issues, "/chapter/sections/0/blocks/0")).toContain("diagram")
    expect(at(issues, "/chapter/sections/0/blocks/1/spec/nodes/0")).toContain("class.row")
  })

  test("non-diagram refusals get no diagram guide", () => {
    const issues = validateChapterV2({ key: "1", title: { text: "x" }, sections: [], blocks: [] }) as Issue[]
    expect(issues.length).toBeGreaterThan(0)
    for (const i of issues) expect(i.message).not.toContain(GUIDE)
    expect(at(issues, "/chapter", "blocks")).toContain("allowed here: key, id, title")
  })

  test("alias targets exist in the schema (the hint never names a field that is not there)", () => {
    const spec = (commonV2Schema as any).$defs.DiagramSpecV2
    const props: Record<string, string[]> = { edge: Object.keys(spec.properties.edges.items.properties), node: Object.keys(spec.properties.nodes.items.properties), spec: Object.keys(spec.properties) }
    for (const [obj, map] of Object.entries(DIAGRAM_ALIASES)) {
      for (const [alias, target] of Object.entries(map)) {
        expect(props[obj]).not.toContain(alias) // an alias is never an accepted field
        if (target !== "caption") expect(props[obj]).toContain(target)
      }
    }
  })
})

// Swarm 1.2.6 row 48 (T-11, 01e §3.2 + §6.1/6.3/6.4, A16/A17, register N-110/N-159). Red at e363918a69: the aliases
// named `family`, `arah` had no alias, `direction` was itself an alias and no `P1-direction` refusal existed.
const DIRECTION_ALIAS_CLAUSE = "direction berlaku untuk family flow; nilai rankdir TB/LR sama, RL/BT tidak didukung"
describe("row 48 T-11: rankdir/arah and the other direction aliases name `direction`; P1-direction refusals", () => {
  for (const alias of ["dir", "rankdir", "rankDir", "orientation", "arah"]) {
    test(`alias "${alias}" on a flow spec: still refused (additionalProperties), hint names direction (TB, LR) and the flow-only clause`, () => {
      const issues = issuesOf(diag({ family: "flow", [alias]: "LR" }))
      const i = issues.find((x) => x.pointer === "/block/spec" && x.keyword === "additionalProperties")
      expect(i).toBeDefined()
      expect(i!.message).toContain(`must NOT have additional properties: "${alias}"`)
      expect(i!.message).toContain(`for "${alias}" use "direction" (TB, LR)`)
      expect(i!.message).toContain(DIRECTION_ALIAS_CLAUSE)
      expect(i!.message).toContain(GUIDE)
      expect(i!.message).not.toContain(`use "family"`)
    })
  }

  test("alias map: direction aliases target direction, `direction` itself is no alias, `layout` stays family", () => {
    expect(DIAGRAM_ALIASES.spec).toEqual({ title: "caption", name: "caption", dir: "direction", rankdir: "direction", rankDir: "direction", orientation: "direction", arah: "direction", layout: "family" })
  })

  test("`layout` still points to family, without the direction clause", () => {
    const msg = at(issuesOf(diag({ layout: "LR" })), "/block/spec/layout", "allowed here") // layout is a display field: second issue
    expect(msg).toContain('for "layout" use "family" (layered,')
    expect(msg).not.toContain(DIRECTION_ALIAS_CLAUSE)
  })

  const v2block = (spec: Record<string, unknown>) => ({ type: "diagram", caption: cap, source: src, spec: { nodes: [node()], ...spec } })
  // [family, direction-hint text that must appear]
  const FAMILY_HINTS: Array<[string, string[]]> = [
    ["layered", ["arah tingkat (class.tier) tetap atas-bawah", 'family flow + direction "LR"', "graph + class.col/row"]],
    ["topology", ["arah tingkat (class.tier) tetap atas-bawah", 'family flow + direction "LR"']],
    ["stack", ["arah tingkat (class.tier) tetap atas-bawah", 'family flow + direction "LR"']],
    ["graph", ["kolom diatur class.col/row; hapus direction"]],
    ["sequence", ["hapus direction"]],
  ]
  for (const [family, words] of FAMILY_HINTS) {
    test(`P1-direction: family ${family} + direction -> refused at .../spec/direction with the ${family} hint`, async () => {
      const byc = await import("../../vendor/src/lib/studio/services/ingest/by-construction")
      expect(typeof (byc as any).diagramDirectionIssues).toBe("function")
      const issues = (byc as any).diagramDirectionIssues({ blocks: [v2block({ family, direction: "TB" })] }, "") as Array<Issue & { checkId?: string }>
      expect(issues.map((i) => [i.pointer, i.checkId])).toEqual([["/blocks/0/spec/direction", "P1-direction"]])
      expect(issues[0].message).toContain(`direction hanya untuk family flow (family '${family}')`)
      for (const w of words) expect(issues[0].message).toContain(w)
      const e = (byc as any).byConstructionError(issues)
      expect([e.code, e.httpStatus]).toEqual(["BY_CONSTRUCTION_FAILED", 422])
    })
  }

  test("P1-direction: flow + per_row + direction -> refused at .../spec/per_row; flow + direction alone and legacy flow pass", async () => {
    const byc = await import("../../vendor/src/lib/studio/services/ingest/by-construction")
    expect(typeof (byc as any).diagramDirectionIssues).toBe("function")
    const issues = (byc as any).diagramDirectionIssues(
      { blocks: [v2block({ family: "flow", direction: "LR", per_row: 2 }), v2block({ family: "flow", direction: "TB" }), v2block({ family: "flow", per_row: 2 })] },
      "",
    ) as Array<Issue & { checkId?: string }>
    expect(issues.map((i) => [i.pointer, i.checkId])).toEqual([["/blocks/0/spec/per_row", "P1-direction"]])
    expect(issues[0].message).toContain("per_row membungkus urutan daftar, direction menata menurut konektor; pakai salah satu")
  })
})

describe("row 178: diagram guide (studio://skema/diagram)", () => {
  test("enums and field lists equal the schema and enums.ts", () => {
    const f = diagramGuideFacts()
    expect(f.families).toEqual([...DIAGRAM_FAMILIES])
    expect(f.shapes).toEqual([...DIAGRAM_SHAPES])
    expect(f.marks).toEqual([...PROVENANCE_MARKS])
    expect(f.edgeKinds).toEqual([...DIAGRAM_EDGE_KINDS])
    const d = (commonV2Schema as any).$defs
    expect(f.classFields).toEqual(Object.keys(d.DiagramSpecV2.properties.nodes.items.properties.class.properties))
    expect(f.specRequired).toEqual(d.DiagramSpecV2.required)
    expect(f.nodeRequired).toEqual(["id", "label", "class"])
    expect(f.edgeRequired).toEqual(["from", "to", "kind", "label"])
    const t = diagramGuideText()
    for (const w of [...DIAGRAM_FAMILIES, ...DIAGRAM_EDGE_KINDS, ...PROVENANCE_MARKS, ...DIAGRAM_SHAPES, "tier, lane, col, row"]) expect(t).toContain(w)
    expect(t).toContain(JSON.stringify(DIAGRAM_GUIDE_EXAMPLE))
    expect(DIAGRAM_GUIDE_URI).toBe("studio://skema/diagram")
    console.log(`[row178] guide ${Buffer.byteLength(t)} B`)
    expect(Buffer.byteLength(t)).toBeLessThan(3000)
  })

  test("the example validates (block schema and preview body) and renders", async () => {
    expect(validateBlockV2(DIAGRAM_GUIDE_EXAMPLE, "/block")).toEqual([])
    expect(parsePreviewBody({ block: DIAGRAM_GUIDE_EXAMPLE }).ok).toBe(true)
    const PKG = path.resolve(import.meta.dir, "..", "..")
    const compose = await import(path.join(PKG, "vendor", "src", "lib", "studio", "services", "compose", "index.ts"))
    const fig = await import(path.join(PKG, "src", "mcp-host", "local-api", "routes", "figure-preview-figure.ts"))
    const content = compose.mapBlock(structuredClone(DIAGRAM_GUIDE_EXAMPLE), "fig-diagram-11", { glyphs: compose.glyphSet(undefined), params: {}, classification: "TERBATAS", artifactLabel: "Gambar 1.1" })
    const block = { blockId: "fig-diagram-11", pid: "fig-diagram-11", address: "1.1.1", ordinal: 0, unitKey: "", type: "diagram", content, textPlain: "", contentSha256: "", artifactLabel: "Gambar 1.1" }
    const r = await fig.renderFigure(block, { params: {} } as any, { inline: true, withSvg: true, lang: "ID" })
    console.log(`[row178] example rendered ${r.size?.widthMm}x${r.size?.heightMm} mm, ${r.size?.svgBytes} B, issues ${JSON.stringify(r.issues)}`)
    expect(r.svg).toContain("<svg")
    expect((r.issues as Array<{ status: string }>).filter((i) => i.status === "FAIL")).toEqual([])
    for (const label of ["Sensor R1-R2", "Gerbang Data A", "Server Pemantauan"]) expect(r.svg).toContain(label)
  })
})
