import * as Tool from "./tool"
import DESCRIPTION from "./task.txt"
import { ToolJsonSchema } from "./json-schema"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { BackgroundJob } from "@/background/job"
import { Session } from "@/session/session"
import { SessionID, MessageID } from "../session/schema"
import { MessageV2 } from "../session/message-v2"
import { Agent } from "../agent/agent"
import { deriveSubagentSessionPermission } from "../agent/subagent-permissions"
import type { SessionPrompt } from "../session/prompt"
import { Config } from "@/config/config"
import { ModelsDev } from "@opencode-ai/core/models-dev"
import { ModelV2 } from "@opencode-ai/core/model"
import { Effect, Exit, Option, Schema, Scope } from "effect"
import { EffectBridge } from "@/effect/bridge"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Database } from "@opencode-ai/core/database/database"
import { SUBAGENT_NO_RESULT, SUBAGENT_OUTPUT_MISSING, SUBAGENT_STOPPED } from "@/permission/autonomy-texts"
import { InstanceState } from "@/effect/instance-state"
import { existsSync } from "node:fs"
import * as path from "path"
import { MCP } from "@/mcp"
import { RoleAlias } from "../agent/role-alias"
import { Permission } from "@/permission"
import { READ_SHELL_ROLES } from "@/permission/autonomy-table"
import type { PermissionV1 } from "@opencode-ai/core/v1/permission"

export interface TaskPromptOps {
  cancel(sessionID: SessionID): Effect.Effect<void>
  resolvePromptParts(template: string): Effect.Effect<SessionPrompt.PromptInput["parts"]>
  prompt(input: SessionPrompt.PromptInput): Effect.Effect<SessionV1.WithParts>
}

const id = "task"
const BACKGROUND_DESCRIPTION = [
  "Background mode: background=true launches the subagent asynchronously and returns immediately.",
  "Foreground is the default; use it when you need the result before continuing.",
  "Use background only for independent work that can run while you continue elsewhere.",
  "You will be notified automatically when it finishes.",
].join(" ")
const BACKGROUND_STARTED = [
  "The task is working in the background. You will be notified automatically when it finishes.",
  "DO NOT sleep, poll for progress, ask the task for status, or duplicate this task's work — avoid working with the same files or topics it is using.",
  "Work on non-overlapping tasks, or briefly tell the user what you launched and end your response.",
].join("\n")
const BACKGROUND_UPDATED = [
  "Additional context sent to the running background task.",
  "The task is still working in the background. You will be notified automatically when it finishes.",
  "DO NOT sleep, poll for progress, ask the task for status, or duplicate this task's work — avoid working with the same files or topics it is using.",
  "Work on non-overlapping tasks, or briefly tell the user what you sent and end your response.",
].join("\n")

const BaseParameterFields = {
  description: Schema.String.annotate({ description: "A short (3-5 words) description of the task" }),
  prompt: Schema.String.annotate({ description: "The task for the agent to perform" }),
  subagent_type: Schema.String.annotate({ description: "The type of specialized agent to use for this task" }),
  task_id: Schema.optional(Schema.String).annotate({
    description:
      "This should only be set if you mean to resume a previous task (you can pass a prior task_id and the task will continue the same subagent session as before instead of creating a fresh one)",
  }),
  command: Schema.optional(Schema.String).annotate({ description: "The command that triggered this task" }),
  expected_outputs: Schema.optional(Schema.Array(Schema.String)).annotate({
    description:
      "Paths the subagent must produce (absolute, or relative to the session directory). After the run, any path that does not exist makes the task return SUBAGENT_OUTPUT_MISSING naming it.",
  }),
  // 1.2.7 P-01a (N7-055, K7-07).
  permissions: Schema.optional(
    Schema.Struct({
      bash: Schema.optional(Schema.Array(Schema.String)),
    }),
  ).annotate({
    description:
      'Extra shell command patterns this subagent may run without asking, e.g. ["sh ./scripts/check.sh"]. Only patterns this session may run itself are accepted. planner and data-collector stay limited to the read class (U4).',
  }),
}

const BaseParameters = Schema.Struct(BaseParameterFields)

export const Parameters = Schema.Struct({
  ...BaseParameterFields,
  background: Schema.optional(Schema.Boolean).annotate({
    description:
      "Run the agent in the background. You will be notified when it completes. DO NOT sleep, poll, or proactively check on its progress",
  }),
})

