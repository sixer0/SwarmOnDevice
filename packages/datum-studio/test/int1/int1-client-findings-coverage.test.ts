// Swarm 1.2.6 integration pass INT-1 item 1 (row 30 follow-up, T-13 / N-032): the fenced client findings block
// (studio_render text and the mission OUTPUT_UNVERIFIED refusal) shows the OVERLAP_CLIP coverage text
// "diukur m/n halaman" when the check carries a well-formed coverage. Red at e363918a69: the head line of each output
// carried only the entry count, and the stored report's coverage was dropped by notPassingChecks.
import { describe, expect, test } from "bun:test"
import { useStudioEnv } from "../ported/_env"
useStudioEnv()
import { clientEntries, clientFindingsBlock, outputGateFindings } from "../../src/mcp-host/verify/client-findings"
import { notPassingChecks } from "../../src/store/mission/output-gate"
import { refusal } from "../../src/mcp-host/mission/tool-result"

const truncated = {
  id: "OVERLAP_CLIP",
  status: "UNKNOWN",
  basis: "self",
  reason: "MEASURE_TRUNCATED",
  findings: [],
  truncated: 0,
  ms: 1,
  coverage: { measuredPages: 20, totalPages: 23 },
} as const

describe("INT-1 item 1: client findings block shows OVERLAP_CLIP coverage", () => {
  test("studio_render block: the output head line carries 'diukur m/n halaman'", () => {
    const block = clientFindingsBlock([{ format: "PDF", outputId: "o-pdf", ...clientEntries([truncated as never]) }])
    expect(block).toContain("OVERLAP_CLIP diukur 20/23 halaman")
    // the UNKNOWN reason stays beside the coverage text (E-14)
    expect(block).toContain("MEASURE_TRUNCATED")
  })

  test("no coverage text when the check has none (stored report from before 1.2.6)", () => {
    const { coverage: _c, ...old } = truncated
    const block = clientFindingsBlock([{ format: "PDF", outputId: "o-pdf", ...clientEntries([old as never]) }])
    expect(block).toContain("MEASURE_TRUNCATED")
    expect(block).not.toContain("diukur")
  })

  test("mission OUTPUT_UNVERIFIED refusal: the stored coverage survives the gate and reaches the text", () => {
    const report = JSON.stringify({ checks: [truncated] })
    const checks = notPassingChecks(report)
    const details = { total: 1, deliverables: [{ documentId: "d1", docKey: "nota", revisionNo: 2, final: false, outputs: [{ outputId: "o-pdf", format: "PDF", state: "unverified", checks }] }] }
    expect(outputGateFindings(details).block).toContain("OVERLAP_CLIP diukur 20/23 halaman")
    const text = (refusal("studio_mission_update_row", "OUTPUT_UNVERIFIED", "x", details).content[0] as { text: string }).text
    expect(text).toContain("OVERLAP_CLIP diukur 20/23 halaman")
  })

  test("a malformed coverage is not printed", () => {
    const bad = { ...truncated, coverage: { measuredPages: 30, totalPages: 23 } }
    const block = clientFindingsBlock([{ format: "PDF", outputId: "o-pdf", ...clientEntries([bad as never]) }])
    expect(block).not.toContain("diukur")
  })
})
