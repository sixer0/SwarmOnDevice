/**
 * Tipe internal layanan kelengkapan (SR-11, register 03_structural_sections_specs.md
 * §0.1: `CompletenessInput` internal modul pemilik, tidak diekspor dari kontrak).
 *
 * Masukan sengaja berbentuk data polos (tanpa Prisma) agar layanan tetap murni:
 * pemanggil (ingest SR-12, submit SR-13, revisi SR-14, render SR-15, route R15)
 * memetakan kerangka (`NormSkeletonV2`/`TemplateSlotDef`) + baris M14/M15 revisi
 * ke bentuk ini.
 */
import type { StudioSlotContentMode } from "@/lib/studio/contract";

/** Satu bab (baris M15) slot berulang. */
export interface CompletenessChapterInput {
  /** Kunci bab ("3", "A"). */
  key: string;
  /** pid bab (identitas M18), mis. "bab-3". */
  pid: string;
  /** `M15.lastFilledBy`; null bila tidak diketahui (data lama). */
  by: string | null;
  /** `M15.lastFilledAt` (Date atau ISO 8601). */
  at: Date | string | null;
  /** `M15.lastFilledRevisionNo`. */
  revisionNo: number | null;
}

/** Baris M14 (`StudioDocSection`) revisi; null = tidak ada baris (slot OMIT). */
export interface CompletenessSlotRowInput {
  filled: boolean;
  /** `M14.payload`; untuk slot berulang dibaca `outline` (RepeatableSlotMetaV2). */
  payload: unknown;
  lastFilledBy: string | null;
  lastFilledAt: Date | string | null;
  lastFilledRevisionNo: number | null;
}

/** Satu slot kerangka (urut posisi dokumen) beserta baris revisinya. */
export interface CompletenessSlotInput {
  slotKey: string;
  sectionType: string;
  label: string;
  required: boolean;
  repeatable: boolean;
  minItems?: number | null;
  maxItems?: number | null;
  contentMode: StudioSlotContentMode;
  /** Aktif untuk tier dokumen (`tiers` kosong atau memuat tier). Slot tidak aktif tidak dicantumkan. */
  active: boolean;
  row: CompletenessSlotRowInput | null;
  /** Baris M15 slot ini (hanya slot berulang). */
  chapters?: CompletenessChapterInput[];
}

/** Identitas dokumen untuk teks (`completenessTexts` ctx, I48). */
export interface CompletenessTextContext {
  docId: string;
  docNumber: string;
  missionFolder?: string | null;
  docKey?: string | null;
}

/** Masukan `computeCompleteness` (I48). */
export interface CompletenessInput {
  revisionNo: number;
  /** Urut posisi dokumen (`structure.order`). */
  slots: CompletenessSlotInput[];
  doc: CompletenessTextContext;
  /**
   * Jenis kontrak templat (`StudioTemplate.contractKind`, MX08). Bila terdaftar di C58,
   * slot berulang kerangka jenis mengharapkan kunci CO wajib ∪ outline dokumen (05 §6.5).
   * Absen/null = perilaku non-kontrak (identik dengan sebelum DC-11).
   */
  contractKind?: string | null;
}
