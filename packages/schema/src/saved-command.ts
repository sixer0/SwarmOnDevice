export * as SavedCommand from "./saved-command"

import { Schema } from "effect"
import { define, inventory } from "./event"

export const Item = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  template: Schema.String,
  scope: Schema.Literals(["project", "global"]).annotate({
    description: "project: lives in this project's .swarm folder. global: available in every project",
  }),
}).annotate({ identifier: "SavedCommandItem" })
export interface Item extends Schema.Schema.Type<typeof Item> {}

export const Draft = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  template: Schema.String,
  source: Schema.Literals(["model", "prompts"]).annotate({
    description: "model: written by the session's model. prompts: put together from the run without a model",
  }),
}).annotate({ identifier: "SavedCommandDraft" })
export interface Draft extends Schema.Schema.Type<typeof Draft> {}

export const Refusal = Schema.Literals(["name", "taken", "empty", "long", "secret"]).annotate({
  identifier: "SavedCommandRefusal",
})
export type Refusal = typeof Refusal.Type

export const Result = Schema.Struct({
  item: Schema.optional(Item),
  refused: Schema.optional(Refusal),
}).annotate({ identifier: "SavedCommandResult" })
export interface Result extends Schema.Schema.Type<typeof Result> {}

export const Repeat = Schema.Struct({
  times: Schema.Number.annotate({
    description: "How many times this project has been asked for this job, or 0 when it is not worth mentioning",
  }),
}).annotate({ identifier: "SavedCommandRepeat" })
export interface Repeat extends Schema.Schema.Type<typeof Repeat> {}

const Updated = define({ type: "command.updated", schema: {} })
export const Event = { Updated, Definitions: inventory(Updated) }
