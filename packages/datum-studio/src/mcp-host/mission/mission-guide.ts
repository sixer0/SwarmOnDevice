/**
 * Row 169 (gateway_check/15_row168_mission_create_failures.md): the MissionDoc guide an agent reads before
 * `studio_mission_create`, served as the MCP resource MISSION_GUIDE_URI (mcp-server.ts). In the row 146 run the agent
 * had no source for tier, kind, size or the deps form and guessed for 22 calls.
 *
 * Every fact is read from `studio.mission/v1` (store/mission/schema.ts) and the builtin mission types, never typed
 * here, so the guide cannot drift from what the store validates; the row 169 test checks the example against
 * MissionDoc and through studio_mission_create (dryRun).
 */
import { MISSION_SCHEMA_V1 } from "../../store/mission/schema.ts"
import { BUILTIN_MISSION_TYPES } from "../../store/mission/builtin-types.ts"
import { MISSION_TRANSITIONS, ROW_RUNNING_DONE_RULE, ROW_TRANSITIONS } from "../../store/mission/mission-store.ts"

export const MISSION_GUIDE_URI = "studio://skema/mission"
export const MISSION_GUIDE_NAME = "skema-mission"

type S = Record<string, any>
const defs = (MISSION_SCHEMA_V1 as S).$defs as S

/** Mission fields the host fills on create ($schema, typeVersion = newest pinned, status = draft). */
const HOST_FILLED = ["$schema", "typeVersion", "status"]
/** Row fields the store refuses on input (mission-store.ts ROW_HOST_FIELDS). */
const ROW_HOST = ["createdAt", "updatedAt", "startedAt", "finishedAt", "reports"]

export interface MissionGuideFacts {
  missionRequired: string[]
  projectRequired: string[]
  rowRequired: string[]
  rowOptional: string[]
  kind: string[]
  size: Array<string | null>
  rowStatus: string[]
  review: string[]
  tier: string[]
  tierNeedsReason: string[]
  depPattern: string
  /** Row.allOf: statuses whose rows need size (S or M) and those whose rows need note. */
  sizeRequiredFor: string[]
  sizeWhenRequired: string[]
  noteRequiredFor: string[]
  types: Array<{ id: string; phases: Array<{ id: string; kinds: string[] }> }>
}

/** The Row.allOf rule whose `then` requires `field` (throws when the schema no longer has it: the test sees drift). */
function conditional(field: string): S {
  const rule = ((defs.Row as S).allOf as S[]).find((r) => (r.then?.required as string[] | undefined)?.includes(field))
  if (!rule) throw new Error(`mission guide: no Row.allOf rule requires ${field}`)
  return rule
}

export function missionGuideFacts(): MissionGuideFacts {
  const row = defs.Row as S
  const sizeRule = conditional("size")
  const noteRule = conditional("note")
  return {
    missionRequired: (defs.MissionDoc.required as string[]).filter((k) => !HOST_FILLED.includes(k)),
    projectRequired: defs.Project.required as string[],
    rowRequired: row.required as string[],
    rowOptional: Object.keys(row.properties).filter((k) => !(row.required as string[]).includes(k) && !ROW_HOST.includes(k)),
    kind: defs.RowKind.enum as string[],
    size: row.properties.size.enum as Array<string | null>,
    rowStatus: defs.RowStatus.enum as string[],
    review: row.properties.review.enum as string[],
    tier: defs.Model.properties.tier.enum as string[],
    tierNeedsReason: defs.Model.if.properties.tier.enum as string[],
    depPattern: defs.Dep.pattern as string,
    sizeRequiredFor: sizeRule.if.properties.status.enum as string[],
    sizeWhenRequired: sizeRule.then.properties.size.enum as string[],
    noteRequiredFor: noteRule.if.properties.status.enum as string[],
    types: BUILTIN_MISSION_TYPES.map((t) => ({ id: t.id, phases: [...t.phases].sort((a, b) => a.order - b.order).map((p) => ({ id: p.id, kinds: [...p.kinds] })) })),
  }
}

