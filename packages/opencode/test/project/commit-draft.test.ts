import { describe, expect, test } from "bun:test"
import { digest, parse } from "../../src/project/commit-draft"

describe("CommitDraft.parse", () => {
  test("reads the subject and summary, past any thinking", () => {
    expect(parse('<think>hm {"subject":"no"}</think>\n{"subject":"Fix  rounding","summary":" Why. "}')).toEqual({
      subject: "Fix rounding",
      summary: "Why.",
    })
  })
  test("anything unusable leaves the run's own record standing", () => {
    expect(parse("no json here")).toEqual({})
    expect(parse('{"summary":"no subject"}')).toEqual({})
    expect(parse(`{"subject":"${"x".repeat(200)}"}`)).toEqual({})
    expect(parse('{"subject": 3}')).toEqual({})
    expect(parse("{broken")).toEqual({})
  })
})

describe("CommitDraft.digest", () => {
  test("one huge file cannot push out the others", () => {
    const text = digest({
      prompts: ["fix it"],
      history: "feat: a",
      diffs: [
        { file: "lock.json", patch: "x".repeat(50_000) },
        { file: "src/a.ts", patch: "the real change" },
      ],
    })
    expect(text).toContain("the real change")
    expect(text).toContain("rest of this diff cut")
    expect(text.length).toBeLessThan(17_000)
  })
})