export function renderTaskOutput(input: {
  sessionID: SessionID
  state: "running" | "completed" | "error"
  summary?: string
  text: string
}) {
  const tag = input.state === "error" ? "task_error" : "task_result"
  return [
    `<task id="${input.sessionID}" state="${input.state}">`,
    ...(input.summary ? [`<summary>${input.summary}</summary>`] : []),
    `<${tag}>`,
    input.text,
    `</${tag}>`,
    "</task>",
  ].join("\n")
}

// How autonomous mode words a subagent run it stopped (`autonomy-texts.ts`, which the permission service writes it with),
// so the task call can tell the stop from a failure.
export {
  SUBAGENT_NO_RESULT,
  SUBAGENT_OUTPUT_MISSING,
  SUBAGENT_STOPPED,
  subagentStoppedMessage,
} from "@/permission/autonomy-texts"

/** 1.2.7 P-01a (N7-131): a `permissions` entry that is not one literal command. */
export const TASK_GRANT_INVALID = "TASK_GRANT_INVALID"
/** 1.2.7 P-01a (N7-132): a `permissions` entry the child's role may not run. */
export const TASK_GRANT_ROLE_DENIED = "TASK_GRANT_ROLE_DENIED"
/** 1.2.7 P-01a (N7-056): a `permissions` entry the parent session may not run itself. */
export const TASK_GRANT_EXCEEDS_PARENT = "TASK_GRANT_EXCEEDS_PARENT"

