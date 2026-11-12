// Swarm 1.2.6 row 69 (T-16, register E-17/E-18): studio_figure_revise deep-merges a `spec` patch into the stored
// diagram spec. Objects merge key by key, arrays replace, `null` removes a key. A spec patch that leaves a required
// diagram key (diagram.schema.ts `required`) missing is refused SCHEMA_INVALID naming the key, before any PATCH.
// Before (e363918a69): mergeFigurePatch replaced `spec` wholesale, so a nodes-only patch dropped family/edges/title.
import { describe, expect, test } from "bun:test"
import { useStudioEnv } from "../ported/_env"
useStudioEnv()
import type { HttpFetch } from "../../vendor/scripts/studio/_http-client"
import { connect, reply } from "../ported/mcp/mcp-harness"
import { mergeFigurePatch } from "../../vendor/scripts/studio/mcp/figure-tools"

type Rec = Record<string, any>

const DOC = "cmvdoc0000000000000000069"
const AGENT = "cod-row69"
const env = { STUDIO_AGENT_ID: AGENT }
const PID = "fig-diag-1"
const CHANGE = { what: "simpul diganti", why: "uji T-16", impact: "Gambar 1.1" }
const R16_PATH = `/api/studio/documents/${DOC}/paragraphs/${PID}`
const PREVIEW_PATH = `/api/studio/documents/${DOC}/figures/preview`

const SPEC = () => ({
  $schema: "https://example.invalid/studio.diagram/v1.json",
  family: "flow",
  id: "d-1",
  title: "Alur uji",
  classification: "TERBATAS",
  width_mm: 160,
  sources: ["Uji"],
  nodes: [
    { id: "a", label: "A" },
    { id: "b", label: "B" },
  ],
  edges: [{ from: "a", to: "b" }],
  sld: { multiBus: false },
})
const BLOCK = () => ({ id: PID, type: "diagram", spec: SPEC(), caption: { text: "Alur" }, source: { text: "Uji" } })
const NEW_NODES = [
  { id: "a", label: "A" },
  { id: "c", label: "C" },
]

describe("T-16 mergeFigurePatch deep-merges spec", () => {
  test("nodes-only patch keeps family, edges, title and every other spec key; nodes array replaced", () => {
    const out = mergeFigurePatch(BLOCK(), { spec: { nodes: NEW_NODES } })
    expect(out.spec).toEqual({ ...SPEC(), nodes: NEW_NODES })
    expect((out.spec as Rec).family).toBe("flow")
    expect((out.spec as Rec).edges).toEqual([{ from: "a", to: "b" }])
  })

  test("edges-only patch replaces the edges array (no element merge); nested object merges", () => {
    const out = mergeFigurePatch(BLOCK(), { spec: { edges: [{ from: "b", to: "a" }], sld: { multiBus: true } } })
    expect((out.spec as Rec).edges).toEqual([{ from: "b", to: "a" }])
    expect((out.spec as Rec).sld).toEqual({ multiBus: true })
    expect((out.spec as Rec).nodes).toEqual(SPEC().nodes)
  })

  test("null inside spec removes an optional key; the input content is not mutated", () => {
    const content = BLOCK()
    const out = mergeFigurePatch(content, { spec: { edges: null } })
    expect("edges" in (out.spec as Rec)).toBe(false)
    expect(content.spec.edges).toEqual([{ from: "a", to: "b" }])
  })

  test("a spec patch that removes a required key is SCHEMA_INVALID naming the key", () => {
    let err: any = null
    try {
      mergeFigurePatch(BLOCK(), { spec: { family: null } })
    } catch (e) {
      err = e
    }
    expect(err?.code).toBe("SCHEMA_INVALID")
    expect(String(err?.message)).toContain("family")
  })

  test("prototype keys inside spec are never copied", () => {
    const out = mergeFigurePatch(BLOCK(), { spec: JSON.parse('{"__proto__":{"polluted":1},"title":"Baru"}') })
    expect((out.spec as Rec).title).toBe("Baru")
    expect(({} as Rec).polluted).toBeUndefined()
    expect(Object.prototype.hasOwnProperty.call(out.spec, "__proto__")).toBe(false)
  })
})

function routes(content: Rec = BLOCK()) {
  const calls: { method: string; url: string; body?: any }[] = []
  const f: HttpFetch = async (url, init) => {
    const body = init.body ? JSON.parse(init.body) : undefined
    calls.push({ method: init.method, url, body })
    const p = `${init.method} ${new URL(url).pathname}`
    if (p === `GET /api/studio/documents/${DOC}`) return reply({ status: 200, body: { document: { id: DOC, docNumber: "069/GSP/KT/XI/2026", createdBy: `agent:${AGENT}`, currentRevisionNo: 3 }, revision: { revisionNo: 3 } } })
    if (p === `GET ${R16_PATH}`) return reply({ status: 200, body: { pid: PID, kind: "BLOCK", address: "1.1.2", type: "diagram", content, revisionNo: 3 } })
    if (p === `PATCH ${R16_PATH}`) return reply({ status: 200, body: { revision: { revisionNo: 4, changeScope: `pid:${PID}` }, pid: PID, rebased: false, baseRevisionNo: 3 } })
    if (p === `POST ${PREVIEW_PATH}`) return reply({ status: 200, body: { documentId: DOC, revisionNo: 4, currentRevisionNo: 4, rendered: false, error: "uji" } })
    return reply({ status: 404, body: { error: "tidak ada", code: "ROUTE_NOT_FOUND" } })
  }
  return { f, patches: () => calls.filter((c) => c.method === "PATCH") }
}

describe("T-16 studio_figure_revise partial spec", () => {
  test("patch {spec:{nodes}} sends the full merged spec (family and edges kept)", async () => {
    const m = routes()
    const { call } = await connect({ fetch: m.f, env })
    const r = await call("studio_figure_revise", { documentId: DOC, pid: PID, baseRevisionNo: 3, change: CHANGE, patch: { spec: { nodes: NEW_NODES } }, preview: false })
    expect(r.data.ok).not.toBe(false)
    expect(m.patches()).toHaveLength(1)
    expect(m.patches()[0].body.block).toEqual({ ...BLOCK(), spec: { ...SPEC(), nodes: NEW_NODES } })
  })

  test("caption-only patch still works and leaves spec untouched", async () => {
    const m = routes()
    const { call } = await connect({ fetch: m.f, env })
    const r = await call("studio_figure_revise", { documentId: DOC, pid: PID, baseRevisionNo: 3, change: CHANGE, patch: { caption: "Alur baru" }, preview: false })
    expect(r.data.ok).not.toBe(false)
    expect(m.patches()[0].body.block).toEqual({ ...BLOCK(), caption: { text: "Alur baru" } })
  })

  test("a spec patch leaving a required key missing is refused SCHEMA_INVALID naming it, with no PATCH", async () => {
    const m = routes()
    const { call } = await connect({ fetch: m.f, env })
    const r = await call("studio_figure_revise", { documentId: DOC, pid: PID, baseRevisionNo: 3, change: CHANGE, patch: { spec: { title: null } }, preview: false })
    expect(r.data.ok).toBe(false)
    expect(r.data.error.code).toBe("SCHEMA_INVALID")
    expect(r.text).toContain("title")
    expect(m.patches()).toEqual([])
  })
})
