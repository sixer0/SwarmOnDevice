/**
 * Kelengkapan dokumen (register 03_structural_sections_specs.md §8.4:
 * T2-60, T2-60a, T2-60b; D-131). Kemajuan bab per slot berulang =
 * `chapters.<slotKey>` (KD-15, bukan medan tetap `content`).
 *
 * `CompletenessSummary` = bentuk ringkas yang dibaca rel kelengkapan UI
 * (FIX-4a `shared/completeness-rail.tsx`, D-163/D-164). `CompletenessReportV2`
 * dapat ditetapkan langsung ke `CompletenessSummary` (dijaga cek tipe di bawah).
 */
import type { ChapterExpectedSource, StudioCompleteness, StudioSlotState } from "../../enums";

/** T2-60a */
export interface SlotStatusV2 {
  slotKey: string;
  label: string;
  sectionType: string;
  state: StudioSlotState;
  required: boolean;
  lastFilledBy: string | null;
  /** ISO 8601 UTC. */
  lastFilledAt: string | null;
  lastFilledRevisionNo: number | null;
}

/** T2-60b */
export interface ChapterProgressV2 {
  expected: string[];
  expectedSource: ChapterExpectedSource;
  present: Array<{ key: string; pid: string; by: string; at: string; revisionNo: number }>;
  missing: string[];
  minItems?: number;
  maxItems?: number;
}

/** T2-60 — juga isi kolom `StudioRevision.completenessReport`. */
export interface CompletenessReportV2 {
  status: StudioCompleteness;
  revisionNo: number;
  fullRenderAllowed: boolean;
  slots: SlotStatusV2[];
  chapters: Record<string, ChapterProgressV2>;
  /** `slotKey` atau `"<slotKey>:<kunci bab>"`. */
  missingRequired: string[];
  nextSteps: string[];
  message: string;
  /** Hanya INCOMPLETE. */
  forwardToController?: string;
}

/** Satu slot pada ringkasan kelengkapan (subset `SlotStatusV2`; medan tambahan opsional). */
export interface CompletenessSlotSummary {
  slotKey: string;
  state: StudioSlotState;
  required: boolean;
  label?: string | null;
  sectionType?: string;
  /** Slot berulang (berbab). */
  repeatable?: boolean;
  lastFilledBy?: string | null;
  lastFilledAt?: string | null;
  lastFilledRevisionNo?: number | null;
}

/** Kemajuan bab satu slot berulang pada ringkasan (subset `ChapterProgressV2`). */
export interface ChapterProgressSummary {
  expected?: string[];
  expectedSource?: ChapterExpectedSource;
  missing: string[];
  present?: Array<{ key: string; pid?: string; by?: string | null; at?: string | null; revisionNo?: number }>;
  minItems?: number;
  maxItems?: number;
}

/**
 * Ringkasan kelengkapan untuk UI (rel kelengkapan, daftar dokumen) dan respons
 * ringkas (GET R04 per dokumen). `chapters` dikunci slotKey berulang (KD-15).
 */
export interface CompletenessSummary {
  status: StudioCompleteness;
  fullRenderAllowed: boolean;
  revisionNo?: number;
  slots: CompletenessSlotSummary[];
  chapters?: Record<string, ChapterProgressSummary>;
  /** Kunci mentah, mis. `["controlSheet", "content:4"]`. */
  missingRequired: string[];
  message?: string;
  forwardToController?: string;
}

// Penjaga kompilasi: laporan lengkap selalu sah sebagai ringkasan.
type AssertAssignable<T extends U, U> = T;
export type _CompletenessReportIsSummary = AssertAssignable<CompletenessReportV2, CompletenessSummary>;
