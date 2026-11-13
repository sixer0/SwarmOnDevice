// Swarm 1.2.8 row 52 (AC-VIS0a, AC-VIS0b; F-VISIO 01f §2.1, §3.1, §4.1, §8; register N8-369, N8-473, N8-474; C12
// OP-18-1). One file for VIS-0 with four describes: "schema" and "guide" (row 52), "char" (row 52b), "carry" (row 33b).
// Red at BASE e1f9673772: the new fields are refused SCHEMA_INVALID, the bounds and the second resource do not exist.
// The "guide" host part binds 127.0.0.1 port 0 (run with the command sandbox off).
// Namespace imports: at BASE some names do not exist, so the red run fails on assertions, not on a link error.
import { useStudioEnv } from "../ported/_env"
useStudioEnv()
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { validateBlockV2 } from "../../vendor/src/lib/studio/services/revisions/v2/body"
import { validateSchema } from "../../vendor/src/lib/studio/services/ingest"
import { commonV2Schema } from "../../vendor/src/lib/studio/contract/schema/v2/common.schema"
import * as enums from "../../vendor/src/lib/studio/contract/enums"
import * as bounds from "../../vendor/src/lib/studio/contract/schema/figure-bounds"
import * as hints from "../../vendor/src/lib/studio/contract/schema/v2/refusal-hints"
import * as tokens from "../../vendor/src/lib/studio/engine/diagram/core/tokens"
import { loadSpec, validateSpec } from "../../vendor/src/lib/studio/engine/diagram/core/spec"
import * as guide from "../../src/mcp-host/diagram-guide.ts"
import { buildDiagramSvg } from "../../vendor/src/lib/studio/engine/diagram/build/index"
import { buildDiagramSvgAuto } from "../../vendor/src/lib/studio/engine/diagram/elk/index"
import { diagramSpec } from "../../vendor/src/lib/studio/services/compose/blocks"

type Issue = { pointer: string; keyword: string; message: string }
type J = Record<string, any>
const E = enums as J
const H = hints as J
const G = guide as J
const B = (bounds as J).FIGURE_BOUNDS as J
const L = (tokens as J).LIMITS as J

// The 1.2.8 contract fields (01f §2.1, §3.1) with every value the register allows (N8-236, N8-249, N8-252, N8-254..N8-266).
const ENUMS: Array<[string, "spec" | "node" | "zone" | "edge", string[]]> = [
  ["lane_orientation", "spec", ["horizontal", "vertical"]],
  ["jumps", "spec", ["on", "off"]],
  ["event_type", "node", ["none", "message", "timer"]],
  ["style", "zone", ["zone", "group"]],
  ["route", "edge", ["orthogonal", "straight", "curved"]],
  ["from_side", "edge", ["auto", "top", "right", "bottom", "left"]],
  ["to_side", "edge", ["auto", "top", "right", "bottom", "left"]],
  ["arrow_start", "edge", ["none", "triangle", "open", "diamond", "circle"]],
  ["arrow_end", "edge", ["none", "triangle", "open", "diamond", "circle"]],
  ["arrow_start_size", "edge", ["s", "m", "l"]],
  ["arrow_end_size", "edge", ["s", "m", "l"]],
  ["dash", "edge", ["solid", "dashed", "dotted", "longdash", "dashdot"]],
  ["weight", "edge", ["thin", "normal", "thick"]],
  ["label_at", "edge", ["start", "middle", "end"]],
]
const NEW_SHAPES = ["predefined", "document", "offpage", "event_start", "event_intermediate", "event_end", "task", "subprocess", "gateway_exclusive", "gateway_parallel", "gateway_inclusive", "gateway_complex", "data_object", "annotation"]
const NEW_FIELDS = { spec: ["lane_orientation", "phases", "pools", "jumps"], node: ["event_type"], class: ["phase", "pool"], edge: ["route", "from_side", "to_side", "from_slot", "to_slot", "via", "arrow_start", "arrow_end", "arrow_start_size", "arrow_end_size", "dash", "weight", "label_at"], zone: ["style"] }

const cap = { text: "Uji." }
const src = { text: "SUMBER: uji." }
const node = (id: string, over: J = {}): J => ({ id, label: id.toUpperCase(), class: { lane: "Lajur 1", phase: "f1", pool: "p1" }, ...over })
/** A swimlane spec that sets every new field once (schema only; engine semantics belong to rows 53-57). */
function fullSpec(): J {
  return {
    family: "swimlane",
    lane_orientation: "vertical",
    phases: [{ id: "f1", label: "Fase 1" }],
    pools: [{ id: "p1", label: "Kolam X" }],
    jumps: "off",
    nodes: [node("a", { shape: "event_start", event_type: "message" }), node("b", { shape: "task" }), node("c", { shape: "gateway_exclusive" })],
    edges: [
      { from: "a", to: "b", kind: "data", label: "", route: "orthogonal", from_side: "right", to_side: "left", from_slot: 0.5, to_slot: 0.25, via: [{ col: 0, row: 3 }], arrow_start: "circle", arrow_end: "open", arrow_start_size: "s", arrow_end_size: "l", dash: "dashed", weight: "thick", label_at: "middle" },
      { from: "b", to: "c", kind: "control", label: "ya", route: "curved" },
    ],
    zones: [{ id: "z", label: "Grup", members: ["a", "b"], style: "group" }],
  }
}
const block = (spec: J): J => ({ type: "diagram", caption: cap, source: src, spec })
const v1 = (spec: J): J => ({ $schema: "studio.diagram/v1", id: "1.1", title: "Uji.", classification: "TERBATAS", width_mm: 128, sources: ["S"], ...spec })
const v2issues = (spec: J): Issue[] => validateBlockV2(block(spec), "/block") as Issue[]
const v1issues = (spec: J): Issue[] => validateSchema("studio.diagram/v1", v1(spec)) as unknown as Issue[]
const mutateEdge = (over: J): J => ({ ...fullSpec(), edges: [{ from: "a", to: "b", kind: "data", label: "", ...over }] })

