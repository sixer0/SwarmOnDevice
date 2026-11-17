/**
 * Mission store API (row 119a; masterplan/01_specs_mission_contract.md §2-§5, §7; decisions U19, U20, C57, C68).
 *
 * Same conventions as the Studio store: every write takes the `tx` of one `SqliteStudioStore.transaction()` job
 * (one BEGIN IMMEDIATE), so a failed check rolls back the whole job; reads take an optional tx and otherwise use
 * the query_only reader (committed data only). Refusals are StoreError with the §6.2 code and a `details` object.
 * The MCP tools (studio_mission_*, report semantics) are row 119b; they call this API one job per call.
 */
import { homedir } from "node:os"
import { posix } from "node:path"
import { StoreError } from "../errors.ts"
import { translateFtsQuery } from "../fts-query.ts"
import { canonicalJson, newId, sha256Hex } from "../ids.ts"
import type { SqliteDb, SqlParam } from "../driver-types.ts"
import type { NewDocument, Row, StoreTx } from "../types.ts"
import { BUILTIN_MISSION_TYPES } from "./builtin-types.ts"
import { computeWaves, countStatuses, emptyCounts, findBCycle, openBDeps, parseDep, readyRows, type DepEdge, type GraphRow } from "./derive.ts"
import type {
  DecisionAnswer,
  DecisionRequest,
  FindingSeverity,
  KnowledgeMark,
  MissionDecision,
  MissionDerived,
  MissionDoc,
  MissionDrift,
  MissionDriftChange,
  MissionEventRecord,
  MissionFinding,
  MissionListFilter,
  MissionListItem,
  MissionLockRecord,
  MissionMessage,
  MissionRow,
  MissionRowContract,
  MissionRowInput,
  MissionSearchHit,
  MissionStatus,
  MissionStatusSnapshot,
  MissionTypeDoc,
  MissionWriteOptions,
  NewDecisionRequest,
  NewMission,
  NewMissionMessage,
  ReportRef,
  ReportStatus,
  RowAwaitingHumanCheck,
  RowCheckpoint,
  RowDeliverable,
  RowFieldChange,
  RowHumanCheck,
  RowKnowledge,
  RowPatch,
  RowStatus,
  SessionLink,
} from "./types.ts"
import { ROW_HUMAN_CHECKS } from "./types.ts"
import { ROW_DELIVERABLE_KEY, rowCloseGate, type RowCloseNote } from "./output-gate.ts"
import { deliverableRefusal, deliverablesNotInProject, missionDeliverables, namedDocuments, requestDocumentIds, rowDocuments, type GateDocument } from "./deliverable-gate.ts"
import { assertActor, assertCheckpoint, assertDecisionAnswer, assertDecisionRequest, assertMessage, assertMissionSchema, groupNameOk } from "./validate.ts"

export interface MissionReader {
  get<T = Row>(sql: string, params?: readonly SqlParam[]): T | undefined
  all<T = Row>(sql: string, params?: readonly SqlParam[]): T[]
}

export interface MissionStoreHost {
  reader(): MissionReader
  log(level: "error" | "warn" | "info", source: string, err: unknown, context: Record<string, unknown>): void
  /**
   * Row 155 (spec output verification §7.3, D-10): true when the row `done` gate is on. The Studio store passes
   * `() => this.missionGuard` (the same switch as the 119a-d MISSION_REQUIRED guards). Absent = off.
   */
  outputGate?(): boolean
  /**
   * 1.3.3 row 66 (MC-5): the store root (absolute), so the done gate can see whether an output's file is on disk and
   * read the witness list a render left (`<root>/verify/<htmlOutputId>/witness.json`). Absent or null = files are not
   * looked at; the gate then judges from the database alone.
   */
  storeRoot?(): string | null
}

/** §2.2 mission transitions. `approved` is reached only through approve(). */
export const MISSION_TRANSITIONS: Readonly<Record<MissionStatus, readonly MissionStatus[]>> = {
  draft: ["approved", "cancelled"],
  approved: ["running", "paused", "cancelled"],
  running: ["paused", "done", "cancelled"],
  paused: ["running", "cancelled"],
  done: [],
  cancelled: [],
}

/**
 * §4.2 row transitions. 1.2.6 row 79 (MC-01, U5 alternative A): running -> done is allowed directly, but only with a
 * note (the check and its result; ROW_RUNNING_DONE_RULE); the done gate (OUTPUT_UNVERIFIED) still applies.
 */
export const ROW_TRANSITIONS: Readonly<Record<RowStatus, readonly RowStatus[]>> = {
  pending: ["running", "blocked", "dropped"],
  running: ["needs-review", "blocked", "done"],
  "needs-review": ["done", "blocked", "running"],
  blocked: ["running", "dropped"],
  done: ["running"],
  dropped: [],
}

/** Row 79 (MC-01): the one wording of the running -> done rule, shared by the refusal, the next-call hint and the update_row description. */
export const ROW_RUNNING_DONE_RULE = "running -> done needs a note (the check and its result); needs-review is optional"

/** §4.4: fields whose change after approval needs a decision. */
const STRUCTURAL_FIELDS = ["phase", "kind", "deps", "agent", "title", "output", "verification", "ownership", "size", "model"] as const
/**
 * 1.2.10 row 49 (P3, N10-050, C16 D-P3-1): the approved blueprint fields whose post-approval change is drift
 * (derived.drift.changed). Not title or ownership (D-P3-1). `output` and `verification` are free text: their change
 * is recorded by name only, never a value (C30, S10-30).
 */
const DRIFT_FIELDS = ["deps", "agent", "phase", "kind", "size", "model", "output", "verification"] as const
const DRIFT_NAME_ONLY: ReadonlySet<string> = new Set(["output", "verification"])

/** 1.2.10 row 49 (N10-052): the DRIFT_FIELDS of `set` whose value really changed from `cur` to `next` (spec 01c §3.2). */
function rowFieldChanges(cur: MissionRow, next: MissionRowInput, set: Record<string, unknown>): RowFieldChange[] {
  const out: RowFieldChange[] = []
  for (const f of DRIFT_FIELDS) {
    if (set[f] === undefined) continue
    let from: unknown
    let to: unknown
    if (f === "deps") {
      const a = [...cur.deps]
      const b = [...(next.deps ?? [])]
      const sa = new Set(a)
      if (sa.size === new Set(b).size && b.every((x) => sa.has(x))) continue // a reorder is not drift (D-P3-9)
      ;[from, to] = [a, b]
    } else if (f === "model") {
      if (cur.model.tier === next.model.tier) continue // tier only (D-P3-2)
      ;[from, to] = [cur.model.tier, next.model.tier]
    } else if (f === "size") {
      ;[from, to] = [cur.size ?? null, next.size ?? null]
      if (from === to) continue
    } else {
      ;[from, to] = [(cur as unknown as Record<string, unknown>)[f], (next as unknown as Record<string, unknown>)[f]]
      if (from === to) continue
    }
    out.push(DRIFT_NAME_ONLY.has(f) ? { field: f } : { field: f, from, to })
  }
  return out
}
const MISSION_HOST_FIELDS = ["createdAt", "updatedAt", "approvedAt", "approvalDecision", "closedAt", "locks"] as const
// 1.3.3 row 5 (register section 1): deliverables, knowledge and awaitingHumanCheck are written by the host setters only.
const ROW_HOST_FIELDS = ["createdAt", "updatedAt", "startedAt", "finishedAt", "reports", "deliverables", "knowledge", "awaitingHumanCheck"] as const
/** 1.3.3 row 5: the column of each row contract field (migration 0009), JSON text. */
const ROW_CONTRACT_COLUMNS = { deliverables: "deliverables", knowledge: "knowledge", awaitingHumanCheck: "awaiting_human_check" } as const
/** 1.3.3 row 5 (register section 1): files kept per domain in `knowledge.domains[].consulted`; later reads are not stored. */
const KNOWLEDGE_CONSULTED_MAX = 20
/** 1.3.3 row 101 (register section 1): `knowledge.domains` holds 1-25 items. */
const KNOWLEDGE_DOMAINS_MAX = 25

/**
 * 1.3.3 row 101 (spec KL-2 item 1): matches a row's text against the library trigger index. Set by the mission tools
 * (`setKnowledgeMatcher`); absent = rows are not matched at start. `reason` set = the library could not be read.
 */
type RowKnowledgeMatcher = (text: string) => { domains: ReadonlyArray<{ domain: string; firstFile: string }>; reason?: string }

/**
 * 1.3.3 row 101: the row's knowledge after a new match. Domains in match order (at most 25); a domain that stays
 * keeps its `consulted` marks, a new one starts empty, a lost one goes with its marks; `reason` is kept while any
 * domain remains. Nothing matched = undefined (store nothing).
 */
export function mergeRowKnowledge(cur: RowKnowledge | undefined, hits: ReadonlyArray<{ domain: string; firstFile: string }>): RowKnowledge | undefined {
  if (hits.length === 0) return undefined
  const domains = hits.slice(0, KNOWLEDGE_DOMAINS_MAX).map((h) => ({ domain: h.domain, firstFile: h.firstFile, consulted: cur?.domains.find((d) => d.domain === h.domain)?.consulted ?? [] }))
  return { domains, ...(cur?.reason !== undefined ? { reason: cur.reason } : {}) }
}

/** Same domains with the same first files (order aside): a new match that changes nothing is not written. */
function sameKnowledge(a: RowKnowledge | undefined, b: RowKnowledge | undefined): boolean {
  const key = (k: RowKnowledge | undefined) => (k?.domains ?? []).map((d) => `${d.domain}\u0000${d.firstFile}`).sort().join("\u0001")
  return key(a) === key(b)
}
const OPEN_STATUSES: readonly MissionStatus[] = ["draft", "approved", "running", "paused"]
const RESOURCE_RE = /^[a-z0-9][a-z0-9._/-]{0,79}$/
const DEFAULT_ACTOR = "swarm"
export const MISSION_LIST_LIMITS = { takeDefault: 50, takeMax: 200 } as const
export const MISSION_PATCH_MAX = 200
/** Contract kind of Studio's work report (vendor contract/enums.ts:467 CONTRACT_KINDS). */
export const WORK_REPORT_CONTRACT_KIND = "agentWorkReport"

const iso = (ms: number | null | undefined): string | undefined => (ms === null || ms === undefined ? undefined : new Date(Number(ms)).toISOString())
const parseJson = <T>(v: unknown): T | undefined => (typeof v === "string" ? (JSON.parse(v) as T) : undefined)

interface MissionDbRow {
  id: string
  title: string
  type_id: string
  type_version: number
  status: MissionStatus
  superseded_by: string | null
  owner: string
  project_dir: string
  swarm_project_id: string | null
  approval_decision_id: string | null
  time_created: number
  time_updated: number
  time_approved: number | null
  time_closed: number | null
}

interface RowDbRow {
  mission_id: string
  row_id: string
  phase_id: string
  kind: string
  title: string
  agent: string
  model_tier: string
  model_reason: string | null
  size: string | null
  status: RowStatus
  output: string
  verification: string
  ownership_text: string | null
  ownership_paths: string | null
  resources: string
  checks: string | null
  review: string
  note: string | null
  decision_id: string | null
  ord: number
  time_created: number
  time_updated: number
  time_started: number | null
  time_finished: number | null
  deliverables: string
  knowledge: string | null
  awaiting_human_check: string | null
}

function err(code: ConstructorParameters<typeof StoreError>[0], message: string, details?: Record<string, unknown>): StoreError {
  return new StoreError(code, message, details)
}

/** Row 85 (1.2.6, MC-07, register N-061): one entry per row patch of a studio_mission_update_row job. */
export interface RowPatchResult {
  id: string
  ok: boolean
  code?: string
  message?: string
  /** Row 82b (MC-04): true when the patch was refused for DEP_NOT_DONE but its note was stored. */
  noteSaved?: boolean
  /**
   * 1.3.3 row 66 (MC-5, U20): the row went `done` while a person's check is still open. `checks` and `since` are the
   * row field (register section 1); `figures` are the block addresses of the figures concerned (cap 20, the rest in
   * `moreFigures`). `message` then says it in one sentence. Only the person clears it (row 62).
   */
  awaitingHumanCheck?: { checks: string[]; since: string; figures: string[]; moreFigures?: number }
  /** 1.3.3 row 66: deliverables that closed without a layout file or with figure pages lacking a witness image (information). */
  closed?: RowCloseNote[]
}

/** 1.3.3 row 66: what the done gate found for a row that may close (nothing to say = `{}`). */
interface RowClose {
  awaitingHumanCheck?: { checks: RowHumanCheck[]; figures: string[]; moreFigures: number }
  closed?: RowCloseNote[]
}

/** What updateRows returns: applied rows, the per-patch results, and the derived waves / ready rows after the job. */
export interface RowPatchJobResult {
  changed: string[]
  results: RowPatchResult[]
  waves: Array<{ wave: number; rows: string[] }>
  ready: string[]
}

/** Row 85: the savepoint name each row patch runs under (one at a time, released before the next patch). */
const ROW_PATCH_SAVEPOINT = "mission_row_patch"

/** Row 197 (S194-01): a self-approval while Swarm's autonomous mode is off (the person turns it on, never the agent). */
function autonomousModeOff(mission: string, decision: string): StoreError {
  return err("AUTONOMOUS_MODE_OFF", "autonomous: true needs Swarm's autonomous mode setting to be on for this session (the person turns it on); it is off", { mission, decision })
}

/**
 * Pin the builtin mission types at store open (spec §3.1 rule 4): a pinned (id, version) is immutable; a pinned
 * version found with a different sha256 is logged as MISSION_TYPE_CHANGED and not overwritten.
 */
export function pinBuiltinMissionTypes(
  db: SqliteDb,
  now: number,
  log: MissionStoreHost["log"],
  types: readonly MissionTypeDoc[] = BUILTIN_MISSION_TYPES,
): { pinned: string[]; changed: string[] } {
  const pinned: string[] = []
  const changed: string[] = []
  for (const t of types) assertMissionType(t)
  db.exec("BEGIN IMMEDIATE")
  try {
    for (const t of types) {
      const sha = sha256Hex(canonicalJson(t))
      const have = db.get<{ definition_sha256: string }>("SELECT definition_sha256 FROM mission_type WHERE id = ? AND version = ?", [t.id, t.version])
      if (have) {
        if (have.definition_sha256 !== sha) {
          changed.push(`${t.id}@${t.version}`)
          log("warn", "MissionStore.pinBuiltinTypes", new StoreError("MISSION_TYPE_CHANGED", "pinned mission type differs from the shipped one; kept as pinned"), { type: t.id, version: t.version, pinned: have.definition_sha256, shipped: sha })
        }
        continue
      }
      db.run("INSERT INTO mission_type (id, version, name_id, name_en, definition, definition_sha256, time_created) VALUES (?, ?, ?, ?, ?, ?, ?)", [t.id, t.version, t.name.id, t.name.en, JSON.stringify(t), sha, now])
      for (const p of t.phases) {
        db.run("INSERT INTO mission_type_phase (type_id, type_version, phase_id, ord, name_id, name_en, kinds) VALUES (?, ?, ?, ?, ?, ?, ?)", [t.id, t.version, p.id, p.order, p.name.id, p.name.en, JSON.stringify(p.kinds)])
      }
      pinned.push(`${t.id}@${t.version}`)
    }
    db.exec("COMMIT")
  } catch (e) {
    try {
      db.exec("ROLLBACK")
    } catch {
      // already rolled back
    }
    throw e
  }
  return { pinned, changed }
}

/** Schema check plus the code-side rule of §3.1 rule 1: phase order 1..n, unique, no gaps; phase ids unique. */
export function assertMissionType(t: MissionTypeDoc): void {
  assertMissionSchema("MissionTypeDoc", t, `mission type ${String((t as { id?: unknown })?.id)}`)
  const orders = t.phases.map((p) => p.order).sort((a, b) => a - b)
  const ids = new Set(t.phases.map((p) => p.id))
  if (orders.some((o, i) => o !== i + 1) || ids.size !== t.phases.length) {
    throw err("SCHEMA_INVALID", `mission type ${t.id}: phase order must be 1..n without gaps and phase ids unique`, { type: t.id, orders })
  }
}

