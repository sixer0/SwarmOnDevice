/**
 * Row 119c (C77, C81; U19): the mission guard on the two generic write tools that can also store a work report,
 * `studio_document_create` and `studio_write`, as wrapping HostToolExtensions (the row 119b hook, tool-table.ts
 * `wraps` / mcp-server.ts `next`). Vendored tools and vendor ingest stay unchanged.
 *
 * Mission contract §5.1 "One guard for every path": work reports are also created by `studio_write` (no template
 * = work report) and by `studio_document_create` with the work-report template, so "a document whose contract kind
 * is agentWorkReport needs a mission and a link, or the call is refused with MISSION_REQUIRED".
 *
 * Report kind (when the wrapper guards a call), keyed on the registry constant as §11 A1 asks, not on a literal:
 * - `studio_document_create { template }` and `studio_write { template }`: the template's stored `contract_kind` is
 *   the work-report kind (`WORK_REPORT_CONTRACT_KIND`). That column is exactly what ingest gives the new document
 *   (vendor services/ingest/v2.ts:210-221 `templateContractKind`, repository.ts:261-262). The registry's own slug
 *   for that kind (registry/contracts.ts:388-390 `templateSlug`) counts too, also before its template row exists
 *   (fail closed). Copies of a contract template carry the same column, so they are covered without a slug list.
 * - `studio_write` without `template`: always a work report (write-tools.ts:191-194 `buildWorkReport`, contract
 *   kind `MD_REPORT_DEFAULT_KIND`, write-content.ts:476).
 * Anything else passes through unchanged.
 *
 * Guarded call (= studio_report_submit / update, report-tools.ts): mission from the argument (MISSION_REQUIRED
 * when absent), docKey row-<row> or delegation (DOC_KEY_MISMATCH), the §6.2 checks before the vendored call, then
 * ONE write-queue job holds the vendored write, the post-check on the stored row, and `missions.recordReport`
 * (new document: link + §5.1 row effect) or `missions.applyReport` (existing linked report). Any refusal rolls the
 * whole job back: nothing is stored.
 *
 * Active only when the store was opened with `missionGuard: true` (row 119a D5: the guard is opt-in; the desktop
 * runner opens it on, I-2 item 4). A store opened without it keeps the old behaviour and the old tool list.
 *
 * Row 119d (C85): the same guard on the R12/R13 create path (vendor services/submit/pipeline.ts applyInLock, create
 * branch on a missing target): `studio_chapter_import_markdown`, `studio_chapter_submit`, `studio_slot_fill`. Their
 * edits of an existing document pass through unchanged (no create possible); so do dry runs and creates on a template
 * that is not a work-report template. Every other call runs in ONE write-queue job: before the vendored call a known
 * report template needs a registered mission (MISSION_REQUIRED / MISSION_NOT_FOUND, then the §6.2 checks); after it,
 * every document the call created (rowid above the job's start mark) with contract kind agentWorkReport is checked
 * again on its stored mission + docKey and linked with `missions.recordReport` (§5.1 row effect), or the whole job
 * is rolled back. The flag is read through the store's public getter `missionGuardEnabled` (studio-store.ts).
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { resolveTemplate } from "../../../vendor/scripts/studio/mcp/write-client-run"
import { buildWorkReport, type SectionInput } from "../../../vendor/scripts/studio/mcp/write-content"
import { normalizeWriteArgs } from "../../../vendor/scripts/studio/mcp/write-normalize"
import { getContractKindDef } from "../../../vendor/src/lib/studio/registry/contracts"
import { withStudioTx } from "../../store-bridge/index.ts"
import type { StoreTx } from "../../store/index.ts"
import { WORK_REPORT_CONTRACT_KIND } from "../../store/mission/index.ts"
import type { ReportStatus } from "../../store/mission/types.ts"
import type { HostToolExtension, HostToolNext, HostToolSession } from "../tool-table.ts"
import type { MissionHostStore } from "./mission-tools.ts"
import { actorOf, sessionOf } from "./mission-tools.ts"
import { reportFacts } from "./report-facts.ts"
import { abortAfter, argStr, docOf, guarded, isOk, JobAbort, linkOf, missionIssues, REPORT_STATUSES, resolveTarget, sc, strip, vendoredDef, withMission, type Target } from "./report-tools.ts"
import { REPORT_EXTRA_PROPERTIES } from "./schemas.ts"
import { errorResult, MissionToolError, refusal, type MissionLog } from "./tool-result.ts"

/** The tools this module wraps. */
export const GUARDED_WRITE_TOOLS = ["studio_document_create", "studio_write"] as const

