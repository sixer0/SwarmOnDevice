// 1.3.3 row 6: the four codes of masterplan/03_register.md section 2 that belong to the store registry are in
// STORE_ERROR_CODES, each with exactly one next-call hint, and the hints never name a way to write as the person.
import { describe, expect, test } from "bun:test"
import { STORE_ERROR_CODES } from "../../src/store/errors.ts"
import { nextCall, MISSION_SKILL } from "../../src/mcp-host/mission/next-call.ts"

const REGISTER = [
  "DELIVERABLE_NOT_IN_PROJECT",
  "KNOWLEDGE_NOT_CONSULTED",
  "PROJECT_UNWRITABLE",
  "LABELS_VERIFIED_PERSON_ONLY",
] as const
const FALLBACK_TAIL = "read the mission with studio_mission_get and fix what rincian names"

describe("1.3.3 error codes", () => {
  for (const code of REGISTER) {
    test(`${code} is registered once with its own hint`, () => {
      expect(STORE_ERROR_CODES.filter((c) => c === code)).toHaveLength(1)
      const hint = nextCall(code)
      expect(hint).not.toContain(FALLBACK_TAIL)
      expect(hint.endsWith(`(skill: ${MISSION_SKILL})`)).toBe(true)
      expect(hint.split("(skill:").length).toBe(2)
      expect(hint).not.toMatch(/\bGKP\b|\bSKT\b/)
    })
  }
  test("the hints name the calls of the register", () => {
    expect(nextCall("DELIVERABLE_NOT_IN_PROJECT")).toContain("studio_render")
    expect(nextCall("KNOWLEDGE_NOT_CONSULTED")).toContain("studio_library_read")
    expect(nextCall("KNOWLEDGE_NOT_CONSULTED")).toContain("knowledgeReason")
    expect(nextCall("PROJECT_UNWRITABLE")).toContain("studio_mission_request_decision")
    expect(nextCall("LABELS_VERIFIED_PERSON_ONLY")).not.toMatch(/by: user|labels_verified: true/)
  })
})