export class MissionStore {
  private readonly host: MissionStoreHost
  /** 1.3.3 row 101: the library matcher used when a row goes `running` (see setKnowledgeMatcher). */
  private knowledgeMatcher: RowKnowledgeMatcher | undefined
  /** No parameter property: the host runs this file under Node type stripping (erasable syntax only). */
  constructor(host: MissionStoreHost) {
    this.host = host
  }

  /**
   * 1.3.3 row 101 (KL-2 item 1): set (or with undefined remove) the matcher a row's title is matched with each time it
   * goes `running`, by update_row and by a work report alike. The mission tools set it when they are built.
   */
  setKnowledgeMatcher(fn: RowKnowledgeMatcher | undefined): void {
    this.knowledgeMatcher = fn
  }

  private r(tx?: MissionReader): MissionReader {
    return tx ?? this.host.reader()
  }

  // ── mission types ─────────────────────────────────────────────────────────

  listTypes(tx?: MissionReader): MissionTypeDoc[] {
    return this.r(tx)
      .all<{ definition: string }>("SELECT definition FROM mission_type ORDER BY id, version")
      .map((x) => JSON.parse(x.definition) as MissionTypeDoc)
  }

  getType(id: string, version?: number, tx?: MissionReader): MissionTypeDoc | null {
    const row =
      version === undefined
        ? this.r(tx).get<{ definition: string }>("SELECT definition FROM mission_type WHERE id = ? ORDER BY version DESC LIMIT 1", [id])
        : this.r(tx).get<{ definition: string }>("SELECT definition FROM mission_type WHERE id = ? AND version = ?", [id, version])
    return row ? (JSON.parse(row.definition) as MissionTypeDoc) : null
  }

  // ── internal reads ────────────────────────────────────────────────────────

  private missionRow(q: MissionReader, id: string): MissionDbRow {
    const m = q.get<MissionDbRow>("SELECT * FROM mission WHERE id = ?", [id])
    if (!m) throw err("MISSION_NOT_FOUND", "unknown mission", { mission: id })
    return m
  }

  private openMission(q: MissionReader, id: string): MissionDbRow {
    const m = this.missionRow(q, id)
    if (m.status === "done" || m.status === "cancelled") throw err("MISSION_CLOSED", `mission is ${m.status}`, { mission: id, status: m.status })
    return m
  }

  private rowDb(q: MissionReader, mission: string, row: string): RowDbRow {
    const r = q.get<RowDbRow>("SELECT * FROM mission_row WHERE mission_id = ? AND row_id = ?", [mission, row])
    if (!r) throw err("ROW_UNKNOWN", "unknown row", { mission, row })
    return r
  }

  private graph(q: MissionReader, mission: string): { rows: Array<GraphRow & { phase: string }>; deps: DepEdge[] } {
    const rows = q.all<{ row_id: string; status: RowStatus; phase_id: string }>("SELECT row_id, status, phase_id FROM mission_row WHERE mission_id = ? ORDER BY ord", [mission]).map((r) => ({ id: r.row_id, status: r.status, phase: r.phase_id }))
    const deps = q
      .all<{ row_id: string; dep_row_id: string; kind: "B" | "C" }>("SELECT row_id, dep_row_id, kind FROM mission_row_dep WHERE mission_id = ? ORDER BY row_id, position", [mission])
      .map((d) => ({ row: d.row_id, dep: d.dep_row_id, kind: d.kind }))
    return { rows, deps }
  }

  private hasDecision(q: MissionReader, mission: string, decision: string): { by: string; autonomous: number | null } | undefined {
    return q.get<{ by: string; autonomous: number | null }>("SELECT by, autonomous FROM mission_decision WHERE mission_id = ? AND decision_id = ?", [mission, decision])
  }

  private requireDecision(q: MissionReader, mission: string, decision: string | undefined, why: string): string {
    if (!decision) throw err("DECISION_REQUIRED", `${why} needs a decision`, { mission })
    if (!this.hasDecision(q, mission, decision)) throw err("DECISION_UNKNOWN", "decision is not recorded in this mission", { mission, decision })
    return decision
  }

  /** Rows named as blocking by open decision requests (C57 a). */
  private requestBlocks(q: MissionReader, mission: string): Map<string, string[]> {
    const out = new Map<string, string[]>()
    for (const r of q.all<{ request_id: string; blocking_rows: string }>("SELECT request_id, blocking_rows FROM mission_decision_request WHERE mission_id = ? AND status = 'open' ORDER BY time_created, request_id", [mission])) {
      for (const row of JSON.parse(r.blocking_rows) as string[]) out.set(row, [...(out.get(row) ?? []), r.request_id])
    }
    return out
  }

  private event(tx: StoreTx, e: { mission: string; verb: string; actor?: string; row?: string; from?: string | null; to?: string | null; decision?: string | null; detail?: unknown }): void {
    tx.run("INSERT INTO mission_event (mission_id, row_id, actor, verb, from_status, to_status, decision_id, detail, time_created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", [
      e.mission,
      e.row ?? null,
      e.actor ?? DEFAULT_ACTOR,
      e.verb,
      e.from ?? null,
      e.to ?? null,
      e.decision ?? null,
      e.detail === undefined ? null : JSON.stringify(e.detail),
      tx.now,
    ])
  }

  private touch(tx: StoreTx, mission: string): void {
    tx.run("UPDATE mission SET time_updated = ? WHERE id = ?", [tx.now, mission])
  }

  private actorOf(opts: MissionWriteOptions | undefined): string {
    const a = opts?.actor ?? DEFAULT_ACTOR
    assertActor(a)
    return a
  }

  /** Every write: declared actor, optional session link (§2.4), mission time_updated. */
  private afterWrite(tx: StoreTx, mission: string, opts: MissionWriteOptions | undefined): void {
    if (opts?.session) this.upsertSession(tx, mission, opts.session, this.actorOf(opts))
    this.touch(tx, mission)
  }

  // ── create ────────────────────────────────────────────────────────────────

  /** studio_mission_create (§8.3): a draft mission with optional rows, decisions, findings and sessions. */
  create(tx: StoreTx, input: NewMission, opts?: MissionWriteOptions): { id: string; status: "draft"; rows: number; waves: Array<{ wave: number; rows: string[] }> } {
    const actor = this.actorOf(opts)
    const readOnly = MISSION_HOST_FIELDS.filter((f) => (input as unknown as Record<string, unknown>)?.[f] !== undefined)
    for (const [i, row] of (input?.rows ?? []).entries()) {
      for (const f of ROW_HOST_FIELDS) if ((row as unknown as Record<string, unknown>)[f] !== undefined) readOnly.push(`rows/${i}/${f}` as never)
    }
    for (const [i, s] of (input?.sessions ?? []).entries()) if (s.linkedAt !== undefined) readOnly.push(`sessions/${i}/linkedAt` as never)
    if (readOnly.length > 0) throw err("FIELD_READ_ONLY", "input carries host fields", { fields: readOnly })
    if (input?.status !== undefined && input.status !== "draft") throw err("STATUS_TRANSITION", "a mission is created as draft", { from: null, to: input.status, allowed: ["draft"] })

    let typeVersion = input?.typeVersion
    if (typeVersion === undefined && typeof input?.type === "string") {
      typeVersion = tx.get<{ v: number | null }>("SELECT max(version) AS v FROM mission_type WHERE id = ?", [input.type])?.v ?? undefined
    }
    const doc = { $schema: "studio.mission/v1", ...input, typeVersion: typeVersion ?? 1, status: "draft", rows: input?.rows ?? [] }
    assertMissionSchema("MissionDoc", doc, "mission")
    const type = this.getType(input.type, doc.typeVersion, tx)
    if (!type) throw err("MISSION_TYPE_UNKNOWN", "mission type or version is not pinned", { type: input.type, version: doc.typeVersion })
    if (tx.get("SELECT 1 FROM mission WHERE id = ?", [input.id])) throw err("MISSION_ID_TAKEN", "mission id exists", { mission: input.id })
    const rows = doc.rows
    for (const r of rows) if (r.status !== "pending" && r.status !== "dropped") throw err("STATUS_TRANSITION", "rows are created pending or dropped", { row: r.id, from: null, to: r.status, allowed: ["pending", "dropped"] })

    tx.run(
      "INSERT INTO mission (id, title, type_id, type_version, status, owner, project_dir, swarm_project_id, time_created, time_updated) VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?)",
      [input.id, input.title, type.id, type.version, input.owner, input.project.dir, input.project.swarmProjectId ?? null, tx.now, tx.now],
    )
    this.event(tx, { mission: input.id, verb: "create", actor, to: "draft", detail: { type: type.id, version: type.version, rows: rows.length } })
    for (const d of input.decisions ?? []) this.insertDecision(tx, input.id, d, actor, opts)
    this.insertRows(tx, input.id, type, rows, null, actor)
    for (const f of input.findings ?? []) this.upsertFinding(tx, input.id, f, actor)
    for (const s of input.sessions ?? []) this.upsertSession(tx, input.id, s, actor)
    if (opts?.session) this.upsertSession(tx, input.id, opts.session, actor)
    const g = this.graph(tx, input.id)
    return { id: input.id, status: "draft", rows: rows.length, waves: computeWaves(g.rows, g.deps) }
  }

