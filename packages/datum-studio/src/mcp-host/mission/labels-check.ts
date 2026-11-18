/**
 * Swarm 1.3.3 row 62 (ST-9 item 2, owner decision U20): `labels_verified` is raised only from a decision recorded by
 * the user. This is the sign-off handler; `studio_mission_answer_decision` wraps its store call in `withLabelsCheck`.
 *
 * How the person is asked: an agent opens an ordinary decision request (studio_mission_request_decision) whose options
 * are `approve`, `decline` and whose one-line `context` is the labels-check line
 *
 *   labels_verified row=<row id> document=<document id> revision=<revision no> figures=<pid>,<pid>,...
 *
 * (`labelsCheckContext` builds it). The line is the request's topic and its naming at once: the `topic` column of a
 * decision request accepts two values under a CHECK constraint (migration 0008), so a third topic value needs a
 * migration that this row does not own. `labelsCheckOf` is the single place that reads the carrier.
 *
 * Who may answer: the person only. The trust check is the one `studio_mission_approve` uses, without its autonomous
 * exception: the stored decision is `by: user` (`mission_decision.by`, mission-store.ts `approve`), and the store's
 * decision sink accepts `by: user` only from an attested Mission Control request (`insertDecision`,
 * SESSION_NOT_ATTESTED). An answer `by: controller`, or from a request that is not attested, is refused with
 * LABELS_VERIFIED_PERSON_ONLY before anything is stored. After the answer is stored the handler reads the request and
 * the decision back from the store and acts on that record, never on the arguments of the call.
 *
 * What an approval does: for the figures the request names, as they were in the named revision, the flag is raised on
 * the current revision through row 61's `raiseLabelsVerified` (the only writer of the flag). A figure whose spec
 * differs from the named revision is not raised and is listed in the reply. When no figure of the row's documents is
 * left unchecked, the row's `awaitingHumanCheck` gets `clearedBy` (the decision id) and `clearedAt`.
 *
 * Not reachable from a tool input: no tool schema names it, no barrel exports it, and the raise call takes its
 * decision id from the stored answer (test/st9-labels-verified-person-only/row62-labels-check-unit.test.ts).
 *
 * 1.3.3 row 150 (senior S1): what happens to the deliverable after the person approves. The raise writes ONE revision
 * for all figures of the request (labels-verified-raise.ts). Then the person's decision renders that revision through
 * the path of an agent's `studio_render` (`renderAfterSignOff`: the vendored render service `renderScope`, wrapped by
 * row 154's `renderVerifyWrapper`, so the outputs are verified and recorded, and row 68's hook copies them into
 * `<project>/deliverables/<mission>/` and lists them on the row as `latest`). The render is the person's action: its
 * job's requester is `user:mission-control` (as the revision's `created_by`), the records' `verifiedBy` is
 * `studio_render/user:mission-control`, and the host log line and the reply name the decision.
 * Before row 150 the revision was never rendered: the row's deliverables kept the older revision (control sheet still
 * "Status: draf"), and row 70's gate refused the next labels-check request naming the document with
 * DELIVERABLE_NOT_IN_PROJECT because the current revision had no project copy. That cause is removed when the render
 * succeeds. When it cannot (renderer unavailable, render failed, not verified, copy refused) the revision and the
 * marker stay as the person decided, the reply says `render owed` with the cause, and the mission gets the open finding
 * `labels-render-r<row>` naming the document, the revision and the one call that refreshes it (`studio_render`); the
 * next successful sign-off render of that row marks the finding fixed. Until then row 70's gate keeps refusing
 * needs-review/done and a request naming the document (its own fix line says studio_render).
 */
import { withStudioTx } from "../../store-bridge/db.ts"
import type { StoreTx } from "../../store/index.ts"
import type { DecisionRequest, MissionStore } from "../../store/mission/index.ts"
import { PERSON_CALLER, raiseLabelsVerified, USER_DECISION_ID_RE, type RaiseLabelsVerifiedInput, type RaiseLabelsVerifiedResult } from "../local-api/labels-verified-raise.ts"
import type { HostToolNext } from "../tool-table.ts"
import { renderVerifyWrapper, type RenderVerifyStore } from "../verify/render-wrapper.ts"
import { MissionToolError, type MissionLog } from "./tool-result.ts"

