// Row 174 (C218 F146b-6): in run 146b the agent sent studio_figure_preview a diagram block 28 times and was refused
// SCHEMA_INVALID every time (fixture store logs: 33 SCHEMA_INVALID, 28 on /figures/preview). From try 8 on, the only
// issue was `/block oneOf "must match exactly one schema in oneOf"`: every try carried BOTH `spec` and `artifactId`,
// which DiagramV2 makes exclusive (xorRequired("spec", "artifactId"), common.schema.ts), so ajv reported both branches
// passing (passingSchemas [0,1]) and the message named no field. The agent guessed at node `class` fields instead and
// gave up. Fix: the classifier names the exclusive fields that were both given; the guide shows the diagram block shape.
import { describe, expect, test } from "bun:test"
import { parsePreviewBody } from "../../src/mcp-host/local-api/routes/figure-preview-request.ts"
import { validateBlockV2 } from "../../vendor/src/lib/studio/services/revisions/v2/body"
import { MCP_DOC_RECIPE } from "../../vendor/scripts/studio/mcp/resources"

// Try 23 of run 146b (minimal) as sent: spec AND artifactId.
const RUN_146B_TRY_23 = {
  artifactId: "probe",
  caption: { text: "Probe." },
  source: { text: "SUMBER: probe. PROVENANS: TERUKUR" },
  spec: { family: "layered", nodes: [{ class: {}, id: "a", label: "A" }] },
  type: "diagram",
}

describe("row 174: diagram block refusal names the field (F146b-6)", () => {
  test("spec + artifactId: the issue names both fields and says to send exactly one", () => {
    const issues = validateBlockV2(RUN_146B_TRY_23, "/block")
    console.log(`[row174] try 23 issues ${JSON.stringify(issues)}`)
    expect(issues).toHaveLength(1)
    expect(issues[0]!.pointer).toBe("/block")
    expect(issues[0]!.keyword).toBe("oneOf")
    expect(issues[0]!.message).toContain('"spec"')
    expect(issues[0]!.message).toContain('"artifactId"')
    // the preview route passes the same issue on
    const r = parsePreviewBody({ block: RUN_146B_TRY_23 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.issues[0]!.message).toContain('"artifactId"')
  })

  test("the same block without artifactId is valid (the run's diagram was otherwise acceptable)", () => {
    const { artifactId: _drop, ...block } = RUN_146B_TRY_23
    expect(validateBlockV2(block, "/block")).toEqual([])
    expect(parsePreviewBody({ block }).ok).toBe(true)
  })

  test("chart data + panels: also named (same rule, three exclusive fields)", () => {
    const issues = validateBlockV2({ type: "chart", code: "bar", caption: { text: "x" }, source: { text: "SUMBER: x" }, data: { categories: ["a"], series: [{ name: "s", values: [1] }] }, panels: [] }, "/block")
    console.log(`[row174] chart issues ${JSON.stringify(issues)}`)
    expect(issues.some((i) => i.keyword === "oneOf" && i.message.includes('"data"') && i.message.includes('"panels"'))).toBe(true)
  })

  test("the MCP guide shows the diagram block shape and that spec and artifactId exclude each other", () => {
    expect(MCP_DOC_RECIPE).toContain('type: "diagram"')
    expect(MCP_DOC_RECIPE).toMatch(/spec.*ATAU.*artifactId/)
  })
})

describe("row 174: mission guide lines (F146b-7, F146b-3)", () => {
  test("studio://skema/mission names verified Studio outputs, the XLSX check-and-result-file rule, and retire", async () => {
    const { missionGuideText } = await import("../../src/mcp-host/mission/mission-guide.ts")
    const t = missionGuideText()
    expect(t).toContain("done gate verified")
    expect(t).toContain("XLSX")
    expect(t).toContain("its result file, and that file must exist")
    expect(t).toContain("retire: [documentId]")
  })
})
