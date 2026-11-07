/**
 * `POST /api/studio/import/markdown` (FIX-H7, D-321/D-322; laporan uji Hermes G3): importer
 * Markdown resmi `md/v1` -> `studio.chapter/v2` KONTEN-SAJA. HANYA mengubah: tidak menyimpan
 * revisi, berkas, maupun aset, dan tidak merender.
 *
 * Badan `{ markdown, chapterKey, title?, agentId?, target?, template?, meta?, slot? }`.
 *   200 `{ chapter, submission?, report: { importer, warnings, dropped, mapping }, validation }`;
 *   `submission` (amplop `studio.chapter/v2` siap POST R12) hanya bila `target` diberikan.
 * `?validate=1`: sesudah konversi, dry-run kiriman bab yang SAMA dengan R08 (`dryRunChapter`,
 * transaksi baca-saja, tanpa tulis/build) atas `submission`; wajib `target`. Hasil di medan
 * `dryRun` `{ ran, valid, issues, lint?, completenessPreview?, submitPreview? }`. Dihitung
 * pembatas laju R08 (ember sama, 429 `RATE_LIMITED`); isu galat layanan memakai pemeta R08 bersama
 * (`validate/_shared/error-issues.ts`), jadi `details` (mis. `overwrittenPids`) ikut (FIX-HR1, C2).
 * FIX-HR1 (D-334 H-01): SETIAP panggilan dihitung ember impor sendiri (`_lib/import-rate.ts`)
 * sebelum badan dibaca; badan maks `MD_IMPORT_MAX_BODY_BYTES`; markdown dibatasi karakter, baris,
 * blok, dan lebar tabel -> 413 `PAYLOAD_TOO_LARGE` dengan `details.reason`.
 * Galat: 400 `SCHEMA_INVALID` (badan/markdown kosong/tanpa judul), 422 `CHAPTER_KEY_INVALID`,
 * 413, 415, 400 `JSON_MALFORMED`, 401, 403 (dry-run templat terbatas), 429.
 *
 * Auth sama dengan route Studio lain: `requireSession`; agen memakai `x-internal-secret` +
 * `agentId` di badan. Setiap jalur galat dicatat tahan lama lewat `apiLog`/`reject`/`failFrom`.
 */
import type { NextRequest } from "../shims";
import { requireSession } from "../shims";
import { STUDIO_ERROR_HTTP, type DocMetaV2, type DocTargetV2, type ValidationIssue } from "@/lib/studio/contract";
import { getStudioCaller } from "../shims";
import type { StudioCaller } from "@/lib/studio/contract/auth";
import { StudioEngineError } from "@/lib/studio/contract/errors";
import { apiLog, isRecord, json, readJsonObject, reject, reqCtx, withQuotaHeaders, type ReqCtx } from "@/lib/studio/http";
// Swarm port (row 31): the services/import barrel (index.ts, re-exports only) is not vendored; import the
// two vendored modules it re-exports.
import { importMarkdownChapter, MD_IMPORT_MAX_BODY_BYTES } from "@/lib/studio/services/import/markdown";
import type { MarkdownImportResult, MdEnvelopeOptions } from "@/lib/studio/services/import/types";
import { dryRunChapter } from "@/lib/studio/services/submit";
import { issuesFromError, type ValidateIssue } from "./error-issues";
import { S55_BODY_OPTIONS, failFrom } from "../route-kit";
import { checkValidateRate } from "./validate-rate";
import { checkImportRate } from "./import-rate";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ROUTE = "/api/studio/import/markdown";
const ALLOWED_FIELDS = new Set(["markdown", "chapterKey", "title", "agentId", "target", "template", "meta", "slot"]);
/** Galat dry-run yang tetap HTTP (bukan `valid:false`), selaras R08. */
const HARD_CODES = new Set(["UNAUTHORIZED", "FORBIDDEN", "PAYLOAD_TOO_LARGE", "JSON_MALFORMED"]);

interface DryRunOutcome {
  ran: boolean;
  valid: boolean;
  issues: ValidateIssue[];
  lint?: unknown;
  completenessPreview?: unknown;
  submitPreview?: unknown;
}

interface ParsedBody {
  markdown: string;
  chapterKey: string;
  title?: string;
  agentId?: string;
  envelope?: MdEnvelopeOptions;
}

/** Bentuk badan; isu berpointer (400 SCHEMA_INVALID). Isi amplop divalidasi skema v2 sesudah konversi. */
function parseBody(b: Record<string, unknown>): { ok: true; value: ParsedBody } | { ok: false; issues: ValidationIssue[] } {
  const issues: ValidationIssue[] = [];
  for (const k of Object.keys(b)) {
    if (!ALLOWED_FIELDS.has(k)) issues.push({ pointer: `/${k}`, keyword: "additionalProperties", message: `unknown field "${k}"` });
  }
  if (typeof b.markdown !== "string") issues.push({ pointer: "/markdown", keyword: "type", message: "must be a string" });
  if (typeof b.chapterKey !== "string") issues.push({ pointer: "/chapterKey", keyword: "type", message: "must be a string" });
  for (const k of ["title", "agentId", "slot"] as const) {
    if (b[k] !== undefined && typeof b[k] !== "string") issues.push({ pointer: `/${k}`, keyword: "type", message: "must be a string" });
  }
  for (const k of ["target", "template", "meta"] as const) {
    if (b[k] !== undefined && !isRecord(b[k])) issues.push({ pointer: `/${k}`, keyword: "type", message: "must be an object" });
  }
  if (b.target === undefined && (b.template !== undefined || b.meta !== undefined || b.slot !== undefined)) {
    issues.push({ pointer: "/target", keyword: "required", message: "template, meta and slot belong to the submission envelope and need target" });
  }
  if (issues.length > 0) return { ok: false, issues };
  const envelope: MdEnvelopeOptions | undefined = isRecord(b.target)
    ? {
        target: b.target as DocTargetV2,
        ...(isRecord(b.template) ? { template: b.template as { slug: string; version?: number } } : {}),
        ...(isRecord(b.meta) ? { meta: b.meta as DocMetaV2 } : {}),
        ...(typeof b.slot === "string" ? { slot: b.slot } : {}),
      }
    : undefined;
  return {
    ok: true,
    value: {
      markdown: b.markdown as string,
      chapterKey: b.chapterKey as string,
      ...(typeof b.title === "string" ? { title: b.title } : {}),
      ...(typeof b.agentId === "string" ? { agentId: b.agentId } : {}),
      ...(envelope ? { envelope } : {}),
    },
  };
}

