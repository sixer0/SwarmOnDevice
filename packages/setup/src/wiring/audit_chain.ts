// Unified audit chain (row 97, task d; contract = masterplan/01f_tool_wiring_spec.md §6.6 and the
// §3 "one audit line per call" evidence rule). The proxy already writes its OWN web-call log in
// §6.6's exact shape from a SEPARATE process (src/mcpproxy/audit.ts — r94's file, untouched here).
// This module is the SETUP-side chain that folds the three event classes row 97 produces into ONE
// append-only JSONL format so a downstream reader (row 113) parses one schema across the estate:
//   - mcp_call      — a swarm-web proxy call, either observed by setup or converted from a §6.6 line
//   - policy_active — the F-79-A fleet policy was present and enforced during a run (task c)
//   - tool_launch   — a private tool (graft / rtk / the proxy) was wired or invoked by absolute path
//                     (tasks a + b)
//
// Append-only durability mirrors provenance.ts and mcpproxy/audit.ts: O_APPEND + fsync before
// returning, mode 0600 under a 0700 parent, never truncate/rewrite/delete the active file. Size
// rotation matches §6.6 (5 MiB, five generations) because this is evidence, not operational chatter.
//
// Path: ~/.swarm/setup/audit.jsonl — inside PC-PATH-01 (the setup state root, P-16 whitelist),
// beside provenance.jsonl. It is NOT a register constant yet; row 97 proposes PC-PATH-17 for it
// (see implementation/s97_wiring_policy.md §register-proposal). Overridable via opts.path /
// SWARM_SETUP_AUDIT_LOG so tests point at a throwaway file exactly like PC-ENV-04 does for the proxy.
//
// Secret safety is STRUCTURAL: no variant field can carry a bearer token or header dump; the
// Firecrawl token never enters any path that writes here (§6.6 "secrets never appear"; P-8). Query
// text IS carried on mcp_call lines on purpose — §6.6/P-7 name this class of log as where sensitive
// query text accumulates; FileVault stays the documented prerequisite.

import {
  existsSync,
  openSync,
  writeSync,
  fsyncSync,
  closeSync,
  statSync,
  renameSync,
  rmSync,
  readFileSync,
} from "node:fs"
import { MODES } from "../constants.ts"
import { ensureParent, expandTilde, setupRoot } from "../paths.ts"
import type { AuditRecord } from "../mcpproxy/audit.ts"

/** Discriminator for the three event classes folded into one format. */
export type ChainKind = "mcp_call" | "policy_active" | "tool_launch" | "setup_verb"

/** Shared leading fields present on EVERY chain line, in this order. `decision` is kind-scoped:
 *  allowed|denied|error for mcp_call, active for policy_active, launched|refused for tool_launch. */
export interface ChainEnvelope {
  readonly ts: string // ISO-8601 UTC
  readonly kind: ChainKind
  readonly source: string // module + function, e.g. "swarm-setup.wiring.policy_enforce"
  readonly decision: string
}

/** Per-run trace id so one install run's lines can be tied together across kinds. */
export interface ChainTail {
  readonly correlationId?: string
}

/** A swarm-web proxy call. Field names mirror §6.6 so a reader can merge this with the proxy's own
 *  web-audit.log by `ts` without learning a second vocabulary. Network fields are present only when
 *  a body was produced (allowed calls); a denied call carries NO network fields (§6.6). */
export interface McpCallEvent extends ChainEnvelope, ChainTail {
  readonly kind: "mcp_call"
  readonly component: "swarm-web"
  readonly tool: "search" | "fetch" | "vault_inbox"
  readonly action: string
  readonly reason: string | null
  readonly query: string | null
  readonly url: string | null
  readonly host: string | null
  readonly status?: number | null
  readonly bytes_in?: number | null
  readonly bytes_out?: number | null
  readonly sha256?: string | null
  readonly truncated?: boolean | null
  readonly latency_ms: number
  readonly nonce?: string | null
  readonly agent: string | null
  readonly session: string | null
}

