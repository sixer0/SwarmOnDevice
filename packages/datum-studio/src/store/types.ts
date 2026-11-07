/**
 * StudioStore contract (spec 01_specs_studio_store.md §10; operations from 01_specs_studio.md §5.2).
 *
 * Conventions:
 * - Typed operation inputs are camelCase. Structure rows (`RevisionRowsInput`) are "column rows":
 *   snake_case keys equal to the table's columns; unknown keys are refused (SCHEMA_INVALID).
 * - Rows returned are snake_case with JSON columns already parsed. The twins of row 29 convert to
 *   the Date/ISO shapes the ported Studio code expects (spec §3.1).
 * - Search and contract results use Studio's result shapes (SearchHitV2, ContractSummaryV2).
 */
import type { RunResult, SqlParam, SqlRow } from "./driver-types.ts"

export type Row = SqlRow

export interface StoreLogEntry {
  level: "error" | "warn" | "info"
  source: string
  message: string
  stack?: string
  context?: Record<string, unknown>
  correlationId?: string
  timestamp: number
}
export type StoreLogger = (e: StoreLogEntry) => void

export interface StoreOpenOptions {
  release: string
  agentClock?: () => number
  /** default 5000 (spec §6.6) */
  busyTimeoutMs?: number
  /** queue-job timeout, default STUDIO_SUBMIT_TX_TIMEOUT_MS 60000 (C28) */
  txTimeoutMs?: number
  /** structured log sink; the host persists it (no PII: ids and codes only). */
  log?: StoreLogger
  /** lock liveness check (tests inject; default lock.ts defaultIsLiveHost) */
  isLiveHost?: (pid: number) => boolean
  /**
   * Row 119a (mission contract §5.1 "one guard for every path"): when true, createDocument refuses a work report
   * (contract kind agentWorkReport) without a mission (MISSION_REQUIRED) and links it in the same job, and
   * appendRevision refuses a work report without a link (REPORT_NOT_IN_MISSION). Default false; the host turns it
   * on when the report tools carry mission ids (row 119b).
   */
  missionGuard?: boolean
}

export interface StoreTx {
  readonly id: string
  readonly now: number
  readonly alive: boolean
  run(sql: string, params?: readonly SqlParam[]): RunResult
  get<T = Row>(sql: string, params?: readonly SqlParam[]): T | undefined
  all<T = Row>(sql: string, params?: readonly SqlParam[]): T[]
}

export type Completeness = "INCOMPLETE" | "COMPLETE"

export interface ChangeNote {
  what: string
  why: string
  impact: string
  addresses?: string[]
  scope?: string | null
}

export interface ContractMirror {
  kind: string | null
  status?: string | null
  owner?: string | null
  taskRef?: string | null
  /** YYYY-MM-DD */
  dueOn?: string | null
  /** each `t_` + 8 hex (C34) */
  cardIds?: string[]
}

export interface RevisionRowsInput {
  /** new doc_identity rows (document_id injected) */
  identities?: Row[]
  /** pids whose identity is retired at this revision (retired_revision_no = new revision_no) */
  retirePids?: string[]
  sections?: Row[]
  chapters?: Row[]
  subsections?: Row[]
  /** doc_block (v2, the search corpus) */
  blocks?: Row[]
  /** block (M06, the v1 dual-write) */
  legacyBlocks?: Row[]
  contractRecord?: (Row & { items?: Row[]; refs?: Row[] }) | null
}

export interface RevisionContent {
  snapshot: unknown
  snapshotSha256?: string
  inputSha256: string
  docRev: string
  change: ChangeNote
  createdBy: string
  schemaId?: string
  structureSha256?: string | null
  completeness?: Completeness
  completenessReport?: unknown
  rows?: RevisionRowsInput
}

export interface DocumentPatch {
  title?: string
  completeness?: Completeness
  contract?: ContractMirror
}

export interface NewDocument {
  id?: string
  docNumber: string
  /** default docNumberSafe(docNumber) */
  docNumberSafe?: string
  numberSource: "AGENT" | "SEQUENCE"
  title: string
  typeCode: string
  language?: string
  classification: string
  tier: "NOTA" | "TERBIT" | "SERAH"
  templateVersionId: string
  missionFolder?: string | null
  missionDocKey?: string | null
  agentRequestId?: string | null
  hermesTaskId?: string | null
  createdBy: string
  completeness?: Completeness
  contract?: ContractMirror
  revision: RevisionContent
}

