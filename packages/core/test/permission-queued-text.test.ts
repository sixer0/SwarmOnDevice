// P-03 (1.2.6 row 40a, register N-083): once a task's family is away, a new ask is queued at once and fails with AwayError.
// Its message starts with QUEUED_TEXT (the request waits in the list and stays answerable) and keeps the alternatives
// sentence that walk-away-steering.test.ts pins. Secrets stay masked (U16), so the "secrets by another route" clause stays.
import { describe, expect, test } from "bun:test"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"

describe("P-03 queued text", () => {
  test("QUEUED_TEXT is exported beside AwayError and says the request waits and stays answerable", () => {
    const text = (PermissionV1 as Record<string, unknown>)["QUEUED_TEXT"]
    expect(typeof text).toBe("string")
    expect(text).toContain("did not run")
    expect(text).toContain("stays answerable")
    expect(text).toContain("do not ask again")
    expect(text).toContain("Continue with other work")
  })

  test("AwayError's message starts with QUEUED_TEXT and keeps the alternatives", () => {
    const message = new PermissionV1.AwayError().message
    expect(message.startsWith(String((PermissionV1 as Record<string, unknown>)["QUEUED_TEXT"]))).toBe(true)
    for (const tool of ["read for a file or a directory's listing", "glob to find files", "grep to search", "git for the repository's state"])
      expect(message).toContain(tool)
    expect(message).toContain("do not ask for a file that holds secrets by another route")
    expect(message).toContain("list what you skipped")
  })

  test("the tag the processor and the app read is unchanged", () => {
    expect(new PermissionV1.AwayError()._tag).toBe("PermissionAwayError")
  })
})
