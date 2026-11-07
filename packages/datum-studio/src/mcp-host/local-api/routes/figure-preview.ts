/**
 * FIG-03b `POST /api/studio/documents/[id]/figures/preview` — pratinjau SATU figur (chart/diagram), BACA SAJA.
 *
 * Badan `{ pid? | address?, block?, revisionNo?, svg?, agentId?, standalone?, png? }` (lihat `_lib/request.ts`; row 165C:
 * `standalone` = gambar mandiri dengan caption, KUNCI dan SUMBER di SVG, `png` = PNG 300 dpi gambar itu, base64).
 * - 200 `{ documentId, revisionNo, currentRevisionNo, rendered: true, figure }`; `figure` = jenis, kode,
 *   pid/alamat/label, `size { widthMm, heightMm, svgBytes }`, `issues[]` lint/tata letak (`checkId`, `status`,
 *   `detail`, `suggest`; maks 40, jumlah penuh `issueCount`), ringkasan data, dan `svg` hanya bila `svg: true`.
 * - 200 `{ rendered: false, error: { code, message, details? } }` bila MESIN menolak figur (mis. DATUM-33 tinggi
 *   melampaui blok teks, kode chart tak dikenal): itu hasil pratinjau, bukan galat transport.
 * - 400 `SCHEMA_INVALID`, 404 `DOCUMENT_NOT_FOUND`/`REVISION_NOT_FOUND`/`PID_NOT_FOUND`/`ADDRESS_NOT_FOUND`,
 *   422 `BLOCK_TYPE_NOT_ADMITTED` (sasaran bukan figur), 429 `RATE_LIMITED` (bucket render, sama dengan R06/R16 PATCH).
 * - SEC-FIX (D-501): kuota ditagih SEBELUM validasi skema (L-1); kardinalitas data dibatasi SEBELUM render (M-1:
 *   blok inline lewat `maxItems` skema v2 -> 400; spec terselesaikan lewat `_lib/limits.ts` -> 422
 *   `BY_CONSTRUCTION_FAILED` `details.checkId = FIGURE_CAPACITY` + `issues[]`); render di `renderGate()` (503
 *   `RENDER_QUEUE_FULL` + `Retry-After` bila antrean penuh). `figure.rendered` = kode/arah/butir yang dirender.
 *
 * Tanpa tulis apa pun: tanpa job, berkas, atau baris DB (D-322). Galat tanpa stack trace; log JSONL tahan lama
 * lewat `apiLog`/`failure` dengan `x-correlation-id`.
 *
 * Swarm port (row 31c): clone C/src/app/api/studio/documents/[id]/figures/preview/route.ts (sha256 in
 * implementation/57_row31c_render_port.md). Changes: `next/server`, `require-session`, `getStudioCaller`
 * -> ../shims; `_lib/*` paths -> ./figure-preview-{figure,load,request}; `_lib/limits` (a re-export of
 * services/render/figure-limits, SEC-FIX D-505) -> that module directly. Body verbatim.
 */
import type { NextRequest } from "../shims";
import { getStudioCaller, requireSession } from "../shims";
import { schemaInvalidMessage } from "@/lib/studio/contract";
import { isStudioEngineError } from "@/lib/studio/contract/errors";
import { apiLog, checkRenderRate, failure, isPlausibleId, json, readJsonObject, reject, reqCtx, withQuotaHeaders, type ReqCtx } from "@/lib/studio/http";
import { renderGate } from "@/lib/studio/services/render";
import { wrapperLangOf } from "@/lib/studio/engine/front/texts";
import { composeInlineBlock, effectiveTemplate, figureCapacityIssues, findFigureBlock, renderResolved, resolveFigure } from "./figure-preview-figure";
import { capacityMessage } from "@/lib/studio/services/render/figure-limits";
import { loadFigureContext } from "./figure-preview-load";
import { parsePreviewBody } from "./figure-preview-request";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const FIGURE_PREVIEW_ROUTE = "/api/studio/documents/[id]/figures/preview";
const FIGURE_PREVIEW_LOG_SOURCE = "studio.api.fig03b";

type Params = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, { params }: Params) {
  const denied = await requireSession(req);
  if (denied) return denied;
  const ctx = reqCtx(req, FIGURE_PREVIEW_ROUTE, FIGURE_PREVIEW_LOG_SOURCE);
  return withQuotaHeaders(ctx, () => preview(req, params, ctx));
}

