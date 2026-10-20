// Consent gate — FIRST, before any download (01c §11 / P-13 / decision 12 / B4).
// Row 83 implementation (row 81 skeleton handed this module over: "row 83 owns the
// consent-grant path + F-79-A policy gate hook").
//
// The load-bearing invariant enforced HERE, in code: NO network request can happen until a
// component has been consented to IN THIS RUN AND that consent is durably recorded. Enforcement
// is threefold:
//   1. Structural — index.ts reaches step discovery ONLY after evaluateConsent returns ok:true,
//      and evaluateConsent records every grant (append + fsync) BEFORE it returns.
//   2. Verifiable — consentWasGranted() answers grant-in-effect: durable record AND selection by
//      this run's decision (M4 fix); stepkit's kit.fetch, stacklib bring-up and row 106 dispatch
//      all gate on this one predicate before row 82's fetchArtifact may be called.
//   3. Testable — test/consent.test.ts wraps globalThis.fetch with a counter and proves a
//      refused run performs ZERO network calls (the blueprint's "no download before consent"),
//      including the M4 matrix: grant-run-A / decline-run-B (zero downloads B) / re-grant-C.
//
// Rules implemented verbatim from masterplan/01d_preinstall_consent_dataflow.md (REVISED):
//   - every component optional and UNTICKED by default (decision 12); only an explicit y/yes grants;
//     blank, EOF, garbage, or a missing terminal select NOTHING (fail-closed).
//   - terms are LINKED, never auto-accepted (C-2); the screen links out and prints the §6.3
//     third-party sentence; no vendor licence-acceptance flag exists anywhere.
//   - the declined terms-display verb (frozen class 12; gate R-3 disposition R-3): the nine fields
//     and the admin token live on THIS screen only (§6.1) — one place to read one value.
//   - non-interactive: --terms-token <component>=<value>, value must equal
//     `<component_id>@<lock_sha256_12>` — first 12 hex chars of sha256 of the shipped
//     tools.lock.json (§6.1). Missing or mismatched -> REFUSED_NON_INTERACTIVE listing what is
//     missing (§6.2 rules 1-3, 01c §8 refusal row). Tokens for unselected components are ignored
//     with a warning (§6.2 rule 2). There is NO bare-affirmative flag, NO wildcard token shortcut
//     and NO environment-variable acceptance channel (§6.2 rules 4-5) — one acceptance path only.
//   - consent record per accepted component appended atomically to ~/.swarm/setup/consent.log
//     (PC-PATH-03, mode 0600) with the five P-13 fields in order (time,user,component,version,hash)
//     plus row 74's §6.5 proposal fields (licence, terms_url, terms_revision, mode, token) and
//     hash_scope — the five originals stay first-class for row 108's field assertion.
//   - F-79-A hook (enforcement half only; admin switch DEFERRED per decisions/decisions.md):
//     forbidden components never reach the screen and refuse even with a token (policy.ts).
//
// The screen shows EXACTLY what the lock will make the program download: pins are pre-flighted
// through row 82's resolveArtifact — zero network by construction (s82_fetch_module.md §3).

import { existsSync, fsyncSync, mkdirSync, openSync, closeSync, readFileSync, readSync, writeSync } from "node:fs"
import { dirname } from "node:path"
import { createHash } from "node:crypto"
import { userInfo } from "node:os"
import { MODES, type ComponentId } from "./constants.ts"
import { OUTCOME, type OutcomeToken } from "./outcomes.ts"
import { consentLog, resolveLockFile } from "./paths.ts"
import { resolveArtifact } from "./fetch.ts"
import type { LockFile } from "./lockfile.ts"
import { CONSENT_BLOCKS, THIRD_PARTY_TERMS_SENTENCE } from "./consentText.ts"
import type { ConsentBlock } from "./consentText.ts"

