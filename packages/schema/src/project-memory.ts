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
  // 1.2.8 F-MEM (N8-001): decoded as a plain string, never a literal union, so a store written by a later build with a
  // kind this build does not know still reads (the item is treated as an ordinary note) instead of failing the whole
  // store and having it set aside as unreadable (01e §2.1, C9).
  kind: Schema.optional(Schema.String).annotate({
    description:
      'Absent: an ordinary note. "index": a mission index entry. "index_rollup": a roll-up of older index entries, written by the store only. Any other value reads as an ordinary note',
  }),
  missionId: Schema.optional(Schema.String).annotate({
    description: 'The mission an "index" entry belongs to (the mission folder name); one entry per mission',
  }),
  rolledInto: Schema.optional(Schema.String).annotate({
    description: "Id of the roll-up that holds this entry's line; the entry is archived, kept whole and recallable",
  }),
}).annotate({ identifier: "MemoryItem" })
export interface Item extends Schema.Schema.Type<typeof Item> {}

export const Info = Schema.Struct({
  enabled: Schema.Boolean,
  items: Schema.Array(Item),
}).annotate({ identifier: "MemoryInfo" })
export interface Info extends Schema.Schema.Type<typeof Info> {}

/**
 * The note limits (1.2.6 M1 S6: their one source). `text`: characters of the note line; `body`: characters of the detail
 * kept with it; `refs`: files or symbols it links. Over a limit the note is refused, never cut (U11). The server
 * (opencode Memory.MAX_*) and the app's memory view (refusal texts, `{{max}}` in every locale) both read these.
 */
export const LIMITS = { text: 2000, body: 10000, refs: 10 } as const
export type Limits = typeof LIMITS

/**
 * The mission index limits (1.2.8 F-MEM, N8-003). `text`: characters of the entry line; `body`: characters of its
 * detail; `entries`: index entries per project store, roll-ups included; `triggers`: trigger words per entry. Over a
 * limit the entry is refused, never cut (U11).
 */
export const INDEX_LIMITS = { text: 300, body: 2000, entries: 40, triggers: 5 } as const
export type IndexLimits = typeof INDEX_LIMITS

/**
 * The entry line (N8-005): `YYYY-MM-DD <mission-id> | <outcome> | triggers: k1, k2, k3 | <report path>`. Groups: 1 date,
 * 2 mission id, 3 outcome, 4 triggers, 5 report path. The trigger count comes from INDEX_LIMITS.triggers, so the two
 * cannot drift (C9 OP-17-4).
 */
export const INDEX_TEXT_PATTERN = new RegExp(
  `^(\\d{4}-\\d{2}-\\d{2}) (\\S+) \\| ([^|]{1,200}) \\| triggers: ([^|,]{1,40}(?:, [^|,]{1,40}){0,${INDEX_LIMITS.triggers - 1}}) \\| (\\S+)$`,
)

export const Refusal = Schema.Literals([
  "empty",
  "long",
  "secret",
  "full",
  "body_long",
  "too_many_refs",
  "index_long",
  "index_body_long",
  "index_format",
  "index_full",
]).annotate({ identifier: "MemoryRefusal" })
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
