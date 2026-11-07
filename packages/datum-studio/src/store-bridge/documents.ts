/**
 * Document, revision and template reads/writes that the ported Studio services did through Prisma
 * (row 109). Plain functions over a `StudioTx` and the row 8 tables; no query DSL. Inserts keep the
 * store's rules: doc_number_safe from `docNumberSafe` (as `createDocument`), document_card rows for
 * the card mirror, release_status/lint_report as the only revision columns written after insert
 * (the D-06 trigger refuses any other update).
 */
import { docNumberSafe, newId } from "../store/index.ts"
import { dayOf, inList, jsonCol, msOf, type SqlParam, type StudioTx } from "./db.ts"
import { documentOf, revisionOf, templateOf, templateVersionOf, type Row, type StudioDocument, type StudioRevision, type StudioTemplate, type StudioTemplateVersion } from "./rows.ts"

// ── documents ─────────────────────────────────────────────────────────────

function cardsOf(tx: StudioTx, documentId: string): string[] {
  return tx.all<{ card_id: string }>("SELECT card_id FROM document_card WHERE document_id = ? ORDER BY card_id", [documentId]).map((r) => r.card_id)
}

function docRow(tx: StudioTx, r: Row | undefined): StudioDocument | null {
  return r ? documentOf(r, cardsOf(tx, String(r.id))) : null
}

export function findDocumentById(tx: StudioTx, id: string): StudioDocument | null {
  return docRow(tx, tx.get("SELECT * FROM document WHERE id = ?", [id]))
}

export function findDocumentByNumber(tx: StudioTx, docNumber: string): StudioDocument | null {
  return docRow(tx, tx.get("SELECT * FROM document WHERE doc_number = ?", [docNumber]))
}

export function findDocumentByMission(tx: StudioTx, folder: string, docKey: string): StudioDocument | null {
  return docRow(tx, tx.get("SELECT * FROM document WHERE mission_folder = ? AND mission_doc_key = ?", [folder, docKey]))
}

/** Document numbers of one type code that contain `fragment` (the Prisma `docNumber: { contains }` of the sequence). */
export function docNumbersContaining(tx: StudioTx, typeCode: string, fragment: string): string[] {
  return tx
    .all<{ doc_number: string }>("SELECT doc_number FROM document WHERE type_code = ? AND instr(doc_number, ?) > 0", [typeCode, fragment])
    .map((r) => r.doc_number)
}

export interface DocumentCreate {
  id?: string
  docNumber: string
  numberSource: "AGENT" | "SEQUENCE" | string
  title: string
  typeCode: string
  language?: string
  classification: string
  tier: string
  templateId: string
  currentRevisionNo?: number
  missionFolder?: string | null
  missionDocKey?: string | null
  agentRequestId?: string | null
  hermesTaskId?: string | null
  createdBy: string
  completeness?: "INCOMPLETE" | "COMPLETE"
}

