/**
 * Studio row shapes (camelCase, Date timestamps) that the vendored services used from
 * `@prisma/client`, now local types over the row 8 schema, plus the mappers from the store's
 * snake_case rows (spec 01_specs_studio.md §1.2 "type-only imports ... patched to local row types";
 * 01_specs_studio_store.md §3.1). Field names are kept from the Prisma models so the ported code
 * reads them unchanged; columns the store dropped are fixed values (`artifactId: null`, M07).
 */
import { bool, dateOf, dateOrNull, dayDate, parseJson, type StudioJson } from "./db.ts"

export type Row = Record<string, unknown>

export interface StudioTemplate {
  id: string
  slug: string
  origin: "builtin" | "user"
  name: string
  kind: string
  description: string | null
  isCanonical: boolean
  isPreset: boolean
  contractKind: string | null
  archived: boolean
  latestVersionNo: number
  createdBy: string
  createdAt: Date
  updatedAt: Date
}

export interface StudioTemplateVersion {
  id: string
  templateId: string
  versionNo: number
  baseVersionId: string | null
  definition: StudioJson
  definitionSha256: string
  overrides: StudioJson
  resolvedParams: StudioJson
  paramsSha256: string
  roleFormats: StudioJson
  sectionPlan: StudioJson
  assets: StudioJson
  provenance: StudioJson
  /** Folded M10-M12 (C5): the canonical `studio.skeleton/v1` of this version, null = implicit. */
  skeleton: StudioJson | null
  skeletonSha256: string | null
  changeNote: string
  createdBy: string
  createdAt: Date
  /** Row 66: migration 0002 guard columns (written only at INSERT; null for builtin pins and pre-0002 versions). */
  guardVerdict: "pass" | "warn" | null
  guardReport: StudioJson | null
  guardSkillSha: string | null
}

export interface StudioDocument {
  id: string
  docNumber: string
  docNumberSafe: string
  numberSource: string
  title: string
  typeCode: string
  language: string
  classification: string
  tier: string
  templateId: string
  currentRevisionNo: number
  missionFolder: string | null
  missionDocKey: string | null
  agentRequestId: string | null
  hermesTaskId: string | null
  createdBy: string
  archived: boolean
  completeness: "INCOMPLETE" | "COMPLETE"
  contractKind: string | null
  contractStatus: string | null
  contractOwner: string | null
  contractTaskRef: string | null
  contractDueOn: Date | null
  contractCardIds: string[]
  createdAt: Date
  updatedAt: Date
}

export interface StudioRevision {
  id: string
  documentId: string
  revisionNo: number
  parentRevisionNo: number | null
  templateVersionId: string
  snapshot: StudioJson
  snapshotSha256: string
  inputSha256: string
  docRev: string
  changeWhat: string
  changeWhy: string
  changeImpact: string
  changedAddresses: string[]
  releaseStatus: string
  lintReport: StudioJson | null
  createdBy: string
  createdAt: Date
  schemaId: string
  structureSha256: string | null
  completeness: "INCOMPLETE" | "COMPLETE"
  completenessReport: StudioJson | null
  changeScope: string | null
}

export interface StudioAsset {
  id: string
  sha256: string
  mime: string
  bytes: number
  widthPx: number
  heightPx: number
  relPath: string
  missionFolder: string | null
  createdBy: string
  createdAt: Date
}

export type StudioOutputFormat = "DOCX" | "PDF" | "HTML" | "SVG" | "PNG"
export type StudioScopeKind = "DOCUMENT" | "CHAPTER" | "SLOT"

export interface StudioOutputFile {
  id: string
  kind: "document" | "preview"
  documentId: string | null
  revisionId: string | null
  /** M07 dropped: always null. */
  artifactId: string | null
  templateVersionId: string | null
  renderJobId: string | null
  format: StudioOutputFormat
  role: "PRIMARY" | "FIGURE"
  figureLabel: string | null
  relPath: string
  fileName: string
  bytes: number
  sha256: string
  mime: string
  lintVerdict: "PENDING" | "PASS" | "FAIL" | "NOT_RUN"
  scopeKind: StudioScopeKind
  scopeKey: string | null
  draft: boolean
  createdAt: Date
}

