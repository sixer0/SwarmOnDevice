/**
 * Perkakas v2 privat route R04 `/api/studio/documents`, R05
 * `/api/studio/documents/[id]` dan R08 `/api/studio/validate` (SR-20,
 * register 03_structural_sections_specs.md §4.5, §8.4, §11.1, §12).
 *
 * - `schemaRootOf`: id skema v2 dari `$schema` tingkat atas badan.
 * - `validateV2`: ajv 2020 instans bersama proses (SR-55 M8, `ingest/validate`
 *   `studioValidator`) dan pemeta TUNGGAL `classifySchemaV2Errors` kontrak (D-172:
 *   issue `checkId` DISPLAY_FIELD / V1_FIELD / RENDER_FIELD; tidak ditulis ulang di sini).
 *   Hanya bentuk; aturan struktur (SLOT_*, DOC_TARGET_AMBIGUOUS, ...) milik
 *   layanan compose/submit.
 * - `asCompletenessReport`: pengaman bentuk `StudioRevision.completenessReport`
 *   (kolom Json) sebelum dikirim sebagai `CompletenessReportV2`.
 */
import {
  STUDIO_COMPLETENESS_STATUSES,
  STUDIO_SCHEMA_URL_BASE,
  classifySchemaV2Errors,
  type CompletenessReportV2,
  type StudioCompleteness,
  type ValidationIssue,
} from "@/lib/studio/contract";
import { StudioEngineError } from "@/lib/studio/contract/errors";
import { isRecord } from "@/lib/studio/http";
import { studioValidator } from "@/lib/studio/services/ingest/validate";

/** Id skema kiriman v2 yang diterima R04 (doc) dan R08 (doc/chapter/slot). */
export const V2_SUBMISSION_SCHEMAS = ["studio.doc/v2", "studio.chapter/v2", "studio.slot/v2"] as const;
export type V2SubmissionSchema = (typeof V2_SUBMISSION_SCHEMAS)[number];

/** Batas isu per validasi (allErrors pada oneOf dapat meledak). */
const MAX_V2_ISSUES = 500;

export function isV2SubmissionSchema(v: unknown): v is V2SubmissionSchema {
  return typeof v === "string" && (V2_SUBMISSION_SCHEMAS as readonly string[]).includes(v);
}

/** `$schema` tingkat atas: id v2 yang dikenal, `"other"` bila string lain, `null` bila absen (v1). */
export function schemaRootOf(body: Record<string, unknown>): V2SubmissionSchema | "other" | null {
  const s = body.$schema;
  if (s === undefined) return null;
  return isV2SubmissionSchema(s) ? s : "other";
}

/** Skema kontrak gagal dikompilasi/tidak terdaftar = cacat server (Error -> 500 lewat failFrom). */
function validatorFor(id: V2SubmissionSchema) {
  return studioValidator(`${STUDIO_SCHEMA_URL_BASE}/${id}.json`);
}

/**
 * Validasi bentuk kiriman v2. Isu berpointer relatif `data` (+ `prefix`);
 * medan tampilan -> `checkId: "DISPLAY_FIELD"`, medan v1 -> `"V1_FIELD"`.
 */
export function validateV2(id: V2SubmissionSchema, data: unknown, prefix = ""): ValidationIssue[] {
  const v = validatorFor(id);
  if (v(data)) return [];
  const issues = classifySchemaV2Errors(id, data, v.errors, prefix);
  if (issues.length <= MAX_V2_ISSUES) return issues;
  return [...issues.slice(0, MAX_V2_ISSUES), { pointer: prefix, keyword: "maxIssues", message: `Isu skema dipotong pada ${MAX_V2_ISSUES}` }];
}

/** 400 SCHEMA_INVALID kiriman v2 (urutan §11.1 butir 2), pesan berbahasa Indonesia. */
export function v2SchemaError(id: V2SubmissionSchema, issues: ValidationIssue[]): StudioEngineError {
  const display = issues.some((i) => i.checkId === "DISPLAY_FIELD");
  const v1 = issues.some((i) => i.checkId === "V1_FIELD");
  const render = issues.some((i) => i.checkId === "RENDER_FIELD");
  const hint = render
    ? " render tidak diterima di kiriman; build lewat POST /api/studio/documents/{id}/render sesudah kiriman tersimpan."
    : display
      ? " Medan tampilan tidak diterima; tampilan diatur templat. Hapus medan pada pointer yang disebut."
      : v1
        ? " Medan v1 tidak diterima di v2; ganti sesuai pesan isu."
        : "";
  return new StudioEngineError("SCHEMA_INVALID", `Kiriman tidak sesuai ${id}.${hint}`, issues);
}

// ── Kelengkapan ──────────────────────────────────────────────────────────

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

function isCompletenessStatus(v: unknown): v is StudioCompleteness {
  return typeof v === "string" && (STUDIO_COMPLETENESS_STATUSES as readonly string[]).includes(v);
}

/** Laporan kelengkapan tersimpan (Json) -> `CompletenessReportV2`, atau null bila bentuknya tidak sah/absen. */
export function asCompletenessReport(v: unknown): CompletenessReportV2 | null {
  if (!isRecord(v)) return null;
  if (!isCompletenessStatus(v.status) || typeof v.revisionNo !== "number" || typeof v.fullRenderAllowed !== "boolean") return null;
  if (!Array.isArray(v.slots) || !isRecord(v.chapters) || !isStringArray(v.missingRequired)) return null;
  if (!isStringArray(v.nextSteps) || typeof v.message !== "string") return null;
  if (v.forwardToController !== undefined && typeof v.forwardToController !== "string") return null;
  return v as unknown as CompletenessReportV2;
}

/** Ringkasan GET R04 per dokumen: `{ status, missingRequired }`. */
export function completenessBrief(
  status: StudioCompleteness,
  report: unknown,
): { status: StudioCompleteness; missingRequired: string[] } {
  const r = asCompletenessReport(report);
  return { status, missingRequired: r ? r.missingRequired : [] };
}

