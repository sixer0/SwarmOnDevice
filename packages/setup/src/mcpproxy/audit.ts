// Web-call audit log (row 94; contract = masterplan/01f_tool_wiring_spec.md §6.6). One JSON
// object per line, appended, ONE line per tool call including refusals — this file is L3's
// evidence layer ("the log proves what the model saw, not what the site sent").
//
// Path: PC-PATH-10 ~/.swarm/logs/web-audit.log (constants.ts PATHS.WEB_AUDIT_LOG), mode 0600,
// overridable by PC-ENV-04 SWARM_WEB_AUDIT_LOG so row 97's config entry can point it elsewhere.
// The brief's "~/.swarm/setup/" phrasing resolves to the register value PC-PATH-10 (~/.swarm/logs/)
// — the register is the constant's home (01c0:23-24), so the spec path wins; both live under the
// P-16 whitelist ~/.swarm/** either way. Rotation is size-based at 5 MiB keeping five files,
// implemented here (no external logrotate dependency) exactly as §6.6 requires.
//
// Durability model mirrors setuplog.ts (row 84): O_APPEND + fsync before returning, so a crash
// loses at most nothing already acknowledged. Append-only: this module never truncates, rewrites
// or deletes the active file; rotation only renames completed generations (.1 .. .5, oldest drop).
//
// Secret safety is STRUCTURAL, not patterned: the record type has no field that could carry a
// bearer token or header dump, and the Firecrawl token never enters any code path that writes
// here (§6.6 "secrets never appear"; P-8). Query text IS recorded on purpose — §6.6/P-7 name
// this log as where sensitive query text accumulates; FileVault is the documented prerequisite.

import { existsSync, openSync, writeSync, fsyncSync, closeSync, statSync, renameSync, rmSync } from "node:fs"
import { MODES, PATHS } from "../constants.ts"
import { ensureParent, expandTilde } from "../paths.ts"
import { ENV_NAMES } from "./register.ts"

export type AuditDecision = "allowed" | "denied" | "error"

/** Field set and order of §6.6's example line. `null` serialises explicitly (the example shows
 *  "reason":null,"query":null,"session":null-style nulls), so optional-but-present fields are
 *  typed nullable rather than omitted. */
export interface AuditRecord {
  readonly ts: string // ISO-8601 UTC
  readonly component: "swarm-web"
  readonly tool: "search" | "fetch" | "vault_inbox"
  /** Sub-action: page|crawl for fetch, write|list|read for vault_inbox, "query" for search. */
  readonly action: string
  readonly decision: AuditDecision
  /** PolicyReason for denied, error summary for error, else null. */
  readonly reason: string | null
  /** Populated for search ONLY (§6.6); url stays null there. */
  readonly query: string | null
  /** Attempted/resolved target for fetch/vault ops; null for search. */
  readonly url: string | null
  readonly host: string | null
  /** Network fields — present ONLY when a response body was produced (allowed web calls).
   *  A denied call carries NO network fields (§6.6); an errored call may carry status when the
   *  transport answered but the body failed (e.g. undecodable), which is still honest. */
  readonly status?: number | null
  readonly bytes_in?: number | null
  readonly bytes_out?: number | null
  /** sha256 over the SANITISED body actually returned to the model (§6.6). */
  readonly sha256?: string | null
  readonly truncated?: boolean | null
  readonly latency_ms: number
  /** Envelope nonce tying the line to the text the model saw; absent when no body was returned.
   *  It doubles as the §6.5 `id=<audit-line-id>` tie-back token (unique per call), so the shipped
   *  line keeps §6.6's exact field set instead of inventing an extra key. */
  readonly nonce?: string | null
  readonly agent: string | null
  readonly session: string | null
}

export interface AuditOptions {
  /** Destination override; default = $SWARM_WEB_AUDIT_LOG else PC-PATH-10. Tests point at a temp file. */
  readonly path?: string
  readonly maxBytes?: number
  readonly maxRotations?: number
}

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024 // 5 MiB per §6.6
const DEFAULT_MAX_ROTATIONS = 5 // five kept files per §6.6

export function auditLogPath(opts: AuditOptions = {}): string {
  const fromEnv = process.env[ENV_NAMES.AUDIT_LOG]
  return opts.path ?? expandTilde(fromEnv && fromEnv.length > 0 ? fromEnv : PATHS.WEB_AUDIT_LOG)
}

/** Serialise one record to a single JSON line (pure; writes nothing). Key order follows the
 *  interface literal order = §6.6 example order, which the golden test pins. */
export function formatAuditLine(rec: AuditRecord): string {
  const line: Record<string, unknown> = {
    ts: rec.ts,
    component: rec.component,
    tool: rec.tool,
    action: rec.action,
    decision: rec.decision,
    reason: rec.reason,
    query: rec.query,
    url: rec.url,
    host: rec.host,
  }
  if (rec.decision === "allowed" || rec.status !== undefined) {
    line.status = rec.status ?? null
    line.bytes_in = rec.bytes_in ?? null
    line.bytes_out = rec.bytes_out ?? null
    line.sha256 = rec.sha256 ?? null
    line.truncated = rec.truncated ?? null
  }
  line.latency_ms = rec.latency_ms
  if (rec.decision === "allowed" || rec.nonce !== undefined) line.nonce = rec.nonce ?? null
  line.agent = rec.agent
  line.session = rec.session
  return JSON.stringify(line)
}

function currentSize(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

/** Shift web-audit.log -> .1 -> ... -> .5, dropping the oldest generation (setuplog.ts shape,
 *  register-mandated 5 MiB / five files instead of 1 MiB / three). */
function rotate(path: string, maxRotations: number): void {
  rmSync(`${path}.${maxRotations}`, { force: true })
  for (let n = maxRotations - 1; n >= 1; n--) {
    const from = `${path}.${n}`
    if (existsSync(from)) renameSync(from, `${path}.${n + 1}`)
  }
  if (existsSync(path)) renameSync(path, `${path}.1`)
}

/**
 * Append one audit line (0600 under a 0700 parent, fsync'd). Returns the exact line written so
 * callers/tests inspect it without re-reading. Rotation is checked against the incoming line so
 * one oversized line still triggers a roll rather than blowing the cap.
 */
export function appendAudit(rec: AuditRecord, opts: AuditOptions = {}): string {
  const line = formatAuditLine(rec)
  const path = auditLogPath(opts)
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
