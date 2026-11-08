import { describe, expect, test } from "bun:test"
import { BUILD_TARGETS, buildTarget, prebuildChecks } from "./prebuild-target"

// Row 120 (spec 113 S1, LP-6): prebuild picks its stage checks from SWARM_BUILD_TARGET, not from the host.

describe("buildTarget", () => {
  test("unset or empty means darwin-arm64 (register R2.2)", () => {
    expect(buildTarget({})).toBe("darwin-arm64")
    expect(buildTarget({ SWARM_BUILD_TARGET: "" })).toBe("darwin-arm64")
  })

  test("accepts each register R2.1 id", () => {
    for (const id of BUILD_TARGETS) expect(buildTarget({ SWARM_BUILD_TARGET: id })).toBe(id)
  })

  test("rejects anything else instead of falling back", () => {
    for (const bad of ["linux", "darwin", "win32-arm64", "LINUX-X64", " linux-x64"])
      expect(() => buildTarget({ SWARM_BUILD_TARGET: bad })).toThrow(/SWARM_BUILD_TARGET/)
  })
})

describe("prebuildChecks", () => {
  test("darwin-arm64 runs all three checks, as the darwin host did before", () => {
    expect(prebuildChecks("darwin-arm64")).toEqual({ setup: true, cli: true, datum: true })
  })

  test("linux-x64 runs check-cli and check-datum, not check-setup (R5.11)", () => {
    expect(prebuildChecks("linux-x64")).toEqual({ setup: false, cli: true, datum: true })
  })

  test("win32-x64 runs check-cli and check-datum, not check-setup (R5.11)", () => {
    expect(prebuildChecks("win32-x64")).toEqual({ setup: false, cli: true, datum: true })
  })

  test("the choice does not depend on the host", () => {
    // Same answers whatever process.platform is: the function takes only the target.
    expect(prebuildChecks(buildTarget({}))).toEqual(prebuildChecks("darwin-arm64"))
  })
})
