/**
 * Row 119b: the 11 `studio_mission_*` tools (mission contract §8.3, decisions U19, U20, C57, C68, C71) as
 * HostToolExtensions over the row 119a mission store (`store.missions`).
 *
 * - Every write is one write-queue job (`store.transaction`); `dryRun` runs the same job and rolls it back.
 * - Caller identity is locked to the MCP session's agent (row 31 D2): the default actor is the session agent, and a
 *   `session.client` that differs from it is refused (AGENT_ID_LOCKED). `actor` is a declared claim (limit L2).
 * - C57 (b)-(d) have no tool of their own (C71 fixes the count at 11): checkpoints are a row patch field and
 *   messages / owner instructions ride on `studio_mission_update_row` (decision D2 of the row 119b report).
 */
import Ajv, { type ErrorObject, type ValidateFunction } from "ajv"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { createHash } from "node:crypto"
import path from "node:path"
import { prepareDownloadDir, REAL_NODE_FS, McpToolError, writeFileGuarded, type NodeFs } from "../../../vendor/scripts/studio/mcp/safety"
import { StoreError, type MissionStore, type StoreTx } from "../../store/index.ts"
import type { MissionDoc, MissionWriteOptions, NewMissionMessage, RowPatch, SessionLink } from "../../store/mission/types.ts"
import { ROW_RUNNING_DONE_RULE, type RowPatchJobResult } from "../../store/mission/mission-store.ts"
import type { HostToolExtension, HostToolSession } from "../tool-table.ts"
import { ACTOR_PATTERN, EXPORT_FILES, MISSION_TOOL_NAMES, MISSION_TOOL_SCHEMAS, type ExportFile, type GetInclude } from "./schemas.ts"
import { errorResult, MissionToolError, okResult, type MissionLog } from "./tool-result.ts"
import { describeAjvError } from "../../store/mission/validate.ts"
import { MISSION_GUIDE_URI } from "./mission-guide.ts"
import { readActivityAt, readDeliverables, readMessagesTail, type OutputVerificationSource } from "./deliverables.ts"

/** The part of SqliteStudioStore the mission tools use (row 126/155: + the G4 source, row 149's listOutputVerifications, see deliverables.ts). */
export interface MissionHostStore extends OutputVerificationSource {
  readonly missions: MissionStore
  transaction<T>(fn: (tx: StoreTx) => Promise<T>, opts?: { timeoutMs?: number; correlationId?: string }): Promise<T>
}

/**
 * Row 120 seam: renders the §9 files of one mission. Paths are relative to `docs/<mission>/`
 * (e.g. `identification/02_structured_rows.md`). Without it `studio_mission_export` refuses EXPORT_NOT_AVAILABLE.
 */
export type MissionExporter = (input: { mission: string; files: readonly ExportFile[]; store: MissionHostStore }) => Promise<Array<{ path: string; markdown: string }>>

export interface MissionToolOptions {
  log: MissionLog
  exporter?: MissionExporter
  nfs?: NodeFs
  now?: () => number
}

const ajv = new Ajv({ allErrors: true, strict: true, useDefaults: true })
const validators = new Map<string, ValidateFunction>(Object.entries(MISSION_TOOL_SCHEMAS).map(([n, s]) => [n, ajv.compile(s)]))
const ACTOR_RE = new RegExp(ACTOR_PATTERN)

/** Rolls a dryRun job back (a StoreError, so the store logs it as a warning, not an error). */
class DryRunRollback extends StoreError {
  readonly result: unknown
  constructor(result: unknown) {
    super("CONSTRAINT", "dryRun: job rolled back on request (nothing stored)")
    this.result = result
  }
}

function argIssues(errors: ErrorObject[] | null | undefined): Array<{ pointer: string; keyword: string; message: string }> {
  return (errors ?? []).slice(0, 50).map((e) => ({ pointer: e.instancePath || "/", keyword: e.keyword, message: describeAjvError(e) }))
}

/** Row 169: the object argument of each tool that an agent may send as a JSON string (row 146 run, call 21). */
const OBJECT_ARGS: Record<string, string> = {
  studio_mission_create: "mission",
  studio_mission_record_decision: "decision",
  studio_mission_record_finding: "finding",
  studio_mission_request_decision: "request",
}

