/**
 * Row 188 (decision L47): every mission refusal ends with the next correct call, so an agent does not guess (the
 * user's session hit SCHEMA_INVALID on an invented session id, MISSION_NOT_APPROVED on a row started before approval
 * and APPROVAL_NEEDS_USER_DECISION on a controller self-approval). The hint names the skill `mission-control`, which
 * holds the full call sequence (row 189).
 *
 * The hints never tell the agent to record a decision by: user (S186-03: the agent never answers as the user).
 *
 * 1.2.6 row 100a (G-03): the hints share their call shapes with the guide resource (mission-guide.ts), so a hint and
 * studio://skema/mission never disagree (top-level autonomous, per-patch results, noteSaved, idempotent set_status).
 */
import Ajv, { type ValidateFunction } from "ajv"
import { BUILTIN_MISSION_TYPES } from "../../store/mission/builtin-types.ts"
import { MISSION_TRANSITIONS, ROW_RUNNING_DONE_RULE, ROW_TRANSITIONS } from "../../store/mission/mission-store.ts"
import { MISSION_SCHEMA_V1 } from "../../store/mission/schema.ts"
import type { MissionStatus, RowStatus } from "../../store/mission/types.ts"
import { assertCheckpoint, assertDecisionRequest, assertMessage, checkMissionSchema, describeAjvError, type MissionSchemaDef } from "../../store/mission/validate.ts"
import { AUTONOMOUS_DECISION_SHAPE, ROW_PATCH_RESULT_SHAPE } from "./mission-guide.ts"
import { fillMissionDefaults, modelForAgent, type MissionTypeLookup } from "./row-defaults.ts"
import { MISSION_TOOL_SCHEMAS } from "./schemas.ts"

export const MISSION_SKILL = "mission-control"

const AUTONOMOUS_APPROVAL = `only if Swarm's autonomous mode setting is on (the person turns it on): ${AUTONOMOUS_DECISION_SHAPE} then studio_mission_approve {mission, decision: C<n>}`
const ASK_USER = "request a decision with studio_mission_request_decision and wait for the user's answer"

const NEXT: Record<string, string> = {
  MISSION_NOT_APPROVED: `the mission is still draft: ${ASK_USER}, or ${AUTONOMOUS_APPROVAL}; then studio_mission_set_status {to: running} and update rows`,
  APPROVAL_NEEDS_USER_DECISION: `${ASK_USER} and approve with the decision it records, or ${AUTONOMOUS_APPROVAL}; never record by: user yourself`,
  DECISION_REQUIRED: `pass decision: the id of a recorded decision (${ASK_USER}, or ${AUTONOMOUS_APPROVAL})`,
  AUTONOMOUS_MODE_OFF: "Swarm's autonomous mode setting is off for this session (the person turns it on; you cannot): ask the person in Mission Control with studio_mission_request_decision and wait for the answer, then studio_mission_approve with the decision it records; never record by: user yourself",
  DECISION_UNKNOWN: "record the decision first with studio_mission_record_decision (controller ids C<n>), or read the ids with studio_mission_get {include: [decisions]}",
  DECISION_ID_TAKEN: "decisions are append-only: use a new id (read the taken ids with studio_mission_get {include: [decisions]}); a correction is a new decision with supersedes",
  DECISION_PENDING: "a decision request blocks this row: wait for the answer (studio_mission_get {include: [requests]}) and retry",
  MISSION_EMPTY: "add rows first: studio_mission_update_row {rows: [{id, add: {...}}]}, then studio_mission_approve",
  MISSION_NOT_FOUND: "list the missions with studio_mission_list, or create one with studio_mission_create {mission, dryRun: true} first",
  MISSION_REQUIRED: "name the mission: pass mission: <mission id> (studio_mission_list shows the ids)",
  MISSION_ID_TAKEN: "pick a new id (YYYY-MM-DD_slug), or continue the existing mission with studio_mission_get",
  MISSION_PAUSED: "resume first: studio_mission_set_status {to: running}",
  MISSION_CLOSED: "the mission is done or cancelled: create a new mission with studio_mission_create (supersede if it replaces it)",
  MISSION_ROWS_OPEN: `finish or drop the open rows with studio_mission_update_row (done or dropped with note; check ${ROW_PATCH_RESULT_SHAPE}: a patch can be refused while the call succeeds), then studio_mission_set_status {to: done}`,
  STATUS_TRANSITION: `read the allowed targets in rincian.allowed (rows: ${ROW_RUNNING_DONE_RULE}; a mission set to the status it already has returns unchanged: true, not this error); the lifecycle is create -> approve -> set_status running -> update_row per step -> gate -> set_status done`,
  KIND_NOT_ALLOWED: "the row's kind is not a kind of its phase for this mission type: use one of the kinds in rincian.allowed, or read the phase-kind matrix in the guide resource studio://skema/mission (section Mission types) and fix the row's phase or kind",
  PHASE_UNKNOWN: "the row's phase is not a phase of this mission type: read the phase-kind matrix in the guide resource studio://skema/mission (section Mission types), use a phase of the mission's type (rincian.allowed when present) and a kind that phase allows",
  ROW_UNKNOWN: "read the row ids with studio_mission_get {include: [rows]}",
  ROW_CLOSED: "the row is done or dropped: add a new row with studio_mission_update_row {rows: [{id, add: {...}}]}",
  DEP_NOT_DONE: "finish the build (:B) dependency first; studio_mission_get shows ready rows in derived.ready. Notes are never gated by dependencies: send the note as its own patch (a note in the refused status patch is kept, results[].noteSaved: true)",
  // 1.2.8 row 39 (MEM-e, N8-013).
  MEMORY_INDEX_MISSING: 'write the mission index entry first: remember {kind: "index", missionId: "<id>", text: "YYYY-MM-DD <id> | <outcome> | triggers: k1, k2 | <report path>"}, then studio_mission_set_status {to: done}',
  // 1.2.8 row 45 (PROJ-b, N8-145).
  PLACE_DECISION_UNANSWERED: 'ask the person with studio_mission_request_decision {topic: "project-placement", …} and wait for the answer; only the answer moves a mission',
  // 1.2.8 row 45b (SR8-05, N8-460).
  SESSION_NOT_ATTESTED: 'agents never move a mission: ask the person with studio_mission_request_decision {topic: "project-placement", …}; Mission Control places it on their answer',
  // 1.3.3 row 6 (register section 2).
  // 1.3.3 row 70: one call per cause (rincian.fix names it; rincian.expected lists each project path).
  DELIVERABLE_NOT_IN_PROJECT:
    "rincian.expected names each project file of the document's current revision: cause missing -> studio_render that document (whole document, current revision), which verifies it and makes the project copy, then retry; cause sha-mismatch (changed by hand, a render does not overwrite it) or PROJECT_UNWRITABLE (the project folder cannot be written) -> only the person can fix it: ask with studio_mission_request_decision and wait for the answer",
  KNOWLEDGE_NOT_CONSULTED: "call the tool datum-studio_studio_library_read with the path, mission and row the message names (or another file of rincian.domains, same mission and row), or send knowledgeReason with the row patch saying why the library does not apply, then retry done",
  PROJECT_UNWRITABLE: "only the person can fix the project folder: ask with studio_mission_request_decision and wait for the answer, then retry",
  LABELS_VERIFIED_PERSON_ONLY: "labels_verified is set by the person in Mission Control in the Swarm app: send the call without labels_verified (or with false) and ask the person with studio_mission_request_decision when the labels need their check",
  // 1.3.3 row 70 (row 66 request, row 67 wording): a note never lifts the output gate.
  OUTPUT_UNVERIFIED: "call the tools in rincian.fix for each output's missing[] (what each lacks is in the periksa block), then retry done; when rincian.fix is absent only the person can act: ask with studio_mission_request_decision",
  // 1.2.8 row 31 (H-N12, N8-202).
  SESSION_UNKNOWN: "omit session; Swarm links the calling session itself",
  AGENT_ID_LOCKED: "omit session.client (it is this MCP session's agent), or omit session entirely; Swarm fills it",
  SCHEMA_INVALID: "fix the fields named in rincian.issues or rincian.field (a row done straight from running needs a note) (guide: resource studio://skema/mission; create with dryRun: true first); omit session, Swarm fills it",
  STORE_BUSY: "retry the same call once",
  STORE_TX_TIMEOUT: "retry the same call once",
  INTERNAL_ERROR: "retry once; if it repeats, report it to the user (the host log has the details)",
}

