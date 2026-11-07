/**
 * DTO route API Studio (01_specs.md §6.2) dan tipe masukan/keluaran layanan
 * (§8.2 I38-I42). Tanggal diserialisasi ISO-8601 string.
 */
import type { StudioCaller } from "../auth";
import type { LintReport, RoleFormatMap } from "../engine";
import type {
  StudioArtifactKind,
  StudioErrorCode,
  StudioNumberSource,
  StudioOutputFormat,
  StudioOutputRole,
  StudioReleaseStatus,
  StudioRenderJobStatus,
  StudioRenderScopeKind,
  StudioTemplateKind,
  StudioTier,
} from "../enums";
import type { RenderEnvReadiness } from "../render-env";
import type { StudioChartV1 } from "./chart";
import type { ParamValue } from "./common";
import type { StudioDiagramV1 } from "./diagram";
import type { Cell, FlowItem, StudioIngestRequest, StudioMissionRef } from "./doc";
import type { StudioHtmlV1 } from "./html";
import type { StudioImageV1 } from "./image";
import type { NormDocSnapshot } from "./model";
import type { SectionPlan } from "./params";

// ── Validasi ─────────────────────────────────────────────────────────────

/** Galat skema/by-construction: pointer = instancePath (JSON Pointer). */
export interface ValidationIssue {
  pointer: string;
  keyword: string;
  message: string;
  checkId?: string;
  /** Kiriman bab/slot: pointer asal di dokumen tergabung; `pointer` relatif badan kiriman (D-272). */
  mergedPointer?: string;
}

// ── Templat (R01, R02) ───────────────────────────────────────────────────

export interface TemplateProvenance {
  tokensVersion: string;
  manualRevision: string;
  skillVersion: string;
  catalogRef: string;
}

export interface TemplateSummary {
  id: string;
  slug: string;
  name: string;
  kind: StudioTemplateKind;
  description: string | null;
  isCanonical: boolean;
  archived: boolean;
  latestVersionNo: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  /**
   * AM-13 (register 05 MX08, CQ-4): jenis kontrak templat C58 (`null` = templat biasa).
   * Diisi pemeta ringkasan layanan templat dari kolom MX08 (DC-28).
   */
  contractKind: string | null;
}

export interface VersionSummary {
  id: string;
  templateId: string;
  versionNo: number;
  baseVersionId: string | null;
  paramsSha256: string;
  changeNote: string;
  createdBy: string;
  createdAt: string;
}

export interface TemplateVersionDto extends VersionSummary {
  overrides: Record<string, ParamValue>;
  resolvedParams: Record<string, ParamValue>;
  roleFormats: RoleFormatMap;
  sectionPlan: SectionPlan;
  assets: Record<string, { sha256: string; path: string; kind: string }>;
  provenance: TemplateProvenance;
}

export interface TemplateListQuery {
  kind?: StudioTemplateKind;
  archived?: boolean;
}

export interface TemplateDetail {
  template: TemplateSummary;
  version: TemplateVersionDto;
  versions: VersionSummary[];
}

/** POST /api/studio/templates. */
export interface CreateTemplateInput {
  slug: string;
  name: string;
  kind: StudioTemplateKind;
  description?: string;
  baseVersionId?: string;
  overrides: Record<string, ParamValue>;
  roleFormats?: RoleFormatMap;
  sectionPlan?: SectionPlan;
  changeNote: string;
}

/** POST /api/studio/templates/[id] (simpan = versi baru). */
export interface CreateTemplateVersionInput {
  overrides: Record<string, ParamValue>;
  roleFormats?: RoleFormatMap;
  sectionPlan?: SectionPlan;
  changeNote: string;
  baseVersionNo: number;
}

// ── Dokumen, revisi, blok (R04-R07) ──────────────────────────────────────

export interface DocumentSummary {
  id: string;
  docNumber: string;
  numberSource: StudioNumberSource;
  title: string;
  typeCode: string;
  language: string;
  classification: string;
  tier: StudioTier;
  templateId: string;
  currentRevisionNo: number;
  missionFolder: string | null;
  agentRequestId: string | null;
  hermesTaskId: string | null;
  createdBy: string;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  releaseStatus?: StudioReleaseStatus;
}

