/**
 * FIX-H2 (D-321/D-322, uji Hermes C2): kiriman bab/slot/dokumen TIDAK boleh diam-diam
 * menimpa paragraf yang disunting lewat PATCH (pid/alamat R16/R06, struktur R14) SETELAH
 * kiriman terakhir lingkup yang sama.
 *
 * Aturan (dicek di dalam kunci, sesudah cek idempoten, sebelum cek dasar §9.2):
 *  - Revisi sunting = revisi yang `changeScope`-nya memuat `pid:<pid>` (R16 dan R06 alamat
 *    menulis `pid:`), atau `structure:renumberChapters` (R14; kunci bab berganti).
 *  - Revisi acuan lingkup = `baseRevisionNo` kiriman bila dikirim; bila tidak, revisi
 *    kiriman TERAKHIR yang memuat lingkup itu (`chapter:<k>` / `slot:<s>`; revisi tanpa
 *    `changeScope` = ingest dokumen utuh, berlaku untuk semua lingkup); 0 bila tidak ada.
 *  - Konflik bila kiriman akan MENGUBAH pid (isi, posisi, atau keberadaannya) yang
 *    terakhir disunting di revisi > acuan. Slot tak-berulang diganti utuh, jadi setiap
 *    pid slot yang disunting sesudah acuan ikut tertimpa. pid yang DIHAPUS oleh sunting
 *    sesudah acuan di bab/slot yang diubah kiriman juga dihitung (kiriman lama akan
 *    menghidupkannya kembali). Kiriman bab ke kunci yang sudah diganti `renumberChapters`
 *    sesudah acuan = konflik pada pid bab itu (mencegah bab ganda diam-diam).
 *  - Hasil: 409 `SCOPE_CONFLICT` `reason: PATCHED_PIDS_OVERWRITTEN` +
 *    `details.overwrittenPids` [{pid, address, editedInRevision, editedBy}] +
 *    `forwardToController` (teks awam). Kiriman identik tetap `unchanged` (cek ini tidak
 *    pernah dijalankan untuknya); kiriman ke bab/slot lain tidak tersentuh (lingkup lain).
 *
 * Biaya baca (FIX-HR2, D-332 C10): cek ini TIDAK membaca seluruh riwayat revisi di dalam
 * kunci. Acuan tiap lingkup diambil dengan satu `findFirst` per lingkup (token
 * `changeScope` persis, lihat `scopeTokenWhere`), lalu hanya revisi sunting (`pid:`) dan
 * `renumberChapters` di jendela (min acuan, revisi terbaru] yang dibaca, dengan empat
 * kolom. Hasilnya sama dengan membaca semua revisi: setiap temuan mensyaratkan sunting
 * terakhir > acuan lingkupnya >= min acuan, dan revisi kiriman tidak pernah memuat `pid:`.
 */
import type { ChapterV2, StudioDocV2Resolved } from "../../contract";
import { StudioEngineError } from "../../contract/errors";
import { stripIds } from "../compose/hash";
import { stableStringify } from "../ingest/util";
import type { StructureRows } from "../structure";
import type { SubmitTx } from "./lock";
// Swarm patch (row 109, Prisma cut): revision/structure reads as SQL over the store transaction.
import { inList } from "../_swarm-store";

/** `changeScope` holds `token` as one `;`-separated item (same rule as `scopeTokenWhere`), SQL form. */
const SCOPE_TOKEN_SQL = "instr(';' || change_scope || ';', ';' || ? || ';') > 0";

type ScopeRowRaw = { revision_no: number; change_scope: string | null; created_by: string; parent_revision_no: number | null };
const scopeRowOf = (r: ScopeRowRaw): RevisionScopeRow => ({
  revisionNo: Number(r.revision_no),
  changeScope: r.change_scope,
  createdBy: r.created_by,
  parentRevisionNo: r.parent_revision_no === null ? null : Number(r.parent_revision_no),
});

/** Ringkasan revisi yang cukup untuk aturan ini (urut naik `revisionNo`). */
export interface RevisionScopeRow {
  revisionNo: number;
  changeScope: string | null;
  createdBy: string;
  parentRevisionNo: number | null;
}

