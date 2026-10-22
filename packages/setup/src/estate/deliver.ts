// Estate render-and-deliver stage (row 263, masterplan/08_s6b_estate_delivery_spec.md).
//
// WHAT THIS IS: the production step that has never existed — the one that puts the rendered
// estate where the estate's own bring-up looks for it (`verification/s6_r240d_compose_delivery.md`,
// verdict DELIVERY MISSING). Per D-262-1 (ratified decisions/decisions.md:426-429) it is a STAGE
// inside the two existing stack steps, called from their install() immediately before bringUp,
// NOT a new component: step order is Kahn over `requires` with both stack steps terminal, dispatch
// is filtered by the consented set (index.ts:371-372), and the product tells users to run
// `install searxng` (index.ts:473) — an eighth component would simply never run on that command.
//
// THE CONTRACT THIS FILE IMPLEMENTS, clause by clause:
//  - D-262-2 per-stack WRITE scope with BOTH-stack slot declarations: renderAll refuses unless
//    every required slot of both stacks is declared (shared.ts contextErrors), so the render is
//    produced whole and the WRITES are filtered by the stack tag every RenderFile carries.
//    A searxng install writes 3 artefacts + 1 secret; firecrawl writes 7 + 4; union = the fifteen
//    artefacts of spec §2.6. Delivering compose alone would convert ARTEFACT_MISSING into
//    BIND_SOURCE_MISSING (stacklib.ts:508-529) — that state must be unproducible, and the three
//    phases below are what make it unproducible.
//  - R-262-1 content-addressed no-write: compare bytes+mode before writing; touch only what
//    differs (a mode-only difference IS rewritten — group-readable bits are exactly what
//    checkPreconditions refuses, stacklib.ts:478-483).
//  - R-262-2 never rotate a live secret: an existing valid secret is left byte-identical and
//    recorded "present" (the discipline live_smoke.ts:142-153 learned the hard way).
//  - R-262-3 report leftovers, never prune: files under the two trees that this render does not
//    emit go into the ledger's `residue` array (red line R5 + rule E13).
//  - Spec §4.2 three phases: plan (render in memory, secret posture, target resolution, pure
//    preflight, intent ledger row) -> commit (capture prior bytes, atomic writes) -> verify
//    (read-back sha256+mode) with rollback from captured priors on any failure. Convergent across
//    crashes: rename-per-file (atomic.ts:19-33) plus compare-on-restart means the next run finishes.
//  - §1.5 skipped stays skipped: state "skipped" -> OUTCOME.SKIPPED, nothing transitioned/written
//    (the chain admits skipped->downloaded, so a chain-walk MUST NOT start for a skipped component).
//  - §1.5 the state walk: absent -> downloaded -> verified -> installed -> configured through one
//    kit, because bringUp only owns configured->healthy and legal() rejects absent->healthy
//    (stepkit.ts:99-114). Mapping (design intent, spec §1.5): downloaded = the artefacts exist as
//    rendered bytes in memory; verified = render ok (lint-clean + argv-leak-clean, composefiles/
//    index.ts:129-153); installed = every artefact committed to the tools root; configured =
//    paths recorded + modes verified. After that, bring-up's existing configured->healthy edge
//    fires untouched.
//  - D-262-3 provenance in the NEW ledger (PC-PATH-20), never a fifth StackProvenanceRecord.action.
//  - §4.1 closed refusal-code set (ledger.ts DELIVER_CODES); no new outcome token — specificity
//    rides the message and the ledger while the step reports FAILED/SKIPPED through frozen tokens.
//  - §4.3 first-line discipline: only the first line survives index.ts:394's split("\n")[0], so
//    every refusal names its code AND the specific path in line one.
//
// SECRETS (spec §2.2; GAP-1 answered from code per decisions/decisions.md:451-454): the only
// producer of the five required secrets today was the smoke driver (test/live_smoke.ts:144-155),
// which product code cannot call; this stage therefore becomes the first production producer,
// generating ONLY absent required slots with node:crypto at the ratified per-slot encodings
// (masterplan/01e_compose_spec.md §4.6 — transcribed from SECRET_INVENTORY genHints, not invented),
// registering every value with kit.registerSecret BEFORE any log line can carry it (P-8). The
// historical gap (no production owner existed) is reported closed by this row, not papered over.
// Optional slots stay absent: the shipped U-5/U-6 defaults forbid creating them (spec §2.5).

