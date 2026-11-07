/**
 * Inti R17 `POST /api/studio/documents/[id]/render` (SR-24; D-131, KD-27,
 * register §12 R17 dan §11.3, blueprint 05 §2.6 contoh E3b).
 *
 * Urutan: id -> badan (400 SCHEMA_INVALID) -> pemanggil -> laju per pemanggil
 * (429 RATE_LIMITED, FIX-1/D-134) -> kapasitas antrean (503 RENDER_QUEUE_FULL,
 * D-134/D-135; keduanya membawa `Retry-After`) -> `renderScope` (SR-15).
 *
 * Urutan galat sasaran SERAGAM apa pun `formats` (FIX-HR2, D-332 C1; sama dengan R07):
 * 401 (sesi, `route.ts`) -> 404 DOCUMENT_NOT_FOUND / REVISION_NOT_FOUND -> 409
 * DOCUMENT_INCOMPLETE (lingkup document) / 404 ADDRESS_NOT_FOUND / 422 SLOT_UNKNOWN
 * -> 503 PDF_ENGINE_UNAVAILABLE tahap preflight. Satu gerbang saja, di `renderScope`
 * sesudah `prepareScopeRender`; route tidak lagi menggerbang pdf eksplisit sendiri
 * (dulu FIX-H1/FIX-HZ1: pdf eksplisit dapat menghasilkan 503 sebelum 409).
 *
 * - FIX-H1 (D-321 C1, D-322): format efektif (eksplisit atau bawaan snapshot) memuat
 *   pdf dan render-env tidak siap -> 503 `PDF_ENGINE_UNAVAILABLE` + `Retry-After`,
 *   `details` { stage: "preflight", jobCreated: false, reason, causes[], retryable,
 *   requiresOperatorAction, retryAfterSec, requestedFormats, suggestedFormats,
 *   statusEndpoint, checkedAt }; tidak ada job dibuat.
 * - 200 `{ job, outputs, completeness, partial, failedFormats, errors }` + header
 *   `X-Studio-Render-Status: <status job>`. `partial: true` = job PARTIAL;
 *   `failedFormats` = format yang gagal (huruf besar seperti `job.formats`).
 * - Render penuh pada revisi INCOMPLETE: layanan melempar `DOCUMENT_INCOMPLETE`;
 *   route menegakkan bentuk §11.3 `{ completeness, allowedScopes, forwardToController }`
 *   apa pun bentuk `details` dari layanan (lihat `incompleteDetails`).
 * - Galat layanan lain (404 ADDRESS_NOT_FOUND/REVISION_NOT_FOUND/DOCUMENT_NOT_FOUND,
 *   422 SLOT_UNKNOWN, 403, ...) dipetakan `failure` tanpa stack trace.
 *
 * Dependensi disuntikkan (`RenderRouteDeps`) agar pemetaan galat dapat
 * dibuktikan dengan layanan tiruan tanpa DB; `route.ts` memasang yang nyata.
 *
 * Swarm port (row 31c): clone C/src/app/api/studio/documents/[id]/render/_lib/handler.ts, verbatim apart
 * from the `./request` import path (-> ./r17-request).
 */
import { isStudioEngineError, StudioNotImplemented, type StudioEngineError } from "@/lib/studio/contract/errors";
import type { StudioRenderScopeKind } from "@/lib/studio/contract/enums";
import type { OutputFileDto, RenderJobDto, RenderJobError } from "@/lib/studio/contract/types/api";
import type { CompletenessReportV2, StudioCaller } from "@/lib/studio/contract";
import { apiLog, failure, isPlausibleId, isRecord, json, readJsonObject, reject, withQuotaHeaders, type ReqCtx } from "@/lib/studio/http";
import {
  isPdfPreflightRejection,
  renderOutcomeMarker,
  renderStatusHeaders,
  withRetryAfterHeader,
} from "@/lib/studio/services/render/preflight";
import { parseRenderBody, type RenderScopeRequest } from "./r17-request";

export const RENDER_ROUTE = "/api/studio/documents/[id]/render";
export const RENDER_API_LOG_SOURCE = "studio.api.render";

/** Pesan 409 sesuai contoh E3b (blueprint 05 §2.6). */
export const DOCUMENT_INCOMPLETE_MESSAGE = "Dokumen belum lengkap; render penuh ditolak";
/** Lingkup yang tetap boleh dirender (draf) saat dokumen INCOMPLETE (D-131 butir 2). */
export const INCOMPLETE_ALLOWED_SCOPES: ReadonlyArray<"chapter" | "slot"> = ["chapter", "slot"];

/** Hasil I51 `renderScope` (register §12 R17 respons 200). */
export interface RenderScopeResult {
  job: RenderJobDto & { scope: { kind: StudioRenderScopeKind; key?: string }; draft: boolean };
  outputs: OutputFileDto[];
  completeness: CompletenessReportV2;
  errors?: RenderJobError[];
}

export type RenderScopeFn = (caller: StudioCaller, documentId: string, req: RenderScopeRequest) => Promise<RenderScopeResult>;

export interface RenderRouteDeps {
  getCaller(req: Request, agentId: string | null): Promise<StudioCaller>;
  checkRate(caller: StudioCaller, ctx: ReqCtx): Response | null;
  assertCapacity(): void;
  /** null = SR-15 belum mendarat (seam). */
  renderScope: RenderScopeFn | null;
  retryAfterSec(): number;
}

/** `details` 409 DOCUMENT_INCOMPLETE (§11.3). */
export interface DocumentIncompleteDetails {
  completeness: CompletenessReportV2 | null;
  allowedScopes: Array<"chapter" | "slot">;
  forwardToController: string;
}

