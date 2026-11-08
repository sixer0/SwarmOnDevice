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
    `- mission, required: ${list(f.missionRequired)}. project: {${list(f.projectRequired)}} (absolute path). Optional: decisions, findings, sessions.`,
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
    "",
    "Minimal valid example:",
    "```json",
    exampleJson(),
    "```",
    "",
  ].join("\n")
}
