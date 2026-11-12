/**
 * Pipeline render revisi dokumen (S51, I41 `renderRevision`) = render PENUH
 * (lingkup DOCUMENT) satu revisi.
 *
 * Urutan (deterministik; masukan = snapshot revisi + versi templat yang dipin):
 *   0. gerbang COMPLETE (D-131, KC-8; SR-15): revisi INCOMPLETE -> 409
 *      `DOCUMENT_INCOMPLETE` tanpa job (render bab/slot lewat `renderScope`).
 *   1. job QUEUED -> RUNNING.
 *   2-5. orkestrator tanpa DB `renderSnapshot` (IP-43a, D-155): templat + override
 *      dokumen (S48/S49), figur SVG -> PNG 300 dpi, DOCX (S20) / PDF dari HTML Studio
 *      lewat op `pdf` render bridge (row 32) / HTML (S24), lint pasca-render
 *      -> status rilis per tier (tidak menahan berkas).
 *   6. serah ke penyimpanan (S52) dengan lintVerdict; status rilis revisi diperbarui.
 *
 * Swarm patch (row 31c, Prisma cut as row 109; decisions C60/C65; 01_specs_studio.md §1.2):
 * - the revision + document + pinned template version are read with bridge functions
 *   (`findRevisionById`, `findDocumentById`, `findTemplateVersionById`) in one read job;
 * - the release-status update is `setRevisionRelease` (the only revision columns D-06 lets change);
 * - PDF: no render-env pre-gate is passed to `renderSnapshot` (row 32 D32-1: the bridge handshake at
 *   the PDF step gates; R17 / rerender run `assertPdfRenderReady` before the job); the old engine
 *   queue callback is gone with row 32;
 * - a job-log line records the pinned template (slug, versionNo, versionId) actually resolved, so a
 *   re-render of an old revision shows it kept that revision's template version.
 */
import type { LintReport, OutputFileDto, RenderOutcome, StudioCaller, StudioOutputFormat, StudioTier } from "../../contract";
import { StudioEngineError } from "../../contract/errors";
import {
  findDocumentById,
  findRevisionById,
  findTemplateVersionById,
  readWith,
  setRevisionRelease,
  withStudioTx,
  type StudioDocument,
  type StudioRevision,
  type StudioTemplate,
  type StudioTemplateVersion,
} from "../_swarm-store";
import { findAssetBySha } from "../images";
import { docDir } from "../storage/paths";
import { asAnySnapshot, errorCodeOf, errorMessageOf, handOff } from "./common";
import { createRenderJob, finalStatus, finishRenderJob, releaseRenderJob, renderJobToDto, type RenderJobHandle } from "./job";
import { pureRequestedFormats, renderSnapshot, type PureRenderResult } from "./pure/render";
import { documentIncompleteError, revisionCompleteness } from "./scope";

/** Revisi + dokumen + versi templat yang dipin (bentuk `include` Prisma semula). */
type RevisionRow = StudioRevision & {
  document: StudioDocument;
  templateVersion: StudioTemplateVersion & { template: StudioTemplate };
};

async function loadRevisionRow(revisionId: string): Promise<RevisionRow | null> {
  return readWith(undefined, (tx) => {
    const rev = typeof revisionId === "string" && revisionId.length <= 200 ? findRevisionById(tx, revisionId) : null;
    if (!rev) return null;
    const document = findDocumentById(tx, rev.documentId);
    const templateVersion = findTemplateVersionById(tx, rev.templateVersionId);
    if (!document || !templateVersion) return null;
    return { ...rev, document, templateVersion };
  });
}

export async function renderRevisionImpl(
  revisionId: string,
  formats: readonly StudioOutputFormat[],
  caller: StudioCaller,
): Promise<RenderOutcome> {
  const rev = await loadRevisionRow(revisionId);
  if (!rev) throw new StudioEngineError("REVISION_NOT_FOUND", `revision ${revisionId} not found`, { revisionId });

  // Render penuh hanya untuk revisi COMPLETE (D-131 butir 2; v1 ikut, KC-8).
  if (rev.completeness === "INCOMPLETE") throw documentIncompleteError(revisionCompleteness(rev, rev.document));

  const snapshot = asAnySnapshot(rev.snapshot);
  const fmts = pureRequestedFormats(formats, snapshot);
  const job = await createRenderJob({ documentId: rev.documentId, revisionId: rev.id }, fmts, caller.requester);
  const outputs: OutputFileDto[] = [];
  const failed = new Set<StudioOutputFormat>();
  let lint: LintReport | undefined;

  try {
    lint = await runRevisionJob(job, rev, fmts, outputs, failed);
  } catch (err) {
    const code = errorCodeOf(err, "RENDER_FAILED");
    job.addError(code, `render job failed: ${errorMessageOf(err)}`, undefined, err);
    for (const f of fmts) failed.add(f);
  } finally {
    releaseRenderJob(job);
  }

  const succeeded = fmts.filter((f) => !failed.has(f)).length;
  const row = await finishRenderJob(job, finalStatus(fmts.length, succeeded, job.errors.length));
  return { job: renderJobToDto(row), outputs, errors: [...job.errors], ...(lint ? { lint } : {}) };
}

