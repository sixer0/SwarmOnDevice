import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// 1.2.9 row 59 (AC-C10b, N9-140; decisions C7(d), C13 OP-15-3). When the Documents folder itself is a symbolic link,
// the desktop neither tells the sidecar a Default Project path through it nor makes the Default Project through it:
// launchDefaultProjectDir() answers undefined (lstat of the parent, one level up only) and first-launch onboarding
// answers null with the reason "documents folder is a link" (N9-013), logged at warn with no path, onboarding still
// pending and nothing created in the link's target. A real Documents folder behaves as before.
// Red at d4282fcfd8: lstat looks only at the last segment, so the path is passed through the link, and onboarding's
// stat follows the link and makes "Default Project" inside the target.
// Layout: documentsLinkLayout (N9-159) from the opencode syn129 module, built under this file's scratch "real-home";
// the person's Documents is never used.

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

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "c10b-")))
const realHome = join(scratch, "real-home")
mkdirSync(realHome, { recursive: true })
let documents = join(realHome, "Documents")
mock.module("electron", () => ({
  app: { getPath: (name: string) => (name === "documents" ? documents : join(scratch, "other", name)) },
}))

const onboarding = await import("./onboarding")
const { prepareOnboardingTestRoot, registerRealDocuments } = await import("./onboarding-test-root")
const { createSidecarEnv, launchDefaultProjectDir } = await import("./sidecar-env")
const { FIRST_LAUNCH_ONBOARDING_COMPLETE_KEY } = await import("./store-keys")

type Layout = {
  root: string
  case: string
  elsewhere: string
  documents: string
  target: string
  defaultProject: string
  realDefaultProject: string
  cleanup: () => Promise<void>
}
// A computed specifier keeps the opencode test sources out of this package's tsgo program
// (precedent opencode test/session/installed-tools.test.ts:31-39; the module imports node built-ins only).
const syn129 = (await import(["..", "..", "..", "opencode", "test", "fixture", "syn129-layouts.ts"].join("/"))) as {
  documentsLinkLayout: (options?: { parent?: string; defaultProject?: boolean; dangling?: boolean }) => Promise<Layout>
}

const KEY = "SWARM_DEFAULT_PROJECT_DIR"
const REASON = "documents folder is a link"
const layouts: Layout[] = []

async function linkedDocuments(options?: { defaultProject?: boolean; dangling?: boolean }) {
  const layout = await syn129.documentsLinkLayout({ parent: realHome, ...options })
  layouts.push(layout)
  documents = layout.documents
  return layout
}

/** sha256 over every entry under `dir` (relative path, kind, link target or file bytes); "absent" when missing. */
function treeHash(dir: string) {
  const hash = createHash("sha256")
  if (!existsSync(dir)) return "absent"
  const walk = (at: string, rel: string) => {
    for (const name of readdirSync(at).sort()) {
      const full = join(at, name)
      const entry = lstatSync(full)
      const key = join(rel, name)
      if (entry.isSymbolicLink()) hash.update(`L ${key} -> ${readlinkSync(full)}\n`)
      else if (entry.isDirectory()) {
        hash.update(`D ${key}\n`)
        walk(full, key)
      } else hash.update(`F ${key} `).update(readFileSync(full)).update("\n")
    }
  }
  walk(dir, "")
  return hash.digest("hex")
}

const warns = () => logs.filter((line) => line.level === "warn")

beforeEach(() => {
  values.clear()
  logs.length = 0
  prepareOnboardingTestRoot({})
  documents = join(realHome, "Documents")
  // The resolver is process-wide (onboarding-test-root); this file registers its own, as r7 and r18c do.
  registerRealDocuments(() => documents)
})

afterEach(async () => {
  registerRealDocuments(() => {
    throw new Error("no Documents folder")
  })
  for (const layout of layouts.splice(0)) await layout.cleanup()
  rmSync(join(realHome, "Documents"), { recursive: true, force: true })
})

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

