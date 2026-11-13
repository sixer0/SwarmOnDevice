// Swarm 1.2.8 row 52 (AC-VIS0a, AC-VIS0b; F-VISIO 01f §2.1, §3.1, §4.1, §8; register N8-369, N8-473, N8-474; C12
// OP-18-1). One file for VIS-0 with four describes: "schema" and "guide" (row 52), "char" (row 52b), "carry" (row 33b).
// Red at BASE e1f9673772: the new fields are refused SCHEMA_INVALID, the bounds and the second resource do not exist.
// The "guide" host part binds 127.0.0.1 port 0 (run with the command sandbox off).
// Namespace imports: at BASE some names do not exist, so the red run fails on assertions, not on a link error.
import { useStudioEnv } from "../ported/_env"
useStudioEnv()
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs"
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
    for (const t of TOOLS as Array<{ name: string; description: string }>) expect(t.description.length, t.name).toBeLessThanOrEqual(450)
    console.log(`[rel128-vis0] longest vendor description ${Math.max(...(TOOLS as Array<{ description: string }>).map((t) => t.description.length))}, longest host description ${Math.max(...tools.map((t) => (t.description ?? "").length))}`)
  })
})