/** A minimal valid `mission` argument (feature-release, three rows, all three tier rules shown). */
export const MISSION_GUIDE_EXAMPLE = {
  id: "2026-11-08_example-mission",
  title: "Example mission",
  type: "feature-release",
  owner: "master-controller",
  project: { dir: "/absolute/path/to/project" },
  rows: [
    { id: "1", phase: "identification", kind: "spec", title: "Write the spec", agent: "task-architect", model: { tier: "thinker" }, deps: [], size: "S", status: "pending", output: "identification/spec.md", verification: "spec reviewed" },
    { id: "2", phase: "implementation", kind: "implementation", title: "Build it", agent: "coder-execution", model: { tier: "worker", reason: "spec is fixed" }, deps: ["1:C"], size: "M", status: "pending", output: "implementation/02.md", verification: "tests pass" },
    { id: "3", phase: "verification", kind: "test", title: "Run the tests", agent: "test-expert", model: { tier: "worker-fast", reason: "mechanical run" }, deps: ["2:B"], size: "S", status: "pending", output: "test/report.md", verification: "suite green" },
  ],
} as const

/** The approval shape for autonomous mode (MC-02, row 80: top-level `autonomous`, stored as decision.autonomous). Shared with next-call.ts. */
export const AUTONOMOUS_DECISION_SHAPE = "studio_mission_record_decision {decision: {id: C<n>, by: controller, date, text}, autonomous: true}"

/** What one update_row job returns per patch (MC-07 row 85, MC-04 row 82b: RowPatchResult). Shared with next-call.ts. */
export const ROW_PATCH_RESULT_SHAPE = "results[] {id, ok, code?, message?, noteSaved?}"

/**
 * Row 188 (L47): the lifecycle in 6 lines (the order the store enforces; skill mission-control has the full sequence).
 * Omit `session` on every call: Swarm links the calling session. 1.2.6 row 100a (G-03): every line states the fixed
 * store behaviour (MC-01..MC-09); the running -> done wording is the store's ROW_RUNNING_DONE_RULE, never retyped.
 */
export const MISSION_LIFECYCLE = [
  "Lifecycle 1/6 create: studio_mission_create {mission, dryRun: true}, fix what it names, then the same call without dryRun (draft). Omit `session` on every call: Swarm fills it. Skill: mission-control.",
  `Lifecycle 2/6 approval: studio_mission_request_decision and wait for the user's answer; only while Swarm's autonomous mode setting is on (the person turns it on) ${AUTONOMOUS_DECISION_SHAPE} (top-level autonomous, or decision.autonomous; both stored the same) then studio_mission_approve {mission, decision: C<n>}. Never record by: user yourself.`,
  "Lifecycle 3/6 set_status running: studio_mission_set_status {to: running}; no row starts before approval (MISSION_NOT_APPROVED). Setting the status a mission already has returns unchanged: true and writes nothing, so a repeated call is safe.",
  `Lifecycle 4/6 update_row per step: studio_mission_update_row {rows: [{id, status: running}]} when a step starts; when it ends set done or blocked, each with a note (${ROW_RUNNING_DONE_RULE}). Each patch applies or is refused on its own: the call can succeed while a patch failed, so read ${ROW_PATCH_RESULT_SHAPE}. rows[].decision gives one patch its own decision (it overrides the call-level decision). Notes are never gated by dependencies: send a note as its own patch; a status refused DEP_NOT_DONE in a patch that also carries a note still stores the note (noteSaved: true). Phase and kind must match the matrix in the guide (KIND_NOT_ALLOWED, PHASE_UNKNOWN otherwise).`,
  "Lifecycle 5/6 gate: a row is done only with verified outputs (OUTPUT_UNVERIFIED otherwise) or a note naming the check and its result file. Rows added or dropped after approval need a decision and show in studio_mission_get derived.drift (each with its decision id).",
  "Lifecycle 6/6 done: every row done or dropped (MISSION_ROWS_OPEN otherwise), then one studio_mission_set_status {to: done}.",
] as const

