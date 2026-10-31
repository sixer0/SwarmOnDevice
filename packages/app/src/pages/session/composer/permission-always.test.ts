import { describe, expect, test } from "bun:test"
import { alwaysLabel } from "./permission-always"

const t = (key: string, params?: { scope: string }) => (params ? `${key}:${params.scope}` : key)

describe("alwaysLabel", () => {
  test("a rule for one command names it", () => {
    expect(alwaysLabel(["git status *"], t)).toBe("session.permission.alwaysNamed:git status")
    expect(alwaysLabel(["make"], t)).toBe("session.permission.alwaysNamed:make")
  })
  test("a rule for everything, or several, keeps the plain words", () => {
    expect(alwaysLabel(["*"], t)).toBe("ui.permission.allowAlways")
    expect(alwaysLabel(["a *", "b *"], t)).toBe("ui.permission.allowAlways")
    expect(alwaysLabel(["/a/very/long/path/that/would/not/fit/on/a/button/*"], t)).toBe("ui.permission.allowAlways")
  })
})