/** A JSON-object string in an object argument is parsed; any other string is refused saying it must be an object. */
export function parseObjectArg(tool: string, args: Record<string, unknown>): void {
  const key = OBJECT_ARGS[tool]
  const raw = key ? args[key] : undefined
  if (typeof raw !== "string") return
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    parsed = undefined
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new MissionToolError("SCHEMA_INVALID", `${key} must be a JSON object, not a string`, { def: `${tool} input`, issues: [{ pointer: `/${key}`, keyword: "type", message: "must be a JSON object (send the object itself)" }] })
  }
  args[key] = parsed
}

export function validateArgs(tool: string, args: Record<string, unknown>): void {
  const v = validators.get(tool)
  if (v && !v(args)) throw new MissionToolError("SCHEMA_INVALID", "arguments do not match the tool input schema", { def: `${tool} input`, issues: argIssues(v.errors) })
}

/**
 * Row 181 (L32): a mission sent without project.dir gets the calling session's directory (the session's file root,
 * the caller's working directory), so Mission Control, which lists by the session directory, shows it. Only an absent
 * project or a project object without `dir` is filled; any other value is left for the schema check.
 */
export function defaultProjectDir(mission: unknown, fileRoot: string): void {
  if (mission === null || typeof mission !== "object" || Array.isArray(mission) || !fileRoot) return
  const m = mission as Record<string, unknown>
  if (m.project === undefined) m.project = { dir: fileRoot }
  else if (m.project !== null && typeof m.project === "object" && !Array.isArray(m.project) && (m.project as Record<string, unknown>).dir === undefined) {
    m.project = { dir: fileRoot, ...(m.project as Record<string, unknown>) }
  }
}

/** Declared actor (L2): the argument, else the session's agent. */
export function actorOf(args: Record<string, unknown>, s: HostToolSession): string | undefined {
  if (typeof args.actor === "string") return args.actor
  return ACTOR_RE.test(s.agentId) ? s.agentId : undefined
}

/** Row 188: the session refs the store accepts (studio.mission/v1 $defs/SessionLink). */
const SWARM_REF_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/
const ANY_REF_RE = /^[A-Za-z0-9_.:-]{1,128}$/
const LINK_CLIENTS = new Set<string>(["swarm", "claude"])

export function validSessionRef(client: string, ref: unknown): ref is string {
  return typeof ref === "string" && ANY_REF_RE.test(ref) && (client !== "swarm" || SWARM_REF_RE.test(ref))
}

/** Row 188: the calling session's own ref, when the client said it and the store would accept it. */
export function callerRef(s: HostToolSession): string | undefined {
  return LINK_CLIENTS.has(s.agentId) && validSessionRef(s.agentId, s.callerSession) ? s.callerSession : undefined
}

/** Row 188: notes about a session link the host filled, replaced or skipped, per call (keyed by the argument object). */
const sessionNotes = new WeakMap<object, string[]>()
function note(args: object, text: string): void {
  sessionNotes.set(args, [...(sessionNotes.get(args) ?? []), text])
}
export function sessionNotesOf(args: object): string[] {
  return sessionNotes.get(args) ?? []
}

/**
 * Session link with the client locked to the MCP session's agent (row 31 D2).
 * Row 188 (L47): the agent never has to invent a session id. Omitted -> the calling session (when the client said it,
 * see HostToolSession.callerSession), else no link. A ref the store would refuse is never a refusal: it is replaced by
 * the calling session, or the link is skipped, and the call says so (sessionNotesOf).
 */
