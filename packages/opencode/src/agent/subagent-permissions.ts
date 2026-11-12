import { isDeepStrictEqual } from "node:util"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { STUDIO_SUBAGENT_TOOLS } from "@opencode-ai/core/swarm-permission-baseline"
import { DATUM_STUDIO_MCP } from "@/mcp/datum-studio"
import { McpCatalog } from "@/mcp/catalog"
import type { Agent } from "./agent"

/**
 * Build the `permission` ruleset for a subagent's session when it's spawned
 * via the task tool. Combines:
 *
 * 1. The parent session's deny rules and external_directory rules.
 *    Parent agent restrictions only govern that agent; the subagent's own
 *    permissions determine its capabilities.
 * 2. Default `todowrite` and `task` denies if the subagent's own ruleset
 *    doesn't already permit them.
 */
export function deriveSubagentSessionPermission(input: {
  parentSessionPermission: PermissionV1.Ruleset
  subagent: Agent.Info
}): PermissionV1.Ruleset {
  const canTask = input.subagent.permission.some((rule) => rule.permission === "task")
  const canTodo = input.subagent.permission.some((rule) => rule.permission === "todowrite")
  return [
    ...input.parentSessionPermission.filter(
      (rule) => rule.permission === "external_directory" || rule.action === "deny",
    ),
    ...(canTodo ? [] : [{ permission: "todowrite" as const, pattern: "*" as const, action: "deny" as const }]),
    ...(canTask ? [] : [{ permission: "task" as const, pattern: "*" as const, action: "deny" as const }]),
  ]
}

/**
 * S-02 / SEC-13 (1.2.6 row 56): whether the shipped `STUDIO_SUBAGENT_TOOLS` allows may stand. A tool key
 * `datum-studio_<tool>` names a server only by its sanitised name, so the allows are bound to the built-in entry here:
 *
 * - the `datum-studio` entry in effect must be exactly the built-in one (`builtin`, from DatumStudioMcp.builtin).
 *   A user, project or managed entry that replaces or changes it (other command, environment, url, type) is a user
 *   server under the same name; no built-in at all (terminal CLI, tests) means nothing can be bound;
 * - no other enabled server may have a sanitised name that equals `datum-studio` or starts with `datum-studio_`,
 *   because `<server>_<tool>` could then compose one of the same keys (e.g. server `datum-studio.studio`, tool
 *   `figure_preview`). Row 56a also refuses those at load. Both use McpCatalog.reservedServerName, which compares
 *   case-insensitively (gate M2 S4), so `Datum-Studio_x` counts here exactly as it does at load.
 *
 * `enabled` and `timeout` do not change which program answers, so they are ignored in the comparison.
 */
export function studioToolsBound(
  mcp: Readonly<Record<string, unknown>> | undefined,
  builtin: Readonly<Record<string, unknown>> | undefined,
): boolean {
  if (builtin === undefined) return false
  const entries = mcp ?? {}
  const own = entries[DATUM_STUDIO_MCP]
  if (!isRecord(own) || own.enabled === false) return false
  if (!isDeepStrictEqual(McpCatalog.serverIdentity(own), McpCatalog.serverIdentity(builtin))) return false
  // Gate M2 S4: the same reserved-name rule as the load/add refusal (case-insensitive sanitised compare).
  return !Object.entries(entries).some(
    ([name, entry]) =>
      name !== DATUM_STUDIO_MCP && !(isRecord(entry) && entry.enabled === false) && McpCatalog.reservedServerName(name),
  )
}

const STUDIO_TOOL_KEYS: ReadonlySet<string> = new Set(STUDIO_SUBAGENT_TOOLS)

/** The ruleset without the allow rules for `STUDIO_SUBAGENT_TOOLS` keys; every other rule (and any deny/ask) stays. */
export function withoutStudioAllows(ruleset: PermissionV1.Ruleset): PermissionV1.Ruleset {
  return ruleset.filter((rule) => !(rule.action === "allow" && STUDIO_TOOL_KEYS.has(rule.permission)))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
