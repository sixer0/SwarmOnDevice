/**
 * Row 120: the /docs Markdown of one mission, rendered from the store (mission contract §9; decisions U19, C77 D3).
 *
 * Pure functions: MissionDoc (+ derived phases, the export snapshot, the event trail) in, Markdown out.
 * - Table headers are byte-identical to today's hand-written files (02_structured.md:151-152, 268-269;
 *   decisions.md:3-4; status_tasks.md:3-4). The delegation trail is new content (§9).
 * - In every cell a `|` is written as `\|`. Newlines cannot occur (the schema forbids control characters);
 *   a control character that slipped past would be written as a space, never as a line break.
 * - Only the tables are generated. The architect's prose stays hand-written (§9 rules).
 */
import type { DeliverableWire } from "../deliverables.ts"
import { ROW_KIND_LABELS, type MissionDecision, type MissionDerived, type MissionDoc, type MissionEventRecord, type MissionRow, type MissionStatusSnapshot, type RowStatus } from "../../../store/mission/types.ts"

/** The four files under docs/<mission>/ (§9), keyed by the `files` argument of studio_mission_export. */
export const EXPORT_PATHS = {
  blueprint: "identification/02_structured_rows.md",
  status: "status_tasks.md",
  decisions: "decisions/decisions.md",
  delegation: "delegation_progress_report.md",
} as const
export type ExportFileKey = keyof typeof EXPORT_PATHS

export const BLUEPRINT_HEADER = "| Step | Task Description | Agent_to_Invoke | Expected Output | Depends On | Verification | Phase |"
export const BLUEPRINT_RULE = "|------|------------------|-----------------|-----------------|------------|--------------|-------|"
export const PROFILE_HEADER = "| Step | Ownership Area | Deps (kind) | Size | Model | Shared Resources | Checks | Review |"
export const PROFILE_RULE = "|------|----------------|-------------|------|-------|------------------|--------|--------|"
export const DECISIONS_HEADER = "| # | Decision | By | Date |"
export const DECISIONS_RULE = "|---|---|---|---|"
export const STATUS_HEADER = "| Phase | Status |"
export const STATUS_RULE = "|---|---|"
export const DELEGATION_HEADER = "| Time (UTC) | Row | Actor | Event | From → To | Decision |"
export const DELEGATION_RULE = "|---|---|---|---|---|---|"
/** Row 86 (MC-08): the deliverables table of status_tasks.md, written only when the mission has deliverables. */
export const DELIVERABLES_HEADER = "| Document | Title | Rev | Row | Owner | Outputs |"
export const DELIVERABLES_RULE = "|---|---|---|---|---|---|"

/** Status groups of a phase cell, in the order of §9 (dropped last: a phase can hold dropped rows). */
export const STATUS_GROUP_ORDER: readonly RowStatus[] = ["done", "running", "blocked", "needs-review", "pending", "dropped"]

/** One Markdown table cell: `|` -> `\|`; control characters (never valid per schema) -> space. */
export function cell(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001f]/g, " ").replace(/\|/g, "\\|")
}

const orDash = (s: string | undefined | null): string => (s === undefined || s === null || s === "" ? "-" : s)

/** `"<rowId>:<B|C>"` -> its row id. */
const depId = (d: string): string => d.slice(0, d.lastIndexOf(":"))

/** Blueprint line (§9): `| {id} | {title} | {agent} | {output} | {dep ids joined ", " or -} | {verification} | {kind label} |`. */
export function blueprintLine(r: MissionRow): string {
  const deps = r.deps.length > 0 ? r.deps.map(depId).join(", ") : "-"
  return `| ${cell(r.id)} | ${cell(r.title)} | ${cell(r.agent)} | ${cell(r.output)} | ${cell(deps)} | ${cell(r.verification)} | ${cell(ROW_KIND_LABELS[r.kind])} |`
}

/** Profile line (§9): `| {id} | {ownership.text or -} | {deps "id:K" or -} | {size or -} | {tier[ (reason)]} | {resources or -} | {checks or -} | {review} |`. */
export function profileLine(r: MissionRow): string {
  const model = `${r.model.tier}${r.model.reason ? ` (${r.model.reason})` : ""}`
  const resources = (r.resources ?? []).join(", ")
  return `| ${cell(r.id)} | ${cell(orDash(r.ownership?.text))} | ${cell(orDash(r.deps.join(", ")))} | ${cell(orDash(r.size))} | ${cell(model)} | ${cell(orDash(resources))} | ${cell(orDash(r.checks))} | ${cell(r.review ?? "gate")} |`
}

