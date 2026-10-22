// Setup config writer — the blueprint row-97 "config writer" half (FIX rounds b + c). At the moment a
// backing component reaches `healthy` (P-15) this writes, into ~/.config/swarm/:
//   (b) the TWO register MCP server entries into swarm.json  — PC-MCP-01 graft, PC-MCP-02 swarm-web; and
//   (c) the model-facing texts from row 98 — agent/researcher.md + the four skills/<name>/SKILL.md —
//       imported (NEVER copied) from src/skills so the installed bytes are exactly what renderSkillTexts()
//       produces. The four SKILL.md files the brief names are the skills subset of TEXT_TARGETS; the
//       researcher agent definition is the fifth target in the same table and is required for the
//       researcher to load, so consuming TEXT_TARGETS writes all five together.
//
// Shared mechanics for EVERY target (entries and texts alike): a hash-named + timestamped backup before
// each content-changing write, an atomic kill-9-safe replace, idempotence (identical desired bytes => no-op),
// reversible removal driven by a ledger (restore-or-delete per file, never a guess), and a symlinked-target
// refusal checked before any read or write. A --check primitive (checkSkillFiles) byte-compares the
// installed texts against a fresh render so CI fails loudly on drift (r98 §7 handoff).
//
// Register authority (01c0_preinstall_register.md, current through r72-fix4):
//   §2.9 "The setup writes exactly two MCP server entries into ~/.config/swarm/ (row 97), only after the
//        component reaches healthy (P-15)."  Class-3 note (:124-126): Swarm's own writes go to
//        ~/.config/swarm/, NOT under ~/.swarm; row 97 owns them.
// s96_permission_baseline.md §7 governs the swarm.json merge: the permission baseline rides the seed merge,
// not this file, so there are no baseline keys to preserve here — but the whole file is still read-modify-
// written, keeping every unrelated key and every other mcp server in place and in order.
//
// Env pointers: the swarm-web entry carries NON-SECRET estate pointers only (SearXNG/Firecrawl base URLs when
// supplied, audit-log = PC-PATH-10, vault = PC-PATH-13). The Firecrawl bearer token is NEVER written here
// (P-8 / 01f §6.1); the proxy inherits it from the spawn environment.
//
// This module spawns nothing and opens no socket. It writes only under ~/.config/swarm (entries + texts +
// their timestamped backups) and ~/.swarm/setup/config-writer.json (the reversal ledger, inside P-16).

