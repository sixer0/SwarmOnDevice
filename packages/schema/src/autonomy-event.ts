export * as AutonomyEvent from "./autonomy-event"

import { Schema } from "effect"
import { Event } from "./event"
import { optional } from "./schema"

/** A count and nothing written by anyone: a model, a file or a repository cannot put words in this notice. */
export const Blocked = Event.define({
  type: "autonomy.blocked",
  schema: {
    sessionID: Schema.String,
    level: Schema.Literals(["b0", "b1"]),
    count: Schema.Int,
  },
})

/**
 * The mode changed through the server (the app's switch, the CLI's `swarm autonomy on|off`), sent to the folder of the
 * changed scope. Only which scope, never the new value: a client reads the mode again, so a notice cannot say more than
 * the server does. `sessionID` is the root whose own answer changed; absent for a folder.
 */
export const ModeChanged = Event.define({
  type: "autonomy.mode.changed",
  schema: {
    scope: Schema.Literals(["session", "directory"]),
    sessionID: optional(Schema.String),
  },
})

export const Definitions = Event.inventory(Blocked, ModeChanged)