/** `Dropped: <ids> (<decisions>)`, or `Dropped: -`. */
export function droppedLine(rows: readonly MissionRow[]): string {
  const dropped = rows.filter((r) => r.status === "dropped")
  if (dropped.length === 0) return "Dropped: -"
  const decisions = [...new Set(dropped.map((r) => r.decision).filter((d): d is string => typeof d === "string"))]
  return `Dropped: ${dropped.map((r) => r.id).join(", ")}${decisions.length > 0 ? ` (${decisions.join(", ")})` : ""}`
}

function missionLine(m: MissionDoc): string {
  return `Mission ${m.id} (${m.type} v${m.typeVersion}): ${m.title}`
}

/** identification/02_structured_rows.md: the blueprint and the Execution Profile of every non-dropped row in `ord` order. */
export function renderBlueprint(m: MissionDoc): string {
  const open = m.rows.filter((r) => r.status !== "dropped")
  return [
    "# Structured rows",
    "",
    `${missionLine(m)}.`,
    "Generated from the mission store (studio.mission/v1). Do not edit: change the rows through the mission tools. The prose stays in 02_structured.md.",
    "",
    "## Structured Task Breakdown",
    "",
    BLUEPRINT_HEADER,
    BLUEPRINT_RULE,
    ...open.map(blueprintLine),
    "",
    "## Execution Profile",
    "",
    PROFILE_HEADER,
    PROFILE_RULE,
    ...open.map(profileLine),
    "",
    droppedLine(m.rows),
    "",
  ].join("\n")
}

/** Sort key of a row id `^[1-9][0-9]{0,3}[a-z]?$`: number, then suffix. */
function idKey(id: string): [number, string] {
  const m = /^(\d+)([a-z]?)$/.exec(id)
  return m ? [Number(m[1]), m[2]!] : [Number.MAX_SAFE_INTEGER, id]
}

export function compareRowIds(a: string, b: string): number {
  const [na, sa] = idKey(a)
  const [nb, sb] = idKey(b)
  return na - nb || (sa < sb ? -1 : sa > sb ? 1 : 0)
}

/** Ids sorted, consecutive plain numeric ids collapsed into ranges: `1-21, 63, 65, 108a`. */
export function collapseIds(ids: readonly string[]): string {
  const sorted = [...ids].sort(compareRowIds)
  const out: string[] = []
  let i = 0
  while (i < sorted.length) {
    const id = sorted[i]!
    if (!/^\d+$/.test(id)) {
      out.push(id)
      i++
      continue
    }
    let j = i
    while (j + 1 < sorted.length && /^\d+$/.test(sorted[j + 1]!) && Number(sorted[j + 1]) === Number(sorted[j]) + 1) j++
    out.push(j > i ? `${id}-${sorted[j]}` : id)
    i = j + 1
  }
  return out.join(", ")
}

/** One phase cell: `done: 1-21, 63; running: 118; ...` (empty groups left out), or `-`. */
export function phaseCell(rows: ReadonlyArray<{ id: string; status: RowStatus }>): string {
  const parts = STATUS_GROUP_ORDER.map((s) => {
    const ids = rows.filter((r) => r.status === s).map((r) => r.id)
    return ids.length > 0 ? `${s}: ${collapseIds(ids)}` : null
  }).filter((p): p is string => p !== null)
  return parts.length > 0 ? parts.join("; ") : "-"
}

/** status_tasks.md: mission line, one line per phase of the type in order, Ready and Locks (from the export snapshot). */
/**
 * Row 86 (MC-08): one deliverables line: `| {docNumber} | {title} | rev {revisionNo} ({docRev}) | {rowId or -} | {owner} |
 * {outputs} |`. Owner is `this mission`, or the owning mission of a linked document (`linked from <id>`). Outputs are
 * the delivered file names (Studio's final name when the DATUM name is absent) with `verified` / `unverified`.
 */
