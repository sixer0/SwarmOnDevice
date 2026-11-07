/**
 * Konteks permintaan route Studio: correlation id + identitas route (IP-08).
 *
 * Correlation id diambil dari header `x-correlation-id` bila bentuknya aman
 * (8-100 karakter `[A-Za-z0-9._:-]`), selain itu UUID baru. Setiap respons
 * non-401 membawa header yang sama.
 */
import { randomUUID } from "node:crypto";
import { STUDIO_API_SOURCE } from "./log";

export const CORRELATION_HEADER = "x-correlation-id";
export const NO_STORE: Readonly<Record<string, string>> = { "Cache-Control": "no-store" };

const CORRELATION_RE = /^[A-Za-z0-9._:-]{8,100}$/;

export interface ReqCtx {
  correlationId: string;
  /** Pola route, mis. `/api/studio/documents/[id]` (bukan URL berisi data). */
  route: string;
  method: string;
  /** Sumber log, mis. `studio.api.templates`. */
  source: string;
}

/** Correlation id dari header (bila sah) atau UUID baru. */
export function correlationIdOf(req: Request): string {
  const raw = (req.headers.get(CORRELATION_HEADER) ?? "").trim();
  return CORRELATION_RE.test(raw) ? raw : randomUUID();
}

export function isCorrelationId(v: unknown): v is string {
  return typeof v === "string" && CORRELATION_RE.test(v);
}

export function reqCtx(req: Request, route: string, source: string = STUDIO_API_SOURCE): ReqCtx {
  return { correlationId: correlationIdOf(req), route, method: req.method, source };
}

/** Pasang header correlation id; header beku disalin ke Response baru. */
export function withCorrelation<T extends Response>(res: T, ctx: ReqCtx): T | Response {
  try {
    res.headers.set(CORRELATION_HEADER, ctx.correlationId);
    return res;
  } catch {
    const headers = new Headers(res.headers);
    headers.set(CORRELATION_HEADER, ctx.correlationId);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  }
}

/** Respons JSON + correlation id (+ header tambahan, mis. `NO_STORE`). */
export function json(body: unknown, status: number, ctx: ReqCtx, headers?: Readonly<Record<string, string>>): Response {
  return withCorrelation(Response.json(body, { status, headers: headers ? { ...headers } : undefined }), ctx);
}
