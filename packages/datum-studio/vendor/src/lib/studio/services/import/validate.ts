/**
 * Validasi hasil importer `md/v1` dengan validator v2 repo (FIX-H7): instans ajv bersama
 * (`ingest/validate` `studioValidator`) + pemeta tunggal `classifySchemaV2Errors` kontrak
 * (DISPLAY_FIELD / V1_FIELD), sama dengan R08/R12. Tanpa DB.
 *
 * Tanpa amplop (`envelope` tidak diberikan), bab dibungkus kiriman `studio.chapter/v2`
 * dengan target pratinjau sintetis hanya demi validasi; isu di luar `/chapter` dibuang
 * sehingga pointer tetap relatif keluaran importer (`/chapter/...`).
 */
import { STUDIO_SCHEMA_BASE_URL, classifySchemaV2Errors, type ChapterV2, type StudioChapterV2, type ValidationIssue } from "../../contract";
import { studioValidator } from "../ingest/validate";
import type { MarkdownImportValidation } from "./types";

const CHAPTER_V2_REF = `${STUDIO_SCHEMA_BASE_URL}/studio.chapter/v2.json`;
const PREVIEW_TARGET = { documentId: "md-import-preview" } as const;
const MAX_ISSUES = 500;

export function validateImported(chapter: ChapterV2, submission?: StudioChapterV2): MarkdownImportValidation {
  const envelope: StudioChapterV2 = submission ?? { $schema: "studio.chapter/v2", target: { ...PREVIEW_TARGET }, chapter };
  // Skema tidak terdaftar = cacat server: `studioValidator` melempar Error (tidak disamarkan).
  const v = studioValidator(CHAPTER_V2_REF);
  if (v(envelope)) return { valid: true, issues: [] };
  const all: ValidationIssue[] = classifySchemaV2Errors("studio.chapter/v2", envelope, v.errors);
  const scoped = submission ? all : all.filter((i) => i.pointer.startsWith("/chapter"));
  const issues = scoped.length > 0 ? scoped : all;
  return { valid: false, issues: issues.slice(0, MAX_ISSUES) };
}
