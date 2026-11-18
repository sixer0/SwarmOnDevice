/**
 * Swarm 1.3.3 row 70 (MC-8 item 3, owner decision U16; register section 2 `DELIVERABLE_NOT_IN_PROJECT`).
 *
 * A row whose outputs are Studio documents may go `needs-review` or `done` only when, per document, the project copy of
 * the document's CURRENT revision is listed in the row's `deliverables` (row 68 writes them after a verified render),
 * is a regular file in `<project>/deliverables/<mission id>/` and has the recorded sha256. A decision request that
 * names a document (the `document=<id>` token of its context line; row 62's labels-check line is the carrier today) is
 * held to the same rule, with the copies of every row of the mission.
 *
 * Which documents are a row's outputs: the documents the row done gate binds to it (output-gate.ts `rowCloseGate`):
 * `document.mission_folder` = mission, not archived, not a work report, `mission_doc_key` = `row-<R>-<name>`
 * (ROW_DELIVERABLE_KEY). Row 68 lists copies on that same row (`project-copy.ts`, docKey first).
 *
 * Revision: only items whose `revisionNo` equals `document.current_revision_no` count. A verified copy of an older
 * revision is listed with `olderRevisionNo` and refused as `missing` (row 78's routed request).
 *
 * Causes (register): `missing` (no item, no file, a link or another kind of entry at the path, a path outside the
 * folder), `sha-mismatch` (the bytes differ from the recorded sha256: hashed here, at gate time) and
 * `PROJECT_UNWRITABLE` (something is missing and the project folder, or `deliverables/<mission id>`, cannot be written,
 * so a render could not make the copy: only the person can fix that). A folder that cannot be written while every copy
 * is present and equal is not a refusal: nothing has to be written.
 *
 * Reads only (database through `q`, files under the project folder); synchronous, so it runs inside the status write's
 * transaction. Never throws for a file problem: every file problem is a cause.
 */
import { accessSync, constants, lstatSync, readFileSync, statSync, type Stats } from "node:fs"
import path from "node:path"
import { sha256Hex } from "../ids.ts"
import { deliverableFileName, deliverablePath, deliverableRelPath, parseRowDeliverables, PROJECT_DELIVERABLES_DIR } from "./deliverable-path.ts"
import { ROW_DELIVERABLE_KEY } from "./output-gate.ts"
import type { MissionReader } from "./mission-store.ts"
import type { RowDeliverable } from "./types.ts"

/** A refusal lists at most this many expected files. */
const DELIVERABLE_GATE_LIST_MAX = 20
/** The formats row 68 copies; the order a missing set is named in. */
const COPY_FORMATS = ["PDF", "DOCX", "HTML"] as const

type DeliverableGateCause = "missing" | "sha-mismatch" | "PROJECT_UNWRITABLE"

interface ExpectedProjectFile {
  /** Project-relative, `/` separators: `deliverables/<mission id>/<doc number> Rev<letter> rev<N>.<ext>`. */
  path: string
  /** The recorded sha256, or the store output's sha256 when nothing is recorded yet; null when neither exists. */
  sha256: string | null
  documentId: string
  revisionNo: number
  format: string
  cause: DeliverableGateCause
  /** A copy of this older revision is listed (it does not count). */
  olderRevisionNo?: number
}

interface DeliverableGateResult {
  /** Empty = the gate passes. */
  expected: ExpectedProjectFile[]
  /** Number of expected files beyond the listed ones. */
  more: number
  /** The cause a reader acts on first: PROJECT_UNWRITABLE, then sha-mismatch, then missing. */
  cause: DeliverableGateCause | null
  /** Set when the cause is PROJECT_UNWRITABLE: what could not be written. */
  unwritable?: string
}

export interface GateDocument {
  id: string
  docNumber: string
  docRev: string
  revisionNo: number
  revisionId: string
}

/** The documents a row's outputs reference: the ones the done gate binds to it by docKey. */
export function rowDocuments(q: MissionReader, mission: string, rowId: string, workReportKind: string): GateDocument[] {
  return q
    .all<{ id: string; doc_number: string; mission_doc_key: string; revision_id: string; revision_no: number; doc_rev: string }>(
      `SELECT d.id, d.doc_number, d.mission_doc_key, r.id AS revision_id, r.revision_no, r.doc_rev
         FROM document d JOIN revision r ON r.document_id = d.id AND r.revision_no = d.current_revision_no
        WHERE d.mission_folder = ? AND d.archived = 0 AND (d.contract_kind IS NULL OR d.contract_kind <> ?)
          AND d.mission_doc_key LIKE 'row-%'
        ORDER BY d.mission_doc_key, d.id`,
      [mission, workReportKind],
    )
    .filter((d) => ROW_DELIVERABLE_KEY.exec(d.mission_doc_key)?.[1] === rowId)
    .map(gateDocument)
}

