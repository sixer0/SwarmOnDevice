/**
 * Baca baris ternormalisasi M14-M18 untuk sunting per pid (SR-14; register
 * 03_structural_sections_specs.md §9.2 cek lingkup pid, §10 riwayat dan pensiun).
 *
 * Hanya kueri baca (penulisan baris revisi milik repositori struktur SR-10).
 * Semua fungsi menerima klien transaksi agar cek konflik berjalan di dalam
 * kunci advisory dokumen (§9.1 butir 4).
 *
 * Swarm twin (row 31b, Prisma cut as row 109; 01_specs_studio.md §1.2): same path, exported names and
 * results. `Db` is the store job (`StudioTx`); each Prisma read is one SQL read over the row 8 tables
 * (`doc_identity`, `doc_block`, `doc_subsection`, `doc_chapter`, `doc_section`, `revision`).
 */
import type { StudioIdentityKind } from "../../../contract";
import { dateOf, parseJson, type StudioTx } from "../../_swarm-store";

export type Db = StudioTx;

export interface IdentityRow {
  id: string;
  pid: string;
  kind: StudioIdentityKind;
  createdRevisionNo: number;
  retiredRevisionNo: number | null;
}

/** Posisi satu identitas di satu revisi. */
export interface IdentityAt {
  revisionNo: number;
  createdBy: string;
  createdAt: Date;
  changeScope: string | null;
  contentSha256: string;
  /** Induk: identitas section/bab (BLOCK, SUBSECTION) atau slotKey (CHAPTER). */
  parent: string;
  address: string | null;
  artifactLabel: string | null;
  content: unknown;
}

type R = Record<string, unknown>;

function identityOf(r: R): IdentityRow {
  return {
    id: String(r.id),
    pid: String(r.pid),
    kind: String(r.kind) as StudioIdentityKind,
    createdRevisionNo: Number(r.created_revision_no),
    retiredRevisionNo: r.retired_revision_no === null || r.retired_revision_no === undefined ? null : Number(r.retired_revision_no),
  };
}

const IDENTITY_COLS = "id, pid, kind, created_revision_no, retired_revision_no";

export async function identityByPid(db: Db, documentId: string, pid: string): Promise<IdentityRow | null> {
  const r = db.get<R>(`SELECT ${IDENTITY_COLS} FROM doc_identity WHERE document_id = ? AND pid = ?`, [documentId, pid]);
  return r ? identityOf(r) : null;
}

/** Semua pid dokumen (aktif dan pensiun; keunikan M18 termasuk pid pensiun, §10). */
export async function documentPids(db: Db, documentId: string): Promise<Map<string, IdentityRow>> {
  const rows = db.all<R>(`SELECT ${IDENTITY_COLS} FROM doc_identity WHERE document_id = ?`, [documentId]);
  return new Map(rows.map((r) => [String(r.pid), identityOf(r)]));
}

/** Revision columns joined by every timeline read (`revSel` of the clone). */
const REV_COLS = "rv.revision_no AS rv_no, rv.created_by AS rv_by, rv.time_created AS rv_at, rv.change_scope AS rv_scope";

function metaOf(r: R) {
  return {
    revisionNo: Number(r.rv_no),
    createdBy: String(r.rv_by),
    createdAt: dateOf(r.rv_at),
    changeScope: r.rv_scope === null || r.rv_scope === undefined ? null : String(r.rv_scope),
  };
}

/**
 * Posisi identitas per revisi untuk revisi `revisionNo >= fromRevisionNo`
 * (urut naik). Revisi tanpa baris identitas tidak muncul di peta.
 */
