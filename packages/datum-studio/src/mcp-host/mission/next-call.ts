/**
 * Row 188 (decision L47): every mission refusal ends with the next correct call, so an agent does not guess (the
 * user's session hit SCHEMA_INVALID on an invented session id, MISSION_NOT_APPROVED on a row started before approval
 * and APPROVAL_NEEDS_USER_DECISION on a controller self-approval). The hint names the skill `mission-control`, which
 * holds the full call sequence (row 189).
 *
 * The hints never tell the agent to record a decision by: user (S186-03: the agent never answers as the user).
 */
import { ROW_RUNNING_DONE_RULE } from "../../store/mission/mission-store.ts"

export const MISSION_SKILL = "mission-control"

const AUTONOMOUS_APPROVAL =
  "only if Swarm's autonomous mode setting is on (the person turns it on): studio_mission_record_decision {decision: {id: C<n>, by: controller, autonomous: true, date, text}} then studio_mission_approve {mission, decision: C<n>}"
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
  MISSION_ROWS_OPEN: "finish or drop the open rows with studio_mission_update_row (done or dropped with note), then studio_mission_set_status {to: done}",
  STATUS_TRANSITION: `read the allowed targets in rincian.allowed (rows: ${ROW_RUNNING_DONE_RULE}); the lifecycle is create -> approve -> set_status running -> update_row per step -> gate -> set_status done`,
  KIND_NOT_ALLOWED: "the row's kind is not a kind of its phase for this mission type: use one of the kinds in rincian.allowed, or read the phase-kind matrix in the guide resource studio://skema/mission (section Mission types) and fix the row's phase or kind",
  PHASE_UNKNOWN: "the row's phase is not a phase of this mission type: read the phase-kind matrix in the guide resource studio://skema/mission (section Mission types), use a phase of the mission's type (rincian.allowed when present) and a kind that phase allows",
  ROW_UNKNOWN: "read the row ids with studio_mission_get {include: [rows]}",
  ROW_CLOSED: "the row is done or dropped: add a new row with studio_mission_update_row {rows: [{id, add: {...}}]}",
  DEP_NOT_DONE: "finish the build (:B) dependency first; studio_mission_get shows ready rows in derived.ready",
  OUTPUT_UNVERIFIED: "verify the row's Studio outputs (done gate) or name the check and its result file in the row note, then retry done",
  AGENT_ID_LOCKED: "omit session.client (it is this MCP session's agent), or omit session entirely; Swarm fills it",
  SCHEMA_INVALID: "fix the fields named in rincian.issues or rincian.field (a row done straight from running needs a note) (guide: resource studio://skema/mission; create with dryRun: true first); omit session, Swarm fills it",
  STORE_BUSY: "retry the same call once",
  STORE_TX_TIMEOUT: "retry the same call once",
  INTERNAL_ERROR: "retry once; if it repeats, report it to the user (the host log has the details)",
}

const FALLBACK = "read the mission with studio_mission_get and fix what rincian names, then retry the same call"

/** The next correct call after a refusal `code` (always ends with the skill name). */
export function nextCall(code: string): string {
  return `${NEXT[code] ?? FALLBACK} (skill: ${MISSION_SKILL})`
}