/**
 * 1.2.9 row 50 (AC-C01, N9-003, N9-002 as amended by S9-02): hints that depend on the refused tool, keyed
 * `<tool>:<code>`, looked up before NEXT. A by: user answer or decision from an unattested session is refused; the
 * hint never says by: user and never tells the agent to answer as itself.
 */
const PERSON_ONLY =
  "only the person answers as the person, in Mission Control in the Swarm app: ask with studio_mission_request_decision and wait for the answer; only when Swarm's autonomous mode is on may you record your own C<n> decision (by: controller, autonomous: true)"
/**
 * 1.2.10 row 74 (B10-11, N10-008): an owner message (messages[].from: "owner") from an unattested session. The hint
 * tells the agent to send as agent or controller and to ask the person; it names no way to write as the owner.
 */
const OWNER_ONLY =
  "owner messages come only from the person, in Mission Control in the Swarm app: send yours as from: agent or from: controller, and ask the person with studio_mission_request_decision when you need an answer"
const NEXT_BY_TOOL: Record<string, string> = {
  "studio_mission_answer_decision:SESSION_NOT_ATTESTED": PERSON_ONLY,
  "studio_mission_record_decision:SESSION_NOT_ATTESTED": PERSON_ONLY,
  // 1.2.10 row 74 (N10-009): create keeps PERSON_ONLY (a by: user decision); update_row is the owner-message refusal.
  "studio_mission_create:SESSION_NOT_ATTESTED": PERSON_ONLY,
  "studio_mission_update_row:SESSION_NOT_ATTESTED": OWNER_ONLY,
}

const FALLBACK = "read the mission with studio_mission_get and fix what rincian names, then retry the same call"

/** The next correct call after a refusal `code` of `tool` (always ends with the skill name). */
export function nextCall(code: string, tool?: string): string {
  return `${(tool !== undefined ? NEXT_BY_TOOL[`${tool}:${code}`] : undefined) ?? NEXT[code] ?? FALLBACK} (skill: ${MISSION_SKILL})`
}

// ── 1.3.3 row 17 (MC-4 items 2-3, register section 2): `corrected` or `fields` on SCHEMA_INVALID / STATUS_TRANSITION ──
//
// The refusal carries the same arguments made valid (`corrected`), or the wrong fields with their legal values
// (`fields`). The server never applies a correction: the agent sends it again. A correction is built only when it is
// CERTAIN, which here means every change is one of:
//   1. a value moved to the place the schema gives it (a field outside its object, a row field outside `set`/`add`,
//      a snake_case name, `checkpoint.id` for the patch id), or a copy of a value that is already there, dropped;
//   2. a JSON string where an array or object belongs, parsed; an argument name that swallowed its JSON value, restored;
//   3. an enum value with exactly one legal value at spelling distance (case, separators, at most two edits);
//   4. an empty value ("" or null) on an optional field, removed; a `topic` that is not a reserved topic, removed;
//      an `include` value of the read tool that names no section, removed;
//   5. a lock name that only differs from the legal form by letter case, lower-cased;
//   6. a status move that lacks exactly one step, and that step is `running` (rows) or the single status in between
//      (missions): the step is put in front. A row added `running` is added `pending` and started by a second patch.
//      A status the row already has is taken out of the patch.
// Never: text written for the agent (title, note, reason, decision id, option), text cut to a limit (a `context`
// over 300 characters is named with the limit; only its line breaks are folded when it then fits), or a guess between
// two legal values. The result is checked again here (`localIssues`) and is returned only when that check is clean.