export function sessionOf(args: Record<string, unknown>, s: HostToolSession): SessionLink | undefined {
  const raw = args.session as { client?: string; ref?: unknown; role?: SessionLink["role"] } | undefined
  const known = callerRef(s)
  if (!raw || typeof raw !== "object") return known ? { client: s.agentId as SessionLink["client"], ref: known } : undefined
  const client = raw.client ?? s.agentId
  if (client !== s.agentId) throw new MissionToolError("AGENT_ID_LOCKED", `session.client is locked to this MCP session's agent "${s.agentId}"`, { client: raw.client, agent: s.agentId })
  const role = raw.role ? { role: raw.role } : {}
  if (validSessionRef(client, raw.ref)) return { client: client as SessionLink["client"], ref: raw.ref, ...role }
  if (known) {
    note(args, `session.ref is not a ${client} session id; linked the calling session ${known} instead (omit session; Swarm fills it)`)
    return { client: client as SessionLink["client"], ref: known, ...role }
  }
  note(args, `session.ref is not a ${client} session id and the calling session is unknown; no session was linked (omit session; Swarm fills it)`)
  return undefined
}

/**
 * Row 188: session links inside a create's MissionDoc (`mission.sessions`) get the same rule: an entry of this agent
 * with a ref the store would refuse becomes the calling session (or is dropped); an invalid entry of another client
 * is dropped. Each change is noted. Entries that are not objects are left for the schema check.
 */
export function normalizeDocSessions(args: Record<string, unknown>, s: HostToolSession): void {
  const m = args.mission as Record<string, unknown> | undefined
  if (!m || typeof m !== "object" || !Array.isArray(m.sessions)) return
  const known = callerRef(s)
  const out: unknown[] = []
  for (const e of m.sessions as unknown[]) {
    if (!e || typeof e !== "object" || Array.isArray(e)) {
      out.push(e)
      continue
    }
    const link = e as Record<string, unknown>
    const client = typeof link.client === "string" ? link.client : s.agentId
    if (!LINK_CLIENTS.has(client) || validSessionRef(client, link.ref)) {
      out.push(e)
      continue
    }
    if (client === s.agentId && known) {
      note(args, `mission.sessions: ref is not a ${client} session id; the calling session ${known} is linked instead`)
      out.push({ ...link, client, ref: known })
    } else note(args, `mission.sessions: ref is not a ${client} session id; that entry was dropped (omit sessions; Swarm links the calling session)`)
  }
  m.sessions = out
}

/**
 * Row 197 (S194-01): a self-approval (`autonomous: true`) is allowed only when Swarm itself says its autonomous mode
 * setting is on for the calling session (`_meta["studio/autonomous"]`, see sessionForCall). Never for another client:
 * the mode is Swarm's. Text the model read (a repo file, a page, a prompt) cannot turn it on.
 */
export function autonomousModeOf(s: HostToolSession): boolean {
  return s.agentId === "swarm" && s.autonomousMode === true
}

export function writeOptions(args: Record<string, unknown>, s: HostToolSession): MissionWriteOptions {
  const actor = actorOf(args, s)
  const session = sessionOf(args, s)
  return { ...(actor ? { actor } : {}), ...(session ? { session } : {}), autonomousMode: autonomousModeOf(s) }
}

function str(a: Record<string, unknown>, k: string): string | undefined {
  return typeof a[k] === "string" ? (a[k] as string) : undefined
}

function pick<T extends Record<string, unknown>>(o: T, keys: readonly string[]): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([k]) => keys.includes(k))) as Partial<T>
}

