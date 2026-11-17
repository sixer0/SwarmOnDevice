/**
 * Row 126: the host read fields mission control needs (masterplan/01_specs_mission_control_ui.md §8, G1-G4).
 * Reads only, over the reader the caller passes (a StoreTx of the write queue, committed data); no write path here.
 *
 * - G1 `deliverables`: the mission's Studio documents (`document.mission_folder` = mission, not archived, not a work
 *   report) with the outputs of the current revision, each with Studio's own final file name (`finalFileNameOfRow`).
 *   Row 136b (C151, M5): the outputs, each output's `verified`, and the deliverable's `verified` / `final` come from
 *   the store's ONE rule (`revisionOutputState`, store/mission/output-gate.ts) - the same set and state the row done
 *   gate uses. The app shows these values and does not derive them.
 * - 1.3.3 row 71 (MC-8 items 4-6): a deliverable that has project copies (the row's stored `deliverables`, written by
 *   row 68 after a verified render) also carries `hasProjectCopy: true` and `projectFiles`. One item per copied file,
 *   older revisions stay listed. `present` is an existence check (regular file) made on every read; the sha256 is NOT
 *   re-hashed on read (slow; the stored `sha256` is the one recorded at the copy, the done gate re-hashes). A deliverable
 *   without a copy has `hasProjectCopy: false` and no `projectFiles` key.
 *   1.3.3 row 147 (S9): presence and `absolutePath` follow the store's ONE containment rule (deliverable-path.ts):
 *   a path outside `deliverables/<mission>/`, or a symbolic link at any segment below the project folder, has no
 *   `absolutePath` and is never present, as the done gate and the copier judge it.
 * - G2 `activityAt`: per listed mission, the newest of mission.time_updated, its documents' time_updated, their outputs'
 *   time_created and the G4 verification time (ISO).
 * - G3 messages tail: the newest N messages of a mission in ascending seq (the store's `listMessages` returns the oldest).
 * - G4: verification times for G2 through `outputVerification` below (row 155: awaits row 149's store read). Per-output
 *   `verified` in G1 is the one rule's state (row 136b), not this seam.
 * - 1.2.6 row 86 (MC-08, N-065): G1 also lists the documents linked to the mission in `mission_document` (migration
 *   0007: a work report of the mission named the revision as its `output`) when another mission owns them, with the
 *   newest linked revision (not the owner's current one), `linked: true` and `ownerMission`. Owned documents keep
 *   their current revision and come first; G2 counts the newest link time.
 */
import { DATUM_FILENAME_PATTERN } from "../../../vendor/src/lib/studio/contract/env"
import { finalFileNameOfRow } from "../../../vendor/src/lib/studio/services/storage/files"
import { outputFileOf } from "../../store-bridge/rows.ts"
import { deliverablePath, parseRowDeliverables } from "../../store/mission/deliverable-path.ts"
import { WORK_REPORT_CONTRACT_KIND, type MissionReader, type MissionStore } from "../../store/mission/index.ts"
import { revisionOutputState, ROW_DELIVERABLE_KEY } from "../../store/mission/output-gate.ts"
import { nativeProjectDir } from "../../store/mission/mission-store.ts"
import type { MissionMessage, RowDeliverable } from "../../store/mission/types.ts"
import type { StoreTx } from "../../store/types.ts"

/** G4 state of one output (C127 ruling 1: any state other than verified shows Unverified). */
export type OutputVerificationState = "verified" | "unverified"

/**
 * G4 source (row 155, C133, C140): row 149's `SqliteStudioStore.listOutputVerifications(ids, tx)` (records for the ids
 * that have one). `outputVerificationStates` is row 126's injected source, kept so its seam test still drives the
 * read; when present it is used instead of the store records (production never sets it).
 */
export interface OutputVerificationSource {
  listOutputVerifications?(fileIds: readonly string[], tx?: StoreTx): Promise<ReadonlyArray<{ output_file_id: string; output_sha256: string; state: string; time_verified: number }>>
  outputVerificationStates?(fileIds: readonly string[]): ReadonlyMap<string, { state: string; at?: number }>
}

/**
 * G4 SEAM (single function). Returns a state for EVERY file asked: "verified" only when the record says `verified`
 * AND its sha equals the output's sha (spec output verification §7.1: a record of other bytes is STALE); no record =
 * "unverified" (NOT_CHECKED). `at` = the record's time_verified (G2). A source that throws fails the read (logged by
 * the tool).
 */