import { existsSync, lstatSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { createHash } from "node:crypto"
import { MODES, PATHS, STATES, type ComponentId } from "../constants.ts"
import { homeDir, setupRoot } from "../paths.ts"
import { atomicWriteText } from "../atomic.ts"
import { readState, defaultState, type StateFile } from "../state.ts"
import { swarmWebMcpEntry, type McpLocalEntry, type GraftEntryOptions } from "../mcpproxy/wiring.ts"
import { MCP_SERVER_NAME, PROXY_BINARY_PATH, VAULT_ROOT, ENV_NAMES } from "../mcpproxy/register.ts"
import { graftLaunchGuard } from "./graft_guard.ts"
import { appendChainEvent, type ChainOptions } from "./audit_chain.ts"
import { renderSkillTexts, TEXT_TARGETS, type SkillTexts } from "../skills/researcher_text.ts"
import type { LockFile } from "../lockfile.ts"

/** The config file swarm reads (register class-3 note; F01 app dir `swarm`). */
export const CONFIG_FILE_NAME = "swarm.json"
/** Reversal ledger — inside the P-16 whitelist, beside provenance.jsonl. */
export const LEDGER_FILE_NAME = "config-writer.json"
const LEDGER_VERSION = 1

/** Join a register tilde path onto an explicit HOME base without mutating process.env. */
function underHome(tildePath: string, base: string): string {
  if (tildePath === "~") return base
  if (tildePath.startsWith("~/")) return join(base, tildePath.slice(2))
  return tildePath
}

export function configDir(base?: string): string {
  if (base !== undefined) return join(base, ".config", "swarm")
  return join(xdgConfigHome(), "swarm")
}

/**
 * Resolve the config directory exactly as the Swarm product does, so an installer never writes where
 * the product will not read (the CONFIG PATH divergence in research/s6_04_route_impact.md). The server
 * builds its config path from xdg-basedir (`packages/core/src/global.ts:13`), which honours
 * `$XDG_CONFIG_HOME` when it is set to an ABSOLUTE path and otherwise falls back to `$HOME/.config`.
 * The writer previously always used `$HOME/.config/swarm`, so whenever `XDG_CONFIG_HOME` was set the two
 * disagreed and a wired entry would land where the running product never looks. Replicating xdg-basedir's
 * own rule locally keeps the unprivileged setup binary free of a new dependency. An explicit `base`
 * (throwaway-HOME tests) still means `<base>/.config/swarm`: that argument simulates HOME, not XDG, and
 * its callers own the whole tree.
 */
function xdgConfigHome(): string {
  const x = process.env.XDG_CONFIG_HOME
  if (x && x.length > 0 && x.startsWith("/")) return x
  return join(homeDir(), ".config")
}

export function configFilePath(opts: { base?: string; path?: string } = {}): string {
  if (opts.path !== undefined) return opts.path
  return join(configDir(opts.base), CONFIG_FILE_NAME)
}

function setupRootFor(base?: string): string {
  return base !== undefined ? join(base, ".swarm", "setup") : setupRoot()
}
function ledgerPath(base?: string): string {
  return join(setupRootFor(base), LEDGER_FILE_NAME)
}

/** Resolve the component state that gates eligibility: an explicit object wins; else a state.json under
 *  the given base (so a throwaway-HOME CI run is self-contained); else the real engine state. */
function resolveStateFile(opts: ConfigWriterOptions): { ok: true; state: StateFile } | { ok: false; error: string } {
  if (opts.state) return { ok: true, state: opts.state }
  if (opts.base !== undefined) return readStateFromBase(opts.base, opts.lock?.version ?? "")
  return readState(opts.lock?.version ?? "")
}

function readStateFromBase(
  base: string,
  lockVersion: string,
): { ok: true; state: StateFile } | { ok: false; error: string } {
  const file = join(setupRootFor(base), "state.json")
  const state = defaultState(lockVersion)
  if (!existsSync(file)) return { ok: true, state }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"))
  } catch (err) {
    return { ok: false, error: `state.json under ${base} is not valid JSON: ${(err as Error).message}` }
  }
  const comps = (parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>).components : {}) as Record<
    string,
    { state?: unknown }
  >
  for (const id of Object.keys(state.components) as ComponentId[]) {
    const st = comps[id]?.state
    if (typeof st === "string") state.components[id].state = st as StateFile["components"][ComponentId]["state"]
  }
  return { ok: true, state }
}

/** Non-secret estate pointers for the swarm-web entry env. Absent keys are simply not written. */
export interface EstatePointers {
  readonly searxngUrl?: string // PC-ENV-01 value (loopback base) — caller resolves at healthy time
  readonly firecrawlUrl?: string // PC-ENV-02 value
  readonly auditLogPath?: string // defaults to PC-PATH-10
  readonly vaultDir?: string // defaults to PC-PATH-13
}

