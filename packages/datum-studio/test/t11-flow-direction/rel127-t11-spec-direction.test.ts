// Swarm 1.2.7 row 39 (T-11 + SF-2, N7-107; 01c T-11): every partial `spec` patch on an INLINE v2 diagram block works.
// Root cause at 04067a9d02: mergeFigurePatch checked the merged spec against the v1 diagram `required`
// ($schema, id, title, classification, width_mm, sources), which an inline v2 spec never has, so
// {spec:{direction:"LR"}} and even a nodes-only patch were refused SCHEMA_INVALID. Now a spec without `$schema`
// is checked against INLINE_V2_DIAGRAM_REQUIRED (= the v2 DiagramSpecV2 `required`), a v1 spec as before.
// Red at 04067a9d02: (1), (2), (4) and the pin fail. Fixture: test/fixtures/syn127/t11_flow_inline_v2.json.
import { describe, expect, test } from "bun:test"
import { useStudioEnv } from "../ported/_env"
useStudioEnv()
import { readFileSync } from "node:fs"
import path from "node:path"
import type { HttpFetch } from "../../vendor/scripts/studio/_http-client"
import { connect, reply } from "../ported/mcp/mcp-harness"
import * as ft from "../../vendor/scripts/studio/mcp/figure-tools"

type Rec = Record<string, any>

const PKG = path.resolve(import.meta.dir, "..", "..")
const V = path.join(PKG, "vendor", "src", "lib", "studio")
const fig = await import(path.join(PKG, "src", "mcp-host", "local-api", "routes", "figure-preview-figure.ts"))
const compose = await import(path.join(V, "services", "compose", "index.ts"))
const elk = await import(path.join(V, "engine", "diagram", "elk", "index.ts"))
const { commonV2Schema } = await import(path.join(V, "contract", "schema", "v2", "common.schema.ts"))

const FIXTURE = JSON.parse(readFileSync(path.join(PKG, "test", "fixtures", "syn127", "t11_flow_inline_v2.json"), "utf8"))
const STORED = (): Rec => structuredClone(FIXTURE.block)

const DOC = "cmvdoc0000000000000000127"
const AGENT = "cod-row39"
const PID = "fig-flow-139"
const CHANGE = { what: "arah alur", why: "uji T-11", impact: "Gambar 1.1" }
const R16_PATH = `/api/studio/documents/${DOC}/paragraphs/${PID}`
const PREVIEW_PATH = `/api/studio/documents/${DOC}/figures/preview`

/** mergeFigurePatch with a loose result type for the assertions. */
const merge = (content: Rec, patch: Rec): Rec => ft.mergeFigurePatch(content, patch) as Rec

function thrown(fn: () => unknown): any {
  try {
    fn()
  } catch (e) {
    return e
  }
  return null
}

/** Template width 166 mm (fixture note: an LR flow of 4 ranks fits 166 mm; the 128 mm default allows 3 LR ranks). */
const PARAMS = { "diagram.widthMm": 166 }
const TPL = { params: PARAMS } as any

/** The store's normalized block for a v2 diagram block (as compose writes it). */
function normBlock(block: Rec) {
  const content = compose.mapBlock(block, PID, { glyphs: compose.glyphSet(undefined), params: PARAMS, classification: "TERBATAS", artifactLabel: "Gambar 1.1" })
  return { blockId: PID, pid: PID, address: "1.1.1", ordinal: 0, unitKey: "", type: block.type, content, textPlain: "", contentSha256: "", artifactLabel: "Gambar 1.1" }
}

describe("T-11 unit: mergeFigurePatch on an inline v2 diagram spec", () => {
  test("pin: INLINE_V2_DIAGRAM_REQUIRED equals the v2 DiagramSpecV2 required list", () => {
    expect([...ft.INLINE_V2_DIAGRAM_REQUIRED]).toEqual(["family", "nodes"])
    expect([...ft.INLINE_V2_DIAGRAM_REQUIRED]).toEqual([...commonV2Schema.$defs.DiagramSpecV2.required])
  })

  test("(1) {spec:{direction:'LR'}} keeps family, nodes and edges and sets direction LR", () => {
    const stored = STORED()
    const out = merge(stored, { spec: { direction: "LR" } })
    expect(out.spec.direction).toBe("LR")
    expect(out.spec.family).toBe("flow")
    expect(out.spec.nodes).toEqual(stored.spec.nodes)
    expect(out.spec.edges).toEqual(stored.spec.edges)
    expect(out.caption).toEqual(stored.caption)
    expect(stored.spec.direction).toBeUndefined()
  })

  test("(2) T-16 promise on inline v2: a nodes-only patch and an edges-only patch succeed and keep the rest", () => {
    const stored = STORED()
    const nodes = stored.spec.nodes.slice(0, 4)
    const n = merge(stored, { spec: { nodes } })
    expect(n.spec.nodes).toEqual(nodes)
    expect(n.spec.edges).toEqual(stored.spec.edges)
    expect(n.spec.family).toBe("flow")
    const edges = stored.spec.edges.slice(0, 3)
    const e = merge(stored, { spec: { edges } })
    expect(e.spec.edges).toEqual(edges)
    expect(e.spec.nodes).toEqual(stored.spec.nodes)
    expect(e.spec.labels_verified).toBe(true)
  })

  test("(3) {spec:{nodes:null}} and {spec:{family:null}} are still refused SCHEMA_INVALID naming the key", () => {
    const a = thrown(() => merge(STORED(), { spec: { nodes: null } }))
    expect(a?.code).toBe("SCHEMA_INVALID")
    expect(String(a?.message)).toContain("nodes")
    const b = thrown(() => merge(STORED(), { spec: { family: null } }))
    expect(b?.code).toBe("SCHEMA_INVALID")
    expect(String(b?.message)).toContain("family")
  })

  test("CHAR: a v1 spec (with $schema) is still checked against the v1 required set; full v1 merge unchanged", () => {
    const v1 = { spec: { $schema: "https://example.invalid/studio.diagram/v1.json", id: "d-1", title: "Alur", classification: "TERBATAS", width_mm: 160, sources: ["Uji"], family: "flow", nodes: [{ id: "a" }, { id: "b" }], edges: [{ from: "a", to: "b" }] } }
    const ok = merge(v1, { spec: { direction: "LR" } })
    expect(ok.spec).toEqual({ ...v1.spec, direction: "LR" })
    const err = thrown(() => merge(v1, { spec: { title: null } }))
    expect(err?.code).toBe("SCHEMA_INVALID")
    expect(String(err?.message)).toContain("title")
  })
})

