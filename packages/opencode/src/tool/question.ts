import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { Question } from "../question"
import { InstanceState } from "@/effect/instance-state"
import { Autonomy } from "@/permission/autonomy"
import { SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import DESCRIPTION from "./question.txt"

export const Parameters = Schema.Struct({
  questions: Schema.mutable(Schema.Array(Question.Prompt)).annotate({ description: "Questions to ask" }),
})

type Metadata = {
  answers: ReadonlyArray<Question.Answer>
}

export const QuestionTool = Tool.define<
  typeof Parameters,
  Metadata,
  Question.Service | Session.Service | Autonomy.Service
>(
  "question",
  Effect.gen(function* () {
    const question = yield* Question.Service
    const sessions = yield* Session.Service
    const autonomy = yield* Autonomy.Service

    // A subagent has no mode of its own: it runs under whatever the session at the top of its line runs under.
    const rootOf = (sessionID: SessionID): Effect.Effect<SessionID> =>
      sessions.get(sessionID).pipe(
        Effect.flatMap((session) => (session.parentID ? rootOf(session.parentID) : Effect.succeed(session.id))),
        Effect.catch(() => Effect.succeed(sessionID)),
      )

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const root = yield* rootOf(ctx.sessionID)
          const directory = yield* InstanceState.directory
          const noWait = yield* autonomy.isOn({ root, directory })
          const answers = yield* question.ask({
            sessionID: ctx.sessionID,
            questions: params.questions,
            tool: ctx.callID ? { messageID: ctx.messageID, callID: ctx.callID } : undefined,
            movesOn: true,
            // Nobody is at the prompt by choice, so the wait would only slow the run. The question stays open for later.
            noWait,
          }).pipe(Effect.catchTag("QuestionAwayError", () => Effect.succeed(undefined)))

          if (!answers) {
            if (noWait)
              yield* autonomy
                .recordSkippedQuestion({
                  root,
                  sessionID: ctx.sessionID,
                  directory,
                  agent: ctx.agent,
                  messageID: ctx.messageID,
                  callID: ctx.callID,
                  questions: params.questions.map((item) => item.question),
                })
                .pipe(
                  // Same as the permission gate: a line that could not be written must not hold the agent up.
                  Effect.catch((error) =>
                    Effect.logError("could not record a skipped question", { root, error: error.message }),
                  ),
                )
            return {
              title: `Asked ${params.questions.length} question${params.questions.length > 1 ? "s" : ""}`,
              output:
                "Nobody answered in time. The user has probably stepped away and can still answer later. Do not ask again. Choose what you would recommend, preferring what is easy to reverse, and carry on. In your final message, say what you assumed.",
              metadata: { answers: [] },
            }
          }

          const formatted = params.questions
            .map((q, i) => `"${q.question}"="${answers[i]?.length ? answers[i].join(", ") : "Unanswered"}"`)
            .join(", ")

          return {
            title: `Asked ${params.questions.length} question${params.questions.length > 1 ? "s" : ""}`,
            output: `User has answered your questions: ${formatted}. You can now continue with the user's answers in mind.`,
            metadata: {
              answers,
            },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