/** Satu pid yang akan tertimpa kiriman. */
export interface OverwrittenPid {
  pid: string;
  address: string | null;
  editedInRevision: number;
  editedBy: string | null;
}

/** Temuan internal (lingkup + acuan untuk detail galat). */
export interface OverwriteFinding extends OverwrittenPid {
  scope: string;
  referenceRevisionNo: number;
}

export const OVERWRITE_REASON = "PATCHED_PIDS_OVERWRITTEN";
const RENUMBER_SCOPE = "structure:renumberChapters";

// ── Pembantu murni ───────────────────────────────────────────────────────

export function parseScopes(changeScope: string | null): string[] {
  return changeScope ? changeScope.split(";").filter((s) => s !== "") : [];
}

/** Revisi bersumber kiriman (bukan sunting): ingest utuh (tanpa changeScope), create, document, bab, slot. */
export function isSubmissionRevision(changeScope: string | null): boolean {
  if (changeScope === null) return true;
  return parseScopes(changeScope).some((s) => s === "create" || s === "document" || s.startsWith("chapter:") || s.startsWith("slot:"));
}

/** Revisi kiriman terakhir (<= n) yang memuat `scope`; ingest utuh tanpa changeScope berlaku untuk semua lingkup; 0 bila tidak ada. */
export function referenceRevision(revs: readonly RevisionScopeRow[], scope: string, n: number): number {
  let ref = 0;
  for (const r of revs) {
    if (r.revisionNo > n || r.revisionNo <= ref) continue;
    if (r.changeScope === null || (isSubmissionRevision(r.changeScope) && parseScopes(r.changeScope).includes(scope))) ref = r.revisionNo;
  }
  return ref;
}

/** Revisi sunting terakhir (<= n) per pid, dari lingkup `pid:<pid>` revisi bukan-kiriman. */
export function lastPidEdits(revs: readonly RevisionScopeRow[], n: number): Map<string, { rev: number; by: string; parent: number | null }> {
  const out = new Map<string, { rev: number; by: string; parent: number | null }>();
  for (const r of revs) {
    if (r.revisionNo > n || isSubmissionRevision(r.changeScope)) continue;
    for (const s of parseScopes(r.changeScope)) {
      if (!s.startsWith("pid:")) continue;
      const pid = s.slice("pid:".length);
      const prev = out.get(pid);
      if (!prev || prev.rev < r.revisionNo) out.set(pid, { rev: r.revisionNo, by: r.createdBy, parent: r.parentRevisionNo ?? r.revisionNo - 1 });
    }
  }
  return out;
}

function omit(o: object, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (!keys.includes(k)) out[k] = v;
  return out;
}

function chaptersByKey(doc: StudioDocV2Resolved): Map<string, ChapterV2> {
  const out = new Map<string, ChapterV2>();
  for (const payload of Object.values(doc.sections ?? {})) {
    const ch = (payload as { chapters?: unknown }).chapters;
    if (!Array.isArray(ch)) continue;
    for (const c of ch as ChapterV2[]) if (c && typeof c.key === "string") out.set(c.key, c);
  }
  return out;
}

/**
 * Tanda keadaan setiap pid bab (murni): bab = medan bab tanpa isi; section = posisi + medan
 * tanpa blok; blok = posisi (section, indeks) + isi tanpa id pemegang pid. Kunci = pid.
 */
export function chapterPidStates(c: ChapterV2): Map<string, string> {
  const out = new Map<string, string>();
  const k = c.key;
  if (c.id) out.set(c.id, `${k}|C|${stableStringify(omit(c, ["id", "intro", "sections"]))}`);
  (c.intro ?? []).forEach((b, j) => {
    if (b.id) out.set(b.id, `${k}|B|0|${j}|${stableStringify(stripIds(b))}`);
  });
  c.sections.forEach((s, i) => {
    if (s.id) out.set(s.id, `${k}|S|${i}|${stableStringify(stripIds(omit(s, ["id", "blocks"])))}`);
    s.blocks.forEach((b, j) => {
      if (b.id) out.set(b.id, `${k}|B|${i + 1}|${j}|${stableStringify(stripIds(b))}`);
    });
  });
  return out;
}

