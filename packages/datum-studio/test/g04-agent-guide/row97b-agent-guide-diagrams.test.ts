// Row 97b (G-04 diagram part, G-01; 1.2.6): the diagram section of vendor/docs/STUDIO-AGENT-GUIDE.md.
// At e363918a69 the guide had no word on studio_figure_preview / studio_figure_revise, `direction`, the caption
// token rule, the three connector-end FAIL kinds or FIGURE_GRAPH_DELTA, and it linked a STUDIO-MCP.md that is not
// shipped. Every call shape, code and number the section quotes is checked against the HEAD code here, so the
// guide cannot drift from the tools. Modules are imported dynamically: at the base some exports do not exist.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

const VENDOR = path.join(import.meta.dir, "..", "..", "vendor")
const GUIDE = readFileSync(path.join(VENDOR, "docs", "STUDIO-AGENT-GUIDE.md"), "utf8")
const start = GUIDE.indexOf("#### 4.1.2 ")
const SECTION = start < 0 ? "" : GUIDE.slice(start, GUIDE.indexOf("\n### 4.2 ", start))
const flat = SECTION.replace(/\s+/g, " ")
const mm = (n: number) => n.toFixed(1).replace(".", ",")

/** Property names of an MCP tool's input schema. */
async function toolProps(name: string): Promise<string[]> {
  const { TOOLS } = await import("../../vendor/scripts/studio/mcp/tools")
  const tool = TOOLS.find((t) => t.name === name)
  return Object.keys((tool?.inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {})
}

describe("row 97b: the diagram section exists and the workflow runs in order", () => {
  test("section 4.1.2 sits between 4.1.1 and 4.2", () => {
    expect(start).toBeGreaterThan(GUIDE.indexOf("#### 4.1.1 "))
    expect(SECTION).toContain("#### 4.1.2 Diagram lewat MCP")
  })

  test("preview inline -> revise partial -> FIGURE_GRAPH_DELTA -> render -> look at the PNG", () => {
    const steps = ["**Pratinjau inline.**", "**Revisi sebagian.**", "**Baca `FIGURE_GRAPH_DELTA`.**", "**Render.**", "**Lihat PNG-nya.**"].map((s) => flat.indexOf(s))
    expect(steps.every((i) => i >= 0)).toBe(true)
    expect([...steps].sort((a, b) => a - b)).toEqual(steps)
    // FX-10 (C19a): the shared figure-gate sentence; a clean preview alone is not done.
    expect(flat).toContain("figur selesai hanya setelah gerbang mesin DAN gerbang mata atas PNG hasil render")
    expect(flat).toContain("Pratinjau bersih saja belum selesai")
  })
})

describe("row 97b: every call shape quoted exists in the HEAD tools", () => {
  test("studio_figure_preview { documentId, block | pid | address }", async () => {
    expect(flat).toContain("studio_figure_preview { documentId, block }")
    const props = await toolProps("studio_figure_preview")
    for (const k of ["documentId", "block", "pid", "address"]) expect(props).toContain(k)
  })

  test("studio_figure_revise { documentId, pid | address, patch, baseRevisionNo, change }; diagram patch keys", async () => {
    expect(flat).toContain("studio_figure_revise { documentId, pid | address, patch, baseRevisionNo, change }")
    const props = await toolProps("studio_figure_revise")
    for (const k of ["documentId", "pid", "address", "patch", "baseRevisionNo", "change"]) expect(props).toContain(k)
    const { DIAGRAM_PATCH_KEYS } = await import("../../vendor/scripts/studio/mcp/figure-tools")
    expect(flat).toContain(`hanya boleh memuat ${DIAGRAM_PATCH_KEYS.map((k) => `\`${k}\``).join(", ").replace(/, (`[^`]+`)$/, ", $1")}`)
  })

  test("partial revise: spec deep-merged, arrays replaced, missing required key SCHEMA_INVALID", async () => {
    const ft = await import("../../vendor/scripts/studio/mcp/figure-tools")
    const { diagramSchema } = await import("../../vendor/src/lib/studio/contract/schema/diagram.schema")
    const required = Object.fromEntries((diagramSchema.required as readonly string[]).map((k) => [k, "x"]))
    const stored = { spec: { ...required, family: "flow", direction: "TB", nodes: [{ id: "a" }, { id: "b" }], edges: [{ from: "a", to: "b" }] } }
    const out = ft.mergeFigurePatch(stored, { spec: { nodes: [{ id: "a" }] } }) as { spec: Record<string, unknown> }
    expect(out.spec.family).toBe("flow")
    expect(out.spec.direction).toBe("TB")
    expect(out.spec.edges).toEqual(stored.spec.edges)
    expect(out.spec.nodes).toEqual([{ id: "a" }])
    expect(() => ft.mergeFigurePatch(stored, { spec: { nodes: null } })).toThrow(/nodes/)
    expect(flat).toContain("larik diganti utuh")
    expect(flat).toContain("`SCHEMA_INVALID` dengan nama medan itu")
  })

  test("FIGURE_GRAPH_DELTA field names match figureGraphDelta", async () => {
    const { figureGraphDelta } = await import("../../vendor/scripts/studio/mcp/figure-tools")
    expect(typeof figureGraphDelta).toBe("function")
    const d = figureGraphDelta({ spec: { nodes: [{ id: "a" }, { id: "b" }], edges: [{ from: "a", to: "b" }] } }, { spec: { nodes: [{ id: "a" }, { id: "b" }, { id: "c" }], edges: [{ from: "a", to: "c" }] } })
    expect(d?.code).toBe("FIGURE_GRAPH_DELTA")
    expect(d?.edges.rewired).toEqual(["a->b => a->c"])
    for (const k of ["nodes.added", "nodes.removed", "edges.added", "edges.removed", "edges.rewired"]) {
      const [g, f] = k.split(".")
      expect(Object.keys((d as unknown as Record<string, Record<string, unknown>>)[g])).toContain(f)
      expect(flat).toContain(`\`${k}\``)
    }
    expect(flat).toContain("structuredContent.graphDelta")
    expect(flat).toContain("bukan penolakan")
  })

  test("studio_render { documentId, scope, key, figures: [\"png\"] } and studio_file_verify { fileId, downloadDir }", async () => {
    expect(flat).toContain('studio_render { documentId, scope: "chapter", key, figures: ["png"] }')
    const render = await toolProps("studio_render")
    for (const k of ["documentId", "scope", "key", "figures"]) expect(render).toContain(k)
    expect(flat).toContain("studio_file_verify { fileId, downloadDir }")
    const verify = await toolProps("studio_file_verify")
    for (const k of ["fileId", "downloadDir"]) expect(verify).toContain(k)
    expect(flat).toContain("`pages:`")
  })

  test("defects and notices the section names are classed that way by the preview route", async () => {
    const { previewIssueClass } = await import("../../src/mcp-host/local-api/routes/figure-preview-figure")
    expect(typeof previewIssueClass).toBe("function")
    const defects = ["GEOM_ENTRY_COLLISION", "CAPTION_WRAP", "CAPTION_TRUNCATED", "LABEL_LEADER", "LABEL_DROPPED", "TEXT_OUTSIDE", "FLOW_SERIALISED"]
    const notices = ["EDGE_LANES", "LABEL_MOVED", "AUTO_FIT", "ELK_LAYOUT"]
    for (const c of defects) expect([c, previewIssueClass(c)]).toEqual([c, "defect"])
    for (const c of notices) expect([c, previewIssueClass(c)]).toEqual([c, "notice"])
    for (const c of [...defects.slice(1), ...notices]) expect(flat).toContain(`\`${c}\``)
  })
})

describe("row 97b: direction for parallel branches (T-11, T-02, T-08)", () => {
  test("TB/LR on flow only, FLOW_SERIALISED without direction", async () => {
    const { flowSerialisedNote } = await import("../../vendor/src/lib/studio/engine/diagram/layout-a/flow")
    const note = flowSerialisedNote({ family: "flow", nodes: [{ id: "a" }, { id: "b" }, { id: "c" }], edges: [{ from: "a", to: "b" }, { from: "a", to: "c" }] } as never)
    expect(note?.checkId).toBe("FLOW_SERIALISED")
    expect(flat).toContain('`spec.direction` bernilai `"TB"` (atas-bawah) atau `"LR"`')
    expect(flat).toContain('`family: "flow"`')
  })

  test("capacity numbers equal the engine limits at 128 and 166 mm", async () => {
    const flow = await import("../../vendor/src/lib/studio/engine/diagram/layout-a/flow")
    const { LATTICE_X } = await import("../../vendor/src/lib/studio/engine/diagram/core/tokens")
    expect(typeof flow.flowTbMaxPerRank).toBe("function")
    expect(flat).toContain(`TB ${flow.flowTbMaxPerRank(128, LATTICE_X)} / ${flow.flowTbMaxPerRank(166, LATTICE_X)} simpul per peringkat`)
    expect(flat).toContain(`LR ${flow.flowLrMaxRanks(128, LATTICE_X)} / ${flow.flowLrMaxRanks(166, LATTICE_X)} peringkat dan ${flow.FLOW_LR_MAX_PARALLEL} simpul per peringkat`)
    expect(flat).toContain("`DATUM-37-lebar`")
  })

  test("fan-out threshold, edge inset, P1-direction and the refused aliases", async () => {
    const { FANOUT_SPLIT_MIN } = await import("../../vendor/src/lib/studio/engine/diagram/build/route")
    const { GRAPH_EDGE_INSET_MM } = await import("../../vendor/src/lib/studio/engine/diagram/core/sheet")
    const { DIAGRAM_ALIASES } = await import("../../vendor/src/lib/studio/contract/schema/v2/refusal-hints")
    expect(flat).toContain(`Kipas ${FANOUT_SPLIT_MIN} tepi atau lebih`)
    expect(flat).toContain(`jarak ${GRAPH_EDGE_INSET_MM} mm`)
    expect(flat).toContain("`class.col: 0` sah")
    expect(flat).toContain('`BY_CONSTRUCTION_FAILED` (`checkId: "P1-direction"`)')
    const aliases = Object.entries(DIAGRAM_ALIASES.spec as Record<string, string>).filter(([, v]) => v === "direction").map(([k]) => k)
    expect(aliases.length).toBe(5)
    for (const a of aliases) expect(flat).toContain(`\`${a}\``)
  })
})

describe("row 97b: caption rules (T-01, W-01)", () => {
  test("token examples are the ones CAPTION_TOKEN_RE refuses; 100 is CAPTION_GUIDE_MAX_CHARS", async () => {
    const { CAPTION_TOKEN_RE } = await import("../../vendor/src/lib/studio/contract/schema/v2/figure-text")
    const { CAPTION_GUIDE_MAX_CHARS } = await import("../../vendor/src/lib/studio/contract/schema/figure-bounds")
    expect(CAPTION_TOKEN_RE).toBeInstanceOf(RegExp)
    for (const t of ["Gambar 3.1", "Figure 2", "Fig. 1", "Grafik 4", "Bagan 2", "Diagram 1"]) {
      expect(flat).toContain(`\`${t}\``)
      expect([t, CAPTION_TOKEN_RE.test(`${t} isi`)]).toEqual([t, true])
    }
    expect(flat).toContain("`CAPTION_TOKEN_DUPLICATE`")
    expect(flat).toContain(`maksimal ${CAPTION_GUIDE_MAX_CHARS} karakter (\`CAPTION_GUIDE_MAX_CHARS\`)`)
  })

  test("CAPTION_WRAP and CAPTION_TRUNCATED fail FIGURE_FIT", async () => {
    const { FIGURE_FIT_FAIL_NOTES } = await import("../../src/mcp-host/verify/static-checks")
    expect([...(FIGURE_FIT_FAIL_NOTES ?? [])].sort()).toEqual(["CAPTION_TRUNCATED", "CAPTION_WRAP"])
    expect(flat).toContain("gagal `FIGURE_FIT` `CAPTION_WRAP`")
    expect(flat).toContain("gagal `CAPTION_TRUNCATED`")
  })
})

describe("row 97b: the three connector-end FAIL kinds (T-03)", () => {
  const KINDS = [
    ["edgeEntryCollision", "GEOM_ENTRY_COLLISION"],
    ["stubSegment", "GEOM_STUB_SEGMENT"],
    ["arrowTangent", "GEOM_ARROW_TANGENT"],
  ] as const

  test("each kind fails FIGURE_FIT and its row quotes the engine's own suggestion", async () => {
    const { DIAGRAM_FAIL_KINDS } = await import("../../src/mcp-host/verify/static-checks")
    const { diagramGeometryIssues } = await import("../../vendor/src/lib/studio/engine/diagram/build/autofit")
    for (const [kind, code] of KINDS) {
      expect([kind, DIAGRAM_FAIL_KINDS.has(kind as never)]).toEqual([kind, true])
      const issue = diagramGeometryIssues({ widthMm: 1, heightMm: 1, counts: {}, defects: [{ kind, text: "t" }] } as never)[0]
      expect(issue?.checkId).toBe(code)
      const row = SECTION.split("\n").find((l) => l.startsWith(`| \`${code}\` / \`${kind}\` |`)) ?? ""
      expect([code, row.includes(issue?.suggest ?? "\u0000")]).toEqual([code, true])
    }
  })

  test("thresholds quoted equal the lint constants", async () => {
    const lint = await import("../../vendor/src/lib/studio/engine/diagram/fit/lint")
    expect(typeof lint.ENTRY_COLLISION_MM).toBe("number")
    expect(flat).toContain(`lebih dekat dari ${mm(lint.ENTRY_COLLISION_MM)} mm`)
    expect(flat).toContain(`di bawah ${mm(lint.STUB_SEGMENT_MIN_MM)} mm`)
    expect(flat).toContain(`dalam ${lint.ARROW_TANGENT_TOL_DEG} derajat`)
    expect(flat).toContain("`FIG_GEOMETRY`")
  })
})

describe("row 97b: no dangling STUDIO-MCP.md, no 1.2.5 workaround, no project text", () => {
  test("the guide no longer links STUDIO-MCP.md; section 17.0 still extracts and points at the MCP resources", async () => {
    expect(GUIDE).not.toContain("STUDIO-MCP.md")
    const { guideSection170, RESOURCE_RECIPE_URI } = await import("../../vendor/scripts/studio/mcp/resources")
    const s170 = guideSection170(VENDOR) ?? ""
    expect(s170).toMatch(/^### 17\.0 Resep satu halaman/)
    expect(s170).toContain(RESOURCE_RECIPE_URI)
    expect(s170).toContain("tools/list")
  })

  test("no workaround text for fixed bugs", () => {
    expect(flat).not.toMatch(/col\S*\s+(?:dari|mulai(?: dari)?)\s+1\b/i)
    expect(flat).not.toMatch(/(?:kirim|sertakan)\s+(?:ulang\s+)?spec\s+(?:utuh|lengkap)/i)
    expect(flat).not.toMatch(/\bpoll|sleep|tunggu lalu/i)
  })

  test("no project or corpus text in the section", () => {
    expect(flat).not.toMatch(/Cikupa|Gardu|GSP|PLN|\b14\.1\b|\brev ?2\d\d\b/i)
  })
})
