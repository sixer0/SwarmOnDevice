/**
 * Payload slot v2 dan kiriman `studio.slot/v2` (register 03_structural_sections_specs.md
 * §4.4-§4.5: T2-33..T2-45, T2-48). Diskriminator `type` = `sectionType` slot.
 * Slot berulang (`chapter`, `appendix`) memakai T2-39/T2-40 hanya di
 * `studio.doc/v2`; satu bab dikirim lewat `studio.chapter/v2`.
 */
import type { RegisterEntry } from "../doc";
import type { AssetInputV2, ChangeV2, DocMetaV2, DocTargetV2, InlineV2, OutlineEntryV2, PartV2 } from "./common";
import type { ContractRecordPayloadV2 } from "./contract";
import type { ChapterV2, TableV2 } from "./doc";

/** T2-33 — medan absen dibangkitkan dari `meta` + parameter (KD-18, mode MIXED). */
export interface CoverPayloadV2 {
  type: "cover";
  /** Pengganti `kicker` v1 (VF-13). */
  tagline?: InlineV2;
  /** 1..4. */
  titleLines?: InlineV2[];
  standfirst?: InlineV2;
  scopeLine?: InlineV2;
  addressLine?: InlineV2;
  control?: Array<[InlineV2, InlineV2, InlineV2, InlineV2]>;
  colophon?: { left: InlineV2; right: InlineV2 };
  identityString?: InlineV2;
}

/** T2-35 — `date` YYYY-MM-DD. */
export interface RevisionEntryV2 {
  rev: string;
  date: string;
  what: string;
  by: string;
}

/** T2-36 */
export interface VerificationEntryV2 {
  layer: string;
  role: string;
  name: string;
  date?: string;
}

/** T2-37 */
export interface DistributionEntryV2 {
  copy: string;
  holder: string;
}

/** T2-34 — daftar bertipe atau `TableV2` konten-saja (KD-19). Kicker = label slot (DF-59). */
export interface ControlSheetPayloadV2 {
  type: "controlSheet";
  title?: InlineV2;
  revisionHistory?: RevisionEntryV2[] | TableV2;
  verificationChain?: VerificationEntryV2[] | TableV2;
  methodStatement?: InlineV2;
  distribution?: DistributionEntryV2[] | TableV2;
}

/** T2-38 — 1..8 peran. Penempatan/tata letak = kenop slot (`slot.placement`). */
export interface SignaturePayloadV2 {
  type: "signatureBlock";
  roles: Array<{ role: InlineV2; holder: InlineV2; date?: InlineV2 }>;
}

/** T2-39 */
export interface ContentSlotPayloadV2 {
  type: "chapter";
  outline?: OutlineEntryV2[];
  parts?: PartV2[];
  chapters?: ChapterV2[];
}

/** T2-40 */
export interface AppendixSlotPayloadV2 {
  type: "appendix";
  outline?: OutlineEntryV2[];
  chapters?: ChapterV2[];
}

/**
 * T2-41 — `entries` hanya bila slot MIXED; pada AUTO setiap medan selain `type`
 * = 422 `SLOT_INPUT_NOT_ACCEPTED` (layanan). Judul/catatan = kenop templat (DF-58).
 */
export interface TocPayloadV2 {
  type: "toc";
  entries?: Array<{ level: "part" | "chapter" | "appendix"; label?: InlineV2; title: InlineV2; page: string }>;
}

/** T2-42 — 1..500 entri; alamat per entri `F:<slotKey>/<n>`. */
export interface SourceRegisterPayloadV2 {
  type: "sourceRegister";
  entries: Array<{ id: string; citation: InlineV2; kind?: string; url?: string; accessed?: string }>;
}

/** T2-43 — AUTO. */
export interface RuleIndexPayloadV2 {
  type: "ruleIndex";
}

/** T2-44 — slot tak-berulang (+ T2-61 `contractRecord`, AM-02 DC-05). */
export type SlotPayloadV2 =
  | CoverPayloadV2
  | ControlSheetPayloadV2
  | SignaturePayloadV2
  | TocPayloadV2
  | SourceRegisterPayloadV2
  | RuleIndexPayloadV2
  | ContractRecordPayloadV2;

/** T2-45 — isi `StudioDocSection.payload` slot berulang (KD-09). */
export interface RepeatableSlotMetaV2 {
  outline?: OutlineEntryV2[];
  parts?: PartV2[];
}

/** T2-48 (SID03) — slot berulang lewat endpoint ini = 422 `SLOT_USE_CHAPTER_ENDPOINT`. */
export interface StudioSlotV2 {
  $schema: "studio.slot/v2";
  agentId?: string;
  target: DocTargetV2;
  /** Wajib hanya bila dokumen belum ada (bersama `meta.title`). */
  template?: { slug: string; version?: number };
  meta?: DocMetaV2;
  slot: string;
  payload: SlotPayloadV2;
  register?: Record<string, RegisterEntry>;
  assets?: Record<string, AssetInputV2>;
  baseRevisionNo?: number;
  change?: ChangeV2;
  // D-247: tanpa `render`; build hanya lewat POST /api/studio/documents/{id}/render.
}