/**
 * pid bab `chapterKeys` yang keadaannya diubah kiriman (isi, posisi, atau hilang) -> kunci
 * bab pemiliknya di revisi terbaru. Murni.
 */
export function changedChapterPids(current: StudioDocV2Resolved, merged: StudioDocV2Resolved, chapterKeys: ReadonlySet<string>): Map<string, string> {
  const cur = chaptersByKey(current);
  const next = chaptersByKey(merged);
  const after = new Map<string, string>();
  for (const k of chapterKeys) {
    const c = next.get(k);
    if (c) for (const [pid, sig] of chapterPidStates(c)) after.set(pid, sig);
  }
  const out = new Map<string, string>();
  for (const k of chapterKeys) {
    const c = cur.get(k);
    if (!c) continue;
    for (const [pid, sig] of chapterPidStates(c)) if (after.get(pid) !== sig) out.set(pid, k);
  }
  return out;
}

/** Alamat pid di baris revisi: blok -> alamat C.S.P/F:slot; section -> `k.s`; bab -> kunci. */
export function addressOfPid(rows: StructureRows, pid: string): string | null {
  const b = rows.blocks.find((x) => x.pid === pid);
  if (b) return b.address;
  const s = rows.subsections.find((x) => x.pid === pid);
  if (s) return `${s.chapterKey}.${s.sectionNo}`;
  const c = rows.chapters.find((x) => x.pid === pid);
  return c ? c.chapterKey : null;
}

function compareFindings(a: OverwriteFinding, b: OverwriteFinding): number {
  return (a.address ?? "").localeCompare(b.address ?? "", "en", { numeric: true }) || a.pid.localeCompare(b.pid);
}

// ── Pemeriksaan (DB) ─────────────────────────────────────────────────────

const REVISION_SCOPE_SELECT = { revisionNo: true, changeScope: true, createdBy: true, parentRevisionNo: true } as const;

/**
 * Syarat Prisma: `changeScope` memuat token `token` persis (dipisah `;`), bukan sekadar
 * substring (`chapter:1` tidak cocok dengan `chapter:10`). Prisma meloloskan `%`/`_`.
 */
export function scopeTokenWhere(token: string): Array<{ changeScope: string | { startsWith: string } | { endsWith: string } | { contains: string } }> {
  return [
    { changeScope: token },
    { changeScope: { startsWith: `${token};` } },
    { changeScope: { endsWith: `;${token}` } },
    { changeScope: { contains: `;${token};` } },
  ];
}

/**
 * Acuan per lingkup = revisi kiriman terakhir (<= n) yang memuat lingkup itu, atau ingest utuh
 * tanpa `changeScope`; 0 bila tidak ada. Setara `referenceRevision` atas seluruh riwayat:
 * token `chapter:`/`slot:` hanya ditulis revisi kiriman. Satu baca satu baris per lingkup.
 */
async function scopeReferences(tx: SubmitTx, documentId: string, n: number, scopes: readonly string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const scope of scopes) {
    const row = tx.get<{ revision_no: number }>(
      `SELECT revision_no FROM revision WHERE document_id = ? AND revision_no <= ? AND (change_scope IS NULL OR ${SCOPE_TOKEN_SQL})
        ORDER BY revision_no DESC LIMIT 1`,
      [documentId, n, scope],
    );
    out.set(scope, row ? Number(row.revision_no) : 0);
  }
  return out;
}

export interface OverwriteCheckInput {
  documentId: string;
  latestRevisionNo: number;
  baseRevisionNo?: number;
  current: StudioDocV2Resolved;
  merged: { doc: StudioDocV2Resolved; scopes: readonly string[] };
  prevRows: StructureRows;
  /** Slot berulang (bab/lampiran) menurut tata letak kerangka. */
  isRepeatableSlot: (slotKey: string) => boolean;
}

