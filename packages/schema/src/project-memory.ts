export * as ProjectMemory from "./project-memory"

import { Schema } from "effect"
import { define, inventory } from "./event"

export const Source = Schema.Literals(["user", "agent", "learned"]).annotate({ identifier: "MemorySource" })
export type Source = typeof Source.Type

export const MemoryRef = Schema.Union([
  Schema.Struct({
    path: Schema.String,
    line: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  }),
  Schema.Struct({
    symbol: Schema.String,
    path: Schema.optional(Schema.String),
  }),
]).annotate({
  identifier: "MemoryRef",
  description: "A file (path, optional line) or a graft symbol (optional file), resolved at recall and never copied in",
})
export type MemoryRef = typeof MemoryRef.Type

export const Item = Schema.Struct({
  id: Schema.String,
  text: Schema.String,
  source: Source.annotate({
    description: "user: typed by the user. agent: noted by an agent. learned: worked out from a failed command",
  }),
  deviceOnly: Schema.Boolean.annotate({
    description: "Never sent to a model that runs off this device",
  }),
  time: Schema.Number,
  sessionID: Schema.optional(Schema.String),
  failed: Schema.optional(Schema.String),
  worked: Schema.optional(Schema.String),
  body: Schema.optional(Schema.String).annotate({
    description: "Longer detail, returned on recall and never put in the prompt",
  }),
  refs: Schema.optional(Schema.Array(MemoryRef)),
  untrusted: Schema.optional(Schema.Boolean).annotate({
    description: "Written after the session consumed web, MCP, Studio data or files outside the worktree",
  }),
}).annotate({ identifier: "MemoryItem" })
export interface Item extends Schema.Schema.Type<typeof Item> {}

export const Info = Schema.Struct({
  enabled: Schema.Boolean,
  items: Schema.Array(Item),
}).annotate({ identifier: "MemoryInfo" })
export interface Info extends Schema.Schema.Type<typeof Info> {}

export const Refusal = Schema.Literals(["empty", "long", "secret", "full", "body_long", "too_many_refs"]).annotate({ identifier: "MemoryRefusal" })
export type Refusal = typeof Refusal.Type

export const Result = Schema.Struct({
  item: Schema.optional(Item),
  refused: Schema.optional(Refusal),
}).annotate({ identifier: "MemoryResult" })
export interface Result extends Schema.Schema.Type<typeof Result> {}

const Updated = define({
  type: "memory.updated",
  schema: {
    added: Schema.optional(Item),
  },
})
export const Event = { Updated, Definitions: inventory(Updated) }