export function insertDocument(tx: StudioTx, d: DocumentCreate): StudioDocument {
  const id = d.id ?? newId()
  tx.run(
    `INSERT INTO document (id, doc_number, doc_number_safe, number_source, title, type_code, language, classification, tier, template_id,
       current_revision_no, mission_folder, mission_doc_key, agent_request_id, hermes_task_id, created_by, archived, completeness,
       time_created, time_updated)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
    [
      id,
      d.docNumber,
      docNumberSafe(d.docNumber),
      d.numberSource,
      d.title,
      d.typeCode,
      d.language ?? "ID",
      d.classification,
      d.tier,
      d.templateId,
      d.currentRevisionNo ?? 1,
      d.missionFolder ?? null,
      d.missionDocKey ?? null,
      d.agentRequestId ?? null,
      d.hermesTaskId ?? null,
      d.createdBy,
      d.completeness ?? "COMPLETE",
      tx.now,
      tx.now,
    ],
  )
  return findDocumentById(tx, id)!
}

/** Columns a Studio document update may set (Prisma `StudioDocumentUpdateInput` as used by the services). */
export interface DocumentUpdate {
  currentRevisionNo?: number
  completeness?: "INCOMPLETE" | "COMPLETE" | string
  title?: string
  typeCode?: string
  language?: string
  classification?: string
  tier?: string
  docNumber?: string
  archived?: boolean
  contractKind?: string | null
  contractStatus?: string | null
  contractOwner?: string | null
  contractTaskRef?: string | null
  contractDueOn?: Date | string | null
  contractCardIds?: readonly string[]
}

const DOC_COLUMNS: Record<Exclude<keyof DocumentUpdate, "contractCardIds" | "docNumber">, string> = {
  currentRevisionNo: "current_revision_no",
  completeness: "completeness",
  title: "title",
  typeCode: "type_code",
  language: "language",
  classification: "classification",
  tier: "tier",
  archived: "archived",
  contractKind: "contract_kind",
  contractStatus: "contract_status",
  contractOwner: "contract_owner",
  contractTaskRef: "contract_task_ref",
  contractDueOn: "contract_due_on",
}

export function updateDocument(tx: StudioTx, id: string, update: DocumentUpdate): StudioDocument {
  const patch = update as DocumentUpdate & Record<string, unknown>
  const sets: string[] = ["time_updated = ?"]
  const vals: SqlParam[] = [tx.now]
  for (const [k, col] of Object.entries(DOC_COLUMNS)) {
    const v = patch[k]
    if (v === undefined) continue
    sets.push(`${col} = ?`)
    vals.push(k === "contractDueOn" ? dayOf(v as Date | string | null) : k === "archived" ? (v ? 1 : 0) : (v as SqlParam))
  }
  if (patch.docNumber !== undefined) {
    sets.push("doc_number = ?", "doc_number_safe = ?")
    vals.push(patch.docNumber, docNumberSafe(patch.docNumber))
  }
  const unknown = Object.keys(patch).filter((k) => patch[k] !== undefined && !(k in DOC_COLUMNS) && k !== "contractCardIds" && k !== "docNumber")
  if (unknown.length > 0) throw new TypeError(`updateDocument: unknown fields ${unknown.join(", ")}`)
  tx.run(`UPDATE document SET ${sets.join(", ")} WHERE id = ?`, [...vals, id])
  if (patch.contractCardIds !== undefined) {
    tx.run("DELETE FROM document_card WHERE document_id = ?", [id])
    for (const card of new Set(patch.contractCardIds)) tx.run("INSERT INTO document_card (document_id, card_id) VALUES (?, ?)", [id, card])
  }
  return findDocumentById(tx, id)!
}

// ── revisions ─────────────────────────────────────────────────────────────

export interface RevisionCreate {
  documentId: string
  revisionNo: number
  parentRevisionNo: number | null
  templateVersionId: string
  snapshot: unknown
  snapshotSha256: string
  inputSha256: string
  docRev: string
  changeWhat: string
  changeWhy: string
  changeImpact: string
  changedAddresses?: readonly string[]
  releaseStatus?: string
  lintReport?: unknown
  createdBy: string
  schemaId?: string
  structureSha256?: string | null
  completeness?: "INCOMPLETE" | "COMPLETE" | string
  completenessReport?: unknown
  changeScope?: string | null
}

export function insertRevision(tx: StudioTx, r: RevisionCreate): StudioRevision {
  const id = newId()
  tx.run(
    `INSERT INTO revision (id, document_id, revision_no, parent_revision_no, template_version_id, snapshot, snapshot_sha256, input_sha256,
       doc_rev, change_what, change_why, change_impact, changed_addresses, release_status, lint_report, created_by, time_created,
       schema_id, structure_sha256, completeness, completeness_report, change_scope)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      r.documentId,
      r.revisionNo,
      r.parentRevisionNo,
      r.templateVersionId,
      JSON.stringify(r.snapshot ?? null),
      r.snapshotSha256,
      r.inputSha256,
      r.docRev,
      r.changeWhat,
      r.changeWhy,
      r.changeImpact,
      JSON.stringify(r.changedAddresses ?? []),
      r.releaseStatus ?? "PENDING",
      jsonCol(r.lintReport),
      r.createdBy,
      tx.now,
      r.schemaId ?? "studio.doc/v1",
      r.structureSha256 ?? null,
      r.completeness ?? "COMPLETE",
      jsonCol(r.completenessReport),
      r.changeScope ?? null,
    ],
  )
  return findRevisionById(tx, id)!
}

export function findRevisionById(tx: StudioTx, id: string): StudioRevision | null {
  const r = tx.get("SELECT * FROM revision WHERE id = ?", [id])
  return r ? revisionOf(r) : null
}

export function findRevisionByNo(tx: StudioTx, documentId: string, revisionNo: number): StudioRevision | null {
  const r = tx.get("SELECT * FROM revision WHERE document_id = ? AND revision_no = ?", [documentId, revisionNo])
  return r ? revisionOf(r) : null
}

/** The only revision columns D-06 allows to change (render lint, spec §3.3). */
export function setRevisionRelease(tx: StudioTx, id: string, releaseStatus: string, lintReport: unknown): void {
  tx.run("UPDATE revision SET release_status = ?, lint_report = ? WHERE id = ?", [releaseStatus, jsonCol(lintReport), id])
}

// ── templates (read) ──────────────────────────────────────────────────────

export function findTemplateById(tx: StudioTx, id: string): StudioTemplate | null {
  const r = tx.get("SELECT * FROM template WHERE id = ?", [id])
  return r ? templateOf(r) : null
}

export function findTemplateBySlug(tx: StudioTx, slug: string): StudioTemplate | null {
  const r = tx.get("SELECT * FROM template WHERE slug = ?", [slug])
  return r ? templateOf(r) : null
}

export function findTemplateVersionById(tx: StudioTx, id: string): (StudioTemplateVersion & { template: StudioTemplate }) | null {
  const v = tx.get("SELECT * FROM template_version WHERE id = ?", [id])
  if (!v) return null
  const t = findTemplateById(tx, String(v.template_id))!
  return { ...templateVersionOf(v), template: t }
}

export function findTemplateVersionByNo(tx: StudioTx, templateId: string, versionNo: number): StudioTemplateVersion | null {
  const v = tx.get("SELECT * FROM template_version WHERE template_id = ? AND version_no = ?", [templateId, versionNo])
  return v ? templateVersionOf(v) : null
}

export function templateVersionsOf(tx: StudioTx, templateId: string): StudioTemplateVersion[] {
  return tx.all("SELECT * FROM template_version WHERE template_id = ? ORDER BY version_no DESC", [templateId]).map(templateVersionOf)
}

export { inList, msOf }