describe("AC-C10b sidecar: a linked Documents is not passed on", () => {
  test("Documents is a link to a folder holding a Default Project: undefined, no key for the sidecar", async () => {
    const layout = await linkedDocuments()
    expect(statSync(layout.defaultProject).isDirectory()).toBe(true)
    expect(launchDefaultProjectDir()).toBeUndefined()
    expect(KEY in createSidecarEnv({ PATH: "/bin", [KEY]: "/inherited" }, undefined, "darwin")).toBe(false)
  })

  test("Documents is a link with no Default Project yet (first launch): not passed on either", async () => {
    await linkedDocuments({ defaultProject: false })
    expect(launchDefaultProjectDir()).toBeUndefined()
  })

  test("a dangling Documents link is a link too", async () => {
    const layout = await linkedDocuments({ dangling: true })
    expect(lstatSync(layout.documents).isSymbolicLink()).toBe(true)
    expect(existsSync(layout.target)).toBe(false)
    expect(launchDefaultProjectDir()).toBeUndefined()
  })

  test("a real Documents folder is unchanged: the path is passed, before and after the folder exists", () => {
    mkdirSync(documents, { recursive: true })
    const expected = join(documents, "Default Project")
    expect(launchDefaultProjectDir()).toBe(expected)
    mkdirSync(expected)
    expect(createSidecarEnv({ PATH: "/bin" }, undefined, "darwin")[KEY]).toBe(expected)
  })
})

describe("AC-C10b onboarding: the Default Project is not made through a linked Documents", () => {
  test("first launch with a linked Documents: null, reason logged at warn with no path, still pending, nothing created", async () => {
    const layout = await linkedDocuments({ defaultProject: false })
    const before = { target: treeHash(layout.target), case: treeHash(layout.case) }

    const result = await onboarding.finishFirstLaunchOnboarding(true)
    expect(result).toBeNull()
    expect(existsSync(layout.realDefaultProject)).toBe(false)
    expect(treeHash(layout.target)).toBe(before.target)
    expect(treeHash(layout.case)).toBe(before.case)
    expect(values.get(FIRST_LAUNCH_ONBOARDING_COMPLETE_KEY)).toBeUndefined()
    expect(onboarding.isFirstLaunchOnboardingPending()).toBe(true)
    expect(warns()).toHaveLength(1)
    expect(warns()[0]?.name).toBe("onboarding")
    expect(warns()[0]?.extra?.reason).toBe(REASON)
    expect(JSON.stringify(warns()[0])).not.toContain(scratch)
  })

  test("a Default Project already inside the link's target is not taken either", async () => {
    const layout = await linkedDocuments()
    const before = treeHash(layout.elsewhere)
    expect(await onboarding.finishFirstLaunchOnboarding(true)).toBeNull()
    expect(treeHash(layout.elsewhere)).toBe(before)
    expect(onboarding.isFirstLaunchOnboardingPending()).toBe(true)
    expect(warns().map((line) => line.extra?.reason)).toEqual([REASON])
  })

  test("a dangling Documents link: same reason, nothing created", async () => {
    const layout = await linkedDocuments({ dangling: true })
    expect(await onboarding.finishFirstLaunchOnboarding(true)).toBeNull()
    expect(existsSync(layout.target)).toBe(false)
    expect(warns().map((line) => line.extra?.reason)).toEqual([REASON])
  })

  test("a real Documents folder is unchanged: the leaf is made and onboarding completes", async () => {
    mkdirSync(documents, { recursive: true })
    const result = await onboarding.finishFirstLaunchOnboarding(true)
    expect(result).toBe(join(documents, "Default Project"))
    expect(statSync(join(documents, "Default Project")).isDirectory()).toBe(true)
    expect(values.get(FIRST_LAUNCH_ONBOARDING_COMPLETE_KEY)).toBe(true)
    expect(warns()).toHaveLength(0)
  })

  test("a missing Documents keeps its 1.2.8 reason", async () => {
    expect(await onboarding.finishFirstLaunchOnboarding(true)).toBeNull()
    expect(warns().map((line) => line.extra?.reason)).toEqual(["documents folder missing"])
  })
})
