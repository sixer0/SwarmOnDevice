// Swarm 1.2.7 row 45c, AC-W18 (W-18, ruled C5 guide-only): CHAR-VERIFY guide pin. One contract file; a correction
// revises it. No tool reads or writes a "contract file" (row 9: no tool surface), so the built-in swarm-workflow
// skill is where this lives. Companion: swarm-workflow-guide.test.ts (row 103).
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

const WORKFLOW = readFileSync(path.join(import.meta.dir, "..", "..", "src", "skill", "swarm-workflow.md"), "utf8")

const section = (n: number) => {
  const start = WORKFLOW.indexOf(`\n## ${n}. `)
  if (start === -1) return ""
  const end = WORKFLOW.indexOf("\n## ", start + 1)
  return WORKFLOW.slice(start, end === -1 ? undefined : end)
}

describe("rel127 VERIFY W-18 one contract file, corrections revise it (guide pin)", () => {
  test("section 5 of swarm-workflow.md states one contract, one file", () => {
    const text = section(5)
    expect(text).not.toBe("")
    expect(text).toContain("- One contract, one file:")
    expect(text).toContain("lives in one file")
  })

  test("a correction is a revision in place, never an appended override section", () => {
    const text = section(5)
    expect(text).toContain("A correction is a revision of that file")
    expect(text).toContain("the changed rule rewritten in place")
    expect(text).toContain("never an appended override or correction section")
  })

  test("the rule appears once in the skill", () => {
    expect(WORKFLOW.split("One contract, one file").length - 1).toBe(1)
  })
})
