/**
 * Tipe importer Markdown resmi `md/v1` (FIX-H7, D-321/D-322; laporan uji Hermes G3).
 *
 * Importer hanya MENGUBAH Markdown menjadi isi `studio.chapter/v2` konten-saja (D-139):
 * tidak menyimpan, tidak merender. Apa pun yang bersifat tampilan (nomor bab/section,
 * perataan kolom, garis pemisah, HTML bergaya, coretan) dibuang dan dicatat di `dropped`.
 */
import type { ChapterV2, DocMetaV2, DocTargetV2, StudioChapterV2, ValidationIssue } from "../../contract";

/** Versi importer; berubah hanya bila pemetaan berubah (keluaran lama tetap dapat dilacak). */
export const MD_IMPORTER_VERSION = "md/v1" as const;
export type MdImporterVersion = typeof MD_IMPORTER_VERSION;

/** Konstruksi Markdown yang dipetakan (kolom `md` di `mapping`). */
export type MdConstruct =
  | "heading1"
  | "heading2"
  | "heading3"
  | "paragraph"
  | "image"
  | "list"
  | "table"
  | "code"
  | "blockquote"
  | "html";

/** Jenis buangan: tampilan, HTML mentah, struktur yang tidak dimodelkan kontrak, atau isi. */
export type MdDropKind = "display" | "html" | "structure" | "content";

export interface MdImportWarning {
  code: string;
  /** Baris Markdown 1-based (0 = seluruh berkas). */
  line: number;
  message: string;
}

export interface MdImportDropped {
  code: string;
  line: number;
  kind: MdDropKind;
  /** Cuplikan sumber (maks 120 karakter). */
  excerpt: string;
}

export interface MdImportMapping {
  line: number;
  md: MdConstruct;
  /** JSON Pointer relatif keluaran (`/chapter/...`). */
  pointer: string;
}

export interface MdImportReport {
  importer: MdImporterVersion;
  warnings: MdImportWarning[];
  dropped: MdImportDropped[];
  mapping: MdImportMapping[];
}

/** Amplop kiriman opsional (bila target diberikan, keluaran memuat `submission` siap POST R12). */
export interface MdEnvelopeOptions {
  target: DocTargetV2;
  template?: { slug: string; version?: number };
  meta?: DocMetaV2;
  slot?: string;
}

export interface MarkdownImportOptions {
  /** Kunci bab (C33a `^[1-9][0-9]{0,2}$` atau C33b `^[A-Z]$`). */
  chapterKey: string;
  /** Judul bab; menimpa `#` bila keduanya ada (peringatan `TITLE_OVERRIDDEN`). */
  title?: string;
  agentId?: string;
  /** Bahasa label bawaan yang terpaksa dibangkitkan importer (label blok kode). Bawaan "ID". */
  language?: "ID" | "EN";
  envelope?: MdEnvelopeOptions;
}

export interface MarkdownImportValidation {
  valid: boolean;
  issues: ValidationIssue[];
}

export interface MarkdownImportResult {
  chapter: ChapterV2;
  /** Hanya bila `envelope` diberikan: kiriman `studio.chapter/v2` lengkap. */
  submission?: StudioChapterV2;
  report: MdImportReport;
  /** Validator skema v2 repo (ajv bersama + `classifySchemaV2Errors`). */
  validation: MarkdownImportValidation;
}
