// Swarm 1.3.3 row 46 (ST-3.5): LABEL_LEADER is a notice like LABEL_MOVED; a real defect code stays a defect.
import { describe, expect, test } from "bun:test"
import { previewIssueClass, splitPreviewIssues } from "../src/mcp-host/local-api/routes/figure-preview-figure"

describe("row 46: LABEL_LEADER notice", () => {
  test("LABEL_LEADER and LABEL_MOVED are notices", () => {
    expect(previewIssueClass("LABEL_LEADER", "REPORT")).toBe("notice")
    expect(previewIssueClass("LABEL_MOVED", "REPORT")).toBe("notice")
  })
  test("only leader/moved findings: no defect, notes returned", () => {
    const issues = [{ checkId: "LABEL_LEADER", status: "REPORT" }, { checkId: "LABEL_MOVED", status: "REPORT" }]
    const { notices, defects } = splitPreviewIssues(issues)
    expect(defects).toEqual([])
    expect(notices).toEqual(issues)
  })
  test("a real defect code is still a defect", () => {
    const { notices, defects } = splitPreviewIssues([{ checkId: "LABEL_LEADER", status: "REPORT" }, { checkId: "TEXT_OUTSIDE", status: "REPORT" }, { checkId: "LABEL_DROPPED", status: "REPORT" }])
    expect(defects.map((d) => d.checkId)).toEqual(["TEXT_OUTSIDE", "LABEL_DROPPED"])
    expect(notices.map((d) => d.checkId)).toEqual(["LABEL_LEADER"])
  })
})