export function deliverableLine(d: DeliverableWire): string {
  const owner = d.linked ? `linked from ${orDash(d.ownerMission)}` : "this mission"
  const outputs = d.outputs.map((o) => `${o.fileName ?? o.finalFileName} (${o.verified ? "verified" : "unverified"})`).join(", ")
  return `| ${cell(d.docNumber)} | ${cell(d.title)} | ${cell(`rev ${d.revisionNo} (${d.docRev})`)} | ${cell(orDash(d.rowId))} | ${cell(owner)} | ${cell(orDash(outputs))} |`
}

/** Row 86 (MC-08): the `## Deliverables` part of status_tasks.md; no lines at all when there is none (the file stays as before). */
export function deliverablesPart(list: readonly DeliverableWire[] | undefined): string[] {
  if (!list || list.length === 0) return []
  return ["## Deliverables", "", DELIVERABLES_HEADER, DELIVERABLES_RULE, ...list.map(deliverableLine), ""]
}

export function renderStatus(m: MissionDoc, derived: Pick<MissionDerived, "phases">, snap: { id: string; body: MissionStatusSnapshot }, deliverables?: readonly DeliverableWire[]): string {
  const byId = new Map(m.rows.map((r) => [r.id, r]))
  const c = snap.body.counts
  const total = c.pending + c.running + c["needs-review"] + c.blocked + c.done
  const state = `${snap.body.missionStatus}${m.supersededBy ? `, superseded by ${m.supersededBy}` : ""}`
  const locks = (snap.body.locks ?? []).map((l) => `${l.resource} (row ${l.row}, ${l.holder})`)
  const phases = [...derived.phases].sort((a, b) => a.order - b.order)
  return [
    "# Status",
    "",
    `${missionLine(m)}: ${state}; ${c.done}/${total} rows done.`,
    `Snapshot ${snap.id} (${snap.body.takenAt}, reason ${snap.body.reason ?? "-"}); counts ${STATUS_GROUP_ORDER.map((s) => `${s} ${c[s]}`).join(", ")}.`,
    "",
    STATUS_HEADER,
    STATUS_RULE,
    ...phases.map((p) => `| ${cell(p.id)} | ${cell(phaseCell(p.rows.map((id) => ({ id, status: byId.get(id)?.status ?? "pending" }))))} |`),
    "",
    `Ready: ${snap.body.ready && snap.body.ready.length > 0 ? snap.body.ready.join(", ") : "-"}`,
    `Locks: ${locks.length > 0 ? locks.join("; ") : "-"}`,
    "",
    ...deliverablesPart(deliverables),
  ].join("\n")
}

/** decisions/decisions.md: one line per decision in recorded order, By as User or Controller. */
export function decisionLine(d: MissionDecision): string {
  return `| ${cell(d.id)} | ${cell(d.text)} | ${d.by === "user" ? "User" : "Controller"} | ${cell(d.date)} |`
}

export function renderDecisions(m: MissionDoc): string {
  return ["# Decisions", "", DECISIONS_HEADER, DECISIONS_RULE, ...(m.decisions ?? []).map(decisionLine), ""].join("\n")
}

/** `2026-11-07T12:00:00.123Z` -> `2026-11-07 12:00:00` (UTC). */
export function utcTime(iso: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})/.exec(iso)
  return m ? `${m[1]} ${m[2]}` : iso
}

export function eventLine(e: MissionEventRecord): string {
  const fromTo = e.from || e.to ? `${e.from ?? "-"} → ${e.to ?? "-"}` : "-"
  return `| ${cell(utcTime(e.at))} | ${cell(orDash(e.row))} | ${cell(e.actor)} | ${cell(e.verb)} | ${cell(fromTo)} | ${cell(orDash(e.decision))} |`
}

/** delegation_progress_report.md: the mission_event trail (§9, new content). */
export function renderDelegation(m: MissionDoc, events: readonly MissionEventRecord[]): string {
  return [
    "# Delegation progress",
    "",
    `${missionLine(m)}. Generated from the mission event trail (${events.length} events, append-only).`,
    "",
    DELEGATION_HEADER,
    DELEGATION_RULE,
    ...events.map(eventLine),
    "",
  ].join("\n")
}
