/**
 * Row 119b: input schemas of the 11 `studio_mission_*` tools (mission contract §8.3 + C57/C71) and the extra
 * arguments of the wrapped `studio_report_*` tools (§8.2).
 *
 * The tool layer checks the top level only (`additionalProperties: false`, types, enums, sizes). The records
 * themselves (`MissionDoc`, `Row`, `Decision`, `Finding`, `SessionLink`) are validated by the store against
 * `studio.mission/v1#/$defs/...` (row 119a, src/store/mission/validate.ts), whose issues come back as
 * `SCHEMA_INVALID {def, issues}`; the C57 records are checked in code by the store (row 119a D2).
 */

export const MISSION_ID_PATTERN = "^\\d{4}-\\d{2}-\\d{2}[_-][a-z0-9][a-z0-9_-]{0,80}$"
export const ROW_ID_PATTERN = "^[1-9][0-9]{0,3}[a-z]?$"
export const ACTOR_PATTERN = "^[a-z0-9][a-z0-9._-]{0,63}$"
const DECISION_ID_PATTERN = "^[UC][1-9][0-9]{0,3}$"
const REQUEST_ID_PATTERN = "^D-[0-9]{1,4}$"

type Schema = Record<string, unknown>

const missionId: Schema = { type: "string", pattern: MISSION_ID_PATTERN, description: "Mission id = the mission folder name, e.g. 2026-11-06_swarm_1_2_0_datum_installer." }
const rowId: Schema = { type: "string", pattern: ROW_ID_PATTERN }
const session: Schema = {
  type: "object",
  additionalProperties: false,
  required: ["ref"],
  properties: {
    client: { type: "string", enum: ["swarm", "claude"], description: "Defaults to this MCP session's agent; another value is refused." },
    ref: { type: "string", minLength: 1, maxLength: 128, description: "Swarm session id (ses_..., 30 characters) or an opaque Claude session ref." },
    role: { type: "string", enum: ["controller", "driver", "viewer"] },
  },
  description: "Optional session link (mission contract §2.4): links this session to the mission; a repeated link only updates the time.",
}
const actor: Schema = { type: "string", pattern: ACTOR_PATTERN, description: "Declared actor recorded in the event trail (not authenticated, limit L2). Default: this session's agent." }
const dryRun: Schema = { type: "boolean", default: false, description: "Validate and run the write, then roll it back (nothing is stored)." }

/** Arguments every write tool accepts (§8.3). */
const writeCommon: Record<string, Schema> = { session, actor, dryRun }

function obj(properties: Record<string, Schema>, required: string[] = []): Schema {
  return { type: "object", additionalProperties: false, properties, ...(required.length > 0 ? { required } : {}) }
}

// Row 126 (spec mission control §8 G1): + "deliverables".
const GET_INCLUDE = ["rows", "decisions", "findings", "locks", "reports", "events", "snapshots", "requests", "checkpoints", "messages", "deliverables"] as const
export type GetInclude = (typeof GET_INCLUDE)[number]
export const EXPORT_FILES = ["blueprint", "status", "decisions", "delegation"] as const
export type ExportFile = (typeof EXPORT_FILES)[number]

const checkpoint: Schema = {
  type: "object",
  additionalProperties: false,
  required: ["n", "m"],
  properties: { n: { type: "integer", minimum: 0, maximum: 10000 }, m: { type: "integer", minimum: 1, maximum: 10000 }, label: { type: "string", maxLength: 200 } },
  description: "C57 (b): row checkpoint n of m (the agent bar), separate from mission progress (rows done / total).",
}

const rowPatch: Schema = {
  type: "object",
  additionalProperties: false,
  required: ["id"],
  properties: {
    id: rowId,
    add: { type: "object", description: "A new row (studio.mission/v1#/$defs/Row). After approval it needs `decision`." },
    set: { type: "object", description: "Row fields to change. Structural fields after approval need `decision` (§4.4)." },
    status: { type: "string", enum: ["pending", "running", "needs-review", "blocked", "done", "dropped"] },
    note: { type: "string", maxLength: 4000 },
    acquire: { type: "array", maxItems: 16, items: { type: "string", maxLength: 80 }, description: "Shared-resource locks to take (one holder across all missions, §5.4)." },
    release: { type: "array", maxItems: 16, items: { type: "string", maxLength: 80 } },
    retire: {
      type: "array",
      minItems: 1,
      maxItems: 16,
      uniqueItems: true,
      items: { type: "string", minLength: 1, maxLength: 64 },
      description: "Document ids linked to this row (docKey row-<id>-<name>) that it no longer delivers, e.g. an abandoned draft; archived, so the done gate and Deliverables judge only the current ones. Needs note; one live deliverable must stay.",
    },
    checkpoint,
  },
}

const message: Schema = {
  type: "object",
  additionalProperties: false,
  required: ["from", "to", "kind", "text"],
  properties: {
    from: { type: "string", enum: ["controller", "agent", "owner"] },
    to: { type: "string", enum: ["controller", "agent", "owner"] },
    kind: { type: "string", enum: ["report", "instruction", "question"] },
    text: { type: "string", minLength: 1, maxLength: 8000 },
    row: rowId,
  },
  description:
    "C57 (c) message log entry. An owner instruction (C57 d) is {from: owner, to: controller, kind: instruction}: stored as a message, never executed by the store.",
}