/** Pemilik pid yang sudah dihapus sunting, dibaca dari baris revisi induk revisi sunting itu. */
async function deletedOwners(
  tx: SubmitTx,
  documentId: string,
  items: ReadonlyArray<{ pid: string; parent: number }>,
): Promise<Map<string, { scope: string; address: string | null }>> {
  const out = new Map<string, { scope: string; address: string | null }>();
  if (items.length === 0) return out;
  const parents = [...new Set(items.map((i) => i.parent))];
  const revs = tx
    .all<{ id: string; revision_no: number }>(`SELECT id, revision_no FROM revision WHERE document_id = ? AND revision_no IN (${inList(parents)})`, [documentId, ...parents])
    .map((r) => ({ id: r.id, revisionNo: Number(r.revision_no) }));
  const revIdOf = new Map(revs.map((r) => [r.revisionNo, r.id]));
  const pids = items.map((i) => i.pid);
  const idents = tx.all<{ id: string; pid: string }>(`SELECT id, pid FROM doc_identity WHERE document_id = ? AND pid IN (${inList(pids)})`, [documentId, ...pids]);
  const identOf = new Map(idents.map((i) => [i.pid, i.id]));
  const revIds = [...revIdOf.values()];
  const identIds = [...identOf.values()];
  if (revIds.length === 0 || identIds.length === 0) return out;
  const both = [...revIds, ...identIds];
  const inRev = `revision_id IN (${inList(revIds)}) AND identity_id IN (${inList(identIds)})`;
  const blocks = tx
    .all<{ revision_id: string; identity_id: string; address: string | null; chapter_key: string | null; slot_key: string }>(
      `SELECT b.revision_id, b.identity_id, b.address, c.chapter_key, s.slot_key FROM doc_block b
         LEFT JOIN doc_chapter c ON c.id = b.chapter_id JOIN doc_section s ON s.id = b.doc_section_id
        WHERE b.${inRev.replace(" AND identity_id", " AND b.identity_id")}`,
      both,
    )
    .map((r) => ({ revisionId: r.revision_id, identityId: r.identity_id, address: r.address, chapter: r.chapter_key === null ? null : { chapterKey: r.chapter_key }, docSection: { slotKey: r.slot_key } }));
  const subs = tx
    .all<{ revision_id: string; identity_id: string; section_no: number; chapter_key: string }>(
      `SELECT s.revision_id, s.identity_id, s.section_no, c.chapter_key FROM doc_subsection s JOIN doc_chapter c ON c.id = s.chapter_id
        WHERE s.${inRev.replace(" AND identity_id", " AND s.identity_id")}`,
      both,
    )
    .map((r) => ({ revisionId: r.revision_id, identityId: r.identity_id, sectionNo: Number(r.section_no), chapter: { chapterKey: r.chapter_key } }));
  const chapters = tx
    .all<{ revision_id: string; identity_id: string; chapter_key: string }>(`SELECT revision_id, identity_id, chapter_key FROM doc_chapter WHERE ${inRev}`, both)
    .map((r) => ({ revisionId: r.revision_id, identityId: r.identity_id, chapterKey: r.chapter_key }));
  for (const it of items) {
    const revId = revIdOf.get(it.parent);
    const identId = identOf.get(it.pid);
    if (!revId || !identId) continue;
    const b = blocks.find((x) => x.revisionId === revId && x.identityId === identId);
    if (b) {
      out.set(it.pid, { scope: b.chapter ? `chapter:${b.chapter.chapterKey}` : `slot:${b.docSection.slotKey}`, address: b.address });
      continue;
    }
    const s = subs.find((x) => x.revisionId === revId && x.identityId === identId);
    if (s) {
      out.set(it.pid, { scope: `chapter:${s.chapter.chapterKey}`, address: `${s.chapter.chapterKey}.${s.sectionNo}` });
      continue;
    }
    const c = chapters.find((x) => x.revisionId === revId && x.identityId === identId);
    if (c) out.set(it.pid, { scope: `chapter:${c.chapterKey}`, address: c.chapterKey });
  }
  return out;
}

/** pid bab berkunci `key` di revisi `revisionNo` (untuk deteksi `renumberChapters`). */
async function chapterPidAt(tx: SubmitTx, documentId: string, revisionNo: number, key: string): Promise<string | null> {
  const row = tx.get<{ pid: string }>(
    `SELECT i.pid FROM doc_chapter c JOIN revision r ON r.id = c.revision_id JOIN doc_identity i ON i.id = c.identity_id
      WHERE c.chapter_key = ? AND r.document_id = ? AND r.revision_no = ? LIMIT 1`,
    [key, documentId, revisionNo],
  );
  return row?.pid ?? null;
}