/** The F-79-A policy was read and enforced. Records only the forbidden COMPONENT IDS (never any
 *  secret, never note bodies); `count` lets a reader assert the list length without re-parsing. */
export interface PolicyActiveEvent extends ChainEnvelope, ChainTail {
  readonly kind: "policy_active"
  readonly policyPath: string
  readonly forbidden: readonly string[]
  readonly count: number
}

/** A private tool was wired or launched by absolute path. `argv` is the exact array handed to the
 *  spawn site (absolute binaries — never PATH-resolved); `telemetryOff` asserts DO_NOT_TRACK=1 was
 *  present; `mustBeUnsetOk` asserts GRAFT_PROVIDER/GRAFT_API_KEY were absent (01c0:194-198). */
export interface ToolLaunchEvent extends ChainEnvelope, ChainTail {
  readonly kind: "tool_launch"
  readonly tool: "graft" | "rtk" | "swarm-web"
  readonly argv: readonly string[]
  readonly telemetryOff: boolean
  readonly mustBeUnsetOk: boolean
}

/** Row 92a (1.2.6, N-153): one line per `swarm-setup start` invocation. `outcome` is the RESULT token
 *  (OK, FAILED or one of the four START refusals); `commands` are the argv lines actually run, in order,
 *  so a reader can prove the verb never ran up/create/pull. decision: started | refused | failed. */
export interface SetupVerbEvent extends ChainEnvelope, ChainTail {
  readonly kind: "setup_verb"
  readonly verb: "start"
  readonly component: string
  readonly outcome: string
  readonly commands: readonly string[]
}

export type ChainEvent = McpCallEvent | PolicyActiveEvent | ToolLaunchEvent | SetupVerbEvent

export interface ChainOptions {
  /** Destination override; default = $SWARM_SETUP_AUDIT_LOG else ~/.swarm/setup/audit.jsonl. */
  readonly path?: string
  readonly maxBytes?: number
  readonly maxRotations?: number
}

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024 // 5 MiB, matching §6.6's evidence cap
const DEFAULT_MAX_ROTATIONS = 5 // five kept generations, matching §6.6

export const SETUP_AUDIT_FILE_NAME = "audit.jsonl"

/** Env override name for the setup-side chain (proposed PC-ENV-07; see artifact register-proposal). */
export const SETUP_AUDIT_ENV_NAME = "SWARM_SETUP_AUDIT_LOG"

export function chainLogPath(opts: ChainOptions = {}): string {
  const fromEnv = process.env[SETUP_AUDIT_ENV_NAME]
  return opts.path ?? expandTilde(fromEnv && fromEnv.length > 0 ? fromEnv : `${setupRoot()}/${SETUP_AUDIT_FILE_NAME}`)
}

/** Serialise one event to a single JSON line (pure; writes nothing). Key order is normative and the
 *  golden tests pin it: shared envelope first, then kind-specific fields, then correlationId last. */
export function formatChainLine(ev: ChainEvent): string {
  const line: Record<string, unknown> = {
    ts: ev.ts,
    kind: ev.kind,
    source: ev.source,
    decision: ev.decision,
  }
  if (ev.kind === "mcp_call") {
    line.component = ev.component
    line.tool = ev.tool
    line.action = ev.action
    line.reason = ev.reason
    line.query = ev.query
    line.url = ev.url
    line.host = ev.host
    if (ev.decision === "allowed" || ev.status !== undefined) {
      line.status = ev.status ?? null
      line.bytes_in = ev.bytes_in ?? null
      line.bytes_out = ev.bytes_out ?? null
      line.sha256 = ev.sha256 ?? null
      line.truncated = ev.truncated ?? null
    }
    line.latency_ms = ev.latency_ms
    if (ev.decision === "allowed" || ev.nonce !== undefined) line.nonce = ev.nonce ?? null
    line.agent = ev.agent
    line.session = ev.session
  } else if (ev.kind === "policy_active") {
    line.policyPath = ev.policyPath
    line.forbidden = ev.forbidden
    line.count = ev.count
  } else if (ev.kind === "setup_verb") {
    line.verb = ev.verb
    line.component = ev.component
    line.outcome = ev.outcome
    line.commands = ev.commands
  } else {
    line.tool = ev.tool
    line.argv = ev.argv
    line.telemetryOff = ev.telemetryOff
    line.mustBeUnsetOk = ev.mustBeUnsetOk
  }
  if (ev.correlationId !== undefined) line.correlationId = ev.correlationId
  return JSON.stringify(line)
}