  /** Insert rows (phase/kind by trigger, pre-checked here for details), then deps, then the B-cycle check. */
  private insertRows(tx: StoreTx, mission: string, type: MissionTypeDoc, rows: readonly MissionRowInput[], decision: string | null, actor: string): void {
    const taken = new Set(tx.all<{ row_id: string }>("SELECT row_id FROM mission_row WHERE mission_id = ?", [mission]).map((r) => r.row_id))
    for (const r of rows) {
      if (taken.has(r.id)) throw err("ROW_ID_TAKEN", "row id exists in this mission", { mission, row: r.id })
      taken.add(r.id)
    }
    let ord = tx.get<{ n: number | null }>("SELECT max(ord) AS n FROM mission_row WHERE mission_id = ?", [mission])?.n ?? 0
    for (const r of rows) {
      this.checkPhaseKind(type, r)
      const rowDecision = r.decision ?? decision ?? undefined
      if (rowDecision && !this.hasDecision(tx, mission, rowDecision)) throw err("DECISION_UNKNOWN", "row decision is not recorded in this mission", { mission, row: r.id, decision: rowDecision })
      ord += 1
      tx.run(
        `INSERT INTO mission_row (mission_id, row_id, phase_id, kind, title, agent, model_tier, model_reason, size, status, output, verification,
           ownership_text, ownership_paths, resources, checks, review, note, decision_id, ord, time_created, time_updated)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          mission,
          r.id,
          r.phase,
          r.kind,
          r.title,
          r.agent,
          r.model.tier,
          r.model.reason ?? null,
          r.size ?? null,
          r.status,
          r.output,
          r.verification,
          r.ownership?.text ?? null,
          r.ownership?.paths ? JSON.stringify(r.ownership.paths) : null,
          JSON.stringify(r.resources ?? []),
          r.checks ?? null,
          r.review ?? "gate",
          r.note ?? null,
          rowDecision ?? null,
          ord,
          tx.now,
          tx.now,
        ],
      )
      this.event(tx, { mission, verb: "row-add", actor, row: r.id, to: r.status, decision: rowDecision ?? null })
    }
    for (const r of rows) this.writeDeps(tx, mission, r.id, r.deps, r.status)
    this.assertNoCycle(tx, mission)
  }

  private checkPhaseKind(type: MissionTypeDoc, r: { id: string; phase: string; kind: string }): void {
    const phase = type.phases.find((p) => p.id === r.phase)
    if (!phase) throw err("PHASE_UNKNOWN", `phase ${r.phase} is not a phase of ${type.id}@${type.version}`, { row: r.id, phase: r.phase, type: type.id, phases: type.phases.map((p) => p.id) })
    if (!(phase.kinds as readonly string[]).includes(r.kind)) throw err("KIND_NOT_ALLOWED", `kind ${r.kind} is not allowed in phase ${r.phase} of ${type.id}`, { row: r.id, phase: r.phase, kind: r.kind, allowed: phase.kinds })
  }

  /** Replace a row's deps (§4.3: DEP_SELF, DEP_UNKNOWN, DEP_DROPPED; duplicate targets are SCHEMA_INVALID). */
  private writeDeps(tx: StoreTx, mission: string, row: string, deps: readonly string[], rowStatus: RowStatus): void {
    tx.run("DELETE FROM mission_row_dep WHERE mission_id = ? AND row_id = ?", [mission, row])
    const seen = new Set<string>()
    deps.forEach((raw, i) => {
      const d = parseDep(raw)
      if (d.row === row) throw err("DEP_SELF", "a row cannot depend on itself", { mission, row })
      if (seen.has(d.row)) throw err("SCHEMA_INVALID", "a dependency is listed twice", { mission, row, dep: d.row })
      seen.add(d.row)
      const target = tx.get<{ status: RowStatus }>("SELECT status FROM mission_row WHERE mission_id = ? AND row_id = ?", [mission, d.row])
      if (!target) throw err("DEP_UNKNOWN", "dependency on a row that does not exist", { mission, row, dep: d.row })
      if (d.kind === "B" && target.status === "dropped" && rowStatus !== "dropped") throw err("DEP_DROPPED", "B dependency on a dropped row", { mission, row, dep: d.row })
      tx.run("INSERT INTO mission_row_dep (mission_id, row_id, dep_row_id, kind, position) VALUES (?, ?, ?, ?, ?)", [mission, row, d.row, d.kind, i + 1])
    })
  }

  private assertNoCycle(tx: StoreTx, mission: string): void {
    const g = this.graph(tx, mission)
    const cycle = findBCycle(g.rows, g.deps)
    if (cycle) throw err("DEP_CYCLE", "B dependencies form a cycle", { mission, cycle })
  }

  // ── approve and mission status ────────────────────────────────────────────

  /** studio_mission_approve (§2.2, §2.3): draft -> approved with a user decision; writes a snapshot. */
  approve(tx: StoreTx, mission: string, decision: string | undefined, opts?: MissionWriteOptions): { id: string; status: "approved"; approvedAt: string; snapshotId: string } {
    const actor = this.actorOf(opts)
    const m = this.openMission(tx, mission)
    if (m.status !== "draft") throw err("STATUS_TRANSITION", `mission is ${m.status}`, { from: m.status, to: "approved", allowed: MISSION_TRANSITIONS[m.status] })
    const live = tx.get<{ n: number }>("SELECT count(*) AS n FROM mission_row WHERE mission_id = ? AND status <> 'dropped'", [mission])!.n
    if (Number(live) === 0) throw err("MISSION_EMPTY", "a mission without rows cannot be approved", { mission })
    if (!decision) throw err("DECISION_REQUIRED", "approval needs the id of a user decision", { mission })
    const d = this.hasDecision(tx, mission, decision)
    if (!d) throw err("DECISION_UNKNOWN", "decision is not recorded in this mission", { mission, decision })
    // Row 188 (L47, L19): a controller decision passes only when it is marked autonomous; it stays by: controller.
    const autonomous = d.by === "controller" && Number(d.autonomous) === 1
    if (autonomous && opts?.autonomousMode === false) throw autonomousModeOff(mission, decision)
    if (d.by !== "user" && !autonomous) {
      throw err("APPROVAL_NEEDS_USER_DECISION", "the approval decision must be recorded by: user, or by: controller with autonomous: true when Swarm's autonomous mode is on", { mission, decision, by: d.by, autonomous: false })
    }
    tx.run("UPDATE mission SET status = 'approved', approval_decision_id = ?, time_approved = ?, time_updated = ? WHERE id = ?", [decision, tx.now, tx.now, mission])
    this.event(tx, { mission, verb: "approve", actor, from: "draft", to: "approved", decision, detail: { by: d.by, autonomous } })
    const snapshotId = this.writeSnapshot(tx, mission, "approve")
    this.afterWrite(tx, mission, opts)
    return { id: mission, status: "approved", approvedAt: iso(tx.now)!, snapshotId }
  }

  /** studio_mission_set_status (§2.2): running, paused, done, cancelled (+ supersededBy). */
  setStatus(
    tx: StoreTx,
    mission: string,
    to: MissionStatus,
    args: { decision?: string; supersededBy?: string; note?: string } = {},
    opts?: MissionWriteOptions,
  ): { id: string; from: MissionStatus; to: MissionStatus; snapshotId?: string; unchanged?: true } {
    const actor = this.actorOf(opts)
    const m = this.openMission(tx, mission)
    const from = m.status
    // 1.2.6 row 84 (MC-06, U5 alternative A): a move to the current status is a no-op, not a refusal. Nothing is
    // written: no status update, no event, no snapshot. approved stays reachable only through approve().
    if (to === from && to !== "approved") return { id: mission, from, to, unchanged: true }
    const allowed = MISSION_TRANSITIONS[from]
    if (to === "approved" || !allowed.includes(to)) throw err("STATUS_TRANSITION", `mission ${from} -> ${to} is not allowed`, { from, to, allowed, ...(to === "approved" ? { via: "approve" } : {}) })
    if (args.supersededBy !== undefined && to !== "cancelled") throw err("SUPERSEDE_TARGET", "supersededBy is allowed only with cancelled", { mission, supersededBy: args.supersededBy })
    if (to === "done") {
      const open = tx.all<{ row_id: string }>("SELECT row_id FROM mission_row WHERE mission_id = ? AND status NOT IN ('done','dropped') ORDER BY ord", [mission]).map((r) => r.row_id)
      if (open.length > 0) throw err("MISSION_ROWS_OPEN", "rows are not done or dropped", { mission, rows: open })
      // 1.2.8 row 39 (MEM-e): Swarm said this project's memory has no index entry for the mission (order: STATUS_TRANSITION
      // -> MISSION_ROWS_OPEN -> MEMORY_INDEX_MISSING; a no-op move above is never checked).
      if (opts?.memoryIndex?.missionId === mission && opts.memoryIndex.present === false) throw err("MEMORY_INDEX_MISSING", "no mission index entry in this project's memory", { mission })
    }
    let decision: string | null = null
    if (to === "cancelled") {
      decision = this.requireDecision(tx, mission, args.decision, "cancelling a mission")
      if (args.supersededBy !== undefined) {
        const target = tx.get<{ status: string }>("SELECT status FROM mission WHERE id = ?", [args.supersededBy])
        if (!target || args.supersededBy === mission || target.status === "cancelled") throw err("SUPERSEDE_TARGET", "supersededBy must be another mission that is not cancelled", { mission, supersededBy: args.supersededBy })
      }
    } else if (args.decision !== undefined) {
      decision = this.requireDecision(tx, mission, args.decision, "status change")
    }
    const closing = to === "done" || to === "cancelled"
    tx.run("UPDATE mission SET status = ?, superseded_by = ?, time_closed = ?, time_updated = ? WHERE id = ?", [to, to === "cancelled" ? (args.supersededBy ?? null) : null, closing ? tx.now : null, tx.now, mission])
    this.event(tx, { mission, verb: "status", actor, from, to, decision, detail: args.note || args.supersededBy ? { note: args.note, supersededBy: args.supersededBy } : undefined })
    if (closing) this.closeLeftovers(tx, mission, actor)
    const snapshotId = this.writeSnapshot(tx, mission, "status")
    if (opts?.session) this.upsertSession(tx, mission, opts.session, actor)
    return { id: mission, from, to, snapshotId }
  }

  /** A closed mission holds no shared lock and keeps no open decision request. */
  private closeLeftovers(tx: StoreTx, mission: string, actor: string): void {
    for (const l of tx.all<{ seq: number; resource: string; row_id: string }>("SELECT seq, resource, row_id FROM mission_lock WHERE mission_id = ? AND time_released IS NULL", [mission])) {
      tx.run("UPDATE mission_lock SET time_released = ? WHERE seq = ?", [tx.now, l.seq])
      this.event(tx, { mission, verb: "unlock", actor, row: l.row_id, detail: { resource: l.resource, reason: "mission closed" } })
    }
    for (const r of tx.all<{ request_id: string }>("SELECT request_id FROM mission_decision_request WHERE mission_id = ? AND status = 'open'", [mission])) {
      tx.run("UPDATE mission_decision_request SET status = 'withdrawn', time_closed = ? WHERE mission_id = ? AND request_id = ?", [tx.now, mission, r.request_id])
      this.event(tx, { mission, verb: "decision", actor, detail: { request: r.request_id, action: "withdraw", reason: "mission closed" } })
    }
  }

  /** approved -> running, in the same job as the first running row or the first report (§2.2). */
  private autoRun(tx: StoreTx, m: MissionDbRow, actor: string, cause: string): void {
    if (m.status !== "approved") return
    tx.run("UPDATE mission SET status = 'running', time_updated = ? WHERE id = ?", [tx.now, m.id])
    m.status = "running"
    this.event(tx, { mission: m.id, verb: "status", actor, from: "approved", to: "running", detail: { cause } })
    this.writeSnapshot(tx, m.id, "status")
  }

  // ── rows ──────────────────────────────────────────────────────────────────

  /**
   * studio_mission_update_row (§8.3): 1-200 patches applied in order in this job.
   * Row 85 (1.2.6, MC-07, N-061): each patch runs under its own SAVEPOINT. A patch refused with a StoreError is rolled
   * back alone and reported in `results` ({id, ok: false, code, message}); the other patches stay applied. A job in
   * which no patch applies (and no note was kept, row 82b) throws the first patch's error unchanged. Row 82b (MC-04): a
   * patch whose status move is refused for DEP_NOT_DONE still stores its note ({..., noteSaved: true}). Any other error is a
   * fault, not a refusal, and still fails the whole job.
   */
  updateRows(tx: StoreTx, mission: string, patches: readonly RowPatch[], args: { decision?: string } = {}, opts?: MissionWriteOptions): RowPatchJobResult {
    const actor = this.actorOf(opts)
    if (!Array.isArray(patches) || patches.length < 1 || patches.length > MISSION_PATCH_MAX) throw err("SCHEMA_INVALID", `1-${MISSION_PATCH_MAX} row patches`, { count: Array.isArray(patches) ? patches.length : null })
    const m = this.openMission(tx, mission)
    const type = this.getType(m.type_id, m.type_version, tx)!
    const changed: string[] = []
    const results: RowPatchResult[] = []
    let firstRefusal: StoreError | undefined
    let notesKept = 0
    for (const p of patches) {
      tx.run(`SAVEPOINT ${ROW_PATCH_SAVEPOINT}`)
      let closeResult: Partial<RowPatchResult> = {}
      try {
        closeResult = this.applyRowPatch(tx, m, type, p, args.decision, actor)
        tx.run(`RELEASE SAVEPOINT ${ROW_PATCH_SAVEPOINT}`)
      } catch (e) {
        tx.run(`ROLLBACK TO SAVEPOINT ${ROW_PATCH_SAVEPOINT}`)
        tx.run(`RELEASE SAVEPOINT ${ROW_PATCH_SAVEPOINT}`)
        if (!(e instanceof StoreError)) throw e
        // transitionRow may have flipped the in-memory mission status (autoRun); re-read it after the rollback.
        m.status = this.openMission(tx, mission).status
        firstRefusal ??= e
        const refusal: RowPatchResult = { id: String(p?.id), ok: false, code: e.code, message: e.message.slice(e.code.length + 2) }
        // Row 82b (1.2.6, MC-04): notes are never gated by dependencies. A status move refused for DEP_NOT_DONE (only
        // this code) still stores the patch's note; the rest of the patch stays rolled back.
        if (e.code === "DEP_NOT_DONE" && p.status && p.note !== undefined && this.keepNote(tx, m, p.id, p.note, actor)) {
          refusal.noteSaved = true
          notesKept++
        }
        results.push(refusal)
        continue
      }
      changed.push(p.id)
      results.push({ id: p.id, ok: true, ...closeResult })
    }
    if (changed.length === 0 && notesKept === 0 && firstRefusal) throw firstRefusal
    this.afterWrite(tx, mission, opts)
    const g = this.graph(tx, mission)
    return { changed, results, waves: computeWaves(g.rows, g.deps), ready: readyRows(g.rows, g.deps, new Set(this.requestBlocks(tx, mission).keys())) }
  }

  /** Row 82b (MC-04): store a refused patch's note under its own savepoint; false when the note itself is refused. */
  private keepNote(tx: StoreTx, m: MissionDbRow, rowId: string, note: string, actor: string): boolean {
    tx.run(`SAVEPOINT ${ROW_PATCH_SAVEPOINT}`)
    try {
      this.setNote(tx, m, rowId, note, actor)
      tx.run(`RELEASE SAVEPOINT ${ROW_PATCH_SAVEPOINT}`)
      return true
    } catch (e) {
      tx.run(`ROLLBACK TO SAVEPOINT ${ROW_PATCH_SAVEPOINT}`)
      tx.run(`RELEASE SAVEPOINT ${ROW_PATCH_SAVEPOINT}`)
      if (!(e instanceof StoreError)) throw e
      return false
    }
  }

  /** One row patch (row 85 split it out of updateRows so each patch can run under its own savepoint). */
  private applyRowPatch(tx: StoreTx, m: MissionDbRow, type: MissionTypeDoc, p: RowPatch, callDecision: string | undefined, actor: string): Partial<RowPatchResult> {
    let closeResult: Partial<RowPatchResult> = {}
    const keys = Object.keys(p ?? {}).filter((k) => !["id", "add", "set", "status", "note", "acquire", "release", "retire", "decision", "knowledgeReason"].includes(k))
    if (keys.length > 0) throw err("SCHEMA_INVALID", "unknown patch fields", { row: p?.id, fields: keys })
    // 1.3.3 row 102 (C13): stored before the status move so the done gate sees it; a refused patch rolls it back.
    if (p.knowledgeReason !== undefined) this.setKnowledgeReason(tx, m, p.id, p.knowledgeReason)
    // Row 81 (1.2.6, MC-03): a patch-level decision overrides the call-level one for this patch only.
    if (p.decision !== undefined && typeof p.decision !== "string") throw err("SCHEMA_INVALID", "patch decision must be a decision id", { row: p.id, fields: ["decision"] })
    const decision = p.decision ?? callDecision
    if (p.add) this.addRow(tx, m, type, p, decision, actor)
    if (p.set) this.setRow(tx, m, type, p.id, p.set, decision, actor)
    // Row 174 (C218 F146b-3): retire before the status move, so `{retire, status: "done"}` is judged without the draft.
    if (p.retire !== undefined) this.retireDeliverables(tx, m, p.id, p.retire, p.note, actor)
    if (p.status) closeResult = this.transitionRow(tx, m, p.id, p.status, { note: p.note, decision, actor, cause: "update_row" })
    else if (p.note !== undefined && !p.add) this.setNote(tx, m, p.id, p.note, actor)
    for (const res of p.acquire ?? []) this.acquireLock(tx, m, p.id, res, actor)
    for (const res of p.release ?? []) this.releaseLock(tx, m, p.id, res, actor)
    return closeResult
  }

  private addRow(tx: StoreTx, m: MissionDbRow, type: MissionTypeDoc, p: RowPatch, decision: string | undefined, actor: string): void {
    const row = p.add!
    if (row.id !== p.id) throw err("SCHEMA_INVALID", "patch id and add.id differ", { id: p.id, addId: row.id })
    const ro = ROW_HOST_FIELDS.filter((f) => (row as unknown as Record<string, unknown>)[f] !== undefined)
    if (ro.length > 0) throw err("FIELD_READ_ONLY", "row carries host fields", { row: row.id, fields: ro })
    assertMissionSchema("Row", row, `row ${row.id}`)
    if (row.status !== "pending" && row.status !== "dropped") throw err("STATUS_TRANSITION", "rows are added pending or dropped", { row: row.id, from: null, to: row.status, allowed: ["pending", "dropped"] })
    const d = m.status === "draft" ? (decision ?? row.decision ?? null) : this.requireDecision(tx, m.id, decision ?? row.decision, "adding a row after approval")
    this.insertRows(tx, m.id, type, [{ ...row, decision: row.decision ?? d ?? undefined }], d, actor)
  }

  private setRow(tx: StoreTx, m: MissionDbRow, type: MissionTypeDoc, rowId: string, set: NonNullable<RowPatch["set"]>, decision: string | undefined, actor: string): void {
    const cur = this.readRow(tx, m.id, this.rowDb(tx, m.id, rowId))
    const bad = Object.keys(set).filter((k) => (ROW_HOST_FIELDS as readonly string[]).includes(k) || k === "id" || k === "status")
    if (bad.length > 0) throw err("FIELD_READ_ONLY", "set carries host or status fields", { row: rowId, fields: bad })
    const structural = STRUCTURAL_FIELDS.filter((f) => (set as Record<string, unknown>)[f] !== undefined)
    let d: string | null = null
    if (structural.length > 0 && m.status !== "draft") d = this.requireDecision(tx, m.id, decision ?? set.decision, `changing ${structural.join(", ")} after approval`)
    else if (decision ?? set.decision) d = this.requireDecision(tx, m.id, decision ?? set.decision, "row change")
    const next: MissionRowInput = { ...stripHost(cur), ...set, id: rowId, status: cur.status } as MissionRowInput
    if (d && structural.length > 0) next.decision = d
    assertMissionSchema("Row", next, `row ${rowId}`)
    if (set.phase !== undefined || set.kind !== undefined) this.checkPhaseKind(type, next)
    // 1.2.10 row 49 (P3): what really changed, compared before the UPDATE; a refused patch writes nothing (savepoint).
    const changes = rowFieldChanges(cur, next, set as Record<string, unknown>)
    tx.run(
      `UPDATE mission_row SET phase_id = ?, kind = ?, title = ?, agent = ?, model_tier = ?, model_reason = ?, size = ?, output = ?, verification = ?,
         ownership_text = ?, ownership_paths = ?, resources = ?, checks = ?, review = ?, note = ?, decision_id = ?, time_updated = ?
       WHERE mission_id = ? AND row_id = ?`,
      [
        next.phase,
        next.kind,
        next.title,
        next.agent,
        next.model.tier,
        next.model.reason ?? null,
        next.size ?? null,
        next.output,
        next.verification,
        next.ownership?.text ?? null,
        next.ownership?.paths ? JSON.stringify(next.ownership.paths) : null,
        JSON.stringify(next.resources ?? []),
        next.checks ?? null,
        next.review ?? "gate",
        next.note ?? null,
        next.decision ?? null,
        tx.now,
        m.id,
        rowId,
      ],
    )
    if (set.deps !== undefined) {
      this.writeDeps(tx, m.id, rowId, set.deps, cur.status)
      this.assertNoCycle(tx, m.id)
    }
    this.event(tx, { mission: m.id, verb: "row-change", actor, row: rowId, decision: d, detail: { fields: Object.keys(set), changes } })
  }

  /**
   * Row 174 (C218 F146b-3): retire (archive) deliverables linked to `rowId` that the row no longer delivers, e.g. an
   * abandoned old draft superseded by another document of the same row. Archived documents leave the done gate and the
   * Deliverables read (both read `archived = 0`, spec output verification §7.1). Not an escape from the gate: every id
   * must be a live deliverable bound to this row (docKey row-<R>-<name>), the patch needs a note (the reason), and at
   * least one live deliverable must stay bound to the row, which the gate then judges as before (UNKNOWN never passes).
   */
  private retireDeliverables(tx: StoreTx, m: MissionDbRow, rowId: string, ids: unknown, note: string | undefined, actor: string): void {
    this.rowDb(tx, m.id, rowId)
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > 16 || ids.some((x) => typeof x !== "string" || x.length < 1 || x.length > 64)) {
      throw err("SCHEMA_INVALID", "retire must list 1-16 document ids", { row: rowId, field: "retire" })
    }
    if (typeof note !== "string" || note.length < 1) throw err("SCHEMA_INVALID", "retire needs a note (why the documents are no longer this row's deliverables)", { row: rowId, field: "note" })
    const docs = new Map(
      tx
        .all<{ id: string; mission_doc_key: string | null; archived: number; contract_kind: string | null }>(
          "SELECT id, mission_doc_key, archived, contract_kind FROM document WHERE mission_folder = ?",
          [m.id],
        )
        .map((d) => [d.id, d]),
    )
    const live = (d: { mission_doc_key: string | null; archived: number; contract_kind: string | null }) =>
      d.archived === 0 && d.contract_kind !== WORK_REPORT_CONTRACT_KIND && ROW_DELIVERABLE_KEY.exec(d.mission_doc_key ?? "")?.[1] === rowId
    const refuse = (documentId: string, reason: string, message: string) => err("DELIVERABLE_NOT_RETIRABLE", message, { mission: m.id, row: rowId, documentId, reason })
    const unique = [...new Set(ids as string[])]
    for (const id of unique) {
      const d = docs.get(id)
      if (!d) throw refuse(id, "NOT_IN_MISSION", `document ${id} is not a document of mission ${m.id}`)
      if (d.archived !== 0) throw refuse(id, "ALREADY_RETIRED", `document ${id} is already retired`)
      if (!live(d)) throw refuse(id, "NOT_BOUND_TO_ROW", `document ${id} (docKey ${d.mission_doc_key ?? "-"}) is not a deliverable of row ${rowId} (docKey row-${rowId}-<name>)`)
    }
    const remaining = [...docs.values()].filter((d) => live(d) && !unique.includes(d.id))
    if (remaining.length === 0) {
      throw refuse(unique[0]!, "NO_CURRENT_DELIVERABLE", `retiring would leave row ${rowId} without a deliverable; keep the document that holds the row's current work`)
    }
    for (const id of unique) tx.run("UPDATE document SET archived = 1, time_updated = ? WHERE id = ?", [tx.now, id])
    this.event(tx, { mission: m.id, verb: "row-change", actor, row: rowId, detail: { fields: ["retire"], retired: unique.map((id) => ({ documentId: id, docKey: docs.get(id)!.mission_doc_key })), keeps: remaining.map((d) => d.id) } })
  }

  private setNote(tx: StoreTx, m: MissionDbRow, rowId: string, note: string, actor: string): void {
    this.rowDb(tx, m.id, rowId)
    if (typeof note !== "string" || note.length < 1 || note.length > 4000 || /[\u0000-\u001f]/.test(note)) {
      throw err("SCHEMA_INVALID", "note must be a cell: 1-4000 characters, no control characters", { row: rowId })
    }
    tx.run("UPDATE mission_row SET note = ?, time_updated = ? WHERE mission_id = ? AND row_id = ?", [note, tx.now, m.id, rowId])
    this.event(tx, { mission: m.id, verb: "row-change", actor, row: rowId, detail: { fields: ["note"] } })
  }

  // ── row contract fields (1.3.3 row 5, register section 1) ────────────────────
  // Host callers only: no MCP tool exposes these four setters, and a caller that sends one of the three fields in a
  // row gets FIELD_READ_ONLY. They store the value after the row schema check; gates and defaults live elsewhere.

  /** The three contract fields of one row. */
  rowContract(mission: string, rowId: string, tx?: MissionReader): MissionRowContract {
    return contractOf(this.rowDb(this.r(tx), this.missionRow(this.r(tx), mission).id, rowId))
  }

  /** Replace the row's deliverables list (at most 100; `[]` clears it). Every path starts with `deliverables/<mission-id>/`. */
  setRowDeliverables(tx: StoreTx, mission: string, rowId: string, value: readonly RowDeliverable[]): void {
    if (!Array.isArray(value)) throw err("SCHEMA_INVALID", "deliverables must be a list", { mission, row: rowId, field: "deliverables" })
    const outside = value.flatMap((d, i) => (typeof d?.path === "string" && !d.path.startsWith(`deliverables/${mission}/`) ? [`deliverables/${i}/path`] : []))
    if (outside.length > 0) throw err("SCHEMA_INVALID", `a deliverable path starts with deliverables/${mission}/`, { mission, row: rowId, fields: outside })
    this.writeRowContract(tx, mission, rowId, "deliverables", value)
  }

  /** Replace the row's knowledge field; `undefined` clears it (no domain matched). A domain without `consulted` gets `[]`. */
  setRowKnowledge(tx: StoreTx, mission: string, rowId: string, value: RowKnowledge | undefined): void {
    if (value === undefined || !Array.isArray(value?.domains)) return this.writeRowContract(tx, mission, rowId, "knowledge", value)
    const names = value.domains.map((d) => d?.domain)
    const twice = names.filter((n, i) => names.indexOf(n) !== i)
    if (twice.length > 0) throw err("SCHEMA_INVALID", "a knowledge domain is listed once", { mission, row: rowId, field: "knowledge", domains: [...new Set(twice)] })
    this.writeRowContract(tx, mission, rowId, "knowledge", { ...value, domains: value.domains.map((d) => (d && typeof d === "object" ? { ...d, consulted: d.consulted ?? [] } : d)) })
  }

  /**
   * Mark one served library file as read for a row. Stored only while the row is `running`. With `domain` the file is
   * added to that domain of the row; without it, to every domain whose `firstFile` is the path (the store holds no
   * index, so another file needs its domain named). At most KNOWLEDGE_CONSULTED_MAX files per domain; a file is listed
   * once. Nothing stored = `marked: false` with the reason, never an error (a bad path is SCHEMA_INVALID).
   */
  markKnowledgeConsulted(tx: StoreTx, mission: string, rowId: string, value: { path: string; domain?: string }): KnowledgeMark {
    const m = this.openMission(tx, mission)
    const row = this.rowDb(tx, m.id, rowId)
    if (row.status !== "running") return { marked: false, domains: [], reason: "row-not-running" }
    const knowledge = parseJson<RowKnowledge>(row.knowledge)
    if (!knowledge) return { marked: false, domains: [], reason: "no-knowledge" }
    const targets = knowledge.domains.filter((d) => (value.domain === undefined ? d.firstFile === value.path : d.domain === value.domain))
    if (targets.length === 0) return { marked: false, domains: [], reason: "no-domain" }
    const fresh = targets.filter((d) => !d.consulted.includes(value.path))
    if (fresh.length === 0) {
      // 1.3.3 row 102: a file listed in an earlier running period is recorded again (event only, list unchanged), so
      // the done gate, which counts reads since the latest start, sees it.
      if (this.consultedSinceStart(tx, m.id, rowId, [value.path])) return { marked: false, domains: [], reason: "already-marked" }
      const again = targets.map((d) => d.domain)
      this.event(tx, { mission: m.id, verb: "row-change", row: rowId, detail: { fields: ["knowledge"], consulted: value.path, domains: again, again: true } })
      this.touch(tx, m.id)
      return { marked: true, domains: again }
    }
    const domains = fresh.filter((d) => d.consulted.length < KNOWLEDGE_CONSULTED_MAX).map((d) => d.domain)
    if (domains.length === 0) return { marked: false, domains: [], reason: "cap" }
    this.writeRowContract(tx, mission, rowId, "knowledge", { ...knowledge, domains: knowledge.domains.map((d) => (domains.includes(d.domain) ? { ...d, consulted: [...d.consulted, value.path] } : d)) }, { consulted: value.path, domains })
    return { marked: true, domains }
  }

  /** Replace the row's awaitingHumanCheck field; `undefined` removes it. "Awaiting" = present and `clearedBy` absent. */
  setAwaitingHumanCheck(tx: StoreTx, mission: string, rowId: string, value: RowAwaitingHumanCheck | undefined): void {
    this.writeRowContract(tx, mission, rowId, "awaitingHumanCheck", value)
  }

  /** Schema check of the row with the new value, then the one column, a `row-change` event and the mission's time. */
  private writeRowContract(tx: StoreTx, mission: string, rowId: string, field: keyof MissionRowContract, value: unknown, detail: Record<string, unknown> = {}): void {
    const m = this.openMission(tx, mission)
    const cur = this.readRow(tx, m.id, this.rowDb(tx, m.id, rowId))
    if (value !== undefined) assertMissionSchema("Row", { ...stripHost(cur), [field]: value }, `row ${rowId}`)
    tx.run(`UPDATE mission_row SET ${ROW_CONTRACT_COLUMNS[field]} = ?, time_updated = ? WHERE mission_id = ? AND row_id = ?`, [value === undefined ? null : JSON.stringify(value), tx.now, m.id, rowId])
    this.event(tx, { mission: m.id, verb: "row-change", row: rowId, detail: { fields: [field], ...detail } })
    this.touch(tx, m.id)
  }

  /**
   * The done gate: every check a row passes before `done`, in order; each check throws its own refusal and may add to
   * the `RowClose` it is handed (what the close reply says). No decision lifts a check (D-6): this runs before any
   * decision is read.
   *
   * SEAM (rows 70 and 102): add ONE call per new check below, after the output check, e.g.
   *   this.checkDeliverablesInProject(tx, m, rowId, close)   // row 70, DELIVERABLE_NOT_IN_PROJECT
   *   this.checkKnowledgeConsulted(tx, m, rowId, close)      // row 102, KNOWLEDGE_NOT_CONSULTED
   * A check that must run whether or not the output gate is on goes outside the `outputGate` condition. Row 70 also
   * gates `needs-review`: call the same private check from `transitionRow` for that status; this method is for `done`.
   */
  private closeChecks(tx: StoreTx, m: MissionDbRow, rowId: string): RowClose {
    const close: RowClose = {}
    if (this.host.outputGate?.() === true) this.checkOutputsVerified(tx, m, rowId, close)
    // Row 70 after row 66: OUTPUT_UNVERIFIED wins when both apply (a copy is made only by a verified render).
    this.checkDeliverablesInProject(tx, m, rowId, "done")
    // Row 102 last, and whether or not the output gate is on: real output problems are fixed before the agent is asked
    // about reading.
    this.checkKnowledgeConsulted(tx, m, rowId)
    return close
  }

  /**
   * 1.3.3 row 147 (senior review S9/S6): the done gate's verdict for a row WITHOUT a status change: the same
   * `closeChecks` sequence (output, project copy, knowledge), read-only. null = `done` would pass now (a label check
   * of a person closes with its marker, so it is not a refusal); otherwise the refusal code `done` would give.
   * The checks only read (they throw before any write), so `q` may be a read-only reader.
   */
  closeRefusal(mission: string, rowId: string, q?: MissionReader): string | null {
    const tx = this.r(q) as StoreTx
    try {
      this.closeChecks(tx, this.missionRow(tx, mission), rowId)
      return null
    } catch (e) {
      if (e instanceof StoreError) return e.code
      throw e
    }
  }

  /**
   * 1.3.3 row 102 (KL-2 item 2, U19): a row with `knowledge` goes `done` only when one of its domain files was read
   * since the row's latest move to `running`, or with `knowledge.reason`. "Since" compares event order, not clock
   * time: a read counts when its `row-change` event (detail.consulted, written by markKnowledgeConsulted) has a larger
   * `seq` than the row's latest `row-status` event to `running` (two writes in the same millisecond stay ordered).
   */
  private checkKnowledgeConsulted(tx: StoreTx, m: MissionDbRow, rowId: string): void {
    const k = contractOf(this.rowDb(tx, m.id, rowId)).knowledge
    if (!k || k.domains.length === 0 || k.reason !== undefined) return
    if (this.consultedSinceStart(tx, m.id, rowId, k.domains.flatMap((d) => d.consulted))) return
    const domains = k.domains.map((d) => ({ domain: d.domain, firstFile: d.firstFile }))
    const q = JSON.stringify
    throw err(
      "KNOWLEDGE_NOT_CONSULTED",
      `row ${rowId} matched the GSP technical knowledge library (${domains.map((d) => `${d.domain} -> ${d.firstFile}`).join("; ")}) and no file of it was read while the row was running. ` +
        // row 151 (S2): the name the agent calls the tool by (Swarm lists host tools as datum-studio_<tool>), as in the
        // create/start replies; said in words, never as `tool_name {json}` (models copy that as a text-form call, MC-1/MC-3)
        `Read one: call the tool datum-studio_studio_library_read with path ${q(domains[0]!.firstFile)}, mission ${q(m.id)}, row ${q(rowId)}, then retry done. ` +
        `Or close with a reason: call the tool datum-studio_studio_mission_update_row with mission ${q(m.id)} and one row patch: id ${q(rowId)}, status "done", note (your check and its result), knowledgeReason (one line: why the library does not apply).`,
      { mission: m.id, row: rowId, domains },
    )
  }

  /** True when one of `paths` has a read event (detail.consulted) recorded after the row's latest move to `running`. */
  private consultedSinceStart(tx: StoreTx, mission: string, rowId: string, paths: readonly string[]): boolean {
    if (paths.length === 0) return false
    const start = tx.get<{ seq: number | null }>("SELECT max(seq) AS seq FROM mission_event WHERE mission_id = ? AND row_id = ? AND verb = 'row-status' AND to_status = 'running'", [mission, rowId])?.seq ?? 0
    return tx
      .all<{ path: string }>("SELECT json_extract(detail, '$.consulted') AS path FROM mission_event WHERE mission_id = ? AND row_id = ? AND verb = 'row-change' AND seq > ? AND json_extract(detail, '$.consulted') IS NOT NULL", [mission, rowId, start])
      .some((e) => paths.includes(e.path))
  }

  /**
   * 1.3.3 row 102 (C13, register section 1): the row patch field `knowledgeReason` becomes `knowledge.reason` (one
   * line, 1-300 characters, not only white space). A row without `knowledge` stores nothing: nothing there to waive.
   */
  private setKnowledgeReason(tx: StoreTx, m: MissionDbRow, rowId: string, reason: unknown): void {
    if (typeof reason !== "string" || reason.trim().length === 0 || reason.length > 300 || /[\u0000-\u001f]/.test(reason)) {
      throw err("SCHEMA_INVALID", "knowledgeReason must be one line of 1-300 characters, not only white space", { row: rowId, field: "knowledgeReason" })
    }
    const cur = contractOf(this.rowDb(tx, m.id, rowId)).knowledge
    if (!cur) return
    this.setRowKnowledge(tx, m.id, rowId, { ...cur, reason })
  }

  /**
   * 1.3.3 row 70 (MC-8 item 3, U16): a row whose outputs are Studio documents goes `needs-review` or `done` only with
   * the project copy of each document's current revision in its `deliverables`, on disk, sha256 equal
   * (deliverable-gate.ts). On with the output gate (missionGuard). No decision lifts it.
   */
  private checkDeliverablesInProject(tx: StoreTx, m: MissionDbRow, rowId: string, to: "done" | "needs-review"): void {
    if (this.host.outputGate?.() !== true) return
    const docs = rowDocuments(tx, m.id, rowId, WORK_REPORT_CONTRACT_KIND)
    if (docs.length === 0) return
    this.refuseNotInProject(tx, m, docs, contractOf(this.rowDb(tx, m.id, rowId)).deliverables, `row ${rowId} cannot go ${to}`, { row: rowId, to })
  }

  private refuseNotInProject(tx: StoreTx, m: MissionDbRow, docs: readonly GateDocument[], items: readonly RowDeliverable[], subject: string, where: Record<string, unknown>): void {
    const gate = deliverablesNotInProject(tx, m.id, nativeProjectDir(m.project_dir), docs, items)
    if (gate.cause === null) return
    const r = deliverableRefusal(subject, gate)
    throw err("DELIVERABLE_NOT_IN_PROJECT", r.message, {
      mission: m.id,
      ...where,
      cause: gate.cause,
      expected: gate.expected,
      ...(gate.more > 0 ? { more: gate.more } : {}),
      ...(gate.unwritable ? { unwritable: gate.unwritable } : {}),
      fix: r.fix,
    })
  }

  /**
   * Row 155 (spec output verification §7.3; C129, C130) as restated by 1.3.3 row 66 (MC-5, U20; output-gate.ts
   * `rowCloseGate`): done only when every deliverable bound to the row (docKey row-<R>-<name>) has its outputs
   * verified. A pending label check of a person and a missing layout witness do not refuse: they are handed back in
   * `close` (the marker is written by `transitionRow` together with the status).
   */
  private checkOutputsVerified(tx: StoreTx, m: MissionDbRow, rowId: string, close: RowClose): void {
    const gate = rowCloseGate(tx, m.id, rowId, WORK_REPORT_CONTRACT_KIND, { storeRoot: this.host.storeRoot?.() ?? null })
    if (gate.total > 0) {
      throw err("OUTPUT_UNVERIFIED", `row ${rowId} has deliverables that are not verified`, {
        mission: m.id,
        row: rowId,
        deliverables: gate.deliverables,
        ...(gate.total > gate.deliverables.length ? { more: gate.total - gate.deliverables.length } : {}),
      })
    }
    const checks = gate.awaitingHumanCheck.filter((c): c is RowHumanCheck => (ROW_HUMAN_CHECKS as readonly string[]).includes(c))
    if (checks.length > 0) close.awaitingHumanCheck = { checks, figures: gate.figures, moreFigures: gate.moreFigures }
    if (gate.notes.length > 0) close.closed = gate.notes
  }

  /**
   * 1.3.3 row 66: writes the row's `awaitingHumanCheck` for a row that just went `done` with a person's check open,
   * and returns what the reply carries. An open marker with the same checks is kept as it is (its `since` is the
   * first time the row waited); a cleared one is replaced only because the documents still report the check. Nothing
   * here ever removes a marker or sets `clearedBy`: that is the person's path (row 62).
   */
  private markAwaitingHumanCheck(tx: StoreTx, m: MissionDbRow, rowId: string, close: RowClose): Partial<RowPatchResult> {
    const out: Partial<RowPatchResult> = close.closed ? { closed: close.closed } : {}
    const wait = close.awaitingHumanCheck
    if (!wait) return out
    const cur = contractOf(this.rowDb(tx, m.id, rowId)).awaitingHumanCheck
    const open = cur && cur.clearedBy === undefined && cur.checks.length === wait.checks.length && wait.checks.every((c) => cur.checks.includes(c))
    const since = open ? cur.since : iso(tx.now)!
    if (!open) this.setAwaitingHumanCheck(tx, m.id, rowId, { checks: wait.checks, since })
    const n = wait.figures.length + wait.moreFigures
    out.awaitingHumanCheck = { checks: wait.checks, since, figures: wait.figures, ...(wait.moreFigures > 0 ? { moreFigures: wait.moreFigures } : {}) }
    out.message = `row ${rowId} is done, awaiting human check: a person has not yet checked the figure labels (${wait.checks.join(", ")})${n > 0 ? ` of ${n} figure${n === 1 ? "" : "s"}` : ""}; only the person clears this, in Mission Control`
    return out
  }

  /** §4.2 row status transition, shared by update_row and reports. Returns what a close adds to the patch result. */
  private transitionRow(tx: StoreTx, m: MissionDbRow, rowId: string, to: RowStatus, a: { note?: string; decision?: string; actor: string; cause: string }): Partial<RowPatchResult> {
    const row = this.rowDb(tx, m.id, rowId)
    const from = row.status
    const allowed = ROW_TRANSITIONS[from]
    if (!allowed.includes(to)) throw err("STATUS_TRANSITION", `row ${rowId} ${from} -> ${to} is not allowed`, { row: rowId, from, to, allowed })
    const noteOk = (n: string | undefined) => typeof n === "string" && n.length >= 1 && n.length <= 4000 && !/[\u0000-\u001f]/.test(n)
    if (from === "running" && to === "done" && !noteOk(a.note)) throw err("SCHEMA_INVALID", ROW_RUNNING_DONE_RULE, { row: rowId, field: "note", from, to })
    if ((to === "blocked" || to === "dropped") && !noteOk(a.note)) throw err("SCHEMA_INVALID", `${to} needs a note (the ${to === "blocked" ? "blocker" : "reason"})`, { row: rowId, field: "note" })
    if (a.note !== undefined && !noteOk(a.note)) throw err("SCHEMA_INVALID", "note must be a cell: 1-4000 characters, no control characters", { row: rowId })
    // The done gate (rows 155, 66; seam for rows 70 and 102 in `closeChecks`). Checked before any decision is read.
    const close: RowClose | null = to === "done" ? this.closeChecks(tx, m, rowId) : null
    // Row 70: the review stage needs the project copy too (update_row and a work report's needs-review alike).
    if (to === "needs-review") this.checkDeliverablesInProject(tx, m, rowId, "needs-review")
    let decision: string | null = null
    if (to === "running") {
      if (m.status === "draft") throw err("MISSION_NOT_APPROVED", "rows start only after approval", { mission: m.id, row: rowId })
      if (m.status === "paused") throw err("MISSION_PAUSED", "mission is paused; no row may go running", { mission: m.id, row: rowId })
      if (from === "done") decision = this.requireDecision(tx, m.id, a.decision, "reopening a done row")
      const g = this.graph(tx, m.id)
      const open = openBDeps(rowId, g.rows, g.deps)
      if (open.length > 0) throw err("DEP_NOT_DONE", "B dependencies are not done", { mission: m.id, row: rowId, open })
      const pending = this.requestBlocks(tx, m.id).get(rowId)
      if (pending) throw err("DECISION_PENDING", "an open decision request blocks this row", { mission: m.id, row: rowId, requests: pending })
    }
    if (to === "dropped") {
      if (m.status !== "draft") decision = this.requireDecision(tx, m.id, a.decision, "dropping a row after approval")
      const dependents = tx
        .all<{ row_id: string }>(
          "SELECT d.row_id FROM mission_row_dep d JOIN mission_row r ON r.mission_id = d.mission_id AND r.row_id = d.row_id WHERE d.mission_id = ? AND d.dep_row_id = ? AND d.kind = 'B' AND r.status <> 'dropped'",
          [m.id, rowId],
        )
        .map((r) => r.row_id)
      if (dependents.length > 0) throw err("DEP_DROPPED", "rows still have a B dependency on this row", { mission: m.id, row: rowId, dependents })
    }
    if (decision === null && a.decision !== undefined) decision = this.requireDecision(tx, m.id, a.decision, "row status")
    const started = to === "running" ? (row.time_started ?? tx.now) : row.time_started
    const finished = to === "done" || to === "dropped" ? tx.now : to === "running" ? null : row.time_finished
    tx.run("UPDATE mission_row SET status = ?, note = ?, time_started = ?, time_finished = ?, time_updated = ? WHERE mission_id = ? AND row_id = ?", [
      to,
      a.note ?? row.note,
      started,
      finished,
      tx.now,
      m.id,
      rowId,
    ])
    this.event(tx, { mission: m.id, verb: "row-status", actor: a.actor, row: rowId, from, to, decision, detail: { cause: a.cause, ...(close?.awaitingHumanCheck ? { awaitingHumanCheck: close.awaitingHumanCheck.checks } : {}) } })
    if (to === "running") this.rematchKnowledge(tx, m, rowId, row.title)
    if (to === "running") this.autoRun(tx, m, a.actor, `row ${rowId} running`)
    return close ? this.markAwaitingHumanCheck(tx, m, rowId, close) : {}
  }

  /**
   * 1.3.3 row 101 (KL-2 item 1): at each start the row's title (it may have changed since create) is matched again and
   * `knowledge` is replaced only when the domains or first files differ, keeping the marks of domains that remain.
   * The library never stops a start: no matcher, an unreadable index (`reason`) or a matcher that throws leaves the
   * field as it is (the tool reply says the library is unavailable; a throw is logged here).
   */
  private rematchKnowledge(tx: StoreTx, m: MissionDbRow, rowId: string, title: string): void {
    if (!this.knowledgeMatcher) return
    let match: ReturnType<RowKnowledgeMatcher>
    try {
      match = this.knowledgeMatcher(title)
    } catch (e) {
      this.host.log("warn", "mission.knowledge-match", e, { mission: m.id, row: rowId })
      return
    }
    if (match.reason !== undefined) return
    const cur = contractOf(this.rowDb(tx, m.id, rowId)).knowledge
    const next = mergeRowKnowledge(cur, match.domains)
    if (sameKnowledge(cur, next)) return
    this.setRowKnowledge(tx, m.id, rowId, next)
  }

  // ── locks (§5.4) ──────────────────────────────────────────────────────────

  private acquireLock(tx: StoreTx, m: MissionDbRow, rowId: string, resource: string, actor: string): void {
    if (typeof resource !== "string" || !RESOURCE_RE.test(resource)) throw err("SCHEMA_INVALID", "resource must match ^[a-z0-9][a-z0-9._/-]{0,79}$", { resource })
    this.rowDb(tx, m.id, rowId)
    const held = tx.get<{ mission_id: string; row_id: string; holder: string }>("SELECT mission_id, row_id, holder FROM mission_lock WHERE resource = ? AND time_released IS NULL", [resource])
    if (held) {
      if (held.mission_id === m.id && held.row_id === rowId) return
      throw err("LOCK_HELD", `resource ${resource} is held`, { resource, mission: held.mission_id, row: held.row_id, holder: held.holder })
    }
    tx.run("INSERT INTO mission_lock (resource, mission_id, row_id, holder, time_acquired) VALUES (?, ?, ?, ?, ?)", [resource, m.id, rowId, actor, tx.now])
    this.event(tx, { mission: m.id, verb: "lock", actor, row: rowId, detail: { resource } })
  }

  private releaseLock(tx: StoreTx, m: MissionDbRow, rowId: string, resource: string, actor: string): void {
    const held = tx.get<{ seq: number }>("SELECT seq FROM mission_lock WHERE resource = ? AND mission_id = ? AND row_id = ? AND time_released IS NULL", [resource, m.id, rowId])
    if (!held) throw err("LOCK_NOT_HELD", `row ${rowId} does not hold ${resource}`, { resource, mission: m.id, row: rowId })
    tx.run("UPDATE mission_lock SET time_released = ? WHERE seq = ?", [tx.now, held.seq])
    this.event(tx, { mission: m.id, verb: "unlock", actor, row: rowId, detail: { resource } })
  }

  // ── decisions and findings ────────────────────────────────────────────────

  /** studio_mission_record_decision: append-only (DECISION_ID_TAKEN, DECISION_IMMUTABLE). */
  recordDecision(tx: StoreTx, mission: string, decision: MissionDecision, opts?: MissionWriteOptions): { id: string } {
    const actor = this.actorOf(opts)
    this.openMission(tx, mission)
    this.insertDecision(tx, mission, decision, actor, opts)
    this.afterWrite(tx, mission, opts)
    return { id: decision.id }
  }

  private insertDecision(tx: StoreTx, mission: string, d: MissionDecision, actor: string, opts?: MissionWriteOptions): void {
    assertMissionSchema("Decision", d, `decision ${String(d?.id)}`)
    // 1.2.9 row 50 (AC-C01, S9-06): the one sink of every decision refuses a by: user decision that no attested
    // Mission Control request carries, whoever calls it (create, record, answer); path-free detail.
    if (d.by === "user" && opts?.attested !== true) throw err("SESSION_NOT_ATTESTED", "a by: user decision is stored only from Mission Control in the Swarm app (attested session)", { mission, decision: d.id })
    if (d.autonomous === true && opts?.autonomousMode === false) throw autonomousModeOff(mission, d.id)
    if (this.hasDecision(tx, mission, d.id)) throw err("DECISION_ID_TAKEN", "decision id exists", { mission, decision: d.id })
    for (const s of d.supersedes ?? []) if (!this.hasDecision(tx, mission, s)) throw err("DECISION_UNKNOWN", "superseded decision is not recorded", { mission, decision: d.id, supersedes: s })
    tx.run("INSERT INTO mission_decision (mission_id, decision_id, by, date, text, rows, supersedes, autonomous, time_created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", [
      mission,
      d.id,
      d.by,
      d.date,
      d.text,
      d.rows ? JSON.stringify(d.rows) : null,
      d.supersedes ? JSON.stringify(d.supersedes) : null,
      d.autonomous === true ? 1 : null,
      tx.now,
    ])
    this.event(tx, { mission, verb: "decision", actor, decision: d.id, ...(d.autonomous === true ? { detail: { by: d.by, autonomous: true } } : {}) })
  }

  /** studio_mission_record_finding: upsert by id; a change of status or severity is an event. */
  recordFinding(tx: StoreTx, mission: string, finding: MissionFinding, opts?: MissionWriteOptions): { id: string; status: MissionFinding["status"] } {
    const actor = this.actorOf(opts)
    this.openMission(tx, mission)
    this.upsertFinding(tx, mission, finding, actor)
    this.afterWrite(tx, mission, opts)
    return { id: finding.id, status: finding.status }
  }

  private upsertFinding(tx: StoreTx, mission: string, f: MissionFinding, actor: string): void {
    assertMissionSchema("Finding", f, `finding ${String(f?.id)}`)
    for (const r of [f.sourceRow, f.ownerRow]) if (r !== undefined && !tx.get("SELECT 1 FROM mission_row WHERE mission_id = ? AND row_id = ?", [mission, r])) throw err("ROW_UNKNOWN", "finding names an unknown row", { mission, finding: f.id, row: r })
    if (f.decision !== undefined && !this.hasDecision(tx, mission, f.decision)) throw err("DECISION_UNKNOWN", "finding decision is not recorded", { mission, finding: f.id, decision: f.decision })
    const old = tx.get<{ status: string; severity: string }>("SELECT status, severity FROM mission_finding WHERE mission_id = ? AND finding_id = ?", [mission, f.id])
    if (!old) {
      tx.run(
        "INSERT INTO mission_finding (mission_id, finding_id, severity, title, source_row, owner_row, status, decision_id, evidence, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [mission, f.id, f.severity, f.title, f.sourceRow, f.ownerRow ?? null, f.status, f.decision ?? null, f.evidence ?? null, tx.now, tx.now],
      )
      this.event(tx, { mission, verb: "finding", actor, row: f.sourceRow, to: f.status, decision: f.decision ?? null, detail: { finding: f.id, severity: f.severity } })
      return
    }
    tx.run("UPDATE mission_finding SET severity = ?, title = ?, source_row = ?, owner_row = ?, status = ?, decision_id = ?, evidence = ?, time_updated = ? WHERE mission_id = ? AND finding_id = ?", [
      f.severity,
      f.title,
      f.sourceRow,
      f.ownerRow ?? null,
      f.status,
      f.decision ?? null,
      f.evidence ?? null,
      tx.now,
      mission,
      f.id,
    ])
    if (old.status !== f.status || old.severity !== f.severity) {
      this.event(tx, { mission, verb: "finding", actor, row: f.sourceRow, from: old.status, to: f.status, decision: f.decision ?? null, detail: { finding: f.id, severity: f.severity, previousSeverity: old.severity } })
    }
  }

  // ── sessions (§2.4) ───────────────────────────────────────────────────────

  linkSession(tx: StoreTx, mission: string, link: SessionLink, opts?: MissionWriteOptions): void {
    const actor = this.actorOf(opts)
    this.openMission(tx, mission)
    this.upsertSession(tx, mission, link, actor)
    this.touch(tx, mission)
  }

  private upsertSession(tx: StoreTx, mission: string, link: SessionLink, actor: string): void {
    if (link?.linkedAt !== undefined) throw err("FIELD_READ_ONLY", "linkedAt is host-set", { fields: ["linkedAt"] })
    assertMissionSchema("SessionLink", link, "session")
    const had = tx.get("SELECT 1 FROM mission_session WHERE mission_id = ? AND client = ? AND session_ref = ?", [mission, link.client, link.ref])
    tx.run(
      "INSERT INTO mission_session (mission_id, client, session_ref, role, time_linked) VALUES (?, ?, ?, ?, ?) ON CONFLICT (mission_id, client, session_ref) DO UPDATE SET time_linked = excluded.time_linked, role = coalesce(excluded.role, role)",
      [mission, link.client, link.ref, link.role ?? null, tx.now],
    )
    if (!had) this.event(tx, { mission, verb: "session", actor, detail: { client: link.client, ref: link.ref, role: link.role } })
  }

  // ── reports (§5.1) ────────────────────────────────────────────────────────

  /**
   * Link a Studio work-report document to its mission (same job as the document's first revision).
   * Row report: docKey `row-<row>`; delegation report: docKey `delegation` (DOC_KEY_MISMATCH otherwise).
   * One document per row and per mission's delegation: a second document is DOC_KEY_TAKEN (a redo is a revision).
   */
  linkReport(tx: StoreTx, link: { documentId: string; mission: string; kind: "row" | "delegation"; row?: string; docKey?: string }, opts?: MissionWriteOptions): void {
    const actor = this.actorOf(opts)
    if (!link?.mission) throw err("MISSION_REQUIRED", "a work report needs a mission", { documentId: link?.documentId })
    const m = this.openMission(tx, link.mission)
    if (link.kind === "row") {
      if (!link.row) throw err("DOC_KEY_MISMATCH", "a row report needs a row", { mission: m.id, docKey: link.docKey })
      if (link.docKey !== undefined && link.docKey !== `row-${link.row}`) throw err("DOC_KEY_MISMATCH", "docKey must be row-<row>", { mission: m.id, row: link.row, docKey: link.docKey })
      this.rowDb(tx, m.id, link.row)
    } else if (link.row !== undefined || (link.docKey !== undefined && link.docKey !== "delegation")) {
      throw err("DOC_KEY_MISMATCH", "a delegation report has docKey delegation and no row", { mission: m.id, docKey: link.docKey, row: link.row })
    }
    if (!tx.get("SELECT 1 FROM document WHERE id = ?", [link.documentId])) throw err("NOT_FOUND", "document not found", { documentId: link.documentId })
    const same = tx.get<{ mission_id: string; kind: string; row_id: string | null }>("SELECT mission_id, kind, row_id FROM mission_report WHERE document_id = ?", [link.documentId])
    if (same) {
      if (same.mission_id === m.id && same.kind === link.kind && (same.row_id ?? undefined) === link.row) return
      throw err("DOC_KEY_MISMATCH", "document is already linked elsewhere", { documentId: link.documentId, mission: same.mission_id, row: same.row_id })
    }
    const other =
      link.kind === "row"
        ? tx.get<{ document_id: string }>("SELECT document_id FROM mission_report WHERE mission_id = ? AND kind = 'row' AND row_id = ?", [m.id, link.row!])
        : tx.get<{ document_id: string }>("SELECT document_id FROM mission_report WHERE mission_id = ? AND kind = 'delegation'", [m.id])
    if (other) throw err("DOC_KEY_TAKEN", "this report already has a document; submit a new revision of it", { mission: m.id, row: link.row, documentId: other.document_id })
    tx.run("INSERT INTO mission_report (document_id, mission_id, kind, row_id, time_created) VALUES (?, ?, ?, ?, ?)", [link.documentId, m.id, link.kind, link.row ?? null, tx.now])
    this.event(tx, { mission: m.id, verb: "report", actor, row: link.row, detail: { documentId: link.documentId, kind: link.kind, action: "link" } })
  }

  /**
   * The row effect of a report revision (§5.1 table): draft none; complete/partial/needs-review -> needs-review;
   * blocked -> blocked with note "blocked: report <documentId> rev <n>". A pending row goes running first (B deps
   * checked). The first report on an approved mission moves it to running. Done/dropped rows: ROW_CLOSED.
   */
  applyReport(tx: StoreTx, rep: { documentId: string; revisionNo: number; status: ReportStatus }, opts?: MissionWriteOptions): { mission: string; row?: string; rowStatus?: RowStatus } {
    const actor = this.actorOf(opts)
    const link = tx.get<{ mission_id: string; kind: string; row_id: string | null }>("SELECT mission_id, kind, row_id FROM mission_report WHERE document_id = ?", [rep.documentId])
    if (!link) throw err("REPORT_NOT_IN_MISSION", "document has no mission link", { documentId: rep.documentId })
    const m = this.openMission(tx, link.mission_id)
    if (m.status === "draft") throw err("MISSION_NOT_APPROVED", "reports are accepted after approval", { mission: m.id })
    this.event(tx, { mission: m.id, verb: "report", actor, row: link.row_id ?? undefined, detail: { documentId: rep.documentId, revisionNo: rep.revisionNo, status: rep.status } })
    let rowStatus: RowStatus | undefined
    if (link.kind === "row" && link.row_id) {
      const rowId = link.row_id
      let cur = this.rowDb(tx, m.id, rowId).status
      if (cur === "done" || cur === "dropped") throw err("ROW_CLOSED", `row ${rowId} is ${cur}`, { mission: m.id, row: rowId, status: cur })
      const cause = `report ${rep.documentId} rev ${rep.revisionNo}`
      if (rep.status !== "draft") {
        if (cur === "pending" || (cur === "blocked" && rep.status !== "blocked")) {
          this.transitionRow(tx, m, rowId, "running", { actor, cause })
          cur = "running"
        }
        if (rep.status === "blocked") {
          const note = `blocked: report ${rep.documentId} rev ${rep.revisionNo}`
          if (cur === "blocked") tx.run("UPDATE mission_row SET note = ?, time_updated = ? WHERE mission_id = ? AND row_id = ?", [note, tx.now, m.id, rowId])
          else this.transitionRow(tx, m, rowId, "blocked", { note, actor, cause })
          cur = "blocked"
        } else if (cur === "running") {
          this.transitionRow(tx, m, rowId, "needs-review", { actor, cause })
          cur = "needs-review"
        }
      }
      rowStatus = cur
    }
    this.autoRun(tx, m, actor, `report ${rep.documentId}`)
    this.afterWrite(tx, m.id, opts)
    return { mission: m.id, row: link.row_id ?? undefined, rowStatus }
  }

  /** linkReport + applyReport in one call (what studio_report_submit does in one job, row 119b). */
  recordReport(
    tx: StoreTx,
    rep: { documentId: string; revisionNo: number; mission: string; kind: "row" | "delegation"; row?: string; docKey?: string; status: ReportStatus },
    opts?: MissionWriteOptions,
  ): { mission: string; row?: string; rowStatus?: RowStatus } {
    this.linkReport(tx, rep, opts)
    return this.applyReport(tx, rep, opts)
  }

  /**
   * §5.1 "one guard for every path": a document whose contract kind is agentWorkReport needs a mission.
   * Called by SqliteStudioStore.createDocument when the store was opened with `missionGuard: true`.
   */
  guardCreateDocument(tx: StoreTx, input: NewDocument): { mission: string; kind: "row" | "delegation"; row?: string; docKey: string } | null {
    if (input.contract?.kind !== WORK_REPORT_CONTRACT_KIND) return null
    if (!input.missionFolder) throw err("MISSION_REQUIRED", "a work report needs a mission", { docNumber: input.docNumber })
    this.openMission(tx, input.missionFolder)
    const key = input.missionDocKey ?? ""
    const match = /^row-([1-9][0-9]{0,3}[a-z]?)$/.exec(key)
    if (match) return { mission: input.missionFolder, kind: "row", row: match[1], docKey: key }
    if (key === "delegation") return { mission: input.missionFolder, kind: "delegation", docKey: key }
    throw err("DOC_KEY_MISMATCH", "a work report docKey is row-<row> or delegation", { mission: input.missionFolder, docKey: input.missionDocKey ?? null })
  }

  /** Called by SqliteStudioStore.appendRevision when `missionGuard` is on. */
  guardAppendRevision(tx: StoreTx, documentId: string): void {
    const doc = tx.get<{ contract_kind: string | null }>("SELECT contract_kind FROM document WHERE id = ?", [documentId])
    if (doc?.contract_kind !== WORK_REPORT_CONTRACT_KIND) return
    const link = tx.get<{ mission_id: string }>("SELECT mission_id FROM mission_report WHERE document_id = ?", [documentId])
    if (!link) throw err("REPORT_NOT_IN_MISSION", "work report has no mission link", { documentId })
    this.openMission(tx, link.mission_id)
  }

  // ── C57 (a) decision requests ─────────────────────────────────────────────

  requestDecision(tx: StoreTx, mission: string, req: NewDecisionRequest, opts?: MissionWriteOptions): DecisionRequest {
    const actor = this.actorOf(opts)
    assertDecisionRequest(req)
    const m = this.openMission(tx, mission)
    for (const r of req.blockingRows ?? []) this.rowDb(tx, mission, r)
    if (tx.get("SELECT 1 FROM mission_decision_request WHERE mission_id = ? AND request_id = ?", [mission, req.id])) throw err("DECISION_REQUEST_ID_TAKEN", "decision request id exists", { mission, request: req.id })
    // Row 70 (MC-8 item 3): a request that names a document of this mission (document=<id> in its context, e.g. row
    // 62's labels-check line) is a review of that document: its current revision must be in the project folder.
    if (this.host.outputGate?.() === true) {
      const docs = namedDocuments(tx, m.id, requestDocumentIds(req.context), WORK_REPORT_CONTRACT_KIND)
      if (docs.length > 0) this.refuseNotInProject(tx, m, docs, missionDeliverables(tx, m.id), `decision request ${req.id} cannot be opened`, { request: req.id })
    }
    tx.run(
      "INSERT INTO mission_decision_request (mission_id, request_id, question, context, options, recommended, blocking_rows, status, requested_by, time_created, topic, proposal) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)",
      [mission, req.id, req.question, req.context ?? null, JSON.stringify(req.options), req.recommended ?? null, JSON.stringify(req.blockingRows ?? []), actor, tx.now, req.topic ?? null, req.proposal ? JSON.stringify(req.proposal) : null],
    )
    this.event(tx, { mission, verb: "decision", actor, detail: { request: req.id, action: "request", blockingRows: req.blockingRows ?? [] } })
    this.afterWrite(tx, mission, opts)
    return this.getDecisionRequest(mission, req.id, tx)!
  }

  /** Answer once: records the decision (U for the user, C for the controller) and releases the blocked rows. */
  answerDecision(tx: StoreTx, mission: string, requestId: string, answer: DecisionAnswer, opts?: MissionWriteOptions): { request: DecisionRequest; decision: MissionDecision; released: string[] } {
    const actor = this.actorOf(opts)
    assertDecisionAnswer(answer)
    this.openMission(tx, mission)
    const req = this.getDecisionRequest(mission, requestId, tx)
    if (!req) throw err("DECISION_REQUEST_UNKNOWN", "unknown decision request", { mission, request: requestId })
    if (req.status !== "open") throw err("DECISION_REQUEST_CLOSED", `decision request is ${req.status}`, { mission, request: requestId, status: req.status })
    const option = req.options.find((o) => o.id === answer.option)
    if (!option) throw err("OPTION_UNKNOWN", "answer names an option that is not offered", { mission, request: requestId, option: answer.option, options: req.options.map((o) => o.id) })
    const decision: MissionDecision = {
      id: answer.decisionId,
      by: answer.by,
      date: answer.date ?? new Date(tx.now).toISOString().slice(0, 10),
      text: answer.text ?? `${req.question} -> ${option.label} (${req.id})`.slice(0, 8000),
      ...(req.blockingRows && req.blockingRows.length > 0 ? { rows: req.blockingRows } : {}),
    }
    // 1.2.8 row 45b (SR8-05, N8-461): the host passes the answering session's agent id and attestation; trusted store
    // code without a session leaves both NULL (no label). An attestation without a session is not recorded.
    const via = typeof answer.via === "string" && VIA_RE.test(answer.via) ? answer.via : null
    const attested = via === null ? null : answer.attested === true ? 1 : 0
    // 1.2.9 row 50 (S9-06): the sink sees the request's attestation (opts.attested), not the answer's arguments.
    this.insertDecision(tx, mission, decision, actor, { attested: opts?.attested === true })
    tx.run("UPDATE mission_decision_request SET status = 'answered', answer_option = ?, answered_by = ?, answer_decision_id = ?, time_closed = ?, answered_via = ?, answered_attested = ? WHERE mission_id = ? AND request_id = ?", [
      option.id,
      answer.by,
      decision.id,
      tx.now,
      via,
      attested,
      mission,
      requestId,
    ])
    this.event(tx, { mission, verb: "decision", actor, decision: decision.id, detail: { request: requestId, action: "answer", option: option.id, ...(via !== null ? { via, attested: attested === 1 } : {}) } })
    this.afterWrite(tx, mission, opts)
    const g = this.graph(tx, mission)
    const ready = new Set(readyRows(g.rows, g.deps, new Set(this.requestBlocks(tx, mission).keys())))
    return { request: this.getDecisionRequest(mission, requestId, tx)!, decision, released: (req.blockingRows ?? []).filter((r) => ready.has(r)) }
  }

  withdrawDecision(tx: StoreTx, mission: string, requestId: string, opts?: MissionWriteOptions): DecisionRequest {
    const actor = this.actorOf(opts)
    this.openMission(tx, mission)
    const req = this.getDecisionRequest(mission, requestId, tx)
    if (!req) throw err("DECISION_REQUEST_UNKNOWN", "unknown decision request", { mission, request: requestId })
    if (req.status !== "open") throw err("DECISION_REQUEST_CLOSED", `decision request is ${req.status}`, { mission, request: requestId, status: req.status })
    tx.run("UPDATE mission_decision_request SET status = 'withdrawn', time_closed = ? WHERE mission_id = ? AND request_id = ?", [tx.now, mission, requestId])
    this.event(tx, { mission, verb: "decision", actor, detail: { request: requestId, action: "withdraw" } })
    this.afterWrite(tx, mission, opts)
    return this.getDecisionRequest(mission, requestId, tx)!
  }

  /**
   * 1.2.8 row 45 (PROJ-b, N8-142): re-point a mission's project dir to a group folder one level below its current dir,
   * only on an ANSWERED placement request of this mission (join/new; the option's group names the folder) or an
   * answered tidy request (approve) of `approvalRef.tidyMission` whose proposal puts this mission in that group, and
   * whose holder lives in the same parent folder. Anything else is PLACE_DECISION_UNANSWERED (N8-145). The disk fact
   * (`<dir>/.swarm/group.json`) is the host's check (studio_mission_place). A closed mission may be placed (tidy lists
   * existing missions). Setting the same dir again returns unchanged: true. OP20-7: no trigger guards project_dir; the
   * 0003 CHECK (absolute) holds.
   */
  setProjectDir(tx: StoreTx, mission: string, dir: string, approvalRef: { request: string; tidyMission?: string }, opts?: MissionWriteOptions): { id: string; from: string; to: string; unchanged: boolean } {
    const actor = this.actorOf(opts)
    const m = this.missionRow(tx, mission)
    const holder = approvalRef.tidyMission ?? mission
    const refuse = (reason: string): never => {
      throw err("PLACE_DECISION_UNANSWERED", `no answered placement decision moves this mission to ${dir}: ${reason}`, { mission, projectDir: dir, request: approvalRef.request, ...(approvalRef.tidyMission ? { tidyMission: approvalRef.tidyMission } : {}), reason })
    }
    const parent = m.project_dir === dir ? posix.dirname(dir) : m.project_dir
    if (!posix.isAbsolute(dir) || posix.normalize(dir) !== dir || dir.endsWith("/") || posix.dirname(dir) !== parent) refuse("projectDir must be a folder directly inside the mission's project dir")
    const group = posix.basename(dir)
    if (!groupNameOk(group)) refuse("the folder name is not a group name")
    const req = this.getDecisionRequest(holder, approvalRef.request, tx)
    if (!req || req.status !== "answered" || !req.answer) refuse(`request ${approvalRef.request} of ${holder} is ${req?.status ?? "unknown"}`)
    const answer = req!.answer!
    if (approvalRef.tidyMission) {
      const item = req!.topic === "project-tidy" && answer.option === "approve" ? req!.proposal?.find((x) => x.mission === mission) : undefined
      if (!item || item.group !== group) refuse("the approved tidy proposal does not put this mission in that group")
      if (this.missionRow(tx, holder).project_dir !== parent) refuse("the tidy mission lives in another folder")
    } else {
      const option = req!.topic === "project-placement" && (answer.option === "join" || answer.option === "new") ? req!.options.find((o) => o.id === answer.option) : undefined
      if (!option || option.group !== group) refuse("the answer does not name that group")
    }
    if (m.project_dir === dir) return { id: mission, from: dir, to: dir, unchanged: true }
    tx.run("UPDATE mission SET project_dir = ? WHERE id = ?", [dir, mission])
    this.event(tx, { mission, verb: "decision", actor, decision: answer.decision, detail: { action: "place", request: approvalRef.request, ...(approvalRef.tidyMission ? { tidyMission: approvalRef.tidyMission } : {}), from: m.project_dir, to: dir } })
    this.afterWrite(tx, mission, opts)
    return { id: mission, from: m.project_dir, to: dir, unchanged: false }
  }

  getDecisionRequest(mission: string, requestId: string, tx?: MissionReader): DecisionRequest | null {
    const r = this.r(tx).get<Row>("SELECT * FROM mission_decision_request WHERE mission_id = ? AND request_id = ?", [mission, requestId])
    return r ? decisionRequestOf(r) : null
  }

  listDecisionRequests(mission: string, f: { status?: DecisionRequest["status"] } = {}, tx?: MissionReader): DecisionRequest[] {
    this.missionRow(this.r(tx), mission)
    return this.r(tx)
      .all<Row>("SELECT * FROM mission_decision_request WHERE mission_id = ? AND (? IS NULL OR status = ?) ORDER BY time_created, request_id", [mission, f.status ?? null, f.status ?? null])
      .map(decisionRequestOf)
  }

  // ── C57 (b) row checkpoints ───────────────────────────────────────────────

  recordCheckpoint(tx: StoreTx, mission: string, rowId: string, cp: { n: number; m: number; label?: string }, opts?: MissionWriteOptions): RowCheckpoint {
    const actor = this.actorOf(opts)
    assertCheckpoint(cp?.n, cp?.m, cp?.label)
    this.openMission(tx, mission)
    const row = this.rowDb(tx, mission, rowId)
    if (row.status === "done" || row.status === "dropped") throw err("ROW_CLOSED", `row ${rowId} is ${row.status}`, { mission, row: rowId, status: row.status })
    tx.run("INSERT INTO mission_row_checkpoint (mission_id, row_id, n, m, label, actor, time_created) VALUES (?, ?, ?, ?, ?, ?, ?)", [mission, rowId, cp.n, cp.m, cp.label ?? null, actor, tx.now])
    this.afterWrite(tx, mission, opts)
    return { n: cp.n, m: cp.m, ...(cp.label ? { label: cp.label } : {}), actor, at: iso(tx.now)! }
  }

  listCheckpoints(mission: string, rowId?: string, tx?: MissionReader): Array<RowCheckpoint & { row: string; seq: number }> {
    this.missionRow(this.r(tx), mission)
    return this.r(tx)
      .all<{ seq: number; row_id: string; n: number; m: number; label: string | null; actor: string; time_created: number }>(
        "SELECT seq, row_id, n, m, label, actor, time_created FROM mission_row_checkpoint WHERE mission_id = ? AND (? IS NULL OR row_id = ?) ORDER BY seq",
        [mission, rowId ?? null, rowId ?? null],
      )
      .map((c) => ({ seq: Number(c.seq), row: c.row_id, n: Number(c.n), m: Number(c.m), ...(c.label ? { label: c.label } : {}), actor: c.actor, at: iso(c.time_created)! }))
  }

  // ── C57 (c) message log, (d) owner instruction channel ────────────────────

  postMessage(tx: StoreTx, mission: string, msg: NewMissionMessage, opts?: MissionWriteOptions): MissionMessage {
    this.actorOf(opts)
    assertMessage(msg)
    this.openMission(tx, mission)
    if (msg.row !== undefined) this.rowDb(tx, mission, msg.row)
    const r = tx.run("INSERT INTO mission_message (mission_id, row_id, from_party, to_party, actor, kind, text, time_created) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [
      mission,
      msg.row ?? null,
      msg.from,
      msg.to,
      msg.actor ?? null,
      msg.kind,
      msg.text,
      tx.now,
    ])
    this.afterWrite(tx, mission, opts)
    return { ...msg, seq: Number(r.lastInsertRowid), at: iso(tx.now)! }
  }

