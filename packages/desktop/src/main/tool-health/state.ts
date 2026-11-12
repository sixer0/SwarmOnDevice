// TH-02 / SEC-16 (1.2.6 row 91): the tool-health state file ~/.swarm/health/state.json (N-125) and the paths of the
// re-check request file (N-152). Desktop main is the only writer: directory 0700, file 0600, written through a temp file
// and a rename. `detail` is one line, at most 300 chars, and passes through Secrets.scrubText (SEC-16) plus a redaction
// of every value the caller names (the render-bridge token, SEC-15), so no token reaches the file or the log.

import { chmodSync, closeSync, fstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { scrubText } from "../../../../opencode/src/tool/secrets"
import type { ToolHealthReason, ToolHealthSource, ToolHealthStatus } from "./types"
import { TOOL_HEALTH_REASONS } from "./types"

export const TOOL_HEALTH_DIR = [".swarm", "health"] as const
export const TOOL_HEALTH_STATE_FILE = "state.json"
export const TOOL_HEALTH_RECHECK_FILE = "recheck.json"
export const TOOL_HEALTH_STATE_VERSION = 1
export const TOOL_HEALTH_DETAIL_MAX = 300
/** A state file larger than this is treated as absent (it is ours; a bigger one was not written by us). */
export const TOOL_HEALTH_STATE_MAX_BYTES = 256 * 1024

const STATUSES: ReadonlySet<string> = new Set([
  "healthy",
  "revived",
  "dead",
  "revive_failed",
  "skipped_never_healthy",
  "skipped_not_installed",
])
const REASONS: ReadonlySet<string> = new Set(TOOL_HEALTH_REASONS)

export type ToolHealthRecord = {
  lastStatus: ToolHealthStatus
  reason: ToolHealthReason
  detail: string
  lastCheckedAt: number
  lastHealthyAt?: number
  lastReviveAt?: number
  source: ToolHealthSource
}

export type ToolHealthState = {
  version: number
  updatedAt: number
  appVersion: string
  components: Record<string, ToolHealthRecord>
}

export function toolHealthDir(home: string) {
  return join(home, ...TOOL_HEALTH_DIR)
}

export function toolHealthStatePath(home: string) {
  return join(toolHealthDir(home), TOOL_HEALTH_STATE_FILE)
}

export function toolHealthRecheckPath(home: string) {
  return join(toolHealthDir(home), TOOL_HEALTH_RECHECK_FILE)
}

/**
 * SEC-16 / SEC-15: scrub, then redact every named secret, keep the first line only, cap at 300 chars. Query strings
 * are cut from any URL the text carries (01c 3.5: `detail` never holds a URL query string).
 */
export function scrubDetail(text: string, secrets: readonly string[] = []): string {
  let out = String(text ?? "")
  for (const secret of secrets) if (secret && secret.length >= 4) out = out.split(secret).join("[hidden:token]")
  out = scrubText(out)
  out = out.replace(/(https?:\/\/[^\s?#]*)[?#][^\s]*/g, "$1")
  const first = out.split(/\r?\n/).find((line) => line.trim().length > 0) ?? ""
  const line = first.trim()
  return line.length > TOOL_HEALTH_DETAIL_MAX ? `${line.slice(0, TOOL_HEALTH_DETAIL_MAX - 3)}...` : line
}

/** Scrub for multi-line output kept in the log (revive stdout/stderr): every line, same secret rules, capped. */
export function scrubOutput(text: string, secrets: readonly string[] = [], max = 4096): string {
  let out = String(text ?? "")
  for (const secret of secrets) if (secret && secret.length >= 4) out = out.split(secret).join("[hidden:token]")
  out = scrubText(out)
  return out.length > max ? `${out.slice(0, max)}...` : out
}

function emptyState(appVersion: string): ToolHealthState {
  return { version: TOOL_HEALTH_STATE_VERSION, updatedAt: 0, appVersion, components: {} }
}

function readRecord(value: unknown): ToolHealthRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const v = value as Record<string, unknown>
  if (typeof v.lastStatus !== "string" || !STATUSES.has(v.lastStatus)) return undefined
  if (typeof v.reason !== "string" || !REASONS.has(v.reason)) return undefined
  if (typeof v.lastCheckedAt !== "number" || !Number.isFinite(v.lastCheckedAt)) return undefined
  const record: ToolHealthRecord = {
    lastStatus: v.lastStatus as ToolHealthStatus,
    reason: v.reason as ToolHealthReason,
    detail: typeof v.detail === "string" ? v.detail.slice(0, TOOL_HEALTH_DETAIL_MAX) : "",
    lastCheckedAt: v.lastCheckedAt,
    source: v.source === "user" ? "user" : "shipped",
  }
  if (typeof v.lastHealthyAt === "number" && Number.isFinite(v.lastHealthyAt)) record.lastHealthyAt = v.lastHealthyAt
  if (typeof v.lastReviveAt === "number" && Number.isFinite(v.lastReviveAt)) record.lastReviveAt = v.lastReviveAt
  return record
}

/**
 * Reads state.json. Missing, oversized, not a regular file or malformed gives an empty state with `exists: false`
 * (records that do not validate are dropped one by one). Never throws.
 */
export function readToolHealthState(home: string, appVersion = ""): { state: ToolHealthState; exists: boolean } {
  let parsed: unknown
  try {
    const fd = openSync(toolHealthStatePath(home), "r")
    try {
      const st = fstatSync(fd)
      if (!st.isFile() || st.size > TOOL_HEALTH_STATE_MAX_BYTES) return { state: emptyState(appVersion), exists: false }
      parsed = JSON.parse(readFileSync(fd, "utf8"))
    } finally {
      closeSync(fd)
    }
  } catch {
    return { state: emptyState(appVersion), exists: false }
  }
  const state = emptyState(appVersion)
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { state, exists: false }
  const p = parsed as Record<string, unknown>
  if (typeof p.updatedAt === "number") state.updatedAt = p.updatedAt
  const components = p.components
  if (components && typeof components === "object" && !Array.isArray(components)) {
    for (const [id, value] of Object.entries(components)) {
      if (!Object.hasOwn(components, id)) continue
      const record = readRecord(value)
      if (record) state.components[id] = record
    }
  }
  return { state, exists: true }
}

/** Creates ~/.swarm/health with mode 0700 (and tightens an existing one). */
export function ensureToolHealthDir(home: string) {
  const dir = toolHealthDir(home)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
  return dir
}

/** Atomic write: temp file 0600 in the same directory, then rename over state.json. */
export function writeToolHealthState(home: string, state: ToolHealthState) {
  const dir = ensureToolHealthDir(home)
  const target = join(dir, TOOL_HEALTH_STATE_FILE)
  const temp = join(dir, `.${TOOL_HEALTH_STATE_FILE}.${process.pid}.${Date.now()}.tmp`)
  const body = `${JSON.stringify(state, null, 2)}\n`
  try {
    writeFileSync(temp, body, { mode: 0o600, flag: "wx" })
    chmodSync(temp, 0o600)
    renameSync(temp, target)
  } catch (error) {
    rmSync(temp, { force: true })
    throw error
  }
}