export interface ConsentRequest {
  /** Components the user asked to install (empty = "all seven", resolved by caller). */
  selected: ComponentId[]
  nonInteractive: boolean
  /** Map of component id -> terms token supplied via --terms-token. */
  tokens: Partial<Record<ComponentId, string>>
  /** Validated lock (row 81 loadLock()) — pins and the token hash derive from it. */
  lock: LockFile
  /** F-79-A forbidden ids from policy.ts; also filtered defensively here (one enforcement point). */
  forbidden?: readonly ComponentId[]
  /** TEST SEAM ONLY (same discipline as row 82's allowedHosts narrowing): replaces the terminal
   *  reader for the interactive prompt. It cannot widen any contact surface — it only answers the
   *  opt-in question, and every non-affirmative answer still selects nothing. */
  ask?: (prompt: string) => string | null
}

export type ConsentResult = { ok: true; consented: ComponentId[] } | { ok: false; token: OutcomeToken }

/** runtime's downloadable artifact ids from the lock (multi-pin component); single-pin ids
 *  self-resolve; stack ids expose image refs instead (dockerd pulls them inside the VM, D-16b). */
const RUNTIME_DOWNLOADS = ["colima", "lima", "docker_cli", "docker_compose", "guest_image", "qemu"] as const

// --- grant-in-effect (FIX ROUND 4, senior review 11 MAJOR-4) ------------------------------------
// INVARIANT: a download requires a grant IN EFFECT FOR THIS RUN — a durable record (PC-PATH-03)
// AND selection by this run's consent decision. The append-only log is historical truth and is
// NEVER rewritten, but it is necessary-not-sufficient: "granted once" must not outlive a later
// DECLINE. Before this fix the predicate answered from history alone, so once run A granted
// `node`, run B declining `node` still passed the kit gate and downloaded (M4 — latent until
// row 106 wires real dispatch, which is exactly when it would have opened).
// sessionSelection holds EXACTLY the components the LAST evaluateConsent decision in this process
// granted; every decision replaces the previous one, and any refusal clears it. Both factors are
// load-bearing against cross-suite leakage (the FIX2 lesson): a stale selection can never grant in
// a HOME without a record, and a historical record can never grant without this-run selection.
const sessionSelection = new Set<ComponentId>()

/** True iff THIS RUN may download the component: a durable consent record exists AND this run's
 *  consent decision selected it. Single enforcement point for stepkit's default consentGate
 *  (kit.fetch layer 2), stacklib bring-up checks, and row 106's dispatch wiring. */
export function consentWasGranted(id: ComponentId): boolean {
  return sessionSelection.has(id) && hasDurableRecord(id)
}

/** Whether the current HOME's consent.log (PC-PATH-03) carries a record line naming the
 *  component — historical truth only; NOT a download permission on its own. Unreadable or
 *  malformed input answers false (fail-closed, same posture as resume logic's "cannot verify =
 *  not verified"); a torn final line must not hide earlier complete records, so scanning continues. */
function hasDurableRecord(id: ComponentId): boolean {
  const path = consentLog()
  if (!existsSync(path)) return false
  let text: string
  try {
    text = readFileSync(path, "utf8")
  } catch {
    return false
  }
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue
    try {
      const rec = JSON.parse(line) as { component?: unknown }
      if (rec.component === id) return true
    } catch {
      // A torn final line (killed appender) must not hide earlier complete records: keep scanning.
      continue
    }
  }
  return false
}

/** Print the consolidated host list BEFORE any download (P-18 / P-13, §11 step 4). */
export function printHostList(hosts: readonly string[]): void {
  console.log("Hosts swarm-setup may contact (nothing else):")
  for (const h of hosts) console.log(`  - ${h}`)
}

/** Present each selected component as optional and UNTICKED (§11 step 5, decision 12). */
export function printUntickedComponents(selected: readonly ComponentId[]): void {
  console.log("Components (all optional, all unticked by default):")
  for (const id of selected) console.log(`  [ ] ${id}`)
}