describe("schema", () => {
  test("every new field at once: accepted on v2 (block) and v1 (artefact)", () => {
    expect(v2issues(fullSpec())).toEqual([])
    expect(v1issues(fullSpec())).toEqual([])
  })

  for (const [field, at, values] of ENUMS) {
    test(`${at}.${field}: every value accepted on v1 and v2; a bad value refused with the allowed list`, () => {
      for (const v of values) {
        const s = fullSpec()
        if (at === "spec") s[field] = v
        else if (at === "node") s.nodes[0][field] = v
        else if (at === "zone") s.zones[0][field] = v
        else s.edges[0][field] = v
        expect(v2issues(s), `${field}=${v}`).toEqual([])
        expect(v1issues(s), `${field}=${v}`).toEqual([])
      }
      const s = fullSpec()
      const bad = "zigzag"
      if (at === "spec") s[field] = bad
      else if (at === "node") s.nodes[0][field] = bad
      else if (at === "zone") s.zones[0][field] = bad
      else s.edges[0][field] = bad
      const issues = v2issues(s)
      expect(issues.length).toBeGreaterThan(0)
      const msg = issues.map((i) => i.message).join("\n")
      for (const v of values) expect(msg).toContain(JSON.stringify(v))
    })
  }

  test("the 14 shape tokens are in the contract enum (appended, older order kept) and in the v2 node schema", () => {
    expect((E.DIAGRAM_SHAPES as string[]).slice(0, 10)).toEqual(["box", "bus", "circle", "cylinder", "diamond", "doubled", "hexagon", "parallelogram", "shadowed", "stadium"])
    expect((E.DIAGRAM_SHAPES as string[]).slice(10)).toEqual(NEW_SHAPES)
    const nodeSchema = (commonV2Schema as J).$defs.DiagramSpecV2.properties.nodes.items
    expect(nodeSchema.properties.shape.enum).toEqual(E.DIAGRAM_SHAPES)
    for (const shape of NEW_SHAPES) expect(v2issues({ family: "flow", nodes: [{ id: "a", label: "A", shape, class: {} }] }), shape).toEqual([])
  })

  test("the engine accepts the new tokens (P1-nodes+P3-shapes) and they fall back to box drawing until rows 53/54", () => {
    for (const shape of NEW_SHAPES) {
      const spec = loadSpec(v1({ family: "flow", nodes: [{ id: "a", label: "A", shape, class: {} }] }))
      const fails = validateSpec(spec).filter((i: J) => i.checkId === "P1-nodes+P3-shapes" && i.status === "FAIL")
      expect(fails, shape).toEqual([])
      expect((tokens as J).SHAPES[shape], shape).toBeDefined()
    }
  })

  test("DiagramSpecV2 lists the four spec-level fields (inheritance does not carry them)", () => {
    const props = Object.keys((commonV2Schema as J).$defs.DiagramSpecV2.properties)
    for (const f of NEW_FIELDS.spec) expect(props).toContain(f)
  })

  test("maxItems equal LIMITS.max_phases / max_pools / max_via through B.diagramPhases / diagramPools / diagramVia (N8-473)", () => {
    expect([B.diagramPhases, B.diagramPools, B.diagramVia]).toEqual([8, 4, 8])
    expect([L.max_phases, L.max_pools, L.max_via]).toEqual([B.diagramPhases, B.diagramPools, B.diagramVia])
    expect([(tokens as J).PHASES_MAX, (tokens as J).POOLS_MAX, (tokens as J).VIA_MAX]).toEqual([8, 4, 8])
    const spec = (commonV2Schema as J).$defs.DiagramSpecV2.properties
    expect([spec.phases.maxItems, spec.pools.maxItems, spec.edges.items.properties.via.maxItems]).toEqual([B.diagramPhases, B.diagramPools, B.diagramVia])
    const many = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `x${i}`, label: `X ${i}` }))
    expect(v2issues({ ...fullSpec(), phases: many(8) })).toEqual([])
    expect(v2issues({ ...fullSpec(), phases: many(9) }).some((i) => i.keyword === "maxItems")).toBe(true)
    expect(v2issues({ ...fullSpec(), pools: many(5) }).some((i) => i.keyword === "maxItems")).toBe(true)
    const via = (n: number) => Array.from({ length: n }, (_, i) => ({ col: i, row: 0 }))
    expect(v2issues(mutateEdge({ via: via(8) }))).toEqual([])
    expect(v2issues(mutateEdge({ via: via(9) })).some((i) => i.keyword === "maxItems")).toBe(true)
  })

  test("bounds of the value fields: slots in (0, 1), via integers >= 0, phase/pool items {id, label} only", () => {
    for (const bad of [0, 1, -0.1, 1.5]) expect(v2issues(mutateEdge({ from_side: "top", from_slot: bad })).length, `slot ${bad}`).toBeGreaterThan(0)
    expect(v2issues(mutateEdge({ via: [{ col: -1, row: 0 }] })).length).toBeGreaterThan(0)
    expect(v2issues(mutateEdge({ via: [{ col: 1.5, row: 0 }] })).length).toBeGreaterThan(0)
    expect(v2issues(mutateEdge({ via: [{ x: 1, y: 0 }] })).length).toBeGreaterThan(0)
    expect(v2issues({ ...fullSpec(), phases: [{ id: "f1", label: "F", width: 3 }] }).length).toBeGreaterThan(0)
    expect(v2issues({ ...fullSpec(), phases: [] }).length).toBeGreaterThan(0)
  })

  test("unknown field refused with the alias hint (01f §4.1 alias table)", () => {
    const cases: Array<[string, unknown, string]> = [
      ["pattern", "dashed", 'for "pattern" use "dash" (solid, dashed, dotted, longdash, dashdot)'],
      ["thickness", 2, 'for "thickness" use "weight" (thin, normal, thick)'],
      ["width", 2, 'for "width" use "weight"'],
      ["stroke", "x", 'for "stroke" use "weight"'],
      ["arrowhead", "open", 'for "arrowhead" use "arrow_end" (none, triangle, open, diamond, circle)'],
      ["head", "open", 'for "head" use "arrow_end"'],
      ["tail", "circle", 'for "tail" use "arrow_start"'],
      ["waypoints", [], 'for "waypoints" use "via"'],
      ["bends", [], 'for "bends" use "via"'],
      ["routing", "curved", 'for "routing" use "route" (orthogonal, straight, curved)'],
    ]
    for (const [field, value, hint] of cases) {
      const issues = v2issues(mutateEdge({ [field]: value }))
      expect(issues.some((x) => x.message.includes(`must NOT have additional properties: "${field}"`)), field).toBe(true)
      expect(issues.some((x) => x.message.includes(hint)), `${field}: ${JSON.stringify(issues)}`).toBe(true)
    }
    // `color` is a display field (own first message); its hint still names kind
    expect(v2issues(mutateEdge({ color: "red" })).some((x) => x.message.includes('for "color" use "kind"'))).toBe(true)
    // `dash` is a field now, never an alias; every alias target is a schema field.
    const edgeProps = Object.keys((commonV2Schema as J).$defs.DiagramSpecV2.properties.edges.items.properties)
    expect(Object.keys(H.DIAGRAM_ALIASES.edge)).not.toContain("dash")
    for (const target of Object.values(H.DIAGRAM_ALIASES.edge as Record<string, string>)) expect(edgeProps).toContain(target)
  })

  test("spec `orientation` keeps naming direction and adds the lane_orientation clause; class as a string lists the new fields after the older ones", () => {
    const o = v2issues({ ...fullSpec(), orientation: "LR" }).find((x) => x.keyword === "additionalProperties")!
    expect(o.message).toContain('for "orientation" use "direction" (TB, LR)')
    expect(o.message).toContain('for swimlane lanes use "lane_orientation" (horizontal, vertical)')
    const c = v2issues({ family: "flow", nodes: [{ id: "a", label: "A", class: "box" }] }).find((x) => x.pointer.endsWith("/class"))!
    expect(c.message).toContain("must be object {tier, lane, col, row, accent, secondary, external} + phase, pool")
  })

  test("existing specs validate unchanged (no new field needed; explicit defaults accepted)", () => {
    const old = { family: "layered", nodes: [{ id: "a", label: "A", class: { tier: 0 } }, { id: "b", label: "B", class: { tier: 1 } }], edges: [{ from: "a", to: "b", kind: "data", label: "x" }] }
    expect(v2issues(old)).toEqual([])
    expect(v1issues(old)).toEqual([])
    const explicit = { ...old, jumps: "on", edges: [{ ...old.edges[0], route: "orthogonal", from_side: "auto", arrow_start: "none", arrow_end_size: "m", weight: "normal" }] }
    expect(v2issues(explicit)).toEqual([])
  })

  test("LIMITS carry the register values (N8-213, N8-217, N8-255 = 32, N8-264, N8-470, N8-471)", () => {
    expect([L.max_line_styles, L.max_line_styles_with_mark, L.curve_samples, L.shape_glyph_mm]).toEqual([4, 3, 32, 2.4])
    expect(L.arrow_sizes_mm).toEqual({ s: 2.5, m: 3.2, l: 4.0 })
    expect(L.weight_mm).toEqual({ thin: 0.3, normal: 0.45, thick: 0.7 })
    expect(L.label_at_fraction).toEqual({ start: 0.2, middle: 0.5, end: 0.8 })
    for (const w of Object.values(L.weight_mm as Record<string, number>)) expect(w).toBeGreaterThanOrEqual((tokens as J).STROKE_FLOOR_MM)
  })
})

