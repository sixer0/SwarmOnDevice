/**
 * R15 `/api/studio/documents/[id]/completeness` (SR-22; register 03 §12 R15,
 * §8.4; blueprint 05 §2.6, D-131 butir 3).
 *
 * GET `?rev=n` -> 200 `{ documentId, completeness: CompletenessReportV2 }`
 * (revisi bawaan = `currentRevisionNo`). Laporan dibaca dari
 * `StudioRevision.completenessReport` (ditulis layanan kiriman/sunting di
 * dalam kunci, SR-11/SR-13/SR-14); revisi v1 mendapat laporan COMPLETE tanpa
 * slot. 401 tanpa sesi; 404 `DOCUMENT_NOT_FOUND` / `REVISION_NOT_FOUND`.
 */
import type { NextRequest } from "../shims";
import { requireSession } from "../shims";
import { json, reject, reqCtx } from "@/lib/studio/http";
import { failFrom } from "../route-kit";
import { completenessOf, loadRevision, revParam, SR22_LOG_SOURCE } from "./structure-revision";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ROUTE = "/api/studio/documents/[id]/completeness";

type Params = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, { params }: Params) {
  const denied = await requireSession(req);
  if (denied) return denied;
  const ctx = reqCtx(req, ROUTE, SR22_LOG_SOURCE);
  const { id } = await params;
  const rev = revParam(req);
  if (rev === null) return reject(ctx, "REVISION_NOT_FOUND", "Revision not found", undefined, { documentId: id });
  try {
    const loaded = await loadRevision(id, rev);
    return json({ documentId: loaded.document.id, completeness: completenessOf(loaded, ctx) }, 200, ctx);
  } catch (e) {
    return failFrom(e, ctx, { documentId: id, rev });
  }
}
