/**
 * Blok, bab, section, dan dokumen `studio.doc/v2` KONTEN MURNI (register
 * 03_structural_sections_specs.md §4.3, §4.5: T2-13..T2-32, T2-46, T2-49).
 *
 * Medan bersama setiap blok: `type` dan `id?` (pid, C19). Tidak ada medan lain
 * di luar daftar register; setiap medan tampilan (DF-01..DF-69) ditolak skema
 * dengan issue `checkId: "DISPLAY_FIELD"`. Skema JSON padanan:
 * ../../schema/v2/common.schema.ts dan ../../schema/v2/doc.schema.ts.
 */
import type { ChartCode, ChartIntentOrientation, ChartIntentSort, DiagramFamily, ParagraphRoleV2, ProvenanceMark, SymbolDialect, TableBlockType } from "../../enums";
import type { ChartLabelShort } from "../chart";
import type { DiagramEdge, DiagramNode, DiagramZone } from "../diagram";
import type { DocMeta, RegisterEntry, StudioMissionRef } from "../doc";
import type {
  AssetInputV2,
  CaptionV2,
  ChangeV2,
  DocMetaV2,
  InlineV2,
  RailLineV2,
  RunV2,
  SourceV2,
} from "./common";
import type { ChartCustomFormV2 } from "./contract";
import type { AppendixSlotPayloadV2, ContentSlotPayloadV2, SlotPayloadV2 } from "./slot";

/** Medan bersama setiap blok v2. */
interface BlockBaseV2 {
  /** pid opsional (C19); absen = pewarisan posisi atau bangkitan. */
  id?: string;
}

/** T2-13 */
export type ParagraphV2 = BlockBaseV2 & InlineV2 & { type: "paragraph"; role?: ParagraphRoleV2; rail?: RailLineV2[] };

/** T2-14 — `ordered` bawaan false. */
export interface ListV2 extends BlockBaseV2 {
  type: "list";
  ordered?: boolean;
  /** minItems 1. */
  items: Array<InlineV2 & { rail?: RailLineV2[] }>;
}

/** T2-15 — `label` bawaan dari varian. */
export interface AsideV2 extends BlockBaseV2 {
  type: "aside";
  variant: "generic" | "doctrine" | "story" | "quickCheck" | "ifInDoubt";
  label?: InlineV2;
  body: InlineV2[];
}

/** T2-16 */
export interface MonoBlockV2 extends BlockBaseV2 {
  type: "monoBlock";
  label: InlineV2;
  lines: InlineV2[];
}

/** T2-17 — `asmId` pola P5-63. */
export type AssumptionInlineV2 = BlockBaseV2 & InlineV2 & { type: "assumptionInline"; asmId: string; impact: string };

/** T2-19 — tanpa lebar/perataan (KC-6, D-166): lebar dari profil `preset` tabel templat (R-52). */
export interface ColumnV2 {
  role?: "text" | "numeral" | "id" | "unit" | "glyph";
  unit?: string;
}

/** T2-21 — salah satu dari `text`, `runs`, `paragraphs`, atau tidak satu pun (sel kosong). */
export interface CellV2 {
  text?: string;
  runs?: RunV2[];
  paragraphs?: InlineV2[];
  gridSpan?: number;
  vMerge?: "restart" | "continue";
  /** Kedalaman 1 (tabel bersarang tidak boleh bersarang lagi). */
  nested?: TableV2;
  nestedIndex?: number;
}

/** T2-20 */
export interface RowV2 {
  kind?: "header" | "body" | "group" | "total";
  cells: CellV2[];
}

/** T2-18 — 11 nilai `TABLE_BLOCK_TYPES`; `preset` = jenis tabel semantik (profil lebar R-52 di templat). */
export interface TableV2 extends BlockBaseV2 {
  type: TableBlockType;
  caption?: CaptionV2;
  /** 1..20. */
  columns: ColumnV2[];
  rows: RowV2[];
  source?: SourceV2;
  preset?: string;
}

/** T2-22 — label "Turunan D-C.n" dibangkitkan mesin. */
export interface DerivationV2 extends BlockBaseV2 {
  type: "derivation";
  title: InlineV2;
  intro?: InlineV2;
  lines: Array<{ label: InlineV2; value?: InlineV2 | { registerKey: string; dec?: 0 | 1 | 2 | 3 }; mark?: ProvenanceMark }>;
  result?: { label: InlineV2; expr: string; registerKey: string; tol?: number };
  verdict?: { label: InlineV2; registerKey: string; limit: number; direction?: "lessOrEqual" | "greaterOrEqual" };
  closing: InlineV2;
}