// ---------------------------------------------------------------- guide (AC-VIS0b)
const PKG = path.resolve(import.meta.dir, "..", "..")
const VENDOR = path.join(PKG, "vendor")
const BASE_DIR = process.env.REL128_VIS0_TEST_DIR ?? path.join(os.tmpdir(), "rel128-vis0")
mkdirSync(BASE_DIR, { recursive: true })
const WORK = realpathSync(mkdtempSync(path.join(BASE_DIR, "v0-")))
const STORE = path.join(WORK, "datum-studio")
const HOME = path.join(WORK, "home")
const RES = path.join(WORK, "Swarm.app", "Contents", "Resources")
const PROJECT = path.join(HOME, "project-a")
for (const d of [HOME, RES, PROJECT]) mkdirSync(d, { recursive: true })
const TOKEN = "e".repeat(16) + "0123456789abcdef".repeat(3)
const FACTS = { home: HOME, resourcesPath: RES, execPath: path.join(WORK, "Swarm.app", "Contents", "MacOS", "Swarm") }

type Mod = typeof import("../../src/mcp-host/index.ts")
let mod: Mod
let store: Awaited<ReturnType<Mod["openHostStore"]>>
let host: Awaited<ReturnType<Mod["startStudioHostServer"]>>
let client: Client
const envBefore = { ws: process.env.STUDIO_WORKSPACE_ROOT, vendor: process.env.STUDIO_VENDOR_ROOT }

describe("guide", () => {
  beforeAll(async () => {
    process.env.STUDIO_WORKSPACE_ROOT = STORE
    process.env.STUDIO_VENDOR_ROOT = VENDOR
    ;(await import("../../vendor/src/lib/studio/contract/env")).resetStudioEnvCache()
    mod = (await import("../../src/mcp-host/index.ts")) as Mod
    const log = () => undefined
    store = await mod.openHostStore(STORE, { release: "1.2.8", logFile: path.join(WORK, "logs", "store.jsonl") })
    mod.configureTemplateSource({ templatesDir: path.join(PKG, "templates"), assetRepoRoot: VENDOR, release: "1.2.8" })
    host = await mod.startStudioHostServer({ store, token: TOKEN, hostname: "127.0.0.1", port: 0, log, facts: FACTS })
    client = new Client({ name: "rel128-vis0", version: "0" })
    await client.connect(new StreamableHTTPClientTransport(new URL(host.url), { requestInit: { headers: { authorization: `Bearer ${TOKEN}`, "x-studio-agent": "claude", "x-studio-caller-cwd": encodeURIComponent(PROJECT) } } }))
  })

  afterAll(async () => {
    await client?.close().catch(() => undefined)
    await host?.close()
    mod?.configureTemplateSource(null)
    if (store) await mod.closeHostStore(store)
    process.env.STUDIO_WORKSPACE_ROOT = envBefore.ws
    if (envBefore.vendor === undefined) delete process.env.STUDIO_VENDOR_ROOT
    else process.env.STUDIO_VENDOR_ROOT = envBefore.vendor
  })

  test("studio://skema/diagram stays < 3000 B, names every shape token and points to studio://skema/diagram-visio", () => {
    const t = G.diagramGuideText() as string
    console.log(`[rel128-vis0] studio://skema/diagram ${Buffer.byteLength(t)} B`)
    expect(Buffer.byteLength(t)).toBeLessThan(3000)
    for (const s of E.DIAGRAM_SHAPES as string[]) expect(t).toContain(s)
    expect(t).toContain("studio://skema/diagram-visio")
    // the 1.2.8 field names live in the second resource (not in the field lines here)
    for (const f of ["arrow_start", "from_slot", "lane_orientation", "event_type", "label_at"]) expect(t).not.toContain(f)
  })

  test("studio://skema/diagram-visio: generated, < 3000 B, names every new field, enum value and shape token", () => {
    expect(G.DIAGRAM_VISIO_GUIDE_URI).toBe("studio://skema/diagram-visio")
    expect(H.DIAGRAM_VISIO_GUIDE_URI).toBe("studio://skema/diagram-visio")
    expect(G.DIAGRAM_VISIO_GUIDE_NAME).toBe("skema-diagram-visio")
    expect(typeof G.diagramVisioGuideText).toBe("function")
    const t = G.diagramVisioGuideText() as string
    console.log(`[rel128-vis0] studio://skema/diagram-visio ${Buffer.byteLength(t)} B`)
    expect(Buffer.byteLength(t)).toBeLessThan(3000)
    for (const fields of Object.values(NEW_FIELDS)) for (const f of fields) expect(t).toContain(f)
    for (const [, , values] of ENUMS) for (const v of values) expect(t).toContain(v)
    for (const s of NEW_SHAPES) expect(t).toContain(s)
    expect(t).toContain(`max ${B.diagramVia}`)
    expect(t).toContain(`max ${B.diagramPhases}`)
    for (const id of ["DATUM-35", "DATUM-25L", "P1-edge-style", "P1-via", "P3-via-family", "P1-containers", "figure.lattice"]) expect(t).toContain(id)
  })

  test("DIAGRAM_VISIO_FIELDS = exactly the schema fields added in 1.2.8; every schema field is in one of the two guides", () => {
    expect(H.DIAGRAM_VISIO_FIELDS).toEqual(NEW_FIELDS)
    const spec = (commonV2Schema as J).$defs.DiagramSpecV2
    const objs: Record<string, J> = { spec, node: spec.properties.nodes.items, class: spec.properties.nodes.items.properties.class, edge: spec.properties.edges.items, zone: spec.properties.zones.items }
    const both = `${G.diagramGuideText()}\n${G.diagramVisioGuideText()}`
    for (const [k, o] of Object.entries(objs)) {
      for (const f of (NEW_FIELDS as J)[k]) expect(Object.keys(o.properties), `${k}.${f}`).toContain(f)
      for (const f of Object.keys(o.properties)) if (!(o.properties[f]?.not && Object.keys(o.properties[f].not).length === 0)) expect(both, `${k}.${f}`).toContain(f)
    }
  })

  test("host: both resources listed and readable; tools/list measured (vendor default < 30 000 B, host < 74 000 B, vendor descriptions <= 450)", async () => {
    const list = (await client.listResources()).resources
    const uris = list.map((r) => r.uri)
    expect(uris).toContain("studio://skema/diagram")
    expect(uris).toContain("studio://skema/diagram-visio")
    expect(list.find((r) => r.uri === "studio://skema/diagram-visio")?.name).toBe("skema-diagram-visio")
    const text = ((await client.readResource({ uri: "studio://skema/diagram-visio" })).contents[0] as { text: string }).text
    expect(text).toBe(G.diagramVisioGuideText())
    const tools = (await client.listTools()).tools
    const hostBytes = Buffer.byteLength(JSON.stringify({ tools }))
    const { connect } = await import("../ported/mcp/mcp-harness")
    const c = await connect({ env: { STUDIO_MCP_TOOLSETS: "reports,documents,query" } })
    const vendorBytes = Buffer.byteLength(JSON.stringify(await c.client.listTools()))
    console.log(`[rel128-vis0] tools/list host ${tools.length} tools ${hostBytes} B; vendor default ${vendorBytes} B`)
    expect(hostBytes).toBeLessThan(74_000)
    expect(vendorBytes).toBeLessThan(30_000)
    // Row 52 changes no tool description; the <= 450 rule is the vendor TOOLS rule of row99-g06 (host wrappers are longer).
    const { TOOLS } = await import("../../vendor/scripts/studio/mcp/tools")
    for (const t of TOOLS as ReadonlyArray<{ name: string; description: string }>) expect(t.description.length, t.name).toBeLessThanOrEqual(450)
    console.log(`[rel128-vis0] longest vendor description ${Math.max(...(TOOLS as ReadonlyArray<{ description: string }>).map((t) => t.description.length))}, longest host description ${Math.max(...tools.map((t) => (t.description ?? "").length))}`)
  })
})