const GRANT_MAX_ENTRIES = 20
const GRANT_MAX_LENGTH = 500
// SR7-04: anything whose runtime meaning can differ from the string the parent vouched for.
const GRANT_NOT_LITERAL = /[*?$`<>|;&(){}[\]]/
const GRANT_CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/
const GRANT_ASSIGNMENT = /^\s*[A-Za-z_][A-Za-z0-9_]*=/
// The read roles (U4, N7-130 `READ_SHELL_ROLES`): a grant never widens them past their read class, so they take none.

const shown = (pattern: string) => JSON.stringify(pattern.length > 120 ? pattern.slice(0, 120) + "…" : pattern)

/**
 * 1.2.7 P-01a (SR7-04): the refusal for the first `permissions` entry that may not be granted, or undefined. Order: the
 * literal rule, then the parent's own effective rules (never wider than the parent), then the child's effective merged
 * ruleset as it will be created and the read-role limit. A role deny is final: a grant never reopens it.
 */
export function taskGrantRefusal(input: {
  patterns: readonly string[]
  role: string
  parent: PermissionV1.Ruleset
  child: PermissionV1.Ruleset
}): string | undefined {
  const invalid = (pattern: string) =>
    `${TASK_GRANT_INVALID} Task not started: permissions entry ${shown(pattern)} is not one literal command (no * ? $ backquote < > | ; & ( ) { } [ ], no leading NAME=value, no control characters, one line, at most ${GRANT_MAX_LENGTH} characters, at most ${GRANT_MAX_ENTRIES} entries).`
  if (input.patterns.length > GRANT_MAX_ENTRIES) return invalid(input.patterns[GRANT_MAX_ENTRIES]!)
  for (const pattern of input.patterns) {
    if (
      pattern.trim() === "" ||
      pattern.length > GRANT_MAX_LENGTH ||
      GRANT_NOT_LITERAL.test(pattern) ||
      GRANT_CONTROL.test(pattern) ||
      GRANT_ASSIGNMENT.test(pattern)
    )
      return invalid(pattern)
  }
  for (const pattern of input.patterns.map((item) => item.trim())) {
    if (Permission.evaluate("bash", pattern, input.parent).action === "deny")
      return `${TASK_GRANT_EXCEEDS_PARENT} Task not started: permissions grants ${shown(pattern)}, which this session may not run itself.`
    if (READ_SHELL_ROLES.has(input.role) || Permission.evaluate("bash", pattern, input.child).action === "deny")
      return `${TASK_GRANT_ROLE_DENIED} Task not started: the ${input.role} role may not run ${shown(pattern)}. Ask for it in your final message instead.`
  }
  return undefined
}

/** S-03b: the `expected_outputs` paths that do not exist, resolved against `root`. Existence only; content is never read. */
export function missingOutputs(root: string, paths: readonly string[] | undefined) {
  return (paths ?? []).filter((item) => !existsSync(path.isAbsolute(item) ? item : path.resolve(root, item)))
}

/** The task result when promised outputs are absent: SUBAGENT_OUTPUT_MISSING, the paths, the task_id and the answer. */
export function subagentOutputMissingText(sessionID: SessionID, missing: readonly string[], answer?: string) {
  return [
    `${SUBAGENT_OUTPUT_MISSING} ${missing.join(", ")} (task_id: ${sessionID})`,
    "The subagent finished but these promised paths do not exist. Do not treat this task as done: mark its row blocked with this note, or pass this task_id to continue it.",
    answer ? `What the subagent answered:\n${answer}` : "The subagent left no answer.",
  ].join("\n\n")
}

/** S-03a: why a subagent run ended without an answer (register N-102). */
export type NoResultReason = "length" | "tool-calls" | "no-text" | "unfinished"

const NO_RESULT_WHY: Record<NoResultReason, string> = {
  length: "it hit the output token limit before writing an answer.",
  "tool-calls": "its last step was a tool call and it never wrote a final answer.",
  "no-text": "it finished without writing any text.",
  unfinished: "its run ended before it finished.",
}

/** The task result for a subagent run with no answer: SUBAGENT_NO_RESULT, the reason and the task_id, never "". */
export function subagentNoResultText(sessionID: SessionID, reason: NoResultReason, partial?: string) {
  return [
    `${SUBAGENT_NO_RESULT} ${reason} (task_id: ${sessionID}): ${NO_RESULT_WHY[reason]}`,
    "Do not treat this task as done. Check what it was meant to produce, then pass this task_id to continue it or carry on another way.",
    partial ? `What the subagent had so far:\n${partial}` : "The subagent left no partial result.",
  ].join("\n\n")
}

/** What a subagent's last message amounts to as a task result. Also read when a restart lost the waiting task call. */
export function taskOutcome(sessionID: SessionID, result: SessionV1.WithParts) {
  if (result.info.role !== "assistant") return { type: "unfinished" as const }
  const failed = result.parts.findLast((item) => item.type === "tool" && item.state.status === "error")
  const message = result.info.error
    ? "message" in result.info.error.data && typeof result.info.error.data.message === "string"
      ? result.info.error.data.message
      : result.info.error.name
    : failed?.type === "tool" && failed.state.status === "error"
      ? failed.state.error
      : undefined
  // Nobody waits on a stopped subagent, so the parent gets the reason and what the subagent had so far, and decides
  // what comes next. Its turn goes on.
  const stop = [message, failed?.type === "tool" && failed.state.status === "error" ? failed.state.error : undefined].find(
    (text) => text?.startsWith(SUBAGENT_STOPPED),
  )
  if (stop) {
    const partial = result.parts.findLast((item) => item.type === "text" && item.text.trim() !== "")
    return {
      type: "stopped" as const,
      text: [
        `${stop} (task_id: ${sessionID})`,
        "The subagent's run was stopped and nobody was asked. Decide the next step yourself: carry on another way, or pass this task_id to continue it with different instructions.",
        partial?.type === "text" ? `What the subagent had so far:\n${partial.text}` : "The subagent left no partial result.",
      ].join("\n\n"),
    }
  }
  if (message) return { type: "failed" as const, message: `Subagent failed (task_id: ${sessionID}): ${message}` }
  const last = result.parts.findLast((item) => item.type === "text" && item.text.trim() !== "")
  const text = last?.type === "text" ? last.text : undefined
  const finish = result.info.finish
  const finished = !!finish && !["tool-calls", "unknown"].includes(finish)
  if (finished && text !== undefined) return { type: "completed" as const, text }
  // S-03a: no answer, or a run that stopped mid-way. The parent gets the reason, never an empty completed result.
  const reason: NoResultReason = !finished
    ? finish === "tool-calls"
      ? "tool-calls"
      : "unfinished"
    : finish === "length"
      ? "length"
      : "no-text"
  return { type: "empty" as const, reason, text: subagentNoResultText(sessionID, reason, text) }
}

export const TaskTool = Tool.define(
  id,
  Effect.gen(function* () {
    const agent = yield* Agent.Service
    const background = yield* BackgroundJob.Service
    const config = yield* Config.Service
    const sessions = yield* Session.Service
    const scope = yield* Scope.Scope
    const flags = yield* RuntimeFlags.Service
    const database = yield* Database.Service
    // Optional: only to know whether swarm-web is connected for the researcher alias. Without it that alias runs as general.
    const mcp = Option.getOrUndefined(yield* Effect.serviceOption(MCP.Service))

    const run = Effect.fn("TaskTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
    ) {
      const cfg = yield* config.get()
      const runInBackground = params.background === true
      if (runInBackground && !flags.experimentalBackgroundSubagents) {
        return yield* Effect.fail(
          new Error("Background subagents require OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true"),
        )
      }

      const parent = yield* sessions.get(ctx.sessionID)
      let current = parent
      let depth = 0
      while (current.parentID) {
        depth++
        current = yield* sessions.get(current.parentID)
      }
      if (depth >= (cfg.subagent_depth ?? 1)) {
        return yield* Effect.fail(
          new Error(
            `Subagent depth limit reached (${cfg.subagent_depth ?? 1}). Increase "subagent_depth" to allow nested subagents.`,
          ),
        )
      }

      // Resolve the requested name first, so the ask below is about the agent that will really run: an alias can
      // never start what its target may not (spec 161 D13, SA-18).
      const raw = params.subagent_type
      const registered = new Map((yield* agent.list()).map((item) => [item.name, item]))
      const connected = Object.entries(mcp ? yield* mcp.status() : {})
        .filter(([, entry]) => entry.status === "connected")
        .map(([key]) => key)
      const resolved = RoleAlias.resolveRole(raw, (name) => registered.get(name), connected)
      if (resolved.type === "unknown") {
        return yield* Effect.fail(new Error(`Unknown agent type: ${raw} is not a valid agent type`))
      }
      if (resolved.type === "unavailable") {
        // An alias whose target the person disabled must not run as another agent with the same rights (S163-07).
        return yield* Effect.fail(
          new Error(
            `The role "${RoleAlias.echoName(raw) ?? "requested"}" runs as the agent "${resolved.target}", which is disabled or not available. Choose another agent.`,
          ),
        )
      }
      const next = yield* agent.get(resolved.name)
      if (!next) {
        return yield* Effect.fail(new Error(`Unknown agent type: ${raw} is not a valid agent type`))
      }

      // `true` (a command's subtask) skips the ask for any agent; a list (agents the person @-mentioned) only for those
      // agents, so a mention never opens the way to an agent the current mode denies (S163-03).
      const bypass = ctx.extra?.bypassAgentCheck
      if (!(bypass === true || (Array.isArray(bypass) && bypass.includes(next.name)))) {
        yield* ctx.ask({
          permission: id,
          patterns: [next.name],
          always: ["*"],
          // Starting one changes nothing by itself. Each call it makes is checked on its own.
          harmless: ctx.trust ? true : undefined,
          metadata: {
            description: params.description,
            subagent_type: next.name,
            requested: raw,
          },
        })
      }
      const note = resolved.type === "fallback" ? RoleAlias.fallbackNote(raw, next.name) : undefined
      const role =
        resolved.type === "fallback"
          ? RoleAlias.FALLBACK_ROLE_LINE
          : resolved.type === "alias"
            ? resolved.role
            : undefined
      const prefix = role === undefined ? "" : RoleAlias.rolePrefix(raw, next.name, role)
      const withNote = (text: string) => (note === undefined ? text : `${note}\n\n${text}`)

      const session = params.task_id
        ? yield* sessions.get(SessionID.make(params.task_id)).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
        : undefined
      const childPermission = deriveSubagentSessionPermission({
        parentSessionPermission: parent.permission ?? [],
        subagent: next,
      })
      const childToolDenies = [
        ...(next.permission.some((rule) => rule.permission === "todowrite")
          ? []
          : [{ permission: "todowrite" as const, pattern: "*" as const, action: "deny" as const }]),
        ...(next.permission.some((rule) => rule.permission === id)
          ? []
          : [{ permission: id, pattern: "*" as const, action: "deny" as const }]),
        ...(cfg.experimental?.primary_tools?.map((permission) => ({
          permission,
          pattern: "*" as const,
          action: "deny" as const,
        })) ?? []),
      ]
      const childSessionPermission = [
        ...childPermission,
        ...childToolDenies.filter(
          (deny) =>
            !childPermission.some(
              (rule) => rule.permission === deny.permission && rule.pattern === deny.pattern && rule.action === deny.action,
            ),
        ),
      ]
      // 1.2.7 P-01a: validated before any child session exists, so a refused grant starts nothing.
      const grantPatterns = (params.permissions?.bash ?? []).map((pattern) => pattern.trim())
      if ((params.permissions?.bash ?? []).length > 0) {
        const parentAgent = yield* agent.get(ctx.agent)
        const refusal = taskGrantRefusal({
          patterns: params.permissions?.bash ?? [],
          role: next.name,
          // Unknown parent agent: nothing is vouched for (fail-closed).
          parent: parentAgent
            ? Permission.merge(parentAgent.permission, parent.permission ?? [])
            : [{ permission: "*", pattern: "*", action: "deny" }],
          child: Permission.merge(next.permission, session?.permission ?? childSessionPermission),
        })
        if (refusal) return yield* Effect.fail(new Error(refusal))
      }
      const nextSession =
        session ??
        (yield* sessions.create({
          parentID: ctx.sessionID,
          title: params.description + ` (@${next.name} subagent)`,
          agent: next.name,
          permission: childSessionPermission,
        }))

      const msg = yield* MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID }).pipe(
        Effect.provideService(Database.Service, database),
        Effect.orDie,
      )
      if (msg.info.role !== "assistant") return yield* Effect.fail(new Error("Not an assistant message"))
      const variant = msg.info.variant

      // A shipped provider says which of its models carry the delegated work. Only while the session is on it, and not for
      // anyone who wrote their own providers: their agents run as they wrote them.
      const shipped = ModelsDev.bundled()
      const delegated =
        shipped?.provider.id === msg.info.providerID && Object.keys(cfg.provider ?? {}).length === 0
          ? shipped.subagents?.[next.name]
          : undefined
      const assigned =
        next.model ?? (delegated ? { modelID: ModelV2.ID.make(delegated), providerID: msg.info.providerID } : undefined)
      const model = assigned ?? {
        modelID: msg.info.modelID,
        providerID: msg.info.providerID,
      }
      const metadata = {
        parentSessionId: ctx.sessionID,
        sessionId: nextSession.id,
        model,
        ...(next.name === raw ? {} : { requested: raw, agent: next.name }),
        ...(runInBackground ? { background: true } : {}),
      }

      yield* ctx.metadata({
        title: params.description,
        metadata,
      })

      const ops = ctx.extra?.promptOps as TaskPromptOps
      if (!ops) return yield* Effect.fail(new Error("TaskTool requires promptOps in ctx.extra"))
      // S-03b: captured here, so a background run checks `expected_outputs` against the same session directory.
      const root = (yield* InstanceState.context).directory

      // 1.2.7 P-01a (N7-133): the grant lives in the permission service's memory for this child only; a call without
      // `permissions` (a resume included) drops any earlier one. Without the service nothing is granted (fail-closed).
      const permissionService = Option.getOrUndefined(yield* Effect.serviceOption(Permission.Service))
      const setGrant = (patterns: readonly string[]) =>
        permissionService?.grantTask?.(nextSession.id, patterns, parent.parentID ? "subagent" : "root") ?? Effect.void
      yield* setGrant(grantPatterns)

      const runTask = Effect.fn("TaskTool.runTask")(function* () {
        const parts = yield* ops.resolvePromptParts(prefix + params.prompt)
        const result = yield* ops.prompt({
          messageID: MessageID.ascending(),
          sessionID: nextSession.id,
          model: {
            modelID: model.modelID,
            providerID: model.providerID,
          },
          variant: assigned ? undefined : variant,
          agent: next.name,
          parts,
        })
        const outcome = taskOutcome(nextSession.id, result)
        if (outcome.type === "failed") return yield* Effect.fail(new Error(outcome.message))
        if (outcome.type === "empty") return yield* Effect.fail(new Error(outcome.text))
        if (outcome.type === "unfinished")
          return yield* Effect.fail(new Error(subagentNoResultText(nextSession.id, "unfinished")))
        const missing = missingOutputs(root, params.expected_outputs)
        if (missing.length > 0)
          return yield* Effect.fail(new Error(subagentOutputMissingText(nextSession.id, missing, outcome.text)))
        return outcome.text
      })
      // The grant ends with the child's run, finished, failed or aborted.
      const runGranted = () => runTask().pipe(Effect.ensuring(setGrant([])))

      const inject = Effect.fn("TaskTool.injectBackgroundResult")(function* (
        state: "completed" | "error",
        text: string,
      ) {
        const currentParent = yield* sessions.get(ctx.sessionID)
        yield* ops
          .prompt({
            sessionID: ctx.sessionID,
            agent: currentParent.agent ?? ctx.agent,
            variant,
            parts: [
              {
                type: "text",
                synthetic: true,
                text: renderTaskOutput({
                  sessionID: nextSession.id,
                  state,
                  summary:
                    state === "completed"
                      ? `Background task completed: ${params.description}`
                      : `Background task failed: ${params.description}`,
                  text,
                }),
              },
            ],
          })
          .pipe(Effect.ignore, Effect.forkIn(scope, { startImmediately: true }))
      })

      const notify = Effect.fn("TaskTool.notifyBackgroundResult")(function* (jobID: string) {
        yield* background.wait({ id: jobID }).pipe(
          Effect.flatMap((result) => {
            if (result.info?.status === "completed") return inject("completed", result.info.output ?? "")
            if (result.info?.status === "error") return inject("error", result.info.error ?? "")
            return Effect.void
          }),
          Effect.forkIn(scope, { startImmediately: true }),
        )
      })

      if (yield* background.extend({ id: nextSession.id, run: runGranted() })) {
        return {
          title: params.description,
          metadata: {
            ...metadata,
            background: true,
            jobId: nextSession.id,
          },
          output: renderTaskOutput({
            sessionID: nextSession.id,
            state: "running",
            summary: "Background task updated",
            text: BACKGROUND_UPDATED,
          }),
        }
      }

      const info = yield* background.start({
        id: nextSession.id,
        type: id,
        title: params.description,
        metadata,
        onPromote: Effect.all([
          ctx.metadata({
            title: params.description,
            metadata: { ...metadata, background: true, jobId: nextSession.id },
          }),
          notify(nextSession.id),
        ]),
        run: runGranted().pipe(Effect.onInterrupt(() => ops.cancel(nextSession.id))),
      })

      function backgroundResult() {
        return {
          title: params.description,
          metadata: {
            ...metadata,
            background: true,
            jobId: info.id,
          },
          output: renderTaskOutput({
            sessionID: nextSession.id,
            state: "running",
            summary: "Background task started",
            text: withNote(BACKGROUND_STARTED),
          }),
        }
      }

      if (runInBackground) {
        yield* notify(info.id)
        return backgroundResult()
      }

      const runCancel = yield* EffectBridge.make()
      const cancel = ops.cancel(nextSession.id)

      function onAbort() {
        runCancel.fork(cancel)
      }

      return yield* Effect.acquireUseRelease(
        Effect.sync(() => {
          ctx.abort.addEventListener("abort", onAbort)
        }),
        () =>
          Effect.gen(function* () {
            const result = yield* Effect.raceFirst(
              background.wait({ id: nextSession.id }).pipe(Effect.map((waited) => waited.info)),
              background.waitForPromotion(nextSession.id),
            )
            if (result?.metadata?.background === true) return backgroundResult()
            if (result?.status === "error") return yield* Effect.fail(new Error(result.error ?? "Task failed"))
            if (result?.status === "cancelled") return yield* Effect.fail(new Error("Task cancelled"))
            return {
              title: params.description,
              metadata,
              output: renderTaskOutput({
                sessionID: nextSession.id,
                state: "completed",
                text: withNote(result?.output ?? ""),
              }),
            }
          }),
        (_, exit) =>
          Effect.gen(function* () {
            if (Exit.hasInterrupts(exit))
              yield* Effect.all([cancel, background.cancel(nextSession.id)], { discard: true })
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                ctx.abort.removeEventListener("abort", onAbort)
              }),
            ),
          ),
      )
    })

    return {
      description: flags.experimentalBackgroundSubagents
        ? [DESCRIPTION, BACKGROUND_DESCRIPTION].join("\n\n")
        : DESCRIPTION,
      parameters: Parameters,
      jsonSchema: flags.experimentalBackgroundSubagents ? undefined : ToolJsonSchema.fromSchema(BaseParameters),
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        run(params, ctx).pipe(Effect.orDie),
    }
  }),
)
