import { LLMEvent } from "@opencode-ai/llm"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Cause, Context, Duration, Effect, Layer, Option, Schema, Stream } from "effect"
import { Agent } from "@/agent/agent"
import { InstanceState } from "@/effect/instance-state"
import { Git } from "@/git"
import { Memory } from "@/memory/memory"
import { Provider } from "@/provider/provider"
import { LLM } from "@/session/llm"
import { SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { Secrets } from "@/tool/secrets"
import PROMPT from "./commit-draft.txt"
import { Vcs } from "./vcs"

// The person is reading the review panel while this runs, and the record of the run is already a usable message, so this
// is only ever an improvement: it never fails, and it never sends a diff to a model off this machine or network.

export const Input = Schema.Struct({
  sessionID: SessionID,
  files: Schema.Array(Schema.String),
})
export type Input = Schema.Schema.Type<typeof Input>

export const Result = Schema.Struct({
  subject: Schema.optional(Schema.String),
  summary: Schema.optional(Schema.String),
}).annotate({ identifier: "VcsCommitDraft" })
export type Result = Schema.Schema.Type<typeof Result>

const TIMEOUT = Duration.seconds(60)
const MAX_DIFF = 16_000
const MAX_FILE_DIFF = 4_000
const MAX_PROMPTS = 6
const MAX_PROMPT = 600
const MAX_SUBJECT = 100
const MAX_SUMMARY = 700

/** What the model returned, or nothing when it is not usable and the run's own record should stand. */
export function parse(text: string): Result {
  const body = text.replace(/<think>[\s\S]*?<\/think>/g, "")
  const start = body.indexOf("{")
  const end = body.lastIndexOf("}")
  if (start === -1 || end <= start) return {}
  const decoded = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(body.slice(start, end + 1))
  if (Option.isNone(decoded) || !decoded.value || typeof decoded.value !== "object") return {}
  const value = decoded.value as Record<string, unknown>
  const subject = typeof value.subject === "string" ? value.subject.replace(/\s+/g, " ").trim() : ""
  const summary = typeof value.summary === "string" ? value.summary.trim() : ""
  if (!subject || subject.length > MAX_SUBJECT || summary.length > MAX_SUMMARY) return {}
  return { subject, summary: summary || undefined }
}

/** Cut per file, so one huge lockfile cannot push out the change the message is about. */
export function digest(input: {
  prompts: readonly string[]
  history: string
  diffs: readonly { file: string; patch?: string }[]
}) {
  const per = Math.max(MAX_FILE_DIFF, Math.floor(MAX_DIFF / Math.max(1, input.diffs.length)))
  const diff = input.diffs
    .map((item) => {
      const patch = item.patch ?? ""
      return patch.length > per ? `${patch.slice(0, per)}\n[${item.file}: rest of this diff cut]` : patch || `${item.file}`
    })
    .join("\n")
    .slice(0, MAX_DIFF)
  return [
    `<request>\n${input.prompts
      .slice(-MAX_PROMPTS)
      .map((prompt) => prompt.slice(0, MAX_PROMPT))
      .join("\n---\n")}\n</request>`,
    `<history>\n${input.history}\n</history>`,
    `<diff>\n${diff}\n</diff>`,
  ].join("\n")
}

export interface Interface {
  readonly write: (input: Input) => Effect.Effect<Result>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/CommitDraft") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const agents = yield* Agent.Service
    const provider = yield* Provider.Service
    const llm = yield* LLM.Service
    const memory = yield* Memory.Service
    const vcs = yield* Vcs.Service
    const git = yield* Git.Service

    const write = Effect.fn("CommitDraft.write")(function* (input: Input) {
      const messages = yield* sessions.messages({ sessionID: input.sessionID })
      const lastUser = messages.findLast((message) => message.info.role === "user")?.info
      if (!lastUser || lastUser.role !== "user") return {}
      const base = yield* agents.get("title")
      if (!base) return {}
      // The run's own model and no other: the small model could be off-device when the run was on it.
      const model = yield* provider.getModel(lastUser.model.providerID, lastUser.model.modelID)
      if (!(yield* memory.onDevice(model))) return {}
      const ctx = yield* InstanceState.context
      const wanted = new Set(input.files)
      const diffs = (yield* vcs.diff("git", { context: 2 })).filter((item) => wanted.has(item.file))
      if (diffs.length === 0) return {}
      const prompts = messages.flatMap((message) =>
        message.info.role !== "user"
          ? []
          : message.parts.flatMap((part) =>
              part.type === "text" && !part.synthetic && !part.ignored && part.text.trim() ? [part.text.trim()] : [],
            ),
      )
      const history = yield* git.run(["log", "-8", "--format=%s"], { cwd: ctx.worktree })
      const text = yield* llm
        .stream({
          agent: { ...base, prompt: PROMPT },
          user: lastUser,
          system: [],
          small: true,
          tools: {},
          model,
          sessionID: input.sessionID,
          retries: 1,
          messages: [
            {
              role: "user",
              content: Secrets.scrub(digest({ prompts, history: history.text().trim(), diffs }), ctx.worktree),
            },
          ],
        })
        .pipe(
          Stream.filter(LLMEvent.is.textDelta),
          Stream.map((event) => event.text),
          Stream.mkString,
          Effect.timeoutOption(TIMEOUT),
          Effect.map(Option.getOrUndefined),
        )
      return text ? parse(text) : {}
    }, (effect) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("commit draft fell back to the run's record", { cause: Cause.pretty(cause) }).pipe(
            Effect.as({} as Result),
          ),
        ),
      ),
    )

    return Service.of({ write })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Session.node, Agent.node, Provider.node, LLM.node, Memory.node, Vcs.node, Git.node],
})

export * as CommitDraft from "./commit-draft"
