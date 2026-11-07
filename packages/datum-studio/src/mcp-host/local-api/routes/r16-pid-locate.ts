/**
 * Pid identity helpers of R16 `paragraphs/[pid]` (SR-23), the part of clone
 * C/src/app/api/studio/documents/[id]/paragraphs/_lib/http.ts that row 31 left out of ./paragraphs-http.ts.
 *
 * Swarm port (row 31b): `locatePid` reads M15-M18 (`doc_identity`, `doc_block`, `doc_chapter`,
 * `doc_subsection`, `doc_section`) with SQL in local-api/db.ts (`pidIdentity`, `pidBlockAt`,
 * `pidChapterAt`, `pidSubsectionAt`) instead of Prisma; results, error codes and messages unchanged.
 * `findById` verbatim.
 */
import type { StudioIdentityKind } from "@/lib/studio/contract";
import { StudioEngineError } from "@/lib/studio/contract/errors";
import { pidBlockAt, pidChapterAt, pidIdentity, pidSubsectionAt } from "../db";

export interface PidLocation {
  kind: StudioIdentityKind;
  slotKey: string;
  /** Kunci bab (null untuk blok slot tak-berulang). */
  chapterKey: string | null;
  address: string;
  /** Jenis blok; `chapter` / `section` untuk identitas bab / subbab. */
  type: string;
  /** Isi v2 blok tanpa `id` (baris M17); null untuk bab/subbab (diproyeksikan). */
  blockContent: unknown;
}

/**
 * Cari identitas pid aktif pada revisi `revisionNo`. Pid tidak dikenal,
 * belum dibuat pada revisi itu, atau pensiun -> 404 `PID_NOT_FOUND`
 * (`details.retiredRevisionNo` bila pensiun, register §10).
 */
export async function locatePid(
  documentId: string,
  revision: { id: string; revisionNo: number },
  pid: string,
): Promise<PidLocation> {
  const identity = await pidIdentity(documentId, pid);
  if (!identity || identity.createdRevisionNo > revision.revisionNo) {
    throw new StudioEngineError("PID_NOT_FOUND", `Pid ${pid} tidak dikenal pada dokumen ini`, { pid });
  }
  if (identity.retiredRevisionNo !== null && identity.retiredRevisionNo <= revision.revisionNo) {
    throw new StudioEngineError("PID_NOT_FOUND", `Pid ${pid} sudah dipensiunkan pada revisi ${identity.retiredRevisionNo}`, {
      pid,
      retiredRevisionNo: identity.retiredRevisionNo,
    });
  }
  const missing = () =>
    new StudioEngineError("PID_NOT_FOUND", `Pid ${pid} tidak ada pada revisi ${revision.revisionNo}`, {
      pid,
      revisionNo: revision.revisionNo,
    });

  if (identity.kind === "BLOCK") {
    const row = await pidBlockAt(revision.id, pid);
    if (!row) throw missing();
    return {
      kind: "BLOCK",
      slotKey: row.slotKey,
      chapterKey: row.chapterKey,
      address: row.address ?? "",
      type: row.type,
      blockContent: row.content,
    };
  }
  if (identity.kind === "CHAPTER") {
    const row = await pidChapterAt(revision.id, identity.id);
    if (!row) throw missing();
    return {
      kind: "CHAPTER",
      slotKey: row.slotKey,
      chapterKey: row.chapterKey,
      address: row.chapterKey,
      type: "chapter",
      blockContent: null,
    };
  }
  if (identity.kind === "SUBSECTION") {
    const row = await pidSubsectionAt(revision.id, identity.id);
    if (!row) throw missing();
    const key = row.chapterKey;
    return {
      kind: "SUBSECTION",
      slotKey: row.slotKey,
      chapterKey: key,
      // Intro bab (sectionNo 0) tidak punya alamat C.S sendiri (§4.1): pakai alamat bab.
      address: row.sectionNo > 0 ? `${key}.${row.sectionNo}` : key,
      type: "section",
      blockContent: null,
    };
  }
  throw missing();
}

/** Cari objek ber-`id === pid` di dalam proyeksi isi (bab/section/blok). */
export function findById(node: unknown, pid: string, depth = 0): Record<string, unknown> | null {
  if (depth > 64 || node === null || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = findById(item, pid, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  const obj = node as Record<string, unknown>;
  if (obj.id === pid) return obj;
  for (const value of Object.values(obj)) {
    const hit = findById(value, pid, depth + 1);
    if (hit) return hit;
  }
  return null;
}