type Rec = Record<string, unknown>
export interface LocalIssue {
  pointer: string
  keyword: string
  message: string
}
export interface CorrectedArgs {
  arguments: Rec
  changed: string
}
export interface RefusalField {
  field: string
  allowed: string | unknown[]
}
export interface Correction {
  corrected?: CorrectedArgs
  fields?: RefusalField[]
  /** Replaces the static hint (the running -> done note case: one example call). Without the skill suffix. */
  next?: string
  /** Replaces the message (the note case names the row and the field). */
  message?: string
}

export const CORRECTABLE_CODES: ReadonlySet<string> = new Set(["SCHEMA_INVALID", "STATUS_TRANSITION"])
export const MAX_REFUSAL_FIELDS = 10
const MAX_CHANGED = 300
const MAX_CORRECTED_JSON = 24_000
const NOTE_ALLOWED = "one line, 1-4000 characters: the check you ran and its result"
const NOTE_PLACEHOLDER = "<the check you ran and its result>"

const isRec = (v: unknown): v is Rec => v !== null && typeof v === "object" && !Array.isArray(v)
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const camel = (k: string) => k.replace(/[_-]+([a-zA-Z0-9])/g, (_m, c: string) => c.toUpperCase())
const DEFS = MISSION_SCHEMA_V1.$defs as Record<string, { properties?: Rec; required?: string[] }>
const propsOf = (def: string) => DEFS[def]?.properties ?? {}
const ROW_PATCH_PROPS = ((MISSION_TOOL_SCHEMAS.studio_mission_update_row.properties as Rec).rows as { items: { properties: Rec } }).items.properties
/** Row fields a patch may change through `set` (the row schema without id, status, note, decision and the host fields). */
const ROW_SET_FIELDS = ["phase", "kind", "title", "agent", "model", "ownership", "deps", "size", "output", "verification", "resources", "checks", "review"]
const ROW_ADD_FIELDS = [...ROW_SET_FIELDS, "id", "status", "note", "decision"]
const REQUEST_FIELDS: Rec = { id: {}, question: {}, context: {}, options: { type: "array" }, recommended: {}, blockingRows: { type: "array" }, topic: {}, proposal: { type: "array" } }
const TOPICS = ["project-placement", "project-tidy"]
const PARTIES = ["controller", "agent", "owner"]
/** The object argument of a tool and the fields it may hold (the server parses a JSON string in it itself). */
const CONTAINER: Record<string, { key: string; props: Rec; def?: MissionSchemaDef }> = {
  studio_mission_create: { key: "mission", props: propsOf("MissionDoc") },
  studio_mission_record_decision: { key: "decision", props: propsOf("Decision"), def: "Decision" },
  studio_mission_record_finding: { key: "finding", props: propsOf("Finding"), def: "Finding" },
  studio_mission_request_decision: { key: "request", props: REQUEST_FIELDS },
}

const toolAjv = new Ajv({ allErrors: true, strict: true })
const toolValidators = new Map<string, ValidateFunction>()
function toolValidator(tool: string): ValidateFunction | undefined {
  const schema = MISSION_TOOL_SCHEMAS[tool]
  if (!schema) return undefined
  if (!toolValidators.has(tool)) toolValidators.set(tool, toolAjv.compile(schema))
  return toolValidators.get(tool)
}

const join = (base: string, path: string) => (path === "/" || path === "" ? base || "/" : `${base}${path}`)
function storeIssues(base: string, check: () => void): LocalIssue[] {
  try {
    check()
    return []
  } catch (e) {
    const issues = (e as { details?: { issues?: Array<{ path: string; keyword: string; message: string }> } }).details?.issues
    if (!Array.isArray(issues)) throw e
    return issues.map((i) => ({ pointer: join(base, i.path), keyword: i.keyword, message: i.message }))
  }
}
const schemaIssues = (base: string, def: MissionSchemaDef, value: unknown): LocalIssue[] => checkMissionSchema(def, value).map((i) => ({ pointer: join(base, i.path), keyword: i.keyword, message: i.message }))
const BUILTIN_TYPES: MissionTypeLookup = { type: (id) => BUILTIN_MISSION_TYPES.find((t) => t.id === id) ?? null, typeOfMission: () => null }
/** phase and kind come from the mission's type, which only the store knows: their absence is not an issue here. */
const typeFilled = (i: LocalIssue) => i.keyword === "required" && /'(phase|kind)'$/.test(i.message)

/**
 * What can be checked without the store: the tool's input schema, then the records the call carries (rows to add with
 * their server defaults, finding, decision, decision request, checkpoints, messages) and two rules that need no
 * state (a row is added pending or dropped; one row is not moved to the same status twice in one call). Empty = the
 * call can only still be refused for the mission's state. The arguments are not changed.
 */
