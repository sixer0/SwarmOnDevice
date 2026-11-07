/**
 * Templat v2 dan kerangka (register 03_structural_sections_specs.md §4.7:
 * T2-56..T2-59; blueprint §2.3). Dipakai editor templat dan R01/R02/R19;
 * agen tidak memakainya. `essentials`/`advanced` dikunci per kunci parameter
 * rinci (KD-21); `$schema` (bukan `schema`) sesuai KD-14.
 */
import type { StudioSlotContentMode, StudioTier } from "../../enums";
import type { ParamValue } from "../common";
import type { SectionSetup } from "../doc";

/**
 * Nilai parameter `slot.setup` (R-41): `SectionSetup` tanpa `pageSizeTw`
 * (ukuran halaman = turunan `page.sizeMm`, KD-25) ditambah dua medan yang
 * dibuka kenop esensial Konten (D-165 KT-10; permintaan SR-05).
 */
export type SlotSetup = Omit<SectionSetup, "pageSizeTw"> & { startOnNewPage?: boolean; runningHead?: boolean };

/** T2-56 */
export interface TemplateSlotDef {
  /** C18. */
  slotKey: string;
  /** C33 `SLOT_SECTION_TYPES` (registri SR-05). */
  sectionType: string;
  label: string;
  /** 1..n kontigu. */
  position: number;
  required: boolean;
  positionLocked: boolean;
  repeatable: boolean;
  minItems?: number;
  maxItems?: number;
  contentMode: StudioSlotContentMode;
  /** Kosong = semua tier. */
  tiers: StudioTier[];
  /** Subset `CONTENT_BLOCK_TYPES`; tidak kosong hanya untuk `chapter`/`appendix`. */
  admits: string[];
  /** Kunci rinci berlapis essential, maks 8 kenop jenis slot. */
  essentials: Record<string, ParamValue>;
  /** ADMIN (mode ahli USER ditunda, D-163 T-1). */
  advanced?: Record<string, ParamValue>;
  /** RoleKey -> {para?, run?}; ADMIN. */
  roleFormats?: Record<string, unknown>;
}

/** T2-57 (SID05) */
export interface StudioSkeletonV1 {
  $schema: "studio.skeleton/v1";
  slots: TemplateSlotDef[];
}

/** T2-58 (SID04) */
export interface StudioTemplateV2 {
  $schema: "studio.template/v2";
  /** Wajib kecuali templat `isPreset`. Tanpa `version` = versi preset terbaru. */
  preset?: { slug: string; version?: number };
  /** Kenop esensial global (kunci rinci). */
  essentials: Record<string, ParamValue>;
  /** ADMIN / mode ahli. */
  advanced?: Record<string, ParamValue>;
  /** ADMIN. */
  roleFormats?: Record<string, unknown>;
  skeleton: { slots: TemplateSlotDef[] };
}

/** T2-59 — isi oleh SR-59/SR-05 di `L/registry/essentials.ts`. */
export interface EssentialKnobDef {
  /** "EK-G01".."EK-G08" global; "EK-<sectionType>-01".. per jenis slot. */
  id: string;
  /** "global" atau kunci registri section. */
  scope: "global" | (string & {});
  /** Bahasa awam. */
  label: string;
  /** Kunci rinci yang ditulis kenop (KD-21). */
  keys: readonly string[];
  /** `multiEnum` = subset berurutan dari `options` (permintaan SR-05, mis. kolom daftar referensi). */
  control: "enum" | "multiEnum" | "bool" | "number" | "text" | "color" | "asset";
  options?: ReadonlyArray<{ value: ParamValue; label: string }>;
  class: "B" | "K";
}
