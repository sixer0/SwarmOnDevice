/**
 * R22 `GET /api/studio/search` (DC-16; register 05_document_contract_specs.md §9, §9.2,
 * §9.6 QH-01..QH-06, T2-69).
 *
 * `?q=&mission=&kind=&documentId=&revisionNo=&type=a,b&slotKey=&take=&cursor=`
 * -> 200 `{ hits: SearchHitV2[], nextCursor, query: { q, config: "simple" } }` lewat I66
 * `searchBlocks` (teks penuh paragraf v2 revisi terkini; tiap hit memuat `pid` + `address`).
 * `q` yang menjadi tsquery kosong (hanya tanda baca) -> `hits: []`. `q` tidak pernah
 * menjadi SQL (kueri terparameter di layanan).
 *
 * Urutan galat seragam R21/R22: 401 (`requireSession`, tanpa header kuota) -> 400
 * `SCHEMA_INVALID` (`/query/q` kosong atau melebihi C43.qMax, `revisionNo` tanpa
 * `documentId`, parameter tak dikenal/ganda; ditolak sebelum tagihan, tanpa header kuota)
 * -> 429 `RATE_LIMITED` (bucket `query`, `Retry-After`). Respons sesudah tagihan membawa
 * C48/C49 lewat `withQuotaHeaders` (QH-03).
 *
 * Kebijakan baca = R04 GET (register §9 / AS-2; dinilai DC-41). Tanpa tulis DB.
 *
 * FIX-SEC (D-402, M-1/L-1): dokumen terarsip dikecualikan secara bawaan, `?includeArchived=1`
 * menyertakannya (`0` = bawaan, nilai lain 400); nilai ber-byte NUL (mis. `q=a%00b`) -> 400
 * `SCHEMA_INVALID` sebelum tagihan; setiap 200 menulis log baca terstruktur (`logQueryRead`:
 * `q` dan filter dipotong, jumlah hit, tanpa isi cuplikan).
 */
import type { NextRequest } from "../shims";
import { requireSession } from "../shims";
import { STUDIO_FTS_CONFIG } from "@/lib/studio/contract";
import { getStudioCaller } from "../shims";
import { checkQueryRate, failure, json, reqCtx, withQuotaHeaders, type ReqCtx } from "@/lib/studio/http";
import { logQueryRead, parseSearchQuery, searchBlocks } from "./query-service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ROUTE = "/api/studio/search";

export async function GET(req: NextRequest) {
  const denied = await requireSession(req);
  if (denied) return denied;
  const ctx = reqCtx(req, ROUTE);
  return withQuotaHeaders(ctx, () => getSearch(req, ctx));
}

async function getSearch(req: NextRequest, ctx: ReqCtx): Promise<Response> {
  try {
    const caller = await getStudioCaller(req);
    const filter = parseSearchQuery(new URL(req.url).searchParams);
    const limited = checkQueryRate(caller, ctx);
    if (limited) return limited;
    const result = await searchBlocks(filter, { correlationId: ctx.correlationId });
    logQueryRead({
      correlationId: ctx.correlationId,
      route: ROUTE,
      caller,
      filter,
      resultCount: result.hits.length,
      hasNextCursor: result.nextCursor !== null,
    });
    return json({ ...result, query: { q: filter.q, config: STUDIO_FTS_CONFIG } }, 200, ctx);
  } catch (err) {
    return failure(err, ctx, { op: "GET search", context: { qLength: qLengthOf(req) }, exposeCorrelationId: true });
  }
}

/** Panjang `q` untuk log (isi `q` teks bebas tidak dicatat). */
function qLengthOf(req: NextRequest): number | null {
  const q = new URL(req.url).searchParams.get("q");
  return q === null ? null : q.length;
}
