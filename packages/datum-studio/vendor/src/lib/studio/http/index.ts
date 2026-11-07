/**
 * Helper HTTP bersama route Studio (`src/app/api/studio/**`; IP-08, F-024).
 *
 * Satu sumber untuk: konteks permintaan + `x-correlation-id`, log JSONL tahan
 * lama, pemetaan galat §6.3 tanpa stack trace, badan JSON berbatas (juga
 * chunked), validasi ringan, sanitasi keluaran/log, pembatas laju, skema
 * client-log. Multipart ada di `@/lib/studio/http/multipart` (menarik layanan
 * gambar S53, tidak diekspor ulang di sini).
 *
 * Hanya runtime node (node:fs, node:crypto).
 */
export { apiLog, apiLogDir, STUDIO_API_SOURCE, type StudioApiLogEntry, type StudioApiLogInput, type StudioLogLevel } from "./log";
export { CORRELATION_HEADER, NO_STORE, correlationIdOf, isCorrelationId, json, reqCtx, withCorrelation, type ReqCtx } from "./context";
export { failure, reject, retryAfterOf, schemaInvalid, type FailureOptions } from "./errors";
export {
  assertJsonContentType,
  assertJsonDepth,
  isJsonMediaType,
  jsonDepthExceeds,
  STUDIO_MAX_JSON_DEPTH,
  parseJsonText,
  readBodyBytes,
  readJsonBody,
  readJsonObject,
  type BodyLimitCode,
  type JsonBodyResult,
  type JsonObjectResult,
  type ReadJsonOptions,
} from "./body";
export { isPlainObject, isPlausibleId, isRecord, issue, parsePosInt, positiveIntParam, ptr } from "./validation";
export {
  DEFAULT_SANITIZE_LIMITS,
  REDACTED,
  isSecretKey,
  redactPaths,
  redactSecrets,
  sanitizeJson,
  sanitizeRoute,
  stripStack,
  type SanitizeLimits,
} from "./sanitize";
export { createFixedWindowLimiter, type FixedWindowLimiter, type RateLimitResult } from "./rate-limit";
export {
  checkRenderRate,
  renderRateIdentity,
  resetRenderRateLimiter,
  RENDER_RATE_LIMIT_DEFAULT,
  RENDER_RATE_WINDOW_MS_DEFAULT,
} from "./render-guard";
export {
  applyQuotaHeaders,
  checkQueryRate,
  QUERY_RATE_LIMIT_DEFAULT,
  QUERY_RATE_WINDOW_MS_DEFAULT,
  QUOTA_BUCKETS,
  quotaRateIdentity,
  quotaReport,
  recordQuotaCharge,
  resetQueryRateLimiter,
  STUDIO_QUOTA_BUCKET_HEADER,
  STUDIO_QUOTA_REMAINING_HEADER,
  withQuotaHeaders,
  type QuotaBucket,
} from "./quota";
export {
  CLIENT_LOG_DETAIL_MAX_BYTES,
  CLIENT_LOG_MAX_BYTES,
  CLIENT_LOG_MESSAGE_MAX,
  CLIENT_LOG_RATE_LIMIT,
  CLIENT_LOG_RATE_WINDOW_MS,
  CLIENT_LOG_ROUTE_MAX,
  CLIENT_LOG_SOURCE,
  CLIENT_LOG_STACK_MAX,
  parseClientLog,
  type ClientLogParse,
  type ClientLogRecord,
} from "./client-log";
export {
  appendJsonlDaily,
  logFilePattern,
  logMaxFileBytes,
  logRetentionDays,
  purgeOldLogs,
  resetLogPurgeSchedule,
  STUDIO_LOG_MAX_FILE_BYTES_DEFAULT,
  STUDIO_LOG_RETENTION_DAYS_DEFAULT,
} from "./jsonl";
