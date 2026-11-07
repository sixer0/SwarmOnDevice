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
import type { HostToolExtension, HostToolSession } from "../tool-table.ts"
import { ACTOR_PATTERN, EXPORT_FILES, MISSION_TOOL_NAMES, MISSION_TOOL_SCHEMAS, type ExportFile, type GetInclude } from "./schemas.ts"
import { errorResult, MissionToolError, okResult, type MissionLog } from "./tool-result.ts"

/** The part of SqliteStudioStore the mission tools use. */
export interface MissionHostStore {
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
  return (errors ?? []).slice(0, 50).map((e) => ({ pointer: e.instancePath || "/", keyword: e.keyword, message: e.message ?? "invalid" }))
}

export function validateArgs(tool: string, args: Record<string, unknown>): void {
  const v = validators.get(tool)
  if (v && !v(args)) throw new MissionToolError("SCHEMA_INVALID", "arguments do not match the tool input schema", { def: `${tool} input`, issues: argIssues(v.errors) })
}

/** Declared actor (L2): the argument, else the session's agent. */
export function actorOf(args: Record<string, unknown>, s: HostToolSession): string | undefined {
  if (typeof args.actor === "string") return args.actor
  return ACTOR_RE.test(s.agentId) ? s.agentId : undefined
}

/** Session link with the client locked to the MCP session's agent (row 31 D2). */
export function sessionOf(args: Record<string, unknown>, s: HostToolSession): SessionLink | undefined {
  const raw = args.session as { client?: string; ref: string; role?: SessionLink["role"] } | undefined
  if (!raw) return undefined
  const client = raw.client ?? s.agentId
  if (client !== s.agentId) throw new MissionToolError("AGENT_ID_LOCKED", `session.client is locked to this MCP session's agent "${s.agentId}"`, { client: raw.client, agent: s.agentId })
  return { client: client as SessionLink["client"], ref: raw.ref, ...(raw.role ? { role: raw.role } : {}) }
}