/** True when `slug` is a work-report template (see the module comment for the rule and its sources). */
export function isReportTemplate(tx: StoreTx, slug: string): boolean {
  if (getContractKindDef(WORK_REPORT_CONTRACT_KIND)?.templateSlug === slug) return true
  return tx.get<{ contract_kind: string | null }>("SELECT contract_kind FROM template WHERE slug = ?", [slug])?.contract_kind === WORK_REPORT_CONTRACT_KIND
}

/** The R12/R13 tools whose create path row 119d guards. */
export const GUARDED_CREATE_TOOLS = ["studio_chapter_import_markdown", "studio_chapter_submit", "studio_slot_fill"] as const

/** Whether the installed store was opened with the work-report guard (public getter of SqliteStudioStore; row 119a D5, row 119d). */
export function storeMissionGuard(store: object): boolean {
  return (store as { readonly missionGuardEnabled?: unknown }).missionGuardEnabled === true
}

interface WriteFacts {
  mission: string | null
  docKey: string | null
  /** null = not known before the call (the stored record is checked afterwards) */
  taskRef: string | null
  status: string | null
  /** TaskRef must equal the row (studio_write builds the record; document_create stores a skeleton without one). */
  requireTaskRef: boolean
}

export function guardWriteWrappers(store: MissionHostStore, opts: { log: MissionLog }): HostToolExtension[] {
  if (!storeMissionGuard(store)) return []
  const M = store.missions

  const wrapper = (name: (typeof GUARDED_WRITE_TOOLS)[number], extra: string, plan: (a: Record<string, unknown>, s: HostToolSession) => Promise<WriteFacts | null>): HostToolExtension => {
    const def = vendoredDef(name)
    const base = def.inputSchema as Record<string, unknown> & { properties?: Record<string, unknown> }
    return {
      name,
      title: String(def.annotations.title ?? name),
      description: `${def.description} Misi (row 119c): ${extra}`,
      inputSchema: { ...base, properties: { ...(base.properties ?? {}), ...REPORT_EXTRA_PROPERTIES.studio_report_update } },
      toolsets: def.toolsets,
      wraps: true,
      async call(args, session, next) {
        if (!next) throw new Error(`${name}: wrapper called without the vendored tool`)
        const a = structuredClone(args ?? {}) as Record<string, unknown>
        try {
          const facts = await plan(a, session)
          if (facts === null) return await next(a) // not a work report: unchanged
          return await guardedWrite(name, a, session, next, facts)
        } catch (e) {
          if (e instanceof JobAbort) return e.result
          return errorResult(name, e, opts.log, { agent: session.agentId })
        }
      },
    }
  }

  async function guardedWrite(tool: string, a: Record<string, unknown>, s: HostToolSession, next: HostToolNext, f: WriteFacts): Promise<CallToolResult> {
    const session = sessionOf(a, s)
    const actor = actorOf(a, s)
    const vend = strip(a, ["session"])
    if (f.mission === null) throw new MissionToolError("MISSION_REQUIRED", "a work report needs a mission: the mission argument names the mission (U19)", { tool, docKey: f.docKey })
    const t: Target = resolveTarget({ mission: f.mission, docKey: f.docKey }, null)
    const wopts = { ...(actor ? { actor } : {}), ...(session ? { session } : {}) }
    return withStudioTx(async (tx) => {
      const existing = tx.get<{ id: string; current_revision_no: number }>("SELECT id, current_revision_no FROM document WHERE mission_folder = ? AND mission_doc_key = ?", [t.mission, t.docKey])
      if (existing && !linkOf(tx, existing.id)) throw new JobAbort(refusal(tool, "REPORT_NOT_IN_MISSION", "the mission + docKey already hold a document without a mission link", { documentId: existing.id, mission: t.mission, docKey: t.docKey }))
      // A new report is checked like submit; a rewrite of a linked report like update (TaskRef on the stored record).
      const pre = missionIssues(store, t, { taskRef: f.taskRef, status: f.status }, tx, { taskRef: f.requireTaskRef && !existing })
      if (pre.length > 0) throw new JobAbort(refusal(tool, pre[0].code, pre[0].message, { ...pre[0].details, issues: pre }))
      const saved = existing ? next.basis.get(existing.id) : null
      const out = await next(vend)
      const documentId = typeof sc(out).documentId === "string" ? (sc(out).documentId as string) : (existing?.id ?? tx.get<{ id: string }>("SELECT id FROM document WHERE mission_folder = ? AND mission_doc_key = ?", [t.mission, t.docKey])?.id ?? null)
      if (!isOk(out)) abortAfter(next, documentId, saved, out) // partial writes of a failed call are rolled back too
      const doc = documentId !== null ? docOf(tx, documentId) : undefined
      if (!doc) abortAfter(next, documentId, saved, refusal(tool, "INTERNAL_ERROR", "the write returned no stored document", {}))
      const abort = (c: string, msg: string, d: Record<string, unknown>) => abortAfter(next, doc.id, saved, refusal(tool, c, msg, d))
      if (doc.contract_kind !== WORK_REPORT_CONTRACT_KIND) return out // the template made no work report (no record slot): nothing to link
      if (doc.mission_folder !== t.mission || doc.mission_doc_key !== t.docKey) abort("DOC_KEY_MISMATCH", "the stored document is not the mission + docKey of the report", { mission: t.mission, docKey: t.docKey, stored: { mission: doc.mission_folder, docKey: doc.mission_doc_key } })
      if (t.kind === "row" && (f.requireTaskRef || doc.contract_task_ref !== null) && doc.contract_task_ref !== t.row) abort("DOC_KEY_MISMATCH", "TaskRef must equal the row id of docKey", { mission: t.mission, row: t.row, taskRef: doc.contract_task_ref })
      const status = (REPORT_STATUSES.includes(doc.contract_status ?? "") ? doc.contract_status : "draft") as ReportStatus
      const revisionNo = Number(doc.current_revision_no)
      if (existing && revisionNo === Number(existing.current_revision_no)) {
        return withMission(out, { id: t.mission, kind: t.kind, ...(t.row ? { row: t.row } : {}), docKey: t.docKey, revisionNo, changed: false }, `misi ${t.mission}: tidak ada revisi baru, tidak ada efek baris`)
      }
      const effect = guarded(next, doc.id, saved, () =>
        existing
          ? M.applyReport(tx, { documentId: doc.id, revisionNo, status }, wopts)
          : M.recordReport(tx, { documentId: doc.id, revisionNo, mission: t.mission, kind: t.kind, ...(t.row ? { row: t.row } : {}), docKey: t.docKey, status }, wopts),
      )
      const missionStatus = M.get(t.mission, tx)?.mission.status
      const info = { id: t.mission, kind: t.kind, ...(t.row ? { row: t.row } : {}), docKey: t.docKey, revisionNo, reportStatus: status, ...(effect.rowStatus ? { rowStatus: effect.rowStatus } : {}), missionStatus, changed: true }
      return withMission(out, info, `misi ${t.mission}: laporan ${t.kind === "row" ? `baris ${t.row}` : "delegasi"} rev ${revisionNo} (${status})${effect.rowStatus ? ` -> baris ${effect.rowStatus}` : ""}; misi ${missionStatus}`)
    })
  }

  const documentCreate = wrapper(
    "studio_document_create",
    "templat laporan kerja (jenis kontrak agentWorkReport) wajib misi yang terdaftar (MISSION_REQUIRED / MISSION_NOT_FOUND), docKey row-<row> atau delegation; dokumen, tautan mission_report dan efek baris dalam satu job antrean tulis; ditolak = tidak ada yang tersimpan. Templat lain tidak berubah.",
    async (a) => {
      const slug = argStr(a, "template")
      if (slug === null || !(await withStudioTx(async (tx) => isReportTemplate(tx, slug)))) return null
      return { mission: argStr(a, "mission"), docKey: argStr(a, "docKey"), taskRef: null, status: null, requireTaskRef: false }
    },
  )

  const write = wrapper(
    "studio_write",
    "laporan kerja (tanpa template, atau templat jenis agentWorkReport) wajib misi yang terdaftar (MISSION_REQUIRED / MISSION_NOT_FOUND), docKey row-<row> atau delegation, meta.taskRef = id baris; dokumen, tautan mission_report dan efek baris (§5.1) dalam satu job antrean tulis; ditolak = tidak ada yang tersimpan. Dokumen klien tidak berubah.",
    async (a, s) => {
      // The vendored prepare step (aliases such as missionFolder / doc_key / templateSlug) on a copy: the wrapper sees
      // what the vendored tool will see; the original arguments go to the vendored tool unchanged.
      const n = structuredClone(strip(a, ["session"]))
      try {
        normalizeWriteArgs(n)
      } catch {
        // the vendored prepare step reports its own errors
      }
      const template = argStr(n, "template")
      if (template !== null && !(await withStudioTx(async (tx) => isReportTemplate(tx, resolveTemplate(template))))) return null
      const mission = argStr(n, "mission")
      const docKey = argStr(n, "docKey")
      if (template !== null) return { mission, docKey, taskRef: null, status: null, requireTaskRef: false }
      const built = (() => {
        try {
          const meta = typeof n.meta === "object" && n.meta !== null && !Array.isArray(n.meta) ? (n.meta as Record<string, string>) : {}
          return buildWorkReport({ mission: mission ?? "0000-00-00_x", docKey: docKey ?? "x", title: argStr(n, "title"), meta, sections: (Array.isArray(n.sections) ? n.sections : []) as SectionInput[], agentId: s.agentId, now: Date.now() })
        } catch {
          return null // the vendored tool reports its own input errors
        }
      })()
      const facts = built !== null ? reportFacts(built.markdown, { mission, docKey }) : null
      return { mission, docKey, taskRef: facts?.taskRef ?? null, status: facts?.status ?? null, requireTaskRef: true }
    },
  )

  /** Row 119d: run a create-path call; `intent` null = it cannot create a work report (pass through unchanged). */
  const createWrapper = (name: (typeof GUARDED_CREATE_TOOLS)[number], plan: (a: Record<string, unknown>) => Promise<CreateIntent | null>): HostToolExtension => {
    const def = vendoredDef(name)
    const base = def.inputSchema as Record<string, unknown> & { properties?: Record<string, unknown> }
    return {
      name,
      title: String(def.annotations.title ?? name),
      description: `${def.description} Misi (row 119d): dokumen BARU dari templat laporan kerja (jenis kontrak agentWorkReport) wajib misi yang terdaftar (MISSION_REQUIRED / MISSION_NOT_FOUND), docKey row-<row> atau delegation; dokumen, tautan mission_report dan efek baris dalam satu job antrean tulis; ditolak = tidak ada yang tersimpan. Dokumen yang sudah ada dan templat lain tidak berubah.`,
      inputSchema: { ...base, properties: { ...(base.properties ?? {}), ...REPORT_EXTRA_PROPERTIES.studio_report_update } },
      toolsets: def.toolsets,
      wraps: true,
      async call(args, session, next) {
        if (!next) throw new Error(`${name}: wrapper called without the vendored tool`)
        const a = structuredClone(args ?? {}) as Record<string, unknown>
        try {
          const intent = await plan(a)
          if (intent === null) return await next(strip(a, ["session"]))
          return await guardedCreate(name, a, session, next, intent)
        } catch (e) {
          if (e instanceof JobAbort) return e.result
          return errorResult(name, e, opts.log, { agent: session.agentId })
        }
      },
    }
  }

  async function guardedCreate(tool: string, a: Record<string, unknown>, s: HostToolSession, next: HostToolNext, intent: CreateIntent): Promise<CallToolResult> {
    const session = sessionOf(a, s)
    const actor = actorOf(a, s)
    const wopts = { ...(actor ? { actor } : {}), ...(session ? { session } : {}) }
    return withStudioTx(async (tx) => {
      if (intent.template !== null && isReportTemplate(tx, intent.template)) {
        // A new work report: refused before the vendored call (nothing renders, nothing is written).
        if (intent.mission === null) throw new MissionToolError("MISSION_REQUIRED", "a new work report needs a mission: target mission (+ docKey row-<row> or delegation) (U19)", { tool, template: intent.template })
        const t = resolveTarget({ mission: intent.mission, docKey: intent.docKey }, null)
        const pre = missionIssues(store, t, { taskRef: null, status: null }, tx, { taskRef: false })
        if (pre.length > 0) throw new JobAbort(refusal(tool, pre[0].code, pre[0].message, { ...pre[0].details, issues: pre }))
      }
      const mark = Number(tx.get<{ n: number }>("SELECT coalesce(max(rowid), 0) AS n FROM document")?.n ?? 0)
      const out = await next(strip(a, ["session"]))
      const created = tx.all<{ id: string }>("SELECT id FROM document WHERE rowid > ? ORDER BY rowid", [mark]).map((d) => d.id)
      const forget = () => created.forEach((id) => next.basis.restore(id, null))
      if (!isOk(out)) {
        forget()
        throw new JobAbort(out) // partial writes of a failed call are rolled back too; the vendored result is returned
      }
      const reports = created.map((id) => docOf(tx, id)).filter((d) => d?.contract_kind === WORK_REPORT_CONTRACT_KIND)
      if (reports.length === 0) return out // nothing created, or no work report (client document)
      const doc = reports[0]!
      // After the call: the stored document decides (fail closed, also for a create the plan did not foresee).
      const done = (() => {
        try {
          if (reports.length > 1) throw new MissionToolError("INTERNAL_ERROR", "one call created more than one work report", { documents: reports.map((d) => d!.id) })
          if (doc.mission_folder === null) throw new MissionToolError("MISSION_REQUIRED", "a new work report needs a mission: target mission (+ docKey row-<row> or delegation) (U19)", { tool })
          const t = resolveTarget({ mission: doc.mission_folder, docKey: doc.mission_doc_key }, null)
          const status = (REPORT_STATUSES.includes(doc.contract_status ?? "") ? doc.contract_status : "draft") as ReportStatus
          const issues = missionIssues(store, t, { taskRef: doc.contract_task_ref, status }, tx, { taskRef: doc.contract_task_ref !== null })
          if (issues.length > 0) throw new MissionToolError(issues[0].code, issues[0].message, { ...issues[0].details, issues })
          const revisionNo = Number(doc.current_revision_no)
          const effect = M.recordReport(tx, { documentId: doc.id, revisionNo, mission: t.mission, kind: t.kind, ...(t.row ? { row: t.row } : {}), docKey: t.docKey, status }, wopts)
          return { t, status, revisionNo, effect }
        } catch (e) {
          forget()
          throw e
        }
      })()
      const t = done.t
      const missionStatus = M.get(t.mission, tx)?.mission.status
      const info = { id: t.mission, kind: t.kind, ...(t.row ? { row: t.row } : {}), docKey: t.docKey, documentId: doc.id, revisionNo: done.revisionNo, reportStatus: done.status, ...(done.effect.rowStatus ? { rowStatus: done.effect.rowStatus } : {}), missionStatus, changed: true }
      return withMission(out, info, `misi ${t.mission}: laporan ${t.kind === "row" ? `baris ${t.row}` : "delegasi"} rev ${done.revisionNo} (${done.status}) dibuat dan ditautkan${done.effect.rowStatus ? ` -> baris ${done.effect.rowStatus}` : ""}; misi ${missionStatus}`)
    })
  }

  /** null when the target certainly exists (an edit: no create), else the intent of a possible create. */
  async function intentUnlessExisting(target: { documentId?: string | null; docNumber?: string | null; mission?: string | null; docKey?: string | null }, intent: CreateIntent): Promise<CreateIntent | null> {
    // A template that is not a work-report template cannot give a new document the work-report contract kind.
    if (intent.template !== null && !(await withStudioTx(async (tx) => isReportTemplate(tx, intent.template as string)))) return null
    const exists = await withStudioTx(async (tx) => {
      if (target.documentId) return !!tx.get("SELECT 1 AS x FROM document WHERE id = ?", [target.documentId])
      if (target.docNumber) return !!tx.get("SELECT 1 AS x FROM document WHERE doc_number = ?", [target.docNumber])
      if (target.mission && target.docKey) return !!tx.get("SELECT 1 AS x FROM document WHERE mission_folder = ? AND mission_doc_key = ?", [target.mission, target.docKey])
      return false // target resolved by the pipeline (e.g. the mission's only document): guarded
    })
    return exists ? null : intent
  }

  const importMarkdown = createWrapper("studio_chapter_import_markdown", async (a) => {
    if (a.submit !== true) return null // check only: the vendored tool stores nothing (doc-tools.ts: R12 only when submit=true)
    const mission = argStr(a, "mission")
    const template = argStr(a, "template")
    // effective docKey = docKey ?? template slug, as the vendored preflight and the R12 lock resolve it
    const docKey = argStr(a, "docKey") ?? template
    return intentUnlessExisting({ documentId: argStr(a, "documentId"), mission, docKey }, { mission, docKey, template })
  })

  const chapterSubmit = createWrapper("studio_chapter_submit", async (a) => {
    if (a.dryRun === true) return null // R08 dry run: nothing stored
    const body = rec(a.submission)
    const t = rec(body.target)
    const tpl = rec(body.template)
    const template = typeof tpl.slug === "string" && tpl.slug !== "" ? tpl.slug : null
    const missionRec = rec(t.mission)
    const mission = typeof missionRec.folder === "string" && missionRec.folder !== "" ? missionRec.folder : null
    const docKey = mission === null ? null : ((typeof t.docKey === "string" && t.docKey !== "" ? t.docKey : null) ?? template)
    const str = (v: unknown) => (typeof v === "string" && v !== "" ? v : null)
    return intentUnlessExisting({ documentId: str(t.documentId), docNumber: str(t.docNumber), mission, docKey }, { mission, docKey, template })
  })

  // The vendored tool only targets an existing documentId (doc-tools.ts slotFillTool); a missing one runs guarded.
  const slotFill = createWrapper("studio_slot_fill", async (a) => (a.dryRun === true ? null : intentUnlessExisting({ documentId: argStr(a, "documentId") }, { mission: null, docKey: null, template: null })))

  return [documentCreate, write, importMarkdown, chapterSubmit, slotFill]
}

/** Row 119d: what a create-path call would create. */
interface CreateIntent {
  /** mission folder of the target; null = none (documentId / docNumber target) */
  mission: string | null
  /** effective docKey (docKey ?? template slug); null = resolved by the pipeline */
  docKey: string | null
  /** template slug sent with the call; null = none */
  template: string | null
}

const rec = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {})