  /** The owner's instruction to the controller: stored as an instruction message, never executed by the store. */
  ownerInstruction(tx: StoreTx, mission: string, text: string, args: { row?: string } = {}, opts?: MissionWriteOptions): MissionMessage {
    return this.postMessage(tx, mission, { from: "owner", to: "controller", kind: "instruction", text, ...(args.row ? { row: args.row } : {}) }, opts)
  }

  listMessages(
    mission: string,
    f: { afterSeq?: number; kind?: MissionMessage["kind"]; from?: MissionMessage["from"]; to?: MissionMessage["to"]; row?: string; take?: number } = {},
    tx?: MissionReader,
  ): MissionMessage[] {
    this.missionRow(this.r(tx), mission)
    const take = Math.min(Math.max(1, f.take ?? 200), 1000)
    return this.r(tx)
      .all<{ seq: number; row_id: string | null; from_party: string; to_party: string; actor: string | null; kind: string; text: string; time_created: number }>(
        `SELECT seq, row_id, from_party, to_party, actor, kind, text, time_created FROM mission_message
          WHERE mission_id = ?1 AND seq > ?2 AND (?3 IS NULL OR kind = ?3) AND (?4 IS NULL OR from_party = ?4) AND (?5 IS NULL OR to_party = ?5) AND (?6 IS NULL OR row_id = ?6)
          ORDER BY seq LIMIT ?7`,
        [mission, f.afterSeq ?? 0, f.kind ?? null, f.from ?? null, f.to ?? null, f.row ?? null, take],
      )
      .map((x) => ({
        seq: Number(x.seq),
        from: x.from_party as MissionMessage["from"],
        to: x.to_party as MissionMessage["to"],
        kind: x.kind as MissionMessage["kind"],
        text: x.text,
        ...(x.row_id ? { row: x.row_id } : {}),
        ...(x.actor ? { actor: x.actor } : {}),
        at: iso(x.time_created)!,
      }))
  }