async function preview(req: NextRequest, params: Params["params"], ctx: ReqCtx): Promise<Response> {
  const { id } = await params;
  if (!isPlausibleId(id)) return reject(ctx, "DOCUMENT_NOT_FOUND", "Document not found");
  const body = await readJsonObject(req, ctx);
  if (!body.ok) return body.response;
  const agentId = body.value.agentId;
  if (agentId !== undefined && typeof agentId !== "string") {
    return reject(ctx, "SCHEMA_INVALID", "agentId harus string", [{ pointer: "/agentId", keyword: "type", message: "must be string" }], { documentId: id });
  }

  try {
    // SEC-FIX L-1: tagih kuota (bucket render) SEBELUM validasi skema blok (ajv atas badan s.d. 5 MiB), sama dengan
    // R16 PATCH: banjir badan tidak sah kena 429.
    const caller = await getStudioCaller(req, typeof agentId === "string" ? agentId : null);
    const limited = checkRenderRate(caller, ctx);
    if (limited) return limited;
    const parsed = parsePreviewBody(body.value);
    if (!parsed.ok) return reject(ctx, "SCHEMA_INVALID", schemaInvalidMessage(parsed.issues, "Invalid figure preview body"), parsed.issues, { documentId: id });
    const r = parsed.value;
    // Row 165C (F56-3): `standalone` / `png` = the stand-alone figure of the original Studio (figure-preview-figure.ts).
    const logCtx = { documentId: id, pid: r.pid ?? null, address: r.address ?? null, inline: r.block !== undefined, revisionNo: r.revisionNo ?? null, standalone: r.standalone, png: r.png };
    const fc = await loadFigureContext(id, r.revisionNo);
    const target = r.pid !== undefined || r.address !== undefined ? findFigureBlock(fc.snapshot, { pid: r.pid, address: r.address }) : null;
    const block = r.block !== undefined ? composeInlineBlock(fc.snapshot, r.block, target) : target;
    if (block === null) return reject(ctx, "SCHEMA_INVALID", "give pid, address, or block", [{ pointer: "/pid", keyword: "required", message: "give pid, address, or block" }], logCtx);
    const head = { documentId: fc.documentId, revisionNo: fc.revisionNo, currentRevisionNo: fc.currentRevisionNo };
    const t0 = Date.now();
    try {
      const resolved = await resolveFigure(block);
      // SEC-FIX M-1: kardinalitas dicek SEBELUM render (figur tersimpan, rujukan artefak, produk/total) -> 422 cepat.
      const over = figureCapacityIssues(resolved);
      if (over.length > 0) return reject(ctx, "BY_CONSTRUCTION_FAILED", capacityMessage(resolved.type, over), { checkId: "FIGURE_CAPACITY", issues: over }, { ...logCtx, revisionNo: fc.revisionNo });
      const tpl = effectiveTemplate(fc.template, fc.snapshot);
      // Render lewat antrean render berbatas proses (sama dengan R08 ?preview=html): penuh -> 503 RENDER_QUEUE_FULL.
      const figure = await renderGate().run(async () => renderResolved(resolved, tpl, { inline: r.block !== undefined, withSvg: r.svg, lang: wrapperLangOf(fc.snapshot.doc.meta), standalone: r.standalone, png: r.png }));
      apiLog({
        ...ctx,
        level: "info",
        message: "figure previewed",
        status: 200,
        context: { ...logCtx, revisionNo: fc.revisionNo, type: figure.type, code: figure.code, renderedCode: figure.rendered?.code ?? null, issueCount: figure.issueCount, durationMs: Date.now() - t0, requester: caller.requester },
      });
      return json({ ...head, rendered: true, figure }, 200, ctx);
    } catch (e) {
      if (!isStudioEngineError(e) || e.httpStatus >= 500) throw e;
      apiLog({ ...ctx, level: "warn", message: `figure preview rejected by engine: ${e.code}`, code: e.code, status: 200, context: { ...logCtx, revisionNo: fc.revisionNo } });
      const error = { code: e.code, message: e.message, ...(e.details !== undefined ? { details: e.details } : {}) };
      return json({ ...head, rendered: false, target: { pid: block.pid ?? null, address: block.address, type: block.type }, error }, 200, ctx);
    }
  } catch (e) {
    return failure(e, ctx, { context: { documentId: id } });
  }
}
