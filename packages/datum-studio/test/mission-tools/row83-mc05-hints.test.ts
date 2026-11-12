// Row 83 (MC-05): KIND_NOT_ALLOWED and PHASE_UNKNOWN name the guide resource and the allowed kinds, the printed
// phase-kind matrix equals BUILTIN_MISSION_TYPES, and the guide lifecycle teaches running -> done with a note (MC-01).
import { describe, expect, test } from "bun:test"
import { BUILTIN_MISSION_TYPES } from "../../src/store/mission/builtin-types.ts"
import { MISSION_LIFECYCLE, missionGuideText } from "../../src/mcp-host/mission/mission-guide.ts"
import { nextCall } from "../../src/mcp-host/mission/next-call.ts"

const FALLBACK_HEAD = "read the mission with studio_mission_get and fix what rincian names"

describe("row 83 MC-05 hints", () => {
  for (const code of ["KIND_NOT_ALLOWED", "PHASE_UNKNOWN"]) {
    test(`${code} is not the generic fallback and points to the guide`, () => {
      const hint = nextCall(code)
      expect(hint.startsWith(FALLBACK_HEAD)).toBe(false)
      expect(hint).toContain("studio://skema/mission")
      expect(hint).toContain("rincian.allowed")
      expect(hint).toContain("(skill: mission-control)")
    })
  }

  test("the guide matrix equals BUILTIN_MISSION_TYPES", () => {
    const lines = missionGuideText()
      .split("\n")
      .filter((l) => /^- [a-z-]+: .+\(.+\)/.test(l) && l.includes(" > ") || /^- [a-z-]+: [a-z-]+\([a-z ]+\)$/.test(l))
    const printed = new Map(lines.map((l) => [l.slice(2, l.indexOf(":")), l.slice(l.indexOf(":") + 2)]))
    for (const t of BUILTIN_MISSION_TYPES) {
      const want = [...t.phases].sort((a, b) => a.order - b.order).map((p) => `${p.id}(${p.kinds.join(" ")})`).join(" > ")
      expect(printed.get(t.id)).toBe(want)
    }
  })

  test("guide lifecycle teaches running -> done with a note", () => {
    const step4 = MISSION_LIFECYCLE[3]
    expect(step4).toContain("running -> done")
    expect(step4).toContain("note")
  })
})