import { existsSync, lstatSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import { createHash, randomBytes } from "node:crypto"
import { MODES, STATES, type StateValue } from "../constants.ts"
import { OUTCOME } from "../outcomes.ts"
import type { StepResult } from "../steps/_template/index.ts"
import type { StepKit } from "../stepkit.ts"
import type { LockFile } from "../lockfile.ts"
import { ensureDir, homeDir } from "../paths.ts"
import { atomicWriteText } from "../atomic.ts"
import { applyRenderedFiles, renderAll, validateRenderedSecrets, type FullRender } from "../composefiles/index.ts"
import { SECRET_INVENTORY, type RenderFile } from "../composefiles/shared.ts"
import {
  appendEstateDelivery,
  programStamp,
  type DeliverCode,
  type EstateArtefactRow,
  type EstateDeliveryRecord,
  type EstateSecretRow,
} from "./ledger.ts"
import { produceDnsPinsFromAnswers } from "./pins.ts"
import type { ResolveOutcome } from "../mcpproxy/resolve.ts"

export interface DeliverEstateOptions {
  readonly kit: StepKit
  /** Pinned HOME (rule E7): resolved ONCE here; every path below derives from this value, so a
   *  sandboxed run cannot leak into the real home mid-flight. */
  readonly home?: string
  /** Row 266 (producer spec §1.1, U-240b-1): the bounded crawl-target allow-list plus whatever the
   *  host resolver answered for each name. BOTH arrive from the caller because neither is this stage's
   *  to invent — which names are pinned is an operator/gate decision, and node has no synchronous DNS
   *  lookup for a stage whose two callers are synchronous. Empty/absent means "no allow-list decided
   *  yet": the produce refuses, writes nothing, and the render stays byte-identical to today's estate
   *  (the absent file is the legal no-pins state, §3.3). A non-empty list with no answers refuses with
   *  PINS_ANSWERS_UNAVAILABLE rather than silently skipping — the gap stays visible. */
  readonly dnsPins?: { readonly hostnames: readonly string[]; readonly answers?: Readonly<Record<string, ResolveOutcome>> }
  /** TEST SEAM ONLY (same narrowing discipline as consentGate/fetchImpl/makeFakeDockerShim):
   *  called with each artefact path immediately AFTER its atomic commit, so a unit can script a
   *  mid-pass throw (simulating EACCES/ENOSPC between writes) or corrupt the committed bytes (to
   *  drive the Phase-3 read-back). It can only make the stage fail EARLIER or LOUDER — it cannot
   *  bypass a gate, widen a scope, or hide a mismatch. Shipped code never passes it. */
  readonly disturbWrite?: (absPath: string) => void
}

type StackComponent = "searxng" | "firecrawl"

const STACK_ORDER: Record<StackComponent, number> = { searxng: 3, firecrawl: 7 }

/** The §4.1 forward-chain positions this stage walks; a component at/after `configured` needs no hops. */
const CHAIN: readonly StateValue[] = [STATES.ABSENT, STATES.DOWNLOADED, STATES.VERIFIED, STATES.INSTALLED, STATES.CONFIGURED]

interface ArtefactPlan {
  readonly file: RenderFile
  readonly row: EstateArtefactRow
  readonly prior?: { bytes: string; mode: number }
}

interface SecretPlan {
  readonly component: StackComponent
  readonly slot: string
  readonly absPath: string
  readonly action: "present" | "created"
  /** Set only when this run generates the value; registered with the redactor immediately, never logged. */
  readonly value?: string
  readonly mode: number
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex")
}

/** UTF-8 byte count through the declared Buffer shim only (from(string,"utf8") -> hex length). */
function utf8Bytes(text: string): number {
  return Buffer.from(text, "utf8").toString("hex").length / 2
}

function toHex(bytes: Uint8Array): string {
  let out = ""
  for (const b of bytes) out += b.toString(16).padStart(2, "0")
  return out
}

const B64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"

/** Unpadded base64url over raw bytes — the §4.6 genHint form `openssl rand -base64 N | tr '+/' '-_'
 *  | tr -d '='` executed in-process. Hand-rolled because the row-81 node shim declares neither a
 *  Buffer that accepts Uint8Array nor btoa; unit-tested against RFC 4648 vectors. */
function toBase64Url(bytes: Uint8Array): string {
  let out = ""
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0
    const has1 = i + 1 < bytes.length
    const has2 = i + 2 < bytes.length
    const n = (b0 << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0)
    out += B64URL_ALPHABET.charAt((n >> 18) & 63) + B64URL_ALPHABET.charAt((n >> 12) & 63)
    if (has1) out += B64URL_ALPHABET.charAt((n >> 6) & 63)
    if (has2) out += B64URL_ALPHABET.charAt(n & 63)
  }
  return out
}

function fileMode(path: string): number {
  return statSync(path).mode & 0o777
}