  // ── events and snapshots (§5.5) ───────────────────────────────────────────

  listEvents(mission: string, f: { afterSeq?: number; take?: number } = {}, tx?: MissionReader): MissionEventRecord[] {
    this.missionRow(this.r(tx), mission)
    return this.r(tx)
      .all<Row>("SELECT * FROM mission_event WHERE mission_id = ? AND seq > ? ORDER BY seq LIMIT ?", [mission, f.afterSeq ?? 0, Math.min(Math.max(1, f.take ?? 500), 5000)])
      .map((e) => ({
        seq: Number(e.seq),
        ...(e.row_id ? { row: e.row_id as string } : {}),
        actor: e.actor as string,
        verb: e.verb as string,
        ...(e.from_status ? { from: e.from_status as string } : {}),
        ...(e.to_status ? { to: e.to_status as string } : {}),
        ...(e.decision_id ? { decision: e.decision_id as string } : {}),
        ...(e.detail ? { detail: JSON.parse(e.detail as string) } : {}),
        at: iso(e.time_created as number)!,
      }))
  }

  /** The current `studio.mission-status/v1` body (validated against the schema). */
  statusOf(mission: string, reason?: MissionStatusSnapshot["reason"], tx?: MissionReader, takenAt?: number): MissionStatusSnapshot {
    const q = this.r(tx)
    const m = this.missionRow(q, mission)
    const g = this.graph(q, mission)
    const body: MissionStatusSnapshot = {
      $schema: "studio.mission-status/v1",
      mission,
      takenAt: iso(takenAt ?? Date.now())!,
      ...(reason ? { reason } : {}),
      missionStatus: m.status,
      counts: countStatuses(g.rows),
      waves: computeWaves(g.rows, g.deps),
      ready: readyRows(g.rows, g.deps, new Set(this.requestBlocks(q, mission).keys())),
      locks: this.locksOf(q, mission, true),
    }
    assertMissionSchema("StatusSnapshot", body, "status snapshot")
    return body
  }

