/**
 * Tipe document contract v2 (register 05_document_contract_specs.md §5.2, T2-61..T2-74;
 * delta DC-05, D-363). Konten murni (D-139): agen mengirim data kontrak; label,
 * susunan tabel, dan rupa milik templat + registri jenis (C58).
 * Skema JSON padanan: `$defs` `ContractRecordPayloadV2` dkk. di ../../schema/v2/common.schema.ts.
 * Aman untuk klien dan server.
 */
import type {
  AgentWorkReportStatus,
  ChartCustomMark,
  ChartCustomOrientation,
  ContractEvidenceKind,
  ContractItemStatus,
  ContractKind,
  ContractOutlineKey,
  ContractRefRel,
  ContractVerdict,
  ContractWarningCode,
  DraftIssueCode,
  StudioCompleteness,
  StudioOutputFormat,
  StudioTier,
} from "../../enums";
import type { StudioChapterV2 } from "./chapter";
import type { InlineV2 } from "./common";
import type { StudioSlotV2 } from "./slot";

// ── Payload slot `contractRecord` (CF-01..CF-13) ─────────────────────────

/** T2-65 — transisi fase (`[FASE] <dari> -> <ke>`). */
export interface ContractPhaseV2 {
  from?: string;
  to: string;
}

/** T2-63 — rujukan ke dokumen lain; tepat satu dari `documentId` / `docNumber` (CH-04). */
export interface ContractRefV2 {
  documentId?: string;
  docNumber?: string;
  /** pid paragraf sasaran (C19); pensiun = peringatan CW-01, tidak pernah ada = 422 EC26. */
  pid?: string;
  revisionNo?: number;
  rel: ContractRefRel;
}

/** T2-64 — bukti; `line` hanya untuk `file`, `exitCode` hanya untuk `command` (CH-04). `ref` tidak pernah di-resolve Studio (CA-11). */
export interface ContractEvidenceV2 {
  kind: ContractEvidenceKind;
  ref: string;
  /** Awalan sha256 8..64 heksa kecil (C38). */
  sha256?: string;
  bytes?: number;
  line?: number;
  exitCode?: number;
  /** Kunci butir yang dibuktikan (C35). */
  item?: string;
  note?: InlineV2;
}

/** T2-62 — butir kerja; `key` unik per payload (EC27), identitas lintas revisi (KD-34). */
export interface ContractItemV2 {
  key: string;
  title: InlineV2;
  status: ContractItemStatus;
  owner?: string;
  phase?: string;
  /** `YYYY-MM-DD`. */
  due?: string;
  dependsOn?: string[];
}

/** T2-61 — payload slot `contractRecord`; tanpa medan `kind` (jenis dari templat, KD-30). */
export interface ContractRecordPayloadV2 {
  type: "contractRecord";
  status: AgentWorkReportStatus;
  verdict?: ContractVerdict;
  owner?: string;
  initiator?: string;
  taskRef?: string;
  /** Tanggal atau waktu ber-zona (C37); dinormalkan ke UTC saat proyeksi. */
  reportedAt: string;
  /** `YYYY-MM-DD`. */
  due?: string;
  phase?: ContractPhaseV2;
  cardIds?: string[];
  refs?: ContractRefV2[];
  evidence?: ContractEvidenceV2[];
  items?: ContractItemV2[];
}

// ── chart.custom (§12) ───────────────────────────────────────────────────

/** T2-66 — bentuk berbatas `chart.code = "custom"`; bawaan `orientation` `vertical`, `stacked` `false`. */
export interface ChartCustomFormV2 {
  mark: ChartCustomMark;
  orientation?: ChartCustomOrientation;
  stacked?: boolean;
}

// ── Respons (AM-08, R21, R22, R23) ───────────────────────────────────────

/** T2-67 — peringatan non-penahan di respons kiriman / R08 (KD-46). */
export interface SubmitWarningV2 {
  code: ContractWarningCode;
  pointer: string;
  message: string;
  details?: unknown;
}

/** T2-68 — butir R21 `GET /api/studio/contracts` (§9.1); nilai kosong = `null`. */
export interface ContractSummaryV2 {
  documentId: string;
  docNumber: string;
  title: string;
  kind: ContractKind;
  /** `null` = slot `record` belum terisi (aturan tulis §7.6; D-370). */
  status: AgentWorkReportStatus | null;
  owner: string | null;
  taskRef: string | null;
  cardIds: string[];
  /** `YYYY-MM-DD` atau `null`. */
  dueOn: string | null;
  revisionNo: number;
  completeness: { status: StudioCompleteness; missingRequired: string[] };
  missionFolder: string | null;
  docKey: string | null;
  updatedAt: string;
  /** Hanya bila filter `cardId` diisi. */
  matchedItems?: Array<{ key: string; status: ContractItemStatus; pid: string; title: string }>;
}

/** T2-69 — butir R22 `GET /api/studio/search` (§9.2). */
export interface SearchHitV2 {
  documentId: string;
  docNumber: string;
  title: string;
  kind: string | null;
  revisionNo: number;
  pid: string;
  address: string;
  slotKey: string;
  chapterKey: string | null;
  type: string;
  snippet: string;
  rank: number;
}

