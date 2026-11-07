/**
 * Render berlingkup revisi dokumen (SR-15, I51 `renderScope`; blueprint 05
 * §2.6 + §2.9, register 03 §12 R17, §11.3, §15.1; D-131, KC-4, KC-8).
 *
 * Urutan:
 *   1. muat dokumen + revisi (`revisionNo` atau revisi terbaru) -> 404
 *      DOCUMENT_NOT_FOUND / REVISION_NOT_FOUND;
 *   2. gerbang COMPLETE: lingkup DOCUMENT pada revisi INCOMPLETE -> 409
 *      `DOCUMENT_INCOMPLETE` + `{ completeness, allowedScopes, forwardToController }`
 *      (v1 tunduk aturan sama, KC-8). CHAPTER/SLOT selalu boleh, sebagai draf;
 *   3. lingkup divalidasi terhadap snapshot (404 ADDRESS_NOT_FOUND bab tak ada,
 *      422 SLOT_UNKNOWN) SEBELUM job dibuat;
 *   4. nilai efektif per slot (SR-06 `resolveSlotsForVersion`) -> `RenderContext.slots`
 *      (snapshot v2 saja; v1 tanpa peta = jalur lama);
 *   4b. FIX-H1: format efektif memuat PDF dan render-env tidak siap -> 503
 *      `PDF_ENGINE_UNAVAILABLE` (`details.stage: "preflight"`) tanpa job;
 *   5. antrean berbatas (`renderGate`, 503 RENDER_QUEUE_FULL, D-134/D-135) ->
 *      job DB (kolom `scopeKind`/`scopeKey`) -> `renderSnapshot` (IP-43a, D-155);
 *   6. serah ke penyimpanan: render penuh ke `rev-<n>/`, draf ke
 *      `rev-<n>/bab-<k>/` | `lamp-<k>/` | `slot-<slotKey>/` dengan nama DATUM +
 *      akhiran lingkup; baris `StudioOutputFile` diberi `scopeKind/scopeKey/draft`.
 *      Status rilis revisi hanya diperbarui oleh render penuh.
 *
 * Kelengkapan dibaca dari revisi (`completeness` + `completenessReport`, ditulis
 * layanan kiriman saat revisi dibuat; revisi tidak berubah sesudahnya). Revisi
 * lama tanpa laporan mendapat laporan ringkas dari kolom status.
 *
 * Modul DB berat (templat, kerangka) diimpor malas (D-155).
 *
 * Swarm patch (row 31c, Prisma cut as row 109; decisions C60/C65; 01_specs_studio.md §1.2):
 * - `RenderScopeDb` is the store's `StudioTx` (was `Prisma.TransactionClient`); the document and
 *   revision reads are bridge functions in `readWith` jobs (`findDocumentById`, `findRevisionByNo`,
 *   `findTemplateVersionById`); `prepareScopeRender` accepts `null`/`undefined` = own read jobs;
 * - output scope columns: one SQL UPDATE of `output_file` (was `studioOutputFile.updateMany`);
 *   release status: `setRevisionRelease` (was `studioRevision.update`);
 * - PDF: `renderSnapshot` gets no render-env pre-gate (row 32 D32-1); `assertPdfRenderReady` (bridge
 *   readiness, preflight.ts) runs before the queue as before; the old engine queue callback is gone;
 * - a job-log line records the pinned template actually resolved (slug, versionNo, versionId).
 */
import type {
  AnyNormSnapshot,
  CompletenessReportV2,
  LintReport,
  OutputFileDto,
  RenderJobDto,
  RenderJobError,
  RenderRequestV2,
  RenderScope,
  RenderScopeName,
  ResolvedSlot,
  ResolvedTemplate,
  StudioCaller,
  StudioOutputFormat,
  StudioRenderScopeKind,
  StudioTier,
} from "../../contract";
import { CONTRACT_DEFAULT_RENDER_FORMATS } from "../../contract/env";
import { StudioEngineError } from "../../contract/errors";
import { findAssetBySha } from "../images";
import {
  findDocumentById,
  findRevisionByNo,
  findTemplateVersionById,
  inList,
  readWith,
  setRevisionRelease,
  withStudioTx,
  type StudioTx,
} from "../_swarm-store";
import { docDir } from "../storage/paths";
import { renderGate } from "./admission";
import { asAnySnapshot, errorCodeOf, errorMessageOf, handOff } from "./common";
import { createRenderJob, finalStatus, finishRenderJob, releaseRenderJob, renderJobToDto, scopeColumns, type RenderJobHandle } from "./job";
import { draftScopeDir, normalizeFormats, type DraftScopeLayout } from "./naming";
import { assertPdfRenderReady } from "./preflight";
import { pureRequestedFormats, renderSnapshot } from "./pure/render";
import { applyRenderScope } from "./pure/scope";

