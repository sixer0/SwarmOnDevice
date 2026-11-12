// Row 102a (1.2.6): GUIDE pins for W-15/OFF-05 (a metric names its corpus and filter) and W-17 (bulk writes only
// after the scope decision is recorded). W-17 lives in swarm-rules.txt only, written once.

import { describe, expect, test } from "bun:test"
import RULES from "../../src/session/prompt/swarm-rules.txt"
import PLANNER from "../../src/agent/prompt/planner.txt"

const line = (text: string, start: string) => text.split("\n").find((item) => item.startsWith(start)) ?? ""
const count = (text: string, needle: string) => text.split(needle).length - 1

describe("1.2.6 guide rules in the built-in prompts", () => {
  test("W-15: the evidence rule of swarm-rules.txt names corpus and filter, with a prose-only example", () => {
    const evidence = line(RULES, "- Evidence: ")
    expect(evidence).toContain("A metric names its corpus and filter")
    expect(evidence).toContain("prose only; tables, lists, headings excluded")
  })

  test("W-15: the planner's evidence rule names corpus and filter", () => {
    const evidence = line(PLANNER, "- Cite file:line")
    expect(evidence).toContain("Every metric you report names its corpus and its filter")
    expect(evidence).toContain("prose only; tables, lists and headings excluded")
  })

  test("W-17: the bulk-write rule is in swarm-rules.txt exactly once and nowhere in planner.txt", () => {
    const rule = "Bulk writes start only after the scope decision is recorded."
    expect(count(RULES, rule)).toBe(1)
    expect(count(RULES, "Bulk writes")).toBe(1)
    expect(count(PLANNER, "Bulk writes")).toBe(0)
  })

  test("OFF-05: the rules carry no helper-script name", () => {
    // The name is assembled so that the release grep for it stays empty on this file too.
    const helper = ["ukur", "prosa"].join("_")
    for (const text of [RULES, PLANNER]) {
      expect(text).not.toContain(helper)
      expect(text).not.toMatch(/\.py\b/)
    }
  })
})