/** T2-27 — `StudioDiagramV1` tanpa `$schema`, `id`, `title`, `width_mm`, `apparatus`, `source` (dan `sld`). */
export interface DiagramSpecV2 {
  family: DiagramFamily;
  classification?: string;
  labels_verified?: boolean;
  sources?: string[];
  nodes: DiagramNode[];
  edges?: DiagramEdge[];
  zones?: DiagramZone[];
  legend?: string[];
  notes?: string[];
  per_row?: number;
}

/**
 * T2-24 — union `ChartData` v1 tanpa `accent` (penekanan = `highlight` di blok, VF-12).
 * Medan konten tambahan RQ-11 (D-223; semuanya DATA bernilai satuan data, bukan tampilan):
 * `points[].target` (sasaran per baris, mis. bullet P-09), `divider` (garis bagi kuadran
 * dalam satuan data, P-13), `binEdges` (tepi bin tempat data terkelompok, S-01) dan
 * `sectors` (jumlah sektor arah tempat data terkelompok, S-08).
 */
export type ChartDataV2 =
  | { shape: "categorical"; points: Array<{ label: string; value: number; sub?: string; target?: number }> }
  | { shape: "series"; categories: string[]; series: Array<{ name: string; values: Array<number | null> }> }
  | {
      shape: "xy";
      points: Array<{ x: number; y: number; size?: number; label?: string; group?: string }>;
      divider?: { x?: number; y?: number };
    }
  | { shape: "matrix"; rows: string[]; cols: string[]; values: number[][] }
  | {
      shape: "intervals";
      items: Array<{ label: string; start: number | string; end: number | string; group?: string; milestone?: boolean }>;
    }
  | {
      shape: "graph";
      nodes: Array<{ id: string; label: string; value?: number; group?: string }>;
      links: Array<{ from: string; to: string; value?: number }>;
    }
  | { shape: "distribution"; groups: Array<{ name: string; values: number[] }>; binEdges?: number[]; sectors?: number }
  | {
      shape: "tiles";
      tiles: Array<{ code: string; row: number; col: number; value?: number; label?: string }>;
      flows?: Array<{ from: string; to: string; value: number }>;
      dots?: Array<{ tile: string; dx?: number; dy?: number; label?: string }>;
    }
  | { shape: "ohlc"; points: Array<{ t: string; o: number; h: number; l: number; c: number }> }
  | { shape: "sets"; sets: Array<{ name: string; size: number }>; overlaps: Array<{ sets: string[]; size: number }> }
  | { shape: "steps"; spec: DiagramSpecV2 };

/** T2-25 (+ `limit` RQ-11/D-223: ambang panel = DATA, bentuk sama dengan `ChartV2.limit`). */
export interface ChartPanelV2 {
  name: string;
  code: ChartCode;
  data: ChartDataV2;
  /** Sama dengan `ChartV2.highlight` (termasuk aturan kategori + seri pada bentuk `series`). */
  highlight?: Array<string | number>;
  unit?: string;
  dec?: 0 | 1 | 2 | 3;
  limit?: { value: number; label?: string };
  caption?: string;
  axisNote?: string;
}

/**
 * T2-23 — tepat satu dari `data`, `panels` (wajib bila `code = "composite"`),
 * `artifactId`. Tata letak komposit dari parameter R-50/R-51 (KD-17).
 * AM-03 (DC-05, register 05 §5.3): skema menerima `code = "custom"` yang mewajibkan
 * `form` + `data` (tanpa `panels`/`artifactId`); `form` terlarang pada kode lain (CH-05).
 * Union TS `code` + `"custom"` mendarat di DC-27 (D-367): perakit (`services/compose/blocks.ts`)
 * menyerahkan `custom` + `form` ke dispatch mesin chart (`engine/chart/core/custom.ts`, I68).
 */
export interface ChartV2 extends BlockBaseV2 {
  type: "chart";
  code: ChartCode | "composite" | "custom";
  /** T2-66 — hanya (dan wajib) bila `code = "custom"`. */
  form?: ChartCustomFormV2;
  data?: ChartDataV2;
  panels?: ChartPanelV2[];
  artifactId?: string;
  /**
   * Label titik, nama seri, id simpul, kode petak, atau indeks 0-based. Bentuk `series`:
   * nama kategori saja = kategori itu; nama seri saja = seluruh seri; satu kategori + satu
   * nama seri = SATU titik di dalam seri itu (D-136). Bentuk `distribution` dengan
   * `sectors`: indeks sektor 0-based.
   */
  highlight?: Array<string | number>;
  unit?: string;
  dec?: 0 | 1 | 2 | 3;
  limit?: { value: number; label?: string };
  note?: string;
  /**
   * FIG-03a (D-482 butir 2) — maksud analitis opsional; absen = perilaku sekarang. Arah baca
   * kategori (P-01/P-02/W-02 dapat ditukar; `vertical` juga mematikan AUTO_ORIENT).
   */
  orientation?: ChartIntentOrientation;
  /** FIG-03a — urutan kategori (`none` = urutan agen). */
  sort?: ChartIntentSort;
  /** FIG-03a — 3..30: N kategori terbesar dipertahankan, sisanya digabung "Lainnya (k)" (jumlah). */
  topN?: number;
  /** FIG-03a — label kategori gabungan (hanya bersama `topN`; bawaan "Lainnya"). */
  otherLabel?: string;
  /** FIG-03a — label sumbu singkat; `label` wajib sama persis dengan kategori yang ada. */
  labelShort?: ChartLabelShort[];
  caption: CaptionV2;
  source: SourceV2;
  keyRow?: InlineV2;
}

