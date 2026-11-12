/**
 * Klien HTTP bersama CLI Studio: `studio-report` dan `draft-check --remote` (R2-F2 #6, D-426).
 *
 * Satu kebijakan untuk kedua CLI:
 * - rahasia dibaca pemanggil dari env `INTERNAL_API_SECRET` dan dikirim HANYA sebagai header
 *   `x-internal-secret`; tidak pernah dicetak, ditulis, atau dimasukkan ke pesan galat;
 * - batas waktu {@link STUDIO_HTTP_TIMEOUT_MS} per panggilan (render R17 bisa lama);
 * - badan dibaca ke memori: JSON (null bila kosong/tidak sah) atau bita untuk unduhan biner;
 * - `code` server dibaca dari badan `{ error, code, details }`, cid dari header
 *   `x-correlation-id` (cadangan: medan badan `correlationId`);
 * - peta galat {@link httpFailureOf}: 3xx `REMOTE_REDIRECT`, 401 `REMOTE_UNAUTHORIZED`, 429
 *   `RATE_LIMITED` (+ `Retry-After`), selain itu `code` server atau `HTTP_<status>`; 3xx/401/429/5xx
 *   = galat lingkungan, 4xx lain = server menolak isi.
 *
 * Pengalihan (3xx) DIPILIH pemanggil lewat {@link RedirectPolicy}, tidak diseragamkan:
 * `studio-report` memakai `"manual"` (pengalihan tidak diikuti, rahasia tidak diteruskan);
 * `draft-check --remote` tetap `"follow"` karena perilaku itu diterima USER sebagai risiko tercatat
 * (D-402 M-2: "boleh mengirim rahasia ke URL apa pun / mengikuti redirect ... tidak ada perubahan
 * kode"; ditegaskan D-425 #2). Mengganti kebijakan draft-check memerlukan keputusan USER baru.
 */

/** Batas waktu satu panggilan HTTP CLI Studio (ms). */
export const STUDIO_HTTP_TIMEOUT_MS = 60_000;

/**
 * Swarm patch (1.2.6 row 53a, M-01, U1; register N-044): budget for one `studio_render` call to R17 (ms). Below the
 * MCP ceiling `experimental.mcp_timeout` 600000 (ladder I-1) and not above the render job limit (I-2), so the tool can
 * give up while the job still runs: its timeout error says the render may still finish (01d F3). Other calls keep
 * {@link STUDIO_HTTP_TIMEOUT_MS}.
 */
export const STUDIO_RENDER_CALL_TIMEOUT_MS = 540_000;

/** Metode HTTP yang dipakai klien Studio (PATCH ditambahkan MCP-D1 untuk R14; tipe saja, perilaku tetap). */
export type StudioMethod = "GET" | "POST" | "HEAD" | "PATCH";

/** `manual` = 3xx dikembalikan apa adanya (lalu dipetakan `REMOTE_REDIRECT`); `follow` = bawaan fetch. */
export type RedirectPolicy = "manual" | "follow";

export interface HttpResponseLike {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
  arrayBuffer?(): Promise<ArrayBuffer>;
}

export type HttpFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; redirect: RedirectPolicy; signal?: AbortSignal },
) => Promise<HttpResponseLike>;

export interface StudioHttpOptions {
  /** Hasil {@link normalizeBaseUrl}. */
  baseUrl: string;
  secret: string;
  redirect: RedirectPolicy;
  fetchImpl?: HttpFetch;
  timeoutMs?: number;
}

export interface StudioRequest {
  /** Badan apa adanya (teks JSON); `content-type: application/json` ditambahkan bila ada. */
  body?: string;
  /** Unduhan biner: badan jawaban sukses dibaca sebagai bita, bukan JSON. */
  binary?: boolean;
  /** Status sukses (bawaan 200, 201). */
  okStatuses?: readonly number[];
}

