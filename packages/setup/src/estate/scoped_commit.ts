// Scoped estate commit primitive (row 269) — the ONE home of the plan/commit/verify/rollback rules
// that row 252 found written twice, once per estate verb.
//
// WHY THIS FILE EXISTS. `deliverEstate` cannot re-run over a component recorded `healthy`: the
// stepkit forward table lists `healthy: ["failed"]` (src/stepkit.ts:105) and `legal()` adds only the
// self-transition and any-state->`absent` (src/stepkit.ts:110-115), so delivery's closing CONFIGURED
// move is refused on a live component — F-246-3 (`implementation/s6b_d5_apply.md` §6). Row 246's
// answer was to re-implement the commit loop in `estate/apply.ts` rather than edit a finished row's
// file. Row 252 Q1 measured the result: six parallel pairs, three of them byte-identical
// (`verification/s6b_14_addendum_codereview.md` Q1 / §Q6.1). Two copies of one rule is this session's
// named drift class.
//
// THE RULING THIS FILE ENACTS, and what it deliberately is not. Widening `healthy -> configured` was
// proposed and rejected: it would drag deliver's state walk and its secret generation into a verb
// that wants neither, and would let a byte-for-byte identical re-run CLAIM it advanced a component
// through `configured` — the truthfulness property D-262-3 guards (decisions/decisions.md:451-453).
// So the transition table is untouched and this primitive is STATE-FREE: no StepKit, no ledger, no
// lifecycle token, no secret generation, nothing written but the bytes it is handed. `deliverEstate`
// keeps its state walk, its intent/outcome ledger rows and its residue report ON TOP of it;
// `applyEstate` keeps committing no lifecycle state at all, exactly as before the extraction.
//
// THE RULES THAT NOW HAVE ONE HOME (row 252 Q1's table, pair by pair):
//   content-addressed no-write ......... isUnchanged(), used by planScopedCommit AND artefactMatchesDisk
//   capture prior bytes + mode ......... readPrior(), called from both schedules
//   atomic per-file commit ............. writeUnit() -> atomicWriteText(), same call order
//   read-back verify ................... verifyUnits() (artefacts by sha+mode, secrets by their own posture)
//   rollback from captured priors ...... rollbackScopedUnits() (own files only, rule E13)
//   sha256 / fileMode / declareRequiredSlots ... exported here; both callers import them
//
// WHAT STAYS DIFFERENT, ON PURPOSE — the `schedule` axis. deliver plans the whole scoped set BEFORE
// its first write (§4.2 refuse-before-bytes), so an unreadable target refuses with zero bytes moved
// and its rollback covers every PLANNED write. apply discovers an unreadable target when the pass
// reaches that file, so its rollback covers only what it actually DID. Those are the two verbs'
// shipped postures; collapsing them would move mtimes and change the reported rolled-back count in
// the mixed-fault case, which is a change of behaviour, not a dedup. Both arms are pinned by tests
// (test/estate_delivery.test.ts, test/estate_apply.test.ts), and one mutation to this file is enough
// to redden both suites — that is the proof the duplication is gone.

import { existsSync, readFileSync, rmSync, statSync } from "node:fs"
import { createHash } from "node:crypto"
import { atomicWriteText } from "../atomic.ts"
import { SECRET_INVENTORY } from "../composefiles/shared.ts"

/** ---------------------------------------------------------------------------------------------
 * The three helpers row 252 §Q6.1 found byte-identical across the two verbs. They have one home here
 * now; a fourth copy of `fileMode` still sits in src/stacklib.ts:450, outside this row's area (declared
 * in implementation/s6_r269_estate_dedup.md rather than silently widened).
 * --------------------------------------------------------------------------------------------- */

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex")
}

export function fileMode(path: string): number {
  return statSync(path).mode & 0o777
}

/** UTF-8 byte count through the declared Buffer shim only (from(string,"utf8") -> hex length). */
export function utf8Bytes(text: string): number {
  return Buffer.from(text, "utf8").toString("hex").length / 2
}

/** D-262-2: declare EVERY required slot of BOTH stacks — contextErrors demands them for the render
 *  to exist at all (src/composefiles/shared.ts) — while writes stay scoped by stack tag. Values are
 *  never passed: the renderer never sees a secret. Both callers render with this exact posture. */
