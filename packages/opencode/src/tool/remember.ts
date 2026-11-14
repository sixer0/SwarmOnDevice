import path from "node:path"
import { Effect, Option, Schema } from "effect"
import { ProjectMemory } from "@opencode-ai/schema/project-memory"
import * as Tool from "./tool"
import DESCRIPTION from "./remember.txt"
import { Memory } from "@/memory/memory"
import { InstanceState } from "@/effect/instance-state"
import type { Provider } from "@/provider/provider"
import { OutwardConsent } from "@/permission/outward-consent"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"

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
  kind: Schema.optional(Schema.Literal("index")).annotate({
    description:
      'Only "index": the one mission index entry written after a mission\'s final report. Needs missionId and text in the index line format',
  }),
  missionId: Schema.optional(Schema.String).annotate({
    description: "With kind index: the mission id, equal to the id in the line. Ignored without kind",
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
  // 1.2.8 F-MEM mission index entries (01e §2.4).
  index_long: `Not saved: a mission index entry is one line of at most ${ProjectMemory.INDEX_LIMITS.text} characters. Shorten the outcome or the triggers; put detail in body (up to ${ProjectMemory.INDEX_LIMITS.body} characters).`,
  index_format: `Not saved: an index entry reads "YYYY-MM-DD <mission-id> | <outcome> | triggers: k1, k2, k3 | docs/<mission-id>/.../report.md", with missionId equal to the id in the line, at most ${ProjectMemory.INDEX_LIMITS.triggers} triggers and the report path inside docs/<mission-id>/.`,
  index_body_long: `Not saved: the index entry body is over ${ProjectMemory.INDEX_LIMITS.body} characters. Keep the detail in the final report and link it; the report path is already in the line.`,
  index_full:
    "Not saved: the mission index is full and older entries cannot be rolled up without cutting them. Ask the person to remove or consolidate old entries in the memory view.",
} satisfies Record<Exclude<ProjectMemory.Refusal, "full">, string>

export const RememberTool = Tool.define<typeof Parameters, Metadata, Memory.Service>(
  "remember",
  Effect.gen(function* () {
    const memory = yield* Memory.Service
    // Optional so a tool built without sessions (tests) still works: a child it cannot read then counts as untrusted.
    const sessions = yield* Effect.serviceOption(Session.Service)

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
          // 1.2.8 MEM-d (01e §2.4): kind without text or without missionId is a malformed index entry.
          if (params.kind !== undefined && (!params.text?.trim() || !params.missionId))
            return {
              title: "Not saved",
              output: REFUSED.index_format,
              metadata: { refused: "index_format" },
            }
          const deviceOnly = model ? yield* memory.onDevice(model) : false
          const instance = yield* InstanceState.context
          const children = yield* loadTaskChildren(ctx.messages, (sessionID) =>
            Option.isSome(sessions)
              ? sessions.value.messages({ sessionID: SessionID.make(sessionID) })
              : Effect.fail(new Error("no sessions")),
          )
          const result = yield* memory.add({
            text: params.text ?? "",
            source: "agent",
            deviceOnly,
            sessionID: ctx.sessionID,
            body: params.body,
            refs: params.refs,
            ...(params.kind !== undefined ? { kind: params.kind, missionId: params.missionId } : {}),
            untrusted: readUntrustedInput(
              ctx.messages,
              {
                root: instance.worktree === "/" ? instance.directory : instance.worktree,
                directory: instance.directory,
              },
              (sessionID) => children.get(sessionID),
            ),
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
  // 1.2.8 row 47 (C54): a draft is written from the session's own text and brings nothing in from outside.
  "skill_draft",
  "apply_patch",
  "lsp",
  "plan_exit",
])
// The parameter that names what a reading tool read; outside the worktree it is outside input too.
const PATH_PARAMETER: Record<string, string> = { read: "filePath", glob: "path", grep: "path" }

// Programs put in front of the one that runs (`sudo curl ...`); skipped when looking for the program of a step.
const WRAPPERS = new Set(["sudo", "doas", "env", "command", "builtin", "exec", "time", "nohup", "nice", "xargs"])

const loopback = (hostname: string) => {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "")
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "::1" ||
    host === "0.0.0.0" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
  )
}

/**
 * 1.2.6 FX-5/6 (M1 S5, SEC-09): whether a shell command fetches web content: a step whose program is a request tool
 * (curl, wget, httpie, xh; OutwardConsent.REQUEST_TOOLS) and whose destination is not loopback. URLs are read as
 * OutwardConsent reads them; with a `scheme://` word only those count, otherwise every word that reads as a host.
 * A fetch whose destination cannot be read (`curl "$URL"`, a config file) is not proven local, so it counts.
 */
export function shellFetchesWeb(command: string) {
  return requestSteps(command).some((urls) => !urls.length || urls.some((url) => !loopback(url.hostname)))
}

/** The URLs of each step of a shell command whose program is a request tool; a step with no readable URL gives []. */
function requestSteps(command: string) {
  return command.split(/&&|\|\||[;|&\n()`]/).flatMap((step) => {
    const words = step
      .split(/[\s<>]+/)
      .map((word) => word.replace(/^['"]+|['"]+$/g, ""))
      .filter(Boolean)
    let at = 0
    while (at < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[at]!) || WRAPPERS.has(words[at]!))) at++
    const program = words[at]
    if (!program || !OutwardConsent.REQUEST_TOOLS.has(path.basename(program))) return []
    const args = words.slice(at + 1).filter((word) => !word.startsWith("-"))
    const schemed = args.filter((word) => /^[a-z][a-z0-9+.-]*:\/\//i.test(word))
    return [(schemed.length ? schemed : args).flatMap((word) => OutwardConsent.urlOf(word) ?? [])]
  })
}

// Swarm's own session message routes: `/session/<id>/message`, `/session/<id>/messages` and what lies below them.
const SESSION_MESSAGES_ROUTE = /\/session\/[^/]+\/messages?(?:\/|$)/i

/**
 * 1.2.8 SR8-06 (AC-SEC06): a loopback request to Swarm's own session message routes reads other sessions' transcripts,
 * which may carry web content, so it counts as outside input although its destination is local.
 */
function shellReadsSessions(command: string) {
  return requestSteps(command).some((urls) =>
    urls.some((url) => loopback(url.hostname) && SESSION_MESSAGES_ROUTE.test(url.pathname)),
  )
}

/** 1.2.8 SR8-06 (N8-395): how deep `readUntrustedInput` follows the child sessions named by completed `task` parts. */
export const UNTRUSTED_TASK_DEPTH = 3

type Messages = Tool.Context["messages"]

/** The child session a completed `task` part names (its metadata `sessionId`), if any. */
const taskChild = (part: Messages[number]["parts"][number]) =>
  part.type === "tool" && part.tool === "task" && part.state.status === "completed"
    ? typeof part.state.metadata?.sessionId === "string"
      ? part.state.metadata.sessionId
      : ""
    : undefined

/**
 * 1.2.8 SR8-06: reads the child sessions named by completed `task` parts, recursively up to UNTRUSTED_TASK_DEPTH, so
 * `readUntrustedInput` can stay pure. A child that cannot be read is left out of the map (and then counts as untrusted).
 */
export const loadTaskChildren = Effect.fnUntraced(function* (
  messages: Messages,
  read: (sessionID: string) => Effect.Effect<Messages, unknown>,
) {
  const found = new Map<string, Messages>()
  let level = messages
  for (let depth = 0; depth < UNTRUSTED_TASK_DEPTH; depth++) {
    const ids = [
      ...new Set(level.flatMap((message) => message.parts.flatMap((part) => taskChild(part) || []))),
    ].filter((id) => !found.has(id))
    if (!ids.length) break
    const next: Messages = []
    for (const id of ids) {
      const child = yield* read(id).pipe(Effect.option)
      if (Option.isNone(child)) continue
      found.set(id, child.value)
      next.push(...child.value)
    }
    level = next
  }
  return found
})

/**
 * SEC-09: whether this session already consumed web, MCP or Studio data or files outside the worktree before the note
 * was written. Web content fetched through the shell counts too (1.2.6 M1 S5, `shellFetchesWeb`), and so do a
 * subagent that consumed such input and a loopback read of session transcripts (1.2.8 SR8-06, `child` reads the
 * sessions `loadTaskChildren` loaded). Such a note is kept (U11 cuts nothing) but carries `untrusted`, its label says so and it ranks lower.
 */
export function readUntrustedInput(
  messages: Messages,
  where: { root: string; directory: string },
  child: (sessionID: string) => Messages | undefined = () => undefined,
  depth = 0,
  seen: Set<string> = new Set(),
): boolean {
  return messages.some((message) =>
    message.parts.some((part) => {
      if (part.type !== "tool" || part.state.status !== "completed") return false
      if (!LOCAL_TOOLS.has(part.tool)) return true
      // The shell counts as local unless the call fetched web content (curl/wget and the like to a non-loopback URL)
      // or read Swarm's own session message routes on loopback (1.2.8 SR8-06).
      if (part.tool === "bash") {
        const command = part.state.input.command
        return typeof command === "string" && (shellFetchesWeb(command) || shellReadsSessions(command))
      }
      // 1.2.8 SR8-06: a subagent's result carries what the subagent read. Its session is read up to
      // UNTRUSTED_TASK_DEPTH levels down; one that is unnamed, unreadable or deeper counts as untrusted.
      const id = taskChild(part)
      if (id !== undefined) {
        if (!id || depth >= UNTRUSTED_TASK_DEPTH) return true
        if (seen.has(id)) return false
        const sub = child(id)
        if (!sub) return true
        return readUntrustedInput(sub, where, child, depth + 1, new Set([...seen, id]))
      }
      const key = PATH_PARAMETER[part.tool]
      const value = key ? part.state.input[key] : undefined
      if (typeof value !== "string" || !value) return false
      const relative = path.relative(where.root, path.resolve(where.directory, value))
      return relative.startsWith("..") || path.isAbsolute(relative)
    }),
  )
}
