import { existsSync, readdirSync } from "node:fs"
import { mkdir, stat } from "node:fs/promises"
import { userInfo } from "node:os"
import { dirname, join } from "node:path"
import { app } from "electron"
import { getStore } from "./store"
import { FIRST_LAUNCH_ONBOARDING_COMPLETE_KEY, OLD_LAYOUT_ELIGIBLE_KEY, SETUP_TOOLS_OFFERED_RELEASE } from "./store-keys"
import { write as writeLog } from "./logging"
import { hasExistingAppState } from "./install-state"
import { SETUP_COMPONENT_IDS, readHealthySetupComponents } from "./setup-runner"
import { DEFAULT_PROJECT_DIR, documentsDir, registerRealDocuments } from "./onboarding-test-root"

// The real Documents folder, for launches outside test onboarding mode. In test mode (R-7, 1.2.8 row 25)
// onboarding-test-root.ts answers with the test root's Documents instead, so the Default Project never lands in
// the person's real Documents during a test. sidecar-env.ts reads the same answer (SWARM_DEFAULT_PROJECT_DIR).
registerRealDocuments(() => app.getPath("documents"))

/** The Default Project root this launch uses (it may not exist yet). */
export function defaultProjectPath() {
  return join(documentsDir() ?? app.getPath("documents"), DEFAULT_PROJECT_DIR)
}

// Equal to SWARM_RELEASE in electron-builder.config.ts (Info.plist SwarmRelease); onboarding.test.ts
// fails if they drift. The main bundle cannot import the builder config.
export const SWARM_RELEASE = "1.2.8"

export function initializeOldLayoutEligibility(userDataPath: string) {
  const entries = existsSync(userDataPath) ? readdirSync(userDataPath, { withFileTypes: true }) : []
  const store = getStore()
  const current = store.get(OLD_LAYOUT_ELIGIBLE_KEY)
  if (typeof current === "boolean") return current

  const eligible = hasExistingAppState(entries)
  store.set(OLD_LAYOUT_ELIGIBLE_KEY, eligible)
  return eligible
}

export function isOldLayoutEligible() {
  return getStore().get(OLD_LAYOUT_ELIGIBLE_KEY) === true
}

export function isFirstLaunchOnboardingPending() {
  const pending = getStore().get(FIRST_LAUNCH_ONBOARDING_COMPLETE_KEY) !== true
  writeLog("onboarding", "first launch onboarding pending checked", { pending })
  return pending
}

export function isSetupToolsOfferPending(home = userInfo().homedir) {
  const offered = getStore().get(SETUP_TOOLS_OFFERED_RELEASE) === SWARM_RELEASE
  // A missing, oversized, unreadable or malformed state.json counts as nothing healthy (setup-runner.ts),
  // so the offer is shown rather than silently skipped.
  const healthy = offered ? 0 : readHealthySetupComponents(home).length
  const pending = !offered && healthy < SETUP_COMPONENT_IDS.length
  writeLog("onboarding", "setup tools offer pending checked", { pending, offered, healthy })
  return pending
}

export function markSetupToolsOffered() {
  getStore().set(SETUP_TOOLS_OFFERED_RELEASE, SWARM_RELEASE)
  writeLog("onboarding", "setup tools offered", { release: SWARM_RELEASE })
}

const errorCode = (error: unknown) =>
  typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : "unknown"

// 1.2.8 R-18c (row 30b): the Default Project is made as the U-8 Recreate makes a folder (SR7-13 rule 1): the leaf
// only, inside a Documents folder that exists. A Documents folder that no longer exists is not recreated and a
// non-folder at the path is left alone. Resolves to undefined when the folder is there, else the reason (no path).
async function makeDefaultProjectFolder(path: string): Promise<string | undefined> {
  const documents = await stat(dirname(path)).catch(() => null)
  if (!documents?.isDirectory()) return "documents folder missing"
  const existing = await stat(path).catch(() => null)
  if (existing) return existing.isDirectory() ? undefined : "not a folder"
  try {
    await mkdir(path)
    return undefined
  } catch (error) {
    // EEXIST: made meanwhile; fine when it is a folder.
    if ((await stat(path).catch(() => null))?.isDirectory()) return undefined
    return `mkdir failed: ${errorCode(error)}`
  }
}

export async function finishFirstLaunchOnboarding(createDefaultProject: boolean) {
  if (!isFirstLaunchOnboardingPending()) {
    writeLog("onboarding", "first launch onboarding already completed")
    return null
  }

  const defaultProject = createDefaultProject ? defaultProjectPath() : null
  if (defaultProject) {
    const reason = await makeDefaultProjectFolder(defaultProject)
    if (reason) {
      // Nothing is opened and onboarding stays pending, so the next launch offers the Default Project again.
      writeLog("onboarding", "default project folder not available", { reason }, "warn")
      return null
    }
  }

  getStore().set(FIRST_LAUNCH_ONBOARDING_COMPLETE_KEY, true)
  writeLog("onboarding", "first launch onboarding completed", { createDefaultProject, defaultProject })
  return defaultProject
}