/** sha256 (full hex) of the tools.lock.json file the setup is shipped with — the token source
 *  material (01d §6.1). Read from disk so the value always matches the bytes actually shipped. */
export function computeLockSha256(): string {
  const bytes = readFileSync(resolveLockFile())
  return createHash("sha256").update(new Uint8Array(bytes)).digest("hex")
}

/** The admin token for one component under one lock: `<component_id>@<lock_sha256_12>` (§6.1). */
export function expectedTokenValue(componentId: ComponentId, lockSha256Hex: string): string {
  return `${componentId}@${lockSha256Hex.slice(0, 12)}`
}

// --- consent screen ---------------------------------------------------------------------

/** Render the §11-step-5 screen: nine P-13 fields per block, live pins from the lock
 *  (zero-network pre-flight via resolveArtifact), terms LINKED not auto-accepted, and the
 *  admin token an MDM operator would need for this exact lock revision (§6.1). */
export function renderConsentScreen(lock: LockFile, offered: readonly ComponentId[], opts: { dryRun: boolean }): void {
  printUntickedComponents(offered)
  const fullHash = computeLockSha256()
  for (const id of offered) {
    for (const block of CONSENT_BLOCKS[id]) {
      console.log("")
      console.log(`--- [ ] ${id} - block ${block.block}: ${block.title} ---`)
      console.log("Optional: yes - unticked by default; nothing installs until you tick it (decision 12).")
      console.log(`Purpose: ${block.purpose}`)
      console.log("Source URL:")
      for (const u of block.sourceUrl) console.log(`  - ${u}`)
      console.log(`Version: ${block.versionNote}`)
      console.log(`Hash: ${block.hashNote}`)
      console.log(`Licence: ${formatLicence(lock, id)}`)
      console.log(`Size: ${block.sizeNote}`)
      console.log("Egress statement:")
      for (const line of block.egress) console.log(`  ${line}`)
      console.log("Paths written:")
      for (const p of block.pathsWritten) console.log(`  - ${p}`)
      console.log("Uninstall path:")
      for (const u of block.uninstallPath) console.log(`  - ${u}`)
      printLivePins(lock, id)
      if (block.termsUrl) {
        console.log(`Third-party terms (LINKED, never auto-accepted): ${block.termsUrl}`)
        console.log(`  Recorded revision: ${block.termsRevision ?? "n/a"}`)
        console.log(`  ${THIRD_PARTY_TERMS_SENTENCE}`)
      }
      for (const w of block.warnings) console.log(`WARNING: ${w}`)
    }
    console.log(`Admin token for --non-interactive (${id}): ${expectedTokenValue(id, fullHash)}`)
    console.log(
      "  The token is public text derived from the shipped lock - not a secret (01d §6.4). Bumping any pin invalidates every scripted token.",
    )
  }
  console.log("")
  if (opts.dryRun) {
    console.log("dry-run: this is EXACTLY what would be asked. Nothing was asked, nothing was consented to,")
    console.log("nothing was recorded, and nothing will be downloaded by this run.")
  }
}

/** Print the exact url/version/hash/size the lock would make this program fetch - through
 *  resolveArtifact, which touches no network (row 82 handoff: "resolveArtifact = zero-network
 *  pin pre-flight for consent screen"). Unfetchable-by-design entries (null pins, images)
 *  are stated, not hidden. */
