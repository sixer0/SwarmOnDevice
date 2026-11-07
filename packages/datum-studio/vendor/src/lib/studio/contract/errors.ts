/**
 * Galat Studio (01_specs.md §6.1, §6.3).
 * Bentuk respons: `{ error: <pesan>, code: StudioErrorCode, details? }` (pola
 * `{ error }` repo + `code`).
 *
 * Tanpa impor `next/server` agar modul ini (dan env.ts yang memakainya) aman
 * diimpor komponen klien: `studioError` membangun `Response.json` standar
 * (bentuk kawat identik dengan `NextResponse.json`; route handler App Router
 * menerima `Response`).
 */
import type { StudioErrorCode } from "./enums";

/**
 * Status HTTP per kode. Kode "dalam job" (PDF_*, RENDER_TIMEOUT) biasanya
 * dilaporkan di `job.errors`; status di sini dipakai bila route harus gagal
 * keras (mis. hanya PDF diminta -> 503 PDF_ENGINE_UNAVAILABLE).
 */
export const STUDIO_ERROR_HTTP: Readonly<Record<StudioErrorCode, number>> = {
  UNAUTHORIZED: 401,
  PARAM_CLASS_K_FORBIDDEN: 403,
  PARAM_CLASS_T_READONLY: 400,
  PARAM_UNKNOWN_KEY: 422,
  SCHEMA_INVALID: 400,
  JSON_MALFORMED: 400,
  CHANGE_FIELDS_REQUIRED: 400,
  CHANGE_NOTE_REQUIRED: 400,
  ADDRESS_INVALID: 400,
  ADDRESS_NOT_FOUND: 404,
  DOCUMENT_NOT_FOUND: 404,
  REVISION_NOT_FOUND: 404,
  TEMPLATE_NOT_FOUND: 404,
  ARTIFACT_NOT_FOUND: 404,
  FILE_NOT_FOUND: 404,
  MISSION_REF_NOT_FOUND: 404,
  DOC_NUMBER_EXISTS: 409,
  TEMPLATE_SLUG_EXISTS: 409,
  REVISION_CONFLICT: 409,
  VERSION_CONFLICT: 409,
  RENDER_IN_PROGRESS: 409,
  BY_CONSTRUCTION_FAILED: 422,
  CHART_KIND_NOT_DRAWN: 422,
  CHART_KIND_UNKNOWN: 422,
  "DATUM-31": 422,
  "DATUM-39": 422,
  PAYLOAD_TOO_LARGE: 413,
  ASSET_TOO_LARGE: 413,
  ASSET_TYPE_UNSUPPORTED: 415,
  PATH_OUTSIDE_ROOT: 403,
  FILE_MISSING_ON_DISK: 410,
  PDF_ENGINE_UNAVAILABLE: 503,
  PDF_CONVERT_FAILED: 500,
  RENDER_TIMEOUT: 504,
  STORAGE_ROOT_FORBIDDEN: 500,
  REGISTRY_KIND_UNKNOWN: 400,
  // Delta S03-d1: kegagalan peluncuran/operasi Chromium (S25), perakitan HTML
  // (S24 HtmlAssembleError), render job dan tulis berkas keluaran (S51).
  BROWSER_UNAVAILABLE: 503,
  HTML_RENDER_FAILED: 500,
  RENDER_FAILED: 500,
  STORAGE_WRITE_FAILED: 500,
  // Delta S03-d2: sesi sah tetapi peran tidak berhak (401 tetap UNAUTHORIZED).
  FORBIDDEN: 403,
  // Delta FIX-1 (S87 M-03, L-07): respons membawa header Retry-After (429/503).
  RATE_LIMITED: 429,
  RENDER_QUEUE_FULL: 503,
  UNSUPPORTED_MEDIA_TYPE: 415,
  // Delta SR-04 (register §11.2, EC01-EC24). ASSET_NOT_FOUND satu status 422
  // (KD-24); GET R18 sha tak dikenal memakai FILE_NOT_FOUND 404.
  SLOT_UNKNOWN: 422,
  SLOT_REQUIRED_MISSING: 422,
  SLOT_DUPLICATE: 422,
  SLOT_POSITION_LOCKED: 422,
  SLOT_TYPE_MISMATCH: 422,
  SLOT_FORBIDDEN_FOR_TIER: 422,
  SLOT_INPUT_NOT_ACCEPTED: 422,
  SLOT_ITEMS_OUT_OF_RANGE: 422,
  BLOCK_TYPE_NOT_ADMITTED: 422,
  SLOT_USE_CHAPTER_ENDPOINT: 422,
  SLOT_PARAM_SCOPE_INVALID: 422,
  PARAM_SURFACE_FORBIDDEN: 403,
  PRESET_READONLY: 403,
  INLINE_FORMAT_REJECTED: 422,
  DOC_TARGET_AMBIGUOUS: 400,
  META_REQUIRED_FOR_CREATE: 400,
  META_CONFLICT: 409,
  TEMPLATE_MISMATCH: 409,
  SCOPE_CONFLICT: 409,
  PID_NOT_FOUND: 404,
  PID_CONFLICT: 422,
  ASSET_NOT_FOUND: 422,
  DOCUMENT_INCOMPLETE: 409,
  CHAPTER_KEY_INVALID: 422,
  // FIX-HR2 (D-332 C9): path Studio tak dikenal (catch-all FIX-H6).
  ROUTE_NOT_FOUND: 404,
  // Delta DC-05 (register 05 §13.1, EC25-EC28): semua 422 (langkah 6b/9a/9, §5.6).
  CONTRACT_REF_NOT_FOUND: 422,
  CONTRACT_REF_PID_NOT_FOUND: 422,
  CONTRACT_ITEM_KEY_DUPLICATE: 422,
  CHART_CUSTOM_FORM_UNSUPPORTED: 422,
  // Swarm patch (row 69a, C78; templates spec §4): new document on an archived template.
  TEMPLATE_ARCHIVED: 403,
};

