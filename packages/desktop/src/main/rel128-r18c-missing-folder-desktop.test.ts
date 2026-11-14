import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// 1.2.8 row 30b (AC-R18c desktop half, N8-326). First-launch onboarding makes the Default Project the way the U-8
// Recreate does (SR7-13 rule 1): only the leaf folder, inside a Documents folder that exists. A Documents folder that
// no longer exists is not recreated, a non-folder at the Default Project path does not throw, nothing is opened
// (null), the onboarding stays pending for the next launch and one warn line goes to the Swarm log.
// Red at e1f9673772: `mkdir(..., { recursive: true })` recreates the missing Documents folder, and a file at the
// path rejects the IPC call. Synthetic mkdtemp folders only; the person's Documents is never used.

const values = new Map<string, unknown>()
mock.module("./store", () => ({
  getStore: () => ({
    get: (key: string) => values.get(key),
    set: (key: string, value: unknown) => values.set(key, value),
  }),
}))
const logs: Array<{ name: string; message: string; extra?: Record<string, unknown>; level?: string }> = []
mock.module("./logging", () => ({
  write: (name: string, message: string, extra?: Record<string, unknown>, level?: string) =>
    void logs.push({ name, message, extra, level }),
}))

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "r18c-")))
let documents = join(scratch, "home", "Documents")
mock.module("electron", () => ({
  app: { getPath: (name: string) => (name === "documents" ? documents : join(scratch, "other", name)) },
}))

const onboarding = await import("./onboarding")
// registerRealDocuments arrived with row 25 (after the base); there the electron mock above answers alone.
const testRoot: { prepareOnboardingTestRoot: (env: NodeJS.ProcessEnv) => unknown; registerRealDocuments?: (resolve: () => string) => void } =
  await import("./onboarding-test-root")
const { FIRST_LAUNCH_ONBOARDING_COMPLETE_KEY } = await import("./store-keys")

let n = 0
beforeEach(() => {
  values.clear()
  logs.length = 0
  testRoot.prepareOnboardingTestRoot({})
  documents = join(scratch, `home-${++n}`, "Documents")
  testRoot.registerRealDocuments?.(() => documents)
})

// Leave no resolver pointing at the deleted scratch folder for the next file in this process.
afterEach(() => {
  testRoot.registerRealDocuments?.(() => {
    throw new Error("no Documents folder")
  })
})

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

const warns = () => logs.filter((line) => line.level === "warn")

describe("AC-R18c onboarding Default Project with a missing folder", () => {
  test("Documents that no longer exists is not recreated; null, still pending, one warn", async () => {
    expect(existsSync(documents)).toBe(false)
    const result = await onboarding.finishFirstLaunchOnboarding(true)
    expect(result).toBeNull()
    expect(existsSync(documents)).toBe(false)
    expect(existsSync(join(scratch, `home-${n}`))).toBe(false)
    expect(values.get(FIRST_LAUNCH_ONBOARDING_COMPLETE_KEY)).toBeUndefined()
    expect(onboarding.isFirstLaunchOnboardingPending()).toBe(true)
    expect(warns()).toHaveLength(1)
    expect(warns()[0]?.name).toBe("onboarding")
    // The path itself is not in the warn line (only the reason).
    expect(JSON.stringify(warns()[0])).not.toContain(scratch)
  })

  test("a file at the Default Project path does not throw and is left as it is", async () => {
    mkdirSync(documents, { recursive: true })
    writeFileSync(join(documents, "Default Project"), "not a folder")
    const result = await onboarding.finishFirstLaunchOnboarding(true)
    expect(result).toBeNull()
    expect(readFileSync(join(documents, "Default Project"), "utf8")).toBe("not a folder")
    expect(onboarding.isFirstLaunchOnboardingPending()).toBe(true)
    expect(warns()).toHaveLength(1)
  })

  test("with Documents present the leaf is made and onboarding completes (unchanged)", async () => {
    mkdirSync(documents, { recursive: true })
    const result = await onboarding.finishFirstLaunchOnboarding(true)
    expect(result).toBe(join(documents, "Default Project"))
    expect(statSync(join(documents, "Default Project")).isDirectory()).toBe(true)
    expect(values.get(FIRST_LAUNCH_ONBOARDING_COMPLETE_KEY)).toBe(true)
    expect(warns()).toHaveLength(0)
  })

  test("an existing Default Project folder is kept with its content (unchanged)", async () => {
    mkdirSync(join(documents, "Default Project"), { recursive: true })
    writeFileSync(join(documents, "Default Project", "keep.txt"), "synthetic")
    const result = await onboarding.finishFirstLaunchOnboarding(true)
    expect(result).toBe(join(documents, "Default Project"))
    expect(readFileSync(join(documents, "Default Project", "keep.txt"), "utf8")).toBe("synthetic")
    expect(values.get(FIRST_LAUNCH_ONBOARDING_COMPLETE_KEY)).toBe(true)
  })

  test("declining creates nothing and completes (unchanged)", async () => {
    expect(await onboarding.finishFirstLaunchOnboarding(false)).toBeNull()
    expect(existsSync(documents)).toBe(false)
    expect(values.get(FIRST_LAUNCH_ONBOARDING_COMPLETE_KEY)).toBe(true)
  })
})
