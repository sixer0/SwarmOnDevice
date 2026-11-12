// Swarm 1.2.6 row 73 (W-05/OFF-06, register N-023; W-03, register N-020..N-022).
// W-05: studio_figure_revise reports FIGURE_GRAPH_DELTA (nodes/edges added, removed, rewired vs the base revision) so a
// shape patch that silently drops an edge is visible. A REPORT, never a refusal: the PATCH is still sent.
// W-03: the figure preview splits its issues into `notices` (engine adapted) and `defects` (agent must fix).
// Before (e363918a69): the revise result carried no delta and the preview only a flat `issues` list.
import { describe, expect, test } from "bun:test"
import { useStudioEnv } from "../ported/_env"
useStudioEnv()
import path from "node:path"
import { readFileSync } from "node:fs"
import type { HttpFetch } from "../../vendor/scripts/studio/_http-client"
import { connect, reply } from "../ported/mcp/mcp-harness"
import * as tools from "../../vendor/scripts/studio/mcp/figure-tools"

type Rec = Record<string, any>

const PKG = path.resolve(import.meta.dir, "..", "..")
const fig = await import(path.join(PKG, "src", "mcp-host", "local-api", "routes", "figure-preview-figure.ts"))
const compose = await import(path.join(PKG, "vendor", "src", "lib", "studio", "services", "compose", "index.ts"))

const DOC = "cmvdoc0000000000000000073"
const AGENT = "cod-row73"
const env = { STUDIO_AGENT_ID: AGENT }
const PID = "fig-diag-73"
const CHANGE = { what: "bentuk simpul diganti", why: "uji W-05", impact: "Gambar 1.1" }
const R16_PATH = `/api/studio/documents/${DOC}/paragraphs/${PID}`
const PREVIEW_PATH = `/api/studio/documents/${DOC}/figures/preview`

const SPEC = () => ({
  $schema: "https://example.invalid/studio.diagram/v1.json",
  family: "flow",
  id: "d-73",
  title: "Alur uji",
  classification: "TERBATAS",
  width_mm: 160,
  sources: ["Uji"],
  nodes: [
    { id: "a", label: "A" },
    { id: "b", label: "B" },
    { id: "c", label: "C" },
  ],
  edges: [
    { from: "a", to: "b", kind: "solid", label: "" },
    { from: "b", to: "c", kind: "solid", label: "" },
  ],
})
const BLOCK = () => ({ id: PID, type: "diagram", spec: SPEC(), caption: { text: "Alur" }, source: { text: "Uji" } })

function routes(content: Rec = BLOCK()) {
  const calls: { method: string; url: string; body?: any }[] = []
  const f: HttpFetch = async (url, init) => {
    const body = init.body ? JSON.parse(init.body) : undefined
    calls.push({ method: init.method, url, body })
    const p = `${init.method} ${new URL(url).pathname}`
    if (p === `GET /api/studio/documents/${DOC}`) return reply({ status: 200, body: { document: { id: DOC, docNumber: "073/GSP/KT/XI/2026", createdBy: `agent:${AGENT}`, currentRevisionNo: 3 }, revision: { revisionNo: 3 } } })
    if (p === `GET ${R16_PATH}`) return reply({ status: 200, body: { pid: PID, kind: "BLOCK", address: "1.1.2", type: "diagram", content, revisionNo: 3 } })
    if (p === `PATCH ${R16_PATH}`) return reply({ status: 200, body: { revision: { revisionNo: 4, changeScope: `pid:${PID}` }, pid: PID, rebased: false, baseRevisionNo: 3 } })
    if (p === `POST ${PREVIEW_PATH}`) return reply({ status: 200, body: { documentId: DOC, revisionNo: 4, currentRevisionNo: 4, rendered: false, error: "uji" } })
    return reply({ status: 404, body: { error: "tidak ada", code: "ROUTE_NOT_FOUND" } })
  }
  return { f, patches: () => calls.filter((c) => c.method === "PATCH") }
}

