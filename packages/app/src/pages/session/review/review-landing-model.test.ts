import { describe, expect, test } from "bun:test"
import type { BriefFile, EvidenceRow } from "./review-brief-model"
import { checkLines, composeMessage, includedByDefault, landedHeadline, promptsBehind, teamUpdate, type CheckWords } from "./review-landing-model"

const file = (name: string, over: Partial<BriefFile> = {}): BriefFile => ({
  file: name,
  additions: 1,
  deletions: 0,
  status: "modified",
  group: "read",
  flags: [],
  assessed: true,
  hash: "h",
  mark: "none",
  touches: [],
  editedAfterChecks: false,
  ...over,
})
const touch = (prompt: string, at: number) => ({ file: "a", at, sessionID: "s", prompt })
const flag = (severity: "high" | "low") => ({ kind: "secret" as const, severity, count: 1, lines: [] })
const run = { kind: "test" as const, command: "bun test", status: "passed" as const, partial: false, at: 1, step: {} as never, sessionID: "s" }
const passed: EvidenceRow = { type: "check", kind: "test", status: "passed", run, editedAfter: [] }

const checks: CheckWords = {
  passed: (command) => `${command}: passed`,
  stale: (command, count) => `${command}: stale ${count}`,
  failed: (command, exit) => `${command}: failed ${exit}`,
  hidden: (command) => `${command}: hidden`,
  seen: (command) => `${command}: seen`,
  partial: (command) => `${command}: partial`,
  none: (kinds) => `not run: ${kinds.join()}`,
}
const words = {
  asked: "Asked for:",
  checks: "Checks:",
  mixed: "Other changes in place.",
  leftOut: (files: string) => `Left out: ${files}`,
  provenance: (reviewed: number, total: number) => `Reviewed ${reviewed} of ${total}.`,
}

describe("includedByDefault", () => {
  test("what a person accepted goes in, even if a rule flagged it or it was not from this run", () => {
    expect(includedByDefault(file("a", { mark: "ok", flags: [flag("high")], group: "elsewhere" }))).toBe(true)
  })
  test("needs work, changed since review, other people's files and high flags nobody has looked at stay out", () => {
    expect(includedByDefault(file("a", { mark: "work" }))).toBe(false)
    expect(includedByDefault(file("a", { mark: "changed" }))).toBe(false)
    expect(includedByDefault(file("a", { group: "elsewhere" }))).toBe(false)
    expect(includedByDefault(file("a", { flags: [flag("high")] }))).toBe(false)
  })
  test("an ordinary file from this run goes in", () => {
    expect(includedByDefault(file("a", { flags: [flag("low")] }))).toBe(true)
  })
})

describe("promptsBehind", () => {
  test("oldest first, without repeats or empties, whichever file came first", () => {
    expect(
      promptsBehind([
        file("a", { touches: [touch("second  try", 2)] }),
        file("b", { touches: [touch("first", 1), touch("second try", 3), { file: "b", at: 4, sessionID: "s" }] }),
      ]),
    ).toEqual(["first", "second try"])
  })
})

describe("checkLines", () => {
  test("says what the record says, for every state", () => {
    const rows: EvidenceRow[] = [
      { type: "check", kind: "test", status: "failed", run: { ...run, status: "failed", exit: 1 }, editedAfter: [] },
      { type: "check", kind: "lint", status: "hidden", run: { ...run, command: "lint | tail" }, editedAfter: [] },
      { type: "check", kind: "build", status: "running", run, editedAfter: [] },
      { type: "check", kind: "typecheck", status: "passed", run: { ...run, command: "tsc", partial: true }, editedAfter: [] },
      { type: "none", kinds: ["build"] },
    ]
    expect(checkLines(rows, new Set(), checks)).toEqual([
      "bun test: failed 1",
      "lint | tail: hidden",
      "tsc: partial",
      "not run: build",
    ])
  })
  test("an edit to a file outside this commit does not make its check stale", () => {
    const stale: EvidenceRow = { type: "check", kind: "test", status: "stale", run, editedAfter: ["in.ts", "out.ts"] }
    expect(checkLines([stale], new Set(["in.ts"]), checks)).toEqual(["bun test: stale 1"])
    expect(checkLines([stale], new Set(["other.ts"]), checks)).toEqual(["bun test: passed"])
  })
})

describe("composeMessage", () => {
  const brief = {
    evidence: [passed],
    files: [
      file("a.ts", { mark: "ok", touches: [touch("Fix the rounding", 1), touch("Also handle negatives", 2)] }),
      file("b.ts", { mark: "work", touches: [touch("Fix the rounding", 1)] }),
      file("c.ts", { group: "elsewhere" }),
    ],
  }
  const compose = (written?: { subject?: string; summary?: string }, title?: string) =>
    composeMessage({ brief, included: new Set(["a.ts"]), title, written, checks, words })

  test("from the record alone: the ask, what ran, what stayed out, who reviewed", () => {
    expect(compose(undefined, "Rounding fix")).toBe(
      [
        "Rounding fix",
        "",
        "Asked for:",
        "- Fix the rounding",
        "- Also handle negatives",
        "",
        "Checks:",
        "- bun test: passed",
        "Other changes in place.",
        "",
        // c.ts was never this run's: the mixed line covers it, and the message is not about it.
        "Left out: b.ts",
        "Reviewed 1 of 1.",
      ].join("\n"),
    )
  })
  test("no title: the first prompt is the subject and is not said twice", () => {
    const text = compose()
    expect(text.split("\n")[0]).toBe("Fix the rounding")
    expect(text).toContain("Asked for:\n- Also handle negatives\n")
    expect(text).not.toContain("- Fix the rounding")
  })
  test("a written summary replaces the ask and never the checks", () => {
    const text = compose({ subject: "Round half up", summary: "Totals were a cent short." })
    expect(text.startsWith("Round half up\n\nTotals were a cent short.\n\nChecks:\n- bun test: passed")).toBe(true)
    expect(text).not.toContain("Asked for:")
  })
  test("a written summary that claims a test result is dropped: only the record says what ran", () => {
    const text = compose({ subject: "Round half up", summary: "All tests pass." }, "Rounding fix")
    expect(text.startsWith("Rounding fix\n")).toBe(true)
    expect(text).not.toContain("All tests pass")
  })
  test("a long prompt becomes a subject at a word boundary", () => {
    const long = "word ".repeat(40).trim()
    const text = composeMessage({
      brief: { evidence: [], files: [file("a", { touches: [touch(long, 1)] })] },
      included: new Set(["a"]),
      checks,
      words,
    })
    const subject = text.split("\n")[0]
    expect(subject.length).toBeLessThanOrEqual(72)
    expect(subject.endsWith("word…")).toBe(true)
  })
})

test("teamUpdate is the headline over the message as committed", () => {
  expect(teamUpdate({ headline: "Committed abc on main, not pushed", message: "  Edited\n" })).toBe(
    "Committed abc on main, not pushed\n\nEdited",
  )
})

test("landedHeadline carries what the server says differed, and adds nothing when it says nothing", () => {
  expect(landedHeadline("Committed abc on main, not pushed")).toBe("Committed abc on main, not pushed")
  expect(landedHeadline("Committed abc on main, not pushed", "Its git hooks did not run.")).toBe(
    "Committed abc on main, not pushed. Its git hooks did not run.",
  )
})
