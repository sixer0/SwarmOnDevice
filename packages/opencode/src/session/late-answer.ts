import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Cause, Effect, Option, Schema } from "effect"
import { NamedError } from "@opencode-ai/core/util/error"
import { Wildcard } from "@opencode-ai/core/util/wildcard"
import { Agent } from "@/agent/agent"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Permission } from "@/permission"
import { Autonomy } from "@/permission/autonomy"
import { Question } from "@/question"
import { ToolRegistry } from "@/tool/registry"
import { SessionPrompt } from "./prompt"
import { MessageID, SessionID } from "./schema"
import { Session } from "./session"

// The agent carried on without a person's answer, and now the person has answered. That answer has nowhere to go: the
// call it belonged to is long over. So it reaches the agent the way anything else from the user does, as a message in
// the session they started. A subagent's own run has already reported back by now, which is why it goes to the root.

export const make = Effect.gen(function* () {
  const sessions = yield* Session.Service
  const prompt = yield* SessionPrompt.Service
  const permission = yield* Permission.Service
  const question = yield* Question.Service
  const events = yield* EventV2Bridge.Service
  // Only what running a held call again needs. Without them an answer wakes the agent, as before (U11 E1).
  const registry = Option.getOrUndefined(yield* Effect.serviceOption(ToolRegistry.Service))
  const agents = Option.getOrUndefined(yield* Effect.serviceOption(Agent.Service))
  const autonomy = Option.getOrUndefined(yield* Effect.serviceOption(Autonomy.Service))

  const rootOf = (sessionID: SessionID): Effect.Effect<SessionID> =>
    sessions.get(sessionID).pipe(
      Effect.flatMap((session) => (session.parentID ? rootOf(session.parentID) : Effect.succeed(session.id))),
      Effect.catchCause(() => Effect.succeed(sessionID)),
    )

  const lastAgent = (sessionID: SessionID) =>
    sessions
      .findMessage(sessionID, (message) => message.info.role === "user")
      .pipe(
        Effect.map(Option.getOrUndefined),
        Effect.map((last) => (last?.info.role === "user" ? last.info.agent : undefined)),
        Effect.catchCause(() => Effect.succeed(undefined)),
      )

  const send = Effect.fn("LateAnswer.send")(function* (sessionID: SessionID, text: string) {
    yield* prompt.prompt({
      sessionID,
      agent: yield* lastAgent(sessionID),
      // Keeps the spend limit's run open: this message must not read as someone starting a new one.
      parts: [{ type: "text", text, metadata: { lateAnswer: true } }],
    })
  })

  const report = (sessionID: SessionID) =>
    Effect.catchCause((cause: Cause.Cause<unknown>) =>
      Effect.gen(function* () {
        yield* Effect.logError("could not continue after a late answer", { sessionID, cause })
        yield* events.publish(Session.Event.Error, {
          sessionID,
          error: new NamedError.Unknown({ message: Cause.pretty(cause) }).toObject(),
        })
      }),
    )

  // Nobody will open a deleted or archived session to answer these, so they should stop being listed.
  const abandoned = Effect.fnUntraced(function* (sessionID: SessionID) {
    const open = (id: SessionID) =>
      sessions.get(id).pipe(
        Effect.map((session) => !session.time.archived),
        Effect.catchCause(() => Effect.succeed(false)),
      )
    return !(yield* open(sessionID)) || !(yield* open(yield* rootOf(sessionID)))
  })

  /**
   * Runs the one call an approved entry showed, through its own tool and in the root's context. It asks like any call:
   * the grant just given is what lets it through, so other content is held anew and a class X call is still refused.
   * Undefined when nothing here can run it, and the answer only wakes the agent then.
   *
   * `granted` is what the answer already granted for this call: the entry's prompt and its `follows`. A tool can ask more
   * than once for one call (a read beyond the folder asks `external_directory`, then `read`), and the entry showed only
   * one of those prompts. The person approved the call, so each other prompt of that same call gets a grant of its own
   * just before it asks (C97 F3). It still goes through the gate, so class X is refused, and the grant is used by that
   * one prompt.
   */
  const rerun = Effect.fnUntraced(function* (
    root: SessionID,
    requestID: PermissionV1.ID,
    call: string,
    granted: Pick<PermissionV1.Request, "permission" | "patterns">[],
  ) {
    const bound = decodeCall(call)
    if (Option.isNone(bound) || !registry || !agents) return undefined
    const setup = yield* Effect.gen(function* () {
      const tool = (yield* registry.all()).find((item) => item.id === bound.value.tool)
      if (!tool) return undefined
      const agent = yield* agents.get((yield* lastAgent(root)) ?? (yield* agents.defaultAgent()))
      const session = yield* sessions.get(root)
      return { tool, agent, ruleset: Permission.merge(agent.permission, session.permission ?? []) }
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("could not set up a held call to run again", { requestID, cause }).pipe(Effect.as(undefined)),
      ),
    )
    if (!setup) return undefined
    const exit = yield* setup.tool
      .execute(bound.value.args, {
        sessionID: root,
        messageID: MessageID.ascending(),
        agent: setup.agent.name,
        abort: new AbortController().signal,
        messages: [],
        metadata: () => Effect.void,
        // A real agent's call, with the stricter answer where this cannot know: no snapshot is assumed.
        trust: { canUndo: false },
        ask: ({ planLimited, ...input }) => {
          // As `session/tools.ts` does for one request under the plan agent's limits: an edit allow asks instead.
          const ruleset = planLimited
            ? setup.ruleset.map((rule) =>
                rule.action === "allow" && Wildcard.match("edit", rule.permission)
                  ? { permission: "edit", pattern: rule.pattern, action: "ask" as const }
                  : rule,
              )
            : setup.ruleset
          return Effect.gen(function* () {
            const covered = granted.findIndex((item) => samePrompt(item, input))
            if (covered >= 0) granted.splice(covered, 1)
            // As `Permission.ask` writes the call down. What cannot be written down is no call anyone approved.
            const asked = yield* Effect.try({ try: () => JSON.stringify(input.call), catch: String }).pipe(
              Effect.orElseSucceed(() => undefined),
            )
            // Only a prompt of this very call, and only one that will ask: a grant nothing asks for would stay behind.
            if (covered < 0 && input.call && asked === call && willAsk(input, ruleset))
              yield* permission.grant({ sessionID: root, permission: input.permission, patterns: input.patterns, call })
            yield* permission.ask({ ...input, sessionID: root, agent: setup.agent.name, canUndo: false, ruleset })
          }).pipe(Effect.orDie)
        },
      })
      .pipe(Effect.exit)
    const result =
      exit._tag === "Success"
        ? { ran: true as const, output: exit.value.output, exit: exit.value.metadata.exit }
        : { ran: false as const, output: failure(exit.cause) }
    if (autonomy)
      yield* autonomy
        .record(root, {
          type: "outcome",
          requestID,
          outcome: result.ran ? "ran" : "failed",
          ...(result.ran && typeof result.exit === "number" && { exit: result.exit }),
          by: "person",
        })
        // Logged by record. The call has run or failed either way, and the agent still has to hear which.
        .pipe(Effect.ignore)
    return result
  })

  /** One approved entry: its calls are granted and run, and the agent is told. */
  const approved = Effect.fnUntraced(function* (request: Permission.Answered) {
    const root = yield* rootOf(request.sessionID)
    // Every call the entry showed when the person approved it (E3), or the one it stood for before entries were shared.
    const calls =
      request.calls ??
      (request.call === undefined
        ? []
        : [{ requestID: request.id, sessionID: request.sessionID, call: request.call, follows: request.follows }])
    // Back from the file after a restart it has no call to show or run, so this answer wakes the agent, and its repeat
    // of the same permission and patterns from that session goes through once (F1), with the other prompts of that one call. Each still passes the gate.
    if (calls.length === 0 && request.deferred)
      yield* permission.grant({
        sessionID: request.sessionID,
        permission: request.permission,
        patterns: request.patterns,
        uses: "once",
      })
    const grants = calls.length > 0 ? calls : request.deferred ? [] : [{ call: undefined, follows: request.follows }]
    for (const held of grants) {
      yield* permission.grant({
        sessionID: root,
        permission: request.permission,
        patterns: request.patterns,
        call: held.call,
      })
      for (const next of held.follows ?? [])
        yield* permission.grant({
          sessionID: root,
          permission: next.permission,
          patterns: next.patterns,
          call: held.call,
          followed: true,
        })
    }
    // U11 E1: each call the person saw runs once now, without waiting for a model turn to ask for it again. One that
    // nothing here can run is left to its grant, and the agent is told to do it.
    const ran: { ran: boolean; output: string }[] = []
    for (const held of calls) {
      const result = yield* rerun(root, held.requestID, held.call, [request, ...(held.follows ?? [])])
      if (result) ran.push(result)
    }
    yield* send(root, ran.length > 0 ? ranText(request, ran, calls.length - ran.length) : allowedText(request)).pipe(
      report(root),
    )
  })

  return {
    forgetAbandoned: Effect.fn("LateAnswer.forgetAbandoned")(function* () {
      for (const item of (yield* permission.list()).filter((item) => item.movedOnAt)) {
        if (yield* abandoned(item.sessionID))
          yield* permission.reply({ requestID: item.id, reply: "reject", abandoned: true }).pipe(Effect.ignore)
      }
      for (const item of (yield* question.list()).filter((item) => item.movedOnAt)) {
        if (yield* abandoned(item.sessionID)) yield* question.reject(item.id).pipe(Effect.ignore)
      }
    }),
    permission: Effect.fn("LateAnswer.permission")(function* (request: Permission.Answered) {
      // An "always in this session" also approved the family's other entries it covers (row 258): each as its own answer.
      for (const answer of [request, ...(request.released ?? [])]) yield* approved(answer)
    }),
    /** A no with a reason is a correction, which the agent has to hear. A plain no wakes nothing. */
    rejected: Effect.fn("LateAnswer.rejected")(function* (request: PermissionV1.Request, message: string | undefined) {
      if (!message?.trim()) return
      const root = yield* rootOf(request.sessionID)
      yield* send(root, rejectedText(request, message)).pipe(report(root))
    }),
    question: Effect.fn("LateAnswer.question")(function* (
      request: Question.Request,
      answers: ReadonlyArray<Question.Answer>,
    ) {
      const root = yield* rootOf(request.sessionID)
      yield* send(root, answeredText(request, answers)).pipe(report(root))
    }),
  }
})