function currentSize(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

/** Shift audit.jsonl -> .1 -> ... -> .5, dropping the oldest generation (audit.ts shape). */
function rotate(path: string, maxRotations: number): void {
  rmSync(`${path}.${maxRotations}`, { force: true })
  for (let n = maxRotations - 1; n >= 1; n--) {
    const from = `${path}.${n}`
    if (existsSync(from)) renameSync(from, `${path}.${n + 1}`)
  }
  if (existsSync(path)) renameSync(path, `${path}.1`)
}

/**
 * Append one chain line (0600 under a 0700 parent, fsync'd). Returns the exact line written so
 * callers/tests inspect it without re-reading. Rotation is checked against the incoming line so one
 * oversized line still rolls rather than blowing the cap. Append-only: never truncates the active file.
 */
export function appendChainEvent(ev: ChainEvent, opts: ChainOptions = {}): string {
  const line = formatChainLine(ev)
  const path = chainLogPath(opts)
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES
  const maxRotations = opts.maxRotations ?? DEFAULT_MAX_ROTATIONS
  if (currentSize(path) + line.length + 1 > maxBytes) rotate(path, maxRotations)
  ensureParent(path)
  const fd = openSync(path, "a", MODES.FILE_0600)
  try {
    writeSync(fd, new TextEncoder().encode(`${line}\n`))
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  return line
}

/**
 * Convert a proxy §6.6 AuditRecord into a chain mcp_call line WITHOUT re-implementing its field set:
 * the proxy runs in a separate process and owns web-audit.log; this lets setup (or row 113) fold a
 * proxy record into the unified schema mechanically. `source`/`correlationId` are supplied by the
 * caller because the proxy record itself carries neither.
 */
export function mcpCallFromProxyRecord(
  rec: AuditRecord,
  meta: { source: string; correlationId?: string },
): McpCallEvent {
  return {
    ts: rec.ts,
    kind: "mcp_call",
    source: meta.source,
    decision: rec.decision,
    component: rec.component,
    tool: rec.tool,
    action: rec.action,
    reason: rec.reason,
    query: rec.query,
    url: rec.url,
    host: rec.host,
    ...(rec.status !== undefined ? { status: rec.status } : {}),
    ...(rec.bytes_in !== undefined ? { bytes_in: rec.bytes_in } : {}),
    ...(rec.bytes_out !== undefined ? { bytes_out: rec.bytes_out } : {}),
    ...(rec.sha256 !== undefined ? { sha256: rec.sha256 } : {}),
    ...(rec.truncated !== undefined ? { truncated: rec.truncated } : {}),
    latency_ms: rec.latency_ms,
    ...(rec.nonce !== undefined ? { nonce: rec.nonce } : {}),
    agent: rec.agent,
    session: rec.session,
    ...(meta.correlationId !== undefined ? { correlationId: meta.correlationId } : {}),
  }
}

/** Read the chain back (row 113 verification + tests). Missing file = empty ledger; a malformed
 *  line surfaces as null so a reader fails closed rather than silently skipping evidence. */
export function readChainEvents(opts: ChainOptions = {}): Array<ChainEvent | null> {
  const path = chainLogPath(opts)
  if (!existsSync(path)) return []
  return readTextLines(path)
}

function readTextLines(path: string): Array<ChainEvent | null> {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => {
      try {
        return JSON.parse(l) as ChainEvent
      } catch {
        return null
      }
    })
}
