/**
 * Tipe internal layanan compose (SR-08, register 03_structural_sections_specs.md
 * §0.1: `StructureRows`, `ComposeInput`, `MergeResult`, `StructureInput` adalah
 * tipe internal modul pemilik, tidak diekspor dari kontrak).
 *
 * Modul ini MURNI: tanpa Prisma, tanpa I/O, tanpa cap waktu (determinisme
 * snapshot, §4.6). Semua yang butuh DB (sekuens nomor, pid pensiun, aset M13,
 * nilai efektif templat) diberikan pemanggil (SR-10, SR-12, SR-13, SR-15, SR-33).
 */
import type { StructureRows } from "../structure/types";
import type {
  AssetInputV2,
  ChapterV2,
  DocMeta,
  NormDocSnapshotV2,
  ParamMap,
  PidAllocator,
  SlotPayloadV2,
  StudioDocV2Resolved,
  StudioMissionRef,
  StudioSkeletonV1,
  StudioTier,
} from "../../contract";

/**
 * Kerangka versi templat untuk compose. Bentuk = keluaran `getSkeleton` SR-06
 * (I44) + id versi. `NormSkeletonV2` (I45 tertulis) tidak membawa
 * `positionLocked`/`tiers`/`admits`/`maxItems` yang dibutuhkan aturan §2.7,
 * jadi compose menerima `StudioSkeletonV1` lengkap.
 */
export interface SkeletonInput {
  templateVersionId: string;
  skeleton: StudioSkeletonV1;
  skeletonSha256: string;
  implicit: boolean;
  /** Id M10 per slotKey (`StudioDocSection.templateSlotId`); absen/implisit = null. */
  templateSlotIds?: Readonly<Record<string, string>>;
}

/** Masukan `validateStructure` (I45). Pointer dipakai di `details.pointer`. */
export interface StructureInput {
  /** `structure.order` kiriman (dokumen v2) atau urutan tersimpan dokumen. */
  structure?: { order: string[] };
  /** `sections` dokumen v2. */
  sections?: Record<string, unknown>;
  /** Kiriman satu bab (`studio.chapter/v2`). */
  chapter?: { slot?: string; chapter: ChapterV2 };
  /** Kiriman satu slot (`studio.slot/v2`). */
  slot?: { slot: string; payload: SlotPayloadV2 };
  /** Jumlah bab per slot berulang SESUDAH penggabungan (cek `maxItems`). */
  chapterCounts?: Record<string, number>;
  /** Kunci bab yang sudah ada per slot berulang (cek bentrok lintas slot). */
  existingChapterKeys?: Record<string, readonly string[]>;
  /** Prefiks pointer badan permintaan (mis. "" untuk dokumen, "/chapter" untuk bab). */
  pointer?: string;
}

/** Metadata aset tersimpan (M13) per sha256 heksa kecil. */
export interface ComposeAssetInfo {
  mime: "image/png" | "image/jpeg";
  /** `relPath` M13 (`assets/<xx>/<sha>.<ext>`, relatif STUDIO_WORKSPACE_ROOT). */
  relPath?: string;
  widthPx?: number;
  heightPx?: number;
}

/** Masukan `composeV2` (I45). */
export interface ComposeInput {
  /** Konten v2 tergabung: setiap bab/section/blok sudah ber-`id` (T2-49). */
  source: StudioDocV2Resolved;
  skeleton: SkeletonInput;
  /** Tier dokumen (penentu slot aktif). Bawaan `source.meta.tier`. */
  tier?: StudioTier;
  /** Nilai efektif parameter tingkat dokumen (templat terpatok). */
  params: ParamMap;
  /** Nilai efektif per slot (`resolveSlotParams` SR-06); absen = `params`. */
  slotParams?: Readonly<Record<string, ParamMap>>;
  /** Metadata aset per sha256; absen = AssetRef internal tanpa path (peringatan). */
  assets?: Readonly<Record<string, ComposeAssetInfo>>;
  /**
   * Render draf (SR-15): slot wajib kosong membuat unit `placeholder: true`.
   * Snapshot tersimpan per revisi selalu `false` (bawaan).
   */
  draft?: boolean;
  /** Baris revisi sebelumnya: pewarisan pid baris slot `F:` dan intro bab (SR-10). */
  prevRows?: StructureRows;
  /** Pembangkit pid baris slot/intro; absen = deterministik (`slot-<slotKey>[-n]`, berbenih). */
  pids?: PidAllocator;
  /**
   * Jenis kontrak templat (MX08 `contractKind`, DC-10): sumber label slot `contractRecord`.
   * Absen = entri C58 yang `templateSlug`-nya = slug templat dokumen.
   */
  contractKind?: string;
}

export interface ComposeWarning {
  code: string;
  message: string;
  address?: string;
}

export interface ComposeResult {
  snapshot: NormDocSnapshotV2;
  /** Baris M14-M17 bentuk repositori SR-10 (`services/structure/types.ts`), isi internal M06 terlekat. */
  rows: StructureRows;
  /** `structureSha256` (§4.6) = `computeStructureSha256(snapshot.skeleton, rows)`. */
  structureSha256: string;
  /** sha256 snapshot (`sha256Hex(stableStringify(snapshot))`, §4.6). */
  snapshotSha256: string;
  warnings: ComposeWarning[];
}

/** Opsi `mergeSubmission` (perluasan aditif I45: penggabungan butuh kerangka + pid). */
export interface MergeOptions {
  skeleton: SkeletonInput;
  tier: StudioTier;
  /** Pembangkit pid (DB: acak; murni: `seededPidAllocator`). */
  pids: PidAllocator;
  /** Pid pensiun dokumen (M18 `retiredRevisionNo` ≠ null): tidak dapat dipakai ulang. */
  retiredPids?: ReadonlySet<string>;
  /**
   * Ubah aset base64 kiriman menjadi `assetRef` (SR-19 menyimpan lebih dulu).
   * Absen: bentuk `{mime, dataBase64}` = 422 `ASSET_NOT_FOUND`.
   */
  resolveAsset?: (key: string, input: AssetInputV2) => string;
  /** Sha256 aset yang dikenal (M13); absen = tidak dicek. */
  knownAssetSha?: ReadonlySet<string>;
}

/** Hasil `mergeSubmission` (I45). */
export interface MergeResult {
  doc: StudioDocV2Resolved;
  /** Lingkup tata bahasa §9.5 (`chapter:3`, `slot:controlSheet`, `register:k`, `structure:reorder`). */
  scopes: string[];
  changed: boolean;
}

/** Konteks pembuatan dokumen kosong (§7). */
export interface EmptyDocInput {
  template: { slug: string; version: number };
  meta: DocMeta;
  mission?: StudioMissionRef;
  docKey?: string;
  structure?: { order: string[] };
}