function requested(request: PermissionV1.Request) {
  const command = request.metadata.command
  return typeof command === "string" && command ? command : `${request.permission} ${request.patterns.join(" ")}`
}

function allowedText(request: PermissionV1.Request) {
  return `I've allowed what you skipped while I was away: \`${requested(request)}\`. Do it now if it's still needed, then carry on.`
}

const decodeCall = Schema.decodeUnknownOption(Schema.fromJsonString(PermissionV1.ToolCall))

function samePrompt(
  a: Pick<PermissionV1.Request, "permission" | "patterns">,
  b: Pick<PermissionV1.Request, "permission" | "patterns">,
) {
  return (
    a.permission === b.permission &&
    a.patterns.length === b.patterns.length &&
    a.patterns.every((pattern, index) => pattern === b.patterns[index])
  )
}

/**
 * Whether `Permission.ask` will look for a grant on this prompt: a pattern its rules ask about, none they deny. An
 * "always" a person gave earlier is not visible here; such a prompt passes without the grant, which then stays unused.
 */
function willAsk(
  input: Pick<PermissionV1.AskInput, "permission" | "patterns" | "harmless">,
  ruleset: PermissionV1.Ruleset,
) {
  const rules = input.patterns.map((pattern) => Permission.evaluate(input.permission, pattern, ruleset))
  if (rules.some((rule) => rule.action === "deny")) return false
  return rules.some((rule) => rule.action === "ask" && !(input.harmless && Permission.isShippedCatchAll(rule)))
}

