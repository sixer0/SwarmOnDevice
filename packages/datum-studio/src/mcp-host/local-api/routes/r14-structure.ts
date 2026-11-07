/**
 * R14 `/api/studio/documents/[id]/structure` (SR-22; register 03 §12 R14,
 * blueprint 05 §2.6, §2.11).
 *
 * GET   `?rev=n` -> 200 `{ revisionNo, skeleton: NormSkeletonV2 | null, order,
 *       outlines, meta, templateVersion: { slug, versionNo }, completeness }`.
 *       Dibaca dari snapshot `studio.norm/v2` revisi; revisi v1 (tanpa
 *       kerangka tersimpan) -> `skeleton: null`, `order: []`, `outlines: {}`.
 *       404 `DOCUMENT_NOT_FOUND` / `REVISION_NOT_FOUND`.
 * PATCH `{ op, baseRevisionNo, change, agentId?, ... }` (E33; D-247: `render` -> 400 SCHEMA_INVALID RENDER_FIELD):
 *       `reorder {order}`, `omitSlot {slot}`, `restoreSlot {slot, position?}`,
 *       `setOutline {slot?, outline}`, `setMeta {meta}`,
 *       `renumberChapters {slot?, map}` (ADMIN), `templateVersion {versionNo}`
 *       -> 200 `{ revision, addressMap?, completeness }` dari `patchStructure`
 *       (SR-14). 400 `CHANGE_FIELDS_REQUIRED` / `SCHEMA_INVALID`; 403
 *       `FORBIDDEN` (renumber non-ADMIN); 409 `SCOPE_CONFLICT`,
 *       `DOC_NUMBER_EXISTS`; 422 `SLOT_*`, `CHAPTER_KEY_INVALID` (layanan).
 *       Tanpa render (D-247): build lewat POST /api/studio/documents/{id}/render.
 *
 * Swarm port (row 31b): clone C/src/app/api/studio/documents/[id]/structure/route.ts (sha256 in
 * implementation/NN_row31b_revisions_port.md). Changes: `next/server`, `require-session`,
 * `getStudioCaller` -> ../shims (row 31: the caller is the MCP session's, a body `agentId` is ignored);
 * `isAdminCaller` from templates/access (its defining module); route-kit and `_lib` paths re-pointed
 * (`_lib/revision` = row 31's ./structure-revision). Bodies verbatim.
 */
import type { NextRequest } from "../shims";
import { getStudioCaller, requireSession } from "../shims";
import { schemaInvalidMessage, type DocMeta, type NormDocSnapshot, type NormDocSnapshotV2, type OutlineEntryV2, type ChangeV2 } from "@/lib/studio/contract";
import { CHANGE_FIELD_MAX } from "@/lib/studio/services/revisions";
import { isAdminCaller } from "@/lib/studio/services/templates/access";
import { apiLog, checkRenderRate, isPlainObject, json, readJsonObject, reject, reqCtx, isPlausibleId, withQuotaHeaders, type ReqCtx } from "@/lib/studio/http";
import { failFrom } from "../route-kit";
import { parseStructurePatch } from "./r14-patch-body";
import { completenessOf, loadRevision, revParam, SR22_LOG_SOURCE, type LoadedRevision } from "./structure-revision";
import { resolvePatchStructure } from "./r14-service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ROUTE = "/api/studio/documents/[id]/structure";

type Params = { params: Promise<{ id: string }> };

function isSnapshotV2(s: unknown): s is NormDocSnapshotV2 {
  return isPlainObject(s) && s.schema === "studio.norm/v2" && isPlainObject(s.skeleton) && Array.isArray(s.skeleton.slots);
}

/** Proyeksi GET dari snapshot revisi (lihat kepala berkas). */
function structureView(loaded: LoadedRevision) {
  const snap = loaded.revision.snapshot;
  let skeleton: NormDocSnapshotV2["skeleton"] | null = null;
  let order: string[] = [];
  const outlines: Record<string, OutlineEntryV2[] | null> = {};
  let meta: DocMeta | null = null;

  if (isSnapshotV2(snap)) {
    skeleton = snap.skeleton;
    const live = skeleton.slots.filter((s) => s.active && !s.omitted && s.position > 0).sort((a, b) => a.position - b.position);
    order = live.map((s) => s.slotKey);
    const sections = (isPlainObject(snap.source?.sections) ? snap.source.sections : {}) as Record<string, unknown>;
    for (const s of live) {
      if (!s.repeatable) continue;
      const payload = sections[s.slotKey];
      const outline = isPlainObject(payload) && Array.isArray(payload.outline) ? (payload.outline as OutlineEntryV2[]) : null;
      outlines[s.slotKey] = outline;
    }
    meta = snap.source?.meta ?? snap.doc?.meta ?? null;
  } else if (isPlainObject(snap) && isPlainObject((snap as unknown as NormDocSnapshot).doc)) {
    meta = (snap as unknown as NormDocSnapshot).doc.meta ?? null;
  }
  return { skeleton, order, outlines, meta };
}

