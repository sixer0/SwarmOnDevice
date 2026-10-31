import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./remember.txt"
import { Memory } from "@/memory/memory"
import type { Provider } from "@/provider/provider"

export const Parameters = Schema.Struct({
  text: Schema.optional(Schema.String).annotate({ description: "The note to keep" }),
  forget: Schema.optional(Schema.String).annotate({ description: "The id of a note to remove" }),
})

type Metadata = { id?: string; refused?: string; deviceOnly?: boolean }

const REFUSED = {
  empty: "Nothing to remember: the note was empty.",
  long: `Not saved: keep a note under ${Memory.MAX_TEXT} characters.`,
  secret: "Not saved: this looks like a password, key or token. Credentials are never kept in memory.",
  full: `Not saved: memory holds ${Memory.MAX_ITEMS} notes already. Remove one first.`,
}

export const RememberTool = Tool.define<typeof Parameters, Metadata, Memory.Service>(
  "remember",
  Effect.gen(function* () {
    const memory = yield* Memory.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          // No permission prompt: a note stays on this device, shows in the transcript and can be undone, and stopping
          // an unattended run to approve a sentence would cost more than it protects. `"remember": "deny"` hides the tool.
          if (params.forget) {
            const removed = yield* memory.remove(params.forget)
            return {
              title: removed ? "Forgot a note" : "No such note",
              output: removed ? `Removed note ${params.forget}.` : `There is no note with id ${params.forget}.`,
              metadata: { id: params.forget },
            }
          }

          // A note taken while talking to an on-device model stays with on-device models until the user says otherwise.
          const model = ctx.extra?.model as Provider.Model | undefined
          const deviceOnly = model ? yield* memory.onDevice(model) : false
          const result = yield* memory.add({
            text: params.text ?? "",
            source: "agent",
            deviceOnly,
            sessionID: ctx.sessionID,
          })
          if (result.refused)
            return { title: "Not saved", output: REFUSED[result.refused], metadata: { refused: result.refused } }
          return {
            title: result.item?.text ?? "",
            output: `Saved as note ${result.item?.id}. The user can see and edit it.`,
            metadata: { id: result.item?.id, deviceOnly: result.item?.deviceOnly },
          }
        }),
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
  }),
)