export interface DocumentListQuery {
  mission?: string;
  agentRequestId?: string;
  hermesTaskId?: string;
  /** Maks 200. */
  take?: number;
  cursor?: string;
}

export interface RevisionSummary {
  id: string;
  documentId: string;
  revisionNo: number;
  parentRevisionNo: number | null;
  templateVersionId: string;
  docRev: string;
  snapshotSha256: string;
  inputSha256: string;
  changeWhat: string;
  changeWhy: string;
  changeImpact: string;
  changedAddresses: string[];
  releaseStatus: StudioReleaseStatus;
  createdBy: string;
  createdAt: string;
}

/** Simpul pohon alamat (GET /documents/[id]). */
export interface AddressNode {
  address: string;
  blockId: string;
  type: string;
  label?: string;
  artifactLabel?: string;
  textPreview?: string;
  children?: AddressNode[];
}

export interface BlockDto {
  address: string;
  blockId: string;
  type: string;
  content: unknown;
  revisionNo: number;
}

export interface ChangeFields {
  what: string;
  why: string;
  impact: string;
}

/** PATCH /documents/[id]/blocks/[address]. */
export interface PatchBlockInput {
  baseRevisionNo: number;
  op: "replace" | "insertBefore" | "insertAfter" | "delete";
  block?: FlowItem;
  cell?: Cell;
  change: ChangeFields;
}

export interface PatchResult {
  revision: RevisionSummary;
  /** Alamat lama -> baru untuk semua blok yang bergeser (§4.2). */
  addressMap: Record<string, string>;
  job: RenderJobDto | null;
  outputs: OutputFileDto[];
}

/** POST /documents/[id]/revisions (render ulang revisi lama). */
export interface RerenderRequest {
  revisionNo: number;
  formats?: StudioOutputFormat[];
}

export interface RerenderResult {
  job: RenderJobDto;
  outputs: OutputFileDto[];
  identical: boolean;
}

/**
 * Tanda tangan I40 `rerenderRevision` (services/revisions, S50). Delta S03-d1
 * (D-54): argumen ke-4 opsional `caller`; tanpa itu = pemanggil internal anonim.
 */
export type RerenderRevisionFn = (
  docId: string,
  revNo: number,
  formats?: readonly StudioOutputFormat[],
  caller?: StudioCaller,
) => Promise<RerenderResult>;

// ── Berkas dan job render ────────────────────────────────────────────────

export interface OutputFileDto {
  id: string;
  documentId: string | null;
  revisionId: string | null;
  artifactId: string | null;
  renderJobId: string | null;
  format: StudioOutputFormat;
  role: StudioOutputRole;
  figureLabel: string | null;
  /** Relatif akar Studio, pemisah `/`. */
  relPath: string;
  fileName: string;
  bytes: number;
  sha256: string;
  mime: string;
  lintVerdict: StudioReleaseStatus;
  createdAt: string;
  /** Path unduh R10. */
  url: string;
  /** Delta IP-48 (IP-54, D-186/D-212): berkas render parsial (draf) dokumen INCOMPLETE. */
  draft: boolean;
  /** Delta IP-48 (IP-54): lingkup render berkas (kolom MX06 `scopeKind`/`scopeKey`). */
  scope: OutputFileScope;
  /**
   * AM-09 (DC-05; register 05 §10, C51): nama berkas final, WAJIB (D-389; diisi
   * pemeta bersama `toOutputFileDto`, CQ-3).
   */
  finalFileName: string;
}

/** Lingkup render satu berkas; `key` hanya untuk CHAPTER/SLOT (DOCUMENT tanpa `key`). */
export interface OutputFileScope {
  kind: StudioRenderScopeKind;
  key?: string;
}

/** Nama yang dipakai tanda tangan I42 `writeOutput`; identik dengan OutputFileDto. */
export type StudioOutputFileDto = OutputFileDto;