/** Same collapse stacklib.ts:180-182 does for the consumer's whitelist test — kept local because
 *  stacklib's copy is module-private and stacklib.ts is row 246's area (not editable here). */
function collapseSlashes(p: string): string {
  return p.replace(/\/{2,}/g, "/")
}

/** §4.6 per-slot encodings, transcribed from the SECRET_INVENTORY genHints (openssl rand forms)
 *  and executed with node:crypto instead of spawning openssl. Every form clears the 32-char floor. */
function generateSecretValue(component: StackComponent, slot: string): string {
  const hint = SECRET_INVENTORY[component].find((s) => s.name === slot)?.genHint ?? ""
  if (hint.includes("-hex")) return toHex(randomBytes(32)) // secret_key, redis_auth (U-4 ON)
  if (hint.includes("-base64 48")) return toBase64Url(randomBytes(48)) // postgres_password (tr -d '\n=' == unpadded url-safe)
  return toBase64Url(randomBytes(32)) // proxy_token (base64url per §4.6), bull_auth_key (base64 alphabet, url-safe superset)
}

/** Pure preflight (zero writes): the nearest existing ancestor of every target must be a writable
 *  directory, and no ancestor may be occupied by a non-directory. */
function uncreatableTarget(targets: readonly string[]): string | null {
  for (const target of targets) {
    let dir = dirname(target)
    for (;;) {
      let st
      try {
        st = lstatSync(dir)
      } catch {
        dir = dirname(dir)
        continue
      }
      if (!st.isDirectory()) return `${target}: ancestor ${dir} is not a directory`
      // Writability without accessSync (outside the row-81 node:fs shim): swarm-setup refuses to run
      // as root (gates P-4), so on its own home tree the OWNER write bit is this process's write
      // permission; a cleared bit refuses here, and a wrong-owner dir still fails the atomic write.
      if ((st.mode & 0o200) === 0) return `${target}: ancestor ${dir} is not writable (owner write bit clear)`
      break
    }
  }
  return null
}

/** R-262-3 residue: files under the two component trees that THIS render does not emit. Inventory
 *  secret slots (required and optional) are another owner's legitimate output; cache/logs subtrees
 *  are bring-up's runtime mounts (spec §2.3). Reported, never deleted (R5/E13). */
function listResidue(toolsRoot: string, rendered: readonly RenderFile[]): string[] {
  const known = new Set<string>(rendered.map((f) => f.relPath))
  for (const comp of ["searxng", "firecrawl"] as const)
    for (const spec of SECRET_INVENTORY[comp]) known.add(`${comp}/secrets/${spec.name}`)
  const out: string[] = []
  for (const comp of ["searxng", "firecrawl"] as const) {
    const root = join(toolsRoot, comp)
    if (!existsSync(root)) continue
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const abs = join(dir, name)
        if (statSync(abs).isDirectory()) {
          if (name === "cache" || name === "logs") continue // bring-up-owned runtime mounts
          walk(abs)
          continue
        }
        if (!known.has(abs.slice(`${toolsRoot}/`.length))) out.push(abs)
      }
    }
    walk(root)
  }
  return out.sort()
}

function baseFields(kit: StepKit, component: StackComponent, home: string, toolsRoot: string) {
  const verbTokens = process.argv.slice(2).filter((a) => !a.startsWith("-"))
  return {
    lockVersion: kit.lock.version,
    program: programStamp(verbTokens),
    stack: component,
    home,
    toolsRoot,
    correlationId: `run-${process.pid}`, // matches cmdInstall's correlation id (index.ts:315)
  }
}

function appendBestEffort(record: EstateDeliveryRecord): void {
  const outcome = appendEstateDelivery(record)
  if (!outcome.ok) console.error(`${"swarm-setup"}: estate-delivery ledger append failed: ${outcome.detail}`)
}

/** One refusal shape for every code: ledger row + FAILED whose FIRST line carries the code and the
 *  specific detail/path (only line one survives index.ts:394). */
function appendRefused(
  code: DeliverCode,
  fields: ReturnType<typeof baseFields>,
  startedAt: number,
  extra: { render?: EstateDeliveryRecord["render"]; secrets?: readonly EstateSecretRow[]; residue?: readonly string[] } = {},
): void {
  appendBestEffort({
    ts: new Date().toISOString(),
    ...fields,
    action: "refused",
    code,
    ...(extra.render ? { render: extra.render } : {}),
    artefacts: [],
    secrets: extra.secrets ?? [],
    residue: extra.residue ?? [],
    elapsedMs: Date.now() - startedAt,
  })
}

