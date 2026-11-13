/**
 * Row 119b: mission semantics of the kept `studio_report_*` tools (mission contract §8.2, §5.1, §6.2; U19),
 * as wrapping HostToolExtensions around the vendored tools (which stay byte-identical, row 27).
 *
 * - `studio_report_template`: optional `row` fills mission:, docKey: row-<row>, TaskRef: <row>, Owner: <row agent>;
 *   MISSION_NOT_FOUND / ROW_UNKNOWN early. Read-only.
 * - `studio_report_check`: also runs the §6.2 mission checks and reports them as issues (valid: false). Saves nothing.
 * - `studio_report_submit`: mission required (argument or header, MISSION_REQUIRED); mission approved, running or
 *   paused; `row` -> docKey row-<row> (both given must agree); TaskRef = row id. The vendored submit, the
 *   mission_report link and the §5.1 row effect run in ONE write-queue job (the bridge's `withStudioTx`: every
 *   store write of the vendored services joins it), so a refused report leaves no document, revision or link.
 * - `studio_report_update`: mission from the document's mission_report link (REPORT_NOT_IN_MISSION), closed
 *   missions refused; same row effect, same single job.
 * - `studio_report_refresh` is not wrapped: unchanged, its file write is already limited to the session root
 *   (STUDIO_MCP_FILE_ROOTS = the session root, start.ts).
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { TOOLS } from "../../../vendor/scripts/studio/mcp/tools"
import { withStudioTx } from "../../store-bridge/index.ts"
import { StoreError, type StoreTx } from "../../store/index.ts"
import type { MissionDoc, MissionRow, ReportStatus } from "../../store/mission/types.ts"
import type { HostToolExtension, HostToolNext, HostToolSession } from "../tool-table.ts"
import type { MissionHostStore } from "./mission-tools.ts"
import { actorOf, sessionOf } from "./mission-tools.ts"
import { readReportSource, reportFacts, type ReportFacts } from "./report-facts.ts"
import { REPORT_EXTRA_PROPERTIES, ROW_ID_PATTERN } from "./schemas.ts"
import { errorResult, MissionToolError, refusal, type MissionLog } from "./tool-result.ts"

const WORK_REPORT = "agentWorkReport"
const ROW_RE = new RegExp(ROW_ID_PATTERN)
const DOCKEY_ROW_RE = /^row-([1-9][0-9]{0,3}[a-z]?)$/

/**
 * H-N16 (1.2.8 row 34b): every DOC_KEY_MISMATCH message ends with one example payload: a studio_report_submit
 * argument object that parses as JSON and passes that tool's schema (the mission and row of the call when valid).
 */
export function docKeyExample(mission?: string | null, row?: string | null): string {
  const m = typeof mission === "string" && mission.length > 0 && mission.length <= 120 && [...mission].every((c) => c.charCodeAt(0) > 0x1f) ? mission : "2026-11-14_contoh"
  const r = typeof row === "string" && ROW_RE.test(row) ? row : "1"
  return `; contoh: ${JSON.stringify({ mission: m, row: r, docKey: `row-${r}` })}`
}

export interface MissionIssue {
  code: string
  message: string
  details: Record<string, unknown>
}

interface Target {
  mission: string
  kind: "row" | "delegation"
  row?: string
  docKey: string
}

/** Ends the report job and rolls it back, carrying the result to return (a StoreError: the store logs a warning). */
class JobAbort extends StoreError {
  readonly result: CallToolResult
  constructor(result: CallToolResult) {
    super("CONSTRAINT", "report job rolled back (refused; nothing stored)")
    this.result = result
  }
}

/** Roll the job back after the vendored call: restore the session's remembered basis first (the store keeps none of it). */
function abortAfter(next: HostToolNext, documentId: string | null, saved: ReturnType<HostToolNext["basis"]["get"]>, result: CallToolResult): never {
  if (documentId !== null) next.basis.restore(documentId, saved)
  throw new JobAbort(result)
}

/** A store refusal after the vendored call rolls the job back: restore the session basis, then rethrow. */
function guarded<T>(next: HostToolNext, documentId: string, saved: ReturnType<HostToolNext["basis"]["get"]>, fn: () => T): T {
  try {
    return fn()
  } catch (e) {
    next.basis.restore(documentId, saved)
    throw e
  }
}