function printLivePins(lock: LockFile, id: ComponentId): void {
  if (id === "runtime") {
    console.log("Pins from tools.lock.json (shown exactly as the fetch library will re-check them):")
    for (const artifact of RUNTIME_DOWNLOADS) {
      const r = resolveArtifact(lock, id, artifact)
      if (r.ok)
        console.log(
          `  ${artifact}: ${r.artifact.url} | ${r.artifact.version ?? "n/a"} | ${r.artifact.expected.algorithm}:${r.artifact.expected.pin} | ${sizeText(r.artifact.expectedSizeBytes)}`,
        )
      else console.log(`  ${artifact}: ${r.code} - ${r.message}`)
    }
    return
  }
  const direct = resolveArtifact(lock, id)
  if (direct.ok) {
    console.log(
      `Pin from tools.lock.json: ${direct.artifact.url} | ${direct.artifact.version ?? "n/a"} | ${direct.artifact.expected.algorithm}:${direct.artifact.expected.pin} | ${sizeText(direct.artifact.expectedSizeBytes)}`,
    )
    if (id === "graft")
      console.log("  (installed footprint measured 387 MB on this machine - both figures shown per 01d §9)")
    return
  }
  // Stack components: dockerd pulls images inside the VM; the setup fetches no file for them (D-16b).
  const images = Object.entries(lock.components[id] ?? {}).filter(
    ([k, v]) => (k === "image" || k.endsWith("_image")) && typeof v === "string",
  )
  if (images.length > 0) {
    console.log(
      "Container images (pulled by dockerd INSIDE the swarm VM against these digests, never fetched by the setup - D-16b):",
    )
    for (const [field, ref] of images) console.log(`  ${field.replace(/_image$/, "")}: ${String(ref)}`)
  }
  if (id === "firecrawl") {
    const mcp = resolveArtifact(lock, id, "firecrawl_mcp")
    console.log(
      `  firecrawl-mcp connector: ${mcp.ok ? mcp.artifact.url : `${mcp.code} - pinned install waits for its reviewed pin (finding F-2, gate D-11)`}`,
    )
  }
}

function sizeText(n: number | undefined): string {
  return n === undefined ? "size not pinned" : `${n.toLocaleString("en-US")} bytes`
}

/** Licence(s) exactly as the reviewed lock records them (D-03 map; LicenseRef-Obsidian included). */
export function formatLicence(lock: LockFile, id: ComponentId): string {
  const licence = lock.components[id]?.licence
  if (typeof licence === "string") return licence
  if (licence && typeof licence === "object") {
    return Object.entries(licence as Record<string, unknown>)
      .map(([k, v]) => `${k}=${typeof v === "string" ? v : "not yet reviewed"}`)
      .join("; ")
  }
  return "see tools.lock.json"
}

// --- decision -----------------------------------------------------------------------------

/**
 * Decide consent. Grants ONLY through: an explicit y/yes per component (interactive), or a
 * matching per-component --terms-token (non-interactive). Every grant is recorded durably to
 * PC-PATH-03 BEFORE this function returns ok:true - the ordering invariant in code. Refusals
 * write nothing to disk (row 83 gate: "a refused run leaves nothing on disk").
 */