export interface ConfigWriterOptions {
  /** Explicit HOME base (tests point at a throwaway dir); default = process.env.HOME via paths. */
  readonly base?: string
  /** Override the swarm.json target path directly (tests). */
  readonly path?: string
  /** ISO timestamp source for backups + ledger (deterministic tests). */
  readonly now?: () => string
  readonly lock?: LockFile
  /** Pre-read state; when absent the writer calls readState(). */
  readonly state?: StateFile
  readonly estate?: EstatePointers
  /** TEST SEAM ONLY: replaces the graft resolver (r88 discipline). Cannot weaken anything. */
  readonly launch?: GraftEntryOptions["launch"]
  /** Env view for the graft must-be-unset check; default process.env. */
  readonly env?: Readonly<Record<string, string | undefined>>
  /** Where tool_launch audit lines go; default = the unified chain path. */
  readonly chain?: ChainOptions
  /** TEST SEAM ONLY (F-R109-1 kill-boundary replay): invoked inside the per-target loop right after the
   *  durable ledger commit ("pre-replace") and again after the atomic replace ("post-replace"). Throwing
   *  from it emulates a process death at that exact durable boundary so a unit can prove resume+removal
   *  stay complete. Optional and inert in production — cannot weaken any guarantee. */
  readonly onTargetBoundary?: (phase: "pre-replace" | "post-replace", label: string) => void
}

export interface WriteOutcome {
  readonly ok: true
  /** True iff ANY target's bytes actually changed this run (false == full idempotent no-op). */
  readonly changed: boolean
  readonly wrote: { readonly graft: boolean; readonly swarmWeb: boolean; readonly skills: readonly string[] }
  readonly skipped: { readonly graft?: string; readonly swarmWeb?: string; readonly skills?: Record<string, string> }
  /** Backup created for swarm.json this run (null on a no-op or first-ever creation). */
  readonly backupPath: string | null
  /** Every backup created this run across all targets. */
  readonly backups: readonly string[]
  readonly configPath: string
}
export type WriteResult = WriteOutcome | { ok: false; reason: string }

interface Eligibility {
  graft: boolean
  swarmWeb: boolean
  rtk: boolean
  obsidian: boolean
}

function eligibility(state: StateFile, opts: ConfigWriterOptions): Eligibility {
  const healthy = (id: ComponentId) => state.components[id]?.state === STATES.HEALTHY
  const binaryPresent = existsSync(underHome(PROXY_BINARY_PATH, opts.base ?? homeDir()))
  return {
    graft: healthy("graft"),
    // swarm-web backs search (searxng always-on) and needs its staged binary present (§6.1 absolute command).
    swarmWeb: healthy("searxng") && binaryPresent,
    rtk: healthy("rtk"),
    obsidian: healthy("obsidian"),
  }
}

/** Which rendered text goes where, and which health signal gates it (mirrors the entry gating). */
const TEXT_PLAN: ReadonlyArray<{ key: keyof SkillTexts; rel: string; gate: keyof Eligibility }> = [
  { key: "agentResearcherMd", rel: TEXT_TARGETS.agentResearcher, gate: "swarmWeb" },
  { key: "skillSwarmResearchMd", rel: TEXT_TARGETS.swarmResearch, gate: "swarmWeb" },
  { key: "skillGraftMd", rel: TEXT_TARGETS.graft, gate: "graft" },
  { key: "skillRtkMd", rel: TEXT_TARGETS.rtk, gate: "rtk" },
  { key: "skillObsidianInboxMd", rel: TEXT_TARGETS.obsidianInbox, gate: "obsidian" },
]

interface SkippedBag {
  graft?: string
  swarmWeb?: string
  skills?: Record<string, string>
}

/** Build the desired mcp entries (only eligible ones) + record skip reasons + emit launch audit lines. */
function desiredEntries(
  state: StateFile,
  opts: ConfigWriterOptions,
  el: Eligibility,
): { entries: Record<string, McpLocalEntry>; skipped: SkippedBag } {
  const base = opts.base ?? homeDir()
  const entries: Record<string, McpLocalEntry> = {}
  const skipped: SkippedBag = {}

  if (el.graft) {
    const guard = graftLaunchGuard({
      ...(opts.lock ? { lock: opts.lock } : {}),
      ...(opts.launch ? { launch: opts.launch } : {}),
      ...(opts.env ? { env: opts.env } : {}),
      chain: opts.chain ?? {},
      ...(opts.now ? { now: opts.now } : {}),
    })
    if (guard.ok) entries["graft"] = guard.entry
    else skipped.graft = guard.reason
  } else {
    skipped.graft = "graft component is not healthy (P-15)"
  }

  if (el.swarmWeb) {
    entries[MCP_SERVER_NAME] = { ...swarmWebMcpEntry(underHome(PROXY_BINARY_PATH, base)), env: estateEnv(opts, base) }
    appendChainEvent(
      {
        ts: opts.now?.() ?? new Date().toISOString(),
        kind: "tool_launch",
        source: "swarm-setup.wiring.config_writer",
        decision: "launched",
        tool: "swarm-web",
        argv: [underHome(PROXY_BINARY_PATH, base)],
        telemetryOff: true,
        mustBeUnsetOk: true,
      },
      opts.chain ?? {},
    )
  } else {
    skipped.swarmWeb =
      state.components.searxng?.state !== STATES.HEALTHY
        ? "searxng component is not healthy (P-15)"
        : "proxy binary not staged at PC-PATH-14"
  }

  return { entries, skipped }
}