/** First word of the context line of a labels-check request; equal to the row check name (register section 1). */
/** @internal test seam */
export const LABELS_CHECK_MARK = "labels_verified"
/** The only option id that approves. */
const LABELS_CHECK_APPROVE = "approve"
const LABELS_CHECK_DECLINE = "decline"
const SOURCE = "datum-studio-host.mission.labels-check"

interface LabelsCheckNaming {
  /** Mission row that waits for the check. */
  row: string
  documentId: string
  /** Revision the person is asked to check (the row's revision when it closed). */
  revisionNo: number
  /** Diagram block pids of that revision. */
  figures: string[]
}

const LINE_RE = /^labels_verified row=([A-Za-z0-9][A-Za-z0-9._-]{0,63}) document=([A-Za-z0-9_-]{1,64}) revision=([1-9][0-9]{0,8}) figures=([A-Za-z0-9_-]{1,64}(?:,[A-Za-z0-9_-]{1,64})*)$/

/** The context line of a labels-check request (at most 300 characters: the store's limit for `context`). */
/** @internal test seam */
export function labelsCheckContext(n: LabelsCheckNaming): string {
  return `${LABELS_CHECK_MARK} row=${n.row} document=${n.documentId} revision=${n.revisionNo} figures=${n.figures.join(",")}`
}

/**
 * null = the request is not a labels check (another topic). Otherwise the naming, or `malformed` when the line carries
 * the mark but names no figures in the fixed form.
 */
/** @internal test seam */
export function labelsCheckOf(req: { context?: unknown }): { naming?: LabelsCheckNaming; malformed?: string } | null {
  const line = typeof req?.context === "string" ? req.context : ""
  if (line !== LABELS_CHECK_MARK && !line.startsWith(`${LABELS_CHECK_MARK} `)) return null
  const m = LINE_RE.exec(line)
  if (!m) return { malformed: "the line must be: labels_verified row=<row id> document=<document id> revision=<n> figures=<pid>,<pid>" }
  const figures = m[4]!.split(",")
  if (new Set(figures).size !== figures.length) return { malformed: "a figure is named twice" }
  return { naming: { row: m[1]!, documentId: m[2]!, revisionNo: Number(m[3]), figures } }
}

/** Request-time check for studio_mission_request_decision (SCHEMA_INVALID issues; empty for any other request). */
/** @internal test seam */
export function labelsRequestIssues(req: { context?: unknown; options?: unknown }): Array<{ pointer: string; keyword: string; message: string }> {
  const check = labelsCheckOf(req ?? {})
  if (!check) return []
  const issues: Array<{ pointer: string; keyword: string; message: string }> = []
  if (typeof req.context === "string" && req.context.length > LABELS_CHECK_CONTEXT_MAX) issues.push({ pointer: "/request/context", keyword: "labels-check", message: SEVERAL })
  else if (!check.naming) issues.push({ pointer: "/request/context", keyword: "labels-check", message: check.malformed ?? "malformed" })
  const ids = (Array.isArray(req.options) ? req.options : []).map((o) => (o as { id?: unknown } | null)?.id).join(",")
  if (ids !== `${LABELS_CHECK_APPROVE},${LABELS_CHECK_DECLINE}`) issues.push({ pointer: "/request/options", keyword: "labels-check", message: "a labels check has exactly the options approve, decline" })
  return issues
}

/** The store's limit for `context`; with a 25-character document id about 17 figures fit in one request. */
const LABELS_CHECK_CONTEXT_MAX = 300
const LABELS_CHECK_FIGURES_ABOUT = 17
const SEVERAL = `one request holds about ${LABELS_CHECK_FIGURES_ABOUT} figures (context is at most ${LABELS_CHECK_CONTEXT_MAX} characters): send several requests, each naming other figures`

type Rec = Record<string, unknown>
const isRec = (v: unknown): v is Rec => v !== null && typeof v === "object" && !Array.isArray(v)

interface LabelsFigures {
  /** `document.mission_folder`. */
  missionFolder: string | null
  currentRevisionNo: number
  /** pid -> diagram spec in the named revision; null = the document has no such revision. */
  named: Map<string, unknown> | null
  /** pid -> diagram spec in the current revision. */
  current: Map<string, unknown>
}