/** Dry-run R08 (`dryRunChapter`) atas amplop hasil konversi; galat masukan 4xx -> `valid:false`. */
async function dryRun(result: MarkdownImportResult, caller: StudioCaller, ctx: ReqCtx): Promise<DryRunOutcome> {
  if (!result.submission || !result.validation.valid) return { ran: false, valid: false, issues: result.validation.issues };
  try {
    const dry = await dryRunChapter(caller, result.submission);
    const res = dry.result;
    return {
      ran: true,
      valid: true,
      issues: [],
      lint: dry.lint,
      completenessPreview: res.completeness,
      submitPreview: {
        documentId: res.document.id === "" ? null : res.document.id,
        docNumber: res.document.docNumber,
        created: res.created,
        unchanged: res.unchanged,
        rebased: res.rebased,
        revisionNo: res.revision.revisionNo,
        changeScope: res.revision.changeScope,
        ...(res.chapter ? { chapter: { slotKey: res.chapter.slotKey, chapterKey: res.chapter.chapterKey, pid: res.chapter.pid } } : {}),
      },
    };
  } catch (err) {
    if (!(err instanceof StudioEngineError) || HARD_CODES.has(err.code) || STUDIO_ERROR_HTTP[err.code] >= 500) throw err;
    apiLog({ ...ctx, level: "info", message: `md import dry-run rejected: ${err.message}`, code: err.code });
    return { ran: true, valid: false, issues: issuesFromError(err) };
  }
}

export async function POST(req: NextRequest) {
  const denied = await requireSession(req);
  if (denied) return denied;
  const ctx = reqCtx(req, ROUTE);
  // DC-19 (QH-03): header kuota pada respons apa pun sesudah tagihan bucket; tanpa tagihan = tanpa header.
  return withQuotaHeaders(ctx, () => postImport(req, ctx));
}

async function postImport(req: NextRequest, ctx: ReqCtx): Promise<Response> {
  try {
    // Laju dihitung sebelum badan dibaca/diurai; identitas laju tidak bergantung pada agentId badan.
    const limited = checkImportRate(await getStudioCaller(req), ctx);
    if (limited) return limited;
  } catch (err) {
    return failFrom(err, ctx);
  }
  const body = await readJsonObject(req, ctx, { ...S55_BODY_OPTIONS, limit: MD_IMPORT_MAX_BODY_BYTES });
  if (!body.ok) return body.response;

  try {
    const agentId = typeof body.value.agentId === "string" ? body.value.agentId : undefined;
    const caller = await getStudioCaller(req, agentId);
    const parsed = parseBody(body.value);
    if (!parsed.ok) return reject(ctx, "SCHEMA_INVALID", "Request does not match { markdown, chapterKey, title?, agentId?, target? }", parsed.issues);
    const p = parsed.value;
    const wantValidate = new URL(req.url).searchParams.get("validate") === "1";
    if (wantValidate && !p.envelope) {
      return reject(ctx, "SCHEMA_INVALID", "?validate=1 runs the R08 dry-run of the chapter submission and needs target", [
        { pointer: "/target", keyword: "required", message: "target is required with ?validate=1" },
      ]);
    }
    if (wantValidate) {
      const limited = checkValidateRate(caller, ctx);
      if (limited) return limited;
    }

    let result: MarkdownImportResult;
    try {
      result = importMarkdownChapter(p.markdown, {
        chapterKey: p.chapterKey,
        ...(p.title !== undefined ? { title: p.title } : {}),
        ...(p.agentId !== undefined ? { agentId: p.agentId } : {}),
        ...(p.envelope ? { envelope: p.envelope } : {}),
      });
    } catch (err) {
      if (err instanceof StudioEngineError && STUDIO_ERROR_HTTP[err.code] < 500) return reject(ctx, err.code, err.message, err.details);
      throw err;
    }

    const out: MarkdownImportResult & { dryRun?: DryRunOutcome } = { ...result };
    if (wantValidate) out.dryRun = await dryRun(result, caller, ctx);
    apiLog({
      ...ctx,
      level: "info",
      message: "markdown imported (not stored)",
      code: "MD_IMPORTED",
      context: {
        importer: result.report.importer,
        chapterKey: p.chapterKey,
        valid: result.validation.valid,
        sections: result.chapter.sections.length,
        mapped: result.report.mapping.length,
        warnings: result.report.warnings.length,
        dropped: result.report.dropped.length,
        ...(out.dryRun ? { dryRunValid: out.dryRun.valid } : {}),
        requester: caller.requester,
      },
    });
    return json(out, 200, ctx);
  } catch (err) {
    return failFrom(err, ctx);
  }
}
