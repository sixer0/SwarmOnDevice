import { InstanceStore } from "@/project/instance-store"
import { errorMessage } from "@/util/error"
import { isRecord } from "@/util/record"
import { NamedError } from "@opencode-ai/core/util/error"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Effect, Layer, Option } from "effect"
import { renderTaskOutput, taskOutcome } from "../tool/task"
import { MessageV2 } from "./message-v2"
import { SessionPrompt } from "./prompt"
import { RunLease } from "./run-lease"
import { SessionID } from "./schema"
import { Session } from "./session"

/** What the model reads in place of a result. It has to know the call may have had effects: a killed bash can even still be running. */
export const INTERRUPTED_TOOL =
  "[Swarm restarted while this tool was running. It may have partly run, or may still be running in the background. Check the current state before repeating it.]"

/** The same moment for a call stopped at a prompt: it is known not to have run, and the person was never asked. */
export const NOT_RUN_TOOL =
  "[Swarm restarted while this call was waiting for a person, so it did not run and nobody answered. If it is still needed, make the call again.]"

type Run = Effect.Effect<SessionV1.WithParts | undefined>

const resumeAll = Effect.fn("SessionResume.resumeAll")(function* (found: RunLease.Interrupted[]) {
  const store = yield* InstanceStore.Service
  const byDirectory = Map.groupBy(found, (item) => item.lease.directory)
  yield* Effect.forEach(
    [...byDirectory],
    ([directory, items]) =>
      store.provide({ directory }, resumeDirectory(items)).pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            yield* Effect.logError("could not resume interrupted runs", { directory, cause })
            items.forEach((item) => RunLease.end(item.lease.sessionID))
          }),
        ),
      ),
    { concurrency: "unbounded", discard: true },
  )
})