  /** A snapshot on demand (reason `manual` or `export`, row 120). */
  snapshot(tx: StoreTx, mission: string, reason: "manual" | "export" = "manual"): string {
    this.missionRow(tx, mission)
    return this.writeSnapshot(tx, mission, reason)
  }

  private writeSnapshot(tx: StoreTx, mission: string, reason: NonNullable<MissionStatusSnapshot["reason"]>): string {
    const id = newId()
    const body = this.statusOf(mission, reason, tx, tx.now)
    tx.run("INSERT INTO mission_snapshot (id, mission_id, reason, body, time_created) VALUES (?, ?, ?, ?, ?)", [id, mission, reason, JSON.stringify(body), tx.now])
    return id
  }

  listSnapshots(mission: string, tx?: MissionReader): Array<{ id: string; reason: string; body: MissionStatusSnapshot; at: string }> {
    this.missionRow(this.r(tx), mission)
    return this.r(tx)
      .all<{ id: string; reason: string; body: string; time_created: number }>("SELECT id, reason, body, time_created FROM mission_snapshot WHERE mission_id = ? ORDER BY time_created, rowid", [mission])
      .map((s) => ({ id: s.id, reason: s.reason, body: JSON.parse(s.body) as MissionStatusSnapshot, at: iso(s.time_created)! }))
  }