export interface NewRevision extends RevisionContent {
  documentId: string
  /** default: the previous revision's pin (a template move pins a new version, spec §7.1) */
  templateVersionId?: string
  document?: DocumentPatch
}

export interface DocumentRow {
  id: string
  doc_number: string
  doc_number_safe: string
  number_source: string
  title: string
  type_code: string
  language: string
  classification: string
  tier: string
  template_id: string
  current_revision_no: number
  mission_folder: string | null
  mission_doc_key: string | null
  agent_request_id: string | null
  hermes_task_id: string | null
  created_by: string
  archived: number
  completeness: Completeness
  contract_kind: string | null
  contract_status: string | null
  contract_owner: string | null
  contract_task_ref: string | null
  contract_due_on: string | null
  time_created: number
  time_updated: number
}

export interface RevisionRow {
  id: string
  document_id: string
  revision_no: number
  parent_revision_no: number | null
  template_version_id: string
  snapshot: unknown
  snapshot_sha256: string
  input_sha256: string
  doc_rev: string
  change_what: string
  change_why: string
  change_impact: string
  changed_addresses: string[]
  release_status: string
  lint_report: unknown
  created_by: string
  time_created: number
  schema_id: string
  structure_sha256: string | null
  completeness: Completeness
  completeness_report: unknown
  change_scope: string | null
}

export interface RevisionSummary {
  revision_no: number
  doc_rev: string
  change_what: string
  change_why: string
  change_impact: string
  created_by: string
  time_created: number
  release_status: string
  completeness: string
  template_version_id: string
}

export interface DocumentDetail {
  document: DocumentRow
  cardIds: string[]
  revisions: RevisionSummary[]
  template: { slug: string; origin: string; version_no: number } | null
  outputs: OutputFileRow[]
}

export interface RevisionWithRows {
  revision: RevisionRow
  template: { slug: string; origin: string; version_no: number }
  sections: Row[]
  chapters: Row[]
  subsections: Row[]
  blocks: Row[]
  legacyBlocks: Row[]
  contractRecord: Row | null
  contractItems: Row[]
  docRefs: Row[]
}

export interface TemplateRow {
  id: string
  slug: string
  origin: "builtin" | "user"
  name: string
  kind: string
  description: string | null
  is_canonical: number
  is_preset: number
  contract_kind: string | null
  archived: number
  latest_version_no: number
  created_by: string
  time_created: number
  time_updated: number
}

export interface TemplateVersionRow {
  id: string
  template_id: string
  version_no: number
  base_version_id: string | null
  definition: unknown
  definition_sha256: string
  overrides: unknown
  resolved_params: unknown
  params_sha256: string
  role_formats: unknown
  section_plan: unknown
  assets: unknown
  provenance: unknown
  skeleton: unknown
  skeleton_sha256: string | null
  change_note: string
  created_by: string
  time_created: number
  /** migration 0002 (row 64, templates spec §5.5): written only at INSERT; NULL for builtin pins and pre-0002 versions */
  guard_verdict: TemplateGuardVerdict | null
  /** JSON guard report (templates spec §5.5 / U.5), parsed on read */
  guard_report: unknown
  guard_skill_sha: string | null
  /** joined from template */
  slug?: string
  origin?: string
}

/** Template guard outcome that may be saved (a rejected version is never saved, templates spec §5). */
export type TemplateGuardVerdict = "pass" | "warn"

/** Byte cap of `template_version.guard_report` (templates spec §5.5: JSON, ≤64 KiB). */
export const TEMPLATE_GUARD_REPORT_MAX_BYTES = 65_536

/**
 * Guard result stored with a user template version (migration 0002). All three parts or none:
 * `skillSha` = sha256 hex of Studio's lint closure as shipped (names register R9).
 */
export interface TemplateGuardRecord {
  verdict: TemplateGuardVerdict
  report: unknown
  skillSha: string
}

