import { describe, expect, test } from "bun:test"
import { BASELINE_CONFIG } from "@opencode-ai/core/swarm-defaults"

// S-02 (1.2.6 row 56b, register N-100): the planner and document-writer Studio allow list.
// Imported dynamically so that, at a base without the export, the file still loads and every case fails on its
// assertion (expected/received) rather than on a module-link error.
const { AGENT_BASELINE, STUDIO_SUBAGENT_TOOLS } = await import("@opencode-ai/core/swarm-permission-baseline")

const PREFIX = "datum-studio_studio_"
const EXPECTED = [
  "figure_preview",
  "figure_revise",
  "document_get",
  "document_status",
  "document_structure",
  "search",
  "contracts_query",
  "templates_list",
  "template_get",
  "registry",
  "file_verify",
  "mission_get",
  "mission_list",
].map((tool) => PREFIX + tool)
const EXPECTED_PERMISSION = Object.fromEntries(EXPECTED.map((tool) => [tool, "allow"]))

const list = (): readonly string[] => STUDIO_SUBAGENT_TOOLS ?? []
const agentPermission = (source: Record<string, { permission?: Record<string, unknown> } | undefined>, name: string) =>
  source[name]?.permission

describe("STUDIO_SUBAGENT_TOOLS", () => {
  test("holds figure_preview, figure_revise and the read subset, file_verify included (C9)", () => {
    expect([...list()].sort()).toEqual([...EXPECTED].sort())
  })

  test("answer_decision and asset_put are absent; no wildcard, no write tool", () => {
    expect(list().length).toBe(EXPECTED.length)
    expect(list()).not.toContain(PREFIX + "mission_answer_decision")
    expect(list()).not.toContain(PREFIX + "asset_put")
    expect(list().some((tool) => tool.includes("*"))).toBe(false)
    for (const write of ["document_create", "slot_fill", "render", "write", "edit", "report_submit", "mission_update_row"])
      expect(list()).not.toContain(PREFIX + write)
  })

  test("planner and document-writer allow exactly the list through the shipped config slot", () => {
    for (const name of ["planner", "document-writer"]) {
      expect(agentPermission(AGENT_BASELINE, name)).toEqual(EXPECTED_PERMISSION)
      expect(agentPermission(BASELINE_CONFIG.agent, name)).toEqual(EXPECTED_PERMISSION)
    }
    expect(BASELINE_CONFIG.agent.researcher.mode).toBe("subagent")
  })
})