const issue = (code: string, message: string, details: Record<string, unknown> = {}): MissionIssue => ({ code, message, details })
const sc = (r: CallToolResult): Record<string, unknown> => (r.structuredContent ?? {}) as Record<string, unknown>
const isOk = (r: CallToolResult) => sc(r).ok === true && r.isError !== true

/** mission + docKey (+ row) of a new report; throws the first refusal. */
export function resolveTarget(facts: Pick<ReportFacts, "mission" | "docKey">, row: string | null): Target {
  if (!facts.mission) throw new MissionToolError("MISSION_REQUIRED", "a work report needs a mission: the mission argument or the `mission:` header line", {})
  if (row !== null && facts.docKey !== null && facts.docKey !== `row-${row}`) {
    throw new MissionToolError("DOC_KEY_MISMATCH", `docKey must be row-<row> when row is given${docKeyExample(facts.mission, row)}`, { mission: facts.mission, row, docKey: facts.docKey })
  }
  const docKey = facts.docKey ?? (row !== null ? `row-${row}` : null)
  if (docKey === "delegation") return { mission: facts.mission, kind: "delegation", docKey }
  const m = docKey !== null ? DOCKEY_ROW_RE.exec(docKey) : null
  if (!m) throw new MissionToolError("DOC_KEY_MISMATCH", `a mission work report has docKey row-<row> or delegation${docKeyExample(facts.mission, row)}`, { mission: facts.mission, docKey })
  return { mission: facts.mission, kind: "row", row: m[1], docKey: docKey as string }
}

function openBDeps(doc: MissionDoc, row: MissionRow): string[] {
  const status = new Map(doc.rows.map((r) => [r.id, r.status]))
  return row.deps.filter((d) => d.endsWith(":B")).map((d) => d.slice(0, -2)).filter((id) => status.get(id) !== "done")
}

/**
 * The §6.2 checks of one report against the stored mission (all issues, in a stable order). `reportStatus` is the
 * record Status: a draft report has no row effect, so the start checks of a pending row apply only to the others.
 */
export function missionIssues(store: MissionHostStore, t: Target, facts: Pick<ReportFacts, "taskRef" | "status">, tx?: StoreTx, o: { taskRef?: boolean } = {}): MissionIssue[] {
  const got = store.missions.get(t.mission, tx)
  if (!got) return [issue("MISSION_NOT_FOUND", "unknown mission id", { mission: t.mission })]
  const m = got.mission
  const out: MissionIssue[] = []
  if (m.status === "draft") out.push(issue("MISSION_NOT_APPROVED", "reports are accepted after approval", { mission: m.id, status: m.status }))
  if (m.status === "done" || m.status === "cancelled") out.push(issue("MISSION_CLOSED", `mission is ${m.status}`, { mission: m.id, status: m.status, ...(m.supersededBy ? { supersededBy: m.supersededBy } : {}) }))
  if (t.kind === "delegation") return out
  const row = m.rows.find((r) => r.id === t.row)
  if (!row) return [...out, issue("ROW_UNKNOWN", "docKey names no row of the mission", { mission: m.id, row: t.row, docKey: t.docKey })]
  if (row.status === "done" || row.status === "dropped") out.push(issue("ROW_CLOSED", `row ${row.id} is ${row.status}`, { mission: m.id, row: row.id, status: row.status }))
  if (o.taskRef !== false && (facts.taskRef === null || facts.taskRef !== row.id)) {
    const known = facts.taskRef !== null && ROW_RE.test(facts.taskRef) && m.rows.some((r) => r.id === facts.taskRef)
    out.push(
      facts.taskRef !== null && !known
        ? issue("ROW_UNKNOWN", "TaskRef names no row of the mission; TaskRef must equal the row id", { mission: m.id, row: row.id, taskRef: facts.taskRef })
        : issue("DOC_KEY_MISMATCH", `TaskRef must equal the row id of docKey${docKeyExample(m.id, row.id)}`, { mission: m.id, row: row.id, docKey: t.docKey, taskRef: facts.taskRef }),
    )
  }
  // A non-draft report starts a pending row, and restarts a blocked one unless it is itself blocked (store applyReport).
  const starts = facts.status !== null && facts.status !== "draft" && (row.status === "pending" || (row.status === "blocked" && facts.status !== "blocked"))
  if (starts && m.status !== "draft" && m.status !== "done" && m.status !== "cancelled") {
    if (m.status === "paused") out.push(issue("MISSION_PAUSED", `a ${row.status} row cannot (re)start while the mission is paused`, { mission: m.id, row: row.id, status: row.status }))
    const open = openBDeps(m, row)
    if (open.length > 0) out.push(issue("DEP_NOT_DONE", "B dependencies are not done", { mission: m.id, row: row.id, open }))
    const pending = store.missions.listDecisionRequests(m.id, { status: "open" }, tx).filter((r) => (r.blockingRows ?? []).includes(row.id))
    if (pending.length > 0) out.push(issue("DECISION_PENDING", "an open decision request blocks this row", { mission: m.id, row: row.id, requests: pending.map((r) => r.id) }))
  }
  return out
}

