export * as ProjectMemory from "./project-memory"

import { Schema } from "effect"
import { define, inventory } from "./event"

export const Source = Schema.Literals(["user", "agent", "learned"]).annotate({ identifier: "MemorySource" })
export type Source = typeof Source.Type

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
}).annotate({ identifier: "MemoryItem" })
export interface Item extends Schema.Schema.Type<typeof Item> {}

export const Info = Schema.Struct({
  enabled: Schema.Boolean,
  items: Schema.Array(Item),
}).annotate({ identifier: "MemoryInfo" })
export interface Info extends Schema.Schema.Type<typeof Info> {}

export const Refusal = Schema.Literals(["empty", "long", "secret", "full"]).annotate({ identifier: "MemoryRefusal" })
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