export function evaluateConsent(req: ConsentRequest): ConsentResult {
  // Every consent decision REPLACES the previous one in this process (grant-in-effect, M4):
  // clear first, so any refusal path below leaves nothing selected for this run.
  sessionSelection.clear()
  const forbidden = new Set(req.forbidden ?? [])
  const blocked = req.selected.filter((id) => forbidden.has(id))
  if (blocked.length > 0) {
    // F-79-A enforcement: forbidden components refuse even with a token; they never reach the screen.
    console.error(
      `admin policy forbids: ${blocked.join(", ")} - not presented, refusing even with a token (F-79-A hook)`,
    )
  }
  const offered = req.selected.filter((id) => !forbidden.has(id))
  if (offered.length === 0) return { ok: false, token: OUTCOME.REFUSED_NO_CONSENT }

  const ask = req.ask ?? defaultAsk

  if (req.nonInteractive) {
    const missing = offered.filter((id) => !req.tokens[id])
    if (missing.length > 0) {
      console.error(`Missing --terms-token for: ${missing.join(", ")}`)
      return { ok: false, token: OUTCOME.REFUSED_NON_INTERACTIVE }
    }
    const fullHash = computeLockSha256()
    const mismatched = offered.filter((id) => req.tokens[id] !== expectedTokenValue(id, fullHash))
    if (mismatched.length > 0) {
      // Name the components, not the values: the token is public text (§6.4), but echoing
      // near-miss values invites silent fleet drift; the correct token prints on the screen.
      console.error(
        `--terms-token mismatch for: ${mismatched.join(", ")} - expected <component_id>@<lock_sha256_12> for THIS lock (shown on the consent screen)`,
      )
      return { ok: false, token: OUTCOME.REFUSED_NON_INTERACTIVE }
    }
    const ignored = Object.keys(req.tokens).filter((k) => !offered.includes(k as ComponentId))
    for (const k of ignored)
      console.error(
        `warning: --terms-token for "${k}" ignored (component not selected) - acceptance is never recorded for unselected components (01d §6.4)`,
      )

    const granted: ComponentId[] = []
    for (const id of offered) {
      recordConsent({ component: id, mode: "non-interactive", token: req.tokens[id], lock: req.lock })
      granted.push(id)
    }
    // Grant-in-effect: only components whose token VALIDATED count as selected for this run.
    for (const id of granted) sessionSelection.add(id)
    return { ok: true, consented: granted }
  }

  // Interactive path: default OFF for every component (decision 12). Only y/yes grants.
  const granted: ComponentId[] = []
  for (const id of offered) {
    const answer = ask(
      `Install ${id}? Type 'y' to consent (reads the block above first), anything else leaves it OFF [y/N]`,
    )
    const yes = answer !== null && ["y", "yes"].includes(answer.trim().toLowerCase())
    if (yes) granted.push(id)
  }
  if (granted.length === 0) {
    // Nothing selected means nothing was consented to; there is nothing to install. Fail-closed
    // whether the cause was blank answers, EOF, or no terminal at all (defaultAsk -> null).
    return { ok: false, token: OUTCOME.REFUSED_NO_CONSENT }
  }
  for (const id of granted) recordConsent({ component: id, mode: "interactive", lock: req.lock })
  // Grant-in-effect: the y/yes answers of THIS decision are this run's selection (M4).
  for (const id of granted) sessionSelection.add(id)
  return { ok: true, consented: granted }
}

// --- interactive reader --------------------------------------------------------------------

/** Default reader: prompts ONLY on a real terminal. With no TTY it returns null (no answer),
 *  which selects nothing - the fail-closed posture row 81 had, kept honest: we never fabricate
 *  consent from a pipe, and scripted runs use --non-interactive + tokens (the ONE channel §6.2
 *  defines). Never blocks on a non-terminal stdin. */
function defaultAsk(prompt: string): string | null {
  if (process.stdin?.isTTY !== true) {
    console.error(
      "no interactive terminal; nothing selected (scripted runs must use --non-interactive with --terms-token)",
    )
    return null
  }
  console.log(prompt)
  return readLineFromStdin()
}

/** One line from fd 0. Canonical-mode TTY reads return whole lines; EOF returns null.
 *  ASCII char decoding only (y/n answers); no TextEncoder/TextDecoder global is declared in
 *  this package's self-contained type shims, and inventing one is row 106's catalog job. */
function readLineFromStdin(): string | null {
  const buf = new Uint8Array(256)
  let line = ""
  for (;;) {
    let n: number
    try {
      n = readSync(0, buf, 0, buf.length)
    } catch {
      return null // EAGAIN/EIO on a weird stdin: treat as no input (fail-closed)
    }
    if (n <= 0) return line.length > 0 ? line : null
    for (let i = 0; i < n; i++) {
      const c = buf[i] as number
      if (c === 10) return line.replace(/\r$/, "") // '\n'
      line += String.fromCharCode(c)
      if (line.length > 512) return null // absurd input: no answer, not a memory risk
    }
  }
}

// --- durable recording (PC-PATH-03) ----------------------------------------------------------

export interface ConsentEntryInput {
  component: ComponentId
  mode: "interactive" | "non-interactive"
  /** The validated token value for non-interactive grants; logged as evidence, never secret (§6.4). */
  token?: string
  lock: LockFile
}