const arrows = (moves: Readonly<Record<string, readonly string[]>>) =>
  Object.entries(moves)
    .map(([from, to]) => `${from} -> ${to.length ? to.join(" | ") : "(none)"}`)
    .join("; ")

/** Row 100a: the status moves the store allows, printed from ROW_TRANSITIONS and MISSION_TRANSITIONS (never typed here). */
export function statusMoveLines(): string[] {
  return [
    `Row status moves: ${arrows(ROW_TRANSITIONS)}.`,
    `Mission status moves: ${arrows(MISSION_TRANSITIONS)}.`,
  ]
}

function exampleJson(): string {
  const { rows, ...head } = MISSION_GUIDE_EXAMPLE
  const h = JSON.stringify(head)
  return `${h.slice(0, -1)},"rows":[\n  ${rows.map((r) => JSON.stringify(r)).join(",\n  ")}\n]}`
}

export function missionGuideText(): string {
  const f = missionGuideFacts()
  const list = (xs: ReadonlyArray<string | null>) => xs.map((x) => String(x)).join(", ")
  return [
    "# studio_mission_create: the `mission` argument (studio.mission/v1 MissionDoc)",
    "",
    "Send `mission` as a JSON object (not a string). The host sets $schema, typeVersion (newest) and status (draft). Test with dryRun: true first.",
    "",
    ...MISSION_LIFECYCLE,
    "",
    ...statusMoveLines(),
    "(approved is reached only through studio_mission_approve.)",
    "",
    `- mission, required: ${list(f.missionRequired)}. project: {${list(f.projectRequired)}} (absolute path: the session's working directory or a folder inside it; when project.dir is left out the host sets the session's working directory). Optional: decisions, findings, sessions.`,
    `- id: YYYY-MM-DD_slug (lowercase a-z 0-9 _ -), e.g. ${MISSION_GUIDE_EXAMPLE.id}.`,
    `- row, required: ${list(f.rowRequired)}. Optional: ${list(f.rowOptional)}.`,
    `- row id: "1", "2", "2a"; status on create: pending or dropped (all: ${list(f.rowStatus)}).`,
    `- kind: ${list(f.kind)}; must be a kind of the row's phase (table below).`,
    `- size: ${list(f.size)}; required and ${list(f.sizeWhenRequired)} when status is ${list(f.sizeRequiredFor)}. note: required when status is ${list(f.noteRequiredFor)}. review: ${list(f.review)}.`,
    `- model: an object {tier, reason?}. tier: ${list(f.tier)}. reason (one line) is required for ${list(f.tierNeedsReason)}.`,
    `- deps: array of "<row id>:B" (build: starts after that row is done) or "<row id>:C" (contract: needs only its spec/interface); [] when none. Short: N:B / N:C, e.g. ["1:B", "2:C"]. Pattern ${f.depPattern}.`,
    "",
    "Mission types (type: phase(kinds) in order):",
    ...f.types.map((t) => `- ${t.id}: ${t.phases.map((p) => `${p.id}(${p.kinds.join(" ")})`).join(" > ")}`),
    "",
    "Deliverables and done (row 174, C218):",
    "- A row marked done delivers Studio outputs the done gate verified (docKey row-<id>-<name>, OUTPUT_UNVERIFIED otherwise). For a format Studio does not make (e.g. XLSX), the row note names the check that was run and its result file, and that file must exist.",
    "- A draft linked to the row that the row no longer delivers: studio_mission_update_row rows: [{id, retire: [documentId], note}] (one live deliverable must stay); never drop the row to get past the gate.",
    "- studio_mission_get {include: [deliverables]} also lists documents another mission owns that a work report of this mission named as an output (linked: true, ownerMission).",
    "",
    "Minimal valid example:",
    "```json",
    exampleJson(),
    "```",
    "",
  ].join("\n")
}
