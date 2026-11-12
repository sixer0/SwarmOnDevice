// Row 102 (1.2.6): GUIDE pins for the working norms in the built-in swarm-workflow skill.
// W-07 capability pre-check before delegating (section 0), W-04 measure a tool before promising a shape and
// W-11 declare outside tools in the blueprint (section 2), W-02 dual gate machine checks plus eyes (section 6).

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

const WORKFLOW = readFileSync(path.join(import.meta.dir, "..", "..", "src", "skill", "swarm-workflow.md"), "utf8")

// The body of "## <n>. ..." up to the next "## " heading.
const section = (n: number) => {
  const start = WORKFLOW.indexOf(`\n## ${n}. `)
  expect(start).toBeGreaterThan(-1)
  const end = WORKFLOW.indexOf("\n## ", start + 1)
  return WORKFLOW.slice(start, end === -1 ? undefined : end)
}

describe("1.2.6 row 102 working norms in swarm-workflow.md", () => {
  test("W-07: section 0 asks for a capability pre-check (images, tool reach) before delegating", () => {
    const text = section(0)
    expect(text).toContain("- Before delegating, check the agent can do the step:")
    expect(text).toContain("it reads images when the step needs eyes on a picture")
    expect(text).toContain("it reaches the tools the step names")
  })

  test("W-04: section 2 says measure a tool on a sample before promising a shape", () => {
    const text = section(2)
    expect(text).toContain("- Measure a tool before promising a shape:")
    expect(text).toContain("Promise only what the sample showed.")
  })

  test("W-11: section 2 says declare tools and commands outside Swarm in the blueprint row", () => {
    const text = section(2)
    expect(text).toContain("- Declare every tool or command outside Swarm a row will run")
    expect(text).toContain("Swarm's permission prompts still apply.")
  })

  test("W-02: section 6 sets the dual gate, machine checks and an eye check, before a figure is done", () => {
    const text = section(6)
    expect(text).toContain("- Figures and other visual output pass two gates:")
    expect(text).toContain("an eye check of the rendered image")
    expect(text).toContain("a clean preview alone is not the gate")
  })

  test("the norms stay generic: no project document, helper script or outside tool names", () => {
    expect(WORKFLOW).not.toMatch(/\b004\b|Gambar|ukur_prosa|dotgen|Graphviz/)
  })
})

// Row 103 (1.2.6): W-06 release blockers before cosmetic loops (section 2), W-08 the mission is the one decision
// source and the docs/ file is its export (section 5, matches row 89: done lists the decision ids,
// studio_mission_export renders the file), W-18 one contract file, corrections revise it (section 5).
describe("1.2.6 row 103 blockers, decisions and contracts in swarm-workflow.md", () => {
  test("W-06: section 2 orders the release blocker before cosmetic loops, with the paged findings", () => {
    const text = section(2)
    expect(text).toContain("- Release blockers first:")
    expect(text).toContain("before any cosmetic or layout loop")
    expect(text).toContain("studio_document_status with findings")
  })

  test("W-08: section 5 records decisions in the mission; the docs/ file is its export", () => {
    const text = section(5)
    expect(text).toContain("- One decision source:")
    expect(text).toContain("studio_mission_record_decision")
    expect(text).toContain("is its export (studio_mission_export)")
    expect(text).toContain("never a second register edited by hand")
    expect(text).not.toContain("in docs/<task>/decisions.md when it happens")
  })

  test("W-18: section 5 keeps one contract file and a correction revises it", () => {
    const text = section(5)
    expect(text).toContain("- One contract, one file:")
    expect(text).toContain("A correction is a revision of that file")
    expect(text).toContain("never an appended override or correction section")
  })
})