// ---------------------------------------------------------------- char (AC-VIS0c, row 52b)
// Byte-identity harness over the CHAR-VIS corpus (01_specs §3.6 clauses 1, 2, 5; 01f §3.2; AT-V0-char): every diagram
// spec in the fixed corpus files below (syn127, the old-field syn128 files, the specs the engine-rev-a/svg tests read;
// anon126 excluded) is rendered with the sync build (`buildDiagramSvg`) and the production path (`buildDiagramSvgAuto`,
// services/render/figures.ts). Each render is split into the <marker> elements and the rest; both are hashed (sha256,
// first 16 hex) and compared with CHAR_BASE, which was generated with this describe at BASE e1f9673772 (red-base
// worktree, REL128_VIS0_CHAR_PRINT=1). Green at BASE by construction, green at HEAD while the engine keeps old output.
// - "outside markers": every path, node, text, hop and label byte of BASE (clause 1). Only exception: the specs listed in
//   CHAR_ROUTE_INTENT (row 56c, C51/C75/C101: connector ends moved onto the true outline, back-jogs removed), whose
//   outside-marker hashes must equal the listed HEAD hashes instead.
// - "marker elements": the H-ARW marker set (row 57, AC-HARW INTENT): each BASE `mk` hash maps to its H-ARW hash in
//   CHAR_HARW_MK; CHAR_BASE keeps the BASE hashes as generated.
// - "verdicts": validateSpec non-PASS ids, build issues, geometry ids, ELK decision, refusal id (clause 5); an entry may
//   also match its CHAR_INTENT value, which names the AC line that owns the change.
// - "twins": the same spec with every 1.2.8 field set to its default (01f §3.2.2) renders byte-equal to the spec without
//   them. At BASE no 1.2.8 field is in the schema, so no twin field exists and the case checks only that (all or none).

const TEST_ROOT = path.resolve(import.meta.dir, "..")
/** Fixed corpus (files present when the harness was generated; later M3 fixtures use new fields and are not CHAR). */
const CHAR_FILES = [
  "engine-rev-a/svg/fixtures/case04.studio.json",
  "engine-rev-a/svg/fixtures/case04_v2.studio.json",
  "engine-rev-a/svg/fixtures/case05_diagram_block.json",
  "engine-rev-a/svg/fixtures/row162_elk_not_better.json",
  "engine-rev-a/svg/fixtures/row162_large_layered.json",
  "fixtures/syn127/f6_fan_in_specs.json",
  "fixtures/syn127/m03_render_fail_doc.json",
  "fixtures/syn127/n7_autofit_t03_rest.json",
  "fixtures/syn127/t06_diagram_six_colours.json",
  "fixtures/syn127/t11_flow_inline_v2.json",
  "fixtures/syn127/t12_standalone_key_source.json",
  "fixtures/syn128/hn13_import.md",
  "fixtures/syn128/hn6_engine_entry_collision.json",
  "fixtures/syn128/hna_flow_v2.json",
  "fixtures/syn128/hnb2_capacity_adapt.json",
  "fixtures/syn128/hnb4_flow_rank_overflow.json",
  "fixtures/syn128/hnb4_graph_sheet_overflow.json",
  "fixtures/syn128/hnb_fit_to_zero.json",
  "fixtures/syn128/r18g_lr_166.json",
]

type CharEntry = { key: string; v1: J; opts: J; fields: string[] }
const isSpec = (o: unknown): o is J => !!o && typeof o === "object" && !Array.isArray(o) && Array.isArray((o as J).nodes) && typeof (o as J).family === "string"
function charCorpus(): CharEntry[] {
  const out: CharEntry[] = []
  for (const rel of CHAR_FILES) {
    const text = readFileSync(path.join(TEST_ROOT, rel), "utf8")
    const roots: Array<[string, J]> = rel.endsWith(".md")
      ? [...text.matchAll(/```(?:diagram|json)\n([\s\S]*?)\n```/g)].map((m, i) => [`/fence${i}`, JSON.parse(m[1])] as [string, J])
      : [["", JSON.parse(text)]]
    for (const [base, root] of roots) {
      const opts = { release: false, ...((root.buildOptions as J) ?? {}) }
      const walk = (o: unknown, ptr: string) => {
        if (isSpec(o)) {
          const v1 = o.$schema ? structuredClone(o) : diagramSpec(structuredClone(o) as never, "Uji.", "SUMBER: uji.", 128, { artifactLabel: "1.1", classification: "TERBATAS", params: {} } as never)
          out.push({ key: `${rel}#${base}${ptr}`, v1: v1 as J, opts, fields: usedNewFields(o) })
          return
        }
        if (o && typeof o === "object") for (const [k, v] of Object.entries(o as J)) walk(v, `${ptr}/${k}`)
      }
      walk(root, "")
    }
  }
  return out
}
/** 1.2.8 fields and shape tokens a spec uses (the CHAR corpus must use none: "old-field" specs only). */
function usedNewFields(s: J): string[] {
  const used = NEW_FIELDS.spec.filter((f) => f in s)
  for (const n of (s.nodes ?? []) as J[]) {
    for (const f of NEW_FIELDS.node) if (f in n) used.push(`node.${f}`)
    for (const f of NEW_FIELDS.class) if (n.class && typeof n.class === "object" && f in n.class) used.push(`class.${f}`)
    if (NEW_SHAPES.includes(n.shape)) used.push(`shape.${n.shape}`)
  }
  for (const e of (s.edges ?? []) as J[]) for (const f of NEW_FIELDS.edge) if (f in e) used.push(`edge.${f}`)
  for (const z of (s.zones ?? []) as J[]) for (const f of NEW_FIELDS.zone) if (f in z) used.push(`zone.${f}`)
  return used
}

const h16 = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16)
const MARKER_RE = /<marker\b[^>]*?(?:\/>|>[\s\S]*?<\/marker>)/g
const splitMarkers = (svg: string) => ({ out: svg.replace(MARKER_RE, ""), mk: (svg.match(MARKER_RE) ?? []).join("\n") })
const errId = (e: unknown): string => {
  const x = e as J
  const id = x?.details?.checkId ?? x?.checkId
  return id ? String(id) : `ERR:${String(x?.message ?? x).split(/[\s:]/)[0]}`
}
const issueIds = (list: J[] | undefined) => (list ?? []).filter((i) => i.status !== "PASS").map((i) => `${i.checkId}:${i.status}`).sort().join(",")

type Fp = { out: string; mk: string; verdict: string }
/** One render path: hashes of the bytes outside / inside <marker>, and the verdict string. */
async function fingerprint(v1: J, opts: J, auto: boolean): Promise<Fp> {
  const vs = (() => {
    try {
      return issueIds(validateSpec(loadSpec(structuredClone(v1))) as J[])
    } catch (e) {
      return `throw ${errId(e)}`
    }
  })()
  let decision = ""
  try {
    const r = (auto
      ? await buildDiagramSvgAuto(structuredClone(v1) as never, opts as never, {}, (d) => (decision = String(d.reason).split(":")[0]))
      : buildDiagramSvg(structuredClone(v1) as never, opts as never)) as J
    const { out, mk } = splitMarkers(r.svg as string)
    const geo = ((r.report.geometry ?? []) as J[]).map((g) => `${g.checkId}:${g.status}`).sort().join(",")
    return { out: h16(out), mk: h16(mk), verdict: `V[${vs}] I[${issueIds(r.report.issues)}] G[${geo}] E[${decision}]` }
  } catch (e) {
    return { out: "-", mk: "-", verdict: `V[${vs}] X[${errId(e)}] E[${decision}]` }
  }
}
/** Serialised as "<sync out> <sync mk> <auto out> <auto mk> | <sync verdict> | <auto verdict>". */
async function charLine(v1: J, opts: J): Promise<string> {
  const s = await fingerprint(v1, opts, false)
  const a = await fingerprint(v1, opts, true)
  return `${s.out} ${s.mk} ${a.out} ${a.mk} | ${s.verdict} | ${a.verdict}`
}
const parts = (line: string) => {
  const [hashes, vs, va] = line.split(" | ")
  const [so, sm, ao, am] = hashes.split(" ")
  return { so, sm, ao, am, vs, va }
}