/** What the agent is told of a call that did not go through: the error a tool result would have carried. */
function failure(cause: Cause.Cause<unknown>) {
  const error = Cause.squash(cause)
  return error instanceof Error && error.message ? error.message : "The call failed."
}

/**
 * The output is the tool's, as truncated and scrubbed as any tool result, and it is fenced so it cannot read as the
 * person's words. A `lateAnswer` part is never mission text, a goal or what a decider sees as the user's.
 */
function ranText(
  request: PermissionV1.Request,
  results: ReadonlyArray<{ ran: boolean; output: string }>,
  left: number,
) {
  const blocks = results.map((result) => {
    const fence = "`".repeat(
      [...result.output.matchAll(/`+/g)].reduce((longest, run) => Math.max(longest, run[0].length + 1), 3),
    )
    const head = result.ran
      ? "Swarm ran it once for you, so do not run it again. Its output, which is the tool's and not my words:"
      : "Swarm tried to run it once for you, and it did not go through:"
    return `${head}\n\n${fence}\n${result.output}\n${fence}`
  })
  const rest =
    left > 0 ? ` ${left} more call(s) of this kind are allowed too: do those now if they are still needed.` : ""
  return `I've allowed what you skipped while I was away: \`${requested(request)}\`.\n\n${blocks.join("\n\n")}\n\nCarry on from there.${rest}`
}

function rejectedText(request: PermissionV1.Request, message: string) {
  return `I've declined what you skipped while I was away: \`${requested(request)}\`. Don't do it. ${message}`
}

function answeredText(request: Question.Request, answers: ReadonlyArray<Question.Answer>) {
  const pairs = request.questions.map(
    (question, index) => `"${question.question}": ${answers[index]?.join(", ") || "no answer"}`,
  )
  return `My answer to what you asked while I was away. ${pairs.join(". ")}. If you assumed something else, fix whatever depended on it, then carry on.`
}

export * as LateAnswer from "./late-answer"
