/**
 * Riwayat per pid dan peta alamat antar revisi (SR-14; register 03 §10
 * "Riwayat", blueprint §2.10 `GET …/paragraphs/[pid]?history=1`).
 *
 * Swarm patch (row 31b, Prisma cut as row 109; 01_specs_studio.md §1.2): the default client
 * `db = prisma` becomes "the caller's store job, else a read job of its own" (`readWith`); the one
 * revision read is SQL. `addressMapOf` / `addressOfPid` are unchanged.
 */
import { dateOf, readWith } from "../../_swarm-store";
import { StudioEngineError } from "../../../contract/errors";
import { identityByPid, identityTimeline, type Db } from "./rows";

/** Bentuk minimum baris revisi (cocok dengan `StructureRows` SR-10). */
export interface AddressRows {
  chapters: ReadonlyArray<{ pid: string; chapterKey: string }>;
  subsections: ReadonlyArray<{ pid: string; chapterKey: string; sectionNo: number }>;
  blocks: ReadonlyArray<{ pid: string; address: string | null; artifactLabel: string | null }>;
}

/** Entri riwayat (`PidHistoryEntry`, tipe internal modul pemilik, register §0.1). */
export interface PidHistoryEntry {
  revisionNo: number;
  changeScope: string | null;
  by: string;
  at: string;
  contentSha256: string | null;
  address: string | null;
  retired: boolean;
}

/**
 * Riwayat identitas: satu entri per revisi tempat identitas muncul, berubah isi
 * (sha), berpindah alamat/induk, atau dipensiunkan. Urut naik.
 * 404 PID_NOT_FOUND bila pid tidak pernah ada di dokumen.
 */
export async function pidHistory(documentId: string, pid: string, db?: Db): Promise<PidHistoryEntry[]> {
  return readWith(db, (q) => pidHistoryIn(q, documentId, pid));
}

async function pidHistoryIn(db: Db, documentId: string, pid: string): Promise<PidHistoryEntry[]> {
  const ident = await identityByPid(db, documentId, pid);
  if (!ident) throw new StudioEngineError("PID_NOT_FOUND", `pid ${pid} tidak dikenal di dokumen ini`, { pid });
  const timeline = await identityTimeline(db, documentId, ident, 1);
  const out: PidHistoryEntry[] = [];
  let prevSig: string | null = null;
  for (const at of [...timeline.values()].sort((a, b) => a.revisionNo - b.revisionNo)) {
    const sig = `${at.contentSha256}|${at.parent}|${at.address ?? ""}`;
    if (sig === prevSig) continue;
    prevSig = sig;
    out.push({
      revisionNo: at.revisionNo,
      changeScope: at.changeScope,
      by: at.createdBy,
      at: at.createdAt.toISOString(),
      contentSha256: at.contentSha256,
      address: at.address,
      retired: false,
    });
  }
  if (ident.retiredRevisionNo !== null) {
    const row = db.get<{ revision_no: number; change_scope: string | null; created_by: string; time_created: number }>(
      "SELECT revision_no, change_scope, created_by, time_created FROM revision WHERE document_id = ? AND revision_no = ?",
      [documentId, ident.retiredRevisionNo],
    );
    const rev = row ? { revisionNo: Number(row.revision_no), changeScope: row.change_scope ?? null, createdBy: String(row.created_by), createdAt: dateOf(row.time_created) } : null;
    out.push({
      revisionNo: ident.retiredRevisionNo,
      changeScope: rev?.changeScope ?? null,
      by: rev?.createdBy ?? "",
      at: rev ? rev.createdAt.toISOString() : "",
      contentSha256: null,
      address: null,
      retired: true,
    });
  }
  return out;
}

/**
 * Alamat lama -> baru untuk identitas yang hadir di kedua revisi dan bergeser:
 * alamat blok, label artefak, alamat section (`C.S`), dan kunci bab.
 */
export function addressMapOf(before: AddressRows, after: AddressRows): Record<string, string> {
  const map: Record<string, string> = {};
  const put = (a: string | null | undefined, b: string | null | undefined) => {
    if (a && b && a !== b) map[a] = b;
  };
  const afterBlocks = new Map(after.blocks.map((b) => [b.pid, b]));
  for (const b of before.blocks) {
    const n = afterBlocks.get(b.pid);
    if (!n) continue;
    put(b.address, n.address);
    put(b.artifactLabel, n.artifactLabel);
  }
  const subAddr = (s: { chapterKey: string; sectionNo: number }) => (s.sectionNo === 0 ? null : `${s.chapterKey}.${s.sectionNo}`);
  const afterSubs = new Map(after.subsections.map((s) => [s.pid, s]));
  for (const s of before.subsections) {
    const n = afterSubs.get(s.pid);
    if (n) put(subAddr(s), subAddr(n));
  }
  const afterCh = new Map(after.chapters.map((c) => [c.pid, c]));
  for (const c of before.chapters) {
    const n = afterCh.get(c.pid);
    if (n) put(c.chapterKey, n.chapterKey);
  }
  return map;
}

/** Alamat identitas di baris revisi (blok: alamat M17; section: `C.S`; bab: kunci). */
export function addressOfPid(rows: AddressRows, pid: string): string | null {
  const b = rows.blocks.find((x) => x.pid === pid);
  if (b) return b.address;
  const s = rows.subsections.find((x) => x.pid === pid);
  if (s) return s.sectionNo === 0 ? s.chapterKey : `${s.chapterKey}.${s.sectionNo}`;
  const c = rows.chapters.find((x) => x.pid === pid);
  return c ? c.chapterKey : null;
}
