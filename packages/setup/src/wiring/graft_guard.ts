// Graft launch-site enforcement (row 97, task b; contract = masterplan/01f_tool_wiring_spec.md §9 +
// register must-be-unset list 01c0:194-198). r88 already ships the resolvers (graftLaunch /
// graftChildEnv) and r94 composes the MCP config ENTRY from them; this module is the ASSERTION layer
// a launch site runs before it spawns, so "DO_NOT_TRACK=1 at every graft launch" is enforced, not
// assumed. It records one `tool_launch` line to the unified audit chain on success.
//
// What it enforces, each fail-closed:
//   - the child environment carries DO_NOT_TRACK=1 (telemetry off, P-10);
//   - GRAFT_PROVIDER / GRAFT_API_KEY are ABSENT (their presence would route deep analysis to a paid
//     LLM provider — forbidden; names checked, values never read or logged);
//   - the argv is exactly `[<absolute node>, <absolute cli.js>, "mcp"]`: the ONE sanctioned
//     subcommand (01f §9). `graft init` (P-10 — it edits ~/.claude/settings.json etc.) and any deep
//     mode (`--deep`, which sends code to an LLM provider) are structurally rejected here.
//
// It edits nothing in steps/graft or mcpproxy; it consumes their exports.

import { graftMcpEntry, type GraftEntryOptions, type McpLocalEntry } from "../mcpproxy/wiring.ts"
import { appendChainEvent, type ChainOptions } from "./audit_chain.ts"

/** Register must-be-unset list (01c0:194-198). Names only; values are never inspected or logged. */
export const GRAFT_MUST_BE_UNSET: readonly string[] = ["GRAFT_PROVIDER", "GRAFT_API_KEY"]

/** Subcommand words that must never appear anywhere in a graft argv this guard clears. */
const FORBIDDEN_GRAFT_WORDS: readonly string[] = ["init", "--deep", "-deep", "deep"]

export interface GraftEnvCheck {
  readonly ok: boolean
  readonly violations: readonly string[]
}

/** Assert a graft child environment carries the telemetry-off knob and none of the must-be-unset
 *  secrets. Returns every violation found (empty == clean). Pure: reads nothing but the map. */
export function assertGraftChildEnv(env: Readonly<Record<string, string | undefined>>): GraftEnvCheck {
  const violations: string[] = []
  if (env.DO_NOT_TRACK !== "1")
    violations.push('DO_NOT_TRACK must equal "1" at a graft launch site (telemetry off, P-10)')
  for (const key of GRAFT_MUST_BE_UNSET) {
    const v = env[key]
    if (v !== undefined && v !== "") violations.push(`${key} must be absent (01c0:194-198)`)
  }
  return { ok: violations.length === 0, violations }
}

/** Assert a composed graft argv is the single sanctioned `[node, cli, "mcp"]` shape with absolute
 *  binaries and no forbidden word. Pure: inspects the array only. */
export function assertGraftArgvSanctioned(argv: readonly string[]): GraftEnvCheck {
  const violations: string[] = []
  if (argv.length !== 3) violations.push(`graft argv must be exactly [node, cli, "mcp"], got ${argv.length} element(s)`)
  if (!argv[0]?.startsWith("/")) violations.push("argv[0] (private node) must be absolute")
  if (!argv[1]?.startsWith("/")) violations.push("argv[1] (private graft CLI) must be absolute")
  if (argv[2] !== "mcp") violations.push(`argv[2] must be the "mcp" subcommand, got ${JSON.stringify(argv[2])}`)
  for (const word of argv) {
    if (FORBIDDEN_GRAFT_WORDS.includes(word))
      violations.push(`forbidden graft word "${word}" present (init / deep are unreachable, P-10)`)
  }
  return { ok: violations.length === 0, violations }
}

export type GraftLaunchGuardResult =
  | { readonly ok: true; readonly entry: McpLocalEntry; readonly auditLine: string }
  | { readonly ok: false; readonly reason: string }

export interface GraftLaunchGuardOptions extends GraftEntryOptions {
  readonly chain?: ChainOptions
  readonly correlationId?: string
  readonly now?: () => string
}

/**
 * THE launch-site gate: compose the graft MCP entry via r94's resolver hook, then assert every
 * invariant before it would be spawned. On any violation the entry is refused (never handed back),
 * so a caller cannot accidentally launch an un-telemetry-off or deep-mode graft. On success one
 * `tool_launch` line is appended to the audit chain.
 */
export function graftLaunchGuard(opts: GraftLaunchGuardOptions = {}): GraftLaunchGuardResult {
  const res = graftMcpEntry(opts)
  if (!res.ok) return { ok: false, reason: res.reason }

  const argvCheck = assertGraftArgvSanctioned(res.entry.command)
  if (!argvCheck.ok) return { ok: false, reason: argvCheck.violations.join("; ") }

  const envCheck = assertGraftChildEnv({ ...graftEnvView(res.entry.env) })
  if (!envCheck.ok) return { ok: false, reason: envCheck.violations.join("; ") }

  const auditLine = appendChainEvent(
    {
      ts: opts.now?.() ?? new Date().toISOString(),
      kind: "tool_launch",
      source: "swarm-setup.wiring.graft_guard",
      decision: "launched",
      tool: "graft",
      argv: res.entry.command,
      telemetryOff: res.entry.env?.DO_NOT_TRACK === "1",
      mustBeUnsetOk: true,
      ...(opts.correlationId !== undefined ? { correlationId: opts.correlationId } : {}),
    },
    opts.chain ?? {},
  )

  return { ok: true, entry: res.entry, auditLine }
}

/** The MCP entry only carries the explicit DO_NOT_TRACK knob; the must-be-unset secrets are asserted
 *  against the CALLER's environment by graftMcpEntry itself (r94 refuses the entry if present). View
 *  merges both so the guard reports the same posture a spawn would see. */
function graftEnvView(entryEnv?: Readonly<Record<string, string>>): Record<string, string | undefined> {
  const view: Record<string, string | undefined> = {}
  for (const key of GRAFT_MUST_BE_UNSET) view[key] = process.env[key]
  if (entryEnv) Object.assign(view, entryEnv)
  return view
}
