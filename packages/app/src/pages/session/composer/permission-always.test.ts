import { describe, expect, test } from "bun:test"
import type { PermissionRequest } from "@opencode-ai/sdk/v2/client"
import { alwaysLabel, offersAlways } from "./permission-always"

const t = (key: string) => key
// A prompt as the server lists it; only what the rule reads differs between cases.
const request = (permission: string, always: string[], extra: Partial<PermissionRequest> = {}): PermissionRequest => ({
  id: "per_test",
  sessionID: "ses_test",
  permission,
  patterns: ["rm -rf build"],
  always,
  metadata: {},
  ...extra,
})
const bash = (always: string[]) => request("bash", always)

describe("offersAlways", () => {
  test("a prompt whose tool named no rule still offers the button", () => {
    expect(offersAlways(bash([]))).toBe(true)
    expect(offersAlways(request("external_directory", [], { metadata: { workdir: "/w" } }))).toBe(true)
  })
  test("a prompt with a rule offers it", () => {
    expect(offersAlways(bash(["git status *"]))).toBe(true)
  })
  test("the spend limit keeps only Stop and Continue", () => {
    expect(offersAlways(request("spend_limit", [], { metadata: { spent: 5, next: 10 } }))).toBe(false)
    expect(offersAlways(request("spend_limit", ["*"]))).toBe(false)
  })
  test("moved-on and held prompts do not offer it", () => {
    expect(offersAlways({ ...bash([]), movedOnAt: 1 })).toBe(false)
    expect(offersAlways({ ...bash(["git status *"]), deferred: true })).toBe(false)
  })
})

describe("alwaysLabel", () => {
  test("the button says the answer reaches this session only", () => {
    expect(alwaysLabel(bash([]), t)).toBe("session.movedOn.alwaysInSession")
    expect(alwaysLabel(bash(["git status *"]), t)).toBe("session.movedOn.alwaysInSession")
    expect(alwaysLabel(bash(["*"]), t)).toBe("session.movedOn.alwaysInSession")
  })
  test("the prompt about repeated calls says that is what it allows, and does not read as allowing the shell", () => {
    expect(alwaysLabel({ permission: "doom_loop" }, t)).toBe("session.permission.alwaysRepeats")
  })
})