/** Galat mesin/layanan bertipe kode; route memetakan ke HTTP lewat studioError. */
export class StudioEngineError extends Error {
  readonly code: StudioErrorCode;
  readonly details?: unknown;

  constructor(code: StudioErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "StudioEngineError";
    this.code = code;
    this.details = details;
  }

  get httpStatus(): number {
    return STUDIO_ERROR_HTTP[this.code];
  }
}

/**
 * Dilempar stub S03 sampai baris pemilik mengisi modul. Argumen tambahan
 * (masukan pemanggil) hanya dihitung, tidak disimpan, agar tidak membocorkan isi.
 */
export class StudioNotImplemented extends Error {
  readonly moduleId: string;
  readonly receivedArgs: number;

  constructor(moduleId: string, ...received: unknown[]) {
    super(`Studio module not implemented: ${moduleId}`);
    this.name = "StudioNotImplemented";
    this.moduleId = moduleId;
    this.receivedArgs = received.length;
  }
}

export interface StudioErrorBody {
  error: string;
  code: StudioErrorCode;
  details?: unknown;
}

/** Respons galat standar Studio. */
export function studioError(code: StudioErrorCode, message: string, details?: unknown): Response {
  const body: StudioErrorBody = details === undefined ? { error: message, code } : { error: message, code, details };
  return Response.json(body, { status: STUDIO_ERROR_HTTP[code] });
}

/** Petakan galat apa pun ke respons Studio; galat tak dikenal tidak membocorkan detail. */
export function studioErrorFrom(e: unknown): Response {
  if (e instanceof StudioEngineError) return studioError(e.code, e.message, e.details);
  return Response.json({ error: "Internal error" }, { status: 500 });
}

export function isStudioEngineError(e: unknown): e is StudioEngineError {
  return e instanceof StudioEngineError;
}
