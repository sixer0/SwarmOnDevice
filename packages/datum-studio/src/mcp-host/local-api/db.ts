/**
 * Read helpers for the ported route bodies (row 31). Each replaces one Prisma read of a Studio route with
 * SQL over the row 8 tables (src/store/migrations/0001_datum_studio_init.ts), returning the Prisma row shape
 * the route body already used (camelCase + Date, through the row 109 bridge mappers in store-bridge/rows.ts).
 * Reads only; every write still goes through the vendored services and the store's write queue.
 *
 * Folded relations (store spec C5): `templateSlot` (M10) is read from the revision's template version
 * `skeleton.slots` by slot key; `sectionType.name` (M13) from `registry/sections` `getSectionType`.
 */
import type { StudioSlotContentMode } from "@/lib/studio/contract"
import type { TemplateSlotDef } from "@/lib/studio/contract/types/v2/template"
import { getSectionType } from "@/lib/studio/registry/sections"
import type { OutputFileRow } from "@/lib/studio/services/storage/files"
import {
  documentOf,
  findDocumentById,
  findRevisionById,
  findRevisionByNo,
  findTemplateVersionById,
  outputFileOf,
  parseJson,
  readWith,
  revisionOf,
  type StudioDocument,
  type StudioRevision,
} from "../../store-bridge/index.ts"

type R = Record<string, unknown>

export function docById(id: string): Promise<StudioDocument | null> {
  return readWith(undefined, (q) => findDocumentById(q, id))
}

export function revisionByNo(documentId: string, revisionNo: number): Promise<StudioRevision | null> {
  return readWith(undefined, (q) => findRevisionByNo(q, documentId, revisionNo))
}

export async function revisionWithDocument(revisionId: string): Promise<(StudioRevision & { document: StudioDocument }) | null> {
  return readWith(undefined, (q) => {
    const rev = findRevisionById(q, revisionId)
    if (!rev) return null
    const doc = findDocumentById(q, rev.documentId)
    return doc ? { ...rev, document: doc } : null
  })
}

/** Revision + its template version id/number/slug (structure/_lib/revision.ts `loadRevision`). */
export async function revisionWithTemplate(documentId: string, revisionNo: number) {
  return readWith(undefined, (q) => {
    const rev = findRevisionByNo(q, documentId, revisionNo)
    if (!rev) return null
    const tv = findTemplateVersionById(q, rev.templateVersionId)
    return { rev, templateVersion: { id: rev.templateVersionId, versionNo: tv?.versionNo ?? 0, template: { slug: tv?.template.slug ?? "" } } }
  })
}

export interface LegacyBlockRow {
  address: string
  blockId: string
  type: string
  artifactLabel: string | null
  ordinal: number
  textPlain: string
}

/** M06 `block` rows of one revision, ordinal order. */
export function legacyBlocks(revisionId: string): Promise<LegacyBlockRow[]> {
  return readWith(undefined, (q) =>
    q
      .all<R>("SELECT address, block_id, type, artifact_label, ordinal, text_plain FROM block WHERE revision_id = ? ORDER BY ordinal ASC", [revisionId])
      .map((b) => ({ address: String(b.address), blockId: String(b.block_id), type: String(b.type), artifactLabel: (b.artifact_label ?? null) as string | null, ordinal: Number(b.ordinal), textPlain: String(b.text_plain) })),
  )
}

/** Output rows of one revision with the `OUTPUT_FILE_OWNER_INCLUDE` relation (storage/files.ts:35-48). */
export function outputsOfRevision(revisionId: string): Promise<OutputFileRow[]> {
  return readWith(undefined, (q) =>
    q
      .all<R>(
        `SELECT o.*, d.doc_number AS owner_doc_number, d.contract_kind AS owner_contract_kind, r.revision_no AS owner_revision_no
           FROM output_file o LEFT JOIN document d ON d.id = o.document_id LEFT JOIN revision r ON r.id = o.revision_id
          WHERE o.revision_id = ? ORDER BY o.role ASC, o.format ASC, o.time_created DESC, o.rowid DESC`,
        [revisionId],
      )
      .map((r) => ({
        ...outputFileOf(r),
        document: r.owner_doc_number == null ? null : { docNumber: String(r.owner_doc_number), contractKind: (r.owner_contract_kind ?? null) as string | null },
        revision: r.owner_revision_no == null ? null : { revisionNo: Number(r.owner_revision_no) },
      })),
  )
}

