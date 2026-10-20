// Row-98 handoff surface (row 97, task e). Row 98 writes the tool-usage skills and the researcher
// prompt text; every fact it must state is exposed here as ONE machine-readable object so the skill
// prose can never drift from the shipped wiring (the same discipline r95 applied to vaultSkillFacts
// and r94 to mcpPermissionGates). Nothing is invented: each field is composed from an already-shipped
// export or cited to 01f. Row 98 imports this instead of re-typing constants.

import { researcherDefinition, validateResearcherDefinition, mcpPermissionGates } from "../mcpproxy/wiring.ts"
import { vaultSkillFacts } from "../vault/writer.ts"
import { rtkTelemetryPosture, type RtkTelemetryPosture } from "./rtk_invocation.ts"
import { GRAFT_MUST_BE_UNSET } from "./graft_guard.ts"
import type { LockFile } from "../lockfile.ts"

/** PC-MCP-01 server name `graft` (01c0:207, cited by 01f §9). Composed tool names the baseline gates
 *  are `<server>_<tool>` per mcp/catalog.ts sanitize (keeps `-`/`_`). */
export const GRAFT_SERVER_NAME = "graft"

/** The single sanctioned graft subcommand row 98 may name in a skill (01f §9). */
export const GRAFT_SANCTIONED_SUBCOMMAND = "mcp"

export interface ResearcherReturnContract {
  readonly summaryRequired: true
  readonly sourceListWithUrlsAndFetchTimes: true
  readonly untrustedAttributionRequired: true
  readonly rawPageBodiesMayBePasted: false
  readonly nonceMakesTranscriptAuditable: true
}

export interface GraftFacts {
  readonly serverName: string
  readonly sanctionedSubcommand: string
  readonly forbiddenInit: true
  readonly forbiddenDeepMode: true
  readonly telemetryKnob: "DO_NOT_TRACK=1"
  readonly mustBeUnset: readonly string[]
  readonly gateRule: readonly [string, string]
}

export interface RtkFacts {
  /** Absolute private binary path shape; row 98 prints the PATH-FREE invocation rule, never a PATH hint. */
  readonly invokedByAbsolutePathOnly: true
  readonly addedToPath: false
  readonly silentRewritingShipped: false
  readonly recallControlDeferredToRow: 98
  readonly filteredOutputIsNotEvidence: true
  readonly telemetry: RtkTelemetryPosture
}

export interface ResearcherAssemblyInputs {
  readonly researcher: typeof researcherDefinition
  readonly researcherValid: boolean
  readonly permissionGates: ReadonlyArray<readonly [string, string]>
  readonly vault: ReturnType<typeof vaultSkillFacts>
  readonly graft: GraftFacts
  readonly rtk: RtkFacts
  readonly returnContract: ResearcherReturnContract
  readonly oneSpawnAtATime: true
  readonly resumeByTaskIdNotRespawn: true
  readonly webToolsUnavailableFallback: "report web tools unavailable; never fall back to bash curl"
}

/**
 * Assemble the inputs row 98 cites. `researcherValid` runs r94's validator over the shipped object so
 * a broken definition surfaces here rather than in prose. Pass the reviewed lock to bind the RTK
 * never_run list to the same source of truth the guard uses.
 */
export function researcherAssemblyInputs(lock?: LockFile): ResearcherAssemblyInputs {
  return {
    researcher: researcherDefinition,
    researcherValid: validateResearcherDefinition(researcherDefinition).length === 0,
    permissionGates: mcpPermissionGates(),
    vault: vaultSkillFacts(),
    graft: {
      serverName: GRAFT_SERVER_NAME,
      sanctionedSubcommand: GRAFT_SANCTIONED_SUBCOMMAND,
      forbiddenInit: true,
      forbiddenDeepMode: true,
      telemetryKnob: "DO_NOT_TRACK=1",
      mustBeUnset: GRAFT_MUST_BE_UNSET,
      gateRule: ["graft_*", "ask"],
    },
    rtk: {
      invokedByAbsolutePathOnly: true,
      addedToPath: false,
      silentRewritingShipped: false,
      recallControlDeferredToRow: 98,
      filteredOutputIsNotEvidence: true,
      telemetry: rtkTelemetryPosture(lock),
    },
    returnContract: {
      summaryRequired: true,
      sourceListWithUrlsAndFetchTimes: true,
      untrustedAttributionRequired: true,
      rawPageBodiesMayBePasted: false,
      nonceMakesTranscriptAuditable: true,
    },
    oneSpawnAtATime: true,
    resumeByTaskIdNotRespawn: true,
    webToolsUnavailableFallback: "report web tools unavailable; never fall back to bash curl",
  }
}
