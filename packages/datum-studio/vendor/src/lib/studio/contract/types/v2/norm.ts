/**
 * Snapshot ternormalisasi `studio.norm/v2` (SID06; register 03_structural_sections_specs.md
 * §4.6 T2-50..T2-54, §10 T2-55). Internal (kolom `StudioRevision.snapshot`),
 * tidak dipublikasikan sebagai JSON Schema. `studio.norm/v1` tetap valid; jalur
 * render ditentukan `snapshot.schema` (KD-10).
 */
import type { StudioIdentityKind, StudioSlotContentMode, StudioSlotState, StudioTier } from "../../enums";
import type { ParamValue } from "../common";
import type { RegisterEntry, StudioDocV1 } from "../doc";
import type { NormBlock, NormDocSnapshot, NormUnit } from "../model";
import type { StudioDocV2Resolved } from "./doc";
import type { StudioSkeletonV1 } from "./template";

/** T2-50 */
export interface NormSlotV2 {
  slotKey: string;
  sectionType: string;
  label: string;
  /** Posisi dokumen; 0 bila tidak aktif/OMITTED. */
  position: number;
  required: boolean;
  repeatable: boolean;
  contentMode: StudioSlotContentMode;
  active: boolean;
  omitted: boolean;
  state: StudioSlotState;
}

/** T2-51 — `implicit` = kerangka dari `sectionPlan` versi templat lama (§6.3). */
export interface NormSkeletonV2 {
  templateVersionId: string;
  skeletonSha256: string;
  implicit: boolean;
  slots: NormSlotV2[];
}

/** T2-52 — `NormUnitKind` diperluas `"slot"`; `placeholder` = slot wajib kosong pada render draf. */
export interface NormUnitV2 extends NormUnit {
  slotKey: string;
  sectionType: string;
  placeholder?: boolean;
}

/** T2-53 — `blockId` = pid. */
export interface NormBlockV2 extends NormBlock {
  pid: string;
  slotKey: string;
  assetSha256?: string;
}

// ── Delta IP-48 (D-193): konteks compose ulang `snapshot.compose` (+ atas T2-54) ──

/**
 * Tujuh belas kunci parameter yang dibaca compose (tingkat dokumen dan slot), D-193 (+4 RQ-8/D-224, +1 C10 R-69,
 * +1 C27 R-79; keduanya dibuang dari konteks tersimpan bila absen/null/bawaan, spike research/35 C-5).
 * Sumber kanonik daftar; `services/compose/context.ts` `COMPOSE_PARAM_KEYS`
 * wajib sama (urutan = urutan proyeksi).
 */
export const NORM_COMPOSE_PARAM_KEYS = [
  "render.run.symbolGlyphs",
  "chart.output.widthMm",
  "diagram.widthMm",
  "grid.textColumnMm",
  "grid.allowedFigureWidthsMm",
  "render.table.columnProfiles",
  "chart.composite.columns",
  "chart.composite.gapMm",
  "slot.setup",
  "slot.placement",
  "slot.placeholderText",
  "render.toc.title",
  "render.toc.note",
  "image.widthMm",
  "symbolSheet.widthMm",
  "controlSheet.columns.form",
  "cover.controlBlock.preparerUnit",
] as const;

export type NormComposeParamKey = (typeof NORM_COMPOSE_PARAM_KEYS)[number];

/** Nilai efektif hanya untuk kunci compose; kunci absen = tidak ada nilai efektif. */
export type NormComposeParams = Partial<Record<NormComposeParamKey, ParamValue>>;

/** Kerangka yang dipakai compose (bentuk `SkeletonInput` layanan compose). */
export interface NormComposeSkeleton {
  templateVersionId: string;
  skeleton: StudioSkeletonV1;
  skeletonSha256: string;
  implicit: boolean;
  /** Id M10 per slotKey (`StudioDocSection.templateSlotId`); absen/implisit = null. */
  templateSlotIds?: Readonly<Record<string, string>>;
}

/** Metadata aset per sha256 (bentuk `ComposeAssetInfo` layanan compose). */
export interface NormComposeAsset {
  mime: "image/png" | "image/jpeg";
  /** `relPath` M13 (`assets/<xx>/<sha>.<ext>`, relatif STUDIO_WORKSPACE_ROOT). */
  relPath?: string;
  widthPx?: number;
  heightPx?: number;
}

/**
 * Konteks compose tersimpan agar rekonstruksi M14-M18 -> compose ulang -> sha
 * sama (register §4.6, SC-5) berjalan tanpa DB templat. Versi `v: 1`.
 */
export interface NormComposeContext {
  v: 1;
  skeleton: NormComposeSkeleton;
  tier: StudioTier;
  params: NormComposeParams;
  /** Per slotKey; absen = `params`. */
  slotParams?: Record<string, NormComposeParams>;
  assets?: Record<string, NormComposeAsset>;
}

/** T2-54 */
export interface NormDocSnapshotV2 {
  schema: "studio.norm/v2";
  /** Bentuk internal hasil compose (mesin tidak berubah); `chapters` boleh []. */
  doc: StudioDocV1;
  /** Konten v2 tergabung (T2-49). */
  source: StudioDocV2Resolved;
  skeleton: NormSkeletonV2;
  units: NormUnitV2[];
  blocks: NormBlockV2[];
  /** pid -> "Tabel 3.1" | "Gambar 3.1" | "Turunan D-3.1". */
  numbering: Record<string, string>;
  register: Record<string, RegisterEntry>;
  /** Delta IP-48 (D-193): konteks compose ulang; absen pada snapshot sebelum SR-08. */
  compose?: NormComposeContext;
}

/** Snapshot apa pun yang dapat dirender (`renderSnapshot` parameter 1, register §15.1). */
export type AnyNormSnapshot = NormDocSnapshot | NormDocSnapshotV2;

/**
 * T2-55 — pembangkit pid (KD-22): acak kriptografis di layanan DB (C20 + C22
 * karakter C21); deterministik berbenih di jalur murni CLI/uji.
 */
export interface PidAllocator {
  next(kind: StudioIdentityKind, hint: string): string;
}

/** true bila snapshot berbentuk `studio.norm/v2`. */
export function isNormSnapshotV2(s: AnyNormSnapshot): s is NormDocSnapshotV2 {
  return s.schema === "studio.norm/v2";
}