/** Non-secret env pointers only. The Firecrawl TOKEN is never placed here (P-8). */
function estateEnv(opts: ConfigWriterOptions, base: string): Record<string, string> {
  const env: Record<string, string> = {}
  const e = opts.estate ?? {}
  if (e.searxngUrl) env[ENV_NAMES.SEARXNG_URL] = e.searxngUrl
  if (e.firecrawlUrl) env[ENV_NAMES.FIRECRAWL_URL] = e.firecrawlUrl
  env[ENV_NAMES.AUDIT_LOG] = e.auditLogPath ?? underHome(PATHS.WEB_AUDIT_LOG, base)
  env[ENV_NAMES.VAULT_DIR] = e.vaultDir ?? underHome(VAULT_ROOT, base)
  return env
}

function readCurrent(path: string): { present: boolean; text: string } {
  if (!existsSync(path)) return { present: false, text: "" }
  return { present: true, text: readFileSync(path, "utf8") }
}

/** Merge our entries into the parsed existing object, preserving all other keys and order. */
function mergeIntoExisting(
  existingText: string,
  entries: Record<string, McpLocalEntry>,
): { json: string; conflict: string | null } {
  let root: Record<string, unknown> = {}
  if (existingText.trim() !== "") {
    let parsed: unknown
    try {
      parsed = JSON.parse(existingText)
    } catch (err) {
      return { json: "", conflict: `existing ${CONFIG_FILE_NAME} is not valid JSON: ${(err as Error).message}` }
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return { json: "", conflict: `existing ${CONFIG_FILE_NAME} top level is not an object` }
    root = parsed as Record<string, unknown>
  }
  const existingMcp =
    root.mcp && typeof root.mcp === "object" && !Array.isArray(root.mcp) ? (root.mcp as Record<string, unknown>) : {}
  const mergedMcp: Record<string, unknown> = { ...existingMcp }
  for (const [name, entry] of Object.entries(entries)) mergedMcp[name] = entry
  root.mcp = mergedMcp
  return { json: JSON.stringify(root, null, 2) + "\n", conflict: null }
}

function sha12(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 12)
}
function compactStamp(iso: string): string {
  return iso.replace(/[-:]/g, "").replace(/\..+$/, "")
}

interface FileRecord {
  readonly targetPath: string
  readonly preexisting: boolean
  readonly firstBackupPath: string | null
  readonly backups: string[]
}
interface WriterLedger {
  readonly version: number
  readonly files: Record<string, FileRecord>
  readonly updatedAt: string
}

function readLedger(path: string): WriterLedger | null {
  if (!existsSync(path)) return null
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as WriterLedger
    return parsed && typeof parsed === "object" && parsed.files && typeof parsed.files === "object" ? parsed : null
  } catch {
    return null
  }
}

/** One planned file write: absolute path + the exact desired bytes. */
interface PlannedWrite {
  readonly path: string
  readonly desired: string
  readonly label: string
}