/** The ids named by `document=<id>` tokens of a decision request's context line. */
export function requestDocumentIds(context: unknown): string[] {
  if (typeof context !== "string") return []
  return [...new Set([...context.matchAll(/(?:^|\s)document=([A-Za-z0-9_-]{1,64})(?=\s|$)/g)].map((m) => m[1]!))]
}

/** Documents of `mission` (owned, not archived, not a work report) among `ids`; other ids are not this gate's business. */
export function namedDocuments(q: MissionReader, mission: string, ids: readonly string[], workReportKind: string): GateDocument[] {
  if (ids.length === 0) return []
  return q
    .all<{ id: string; doc_number: string; revision_id: string; revision_no: number; doc_rev: string }>(
      `SELECT d.id, d.doc_number, r.id AS revision_id, r.revision_no, r.doc_rev
         FROM document d JOIN revision r ON r.document_id = d.id AND r.revision_no = d.current_revision_no
        WHERE d.id IN (${ids.map(() => "?").join(", ")}) AND d.mission_folder = ? AND d.archived = 0 AND (d.contract_kind IS NULL OR d.contract_kind <> ?)
        ORDER BY d.id`,
      [...ids, mission, workReportKind],
    )
    .map(gateDocument)
}

/**
 * The gate. `items` = the deliverables that count (the row's own for a status move; every row's for a decision
 * request); `projectDir` = the mission's project folder as a disk path (`nativeProjectDir`).
 */
export function deliverablesNotInProject(q: MissionReader, mission: string, projectDir: string, docs: readonly GateDocument[], items: readonly RowDeliverable[]): DeliverableGateResult {
  const expected = docs.flatMap((d) => expectedOf(q, mission, projectDir, d, items))
  if (expected.length === 0) return { expected: [], more: 0, cause: null }
  const unwritable = expected.some((e) => e.cause === "missing") ? unwritableReason(projectDir, mission) : null
  const all = unwritable ? expected.map((e) => (e.cause === "missing" ? { ...e, cause: "PROJECT_UNWRITABLE" as const } : e)) : expected
  const cause = (["PROJECT_UNWRITABLE", "sha-mismatch", "missing"] as const).find((c) => all.some((e) => e.cause === c))!
  return {
    expected: all.slice(0, DELIVERABLE_GATE_LIST_MAX),
    more: Math.max(0, all.length - DELIVERABLE_GATE_LIST_MAX),
    cause,
    ...(unwritable ? { unwritable } : {}),
  }
}

/**
 * Message and the one call of a refusal. `subject` says what was refused ("row 3 cannot go done"). Cause missing:
 * studio_render of the document (whole document, current revision) verifies it and makes the copy (row 68). Cause
 * sha-mismatch: a render does not overwrite a changed file (OUTPUT_EXISTS), and PROJECT_UNWRITABLE: only the person
 * fixes the folder; both name studio_mission_request_decision.
 */
export function deliverableRefusal(subject: string, gate: DeliverableGateResult): { message: string; fix: "studio_render" | "studio_mission_request_decision" } {
  const first = gate.expected[0]!
  const files = gate.expected.slice(0, 3).map((e) => `${e.path} (${e.cause}${e.olderRevisionNo !== undefined ? `, only revision ${e.olderRevisionNo} is copied` : ""})`)
  const more = gate.expected.length + gate.more - files.length
  const head = `${subject}: the project copy of the current revision is not in the project folder: ${files.join("; ")}${more > 0 ? ` and ${more} more` : ""}`
  if (gate.cause === "PROJECT_UNWRITABLE") return { message: `${head}. The project folder cannot be written (${gate.unwritable}): only the person can fix it; ask with studio_mission_request_decision`, fix: "studio_mission_request_decision" }
  if (gate.cause === "sha-mismatch") return { message: `${head}. The file differs from the recorded sha256 (changed by hand); a render does not overwrite it: ask the person with studio_mission_request_decision`, fix: "studio_mission_request_decision" }
  // Decision C40 (row 147): plain words, never a call-shaped `tool {args}` text a model copies as a fake call.
  return { message: `${head}. Call the tool datum-studio_studio_render with documentId "${first.documentId}" and formats ["pdf","docx","html"] (the whole document at its current revision ${first.revisionNo}): a verified render copies it into the project folder`, fix: "studio_render" }
}