function refuse(
  code: DeliverCode,
  detail: string,
  fields: ReturnType<typeof baseFields>,
  startedAt: number,
  extra: { render?: EstateDeliveryRecord["render"]; secrets?: readonly EstateSecretRow[]; residue?: readonly string[] } = {},
): StepResult {
  appendRefused(code, fields, startedAt, extra)
  return { token: OUTCOME.FAILED, message: `estate delivery refused [${code}] ${detail}` }
}

/** §2.2 secret posture for the REQUESTED stack only (D-262-2). Valid-present -> leave byte-identical
 *  (R-262-2); absent -> generate in memory now; present-but-invalid/unreadable -> collect the named
 *  SECRET_MISSING-mirror condition (the same three tests checkPreconditions applies, stacklib.ts:465-491)
 *  so the caller refuses with DELIVER_SECRET_INVALID before any byte moves. Optional slots never ensured. */
function planSecrets(kit: StepKit, component: StackComponent, toolsRoot: string): { plans: SecretPlan[]; invalid: EstateSecretRow[]; reasons: string[] } {
  const plans: SecretPlan[] = []
  const invalid: EstateSecretRow[] = []
  const reasons: string[] = []
  for (const spec of SECRET_INVENTORY[component]) {
    if (!spec.required) continue // D-22: absence of an optional slot is a valid state (spec §2.5)
    const absPath = join(toolsRoot, component, "secrets", spec.name)
    if (existsSync(absPath)) {
      const mode = fileMode(absPath)
      if ((mode & 0o077) !== 0) {
        invalid.push({ component, slot: spec.name, action: "refused", mode })
        reasons.push(`SECRET_MISSING mirror: secret ${absPath} mode ${mode.toString(8)} (group/other bits set)`)
        continue
      }
      let content = ""
      try {
        content = readFileSync(absPath, "utf8")
      } catch (err) {
        invalid.push({ component, slot: spec.name, action: "refused", mode })
        reasons.push(`SECRET_MISSING mirror: secret ${absPath} unreadable (${(err as Error).message})`)
        continue
      }
      if (content.trim() === "") {
        invalid.push({ component, slot: spec.name, action: "refused", mode })
        reasons.push(`SECRET_MISSING mirror: secret ${absPath} is empty`)
        continue
      }
      plans.push({ component, slot: spec.name, absPath, action: "present", mode })
      continue
    }
    const value = generateSecretValue(component, spec.name)
    kit.registerSecret(value) // BEFORE any log line can carry it (P-8, row-84 mechanism)
    plans.push({ component, slot: spec.name, absPath, action: "created", value, mode: MODES.FILE_0600 })
  }
  return { plans, invalid, reasons }
}

function planArtefacts(scoped: readonly RenderFile[], toolsRoot: string): { plans: ArtefactPlan[]; blocked: string[] } {
  const plans: ArtefactPlan[] = []
  const blocked: string[] = []
  for (const file of scoped) {
    const absPath = join(toolsRoot, file.relPath)
    const rowBase = {
      relPath: file.relPath,
      absPath,
      mode: file.mode,
      sha256: sha256(file.content),
      bytes: utf8Bytes(file.content),
    }
    if (!existsSync(absPath)) {
      plans.push({ file, row: { ...rowBase, action: "written" } })
      continue
    }
    let prior: { bytes: string; mode: number }
    try {
      prior = { bytes: readFileSync(absPath, "utf8"), mode: fileMode(absPath) }
    } catch (err) {
      // An existing target that cannot be read (occupied by a directory, EISDIR/EACCES) is a
      // detectable-in-advance failure: name it and refuse BEFORE any byte moves (§4.1), rather
      // than throwing mid-plan.
      blocked.push(`${absPath}: existing target unreadable (${(err as Error).message})`)
      continue
    }
    const unchanged = prior.bytes === file.content && prior.mode === file.mode
    plans.push({ file, row: { ...rowBase, action: unchanged ? "unchanged" : "written" }, prior })
  }
  return { plans, blocked }
}

/** Snapshot `.tmp-*` siblings per affected parent dir BEFORE committing, so teardown can remove
 *  only the ones that appeared during THIS pass (mine by construction — atomic.ts names them with
 *  a UUID this process generated). Never a sweep (rule E13). */
function snapshotTmpDirs(targets: readonly string[]): Map<string, Set<string>> {
  const snap = new Map<string, Set<string>>()
  for (const dir of new Set(targets.map((t) => dirname(t))))
    snap.set(dir, new Set(existsSync(dir) ? readdirSync(dir).filter((n) => n.startsWith(".tmp-")) : []))
  return snap
}

