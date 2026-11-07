/**
 * Pembacaan badan permintaan berbatas untuk route Studio (IP-08).
 *
 * Batas ditegakkan dua kali: dari `content-length` sebelum membaca (413 tanpa
 * menyentuh badan) dan saat streaming, sehingga badan chunked tanpa
 * `content-length` juga berhenti begitu melewati batas. Badan kosong, tidak
 * terbaca, atau bukan JSON -> 400 `JSON_MALFORMED`.
 *
 * FIX-1 (S87 L-04, L-07):
 * - Kedalaman JSON dibatasi `STUDIO_MAX_JSON_DEPTH` (diperiksa iteratif
 *   setelah parse, tanpa rekursi) -> 400 `SCHEMA_INVALID`; sebelumnya walker
 *   rekursif dan `JSON.stringify` jatuh ke `RangeError` (500).
 * - Route tulis JSON menolak `Content-Type` yang hadir tetapi bukan JSON
 *   (`application/json` atau `application/<x>+json`) -> 415 `UNSUPPORTED_MEDIA_TYPE`,
 *   sebelum badan dibaca. Header absen diterima (klien non-peramban); peramban
 *   selalu mengirim Content-Type untuk permintaan lintas situs sederhana
 *   (`text/plain`, form urlencoded/multipart), jadi itulah yang ditutup.
 */
import { STUDIO_MAX_JSON_BYTES } from "@/lib/studio/contract/env";
import { StudioEngineError } from "@/lib/studio/contract/errors";
import type { ReqCtx } from "./context";
import { reject } from "./errors";

export type BodyLimitCode = "PAYLOAD_TOO_LARGE" | "ASSET_TOO_LARGE";

function tooLarge(limit: number, code: BodyLimitCode): StudioEngineError {
  return new StudioEngineError(code, `Request body exceeds ${limit} bytes`);
}

/**
 * Baca seluruh badan sebagai byte dengan batas. Melempar StudioEngineError
 * (`code` bila melewati batas, `JSON_MALFORMED` bila stream gagal dibaca).
 * Tanpa badan -> array kosong.
 */
export async function readBodyBytes(
  req: Request,
  limit: number = STUDIO_MAX_JSON_BYTES,
  code: BodyLimitCode = "PAYLOAD_TOO_LARGE",
): Promise<Uint8Array<ArrayBuffer>> {
  const declared = req.headers.get("content-length");
  if (declared !== null && declared !== "") {
    const n = Number(declared);
    if (Number.isFinite(n) && n > limit) throw tooLarge(limit, code);
  }
  if (!req.body) return new Uint8Array(new ArrayBuffer(0));
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => undefined);
        throw tooLarge(limit, code);
      }
      chunks.push(value);
    }
  } catch (err) {
    if (err instanceof StudioEngineError) throw err;
    throw new StudioEngineError("JSON_MALFORMED", "Request body could not be read");
  }
  const out = new Uint8Array(new ArrayBuffer(total));
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

/** Kedalaman maksimum badan JSON (objek/array bersarang; akar = 1). */
export const STUDIO_MAX_JSON_DEPTH = 64;

/** Kedalaman nilai JSON (iteratif; berhenti begitu melewati `limit`). */
export function jsonDepthExceeds(value: unknown, limit: number = STUDIO_MAX_JSON_DEPTH): boolean {
  if (value === null || typeof value !== "object") return false;
  const stack: Array<{ v: unknown; d: number }> = [{ v: value, d: 1 }];
  while (stack.length > 0) {
    const { v, d } = stack.pop()!;
    if (d > limit) return true;
    const children = Array.isArray(v) ? v : Object.values(v as Record<string, unknown>);
    for (const c of children) {
      if (c !== null && typeof c === "object") stack.push({ v: c, d: d + 1 });
    }
  }
  return false;
}

