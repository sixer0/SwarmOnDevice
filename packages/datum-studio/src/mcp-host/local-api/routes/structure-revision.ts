/**
 * Pembantu baca bersama R14 GET dan R15 GET (SR-22). Folder `_lib` privat
 * (tidak dirutekan App Router).
 *
 * - `loadRevision`: dokumen + revisi (`?rev=n`, bawaan `currentRevisionNo`)
 *   beserta patokan templat. 404 `DOCUMENT_NOT_FOUND` / `REVISION_NOT_FOUND`.
 * - `completenessOf`: `CompletenessReportV2` revisi. Sumber utama = kolom
 *   `StudioRevision.completenessReport` (MX04; register §8.4 "juga isi kolom").
 *   Revisi v1 (kolom null, `completeness` bawaan COMPLETE) mendapat laporan
 *   tanpa slot dengan teks §8.3; revisi INCOMPLETE tanpa laporan = cacat data,
 *   dicatat warn dan dijawab dengan laporan minimal (bukan 500).
 */
import { docById, revisionWithTemplate } from "../db";
import { STUDIO_COMPLETENESS_STATUSES, type CompletenessReportV2, type StudioCompleteness } from "@/lib/studio/contract";
import { StudioEngineError } from "@/lib/studio/contract/errors";
import { apiLog, isPlainObject, isPlausibleId, parsePosInt, type ReqCtx } from "@/lib/studio/http";

export const SR22_LOG_SOURCE = "studio.api.structure";

export interface LoadedRevision {
  document: { id: string; docNumber: string; missionFolder: string | null; missionDocKey: string | null };
  revision: {
    id: string;
    revisionNo: number;
    snapshot: unknown;
    completeness: StudioCompleteness;
    completenessReport: unknown;
    structureSha256: string | null;
    schemaId: string;
  };
  templateVersion: { id: string; slug: string; versionNo: number };
}

/**
 * Nilai `?rev`: undefined = revisi terbaru; null = bentuk salah (404
 * REVISION_NOT_FOUND, sama dengan R05).
 */
export function revParam(req: Request): number | undefined | null {
  const raw = new URL(req.url).searchParams.get("rev");
  if (raw === null || raw === "") return undefined;
  return parsePosInt(raw);
}

/** Melempar StudioEngineError 404 bila dokumen/revisi tidak ada. */
export async function loadRevision(documentId: string, rev: number | undefined): Promise<LoadedRevision> {
  if (!isPlausibleId(documentId)) throw new StudioEngineError("DOCUMENT_NOT_FOUND", "Document not found");
  const doc = await docById(documentId);
  if (!doc) throw new StudioEngineError("DOCUMENT_NOT_FOUND", "Document not found", { documentId });
  const revisionNo = rev ?? doc.currentRevisionNo;
  const found = await revisionWithTemplate(documentId, revisionNo);
  if (!found) throw new StudioEngineError("REVISION_NOT_FOUND", "Revision not found", { documentId, revisionNo });
  const row = { ...found.rev, templateVersion: found.templateVersion };
  return {
    document: { id: doc.id, docNumber: doc.docNumber, missionFolder: doc.missionFolder, missionDocKey: doc.missionDocKey },
    revision: {
      id: row.id,
      revisionNo: row.revisionNo,
      snapshot: row.snapshot,
      completeness: row.completeness as StudioCompleteness,
      completenessReport: row.completenessReport,
      structureSha256: row.structureSha256,
      schemaId: row.schemaId,
    },
    templateVersion: { id: row.templateVersion.id, slug: row.templateVersion.template.slug, versionNo: row.templateVersion.versionNo },
  };
}

function isStoredReport(v: unknown): v is CompletenessReportV2 {
  return (
    isPlainObject(v) &&
    typeof v.status === "string" &&
    (STUDIO_COMPLETENESS_STATUSES as readonly string[]).includes(v.status) &&
    typeof v.revisionNo === "number" &&
    Array.isArray(v.slots) &&
    Array.isArray(v.missingRequired)
  );
}

/** Laporan kelengkapan revisi (lihat kepala berkas). */
export function completenessOf(loaded: LoadedRevision, ctx: ReqCtx): CompletenessReportV2 {
  const { document, revision } = loaded;
  if (isStoredReport(revision.completenessReport)) return revision.completenessReport;

  const n = revision.revisionNo;
  if (revision.completenessReport !== null && revision.completenessReport !== undefined) {
    apiLog({
      ...ctx,
      level: "warn",
      message: "stored completenessReport has an unexpected shape; serving a minimal report",
      code: "COMPLETENESS_REPORT_INVALID",
      context: { documentId: document.id, revisionNo: n },
    });
  }
  if (revision.completeness === "COMPLETE") {
    return {
      status: "COMPLETE",
      revisionNo: n,
      fullRenderAllowed: true,
      slots: [],
      chapters: {},
      missingRequired: [],
      nextSteps: [`Minta render penuh: POST /api/studio/documents/${document.id}/render {scope: "document"}`],
      message: `Dokumen ${document.docNumber} lengkap pada revisi ${n}; render penuh tersedia.`,
    };
  }
  apiLog({
    ...ctx,
    level: "warn",
    message: "INCOMPLETE revision without completenessReport; serving a minimal report",
    code: "COMPLETENESS_REPORT_MISSING",
    context: { documentId: document.id, revisionNo: n },
  });
  return {
    status: "INCOMPLETE",
    revisionNo: n,
    fullRenderAllowed: false,
    slots: [],
    chapters: {},
    missingRequired: [],
    nextSteps: [],
    message: `Dokumen ${document.docNumber} belum lengkap pada revisi ${n}. Render penuh ditolak; render bab/slot tersedia sebagai draf.`,
  };
}