  // ── reads: get, list, search ──────────────────────────────────────────────

  private locksOf(q: MissionReader, mission: string, heldOnly: boolean): MissionLockRecord[] {
    return q
      .all<{ resource: string; row_id: string; holder: string; time_acquired: number; time_released: number | null }>(
        `SELECT resource, row_id, holder, time_acquired, time_released FROM mission_lock WHERE mission_id = ? ${heldOnly ? "AND time_released IS NULL" : ""} ORDER BY seq`,
        [mission],
      )
      .map((l) => ({ resource: l.resource, row: l.row_id, holder: l.holder, acquiredAt: iso(l.time_acquired)!, ...(l.time_released !== null ? { releasedAt: iso(l.time_released)! } : {}) }))
  }

  private readRow(q: MissionReader, mission: string, r: RowDbRow, deps?: DepEdge[], reports?: ReportRef[]): MissionRow {
    const ds = deps ?? this.graph(q, mission).deps
    const paths = parseJson<NonNullable<MissionRow["ownership"]>["paths"]>(r.ownership_paths)
    return {
      id: r.row_id,
      phase: r.phase_id,
      kind: r.kind as MissionRow["kind"],
      title: r.title,
      agent: r.agent,
      model: { tier: r.model_tier as MissionRow["model"]["tier"], ...(r.model_reason ? { reason: r.model_reason } : {}) },
      ...(r.ownership_text !== null ? { ownership: { text: r.ownership_text, ...(paths ? { paths } : {}) } } : {}),
      deps: ds.filter((d) => d.row === r.row_id).map((d) => `${d.dep}:${d.kind}`),
      size: (r.size as MissionRow["size"]) ?? null,
      status: r.status,
      output: r.output,
      verification: r.verification,
      resources: JSON.parse(r.resources) as string[],
      ...(r.checks !== null ? { checks: r.checks } : {}),
      review: r.review as "gate" | "none",
      ...(r.note !== null ? { note: r.note } : {}),
      ...(r.decision_id !== null ? { decision: r.decision_id } : {}),
      createdAt: iso(r.time_created)!,
      updatedAt: iso(r.time_updated)!,
      ...(r.time_started !== null ? { startedAt: iso(r.time_started)! } : {}),
      ...(r.time_finished !== null ? { finishedAt: iso(r.time_finished)! } : {}),
      ...(reports && reports.length > 0 ? { reports } : {}),
      ...contractOf(r),
    }
  }

  /**
   * 1.2.6 row 87 (MC-09, N-066): rows added (`row-add`) and dropped (`row-status` to dropped) after the approve event,
   * each with the decision id its event carries. Ordered by event seq, not time, so a change in the approving
   * millisecond is still placed correctly; a draft mission (no approve event) has an empty drift.
   * 1.2.10 row 49 (P3, N10-053): `changed` lists the `row-change` events after approval that changed a DRIFT_FIELDS
   * value: a 1.2.10 event by its recorded `changes` (no entry when empty), an older event by name only
   * (`DRIFT_FIELDS ∩ detail.fields`, no `changes` key).
   */
  private driftOf(q: MissionReader, mission: string): MissionDrift {
    const drift: MissionDrift = { count: 0, rows: [], dropped: [], changed: [] }
    const approved = q.get<{ s: number | null }>("SELECT min(seq) AS s FROM mission_event WHERE mission_id = ? AND verb = 'approve'", [mission])?.s
    if (approved === null || approved === undefined) return drift
    const events = q.all<{ row_id: string; verb: string; decision_id: string | null; detail: string | null; time_created: number }>(
      `SELECT row_id, verb, decision_id, detail, time_created FROM mission_event
        WHERE mission_id = ? AND seq > ? AND row_id IS NOT NULL AND (verb = 'row-add' OR verb = 'row-change' OR (verb = 'row-status' AND to_status = 'dropped'))
        ORDER BY seq`,
      [mission, approved],
    )
    for (const e of events) {
      if (e.verb === "row-add") drift.rows.push({ row: e.row_id, timeCreated: iso(e.time_created)!, decision: e.decision_id ?? null })
      else if (e.verb === "row-status") drift.dropped.push({ row: e.row_id, timeDropped: iso(e.time_created)!, decision: e.decision_id ?? null })
      else {
        const detail = (e.detail ? JSON.parse(e.detail) : {}) as { fields?: unknown; changes?: unknown }
        const entry: MissionDriftChange = { row: e.row_id, timeChanged: iso(e.time_created)!, decision: e.decision_id ?? null, fields: [] }
        if (Array.isArray(detail.changes)) {
          if (detail.changes.length === 0) continue
          entry.changes = detail.changes as RowFieldChange[]
          entry.fields = entry.changes.map((c) => c.field)
        } else {
          const names = Array.isArray(detail.fields) ? (detail.fields as unknown[]) : []
          entry.fields = DRIFT_FIELDS.filter((f) => names.includes(f))
          if (entry.fields.length === 0) continue
        }
        drift.changed.push(entry)
      }
    }
    drift.count = drift.rows.length
    return drift
  }