export function localIssues(tool: string, args: Rec): LocalIssue[] {
  const a = structuredClone(args)
  const c = CONTAINER[tool]
  if (c && typeof a[c.key] === "string") {
    try {
      const parsed: unknown = JSON.parse(a[c.key] as string)
      if (isRec(parsed)) a[c.key] = parsed
    } catch {
      // left as sent: the schema check below names it
    }
  }
  const v = toolValidator(tool)
  if (v && !v(a)) return (v.errors ?? []).map((e) => ({ pointer: e.instancePath || "/", keyword: e.keyword, message: describeAjvError(e) }))
  const out: LocalIssue[] = []
  if (tool === "studio_mission_create" && isRec(a.mission)) {
    fillMissionDefaults(tool, a, BUILTIN_TYPES)
    const m = a.mission
    out.push(...schemaIssues("/mission", "MissionDoc", { $schema: "studio.mission/v1", typeVersion: 1, status: "draft", ...m, project: { dir: "/project", ...(isRec(m.project) ? m.project : {}) } }).filter((i) => !typeFilled(i)))
  }
  if (c?.def && isRec(a[c.key])) out.push(...schemaIssues(`/${c.key}`, c.def, tool === "studio_mission_record_decision" && a.autonomous !== undefined ? { autonomous: a.autonomous, ...(a[c.key] as Rec) } : a[c.key]))
  if (tool === "studio_mission_request_decision" && isRec(a.request)) out.push(...storeIssues("/request", () => assertDecisionRequest(a.request as never)))
  if (tool === "studio_mission_update_row") {
    const last = new Map<string, unknown>()
    const rows = Array.isArray(a.rows) ? (a.rows as Rec[]) : []
    rows.forEach((p, i) => {
      if (isRec(p.add)) {
        const probe = structuredClone(p.add)
        fillMissionDefaults(tool, { rows: [{ id: p.id, add: probe }] }, BUILTIN_TYPES)
        if (probe.id !== p.id) out.push({ pointer: `/rows/${i}/add/id`, keyword: "const", message: `must be ${JSON.stringify(p.id)} (the patch id)` })
        out.push(...schemaIssues(`/rows/${i}/add`, "Row", probe).filter((x) => !typeFilled(x)))
        if (typeof probe.status === "string" && !["pending", "dropped"].includes(probe.status) && ROW_STATUSES.includes(probe.status)) out.push({ pointer: `/rows/${i}/add/status`, keyword: "enum", message: "must be equal to one of the allowed values: pending, dropped" })
        last.set(String(p.id), probe.status)
      }
      if (isRec(p.checkpoint)) out.push(...storeIssues(`/rows/${i}/checkpoint`, () => assertCheckpoint((p.checkpoint as Rec).n, (p.checkpoint as Rec).m, (p.checkpoint as Rec).label)))
      if (p.status !== undefined) {
        if (last.get(String(p.id)) === p.status) out.push({ pointer: `/rows/${i}/status`, keyword: "duplicate", message: `an earlier patch of this call already moves row ${String(p.id)} to ${String(p.status)}` })
        last.set(String(p.id), p.status)
      }
    })
    ;(Array.isArray(a.messages) ? a.messages : []).forEach((m, i) => out.push(...storeIssues(`/messages/${i}`, () => assertMessage(m as never))))
  }
  return out
}
const ROW_STATUSES: readonly string[] = Object.keys(ROW_TRANSITIONS)

/** Damerau-Levenshtein distance (adjacent transposition counts one). */
function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_x, i) => [i, ...Array<number>(b.length).fill(0)])
  for (let j = 1; j <= b.length; j++) d[0][j] = j
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1)
    }
  return d[a.length][b.length]
}
const fold = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "")
/** The one legal value a wrong spelling stands for: equal without case and separators, else one value within two edits (and under half its length). */
export function nearestLegal(value: unknown, legal: readonly string[]): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined
  const equal = legal.filter((l) => fold(l) === fold(value))
  if (equal.length > 0) return equal.length === 1 ? equal[0] : undefined
  const near = legal.filter((l) => ((d) => d <= 2 && d * 2 < fold(l).length)(distance(fold(value), fold(l))))
  return near.length === 1 ? near[0] : undefined
}
const enumValues = (message: string): string[] | undefined => ((m) => (m ? m[1].split(", ") : undefined))(/^must be equal to one of the allowed values: (.*)$/.exec(message))

function segments(pointer: string): string[] {
  return pointer === "/" || pointer === "" ? [] : pointer.slice(1).split("/")
}
function valueAt(root: unknown, pointer: string): unknown {
  return segments(pointer).reduce<unknown>((v, k) => (Array.isArray(v) ? v[Number(k)] : isRec(v) ? v[k] : undefined), root)
}
function setAt(root: unknown, pointer: string, value: unknown): void {
  const keys = segments(pointer)
  const parent = valueAt(root, `/${keys.slice(0, -1).join("/")}`)
  const k = keys[keys.length - 1]
  if (Array.isArray(parent)) parent[Number(k)] = value
  else if (isRec(parent)) parent[k] = value
}