export async function outputVerification(source: OutputVerificationSource, tx: StoreTx, files: ReadonlyArray<{ id: string; sha256: string }>): Promise<Map<string, { state: OutputVerificationState; at?: number }>> {
  const out = new Map<string, { state: OutputVerificationState; at?: number }>()
  if (files.length === 0) return out
  const ids = files.map((f) => f.id)
  const found = new Map<string, { state: string; at?: number; sha?: string }>()
  if (typeof source.outputVerificationStates === "function") for (const [id, r] of source.outputVerificationStates(ids)) found.set(id, r)
  else if (typeof source.listOutputVerifications === "function") for (const r of await source.listOutputVerifications(ids, tx)) found.set(r.output_file_id, { state: r.state, at: Number(r.time_verified), sha: r.output_sha256 })
  for (const f of files) {
    const r = found.get(f.id)
    const verified = r?.state === "verified" && (r.sha === undefined || r.sha === f.sha256)
    out.set(f.id, { state: verified ? "verified" : "unverified", ...(typeof r?.at === "number" && Number.isFinite(r.at) ? { at: r.at } : {}) })
  }
  return out
}

export type DeliverableOutputWire = {
  fileId: string
  format: "DOCX" | "PDF" | "HTML" | "SVG" | "PNG"
  role: "PRIMARY" | "FIGURE"
  finalFileName: string
  /**
   * Row 165D (F56-2, CP-17): the DATUM title name the file is delivered under (`output_file.file_name`, e.g.
   * `<Judul> 012-GSP-KT-XI-2026 RevA.docx`); null when the stored name is not a safe DATUM name (DATUM_FILENAME_PATTERN).
   */
  fileName: string | null
  sha256: string
  bytes: number
  createdAt: string
  verified: boolean
}

/** 1.3.3 row 71: one project copy of a deliverable (row 68's stored item plus the absolute path and a presence flag). */
export type ProjectFileWire = {
  /** Project-relative, `/` separators, starts with `deliverables/<mission id>/` (as stored). */
  path: string
  /** `<mission project folder>/<path>` as a disk path, for the "open" action; absent when the stored path would leave the folder. */
  absolutePath?: string
  format: RowDeliverable["format"]
  docRev?: string
  revisionNo?: number
  /** Recorded at the copy; not re-hashed on read. */
  sha256: string
  /** True on the items of the highest Studio revision listed for the document. */
  latest: boolean
  /** The file exists in the project folder right now (existence only, no hash). */
  present: boolean
}

export type DeliverableWire = {
  documentId: string
  docNumber: string
  title: string
  docKey: string | null
  rowId?: string
  revisionNo: number
  docRev: string
  updatedAt: string
  /** Row 136b: the output set is non-empty and every output in it is verified (the U24 badge). */
  verified: boolean
  /** Row 136b: spec output verification §7.2 Final (the row done gate's rule): >= 1 PRIMARY, all verified, a verified PRIMARY PDF/HTML. */
  final: boolean
  /**
   * 1.3.3 row 147 (S6; first added by row 70 at row 66's request): the done verdict of the document's row, the store's
   * whole `closeChecks` sequence run read-only (`MissionStore.closeRefusal`): output gate, project copy, knowledge.
   * true = `done` of that row would pass now (a person's label check pending closes with its marker). It is the ROW's
   * verdict: false says nothing about which document holds it back. Present on owned documents bound to a row by docKey.
   */
  mayClose?: boolean
  outputs: DeliverableOutputWire[]
  /** 1.3.3 row 71: true when row 68 recorded at least one project copy for this document. */
  hasProjectCopy: boolean
  /** 1.3.3 row 71: the project copies, newest revision first; absent when `hasProjectCopy` is false. */
  projectFiles?: ProjectFileWire[]
  /** Row 86 (MC-08): present (true) only on a document another mission owns, listed through `mission_document`. */
  linked?: true
  /** Row 86 (MC-08): the owning mission (`document.mission_folder`, null = none) of a linked document. */
  ownerMission?: string | null
}

/** Spec §7.1 row link: `row-<rowId>-<slug>` (a row id has no hyphen, so the parse is unambiguous). */
const ROW_KEY = /^row-([1-9][0-9]{0,3}[a-z]?)-(.+)$/
/** Badge order of spec §7.1 (PDF, DOCX, HTML), figures after. */
const FORMAT_ORDER = ["PDF", "DOCX", "HTML", "SVG", "PNG"]

const iso = (ms: unknown): string => new Date(Number(ms)).toISOString()
/** Row 165D: a stored name is passed on as the delivered DATUM name only in the DATUM form (one safe segment). */
const DATUM_NAME = new RegExp(DATUM_FILENAME_PATTERN)
type R = Record<string, unknown>

/**
 * 1.3.3 row 71: the project copies of a mission by document id, from the rows' stored `deliverables` (row 5) and the
 * mission's project folder. Existence is checked per file, nothing is hashed. Items without `documentId` (support
 * files) are not part of a document and are skipped. `exists` replaces the presence probe of a path the containment
 * rule accepted (tests); it never lets a refused path through.
 */