function routes(content: Rec) {
  const calls: { method: string; url: string; body?: any }[] = []
  const previews: Rec[] = []
  const f: HttpFetch = async (url, init) => {
    const body = init.body ? JSON.parse(init.body) : undefined
    calls.push({ method: init.method, url, body })
    const p = `${init.method} ${new URL(url).pathname}`
    if (p === `GET /api/studio/documents/${DOC}`) return reply({ status: 200, body: { document: { id: DOC, docNumber: "000/SYN/KT/XI/2026", createdBy: `agent:${AGENT}`, currentRevisionNo: 3 }, revision: { revisionNo: 3 } } })
    if (p === `GET ${R16_PATH}`) return reply({ status: 200, body: { pid: PID, kind: "BLOCK", address: "1.1.1", type: "diagram", content, revisionNo: 3 } })
    if (p === `PATCH ${R16_PATH}`) return reply({ status: 200, body: { revision: { revisionNo: 4, changeScope: `pid:${PID}` }, pid: PID, rebased: false, baseRevisionNo: 3 } })
    if (p === `POST ${PREVIEW_PATH}`) {
      // The real preview renderer on the block the tool just wrote (the store is mocked, the engine is not).
      const written = calls.filter((c) => c.method === "PATCH").at(-1)?.body.block
      const figure = await fig.renderFigure(normBlock(written), TPL, { inline: false, withSvg: false, lang: "ID" })
      previews.push(figure)
      return reply({ status: 200, body: { documentId: DOC, revisionNo: 4, currentRevisionNo: 4, rendered: true, figure } })
    }
    return reply({ status: 404, body: { error: "tidak ada", code: "ROUTE_NOT_FOUND" } })
  }
  return { f, patches: () => calls.filter((c) => c.method === "PATCH"), previews }
}

describe("T-11 host: studio_figure_revise on the stored inline v2 flow", () => {
  test("(4) patch {spec:{direction:'LR'}} -> OK, stored direction LR, preview with 0 defects (no GEOM_*)", async () => {
    const m = routes(STORED())
    const { call } = await connect({ fetch: m.f, env: { STUDIO_AGENT_ID: AGENT } })
    const r = await call("studio_figure_revise", { documentId: DOC, pid: PID, baseRevisionNo: 3, change: CHANGE, patch: { spec: { direction: "LR" } } })
    expect(r.data.ok).not.toBe(false)
    expect(m.patches()).toHaveLength(1)
    const block = m.patches()[0].body.block
    expect(block.spec).toEqual({ ...STORED().spec, direction: "LR" })
    expect(m.previews).toHaveLength(1)
    const p = m.previews[0]
    expect(p.defects).toEqual([])
    expect(p.issues.filter((i: Rec) => String(i.checkId).startsWith("GEOM_"))).toEqual([])
    expect(r.data.figure.defects).toEqual([])
  })

  test("a top-level `direction` key stays refused INVALID_ARGUMENT, and the refusal names the spec route", async () => {
    const m = routes(STORED())
    const { call } = await connect({ fetch: m.f, env: { STUDIO_AGENT_ID: AGENT } })
    const r = await call("studio_figure_revise", { documentId: DOC, pid: PID, baseRevisionNo: 3, change: CHANGE, patch: { direction: "LR" } })
    expect(r.data.ok).toBe(false)
    expect(r.data.error.code).toBe("INVALID_ARGUMENT")
    expect(r.text).toContain('arah alur lewat patch {spec:{direction:"LR"}}')
    expect(m.patches()).toEqual([])
  })
})

describe("T-11 engine: the LR spec at 166 mm is drawn left to right", () => {
  test("(5) buildDiagramSvgAuto: every edge source x < target x", async () => {
    const merged = merge(STORED(), { spec: { direction: "LR" } })
    const f = await fig.resolveFigure(normBlock(merged))
    const r = await elk.buildDiagramSvgAuto({ ...f.spec, width_mm: 166 }, { release: false })
    const x = new Map<string, number>()
    for (const mm of r.svg.matchAll(/<rect\b([^>]*\bdata-mark="node"[^>]*)\/>/g)) {
      const id = /data-node="([^"]*)"/.exec(mm[1])?.[1]
      const xs = /\bx="([^"]*)"/.exec(mm[1])?.[1]
      if (id !== undefined && xs !== undefined) x.set(id, Number(xs))
    }
    expect([...x.keys()].sort()).toEqual(["a", "b", "c", "d", "e"])
    for (const e of FIXTURE.block.spec.edges) expect(x.get(e.from)!).toBeLessThan(x.get(e.to)!)
    expect(new Set(x.values()).size).toBeGreaterThan(1)
  })
})