/** Build the full plan for the current state: swarm.json (merge) + every eligible text file. */
function buildPlan(
  state: StateFile,
  opts: ConfigWriterOptions,
): { plan: PlannedWrite[]; el: Eligibility; skipped: SkippedBag; configPath: string; conflict: string | null } {
  const configPath = configFilePath({
    ...(opts.base !== undefined ? { base: opts.base } : {}),
    ...(opts.path !== undefined ? { path: opts.path } : {}),
  })
  const el = eligibility(state, opts)
  const { entries, skipped } = desiredEntries(state, opts, el)
  const plan: PlannedWrite[] = []
  // D13: carry the merge conflict out of the planner instead of discarding it. `mergeIntoExisting`
  // returns `{ json: "", conflict: "<sentence>" }` when the existing swarm.json is not valid JSON or
  // not a top-level object; the old code destructured only `{ json }` and pushed the empty string as
  // the desired bytes, which the write loop then committed (truncating the user's file). The empty
  // `json` is still planned so the symlink guard runs against the real target first, but the caller
  // refuses on `conflict` BEFORE any write, so the original bytes survive at their own path.
  let conflict: string | null = null

  if (Object.keys(entries).length > 0) {
    const current = readCurrent(configPath)
    const merged = mergeIntoExisting(current.text, entries)
    conflict = merged.conflict
    plan.push({ path: configPath, desired: merged.json, label: CONFIG_FILE_NAME })
  }

  const texts = renderSkillTexts(opts.lock)
  for (const t of TEXT_PLAN) {
    if (el[t.gate]) {
      plan.push({ path: join(configDir(opts.base), t.rel), desired: texts[t.key], label: t.rel })
    } else {
      ;(skipped.skills ??= {})[t.rel] = `${t.gate} component is not healthy (P-15)`
    }
  }
  return { plan, el, skipped, configPath, conflict }
}

/**
 * Write the eligible MCP entries AND model-facing texts into ~/.config/swarm at the healthy-gated moment.
 * Fail-closed on any symlinked target and on an unparseable existing swarm.json. Idempotent: identical
 * desired bytes across all targets => no backup, no write.
 */
export function writeConfigEntries(opts: ConfigWriterOptions = {}): WriteResult {
  const now = opts.now?.() ?? new Date().toISOString()
  const stateRes = resolveStateFile(opts)
  if (!stateRes.ok) return { ok: false, reason: `cannot read component state: ${stateRes.error}` }

  const { plan, el, skipped, configPath, conflict } = buildPlan(stateRes.state, opts)

  // Symlink refusal BEFORE any read/write, across every planned target (never follow one).
  for (const p of plan) {
    if (isSymlink(p.path))
      return { ok: false, reason: `target ${p.path} is a symlink — refusing to write through it (target_symlink)` }
  }

  // D13 fail-closed — the guarantee this function's own doc comment advertises ("...and on an
  // unparseable existing swarm.json") that was never implemented. Refuse on the conflict AFTER the
  // symlink guard (so a symlinked corrupt target still reports "symlink" first) and BEFORE the write
  // loop (so the user's bytes survive byte-for-byte at their original path: no truncation, no backup,
  // no ledger, never a half-wired machine). Closes drift D13 / AC-T1..AC-T3.
  if (conflict !== null) return { ok: false, reason: conflict }

  const wroteSkills = plan.filter((p) => p.label !== CONFIG_FILE_NAME).map((p) => p.label)
  const wrote = { graft: el.graft && !!readEntryFromPlan(plan, "graft"), swarmWeb: el.swarmWeb, skills: wroteSkills }

  const lpath = ledgerPath(opts.base)
  const prior = readLedger(lpath)
  const files: Record<string, FileRecord> = { ...(prior?.files ?? {}) }
  const backupsThisRun: string[] = []
  let configBackup: string | null = null
  let changed = false

  // F-R109-1 fix: commit the ledger PER TARGET, durably, immediately BEFORE that target's replace, so
  // every completed step is independently kill-safe and reversible. A kill between two targets leaves a
  // ledger that fully accounts for everything already written (no orphan); a re-run finishes the rest.
  // Ordering per target: durable backup -> durable ledger (fsync'd via atomicWriteText) -> atomic replace.
  const commitLedger = (): void => {
    atomicWriteText(
      lpath,
      JSON.stringify({ version: LEDGER_VERSION, files, updatedAt: now } satisfies WriterLedger, null, 2) + "\n",
      MODES.FILE_0600,
    )
  }

  for (const p of plan) {
    const cur = readCurrent(p.path)
    if (cur.present && cur.text === p.desired) continue // already correct; leave any existing record intact

    const prev = files[p.path]
    let backup: string | null = null
    if (cur.present) {
      backup = join(dirname(p.path), `${basename(p.path)}.${sha12(cur.text)}.${compactStamp(now)}.bak`)
      atomicWriteText(backup, cur.text, MODES.FILE_0600) // durable BEFORE the ledger references it
      backupsThisRun.push(backup)
      if (p.label === CONFIG_FILE_NAME) configBackup = backup
    }
    files[p.path] = {
      targetPath: p.path,
      preexisting: prev ? prev.preexisting : cur.present,
      firstBackupPath: prev?.firstBackupPath ?? backup,
      backups: [...(prev?.backups ?? []), ...(backup ? [backup] : [])],
    }
    commitLedger() // reversal info is durable before the target changes (closes the K11/K12 gap)
    opts.onTargetBoundary?.("pre-replace", p.label) // TEST SEAM ONLY: throw here to emulate a kill after the ledger commit but before the replace
    atomicWriteText(p.path, p.desired, MODES.FILE_0600)
    opts.onTargetBoundary?.("post-replace", p.label) // TEST SEAM ONLY: throw here to emulate a kill after this target fully lands
    changed = true
  }

  if (!changed) {
    return { ok: true, changed: false, wrote, skipped, backupPath: null, backups: [], configPath }
  }
  return { ok: true, changed: true, wrote, skipped, backupPath: configBackup, backups: backupsThisRun, configPath }
}