/** @internal test seam */
export interface LabelsFigureSource {
  /** null = unknown document. */
  read(documentId: string, revisionNo: number): Promise<LabelsFigures | null>
}

/** Reads the stored diagram blocks (the same rows row 61's raise function reads). */
const STORED_FIGURES: LabelsFigureSource = {
  read(documentId, revisionNo) {
    return withStudioTx(async (tx) => {
      const doc = tx.get<{ current_revision_no: number; mission_folder: string | null }>("SELECT current_revision_no, mission_folder FROM document WHERE id = ?", [documentId])
      if (!doc) return null
      const currentRevisionNo = Number(doc.current_revision_no)
      const specs = (no: number): Map<string, unknown> | null => {
        if (!tx.get("SELECT 1 AS x FROM revision WHERE document_id = ? AND revision_no = ?", [documentId, no])) return null
        const rows = tx.all<{ pid: string; content: unknown }>(
          `SELECT b.pid AS pid, b.content AS content FROM doc_block b JOIN revision r ON r.id = b.revision_id
            WHERE r.document_id = ? AND r.revision_no = ? AND b.type = 'diagram' ORDER BY b.ordinal ASC`,
          [documentId, no],
        )
        return new Map(rows.map((b) => [String(b.pid), ((c: unknown) => (isRec(c) ? c.spec : undefined))(typeof b.content === "string" ? JSON.parse(b.content) : b.content)]))
      }
      return { missionFolder: doc.mission_folder ?? null, currentRevisionNo, named: specs(revisionNo), current: specs(currentRevisionNo) ?? new Map() }
    })
  },
}

/** Canonical JSON of a spec without the flag itself (keys sorted at every level). */
function specKey(spec: unknown): string {
  const walk = (x: unknown): unknown => (Array.isArray(x) ? x.map(walk) : isRec(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, walk(x[k])])) : x)
  if (!isRec(spec)) return JSON.stringify(walk(spec) ?? null)
  const { [LABELS_CHECK_MARK]: _flag, ...rest } = spec
  return JSON.stringify(walk(rest))
}
/** An inline diagram spec that the person has not checked (an artefact reference carries no labels of its own). */
const unchecked = (spec: unknown): boolean => isRec(spec) && typeof spec.artifactId !== "string" && spec[LABELS_CHECK_MARK] !== true

/**
 * Request-time check of studio_mission_request_decision: a label-check request that could not be answered is refused
 * before the person sees it (malformed line, wrong options, unknown row, unknown or foreign document, a figure that is
 * not an unchecked inline diagram of the named revision or that changed since). `note` is appended to the reply when
 * the document has unchecked figures the request does not name. Any other request: no issues, no note, no store read.
 */
export async function checkLabelsRequest(deps: Pick<LabelsCheckDeps, "store" | "figures">, mission: string, req: { context?: unknown; options?: unknown }): Promise<{ issues: Array<{ pointer: string; keyword: string; message: string }>; note: string }> {
  const issues = labelsRequestIssues(req)
  const naming = labelsCheckOf(req ?? {})?.naming
  if (!naming || issues.length > 0) return { issues, note: "" }
  const bad = (message: string) => void issues.push({ pointer: "/request/context", keyword: "labels-check", message })
  let documents: string[] = []
  try {
    documents = deps.store.missions.rowContract(mission, naming.row).deliverables.flatMap((d) => (d.documentId ? [d.documentId] : []))
  } catch {
    bad(`row ${naming.row} is not a row of this mission`)
    return { issues, note: "" }
  }
  if (documents.length > 0 && !documents.includes(naming.documentId)) bad(`document ${naming.documentId} is not a deliverable of row ${naming.row}`)
  const doc = await (deps.figures ?? STORED_FIGURES).read(naming.documentId, naming.revisionNo)
  if (!doc) bad(`document ${naming.documentId} is not in the store`)
  else if (doc.missionFolder !== mission) bad(`document ${naming.documentId} does not belong to this mission`)
  else if (!doc.named) bad(`document ${naming.documentId} has no revision ${naming.revisionNo} (current: ${doc.currentRevisionNo})`)
  else {
    for (const figure of naming.figures) {
      const cur = doc.current.get(figure)
      if (!doc.named.has(figure) || !doc.current.has(figure)) bad(`figure ${figure} is not a diagram of revision ${naming.revisionNo} and of the current revision ${doc.currentRevisionNo}`)
      else if (!unchecked(cur)) bad(`figure ${figure} needs no check (already checked, or it has no inline spec)`)
      else if (specKey(doc.named.get(figure)) !== specKey(cur)) bad(`figure ${figure} changed since revision ${naming.revisionNo}: name revision ${doc.currentRevisionNo}`)
    }
    const named = new Set(naming.figures)
    const others = [...doc.current.entries()].filter(([pid, spec]) => !named.has(pid) && unchecked(spec)).length
    if (issues.length === 0 && others > 0) return { issues, note: `\nlabels_verified: ${others} other figure(s) of document ${naming.documentId} are still unchecked; ${SEVERAL}` }
  }
  return { issues, note: "" }
}