export function readProjectCopies(q: MissionReader, mission: string, exists?: (p: string) => boolean): Map<string, ProjectFileWire[]> {
  const out = new Map<string, ProjectFileWire[]>()
  const m = q.get<{ project_dir: string }>("SELECT project_dir FROM mission WHERE id = ?", [mission])
  if (!m) return out
  const dir = nativeProjectDir(m.project_dir)
  for (const r of q.all<{ deliverables: string }>("SELECT deliverables FROM mission_row WHERE mission_id = ? ORDER BY ord", [mission])) {
    for (const it of parseRowDeliverables(r.deliverables)) {
      if (typeof it.documentId !== "string") continue
      const at = deliverablePath(dir, mission, it.path)
      // Outside the folder or through a link: no path to open and never present, whatever `exists` says.
      const abs = at.ok || at.reason === "not-file" ? at.abs : undefined
      const file: ProjectFileWire = {
        path: it.path,
        ...(abs ? { absolutePath: abs } : {}),
        format: it.format,
        ...(typeof it.docRev === "string" ? { docRev: it.docRev } : {}),
        ...(typeof it.revisionNo === "number" ? { revisionNo: it.revisionNo } : {}),
        sha256: it.sha256,
        latest: it.latest === true,
        present: abs !== undefined && (exists ? exists(abs) : at.ok && at.present),
      }
      const l = out.get(it.documentId)
      if (l) l.push(file)
      else out.set(it.documentId, [file])
    }
  }
  for (const l of out.values()) l.sort((a, b) => (b.revisionNo ?? 0) - (a.revisionNo ?? 0) || FORMAT_ORDER.indexOf(a.format) - FORMAT_ORDER.indexOf(b.format))
  return out
}

/**
 * G1: deliverables of one mission (rowIds = the mission's row ids, for the row link). Synchronous over the reader:
 * the output set and every verified/final value come from `revisionOutputState` (row 136b).
 */
export function readDeliverables(q: MissionReader, mission: string, rowIds: ReadonlySet<string>, close: Pick<MissionStore, "closeRefusal">): DeliverableWire[] {
  const owned = q.all<R>(
    `SELECT d.id, d.doc_number, d.title, d.mission_doc_key, d.time_updated, r.id AS revision_id, r.revision_no, r.doc_rev
       FROM document d JOIN revision r ON r.document_id = d.id AND r.revision_no = d.current_revision_no
      WHERE d.mission_folder = ? AND d.archived = 0 AND (d.contract_kind IS NULL OR d.contract_kind <> ?)
      ORDER BY d.time_updated DESC, d.id`,
    [mission, WORK_REPORT_CONTRACT_KIND],
  )
  // Row 86 (MC-08): documents another mission owns, linked to this one (newest linked revision per document).
  const linked = q.all<R>(
    `SELECT d.id, d.doc_number, d.title, d.mission_doc_key, d.mission_folder, d.time_updated, r.id AS revision_id, r.revision_no, r.doc_rev,
            (SELECT l2.row_id FROM mission_document l2 WHERE l2.mission_id = l.mission_id AND l2.document_id = l.document_id AND l2.revision_no = l.revision_no) AS link_row
       FROM (SELECT mission_id, document_id, max(revision_no) AS revision_no, max(time_linked) AS time_linked
               FROM mission_document WHERE mission_id = ? GROUP BY mission_id, document_id) l
       JOIN document d ON d.id = l.document_id
       JOIN revision r ON r.document_id = d.id AND r.revision_no = l.revision_no
      WHERE (d.mission_folder IS NULL OR d.mission_folder <> ?) AND d.archived = 0 AND (d.contract_kind IS NULL OR d.contract_kind <> ?)
      ORDER BY l.time_linked DESC, d.id`,
    [mission, mission, WORK_REPORT_CONTRACT_KIND],
  )
  const copies = readProjectCopies(q, mission)
  // Row 147 (S6): one read-only run of the store's done gate per bound row.
  const closeVerdicts = new Map<string, boolean>()
  const mayClose = (rowId: string): boolean => {
    const v = closeVerdicts.get(rowId) ?? close.closeRefusal(mission, rowId, q) === null
    closeVerdicts.set(rowId, v)
    return v
  }
  const docs: R[] = [...owned, ...linked.map((d): R => ({ ...d, linked: true }))]
  return docs.map((d) => {
    const state = revisionOutputState(q, String(d.id), String(d.revision_id))
    const ids = state.outputs.map((o) => o.outputId)
    const files = ids.length === 0 ? [] : q.all<R>(`SELECT * FROM output_file WHERE id IN (${ids.map(() => "?").join(", ")}) ORDER BY time_created DESC, rowid DESC`, ids)
    const verifiedIds = new Set(state.outputs.filter((o) => o.state === "verified").map((o) => o.outputId))
    const docKey = (d.mission_doc_key as string | null) ?? null
    const isLinked = d.linked === true
    // An owned document's row comes from its docKey; a linked one's from the report row that linked it.
    const m = !isLinked && docKey ? ROW_KEY.exec(docKey) : null
    const linkRow = isLinked && typeof d.link_row === "string" ? d.link_row : null
    const rowId = m && rowIds.has(m[1]!) ? m[1] : linkRow !== null && rowIds.has(linkRow) ? linkRow : undefined
    const outputs = files
      .map((f) => {
        const row = { ...outputFileOf(f), document: { docNumber: String(d.doc_number) }, revision: { revisionNo: Number(d.revision_no) } }
        return {
          fileId: row.id,
          format: row.format as DeliverableOutputWire["format"],
          role: row.role,
          finalFileName: finalFileNameOfRow(row as never),
          fileName: typeof row.fileName === "string" && DATUM_NAME.test(row.fileName) ? row.fileName : null,
          sha256: row.sha256,
          bytes: row.bytes,
          createdAt: iso(f.time_created),
          verified: verifiedIds.has(row.id),
        }
      })
      // one output per (role, format, figure label) after the rule; badge order by format, newest first inside it
      .sort((a, b) => FORMAT_ORDER.indexOf(a.format) - FORMAT_ORDER.indexOf(b.format))
    const projectFiles = copies.get(String(d.id))
    return {
      documentId: String(d.id),
      docNumber: String(d.doc_number),
      title: String(d.title),
      docKey,
      ...(rowId ? { rowId } : {}),
      revisionNo: Number(d.revision_no),
      docRev: String(d.doc_rev),
      updatedAt: iso(d.time_updated),
      verified: state.verified,
      final: state.final,
      ...(m && rowId && docKey && ROW_DELIVERABLE_KEY.exec(docKey)?.[1] === rowId ? { mayClose: mayClose(rowId) } : {}),
      outputs,
      hasProjectCopy: projectFiles !== undefined,
      ...(projectFiles ? { projectFiles } : {}),
      ...(isLinked ? { linked: true as const, ownerMission: (d.mission_folder as string | null) ?? null } : {}),
    }
  })
}

