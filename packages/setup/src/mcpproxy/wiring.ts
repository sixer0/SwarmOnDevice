// Wiring hooks for the config writer (row 97) and baseline owner (row 96) — row 94 dispatch
// item (c)+(b): THIN invocation of the steps' exported resolvers, no init, no config writes.
// This module composes the MCP config ENTRY SHAPES from 01f §6.1/§9 and validates the shipped
// researcher definition (§5.1); it never touches ~/.config/swarm itself (P-15: entries are
// written only after healthy, by row 97; single-writer map).
//
// What each hook guarantees to its consumer:
//   swarmWebMcpEntry()  — §6.1 entry verbatim: type local, command = [PC-PATH-14 absolute],
//                         enabled true, timeout 30000 ms. No env here: the proxy inherits
//                         SWARM_* from the parent environment at spawn (mcp/index.ts merges
//                         entry.env + process.env, 01f §6.1), so no secret ever sits in the file.
//   graftMcpEntry()     — PC-MCP-01 `graft` via r88's graftLaunch (private node + private CLI,
//                         absolute argv, PATH never consulted nor mutated) running `mcp` ONLY.
//                         `graft init` is structurally unreachable from this module (P-10); the
//                         must-be-unset list (01c0:194-198) is asserted before offering an entry.
//   rtkToolPath()       — PC-CMP-04 private binary via r89's rtkBin (tamper-aware). RTK is a
//                         command filter offered as a model-visible skill (01f §8 piece 1), NOT
//                         an MCP server and NOT a rewriting hook (§8.1 blind spot); `rtk init`
//                         never appears in any argv this module can build (P-11/B3).
//   mcpPermissionGates()— §4.2's two per-server named rules, in normative key order, for row
//                         96's baseline merge. Belt-and-braces over the catch-all ask (§4.2).
//   researcherDefinition + validateResearcherDefinition() — §5.1's agent block as shipped JSON,
//                         machine-checked so rows 96/113 assert shape, not vibes (T-W7-6 input).

import { graftLaunch, graftChildEnv, type GraftLaunchResult } from "../steps/graft/index.ts"
import { rtkBin, type RtkBinResult } from "../steps/rtk/index.ts"
import type { LockFile } from "../lockfile.ts"
import { expandTilde } from "../paths.ts"
import { MCP_SERVER_NAME, MCP_STARTUP_TIMEOUT_MS, PROXY_BINARY_PATH } from "./register.ts"
import researcherJson from "./researcher.json"

/** The config-entry shape connectLocal consumes (mcp/index.ts:342-347 `command` array form). */
export interface McpLocalEntry {
  readonly type: "local"
  readonly command: readonly string[]
  readonly enabled: true
  readonly timeout: number
  readonly env?: Readonly<Record<string, string>>
}

export function swarmWebMcpEntry(binaryPath?: string): McpLocalEntry {
  return {
    type: "local",
    command: [binaryPath ?? expandTilde(PROXY_BINARY_PATH)], // PC-PATH-14, absolute
    enabled: true, // written ONLY at healthy (P-15) — that gate is row 97's, not this module's
    timeout: MCP_STARTUP_TIMEOUT_MS,
  }
}

export type GraftEntryResult =
  | { readonly ok: true; readonly entry: McpLocalEntry }
  | { readonly ok: false; readonly reason: string }

/** Env vars that MUST be absent from the proxy/graft child environment (register must-be-unset
 *  list, 01c0:194-198 cited by 01f §9): their presence would route Graft deep-analysis to a
 *  paid LLM provider — forbidden. Names only are referenced here; values are never read/logged. */
const GRAFT_MUST_BE_UNSET = ["GRAFT_PROVIDER", "GRAFT_API_KEY"] as const

export interface GraftEntryOptions {
  readonly lock?: LockFile
  readonly installRoot?: string
  readonly nodeInstallRoot?: string
  /** TEST SEAM ONLY (r88 discipline): replaces the resolver so units drive the success/failure
   *  shapes without a staged private Node+Graft. Cannot weaken anything: the real proof runs
   *  the real resolver, and no fallback path exists regardless of the seam. */
  readonly launch?: (options: {
    lock?: LockFile
    version?: string
    installRoot?: string
    nodeInstallRoot?: string
  }) => GraftLaunchResult
  readonly env?: Readonly<Record<string, string | undefined>>
}