export interface HttpReply {
  status: number;
  ok: boolean;
  headers: HttpResponseLike["headers"];
  /** JSON terurai; null untuk badan kosong, bukan JSON, HEAD, atau unduhan biner sukses. */
  body: unknown;
  bytes?: Buffer;
  correlationId?: string;
  /** Medan `code` badan galat Studio, bila ada. */
  serverCode?: string;
}

export interface HttpFailure {
  /** `REMOTE_REDIRECT`, `REMOTE_UNAUTHORIZED`, `RATE_LIMITED`, `code` server, atau `HTTP_<status>`. */
  code: string;
  message: string;
  httpStatus: number;
  /** true = galat lingkungan (3xx, 401, 429, 5xx); false = server menolak isi (4xx lain). */
  environmental: boolean;
  correlationId?: string;
  serverCode?: string;
  retryAfter?: string;
  details?: unknown;
}

/** Galat pemakaian URL (`--remote` / `HQ_URL`). */
export class StudioUrlError extends Error {
  readonly code = "USAGE_ERROR";
}

/** Server tidak dapat dihubungi (jaringan, DNS, batas waktu). */
export class StudioUnreachableError extends Error {
  readonly code = "REMOTE_UNREACHABLE";
  /** Swarm patch (1.2.6 row 53a, M-01): true when the call ran out of its `timeoutMs` (not a refused connection). */
  readonly timedOut: boolean;
  constructor(message: string, timedOut = false) {
    super(message);
    this.timedOut = timedOut;
  }
}

/**
 * Swarm patch (1.2.6 row 54a, M-02, U5; register N-050): name shown for the in-process studio host instead of its
 * routing origin (E-06 `LOCAL_API_BASE_URL` = `http://127.0.0.1:1`, MH/start.ts), which is not a server anyone can reach.
 */
export const IN_PROCESS_ENDPOINT_LABEL = "studio-host (in-process)";

/** E-06 mirror (MH/start.ts `LOCAL_API_BASE_URL`); only used to replace it by {@link IN_PROCESS_ENDPOINT_LABEL} in error text. */
const IN_PROCESS_BASE_URL = "http://127.0.0.1:1";

/**
 * Swarm patch (1.2.6 row 54a, M-02): REMOTE_UNREACHABLE text. Names the operation (method + route, query dropped), the
 * endpoint (label for the in-process host), and on a timeout the limit constant that fired plus the follow-up: the
 * handler is not cancelled by the abort, so the work may still finish (01d F3). Never the secret, never the placeholder.
 */