export interface StudioRenderJob {
  id: string
  documentId: string | null
  revisionId: string | null
  /** M07 dropped: always null. */
  artifactId: string | null
  formats: string[]
  status: string
  errorCode: string | null
  errorMessage: string | null
  engine: StudioJson | null
  requestedBy: string
  scopeKind: StudioScopeKind
  scopeKey: string | null
  queuedAt: Date
  startedAt: Date | null
  finishedAt: Date | null
  durationMs: number | null
}

const n = (v: unknown): number => Number(v)
const nOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v))
const s = (v: unknown): string => String(v)
const sOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v))

export function templateOf(r: Row): StudioTemplate {
  return {
    id: s(r.id),
    slug: s(r.slug),
    origin: r.origin === "user" ? "user" : "builtin",
    name: s(r.name),
    kind: s(r.kind),
    description: sOrNull(r.description),
    isCanonical: bool(r.is_canonical),
    isPreset: bool(r.is_preset),
    contractKind: sOrNull(r.contract_kind),
    archived: bool(r.archived),
    latestVersionNo: n(r.latest_version_no),
    createdBy: s(r.created_by),
    createdAt: dateOf(r.time_created),
    updatedAt: dateOf(r.time_updated),
  }
}

export function templateVersionOf(r: Row): StudioTemplateVersion {
  return {
    id: s(r.id),
    templateId: s(r.template_id),
    versionNo: n(r.version_no),
    baseVersionId: sOrNull(r.base_version_id),
    definition: parseJson(r.definition),
    definitionSha256: s(r.definition_sha256),
    overrides: parseJson(r.overrides),
    resolvedParams: parseJson(r.resolved_params),
    paramsSha256: s(r.params_sha256),
    roleFormats: parseJson(r.role_formats),
    sectionPlan: parseJson(r.section_plan),
    assets: parseJson(r.assets),
    provenance: parseJson(r.provenance),
    skeleton: r.skeleton === null || r.skeleton === undefined ? null : parseJson(r.skeleton),
    skeletonSha256: sOrNull(r.skeleton_sha256),
    changeNote: s(r.change_note),
    createdBy: s(r.created_by),
    createdAt: dateOf(r.time_created),
    guardVerdict: r.guard_verdict === "pass" || r.guard_verdict === "warn" ? r.guard_verdict : null,
    guardReport: r.guard_report === null || r.guard_report === undefined ? null : parseJson(r.guard_report),
    guardSkillSha: sOrNull(r.guard_skill_sha),
  }
}

/** `cards` = the document_card rows (the Prisma `contractCardIds String[]`). */
export function documentOf(r: Row, cards: readonly string[] = []): StudioDocument {
  return {
    id: s(r.id),
    docNumber: s(r.doc_number),
    docNumberSafe: s(r.doc_number_safe),
    numberSource: s(r.number_source),
    title: s(r.title),
    typeCode: s(r.type_code),
    language: s(r.language),
    classification: s(r.classification),
    tier: s(r.tier),
    templateId: s(r.template_id),
    currentRevisionNo: n(r.current_revision_no),
    missionFolder: sOrNull(r.mission_folder),
    missionDocKey: sOrNull(r.mission_doc_key),
    agentRequestId: sOrNull(r.agent_request_id),
    hermesTaskId: sOrNull(r.hermes_task_id),
    createdBy: s(r.created_by),
    archived: bool(r.archived),
    completeness: r.completeness === "INCOMPLETE" ? "INCOMPLETE" : "COMPLETE",
    contractKind: sOrNull(r.contract_kind),
    contractStatus: sOrNull(r.contract_status),
    contractOwner: sOrNull(r.contract_owner),
    contractTaskRef: sOrNull(r.contract_task_ref),
    contractDueOn: dayDate(r.contract_due_on),
    contractCardIds: [...cards],
    createdAt: dateOf(r.time_created),
    updatedAt: dateOf(r.time_updated),
  }
}

