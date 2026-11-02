import { Database } from "bun:sqlite"
import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { prepareOnboardingTestRoot } from "./onboarding-test-root"

const created: string[] = []

afterEach(() => {
  created.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }))
})

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "swarm-test-root-"))
  created.push(dir)
  return dir
}

function prepare(env: NodeJS.ProcessEnv) {
  const root = prepareOnboardingTestRoot(env)
  if (root) created.push(root)
  return root
}

describe("prepareOnboardingTestRoot without test mode", () => {
  test.each([
    ["unset", undefined],
    ["zero", "0"],
    ["true", "true"],
    ["empty", ""],
  ])("ignores the fixed root when test mode is %s", (_name, mode) => {
    const fixed = join(scratch(), "must-not-appear")
    const env = { OPENCODE_TEST_ONBOARDING: mode, OPENCODE_TEST_ONBOARDING_ROOT: fixed, XDG_DATA_HOME: "/kept" }
    const before = { ...env }

    expect(prepareOnboardingTestRoot(env)).toBeUndefined()
    expect(existsSync(fixed)).toBe(false)
    expect(env).toEqual(before)
  })
})

describe("prepareOnboardingTestRoot in test mode without a fixed root", () => {
  test("gives a new random root and an in-memory database on every call", () => {
    const first = { OPENCODE_TEST_ONBOARDING: "1" } as NodeJS.ProcessEnv
    const second = { OPENCODE_TEST_ONBOARDING: "1" } as NodeJS.ProcessEnv
    const a = prepare(first)
    const b = prepare(second)

    expect(a).toStartWith(join(tmpdir(), "swarm-onboarding-"))
    expect(b).toStartWith(join(tmpdir(), "swarm-onboarding-"))
    expect(a).not.toBe(b)
    expect(first.OPENCODE_DB).toBe(":memory:")
    expect(first.XDG_DATA_HOME).toBe(join(a!, "data"))
    expect(first.XDG_CONFIG_HOME).toBe(join(a!, "config"))
    expect(first.XDG_CACHE_HOME).toBe(join(a!, "cache"))
    expect(first.XDG_STATE_HOME).toBe(join(a!, "state"))
    ;["data", "config", "cache", "state", "desktop", "session"].forEach((dir) =>
      expect(existsSync(join(a!, dir))).toBe(true),
    )
  })

  test.each([
    ["relative", "relative-test-root-r87"],
    ["dot relative", "./relative-test-root-r87"],
    ["tilde", "~/relative-test-root-r87"],
    ["leading space", " /relative-test-root-r87"],
    ["empty", ""],
  ])("ignores a %s value", (_name, value) => {
    const env = { OPENCODE_TEST_ONBOARDING: "1", OPENCODE_TEST_ONBOARDING_ROOT: value } as NodeJS.ProcessEnv
    const root = prepare(env)

    expect(root).toStartWith(join(tmpdir(), "swarm-onboarding-"))
    expect(env.OPENCODE_DB).toBe(":memory:")
    expect(existsSync("relative-test-root-r87")).toBe(false)
  })
})

describe("prepareOnboardingTestRoot in test mode with a fixed root", () => {
  test("creates the root and points every path and a file database under it", () => {
    const fixed = join(scratch(), "not-yet", "fixed")
    const env = {
      OPENCODE_TEST_ONBOARDING: "1",
      OPENCODE_TEST_ONBOARDING_ROOT: fixed,
      OPENCODE_DB: ":memory:",
      XDG_DATA_HOME: "/overwritten",
    } as NodeJS.ProcessEnv

    expect(prepare(env)).toBe(fixed)
    expect(env.XDG_DATA_HOME).toBe(join(fixed, "data"))
    expect(env.XDG_CONFIG_HOME).toBe(join(fixed, "config"))
    expect(env.XDG_CACHE_HOME).toBe(join(fixed, "cache"))
    expect(env.XDG_STATE_HOME).toBe(join(fixed, "state"))
    expect(env.OPENCODE_DB).toStartWith(fixed)
    expect(env.OPENCODE_DB).not.toBe(":memory:")
    expect(existsSync(dirname(env.OPENCODE_DB!))).toBe(true)
  })

  test("keeps files and database rows across a restart", () => {
    const fixed = join(scratch(), "fixed")
    const launch = () => {
      const env = { OPENCODE_TEST_ONBOARDING: "1", OPENCODE_TEST_ONBOARDING_ROOT: fixed } as NodeJS.ProcessEnv
      expect(prepare(env)).toBe(fixed)
      return env
    }

    const first = launch()
    const writer = new Database(first.OPENCODE_DB!)
    writer.run("create table kept (value text)")
    writer.run("insert into kept values ('row')")
    writer.close()
    writeFileSync(join(fixed, "desktop", "opencode.global.dat"), "{}")

    const second = launch()
    expect(second.OPENCODE_DB).toBe(first.OPENCODE_DB)
    expect(existsSync(join(fixed, "desktop", "opencode.global.dat"))).toBe(true)
    const reader = new Database(second.OPENCODE_DB!)
    expect(reader.query("select value from kept").get()).toEqual({ value: "row" })
    reader.close()
  })
})
