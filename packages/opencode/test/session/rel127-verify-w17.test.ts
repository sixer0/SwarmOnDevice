// Swarm 1.2.7 row 45c, AC-W17 (W-17, ruled C5 guide-only): CHAR-VERIFY guide pin. Bulk writes start only after
// the scope decision is recorded. 1.2.7 enforces this in the built-in rules prompt, not with a tool lock (the
// row 9 probe showed no tool refuses a bulk write; C5 keeps it guide-only). Companion: swarm-rules-guide.test.ts.
import { describe, expect, test } from "bun:test"
import RULES from "../../src/session/prompt/swarm-rules.txt"
import PLANNER from "../../src/agent/prompt/planner.txt"

const RULE = "- Bulk writes start only after the scope decision is recorded."
const count = (text: string, needle: string) => text.split(needle).length - 1

describe("rel127 VERIFY W-17 bulk writes wait for the recorded scope decision (guide pin)", () => {
  test("swarm-rules.txt carries the rule as its own list line, exactly once", () => {
    expect(RULES.split("\n").filter((line) => line.trim() === RULE)).toHaveLength(1)
    expect(count(RULES, "scope decision")).toBe(1)
  })

  test("the rule is written once: the planner prompt does not repeat it", () => {
    expect(count(PLANNER, "Bulk writes")).toBe(0)
  })
})