type LabelsCheckOutcome =
  | "raised"
  | "not-approved"
  | "not-by-user"
  | "no-figures-named"
  | "row-unknown"
  | "document-unknown"
  | "document-not-of-mission"
  | "raise-failed"

type LabelsNotRaisedCause = "figure-changed-after-check" | "not-in-named-revision" | "not-in-current-revision" | "no-inline-spec"

/** @internal test seam */
export interface LabelsCheckResult {
  outcome: LabelsCheckOutcome
  /** Decision id of the stored answer. */
  decision?: string
  row?: string
  documentId?: string
  /** Current revision of the document after the call. */
  revisionNo?: number
  /** Figures whose flag this call set. */
  raised: string[]
  /** Named figures that were already true. */
  alreadyTrue: string[]
  /** Named figures left as they are, each with its cause. */
  notRaised: Array<{ figure: string; cause: LabelsNotRaisedCause }>
  /** Figures of the row's documents still unchecked after the call. */
  remaining?: number
  /** The row's awaitingHumanCheck was cleared for labels_verified by this call. */
  markerCleared: boolean
  /** Error code of a failed raise. */
  code?: string
  /** Row 150: the render of the new revision that the person's decision started (absent when nothing was raised). */
  render?: SignOffRender
}

/** Row 150: the render after a sign-off, as the reply and the log state it. */
interface SignOffRender {
  /** `rendered` = verified, copied to the project folder and listed on the row; `owed` = the next studio_render does it. */
  state: "rendered" | "owed"
  /** Whose action it is: the person's decision. */
  by: "user"
  decision: string
  documentId: string
  revisionNo: number
  /** Project paths of this revision's files listed on the row (rendered only). */
  files: string[]
  /** Why the render is owed: an error code (e.g. PDF_ENGINE_UNAVAILABLE) or a skip reason (not-verified, draft, ...). */
  cause?: string
  /** Mission finding that carries the owed render (`labels-render-r<row>`). */
  finding?: string
}

/** What a renderer reports back: the copied project files, or why it could not. */
type SignOffRenderOutcome = { ok: true; files: string[] } | { ok: false; cause: string }

interface SignOffRenderRequest {
  documentId: string
  revisionNo: number
  /** Formats of the row's current project files of this document (lower case); absent = the document's default. */
  formats?: string[]
  decision: string
  /**
   * Folder of the person's session that answered (`HostToolSession.fileRoot`): row 147's rule copies only into a
   * project folder inside the calling session's folder, and the person's answer is the calling session here.
   */
  sessionRoot: string
}

type SignOffRenderer = (req: SignOffRenderRequest) => Promise<SignOffRenderOutcome>

/** @internal test seam */
export interface LabelsCheckStore {
  readonly missions: MissionStore
  transaction<T>(fn: (tx: StoreTx) => Promise<T>, opts?: { timeoutMs?: number; correlationId?: string }): Promise<T>
}

/** @internal test seam */
export interface LabelsCheckDeps {
  store: LabelsCheckStore
  /** The host's persistent log. */
  log: MissionLog
  figures?: LabelsFigureSource
  raise?: (input: RaiseLabelsVerifiedInput) => Promise<RaiseLabelsVerifiedResult>
  /** Row 150: the render after a raise; default `renderAfterSignOff` over `store` (the installed store). */
  render?: SignOffRenderer
  now?: () => number
}