/** Temukan pid yang akan tertimpa (tanpa melempar). Kosong = aman. */
export async function findPatchedOverwrites(tx: SubmitTx, input: OverwriteCheckInput): Promise<OverwriteFinding[]> {
  const n = input.latestRevisionNo;
  const base = input.baseRevisionNo;
  // Revisi dasar tidak sah -> biarkan cek dasar (§9.2) melempar REVISION_NOT_FOUND.
  if (base !== undefined && (!Number.isInteger(base) || base < 1 || base > n)) return [];
  if (base === n) return [];
  const chapterKeys = new Set(input.merged.scopes.filter((s) => s.startsWith("chapter:")).map((s) => s.slice("chapter:".length)));
  const slotKeys = input.merged.scopes
    .filter((s) => s.startsWith("slot:"))
    .map((s) => s.slice("slot:".length))
    .filter((k) => !input.isRepeatableSlot(k));
  if (chapterKeys.size === 0 && slotKeys.length === 0) return [];

  const touchedScopes = [...[...chapterKeys].map((k) => `chapter:${k}`), ...slotKeys.map((k) => `slot:${k}`)];
  const refs = base !== undefined ? null : await scopeReferences(tx, input.documentId, n, touchedScopes);
  const refOf = (scope: string): number => (base !== undefined ? base : (refs?.get(scope) ?? 0));
  const minRef = Math.min(...touchedScopes.map(refOf));

  // Hanya revisi sunting/renumber sesudah acuan terkecil: sunting <= minRef tidak pernah > acuan lingkup mana pun.
  void REVISION_SCOPE_SELECT;
  const revs: RevisionScopeRow[] = tx
    .all<ScopeRowRaw>(
      `SELECT revision_no, change_scope, created_by, parent_revision_no FROM revision
        WHERE document_id = ? AND revision_no > ? AND revision_no <= ? AND (instr(change_scope, 'pid:') > 0 OR ${SCOPE_TOKEN_SQL})
        ORDER BY revision_no ASC`,
      [input.documentId, minRef, n, RENUMBER_SCOPE],
    )
    .map(scopeRowOf);
  const edits = lastPidEdits(revs, n);
  const renumbers = revs.filter((r) => parseScopes(r.changeScope).includes(RENUMBER_SCOPE));
  if (edits.size === 0 && renumbers.length === 0) return [];

  const findings = new Map<string, OverwriteFinding>();
  const add = (pid: string, scope: string, address: string | null, rev: number, by: string | null) => {
    const prev = findings.get(pid);
    if (!prev || prev.editedInRevision < rev) findings.set(pid, { pid, address, editedInRevision: rev, editedBy: by, scope, referenceRevisionNo: refOf(scope) });
  };

  // (a) pid bab yang diubah kiriman dan disunting sesudah acuan.
  if (chapterKeys.size > 0 && edits.size > 0) {
    for (const [pid, key] of changedChapterPids(input.current, input.merged.doc, chapterKeys)) {
      const e = edits.get(pid);
      const scope = `chapter:${key}`;
      if (e && e.rev > refOf(scope)) add(pid, scope, addressOfPid(input.prevRows, pid), e.rev, e.by);
    }
  }
  // (b) slot tak-berulang diganti utuh: setiap pid slot yang disunting sesudah acuan.
  for (const slotKey of slotKeys) {
    const scope = `slot:${slotKey}`;
    for (const row of input.prevRows.blocks) {
      if (row.slotKey !== slotKey || row.chapterKey !== null) continue;
      const e = edits.get(row.pid);
      if (e && e.rev > refOf(scope)) add(row.pid, scope, row.address, e.rev, e.by);
    }
  }
  // (c) pid yang DIHAPUS sunting sesudah acuan di bab/slot yang diubah kiriman.
  const active = new Set<string>([...input.prevRows.blocks.map((b) => b.pid), ...input.prevRows.subsections.map((s) => s.pid), ...input.prevRows.chapters.map((c) => c.pid)]);
  const gone = [...edits].filter(([pid, e]) => !active.has(pid) && e.rev > minRef && e.parent !== null).map(([pid, e]) => ({ pid, parent: e.parent as number }));
  if (gone.length > 0) {
    const owners = await deletedOwners(tx, input.documentId, gone);
    const touched = new Set(touchedScopes);
    for (const { pid } of gone) {
      const o = owners.get(pid);
      const e = edits.get(pid);
      if (o && e && touched.has(o.scope) && e.rev > refOf(o.scope)) add(pid, o.scope, o.address, e.rev, e.by);
    }
  }
  // (d) kunci bab sudah diganti `renumberChapters` sesudah acuan: kiriman kunci lama akan membuat bab ganda.
  if (renumbers.length > 0) {
    const currentKeys = chaptersByKey(input.current);
    for (const key of chapterKeys) {
      if (currentKeys.has(key)) continue;
      const scope = `chapter:${key}`;
      const ref = refOf(scope);
      const last = [...renumbers].reverse().find((r) => r.revisionNo > ref);
      if (!last || ref < 1) continue;
      const pid = await chapterPidAt(tx, input.documentId, ref, key);
      const now = pid ? input.prevRows.chapters.find((c) => c.pid === pid) : undefined;
      if (pid && now && now.chapterKey !== key) add(pid, scope, now.chapterKey, last.revisionNo, last.createdBy);
    }
  }
  return [...findings.values()].sort(compareFindings);
}

