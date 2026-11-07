/**
 * Pemetaan galat route Studio ke bentuk §6.1 `{ error, code, details? }`
 * (01_specs.md §6.3) tanpa stack trace (IP-08).
 *
 * - `reject`: galat yang diputuskan route sendiri (400/403/404/413/...),
 *   dicatat level warn.
 * - `failure`: galat yang dilempar layanan. StudioEngineError -> kode kontrak
 *   (4xx warn tanpa stack, 5xx error dengan stack di log saja); galat lain
 *   -> log error dengan stack + 500 `{ error: "Internal error" }`.
 */
import { STUDIO_ERROR_HTTP, StudioNotImplemented, isStudioEngineError, studioError, studioErrorFrom } from "@/lib/studio/contract/errors";
import type { StudioErrorCode } from "@/lib/studio/contract/enums";
import type { ValidationIssue } from "@/lib/studio/contract/types/api";
import { withCorrelation, type ReqCtx } from "./context";
import { apiLog } from "./log";

const LOG_MESSAGE_MAX = 500;

/** Kode yang wajib membawa header `Retry-After` (FIX-1, S87 M-03). */
const RETRY_AFTER_CODES: ReadonlySet<StudioErrorCode> = new Set<StudioErrorCode>(["RATE_LIMITED", "RENDER_QUEUE_FULL"]);

/** Detik `Retry-After` dari `details.retryAfterSec` (bawaan 1 detik untuk kode antrean/laju). */
export function retryAfterOf(code: StudioErrorCode, details: unknown): number | null {
  if (!RETRY_AFTER_CODES.has(code)) return null;
  const v = details && typeof details === "object" ? (details as { retryAfterSec?: unknown }).retryAfterSec : undefined;
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.ceil(v) : 1;
}

/** Pasang `Retry-After` pada respons galat bila kodenya menuntut. */
function withRetryAfter(res: Response, code: StudioErrorCode, details: unknown): Response {
  const sec = retryAfterOf(code, details);
  if (sec === null) return res;
  const headers = new Headers(res.headers);
  headers.set("Retry-After", String(sec));
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

function clip(s: string, max = LOG_MESSAGE_MAX): string {
  return s.length > max ? `${s.slice(0, max)}...` : s;
}

/** Respons galat kode kontrak + log warn. */
export function reject(
  ctx: ReqCtx,
  code: StudioErrorCode,
  message: string,
  details?: unknown,
  context?: Record<string, unknown>,
): Response {
  apiLog({ ...ctx, level: "warn", message: clip(message), code, status: STUDIO_ERROR_HTTP[code], ...(context ? { context } : {}) });
  return withCorrelation(withRetryAfter(studioError(code, message, details), code, details), ctx);
}

/** 400 `SCHEMA_INVALID` dengan isu berpointer. */
export function schemaInvalid(issues: ValidationIssue[], ctx: ReqCtx, message = "Request does not match the expected shape"): Response {
  return reject(ctx, "SCHEMA_INVALID", message, issues);
}

export interface FailureOptions {
  /** Nama operasi untuk pesan log, mis. `GET templates`. */
  op?: string;
  context?: Record<string, unknown>;
  /** Buang `details` StudioEngineError dari respons (mis. relPath internal R10). */
  stripDetails?: boolean;
  /** Sertakan `correlationId` di badan 500 generik (bentuk R04/R05/R08). */
  exposeCorrelationId?: boolean;
}

/**
 * Petakan galat apa pun ke respons kontrak dan catat secara tahan lama.
 * Respons tidak pernah memuat stack trace atau pesan galat tak terduga.
 */
export function failure(e: unknown, ctx: ReqCtx, opts: FailureOptions = {}): Response {
  const prefix = opts.op ? `${opts.op}: ` : "";
  if (isStudioEngineError(e)) {
    const status = e.httpStatus;
    const serverSide = status >= 500;
    apiLog({
      ...ctx,
      level: serverSide ? "error" : "warn",
      message: clip(`${prefix}${e.code}: ${e.message}`),
      code: e.code,
      status,
      ...(serverSide && e.stack ? { stack_trace: e.stack } : {}),
      ...(opts.context ? { context: opts.context } : {}),
    });
    const res = opts.stripDetails ? studioError(e.code, e.message) : studioErrorFrom(e);
    return withCorrelation(withRetryAfter(res, e.code, e.details), ctx);
  }
  const err = e instanceof Error ? e : new Error(String(e));
  const notImpl = e instanceof StudioNotImplemented;
  apiLog({
    ...ctx,
    level: "error",
    message: clip(`${prefix}unexpected ${err.name}`),
    code: notImpl ? "MODULE_NOT_IMPLEMENTED" : "INTERNAL",
    status: 500,
    stack_trace: err.stack,
    context: { ...opts.context, errorMessage: clip(err.message), ...(notImpl ? { moduleId: e.moduleId } : {}) },
  });
  const res = opts.exposeCorrelationId
    ? Response.json({ error: "Internal error", correlationId: ctx.correlationId }, { status: 500 })
    : studioErrorFrom(e);
  return withCorrelation(res, ctx);
}