/** Pesan 409 (blueprint 05 §2.6 contoh E3b). */
export const DOCUMENT_INCOMPLETE_MESSAGE = "Dokumen belum lengkap; render penuh ditolak";
/** Lingkup yang tetap boleh dirender (draf) saat dokumen INCOMPLETE (D-131 butir 2). */
export const INCOMPLETE_ALLOWED_SCOPES: ReadonlyArray<"chapter" | "slot"> = ["chapter", "slot"];

/** Badan R17 setelah validasi route: `RenderRequestV2` dengan `scope` wajib. */
export type RenderScopeRequest = Omit<RenderRequestV2, "scope"> & { scope: RenderScopeName };

export type ScopedOutputDto = OutputFileDto & { draft: boolean; scope: { kind: StudioRenderScopeKind; key?: string } };

/** Hasil I51 (register §12 R17 respons 200; internal modul ini, register §0.1). */
export interface RenderScopeResult {
  job: RenderJobDto & { scope: { kind: StudioRenderScopeKind; key?: string }; draft: boolean };
  outputs: ScopedOutputDto[];
  completeness: CompletenessReportV2;
  errors: RenderJobError[];
  lint?: LintReport;
}

/** Klien baca: transaksi store (`StudioTx`); absen = job baca sendiri (Swarm, row 31c). */
export type RenderScopeDb = StudioTx;

