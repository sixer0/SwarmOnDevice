import { describe, expect, test } from "bun:test"
import { alwaysLabel } from "./permission-always"

const t = (key: string, params?: { scope: string }) => (params ? `${key}:${params.scope}` : key)
const bash = (always: string[]) => ({ permission: "bash", always })

describe("alwaysLabel", () => {
  test("a rule for one command names it", () => {
    expect(alwaysLabel(bash(["git status *"]), t)).toBe("session.permission.alwaysNamed:git status")
    expect(alwaysLabel(bash(["make"]), t)).toBe("session.permission.alwaysNamed:make")
  })
  test("the prompt about repeated calls says that is what it allows, and does not read as allowing the shell", () => {
    expect(alwaysLabel({ permission: "doom_loop", always: ["bash"] }, t)).toBe("session.permission.alwaysRepeats")
  })
  test("a rule for everything, or several, keeps the plain words", () => {
    expect(alwaysLabel(bash(["*"]), t)).toBe("ui.permission.allowAlways")
    expect(alwaysLabel(bash(["a *", "b *"]), t)).toBe("ui.permission.allowAlways")
    expect(alwaysLabel(bash(["/a/very/long/path/that/would/not/fit/on/a/button/*"]), t)).toBe("ui.permission.allowAlways")
  })
})
