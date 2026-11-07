/**
 * R17 `POST /api/studio/documents/[id]/render` (SR-24; register
 * 03_structural_sections_specs.md §12 R17, blueprint 05 §2.6/§2.11, D-131).
 *
 * Badan `{ scope: "document" | "chapter" | "slot", key?, formats?, figures?, revisionNo? }`.
 * - 200 `{ job: RenderJobDto & { scope, draft }, outputs, completeness, partial,
 *   failedFormats, errors }` + header `X-Studio-Render-Status` (FIX-H1);
 *   `chapter`/`slot` selalu boleh (draf).
 * - 503 `PDF_ENGINE_UNAVAILABLE` `details.stage: "preflight"` + `Retry-After` bila
 *   format efektif memuat pdf dan render-env tidak siap; tanpa job (FIX-H1, D-322).
 *   Urutan seragam apa pun `formats` (FIX-HR2, D-332 C1): 401 -> 404 -> 409
 *   `DOCUMENT_INCOMPLETE`/422 -> 503 preflight; satu gerbang di layanan.
 * - 409 `DOCUMENT_INCOMPLETE` `{ completeness, allowedScopes, forwardToController }`
 *   untuk `scope: "document"` pada revisi INCOMPLETE (contoh E3b).
 * - 404 `ADDRESS_NOT_FOUND`/`REVISION_NOT_FOUND`/`DOCUMENT_NOT_FOUND`, 422 `SLOT_UNKNOWN`,
 *   429 `RATE_LIMITED`, 503 `RENDER_QUEUE_FULL` (dua terakhir + `Retry-After`).
 *
 * Logika ada di `_lib/handler.ts`; berkas ini hanya memasang sesi dan dependensi nyata.
 *
 * Swarm port (row 31c): clone C/src/app/api/studio/documents/[id]/render/route.ts (sha256 in
 * implementation/57_row31c_render_port.md). Changes: `next/server`, `require-session`, `getStudioCaller`
 * -> ../shims (row 31: the caller is the MCP session's, a body `agentId` is ignored); `_lib/*` paths ->
 * ./r17-handler, ./r17-service. Body verbatim.
 */
import type { NextRequest } from "../shims";
import { getStudioCaller, requireSession } from "../shims";
import { assertRenderCapacity, renderQueueRetryAfterSec } from "@/lib/studio/services/render";
import { checkRenderRate, reqCtx } from "@/lib/studio/http";
import { handleRenderPost, RENDER_API_LOG_SOURCE, RENDER_ROUTE, type RenderRouteDeps } from "./r17-handler";
import { resolveRenderScope } from "./r17-service";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

function liveDeps(): RenderRouteDeps {
  return {
    getCaller: (req, agentId) => getStudioCaller(req, agentId),
    checkRate: checkRenderRate,
    assertCapacity: assertRenderCapacity,
    renderScope: resolveRenderScope(),
    retryAfterSec: renderQueueRetryAfterSec,
  };
}

export async function POST(req: NextRequest, { params }: Params) {
  const denied = await requireSession(req);
  if (denied) return denied;
  const ctx = reqCtx(req, RENDER_ROUTE, RENDER_API_LOG_SOURCE);
  const { id } = await params;
  return handleRenderPost(req, id, ctx, liveDeps());
}
