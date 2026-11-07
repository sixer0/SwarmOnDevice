/**
 * Bentuk baris struktur per revisi (SR-10; register 03_structural_sections_specs.md
 * §3.1 M14-M17, §10). `StructureRows` adalah tipe internal modul (register §0.1)
 * yang dipakai bersama compose (I45 `ComposeResult.rows`) dan repositori ini
 * (I47 `writeRevisionRows` / `readRows`).
 *
 * Baris bebas DB: tidak memuat id baris, `revisionId`, atau id identitas.
 * Identitas dirujuk lewat `pid` (M18 per dokumen); induk dirujuk lewat kunci
 * alami (`slotKey`, `chapterKey`, `sectionNo`). Repositori memetakan kunci ke id.
 */
import type { InlineV2 } from "../../contract";
// Swarm patch (row 109, Prisma cut): the DB client is a DATUM Studio store transaction.
import type { StudioTx } from "../_swarm-store";

/** Klien DB: transaksi store (Swarm: `StoreTx`; tanpa klien global). */
export type StructureDb = StudioTx;

/** Cap pengisi terakhir (M14/M15). Waktu = ISO 8601 UTC. */
export interface FillStamp {
  lastFilledBy: string | null;
  lastFilledAt: string | null;
  lastFilledRevisionNo: number | null;
}

/** M14 — satu baris per slot aktif yang tidak di-OMIT (D-153, KD-08). */
export interface StructureSectionRow extends FillStamp {
  slotKey: string;
  sectionTypeKey: string;
  /** null = kerangka implisit (§6.3). */
  templateSlotId: string | null;
  /** Posisi dokumen 1..n kontigu. */
  position: number;
  filled: boolean;
  /** Tak-berulang: payload slot (memuat `type`); berulang: `RepeatableSlotMetaV2` atau null (KD-09). */
  payload: unknown | null;
  payloadSha256: string;
}

/** M15 — bab di slot berulang. */
export interface StructureChapterRow extends FillStamp {
  slotKey: string;
  chapterKey: string;
  pid: string;
  /** Urutan bab dalam slot (1-based). */
  position: number;
  partKey: string | null;
  title: InlineV2;
  shortTitle: string | null;
  contentSha256: string;
}

/** M16 — section bab; `sectionNo` 0 = intro bab (title null). */
export interface StructureSubsectionRow {
  chapterKey: string;
  pid: string;
  sectionNo: number;
  title: InlineV2 | null;
  contentSha256: string;
}

/** Isi internal (bentuk `NormBlock.content`) untuk tulis ganda `StudioBlock` (M06, §10). */
export interface StructureBlockInternal {
  content: unknown;
  contentSha256: string;
  textPlain?: string;
  type?: string;
}

/**
 * M17 — blok berpid. Blok bab: `chapterKey` + `sectionNo` terisi. Baris slot
 * tak-berulang (alamat `F:<slotKey>[/n]`, §4.6): `chapterKey`/`sectionNo` null.
 */
export interface StructureBlockRow {
  slotKey: string;
  chapterKey: string | null;
  sectionNo: number | null;
  pid: string;
  address: string;
  artifactLabel: string | null;
  /** Unik per revisi (1-based, urut dokumen). */
  ordinal: number;
  paraNo: number | null;
  type: string;
  /** Konten v2 apa adanya tanpa medan pid `id`. */
  content: unknown;
  textPlain: string;
  contentSha256: string;
  assetSha256: string | null;
  /** Isi internal untuk M06; absen = M06 memakai konten v2 (dicatat warn). */
  internal?: StructureBlockInternal;
}

export interface StructureRows {
  sections: StructureSectionRow[];
  chapters: StructureChapterRow[];
  subsections: StructureSubsectionRow[];
  blocks: StructureBlockRow[];
}

/** Spesifikasi instansiasi M14 per slot aktif (urut posisi dokumen). */
export interface SlotRowSpec {
  slotKey: string;
  sectionTypeKey: string;
  templateSlotId: string | null;
  position: number;
}

/** Jenis slot berulang (register §4.7: `repeatable` hanya untuk dua jenis ini). */
export const REPEATABLE_SECTION_TYPES: ReadonlySet<string> = new Set(["chapter", "appendix"]);

export function isRepeatableSectionType(sectionTypeKey: string): boolean {
  return REPEATABLE_SECTION_TYPES.has(sectionTypeKey);
}

/** Galat invarian baris (bug pemanggil, bukan galat kiriman agen). */
export class StructureRowsInvalidError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`structure rows invalid: ${issues.slice(0, 5).join("; ")}${issues.length > 5 ? ` (+${issues.length - 5})` : ""}`);
    this.name = "StructureRowsInvalidError";
    this.issues = issues;
  }
}

/** Rekonstruksi snapshot dari baris tidak menghasilkan sha tersimpan. */
export class StructureIntegrityError extends Error {
  readonly details: Record<string, unknown>;
  constructor(message: string, details: Record<string, unknown>) {
    super(message);
    this.name = "StructureIntegrityError";
    this.details = details;
  }
}