export interface TemplateSlotView {
  label: string
  repeatable: boolean
  required: boolean
  contentMode: StudioSlotContentMode
  minItems: number | null
}

/** `skeleton.slots` of a template version, keyed by slot key (null skeleton = implicit, no slots). */
function skeletonSlots(q: Parameters<Parameters<typeof readWith>[1]>[0], templateVersionId: string): Map<string, TemplateSlotView> {
  const row = q.get<{ skeleton: string | null }>("SELECT skeleton FROM template_version WHERE id = ?", [templateVersionId])
  const sk = row?.skeleton ? parseJson<{ slots?: TemplateSlotDef[] }>(row.skeleton) : null
  const out = new Map<string, TemplateSlotView>()
  for (const s of sk?.slots ?? []) {
    out.set(s.slotKey, { label: s.label, repeatable: s.repeatable, required: s.required, contentMode: s.contentMode, minItems: s.minItems ?? null })
  }
  return out
}

export interface StructureRows {
  sections: Array<{
    id: string
    slotKey: string
    sectionTypeKey: string
    filled: boolean
    payload: unknown
    templateSlot: TemplateSlotView | null
    sectionType: { name: string }
  }>
  chapters: Array<{ id: string; docSectionId: string; chapterKey: string; title: unknown; identity: { pid: string } }>
  subsections: Array<{ id: string; chapterId: string; sectionNo: number; title: unknown; identity: { pid: string } }>
  blocks: Array<{ pid: string; address: string | null; type: string; artifactLabel: string | null; subsectionId: string | null }>
}

/** M14-M17 rows of one revision (documents/[id]/route.ts `readStructure`), same orders. */
export function structureOf(revisionId: string, templateVersionId: string): Promise<StructureRows> {
  return readWith(undefined, (q) => {
    const slots = skeletonSlots(q, templateVersionId)
    const sections = q.all<R>("SELECT id, slot_key, section_type_key, template_slot_key, filled, payload FROM doc_section WHERE revision_id = ? ORDER BY position ASC", [revisionId]).map((s) => ({
      id: String(s.id),
      slotKey: String(s.slot_key),
      sectionTypeKey: String(s.section_type_key),
      filled: Number(s.filled) === 1,
      payload: s.payload == null ? null : parseJson(s.payload),
      templateSlot: s.template_slot_key == null ? null : (slots.get(String(s.slot_key)) ?? slots.get(String(s.template_slot_key)) ?? null),
      sectionType: { name: getSectionType(String(s.section_type_key))?.name ?? String(s.section_type_key) },
    }))
    const chapters = q
      .all<R>(
        "SELECT c.id, c.doc_section_id, c.chapter_key, c.title, i.pid FROM doc_chapter c JOIN doc_identity i ON i.id = c.identity_id WHERE c.revision_id = ? ORDER BY c.doc_section_id ASC, c.position ASC",
        [revisionId],
      )
      .map((c) => ({ id: String(c.id), docSectionId: String(c.doc_section_id), chapterKey: String(c.chapter_key), title: parseJson(c.title), identity: { pid: String(c.pid) } }))
    const subsections = q
      .all<R>(
        "SELECT s.id, s.chapter_id, s.section_no, s.title, i.pid FROM doc_subsection s JOIN doc_identity i ON i.id = s.identity_id WHERE s.revision_id = ? ORDER BY s.chapter_id ASC, s.section_no ASC",
        [revisionId],
      )
      .map((s) => ({ id: String(s.id), chapterId: String(s.chapter_id), sectionNo: Number(s.section_no), title: s.title == null ? null : parseJson(s.title), identity: { pid: String(s.pid) } }))
    const blocks = q
      .all<R>("SELECT pid, address, type, artifact_label, subsection_id FROM doc_block WHERE revision_id = ? AND subsection_id IS NOT NULL ORDER BY ordinal ASC", [revisionId])
      .map((b) => ({ pid: String(b.pid), address: (b.address ?? null) as string | null, type: String(b.type), artifactLabel: (b.artifact_label ?? null) as string | null, subsectionId: (b.subsection_id ?? null) as string | null }))
    return { sections, chapters, subsections, blocks }
  })
}

