/**
 * Validation of mission records against `studio.mission/v1` (spec §6.1): ajv 8.20.0 Ajv2020 with Studio's options
 * (vendor contract/index.ts:96 STUDIO_AJV_OPTIONS), no ajv-formats. Failures are SCHEMA_INVALID with the ajv
 * issues, capped like Studio's ingest validator (MAX_SCHEMA_ISSUES = 500, vendor services/ingest/validate.ts:31).
 * The C57 entities are not in the v1 schema (a schema change is v2, §6.1); they are checked in code here.
 */
import Ajv2020 from "ajv/dist/2020.js"
import type { ErrorObject, ValidateFunction } from "ajv"
import { StoreError } from "../errors.ts"
import { MISSION_SCHEMA_V1, MISSION_SCHEMA_V1_ID } from "./schema.ts"
import type { DecisionAnswer, NewDecisionRequest, NewMissionMessage } from "./types.ts"

export const MISSION_AJV_OPTIONS = { strict: true, allErrors: true, discriminator: true, allowUnionTypes: true } as const
export const MAX_MISSION_SCHEMA_ISSUES = 500

export type MissionSchemaDef = "MissionDoc" | "MissionTypeDoc" | "ReportEnvelope" | "StatusSnapshot" | "Row" | "Decision" | "Finding" | "SessionLink" | "Lock" | "Actor" | "MissionId" | "RowId" | "DecisionId"

let ajv: Ajv2020 | null = null
const compiled = new Map<string, ValidateFunction>()

function getAjv(): Ajv2020 {
  if (!ajv) {
    const a = new Ajv2020({ ...MISSION_AJV_OPTIONS })
    a.addSchema(MISSION_SCHEMA_V1)
    ajv = a
  }
  return ajv
}

function validatorOf(def: MissionSchemaDef | "root"): ValidateFunction {
  const ref = def === "root" ? MISSION_SCHEMA_V1_ID : `${MISSION_SCHEMA_V1_ID}#/$defs/${def}`
  let v = compiled.get(ref)
  if (!v) {
    v = getAjv().getSchema(ref)
    if (!v) throw new StoreError("SCHEMA_INVALID", `schema ref not found: ${ref}`)
    compiled.set(ref, v)
  }
  return v
}

export interface SchemaIssue {
  path: string
  keyword: string
  message: string
}

const DEP_PATTERN = "^[1-9][0-9]{0,3}[a-z]?:[BC]$"

/**
 * One ajv error as a message that says what is expected (rows 166, 169): enum lists the allowed values, const the
 * value, additionalProperties the unknown name, the deps pattern its "N:B" / "N:C" form. required ("must have
 * required property 'x'") and type ("must be object") already name it. Shared with the tool argument check.
 */
export function describeAjvError(e: ErrorObject): string {
  const p = e.params as Record<string, unknown>
  const base = e.message ?? e.keyword
  if (e.keyword === "enum" && Array.isArray(p.allowedValues)) return `${base}: ${p.allowedValues.map((v) => String(v)).join(", ")}`
  if (e.keyword === "const") return `must be ${JSON.stringify(p.allowedValue)}`
  if (e.keyword === "additionalProperties" && typeof p.additionalProperty === "string") return `${base}: "${p.additionalProperty}"`
  if (e.keyword === "pattern" && p.pattern === DEP_PATTERN) return `must be "<row id>:B" (build dependency) or "<row id>:C" (contract dependency), e.g. "1:B"`
  return base
}

function issuesOf(errors: ErrorObject[] | null | undefined): SchemaIssue[] {
  // An `if` error only repeats the `then` failure next to it (e.g. Model.reason required); drop it.
  return (errors ?? [])
    .filter((e) => e.keyword !== "if")
    .slice(0, MAX_MISSION_SCHEMA_ISSUES)
    .map((e) => ({ path: e.instancePath || "/", keyword: e.keyword, message: describeAjvError(e) }))
}

/** Validate `value` against one `$defs` entry (or the root `oneOf`); returns the issues, empty when valid. */
export function checkMissionSchema(def: MissionSchemaDef | "root", value: unknown): SchemaIssue[] {
  const v = validatorOf(def)
  return v(value) ? [] : issuesOf(v.errors)
}

/** Validate or throw SCHEMA_INVALID {def, issues}. */
export function assertMissionSchema(def: MissionSchemaDef | "root", value: unknown, at?: string): void {
  const issues = checkMissionSchema(def, value)
  if (issues.length > 0) throw new StoreError("SCHEMA_INVALID", `${at ?? def} does not match ${MISSION_SCHEMA_V1_ID}#/$defs/${def}`, { def, at, issues })
}

// ── C57 entities, checked in code ──────────────────────────────────────────

const CTRL = /[\u0000-\u001f]/
const OPTION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/
const REQUEST_ID = /^D-[0-9]{1,5}$/
const ROW_ID = /^[1-9][0-9]{0,3}[a-z]?$/
const ACTOR = /^[a-z0-9][a-z0-9._-]{0,63}$/

