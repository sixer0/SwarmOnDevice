/**
 * Bentuk respons API struktur v2 (register 03_structural_sections_specs.md
 * §12: T2-60c `SubmitResultV2`, `AssetDtoV2` R18, `SlotNodeV2` R05; §14.3
 * `AdaptReportV1` isi lint LD-03). Respons agen ringkas dan dapat diteruskan
 * apa adanya ke controller agen (§0 butir c).
 */
import type { InlineV2 } from "./common";
import type { CompletenessReportV2 } from "./completeness";
import type { SubmitWarningV2 } from "./contract";
import type { InlineFormatPolicy, StudioSlotState, StudioTier } from "../../enums";

/** R18 — tanpa path berkas. */
export interface AssetDtoV2 {
  sha256: string;
  mime: "image/png" | "image/jpeg";
  widthPx: number;
  heightPx: number;
  bytes: number;
  createdAt: string;
}

/** T2-60c — respons kiriman R04 (v2), R12, R13; 201 baru/revisi n+1, 200 `unchanged`. */
export interface SubmitResultV2 {
  document: {
    id: string;
    docNumber: string;
    missionFolder: string | null;
    docKey: string | null;
    template: { slug: string; versionNo: number };
    tier: StudioTier;
  };
  created: boolean;
  unchanged: boolean;
  rebased: boolean;
  baseRevisionNo?: number;
  appliedOnRevisionNo?: number;
  /** `changeScope` tata bahasa §9.5; `changeAuto` = `change` diisi otomatis. */
  revision: { revisionNo: number; changeScope: string; changeAuto: boolean };
  chapter?: {
    slotKey: string;
    chapterKey: string;
    pid: string;
    sha256: string;
    blocks: Array<{ address: string; pid: string; type: string; artifactLabel?: string }>;
  };
  slot?: { slotKey: string; pid?: string; sha256: string; address: string };
  completeness: CompletenessReportV2;
  /** AM-08 (DC-05; register 05 KD-46): peringatan non-penahan; hanya bila tidak kosong (isi DC-08). */
  warnings?: SubmitWarningV2[];
  /** D-247: tanpa `job`/`outputs`/`renderRefused`; build hanya lewat endpoint render (R17). */
}

/** R05 — pohon slot/bab/section/blok dengan alamat dan pid. */
export interface SlotNodeV2 {
  slotKey: string;
  sectionType: string;
  label: string;
  state: StudioSlotState;
  /** `F:<slotKey>` (slot tak-berulang) atau kosong untuk slot berulang. */
  address: string;
  pid?: string;
  chapters?: Array<{
    key: string;
    pid: string;
    address: string;
    title: InlineV2;
    sections: Array<{
      sectionNo: number;
      pid: string;
      address: string;
      title: InlineV2 | null;
      blocks: Array<{ pid: string; address: string; type: string; artifactLabel?: string }>;
    }>;
  }>;
}

/** §14.3 — isi `details` lint LD-03 `SCHEMA_V1_ADAPTED` (adaptor v1 -> v2, I46). */
export interface AdaptReportV1 {
  schema: "studio.doc/v1";
  policy: InlineFormatPolicy;
  stripped: Record<string, number>;
  dropped: {
    spacer: number;
    device: number;
    symbolGlyphRuns: number;
    fieldRuns: number;
    frontItems: number;
    tocEntries: number;
  };
  renamed: Record<string, number>;
}
