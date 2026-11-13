import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, sep } from "node:path"

// 1.2.8 row 25 (AC-R7, AC-PROJa, N8-322). Under OPENCODE_TEST_ONBOARDING=1 the Default Project lives in the test
// root's Documents, never in the person's real Documents, and the sidecar is told that root through
// SWARM_DEFAULT_PROJECT_DIR (N8-443). Outside test mode nothing changes. The "real" Documents here is a mkdtemp
// stand-in; the person's own folders are never touched.

const values = new Map<string, unknown>()
mock.module("./store", () => ({
  getStore: () => ({
    get: (key: string) => values.get(key),
    set: (key: string, value: unknown) => values.set(key, value),
  }),
}))
mock.module("./logging", () => ({ write: () => {} }))

const scratch = mkdtempSync(join(tmpdir(), "r7-"))
const realDocuments = join(scratch, "real-home", "Documents")
mkdirSync(realDocuments, { recursive: true })
mock.module("electron", () => ({
  app: { getPath: (name: string) => (name === "documents" ? realDocuments : join(scratch, "other", name)) },
}))

const onboarding = await import("./onboarding")
const { prepareOnboardingTestRoot } = await import("./onboarding-test-root")
const { createSidecarEnv } = await import("./sidecar-env")

const KEY = "SWARM_DEFAULT_PROJECT_DIR"
const roots: string[] = []

function testRoot() {
  const fixed = join(mkdtempSync(join(scratch, "root-")), "fixed")
  roots.push(fixed)
  return fixed
}

function inside(path: string, root: string) {
  return path === root || path.startsWith(root + sep)
}

beforeEach(() => {
  values.clear()
})

afterEach(() => {
  // Leave the module outside test mode for the next test.
  prepareOnboardingTestRoot({})
  rmSync(join(realDocuments, "Default Project"), { recursive: true, force: true })
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }))
})

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

describe("test root Documents (AC-R7)", () => {
  test("test mode creates <root>/Documents and the Default Project lands under the test root", async () => {
    const fixed = testRoot()
    const env = { OPENCODE_TEST_ONBOARDING: "1", OPENCODE_TEST_ONBOARDING_ROOT: fixed } as NodeJS.ProcessEnv
    expect(prepareOnboardingTestRoot(env)).toBe(fixed)
    expect(statSync(join(fixed, "Documents")).isDirectory()).toBe(true)

    const project = await onboarding.finishFirstLaunchOnboarding(true)
    expect(project).toBe(join(fixed, "Documents", "Default Project"))
    expect(inside(project!, fixed)).toBe(true)
    expect(existsSync(project!)).toBe(true)
    expect(existsSync(join(realDocuments, "Default Project"))).toBe(false)
  })

  test("a random test root also keeps the Default Project inside it", async () => {
    const env = { OPENCODE_TEST_ONBOARDING: "1" } as NodeJS.ProcessEnv
    const root = prepareOnboardingTestRoot(env)!
    roots.push(root)

    const project = await onboarding.finishFirstLaunchOnboarding(true)
    expect(project).toBe(join(root, "Documents", "Default Project"))
    expect(existsSync(join(realDocuments, "Default Project"))).toBe(false)
  })

  test("outside test mode prepare returns undefined, sets no path, and the real Documents is used", async () => {
    const fixed = testRoot()
    // A test-mode launch earlier in the same process must not leak into a later non-test call.
    prepareOnboardingTestRoot({ OPENCODE_TEST_ONBOARDING: "1", OPENCODE_TEST_ONBOARDING_ROOT: fixed })
    const env = { OPENCODE_TEST_ONBOARDING: "0", OPENCODE_TEST_ONBOARDING_ROOT: fixed, XDG_DATA_HOME: "/kept" }
    const before = { ...env }

    expect(prepareOnboardingTestRoot(env)).toBeUndefined()
    expect(env).toEqual(before)
    expect(onboarding.defaultProjectPath()).toBe(join(realDocuments, "Default Project"))
    const project = await onboarding.finishFirstLaunchOnboarding(true)
    expect(project).toBe(join(realDocuments, "Default Project"))
  })

  test("declining the Default Project creates nothing in either Documents", async () => {
    const fixed = testRoot()
    prepareOnboardingTestRoot({ OPENCODE_TEST_ONBOARDING: "1", OPENCODE_TEST_ONBOARDING_ROOT: fixed })
    expect(await onboarding.finishFirstLaunchOnboarding(false)).toBeNull()
    expect(existsSync(join(fixed, "Documents", "Default Project"))).toBe(false)
    expect(existsSync(join(realDocuments, "Default Project"))).toBe(false)
  })
})

describe("sidecar env (AC-PROJa)", () => {
  test("under test onboarding the sidecar gets the test-root Default Project and an inherited value is replaced", async () => {
    const fixed = testRoot()
    prepareOnboardingTestRoot({ OPENCODE_TEST_ONBOARDING: "1", OPENCODE_TEST_ONBOARDING_ROOT: fixed })
    const project = (await onboarding.finishFirstLaunchOnboarding(true))!

    const env = createSidecarEnv({ PATH: "/bin", [KEY]: "/elsewhere/Default Project" }, undefined, "darwin")
    expect(env[KEY]).toBe(project)
    expect(inside(env[KEY]!, fixed)).toBe(true)
  })

  test("an inherited value is deleted when the Default Project folder is absent", () => {
    const fixed = testRoot()
    prepareOnboardingTestRoot({ OPENCODE_TEST_ONBOARDING: "1", OPENCODE_TEST_ONBOARDING_ROOT: fixed })

    const env = createSidecarEnv({ PATH: "/bin", [KEY]: "/elsewhere/Default Project" }, undefined, "darwin")
    expect(KEY in env).toBe(false)
    expect(env.PATH).toBe("/bin")
  })

  test("a file where the folder should be is not passed on", () => {
    const fixed = testRoot()
    prepareOnboardingTestRoot({ OPENCODE_TEST_ONBOARDING: "1", OPENCODE_TEST_ONBOARDING_ROOT: fixed })
    writeFileSync(join(fixed, "Documents", "Default Project"), "not a folder")

    expect(KEY in createSidecarEnv({ PATH: "/bin" }, undefined, "darwin")).toBe(false)
  })

  test("outside test mode the real Documents Default Project is used", () => {
    prepareOnboardingTestRoot({})
    mkdirSync(join(realDocuments, "Default Project"), { recursive: true })

    const env = createSidecarEnv({ PATH: "/bin", [KEY]: "/elsewhere" }, undefined, "darwin")
    expect(env[KEY]).toBe(join(realDocuments, "Default Project"))
    expect(realpathSync(env[KEY]!)).toBe(realpathSync(join(realDocuments, "Default Project")))
  })

  test("an explicit Default Project argument wins, and null leaves the key unset", () => {
    const explicit = join(testRoot(), "explicit")
    mkdirSync(explicit, { recursive: true })
    expect(createSidecarEnv({ PATH: "/bin" }, undefined, "darwin", explicit)[KEY]).toBe(explicit)
    expect(KEY in createSidecarEnv({ PATH: "/bin", [KEY]: "/x" }, undefined, "darwin", null)).toBe(false)
  })
})