/** Tolak 400 `SCHEMA_INVALID` bila nilai JSON melewati batas kedalaman (S87 L-04). */
export function assertJsonDepth(value: unknown, what = "Request body", limit: number = STUDIO_MAX_JSON_DEPTH): void {
  if (jsonDepthExceeds(value, limit)) {
    throw new StudioEngineError("SCHEMA_INVALID", `${what} nests deeper than ${limit} levels`, [
      { pointer: "", keyword: "maxDepth", message: `JSON nesting must not exceed ${limit} levels` },
    ]);
  }
}

/** Parse teks JSON; kosong/rusak -> `JSON_MALFORMED`; terlalu dalam -> `SCHEMA_INVALID`. */
export function parseJsonText(text: string, what = "Request body"): unknown {
  if (!text.trim()) throw new StudioEngineError("JSON_MALFORMED", `${what} is empty`);
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new StudioEngineError("JSON_MALFORMED", `${what} is not valid JSON`);
  }
  assertJsonDepth(value, what);
  return value;
}

/** true bila media type JSON (`application/json`, `application/*+json`); parameter diabaikan. */
export function isJsonMediaType(contentType: string): boolean {
  const mt = contentType.split(";")[0].trim().toLowerCase();
  return mt === "application/json" || /^application\/[a-z0-9.+-]+\+json$/.test(mt);
}

/**
 * S87 L-07: tolak 415 `UNSUPPORTED_MEDIA_TYPE` bila `Content-Type` hadir dan
 * bukan JSON. Header absen/kosong diterima (lihat catatan modul).
 */
export function assertJsonContentType(req: Request): void {
  const ct = (req.headers.get("content-type") ?? "").trim();
  if (ct === "" || isJsonMediaType(ct)) return;
  throw new StudioEngineError("UNSUPPORTED_MEDIA_TYPE", "Content-Type must be application/json", {
    contentType: ct.split(";")[0].trim().slice(0, 100),
  });
}

export interface ReadJsonOptions {
  /** Batas byte; bawaan `STUDIO_MAX_JSON_BYTES` (5 MiB). */
  limit?: number;
  /**
   * UTF-8 tidak sah -> 400 `JSON_MALFORMED` (bawaan R04/R05/R08). Bila false,
   * byte tidak sah diganti U+FFFD seperti `Request.text()` (bawaan R01/R02/R06/R07/R09).
   */
  fatalUtf8?: boolean;
  /** Lewati cek Content-Type JSON (L-07). Bawaan false: route tulis JSON wajib JSON. */
  anyContentType?: boolean;
}

export type JsonBodyResult = { ok: true; value: unknown } | { ok: false; response: Response };
export type JsonObjectResult = { ok: true; value: Record<string, unknown> } | { ok: false; response: Response };

/** Baca badan JSON berbatas; galat dibalas lewat `reject` (log warn + correlation id). */
export async function readJsonBody(req: Request, ctx: ReqCtx, opts: ReadJsonOptions = {}): Promise<JsonBodyResult> {
  const limit = opts.limit ?? STUDIO_MAX_JSON_BYTES;
  try {
    if (opts.anyContentType !== true) assertJsonContentType(req);
    const bytes = await readBodyBytes(req, limit);
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: opts.fatalUtf8 === true }).decode(bytes);
    } catch {
      throw new StudioEngineError("JSON_MALFORMED", "Request body is not valid UTF-8");
    }
    return { ok: true, value: parseJsonText(text) };
  } catch (err) {
    if (err instanceof StudioEngineError) {
      return { ok: false, response: reject(ctx, err.code, err.message, undefined, { limit }) };
    }
    throw err;
  }
}

/** Seperti `readJsonBody`, tetapi badan wajib objek JSON (selain itu 400 `SCHEMA_INVALID`). */
export async function readJsonObject(req: Request, ctx: ReqCtx, opts: ReadJsonOptions = {}): Promise<JsonObjectResult> {
  const r = await readJsonBody(req, ctx, opts);
  if (!r.ok) return r;
  const v = r.value;
  if (!v || typeof v !== "object" || Array.isArray(v)) {
    return {
      ok: false,
      response: reject(ctx, "SCHEMA_INVALID", "Body must be a JSON object", [{ pointer: "", keyword: "type", message: "must be object" }]),
    };
  }
  return { ok: true, value: v as Record<string, unknown> };
}
