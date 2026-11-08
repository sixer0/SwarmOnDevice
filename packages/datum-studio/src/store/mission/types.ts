/**
 * Mission contract types (row 119a; masterplan/01_specs_mission_contract.md §2-§5, decisions U19, U20, C57).
 * JSON shapes follow `studio.mission/v1` (schema.ts). Times are UTC instants in JSON, integer ms in SQLite.
 */

export const MISSION_STATUSES = ["draft", "approved", "running", "paused", "done", "cancelled"] as const
export type MissionStatus = (typeof MISSION_STATUSES)[number]

export const ROW_STATUSES = ["pending", "running", "needs-review", "blocked", "done", "dropped"] as const
export type RowStatus = (typeof ROW_STATUSES)[number]

/** §3.2: the 15 row kinds (schema enum). A new kind is schema v2. */
export const ROW_KINDS = ["intake", "research", "spec", "synthesis", "reproduce", "diagnose", "fix", "implementation", "draft", "test", "gate", "review", "release", "publish", "report"] as const
export type RowKind = (typeof ROW_KINDS)[number]

/** §3.2: label printed in today's "Phase" column by the export (row 120). */
export const ROW_KIND_LABELS: Readonly<Record<RowKind, string>> = {
  intake: "intake",
  research: "research",
  spec: "masterplan",
  synthesis: "synthesis",
  reproduce: "reproduce",
  diagnose: "diagnose",
  fix: "fix",
  implementation: "implementation",
  draft: "draft",
  test: "test",
  gate: "gateway_check",
  review: "verification",
  release: "release",
  publish: "publish",
  report: "report",
}

export interface Bilingual {
  id: string
  en: string
}

export interface MissionPhaseDef {
  id: string
  name: Bilingual
  order: number
  kinds: RowKind[]
}

export interface MissionTypeDoc {
  $schema: "studio.mission-type/v1"
  id: string
  version: number
  name: Bilingual
  phases: MissionPhaseDef[]
}

export type SessionClient = "swarm" | "claude"
export type SessionRole = "controller" | "driver" | "viewer"

export interface SessionLink {
  client: SessionClient
  ref: string
  role?: SessionRole
  /** host-set */
  linkedAt?: string
}

export interface MissionProject {
  dir: string
  swarmProjectId?: string
}

export interface RowModel {
  /** GSP AI tiers of the bundled provider (row 166): thinker, worker, worker-fast; inherit = the session's model. Recorded only. */
  tier: "thinker" | "worker" | "worker-fast" | "inherit"
  reason?: string
}

export interface RowOwnership {
  text: string
  paths?: Array<{ path: string; state: "exists" | "new" | "unknown" }>
}

export interface ReportRef {
  documentId: string
  revisionNo: number
  kind: "row" | "delegation"
  status?: ReportStatus
}

/** A row as written by a caller (§4.1). Host fields are refused with FIELD_READ_ONLY. */
export interface MissionRowInput {
  id: string
  phase: string
  kind: RowKind
  title: string
  agent: string
  model: RowModel
  ownership?: RowOwnership
  deps: string[]
  size?: "S" | "M" | null
  status: RowStatus
  output: string
  verification: string
  resources?: string[]
  checks?: string
  review?: "gate" | "none"
  note?: string
  decision?: string
}

export interface RowCheckpoint {
  n: number
  m: number
  label?: string
  actor: string
  at: string
}

/** A row as read back: input fields plus host fields. */
export interface MissionRow extends MissionRowInput {
  createdAt: string
  updatedAt: string
  startedAt?: string
  finishedAt?: string
  reports?: ReportRef[]
}

export interface MissionDecision {
  id: string
  by: "user" | "controller"
  date: string
  text: string
  rows?: string[]
  supersedes?: string[]
}

export const FINDING_SEVERITIES = ["critical", "high", "medium", "low", "info"] as const
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number]

export interface MissionFinding {
  id: string
  severity: FindingSeverity
  title: string
  sourceRow: string
  ownerRow?: string
  status: "open" | "fixed" | "accepted" | "deferred"
  decision?: string
  evidence?: string
}

export interface MissionLockRecord {
  resource: string
  row: string
  holder: string
  acquiredAt: string
  releasedAt?: string
}

/** `studio.mission/v1` MissionDoc as read back. */
export interface MissionDoc {
  $schema: "studio.mission/v1"
  id: string
  title: string
  type: string
  typeVersion: number
  status: MissionStatus
  supersededBy?: string
  owner: string
  project: MissionProject
  createdAt: string
  updatedAt: string
  approvedAt?: string
  approvalDecision?: string
  closedAt?: string
  sessions?: SessionLink[]
  rows: MissionRow[]
  decisions?: MissionDecision[]
  findings?: MissionFinding[]
  locks?: MissionLockRecord[]
}