function text(v: unknown, max: number): boolean {
  return typeof v === "string" && v.length >= 1 && v.length <= max && !CTRL.test(v)
}

function invalid(at: string, issues: SchemaIssue[]): never {
  throw new StoreError("SCHEMA_INVALID", `${at} is malformed`, { at, issues })
}

// 1.2.8 row 45 (01d §2.1 rule 3, §4, SR8-17, R20-C35): the host mirror of opencode project/rehome.ts groupNameOk.
/** N8-150: one folder level, at most 60 characters, no leading dot, no slash. */
export const GROUP_NAME_PATTERN = /^[^./\\][^/\\]{0,59}$/
/** N8-445, compared case-insensitively. */
export const RESERVED_GROUP_NAMES = ["docs"] as const
const GROUP_KINDS = ["product", "institution", "theme"]
const MISSION_ID = /^\d{4}-\d{2}-\d{2}[_-][a-z0-9][a-z0-9_-]{0,80}$/

/** N8-150 plus SR8-17: NFC, no control, format, line or paragraph separator characters, no edge white space, no trailing dot, not reserved. */
export function groupNameOk(name: unknown): name is string {
  if (typeof name !== "string" || !GROUP_NAME_PATTERN.test(name)) return false
  if (name.normalize("NFC") !== name) return false
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(name)) return false
  if (name.trim() !== name || name.endsWith(".")) return false
  return !RESERVED_GROUP_NAMES.some((reserved) => reserved === name.toLowerCase())
}

/**
 * 1.2.8 row 45 (N8-146..N8-149, N8-454; 01d §3.3, §4, §5): `project-placement` options are exactly join, new, root in
 * that order (join omitted when no group exists), join/new carry `group` + `groupKind`, root none; `project-tidy`
 * options are exactly approve, decline with a `proposal` of 1-200 items (C8 OP-4: more go in another request).
 */
function topicIssues(r: NewDecisionRequest, bad: (path: string, message: string) => void): void {
  const opts = Array.isArray(r?.options) ? r.options : []
  const ids = opts.map((o) => o?.id).join(",")
  const placement = r?.topic === "project-placement"
  opts.forEach((o, i) => {
    const grouped = placement && (o?.id === "join" || o?.id === "new")
    if (!grouped && (o?.group !== undefined || o?.groupKind !== undefined)) bad(`/options/${i}`, "group and groupKind only on project-placement join/new options")
    if (grouped && !groupNameOk(o.group)) bad(`/options/${i}/group`, "a group folder name: one level, 1-60 characters, no leading dot, slash, edge space, trailing dot or format character; not docs")
    if (grouped && !GROUP_KINDS.includes(o.groupKind as string)) bad(`/options/${i}/groupKind`, "product, institution or theme")
  })
  if (r?.topic !== undefined && r.topic !== "project-placement" && r.topic !== "project-tidy") bad("/topic", "project-placement or project-tidy")
  if (placement && ids !== "join,new,root" && ids !== "new,root") bad("/options", "project-placement options are join, new, root in that order (join only when a group exists)")
  if (r?.topic === "project-tidy" && ids !== "approve,decline") bad("/options", "project-tidy options are approve, decline")
  if (r?.topic !== "project-tidy") {
    if (r?.proposal !== undefined) bad("/proposal", "only with topic project-tidy")
    return
  }
  const items = Array.isArray(r.proposal) ? r.proposal : []
  if (!Array.isArray(r.proposal) || items.length < 1 || items.length > 200) bad("/proposal", "1-200 items (maxItems 200: send more missions in another request)")
  const seen = new Set<string>()
  items.forEach((x, i) => {
    if (Object.keys(x ?? {}).some((k) => !["mission", "group", "groupKind"].includes(k))) bad(`/proposal/${i}`, "unknown field")
    if (typeof x?.mission !== "string" || !MISSION_ID.test(x.mission)) bad(`/proposal/${i}/mission`, "must be a mission id")
    else if (seen.has(x.mission)) bad(`/proposal/${i}/mission`, "duplicate mission")
    else seen.add(x.mission)
    if (x?.group !== null && !groupNameOk(x?.group)) bad(`/proposal/${i}/group`, "a group folder name, or null to stay at the root")
    if (x?.group !== null && !GROUP_KINDS.includes(x?.groupKind as string)) bad(`/proposal/${i}/groupKind`, "product, institution or theme")
    if (x?.group === null && x.groupKind !== undefined) bad(`/proposal/${i}/groupKind`, "only with a group")
  })
}