  /** studio_mission_get (§8.3): the stored MissionDoc plus derived phases (the type's only), waves, ready, counts. */
  get(mission: string, tx?: MissionReader): { mission: MissionDoc; derived: MissionDerived } | null {
    const q = this.r(tx)
    const m = q.get<MissionDbRow>("SELECT * FROM mission WHERE id = ?", [mission])
    if (!m) return null
    const g = this.graph(q, mission)
    const reportRows = q.all<{ document_id: string; kind: "row" | "delegation"; row_id: string | null; current_revision_no: number; contract_status: string | null }>(
      "SELECT r.document_id, r.kind, r.row_id, d.current_revision_no, d.contract_status FROM mission_report r JOIN document d ON d.id = r.document_id WHERE r.mission_id = ?",
      [mission],
    )
    const reportsByRow = new Map<string, ReportRef[]>()
    for (const r of reportRows) {
      if (!r.row_id) continue
      const ref: ReportRef = { documentId: r.document_id, revisionNo: Number(r.current_revision_no), kind: r.kind, ...(isReportStatus(r.contract_status) ? { status: r.contract_status } : {}) }
      reportsByRow.set(r.row_id, [...(reportsByRow.get(r.row_id) ?? []), ref])
    }
    const rows = q.all<RowDbRow>("SELECT * FROM mission_row WHERE mission_id = ? ORDER BY ord", [mission]).map((r) => this.readRow(q, mission, r, g.deps, reportsByRow.get(r.row_id)))
    const decisions = q.all<Row>(`SELECT d.* FROM mission_decision d WHERE d.mission_id = ?
        ORDER BY (SELECT min(e.seq) FROM mission_event e WHERE e.mission_id = d.mission_id AND e.verb = 'decision' AND e.decision_id = d.decision_id), d.decision_id`, [mission]).map(decisionOf)
    const findings = q.all<Row>("SELECT * FROM mission_finding WHERE mission_id = ? ORDER BY time_created, finding_id", [mission]).map(findingOf)
    const sessions = q
      .all<{ client: SessionLink["client"]; session_ref: string; role: SessionLink["role"] | null; time_linked: number }>("SELECT client, session_ref, role, time_linked FROM mission_session WHERE mission_id = ? ORDER BY time_linked, session_ref", [mission])
      .map((s) => ({ client: s.client, ref: s.session_ref, ...(s.role ? { role: s.role } : {}), linkedAt: iso(s.time_linked)! }))
    const locks = this.locksOf(q, mission, false)
    const doc: MissionDoc = {
      $schema: "studio.mission/v1",
      id: m.id,
      title: m.title,
      type: m.type_id,
      typeVersion: Number(m.type_version),
      status: m.status,
      ...(m.superseded_by ? { supersededBy: m.superseded_by } : {}),
      owner: m.owner,
      project: { dir: m.project_dir, ...(m.swarm_project_id ? { swarmProjectId: m.swarm_project_id } : {}) },
      createdAt: iso(m.time_created)!,
      updatedAt: iso(m.time_updated)!,
      ...(m.time_approved !== null ? { approvedAt: iso(m.time_approved)! } : {}),
      ...(m.approval_decision_id ? { approvalDecision: m.approval_decision_id } : {}),
      ...(m.time_closed !== null ? { closedAt: iso(m.time_closed)! } : {}),
      sessions,
      rows,
      decisions,
      findings,
      locks,
    }
    const type = this.getType(m.type_id, Number(m.type_version), q)!
    const blocks = this.requestBlocks(q, mission)
    const checkpoints: Record<string, RowCheckpoint> = {}
    for (const c of this.listCheckpoints(mission, undefined, q)) checkpoints[c.row] = { n: c.n, m: c.m, ...(c.label ? { label: c.label } : {}), actor: c.actor, at: c.at }
    const counts = countStatuses(g.rows)
    const derived: MissionDerived = {
      phases: [...type.phases]
        .sort((a, b) => a.order - b.order)
        .map((p) => {
          const inPhase = g.rows.filter((r) => r.phase === p.id)
          return { id: p.id, name: p.name, order: p.order, rows: inPhase.map((r) => r.id), counts: countStatuses(inPhase) }
        }),
      waves: computeWaves(g.rows, g.deps),
      ready: readyRows(g.rows, g.deps, new Set(blocks.keys())),
      counts,
      progress: { done: counts.done, total: g.rows.length - counts.dropped },
      checkpoints,
      drift: this.driftOf(q, mission),
    }
    // Row 188 (L47): who approved; an autonomous controller approval is labelled so Mission Control shows it apart.
    // Row 197 (S194-02): the label says what the record says. The store cannot tell Mission Control from an agent that
    // records by: user, so it never claims "by user" as a fact, only that the decision is recorded by: user.
    const approvedBy = m.approval_decision_id ? decisions.find((d) => d.id === m.approval_decision_id) : undefined
    if (approvedBy) {
      const autonomous = approvedBy.by === "controller" && approvedBy.autonomous === true
      derived.approval = { decision: approvedBy.id, by: approvedBy.by, autonomous, label: autonomous ? "self-approved (autonomous)" : "approved (decision by: user)" }
    }
    return { mission: doc, derived }
  }

  /** studio_mission_list (§8.3): the session overview; keyset cursor over (time_updated DESC, id DESC). */
  list(f: MissionListFilter = {}, tx?: MissionReader): { items: MissionListItem[]; nextCursor: string | null } {
    const q = this.r(tx)
    const take = Math.min(Math.max(1, f.take ?? MISSION_LIST_LIMITS.takeDefault), MISSION_LIST_LIMITS.takeMax)
    let match: string | null = null
    if (f.q !== undefined) {
      match = translateFtsQuery(f.q)
      if (match === null) return { items: [], nextCursor: null }
    }
    const cur = f.cursor ? decodeMissionCursor(f.cursor) : null
    if (f.cursor && !cur) throw err("SCHEMA_INVALID", "cursor is malformed", { cursor: f.cursor })
    const scope = f.projectDir !== undefined ? projectDirScope(f.projectDir) : null
    // Row 183 (L36): linkedSessions widens the projectDir rule to a UNION with the missions linked to those sessions
    // (the current session and its subagents). An empty refs list is no filter.
    const linked = f.linkedSessions && f.linkedSessions.refs.length > 0 ? f.linkedSessions : null
    const rows = q.all<MissionDbRow>(
      `SELECT m.* FROM mission m
        WHERE (?1 IS NULL OR EXISTS (SELECT 1 FROM mission_session s WHERE s.mission_id = m.id AND s.client = ?1 AND s.session_ref = ?2))
          AND (?3 IS NULL OR m.status IN (SELECT value FROM json_each(?3)))
          AND (?4 IS NULL OR m.type_id = ?4)
          AND ((?5 IS NULL AND ?12 IS NULL)
               OR (?5 IS NOT NULL AND (m.project_dir = ?5 OR m.project_dir = ?10
                   OR (?11 IS NOT NULL AND substr(m.project_dir, 1, length(?11)) = ?11 AND instr(m.project_dir || '/', '/../') = 0 AND instr(m.project_dir || '/', '/./') = 0)))
               OR (?12 IS NOT NULL AND EXISTS (SELECT 1 FROM mission_session l WHERE l.mission_id = m.id AND l.client = ?12 AND l.session_ref IN (SELECT value FROM json_each(?13)))))
          AND (?6 IS NULL OR m.id IN (SELECT mission_id FROM mission_fts WHERE mission_fts MATCH ?6))
          AND (?7 IS NULL OR m.time_updated < ?7 OR (m.time_updated = ?7 AND m.id < ?8))
        ORDER BY m.time_updated DESC, m.id DESC LIMIT ?9`,
      [f.session?.client ?? null, f.session?.ref ?? null, f.status ? JSON.stringify(f.status) : null, f.type ?? null, f.projectDir ?? null, match, cur?.t ?? null, cur?.id ?? null, take + 1, scope?.exact ?? null, scope?.prefix ?? null, linked?.client ?? null, linked ? JSON.stringify(linked.refs) : null],
    )
    const page = rows.slice(0, take)
    const items = page.map((m) => this.listItem(q, m, match))
    const last = page[page.length - 1]
    return { items, nextCursor: rows.length > take && last ? encodeMissionCursor({ t: Number(last.time_updated), id: last.id }) : null }
  }

  private listItem(q: MissionReader, m: MissionDbRow, match: string | null): MissionListItem {
    const g = this.graph(q, m.id)
    const type = this.getType(m.type_id, Number(m.type_version), q)!
    const counts = countStatuses(g.rows)
    const openFindings: Partial<Record<FindingSeverity, number>> = {}
    for (const x of q.all<{ severity: FindingSeverity; n: number }>("SELECT severity, count(*) AS n FROM mission_finding WHERE mission_id = ? AND status = 'open' GROUP BY severity", [m.id])) openFindings[x.severity] = Number(x.n)
    const snippet = match
      ? q.get<{ s: string }>("SELECT snippet(mission_fts, 0, '[[', ']]', '…', 8) AS s FROM mission_fts WHERE mission_fts MATCH ? AND mission_id = ? ORDER BY rank LIMIT 1", [match, m.id])?.s
      : undefined
    return {
      id: m.id,
      title: m.title,
      type: m.type_id,
      typeVersion: Number(m.type_version),
      status: m.status,
      ...(m.superseded_by ? { supersededBy: m.superseded_by } : {}),
      counts,
      progress: { done: counts.done, total: g.rows.length - counts.dropped },
      phases: [...type.phases].sort((a, b) => a.order - b.order).map((p) => ({ id: p.id, name: p.name, counts: countStatuses(g.rows.filter((r) => r.phase === p.id)) })),
      running: g.rows.filter((r) => r.status === "running").map((r) => r.id),
      blocked: g.rows.filter((r) => r.status === "blocked").map((r) => r.id),
      needsReview: g.rows.filter((r) => r.status === "needs-review").map((r) => r.id),
      openFindings,
      openRequests: q.all<{ request_id: string }>("SELECT request_id FROM mission_decision_request WHERE mission_id = ? AND status = 'open' ORDER BY time_created, request_id", [m.id]).map((r) => r.request_id),
      heldLocks: this.locksOf(q, m.id, true).map((l) => l.resource),
      updatedAt: iso(m.time_updated)!,
      ...(snippet !== undefined ? { snippet } : {}),
    }
  }

  /** mission_fts search (§7.3): row titles/notes, decisions, findings, plus C57 requests and messages. */
  search(qText: string, f: { mission?: string; take?: number } = {}, tx?: MissionReader): MissionSearchHit[] {
    const match = translateFtsQuery(qText)
    if (match === null) return []
    const take = Math.min(Math.max(1, f.take ?? 20), 100)
    return this.r(tx)
      .all<{ mission_id: string; ref_kind: MissionSearchHit["refKind"]; ref_id: string; s: string }>(
        "SELECT mission_id, ref_kind, ref_id, snippet(mission_fts, 0, '[[', ']]', '…', 8) AS s FROM mission_fts WHERE mission_fts MATCH ? AND (? IS NULL OR mission_id = ?) ORDER BY rank LIMIT ?",
        [match, f.mission ?? null, f.mission ?? null, take],
      )
      .map((h) => ({ mission: h.mission_id, refKind: h.ref_kind, refId: h.ref_id, snippet: h.s }))
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

function stripHost(r: MissionRow): MissionRowInput {
  const { createdAt: _c, updatedAt: _u, startedAt: _s, finishedAt: _f, reports: _r, deliverables: _d, knowledge: _k, awaitingHumanCheck: _a, ...rest } = r
  return rest
}

/** 1.3.3 row 5: the three contract fields of a stored row; `deliverables` is always a list, the other two only when set. */
function contractOf(r: Pick<RowDbRow, "deliverables" | "knowledge" | "awaiting_human_check">): MissionRowContract {
  const knowledge = parseJson<RowKnowledge>(r.knowledge)
  const awaitingHumanCheck = parseJson<RowAwaitingHumanCheck>(r.awaiting_human_check)
  return { deliverables: parseJson<RowDeliverable[]>(r.deliverables) ?? [], ...(knowledge ? { knowledge } : {}), ...(awaitingHumanCheck ? { awaitingHumanCheck } : {}) }
}

function isReportStatus(s: unknown): s is ReportStatus {
  return s === "draft" || s === "complete" || s === "partial" || s === "blocked" || s === "needs-review"
}

function decisionOf(d: Row): MissionDecision {
  const rows = parseJson<string[]>(d.rows)
  const supersedes = parseJson<string[]>(d.supersedes)
  return {
    id: d.decision_id as string,
    by: d.by as MissionDecision["by"],
    date: d.date as string,
    text: d.text as string,
    ...(rows ? { rows } : {}),
    ...(supersedes ? { supersedes } : {}),
    ...(Number(d.autonomous) === 1 ? { autonomous: true as const } : {}),
  }
}

function findingOf(f: Row): MissionFinding {
  return {
    id: f.finding_id as string,
    severity: f.severity as MissionFinding["severity"],
    title: f.title as string,
    sourceRow: f.source_row as string,
    ...(f.owner_row ? { ownerRow: f.owner_row as string } : {}),
    status: f.status as MissionFinding["status"],
    ...(f.decision_id ? { decision: f.decision_id as string } : {}),
    ...(f.evidence ? { evidence: f.evidence as string } : {}),
  }
}

/** 1.2.8 row 45b: an answering session's agent id (= the host's X-Studio-Agent rule, http-server.ts AGENT_RE). */
const VIA_RE = /^[A-Za-z0-9_.-]{1,40}$/

function decisionRequestOf(r: Row): DecisionRequest {
  const blockingRows = JSON.parse(r.blocking_rows as string) as string[]
  // 1.2.8 row 45b: topic and proposal have their own columns (migration 0008 moved row 45's options[0]["$request"]).
  return {
    id: r.request_id as string,
    question: r.question as string,
    ...(r.context ? { context: r.context as string } : {}),
    ...(r.topic ? { topic: r.topic as DecisionRequest["topic"] & string } : {}),
    ...(r.proposal ? { proposal: JSON.parse(r.proposal as string) as NonNullable<DecisionRequest["proposal"]> } : {}),
    options: JSON.parse(r.options as string) as DecisionRequest["options"],
    ...(r.recommended ? { recommended: r.recommended as string } : {}),
    blockingRows,
    status: r.status as DecisionRequest["status"],
    requestedBy: r.requested_by as string,
    createdAt: iso(r.time_created as number)!,
    ...(r.time_closed !== null && r.time_closed !== undefined ? { closedAt: iso(r.time_closed as number)! } : {}),
    ...(r.status === "answered" ? { answer: { option: r.answer_option as string, by: r.answered_by as "user" | "controller", decision: r.answer_decision_id as string, ...(typeof r.answered_via === "string" ? { via: r.answered_via } : {}), ...(r.answered_attested !== null && r.answered_attested !== undefined ? { attested: Number(r.answered_attested) === 1 } : {}) } } : {}),
  }
}

/**
 * Row 181 (L32): a projectDir filter lists missions whose project dir is the directory itself or a folder inside it
 * (an agent may store a subfolder of the session directory). `exact` is the normalised directory (no trailing slash,
 * no '.' or '..' segments); `prefix` adds the separator boundary, so '/a/b' never matches '/a/bc'. The list query
 * refuses a prefix match for a stored dir with '.' or '..' segments ('/a/b/../../etc' is not inside '/a/b').
 * Project dirs are POSIX absolute (migration 0003 CHECK: leading '/').
 * Row 185 (S186-01, L42): the subfolder (prefix) rule needs a narrow folder. For '/', the home folder or a folder
 * directly in it ('~/Documents'), or a folder fewer than PROJECT_PREFIX_MIN_SEGMENTS segments deep, `prefix` is null
 * and only the exact folder matches, so a session opened on a broad folder does not list every project below it.
 * Desktop mirrors this rule in mission-ipc.ts withinDirectory (the window access check).
 */
export const PROJECT_PREFIX_MIN_SEGMENTS = 4

export function projectDirScope(dir: string, home: string = homedir()): { exact: string; prefix: string | null } {
  const exact = posix.resolve("/", storeProjectDir(dir))
  return { exact, prefix: broadProjectDir(exact, storeProjectDir(home)) ? null : `${exact}/` }
}

/**
 * 1.3.1 Windows (1.2.2 F1, S186-04): a Windows drive path is stored in POSIX form - `C:\Users\a\p` and `c:/Users/a/p`
 * become `/C:/Users/a/p` - so migration 0003's CHECK (leading '/') and every POSIX scope rule hold unchanged, with no
 * migration of existing stores. A POSIX path passes through as it is. nativeProjectDir turns it back for disk access.
 * Desktop mirrors this in mission-ipc.ts (withinDirectory).
 */
export function storeProjectDir(dir: string): string {
  if (!/^[A-Za-z]:[\\/]/.test(dir)) return dir
  return `/${dir[0].toUpperCase()}:${dir.slice(2).replaceAll("\\", "/")}`
}

/** On win32 a stored `/C:/...` dir is `C:\...` on disk; elsewhere (and for POSIX dirs) the stored dir is the path. */
export function nativeProjectDir(dir: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== "win32" || !/^\/[A-Za-z]:(\/|$)/.test(dir)) return dir
  return `${dir.slice(1, 3)}\\${dir.slice(4).replaceAll("/", "\\")}`
}

/** S186-01: '/', the home folder, a direct child of it ('~/Documents'), or fewer than 4 segments deep. */
function broadProjectDir(exact: string, home: string): boolean {
  if (exact === "/" || exact.split("/").filter(Boolean).length < PROJECT_PREFIX_MIN_SEGMENTS) return true
  if (!home.startsWith("/")) return false
  const h = posix.resolve("/", home)
  return exact === h || posix.dirname(exact) === h
}

export function encodeMissionCursor(c: { t: number; id: string }): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url")
}

export function decodeMissionCursor(raw: string): { t: number; id: string } | null {
  try {
    const v = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as { t?: unknown; id?: unknown }
    return typeof v.t === "number" && Number.isFinite(v.t) && typeof v.id === "string" ? { t: v.t, id: v.id } : null
  } catch {
    return null
  }
}

export { emptyCounts }