interface LabelsCheckCall {
  mission: string
  /** Decision request id (D-<n>). */
  request: string
  /** `by` of the answer as sent. */
  by: unknown
  /** The session of this call (attestation is set by the host per request, never by tool arguments). */
  session: { agentId: string; attested?: boolean; fileRoot?: string }
  dryRun: boolean
}

const nothing = (outcome: LabelsCheckOutcome, extra: Partial<LabelsCheckResult> = {}): LabelsCheckResult => ({ outcome, raised: [], alreadyTrue: [], notRaised: [], markerCleared: false, ...extra })

/**
 * Wraps the store call that answers a decision request. `answer` is called at most once. For a request that is not a
 * labels check the result of `answer` is returned unchanged.
 */
export async function withLabelsCheck<T extends { request: DecisionRequest }>(deps: LabelsCheckDeps, call: LabelsCheckCall, answer: () => Promise<T>): Promise<T & { labelsCheck?: LabelsCheckResult }> {
  const M = deps.store.missions
  const open = M.getDecisionRequest(call.mission, call.request)
  const isCheck = open !== null && labelsCheckOf(open) !== null
  if (isCheck && open.status === "open" && (call.by !== "user" || call.session.attested !== true)) {
    deps.log("warn", SOURCE, "LABELS_VERIFIED_PERSON_ONLY", { mission: call.mission, request: call.request, agent: call.session.agentId, by: call.by === "user" ? "user" : "controller" })
    throw new MissionToolError("LABELS_VERIFIED_PERSON_ONLY", "the check of figure labels is answered by the person only, in Mission Control in the Swarm app", { field: LABELS_CHECK_MARK, pointer: "/by", mission: call.mission, request: call.request })
  }
  const out = await answer()
  if (!isCheck || call.dryRun) return out
  const labelsCheck = await applyStoredAnswer(deps, call.mission, call.request, call.session.fileRoot ?? "")
  return labelsCheck ? { ...out, labelsCheck } : out
}

