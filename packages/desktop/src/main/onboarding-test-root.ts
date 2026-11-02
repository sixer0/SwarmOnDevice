import { randomUUID } from "node:crypto"
import { mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { isAbsolute, join } from "node:path"

// Lives apart from index.ts because importing that file needs a running Electron.
// OPENCODE_TEST_ONBOARDING_ROOT only has meaning inside OPENCODE_TEST_ONBOARDING=1: it keeps
// state across restarts of a test instance, and outside test mode it must not be read.
export function prepareOnboardingTestRoot(env: NodeJS.ProcessEnv) {
  if (env.OPENCODE_TEST_ONBOARDING !== "1") return

  const fixed = env.OPENCODE_TEST_ONBOARDING_ROOT
  const persistent = fixed !== undefined && isAbsolute(fixed)
  const root = persistent ? fixed : join(tmpdir(), `swarm-onboarding-${randomUUID()}`)
  if (!persistent) rmSync(root, { recursive: true, force: true })
  ;["data", "config", "cache", "state", "desktop", "session"].forEach((dir) =>
    mkdirSync(join(root, dir), { recursive: true }),
  )
  env.OPENCODE_DB = persistent ? join(root, "data", "test.db") : ":memory:"
  env.XDG_DATA_HOME = join(root, "data")
  env.XDG_CONFIG_HOME = join(root, "config")
  env.XDG_CACHE_HOME = join(root, "cache")
  env.XDG_STATE_HOME = join(root, "state")
  return root
}
