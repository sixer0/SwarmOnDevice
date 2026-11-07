/**
 * Modul services/render (I41, 01_specs.md §8.2), diisi S51: orkestrator render.
 *
 * - `renderRevision`: StudioRenderJob untuk satu revisi dokumen; DOCX (S20),
 *   PDF dari HTML Studio sendiri lewat op `pdf` render bridge (row 32, studio spec §4),
 *   HTML (S24), figur SVG/PNG 300 dpi (S30/S32/S31 -> S19/S25), lint pasca-render
 *   (S44-S47) -> status rilis per tier (tidak menahan berkas), serah ke
 *   penyimpanan (S52).
 * - `renderArtifact`: artefak mandiri tidak ada di store DATUM Studio (M07) -> 404.
 * - `renderScope` (SR-15, I51): render lingkup DOCUMENT (hanya revisi COMPLETE,
 *   selain itu 409 DOCUMENT_INCOMPLETE), CHAPTER, atau SLOT (draf di
 *   `rev-<n>/bab-<k>/`), lewat orkestrator tanpa DB `pure/renderSnapshot`.
 *
 * Status job: QUEUED -> RUNNING -> SUCCEEDED | PARTIAL | FAILED. Log job
 * (termasuk log render-env/browser, F-020) dipersistenkan di kolom `engine`
 * baris `render_job`. Galat sebelum job dibuat (tidak ditemukan,
 * format tak didukung, RENDER_IN_PROGRESS) dilempar sebagai StudioEngineError.
 *
 * Swarm patch (row 31c; decisions C60/C65): header text above (PDF path, artifacts, store) and two
 * additive exports (`bridgePdfReadiness`, `resetBridgePdfReadiness`, readiness.ts). The store is the
 * DATUM Studio store installed by the host (`./db`, row 109); no Prisma.
 */
import type { RenderOutcome, StudioCaller, StudioOutputFormat } from "../../contract";
import { renderGate } from "./admission";
import { renderArtifactImpl } from "./artifact";
import { renderRevisionImpl } from "./revision";

/** FIX-1 (S87 M-03): setiap job lewat antrean berbatas (503 RENDER_QUEUE_FULL bila penuh). */
export async function renderRevision(
  revisionId: string,
  formats: readonly StudioOutputFormat[],
  caller: StudioCaller,
): Promise<RenderOutcome> {
  return renderGate().run(() => renderRevisionImpl(revisionId, formats, caller));
}

export async function renderArtifact(
  artifactId: string,
  formats: readonly StudioOutputFormat[],
  caller: StudioCaller,
): Promise<RenderOutcome> {
  return renderGate().run(() => renderArtifactImpl(artifactId, formats, caller));
}

// SR-15 (I51): render berlingkup; antrean berbatas di dalam `renderScope`.
export {
  documentIncompleteError,
  DOCUMENT_INCOMPLETE_MESSAGE,
  INCOMPLETE_ALLOWED_SCOPES,
  prepareScopeRender,
  renderScope,
  revisionCompleteness,
  scopeRelDir,
  toRenderScope,
  type RenderScopeDb,
  type RenderScopeRequest,
  type RenderScopeResult,
  type ScopedOutputDto,
  type ScopeRenderPlan,
} from "./scope";
export { draftFileName, draftScopeDir, draftScopeSuffix, type DraftScopeLayout } from "./naming";

// Ekspor tambahan (aditif) untuk route S55/S57 dan uji S74/S75.
export { renderJobToDto } from "./job";
export {
  assertRenderCapacity,
  createRenderGate,
  isQueueFullOutcome,
  renderQueueRetryAfterSec,
  renderGate,
  resetRenderGate,
  RENDER_MAX_CONCURRENT_DEFAULT,
  RENDER_MAX_QUEUED_DEFAULT,
  type RenderGate,
  type RenderGateStats,
} from "./admission";
export { errorCodeOf } from "./common";
export { installRenderLogSinks, JOB_LOG_MAX_ENTRIES, type JobLogEntry } from "./joblog";
export { lintAfterRender, lintArtifact, releaseFor } from "./lint";
export { FORMAT_MIME, normalizeFormats } from "./naming";
// FIX-H1 (D-322): gerbang awal PDF + penanda hasil sebagian R17/R09.
export {
  assertPdfRenderReady,
  isPdfPreflightRejection,
  layCausesOf,
  pdfNotReadyDetails,
  renderOutcomeMarker,
  renderStatusHeaders,
  suggestedFormatsWithoutPdf,
  withRetryAfterHeader,
  PDF_NOT_READY_MESSAGE,
  PDF_PREFLIGHT_RETRY_AFTER_SEC,
  PDF_PREFLIGHT_STAGE,
  RENDER_ENV_STATUS_ENDPOINT,
  RENDER_STATUS_HEADER,
  type PdfNotReadyCause,
  type PdfNotReadyCauseCode,
  type PdfNotReadyDetails,
  type ReadinessFn,
  type RenderOutcomeMarker,
} from "./preflight";
// Swarm (row 31c): PDF readiness = render bridge (preflight default).
export { bridgePdfReadiness, resetBridgePdfReadiness, BRIDGE_READINESS_TTL_MS, type BridgePdfReadiness } from "./readiness";
