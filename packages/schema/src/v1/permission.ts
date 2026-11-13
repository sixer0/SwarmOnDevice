export * as PermissionV1 from "./permission"

import { Schema } from "effect"
import { define, inventory } from "../event"
import { ascending } from "../identifier"
import { Project } from "../project"
import { PositiveInt, statics } from "../schema"
import { SessionID } from "../session-id"

export const ID = Schema.String.check(Schema.isStartsWith("per")).pipe(
  Schema.brand("PermissionID"),
  statics((schema) => ({ ascending: (id?: string) => schema.make(id ?? "per_" + ascending()) })),
)
export type ID = typeof ID.Type

export const Action = Schema.Literals(["allow", "deny", "ask"]).annotate({ identifier: "PermissionAction" })
export type Action = typeof Action.Type

export const Rule = Schema.Struct({ permission: Schema.String, pattern: Schema.String, action: Action }).annotate({
  identifier: "PermissionRule",
})
export type Rule = typeof Rule.Type

export const Ruleset = Schema.Array(Rule).annotate({ identifier: "PermissionRuleset" })
export type Ruleset = typeof Ruleset.Type

export const Request = Schema.Struct({
  id: ID,
  sessionID: SessionID,
  permission: Schema.String,
  patterns: Schema.Array(Schema.String),
  metadata: Schema.Record(Schema.String, Schema.Unknown),
  always: Schema.Array(Schema.String),
  tool: Schema.optional(Schema.Struct({ messageID: Schema.String, callID: Schema.String })),
  movesOnAt: Schema.optional(Schema.Finite).annotate({
    description: "When the agent stops waiting and carries on without this, if nobody has answered",
  }),
  movedOnAt: Schema.optional(Schema.Finite).annotate({
    description: "When the agent carried on without this. It can still be answered, which continues the session",
  }),
  deferred: Schema.optional(Schema.Literal(true)).annotate({
    description: "Autonomous mode held this for the user's decision: the agent never waited for it",
  }),
}).annotate({ identifier: "PermissionRequest" })
export type Request = typeof Request.Type

export const Reply = Schema.Literals(["once", "always", "reject"])
export type Reply = typeof Reply.Type

export const ReplyBody = Schema.Struct({
  reply: Reply,
  message: Schema.optional(Schema.String),
  version: Schema.optional(PositiveInt).annotate({
    description:
      "The metadata.version of the request that was shown. An approval only counts for that list; leave it out for a single call",
  }),
}).annotate({
  identifier: "PermissionReplyBody",
})
export type ReplyBody = typeof ReplyBody.Type

export const Approval = Schema.Struct({ projectID: Project.ID, patterns: Schema.Array(Schema.String) }).annotate({
  identifier: "PermissionApproval",
})
export type Approval = typeof Approval.Type

export const EditClass = Schema.Literals(["ordinary", "not_ordinary", "no_undo", "sensitive", "secret"]).annotate({
  identifier: "PermissionEditClass",
})
export type EditClass = typeof EditClass.Type

/** Why autonomous mode did not run a call. Closed, so nothing a repository wrote can reach the agent through it. */
export const DeferredCategory = Schema.Literals([
  "outside_folder",
  "outward",
  "not_reversible",
  "sensitive_file",
  "secret_file",
  "external_tool",
  "no_undo",
  "not_routine",
  "queue_full",
  "decider_unavailable",
  "folder_not_trusted",
  "plan_mode",
  "app_state",
  "asks_every_time",
  // D: held for a person
  "outward_not_in_mission",
  "script_flagged",
  "script_unreadable",
  "program_not_trusted",
  // D under the 1.1.1 consented bypass: still held for a person
  "outside_write_held",
  "system_service",
  "process_not_own",
  "unreadable_command",
  // X: never run, whoever is asked
  "outside_write",
  "delete_compound",
  "credential_change",
  // X (row 202): a write into a secret or system place outside the project, refused with or without the consented bypass.
  // 1.2.6 (U12): a read of such a place is `protected_read` (class A) instead.
  "protected_path",
  // X under the 1.1.1 consented bypass
  "irreversible",
  "admin_rights",
  // X (1.2.6, U6): an irreversible local action whose checkpoint could not be made, so it did not run
  "checkpoint_failed",
  // X (1.2.7 F-4, N7-051): a call to Swarm's own running server, literal or indirect (a config file, a host or port in a
  // variable), split from `app_state`. Refused with or without the consented bypass, and never opened.
  "own_api",
]).annotate({ identifier: "PermissionDeferredCategory" })
export type DeferredCategory = typeof DeferredCategory.Type

