// 1.3.3 row 153 (senior S4): the mission guide resource no longer says a note lifts the output gate (C25) and names the
// three 1.3.3 close gates, the awaiting-check marker and the one deliverable folder.
import { describe, expect, test } from "bun:test"
import { missionGuideText } from "../../src/mcp-host/mission/mission-guide"

describe("row 153 S4: mission guide close gates", () => {
  const text = missionGuideText()
  test("no 'or a note' way past the output gate", () => {
    expect(text).not.toContain("or a note naming the check")
    expect(text).toContain("a note never lifts the output gate")
    expect(text).toContain("a note never lifts that gate")
  })
  test("names the 1.3.3 gates and the marker", () => {
    for (const name of ["DELIVERABLE_NOT_IN_PROJECT", "KNOWLEDGE_NOT_CONSULTED", "knowledgeReason", "awaitingHumanCheck"]) {
      expect(text).toContain(name)
    }
    expect(text).toContain("datum-studio_studio_library_read")
  })
  test("one deliverable folder: deliverables/<mission-id>/; the numbered folder is only the older place", () => {
    expect(text).toContain("deliverables/<mission-id>/ in the project")
    expect(text).not.toContain("final deliverables go in")
  })
})