/** Teks awam untuk diteruskan agen ke controller-nya. */
export function overwriteForwardText(documentId: string, findings: readonly OverwriteFinding[], latestRevisionNo: number): string {
  const where = findings
    .slice(0, 5)
    .map((f) => f.address ?? f.pid)
    .join(", ");
  const more = findings.length > 5 ? ` dan ${findings.length - 5} lainnya` : "";
  return (
    `Kiriman belum disimpan: ${findings.length} paragraf (${where}${more}) sudah disunting setelah kiriman terakhir bagian ini, ` +
    `dan kiriman ini akan menghapus suntingan tersebut. Baca isi terkini lewat GET /api/studio/documents/${documentId}/content, ` +
    `gabungkan perubahan Anda dengan isi itu, lalu kirim ulang dengan baseRevisionNo ${latestRevisionNo}.`
  );
}

/** 409 `SCOPE_CONFLICT` bila kiriman akan menimpa suntingan PATCH sesudah acuan lingkupnya. */
export async function assertNoPatchedOverwrite(tx: SubmitTx, input: OverwriteCheckInput): Promise<void> {
  const findings = await findPatchedOverwrites(tx, input);
  if (findings.length === 0) return;
  const n = input.latestRevisionNo;
  const latestEdit = findings.reduce((a, b) => (b.editedInRevision > a.editedInRevision ? b : a));
  const scopes = [...new Set(findings.map((f) => f.scope))];
  const first = findings[0];
  const list = findings
    .slice(0, 5)
    .map((f) => `${f.pid}${f.address ? ` (${f.address})` : ""} rev ${f.editedInRevision}`)
    .join(", ");
  throw new StudioEngineError(
    "SCOPE_CONFLICT",
    `Kiriman akan menimpa ${findings.length} pid yang disunting lewat PATCH setelah revisi ${first.referenceRevisionNo} (${list}${findings.length > 5 ? ", ..." : ""}); ` +
      `baca isi terkini lewat GET /api/studio/documents/${input.documentId}/content, gabungkan, lalu kirim ulang dengan baseRevisionNo ${n}`,
    {
      scope: first.scope,
      reason: OVERWRITE_REASON,
      baseRevisionNo: input.baseRevisionNo ?? null,
      referenceRevisionNo: first.referenceRevisionNo,
      latestRevisionNo: n,
      changedInRevisionNo: latestEdit.editedInRevision,
      changedBy: latestEdit.editedBy,
      overwrittenPids: findings.map(({ pid, address, editedInRevision, editedBy }) => ({ pid, address, editedInRevision, editedBy })),
      ...(scopes.length > 1 ? { conflictingScopes: scopes } : {}),
      readContent: `GET /api/studio/documents/${input.documentId}/content`,
      forwardToController: overwriteForwardText(input.documentId, findings, n),
    },
  );
}
