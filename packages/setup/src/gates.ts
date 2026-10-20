// Platform gate (P-20, 03e:197 / 01c §2) and root refusal (P-4, 03e:181 / 01c §2).
// These run FIRST for every command, before the lock, the lock-file load, and any
// consent prompt (01c §11 step 1). Both are one-line refusals with no writes.

import { platform, arch } from "node:os"
import { OUTCOME, type OutcomeToken } from "./outcomes.ts"

/** P-20: macOS arm64 only. Rejects anything else with a one-line message. */
export function checkPlatform(): OutcomeToken | null {
  if (platform() !== "darwin" || arch() !== "arm64") {
    return OUTCOME.REFUSED_PLATFORM
  }
  return null
}

/** P-4: never run as root (uid 0). On POSIX getuid is available; if it is somehow
 *  absent we do not assume root. */
export function checkNotRoot(): OutcomeToken | null {
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined
  if (uid === 0) {
    return OUTCOME.REFUSED_ROOT
  }
  return null
}

/** Combined first gate. Returns the first refusal token, or null to proceed. */
export function runEntryGates(): OutcomeToken | null {
  return checkPlatform() ?? checkNotRoot()
}