/** G2: activityAt per mission id (ISO). One grouped query for documents/outputs, one seam call for verification times. */
export async function readActivityAt(q: StoreTx, source: OutputVerificationSource, missionIds: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (missionIds.length === 0) return out
  const marks = missionIds.map(() => "?").join(", ")
  const newest = new Map<string, number>()
  const bump = (id: string, ms: unknown) => {
    if (ms === null || ms === undefined) return
    const v = Number(ms)
    if (Number.isFinite(v) && v > (newest.get(id) ?? -Infinity)) newest.set(id, v)
  }
  for (const r of q.all<R>(`SELECT id, time_updated FROM mission WHERE id IN (${marks})`, missionIds)) bump(String(r.id), r.time_updated)
  for (const r of q.all<R>(
    `SELECT d.mission_folder AS m, max(d.time_updated) AS du, max(o.time_created) AS oc
       FROM document d LEFT JOIN output_file o ON o.document_id = d.id
      WHERE d.mission_folder IN (${marks}) GROUP BY d.mission_folder`,
    missionIds,
  )) {
    bump(String(r.m), r.du)
    bump(String(r.m), r.oc)
  }
  // Row 86 (MC-08): a link to a document another mission owns is activity of the linking mission.
  for (const r of q.all<R>(`SELECT mission_id AS m, max(time_linked) AS t FROM mission_document WHERE mission_id IN (${marks}) GROUP BY mission_id`, missionIds)) bump(String(r.m), r.t)
  const files = q.all<R>(
    `SELECT d.mission_folder AS m, o.id, o.sha256 FROM document d JOIN output_file o ON o.document_id = d.id
      WHERE d.mission_folder IN (${marks})`,
    missionIds,
  )
  if (files.length > 0) {
    const states = await outputVerification(source, q, files.map((f) => ({ id: String(f.id), sha256: String(f.sha256) })))
    for (const f of files) bump(String(f.m), states.get(String(f.id))?.at)
  }
  for (const [id, ms] of newest) out.set(id, iso(ms))
  return out
}

/** G3: the newest `n` messages of a mission, ascending seq (reuses the store's mapping through listMessages). */
export function readMessagesTail(q: MissionReader, M: MissionStore, mission: string, n: number): MissionMessage[] {
  const nth = q.get<{ seq: number }>("SELECT seq FROM mission_message WHERE mission_id = ? ORDER BY seq DESC LIMIT 1 OFFSET ?", [mission, n - 1])
  const oldest = nth ? Number(nth.seq) : 1
  return M.listMessages(mission, { afterSeq: oldest - 1, take: n }, q)
}