function removeOwnStrayTmp(snap: Map<string, Set<string>>): void {
  for (const [dir, before] of snap) {
    if (!existsSync(dir)) continue
    for (const name of readdirSync(dir).filter((n) => n.startsWith(".tmp-"))) {
      if (before.has(name)) continue
      try {
        rmSync(join(dir, name))
      } catch {
        // vanished meanwhile; nothing owed.
      }
    }
  }
}

/** Restore captured priors / undo creations made in this pass. Returns the paths actually undone. */
function rollback(entries: ReadonlyArray<{ absPath: string; prior?: { bytes: string; mode: number } }>): string[] {
  const rolledBack: string[] = []
  for (const p of entries) {
    try {
      if (p.prior) atomicWriteText(p.absPath, p.prior.bytes, p.prior.mode)
      else if (existsSync(p.absPath)) rmSync(p.absPath)
      rolledBack.push(p.absPath)
    } catch {
      // A failed restore stays OUT of rolledBack — the short list plus the ledger code names the incident.
    }
  }
  return rolledBack
}

/** Walk the forward chain up to `to` through the one kit. Positions at/after `configured` need no
 *  hops (re-runs stay state-inert); `failed`/`BLOCKED_BY_NETWORK` resume per stepkit FORWARD tables
 *  (both admit `downloaded`). Validates against the kit's live tracker, so mid-walk commits count. */
function walkTo(kit: StepKit, to: StateValue): { ok: true } | { ok: false; error: string } {
  const start = CHAIN.indexOf(kit.stateOf().state)
  const target = CHAIN.indexOf(to)
  const hops = (start >= 0 ? CHAIN.slice(start + 1) : CHAIN.slice(1)).filter((h) => CHAIN.indexOf(h) <= target)
  for (const hop of hops) {
    const moved = kit.transition(hop)
    if (!moved.ok) return moved
  }
  return { ok: true }
}