/** 1.2.8 fields set to their default (01f §3.2.2). Spec level: jumps; lane_orientation on swimlane only (P1-containers cause 1). */
const KIND_HEAD: Record<string, string> = { data: "triangle", accent: "triangle", control: "open", sync: "open", alert: "open", verify: "open" }
const KIND_DASH: Record<string, string> = { data: "solid", accent: "solid", control: "dashed", sync: "dotted", alert: "longdash", verify: "dashdot" }
function explicitDefaults(v1: J, has: Set<string>): J {
  const s = structuredClone(v1)
  if (has.has("jumps")) s.jumps = "on"
  if (has.has("lane_orientation") && s.family === "swimlane") s.lane_orientation = "horizontal"
  for (const e of (s.edges ?? []) as J[]) {
    const set = (f: string, v: unknown) => {
      if (has.has(f)) e[f] = v
    }
    set("route", "orthogonal")
    set("from_side", "auto")
    set("to_side", "auto")
    set("arrow_start", "none")
    if (KIND_HEAD[e.kind]) {
      set("arrow_end", KIND_HEAD[e.kind])
      set("arrow_end_size", "m")
    }
    if (KIND_DASH[e.kind]) set("dash", KIND_DASH[e.kind])
    if (e.kind !== "accent") set("weight", "normal")
  }
  for (const z of (s.zones ?? []) as J[]) if (has.has("style")) z.style = "zone"
  return s
}
const TWIN_FIELDS = ["jumps", "lane_orientation", "route", "from_side", "to_side", "arrow_start", "arrow_end", "arrow_end_size", "dash", "weight", "style"]
/** Twin fields present in the contract schema (HEAD: all; BASE: none). */
function schemaTwinFields(): Set<string> {
  const spec = (commonV2Schema as J).$defs.DiagramSpecV2.properties as J
  const edge = (spec.edges?.items?.properties ?? {}) as J
  const zone = (spec.zones?.items?.properties ?? {}) as J
  const has = new Set<string>()
  for (const f of ["jumps", "lane_orientation"]) if (f in spec) has.add(f)
  for (const f of TWIN_FIELDS) if (f in edge) has.add(f)
  if ("style" in zone) has.add("style")
  return has
}