/** Did the plan actually carry a graft entry? (guards against a guard-refusal that skipped it.) */
function readEntryFromPlan(plan: PlannedWrite[], name: "graft"): boolean {
  if (name !== "graft") return false
  const cfg = plan.find((p) => p.label === CONFIG_FILE_NAME)
  if (!cfg) return false
  try {
    return !!(JSON.parse(cfg.desired) as { mcp?: Record<string, unknown> }).mcp?.graft
  } catch {
    return false
  }
}

export interface RemoveOutcome {
  readonly ok: true
  readonly reversed: boolean
  /** Headline action on the config file (swarm.json); per-file detail is in `files`. */
  readonly action: "restored" | "deleted" | "no-op"
  readonly restoredFrom: string | null
  readonly removedBackups: number
  readonly files: ReadonlyArray<{ path: string; action: "restored" | "deleted" | "no-op" }>
}
export type RemoveResult = RemoveOutcome | { ok: false; reason: string }

/**
 * Reverse every recorded write: restore each pre-existing file from its first backup, delete each file we
 * created, sweep our backups, drop the ledger. Idempotent (a second call is a no-op). Refuses through a
 * symlinked target and refuses to fabricate a restore when a pre-existing origin-backup has gone missing.
 */
export function removeConfigEntries(opts: ConfigWriterOptions = {}): RemoveResult {
  const lpath = ledgerPath(opts.base)
  const ledger = readLedger(lpath)
  const configPath = configFilePath({
    ...(opts.base !== undefined ? { base: opts.base } : {}),
    ...(opts.path !== undefined ? { path: opts.path } : {}),
  })
  if (!ledger) return { ok: true, reversed: false, action: "no-op", restoredFrom: null, removedBackups: 0, files: [] }

  for (const rec of Object.values(ledger.files)) {
    if (isSymlink(rec.targetPath))
      return {
        ok: false,
        reason: `target ${rec.targetPath} is a symlink — refusing to remove through it (target_symlink)`,
      }
  }

  const files: Array<{ path: string; action: "restored" | "deleted" | "no-op" }> = []
  let removedBackups = 0
  for (const rec of Object.values(ledger.files)) {
    let action: "restored" | "deleted" | "no-op" = "no-op"
    if (rec.preexisting && rec.firstBackupPath && existsSync(rec.firstBackupPath)) {
      atomicWriteText(rec.targetPath, readFileSync(rec.firstBackupPath, "utf8"), MODES.FILE_0600)
      action = "restored"
    } else if (!rec.preexisting) {
      rmSync(rec.targetPath, { force: true })
      action = "deleted"
    } else {
      return {
        ok: false,
        reason: `ledger says ${rec.targetPath} pre-existed but its first backup ${String(rec.firstBackupPath)} is missing; refusing to guess the original`,
      }
    }
    removedBackups += sweepBackups(rec.targetPath, rec.backups)
    files.push({ path: rec.targetPath, action })
  }

  rmSync(lpath, { force: true })
  const cfgRecord = ledger.files[configPath]
  const cfgAction = files.find((f) => f.path === configPath)?.action ?? files[0]?.action ?? "no-op"
  const restoredFrom = cfgAction === "restored" ? (cfgRecord?.firstBackupPath ?? null) : null
  return { ok: true, reversed: true, action: cfgAction, restoredFrom, removedBackups, files }
}