export function deliverEstate(opts: DeliverEstateOptions): StepResult {
  const { kit } = opts
  const component = kit.componentId
  if (component !== "searxng" && component !== "firecrawl")
    return { token: OUTCOME.FAILED, message: "estate delivery refused: delivery is a stage of the searxng/firecrawl steps only" }
  const startedAt = Date.now()
  const home = opts.home ?? homeDir() // pinned once (E7)
  const toolsRoot = collapseSlashes(`${home}/.swarm/tools`) // the consumer's own derivation (§2.0)
  const fields = baseFields(kit, component, home, toolsRoot)

  // Skipped stays skipped (§1.5): the chain admits skipped->downloaded, so the walk must not start.
  // §4.1's table pins this row's step token to SKIPPED (exit 0 family) — not FAILED.
  if (kit.stateOf().state === STATES.SKIPPED) {
    appendRefused("DELIVER_SKIPPED_COMPONENT", fields, startedAt)
    return { token: OUTCOME.SKIPPED, message: `estate delivery skipped [DELIVER_SKIPPED_COMPONENT] ${component}: component state is "skipped"; nothing rendered, nothing written` }
  }

  // --- Row 266: the initial DNS-pin produce (PC-PATH-19), BEFORE the render reads the file ------
  // Producer spec §2.2 assigns this moment: "the initial produce rides the same bring-up sequence that
  // already drives renderAll … a host-side resolve→check→write step that lands dns-pins.json
  // immediately before the render reads it". Row 263 made THIS stage that render driver, so the
  // produce belongs here and nowhere else — renderAll reads the file at composefiles/index.ts's
  // readDnsPins call, and bring-up never re-renders (stacklib.ts:497), so a later produce would be
  // invisible to the estate. An empty allow-list is NOT a delivery failure: the absent file is the one
  // legal no-pins state (§3.3 closing paragraph) and which hostnames belong on the list is an open
  // human decision (U-240b-1), so refusing every install over it would strand clean machines on a
  // question this stage does not get to ask. Every OTHER refusal is final and moves zero bytes.
  const pins = produceDnsPinsFromAnswers({
    home,
    hostnames: opts.dnsPins?.hostnames ?? [],
    answers: opts.dnsPins?.answers ?? {},
    dryRun: kit.dryRun,
    log: (level, message, context) => kit.log(level, message, context ? { context } : undefined),
  })
  if (!pins.ok && pins.code !== "PINS_ALLOW_LIST_EMPTY")
    return { token: OUTCOME.FAILED, message: `estate delivery refused [${pins.code}] ${pins.reason}` }

  // --- Phase 1: plan ---------------------------------------------------------------------------
  const rendered = renderAll(kit.lock, { home, secrets: declareRequiredSlots() })
  const renderBlock: EstateDeliveryRecord["render"] = {
    enginePath: rendered.enginePath,
    caBundlePresent: false, // pinned unset for build-time parity (spec §3.3); flipping it stays UNKNOWN-3
    lintErrorCount: rendered.findings.filter((f) => f.severity === "error").length,
  }
  if (!rendered.ok) {
    if (rendered.errors.length > 0) {
      const e = rendered.errors[0]
      return refuse("DELIVER_RENDER_REFUSED", `renderer refused [${e?.code ?? "?"}] ${e?.message ?? "no detail"}`, fields, startedAt, { render: renderBlock })
    }
    const finding = rendered.findings.find((x) => x.severity === "error")
    return refuse("DELIVER_LINT_REFUSED", `lint finding [${finding?.rule ?? "?"}] ${finding?.message ?? "no error detail"}`, fields, startedAt, { render: renderBlock })
  }
  // Discriminator pair (spec §2.5): shipped defaults render exactly ten files, split 3/7 by stack.
  // Any other count means an optional slot flipped or a required half vanished — say which, refuse.
  const scoped = rendered.files.filter((f) => f.stack === component)
  if (rendered.files.length !== 10 || scoped.length !== STACK_ORDER[component])
    return refuse(
      "DELIVER_RENDER_REFUSED",
      `artefact count drifted: render emitted ${rendered.files.length} file(s), ${scoped.length} tagged ${component}; shipped defaults require 10 (${STACK_ORDER[component]})`,
      fields,
      startedAt,
      { render: renderBlock },
    )

  const posture = planSecrets(kit, component, toolsRoot)
  if (posture.invalid.length > 0)
    return refuse("DELIVER_SECRET_INVALID", posture.reasons.join("; "), fields, startedAt, { render: renderBlock, secrets: posture.invalid })
  const placeholderProblems = validateRenderedSecrets(
    Object.fromEntries(posture.plans.filter((p) => p.value !== undefined).map((p) => [p.slot, p.value as string])),
  )
  if (placeholderProblems.length > 0)
    return refuse("DELIVER_SECRET_INVALID", placeholderProblems.join("; "), fields, startedAt, { render: renderBlock })

  const artefactPlan = planArtefacts(scoped, toolsRoot)
  if (artefactPlan.blocked.length > 0)
    return refuse("DELIVER_TARGET_UNWRITABLE", artefactPlan.blocked.join("; "), fields, startedAt, { render: renderBlock, secrets: secretRowsFrom(posture.plans) })
  const artefacts = artefactPlan.plans
  const createdSecrets = posture.plans.filter((p) => p.action === "created")
  const targets = [...artefacts.map((a) => a.row.absPath), ...createdSecrets.map((p) => p.absPath)]
  const blocked =
    existsSync(toolsRoot) && !lstatSync(toolsRoot).isDirectory()
      ? `${toolsRoot}: tools root exists and is not a directory`
      : uncreatableTarget(targets)
  if (blocked)
    return refuse("DELIVER_TARGET_UNWRITABLE", blocked, fields, startedAt, { render: renderBlock, secrets: secretRowsFrom(posture.plans) })

  // downloaded/verified describe the in-memory render (spec §1.5 mapping) — walked BEFORE the intent
  // row so the attempt record already carries the honest lifecycle position.
  const preWalk = walkTo(kit, STATES.VERIFIED)
  if (!preWalk.ok)
    return { token: OUTCOME.FAILED, message: `estate delivery refused: the state engine declined the pre-commit walk — ${preWalk.error}` }

  const plannedRows = artefacts.map((a) => a.row)
  const residue = listResidue(toolsRoot, rendered.files)
  const intent: EstateDeliveryRecord = {
    ts: new Date().toISOString(),
    ...fields,
    action: "attempt",
    render: renderBlock,
    artefacts: plannedRows,
    secrets: secretRowsFrom(posture.plans),
    residue,
    elapsedMs: Date.now() - startedAt,
  }
  const appended = appendEstateDelivery(intent)
  if (!appended.ok)
    return refuse("DELIVER_LEDGER_UNWRITABLE", `${appended.detail} — refusing rather than writing unrecorded`, fields, startedAt, {
      render: renderBlock,
      secrets: secretRowsFrom(posture.plans),
      residue,
    })

  // --- Phase 2: commit -------------------------------------------------------------------------
  const tmpSnap = snapshotTmpDirs(targets)
  const wroteArtefacts = artefacts.filter((a) => a.row.action === "written")
  const rollbackEntries = () => [
    ...wroteArtefacts.map((a) => ({ absPath: a.row.absPath, prior: a.prior })),
    ...createdSecrets.map((p) => ({ absPath: p.absPath })),
  ]
  try {
    for (const a of wroteArtefacts) {
      atomicWriteText(a.row.absPath, a.file.content, a.row.mode)
      opts.disturbWrite?.(a.row.absPath) // TEST SEAM ONLY — can only fail the pass earlier/louder
    }
    for (const s of createdSecrets) {
      ensureDir(dirname(s.absPath), MODES.DIR_0700) // the secrets dir is this stage's only extra dir duty (§2.3)
      atomicWriteText(s.absPath, `${s.value}\n`, s.mode)
    }
  } catch (err) {
    const rolledBack = rollback(rollbackEntries())
    removeOwnStrayTmp(tmpSnap)
    appendBestEffort(outcomeRecord("rolled-back", "DELIVER_WRITE_FAILED", rolledBack))
    return { token: OUTCOME.FAILED, message: `estate delivery refused [DELIVER_WRITE_FAILED] ${(err as Error).message}; rolled back ${rolledBack.length} path(s)` }
  }

  // --- Phase 3: verify every in-scope target against the plan ------------------------------------
  const mismatches: string[] = []
  for (const a of artefacts) {
    if (!existsSync(a.row.absPath)) mismatches.push(`${a.row.absPath}: missing after commit`)
    else if (fileMode(a.row.absPath) !== a.row.mode) mismatches.push(`${a.row.absPath}: mode ${fileMode(a.row.absPath).toString(8)} != ${a.row.mode.toString(8)}`)
    else if (sha256(readFileSync(a.row.absPath, "utf8")) !== a.row.sha256) mismatches.push(`${a.row.absPath}: sha256 differs from plan`)
  }
  for (const s of posture.plans) {
    if (!existsSync(s.absPath)) mismatches.push(`${s.absPath}: missing after commit`)
    else if ((fileMode(s.absPath) & 0o077) !== 0) mismatches.push(`${s.absPath}: group/other bits set`)
    else if (s.value !== undefined && readFileSync(s.absPath, "utf8").trim() !== s.value) mismatches.push(`${s.absPath}: content differs from the generated value`)
  }
  if (mismatches.length > 0) {
    const rolledBack = rollback(rollbackEntries())
    removeOwnStrayTmp(tmpSnap)
    appendBestEffort(outcomeRecord("rolled-back", "DELIVER_VERIFY_MISMATCH", rolledBack))
    return {
      token: OUTCOME.FAILED,
      message: `estate delivery refused [DELIVER_VERIFY_MISMATCH] ${mismatches[0]}${mismatches.length > 1 ? ` (+${mismatches.length - 1} more)` : ""}; rolled back ${rolledBack.length} path(s)`,
    }
  }

  const toInstalled = walkTo(kit, STATES.INSTALLED)
  if (!toInstalled.ok)
    return { token: OUTCOME.FAILED, message: `estate delivery: bytes committed but the state engine declined installed — ${toInstalled.error}` }
  const pathsPatch = kit.transition(STATES.CONFIGURED, { paths: targets.slice().sort(), version: kit.lock.version })
  if (!pathsPatch.ok)
    return { token: OUTCOME.FAILED, message: `estate delivery: bytes committed but the state engine declined configured — ${pathsPatch.error}` }

  const wroteAny = wroteArtefacts.length > 0 || createdSecrets.length > 0
  appendBestEffort(outcomeRecord(wroteAny ? "delivered" : "unchanged"))
  const w = wroteArtefacts.length
  const u = artefacts.length - w
  const c = createdSecrets.length
  const kept = posture.plans.length - c
  return { token: OUTCOME.OK, message: `estate delivery ${component}: ${w} artefact(s) written, ${u} unchanged; secrets ${c} created, ${kept} kept; configured` }

  function outcomeRecord(action: EstateDeliveryRecord["action"], code?: DeliverCode, rolledBack?: string[]): EstateDeliveryRecord {
    const restored = new Set(rolledBack ?? [])
    return {
      ts: new Date().toISOString(),
      ...fields,
      action,
      ...(code ? { code } : {}),
      render: renderBlock,
      artefacts: plannedRows.map((r) => (restored.has(r.absPath) && artefacts.find((a) => a.row.absPath === r.absPath)?.prior ? { ...r, action: "restored" as const } : r)),
      secrets: secretRowsFrom(posture.plans),
      residue,
      elapsedMs: Date.now() - startedAt,
      ...(rolledBack ? { rolledBack } : {}),
    }
  }
}

