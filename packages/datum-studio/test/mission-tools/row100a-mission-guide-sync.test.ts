// Row 100a (1.2.6, G-03 Studio side): the mission guide (studio://skema/mission) and the next-call hints agree with the
// fixed store on every MC point: row and mission status moves equal ROW_TRANSITIONS / MISSION_TRANSITIONS, running -> done
// quotes ROW_RUNNING_DONE_RULE (MC-01), top-level autonomous (MC-02), rows[].decision (MC-03), notes never dep-gated and
// noteSaved (MC-04), idempotent set_status (MC-06), per-patch results (MC-07), linked deliverables (MC-08), drift (MC-09).
// Only exports that already existed at BASE are imported, so the red run fails on assertions, not on a missing import.
import { describe, expect, test } from "bun:test"
import { MISSION_LIFECYCLE, missionGuideText } from "../../src/mcp-host/mission/mission-guide.ts"
import { nextCall } from "../../src/mcp-host/mission/next-call.ts"
import { MISSION_TOOL_SCHEMAS } from "../../src/mcp-host/mission/schemas.ts"
// Namespace import: ROW_RUNNING_DONE_RULE does not exist at BASE (row 79), and a missing named import would crash the red run.
import * as store from "../../src/store/mission/mission-store.ts"

const { MISSION_TRANSITIONS, ROW_TRANSITIONS } = store
const ROW_RUNNING_DONE_RULE = (store as Record<string, unknown>).ROW_RUNNING_DONE_RULE as string

type S = Record<string, any>

/** Parse "<Label>: a -> b | c; d -> (none)" into {a: [b, c], d: []}. */
function movesLine(text: string, label: string): Record<string, string[]> {
  const line = text.split("\n").find((l) => l.startsWith(`${label}`))
  expect(line).toBeDefined()
  const body = line!.slice(line!.indexOf(": ") + 2).replace(/\.$/, "")
  const out: Record<string, string[]> = {}
  for (const part of body.split("; ")) {
    const [from, to] = part.split(" -> ")
    out[from!.trim()] = to!.trim() === "(none)" ? [] : to!.split(" | ").map((s) => s.trim())
  }
  return out
}

const plain = (o: Readonly<Record<string, readonly string[]>>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, [...v]]))

describe("row 100a mission guide and hints agree with the store", () => {
  const text = missionGuideText()
  const lifecycle = MISSION_LIFECYCLE.join("\n")

  test("row status moves printed in the guide equal ROW_TRANSITIONS", () => {
    expect(movesLine(text, "Row status moves")).toEqual(plain(ROW_TRANSITIONS))
  })

  test("mission status moves printed in the guide equal MISSION_TRANSITIONS", () => {
    expect(movesLine(text, "Mission status moves")).toEqual(plain(MISSION_TRANSITIONS))
  })

  test("MC-01: lifecycle 4/6 and the STATUS_TRANSITION hint quote ROW_RUNNING_DONE_RULE verbatim", () => {
    expect(typeof ROW_RUNNING_DONE_RULE).toBe("string")
    expect(MISSION_LIFECYCLE.length).toBe(6)
    expect(MISSION_LIFECYCLE[3]).toContain(ROW_RUNNING_DONE_RULE)
    expect(nextCall("STATUS_TRANSITION")).toContain(ROW_RUNNING_DONE_RULE)
    // no 1.2.5 workaround: running is never sent through needs-review to reach done
    for (const t of [text, nextCall("STATUS_TRANSITION"), nextCall("OUTPUT_UNVERIFIED")]) {
      expect(t).not.toMatch(/running -> needs-review -> done/)
      expect(t).not.toMatch(/two-step/i)
    }
  })

  test("MC-02: top-level autonomous is in the schema, the guide and the approval hints", () => {
    expect((MISSION_TOOL_SCHEMAS.studio_mission_record_decision as S).properties.autonomous.type).toBe("boolean")
    const shape = "studio_mission_record_decision {decision: {id: C<n>, by: controller, date, text}, autonomous: true}"
    expect(MISSION_LIFECYCLE[1]).toContain(shape)
    for (const code of ["MISSION_NOT_APPROVED", "APPROVAL_NEEDS_USER_DECISION", "DECISION_REQUIRED"]) expect(nextCall(code)).toContain(shape)
    expect(lifecycle).toContain("decision.autonomous")
  })

  test("MC-03: rows[].decision is in the schema and the guide", () => {
    const rowPatch = (MISSION_TOOL_SCHEMAS.studio_mission_update_row as S).properties.rows.items as S
    expect(rowPatch.properties.decision.type).toBe("string")
    expect(lifecycle).toContain("rows[].decision")
  })

  test("MC-04: notes are never dependency-gated (noteSaved) in the guide and the DEP_NOT_DONE hint", () => {
    expect(lifecycle).toContain("noteSaved: true")
    expect(lifecycle).toContain("never gated by dependencies")
    const hint = nextCall("DEP_NOT_DONE")
    expect(hint).toContain("never gated by dependencies")
    expect(hint).toContain("noteSaved")
  })

  test("MC-06: set_status to the current status is unchanged, not an error", () => {
    expect(lifecycle).toContain("unchanged: true")
    expect(nextCall("STATUS_TRANSITION")).toContain("unchanged: true")
  })

  test("MC-07: per-patch results are read in the guide and named in the hints", () => {
    expect(lifecycle).toContain("results[]")
    expect(lifecycle).toContain("{id, ok, code?, message?, noteSaved?}")
    expect(nextCall("MISSION_ROWS_OPEN")).toContain("results[]")
  })

  test("MC-08: deliverables linked from another mission are described", () => {
    expect(text).toContain("linked: true")
    expect(text).toContain("ownerMission")
  })

  test("MC-09: drift in studio_mission_get is named", () => {
    expect(lifecycle).toContain("derived.drift")
  })

  test("every hint still ends with the skill name and the 6 lifecycle lines keep their order", () => {
    for (const code of ["STATUS_TRANSITION", "DEP_NOT_DONE", "MISSION_ROWS_OPEN", "MISSION_NOT_APPROVED"]) expect(nextCall(code).endsWith("(skill: mission-control)")).toBe(true)
    expect(MISSION_LIFECYCLE.map((l) => l.slice(10, 13))).toEqual(["1/6", "2/6", "3/6", "4/6", "5/6", "6/6"])
  })
})