/** Acts on the answered request as the store holds it. */
async function applyStoredAnswer(deps: LabelsCheckDeps, mission: string, request: string, sessionRoot: string): Promise<LabelsCheckResult | undefined> {
  const M = deps.store.missions
  const stored = M.getDecisionRequest(mission, request)
  const check = stored ? labelsCheckOf(stored) : null
  if (!stored || !check || stored.status !== "answered" || !stored.answer) return undefined
  const decision = stored.answer.decision
  // The trust check of studio_mission_approve (mission_decision.by === "user"), without its autonomous exception,
  // plus the provenance the store wrote for this answer (attested Mission Control request).
  const record = M.get(mission)?.mission.decisions?.find((d) => d.id === decision)
  if (record?.by !== "user" || stored.answer.by !== "user" || stored.answer.attested !== true || !USER_DECISION_ID_RE.test(decision)) return nothing("not-by-user", { decision })
  if (stored.answer.option !== LABELS_CHECK_APPROVE) return nothing("not-approved", { decision })
  const naming = check.naming
  if (!naming) return nothing("no-figures-named", { decision })
  const base = { decision, row: naming.row, documentId: naming.documentId }
  let marker: ReturnType<MissionStore["rowContract"]>["awaitingHumanCheck"]
  try {
    marker = M.rowContract(mission, naming.row).awaitingHumanCheck
  } catch {
    return nothing("row-unknown", base)
  }

  const figures = deps.figures ?? STORED_FIGURES
  const raise = deps.raise ?? raiseLabelsVerified
  try {
    const doc = await figures.read(naming.documentId, naming.revisionNo)
    if (!doc) return nothing("document-unknown", base)
    if (doc.missionFolder !== mission) return nothing("document-not-of-mission", base)
    const notRaised: LabelsCheckResult["notRaised"] = []
    const pids: string[] = []
    for (const figure of naming.figures) {
      const then = doc.named?.get(figure)
      const cur = doc.current.get(figure)
      if (!doc.named || !doc.named.has(figure)) notRaised.push({ figure, cause: "not-in-named-revision" })
      else if (!doc.current.has(figure)) notRaised.push({ figure, cause: "not-in-current-revision" })
      else if (!isRec(cur) || typeof cur.artifactId === "string") notRaised.push({ figure, cause: "no-inline-spec" })
      else if (specKey(then) !== specKey(cur)) notRaised.push({ figure, cause: "figure-changed-after-check" })
      else pids.push(figure)
    }
    const done = pids.length > 0 ? await raise({ documentId: naming.documentId, pids, decisionId: stored.answer.decision, mission }) : { documentId: naming.documentId, raised: [], alreadyTrue: [], revisionNo: doc.currentRevisionNo }
    // Row 150: the new revision is rendered, verified and copied now, on the person's decision (never throws).
    const render = done.raised.length > 0 ? await renderSignedOff(deps, { mission, row: naming.row, documentId: naming.documentId, revisionNo: done.revisionNo, decision, sessionRoot }) : undefined

    // Figures of the row's documents that still wait: the named document and the row's latest deliverable documents.
    const others = new Set(M.rowContract(mission, naming.row).deliverables.flatMap((d) => (d.latest && d.documentId && d.documentId !== naming.documentId ? [d.documentId] : [])))
    let remaining = 0
    for (const id of [naming.documentId, ...others]) {
      const after = await figures.read(id, 1)
      if (after && after.missionFolder === mission) remaining += [...after.current.values()].filter(unchecked).length
    }
    let markerCleared = false
    if (marker && marker.clearedBy === undefined && marker.checks.includes(LABELS_CHECK_MARK) && notRaised.length === 0 && remaining === 0) {
      const rest = marker.checks.filter((c) => c !== LABELS_CHECK_MARK)
      const value = rest.length > 0 ? { ...marker, checks: rest } : { ...marker, clearedBy: decision, clearedAt: new Date((deps.now ?? Date.now)()).toISOString() }
      await deps.store.transaction(async (tx) => M.setAwaitingHumanCheck(tx, mission, naming.row, value))
      markerCleared = true
    }
    deps.log("info", SOURCE, "labels_verified raised from a user decision", { mission, request, decision, row: naming.row, documentId: naming.documentId, revisionNo: done.revisionNo, raised: done.raised.length, alreadyTrue: done.alreadyTrue.length, notRaised: notRaised.length, remaining, markerCleared, render: render?.state ?? "none", renderCause: render?.cause })
    return { outcome: "raised", ...base, revisionNo: done.revisionNo, raised: done.raised, alreadyTrue: done.alreadyTrue, notRaised, remaining, markerCleared, ...(render ? { render } : {}) }
  } catch (e) {
    // The answer is stored; the flag is not (or not fully). Persisted so the team finds it: the person is told in the reply.
    const code = typeof (e as { code?: unknown })?.code === "string" ? ((e as { code: string }).code) : "INTERNAL_ERROR"
    deps.log("error", SOURCE, "labels_verified raise failed after a user decision", { mission, request, decision, row: naming.row, documentId: naming.documentId, code, error: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? (e.stack ?? "") : "" })
    return nothing("raise-failed", { ...base, code })
  }
}

/** Finding that carries an owed sign-off render of a row (one per row; upserted). */
const signOffFindingId = (row: string): string => `labels-render-r${row}`

/**
 * Row 150: renders the signed-off revision, then records the outcome on the mission: an owed render opens the row's
 * finding, a successful one marks an open one fixed. Never throws: the decision and the raise are already stored.
 */