export function revisionOf(r: Row): StudioRevision {
  return {
    id: s(r.id),
    documentId: s(r.document_id),
    revisionNo: n(r.revision_no),
    parentRevisionNo: nOrNull(r.parent_revision_no),
    templateVersionId: s(r.template_version_id),
    snapshot: parseJson(r.snapshot),
    snapshotSha256: s(r.snapshot_sha256),
    inputSha256: s(r.input_sha256),
    docRev: s(r.doc_rev),
    changeWhat: s(r.change_what),
    changeWhy: s(r.change_why),
    changeImpact: s(r.change_impact),
    changedAddresses: parseJson<string[]>(r.changed_addresses) ?? [],
    releaseStatus: s(r.release_status),
    lintReport: r.lint_report === null || r.lint_report === undefined ? null : parseJson(r.lint_report),
    createdBy: s(r.created_by),
    createdAt: dateOf(r.time_created),
    schemaId: s(r.schema_id),
    structureSha256: sOrNull(r.structure_sha256),
    completeness: r.completeness === "INCOMPLETE" ? "INCOMPLETE" : "COMPLETE",
    completenessReport: r.completeness_report === null || r.completeness_report === undefined ? null : parseJson(r.completeness_report),
    changeScope: sOrNull(r.change_scope),
  }
}

export function assetOf(r: Row): StudioAsset {
  return {
    id: s(r.id),
    sha256: s(r.sha256),
    mime: s(r.mime),
    bytes: n(r.bytes),
    widthPx: n(r.width_px),
    heightPx: n(r.height_px),
    relPath: s(r.rel_path),
    missionFolder: sOrNull(r.mission_folder),
    createdBy: s(r.created_by),
    createdAt: dateOf(r.time_created),
  }
}

export function outputFileOf(r: Row): StudioOutputFile {
  return {
    id: s(r.id),
    kind: r.kind === "preview" ? "preview" : "document",
    documentId: sOrNull(r.document_id),
    revisionId: sOrNull(r.revision_id),
    artifactId: null,
    templateVersionId: sOrNull(r.template_version_id),
    renderJobId: sOrNull(r.render_job_id),
    format: s(r.format) as StudioOutputFormat,
    role: r.role === "FIGURE" ? "FIGURE" : "PRIMARY",
    figureLabel: sOrNull(r.figure_label),
    relPath: s(r.rel_path),
    fileName: s(r.file_name),
    bytes: n(r.bytes),
    sha256: s(r.sha256),
    mime: s(r.mime),
    lintVerdict: s(r.lint_verdict) as StudioOutputFile["lintVerdict"],
    scopeKind: s(r.scope_kind) as StudioScopeKind,
    scopeKey: sOrNull(r.scope_key),
    draft: bool(r.draft),
    createdAt: dateOf(r.time_created),
  }
}

export function renderJobOf(r: Row): StudioRenderJob {
  return {
    id: s(r.id),
    documentId: sOrNull(r.document_id),
    revisionId: sOrNull(r.revision_id),
    artifactId: null,
    formats: parseJson<string[]>(r.formats) ?? [],
    status: s(r.status),
    errorCode: sOrNull(r.error_code),
    errorMessage: sOrNull(r.error_message),
    engine: r.engine === null || r.engine === undefined ? null : parseJson(r.engine),
    requestedBy: s(r.requested_by),
    scopeKind: s(r.scope_kind) as StudioScopeKind,
    scopeKey: sOrNull(r.scope_key),
    queuedAt: dateOf(r.time_queued),
    startedAt: dateOrNull(r.time_started),
    finishedAt: dateOrNull(r.time_finished),
    durationMs: nOrNull(r.duration_ms),
  }
}