function secretRowsFrom(plans: readonly SecretPlan[]): EstateSecretRow[] {
  return plans.map(({ component, slot, action, mode }) => ({ component, slot, action, mode }))
}

/** D-262-2: declare EVERY required slot of BOTH stacks — contextErrors demands them for the render
 *  to exist at all (shared.ts:153-177) — while writes stay scoped by stack tag. Values are never
 *  passed: the renderer never sees a secret (committed composefiles/index.ts:24-26; the standalone
 *  CLI declares the same posture with zero secret files on disk, :272-277). */
function declareRequiredSlots(): Record<"searxng" | "firecrawl", Record<string, "generated">> {
  const secrets: Record<"searxng" | "firecrawl", Record<string, "generated">> = { searxng: {}, firecrawl: {} }
  for (const comp of ["searxng", "firecrawl"] as const)
    for (const spec of SECRET_INVENTORY[comp]) if (spec.required) secrets[comp][spec.name] = "generated"
  return secrets
}

/** ------------------------------------------------------------------------------------------
 * FENCE for the live-smoke harness (R-262/E, ratified decisions/decisions.md:445-450).
 *
 * test/live_smoke.ts renders into the REAL home with an unprefixed HOME — the condition that made
 * the delivery gap invisible for five sessions (verification/s6_r240d_compose_delivery.md:348-350).
 * Fencing here means RECORDED, not disabled: the harness deposits exactly the same bytes at exactly
 * the same paths (rows 254/255 still need them where colima's virtiofs mounts the real home), but
 * every deposit now moves through this function, which appends attempt/delivered rows per stack
 * with program.compiled read from isCompiledBinary() — false under the harness recipe (repo source
 * + local bun + R93_LIVE=1), so a compiled:true ledger row can only ever come from the product
 * (spec §5.3 discriminator D-B). Intent rows precede the writes (D-C), hashes bind the bytes (D-A).
 * ------------------------------------------------------------------------------------------ */