async function renderSignedOff(deps: LabelsCheckDeps, at: { mission: string; row: string; documentId: string; revisionNo: number; decision: string; sessionRoot: string }): Promise<SignOffRender> {
  const M = deps.store.missions
  const base = { by: "user" as const, decision: at.decision, documentId: at.documentId, revisionNo: at.revisionNo }
  // The formats the document was last delivered in: the row's latest project files, else its newest whole-document render.
  const known = M.rowContract(at.mission, at.row)
    .deliverables.filter((d) => d.documentId === at.documentId && d.latest)
    .map((d) => d.format.toLowerCase())
  const rendered =
    known.length > 0
      ? []
      : await deps.store
          .transaction(async (tx) =>
            tx
              .all<{ format: string }>(
                `SELECT DISTINCT format FROM output_file WHERE document_id = ? AND role = 'PRIMARY' AND scope_kind = 'DOCUMENT' AND draft = 0 AND render_job_id =
                   (SELECT render_job_id FROM output_file WHERE document_id = ? AND role = 'PRIMARY' AND scope_kind = 'DOCUMENT' AND draft = 0 ORDER BY time_created DESC, rowid DESC LIMIT 1)`,
                [at.documentId, at.documentId],
              )
              .map((r) => String(r.format).toLowerCase()),
          )
          .catch((e: unknown) => {
            deps.log("warn", SOURCE, "formats of the last render could not be read; the document's default formats are rendered", { mission: at.mission, row: at.row, documentId: at.documentId, message: e instanceof Error ? e.message : String(e) })
            return [] as string[]
          })
  const formats = [...new Set([...known, ...rendered].filter((f) => f === "pdf" || f === "docx" || f === "html"))]
  const outcome = await (deps.render ?? renderAfterSignOff(deps.store as unknown as RenderVerifyStore, deps.log))({ documentId: at.documentId, revisionNo: at.revisionNo, decision: at.decision, sessionRoot: at.sessionRoot, ...(formats.length > 0 ? { formats } : {}) }).catch(
    (e: unknown): SignOffRenderOutcome => ({ ok: false, cause: codeOf(e) }),
  )
  const finding = signOffFindingId(at.row)
  try {
    if (outcome.ok) {
      const open = M.get(at.mission)?.mission.findings?.find((f) => f.id === finding && f.status === "open")
      if (open) await deps.store.transaction(async (tx) => void M.recordFinding(tx, at.mission, { ...open, status: "fixed", decision: at.decision, evidence: `document ${at.documentId} revision ${at.revisionNo} rendered, verified and copied on decision ${at.decision}` }, { actor: "user" }))
      deps.log("info", SOURCE, "signed-off revision rendered on the person's decision", { mission: at.mission, row: at.row, ...base, files: outcome.files })
      return { state: "rendered", ...base, files: outcome.files }
    }
    await deps.store.transaction(async (tx) =>
      void M.recordFinding(
        tx,
        at.mission,
        {
          id: finding,
          severity: "medium",
          title: `Row ${at.row}: revision ${at.revisionNo} of document ${at.documentId} (label check ${at.decision}) is not rendered into the project folder yet`,
          sourceRow: at.row,
          ownerRow: at.row,
          status: "open",
          decision: at.decision,
          evidence: `render after the person's label check could not finish (${outcome.cause}). Next: call the tool datum-studio_studio_render for the whole document ${at.documentId}; it verifies the revision, copies it to the project folder and lists it on row ${at.row}. Until then the row's deliverables point at an older revision. Afterwards record this finding fixed.`,
        },
        { actor: "user" },
      ),
    )
    deps.log("warn", SOURCE, "signed-off revision not rendered; render owed", { mission: at.mission, row: at.row, ...base, cause: outcome.cause, finding })
    return { state: "owed", ...base, files: [], cause: outcome.cause, finding }
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e))
    deps.log("error", SOURCE, "sign-off render outcome could not be recorded on the mission", { mission: at.mission, row: at.row, ...base, ok: outcome.ok, code: codeOf(e), message: err.message, stack_trace: err.stack ?? "" })
    return outcome.ok ? { state: "rendered", ...base, files: outcome.files } : { state: "owed", ...base, files: [], cause: outcome.cause }
  }
}

const codeOf = (e: unknown): string => {
  const c = (e as { code?: unknown } | null)?.code
  return typeof c === "string" && /^[A-Z][A-Z0-9_]{1,60}$/.test(c) ? c : "RENDER_FAILED"
}

/**
 * Row 150: the production renderer. The vendored render service (`renderScope`, the service behind `studio_render`'s
 * route, as the person's caller) is the `next` of row 154's `studio_render` wrapper, so verification, its records and
 * row 68's project copy run exactly as for an agent's render. `ok` only when every output verified and the copy is
 * listed on a row.
 */