/** One row of `listTemplateVersions`: version metadata without the large JSON columns. */
export interface TemplateVersionSummary {
  id: string
  version_no: number
  base_version_id: string | null
  definition_sha256: string
  params_sha256: string
  skeleton_sha256: string | null
  change_note: string
  created_by: string
  time_created: number
  guard_verdict: TemplateGuardVerdict | null
  guard_skill_sha: string | null
  /** revisions pinned to this version (the document-to-version link, `revision.template_version_id`) */
  revision_count: number
  /** documents with at least one revision pinned to this version */
  document_count: number
}

export interface TemplateVersionContent {
  definition: unknown
  definitionSha256?: string
  overrides?: unknown
  resolvedParams?: unknown
  paramsSha256?: string
  roleFormats?: unknown
  sectionPlan?: unknown
  assets?: unknown
  provenance?: unknown
  skeleton?: unknown
  skeletonSha256?: string | null
  changeNote: string
  createdBy: string
  /** user versions only; builtin pins always store NULL (they are guarded at build, row 45) */
  guard?: TemplateGuardRecord | null
}

export interface BuiltinTemplateFile extends Omit<TemplateVersionContent, "provenance" | "changeNote" | "createdBy" | "guard"> {
  slug: string
  name: string
  kind: string
  description?: string | null
  contractKind?: string | null
  isCanonical?: boolean
  isPreset?: boolean
  versionNo: number
  definitionSha256: string
  /** file name under Res/datum-studio/templates/ */
  file: string
  fileSha256: string
  release: string
  changeNote?: string
  createdBy?: string
}

export interface NewUserTemplate {
  slug: string
  name: string
  kind: string
  description?: string | null
  contractKind?: string | null
  baseVersionId?: string | null
  createdBy: string
  version: TemplateVersionContent
}

export interface NewTemplateVersion extends TemplateVersionContent {
  slug: string
}

export interface OutputFileRow {
  id: string
  kind: "document" | "preview"
  document_id: string | null
  revision_id: string | null
  template_version_id: string | null
  render_job_id: string | null
  format: string
  role: string
  figure_label: string | null
  rel_path: string
  file_name: string
  bytes: number
  sha256: string
  mime: string
  lint_verdict: string
  scope_kind: string
  scope_key: string | null
  draft: number
  time_created: number
}

export interface NewOutputFile {
  id?: string
  kind: "document" | "preview"
  documentId?: string | null
  revisionId?: string | null
  templateVersionId?: string | null
  renderJobId?: string | null
  format: "DOCX" | "PDF" | "HTML" | "SVG" | "PNG"
  role: "PRIMARY" | "FIGURE"
  figureLabel?: string | null
  relPath: string
  fileName: string
  bytes: number
  sha256: string
  mime: string
  lintVerdict?: "PENDING" | "PASS" | "FAIL" | "NOT_RUN"
  scopeKind?: "DOCUMENT" | "CHAPTER" | "SLOT"
  scopeKey?: string | null
  draft?: boolean
}

export interface AssetMeta {
  mime: "image/png" | "image/jpeg"
  widthPx: number
  heightPx: number
  missionFolder?: string | null
  createdBy: string
}

export interface AssetRow {
  id: string
  sha256: string
  mime: string
  bytes: number
  width_px: number
  height_px: number
  rel_path: string
  mission_folder: string | null
  created_by: string
  time_created: number
}

export interface RenderJobUpdate {
  id?: string
  documentId?: string | null
  revisionId?: string | null
  formats: string[]
  status: "QUEUED" | "RUNNING" | "SUCCEEDED" | "PARTIAL" | "FAILED"
  errorCode?: string | null
  errorMessage?: string | null
  engine?: unknown
  requestedBy: string
  scopeKind?: "DOCUMENT" | "CHAPTER" | "SLOT"
  scopeKey?: string | null
  timeQueued?: number
  timeStarted?: number | null
  timeFinished?: number | null
  durationMs?: number | null
}

/** Studio `services/query/filters.ts` ContractQueryFilter (structurally identical). */
export interface ContractQueryFilter {
  mission?: string
  docKey?: string
  docNumber?: string
  kind?: string
  status?: string[]
  cardId?: string
  owner?: string
  taskRef?: string
  dueBefore?: string
  dueAfter?: string
  take?: number
  cursor?: string
  includeArchived?: true
}