function nonEmpty(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v : null;
}

/**
 * Normalkan `details` dari layanan ke bentuk §11.3. Menerima `details` berbentuk
 * `{ completeness, forwardToController?, allowedScopes? }` atau laporan kelengkapan
 * itu sendiri (punya `status` + `missingRequired`). `forwardToController` diambil
 * dari details, lalu dari laporan kelengkapan, lalu dari pesan galat.
 */
export function incompleteDetails(e: StudioEngineError): DocumentIncompleteDetails {
  const d = isRecord(e.details) ? e.details : {};
  let completeness: CompletenessReportV2 | null = null;
  if (isRecord(d.completeness)) completeness = d.completeness as unknown as CompletenessReportV2;
  else if (typeof d.status === "string" && Array.isArray(d.missingRequired)) completeness = d as unknown as CompletenessReportV2;
  const forwardToController =
    nonEmpty(d.forwardToController) ?? nonEmpty(completeness?.forwardToController) ?? nonEmpty(e.message) ?? DOCUMENT_INCOMPLETE_MESSAGE;
  return { completeness, allowedScopes: [...INCOMPLETE_ALLOWED_SCOPES], forwardToController };
}

function isQueueFull(r: RenderScopeResult): boolean {
  const errors = r.job.errors ?? r.errors ?? [];
  return r.outputs.length === 0 && errors.length > 0 && errors.every((x) => x.code === "RENDER_QUEUE_FULL");
}

export async function handleRenderPost(req: Request, rawId: string, ctx: ReqCtx, deps: RenderRouteDeps): Promise<Response> {
  // DC-19 (QH-03): header kuota pada respons apa pun sesudah tagihan bucket; tanpa tagihan = tanpa header.
  return withQuotaHeaders(ctx, () => renderPost(req, rawId, ctx, deps));
}

async function renderPost(req: Request, rawId: string, ctx: ReqCtx, deps: RenderRouteDeps): Promise<Response> {
  if (!isPlausibleId(rawId)) return reject(ctx, "DOCUMENT_NOT_FOUND", "Document not found");
  const documentId = rawId;

  const body = await readJsonObject(req, ctx);
  if (!body.ok) return body.response;
  const parsed = parseRenderBody(body.value);
  if (!parsed.ok) return reject(ctx, "SCHEMA_INVALID", "Invalid render body", parsed.issues, { documentId });
  const request = parsed.request;
  const logCtx = { documentId, scope: request.scope, key: request.key, revisionNo: request.revisionNo, formats: request.formats };

  try {
    const caller = await deps.getCaller(req, parsed.agentId);
    const limited = deps.checkRate(caller, ctx);
    if (limited) return limited;
    deps.assertCapacity();
    // FIX-HR2 (D-332 C1): tanpa gerbang PDF di sini; `renderScope` menggerbang format
    // efektif SESUDAH 404/409/422 sehingga urutan galat tidak bergantung pada `formats`.
    if (!deps.renderScope) throw new StudioNotImplemented("services/render.renderScope (SR-15)");

    let result: RenderScopeResult;
    try {
      result = await deps.renderScope(caller, documentId, request);
    } catch (e) {
      if (isStudioEngineError(e) && e.code === "DOCUMENT_INCOMPLETE") {
        const details = incompleteDetails(e);
        if (!details.completeness) {
          apiLog({ ...ctx, level: "warn", message: "DOCUMENT_INCOMPLETE without completeness report from render service", code: e.code, status: 409, context: logCtx });
        }
        return reject(ctx, "DOCUMENT_INCOMPLETE", DOCUMENT_INCOMPLETE_MESSAGE, details, {
          ...logCtx,
          revisionNoChecked: details.completeness?.revisionNo ?? null,
          missingRequired: details.completeness?.missingRequired ?? null,
        });
      }
      throw e;
    }

    if (isQueueFull(result)) {
      return reject(ctx, "RENDER_QUEUE_FULL", "Render queue is full; retry later", {
        documentId,
        jobId: result.job.id,
        retryAfterSec: deps.retryAfterSec(),
      }, logCtx);
    }

    const errors = result.errors ?? [];
    const marker = renderOutcomeMarker(result.job, result.outputs, errors);
    const incomplete = result.job.status !== "SUCCEEDED";
    apiLog({
      ...ctx,
      level: incomplete ? "warn" : "info",
      message: incomplete ? `scoped render ${result.job.status}` : "scoped render requested",
      ...(incomplete ? { code: errors[0]?.code ?? "RENDER_INCOMPLETE" } : {}),
      status: 200,
      context: {
        ...logCtx,
        jobId: result.job.id,
        jobStatus: result.job.status,
        draft: result.job.draft,
        completeness: result.completeness?.status ?? null,
        requester: caller.requester,
        ...(incomplete ? { failedFormats: marker.failedFormats, errorCodes: errors.map((x) => x.code) } : {}),
      },
    });
    return json(
      { job: result.job, outputs: result.outputs, completeness: result.completeness, ...marker, errors },
      200,
      ctx,
      renderStatusHeaders(result.job),
    );
  } catch (e) {
    if (isPdfPreflightRejection(e)) {
      const d = e.details;
      const res = reject(ctx, "PDF_ENGINE_UNAVAILABLE", e.message, d, {
        ...logCtx,
        stage: d.stage,
        causeCodes: d.causes.map((c) => c.code),
        checkedAt: d.checkedAt,
      });
      return withRetryAfterHeader(res, d.retryAfterSec);
    }
    return failure(e, ctx, { op: "POST render", context: logCtx });
  }
}