// GENERATED at BASE e1f9673772 (red-base worktree) with REL128_VIS0_CHAR_PRINT=1. Do not edit by hand except as INTENT
// of a listed AC line (row 57 AC-HARW: the `mk` columns).
const CHAR_BASE: Record<string, string> = {
  "engine-rev-a/svg/fixtures/case04.studio.json#":
    "1cbea94b2c1060f2 5951e475e7e785a8 1cbea94b2c1060f2 5951e475e7e785a8 | V[] I[P1-labels_verified:NOT_RUN] G[] E[] | V[] I[P1-labels_verified:NOT_RUN] G[] E[R2]",
  "engine-rev-a/svg/fixtures/case04_v2.studio.json#":
    "f624bcf93d04310d 5951e475e7e785a8 f624bcf93d04310d 5951e475e7e785a8 | V[] I[P1-labels_verified:NOT_RUN] G[] E[] | V[] I[P1-labels_verified:NOT_RUN] G[] E[R2]",
  "engine-rev-a/svg/fixtures/case05_diagram_block.json#/spec":
    "dd3064adf024896a 5951e475e7e785a8 dd3064adf024896a 5951e475e7e785a8 | V[] I[P1-labels_verified:NOT_RUN] G[] E[] | V[] I[P1-labels_verified:NOT_RUN] G[] E[R2]",
  "engine-rev-a/svg/fixtures/row162_elk_not_better.json#":
    "b646efd9124c2d9d 5951e475e7e785a8 b646efd9124c2d9d 5951e475e7e785a8 | V[] I[P1-labels_verified:NOT_RUN] G[AUTO_FIT:REPORT,EDGE_LANES:REPORT,GEOM_EDGE_COLLINEAR:REPORT,GEOM_EDGE_CROSS:REPORT,LABEL_MOVED:REPORT,NODE_ORDER:REPORT] E[] | V[] I[P1-labels_verified:NOT_RUN] G[AUTO_FIT:REPORT,EDGE_LANES:REPORT,ELK_LAYOUT:REPORT,GEOM_EDGE_COLLINEAR:REPORT,GEOM_EDGE_CROSS:REPORT,LABEL_MOVED:REPORT,NODE_ORDER:REPORT] E[R4]",
  "engine-rev-a/svg/fixtures/row162_large_layered.json#":
    "ddcaff3459a94e61 5951e475e7e785a8 c6c2c603e634c266 5951e475e7e785a8 | V[] I[P1-labels_verified:NOT_RUN] G[AUTO_FIT:REPORT,GEOM_EDGE_COLLINEAR:REPORT,GEOM_EDGE_CROSS:REPORT,GEOM_STUB_SEGMENT:REPORT,LABEL_MOVED:REPORT,NODE_ORDER:REPORT] E[] | V[] I[P1-labels_verified:NOT_RUN] G[AUTO_FIT:REPORT,EDGE_LANES:REPORT,ELK_LAYOUT:REPORT,LABEL_MOVED:REPORT] E[R3/R4]",
  "fixtures/syn127/f6_fan_in_specs.json#/specs/0/spec":
    "694448220dbc9ea7 eea8450c80a2d003 694448220dbc9ea7 eea8450c80a2d003 | V[] I[] G[] E[] | V[] I[] G[] E[R1]",
  "fixtures/syn127/f6_fan_in_specs.json#/specs/1/spec":
    "82586f59c7edfd6b eea8450c80a2d003 82586f59c7edfd6b eea8450c80a2d003 | V[] I[] G[] E[] | V[] I[] G[] E[R1]",
  "fixtures/syn127/f6_fan_in_specs.json#/specs/2/spec":
    "1a5c662897015832 eea8450c80a2d003 1a5c662897015832 eea8450c80a2d003 | V[] I[] G[GEOM_STUB_SEGMENT:REPORT] E[] | V[] I[] G[GEOM_STUB_SEGMENT:REPORT] E[R1]",
  "fixtures/syn127/f6_fan_in_specs.json#/specs/3/spec":
    "cc6faf8a4ab4d959 eea8450c80a2d003 cc6faf8a4ab4d959 eea8450c80a2d003 | V[] I[] G[GEOM_STUB_SEGMENT:REPORT] E[] | V[] I[] G[GEOM_STUB_SEGMENT:REPORT] E[R1]",
  "fixtures/syn127/f6_fan_in_specs.json#/specs/4/spec":
    "fdec7f21ed78263c eea8450c80a2d003 fdec7f21ed78263c eea8450c80a2d003 | V[] I[] G[] E[] | V[] I[] G[] E[R2]",
  "fixtures/syn127/f6_fan_in_specs.json#/specs/5/spec":
    "540d8474a29336b2 eea8450c80a2d003 540d8474a29336b2 eea8450c80a2d003 | V[] I[] G[AUTO_FIT:REPORT,EDGE_LANES:REPORT,FLOW_SERIALISED:REPORT,GEOM_EDGE_COLLINEAR:REPORT] E[] | V[] I[] G[AUTO_FIT:REPORT,EDGE_LANES:REPORT,FLOW_SERIALISED:REPORT,GEOM_EDGE_COLLINEAR:REPORT] E[R1]",
  "fixtures/syn127/f6_fan_in_specs.json#/specs/6/spec":
    "f6b91b24aa6af503 eea8450c80a2d003 f6b91b24aa6af503 eea8450c80a2d003 | V[] I[] G[] E[] | V[] I[] G[] E[R2]",
  "fixtures/syn127/f6_fan_in_specs.json#/specs/7/spec":
    "5cbdd2459a802c3c 3efe8a70ab24fdc4 5cbdd2459a802c3c 3efe8a70ab24fdc4 | V[] I[] G[GEOM_STUB_SEGMENT:REPORT] E[] | V[] I[] G[GEOM_STUB_SEGMENT:REPORT] E[R1]",
  "fixtures/syn127/m03_render_fail_doc.json#/chapters/0/chapter/sections/0/blocks/1/spec":
    "11c88a9ff40b79ac eea8450c80a2d003 11c88a9ff40b79ac eea8450c80a2d003 | V[] I[] G[] E[] | V[] I[] G[] E[R1]",
  "fixtures/syn127/n7_autofit_t03_rest.json#/spec":
    "a4e7562f1ab641bd eea8450c80a2d003 a4e7562f1ab641bd eea8450c80a2d003 | V[] I[] G[AUTO_FIT:REPORT,GEOM_STUB_SEGMENT:REPORT,LABEL_LEADER:REPORT,LABEL_LEADER:REPORT,LABEL_MOVED:REPORT] E[] | V[] I[] G[AUTO_FIT:REPORT,GEOM_STUB_SEGMENT:REPORT,LABEL_LEADER:REPORT,LABEL_LEADER:REPORT,LABEL_MOVED:REPORT] E[R1]",
  "fixtures/syn127/t06_diagram_six_colours.json#/spec":
    "- - - - | V[] X[DATUM-25] E[] | V[] X[DATUM-25] E[]",
  "fixtures/syn127/t11_flow_inline_v2.json#/block/spec":
    "4bdcb52bb5d1d57b 3efe8a70ab24fdc4 4bdcb52bb5d1d57b 3efe8a70ab24fdc4 | V[] I[] G[FLOW_SERIALISED:REPORT,GEOM_ARROW_TANGENT:REPORT] E[] | V[] I[] G[FLOW_SERIALISED:REPORT,GEOM_ARROW_TANGENT:REPORT] E[R1]",
  "fixtures/syn127/t12_standalone_key_source.json#/block/spec":
    "eb8cd269271d6289 3efe8a70ab24fdc4 eb8cd269271d6289 3efe8a70ab24fdc4 | V[] I[] G[] E[] | V[] I[] G[] E[R1]",
  "fixtures/syn128/hn13_import.md#/fence0":
    "2852fcd149ca343c eea8450c80a2d003 2852fcd149ca343c eea8450c80a2d003 | V[] I[] G[] E[] | V[] I[] G[] E[R1]",
  "fixtures/syn128/hn13_import.md#/fence1/spec":
    "9ea657713b29d596 eea8450c80a2d003 9ea657713b29d596 eea8450c80a2d003 | V[] I[] G[] E[] | V[] I[] G[] E[R1]",
  "fixtures/syn128/hn6_engine_entry_collision.json#/spec":
    "7178c24ea8adcd66 eea8450c80a2d003 7178c24ea8adcd66 eea8450c80a2d003 | V[] I[] G[GEOM_STUB_SEGMENT:REPORT] E[] | V[] I[] G[GEOM_STUB_SEGMENT:REPORT] E[R1]",
  "fixtures/syn128/hna_flow_v2.json#/block/spec":
    "ae50b51457fb4d03 3efe8a70ab24fdc4 ae50b51457fb4d03 3efe8a70ab24fdc4 | V[] I[] G[GEOM_ARROW_TANGENT:REPORT,GEOM_STUB_SEGMENT:REPORT] E[] | V[] I[] G[GEOM_ARROW_TANGENT:REPORT,GEOM_STUB_SEGMENT:REPORT] E[R1]",
  "fixtures/syn128/hna_flow_v2.json#/writeBlock/diagram/spec":
    "ae50b51457fb4d03 3efe8a70ab24fdc4 ae50b51457fb4d03 3efe8a70ab24fdc4 | V[] I[] G[GEOM_ARROW_TANGENT:REPORT,GEOM_STUB_SEGMENT:REPORT] E[] | V[] I[] G[GEOM_ARROW_TANGENT:REPORT,GEOM_STUB_SEGMENT:REPORT] E[R1]",
  "fixtures/syn128/hna_flow_v2.json#/chapter/chapter/sections/0/blocks/1/spec":
    "ae50b51457fb4d03 3efe8a70ab24fdc4 ae50b51457fb4d03 3efe8a70ab24fdc4 | V[] I[] G[GEOM_ARROW_TANGENT:REPORT,GEOM_STUB_SEGMENT:REPORT] E[] | V[] I[] G[GEOM_ARROW_TANGENT:REPORT,GEOM_STUB_SEGMENT:REPORT] E[R1]",
  "fixtures/syn128/hnb2_capacity_adapt.json#/spec":
    "4bafa659a12d5cb1 eea8450c80a2d003 4bafa659a12d5cb1 eea8450c80a2d003 | V[] I[] G[AUTO_FIT:REPORT,CAPACITY_ADAPT:REPORT] E[] | V[] I[] G[AUTO_FIT:REPORT,CAPACITY_ADAPT:REPORT] E[R1]",
  "fixtures/syn128/hnb4_flow_rank_overflow.json#/spec":
    "- - - - | V[] X[DATUM-37-lebar] E[] | V[] X[DATUM-37-lebar] E[]",
  "fixtures/syn128/hnb4_graph_sheet_overflow.json#/spec":
    "- - - - | V[] X[DATUM-37-lebar] E[] | V[] X[DATUM-37-lebar] E[R1]",
  "fixtures/syn128/hnb_fit_to_zero.json#/spec":
    "3a0c05a3c2f31301 eea8450c80a2d003 3a0c05a3c2f31301 eea8450c80a2d003 | V[] I[] G[AUTO_FIT:REPORT] E[] | V[] I[] G[AUTO_FIT:REPORT] E[R2]",
  "fixtures/syn128/r18g_lr_166.json#/spec":
    "2619dc383ad9cffc 3efe8a70ab24fdc4 2619dc383ad9cffc 3efe8a70ab24fdc4 | V[] I[] G[AUTO_FIT:REPORT] E[] | V[] I[] G[AUTO_FIT:REPORT] E[R2]",
}
/**
 * Swarm 1.2.8 row 57 (AC-HARW INTENT, C10 OP13-5, C12 OP-18-2, 01f §5.3): the H-ARW marker set. Every BASE marker block
 * of the corpus (sha256 first 16 hex of the joined <marker> elements, CHAR_BASE `mk` columns) maps to the block row 57
 * draws (`head-<kind>` in userSpaceOnUse mm at size m). Three distinct BASE blocks occur (the case04 one holds
 * head-control, head-data, head-sync); a refused spec ("-") draws none. Generated with REL128_VIS0_CHAR_PRINT=1 at row 57;
 * the bytes outside <marker> and the verdicts stayed BASE's for every key.
 */
const CHAR_HARW_MK: Record<string, string> = {
  "5951e475e7e785a8": "ea8f7d397f16783f",
  eea8450c80a2d003: "d88b640769644364",
  "3efe8a70ab24fdc4": "411292684f467f10",
  "-": "-",
}
/** Intended verdict changes (01_specs §3.6 clause 5), key -> [AC line, HEAD line]; bytes outside markers stay BASE's. */
const CHAR_INTENT: Record<string, [string, string]> = {
  // AC-HNB4 (row 35b, 4dcd95b64c): one meaning per DATUM-37 id; the refusal stays, its id is split.
  "fixtures/syn128/hnb4_flow_rank_overflow.json#/spec":
    ["AC-HNB4", "- - - - | V[] X[DATUM-37-rank] E[] | V[] X[DATUM-37-rank] E[]"],
  "fixtures/syn128/hnb4_graph_sheet_overflow.json#/spec":
    ["AC-HNB4", "- - - - | V[] X[DATUM-37-sheet] E[] | V[] X[DATUM-37-sheet] E[R1]"],
  // Row 56c (C51, C75): the diamond exits land on the diamond outline; the fan-in stub on Langkah D's top is gone, so
  // GEOM_STUB_SEGMENT is no longer reported (GEOM_ARROW_TANGENT stays, pre-existing).
  "fixtures/syn128/hna_flow_v2.json#/block/spec":
    ["AC-VIS-56c", "83825ace228e8e9e 411292684f467f10 83825ace228e8e9e 411292684f467f10 | V[] I[] G[GEOM_ARROW_TANGENT:REPORT] E[] | V[] I[] G[GEOM_ARROW_TANGENT:REPORT] E[R1]"],
  "fixtures/syn128/hna_flow_v2.json#/chapter/chapter/sections/0/blocks/1/spec":
    ["AC-VIS-56c", "83825ace228e8e9e 411292684f467f10 83825ace228e8e9e 411292684f467f10 | V[] I[] G[GEOM_ARROW_TANGENT:REPORT] E[] | V[] I[] G[GEOM_ARROW_TANGENT:REPORT] E[R1]"],
  "fixtures/syn128/hna_flow_v2.json#/writeBlock/diagram/spec":
    ["AC-VIS-56c", "83825ace228e8e9e 411292684f467f10 83825ace228e8e9e 411292684f467f10 | V[] I[] G[GEOM_ARROW_TANGENT:REPORT] E[] | V[] I[] G[GEOM_ARROW_TANGENT:REPORT] E[R1]"],
}
/**
 * Swarm 1.2.8 row 56c (C51, C75, C101; user item 7): intended changes of the bytes outside <marker>, key -> [reason,
 * HEAD sync hash, HEAD auto hash]. Only connector paths (and the edge labels placed on them) move; nodes and markers
 * keep their bytes. Generated with REL128_VIS0_CHAR_PRINT=1 on the row 56c engine (isolated copy of HEAD 2a85a24cbb).
 */