export function graftMcpEntry(opts: GraftEntryOptions = {}): GraftEntryResult {
  const env = opts.env ?? process.env
  const leaked = GRAFT_MUST_BE_UNSET.filter((k) => {
    const v = env[k]
    return v !== undefined && v !== ""
  })
  if (leaked.length > 0)
    return {
      ok: false,
      reason: `must-be-unset environment present (${leaked.join(", ")}); refusing to wire graft (01c0:194-198)`,
    }

  const launch = opts.launch ?? graftLaunch
  const res = launch({
    ...(opts.lock ? { lock: opts.lock } : {}),
    ...(opts.installRoot ? { installRoot: opts.installRoot } : {}),
    ...(opts.nodeInstallRoot ? { nodeInstallRoot: opts.nodeInstallRoot } : {}),
  })
  if (!res.ok || !res.nodePath || !res.cliPath)
    return { ok: false, reason: res.reason ?? "graft resolver returned no paths" }

  // graftChildEnv carries DO_NOT_TRACK=1 (telemetry off, P-10) + the npm-cache redirect; the
  // MCP entry needs only the telemetry knob explicitly — the rest follows process.env at spawn.
  const childEnv = graftChildEnv(env, opts.installRoot)
  return {
    ok: true,
    entry: {
      type: "local",
      command: [res.nodePath, res.cliPath, "mcp"], // the ONE sanctioned subcommand (01f §9)
      enabled: true,
      timeout: MCP_STARTUP_TIMEOUT_MS,
      env: { DO_NOT_TRACK: childEnv.DO_NOT_TRACK ?? "1" },
    },
  }
}

/** Absolute path of the private rtk for row 98's skill text / row 97's plugin env — resolver
 *  facts only; this module builds NO rtk argv whatsoever and offers NO init surface (P-11). */
export function rtkToolPath(options: { lock?: LockFile; version?: string; installRoot?: string } = {}): RtkBinResult {
  return rtkBin(options)
}

/** §4.2's per-server rules in normative order (catch-all first, these last). Returned as
 *  ordered pairs because key order is load-bearing (fromConfig preserves file order,
 *  findLast decides — 01f §2.1) and a Record literal would let a consumer reorder it silently. */
export function mcpPermissionGates(): ReadonlyArray<readonly [string, string]> {
  return [
    ["graft_*", "ask"], // PC-MCP-01 composed names (mcp/catalog.ts sanitize keeps -/_)
    [`${MCP_SERVER_NAME}_*`, "ask"], // PC-MCP-02 composed names
  ]
}

// --- researcher definition (§5.1) -------------------------------------------------------------

export interface ResearcherDefinition {
  readonly agent: {
    readonly researcher: {
      readonly description: string
      readonly mode: "subagent"
      readonly permission: Readonly<Record<string, string>>
    }
  }
}

export const researcherDefinition: ResearcherDefinition = researcherJson as ResearcherDefinition

/** Machine-checkable shape assertions for T-W7-6's `swarm debug agent researcher` counterpart:
 *  returns the list of violations (empty == valid). Row 96 merges THIS object into the global
 *  config; row 113 re-runs the check against the resolved file. */
export function validateResearcherDefinition(def: unknown): string[] {
  const findings: string[] = []
  if (!def || typeof def !== "object") return ["definition is not an object"]
  const root = def as Record<string, unknown>
  const agent = root.agent
  if (!agent || typeof agent !== "object") return ["missing agent block"]
  const researcher = (agent as Record<string, unknown>).researcher
  if (!researcher || typeof researcher !== "object") return ["missing agent.researcher"]
  const r = researcher as Record<string, unknown>
  if (r.mode !== "subagent") findings.push(`mode must be "subagent", got ${JSON.stringify(r.mode)}`)
  if (typeof r.description !== "string" || r.description.trim() === "")
    findings.push("description must be a non-empty string")
  const perm = r.permission
  if (!perm || typeof perm !== "object") return [...findings, "missing permission block"]
  const keys = Object.keys(perm as Record<string, unknown>)
  const p = perm as Record<string, string>
  if (keys[0] !== "*" || p["*"] !== "deny")
    findings.push('permission must START with "*": "deny" (deny-all first; key order is load-bearing, 01f §2.1/§5.1)')
  for (const grant of ["swarm-web_search", "swarm-web_fetch", "swarm-web_vault_inbox"]) {
    if (p[grant] !== "allow") findings.push(`permission.${grant} must be "allow"`)
  }
  if (p["task"] !== "deny")
    findings.push(
      'permission.task must be an explicit "deny" (hides the tool AND opts out of the auto-inject, 01f §5.1)',
    )
  if (p["todowrite"] !== "deny") findings.push('permission.todowrite must be an explicit "deny"')
  const webRegrants = keys.filter((k) => k === "webfetch" || k === "websearch")
  if (webRegrants.length > 0)
    findings.push(
      "the built-in web tools must NOT be re-granted to the researcher (they stay hidden by the baseline, 01f §5.1)",
    )
  return findings
}