/** T2-72 — isu ekstraktor draf (DR-01..DR-08). */
export interface DraftIssueV2 {
  code: DraftIssueCode;
  severity: "error" | "warning";
  line?: number;
  column?: number;
  blockIndex?: number;
  message: string;
}

/** T2-71 — hasil per blok `json` draf (§11.4). */
export interface DraftBlockResultV2 {
  /** 1-based. */
  index: number;
  /** Baris pagar pembuka (1-based, berkas asli). */
  line: number;
  endLine: number;
  schema: string | null;
  valid: boolean;
  /** Isu R08 apa adanya. */
  issues: unknown[];
  payload: unknown | null;
  submitPreview?: unknown;
  completenessPreview?: unknown;
}

/** T2-70 — respons R23 dan keluaran CLI `draft-check --json` (§11.4); `valid` = tanpa isu error dan setiap blok valid. */
export interface DraftCheckResultV2 {
  valid: boolean;
  header: { title: string | null; tujuan: string | null; langkahBerikut: string | null; basis: string | null };
  issues: DraftIssueV2[];
  blocks: DraftBlockResultV2[];
}

// ── Registri jenis kontrak (C58, R03 `kind=contracts`) ───────────────────

/** T2-73 — satu entri `CONTRACT_KIND_DEFS` (register 05 §6.4) dan butir R03 `kind=contracts`. */
export interface ContractKindDefV2 {
  kind: ContractKind;
  /** R03 hanya mencantumkan `active`; jenis dicadangkan (§1.2) tidak masuk registri tahap 1. */
  stage: "active";
  templateSlug: string;
  tier: StudioTier;
  typeCode: string;
  /** Kerangka ringkas SL-08..SL-10. */
  skeleton: ReadonlyArray<{ slotKey: string; sectionType: string; label: string; required: boolean; repeatable: boolean }>;
  /** Bab wajib CO-01..CO-05. */
  outline: ReadonlyArray<{ chapterKey: string; outlineKey: ContractOutlineKey; title: string; required: boolean }>;
  statuses: ReadonlyArray<{ code: AgentWorkReportStatus; label: string }>;
  itemStatuses: ReadonlyArray<{ code: ContractItemStatus; label: string }>;
  verdicts: ReadonlyArray<{ code: ContractVerdict; label: string }>;
  refRels: readonly ContractRefRel[];
  evidenceKinds: readonly ContractEvidenceKind[];
  /** Nilai konstanta C34, C35, C36, C37, C51. */
  patterns: { cardId: string; key: string; actor: string; reportedAt: string; finalFileName: string };
  /** C39. */
  limits: { cardIds: number; items: number; dependsOn: number; refs: number; evidence: number; refText: number };
  /** Label tampil (bahasa Indonesia, CA-2): medan CF dan kolom tabel butir, bukti, rujukan. */
  labels: {
    fields: Readonly<Record<string, string>>;
    itemColumns: readonly string[];
    evidenceColumns: readonly string[];
    refColumns: readonly string[];
  };
  /** Alias generator §16 (nilai ternormalisasi -> tujuan): GA, GL, GF, GS, GI, GV. */
  aliases: {
    headings: Readonly<Record<string, string>>;
    lineLabels: Readonly<Record<string, string>>;
    headerKeys: Readonly<Record<string, string>>;
    statuses: Readonly<Record<string, AgentWorkReportStatus>>;
    itemStatuses: Readonly<Record<string, ContractItemStatus>>;
    verdicts: Readonly<Record<string, ContractVerdict>>;
  };
  /** C40. */
  defaultFormats: readonly StudioOutputFormat[];
  /** U-03 (D-419) — contoh kiriman siap salin; setiap contoh lolos skema v2 + dry-run R08 (uji r2reg). */
  examples: ContractKindExamplesV2;
}

/**
 * U-03 (D-419) — contoh kiriman per jenis kontrak (R03 `kind=contracts`, `items[].examples`):
 * agen menyalin badan apa adanya lalu mengganti isinya (konten saja, D-139).
 */
export interface ContractKindExamplesV2 {
  /** Medan yang wajib diganti sebelum mengirim (target, pelaku, waktu, isi). */
  howTo: readonly string[];
  /** Kiriman pertama slot `record` (`POST /api/studio/slots`, amplop buat): payload `contractRecord` lengkap. */
  record: StudioSlotV2 & { slot: "record"; payload: ContractRecordPayloadV2 };
  /** Satu badan `studio.chapter/v2` per `chapterKey` outline wajib (`POST /api/studio/chapters`). */
  chapters: Readonly<Record<string, StudioChapterV2>>;
}

// ── Nama berkas final (§10) ──────────────────────────────────────────────

/** T2-74 — bagian nama final `<docNumberSafe>_rev<n>_<YYYYMMDDTHHMMSSZ>_<sha8>.<ext>` (I59-I62, DC-17). */
export interface FinalFileNameParts {
  docNumberSafe: string;
  revisionNo: number;
  /** ISO UTC detik `YYYY-MM-DDTHH:MM:SSZ`. */
  renderedAt: string;
  sha8: string;
  ext: "docx" | "pdf" | "html" | "svg" | "png";
}