export function fenceApplyRendered(opts: {
  readonly lock: LockFile
  readonly home: string
  readonly rendered: FullRender
  readonly root: string
  readonly entryTokens: readonly string[]
  readonly secretRows?: readonly EstateSecretRow[]
}): { applied: string[] } {
  const { lock, home, rendered, root, entryTokens } = opts
  const fieldsFor = (stack: StackComponent) => ({
    lockVersion: lock.version,
    program: programStamp(entryTokens),
    stack,
    home,
    toolsRoot: root,
    correlationId: `run-${process.pid}`,
  })
  const renderBlock: EstateDeliveryRecord["render"] = {
    enginePath: rendered.enginePath,
    caBundlePresent: false,
    lintErrorCount: rendered.findings.filter((f) => f.severity === "error").length,
  }
  const rowsFor = (stack: StackComponent, actions: Map<string, EstateArtefactRow["action"]>): EstateArtefactRow[] =>
    rendered.files
      .filter((f) => f.stack === stack)
      .map((f) => {
        const absPath = join(root, f.relPath)
        return { relPath: f.relPath, absPath, mode: f.mode, sha256: sha256(f.content), bytes: utf8Bytes(f.content), action: actions.get(absPath) ?? "written" }
      })
  const stacks: StackComponent[] = ["searxng", "firecrawl"]
  const unchangedBefore = new Map<string, boolean>()
  for (const f of rendered.files) {
    const abs = join(root, f.relPath)
    unchangedBefore.set(abs, existsSync(abs) && readFileSync(abs, "utf8") === f.content && fileMode(abs) === f.mode)
  }
  const planned = new Map<string, EstateArtefactRow["action"]>()
  const delivered = new Map<string, EstateArtefactRow["action"]>()
  for (const f of rendered.files) {
    const abs = join(root, f.relPath)
    planned.set(abs, "written") // the attempt row states intent; the outcome row corrects to unchanged where true
    delivered.set(abs, unchangedBefore.get(abs) ? "unchanged" : "written")
  }
  for (const stack of stacks) {
    appendBestEffort({
      ts: new Date().toISOString(),
      ...fieldsFor(stack),
      action: "attempt",
      render: renderBlock,
      artefacts: rowsFor(stack, planned),
      secrets: (opts.secretRows ?? []).filter((r) => r.component === stack),
      residue: [],
      elapsedMs: 0,
    })
  }
  const applied = applyRenderedFiles(rendered, root)
  for (const stack of stacks) {
    const rows = rowsFor(stack, delivered)
    appendBestEffort({
      ts: new Date().toISOString(),
      ...fieldsFor(stack),
      action: rows.some((r) => r.action === "written") ? "delivered" : "unchanged",
      render: renderBlock,
      artefacts: rows,
      secrets: (opts.secretRows ?? []).filter((r) => r.component === stack),
      residue: [],
      elapsedMs: 0,
    })
  }
  return { applied }
}