function unreachableMessage(baseUrl: string, method: StudioMethod, path: string, timeoutMs: number, timedOut: boolean, e: unknown): string {
  const inProcess = baseUrl === IN_PROCESS_BASE_URL;
  const endpoint = inProcess ? IN_PROCESS_ENDPOINT_LABEL : `server ${baseUrl}`;
  const operation = `${method} ${path.split("?")[0]}`;
  if (timedOut) {
    const limit =
      timeoutMs === STUDIO_RENDER_CALL_TIMEOUT_MS ? "STUDIO_RENDER_CALL_TIMEOUT_MS" : timeoutMs === STUDIO_HTTP_TIMEOUT_MS ? "STUDIO_HTTP_TIMEOUT_MS" : "timeoutMs";
    return `${operation} ke ${endpoint} tidak menjawab dalam ${timeoutMs / 1000} detik (${limit}); permintaan mungkin masih diproses, cek studio_document_status sebelum mengulang`;
  }
  let why = e instanceof Error ? e.message : String(e);
  if (inProcess) why = why.replace(/(?:http:\/\/)?127\.0\.0\.1:1(?!\d)/g, IN_PROCESS_ENDPOINT_LABEL);
  return `${operation}: ${endpoint} tidak dapat dihubungi: ${why}`;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Asal + path tanpa garis miring akhir; selain http(s) = {@link StudioUrlError}. */
export function normalizeBaseUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new StudioUrlError(`--remote harus URL http(s) yang sah, mis. http://127.0.0.1:9021 (diberikan "${raw}")`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new StudioUrlError("--remote harus memakai http:// atau https://");
  return u.origin + u.pathname.replace(/\/+$/, "");
}

/** `code` badan galat Studio `{ error, code, details }`. */
export function serverCodeOf(body: unknown): string | undefined {
  return isRecord(body) && typeof body.code === "string" ? body.code : undefined;
}

/** cid: header `x-correlation-id`, cadangan medan badan `correlationId`. */
export function correlationIdOf(headers: HttpResponseLike["headers"], body: unknown): string | undefined {
  const h = headers.get("x-correlation-id");
  if (h !== null && h !== "") return h;
  return isRecord(body) && typeof body.correlationId === "string" ? body.correlationId : undefined;
}

/**
 * Satu panggilan ke `<baseUrl><path>`. Jawaban HTTP apa pun dikembalikan (cek `ok`, lalu
 * {@link httpFailureOf}); hanya kegagalan transport yang dilempar ({@link StudioUnreachableError}).
 */
export async function studioRequest(opts: StudioHttpOptions, method: StudioMethod, path: string, req: StudioRequest = {}): Promise<HttpReply> {
  const f = opts.fetchImpl ?? (globalThis.fetch as unknown as HttpFetch);
  const timeoutMs = opts.timeoutMs ?? STUDIO_HTTP_TIMEOUT_MS;
  const headers: Record<string, string> = { "x-internal-secret": opts.secret, accept: req.binary ? "*/*" : "application/json" };
  if (req.body !== undefined) headers["content-type"] = "application/json";
  let res: HttpResponseLike;
  try {
    res = await f(`${opts.baseUrl}${path}`, { method, headers, body: req.body, redirect: opts.redirect, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    const timedOut = e instanceof Error && e.name === "TimeoutError";
    throw new StudioUnreachableError(unreachableMessage(opts.baseUrl, method, path, timeoutMs, timedOut, e), timedOut);
  }
  const ok = (req.okStatuses ?? [200, 201]).includes(res.status);
  let body: unknown = null;
  let bytes: Buffer | undefined;
  if (method !== "HEAD") {
    if (req.binary && ok) {
      bytes = res.arrayBuffer ? Buffer.from(await res.arrayBuffer()) : Buffer.from(await res.text(), "utf8");
    } else {
      const text = await res.text();
      try {
        body = text === "" ? null : JSON.parse(text);
      } catch {
        body = null;
      }
    }
  }
  return { status: res.status, ok, headers: res.headers, body, bytes, correlationId: correlationIdOf(res.headers, body), serverCode: serverCodeOf(body) };
}

/** Peta galat seragam untuk jawaban tidak sukses; `action` mis. `POST /api/studio/chapters`. */
export function httpFailureOf(reply: HttpReply, action: string): HttpFailure {
  const { status, correlationId, serverCode } = reply;
  const base = {
    httpStatus: status,
    ...(correlationId !== undefined ? { correlationId } : {}),
    ...(serverCode !== undefined ? { serverCode } : {}),
    ...(isRecord(reply.body) && reply.body.details !== undefined ? { details: reply.body.details } : {}),
  };
  if (status >= 300 && status < 400) {
    return { ...base, code: "REMOTE_REDIRECT", environmental: true, message: `server mengalihkan ${action} (${status}); pengalihan tidak diikuti agar rahasia tidak diteruskan` };
  }
  if (status === 401) return { ...base, code: "REMOTE_UNAUTHORIZED", environmental: true, message: "server menolak rahasia (401): periksa env INTERNAL_API_SECRET" };
  if (status === 429) {
    const ra = reply.headers.get("retry-after");
    return { ...base, code: "RATE_LIMITED", environmental: true, ...(ra ? { retryAfter: ra } : {}), message: `batas laju server tercapai (429)${ra ? `; coba lagi dalam ${ra} detik` : ""}` };
  }
  const serverMsg = isRecord(reply.body) && typeof reply.body.error === "string" ? reply.body.error : `server menjawab ${status}`;
  return { ...base, code: serverCode ?? `HTTP_${status}`, environmental: status >= 500, message: serverMsg };
}