async function runRevisionJob(
  job: RenderJobHandle,
  rev: RevisionRow,
  fmts: StudioOutputFormat[],
  outputs: OutputFileDto[],
  failed: Set<StudioOutputFormat>,
): Promise<LintReport | undefined> {
  job.startedAt = new Date();
  job.status = "RUNNING";
  await job.persist({ status: "RUNNING", startedAt: job.startedAt });

  // Templat yang dipin revisi (impor malas, D-155).
  const { resolveTemplate } = await import("../templates");
  const tv = rev.templateVersion;
  const pinned = await resolveTemplate(tv.template.slug, tv.versionNo);
  if (pinned.versionId && pinned.versionId !== tv.id) {
    job.log.warn(`resolved template version ${pinned.versionId} differs from pinned ${tv.id}`, { code: "TEMPLATE_VERSION_MISMATCH" });
  }
  job.log.info("pinned template resolved", {
    code: "TEMPLATE_PINNED",
    context: { slug: tv.template.slug, versionNo: tv.versionNo, versionId: tv.id, resolvedVersionId: pinned.versionId ?? null, revisionNo: rev.revisionNo },
  });

  // Langkah 1-5 lewat orkestrator murni (job DB milik layanan; persist oleh layanan).
  const result = await renderSnapshot(asAnySnapshot(rev.snapshot), pinned, {
    job,
    tier: rev.document.tier as StudioTier,
    formats: fmts,
    naming: { docNumber: rev.document.docNumber, rev: rev.docRev, revisionNo: rev.revisionNo }, // row 75 (M-05): ` rev<N>`
    registerLog: false, // createRenderJob sudah mendaftarkan log job
    assetLookup: async (sha) => {
      const row = await findAssetBySha(sha);
      return row ? { relPath: row.relPath, mime: row.mime } : null;
    },
  });
  for (const f of result.failed) failed.add(f);

  // 6. Serah ke penyimpanan (urutan tetap: DOCX, PDF, HTML, figur).
  job.checkAborted("storage");
  await storeRevisionFiles(job, rev, result, outputs, failed);

  // Status rilis revisi (lint pasca-render).
  if (result.lint) {
    try {
      const lintJson = JSON.parse(JSON.stringify(result.lint)) as unknown;
      await withStudioTx(async (tx) => setRevisionRelease(tx, rev.id, result.lint!.releaseStatus, lintJson));
    } catch (err) {
      job.log.error(`revision release status update failed: ${errorMessageOf(err)}`, { code: "REVISION_UPDATE_FAILED", err });
    }
  }
  return result.lint;
}

async function storeRevisionFiles(
  job: RenderJobHandle,
  rev: RevisionRow,
  result: PureRenderResult,
  outputs: OutputFileDto[],
  failed: Set<StudioOutputFormat>,
): Promise<void> {
  let relDir: string;
  try {
    relDir = docDir({
      missionFolder: rev.document.missionFolder ?? undefined,
      issueDate: asAnySnapshot(rev.snapshot).doc.meta.issueDate,
      docNumber: rev.document.docNumber,
      revisionNo: rev.revisionNo,
    });
  } catch (err) {
    job.addError(errorCodeOf(err, "STORAGE_WRITE_FAILED"), `storage directory unavailable: ${errorMessageOf(err)}`, undefined, err);
    for (const f of result.formats) failed.add(f);
    return;
  }
  const verdict = result.lint?.releaseStatus;
  const base = { documentId: rev.documentId, revisionId: rev.id, ...(verdict ? { lintVerdict: verdict } : {}) };
  for (const f of result.files) {
    if (f.role === "PRIMARY" && failed.has(f.format)) continue;
    const dir = f.role === "FIGURE" ? `${relDir}/figur` : relDir;
    await handOff(
      job,
      { ...base, relDir: dir, role: f.role, fileName: f.fileName, data: f.data, format: f.format, mime: f.mime, ...(f.figureLabel ? { figureLabel: f.figureLabel } : {}) },
      outputs,
      failed,
    );
  }
}