export interface RenderJobError {
  code: StudioErrorCode;
  message?: string;
  format?: StudioOutputFormat;
}

export interface RenderJobDto {
  id: string;
  documentId: string | null;
  revisionId: string | null;
  artifactId: string | null;
  formats: StudioOutputFormat[];
  status: StudioRenderJobStatus;
  errorCode: string | null;
  errorMessage: string | null;
  engine: { sofficeVersion?: string; chromiumRevision?: string; renderEnvManifestSha256?: string } | null;
  requestedBy: string;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  errors?: RenderJobError[];
}

/** Masukan I42 `writeOutput`. Tepat satu dari revisionId/artifactId terisi (invarian M08). */
export interface WriteOutputInput {
  documentId?: string;
  revisionId?: string;
  artifactId?: string;
  renderJobId?: string;
  /** Direktori relatif akar Studio (hasil docDir). */
  relDir: string;
  fileName: string;
  data: Uint8Array | string;
  format: StudioOutputFormat;
  role: StudioOutputRole;
  figureLabel?: string;
  mime: string;
  lintVerdict?: StudioReleaseStatus;
}

export interface RenderOutcome {
  job: RenderJobDto;
  outputs: OutputFileDto[];
  errors: RenderJobError[];
  lint?: LintReport;
}

// ── Ingest dan validasi (R04 POST, R08) ──────────────────────────────────

export interface IngestResult {
  valid: boolean;
  issues: ValidationIssue[];
  lint: LintReport | null;
  /** null pada dryRun atau bila invalid. */
  document: DocumentSummary | null;
  revision: RevisionSummary | null;
  outputs: OutputFileDto[];
  job: RenderJobDto | null;
  releaseStatus: StudioReleaseStatus;
  snapshot?: NormDocSnapshot;
  previewHtml?: string;
}

export type ValidateRequest =
  | StudioIngestRequest
  | { schemaId: "studio.chart/v1" | "studio.diagram/v1" | "studio.image/v1" | "studio.html/v1" | "studio.doc/v1"; spec: unknown };

export interface ValidateResponse {
  valid: boolean;
  issues: ValidationIssue[];
  lint: LintReport | null;
  previewHtml?: string;
}

// ── Artefak (R09) ────────────────────────────────────────────────────────

export type StudioArtifactSpec = StudioChartV1 | StudioDiagramV1 | StudioImageV1 | StudioHtmlV1;

export interface ArtifactCreateRequest {
  agentId?: string;
  spec: StudioArtifactSpec;
  mission?: StudioMissionRef;
  formats?: StudioOutputFormat[];
}

export interface ArtifactSummary {
  id: string;
  kind: StudioArtifactKind;
  schemaId: string;
  title: string;
  label: string | null;
  specSha256: string;
  templateVersionId: string | null;
  missionFolder: string | null;
  agentRequestId: string | null;
  hermesTaskId: string | null;
  releaseStatus: StudioReleaseStatus;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface ArtifactListQuery {
  kind?: StudioArtifactKind;
  mission?: string;
  take?: number;
}

// ── Registri dan render-env (R03, R11) ───────────────────────────────────

/**
 * `presets`, `essentials`, `slots`, `paramScopes` = delta SR-04 (register §12 R03);
 * `contracts` = AM-07 (register 05 §9.4, registri jenis kontrak C58; DC-28).
 */
export type RegistryKind =
  | "sections"
  | "params"
  | "charts"
  | "diagram"
  | "symbols"
  | "lint"
  | "roles"
  | "schema"
  | "presets"
  | "essentials"
  | "slots"
  | "paramScopes"
  | "contracts";
export const REGISTRY_KINDS: readonly RegistryKind[] = [
  "sections",
  "params",
  "charts",
  "diagram",
  "symbols",
  "lint",
  "roles",
  "schema",
  "presets",
  "essentials",
  "slots",
  "paramScopes",
  "contracts",
];

export interface RegistryResponse<T = unknown> {
  kind: RegistryKind;
  items: T[];
}

export interface RenderEnvResponse {
  readiness: RenderEnvReadiness;
  jobs?: RenderJobDto[];
}

