import path from "node:path"
import { Effect, Schema } from "effect"
import { ProjectMemory } from "@opencode-ai/schema/project-memory"
import * as Tool from "./tool"
import DESCRIPTION from "./remember.txt"
import { Memory } from "@/memory/memory"
import { InstanceState } from "@/effect/instance-state"
import type { Provider } from "@/provider/provider"

export const Parameters = Schema.Struct({
  text: Schema.optional(Schema.String).annotate({
    description: `The note line, at most ${Memory.MAX_TEXT} characters: one self-contained sentence or a few`,
  }),
  body: Schema.optional(Schema.String).annotate({
    description: `Detail kept with the note, at most ${Memory.MAX_BODY} characters, line breaks kept. Never put in the prompt; read back with recall. Only with text`,
  }),
  refs: Schema.optional(Schema.Array(ProjectMemory.MemoryRef)).annotate({
    description: `Files ({path, line?}) or graft symbols ({symbol, path?}) the note points at, at most ${Memory.MAX_REFS}. Linked, never copied: checked at recall. Only with text`,
  }),
  forget: Schema.optional(Schema.String).annotate({ description: "The id of a note to remove" }),
  recall: Schema.optional(Schema.String).annotate({
    description: "A note id to read its body and check its links, or words to search the notes. Writes nothing",
  }),
})

type Metadata = { id?: string; refused?: string; deviceOnly?: boolean; untrusted?: boolean; recall?: string }

// The limit and the next step, never a cut (U11, C6). `full` is never emitted any more: the store has no entry cap.
export const REFUSED = {
  empty: "Nothing to remember: the note was empty.",
  long: `Not saved: the note line is over ${Memory.MAX_TEXT} characters. Keep the line short, put the detail in body (up to ${Memory.MAX_BODY} characters), or link the file that holds it in refs.`,
  body_long: `Not saved: the body is over ${Memory.MAX_BODY} characters. Do not shorten the facts: keep them in a file and link it in refs (path, path:line or a graft symbol).`,
  too_many_refs: `Not saved: a note links at most ${Memory.MAX_REFS} files or symbols. Split it into notes by topic, or link the folder or index file that lists the rest.`,
  secret: "Not saved: this looks like a password, key or token. Credentials are never kept in memory.",
} satisfies Record<Exclude<ProjectMemory.Refusal, "full">, string>

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

          const model = ctx.extra?.model as Provider.Model | undefined
          if (params.recall !== undefined) {
            const output = yield* memory.recall({ query: params.recall, model })
            return {
              title: `Recalled ${params.recall.slice(0, 60)}`,
              output: output ?? "Project memory is off: there is nothing to recall.",
              metadata: { recall: params.recall },
            }
          }

          // A note taken while talking to an on-device model stays with on-device models until the user says otherwise.
          const deviceOnly = model ? yield* memory.onDevice(model) : false
          const instance = yield* InstanceState.context
          const result = yield* memory.add({
            text: params.text ?? "",
            source: "agent",
            deviceOnly,
            sessionID: ctx.sessionID,
            body: params.body,
            refs: params.refs,
            untrusted: readUntrustedInput(ctx.messages, {
              root: instance.worktree === "/" ? instance.directory : instance.worktree,
              directory: instance.directory,
            }),
          })
          if (result.refused)
            return {
              title: "Not saved",
              output: result.refused === "full" ? "Not saved." : REFUSED[result.refused],
              metadata: { refused: result.refused },
            }
          return {
            // Display only: the stored line is never cut.
            title: (result.item?.text ?? "").slice(0, 80),
            output: `Saved as note ${result.item?.id}. The user can see and edit it.`,
            metadata: { id: result.item?.id, deviceOnly: result.item?.deviceOnly, untrusted: result.item?.untrusted },
          }
        }),
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
  }),
)

// Built-in tools that bring in nothing from outside this machine's project. Everything else counts as outside input:
// webfetch, websearch, code mode (`execute`, which calls MCP), every MCP tool (Studio included) and plugin tools.
const LOCAL_TOOLS = new Set([
  "invalid",
  "question",
  "bash",
  "read",
  "glob",
  "grep",
  "git",
  "edit",
  "write",
  "task",
  "todowrite",
  "remember",
  "skill",
  "apply_patch",
  "lsp",
  "plan_exit",
])
// The parameter that names what a reading tool read; outside the worktree it is outside input too.
const PATH_PARAMETER: Record<string, string> = { read: "filePath", glob: "path", grep: "path" }

/**
 * SEC-09: whether this session already consumed web, MCP or Studio data or files outside the worktree before the note
 * was written. Such a note is kept (U11 cuts nothing) but carries `untrusted`, its label says so and it ranks lower.
 */
export function readUntrustedInput(messages: Tool.Context["messages"], where: { root: string; directory: string }) {
  return messages.some((message) =>
    message.parts.some((part) => {
      if (part.type !== "tool" || part.state.status !== "completed") return false
      if (!LOCAL_TOOLS.has(part.tool)) return true
      const key = PATH_PARAMETER[part.tool]
      const value = key ? part.state.input[key] : undefined
      if (typeof value !== "string" || !value) return false
      const relative = path.relative(where.root, path.resolve(where.directory, value))
      return relative.startsWith("..") || path.isAbsolute(relative)
    }),
  )
}
