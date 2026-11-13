import { randomUUID } from "node:crypto"
import { mkdirSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { isAbsolute, join } from "node:path"

export const DEFAULT_PROJECT_DIR = "Default Project"

// The test root's Documents while this process runs in test onboarding mode, else undefined (AC-R7, 1.2.8 row 25).
let testDocuments: string | undefined
// Where the real Documents folder is (app.getPath("documents")); registered by onboarding.ts, which may import Electron.
let realDocuments: (() => string) | undefined

// Lives apart from index.ts because importing that file needs a running Electron.
// OPENCODE_TEST_ONBOARDING_ROOT only has meaning inside OPENCODE_TEST_ONBOARDING=1: it keeps
// state across restarts of a test instance, and outside test mode it must not be read.
export function prepareOnboardingTestRoot(env: NodeJS.ProcessEnv) {
  testDocuments = undefined
  if (env.OPENCODE_TEST_ONBOARDING !== "1") return

  const fixed = env.OPENCODE_TEST_ONBOARDING_ROOT
  const persistent = fixed !== undefined && isAbsolute(fixed)
  const root = persistent ? fixed : join(tmpdir(), `swarm-onboarding-${randomUUID()}`)
  if (!persistent) rmSync(root, { recursive: true, force: true })
  ;["data", "config", "cache", "state", "desktop", "session", "Documents"].forEach((dir) =>
    mkdirSync(join(root, dir), { recursive: true }),
  )
  env.OPENCODE_DB = persistent ? join(root, "data", "test.db") : ":memory:"
  env.XDG_DATA_HOME = join(root, "data")
  env.XDG_CONFIG_HOME = join(root, "config")
  env.XDG_CACHE_HOME = join(root, "cache")
  env.XDG_STATE_HOME = join(root, "state")
  // R-7: the Default Project (and anything else placed in Documents) stays inside the test root.
  testDocuments = join(root, "Documents")
  return root
}

export function registerRealDocuments(resolve: () => string) {
  realDocuments = resolve
}

/** The Documents folder this launch uses: the test root's in test onboarding mode, else the real one (or undefined). */
export function documentsDir() {
  if (testDocuments) return testDocuments
  try {
    return realDocuments?.()
  } catch {
    return undefined
  }
}

/** The Default Project root for this launch, whether or not it exists yet. */
export function defaultProjectDir() {
  const documents = documentsDir()
  return documents ? join(documents, DEFAULT_PROJECT_DIR) : undefined
}

/** The Default Project root only when it exists as a directory (what the sidecar may be told, AC-PROJa). */
export function existingDefaultProjectDir() {
  const dir = defaultProjectDir()
  if (!dir || !isAbsolute(dir)) return undefined
  try {
    return statSync(dir).isDirectory() ? dir : undefined
  } catch {
    return undefined
  }
}