/** Input of `create` (§8.3 studio_mission_create): a draft MissionDoc without host fields. */
export interface NewMission {
  $schema?: "studio.mission/v1"
  id: string
  title: string
  type: string
  /** default: the highest pinned version of `type` */
  typeVersion?: number
  status?: "draft"
  owner: string
  project: MissionProject
  sessions?: SessionLink[]
  rows?: MissionRowInput[]
  decisions?: MissionDecision[]
  findings?: MissionFinding[]
}

export type ReportStatus = "draft" | "complete" | "partial" | "blocked" | "needs-review"

export interface StatusCounts {
  pending: number
  running: number
  "needs-review": number
  blocked: number
  done: number
  dropped: number
}

/** `studio.mission-status/v1` (§5.5). */
export interface MissionStatusSnapshot {
  $schema: "studio.mission-status/v1"
  mission: string
  takenAt: string
  reason?: "approve" | "status" | "export" | "manual"
  missionStatus: MissionStatus
  counts: StatusCounts
  waves: Array<{ wave: number; rows: string[] }>
  ready?: string[]
  locks?: MissionLockRecord[]
}

/** Derived on read, never stored (§4.3). */
export interface MissionDerived {
  phases: Array<{ id: string; name: Bilingual; order: number; rows: string[]; counts: StatusCounts }>
  waves: Array<{ wave: number; rows: string[] }>
  ready: string[]
  counts: StatusCounts
  /** C57 (b): mission progress = rows done / rows not dropped; separate from row checkpoints. */
  progress: { done: number; total: number }
  /** C57 (b): the latest checkpoint per row (agent bar). */
  checkpoints: Record<string, RowCheckpoint>
}

// ── C57 entities (not part of studio.mission/v1; validated in code, spec §6.1 change rule) ──────────

export interface DecisionOption {
  /** `^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$` */
  id: string
  label: string
  /** one line: what choosing this option leads to */
  consequence: string
}

export interface NewDecisionRequest {
  /** `D-<n>`, e.g. D-07 */
  id: string
  question: string
  /** at most one line (300 characters) */
  context?: string
  options: DecisionOption[]
  recommended?: string
  /** rows that may not start while the request is open */
  blockingRows?: string[]
}

export interface DecisionRequest extends NewDecisionRequest {
  status: "open" | "answered" | "withdrawn"
  requestedBy: string
  createdAt: string
  closedAt?: string
  answer?: { option: string; by: "user" | "controller"; decision: string }
}

export interface DecisionAnswer {
  option: string
  by: "user" | "controller"
  /** the decision id to record: U<n> for the user, C<n> for the controller */
  decisionId: string
  /** default: today (UTC) from the store clock */
  date?: string
  /** default: "<question> -> <option label> (<request id>)" */
  text?: string
}

export type MessageParty = "controller" | "agent" | "owner"
export type MessageKind = "report" | "instruction" | "question"

export interface NewMissionMessage {
  from: MessageParty
  to: MessageParty
  kind: MessageKind
  text: string
  row?: string
  actor?: string
}

export interface MissionMessage extends NewMissionMessage {
  seq: number
  at: string
}

export interface MissionEventRecord {
  seq: number
  row?: string
  actor: string
  verb: string
  from?: string
  to?: string
  decision?: string
  detail?: unknown
  at: string
}

/** Options every write accepts (§8.3): the declared actor (limit L2) and an optional session link. */
export interface MissionWriteOptions {
  actor?: string
  session?: SessionLink
}

export interface RowPatch {
  id: string
  add?: MissionRowInput
  set?: Partial<Omit<MissionRowInput, "id" | "status">>
  status?: RowStatus
  note?: string
  acquire?: string[]
  release?: string[]
  /** Row 174 (C218 F146b-3): ids of documents linked to this row (docKey row-<R>-<name>) to retire (archive); needs `note`. */
  retire?: string[]
}

export interface MissionListFilter {
  session?: { client: SessionClient; ref: string }
  status?: MissionStatus[]
  type?: string
  projectDir?: string
  q?: string
  take?: number
  cursor?: string
}

export interface MissionListItem {
  id: string
  title: string
  type: string
  typeVersion: number
  status: MissionStatus
  supersededBy?: string
  counts: StatusCounts
  progress: { done: number; total: number }
  phases: Array<{ id: string; name: Bilingual; counts: StatusCounts }>
  running: string[]
  blocked: string[]
  needsReview: string[]
  openFindings: Partial<Record<FindingSeverity, number>>
  openRequests: string[]
  heldLocks: string[]
  updatedAt: string
  /** when `q` was given: the best mission_fts snippet */
  snippet?: string
}

export interface MissionSearchHit {
  mission: string
  refKind: "row" | "decision" | "finding" | "request" | "message"
  refId: string
  snippet: string
}