export const resumeDirectory = Effect.fn("SessionResume.resumeDirectory")(function* (items: RunLease.Interrupted[]) {
  const sessions = yield* Session.Service
  const prompt = yield* SessionPrompt.Service
  const runs = new Map<string, Run>()

  const lastAssistant = (sessionID: SessionID) =>
    sessions
      .findMessage(sessionID, (message) => message.info.role === "assistant")
      .pipe(
        Effect.map(Option.getOrUndefined),
        Effect.catchCause(() => Effect.succeed(undefined)),
      )

  const interrupt = Effect.fnUntraced(function* (part: SessionV1.ToolPart, stated?: string) {
    const state = part.state
    if (state.status !== "pending" && state.status !== "running") return
    const end = Date.now()
    const { waitingOnPermission, ...metadata } = "metadata" in state && isRecord(state.metadata) ? state.metadata : {}
    const start = "time" in state ? state.time.start : end
    if (!stated && (part.tool === "question" || waitingOnPermission === true)) {
      yield* sessions.updatePart({
        ...part,
        state: {
          status: "error",
          input: state.input,
          error: NOT_RUN_TOOL,
          metadata: { ...metadata, notRun: "away" },
          time: { start, end },
        },
      })
      return
    }
    const text = stated ?? INTERRUPTED_TOOL
    yield* sessions.updatePart({
      ...part,
      state: {
        status: "error",
        input: state.input,
        error: text,
        // A bash streams its output into metadata, and an interrupted part replays that as if it were the whole result.
        metadata: {
          ...metadata,
          interrupted: true,
          ...(typeof metadata.output === "string" ? { output: `${metadata.output}\n\n${text}` } : {}),
        },
        time: { start, end },
      },
    })
  })

  // A parent's task call was waiting on this subagent. Give it the answer the tool would have returned.
  const settleTask = Effect.fnUntraced(function* (part: SessionV1.ToolPart, child: SessionID) {
    const state = part.state
    if (state.status !== "running") return
    const run = runs.get(child)
    const result = run ? yield* run : yield* lastAssistant(child)
    const outcome = result && result.info.role === "assistant" ? taskOutcome(child, result) : undefined
    // A run still mid-way when Swarm stopped can be continued; a run that ended with no answer (S-03a) is reported.
    if (
      !outcome ||
      outcome.type === "unfinished" ||
      (outcome.type === "empty" && (outcome.reason === "unfinished" || outcome.reason === "tool-calls"))
    ) {
      yield* interrupt(
        part,
        `[Swarm restarted while this subagent was running and it did not finish. Pass task_id "${child}" to the task tool to continue it.]`,
      )
      return
    }
    if (outcome.type === "failed" || outcome.type === "empty") {
      yield* interrupt(part, outcome.type === "failed" ? outcome.message : outcome.text)
      return
    }
    yield* sessions.updatePart({
      ...part,
      state: {
        status: "completed",
        input: state.input,
        output: renderTaskOutput({ sessionID: child, state: "completed", text: outcome.text }),
        metadata: isRecord(state.metadata) ? state.metadata : {},
        title: state.title ?? part.tool,
        time: { start: state.time.start, end: Date.now() },
      },
    })
  })

  const tidy = Effect.fnUntraced(function* (sessionID: SessionID, input: { wait: boolean; error?: (info: SessionV1.Assistant) => SessionV1.Assistant["error"] }) {
    const last = yield* lastAssistant(sessionID)
    if (!last || last.info.role !== "assistant") return
    const info = last.info
    // Stream fragments have no end time. Deltas are not saved, so what is stored is empty or cut off and worth nothing.
    yield* Effect.forEach(
      last.parts.filter((part) => (part.type === "text" || part.type === "reasoning") && !part.time?.end),
      (part) => sessions.removePart({ sessionID, messageID: info.id, partID: part.id }),
      { discard: true },
    )
    const tools = last.parts.filter((part): part is SessionV1.ToolPart => part.type === "tool")
    const open = tools.filter((part) => part.state.status === "pending" || part.state.status === "running")
    if (info.time.completed && open.length === 0) return
    const close = (part: SessionV1.ToolPart) => {
      const child = part.tool === "task" && part.state.status === "running" ? part.state.metadata?.sessionId : undefined
      if (!input.wait || typeof child !== "string") return interrupt(part)
      return settleTask(part, SessionID.make(child)).pipe(
        Effect.onInterrupt(() =>
          // The user pressed stop on the parent while it waited: that stops its subagents too, like any other run.
          prompt.cancel(SessionID.make(child)).pipe(Effect.andThen(interrupt(part))),
        ),
      )
    }
    const finish = Effect.gen(function* () {
      const hasOutput = last.parts.some(
        (part) => part.type === "tool" || ((part.type === "text" || part.type === "reasoning") && part.time?.end),
      )
      // The step produced nothing that survived. Without this the model would be asked to continue an empty turn.
      if (!hasOutput && !input.error) {
        yield* sessions.removeMessage({ sessionID, messageID: info.id })
        return
      }
      yield* sessions.updateMessage({
        ...info,
        time: { ...info.time, completed: info.time.completed ?? Date.now() },
        finish: info.finish ?? (tools.length ? "tool-calls" : undefined),
        ...(input.error ? { error: input.error(info) } : {}),
      })
    })
    yield* Effect.forEach(open, close, { concurrency: "unbounded", discard: true }).pipe(Effect.ensuring(finish))
  })

  const one = (item: RunLease.Interrupted): Run => {
    const sessionID = SessionID.make(item.lease.sessionID)
    return Effect.gen(function* () {
      const exists = yield* sessions.get(sessionID).pipe(
        Effect.as(true),
        Effect.catchCause(() => Effect.succeed(false)),
      )
      if (!exists) {
        RunLease.end(sessionID)
        return undefined
      }
      yield* Effect.logInfo("resuming interrupted run", {
        "session.id": sessionID,
        action: item.action,
        resumes: item.lease.resumes,
      })
      if (item.action === "continue") return yield* prompt.resume(sessionID, tidy(sessionID, { wait: true }))
      yield* tidy(sessionID, {
        wait: false,
        error: (info) =>
          item.action === "stopped"
            ? MessageV2.fromError(new DOMException("Aborted", "AbortError"), {
                providerID: info.providerID,
                aborted: true,
              })
            : new NamedError.Unknown({
                message:
                  "Swarm stopped before this run finished, and it was not safe to continue on its own. Send a message to carry on.",
              }).toObject(),
      })
      return undefined
    }).pipe(
      Effect.ensuring(Effect.sync(() => item.action !== "continue" && RunLease.end(sessionID))),
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          yield* Effect.logError("could not resume run", { "session.id": sessionID, error: errorMessage(cause) })
          RunLease.end(sessionID)
          return undefined
        }),
      ),
    )
  }

  // Memoised up front, so a parent waiting on a subagent and the sweep below share one run of it.
  yield* Effect.forEach(
    items,
    (item) =>
      Effect.cached(one(item)).pipe(
        Effect.tap((run) => Effect.sync(() => runs.set(item.lease.sessionID, run))),
      ),
    { discard: true },
  )
  yield* Effect.forEach([...runs.values()], (run) => run, { concurrency: "unbounded", discard: true })
})

/**
 * Part of the server's own layer graph because it has to be: the session services hold running work in memory, so a run
 * resumed through any other copy of them would be invisible to the status API, deaf to Stop, and could run twice.
 */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const found = RunLease.takePending()
    if (found.length === 0) return
    yield* resumeAll(found).pipe(Effect.forkScoped)
  }),
)

export * as SessionResume from "./resume"