/** Section rows of several revisions for the R04 list fallback (`rowSummariesOf`). */
export function sectionSummaries(revisionIds: readonly string[]) {
  return readWith(undefined, (q) => {
    const out: Array<{
      revisionId: string
      slotKey: string
      sectionTypeKey: string
      filled: boolean
      templateSlot: TemplateSlotView | null
      sectionType: { name: string }
      chapters: Array<{ chapterKey: string }>
    }> = []
    for (const revisionId of revisionIds) {
      const tv = q.get<{ template_version_id: string }>("SELECT template_version_id FROM revision WHERE id = ?", [revisionId])
      const slots = tv ? skeletonSlots(q, tv.template_version_id) : new Map<string, TemplateSlotView>()
      for (const s of q.all<R>("SELECT id, slot_key, section_type_key, template_slot_key, filled FROM doc_section WHERE revision_id = ? ORDER BY position ASC", [revisionId])) {
        const chapters = q.all<R>("SELECT chapter_key FROM doc_chapter WHERE doc_section_id = ? ORDER BY position ASC", [String(s.id)]).map((c) => ({ chapterKey: String(c.chapter_key) }))
        out.push({
          revisionId,
          slotKey: String(s.slot_key),
          sectionTypeKey: String(s.section_type_key),
          filled: Number(s.filled) === 1,
          templateSlot: s.template_slot_key == null ? null : (slots.get(String(s.slot_key)) ?? null),
          sectionType: { name: getSectionType(String(s.section_type_key))?.name ?? String(s.section_type_key) },
          chapters,
        })
      }
    }
    return out
  })
}

export interface DocumentListFilter {
  mission?: string
  docKey?: string
  agentRequestId?: string
  hermesTaskId?: string
  archived?: boolean
  cursor?: string
  take: number
}

/**
 * R04 GET list: `orderBy createdAt DESC, id DESC`, `take + 1`, Prisma cursor semantics (start after the
 * cursor row; an unknown cursor id gives an empty page, as Prisma's cursor would find no anchor).
 */
export function listDocuments(f: DocumentListFilter) {
  return readWith(undefined, (q) => {
    const where: string[] = []
    const params: Array<string | number> = []
    if (f.mission) (where.push("d.mission_folder = ?"), params.push(f.mission))
    if (f.docKey) (where.push("d.mission_doc_key = ?"), params.push(f.docKey))
    if (f.agentRequestId) (where.push("d.agent_request_id = ?"), params.push(f.agentRequestId))
    if (f.hermesTaskId) (where.push("d.hermes_task_id = ?"), params.push(f.hermesTaskId))
    if (f.archived !== undefined) (where.push("d.archived = ?"), params.push(f.archived ? 1 : 0))
    if (f.cursor) {
      const anchor = q.get<{ time_created: number; id: string }>("SELECT time_created, id FROM document WHERE id = ?", [f.cursor])
      if (!anchor) return []
      where.push("(d.time_created < ? OR (d.time_created = ? AND d.id < ?))")
      params.push(anchor.time_created, anchor.time_created, anchor.id)
    }
    const sql = `SELECT d.* FROM document d ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY d.time_created DESC, d.id DESC LIMIT ?`
    params.push(f.take + 1)
    return q.all<R>(sql, params).map((r) => {
      const cards = q.all<{ card_id: string }>("SELECT card_id FROM document_card WHERE document_id = ? ORDER BY card_id", [String(r.id)]).map((c) => c.card_id)
      const latest = q.get<R>("SELECT id, release_status, completeness_report FROM revision WHERE document_id = ? ORDER BY revision_no DESC LIMIT 1", [String(r.id)])
      return {
        ...documentOf(r, cards),
        revisions: latest ? [{ id: String(latest.id), releaseStatus: String(latest.release_status), completenessReport: latest.completeness_report == null ? null : parseJson(latest.completeness_report) }] : [],
      }
    })
  })
}

/** R04 `latestFilesOf`: distinct (revision, draft, scopeKind) of PRIMARY outputs, with the revision number. */
export function primaryOutputsOf(documentIds: readonly string[]) {
  return readWith(undefined, (q) => {
    const out: Array<{ documentId: string; draft: boolean; scopeKind: string; revision: { revisionNo: number } | null }> = []
    for (const id of documentIds) {
      for (const r of q.all<R>(
        `SELECT DISTINCT o.document_id, o.draft, o.scope_kind, o.revision_id, rv.revision_no FROM output_file o
           JOIN revision rv ON rv.id = o.revision_id
          WHERE o.document_id = ? AND o.revision_id IS NOT NULL AND o.role = 'PRIMARY'`,
        [id],
      )) {
        out.push({ documentId: String(r.document_id), draft: Number(r.draft) === 1, scopeKind: String(r.scope_kind), revision: { revisionNo: Number(r.revision_no) } })
      }
    }
    return out
  })
}

