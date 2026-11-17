/**
 * Row 155: the mission rule of masterplan/01_specs_output_verification.md §7 (decisions C129, C130, C140).
 *
 * A mission row may go `done` only when every deliverable bound to it is Final (§7.2). Reads only, synchronous over
 * the reader it is given (the write job's tx in `MissionStore.transitionRow`), so the check and the status write see
 * the same committed state inside one BEGIN IMMEDIATE.
 *
 * - Deliverable of mission M (§7.1): document with `mission_folder = M`, `archived = 0`, contract kind not the work
 *   report (D-9).
 * - Bound to row R: `mission_doc_key` matches `row-<R>-<name>` (regex below, capture = R). Any other docKey is
 *   mission-level and not row-gated (L-4). A row without bound deliverables is not blocked (C129).
 * - Output set: output_file kind 'document', scope DOCUMENT, draft 0, the current revision; newest per
 *   (role, format, figure_label) by time_created DESC, rowid DESC.
 * - Verified output: a record exists, its sha equals the output's sha, state 'verified' (UNKNOWN never passes).
 * - Final: >= 1 PRIMARY output, every output verified, a verified PRIMARY PDF or HTML (layout witness).
 *
 * Row 136b (C151, review M4/M5): `revisionOutputState` below is the ONE implementation of the output set, the
 * per-output state and Final. `rowDeliverablesNotFinal` (this gate), `SqliteStudioStore.revisionVerification` (row
 * 149's async API, a thin wrapper) and mission control's G1 read (mcp-host/mission/deliverables.ts) all call it, so
 * the gate's refusal, the store API and the panel the owner sees cannot disagree.
 *
 * 1.3.3 row 66 (MC-5, U20): the row `done` gate now runs `rowCloseGate` (end of this file), which builds on
 * `revisionOutputState` but does not refuse for a missing layout witness or for a label check only a person can make.
 * "Final" (strict: `revisionOutputState`, the store API, the panel) and "may close" therefore differ in exactly those
 * two cases; a row that closed in one of them says so in its reply and, for the label check, in `awaitingHumanCheck`.
 */
import { lstatSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { OutputUnverifiedReason, RevisionNotFinalReason, RevisionOutputVerification } from "../types.ts"
import type { MissionReader } from "./mission-store.ts"

export const ROW_DELIVERABLE_KEY = /^row-([1-9][0-9]{0,3}[a-z]?)-[a-z0-9]+(-[a-z0-9]+)*$/
/** Refusal lists at most this many deliverables (spec §7.3). */
export const OUTPUT_GATE_LIST_MAX = 20

export type OutputGateReason = "NOT_CHECKED" | "CHECK_FAILED" | "CHECK_UNKNOWN" | "STALE" | "NOT_RENDERED" | "NO_LAYOUT_WITNESS"

export interface OutputGateOutput {
  outputId: string | null
  format: string | null
  state: "unverified"
  reason: OutputGateReason
  /**
   * Row 206 (1.2.3): for CHECK_FAILED / CHECK_UNKNOWN, the FAIL and UNKNOWN checks of the stored verification report
   * (output_verification.report), findings capped at OUTPUT_GATE_FINDINGS_MAX each. The mission refusal turns them
   * into client entries (mcp-host/verify/client-findings.ts). Findings are document-derived: untrusted.
   */
  checks?: OutputGateCheck[]
  /** 1.3.3 row 66: the record says verified but the stored file is not on disk (reason NOT_RENDERED). */
  fileMissing?: true
}

/** A not-passing check of a stored report, as stored (VerifyCheck subset; the store does not import the host types). */
export interface OutputGateCheck {
  id: string
  status: "FAIL" | "UNKNOWN"
  reason: string | null
  findings: Array<{ code: string; page: number | null; address: string | null; label: string | null; detail: string; amount?: number }>
  truncated: number
  /** 1.2.6 INT-1: OVERLAP_CLIP page coverage of the stored check (N-032), kept only when well-formed. */
  coverage?: { measuredPages: number; totalPages: number }
}

/** Findings kept per check in a refusal (the rest is counted in `truncated`). */
export const OUTPUT_GATE_FINDINGS_MAX = 8

/** 1.2.6 INT-1: a stored OVERLAP_CLIP coverage {measuredPages, totalPages} (integers, 0 <= m <= n), else nothing. */
function coverageOf(v: unknown): { coverage?: { measuredPages: number; totalPages: number } } {
  if (!v || typeof v !== "object") return {}
  const { measuredPages: m, totalPages: n } = v as Record<string, unknown>
  const ok = (x: unknown): x is number => typeof x === "number" && Number.isInteger(x) && x >= 0
  return ok(m) && ok(n) && m <= n ? { coverage: { measuredPages: m, totalPages: n } } : {}
}

/** The FAIL / UNKNOWN checks of a stored report (JSON text); [] when the report cannot be read. */
export function notPassingChecks(report: unknown): OutputGateCheck[] {
  let r: unknown = report
  if (typeof r === "string") {
    try {
      r = JSON.parse(r)
    } catch {
      return []
    }
  }
  const checks = r && typeof r === "object" ? (r as { checks?: unknown }).checks : null
  if (!Array.isArray(checks)) return []
  const out: OutputGateCheck[] = []
  for (const c of checks) {
    if (!c || typeof c !== "object") continue
    const k = c as Record<string, unknown>
    if ((k.status !== "FAIL" && k.status !== "UNKNOWN") || typeof k.id !== "string") continue
    const all = Array.isArray(k.findings) ? (k.findings as OutputGateCheck["findings"]).filter((f) => f && typeof f === "object" && typeof f.code === "string") : []
    out.push({
      id: k.id,
      status: k.status,
      reason: typeof k.reason === "string" ? k.reason : null,
      findings: all.slice(0, OUTPUT_GATE_FINDINGS_MAX),
      truncated: Math.max(0, all.length - OUTPUT_GATE_FINDINGS_MAX) + (typeof k.truncated === "number" ? k.truncated : 0),
      ...coverageOf(k.coverage),
    })
  }
  return out
}

export interface OutputGateDeliverable {
  documentId: string
  docKey: string
  revisionNo: number
  final: false
  outputs: OutputGateOutput[]
  /**
   * 1.3.3 row 66, facts for the refusal detail (row 67, mcp-host/verify/client-findings.ts reads them from here and
   * does not echo the raw lists): the entries of the revision's lint report `notRun` that are not "does not apply"
   * (causes could-not-run, staged, human); absent when the report carries no `notRun` list.
   */
  lintNotRun?: LintNotRunEntry[]
  /** Figure pages of the newest PRIMARY HTML without a witness image (row 58 list); information, never a refusal. */
  witness?: WitnessFacts
  /** Human checks the document still waits for (`labels_verified`); information, never a refusal. */
  awaitingHumanCheck?: string[]
}

/** Fixed order of the not-Final reasons (spec §7.1, §7.3). */
export const REVISION_REASON_ORDER: readonly RevisionNotFinalReason[] = ["NOT_RENDERED", "NO_LAYOUT_WITNESS", "NOT_CHECKED", "STALE", "CHECK_FAILED", "CHECK_UNKNOWN"]

type OutRow = { id: string; format: string; role: string; figure_label: string | null; sha256: string; v_sha: string | null; v_state: string | null; v_fail: number | null; v_unknown: number | null; v_attempt: number | null }

/**
 * Spec §7.1: no record -> NOT_CHECKED; record for other bytes -> STALE; FAIL -> CHECK_FAILED; UNKNOWN -> CHECK_UNKNOWN.
 * An `unverified` record with zero FAIL and zero UNKNOWN cannot be explained by its counts; it reads CHECK_UNKNOWN,
 * never verified. Returns null only for a `verified` record of the same bytes (which the 0004 CHECK keeps at 0/0).
 */
function reasonOf(r: OutRow): OutputUnverifiedReason | null {
  if (r.v_state === null || r.v_sha === null) return "NOT_CHECKED"
  if (r.v_sha !== r.sha256) return "STALE"
  if (Number(r.v_fail) > 0) return "CHECK_FAILED"
  if (Number(r.v_unknown) > 0) return "CHECK_UNKNOWN"
  if (r.v_state !== "verified") return "CHECK_UNKNOWN"
  return null
}

/** Result of the one rule for one revision. `reasons` is empty iff `final`; `verified` = a non-empty set, all verified. */
export interface RevisionOutputState {
  final: boolean
  verified: boolean
  reasons: RevisionNotFinalReason[]
  outputs: RevisionOutputVerification[]
}

/**
 * THE rule (spec §7.1/§7.2), synchronous over any reader (a store tx or the committed reader).
 * Output set: output_file kind 'document', scope DOCUMENT, draft 0, of `revisionId`; newest per
 * (role, format, figure_label) by time_created DESC, rowid DESC. Verified output: a record exists, its sha equals the
 * output's sha, state 'verified'. Final: >= 1 PRIMARY output, every output verified, a verified PRIMARY PDF or HTML
 * (layout witness).
 */
export function revisionOutputState(q: MissionReader, documentId: string, revisionId: string): RevisionOutputState {
  const rows = q.all<OutRow>(
    `SELECT o.id, o.format, o.role, o.figure_label, o.sha256, v.output_sha256 AS v_sha, v.state AS v_state, v.fail_count AS v_fail, v.unknown_count AS v_unknown, v.attempt AS v_attempt
       FROM output_file o LEFT JOIN output_verification v ON v.output_file_id = o.id
      WHERE o.kind = 'document' AND o.scope_kind = 'DOCUMENT' AND o.draft = 0 AND o.document_id = ? AND o.revision_id = ?
      ORDER BY o.role, o.format, o.figure_label, o.time_created DESC, o.rowid DESC`,
    [documentId, revisionId],
  )
  const seen = new Set<string>()
  const outputs: RevisionOutputVerification[] = []
  for (const r of rows) {
    const key = JSON.stringify([r.role, r.format, r.figure_label])
    if (seen.has(key)) continue
    seen.add(key)
    const reason = reasonOf(r)
    outputs.push({ outputId: r.id, format: r.format, role: r.role, figureLabel: r.figure_label, sha256: r.sha256, state: reason === null ? "verified" : "unverified", reason, attempt: r.v_attempt === null ? null : Number(r.v_attempt) })
  }
  const found = new Set<RevisionNotFinalReason>()
  const primaries = outputs.filter((o) => o.role === "PRIMARY")
  if (primaries.length === 0) found.add("NOT_RENDERED")
  else if (!primaries.some((o) => (o.format === "PDF" || o.format === "HTML") && o.state === "verified")) found.add("NO_LAYOUT_WITNESS")
  for (const o of outputs) if (o.reason) found.add(o.reason)
  const reasons = REVISION_REASON_ORDER.filter((x) => found.has(x))
  return { final: reasons.length === 0, verified: outputs.length > 0 && outputs.every((o) => o.state === "verified"), reasons, outputs }
}

/**
 * Strict listing (rule of 1.2.1, kept for readers of "Final"; since 1.3.3 row 66 the done gate calls `rowCloseGate`).
 * The deliverables bound to `rowId` of `mission` that are NOT Final, each with its unverified outputs (and a
 * document-level entry, `outputId: null`, for NOT_RENDERED / NO_LAYOUT_WITNESS). Empty = the gate passes.
 * `total` counts every not-final deliverable; `deliverables` is capped at OUTPUT_GATE_LIST_MAX.
 */
export function rowDeliverablesNotFinal(q: MissionReader, mission: string, rowId: string, workReportKind: string): { total: number; deliverables: OutputGateDeliverable[] } {
  const docs = q
    .all<{ id: string; mission_doc_key: string; revision_id: string; revision_no: number }>(
      `SELECT d.id, d.mission_doc_key, r.id AS revision_id, r.revision_no
         FROM document d JOIN revision r ON r.document_id = d.id AND r.revision_no = d.current_revision_no
        WHERE d.mission_folder = ? AND d.archived = 0 AND (d.contract_kind IS NULL OR d.contract_kind <> ?)
          AND d.mission_doc_key LIKE 'row-%'
        ORDER BY d.mission_doc_key, d.id`,
      [mission, workReportKind],
    )
    .filter((d) => ROW_DELIVERABLE_KEY.exec(d.mission_doc_key)?.[1] === rowId)
  const notFinal: OutputGateDeliverable[] = []
  for (const d of docs) {
    const state = revisionOutputState(q, d.id, d.revision_id)
    if (state.final) continue
    const outputs: OutputGateOutput[] = []
    if (state.reasons.includes("NOT_RENDERED")) outputs.push({ outputId: null, format: null, state: "unverified", reason: "NOT_RENDERED" })
    else if (state.reasons.includes("NO_LAYOUT_WITNESS")) outputs.push({ outputId: null, format: null, state: "unverified", reason: "NO_LAYOUT_WITNESS" })
    for (const o of state.outputs) {
      if (!o.reason) continue
      const entry: OutputGateOutput = { outputId: o.outputId, format: o.format, state: "unverified", reason: o.reason }
      if (o.reason === "CHECK_FAILED" || o.reason === "CHECK_UNKNOWN") {
        const rec = q.get<{ report: string }>("SELECT report FROM output_verification WHERE output_file_id = ?", [o.outputId])
        entry.checks = notPassingChecks(rec?.report ?? null)
      }
      outputs.push(entry)
    }
    notFinal.push({ documentId: d.id, docKey: d.mission_doc_key, revisionNo: Number(d.revision_no), final: false, outputs })
  }
  return { total: notFinal.length, deliverables: notFinal.slice(0, OUTPUT_GATE_LIST_MAX) }
}

// ── 1.3.3 row 66 (MC-5, U20): the row-close rule ──────────────────────────────────────────────────────────────────
//
// `revisionOutputState` above stays the strict "Final" the panel and the store API show. A row may CLOSE on a
// slightly different rule, because the strict one could not be satisfied by an agent (replay R7: u1 row 4, u3 row 2):
//
//   C1  A deliverable needs at least one PRIMARY output of the document's current revision (else NOT_RENDERED).
//   C2  Every output of the set is verified: a record exists for the same sha256, with no FAIL and no UNKNOWN check,
//       and (when the store root is known) the file is on disk. Lint is one of those checks: a lint FAIL keeps
//       CHECK_FAILED; a lint rule the tier requires that could not run keeps CHECK_UNKNOWN (LINT_PARTIAL /
//       LINT_NOT_RUN, static-checks.ts `checkLint`). Rules not run for cause `tier` or `not-applicable` never reach
//       the record as UNKNOWN, so they do not block. Staged rules (no scanner exists) do not block by themselves.
//   C3  `labels_verified` not true is NOT a refusal. Since row 60 lint reports it (`P1-labels_verified: REPORT`) and
//       does not fail; a record written before that (LINT FAIL whose only findings are D09 / P1-labels_verified)
//       counts as verified here. The row then closes with `awaitingHumanCheck` (the store writes the row field).
//   C4  No layout witness is demanded: a verified file is not refused because no verified PRIMARY PDF / HTML exists,
//       nor because figure pages have no witness image. Both are reported as information.
//
// The refusal lists only what an agent can act on, plus the facts row 67's detail builder turns into rule names and
// page numbers (`lintNotRun`, `witness`, `awaitingHumanCheck`, `fileMissing`).

/** Lint check id of the pending label check (vendor services/render/figures.ts `LABELS_VERIFIED_CHECK`). */
export const ROW_LABELS_VERIFIED_CHECK = "P1-labels_verified"
/** Register section 1 `awaitingHumanCheck.checks` value (vendor `LABELS_VERIFIED_HUMAN_CHECK`). */
export const ROW_LABELS_VERIFIED_HUMAN_CHECK = "labels_verified"
/** Lint rule ids that, before row 60, FAILED for labels a person had not checked (stored LINT findings `label`). */
const LABEL_LINT_RULES: ReadonlySet<string> = new Set(["D09", ROW_LABELS_VERIFIED_CHECK])
/** Figures named in a marker reply or a close note (the rest is counted). */
export const ROW_CLOSE_FIGURES_MAX = 20
/** `notRun` entries handed to the refusal detail per deliverable. */
export const ROW_CLOSE_NOT_RUN_MAX = 60
const WITNESS_MANIFEST = "witness.json" // mcp-host/verify/verify-outputs.ts VERIFY_WITNESS_MANIFEST
const WITNESS_SCHEMA = "studio.verify.witness/v1" // VERIFY_WITNESS_SCHEMA
const WITNESS_PAGES_MAX = 400

/** One entry of `LintReport.notRun` (row 64), as stored in `revision.lint_report`. */
export interface LintNotRunEntry {
  id: string
  kind: "rule" | "module"
  reason: string
  cause: "tier" | "not-applicable" | "human" | "staged" | "could-not-run"
}

/** Witness facts of one revision's newest PRIMARY HTML render (row 58): pages of figures without an image. */
export interface WitnessFacts {
  htmlOutputId: string
  missing: number[]
  unplaced: string[]
}

/** What the gate may read beside the database. Absent root = files are not looked at (no witness, no presence check). */
export interface RowCloseFacts {
  storeRoot?: string | null
}

/** A deliverable that closes, when there is something a reader should know about it. */
export interface RowCloseNote {
  docKey: string
  documentId: string
  revisionNo: number
  /** false = no verified PRIMARY PDF or HTML exists: nobody, machine or person, has a laid-out file of this revision. */
  layoutWitness: boolean
  /** Figure pages without a witness image (cap WITNESS_PAGES_MAX). */
  witnessMissingPages?: number[]
}

export interface RowCloseGate {
  /** Deliverables that refuse the close; 0 = the row may go `done`. */
  total: number
  /** The refused deliverables (cap OUTPUT_GATE_LIST_MAX), each with its not-verified outputs and the detail facts. */
  deliverables: OutputGateDeliverable[]
  /** Human checks the row's deliverables wait for (register vocabulary); not empty = close with the marker. */
  awaitingHumanCheck: string[]
  /** Block addresses of the figures whose labels wait for a person (safe tokens, cap ROW_CLOSE_FIGURES_MAX). */
  figures: string[]
  moreFigures: number
  /** Close notes of the deliverables that pass (only those with something to say). */
  notes: RowCloseNote[]
}

const SAFE_ADDRESS = /^[A-Za-z0-9][A-Za-z0-9._\-]{0,39}$/

function parseJsonText(v: unknown): unknown {
  if (typeof v !== "string") return v ?? null
  try {
    return JSON.parse(v)
  } catch {
    return null
  }
}

/**
 * The pending human checks of a lint report's `checks` (the stored `revision.lint_report.checks`): same reading as the
 * vendored `awaitingHumanCheckOf` (row 60 contract: a row `{checkId: "P1-labels_verified", status: "REPORT"}`), plus
 * the block addresses of those rows. The store does not import the render service, so the two-line rule is repeated
 * here; test/mc5-row-close-gate pins that both read alike.
 */
export function rowAwaitingHumanCheckOf(checks: unknown): { checks: string[]; figures: string[] } {
  if (!Array.isArray(checks)) return { checks: [], figures: [] }
  const rows = checks.filter((c): c is Record<string, unknown> => c !== null && typeof c === "object" && (c as Record<string, unknown>).checkId === ROW_LABELS_VERIFIED_CHECK && (c as Record<string, unknown>).status === "REPORT")
  if (rows.length === 0) return { checks: [], figures: [] }
  return { checks: [ROW_LABELS_VERIFIED_HUMAN_CHECK], figures: rows.map((c) => c.address).filter((a): a is string => typeof a === "string" && SAFE_ADDRESS.test(a)) }
}

/** `notRun` of a parsed lint report, defensively; null when the report has no such list (written before row 64). */
function lintNotRunOf(report: unknown): LintNotRunEntry[] | null {
  const list = report && typeof report === "object" ? (report as { notRun?: unknown }).notRun : null
  if (!Array.isArray(list)) return null
  const causes = new Set(["tier", "not-applicable", "human", "staged", "could-not-run"])
  return list.flatMap((e) => {
    if (!e || typeof e !== "object") return []
    const { id, kind, reason, cause } = e as Record<string, unknown>
    if (typeof id !== "string" || (kind !== "rule" && kind !== "module") || typeof cause !== "string" || !causes.has(cause)) return []
    return [{ id: id.slice(0, 80), kind, reason: typeof reason === "string" ? reason.slice(0, 300) : "", cause: cause as LintNotRunEntry["cause"] }]
  })
}

/**
 * True when a stored verification report is held back ONLY by the label check of a person: its not-passing checks are
 * exactly LINT with status FAIL, and every finding of it is rule D09 or P1-labels_verified, with nothing cut from the
 * list. Returns the block addresses of those findings, else null. (Records written before row 60 made the rule report.)
 */
export function heldOnlyByLabelCheck(report: unknown): string[] | null {
  const r = parseJsonText(report)
  const checks = r && typeof r === "object" ? (r as { checks?: unknown }).checks : null
  if (!Array.isArray(checks)) return null
  const open = checks.filter((c): c is Record<string, unknown> => c !== null && typeof c === "object" && ((c as Record<string, unknown>).status === "FAIL" || (c as Record<string, unknown>).status === "UNKNOWN"))
  if (open.length !== 1 || open[0]!.id !== "LINT" || open[0]!.status !== "FAIL") return null
  const findings = open[0]!.findings
  if (!Array.isArray(findings) || findings.length === 0) return null
  if (typeof open[0]!.truncated === "number" && open[0]!.truncated > 0) return null
  const figures: string[] = []
  for (const f of findings) {
    if (!f || typeof f !== "object" || typeof (f as Record<string, unknown>).label !== "string" || !LABEL_LINT_RULES.has((f as { label: string }).label)) return null
    const a = (f as Record<string, unknown>).address
    if (typeof a === "string" && SAFE_ADDRESS.test(a)) figures.push(a)
  }
  return figures
}

/**
 * The witness list a render left in `<storeRoot>/verify/<htmlOutputId>/witness.json` (row 58), reduced to what the
 * gate reports: pages without an existing image, and the figures that could not be placed on a page. null = no list.
 * Same reading as the host's `readWitnessManifest` (the store does not import the host); never throws.
 */
export function readWitnessFacts(storeRoot: string, htmlOutputId: string): WitnessFacts | null {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(htmlOutputId)) return null
  const dir = join(storeRoot, "verify", htmlOutputId)
  try {
    const st = lstatSync(join(dir, WITNESS_MANIFEST), { throwIfNoEntry: false })
    if (!st || !st.isFile() || st.size > 4 * 1024 * 1024) return null
    const j = JSON.parse(readFileSync(join(dir, WITNESS_MANIFEST), "utf8")) as { $schema?: unknown; pages?: unknown; missing?: unknown; unplaced?: unknown }
    if (!j || j.$schema !== WITNESS_SCHEMA || !Array.isArray(j.pages) || !Array.isArray(j.missing)) return null
    const page = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 1
    const missing = new Set<number>(j.missing.filter(page))
    for (const p of j.pages as Array<{ page?: unknown; png?: unknown }>) {
      if (!p || !page(p.page) || typeof p.png !== "string") continue
      const name = /(?:^|[\\/])(p\d{3,6}\.png)$/.exec(p.png)?.[1]
      const f = name ? lstatSync(join(dir, name), { throwIfNoEntry: false }) : undefined
      if (!name || !f || !f.isFile()) missing.add(p.page)
    }
    return {
      htmlOutputId,
      missing: [...missing].sort((a, b) => a - b).slice(0, WITNESS_PAGES_MAX),
      unplaced: Array.isArray(j.unplaced) ? j.unplaced.filter((x): x is string => typeof x === "string").slice(0, 50).map((x) => x.slice(0, 80)) : [],
    }
  } catch {
    return null
  }
}

