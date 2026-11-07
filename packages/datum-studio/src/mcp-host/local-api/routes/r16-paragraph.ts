/**
 * R16 `/api/studio/documents/[id]/paragraphs/[pid]` (SR-23; blueprint 05 §2.6,
 * register 03 §10 dan §12).
 *
 * GET   `?rev=n&history=1` -> 200 `{ pid, kind, address, type, content (v2 + id),
 *       revisionNo, history? }`. Pid tak dikenal, belum ada pada revisi itu,
 *       atau pensiun -> 404 `PID_NOT_FOUND` (`details.retiredRevisionNo` bila pensiun).
 * PATCH `{ op: PidOp, baseRevisionNo, block?, section?, chapter?,
 *       to?: { before?, after?, section?: { chapterKey, sectionNo, at } },
 *       change: { what, why, impact }, agentId? }` (D-247: `render` -> 400 SCHEMA_INVALID RENDER_FIELD)
 *       -> 200 `{ revision, pid, newPid?, address, addressMap, rebased,
 *       baseRevisionNo, appliedOnRevisionNo, completeness }` (tanpa render; build lewat endpoint render).
 *
 * Route memeriksa transport (sesi, JSON, segmen `[pid]` C19, `agentId` untuk
 * identitas pemanggil). Bentuk badan divalidasi SATU kali oleh layanan revisi
 * (`patchPid`, SR-14): `change` wajib (D-06, 400 `CHANGE_FIELDS_REQUIRED`),
 * `baseRevisionNo`, op, fragmen v2 (`DISPLAY_FIELD`), `to`; juga op per jenis
 * identitas (`PID_OP_KIND`), konflik lingkup (409 `SCOPE_CONFLICT`), pid
 * (404/422), gerbang kepercayaan D-98/D-134. Tanpa render dalam kiriman (D-247): build lewat endpoint
 * render terpisah (R17). Galat tanpa stack trace.
 *
 * Swarm port (row 31b): clone C/src/app/api/studio/documents/[id]/paragraphs/[pid]/route.ts (sha256 in
 * implementation/NN_row31b_revisions_port.md). Changes: `next/server`, `require-session`,
 * `getStudioCaller` -> ../shims (the caller is the MCP session's; a body `agentId` is ignored for
 * identity); `_lib/http` = row 31's ./paragraphs-http (rev/doc helpers) + ./r16-pid-locate (the pid
 * helpers row 31 left out, Prisma reads as SQL). Bodies verbatim.
 */
import type { NextRequest } from "../shims";
import { getStudioCaller, requireSession } from "../shims";
import { patchPid, pidHistory } from "@/lib/studio/services/revisions";
import { projectContent } from "@/lib/studio/services/structure";
import { apiLog, checkRenderRate, failure, isPlainObject, isPlausibleId, json, readJsonObject, reject, reqCtx, withQuotaHeaders, type ReqCtx } from "@/lib/studio/http";
import { API_LOG_SOURCE, decodePidParam, loadDocRevision } from "./paragraphs-http";
import { findById, locatePid } from "./r16-pid-locate";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ROUTE = "/api/studio/documents/[id]/paragraphs/[pid]";

type Params = { params: Promise<{ id: string; pid: string }> };

