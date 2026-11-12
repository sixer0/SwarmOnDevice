import { existsSync, readdirSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import { userInfo } from "node:os"
import { join } from "node:path"
import { app } from "electron"
import { getStore } from "./store"
import { FIRST_LAUNCH_ONBOARDING_COMPLETE_KEY, OLD_LAYOUT_ELIGIBLE_KEY, SETUP_TOOLS_OFFERED_RELEASE } from "./store-keys"
import { write as writeLog } from "./logging"
import { hasExistingAppState } from "./install-state"
import { SETUP_COMPONENT_IDS, readHealthySetupComponents } from "./setup-runner"

const DEFAULT_PROJECT_DIR = "Default Project"

// Equal to SWARM_RELEASE in electron-builder.config.ts (Info.plist SwarmRelease); onboarding.test.ts
// fails if they drift. The main bundle cannot import the builder config.
export const SWARM_RELEASE = "1.2.6"

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

export async function finishFirstLaunchOnboarding(createDefaultProject: boolean) {
  if (!isFirstLaunchOnboardingPending()) {
    writeLog("onboarding", "first launch onboarding already completed")
    return null
  }

  const defaultProject = createDefaultProject ? join(app.getPath("documents"), DEFAULT_PROJECT_DIR) : null
  if (defaultProject) await mkdir(defaultProject, { recursive: true })

  getStore().set(FIRST_LAUNCH_ONBOARDING_COMPLETE_KEY, true)
  writeLog("onboarding", "first launch onboarding completed", { createDefaultProject, defaultProject })
  return defaultProject
}