function renderAfterSignOff(store: RenderVerifyStore, log: MissionLog): SignOffRenderer {
  return async (req) => {
    const { assertRenderCapacity, renderScope } = await import("@/lib/studio/services/render")
    const wrapper = renderVerifyWrapper(store, { log })
    const next: HostToolNext = Object.assign(
      async (args: Record<string, unknown>) => {
        assertRenderCapacity()
        const formats = Array.isArray(args.formats) ? (args.formats as Array<"docx" | "pdf" | "html">) : undefined
        const r = await renderScope(PERSON_CALLER, req.documentId, { scope: "document", revisionNo: req.revisionNo, ...(formats ? { formats } : {}) })
        const errors = r.job.errors ?? r.errors ?? []
        return { content: [{ type: "text" as const, text: `render job ${r.job.id} ${r.job.status}` }], structuredContent: { ok: r.job.status === "SUCCEEDED", job: r.job, outputs: r.outputs, completeness: r.completeness, errors } }
      },
      { basis: { get: () => null, restore: () => undefined } },
    )
    const out = await wrapper.call({ documentId: req.documentId, revisionNo: req.revisionNo, ...(req.formats ? { formats: req.formats } : {}) }, { sessionId: "labels-check", agentId: PERSON_CALLER.requester, fileRoot: req.sessionRoot }, next)
    const sc = (out.structuredContent ?? {}) as Record<string, unknown>
    const job = sc.job as { status?: string; errors?: Array<{ code?: string }> } | undefined
    if (job?.status !== "SUCCEEDED") return { ok: false, cause: job?.errors?.[0]?.code ?? (Array.isArray(sc.errors) ? (sc.errors[0] as { code?: string } | undefined)?.code : undefined) ?? "RENDER_FAILED" }
    const verification = sc.verification as { overall?: string } | undefined
    const copy = sc.projectCopy as { ok?: boolean; recorded?: boolean; code?: string; reason?: string; files?: Array<{ path: string; latest?: boolean }> } | undefined
    if (verification?.overall !== "verified") return { ok: false, cause: "RENDER_UNVERIFIED" }
    if (copy?.ok !== true || copy.recorded !== true) return { ok: false, cause: copy?.code ?? (copy?.reason ? `project-copy-${copy.reason}` : "project-copy-not-recorded") }
    return { ok: true, files: (copy.files ?? []).filter((f) => f.latest !== false).map((f) => f.path) }
  }
}

const OUTCOME_TEXT: Record<Exclude<LabelsCheckOutcome, "raised">, string> = {
  "not-approved": "not approved, nothing raised",
  "not-by-user": "the stored answer is not a decision by the user, nothing raised",
  "no-figures-named": "the request names no figures, nothing raised",
  "row-unknown": "the request names a row this mission does not have, nothing raised",
  "document-unknown": "the request names a document the store does not have, nothing raised",
  "document-not-of-mission": "the named document does not belong to this mission, nothing raised",
  "raise-failed": "the flag could not be written; the decision is stored, the figures still wait for the check",
}

/** The reply line of studio_mission_answer_decision (empty for a request that is not a labels check). */
export function labelsCheckText(r: LabelsCheckResult | undefined): string {
  if (!r) return ""
  const head = `\nlabels_verified (${r.decision ?? "-"}): `
  if (r.outcome !== "raised") return `${head}${OUTCOME_TEXT[r.outcome]}${r.code ? ` (${r.code})` : ""}`
  const parts = [`raised on ${r.raised.join(", ") || "-"} of document ${r.documentId} (now revision ${r.revisionNo})`]
  if (r.alreadyTrue.length > 0) parts.push(`already true: ${r.alreadyTrue.join(", ")}`)
  if (r.notRaised.length > 0) parts.push(`not raised: ${r.notRaised.map((n) => `${n.figure} (${n.cause})`).join(", ")}`)
  parts.push(r.markerCleared ? `row ${r.row} no longer waits for the label check` : `row ${r.row} still waits: ${r.remaining ?? 0} figure(s) unchecked`)
  if (r.render?.state === "rendered") parts.push(`rendered on this decision: revision ${r.render.revisionNo} verified and copied to the project folder (${r.render.files.length} files), row ${r.row} deliverables updated`)
  if (r.render?.state === "owed") parts.push(`render owed (${r.render.cause ?? "-"}): revision ${r.render.revisionNo} is stored but not yet in the project folder; next: call the tool datum-studio_studio_render for the whole document ${r.render.documentId}${r.render.finding ? `; finding ${r.render.finding}` : ""}`)
  return head + parts.join("; ")
}