const CHAR_ROUTE_INTENT: Record<string, [string, string, string]> = {
  "engine-rev-a/svg/fixtures/case04.studio.json#": ["srv->db ends on the cylinder's front lid rim (defect 3)", "057ab411e94da281", "057ab411e94da281"],
  "engine-rev-a/svg/fixtures/case04_v2.studio.json#": ["srv->db ends on the cylinder's front lid rim (defect 3)", "c89fa5f3cb3736ab", "c89fa5f3cb3736ab"],
  "engine-rev-a/svg/fixtures/case05_diagram_block.json#/spec": ["srv->db ends on the cylinder's front lid rim (defect 3)", "698931f960562706", "698931f960562706"],
  "fixtures/syn127/f6_fan_in_specs.json#/specs/0/spec": ["fan-in Z routes bend in the gap, no back-jog along the target side (defect 1)", "50b7fec1619a6c96", "50b7fec1619a6c96"],
  "fixtures/syn127/f6_fan_in_specs.json#/specs/1/spec": ["fan-in Z routes bend in the gap, no back-jog along the target side (defect 1)", "36042e0c807d0821", "36042e0c807d0821"],
  "fixtures/syn127/f6_fan_in_specs.json#/specs/2/spec": ["fan-in Z routes bend in the gap, no back-jog along the target side (defect 1)", "69be5fda0acc21af", "69be5fda0acc21af"],
  "fixtures/syn127/f6_fan_in_specs.json#/specs/3/spec": ["fan-in Z routes bend in the gap, no back-jog along the target side (defect 1)", "276aab6f31e9fd03", "276aab6f31e9fd03"],
  "fixtures/syn127/f6_fan_in_specs.json#/specs/7/spec": ["fan-in Z routes bend in the gap, no back-jog along the target side (defect 1)", "d187d02cb19263ef", "d187d02cb19263ef"],
  "fixtures/syn128/hn6_engine_entry_collision.json#/spec": ["Z routes bend in the gap, no back-jog along the target side (defect 1)", "b3894b84e247a4a9", "b3894b84e247a4a9"],
  "fixtures/syn128/hna_flow_v2.json#/block/spec": ["diamond exits start on the diamond's slanted sides (defect 2)", "83825ace228e8e9e", "83825ace228e8e9e"],
  "fixtures/syn128/hna_flow_v2.json#/chapter/chapter/sections/0/blocks/1/spec": ["diamond exits start on the diamond's slanted sides (defect 2)", "83825ace228e8e9e", "83825ace228e8e9e"],
  "fixtures/syn128/hna_flow_v2.json#/writeBlock/diagram/spec": ["diamond exits start on the diamond's slanted sides (defect 2)", "83825ace228e8e9e", "83825ace228e8e9e"],
}

describe("char", () => {
  let corpus: CharEntry[] = []
  const now: Record<string, string> = {}
  beforeAll(async () => {
    corpus = charCorpus()
    for (const c of corpus) now[c.key] = await charLine(c.v1, c.opts)
    if (process.env.REL128_VIS0_CHAR_PRINT === "1") console.log(`[rel128-vis0 char] ${JSON.stringify(now, null, 2)}`)
  }, 120_000)

  test("the corpus is the CHAR-VIS set: every file read, old-field specs only, keys equal CHAR_BASE", () => {
    console.log(`[rel128-vis0 char] corpus ${corpus.length} specs from ${CHAR_FILES.length} files`)
    for (const rel of CHAR_FILES) expect(corpus.some((c) => c.key.startsWith(`${rel}#`)), rel).toBe(true)
    for (const c of corpus) expect(c.fields, c.key).toEqual([])
    expect(corpus.map((c) => c.key).sort()).toEqual(Object.keys(CHAR_BASE).sort())
  })

  test("bytes outside <marker> equal BASE for every rendered spec, sync and auto path (§3.6 clause 1)", () => {
    for (const c of corpus) {
      const b = parts(CHAR_BASE[c.key]!)
      const n = parts(now[c.key]!)
      const route = CHAR_ROUTE_INTENT[c.key] // row 56c INTENT: the listed HEAD hashes replace BASE's
      expect([n.so, n.ao], c.key).toEqual(route ? [route[1], route[2]] : [b.so, b.ao])
    }
  })

  test("marker elements equal the H-ARW set (row 57 AC-HARW INTENT: each BASE marker block -> CHAR_HARW_MK)", () => {
    for (const c of corpus) {
      const b = parts(CHAR_BASE[c.key]!)
      const n = parts(now[c.key]!)
      expect([n.sm, n.am], c.key).toEqual([CHAR_HARW_MK[b.sm], CHAR_HARW_MK[b.am]])
    }
  })

  test("verdicts equal BASE except the intended changes listed with their AC line (§3.6 clause 5)", () => {
    for (const c of corpus) {
      const b = parts(CHAR_BASE[c.key]!)
      const n = parts(now[c.key]!)
      const intent = CHAR_INTENT[c.key]
      const ok = (n.vs === b.vs && n.va === b.va) || (!!intent && n.vs === parts(intent[1]).vs && n.va === parts(intent[1]).va)
      expect(ok ? "ok" : { base: [b.vs, b.va], now: [n.vs, n.va], intent }, c.key).toBe("ok")
    }
  })

  test("explicit-default twins render byte-equal to the spec without the fields, verdicts equal (§3.6 clause 2)", async () => {
    const has = schemaTwinFields()
    console.log(`[rel128-vis0 char] twin fields in the schema: ${has.size} of ${TWIN_FIELDS.length}`)
    // All or none: BASE has no 1.2.8 field; HEAD (row 52 on) has every one. A partial set means a schema regression.
    expect([0, TWIN_FIELDS.length]).toContain(has.size)
    if (has.size === 0) return
    let twins = 0
    for (const c of corpus) {
      const twin = explicitDefaults(c.v1, has)
      expect(usedNewFields(twin).length, c.key).toBeGreaterThan(0)
      // the twin is a valid v1 artefact under the contract
      expect(validateSchema("studio.diagram/v1", twin) as unknown as Issue[], c.key).toEqual([])
      expect(await charLine(twin, c.opts), c.key).toBe(now[c.key])
      twins++
    }
    expect(twins).toBe(corpus.length)
  }, 120_000)
})