/** Rencana render tervalidasi (tanpa efek samping); dipakai `renderScope` dan asap transaksi-rollback. */
export interface ScopeRenderPlan {
  document: { id: string; docNumber: string; tier: StudioTier; missionFolder: string | null; missionDocKey: string | null };
  revision: { id: string; revisionNo: number; docRev: string; templateVersionId: string; templateSlug: string; templateVersionNo: number };
  scope: RenderScope;
  draft: boolean;
  /** Tata letak berkas draf; absen untuk DOCUMENT. */
  layout?: DraftScopeLayout;
  completeness: CompletenessReportV2;
  snapshot: AnyNormSnapshot;
  template: ResolvedTemplate;
  slots?: ReadonlyMap<string, ResolvedSlot>;
  /** Format diminta (kosong = bawaan snapshot/orkestrator). */
  formats: StudioOutputFormat[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Nama lingkup API (E40) -> lingkup mesin (E27). `key` wajib untuk chapter/slot. */
export function toRenderScope(name: RenderScopeName, key?: string): RenderScope {
  if (name === "document") return { kind: "DOCUMENT" };
  const k = typeof key === "string" ? key.trim() : "";
  if (!k) {
    throw new StudioEngineError("SCHEMA_INVALID", `key is required when scope is ${name}`, {
      issues: [{ pointer: "/key", keyword: "required", message: `required when scope is ${name}` }],
    });
  }
  return name === "chapter" ? { kind: "CHAPTER", key: k } : { kind: "SLOT", key: k };
}

function scopeDto(scope: RenderScope): { kind: StudioRenderScopeKind; key?: string } {
  return scope.kind === "DOCUMENT" ? { kind: "DOCUMENT" } : { kind: scope.kind, key: scope.key };
}

/**
 * Format diminta. KD-41 / AM-15 (DC-20, CQ-2): dokumen ber-contractKind tanpa
 * `formats` dan `figures` -> C40 (HTML) alih-alih bawaan snapshot/orkestrator.
 */
function requestFormats(req: RenderScopeRequest, contractKind: string | null): StudioOutputFormat[] {
  const asked = [...(req.formats ?? []), ...(req.figures ?? [])];
  if (asked.length === 0 && contractKind) return [...CONTRACT_DEFAULT_RENDER_FORMATS];
  return normalizeFormats(asked);
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/**
 * Laporan kelengkapan revisi (T2-60). Status = kolom `StudioRevision.completeness`
 * (sumber kebenaran gerbang); rincian dari `completenessReport` bila ada.
 */
export function revisionCompleteness(
  rev: { revisionNo: number; completeness: string; completenessReport: unknown },
  doc: { id: string; docNumber: string; missionFolder: string | null },
): CompletenessReportV2 {
  const status = rev.completeness === "INCOMPLETE" ? "INCOMPLETE" : "COMPLETE";
  const r = isRecord(rev.completenessReport) ? rev.completenessReport : null;
  const misi = doc.missionFolder ? ` (misi ${doc.missionFolder})` : "";
  const renderStep = `Minta render penuh: POST /api/studio/documents/${doc.id}/render {scope: "document"}`;
  const message =
    typeof r?.message === "string" && r.message
      ? r.message
      : status === "COMPLETE"
        ? `Dokumen ${doc.docNumber} lengkap pada revisi ${rev.revisionNo}; render penuh tersedia.`
        : `Dokumen ${doc.docNumber}${misi} belum lengkap pada revisi ${rev.revisionNo}. Render penuh ditolak; render bab/slot tersedia sebagai draf.`;
  const report: CompletenessReportV2 = {
    status,
    revisionNo: rev.revisionNo,
    fullRenderAllowed: status === "COMPLETE",
    slots: Array.isArray(r?.slots) ? (r.slots as CompletenessReportV2["slots"]) : [],
    chapters: isRecord(r?.chapters) ? (r.chapters as CompletenessReportV2["chapters"]) : {},
    missingRequired: strings(r?.missingRequired),
    nextSteps: r ? strings(r.nextSteps) : status === "COMPLETE" ? [renderStep] : [],
    message,
  };
  if (status === "INCOMPLETE") {
    report.forwardToController =
      typeof r?.forwardToController === "string" && r.forwardToController
        ? r.forwardToController
        : `Dokumen ${doc.docNumber}${misi} belum lengkap pada revisi ${rev.revisionNo}. Rincian isi yang belum ada: GET /api/studio/documents/${doc.id}/completeness. Langkah berikut: lengkapi isi wajib (POST /api/studio/slots, POST /api/studio/chapters), lalu minta render penuh.`;
  }
  return report;
}

/** 409 DOCUMENT_INCOMPLETE dengan details §11.3. */
export function documentIncompleteError(completeness: CompletenessReportV2): StudioEngineError {
  return new StudioEngineError("DOCUMENT_INCOMPLETE", DOCUMENT_INCOMPLETE_MESSAGE, {
    completeness,
    allowedScopes: [...INCOMPLETE_ALLOWED_SCOPES],
    forwardToController: completeness.forwardToController ?? DOCUMENT_INCOMPLETE_MESSAGE,
  });
}

/**
 * Muat + gerbang + validasi lingkup + templat + nilai slot, tanpa job, tanpa
 * tulis. `client` = transaksi store (`StudioTx`) atau kosong (job baca sendiri; Swarm row 31c).
 */
export async function prepareScopeRender(client: RenderScopeDb | null | undefined, documentId: string, req: RenderScopeRequest): Promise<ScopeRenderPlan> {
  const scope = toRenderScope(req.scope, req.key);
  const doc = await readWith(client, (tx) => findDocumentById(tx, documentId));
  if (!doc) throw new StudioEngineError("DOCUMENT_NOT_FOUND", `document ${documentId} not found`, { documentId });
  const revisionNo = req.revisionNo ?? doc.currentRevisionNo;
  const rev = await readWith(client, (tx) => {
    const r = findRevisionByNo(tx, doc.id, revisionNo);
    const tv = r ? findTemplateVersionById(tx, r.templateVersionId) : null;
    return r && tv ? { ...r, templateVersion: tv } : null;
  });
  if (!rev) throw new StudioEngineError("REVISION_NOT_FOUND", `revision ${revisionNo} of document ${doc.id} not found`, { documentId: doc.id, revisionNo });

  const completeness = revisionCompleteness(rev, doc);
  if (scope.kind === "DOCUMENT" && completeness.status === "INCOMPLETE") throw documentIncompleteError(completeness);

  const snapshot = asAnySnapshot(rev.snapshot);
  const scoped = applyRenderScope(snapshot, scope); // 404/422 sebelum job

  const { resolveTemplate } = await import("../templates");
  const template = await resolveTemplate(rev.templateVersion.template.slug, rev.templateVersion.versionNo);
  let slots: ReadonlyMap<string, ResolvedSlot> | undefined;
  if (snapshot.schema === "studio.norm/v2") {
    const { resolveSlotsForVersion } = await import("../skeleton");
    slots = (await resolveSlotsForVersion(rev.templateVersionId, { tier: doc.tier as StudioTier, ...(client ? { db: client } : {}) })).slots;
  }

  return {
    document: { id: doc.id, docNumber: doc.docNumber, tier: doc.tier as StudioTier, missionFolder: doc.missionFolder, missionDocKey: doc.missionDocKey },
    revision: {
      id: rev.id,
      revisionNo: rev.revisionNo,
      docRev: rev.docRev,
      templateVersionId: rev.templateVersionId,
      templateSlug: rev.templateVersion.template.slug,
      templateVersionNo: rev.templateVersion.versionNo,
    },
    scope: scoped.scope,
    draft: scoped.draft,
    ...(scoped.layout ? { layout: scoped.layout } : {}),
    completeness,
    snapshot,
    template,
    ...(slots ? { slots } : {}),
    formats: requestFormats(req, doc.contractKind),
  };
}

/** Direktori relatif keluaran: `rev-<n>` (penuh) atau `rev-<n>/<bab-k|lamp-k|slot-x>` (draf). */
export function scopeRelDir(plan: Pick<ScopeRenderPlan, "document" | "revision" | "layout" | "snapshot">): string {
  const base = docDir({
    missionFolder: plan.document.missionFolder ?? undefined,
    issueDate: plan.snapshot.doc.meta.issueDate,
    docNumber: plan.document.docNumber,
    revisionNo: plan.revision.revisionNo,
  });
  return plan.layout ? `${base}/${draftScopeDir(plan.layout)}` : base;
}

/**
 * I51: render satu lingkup revisi dokumen. Melempar (tanpa job) untuk
 * 404/409/422 dan antrean penuh; galat render tercatat per format di job.
 */
export async function renderScope(caller: StudioCaller, documentId: string, req: RenderScopeRequest): Promise<RenderScopeResult> {
  const plan = await prepareScopeRender(undefined, documentId, req);
  // FIX-H1 (D-322): PDF diminta (eksplisit atau bawaan snapshot) + render-env tidak siap
  // -> 503 PDF_ENGINE_UNAVAILABLE tahap preflight SEBELUM antrean dan job dibuat.
  await assertPdfRenderReady(pureRequestedFormats(plan.formats.length > 0 ? plan.formats : undefined, plan.snapshot));
  return renderGate().run(() => runScopeJob(caller, plan));
}

async function runScopeJob(caller: StudioCaller, plan: ScopeRenderPlan): Promise<RenderScopeResult> {
  const target = { documentId: plan.document.id, revisionId: plan.revision.id, scope: plan.scope };
  const requested = plan.formats.length > 0 ? plan.formats : undefined;
  // Format efektif dihitung sama dengan orkestrator agar baris job memuat format nyata.
  const fmts = pureRequestedFormats(requested, plan.snapshot);
  const job = await createRenderJob(target, fmts, caller.requester);
  const outputs: OutputFileDto[] = [];
  const failed = new Set<StudioOutputFormat>();
  let lint: LintReport | undefined;

  try {
    job.startedAt = new Date();
    job.status = "RUNNING";
    await job.persist({ status: "RUNNING", startedAt: job.startedAt });
    job.log.info("scoped render started", {
      code: "SCOPE_RENDER_STARTED",
      context: { scope: plan.scope, draft: plan.draft, revisionNo: plan.revision.revisionNo, completeness: plan.completeness.status },
    });
    job.log.info("pinned template resolved", {
      code: "TEMPLATE_PINNED",
      context: {
        slug: plan.revision.templateSlug,
        versionNo: plan.revision.templateVersionNo,
        versionId: plan.revision.templateVersionId,
        resolvedVersionId: plan.template.versionId ?? null,
        revisionNo: plan.revision.revisionNo,
      },
    });

    const result = await renderSnapshot(plan.snapshot, plan.template, {
      job,
      tier: plan.document.tier,
      formats: fmts,
      scope: plan.scope,
      draft: plan.draft,
      ...(plan.slots ? { slots: plan.slots } : {}),
      naming: { docNumber: plan.document.docNumber, rev: plan.revision.docRev },
      registerLog: false, // createRenderJob sudah mendaftarkan log job
      assetLookup: async (sha) => {
        const row = await findAssetBySha(sha);
        return row ? { relPath: row.relPath, mime: row.mime } : null;
      },
    });
    lint = result.lint;
    for (const f of result.failed) failed.add(f);

    await storeScopeFiles(job, plan, result, outputs, failed);
  } catch (err) {
    job.addError(errorCodeOf(err, "RENDER_FAILED"), `scoped render failed: ${errorMessageOf(err)}`, undefined, err);
    for (const f of fmts) failed.add(f);
  } finally {
    releaseRenderJob(job);
  }

  const succeeded = fmts.filter((f) => !failed.has(f)).length;
  const row = await finishRenderJob(job, finalStatus(fmts.length, succeeded, job.errors.length));
  const scope = scopeDto(plan.scope);
  return {
    job: { ...renderJobToDto(row), scope, draft: plan.draft },
    outputs: outputs.map((o) => ({ ...o, draft: plan.draft, scope })),
    completeness: plan.completeness,
    errors: [...job.errors],
    ...(lint ? { lint } : {}),
  };
}

async function storeScopeFiles(
  job: RenderJobHandle,
  plan: ScopeRenderPlan,
  result: Awaited<ReturnType<typeof renderSnapshot>>,
  outputs: OutputFileDto[],
  failed: Set<StudioOutputFormat>,
): Promise<void> {
  job.checkAborted("storage");
  let relDir: string;
  try {
    relDir = scopeRelDir(plan);
  } catch (err) {
    job.addError(errorCodeOf(err, "STORAGE_WRITE_FAILED"), `storage directory unavailable: ${errorMessageOf(err)}`, undefined, err);
    for (const f of result.formats) failed.add(f);
    return;
  }
  const verdict = result.lint?.releaseStatus;
  const base = { documentId: plan.document.id, revisionId: plan.revision.id, ...(verdict ? { lintVerdict: verdict } : {}) };
  // Urutan tetap: berkas utama (DOCX, PDF, HTML) lalu figur, sama dengan orkestrator.
  for (const f of result.files) {
    if (failed.has(f.format) && f.role === "PRIMARY") continue;
    const dir = f.role === "FIGURE" ? `${relDir}/figur` : relDir;
    await handOff(
      job,
      { ...base, relDir: dir, role: f.role, fileName: f.fileName, data: f.data, format: f.format, mime: f.mime, ...(f.figureLabel ? { figureLabel: f.figureLabel } : {}) },
      outputs,
      failed,
    );
  }

  // Kolom lingkup berkas (MX06): bawaan DB = DOCUMENT/draft false, jadi hanya draf yang ditulis.
  const ids = outputs.map((o) => o.id);
  if (plan.scope.kind !== "DOCUMENT" && ids.length > 0) {
    try {
      const sc = scopeColumns(plan.scope);
      await withStudioTx(async (tx) => {
        tx.run(`UPDATE output_file SET scope_kind = ?, scope_key = ?, draft = ? WHERE id IN (${inList(ids)})`, [sc.scopeKind, sc.scopeKey, plan.draft ? 1 : 0, ...ids]);
      });
    } catch (err) {
      job.log.error(`output scope columns update failed: ${errorMessageOf(err)}`, { code: "OUTPUT_SCOPE_UPDATE_FAILED", err, context: { outputs: ids.length } });
    }
  }

  // Status rilis revisi hanya dari render penuh (draf tidak menimpa lint revisi).
  if (plan.scope.kind === "DOCUMENT" && result.lint) {
    try {
      const lintJson = JSON.parse(JSON.stringify(result.lint)) as unknown;
      const releaseStatus = result.lint.releaseStatus;
      await withStudioTx(async (tx) => setRevisionRelease(tx, plan.revision.id, releaseStatus, lintJson));
    } catch (err) {
      job.log.error(`revision release status update failed: ${errorMessageOf(err)}`, { code: "REVISION_UPDATE_FAILED", err });
    }
  }
}
