export * as PermissionV1 from "./permission"

import { Schema } from "effect"
import { define, inventory } from "../event"
import { ascending } from "../identifier"
import { Project } from "../project"
import { statics } from "../schema"
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

export const ReplyBody = Schema.Struct({ reply: Reply, message: Schema.optional(Schema.String) }).annotate({
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
]).annotate({ identifier: "PermissionDeferredCategory" })
export type DeferredCategory = typeof DeferredCategory.Type

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
