/**
 * Bentuk bersama kontrak v2 KONTEN MURNI (register 03_structural_sections_specs.md
 * §4.2, T2-01..T2-12; prinsip §0 / D-139). Tidak ada medan tampilan, penomoran,
 * tata letak, atau gaya: semua keputusan keluaran milik templat + mesin.
 * Skema JSON padanan: ../../schema/v2/common.schema.ts.
 */
import type { ProvenanceMark, RenderScopeName, StudioTier } from "../../enums";
import type { StudioMissionRef } from "../doc";

/** T2-01 — run berpenanda makna; `sup` dan `sub` tidak boleh keduanya true. */
export type RunV2 =
  | { t: string; strong?: boolean; em?: boolean; code?: boolean; sup?: boolean; sub?: boolean }
  | { tab: true }
  | { br: "line" };

/** T2-02 — `text` (md-lite KS-03) XOR `runs`. */
export type InlineV2 = { text: string } | { runs: RunV2[] };

/** T2-03 — label "Tabel n.m" / "Gambar n.m" dibangkitkan mesin. */
export type CaptionV2 = InlineV2;

/** T2-04 */
export type SourceV2 = InlineV2 & { provenance?: ProvenanceMark[] };

/** T2-05 — label rel milik templat (DF-62). */
export type RailLineV2 = { kind: "mark" | "source" | "note"; mark?: ProvenanceMark } & Partial<{ text: string; runs: RunV2[] }>;

/** T2-06 — `assetRef` = C27 `sha256:<64 heksa>`. */
export type AssetInputV2 = { assetRef: string } | { mime: "image/png" | "image/jpeg"; dataBase64: string };

/** T2-07 — semua medan `DocMeta` v1 opsional (pola/enum sama); absen jatuh ke default templat (§7.2). */
export interface DocMetaV2 {
  title?: string;
  docNumber?: string;
  rev?: string;
  typeCode?: string;
  tier?: StudioTier;
  classification?: string;
  language?: "ID" | "EN";
  author?: string;
  issueDate?: string;
  custodian?: string;
  audience?: string;
  basis?: string;
  subject?: string;
  urgency?: "kilat" | "sangat segera" | "segera" | "biasa";
  issueNumber?: number;
  copyControl?: string;
}

/**
 * T2-08 — tepat satu cara: `documentId`, atau `docNumber`, atau `mission.folder`
 * (+ `docKey` opsional, C23). Selain itu 400 `DOC_TARGET_AMBIGUOUS` (layanan).
 */
export interface DocTargetV2 {
  documentId?: string;
  docNumber?: string;
  mission?: StudioMissionRef;
  docKey?: string;
}

/** T2-09 — sama dengan `ChangeFields` (types/api.ts). */
export interface ChangeV2 {
  what: string;
  why: string;
  impact: string;
}

/** T2-10 */
export interface RenderRequestV2 {
  scope?: RenderScopeName;
  key?: string;
  formats?: Array<"docx" | "pdf" | "html">;
  figures?: Array<"svg" | "png">;
  revisionNo?: number;
}

/** T2-11 */
export interface OutlineEntryV2 {
  key: string;
  title?: InlineV2;
  /**
   * IMPL-W4 (D-547) penomoran sumber: bab ini dicetak persis seperti judul sumbernya (tanpa kicker "Bab n", tanpa
   * nomor section mesin; nomor ada di teks judul) dan label Tabel/Gambar memakai label ini ("Tabel 6.1", "Tabel FM.1";
   * penghitung bersama untuk bab berlabel sama). Absen = penomoran mesin (perilaku lama).
   */
  label?: string;
}

/** T2-12 — `id` `^P[1-9][0-9]?$`; label "Bagian I" dibangkitkan mesin. */
export interface PartV2 {
  id: string;
  title: InlineV2;
  lede?: InlineV2;
}
