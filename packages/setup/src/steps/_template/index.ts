// AUTHORING TEMPLATE — copy to src/steps/<component_id>/index.ts (rows 82-98).
//
// This file proves the STEP CONTRACT the core engine expects. It is under `_template`
// so the directory scan never imports it as a live component; the scan reads only
// step.json. Real steps replace the bodies below with their own behaviour:
//   - install(): fetch+verify (row 82 library), place atomically, configure, health-check.
//   - remove(): delete ONLY objects this component created (label + state manifest), ask
//     before any data volume (P-14). Never prune, never touch the user's default profile.
//
// HARD BOUNDARIES for every step author:
//   - No network primitives in row 81's skeleton. Fetching lives in row 82's verify/fetch
//     library, which steps CALL; do not inline curl/wget/http here.
//   - No sudo/osascript/administrator/chmod-outside-~/.swarm (P-4). If a step needs admin,
//     return SKIPPED_WITH_INSTRUCTIONS and print the exact manual command.
//   - Bind NO port. Ports are compose-side constants (PC-PORT-*); the setup itself never
//     listens (verified by the row-81 grep gate).
//   - Write ONLY inside the P-16 whitelist (~/.swarm/**, ~/.config/swarm/**, the swarm
//     Colima profile dir, /Applications/Obsidian.app only if absent).

import type { ComponentId } from "../../constants.ts"
import type { StateFile } from "../../state.ts"
import type { LockFile } from "../../lockfile.ts"
import type { OutcomeToken } from "../../outcomes.ts"

/** Everything a step is allowed to see. The engine passes the validated lock and the
 *  current state; steps mutate state ONLY through the engine helpers, never by writing
 *  state.json directly (single-writer rule, A-73-3). */
export interface StepContext {
  readonly lock: LockFile
  readonly state: StateFile
  readonly dryRun: boolean
}

export interface StepResult {
  /** Machine-readable outcome token (see outcomes.ts). exitCode is derived from it. */
  readonly token: OutcomeToken
  /** Optional human line printed once; never contains secrets (P-8 redaction). */
  readonly message?: string
}

/** The shape the engine dynamically imports from each src/steps/<id>/index.ts. */
export interface StepModule {
  readonly id: ComponentId
  install(ctx: StepContext): StepResult | Promise<StepResult>
  remove(ctx: StepContext): StepResult | Promise<StepResult>
}

// --- Example implementation (does nothing; safe to run) ---------------------------

export const step: StepModule = {
  id: "runtime",
  install(_ctx: StepContext): StepResult {
    // Row 86 replaces this with the Colima/docker/compose step. Until then it installs
    // nothing and touches nothing, so the skeleton stays honest about "no behaviour yet".
    return { token: "SKIPPED", message: "template step: no behaviour implemented (owned by its row)" }
  },
  remove(_ctx: StepContext): StepResult {
    return { token: "SKIPPED", message: "template step: nothing created, nothing to remove" }
  },
}

export default step