/** Why autonomous mode ran a call without a person, for the autonomous-mode kinds that need a name of their own. */
export const AllowedCategory = Schema.Literals([
  "outside_read",
  "outside_copy",
  // row 202: a file tool's write outside the project, under autonomous mode
  "outside_edit",
  "mcp_tool",
  "consented",
  "archived",
  "script",
  // ran under the 1.1.1 consented bypass; the category it had before is kept in the audit line's \`bypassed\`
  "by_main_agent",
  // 1.2.6 (U12): a read of a secret or sensitive file, a protected place, or a diagnostic probe, run with nobody asked.
  // Values stay masked in what the agent sees (U16).
  "protected_read",
  // 1.2.6 (U6): an irreversible local action that ran after its checkpoint was made (also the audit outcome)
  "checkpointed",
]).annotate({ identifier: "PermissionAllowedCategory" })
export type AllowedCategory = typeof AllowedCategory.Type

/** Permission name of the consent prompt. Always X when an agent asks; only the server creates it. */
export const AUTONOMY_CONSENT = "autonomy_consent"

export class DeferredError extends Schema.TaggedErrorClass<DeferredError>()("PermissionDeferredError", {
  category: DeferredCategory,
}) {
  override get message() {
    return `This call did not run. In autonomous mode it is held for the user's decision: \`${this.category}\`. Do not try to get the same effect another way. Carry on with everything that does not depend on it, and list what is waiting in your final message. To look at something in the project use read, glob, grep or git, which ask nobody. Checks such as tests and builds run as plain commands, for example \`bun test path\` with \`workdir\`; no other operators.`
  }
}

/** A prompt the same call would raise next. One decision answers it too, so a person is not asked twice about one call. */
export const Follows = Schema.Array(
  Schema.Struct({ permission: Schema.String, patterns: Schema.Array(Schema.String) }),
).annotate({ identifier: "PermissionFollows" })
export type Follows = typeof Follows.Type

/** The one call a request belongs to, as its tool received it. In autonomous mode an answer is good for this and no other. */
export const ToolCall = Schema.Struct({ tool: Schema.String, args: Schema.Unknown }).annotate({
  identifier: "PermissionToolCall",
})
export type ToolCall = typeof ToolCall.Type

export const AskInput = Schema.Struct({
  ...Request.fields,
  id: Schema.optional(ID),
  ruleset: Ruleset,
  // The call cannot do lasting harm, so a catch-all "ask" does not apply to it. A rule naming this permission still does.
  harmless: Schema.optional(Schema.Boolean),
  // An earlier "Allow always" does not answer this one: it is more than the single command that always was given for.
  // Rules a person wrote in config still do.
  noAlways: Schema.optional(Schema.Boolean),
  // What autonomous mode needs from the tool. Each is read only on the server, and absent always means the stricter class.
  agent: Schema.optional(Schema.String),
  editClass: Schema.optional(EditClass),
  canUndo: Schema.optional(Schema.Boolean),
  follows: Schema.optional(Follows),
  call: Schema.optional(ToolCall),
}).annotate({
  identifier: "PermissionAskInput",
})
export type AskInput = typeof AskInput.Type

export const ReplyInput = Schema.Struct({ requestID: ID, ...ReplyBody.fields }).annotate({
  identifier: "PermissionReplyInput",
})
export type ReplyInput = typeof ReplyInput.Type

const Asked = define({ type: "permission.asked", schema: Request.fields })
const Replied = define({
  type: "permission.replied",
  schema: { sessionID: SessionID, requestID: ID, reply: Reply },
})
export const Event = { Asked, Replied, Definitions: inventory(Asked, Replied) }
