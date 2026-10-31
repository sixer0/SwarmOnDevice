import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Cause, Effect, Option } from "effect"
import { NamedError } from "@opencode-ai/core/util/error"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Permission } from "@/permission"
import { Question } from "@/question"
import { SessionPrompt } from "./prompt"
import { SessionID } from "./schema"
import { Session } from "./session"

// The agent carried on without a person's answer, and now the person has answered. That answer has nowhere to go: the
// call it belonged to is long over. So it reaches the agent the way anything else from the user does, as a message in
// the session they started. A subagent's own run has already reported back by now, which is why it goes to the root.

export const make = Effect.gen(function* () {
  const sessions = yield* Session.Service
  const prompt = yield* SessionPrompt.Service
  const permission = yield* Permission.Service
  const events = yield* EventV2Bridge.Service

  const rootOf = (sessionID: SessionID): Effect.Effect<SessionID> =>
    sessions.get(sessionID).pipe(
      Effect.flatMap((session) => (session.parentID ? rootOf(session.parentID) : Effect.succeed(session.id))),
      Effect.catchCause(() => Effect.succeed(sessionID)),
    )

  const send = Effect.fn("LateAnswer.send")(function* (sessionID: SessionID, text: string) {
    const last = yield* sessions
      .findMessage(sessionID, (message) => message.info.role === "user")
      .pipe(
        Effect.map(Option.getOrUndefined),
        Effect.catchCause(() => Effect.succeed(undefined)),
      )
    yield* prompt.prompt({
      sessionID,
      agent: last?.info.role === "user" ? last.info.agent : undefined,
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

  return {
    permission: Effect.fn("LateAnswer.permission")(function* (request: PermissionV1.Request) {
      const root = yield* rootOf(request.sessionID)
      yield* permission.grant({ sessionID: root, permission: request.permission, patterns: request.patterns })
      yield* send(root, allowedText(request)).pipe(report(root))
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

function allowedText(request: PermissionV1.Request) {
  const command = request.metadata.command
  const what = typeof command === "string" && command ? command : `${request.permission} ${request.patterns.join(" ")}`
  return `I've allowed what you skipped while I was away: \`${what}\`. Do it now if it's still needed, then carry on.`
}

function answeredText(request: Question.Request, answers: ReadonlyArray<Question.Answer>) {
  const pairs = request.questions.map(
    (question, index) => `"${question.question}": ${answers[index]?.join(", ") || "no answer"}`,
  )
  return `My answer to what you asked while I was away. ${pairs.join(". ")}. If you assumed something else, fix whatever depended on it, then carry on.`
}

export * as LateAnswer from "./late-answer"