/**
 * Append one consent line to ~/.swarm/setup/consent.log (PC-PATH-03, mode 0600) and FSYNC it
 * before returning - the record is durable BEFORE any fetch is permitted (ordering invariant).
 * Append-with-fsync is the atomic-log pattern for JSONL: rename-based atomicWrite would clobber
 * history, and O_APPEND writes of one small line are atomic against concurrent appenders.
 * Schema: the five P-13 fields in row 73's order (time,user,component,version,hash) plus the
 * §6.5 proposal fields (licence, terms_url, terms_revision, mode, token) and hash_scope, which
 * says whether version/hash name a single artifact pin or the whole reviewed lock.
 */
export function recordConsent(input: ConsentEntryInput): void {
  const path = consentLog()
  const pin = pinForRecord(input.lock, input.component)
  const terms = firstTerms(CONSENT_BLOCKS[input.component])
  const line =
    JSON.stringify({
      time: new Date().toISOString(),
      user: userName(),
      component: input.component,
      version: asciiSafe(pin.version),
      hash: asciiSafe(pin.hash),
      hash_scope: pin.scope,
      licence: asciiSafe(formatLicence(input.lock, input.component)),
      terms_url: asciiSafe(terms.url),
      terms_revision: asciiSafe(terms.revision),
      mode: input.mode,
      ...(input.token !== undefined ? { token: asciiSafe(input.token) } : {}),
    }) + "\n"

  mkdirSync(dirname(path), { recursive: true, mode: MODES.DIR_0700 })
  const fd = openSync(path, "a", MODES.FILE_0600)
  try {
    writeSync(fd, asciiBytes(line))
    fsyncSync(fd) // durable BEFORE evaluateConsent can return ok:true
  } finally {
    closeSync(fd)
  }
}

/** version/hash of record per 01d §6.5: single-downloadable-pin components carry their artifact
 *  values (resolveArtifact, zero-network); multi-artifact components (runtime, the two stacks)
 *  carry the reviewed lock itself - one consent line per component (C-4) cannot hold N artifact
 *  hashes, and the lock hash provably pins every one of them. */
function pinForRecord(lock: LockFile, id: ComponentId): { version: string; hash: string; scope: "artifact" | "lock" } {
  const single = id === "node" || id === "graft" || id === "rtk" || id === "obsidian"
  if (single) {
    const r = resolveArtifact(lock, id)
    if (r.ok) return { version: r.artifact.version ?? "n/a", hash: r.artifact.expected.pin, scope: "artifact" }
  }
  return { version: lock.version, hash: computeLockSha256(), scope: "lock" }
}

function firstTerms(blocks: readonly ConsentBlock[]): { url: string; revision: string } {
  for (const b of blocks) {
    if (b.termsUrl) return { url: b.termsUrl, revision: b.termsRevision ?? "n/a" }
  }
  return { url: "n/a (FOSS licence)", revision: "n/a (FOSS licence)" }
}

function userName(): string {
  try {
    const info = userInfo()
    return `${info.username}:${info.uid}`
  } catch {
    const uid = typeof process.getuid === "function" ? String(process.getuid()) : "unknown"
    console.error(
      "consent record: user lookup failed; uid recorded instead (context: consent.log user field, 01d §6.5)",
    )
    return `unknown:${uid}`
  }
}

/** Recorded consent lines stay pure ASCII so the audit log is tool-parseable everywhere
 *  (row 74 §14 keeps its Indonesian sentences out of recorded fields by design; the SCREEN
 *  shows them). Anything outside ASCII collapses to "-" rather than being truncated mid-byte. */
function asciiSafe(s: string): string {
  let out = ""
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    out += c >= 32 && c < 127 ? s[i] : "-"
  }
  return out
}

function asciiBytes(s: string): Uint8Array {
  const bytes = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i) & 0xff
  return bytes
}