/** A JSON string where the schema wants an array or object (or, with no declared type, a string that is one). */
function unstring(value: unknown, schema: unknown): unknown {
  if (typeof value !== "string") return value
  const want = isRec(schema) && typeof schema.type === "string" ? schema.type : undefined
  if (want !== undefined && want !== "array" && want !== "object") return value
  if (!/^\s*[[{]/.test(value)) return value
  try {
    const parsed: unknown = JSON.parse(value)
    if (want === "array" ? Array.isArray(parsed) : want === "object" ? isRec(parsed) : parsed !== null && typeof parsed === "object") return parsed
  } catch {
    // not JSON: left as sent
  }
  return value
}

/** Move `from[key]` to `to[name]` when `to` lacks it; drop it when `to` holds the same value; false when they differ. */
function place(from: Rec, key: string, to: Rec, name: string, schema: unknown): "moved" | "dropped" | false {
  const v = unstring(from[key], schema)
  if (to[name] === undefined) {
    to[name] = v
    delete from[key]
    return "moved"
  }
  if (same(to[name], v) || same(to[name], from[key])) {
    delete from[key]
    return "dropped"
  }
  return false
}

interface Build {
  a: Rec
  changed: string[]
  /** A rule keyed on the refusal's own details did its work (transition, lock name). */
  cause: boolean
  /** Something was found that cannot be corrected with certainty: no `corrected` at all. */
  stop: boolean
}

function fixTopLevel(tool: string, b: Build): void {
  const { a } = b
  const props = (MISSION_TOOL_SCHEMAS[tool]?.properties ?? {}) as Rec
  const c = CONTAINER[tool]
  // 2. an argument name that swallowed its JSON value: `finding\n{...}\n</parameter` with an empty value.
  for (const key of Object.keys(a)) {
    const m = /^([A-Za-z][A-Za-z0-9_]*)\s+([[{][\s\S]*?)\s*(?:<\/[a-z_]*>?)?\s*$/.exec(key)
    if (!m || a[key] !== "" || !(m[1] in props) || a[m[1]] !== undefined) continue
    try {
      a[m[1]] = JSON.parse(m[2])
      delete a[key]
      b.changed.push(`${m[1]} restored from a damaged argument name`)
    } catch {
      // not JSON: left as sent
    }
  }
  for (const key of Object.keys(a)) {
    if (!(key in props)) continue
    const v = unstring(a[key], props[key])
    if (v === a[key]) continue
    a[key] = v
    if (c?.key !== key) b.changed.push(`${key} parsed from a JSON string`)
  }
  const one = tool === "studio_mission_update_row" && Array.isArray(a.rows) && a.rows.length === 1 && isRec(a.rows[0]) ? (a.rows[0] as Rec) : undefined
  const inner: { obj: Rec; props: Rec; label: string } | undefined = c && isRec(a[c.key]) ? { obj: a[c.key] as Rec, props: c.props, label: c.key } : one ? { obj: one, props: ROW_PATCH_PROPS, label: "rows[0]" } : undefined
  for (const key of Object.keys(a)) {
    if (key in props) continue
    const alias = camel(key)
    if (alias !== key && alias in props && !(inner && alias in inner.props)) {
      const r = place(a, key, a, alias, props[alias])
      if (r) b.changed.push(r === "moved" ? `${key} renamed ${alias}` : `${key} dropped (same value as ${alias})`)
      continue
    }
    const name = inner && key in inner.props ? key : inner && alias in inner.props ? alias : undefined
    if (!inner || name === undefined || name === "id") continue
    const r = place(a, key, inner.obj, name, inner.props[name])
    if (r) b.changed.push(r === "moved" ? `${key} moved into ${inner.label}${name === key ? "" : ` as ${name}`}` : `${key} dropped (${inner.label}.${name} holds the same value)`)
  }
}

function fixRecord(tool: string, b: Build): void {
  const c = CONTAINER[tool]
  const rec = c && isRec(b.a[c.key]) ? (b.a[c.key] as Rec) : undefined
  if (!c || !rec) return
  // 4. an empty value on an optional field of a finding or decision.
  if (c.def) {
    const required = DEFS[c.def]?.required ?? []
    for (const k of Object.keys(rec)) {
      if ((rec[k] !== "" && rec[k] !== null) || required.includes(k) || !(k in c.props)) continue
      delete rec[k]
      b.changed.push(`${c.key}.${k} removed (it was empty)`)
    }
  }
  if (tool !== "studio_mission_request_decision") return
  if (rec.topic !== undefined && !TOPICS.includes(rec.topic as string)) {
    const near = nearestLegal(rec.topic, TOPICS)
    if (near) {
      b.changed.push(`request.topic "${String(rec.topic).slice(0, 40)}" spelled ${near}`)
      rec.topic = near
    } else {
      delete rec.topic
      b.changed.push(`request.topic removed (it is only for ${TOPICS.join(" and ")}; a normal question has none)`)
    }
  }
  if (typeof rec.context === "string" && /[\u0000-\u001f]/.test(rec.context)) {
    const folded = rec.context.replace(/\s+/g, " ").trim()
    if (folded.length >= 1 && folded.length <= 300 && !/[\u0000-\u001f]/.test(folded)) {
      rec.context = folded
      b.changed.push("request.context put on one line")
    }
  }
}

function fixRows(code: string, message: string, details: Rec, b: Build): void {
  const { a } = b
  if (!Array.isArray(a.rows)) return
  const rows = a.rows as unknown[]
  for (const p of rows) {
    if (!isRec(p)) continue
    const at = `row ${typeof p.id === "string" ? p.id : "?"}`
    for (const k of ["acquire", "release", "retire"]) {
      const v = unstring(p[k], ROW_PATCH_PROPS[k])
      if (v !== p[k]) {
        p[k] = v
        b.changed.push(`${at}: ${k} parsed from a JSON string`)
      }
    }
    // 1. checkpoint.id / add.id for the patch id.
    for (const k of ["checkpoint", "add"]) {
      const inner = p[k]
      if (!isRec(inner) || typeof inner.id !== "string") continue
      if (p.id === undefined) {
        p.id = inner.id
        if (k === "checkpoint") delete inner.id
        b.changed.push(k === "checkpoint" ? `checkpoint.id ${inner.id ?? p.id} moved to the patch id` : `patch id ${String(p.id)} taken from add.id`)
      } else if (k === "checkpoint" && inner.id === p.id) {
        delete inner.id
        b.changed.push(`row ${String(p.id)}: checkpoint.id dropped (same as the patch id)`)
      }
    }
    // 1. a row field beside `set` / `add`.
    for (const key of Object.keys(p)) {
      if (key in ROW_PATCH_PROPS) continue
      const name = ROW_ADD_FIELDS.includes(key) ? key : camel(key)
      if (isRec(p.add) && ROW_ADD_FIELDS.includes(name)) {
        const r = place(p, key, p.add, name, undefined)
        if (r) b.changed.push(`${at}: ${key} ${r === "moved" ? "moved into add" : "dropped (add holds the same value)"}`)
      } else if (p.add === undefined && ROW_SET_FIELDS.includes(name) && (p.set === undefined || isRec(p.set))) {
        const set = (p.set ?? {}) as Rec
        const r = place(p, key, set, name, undefined)
        if (r) {
          p.set = set
          b.changed.push(`${at}: ${key} ${r === "moved" ? "moved into set" : "dropped (set holds the same value)"}`)
        }
      }
    }
    // `tier` beside the agent in a new row: dropped only when the server default for that agent is the same tier.
    if (isRec(p.add) && typeof p.add.tier === "string" && p.add.model === undefined) {
      const model = modelForAgent(p.add.agent)
      if (model.tier === p.add.tier) {
        b.changed.push(`${at}: add.tier dropped (model {tier: ${model.tier}} is the default of agent ${String(p.add.agent)})`)
        delete p.add.tier
      } else if (p.add.tier === "thinker" || p.add.tier === "inherit") {
        p.add.model = { tier: p.add.tier }
        delete p.add.tier
        b.changed.push(`${at}: add.tier written as add.model.tier`)
      }
    }
  }
  // 5. lock names: the refusal carries the pattern in its message.
  const pattern = /^resource must match (\^.*\$)$/.exec(message)
  if (code === "SCHEMA_INVALID" && pattern) {
    const re = new RegExp(pattern[1])
    for (const p of rows) {
      if (!isRec(p)) continue
      for (const k of ["acquire", "release"]) {
        if (!Array.isArray(p[k])) continue
        p[k] = (p[k] as unknown[]).map((name) => {
          if (typeof name !== "string" || re.test(name)) return name
          if (!re.test(name.toLowerCase())) {
            b.stop = true
            return name
          }
          b.cause = true
          b.changed.push(`lock ${name} written ${name.toLowerCase()}`)
          return name.toLowerCase()
        })
      }
    }
  }
  // 6. a row added in a status other than pending: added pending, started by the next patch.
  for (let i = 0; i < rows.length; i++) {
    const p = rows[i]
    if (!isRec(p) || !isRec(p.add) || p.add.status !== "running" || p.status !== undefined || typeof p.id !== "string") continue
    p.add.status = "pending"
    rows.splice(i + 1, 0, { id: p.id, status: "running" })
    b.cause = true
    b.changed.push(`row ${p.id} is added pending (rows are added pending or dropped) and a second patch starts it`)
  }
  if (code === "STATUS_TRANSITION" && typeof details.from === "string" && typeof details.to === "string") {
    const { from, to } = details as { from: string; to: string }
    const i = rows.findIndex((p) => isRec(p) && p.id === details.row && p.status === to)
    const p = rows[i] as Rec | undefined
    const via = (ROW_TRANSITIONS[from as RowStatus] ?? []).filter((x) => (ROW_TRANSITIONS[x] ?? []).includes(to as RowStatus))
    const noted = typeof p?.note === "string" && p.note.length > 0
    if (p && from === to) {
      delete p.status
      b.cause = true
      b.changed.push(`row ${String(p.id)} is already ${to}: status taken out of its patch`)
    } else if (p && via.length === 1 && via[0] === "running" && (noted || !["done", "blocked", "dropped"].includes(to))) {
      rows.splice(i, 0, { id: p.id, status: "running" })
      b.cause = true
      b.changed.push(`row ${String(p.id)} ${from} -> ${to} needs running first: a patch {status: running} is put before it`)
    }
  }
  // the same status twice for one row in one call: the later one is taken out.
  const last = new Map<unknown, unknown>()
  for (const p of rows) {
    if (!isRec(p)) continue
    if (isRec(p.add)) last.set(p.id, p.add.status ?? "pending")
    if (p.status === undefined) continue
    if (last.get(p.id) === p.status) {
      b.changed.push(`row ${String(p.id)}: status ${String(p.status)} taken out of a later patch (an earlier patch of this call sets it)`)
      delete p.status
    } else last.set(p.id, p.status)
  }
  // a patch that holds nothing but its id does nothing: it leaves the call.
  a.rows = rows.filter((p) => !isRec(p) || Object.keys(p).some((k) => k !== "id"))
  if ((a.rows as unknown[]).length === 0) b.stop = true
}

function fixMissionStatus(details: Rec, b: Build): void {
  const { from, to, allowed } = details as { from?: string; to?: string; allowed?: string[] }
  if (typeof from !== "string" || typeof to !== "string" || !Array.isArray(allowed) || b.a.to !== to) return
  const settable = (MISSION_TOOL_SCHEMAS.studio_mission_set_status.properties as { to: { enum: string[] } }).to.enum
  const via = allowed.filter((x) => settable.includes(x) && (MISSION_TRANSITIONS[x as MissionStatus] ?? []).includes(to as MissionStatus))
  if (via.length !== 1) return
  b.a.to = via[0]
  b.cause = true
  b.changed.push(`mission ${from} -> ${to} needs ${via[0]} first: to is ${via[0]}; send to: ${to} after it`)
}

/** 3. enum spellings, from the issues of the local check; an `include` value of the read tool that is no section leaves the list. */
function fixEnums(tool: string, b: Build): void {
  for (let pass = 0; pass < 3; pass++) {
    const issues = localIssues(tool, b.a).filter((i) => i.keyword === "enum")
    let moved = false
    for (const i of issues.reverse()) {
      const legal = enumValues(i.message)
      const value = valueAt(b.a, i.pointer)
      const near = legal ? nearestLegal(value, legal) : undefined
      if (near !== undefined) {
        setAt(b.a, i.pointer, near)
        b.changed.push(`${i.pointer} "${String(value).slice(0, 40)}" spelled ${near}`)
        moved = true
      } else if (tool === "studio_mission_get" && /^\/include\/\d+$/.test(i.pointer) && Array.isArray(b.a.include) && b.a.include.length > 1) {
        b.a.include.splice(Number(i.pointer.split("/")[2]), 1)
        b.changed.push(`include value ${JSON.stringify(value).slice(0, 40)} removed (not a section of this tool)`)
        moved = true
      }
    }
    if (!moved) return
  }
}

function sentence(changed: string[]): string {
  let out = ""
  let shown = 0
  for (const c of changed) {
    const next = out ? `${out}; ${c}` : c
    if (next.length > MAX_CHANGED - 16) break
    out = next
    shown++
  }
  if (shown === 0) return `${changed[0].slice(0, MAX_CHANGED - 20)}... (${changed.length} changes)`
  return shown < changed.length ? `${out}; +${changed.length - shown} more.` : `${out}.`
}

/** `corrected`, or (when the certain changes do not make the call valid) what is still wrong after them. */
function buildCorrected(tool: string, code: string, message: string, details: Rec, args: Rec): { corrected?: CorrectedArgs; residual?: LocalIssue[] } {
  if (details.field === "note") return {}
  const before = localIssues(tool, args)
  const b: Build = { a: structuredClone(args), changed: [], cause: false, stop: false }
  fixTopLevel(tool, b)
  fixRecord(tool, b)
  if (tool === "studio_mission_update_row") fixRows(code, message, details, b)
  if (tool === "studio_mission_set_status" && code === "STATUS_TRANSITION") fixMissionStatus(details, b)
  fixEnums(tool, b)
  if (b.stop || b.changed.length === 0) return {}
  // The refusal's cause must be one this code can see: a local issue of the sent arguments, or a rule keyed on details.
  if (code === "STATUS_TRANSITION" ? !b.cause : before.length === 0 && !b.cause) return {}
  const residual = localIssues(tool, b.a)
  if (residual.length > 0) return { residual }
  if (JSON.stringify(b.a).length > MAX_CORRECTED_JSON) return {}
  return { corrected: { arguments: b.a, changed: sentence(b.changed) } }
}

const PATCH_FIELDS = Object.keys(ROW_PATCH_PROPS).join(", ")
function fieldOf(tool: string, i: LocalIssue, args: Rec | undefined): RefusalField {
  const name = /'([^']+)'$/.exec(i.message)?.[1]
  if (i.keyword === "required" && name) return { field: join(i.pointer === "/" ? "" : i.pointer, `/${name}`), allowed: "required" }
  const extra = i.keyword === "additionalProperties" ? /: "([\s\S]*)"$/.exec(i.message)?.[1] : undefined
  if (extra !== undefined) {
    const legal = i.pointer === "/" ? Object.keys((MISSION_TOOL_SCHEMAS[tool]?.properties ?? {}) as Rec).join(", ") : /^\/rows\/\d+$/.test(i.pointer) ? PATCH_FIELDS : undefined
    return { field: join(i.pointer === "/" ? "" : i.pointer, `/${extra.length > 60 ? `${extra.slice(0, 60)}...` : extra}`), allowed: `not a field of this object${legal ? `; its fields: ${legal}` : ""}` }
  }
  const legal = i.keyword === "enum" ? enumValues(i.message) : undefined
  if (legal) return { field: i.pointer, allowed: legal }
  const value = args ? valueAt(args, i.pointer) : undefined
  if (/^\/messages\/\d+\/to$/.test(i.pointer) && i.message.startsWith("must differ")) return { field: i.pointer, allowed: PARTIES.filter((x) => x !== value) }
  return { field: i.pointer, allowed: typeof value === "string" && /characters/.test(i.message) ? `${i.message} (sent: ${value.length})` : i.message }
}

/** The refusal's own issues with the argument path in front (used when the arguments are not at hand, or the cause is the store's). */
function detailIssues(tool: string, details: Rec): LocalIssue[] {
  if (!Array.isArray(details.issues)) return []
  const at = typeof details.at === "string" ? details.at : ""
  const base = at === "decision request" ? "/request" : at.startsWith("finding ") ? "/finding" : at.startsWith("row ") ? "/rows/*/add" : at === "checkpoint" ? "/rows/*/checkpoint" : at === "message" ? "/messages/*" : at === "decision answer" ? "" : ""
  return (details.issues as Array<{ pointer?: string; path?: string; keyword?: string; message?: string }>).map((i) => ({ pointer: join(base, i.pointer ?? i.path ?? "/"), keyword: String(i.keyword), message: String(i.message) }))
}

/** Field entries of issues: the anyOf echo of update_row (rows or messages) is not a field; one entry per field. */
function fieldsOf(tool: string, issues: LocalIssue[], args: Rec | undefined): RefusalField[] {
  const out = new Map<string, RefusalField>()
  for (const i of issues) {
    if (i.keyword === "anyOf" || (i.keyword === "required" && i.pointer === "/" && /'(rows|messages)'$/.test(i.message) && args && (args.rows !== undefined || args.messages !== undefined))) continue
    const f = fieldOf(tool, i, args)
    if (!out.has(f.field)) out.set(f.field, f)
  }
  return [...out.values()]
}

function buildFields(tool: string, code: string, message: string, details: Rec, args: Rec | undefined, residual: LocalIssue[] = []): RefusalField[] {
  const rows = args && Array.isArray(args.rows) ? (args.rows as unknown[]) : []
  const rowIndex = (pred: (p: Rec) => boolean) => ((i) => (i < 0 ? "*" : String(i)))(rows.findIndex((p) => isRec(p) && pred(p)))
  if (code === "STATUS_TRANSITION") {
    const allowed = Array.isArray(details.allowed) ? details.allowed : []
    if (tool !== "studio_mission_update_row") return [{ field: "/to", allowed }]
    const added = details.from === null
    const i = rowIndex((p) => p.id === details.row && (added ? isRec(p.add) : p.status === details.to))
    const out: RefusalField[] = [{ field: added ? `/rows/${i}/add/status` : `/rows/${i}/status`, allowed }]
    const p = rows[Number(i)]
    if (!added && ["done", "blocked", "dropped"].includes(String(details.to)) && isRec(p) && !(typeof p.note === "string" && p.note.length > 0)) out.push({ field: `/rows/${i}/note`, allowed: details.to === "done" ? NOTE_ALLOWED : "one line, 1-4000 characters: why" })
    return out
  }
  if (details.field === "note") return [{ field: `/rows/${rowIndex((p) => p.id === details.row && p.status === details.to)}/note`, allowed: NOTE_ALLOWED }]
  if (typeof details.resource === "string") {
    const out: RefusalField[] = []
    rows.forEach((p, i) => {
      for (const k of ["acquire", "release"]) if (isRec(p) && Array.isArray(p[k])) (p[k] as unknown[]).forEach((name, j) => name === details.resource && out.push({ field: `/rows/${i}/${k}/${j}`, allowed: message }))
    })
    return out.length > 0 ? out : [{ field: "/rows/*/acquire", allowed: message }]
  }
  // What is wrong in the arguments as sent, then what would still be wrong once that is put right (its paths are
  // those of the arguments after the first fields are fixed, e.g. inside `rows` once it is an array).
  const local = args ? fieldsOf(tool, [...localIssues(tool, args), ...residual], args) : []
  if (local.length > 0) return local
  if (Array.isArray(details.fields) && details.row !== undefined) return (details.fields as unknown[]).map((f) => ({ field: `/rows/${rowIndex((p) => p.id === details.row)}/${String(f)}`, allowed: `not a field of a row patch; its fields: ${PATCH_FIELDS}` }))
  return fieldsOf(tool, detailIssues(tool, details), undefined)
}

/**
 * What a SCHEMA_INVALID or STATUS_TRANSITION refusal adds: `corrected` when the correction is certain, else `fields`.
 * `args` are the arguments as the agent sent them (absent when the caller has none: then only `fields`, from details).
 * Never throws: a fault here must not hide the refusal itself.
 */
export function correctionFor(tool: string, code: string, message: string, details: Rec, args?: Rec): Correction {
  if (!CORRECTABLE_CODES.has(code)) return {}
  try {
    if (code === "SCHEMA_INVALID" && details.field === "note" && details.to === "done") {
      const row = typeof details.row === "string" ? details.row : "<row id>"
      const mission = args && typeof args.mission === "string" ? args.mission : "<mission id>"
      return {
        message: `row ${row}: missing field note. ${message}`,
        fields: buildFields(tool, code, message, details, args),
        next: `send the done patch again with note, in one call, call the tool datum-studio_studio_mission_update_row with mission "${mission}", and in rows one entry with id "${row}", status "done", note "${NOTE_PLACEHOLDER}" (the note is yours to write: the check and its result)`,
      }
    }
    const built = args && isRec(args) ? buildCorrected(tool, code, message, details, args) : {}
    if (built.corrected) return { corrected: built.corrected }
    const fields = buildFields(tool, code, message, details, args && isRec(args) ? args : undefined, built.residual).slice(0, MAX_REFUSAL_FIELDS)
    return fields.length > 0 ? { fields } : {}
  } catch {
    return {}
  }
}

/**
 * Ruling 3: the same for one patch that was refused inside an accepted studio_mission_update_row call. The store's
 * per-patch result keeps only the code and the message, so the details are read back from the message (the move
 * `row R from -> to`, the added-row rule, the note rule); any other message gives `fields` from the patch itself or
 * nothing. `arguments` hold that patch alone: the patches that applied are not sent again.
 */
export function patchCorrection(mission: string, decision: string | undefined, patch: Rec, code: string, message: string): Correction {
  if (!CORRECTABLE_CODES.has(code)) return {}
  const move = /^row (\S+) (\S+) -> (\S+) is not allowed$/.exec(message)
  const details: Rec =
    code === "STATUS_TRANSITION" && move
      ? { row: move[1], from: move[2], to: move[3], allowed: ROW_TRANSITIONS[move[2] as RowStatus] ?? [] }
      : code === "STATUS_TRANSITION" && isRec(patch.add)
        ? { row: patch.id, from: null, to: patch.add.status, allowed: ["pending", "dropped"] }
        : code === "SCHEMA_INVALID" && message === ROW_RUNNING_DONE_RULE
          ? { row: patch.id, field: "note", from: "running", to: "done" }
          : {}
  const { corrected, fields } = correctionFor("studio_mission_update_row", code, message, details, { mission, ...(decision !== undefined ? { decision } : {}), rows: [patch] })
  return { ...(corrected ? { corrected } : {}), ...(fields ? { fields } : {}) }
}
