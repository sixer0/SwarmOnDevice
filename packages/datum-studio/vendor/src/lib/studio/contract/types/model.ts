/**
 * Model ternormalisasi (01_specs.md §3.9) — isi kolom `StudioRevision.snapshot`.
 * Alamat dihitung ulang per revisi (§4.2); identitas lintas revisi = blockId.
 */
import type { RegisterEntry, SectionSetup, StudioDocV1 } from "./doc";

export interface NormDocSnapshot {
  schema: "studio.norm/v1";
  doc: StudioDocV1;
  units: NormUnit[];
  blocks: NormBlock[];
  /** Label artefak hasil penomoran per bab (mis. blockId -> "Tabel 3.1"). */
  numbering: Record<string, string>;
  register: Record<string, RegisterEntry>;
}

/**
 * `"slot"` = delta SR-04 (register §4.6): unit slot tak-berulang tanpa jenis unit
 * v1 (`signatureBlock` berdiri sendiri, `sourceRegister`, `ruleIndex`); hanya
 * muncul di snapshot `studio.norm/v2`.
 */
export type NormUnitKind = "cover" | "controlSheet" | "toc" | "part" | "chapter" | "appendix" | "slot";

export interface NormUnit {
  kind: NormUnitKind;
  key: string;
  setup: Required<Pick<SectionSetup, "header" | "footer">> & SectionSetup;
}

export interface NormBlock {
  blockId: string;
  /** null = spacer/device (tidak beralamat, KS-05). */
  address: string | null;
  artifactLabel?: string;
  ordinal: number;
  unitKey: string;
  type: string;
  content: unknown;
  textPlain: string;
  contentSha256: string;
}