describe("W-05 FIGURE_GRAPH_DELTA in studio_figure_revise", () => {
  test("a shape patch that drops an edge reports the edge count before and after; the write still goes ahead", async () => {
    const m = routes()
    const { call } = await connect({ fetch: m.f, env })
    // A "shape" patch: the agent resends edges with one missing (the silent loss of W-05).
    const r = await call("studio_figure_revise", { documentId: DOC, pid: PID, baseRevisionNo: 3, change: CHANGE, patch: { spec: { edges: [{ from: "a", to: "b", kind: "solid", label: "" }] } }, preview: false })
    expect(r.data.ok).not.toBe(false)
    expect(m.patches()).toHaveLength(1)
    expect(r.data.graphDelta?.code).toBe("FIGURE_GRAPH_DELTA")
    expect(r.data.graphDelta.edges).toMatchObject({ before: 2, after: 1, removed: ["b->c"], added: [], rewired: [] })
    expect(r.data.graphDelta.nodes).toMatchObject({ before: 3, after: 3, added: [], removed: [] })
    expect(r.text).toContain("FIGURE_GRAPH_DELTA: simpul 3→3, tepi 2→1")
    expect(r.text).toContain("tepi dihapus: b->c")
    // ids come from stored content: only inside the untrusted block, and the field is flagged untrusted.
    expect(r.data.untrustedFields).toContain("graphDelta")
  })

  test("nodes added/removed and a rewired edge are named", () => {
    const after = BLOCK()
    after.spec.nodes = [
      { id: "a", label: "A" },
      { id: "b", label: "B" },
      { id: "d", label: "D" },
    ]
    after.spec.edges = [
      { from: "a", to: "b", kind: "solid", label: "" },
      { from: "b", to: "d", kind: "solid", label: "" },
    ]
    const d = tools.figureGraphDelta(BLOCK(), after)
    expect(d).toEqual({
      code: "FIGURE_GRAPH_DELTA",
      nodes: { before: 3, after: 3, added: ["d"], removed: ["c"] },
      edges: { before: 2, after: 2, added: [], removed: [], rewired: ["b->c => b->d"] },
    })
  })

  test("no graph change (caption-only patch) gives no delta and no line", async () => {
    expect(tools.figureGraphDelta(BLOCK(), { ...BLOCK(), caption: { text: "Lain" } })).toBeNull()
    const m = routes()
    const { call } = await connect({ fetch: m.f, env })
    const r = await call("studio_figure_revise", { documentId: DOC, pid: PID, baseRevisionNo: 3, change: CHANGE, patch: { caption: "Alur baru" }, preview: false })
    expect(r.data.ok).not.toBe(false)
    expect(r.data.graphDelta).toBeUndefined()
    expect(r.text).not.toContain("FIGURE_GRAPH_DELTA")
  })

  test("a chart graph (data.links) is covered too", () => {
    const chart = (links: Rec[]) => ({ type: "chart", data: { shape: "graph", nodes: [{ id: "x", label: "X" }, { id: "y", label: "Y" }], links } })
    const d = tools.figureGraphDelta(chart([{ from: "x", to: "y" }]), chart([]))
    expect(d?.edges).toMatchObject({ before: 1, after: 0, removed: ["x->y"] })
  })
})

describe("W-03 preview splits notices and defects", () => {
  test("EDGE_LANES is a notice and GEOM_ENTRY_COLLISION a defect", () => {
    const issues = [
      { checkId: "EDGE_LANES", status: "REPORT", detail: "lajur", suggest: null, suggestSource: null, info: false },
      { checkId: "GEOM_ENTRY_COLLISION", status: "REPORT", detail: "tabrak", suggest: null, suggestSource: null, info: false },
    ]
    const s = fig.splitPreviewIssues(issues)
    expect(s.notices.map((i: Rec) => i.checkId)).toEqual(["EDGE_LANES"])
    expect(s.defects.map((i: Rec) => i.checkId)).toEqual(["GEOM_ENTRY_COLLISION"])
  })

  test("the class table follows register N-020", () => {
    for (const c of ["EDGE_LANES", "LABEL_MOVED", "AUTO_FIT", "VALUE_LABEL_MOVED", "ELK_LAYOUT"]) expect(fig.previewIssueClass(c, "REPORT")).toBe("notice")
    for (const c of ["CAPTION_WRAP", "LABEL_LEADER", "TEXT_OUTSIDE", "GEOM_TEXT_OVERLAP", "GEOM_STUB_SEGMENT", "FLOW_SERIALISED"]) expect(fig.previewIssueClass(c, "REPORT")).toBe("defect")
    expect(fig.previewIssueClass("EDGE_LANES", "FAIL")).toBe("defect")
    expect(fig.PREVIEW_ISSUE_CLASS.EDGE_LANES).toBe("notice")
  })

  test("a rendered preview carries notices and defects that partition its issues", async () => {
    const CASE04 = JSON.parse(readFileSync(path.join(PKG, "test", "engine-rev-a", "row165c", "fixtures", "row165c_case04_block.json"), "utf8"))
    const content = compose.mapBlock(CASE04, "fig-diagram-41", { glyphs: compose.glyphSet(undefined), params: {}, classification: "TERBATAS", artifactLabel: "Gambar 4.1" })
    const block = { blockId: "fig-diagram-41", pid: "fig-diagram-41", address: "4.1.1", ordinal: 0, unitKey: "", type: CASE04.type, content, textPlain: "", contentSha256: "", artifactLabel: "Gambar 4.1" }
    const p = await fig.renderFigure(block, { params: {} } as any, { inline: false, withSvg: false })
    expect(Array.isArray(p.notices)).toBe(true)
    expect(Array.isArray(p.defects)).toBe(true)
    expect(p.notices.length + p.defects.length).toBe(p.issues.length)
  })

  test("the preview tool text states the defect and notice counts", () => {
    const b = { revisionNo: 4, currentRevisionNo: 4, rendered: true, figure: { type: "diagram", code: "flow", pid: PID, address: "1.1.2", size: {}, issues: [{ checkId: "EDGE_LANES" }, { checkId: "GEOM_ENTRY_COLLISION" }], issueCount: 2, layoutIssueCount: 2, notices: [{ checkId: "EDGE_LANES" }], defects: [{ checkId: "GEOM_ENTRY_COLLISION" }] } }
    expect(tools.previewLines(DOC, b).join("\n")).toContain("cacat 1, catatan 1")
  })
})