export async function identityTimeline(db: Db, documentId: string, ident: IdentityRow, fromRevisionNo = 1): Promise<Map<number, IdentityAt>> {
  const out = new Map<number, IdentityAt>();
  const params = [ident.id, documentId, fromRevisionNo];
  if (ident.kind === "BLOCK") {
    const rows = db.all<R>(
      `SELECT b.content_sha256, b.address, b.artifact_label, b.content, sub.identity_id AS sub_identity, ch.identity_id AS ch_identity, ds.slot_key, ${REV_COLS}
         FROM doc_block b
         JOIN revision rv ON rv.id = b.revision_id
         JOIN doc_section ds ON ds.id = b.doc_section_id
         LEFT JOIN doc_subsection sub ON sub.id = b.subsection_id
         LEFT JOIN doc_chapter ch ON ch.id = b.chapter_id
        WHERE b.identity_id = ? AND rv.document_id = ? AND rv.revision_no >= ?
        ORDER BY rv.revision_no ASC`,
      params,
    );
    for (const b of rows) {
      out.set(Number(b.rv_no), {
        ...metaOf(b),
        contentSha256: String(b.content_sha256),
        parent: (b.sub_identity as string | null) ?? (b.ch_identity as string | null) ?? `slot:${String(b.slot_key)}`,
        address: (b.address ?? null) as string | null,
        artifactLabel: (b.artifact_label ?? null) as string | null,
        content: parseJson(b.content),
      });
    }
  } else if (ident.kind === "SUBSECTION") {
    const rows = db.all<R>(
      `SELECT s.content_sha256, s.section_no, s.title, ch.identity_id AS ch_identity, ch.chapter_key, ${REV_COLS}
         FROM doc_subsection s
         JOIN revision rv ON rv.id = s.revision_id
         JOIN doc_chapter ch ON ch.id = s.chapter_id
        WHERE s.identity_id = ? AND rv.document_id = ? AND rv.revision_no >= ?
        ORDER BY rv.revision_no ASC`,
      params,
    );
    for (const s of rows) {
      const sectionNo = Number(s.section_no);
      const key = String(s.chapter_key);
      out.set(Number(s.rv_no), {
        ...metaOf(s),
        contentSha256: String(s.content_sha256),
        parent: String(s.ch_identity),
        address: sectionNo === 0 ? key : `${key}.${sectionNo}`,
        artifactLabel: null,
        content: { sectionNo, title: s.title === null || s.title === undefined ? null : parseJson(s.title) },
      });
    }
  } else {
    const rows = db.all<R>(
      `SELECT c.content_sha256, c.chapter_key, c.title, c.short_title, ds.slot_key, ${REV_COLS}
         FROM doc_chapter c
         JOIN revision rv ON rv.id = c.revision_id
         JOIN doc_section ds ON ds.id = c.doc_section_id
        WHERE c.identity_id = ? AND rv.document_id = ? AND rv.revision_no >= ?
        ORDER BY rv.revision_no ASC`,
      params,
    );
    for (const c of rows) {
      out.set(Number(c.rv_no), {
        ...metaOf(c),
        contentSha256: String(c.content_sha256),
        parent: `slot:${String(c.slot_key)}`,
        address: String(c.chapter_key),
        artifactLabel: null,
        content: { key: String(c.chapter_key), title: parseJson(c.title), shortTitle: (c.short_title ?? null) as string | null },
      });
    }
  }
  return out;
}

export interface ScopeChange {
  changedInRevisionNo: number;
  changedBy: string;
  current: IdentityAt | null;
}

/**
 * Cek lingkup pid (§9.2): konflik bila sha atau induk identitas berubah, atau
 * identitas muncul/pensiun, pada revisi > `baseRevisionNo` sampai `latestRevisionNo`.
 */
export async function pidScopeChange(
  db: Db,
  documentId: string,
  ident: IdentityRow,
  baseRevisionNo: number,
  latestRevisionNo: number,
): Promise<ScopeChange | null> {
  if (baseRevisionNo >= latestRevisionNo) return null;
  const timeline = await identityTimeline(db, documentId, ident, baseRevisionNo);
  const revs = db
    .all<R>("SELECT revision_no, created_by FROM revision WHERE document_id = ? AND revision_no > ? AND revision_no <= ? ORDER BY revision_no ASC", [
      documentId,
      baseRevisionNo,
      latestRevisionNo,
    ])
    .map((r) => ({ revisionNo: Number(r.revision_no), createdBy: String(r.created_by) }));
  const base = timeline.get(baseRevisionNo) ?? null;
  const sig = (x: IdentityAt | null) => (x ? `${x.contentSha256}|${x.parent}` : "absent");
  const baseSig = sig(base);
  for (const r of revs) {
    const at = timeline.get(r.revisionNo) ?? null;
    if (sig(at) !== baseSig) return { changedInRevisionNo: r.revisionNo, changedBy: r.createdBy, current: timeline.get(latestRevisionNo) ?? null };
  }
  return null;
}