export function missionTools(store: MissionHostStore, opts: MissionToolOptions): HostToolExtension[] {
  const M = store.missions
  const nfs = opts.nfs ?? REAL_NODE_FS
  const now = opts.now ?? Date.now

  async function write<T>(dry: boolean, fn: (tx: StoreTx) => T): Promise<T> {
    try {
      return await store.transaction(async (tx) => {
        const r = fn(tx)
        if (dry) throw new DryRunRollback(r)
        return r
      })
    } catch (e) {
      if (e instanceof DryRunRollback) return e.result as T
      throw e
    }
  }

  /** Row 126: a read-only job on the write queue (committed data; nothing written). */
  function read<T>(fn: (q: StoreTx) => T): Promise<T> {
    return store.transaction(async (tx) => fn(tx))
  }

  function requireMission(id: string): { mission: MissionDoc } {
    const got = M.get(id)
    if (!got) throw new MissionToolError("MISSION_NOT_FOUND", "unknown mission id", { mission: id })
    return got
  }

  type Run = (a: Record<string, unknown>, s: HostToolSession) => Promise<{ text: string; data: Record<string, unknown> }>
  const tool = (name: (typeof MISSION_TOOL_NAMES)[number], title: string, description: string, readOnly: boolean, run: Run): HostToolExtension => ({
    name,
    title,
    description,
    inputSchema: MISSION_TOOL_SCHEMAS[name] as Record<string, unknown>,
    annotations: { readOnlyHint: readOnly, destructiveHint: false, idempotentHint: readOnly, openWorldHint: false },
    toolsets: ["missions"],
    async call(args, session): Promise<CallToolResult> {
      const a = structuredClone(args ?? {}) as Record<string, unknown>
      try {
        parseObjectArg(name, a)
        if (name === "studio_mission_create") normalizeDocSessions(a, session)
        // Row 188: a session ref the store would refuse is handled by sessionOf (replaced or skipped), not refused here.
        const sess = a.session as Record<string, unknown> | undefined
        if (name !== "studio_mission_list" && sess && typeof sess === "object" && !validSessionRef(typeof sess.client === "string" ? sess.client : session.agentId, sess.ref)) {
          sessionOf(a, session) // notes the replacement or the skip
          const known = callerRef(session)
          if (known) a.session = { ...sess, ref: known }
          else delete a.session
        }
        validateArgs(name, a)
        const out = await run(a, session)
        if (!readOnly) opts.log("info", `datum-studio-host.mission.${name}`, "mission write", { mission: typeof a.mission === "string" ? a.mission : (a.mission as { id?: unknown } | undefined)?.id, agent: session.agentId, dryRun: a.dryRun === true })
        const notes = sessionNotesOf(a)
        return notes.length > 0 ? okResult(name, `${out.text}\n${notes.join("\n")}`, { ...out.data, sessionNotes: notes }) : okResult(name, out.text, out.data)
      } catch (e) {
        if (e instanceof McpToolError) return errorResult(name, new MissionToolError(e.code, e.message, (e as { details?: Record<string, unknown> }).details ?? {}), opts.log)
        return errorResult(name, e, opts.log, { mission: typeof a.mission === "string" ? a.mission : undefined, agent: session.agentId })
      }
    },
  })

  const dry = (a: Record<string, unknown>) => a.dryRun === true
  const dryNote = (a: Record<string, unknown>) => (dry(a) ? " (dryRun: checked and rolled back, nothing stored)" : "")

  return [
    tool(
      "studio_mission_create",
      "Create a mission",
      `Create a draft mission (studio.mission/v1 MissionDoc, status draft, no host fields): type, rows (pending or dropped), decisions, findings, sessions. Checks schema, type, phases, kinds, dependencies, B cycles and decision references. Returns id, status, rows, waves. Shape, enums and an example: resource ${MISSION_GUIDE_URI}; row model.tier: thinker | worker | worker-fast | inherit.`,
      false,
      async (a, s) => {
        defaultProjectDir(a.mission, s.fileRoot)
        const input = a.mission as Parameters<MissionStore["create"]>[1]
        const r = await write(dry(a), (tx) => M.create(tx, input, writeOptions(a, s)))
        return { text: `mission ${r.id} created as ${r.status}: ${r.rows} rows, ${r.waves.length} waves${dryNote(a)}`, data: { ...r, issues: [], dryRun: dry(a) } }
      },
    ),
    tool(
      "studio_mission_get",
      "Read a mission",
      "Read one mission: the stored MissionDoc plus derived {phases (only the mission type's phases, U20), waves, ready, counts, progress, checkpoints, drift (rows added after approval with the decision id that justified each: {count, rows: [{row, timeCreated, decision}], dropped: [{row, timeDropped, decision}]}; empty when none)}. include: rows, decisions, findings, locks, reports, events, snapshots, requests, checkpoints, messages, deliverables (the mission's Studio documents with the current revision's outputs: finalFileName, sha256, verified). messagesTail: N = the newest N messages.",
      true,
      async (a) => {
        const id = a.mission as string
        const got = M.get(id)
        if (!got) throw new MissionToolError("MISSION_NOT_FOUND", "unknown mission id", { mission: id })
        const include = (Array.isArray(a.include) ? a.include : null) as GetInclude[] | null
        const has = (k: GetInclude) => include === null || include.includes(k)
        const doc = got.mission as unknown as Record<string, unknown>
        const header = Object.fromEntries(Object.entries(doc).filter(([k]) => !["rows", "decisions", "findings", "locks"].includes(k)))
        const rows = (got.mission.rows ?? []).map((r) => (has("reports") ? r : (({ reports: _r, ...rest }) => rest)(r)))
        const mission = {
          ...header,
          ...(has("rows") ? { rows } : {}),
          ...(has("decisions") && got.mission.decisions ? { decisions: got.mission.decisions } : {}),
          ...(has("findings") && got.mission.findings ? { findings: got.mission.findings } : {}),
          ...(has("locks") && got.mission.locks ? { locks: got.mission.locks } : {}),
        }
        const extra: Record<string, unknown> = {}
        if (include?.includes("events")) extra.events = M.listEvents(id)
        if (include?.includes("snapshots")) extra.snapshots = M.listSnapshots(id)
        if (include?.includes("requests")) extra.requests = M.listDecisionRequests(id)
        if (include?.includes("checkpoints")) extra.checkpoints = M.listCheckpoints(id)
        if (include?.includes("messages")) extra.messages = M.listMessages(id)
        // Row 126 (spec mission control §8 G1, G3).
        const tail = typeof a.messagesTail === "number" ? a.messagesTail : undefined
        if (tail !== undefined || include?.includes("deliverables")) {
          const rowIds = new Set((got.mission.rows ?? []).map((r) => r.id))
          await read(async (q) => {
            if (tail !== undefined) extra.messages = readMessagesTail(q, M, id, tail)
            if (include?.includes("deliverables")) extra.deliverables = readDeliverables(q, id, rowIds) // row 136b: sync, the store's one rule
          })
        }
        const d = got.derived
        const text = [
          `mission ${id} (${got.mission.type} v${got.mission.typeVersion}): ${got.mission.status}${got.mission.supersededBy ? `, superseded by ${got.mission.supersededBy}` : ""}`,
          `  progress ${d.progress.done}/${d.progress.total} rows done; ready: ${d.ready.join(", ") || "-"}`,
          ...d.phases.map((p) => `  ${p.order}. ${p.id}: ${p.rows.join(", ") || "-"}`),
          // 1.2.6 row 87 (MC-09): one drift line, only when rows were added or dropped after approval.
          ...(d.drift.count > 0 || d.drift.dropped.length > 0
            ? [
                `  drift: ${d.drift.count} row${d.drift.count === 1 ? "" : "s"} added after approval (${d.drift.rows.map((r) => `${r.row} by ${r.decision ?? "-"}`).join(", ") || "-"})` +
                  (d.drift.dropped.length > 0 ? `; dropped: ${d.drift.dropped.map((r) => `${r.row} by ${r.decision ?? "-"}`).join(", ")}` : ""),
              ]
            : []),
        ].join("\n")
        return { text, data: { mission, derived: d, ...extra } }
      },
    ),
    tool(
      "studio_mission_list",
      "List missions",
      "Session overview: missions filtered by session (several missions per session), status, type, projectDir (that directory or a folder inside it; with sessions[]: plus the missions linked to any of those sessions of this agent) or text q (mission_fts); newest first with a keyset cursor (take <= 200, default 50). Each item has activityAt: the newest change of the mission, its documents, outputs or output verification.",
      true,
      async (a, s) => {
        // A read: the session is only a filter (another client's overview may be read; client defaults to this agent).
        const sess = a.session as { client?: string; ref: string } | undefined
        const r = M.list({
          ...(sess ? { session: { client: (sess.client ?? s.agentId) as SessionLink["client"], ref: sess.ref } } : {}),
          ...(Array.isArray(a.status) ? { status: a.status as never } : {}),
          ...(str(a, "type") ? { type: str(a, "type") } : {}),
          ...(str(a, "projectDir") ? { projectDir: str(a, "projectDir") } : {}),
          // Row 183 (L36): sessions are refs of this agent's client; their missions are added to the projectDir list.
          ...(Array.isArray(a.sessions) && a.sessions.length > 0 ? { linkedSessions: { client: s.agentId as SessionLink["client"], refs: a.sessions as string[] } } : {}),
          ...(str(a, "q") ? { q: str(a, "q") } : {}),
          take: typeof a.take === "number" ? a.take : 50,
          ...(str(a, "cursor") ? { cursor: str(a, "cursor") } : {}),
        })
        // Row 126 (spec mission control §8 G2): activityAt per item.
        const activity = await read((q) => readActivityAt(q, store, r.items.map((m) => m.id)))
        const items = r.items.map((m) => ({ ...m, activityAt: activity.get(m.id) ?? m.updatedAt }))
        const text = [`${items.length} missions${r.nextCursor ? " (more: nextCursor)" : ""}`, ...items.map((m) => `  ${m.id} [${m.type}] ${m.status} ${m.progress.done}/${m.progress.total}`)].join("\n")
        return { text, data: { items, nextCursor: r.nextCursor } }
      },
    ),
    tool(
      "studio_mission_approve",
      "Approve a mission",
      "draft -> approved with a decision recorded by: user (§2.3), or, only while Swarm's autonomous mode setting is on (the person turns it on), by: controller with autonomous: true (shown as self-approved (autonomous); refused AUTONOMOUS_MODE_OFF otherwise); other controller decisions are refused (APPROVAL_NEEDS_USER_DECISION), as is a mission without rows (MISSION_EMPTY). Writes a status snapshot.",
      false,
      async (a, s) => {
        const r = await write(dry(a), (tx) => {
          const out = M.approve(tx, a.mission as string, a.decision as string, writeOptions(a, s))
          return { ...out, approval: M.get(a.mission as string, tx)?.derived.approval }
        })
        const how = r.approval?.autonomous ? " (self-approved (autonomous), decision by controller)" : ""
        return { text: `mission ${r.id} approved under ${String(a.decision)} at ${r.approvedAt}${how}${dryNote(a)}`, data: { ...r, dryRun: dry(a) } }
      },
    ),
    tool(
      "studio_mission_set_status",
      "Change mission status",
      "Mission status (§2.2): running, paused, done (all rows done or dropped) or cancelled (needs decision; optional supersededBy). done and cancelled are terminal; closing releases locks and withdraws open decision requests. Setting the current status again returns unchanged: true and writes nothing.",
      false,
      async (a, s) => {
        const r = await write(dry(a), (tx) =>
          M.setStatus(
            tx,
            a.mission as string,
            a.to as never,
            { ...(str(a, "decision") ? { decision: str(a, "decision") } : {}), ...(str(a, "supersededBy") ? { supersededBy: str(a, "supersededBy") } : {}), ...(str(a, "note") ? { note: str(a, "note") } : {}) },
            writeOptions(a, s),
          ),
        )
        if (r.unchanged) return { text: `mission ${r.id}: already ${r.to}, unchanged (no event, no snapshot)${dryNote(a)}`, data: { ...r, dryRun: dry(a) } }
        return { text: `mission ${r.id}: ${r.from} -> ${r.to}${dryNote(a)}`, data: { ...r, dryRun: dry(a) } }
      },
    ),
    tool(
      "studio_mission_update_row",
      "Update mission rows",
      `Row patches in order in one job (1-200): {id, add?, set?, status?, note?, acquire?, release?, retire?, checkpoint?{n, m, label?}} (§4.2-4.4, §5.4; C57 b). Status: ${ROW_RUNNING_DONE_RULE} (SCHEMA_INVALID field note otherwise); blocked and dropped need a note; done still passes the output gate (OUTPUT_UNVERIFIED). Each patch applies on its own: valid patches apply, a refused patch is rolled back alone and reported in results [{id, ok, code?, message?, noteSaved?}]; if no patch applies the call fails with the first code. A status refused for DEP_NOT_DONE still stores the patch's note (noteSaved: true). retire: [documentId] archives a superseded draft linked to the row (needs note), applied before status. messages[] (C57 c/d) are appended in the same job; an owner instruction is {from: owner, to: controller, kind: instruction} and is never executed. Returns changed rows, results, waves, ready.`,
      false,
      async (a, s) => {
        const mission = a.mission as string
        const o = writeOptions(a, s)
        const patches = (Array.isArray(a.rows) ? a.rows : []) as Array<RowPatch & { checkpoint?: { n: number; m: number; label?: string } }>
        const messages = (Array.isArray(a.messages) ? a.messages : []) as NewMissionMessage[]
        const r = await write(dry(a), (tx) => {
          let out: RowPatchJobResult = { changed: [], results: [], waves: [], ready: [] }
          const stripped = patches.map(({ checkpoint: _c, ...p }) => p)
          const rowPatches = stripped.filter((p) => Object.keys(p).length > 1)
          if (rowPatches.length > 0) out = M.updateRows(tx, mission, rowPatches, str(a, "decision") ? { decision: str(a, "decision") } : {}, o)
          // Row 85 (MC-07): a refused patch's checkpoint is not recorded (results align with rowPatches by index).
          const refusedPatch = new Set(rowPatches.filter((_p, i) => out.results[i]?.ok === false))
          const checkpoints = patches.filter((p, i) => p.checkpoint && !refusedPatch.has(stripped[i])).map((p) => ({ row: p.id, ...M.recordCheckpoint(tx, mission, p.id, p.checkpoint!, o) }))
          const posted = messages.map((m) =>
            m.from === "owner" && m.to === "controller" && m.kind === "instruction" ? M.ownerInstruction(tx, mission, m.text, m.row ? { row: m.row } : {}, o) : M.postMessage(tx, mission, { ...m, ...(o.actor ? { actor: o.actor } : {}) }, o),
          )
          if (rowPatches.length === 0) {
            const g = M.get(mission, tx)!
            out = { changed: [], results: [], waves: g.derived.waves, ready: g.derived.ready }
          }
          return { ...out, checkpoints, messages: posted }
        })
        const refused = r.results.filter((x) => !x.ok).map((x) => `${x.id} ${x.code}${x.noteSaved ? " (note saved)" : ""}`)
        const text = `mission ${mission}: rows changed ${r.changed.join(", ") || "-"}${refused.length > 0 ? `; refused ${refused.join(", ")}` : ""}; checkpoints ${r.checkpoints.length}; messages ${r.messages.length}; ready ${r.ready.join(", ") || "-"}${dryNote(a)}`
        return { text, data: { ...r, dryRun: dry(a) } }
      },
    ),
    tool(
      "studio_mission_record_decision",
      "Record a decision",
      "Append a decision {id U<n>|C<n>, by user|controller, date, text, rows?, supersedes?, autonomous?} (§5.2); append-only (DECISION_ID_TAKEN). A correction is a new decision with supersedes. autonomous: true (by: controller only) records a self-approval, allowed only while Swarm's autonomous mode setting is on (the person turns it on; else AUTONOMOUS_MODE_OFF); never record by: user for the user.",
      false,
      async (a, s) => {
        const r = await write(dry(a), (tx) => M.recordDecision(tx, a.mission as string, a.decision as never, writeOptions(a, s)))
        return { text: `decision ${r.id} recorded in ${String(a.mission)}${dryNote(a)}`, data: { ...r, dryRun: dry(a) } }
      },
    ),
    tool(
      "studio_mission_record_finding",
      "Record a finding",
      "Upsert a finding by id {id, severity, title, sourceRow, ownerRow?, status, decision?, evidence?} (§5.3): open needs ownerRow; accepted and deferred need a decision.",
      false,
      async (a, s) => {
        const r = await write(dry(a), (tx) => M.recordFinding(tx, a.mission as string, a.finding as never, writeOptions(a, s)))
        return { text: `finding ${r.id} is ${r.status}${dryNote(a)}`, data: { ...r, dryRun: dry(a) } }
      },
    ),
    tool(
      "studio_mission_export",
      "Export a mission to /docs",
      "Render the §9 Markdown files of a mission (blueprint rows, status, decisions, delegation trail). write: true writes them under <session root>/docs/<mission>/ only; an existing file is refused (FILE_EXISTS) unless overwrite (a .bak copy is made first).",
      false,
      async (a, s) => {
        const mission = a.mission as string
        requireMission(mission)
        if (!opts.exporter) throw new MissionToolError("EXPORT_NOT_AVAILABLE", "the /docs export renderer is not installed in this build (row 120)", { mission })
        const files = (Array.isArray(a.files) ? a.files : [...EXPORT_FILES]) as ExportFile[]
        const rendered = await opts.exporter({ mission, files, store })
        const base = path.join(s.fileRoot, "docs", mission)
        const out = rendered.map((f) => {
          const rel = path.normalize(f.path)
          if (path.isAbsolute(rel) || rel.startsWith("..")) throw new MissionToolError("PATH_OUTSIDE_ROOT", "export path leaves docs/<mission>/", { path: f.path })
          const bytes = Buffer.from(f.markdown, "utf8")
          const sha256 = createHash("sha256").update(bytes).digest("hex")
          return { path: path.join("docs", mission, rel), abs: path.join(base, rel), bytes: bytes.length, sha256, markdown: f.markdown, data: bytes }
        })
        if (a.write === true) {
          const roots = [s.fileRoot]
          if (a.overwrite !== true) {
            const taken = out.filter((f) => nfs.exists(f.abs)).map((f) => f.path)
            if (taken.length > 0) throw new MissionToolError("FILE_EXISTS", "export files exist; nothing written (overwrite: true makes a .bak copy first)", { files: taken })
          }
          for (const f of out) prepareDownloadDir(path.dirname(f.abs), roots, nfs)
          for (const f of out) writeFileGuarded(f.abs, f.data, { roots, purpose: "write-report", overwrite: a.overwrite === true, nfs, now })
        }
        const listed = out.map(({ path: p, bytes, sha256, markdown }) => ({ path: p, bytes, sha256, markdown }))
        return { text: `${listed.length} files${a.write === true ? ` written under ${base}` : " (not written)"}: ${listed.map((f) => f.path).join(", ")}`, data: { files: listed, written: a.write === true } }
      },
    ),
    tool(
      "studio_mission_request_decision",
      "Request a decision",
      "C57 (a): open a decision request {id D-<n>, question, context? (one line), options 2-8 {id, label, consequence}, recommended?, blockingRows?}. Blocking rows cannot go running while it is open (DECISION_PENDING); their status is not changed.",
      false,
      async (a, s) => {
        const r = await write(dry(a), (tx) => M.requestDecision(tx, a.mission as string, a.request as never, writeOptions(a, s)))
        return { text: `decision request ${r.id} open: ${r.question} (blocks ${(r.blockingRows ?? []).join(", ") || "-"})${dryNote(a)}`, data: { request: r, dryRun: dry(a) } }
      },
    ),
    tool(
      "studio_mission_answer_decision",
      "Answer a decision request",
      "C57 (a): answer an open request once {request, option, by user|controller, decisionId U<n>|C<n>, date?, text?}: records the decision and releases the blocking rows (returned in released). withdraw: true withdraws it instead.",
      false,
      async (a, s) => {
        const mission = a.mission as string
        const request = a.request as string
        const o = writeOptions(a, s)
        if (a.withdraw === true) {
          const extra = ["option", "by", "decisionId", "date", "text"].filter((k) => a[k] !== undefined)
          if (extra.length > 0) throw new MissionToolError("SCHEMA_INVALID", "withdraw takes no answer fields", { def: "studio_mission_answer_decision input", fields: extra })
          const r = await write(dry(a), (tx) => M.withdrawDecision(tx, mission, request, o))
          return { text: `decision request ${r.id} withdrawn${dryNote(a)}`, data: { request: r, released: [], dryRun: dry(a) } }
        }
        const missing = ["option", "by", "decisionId"].filter((k) => a[k] === undefined)
        if (missing.length > 0) throw new MissionToolError("SCHEMA_INVALID", "an answer needs option, by and decisionId", { def: "studio_mission_answer_decision input", missing })
        const answer = pick(a, ["option", "by", "decisionId", "date", "text"]) as never
        const r = await write(dry(a), (tx) => M.answerDecision(tx, mission, request, answer, o))
        return { text: `decision request ${request} answered ${String(a.option)} -> ${r.decision.id}; released ${r.released.join(", ") || "-"}${dryNote(a)}`, data: { ...r, dryRun: dry(a) } }
      },
    ),
  ]
}