/** Studio `services/query/filters.ts` SearchQueryFilter (structurally identical). */
export interface SearchQueryFilter {
  q: string
  mission?: string
  kind?: string
  documentId?: string
  revisionNo?: number
  type?: string[]
  slotKey?: string
  take?: number
  cursor?: string
  includeArchived?: true
}

export interface SearchHitV2 {
  documentId: string
  docNumber: string
  title: string
  kind: string | null
  revisionNo: number
  pid: string
  address: string
  slotKey: string
  chapterKey: string | null
  type: string
  snippet: string
  /** higher is better (= -bm25), so Studio's cursor rule `r >= 0` and order `rank DESC, id DESC` hold */
  rank: number
}

export interface SearchBlocksResult {
  hits: SearchHitV2[]
  nextCursor: string | null
}

export interface ContractSummaryV2 {
  documentId: string
  docNumber: string
  title: string
  kind: string
  status: string | null
  owner: string | null
  taskRef: string | null
  cardIds: string[]
  dueOn: string | null
  revisionNo: number
  completeness: { status: Completeness; missingRequired: string[] }
  missionFolder: string | null
  docKey: string | null
  updatedAt: string
  matchedItems?: Array<{ key: string; status: string; pid: string; title: string }>
}

export interface QueryContractsResult {
  contracts: ContractSummaryV2[]
  nextCursor: string | null
}

export interface SnapshotReport {
  file: string
  integrity: string
  ftsIntegrity: "ok" | string
  journalMode: string
  schemaVersion: string | null
  storeId: string | null
  counts: { document: number; revision: number; output_file: number; asset: number; doc_block: number }
}

export interface ExportManifest {
  store_id: string
  schema_version: string
  release: string
  time: number
  counts: { document: number; revision: number; output_file: number; asset: number }
}

export interface StudioStore {
  open(root: string, opts: StoreOpenOptions): Promise<void>
  close(): Promise<void>
  transaction<T>(fn: (tx: StoreTx) => Promise<T>, opts?: { timeoutMs?: number; correlationId?: string }): Promise<T>
  createDocument(tx: StoreTx, input: NewDocument): Promise<DocumentRow>
  appendRevision(tx: StoreTx, input: NewRevision & { baseRevisionNo: number | "latest" }): Promise<RevisionRow>
  getDocument(id: string, tx?: StoreTx): Promise<DocumentDetail | null>
  getRevision(documentId: string, n: number | "latest", tx?: StoreTx): Promise<RevisionWithRows | null>
  queryContracts(f: ContractQueryFilter): Promise<QueryContractsResult>
  searchParagraphs(f: SearchQueryFilter): Promise<SearchBlocksResult>
  putOutput(tx: StoreTx, row: NewOutputFile): Promise<OutputFileRow>
  getOutput(id: string): Promise<OutputFileRow | null>
  putAsset(bytes: Uint8Array, meta: AssetMeta, tx?: StoreTx): Promise<AssetRow>
  getAsset(sha256: string): Promise<AssetRow | null>
  recordRender(tx: StoreTx, job: RenderJobUpdate, revisionLint?: { releaseStatus: string; lintReport: unknown }): Promise<void>
  pinBuiltinVersion(tx: StoreTx, file: BuiltinTemplateFile): Promise<TemplateVersionRow>
  createUserTemplate(tx: StoreTx, input: NewUserTemplate): Promise<TemplateVersionRow>
  addTemplateVersion(tx: StoreTx, input: NewTemplateVersion & { baseVersionNo: number }): Promise<TemplateVersionRow>
  setTemplateArchived(tx: StoreTx, slug: string, archived: boolean): Promise<void>
  listUserTemplates(opts: { archived?: boolean }): Promise<TemplateRow[]>
  getTemplateVersion(slug: string, versionNo?: number): Promise<TemplateVersionRow | null>
  /** row 64: every version of a template, oldest first, with its guard verdict and pinned revision/document counts */
  listTemplateVersions(slug: string, tx?: StoreTx): Promise<TemplateVersionSummary[]>
  exportTo(target: string): Promise<ExportManifest>
}