export function declareRequiredSlots(): Record<"searxng" | "firecrawl", Record<string, "generated">> {
  const secrets: Record<"searxng" | "firecrawl", Record<string, "generated">> = { searxng: {}, firecrawl: {} }
  for (const comp of ["searxng", "firecrawl"] as const)
    for (const spec of SECRET_INVENTORY[comp]) if (spec.required) secrets[comp][spec.name] = "generated"
  return secrets
}

/** ---------------------------------------------------------------------------------------------
 * Units — what a caller hands this module. Nothing here knows about stacks, ledgers or lifecycle
 * states; a unit is a path, the bytes it must end with, and how to check it afterwards.
 * --------------------------------------------------------------------------------------------- */

/** `artefact`: content-addressed, verified by exact mode + sha256.
 *  `secret-created`: absent by the caller's own posture, ALWAYS written, verified by "no group/other
 *  bits" plus the generated value (deliver writes `<value>\n`, so the compare trims both sides).
 *  `secret-present`: never written (R-262-2 forbids rotating a live secret), verified only by
 *  "no group/other bits" — its stored value is unknown to the caller by design. */
export type ScopedCommitKind = "artefact" | "secret-created" | "secret-present"

export interface ScopedCommitUnit {
  readonly relPath: string
  readonly absPath: string
  readonly mode: number
  readonly content: string
  readonly kind: ScopedCommitKind
  /** Runs immediately BEFORE this unit's write. Deliver uses it for the secrets dir (spec §2.3), its
   *  only extra directory duty; a throw here is a write failure like any other. */
  readonly prepare?: () => void
  /** TEST SEAM ONLY (deliver's `disturbWrite`, carried unchanged): runs immediately AFTER this unit's
   *  atomic commit so a unit can script a mid-pass throw or corrupt the committed bytes. It can only
   *  make the pass fail EARLIER or LOUDER — never bypass a gate, widen a scope, or hide a mismatch.
   *  Shipped code passes nothing. */
  readonly afterWrite?: (absPath: string) => void
}

export interface PriorBytes {
  readonly bytes: string
  readonly mode: number
}

export interface PlannedUnit {
  readonly relPath: string
  readonly absPath: string
  readonly mode: number
  readonly kind: ScopedCommitKind
  readonly sha256: string
  readonly bytes: number
  readonly action: "written" | "unchanged"
  readonly prior?: PriorBytes
}

export interface ScopedPlan {
  readonly planned: readonly PlannedUnit[]
  /** One line per EXISTING artefact target whose bytes cannot be read (EISDIR/EACCES), path first —
   *  the shape both callers already print. Only `artefact` units can block: a created secret is
   *  absent by construction and a present secret is never read here. */
  readonly blocked: readonly string[]
}

export interface CommitEntry {
  readonly absPath: string
  readonly prior?: PriorBytes
}

export type ScopedFault = "target-unreadable" | "write-threw" | "verify-mismatch"

export type ScopedCommitSchedule = "plan-ahead" | "sequential"

/** Which posture the caller ships — the one axis along which the two verbs are allowed to differ.
 *  `plan-ahead` (deliver) must hand over the plan it already refused on, so the commit cannot be
 *  driven without one; `sequential` (apply) reads the disk per file and therefore needs no plan.
 *  Requiring the plan where it applies is deliberate: a caller that forgot to plan would otherwise
 *  silently write nothing and report it as unchanged. */
export type ScopedCommitOptions = { readonly schedule: "plan-ahead"; readonly plan: ScopedPlan } | { readonly schedule: "sequential" }

export type ScopedCommitResult =
  | {
      readonly ok: true
      readonly written: readonly string[]
      readonly unchanged: readonly string[]
      readonly entries: readonly CommitEntry[]
    }
  | {
      readonly ok: false
      readonly fault: ScopedFault
      /** The fault line in the caller's voice: path-prefixed for a write fault, every mismatch joined
       *  for a verify fault — the strings apply's report carries today, unchanged. */
      readonly reason: string
      /** Every individual line behind the fault (one for a write fault, N for a verify fault). */
      readonly reasons: readonly string[]
      /** Raw thrown-message text for a `write-threw` fault — the string deliver's message carries
       *  today, which names no path; empty for the other faults. */
      readonly detail: string
      readonly entries: readonly CommitEntry[]
      readonly written: readonly string[]
      readonly unchanged: readonly string[]
    }

/** ---------------------------------------------------------------------------------------------
 * Plan (zero writes) and the shared rules.
 * --------------------------------------------------------------------------------------------- */