/** T2-26 — tepat satu dari `spec` atau `artifactId`. */
export interface DiagramV2 extends BlockBaseV2 {
  type: "diagram";
  spec?: DiagramSpecV2;
  artifactId?: string;
  caption: CaptionV2;
  source: SourceV2;
  keyRow?: InlineV2;
}

/** T2-28 — `asset` = kunci `assets` kiriman (C26) atau rujukan langsung (C27). Lebar dari templat. */
export interface ImageV2 extends BlockBaseV2 {
  type: "image";
  asset: string;
  caption: CaptionV2;
  source: SourceV2;
  keyRow?: InlineV2;
}

/** T2-29 — jumlah kolom lembar = parameter `symbol.*` (DF-57). */
export interface SymbolSheetV2 extends BlockBaseV2 {
  type: "symbolSheet";
  dialect: SymbolDialect;
  caption: CaptionV2;
  source: SourceV2;
  keyRow?: InlineV2;
}

/** T2-30 — 21 nilai `type`, diskriminator `type`. */
export type BlockV2 =
  | ParagraphV2
  | ListV2
  | AsideV2
  | MonoBlockV2
  | AssumptionInlineV2
  | TableV2
  | DerivationV2
  | ChartV2
  | DiagramV2
  | ImageV2
  | SymbolSheetV2;

/** T2-32 */
export interface SectionV2 {
  id?: string;
  title: InlineV2;
  blocks: BlockV2[];
}

/**
 * T2-31 — `key` wajib: C33a untuk slot `chapter`, C33b untuk slot `appendix`
 * (selain itu 422 `CHAPTER_KEY_INVALID`, layanan). Label "BAB n" milik mesin.
 */
export interface ChapterV2 {
  key: string;
  id?: string;
  title: InlineV2;
  /** Maks 80 karakter (pengganti `runningHeadTitle`, VF-04). */
  shortTitle?: string;
  partId?: string;
  intro?: BlockV2[];
  sections: SectionV2[];
}

/** Payload satu entri `sections` dokumen v2 (slot tak-berulang atau berulang); tipe lokal. */
type DocSectionPayloadV2 = SlotPayloadV2 | ContentSlotPayloadV2 | AppendixSlotPayloadV2;

/** T2-46 (SID01) — `sections` absen = dokumen kosong berkerangka (§7). */
export interface StudioDocV2 {
  $schema: "studio.doc/v2";
  /** Maks 80 karakter. */
  agentId?: string;
  template: { slug: string; version?: number };
  mission?: StudioMissionRef;
  /** C23; bawaan = slug templat bila `mission.folder` ada. */
  docKey?: string;
  /** `title` wajib. */
  meta: DocMetaV2 & { title: string };
  /** Pengecualian D-127: urutan + penghapusan slot opsional; bawaan = kerangka. */
  structure?: { order: string[] };
  sections?: { [slotKey: string]: DocSectionPayloadV2 };
  register?: Record<string, RegisterEntry>;
  assets?: Record<string, AssetInputV2>;
  x?: Record<string, unknown>;
  change?: ChangeV2;
  // D-247: tanpa `render`; build hanya lewat POST /api/studio/documents/{id}/render.
}

/**
 * T2-49 — bentuk internal hasil gabung (disimpan di `NormDocSnapshotV2.source`,
 * dikembalikan R20): tanpa `agentId`, `change`; `template.version`
 * terisi (patokan); `meta` = `DocMeta` lengkap; setiap bab/section/blok punya
 * `id`; `assets` hanya bentuk `{ assetRef }`.
 */
export interface StudioDocV2Resolved
  extends Omit<StudioDocV2, "agentId" | "change" | "template" | "meta" | "assets"> {
  template: { slug: string; version: number };
  meta: DocMeta;
  assets?: Record<string, { assetRef: string }>;
}