export function assertDecisionRequest(r: NewDecisionRequest): void {
  const issues: SchemaIssue[] = []
  const bad = (path: string, message: string) => issues.push({ path, keyword: "c57", message })
  const allowed = new Set(["id", "question", "context", "options", "recommended", "blockingRows", "topic", "proposal"])
  for (const k of Object.keys(r ?? {})) if (!allowed.has(k)) bad(`/${k}`, "unknown field")
  if (typeof r?.id !== "string" || !REQUEST_ID.test(r.id)) bad("/id", "must match ^D-[0-9]{1,5}$")
  if (!text(r?.question, 1000)) bad("/question", "1-1000 characters, no control characters")
  if (r?.context !== undefined && !text(r.context, 300)) bad("/context", "one line, 1-300 characters")
  const opts = Array.isArray(r?.options) ? r.options : []
  if (!Array.isArray(r?.options) || opts.length < 2 || opts.length > 8) bad("/options", "2-8 options")
  const ids = new Set<string>()
  opts.forEach((o, i) => {
    const keys = Object.keys(o ?? {})
    if (keys.some((k) => !["id", "label", "consequence", "group", "groupKind"].includes(k))) bad(`/options/${i}`, "unknown field")
    if (typeof o?.id !== "string" || !OPTION_ID.test(o.id)) bad(`/options/${i}/id`, "must match ^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$")
    else if (ids.has(o.id)) bad(`/options/${i}/id`, "duplicate option id")
    else ids.add(o.id)
    if (!text(o?.label, 300)) bad(`/options/${i}/label`, "one line, 1-300 characters")
    if (!text(o?.consequence, 300)) bad(`/options/${i}/consequence`, "one line, 1-300 characters")
  })
  if (r?.recommended !== undefined && !ids.has(r.recommended)) bad("/recommended", "must be one of the option ids")
  if (r?.blockingRows !== undefined) {
    if (!Array.isArray(r.blockingRows) || r.blockingRows.length > 64) bad("/blockingRows", "array of at most 64 row ids")
    else {
      if (new Set(r.blockingRows).size !== r.blockingRows.length) bad("/blockingRows", "row ids must be unique")
      r.blockingRows.forEach((x, i) => {
        if (typeof x !== "string" || !ROW_ID.test(x)) bad(`/blockingRows/${i}`, "must be a row id")
      })
    }
  }
  topicIssues(r, bad)
  if (issues.length > 0) invalid("decision request", issues)
}

export function assertDecisionAnswer(a: DecisionAnswer): void {
  const issues: SchemaIssue[] = []
  const bad = (path: string, message: string) => issues.push({ path, keyword: "c57", message })
  if (typeof a?.option !== "string" || !OPTION_ID.test(a.option)) bad("/option", "must be an option id")
  if (a?.by !== "user" && a?.by !== "controller") bad("/by", "user or controller")
  if (a?.text !== undefined && !text(a.text, 8000)) bad("/text", "1-8000 characters, no control characters")
  if (issues.length > 0) invalid("decision answer", issues)
}

const PARTIES = new Set(["controller", "agent", "owner"])
const KINDS = new Set(["report", "instruction", "question"])

export function assertMessage(m: NewMissionMessage): void {
  const issues: SchemaIssue[] = []
  const bad = (path: string, message: string) => issues.push({ path, keyword: "c57", message })
  const allowed = new Set(["from", "to", "kind", "text", "row", "actor"])
  for (const k of Object.keys(m ?? {})) if (!allowed.has(k)) bad(`/${k}`, "unknown field")
  if (!PARTIES.has(m?.from as string)) bad("/from", "controller, agent or owner")
  if (!PARTIES.has(m?.to as string)) bad("/to", "controller, agent or owner")
  if (m?.from === m?.to) bad("/to", "must differ from `from`")
  if (!KINDS.has(m?.kind as string)) bad("/kind", "report, instruction or question")
  if (!text(m?.text, 8000)) bad("/text", "1-8000 characters, no control characters")
  if (m?.row !== undefined && (typeof m.row !== "string" || !ROW_ID.test(m.row))) bad("/row", "must be a row id")
  if (m?.actor !== undefined && (typeof m.actor !== "string" || !ACTOR.test(m.actor))) bad("/actor", "must match the actor pattern")
  if (issues.length > 0) invalid("message", issues)
}

export function assertCheckpoint(n: unknown, m: unknown, label: unknown): void {
  const issues: SchemaIssue[] = []
  if (!Number.isInteger(m) || (m as number) < 1 || (m as number) > 1000) issues.push({ path: "/m", keyword: "c57", message: "integer 1-1000" })
  if (!Number.isInteger(n) || (n as number) < 0 || (Number.isInteger(m) && (n as number) > (m as number))) issues.push({ path: "/n", keyword: "c57", message: "integer 0..m" })
  if (label !== undefined && !text(label, 300)) issues.push({ path: "/label", keyword: "c57", message: "one line, 1-300 characters" })
  if (issues.length > 0) invalid("checkpoint", issues)
}

export function assertActor(actor: string): void {
  if (!ACTOR.test(actor)) invalid("actor", [{ path: "/actor", keyword: "pattern", message: "must match ^[a-z0-9][a-z0-9._-]{0,63}$" }])
}