/** false only when the store root is known and the output's file is not a plain file under it. */
function fileOnDisk(storeRoot: string | null | undefined, relPath: unknown): boolean {
  if (!storeRoot) return true
  if (typeof relPath !== "string" || relPath === "" || relPath.startsWith("/") || relPath.includes("\\") || relPath.includes("\u0000") || relPath.split("/").includes("..")) return false
  try {
    return lstatSync(join(storeRoot, relPath), { throwIfNoEntry: false })?.isFile() === true
  } catch {
    return false
  }
}

/**
 * The row-close rule (C1-C4 above) over the deliverables bound to `rowId`. Reads only (database through `q`, files
 * under `facts.storeRoot`), synchronous, so the done block can run it inside the status write's transaction.
 */
export function rowCloseGate(q: MissionReader, mission: string, rowId: string, workReportKind: string, facts: RowCloseFacts = {}): RowCloseGate {
  const docs = q
    .all<{ id: string; mission_doc_key: string; revision_id: string; revision_no: number; lint_report: string | null }>(
      `SELECT d.id, d.mission_doc_key, r.id AS revision_id, r.revision_no, r.lint_report
         FROM document d JOIN revision r ON r.document_id = d.id AND r.revision_no = d.current_revision_no
        WHERE d.mission_folder = ? AND d.archived = 0 AND (d.contract_kind IS NULL OR d.contract_kind <> ?)
          AND d.mission_doc_key LIKE 'row-%'
        ORDER BY d.mission_doc_key, d.id`,
      [mission, workReportKind],
    )
    .filter((d) => ROW_DELIVERABLE_KEY.exec(d.mission_doc_key)?.[1] === rowId)
  const refused: OutputGateDeliverable[] = []
  const notes: RowCloseNote[] = []
  const awaiting = new Set<string>()
  const figures = new Set<string>()
  for (const d of docs) {
    const state = revisionOutputState(q, d.id, d.revision_id)
    const lint = parseJsonText(d.lint_report)
    const fromLint = rowAwaitingHumanCheckOf(lint && typeof lint === "object" ? (lint as { checks?: unknown }).checks : null)
    const waits = new Set<string>(fromLint.checks)
    const waitFigures = new Set<string>(fromLint.figures)
    const relPaths = new Map(q.all<{ id: string; rel_path: string }>("SELECT id, rel_path FROM output_file WHERE document_id = ? AND revision_id = ?", [d.id, d.revision_id]).map((r) => [r.id, r.rel_path]))
    const outputs: OutputGateOutput[] = []
    // C1
    if (!state.outputs.some((o) => o.role === "PRIMARY")) outputs.push({ outputId: null, format: null, state: "unverified", reason: "NOT_RENDERED" })
    let layoutWitness = false
    for (const o of state.outputs) {
      let reason = o.reason
      let checks: OutputGateCheck[] | undefined
      if (reason === "CHECK_FAILED" || reason === "CHECK_UNKNOWN") {
        const rec = q.get<{ report: string }>("SELECT report FROM output_verification WHERE output_file_id = ?", [o.outputId])
        // C3: a record of before row 60, held back by the label check alone, is a verified file that waits for a person.
        const held = reason === "CHECK_FAILED" ? heldOnlyByLabelCheck(rec?.report ?? null) : null
        if (held) {
          reason = null
          waits.add(ROW_LABELS_VERIFIED_HUMAN_CHECK)
          for (const f of held) waitFigures.add(f)
        } else checks = notPassingChecks(rec?.report ?? null)
      }
      if (reason === null) {
        // C2: the bytes the record speaks of must still be there.
        if (fileOnDisk(facts.storeRoot, relPaths.get(o.outputId))) {
          if (o.role === "PRIMARY" && (o.format === "PDF" || o.format === "HTML")) layoutWitness = true
          continue
        }
        outputs.push({ outputId: o.outputId, format: o.format, state: "unverified", reason: "NOT_RENDERED", fileMissing: true })
        continue
      }
      outputs.push({ outputId: o.outputId, format: o.format, state: "unverified", reason, ...(checks ? { checks } : {}) })
    }
    const html = state.outputs.find((o) => o.role === "PRIMARY" && o.format === "HTML")
    const witness = html && facts.storeRoot ? readWitnessFacts(facts.storeRoot, html.outputId) : null
    if (outputs.length > 0) {
      const notRun = lintNotRunOf(lint)?.filter((e) => e.cause !== "tier" && e.cause !== "not-applicable")
      refused.push({
        documentId: d.id,
        docKey: d.mission_doc_key,
        revisionNo: Number(d.revision_no),
        final: false,
        outputs,
        ...(notRun ? { lintNotRun: notRun.slice(0, ROW_CLOSE_NOT_RUN_MAX) } : {}),
        ...(witness && (witness.missing.length > 0 || witness.unplaced.length > 0) ? { witness } : {}),
        ...(waits.size > 0 ? { awaitingHumanCheck: [...waits] } : {}),
      })
      continue
    }
    for (const c of waits) awaiting.add(c)
    for (const f of waitFigures) figures.add(f)
    // C4: stated, never refused.
    if (!layoutWitness || (witness && witness.missing.length > 0)) {
      notes.push({ docKey: d.mission_doc_key, documentId: d.id, revisionNo: Number(d.revision_no), layoutWitness, ...(witness && witness.missing.length > 0 ? { witnessMissingPages: witness.missing } : {}) })
    }
  }
  const all = [...figures].sort((a, b) => a.localeCompare(b, "en", { numeric: true }))
  return {
    total: refused.length,
    deliverables: refused.slice(0, OUTPUT_GATE_LIST_MAX),
    awaitingHumanCheck: refused.length === 0 ? [...awaiting] : [],
    figures: refused.length === 0 ? all.slice(0, ROW_CLOSE_FIGURES_MAX) : [],
    moreFigures: refused.length === 0 ? Math.max(0, all.length - ROW_CLOSE_FIGURES_MAX) : 0,
    notes: refused.length === 0 ? notes.slice(0, OUTPUT_GATE_LIST_MAX) : [],
  }
}
