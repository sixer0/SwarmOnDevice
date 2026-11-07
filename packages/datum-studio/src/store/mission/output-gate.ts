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
 */
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
}

export interface OutputGateDeliverable {
  documentId: string
  docKey: string
  revisionNo: number
  final: false
  outputs: OutputGateOutput[]
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
    for (const o of state.outputs) if (o.reason) outputs.push({ outputId: o.outputId, format: o.format, state: "unverified", reason: o.reason })
    notFinal.push({ documentId: d.id, docKey: d.mission_doc_key, revisionNo: Number(d.revision_no), final: false, outputs })
  }
  return { total: notFinal.length, deliverables: notFinal.slice(0, OUTPUT_GATE_LIST_MAX) }
}