// ---------------------------------------------------------------- carry (AC-VISNA, row 33b)
// AT-NA-VIS (01f §4.2): a diagram using every 1.2.8 field survives the five write channels unchanged. Fixtures
// vis0_carry_a.json (swimlane, BPMN, spec-level fields) and vis0_carry_b.json (flow, ISO 5807, the other enum values);
// two because one figure cannot hold every field within DATUM-25L and DATUM-35. Channels, on the real host over a temp
// store (diagram-persist/hna-host.ts, binds 127.0.0.1 port 0: run with the command sandbox off): chapter_submit as an
// object, chapter_submit as a JSON string, studio_write {diagram}, studio_edit append [{diagram}], and the markdown
// import fence (studio_chapter_import_markdown submit=true). Each is read back with studio_document_get: the stored spec
// is deep-equal (canonical JSON, keys sorted) to the submitted one, caption and source as {text}. Then a style-only
// studio_figure_revise patch round-trips with no FIGURE_GRAPH_DELTA. Red at BASE e1f9673772: every channel refuses the
// new fields (SCHEMA_INVALID / INVALID_ARGUMENT), so nothing is stored.
type HnaHost = typeof import("../diagram-persist/hna-host")
const CARRY_FIXTURES = ["vis0_carry_a", "vis0_carry_b"] as const
const carryFixture = (name: string): { spec: J; caption: string; source: string } => JSON.parse(readFileSync(path.join(TEST_ROOT, "fixtures", "syn128", `${name}.json`), "utf8"))
/** Every 1.2.8 field name a spec uses, as "<at>.<field>" (at = spec, node, class, edge, zone). */
function carryFieldsOf(spec: J): Set<string> {
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

describe("carry", () => {
  let hh: HnaHost
  let h: Awaited<ReturnType<HnaHost["startHost"]>>
  beforeAll(async () => {
    hh = await import("../diagram-persist/hna-host")
    h = await hh.startHost("carry")
  }, 120_000)
  afterAll(async () => {
    await h?.close()
  })

  const MISSION = "2026-11-14_visna"
  const expected = (fx: { spec: J; caption: string; source: string }): J => ({ type: "diagram", spec: fx.spec, caption: { text: fx.caption }, source: { text: fx.source } })
  /** Every stored diagram of the document (n of them) equals the fixture block (spec, caption, source; id ignored). */
  async function expectStored(documentId: string, fx: { spec: J; caption: string; source: string }, n: number, channel: string): Promise<J[]> {
    const ds = hh.diagramsOf(await h.content(documentId))
    expect(ds.length, channel).toBe(n)
    for (const d of ds) {
      expect(hh.canon(d.spec), `${channel}: spec`).toBe(hh.canon(fx.spec))
      expect(hh.canon(hh.withoutId(d)), `${channel}: block`).toBe(hh.canon(expected(fx)))
    }
    return ds
  }
  const ok = (r: J, what: string) => expect(r.ok, `${what}: ${String(r._text).slice(0, 600)}`).not.toBe(false)

  test("the two fixtures together use every 1.2.8 field; each passes the v2 validator and validateSpec", () => {
    const used = new Set<string>()
    for (const name of CARRY_FIXTURES) {
      const fx = carryFixture(name)
      for (const f of carryFieldsOf(fx.spec)) used.add(f)
      expect(validateBlockV2(expected(fx), "/block") as Issue[], name).toEqual([])
      const fails = validateSpec(loadSpec(v1(fx.spec))).filter((i: J) => i.status !== "PASS")
      expect(fails, name).toEqual([])
    }
    const all = Object.entries(NEW_FIELDS).flatMap(([at, fs]) => fs.map((f) => `${at}.${f}`))
    expect(all.filter((f) => !used.has(f))).toEqual([])
  })

  for (const name of CARRY_FIXTURES) {
    const fx = carryFixture(name)
    // One client document per channel group: the host rate-limits document creation.
    let docSubmit = ""
    let docWrite = ""

    test(`${name}: studio_chapter_submit (object, then JSON string) stores the spec unchanged`, async () => {
      docSubmit = await hh.newClientDoc(h, `visna-${name.slice(-1)}-submit`)
      const submission = () => ({
        $schema: "studio.chapter/v2",
        target: { documentId: docSubmit },
        chapter: { key: "1", title: { text: "Uraian uji bawa" }, sections: [{ title: { text: "Bagian uji" }, blocks: [{ type: "paragraph", text: "Paragraf sintetis alfa bravo." }, expected(hh.clone(fx))] }] },
      })
      ok(await h.call("studio_chapter_submit", { submission: submission() }), "submit object")
      await expectStored(docSubmit, fx, 1, "submit object")
      ok(await h.call("studio_chapter_submit", { submission: JSON.stringify(submission()) }), "submit string")
      await expectStored(docSubmit, fx, 1, "submit string")
    }, 120_000)

    test(`${name}: markdown import fence (studio_chapter_import_markdown submit=true) stores the spec unchanged`, async () => {
      expect(docSubmit).not.toBe("")
      const markdown = ["# Bab uji impor bawa", "", "Paragraf sintetis charlie delta.", "", "```diagram", JSON.stringify(fx.spec, null, 2), "```", "", `Gambar: ${fx.caption}`, "", `Sumber: ${fx.source}`, ""].join("\n")
      const r = await h.call("studio_chapter_import_markdown", { markdown, chapterKey: "2", documentId: docSubmit, submit: true, change: hh.CHANGE })
      ok(r, "import")
      expect(r.importSummary?.keptAsCode, "import keptAsCode").toBe(0)
      await expectStored(docSubmit, fx, 2, "import fence")
    }, 120_000)

    test(`${name}: studio_write {diagram} and studio_edit append [{diagram}] store the spec unchanged`, async () => {
      const sections = [
        { heading: "Pendahuluan", blocks: ["Paragraf pembuka sintetis alfa bravo charlie."] },
        { heading: "Uraian uji bawa", blocks: ["Paragraf sintetis sebelum diagram.", { diagram: { spec: hh.clone(fx.spec), caption: fx.caption, source: fx.source } }] },
      ]
      const w = await h.call("studio_write", { mission: MISSION, docKey: `visna-${name.slice(-1)}-write`, template: "datum-nota", meta: hh.META, sections })
      ok(w, "write")
      docWrite = String(w.documentId)
      await expectStored(docWrite, fx, 1, "write")
      const e = await h.call("studio_edit", { documentId: docWrite, edits: [{ section: "Pendahuluan", append: [{ diagram: { spec: hh.clone(fx.spec), caption: fx.caption, source: fx.source } }] }], change: hh.CHANGE })
      ok(e, "edit append")
      await expectStored(docWrite, fx, 2, "edit append")
    }, 120_000)

    test(`${name}: a style-only studio_figure_revise round-trips with no FIGURE_GRAPH_DELTA; get shows the patch and every other field`, async () => {
      expect(docWrite).not.toBe("")
      const before = hh.diagramsOf(await h.content(docWrite))
      expect(before).toHaveLength(2)
      // Style only: jumps flipped; on the first edge the end-head size and label position change. Arrays replace whole.
      const edges = hh.clone(fx.spec.edges) as J[]
      edges[0].arrow_end_size = edges[0].arrow_end_size === "s" ? "l" : "s"
      edges[0].label_at = edges[0].label_at === "end" ? "start" : "end"
      const patch = { spec: { jumps: fx.spec.jumps === "off" ? "on" : "off", edges } }
      const r = await h.call("studio_figure_revise", { documentId: docWrite, pid: String(before[0].id), patch, change: hh.CHANGE, preview: false })
      ok(r, "figure_revise")
      expect(r.graphDelta, "graphDelta").toBeUndefined()
      expect(String(r._text)).not.toContain("FIGURE_GRAPH_DELTA")
      const want = { ...hh.clone(fx.spec), ...patch.spec }
      const after = hh.diagramsOf(await h.content(docWrite)).map((d) => hh.canon(d.spec)).sort()
      expect(after).toEqual([hh.canon(want), hh.canon(fx.spec)].sort())
      // the revised spec still carries every 1.2.8 field the fixture had
      expect([...carryFieldsOf(want)].sort()).toEqual([...carryFieldsOf(fx.spec)].sort())
    }, 120_000)
  }
})