export { revisionOf }

/** R03 `kind=presets`: active preset templates + resolved params of their latest version (two reads). */
export function presetTemplates() {
  return readWith(undefined, (q) =>
    q
      .all<R>(
        `SELECT t.id, t.slug, t.name, t.kind, t.description, t.is_canonical, t.latest_version_no, t.time_updated, v.resolved_params
           FROM template t LEFT JOIN template_version v ON v.template_id = t.id AND v.version_no = t.latest_version_no
          WHERE t.is_preset = 1 AND t.archived = 0 ORDER BY t.is_canonical DESC, t.slug ASC`,
      )
      .map((t) => ({
        id: String(t.id),
        slug: String(t.slug),
        name: String(t.name),
        kind: String(t.kind),
        description: (t.description ?? null) as string | null,
        isCanonical: Number(t.is_canonical) === 1,
        latestVersionNo: Number(t.latest_version_no),
        updatedAt: new Date(Number(t.time_updated)),
        resolvedParams: t.resolved_params == null ? null : parseJson(t.resolved_params),
      })),
  )
}

// ── Row 31b (additive): pid identity reads of R16 `paragraphs/[pid]` (clone paragraphs/_lib/http.ts
// `locatePid`, Prisma -> SQL over doc_identity / doc_block / doc_chapter / doc_subsection / doc_section).

/** M18 identity of a pid in a document (`studioDocIdentity.findUnique({ documentId_pid })`). */
export function pidIdentity(documentId: string, pid: string) {
  return readWith(undefined, (q) => {
    const r = q.get<R>("SELECT id, kind, created_revision_no, retired_revision_no FROM doc_identity WHERE document_id = ? AND pid = ?", [documentId, pid])
    if (!r) return null
    return {
      id: String(r.id),
      kind: String(r.kind) as "CHAPTER" | "SUBSECTION" | "BLOCK",
      createdRevisionNo: Number(r.created_revision_no),
      retiredRevisionNo: r.retired_revision_no == null ? null : Number(r.retired_revision_no),
    }
  })
}

/** M17 block of a pid in one revision, with its slot key and chapter key (`studioDocBlock.findUnique({ revisionId_pid })`). */
export function pidBlockAt(revisionId: string, pid: string) {
  return readWith(undefined, (q) => {
    const r = q.get<R>(
      `SELECT b.address, b.type, b.content, ds.slot_key, ch.chapter_key FROM doc_block b
         JOIN doc_section ds ON ds.id = b.doc_section_id LEFT JOIN doc_chapter ch ON ch.id = b.chapter_id
        WHERE b.revision_id = ? AND b.pid = ?`,
      [revisionId, pid],
    )
    if (!r) return null
    return {
      address: (r.address ?? null) as string | null,
      type: String(r.type),
      content: parseJson(r.content),
      slotKey: String(r.slot_key),
      chapterKey: (r.chapter_key ?? null) as string | null,
    }
  })
}

/** M15 chapter of an identity in one revision (`studioDocChapter.findFirst({ revisionId, identityId })`). */
export function pidChapterAt(revisionId: string, identityId: string) {
  return readWith(undefined, (q) => {
    const r = q.get<R>(
      "SELECT c.chapter_key, ds.slot_key FROM doc_chapter c JOIN doc_section ds ON ds.id = c.doc_section_id WHERE c.revision_id = ? AND c.identity_id = ? LIMIT 1",
      [revisionId, identityId],
    )
    return r ? { chapterKey: String(r.chapter_key), slotKey: String(r.slot_key) } : null
  })
}

/** M16 subsection of an identity in one revision (`studioDocSubsection.findFirst({ revisionId, identityId })`). */
export function pidSubsectionAt(revisionId: string, identityId: string) {
  return readWith(undefined, (q) => {
    const r = q.get<R>(
      `SELECT s.section_no, c.chapter_key, ds.slot_key FROM doc_subsection s
         JOIN doc_chapter c ON c.id = s.chapter_id JOIN doc_section ds ON ds.id = c.doc_section_id
        WHERE s.revision_id = ? AND s.identity_id = ? LIMIT 1`,
      [revisionId, identityId],
    )
    return r ? { sectionNo: Number(r.section_no), chapterKey: String(r.chapter_key), slotKey: String(r.slot_key) } : null
  })
}
