/**
 * Tipe generator `md2contract/v1` (DC-24; register masterplan/05_document_contract_specs.md
 * §15 I64, §16, §13.2 CW-02..CW-04, KD-42, BA-24).
 *
 * Masukan = laporan kerja agen Markdown lama (F1 laporan tunggal, F2 entri PHASE-REPORTS),
 * bukan `contract.md` (BA-24). Keluaran = satu `studio.doc/v2` templat CK-01.
 * Generator murni dan deterministik: tidak menyimpan, tidak merender, tanpa cap waktu.
 */
import type { ContractKind, ContractWarningCode, StudioDocV2, ValidationIssue } from "../../../contract";
import type { MdImportDropped, MdImportWarning } from "../types";

export const MD2CONTRACT_GENERATOR = "md2contract/v1" as const;

/** I64 `opts`. Semua nilai fallback (`status`, `reportedAt`) hanya dipakai bila kepala tidak memberi nilai berpeta. */
export interface ContractImportOptions {
  kind: ContractKind;
  /** `mission.folder` dokumen (bukan `<misi>` baris `[FASE]`, GL-12). */
  mission?: string;
  docKey?: string;
  docNumber?: string;
  /** Menimpa judul `#` pertama. */
  docTitle?: string;
  /** Fallback `--status` (KD-42): kode E45 atau alias GS. */
  status?: string;
  /** Fallback `--reported-at`: tanggal atau waktu ber-zona (C37; `WIB` -> `+07:00`). */
  reportedAt?: string;
  /** F2: entri ke-n (1-based) atau `last` (bawaan). Memaksa bentuk F2 bila diberikan. */
  entry?: number | "last";
  /**
   * R3-01 (U-15, D-435): alias TAMBAHAN di atas alias registri (`aliases.headerKeys` /
   * `aliases.headings`), dipakai `studio-report` untuk laporan MD-native (nama medan CF dan judul
   * outline CO). Alias registri menang bila kunci sama. Tanpa opsi ini keluaran tidak berubah
   * (`md2contract` tidak memberikannya; golden dc24/dc35 tetap).
   */
  extraAliases?: {
    /** Kunci kepala huruf kecil -> tujuan GF (`status`, `owner`, `taskRef`, `reportedAt`, `cardIds`, `verdict`). */
    headerKeys?: Readonly<Record<string, string>>;
    /** Judul `##` ternormalisasi (`normalizeHeading`) -> `content:<n>` / `references`. */
    headings?: Readonly<Record<string, string>>;
  };
}

export interface ContractImportWarning {
  code: ContractWarningCode;
  /** Baris Markdown sumber 1-based (0 = seluruh berkas). */
  line: number;
  message: string;
  details?: unknown;
}

/** Catatan pemetaan non-peringatan (nilai tak sah, baris dilewati, batas). Kode bebas, stabil. */
export interface ContractImportNote {
  code: string;
  line: number;
  message: string;
}

export interface ContractRecordMapping {
  field: string;
  /** `header` (baris `Kunci: nilai`), `frontmatter`, `label` (F2), `entryHeading` (GL-13), `phaseLine` (GL-12), `scan` (id C34), `table`, `option`. */
  source: string;
  line: number;
  raw?: string;
  value: unknown;
}

export interface ContractHeadingMapping {
  line: number;
  heading: string;
  normalized: string;
  /** Tujuan alias GA (`content:<n>` / `references`) atau `null` (CW-03). */
  target: string | null;
}

export interface ContractChapterMapping {
  key: string;
  title: string;
  /** Kunci outline CO (E50) atau `null` untuk bab tambahan (kunci >= 6). */
  outlineKey: string | null;
  sources: Array<{ line: number; heading: string }>;
}

export interface ContractProseReport {
  chapterKey: string;
  warnings: MdImportWarning[];
  dropped: MdImportDropped[];
}

export interface ContractItemTableMapping {
  line: number;
  keyColumn: string;
  statusColumn: string;
  rows: number;
  admitted: number;
}

export interface ContractImportMapping {
  form: "F1" | "F2";
  entry: { index: number; count: number; line: number; mission: string | null } | null;
  title: { source: "option" | "heading" | "fallback"; line: number };
  record: ContractRecordMapping[];
  headings: ContractHeadingMapping[];
  chapters: ContractChapterMapping[];
  /** Kunci CO wajib yang tidak berisi apa pun di sumber (generator tidak mengarang isi). */
  missingChapters: string[];
  references: { lines: number[]; entries: number } | null;
  itemTables: ContractItemTableMapping[];
  prose: ContractProseReport[];
  notes: ContractImportNote[];
}

export interface ContractImportReport {
  generator: typeof MD2CONTRACT_GENERATOR;
  warnings: ContractImportWarning[];
  mapping: ContractImportMapping;
}

export interface ContractImportValidation {
  valid: boolean;
  issues: ValidationIssue[];
}

export interface ContractImportResult {
  doc: StudioDocV2;
  report: ContractImportReport;
  /** Validator v2 repo (ajv bersama + `classifySchemaV2Errors`), tanpa DB. */
  validation: ContractImportValidation;
}

/** Kode galat generator; `exitCode` = kode keluar CLI §16.6 (2 pemakaian, 3 nilai wajib hilang). */
export type ContractImportErrorCode = "MD2CONTRACT_USAGE" | "MD2CONTRACT_REQUIRED_MISSING";

/**
 * Dilempar bila dokumen tidak dapat dibangun tanpa menebak (KD-42) atau masukan tidak sah.
 * `MD2CONTRACT_REQUIRED_MISSING` membawa laporan (peringatan CW-02 dsb.) agar CLI dapat mencetaknya.
 */
export class ContractImportError extends Error {
  readonly code: ContractImportErrorCode;
  readonly exitCode: 2 | 3;
  readonly missing: ReadonlyArray<"status" | "reportedAt">;
  readonly report: ContractImportReport | null;
  constructor(
    code: ContractImportErrorCode,
    message: string,
    extra: { missing?: ReadonlyArray<"status" | "reportedAt">; report?: ContractImportReport } = {},
  ) {
    super(message);
    this.name = "ContractImportError";
    this.code = code;
    this.exitCode = code === "MD2CONTRACT_USAGE" ? 2 : 3;
    this.missing = extra.missing ?? [];
    this.report = extra.report ?? null;
  }
}
