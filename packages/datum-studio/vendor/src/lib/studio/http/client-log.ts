/**
 * Skema dan sanitasi `POST /api/studio/client-log` (IP-09, F-031).
 *
 * Bentuk badan ringkas (maks `CLIENT_LOG_MAX_BYTES`):
 * `{ level, message, route?, correlationId?, source?, code?, status?, stack?, detail?, timestamp? }`.
 * Alias rekaman konsol UI Studio yang sudah ada (S60/S61/S62/S101) juga
 * diterima: `correlation_id`, `stack_trace`, `context`.
 *
 * Sanitasi: kunci rahasia (token/cookie/authorization/password/secret/session
 * ...) diganti `[redacted]`, teks bebas disamarkan (Bearer, JWT, `kunci=nilai`),
 * path profil user -> `%USERPROFILE%`, query route berkunci rahasia
 * disamarkan; `detail` dibatasi kedalaman/kunci/elemen dan
 * `CLIENT_LOG_DETAIL_MAX_BYTES` setelah sanitasi.
 */
import type { ValidationIssue } from "@/lib/studio/contract/types/api";
import { isCorrelationId } from "./context";
import type { StudioLogLevel } from "./log";
import { redactSecrets, sanitizeJson, sanitizeRoute } from "./sanitize";
import { isPlainObject, issue } from "./validation";

export const CLIENT_LOG_SOURCE = "studio.client";
export const CLIENT_LOG_MAX_BYTES = 16 * 1024;
export const CLIENT_LOG_DETAIL_MAX_BYTES = 4 * 1024;
export const CLIENT_LOG_MESSAGE_MAX = 2000;
export const CLIENT_LOG_STACK_MAX = 4000;
export const CLIENT_LOG_ROUTE_MAX = 500;
/** Batas laju per sesi: entri per jendela. */
export const CLIENT_LOG_RATE_LIMIT = 30;
export const CLIENT_LOG_RATE_WINDOW_MS = 60_000;

const LEVELS: readonly StudioLogLevel[] = ["error", "warn", "info"];
const KEYS = new Set([
  "level",
  "message",
  "route",
  "correlationId",
  "correlation_id",
  "source",
  "code",
  "status",
  "stack",
  "stack_trace",
  "detail",
  "context",
  "timestamp",
]);
const SOURCE_RE = /^[A-Za-z0-9._:/-]{1,80}$/;
const CODE_RE = /^[A-Za-z0-9._:-]{1,80}$/;

/** Masukan klien yang sudah divalidasi dan dibersihkan. */
export interface ClientLogRecord {
  level: StudioLogLevel;
  message: string;
  route?: string;
  /** Correlation id klien (bila sah); dipakai sebagai correlation id entri log. */
  correlationId?: string;
  clientSource?: string;
  code?: string;
  status?: number;
  stack?: string;
  detail?: unknown;
  clientTimestamp?: string;
}

export type ClientLogParse = { ok: true; record: ClientLogRecord } | { ok: false; issues: ValidationIssue[] };

function optString(body: Record<string, unknown>, keys: string[], issues: ValidationIssue[]): string | undefined {
  for (const k of keys) {
    const v = body[k];
    if (v === undefined || v === null) continue;
    if (typeof v !== "string") {
      issues.push(issue(`/${k}`, "type", "must be string"));
      return undefined;
    }
    return v;
  }
  return undefined;
}

function sanitizeDetail(raw: unknown): unknown {
  const clean = sanitizeJson(raw);
  const bytes = Buffer.byteLength(JSON.stringify(clean) ?? "", "utf8");
  return bytes > CLIENT_LOG_DETAIL_MAX_BYTES ? { "[truncated]": `${bytes} bytes after sanitizing` } : clean;
}

/** Validasi + sanitasi badan client-log. */
export function parseClientLog(body: unknown): ClientLogParse {
  if (!isPlainObject(body)) return { ok: false, issues: [issue("", "type", "must be object")] };
  const issues: ValidationIssue[] = [];
  for (const k of Object.keys(body)) {
    if (!KEYS.has(k)) issues.push(issue(`/${k}`, "additionalProperties", "must NOT have additional properties"));
  }

  const level = body.level;
  if (typeof level !== "string" || !(LEVELS as readonly string[]).includes(level)) {
    issues.push(issue("/level", "enum", `must be one of ${LEVELS.join(", ")}`));
  }
  const message = body.message;
  if (typeof message !== "string" || !message.trim()) {
    issues.push(issue("/message", "required", "must be a non-empty string"));
  } else if (message.length > CLIENT_LOG_MESSAGE_MAX) {
    issues.push(issue("/message", "maxLength", `must NOT have more than ${CLIENT_LOG_MESSAGE_MAX} characters`));
  }

  const route = optString(body, ["route"], issues);
  if (route !== undefined && route.length > CLIENT_LOG_ROUTE_MAX) {
    issues.push(issue("/route", "maxLength", `must NOT have more than ${CLIENT_LOG_ROUTE_MAX} characters`));
  }
  const corr = optString(body, ["correlationId", "correlation_id"], issues);
  if (corr !== undefined && !isCorrelationId(corr)) {
    issues.push(issue("/correlationId", "pattern", "must be 8-100 characters of [A-Za-z0-9._:-]"));
  }
  const source = optString(body, ["source"], issues);
  if (source !== undefined && !SOURCE_RE.test(source)) issues.push(issue("/source", "pattern", "must match [A-Za-z0-9._:/-]{1,80}"));
  const code = optString(body, ["code"], issues);
  if (code !== undefined && !CODE_RE.test(code)) issues.push(issue("/code", "pattern", "must match [A-Za-z0-9._:-]{1,80}"));
  let status: number | undefined;
  if (body.status !== undefined && body.status !== null) {
    if (typeof body.status !== "number" || !Number.isInteger(body.status) || body.status < 0 || body.status > 599) {
      issues.push(issue("/status", "type", "must be an integer 0..599"));
    } else {
      status = body.status;
    }
  }
  const stack = optString(body, ["stack", "stack_trace"], issues);
  const ts = optString(body, ["timestamp"], issues);
  if (ts !== undefined && ts.length > 40) issues.push(issue("/timestamp", "maxLength", "must NOT have more than 40 characters"));

  const rawDetail = body.detail !== undefined ? body.detail : body.context;
  const detailKey = body.detail !== undefined ? "detail" : "context";
  if (rawDetail !== undefined && rawDetail !== null && !isPlainObject(rawDetail)) {
    issues.push(issue(`/${detailKey}`, "type", "must be object"));
  }

  if (issues.length > 0) return { ok: false, issues };

  const record: ClientLogRecord = {
    level: level as StudioLogLevel,
    message: redactSecrets((message as string).trim()),
  };
  if (route) record.route = sanitizeRoute(route, CLIENT_LOG_ROUTE_MAX);
  if (corr) record.correlationId = corr;
  if (source) record.clientSource = source;
  if (code) record.code = code;
  if (status !== undefined) record.status = status;
  if (stack) {
    const s = redactSecrets(stack);
    record.stack = s.length > CLIENT_LOG_STACK_MAX ? `${s.slice(0, CLIENT_LOG_STACK_MAX)}...` : s;
  }
  if (rawDetail !== undefined && rawDetail !== null) record.detail = sanitizeDetail(rawDetail);
  if (ts) record.clientTimestamp = redactSecrets(ts);
  return { ok: true, record };
}
