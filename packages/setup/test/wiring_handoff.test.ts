// Row-97 unit tests — row-98 handoff surface (task e). Asserts the assembled object exposes every
// input row 98 needs and that each field is composed from the shipped source (not re-typed), so the
// skill/prompt prose cannot silently drift from the wiring. Run TARGETED: cd packages/setup && bun test test/wiring_handoff.test.ts

import { describe, it, expect } from "bun:test"
import { researcherAssemblyInputs, GRAFT_SERVER_NAME, GRAFT_SANCTIONED_SUBCOMMAND } from "../src/wiring/handoff_98.ts"
import { researcherDefinition, mcpPermissionGates } from "../src/mcpproxy/wiring.ts"
import { vaultSkillFacts } from "../src/vault/writer.ts"

describe("researcherAssemblyInputs (row 98 final-assembly inputs)", () => {
  const inputs = researcherAssemblyInputs()

  it("exposes the shipped researcher object verbatim and reports it valid", () => {
    expect(inputs.researcher).toEqual(researcherDefinition)
    expect(inputs.researcherValid).toBe(true)
    expect(inputs.researcher.agent.researcher.mode).toBe("subagent")
  })

  it("permission gates are the same ordered pairs r94 ships (graft_* then swarm-web_*)", () => {
    expect(inputs.permissionGates).toEqual(mcpPermissionGates())
    expect(inputs.permissionGates).toEqual([
      ["graft_*", "ask"],
      ["swarm-web_*", "ask"],
    ])
  })

  it("vault facts are passed through from r95 unchanged", () => {
    expect(inputs.vault).toEqual(vaultSkillFacts())
    expect(inputs.vault.toolName).toBe("swarm-web_vault_inbox")
    expect(inputs.vault.createOnly).toBe(true)
    expect(inputs.vault.communityPluginUsed).toBe(false)
  })

  it("graft facts name the server, the one sanctioned subcommand, and the must-be-unset list", () => {
    expect(inputs.graft.serverName).toBe(GRAFT_SERVER_NAME)
    expect(GRAFT_SERVER_NAME).toBe("graft")
    expect(inputs.graft.sanctionedSubcommand).toBe(GRAFT_SANCTIONED_SUBCOMMAND)
    expect(GRAFT_SANCTIONED_SUBCOMMAND).toBe("mcp")
    expect(inputs.graft.forbiddenInit).toBe(true)
    expect(inputs.graft.forbiddenDeepMode).toBe(true)
    expect(inputs.graft.telemetryKnob).toBe("DO_NOT_TRACK=1")
    expect(inputs.graft.mustBeUnset).toEqual(["GRAFT_PROVIDER", "GRAFT_API_KEY"])
    expect(inputs.graft.gateRule).toEqual(["graft_*", "ask"])
  })

  it("rtk facts carry the absolute-path / no-rewrite / deferred-recall posture + telemetry", () => {
    expect(inputs.rtk.invokedByAbsolutePathOnly).toBe(true)
    expect(inputs.rtk.addedToPath).toBe(false)
    expect(inputs.rtk.silentRewritingShipped).toBe(false)
    expect(inputs.rtk.recallControlDeferredToRow).toBe(98)
    expect(inputs.rtk.filteredOutputIsNotEvidence).toBe(true)
    expect(inputs.rtk.telemetry.telemetryDefault).toBe("off")
  })

  it("return contract forbids pasting raw pages and requires untrusted attribution (§5.3)", () => {
    expect(inputs.returnContract.rawPageBodiesMayBePasted).toBe(false)
    expect(inputs.returnContract.untrustedAttributionRequired).toBe(true)
    expect(inputs.returnContract.sourceListWithUrlsAndFetchTimes).toBe(true)
    expect(inputs.returnContract.nonceMakesTranscriptAuditable).toBe(true)
  })

  it("one-spawn-at-a-time + resume-by-task-id + no-bash-curl fallback are stated (§5.1/§5.2)", () => {
    expect(inputs.oneSpawnAtATime).toBe(true)
    expect(inputs.resumeByTaskIdNotRespawn).toBe(true)
    expect(inputs.webToolsUnavailableFallback).toContain("never fall back to bash curl")
  })
})