export async function GET(req: NextRequest, { params }: Params) {
  const denied = await requireSession(req);
  if (denied) return denied;
  const ctx = reqCtx(req, ROUTE, SR22_LOG_SOURCE);
  const { id } = await params;
  const rev = revParam(req);
  if (rev === null) return reject(ctx, "REVISION_NOT_FOUND", "Revision not found", undefined, { documentId: id });
  try {
    const loaded = await loadRevision(id, rev);
    const view = structureView(loaded);
    return json(
      {
        revisionNo: loaded.revision.revisionNo,
        skeleton: view.skeleton,
        order: view.order,
        outlines: view.outlines,
        meta: view.meta,
        templateVersion: { slug: loaded.templateVersion.slug, versionNo: loaded.templateVersion.versionNo },
        completeness: completenessOf(loaded, ctx),
      },
      200,
      ctx,
    );
  } catch (e) {
    return failFrom(e, ctx, { documentId: id, rev });
  }
}

function nonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

export async function PATCH(req: NextRequest, { params }: Params) {
  const denied = await requireSession(req);
  if (denied) return denied;
  const ctx = reqCtx(req, ROUTE, SR22_LOG_SOURCE);
  // FIX-R40-1 (QH-03): header kuota (bucket render) pada respons apa pun sesudah tagihan; 401 dan
  // penolakan sebelum `checkRenderRate` tanpa tagihan = tanpa header.
  return withQuotaHeaders(ctx, () => patchStructureRoute(req, params, ctx));
}

async function patchStructureRoute(req: NextRequest, params: Params["params"], ctx: ReqCtx): Promise<Response> {
  const { id } = await params;
  if (!isPlausibleId(id)) return reject(ctx, "DOCUMENT_NOT_FOUND", "Document not found");

  const body = await readJsonObject(req, ctx);
  if (!body.ok) return body.response;
  const b = body.value;
  const logCtx: Record<string, unknown> = { documentId: id, op: typeof b.op === "string" ? b.op : null };

  // apa/mengapa/dampak wajib (D-06; register §9.2).
  const ch = isPlainObject(b.change) ? b.change : {};
  const missing = (["what", "why", "impact"] as const).filter((k) => !nonEmptyString(ch[k]));
  if (missing.length > 0) {
    return reject(
      ctx,
      "CHANGE_FIELDS_REQUIRED",
      "change.what, change.why and change.impact are required",
      missing.map((k) => ({ pointer: `/change/${k}`, keyword: "required", message: "must be a non-empty string" })),
      logCtx,
    );
  }
  const change: ChangeV2 = { what: (ch.what as string).trim(), why: (ch.why as string).trim(), impact: (ch.impact as string).trim() };
  const tooLong = (["what", "why", "impact"] as const).filter((k) => change[k].length > CHANGE_FIELD_MAX);
  const extraChange = Object.keys(ch).filter((k) => k !== "what" && k !== "why" && k !== "impact");

  const parsed = parseStructurePatch(b, change);
  const issues = [
    ...tooLong.map((k) => ({ pointer: `/change/${k}`, keyword: "maxLength", message: `must be at most ${CHANGE_FIELD_MAX} characters` })),
    ...extraChange.map((k) => ({ pointer: `/change/${k}`, keyword: "additionalProperties", message: "is not accepted" })),
    ...(parsed.ok ? [] : parsed.issues),
  ];
  if (issues.length > 0 || !parsed.ok) return reject(ctx, "SCHEMA_INVALID", schemaInvalidMessage(issues, "Invalid structure PATCH body"), issues, logCtx);
  const input = parsed.value;
  logCtx.baseRevisionNo = input.baseRevisionNo;

  try {
    const caller = await getStudioCaller(req, parsed.agentId ?? null);
    // Penomoran ulang kunci bab hanya ADMIN (register §9.4, §12 R14).
    if (input.op === "renumberChapters" && !isAdminCaller(caller)) {
      return reject(ctx, "FORBIDDEN", "renumberChapters requires an administrator session", { op: input.op }, { ...logCtx, requester: caller.requester });
    }
    // FIX-1 (S87 M-03): laju per pemanggil (429); tanpa render (D-247).
    const limited = checkRenderRate(caller, ctx);
    if (limited) return limited;
    const patchStructure = resolvePatchStructure();
    const result = await patchStructure(caller, id, input);
    apiLog({
      ...ctx,
      level: "info",
      message: "document structure patched",
      status: 200,
      context: {
        ...logCtx,
        revisionNo: result.revision?.revisionNo ?? null,
        completeness: result.completeness?.status ?? null,
        requester: caller.requester,
      },
    });
    return json(result, 200, ctx);
  } catch (e) {
    return failFrom(e, ctx, logCtx);
  }
}
