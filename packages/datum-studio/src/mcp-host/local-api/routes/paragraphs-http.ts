/**
 * Utilitas khusus route SR-23: R16 `paragraphs/[pid]` dan R20 `content`.
 * Folder `_lib` privat (tidak dirutekan App Router).
 *
 * Isi:
 * - sumber log SR-23 dan validasi segmen `[pid]` (C19 `PID_PATTERN`);
 * - parameter kueri `rev` (bentuk R05: bukan bilangan bulat positif -> 404
 *   `REVISION_NOT_FOUND`) dan pemuatan dokumen + revisi;
 * - pencarian identitas pid di satu revisi (M15-M18, baca saja).
 *
 * Helper HTTP umum (log JSONL tahan lama, correlation id, pemetaan galat)
 * ada di `@/lib/studio/http` (read-only).
 */
import { docById, revisionByNo } from "../db";
import { PID_PATTERN, type StudioIdentityKind } from "@/lib/studio/contract";
import { StudioEngineError } from "@/lib/studio/contract/errors";
import { reject, type ReqCtx } from "@/lib/studio/http";

export const API_LOG_SOURCE = "studio.api.sr23";

const PID_RE = new RegExp(PID_PATTERN);

/**
 * Dekode segmen `[pid]` lalu cocokkan C19. Pid sah tidak memuat `%`, jadi
 * dekode dilakukan tepat sekali bila `%` ada. Null = 404 `PID_NOT_FOUND`
 * (pid berbentuk lain tidak mungkin ada di dokumen mana pun).
 */
export function decodePidParam(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 200) return null;
  let s = raw;
  if (s.includes("%")) {
    try {
      s = decodeURIComponent(s);
    } catch {
      return null;
    }
  }
  return PID_RE.test(s) ? s : null;
}

/** `?rev=` absen/kosong -> undefined; bilangan bulat positif -> angka; selain itu null. */
export function parseRevParam(raw: string | null): number | undefined | null {
  if (raw === null || raw === "") return undefined;
  if (!/^[1-9][0-9]{0,8}$/.test(raw)) return null;
  return Number(raw);
}

export interface DocRevision {
  document: { id: string; docNumber: string; currentRevisionNo: number };
  revision: { id: string; revisionNo: number };
}

/**
 * Muat dokumen dan revisi (bawaan revisi terbaru). Respons galat (404
 * `DOCUMENT_NOT_FOUND` / `REVISION_NOT_FOUND`) dikembalikan sebagai `Response`.
 */
export async function loadDocRevision(
  ctx: ReqCtx,
  documentId: string,
  revRaw: string | null,
): Promise<{ ok: true; value: DocRevision } | { ok: false; response: Response }> {
  const rev = parseRevParam(revRaw);
  if (rev === null) {
    return { ok: false, response: reject(ctx, "REVISION_NOT_FOUND", "Revision not found", undefined, { documentId }) };
  }
  const doc = await docById(documentId);
  if (!doc) {
    return { ok: false, response: reject(ctx, "DOCUMENT_NOT_FOUND", "Document not found", undefined, { documentId }) };
  }
  const revisionNo = rev ?? doc.currentRevisionNo;
  const revision = await revisionByNo(documentId, revisionNo);
  if (!revision) {
    return {
      ok: false,
      response: reject(ctx, "REVISION_NOT_FOUND", "Revision not found", undefined, { documentId, revisionNo }),
    };
  }
  return { ok: true, value: { document: doc, revision } };
}

// Swarm port (row 31): the pid-identity helpers below this point in the clone serve R16, which is not
// ported (services/revisions/v2 is not vendored); they are left out.