export const MISSION_TOOL_SCHEMAS: Record<string, Schema> = {
  studio_mission_create: obj(
    {
      mission: { type: "object", description: "studio.mission/v1#/$defs/MissionDoc, status draft, no host fields; may include rows, decisions, findings, sessions." },
      ...writeCommon,
    },
    ["mission"],
  ),
  studio_mission_get: obj(
    {
      mission: missionId,
      include: { type: "array", uniqueItems: true, items: { type: "string", enum: [...GET_INCLUDE] }, description: "Default: the whole MissionDoc (rows with reports, decisions, findings, locks)." },
      // Row 126 (spec mission control §8 G3).
      messagesTail: { type: "integer", minimum: 1, maximum: 50, description: "Return `messages` as the newest N messages (ascending seq) instead of the oldest 200." },
    },
    ["mission"],
  ),
  studio_mission_list: obj({
    session: { type: "object", additionalProperties: false, required: ["ref"], properties: { client: { type: "string", enum: ["swarm", "claude"] }, ref: { type: "string", minLength: 1, maxLength: 128 } } },
    status: { type: "array", uniqueItems: true, items: { type: "string", enum: ["draft", "approved", "running", "paused", "done", "cancelled"] } },
    type: { type: "string", maxLength: 64 },
    projectDir: { type: "string", maxLength: 4096 },
    q: { type: "string", minLength: 1, maxLength: 500 },
    take: { type: "integer", minimum: 1, maximum: 200, default: 50 },
    cursor: { type: "string", maxLength: 512 },
  }),
  studio_mission_approve: obj({ mission: missionId, decision: { type: "string", pattern: DECISION_ID_PATTERN, description: "A decision recorded by: user (§2.3)." }, ...writeCommon }, ["mission", "decision"]),
  studio_mission_set_status: obj(
    {
      mission: missionId,
      to: { type: "string", enum: ["running", "paused", "done", "cancelled"] },
      decision: { type: "string", pattern: DECISION_ID_PATTERN, description: "Required for cancelled." },
      supersededBy: missionId,
      note: { type: "string", maxLength: 4000 },
      ...writeCommon,
    },
    ["mission", "to"],
  ),
  studio_mission_update_row: {
    ...obj({
      mission: missionId,
      rows: { type: "array", minItems: 1, maxItems: 200, items: rowPatch, description: "1-200 row patches applied in order in one job." },
      messages: { type: "array", minItems: 1, maxItems: 50, items: message, description: "C57 (c)/(d): messages appended after the row patches, in the same job." },
      decision: { type: "string", pattern: DECISION_ID_PATTERN },
      ...writeCommon,
    }),
    required: ["mission"],
    // strictRequired: each branch declares the property it requires
    anyOf: [
      { properties: { rows: { type: "array" } }, required: ["rows"] },
      { properties: { messages: { type: "array" } }, required: ["messages"] },
    ],
  },
  studio_mission_record_decision: obj({ mission: missionId, decision: { type: "object", description: "studio.mission/v1#/$defs/Decision {id, by, date, text, rows?, supersedes?}; append-only." }, ...writeCommon }, [
    "mission",
    "decision",
  ]),
  studio_mission_record_finding: obj({ mission: missionId, finding: { type: "object", description: "studio.mission/v1#/$defs/Finding; upsert by id." }, ...writeCommon }, ["mission", "finding"]),
  studio_mission_export: obj(
    {
      mission: missionId,
      files: { type: "array", uniqueItems: true, minItems: 1, items: { type: "string", enum: [...EXPORT_FILES] }, description: "Default: all four (§9)." },
      write: { type: "boolean", default: false, description: "Write under <session root>/docs/<mission>/ (studio spec §9.4)." },
      overwrite: { type: "boolean", default: false, description: "Replace existing files (a .bak copy is made first)." },
    },
    ["mission"],
  ),
  studio_mission_request_decision: obj(
    {
      mission: missionId,
      request: {
        type: "object",
        description: "C57 (a): {id D-<n>, question, context? (one line), options[2-8]{id, label, consequence}, recommended?, blockingRows?[]}. Blocking rows cannot start while it is open.",
      },
      ...writeCommon,
    },
    ["mission", "request"],
  ),
  studio_mission_answer_decision: obj(
    {
      mission: missionId,
      request: { type: "string", pattern: REQUEST_ID_PATTERN },
      option: { type: "string", maxLength: 32 },
      by: { type: "string", enum: ["user", "controller"] },
      decisionId: { type: "string", pattern: DECISION_ID_PATTERN, description: "The decision to record: U<n> for the user, C<n> for the controller." },
      date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
      text: { type: "string", maxLength: 8000 },
      withdraw: { type: "boolean", default: false, description: "Withdraw the open request instead of answering it." },
      ...writeCommon,
    },
    ["mission", "request"],
  ),
}

/** §8.1 tool order of the `missions` toolset (9 of §8.3) + the two C57 decision tools (C71). */
export const MISSION_TOOL_NAMES = [
  "studio_mission_create",
  "studio_mission_get",
  "studio_mission_list",
  "studio_mission_approve",
  "studio_mission_set_status",
  "studio_mission_update_row",
  "studio_mission_record_decision",
  "studio_mission_record_finding",
  "studio_mission_export",
  "studio_mission_request_decision",
  "studio_mission_answer_decision",
] as const

/** §8.2: arguments the wrappers add to the vendored report tools (stripped before the vendored call). */
export const REPORT_EXTRA_PROPERTIES: Record<string, Record<string, Schema>> = {
  studio_report_template: { row: { ...rowId, description: "Mission row: fills mission:, docKey: row-<row>, TaskRef: <row> and Owner: <row agent>. Needs mission." } },
  studio_report_check: { row: { ...rowId, description: "Mission row (docKey row-<row>); the mission checks of §6.2 are reported as issues." } },
  studio_report_submit: {
    row: { ...rowId, description: "Mission row: docKey defaults to row-<row>; both given must agree. TaskRef must equal the row id." },
    session,
  },
  studio_report_update: { session },
  studio_report_refresh: {},
}
