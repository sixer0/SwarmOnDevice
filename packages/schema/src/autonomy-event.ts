export * as AutonomyEvent from "./autonomy-event"

import { Schema } from "effect"
import { Event } from "./event"

/** A count and nothing written by anyone: a model, a file or a repository cannot put words in this notice. */
export const Blocked = Event.define({
  type: "autonomy.blocked",
  schema: {
    sessionID: Schema.String,
    level: Schema.Literals(["b0", "b1"]),
    count: Schema.Int,
  },
})

export const Definitions = Event.inventory(Blocked)