function sweepBackups(targetPath: string, listed: string[]): number {
  let n = 0
  for (const b of listed) {
    if (existsSync(b)) {
      rmSync(b, { force: true })
      n++
    }
  }
  const dir = dirname(targetPath)
  const prefix = `${basename(targetPath)}.`
  if (existsSync(dir)) {
    for (const name of readdirSync(dir)) {
      if (name.startsWith(prefix) && name.endsWith(".bak")) {
        const p = join(dir, name)
        if (!listed.includes(p) && existsSync(p)) {
          rmSync(p, { force: true })
          n++
        }
      }
    }
  }
  return n
}

function isSymlink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink()
  } catch {
    return false
  }
}

export interface CheckResult {
  readonly ok: boolean
  /** Each entry is "<rel>: MISSING" or "<rel>: differs from rendered facts". Empty == current. */
  readonly drifts: readonly string[]
  readonly checked: readonly string[]
}

/**
 * Render-vs-written byte compare for the eligible model-facing texts (r98 §7 CI gate). Returns the drift
 * list; empty means every installed text byte-equals a fresh renderSkillTexts(). swarm.json is NOT checked
 * here (it is a merge that may legitimately hold user keys); only the pure rendered texts are.
 */
export function checkSkillFiles(opts: ConfigWriterOptions = {}): CheckResult {
  const stateRes = resolveStateFile(opts)
  if (!stateRes.ok) return { ok: false, drifts: [`state unreadable: ${stateRes.error}`], checked: [] }
  const el = eligibility(stateRes.state, opts)
  const texts = renderSkillTexts(opts.lock)
  const drifts: string[] = []
  const checked: string[] = []
  for (const t of TEXT_PLAN) {
    if (!el[t.gate]) continue
    checked.push(t.rel)
    const dest = join(configDir(opts.base), t.rel)
    if (!existsSync(dest)) {
      drifts.push(`${t.rel}: MISSING`)
      continue
    }
    if (readFileSync(dest, "utf8") !== texts[t.key]) drifts.push(`${t.rel}: differs from rendered facts`)
  }
  return { ok: drifts.length === 0, drifts, checked }
}

/** Exposed for tests: the exact desired swarm.json text for a given state, without writing anything. */
export function previewConfig(
  state: StateFile,
  opts: ConfigWriterOptions = {},
): { json: string; wrote: { graft: boolean; swarmWeb: boolean } } {
  const el = eligibility(state, opts)
  const { entries } = desiredEntries(state, opts, el)
  const { json } = mergeIntoExisting("", entries)
  return { json, wrote: { graft: !!entries.graft, swarmWeb: !!entries[MCP_SERVER_NAME] } }
}