export function writeOptions(args: Record<string, unknown>, s: HostToolSession): MissionWriteOptions {
  const actor = actorOf(args, s)
  const session = sessionOf(args, s)
  return { ...(actor ? { actor } : {}), ...(session ? { session } : {}) }
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
        validateArgs(name, a)
        const out = await run(a, session)
        if (!readOnly) opts.log("info", `datum-studio-host.mission.${name}`, "mission write", { mission: typeof a.mission === "string" ? a.mission : (a.mission as { id?: unknown } | undefined)?.id, agent: session.agentId, dryRun: a.dryRun === true })
        return okResult(name, out.text, out.data)
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
      "Create a draft mission (studio.mission/v1 MissionDoc, status draft, no host fields): type, rows (pending or dropped), decisions, findings, sessions. Checks schema, type, phases, kinds, dependencies, B cycles and decision references. Returns id, status, rows, waves.",
      false,
      async (a, s) => {
        const input = a.mission as Parameters<MissionStore["create"]>[1]
        const r = await write(dry(a), (tx) => M.create(tx, input, writeOptions(a, s)))
        return { text: `mission ${r.id} created as ${r.status}: ${r.rows} rows, ${r.waves.length} waves${dryNote(a)}`, data: { ...r, issues: [], dryRun: dry(a) } }
      },
    ),
    tool(
      "studio_mission_get",
      "Read a mission",
      "Read one mission: the stored MissionDoc plus derived {phases (only the mission type's phases, U20), waves, ready, counts, progress, checkpoints}. include: rows, decisions, findings, locks, reports, events, snapshots, requests, checkpoints, messages.",
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
        const d = got.derived
        const text = [
          `mission ${id} (${got.mission.type} v${got.mission.typeVersion}): ${got.mission.status}${got.mission.supersededBy ? `, superseded by ${got.mission.supersededBy}` : ""}`,
          `  progress ${d.progress.done}/${d.progress.total} rows done; ready: ${d.ready.join(", ") || "-"}`,
          ...d.phases.map((p) => `  ${p.order}. ${p.id}: ${p.rows.join(", ") || "-"}`),
        ].join("\n")
        return { text, data: { mission, derived: d, ...extra } }
      },
    ),
    tool(
      "studio_mission_list",
      "List missions",
      "Session overview: missions filtered by session (several missions per session), status, type, projectDir or text q (mission_fts); newest first with a keyset cursor (take <= 200, default 50).",
      true,
      async (a, s) => {
        // A read: the session is only a filter (another client's overview may be read; client defaults to this agent).
        const sess = a.session as { client?: string; ref: string } | undefined
        const r = M.list({
          ...(sess ? { session: { client: (sess.client ?? s.agentId) as SessionLink["client"], ref: sess.ref } } : {}),
          ...(Array.isArray(a.status) ? { status: a.status as never } : {}),
          ...(str(a, "type") ? { type: str(a, "type") } : {}),
          ...(str(a, "projectDir") ? { projectDir: str(a, "projectDir") } : {}),
          ...(str(a, "q") ? { q: str(a, "q") } : {}),
          take: typeof a.take === "number" ? a.take : 50,
          ...(str(a, "cursor") ? { cursor: str(a, "cursor") } : {}),
        })
        const text = [`${r.items.length} missions${r.nextCursor ? " (more: nextCursor)" : ""}`, ...r.items.map((m) => `  ${m.id} [${m.type}] ${m.status} ${m.progress.done}/${m.progress.total}`)].join("\n")
        return { text, data: { items: r.items, nextCursor: r.nextCursor } }
      },
    ),
    tool(
      "studio_mission_approve",
      "Approve a mission",
      "draft -> approved with a decision recorded by: user (§2.3); refused without rows (MISSION_EMPTY) or with a controller decision (APPROVAL_NEEDS_USER_DECISION). Writes a status snapshot.",
      false,
      async (a, s) => {
        const r = await write(dry(a), (tx) => M.approve(tx, a.mission as string, a.decision as string, writeOptions(a, s)))
        return { text: `mission ${r.id} approved under ${String(a.decision)} at ${r.approvedAt}${dryNote(a)}`, data: { ...r, dryRun: dry(a) } }
      },
    ),
    tool(
      "studio_mission_set_status",
      "Change mission status",
      "Mission status (§2.2): running, paused, done (all rows done or dropped) or cancelled (needs decision; optional supersededBy). done and cancelled are terminal; closing releases locks and withdraws open decision requests.",
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
        return { text: `mission ${r.id}: ${r.from} -> ${r.to}${dryNote(a)}`, data: { ...r, dryRun: dry(a) } }
      },
    ),
    tool(
      "studio_mission_update_row",
      "Update mission rows",
      "Row patches in order in one job (1-200): {id, add?, set?, status?, note?, acquire?, release?, checkpoint?{n, m, label?}} (§4.2-4.4, §5.4; C57 b). messages[] (C57 c/d) are appended in the same job; an owner instruction is {from: owner, to: controller, kind: instruction} and is never executed. Returns changed rows, waves, ready.",
      false,
      async (a, s) => {
        const mission = a.mission as string
        const o = writeOptions(a, s)
        const patches = (Array.isArray(a.rows) ? a.rows : []) as Array<RowPatch & { checkpoint?: { n: number; m: number; label?: string } }>
        const messages = (Array.isArray(a.messages) ? a.messages : []) as NewMissionMessage[]
        const r = await write(dry(a), (tx) => {
          let out: { changed: string[]; waves: Array<{ wave: number; rows: string[] }>; ready: string[] } = { changed: [], waves: [], ready: [] }
          const rowPatches = patches.map(({ checkpoint: _c, ...p }) => p).filter((p) => Object.keys(p).length > 1)
          if (rowPatches.length > 0) out = M.updateRows(tx, mission, rowPatches, str(a, "decision") ? { decision: str(a, "decision") } : {}, o)
          const checkpoints = patches.filter((p) => p.checkpoint).map((p) => ({ row: p.id, ...M.recordCheckpoint(tx, mission, p.id, p.checkpoint!, o) }))
          const posted = messages.map((m) =>
            m.from === "owner" && m.to === "controller" && m.kind === "instruction" ? M.ownerInstruction(tx, mission, m.text, m.row ? { row: m.row } : {}, o) : M.postMessage(tx, mission, { ...m, ...(o.actor ? { actor: o.actor } : {}) }, o),
          )
          if (rowPatches.length === 0) {
            const g = M.get(mission, tx)!
            out = { changed: [], waves: g.derived.waves, ready: g.derived.ready }
          }
          return { ...out, checkpoints, messages: posted }
        })
        const text = `mission ${mission}: rows changed ${r.changed.join(", ") || "-"}; checkpoints ${r.checkpoints.length}; messages ${r.messages.length}; ready ${r.ready.join(", ") || "-"}${dryNote(a)}`
        return { text, data: { ...r, dryRun: dry(a) } }
      },
    ),
    tool(
      "studio_mission_record_decision",
      "Record a decision",
      "Append a decision {id U<n>|C<n>, by user|controller, date, text, rows?, supersedes?} (§5.2); append-only (DECISION_ID_TAKEN). A correction is a new decision with supersedes.",
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