function linkOf(tx: StoreTx, documentId: string): { mission_id: string; kind: "row" | "delegation"; row_id: string | null } | undefined {
  return tx.get("SELECT mission_id, kind, row_id FROM mission_report WHERE document_id = ?", [documentId])
}

interface DocFacts {
  id: string
  mission_folder: string | null
  mission_doc_key: string | null
  contract_kind: string | null
  contract_status: string | null
  contract_task_ref: string | null
  current_revision_no: number
}

function docOf(tx: StoreTx, id: string): DocFacts | undefined {
  return tx.get("SELECT id, mission_folder, mission_doc_key, contract_kind, contract_status, contract_task_ref, current_revision_no FROM document WHERE id = ?", [id])
}

const REPORT_STATUSES: readonly string[] = ["draft", "complete", "partial", "blocked", "needs-review"]

function vendoredDef(name: string) {
  const t = TOOLS.find((x) => x.name === name)
  if (!t) throw new Error(`vendored MCP tool ${name} is missing`)
  return t
}

function extendSchema(name: string): Record<string, unknown> {
  const base = vendoredDef(name).inputSchema as Record<string, unknown> & { properties?: Record<string, unknown> }
  return { ...base, properties: { ...(base.properties ?? {}), ...(REPORT_EXTRA_PROPERTIES[name] ?? {}) } }
}

function strip(args: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args).filter(([k]) => !keys.includes(k)))
}

function withMission(out: CallToolResult, mission: Record<string, unknown>, line: string): CallToolResult {
  const content = [...(out.content ?? [])]
  content.push({ type: "text", text: line })
  return { ...out, content, structuredContent: { ...sc(out), mission } }
}

function argStr(a: Record<string, unknown>, k: string): string | null {
  return typeof a[k] === "string" && (a[k] as string) !== "" ? (a[k] as string) : null
}

function checkRowArg(name: string, row: unknown): string | null {
  if (row === undefined) return null
  if (typeof row !== "string" || !ROW_RE.test(row)) throw new MissionToolError("SCHEMA_INVALID", "row must match ^[1-9][0-9]{0,3}[a-z]?$", { def: `${name} input`, row })
  return row
}

