// Row 161 (decision C40): the two reply lines added by 1.3.3 name the call in plain words, never as `tool {json}`.
import { describe, expect, test } from "bun:test"
import { witnessRenderCall } from "../src/mcp-host/verify/witness-list"
import { correctionFor } from "../src/mcp-host/mission/next-call"

const CALL_SHAPE = /[a-z_]+ \{"?/

describe("row 161: plain call wording", () => {
  test("witness-list render hint (row 59) is plain words with every value kept", () => {
    const text = witnessRenderCall("doc-9", 4)
    expect(text).toContain('call the tool datum-studio_studio_render with documentId "doc-9", revisionNo 4, formats "html" and "pdf"')
    expect(text).not.toMatch(CALL_SHAPE)
  })

  test("done-without-note correction (row 17) is plain words with every value kept", () => {
    const c = correctionFor("studio_mission_update_row", "SCHEMA_INVALID", "a row closes with a note", { row: "7", field: "note", to: "done" }, { mission: "m-1", rows: [{ id: "7", status: "done" }] })
    expect(c.next).toContain('call the tool datum-studio_studio_mission_update_row with mission "m-1", and in rows one entry with id "7", status "done", note "<the check you ran and its result>"')
    expect(c.next).not.toMatch(CALL_SHAPE)
  })
})