export async function GET(req: NextRequest, { params }: Params) {
  const denied = await requireSession(req);
  if (denied) return denied;
  const ctx = reqCtx(req, ROUTE, API_LOG_SOURCE);
  const { id, pid: rawPid } = await params;

  if (!isPlausibleId(id)) return reject(ctx, "DOCUMENT_NOT_FOUND", "Document not found");
  const pid = decodePidParam(rawPid);
  if (!pid) return reject(ctx, "PID_NOT_FOUND", "Pid tidak dikenal; pakai pid dari GET dokumen atau isi", { pid: String(rawPid ?? "") }, { documentId: id });

  const url = new URL(req.url);
  const historyRaw = url.searchParams.get("history");
  const withHistory = historyRaw === "1" || historyRaw === "true";
  const logCtx = { documentId: id, pid };

  try {
    const loaded = await loadDocRevision(ctx, id, url.searchParams.get("rev"));
    if (!loaded.ok) return loaded.response;
    const { revision } = loaded.value;

    const loc = await locatePid(id, revision, pid);
    let content: unknown;
    if (loc.kind === "BLOCK") {
      // Baris M17 menyimpan isi v2 tanpa `id`; pid ditambahkan kembali.
      content = isPlainObject(loc.blockContent) ? { ...loc.blockContent, id: pid } : { type: loc.type, id: pid };
    } else {
      const projected = await projectContent(revision.id, { slot: loc.slotKey, chapter: loc.chapterKey ?? undefined });
      content = findById(projected, pid);
      if (!content) {
        // Proyeksi tidak memuat pid yang baris identitasnya ada = cacat data, bukan masukan.
        throw new Error(`projectContent missing ${loc.kind} pid in revision ${revision.revisionNo}`);
      }
    }

    const body: Record<string, unknown> = {
      pid,
      kind: loc.kind,
      address: loc.address,
      type: loc.type,
      content,
      revisionNo: revision.revisionNo,
    };
    if (withHistory) body.history = await pidHistory(id, pid);
    return json(body, 200, ctx);
  } catch (e) {
    return failure(e, ctx, { context: { ...logCtx, history: withHistory } });
  }
}

export async function PATCH(req: NextRequest, { params }: Params) {
  const denied = await requireSession(req);
  if (denied) return denied;
  const ctx = reqCtx(req, ROUTE, API_LOG_SOURCE);
  // FIX-R40-1 (QH-03): header kuota (bucket render) pada respons apa pun sesudah tagihan; 401 dan
  // penolakan sebelum `checkRenderRate` tanpa tagihan = tanpa header.
  return withQuotaHeaders(ctx, () => patchPidRoute(req, params, ctx));
}

async function patchPidRoute(req: NextRequest, params: Params["params"], ctx: ReqCtx): Promise<Response> {
  const { id, pid: rawPid } = await params;

  if (!isPlausibleId(id)) return reject(ctx, "DOCUMENT_NOT_FOUND", "Document not found");
  const pid = decodePidParam(rawPid);
  if (!pid) return reject(ctx, "PID_NOT_FOUND", "Pid tidak dikenal; pakai pid dari GET dokumen atau isi", { pid: String(rawPid ?? "") }, { documentId: id });

  const parsed = await readJsonObject(req, ctx);
  if (!parsed.ok) return parsed.response;
  const { agentId, ...body } = parsed.value;
  const logCtx = { documentId: id, pid };
  if (agentId !== undefined && typeof agentId !== "string") {
    return reject(ctx, "SCHEMA_INVALID", "agentId harus string", [{ pointer: "/agentId", keyword: "type", message: "must be string" }], logCtx);
  }
  const opCtx = {
    ...logCtx,
    op: typeof body.op === "string" ? body.op.slice(0, 32) : null,
    baseRevisionNo: typeof body.baseRevisionNo === "number" ? body.baseRevisionNo : null,
  };

  try {
    const caller = await getStudioCaller(req, typeof agentId === "string" ? agentId : null);
    // FIX-1 (S87 M-03): laju per pemanggil (429). D-247: tanpa render; `render` di badan
    // ditolak layanan (400 SCHEMA_INVALID, checkId RENDER_FIELD).
    const limited = checkRenderRate(caller, ctx);
    if (limited) return limited;
    // Bentuk badan (op, fragmen v2, change D-06, to) divalidasi SATU kali oleh layanan.
    const result = await patchPid(caller, id, pid, body);
    apiLog({
      ...ctx,
      level: "info",
      message: "pid patched",
      status: 200,
      context: {
        ...opCtx,
        revisionNo: result.revision.revisionNo,
        newPid: result.newPid ?? null,
        requester: caller.requester,
      },
    });
    return json(result, 200, ctx);
  } catch (e) {
    return failure(e, ctx, { context: opCtx });
  }
}