/** Every stored deliverable item of the mission's rows (the decision request reads the whole mission). */
export function missionDeliverables(q: MissionReader, mission: string): RowDeliverable[] {
  return q.all<{ deliverables: string | null }>("SELECT deliverables FROM mission_row WHERE mission_id = ? ORDER BY ord", [mission]).flatMap((r) => parseRowDeliverables(r.deliverables))
}

function gateDocument(d: { id: string; doc_number: string; revision_id: string; revision_no: number; doc_rev: string }): GateDocument {
  return { id: d.id, docNumber: d.doc_number, docRev: d.doc_rev, revisionNo: Number(d.revision_no), revisionId: d.revision_id }
}

function expectedOf(q: MissionReader, mission: string, projectDir: string, d: GateDocument, items: readonly RowDeliverable[]): ExpectedProjectFile[] {
  const mine = items.filter((it) => it.documentId === d.id)
  const current = mine.filter((it) => it.revisionNo === d.revisionNo)
  if (current.length > 0) {
    return current.flatMap((it): ExpectedProjectFile[] => {
      const cause = fileCause(projectDir, mission, it)
      return cause ? [{ path: it.path, sha256: it.sha256, documentId: d.id, revisionNo: d.revisionNo, format: it.format, cause }] : []
    })
  }
  // Nothing recorded for the current revision: name the files a verified render of it would copy.
  const older = mine.reduce<number | undefined>((n, it) => (typeof it.revisionNo === "number" && (n === undefined || it.revisionNo > n) ? it.revisionNo : n), undefined)
  const outputs = q.all<{ format: string; sha256: string }>(
    `SELECT format, sha256 FROM output_file WHERE document_id = ? AND revision_id = ? AND kind = 'document' AND scope_kind = 'DOCUMENT' AND draft = 0 AND role = 'PRIMARY'
      ORDER BY time_created DESC, rowid DESC`,
    [d.id, d.revisionId],
  )
  const formats = COPY_FORMATS.filter((f) => outputs.some((o) => o.format === f))
  return (formats.length > 0 ? formats : (["PDF"] as const)).map((format) => ({
    path: deliverableRelPath(mission, deliverableFileName(d.docNumber, d.docRev, d.revisionNo, format)),
    sha256: outputs.find((o) => o.format === format)?.sha256 ?? null,
    documentId: d.id,
    revisionNo: d.revisionNo,
    format,
    cause: "missing" as const,
    ...(older !== undefined ? { olderRevisionNo: older } : {}),
  }))
}

/**
 * null = the recorded file is there with the recorded bytes. Row 147 (S9): the one containment rule
 * (deliverable-path.ts): a symbolic link at `deliverables`, `<mission>` or the name is `missing`, like no file.
 */
function fileCause(projectDir: string, mission: string, it: RowDeliverable): DeliverableGateCause | null {
  const at = deliverablePath(projectDir, mission, it.path)
  if (!at.ok || !at.present) return "missing"
  try {
    return sha256Hex(readFileSync(at.abs)) === it.sha256 ? null : "sha-mismatch"
  } catch {
    return "missing"
  }
}

/** Why a render could not write the copy, or null when it could (row 68's PROJECT_UNWRITABLE conditions, probed). */
function unwritableReason(projectDir: string, mission: string): string | null {
  if (!path.isAbsolute(projectDir)) return "the mission's project folder is not an absolute path"
  const dirs = [projectDir, path.join(projectDir, PROJECT_DELIVERABLES_DIR), path.join(projectDir, PROJECT_DELIVERABLES_DIR, mission)]
  for (const [i, dir] of dirs.entries()) {
    // The project folder may be reached through a link (row 68 resolves it); its two children may not.
    const st = statOf(dir, i === 0)
    if (st === "error") return `${dir} cannot be read`
    if (!st) return i === 0 ? "the mission's project folder does not exist" : null
    if (!st.isDirectory()) return `${dir} is not a folder`
    try {
      accessSync(dir, constants.W_OK | constants.X_OK)
    } catch {
      return `${dir} cannot be written`
    }
  }
  return null
}

function statOf(p: string, follow: boolean): Stats | undefined | "error" {
  try {
    return follow ? statSync(p, { throwIfNoEntry: false }) : lstatSync(p, { throwIfNoEntry: false })
  } catch {
    return "error"
  }
}