export function reportWrappers(store: MissionHostStore, opts: { log: MissionLog }): HostToolExtension[] {
  const M = store.missions
  const wrapper = (name: string, title: string, extra: string, call: (a: Record<string, unknown>, s: HostToolSession, next: HostToolNext) => Promise<CallToolResult>): HostToolExtension => {
    const def = vendoredDef(name)
    return {
      name,
      title,
      description: `${def.description} Misi (row 119b): ${extra}`,
      inputSchema: extendSchema(name),
      toolsets: def.toolsets,
      wraps: true,
      async call(args, session, next) {
        if (!next) throw new Error(`${name}: wrapper called without the vendored tool`)
        const a = structuredClone(args ?? {}) as Record<string, unknown>
        try {
          return await call(a, session, next)
        } catch (e) {
          if (e instanceof JobAbort) return e.result
          return errorResult(name, e, opts.log, { agent: session.agentId })
        }
      },
    }
  }

  // ── studio_report_template ──────────────────────────────────────────────
  const template = wrapper(
    "studio_report_template",
    "Templat laporan kerja",
    "row (opsional) mengisi mission:, docKey: row-<row>, TaskRef: <row>, Owner: <agen baris>; misi/baris tak dikenal -> MISSION_NOT_FOUND / ROW_UNKNOWN.",
    async (a, _s, next) => {
      const row = checkRowArg("studio_report_template", a.row)
      const mission = argStr(a, "mission")
      const vend = strip(a, ["row"])
      if (row !== null && mission === null) throw new MissionToolError("MISSION_REQUIRED", "row needs the mission argument", { row })
      if (mission === null) return next(vend)
      const got = M.get(mission)
      if (!got) throw new MissionToolError("MISSION_NOT_FOUND", "unknown mission id", { mission })
      if (row === null) return next(vend)
      const r = got.mission.rows.find((x) => x.id === row)
      if (!r) throw new MissionToolError("ROW_UNKNOWN", "row is not a row of the mission", { mission, row })
      const docKey = argStr(a, "docKey")
      if (docKey !== null && docKey !== `row-${row}`) throw new MissionToolError("DOC_KEY_MISMATCH", `docKey must be row-<row> when row is given${docKeyExample(mission, row)}`, { mission, row, docKey })
      const out = await next({ ...vend, docKey: `row-${row}` })
      if (!isOk(out)) return out
      const fill = (t: string) =>
        t
          .replace(/^Owner: <isi:[^>\n]*>$/m, `Owner: ${r.agent}`)
          .replace(/^TaskRef: <isi:[^>\n]*>$/m, `TaskRef: ${row}`)
          .replace(/("owner":\s*)"<isi:[^>\n"]*>"/, `$1${JSON.stringify(r.agent)}`)
          .replace(/("taskRef":\s*)"<isi:[^>\n"]*>"/, `$1${JSON.stringify(row)}`)
      const data = sc(out)
      const filled = typeof data.template === "string" ? fill(data.template) : data.template
      return {
        ...out,
        content: (out.content ?? []).map((c) => (c.type === "text" ? { ...c, text: fill(c.text) } : c)),
        structuredContent: { ...data, template: filled, row, mission, docKey: `row-${row}`, owner: r.agent, taskRef: row },
      }
    },
  )

  // ── studio_report_check ─────────────────────────────────────────────────
  const check = wrapper(
    "studio_report_check",
    "Periksa laporan kerja",
    "juga menjalankan cek misi §6.2 (MISSION_REQUIRED, MISSION_NOT_FOUND, MISSION_NOT_APPROVED, MISSION_CLOSED, ROW_UNKNOWN, ROW_CLOSED, DOC_KEY_MISMATCH, TaskRef = baris, DEP_NOT_DONE, MISSION_PAUSED, DECISION_PENDING, REPORT_NOT_IN_MISSION) sebagai isu (valid: false); tidak menyimpan apa pun.",
    async (a, s, next) => {
      const row = checkRowArg("studio_report_check", a.row)
      const vend = strip(a, ["row"])
      if (row !== null && argStr(a, "docKey") === null) vend.docKey = `row-${row}`
      const out = await next(vend)
      const src = readReportSource(a, s.fileRoot)
      if (src === null) return out
      const facts = reportFacts(src, { mission: argStr(a, "mission"), docKey: argStr(vend, "docKey") })
      let issues: MissionIssue[] = []
      let target: Record<string, unknown> | null = null
      if (facts.basisDocumentId !== null) {
        // update mode: the mission comes from the document's link
        const link = await withStudioTx(async (tx) => linkOf(tx, facts.basisDocumentId as string))
        if (!link) issues = [issue("REPORT_NOT_IN_MISSION", "the document has no mission link", { documentId: facts.basisDocumentId })]
        else {
          const t: Target = link.kind === "delegation" ? { mission: link.mission_id, kind: "delegation", docKey: "delegation" } : { mission: link.mission_id, kind: "row", row: link.row_id ?? undefined, docKey: `row-${link.row_id}` }
          target = { ...t, documentId: facts.basisDocumentId }
          issues = missionIssues(store, t, facts)
        }
      } else {
        try {
          const t = resolveTarget(facts, row)
          target = { ...t }
          issues = missionIssues(store, t, facts)
        } catch (e) {
          if (!(e instanceof MissionToolError)) throw e
          issues = [issue(e.code, e.message, e.details)]
        }
      }
      const data = sc(out)
      const valid = data.valid !== false && issues.length === 0
      const lines = issues.length === 0 ? ["cek misi: lolos"] : issues.map((i) => `isu misi ${i.code}: ${i.message} ${JSON.stringify(i.details)}`)
      return { ...out, content: [...(out.content ?? []), { type: "text", text: lines.join("\n") }], structuredContent: { ...data, valid, mission: target, missionIssues: issues } }
    },
  )

  // ── studio_report_submit ────────────────────────────────────────────────
  const submit = wrapper(
    "studio_report_submit",
    "Kirim laporan kerja",
    "mission wajib (argumen atau baris mission:, MISSION_REQUIRED); misi approved/running/paused; row -> docKey row-<row> (harus cocok); TaskRef = id baris; tabel maks 20 kolom, 20 sel per baris; dokumen, tautan mission_report dan efek baris (§5.1) satu job antrean tulis; ditolak = tak ada yang tersimpan.",
    async (a, s, next) => {
      const row = checkRowArg("studio_report_submit", a.row)
      const session = sessionOf(a, s)
      const actor = actorOf(a, s)
      const vend = strip(a, ["row", "session"])
      const src = readReportSource(a, s.fileRoot)
      const facts: ReportFacts = src !== null ? reportFacts(src, { mission: argStr(a, "mission"), docKey: argStr(a, "docKey") }) : { format: "md", mission: argStr(a, "mission"), docKey: argStr(a, "docKey"), taskRef: null, status: null, owner: null, basisDocumentId: null }
      const t = resolveTarget(facts, row)
      if (row !== null) vend.docKey = t.docKey
      return withStudioTx(async (tx) => {
        const first = missionIssues(store, t, facts, tx)
        if (first.length > 0) throw new JobAbort(refusal("studio_report_submit", first[0].code, first[0].message, { ...first[0].details, issues: first }))
        const existing = tx.get<{ id: string }>("SELECT id FROM document WHERE mission_folder = ? AND mission_doc_key = ?", [t.mission, t.docKey])?.id ?? null
        const saved = existing !== null ? next.basis.get(existing) : null
        const out = await next(vend)
        const documentId = typeof sc(out).documentId === "string" ? (sc(out).documentId as string) : existing
        if (!isOk(out)) abortAfter(next, documentId, saved, out) // partial writes of a failed submit are rolled back too
        const doc = documentId !== null ? docOf(tx, documentId) : undefined
        if (!doc) abortAfter(next, documentId, saved, refusal("studio_report_submit", "INTERNAL_ERROR", "submit returned no stored document", {}))
        const abort = (c: string, msg: string, d: Record<string, unknown>) => abortAfter(next, doc.id, saved, refusal("studio_report_submit", c, msg, d))
        if (doc.mission_folder !== t.mission || doc.mission_doc_key !== t.docKey) abort("DOC_KEY_MISMATCH", `the stored document is not the mission + docKey of the report${docKeyExample(t.mission, t.row)}`, { mission: t.mission, docKey: t.docKey, stored: { mission: doc.mission_folder, docKey: doc.mission_doc_key } })
        if (doc.contract_kind !== WORK_REPORT) abort("DOC_KEY_MISMATCH", `the document is not a work report${docKeyExample(t.mission, t.row)}`, { documentId: doc.id, contractKind: doc.contract_kind })
        if (t.kind === "row" && doc.contract_task_ref !== t.row) abort("DOC_KEY_MISMATCH", `TaskRef must equal the row id of docKey${docKeyExample(t.mission, t.row)}`, { mission: t.mission, row: t.row, taskRef: doc.contract_task_ref })
        const status = (REPORT_STATUSES.includes(doc.contract_status ?? "") ? doc.contract_status : "draft") as ReportStatus
        const effect = guarded(next, doc.id, saved, () => M.recordReport(
          tx,
          { documentId: doc.id, revisionNo: Number(doc.current_revision_no), mission: t.mission, kind: t.kind, ...(t.row ? { row: t.row } : {}), docKey: t.docKey, status },
          { ...(actor ? { actor } : {}), ...(session ? { session } : {}) },
        ))
        const missionStatus = M.get(t.mission, tx)?.mission.status
        const info = { id: t.mission, kind: t.kind, ...(t.row ? { row: t.row } : {}), docKey: t.docKey, revisionNo: Number(doc.current_revision_no), reportStatus: status, ...(effect.rowStatus ? { rowStatus: effect.rowStatus } : {}), missionStatus }
        return withMission(out, info, `misi ${t.mission}: laporan ${t.kind === "row" ? `baris ${t.row}` : "delegasi"} rev ${doc.current_revision_no} (${status})${effect.rowStatus ? ` -> baris ${effect.rowStatus}` : ""}; misi ${missionStatus}`)
      })
    },
  )

  // ── studio_report_update ────────────────────────────────────────────────
  const update = wrapper(
    "studio_report_update",
    "Perbarui laporan kerja",
    "misi diambil dari tautan mission_report dokumen (tanpa tautan -> REPORT_NOT_IN_MISSION); misi done/cancelled -> MISSION_CLOSED; efek baris sama dengan submit, dalam satu job antrean tulis.",
    async (a, s, next) => {
      const session = sessionOf(a, s)
      const actor = actorOf(a, s)
      const vend = strip(a, ["session"])
      const documentId = argStr(a, "documentId")
      if (documentId === null) return next(vend) // the vendored schema refuses it
      return withStudioTx(async (tx) => {
        const before = docOf(tx, documentId)
        if (!before) return next(vend) // vendored NOT_FOUND, nothing written
        const link = linkOf(tx, documentId)
        if (!link) throw new JobAbort(refusal("studio_report_update", "REPORT_NOT_IN_MISSION", "the document has no mission link", { documentId }))
        const t: Target = link.kind === "delegation" ? { mission: link.mission_id, kind: "delegation", docKey: "delegation" } : { mission: link.mission_id, kind: "row", row: link.row_id ?? undefined, docKey: `row-${link.row_id}` }
        // §6.2 before the vendored call (TaskRef is checked on the stored record afterwards: a partial update may omit it)
        const src = readReportSource(a, s.fileRoot)
        const facts = src !== null ? reportFacts(src, {}) : null
        const pre = missionIssues(store, t, { taskRef: null, status: facts?.status ?? null }, tx, { taskRef: false })
        if (pre.length > 0) throw new JobAbort(refusal("studio_report_update", pre[0].code, pre[0].message, { ...pre[0].details, documentId, issues: pre }))
        const saved = next.basis.get(documentId)
        const out = await next(vend)
        if (!isOk(out)) abortAfter(next, documentId, saved, out)
        const after = docOf(tx, documentId)!
        if (Number(after.current_revision_no) === Number(before.current_revision_no)) {
          return withMission(out, { id: t.mission, kind: t.kind, ...(t.row ? { row: t.row } : {}), revisionNo: Number(after.current_revision_no), changed: false }, `misi ${t.mission}: tidak ada revisi baru, tidak ada efek baris`)
        }
        if (t.kind === "row" && after.contract_task_ref !== t.row) {
          abortAfter(next, documentId, saved, refusal("studio_report_update", "DOC_KEY_MISMATCH", `TaskRef must equal the row id of the report${docKeyExample(t.mission, t.row)}`, { mission: t.mission, row: t.row, taskRef: after.contract_task_ref }))
        }
        const status = (REPORT_STATUSES.includes(after.contract_status ?? "") ? after.contract_status : "draft") as ReportStatus
        const effect = guarded(next, documentId, saved, () => M.applyReport(tx, { documentId, revisionNo: Number(after.current_revision_no), status }, { ...(actor ? { actor } : {}), ...(session ? { session } : {}) }))
        const missionStatus = M.get(t.mission, tx)?.mission.status
        const info = { id: t.mission, kind: t.kind, ...(t.row ? { row: t.row } : {}), revisionNo: Number(after.current_revision_no), reportStatus: status, ...(effect.rowStatus ? { rowStatus: effect.rowStatus } : {}), missionStatus, changed: true }
        return withMission(out, info, `misi ${t.mission}: rev ${after.current_revision_no} (${status})${effect.rowStatus ? ` -> baris ${effect.rowStatus}` : ""}; misi ${missionStatus}`)
      })
    },
  )

  return [template, check, submit, update]
}

// Row 119c: the same job helpers for the studio_document_create / studio_write wrappers (guard-writes.ts).
export { WORK_REPORT, JobAbort, abortAfter, guarded, sc, isOk, linkOf, docOf, REPORT_STATUSES, vendoredDef, strip, withMission, argStr }
export type { Target }