/** Content-addressed no-write test (R-262-1): identical bytes AND identical mode freeze the file, so
 *  its mtime freezes too. This is the ONE statement of that rule — the plan uses it to decide an
 *  artefact's action and the sequential schedule uses it per file, so a widening of "already delivered"
 *  cannot land on one caller and miss the other. A missing or unreadable target is NOT a match: the
 *  caller's own path then names why. Deliver compared decoded bytes and apply compared their sha256;
 *  both readings of the same decoded UTF-8 string agree on every input (hashing adds no discriminating
 *  power), so the cheaper exact compare serves both. */
function isUnchanged(unit: Pick<ScopedCommitUnit, "mode" | "content">, prior: PriorBytes | undefined): boolean {
  return prior !== undefined && prior.bytes === unit.content && prior.mode === unit.mode
}

/** The same rule, read straight off the disk: used by apply's sequential schedule and by its dry-run
 *  plan. Returns false for a missing target and for one whose bytes cannot be read. */
export function artefactMatchesDisk(unit: Pick<ScopedCommitUnit, "absPath" | "mode" | "content">): boolean {
  const prior = readPrior(unit.absPath)
  return prior.ok ? isUnchanged(unit, prior.prior) : false
}

function readPrior(absPath: string): { ok: true; prior?: PriorBytes } | { ok: false; error: string } {
  if (!existsSync(absPath)) return { ok: true }
  try {
    return { ok: true, prior: { bytes: readFileSync(absPath, "utf8"), mode: fileMode(absPath) } }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

/** Zero writes. Computes the content hash/size every ledger row quotes, captures the bytes a
 *  rollback must put back, and names any existing target that cannot be read. An unreadable target is
 *  COLLECTED, not thrown: an existing target occupied by a directory (EISDIR) is detectable in advance,
 *  so it is refused before any byte moves rather than crashing the pass mid-plan. */
export function planScopedCommit(units: readonly ScopedCommitUnit[]): ScopedPlan {
  const planned: PlannedUnit[] = []
  const blocked: string[] = []
  for (const unit of units) {
    const base = { relPath: unit.relPath, absPath: unit.absPath, mode: unit.mode, kind: unit.kind, sha256: sha256(unit.content), bytes: utf8Bytes(unit.content) }
    if (unit.kind === "secret-present") {
      planned.push({ ...base, action: "unchanged" })
      continue
    }
    if (unit.kind === "secret-created") {
      planned.push({ ...base, action: "written" })
      continue
    }
    if (!existsSync(unit.absPath)) {
      planned.push({ ...base, action: "written" })
      continue
    }
    const prior = readPrior(unit.absPath)
    if (!prior.ok) {
      blocked.push(`${unit.absPath}: existing target unreadable (${prior.error})`)
      continue
    }
    const unchanged = isUnchanged(unit, prior.prior)
    planned.push({ ...base, action: unchanged ? "unchanged" : "written", ...(prior.prior ? { prior: prior.prior } : {}) })
  }
  return { planned, blocked }
}

function writeUnit(unit: ScopedCommitUnit): { ok: true } | { ok: false; error: string } {
  try {
    unit.prepare?.()
    atomicWriteText(unit.absPath, unit.content, unit.mode)
    unit.afterWrite?.(unit.absPath)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

/** Read-back verification of every unit, written or not: exists, then the mode rule, then the content
 *  rule for its kind. Mismatch strings are the ones both callers already report, character for
 *  character, because they are what an operator greps for. */
function verifyUnits(units: readonly ScopedCommitUnit[]): string[] {
  const mismatches: string[] = []
  for (const unit of units) {
    if (!existsSync(unit.absPath)) {
      mismatches.push(`${unit.absPath}: missing after commit`)
      continue
    }
    const mode = fileMode(unit.absPath)
    if (unit.kind === "artefact") {
      if (mode !== unit.mode) mismatches.push(`${unit.absPath}: mode ${mode.toString(8)} != ${unit.mode.toString(8)}`)
      else if (sha256(readFileSync(unit.absPath, "utf8")) !== sha256(unit.content)) mismatches.push(`${unit.absPath}: sha256 differs from plan`)
      continue
    }
    if ((mode & 0o077) !== 0) {
      mismatches.push(`${unit.absPath}: group/other bits set`)
      continue
    }
    if (unit.kind === "secret-created" && readFileSync(unit.absPath, "utf8").trim() !== unit.content.trim())
      mismatches.push(`${unit.absPath}: content differs from the generated value`)
  }
  return mismatches
}

/** ---------------------------------------------------------------------------------------------
 * Commit + verify. The two schedules differ ONLY in when an unreadable target is discovered and how
 * wide the rollback therefore reaches; every rule inside them is the same function.
 * --------------------------------------------------------------------------------------------- */

export function commitScopedUnits(units: readonly ScopedCommitUnit[], opts: ScopedCommitOptions): ScopedCommitResult {
  const pass = opts.schedule === "plan-ahead" ? commitFromPlan(units, opts.plan) : commitAsYouGo(units)
  if (!pass.ok) return pass
  const mismatches = verifyUnits(units)
  if (mismatches.length > 0)
    return { ok: false, fault: "verify-mismatch", reason: mismatches.join("; "), reasons: mismatches, detail: "", entries: pass.entries, written: pass.written, unchanged: pass.unchanged }
  return { ok: true, written: pass.written, unchanged: pass.unchanged, entries: pass.entries }
}

/** deliver's posture: the plan already decided every action, so nothing is re-read from disk and the
 *  rollback list covers EVERY planned write — including a file the pass never reached, whose prior is
 *  still the truth of what was there before this run. */
function commitFromPlan(units: readonly ScopedCommitUnit[], plan: ScopedPlan): ScopedCommitResult {
  const byPath = new Map(plan.planned.map((p) => [p.absPath, p]))
  const written: string[] = []
  const unchanged: string[] = []
  const entries: CommitEntry[] = plan.planned
    .filter((p) => p.action === "written")
    .map((p) => ({ absPath: p.absPath, ...(p.kind === "artefact" && p.prior ? { prior: p.prior } : {}) }))
  for (const unit of units) {
    if (unit.kind === "secret-present") continue
    if (byPath.get(unit.absPath)?.action !== "written") {
      unchanged.push(unit.relPath)
      continue
    }
    const wrote = writeUnit(unit)
    if (!wrote.ok)
      return { ok: false, fault: "write-threw", reason: `${unit.absPath}: ${wrote.error}`, reasons: [`${unit.absPath}: ${wrote.error}`], detail: wrote.error, entries, written, unchanged }
    written.push(unit.relPath)
  }
  return { ok: true, written, unchanged, entries }
}

/** apply's posture as shipped by row 246: decide, capture and write one file at a time, so a target
 *  that turns out to be unreadable stops the pass where it stands and only the writes actually made
 *  are undone. */
function commitAsYouGo(units: readonly ScopedCommitUnit[]): ScopedCommitResult {
  const written: string[] = []
  const unchanged: string[] = []
  const entries: CommitEntry[] = []
  for (const unit of units) {
    if (unit.kind === "secret-present") continue
    if (unit.kind === "artefact") {
      if (artefactMatchesDisk(unit)) {
        unchanged.push(unit.relPath)
        continue
      }
      const prior = readPrior(unit.absPath)
      if (!prior.ok) {
        const line = `${unit.absPath}: existing target unreadable (${prior.error})`
        return { ok: false, fault: "target-unreadable", reason: line, reasons: [line], detail: prior.error, entries, written, unchanged }
      }
      entries.push({ absPath: unit.absPath, ...(prior.prior ? { prior: prior.prior } : {}) })
    } else {
      // A created secret has no prior to restore — deliver's posture, kept for both schedules.
      entries.push({ absPath: unit.absPath })
    }
    const wrote = writeUnit(unit)
    if (!wrote.ok)
      return { ok: false, fault: "write-threw", reason: `${unit.absPath}: ${wrote.error}`, reasons: [`${unit.absPath}: ${wrote.error}`], detail: wrote.error, entries, written, unchanged }
    written.push(unit.relPath)
  }
  return { ok: true, written, unchanged, entries }
}

/** Restore captured priors and undo creations made by this pass. Returns the paths actually undone —
 *  deliver needs the list for its ledger row, apply needs its length. A path whose restore threw stays
 *  OUT of the list, so the short list plus the caller's ledger code names the incident. Only paths this
 *  pass touched are ever removed: a foreign `.tmp-*` sibling is nobody else's cleanup (rule E13). */
export function rollbackScopedUnits(entries: readonly CommitEntry[]): string[] {
  const rolledBack: string[] = []
  for (const entry of entries) {
    try {
      if (entry.prior) atomicWriteText(entry.absPath, entry.prior.bytes, entry.prior.mode)
      else if (existsSync(entry.absPath)) rmSync(entry.absPath)
      rolledBack.push(entry.absPath)
    } catch {
      /* best-effort: the caller reports the refusal either way and names the rollback count */
    }
  }
  return rolledBack
}
