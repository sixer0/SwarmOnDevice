import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { Question } from "../question"
import { Autonomy } from "@/permission/autonomy"
import { Session } from "@/session/session"
import { MissionWindow } from "@/permission/mission-window"
import DESCRIPTION from "./question.txt"

export const Parameters = Schema.Struct({
  questions: Schema.mutable(Schema.Array(Question.Prompt)).annotate({ description: "Questions to ask" }),
  user_quote: Schema.optional(Schema.String).annotate({
    description:
      "The user's own words asking you to ask them, copied exactly from their message. Leave it out when they did not ask.",
  }),
})

export const WAITED_REASON = "the user asked to be asked"
export const CLOSED_OUTPUT =
  "Autonomous mode is on and the user did not ask to be asked, so this question was not put to them and is closed. Do not ask again. Choose what you would recommend, preferring what is easy to reverse, and carry on. In your final message, say what you assumed."

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

    // Rule 9 (U11, U13): in autonomous mode a question waits for the person only when `user_quote` is their own request to
    // be asked, found in the root's mission. A skill, the system prompt, a repo file or a subagent's prompt is not in it.
    // `since` is read as `plan_exit` reads it: the first mode_on after the last mode_off, or now when there is none.
    const askedToAsk = Effect.fn("QuestionTool.askedToAsk")(function* (
      where: Autonomy.Where,
      quote: string | undefined,
    ) {
      if (!quote) return false
      yield* autonomy.markMode(where)
      const modes = (yield* autonomy.readAudit(where.root)).lines.flatMap((line) =>
        line.type === "marker" && (line.marker === "mode_on" || line.marker === "mode_off") ? [line] : [],
      )
      const marker = modes
        .slice(modes.findLastIndex((line) => line.marker === "mode_off") + 1)
        .find((line) => line.marker === "mode_on")
      const messages = yield* sessions.messages({ sessionID: where.root }).pipe(Effect.orDie)
      return MissionWindow.quoted(
        quote,
        MissionWindow.window(messages, { root: where.root, since: marker?.at ?? Date.now() }),
      )
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          // A subagent has no mode of its own: it runs under whatever the session at the top of its line runs under.
          const place = yield* Autonomy.placeOf(sessions, ctx.sessionID)
          const root = place.root.id
          const directory = place.directory
          const on = yield* autonomy.isOn({ root, directory })
          const waited = on && (yield* askedToAsk({ root, directory }, params.user_quote))
          const noWait = on && !waited
          if (waited)
            yield* autonomy
              .record(root, {
                type: "decision",
                sessionID: ctx.sessionID,
                requestID: ctx.callID ?? ctx.messageID,
                messageID: ctx.messageID,
                callID: ctx.callID,
                agent: ctx.agent,
                directory,
                permission: "question",
                // The quote first, spaces as they were matched and masked as any pattern is, then what was asked.
                patterns: [
                  params.user_quote!.replace(/\s+/g, " ").trim(),
                  ...params.questions.map((item) => item.question),
                ],
                class: "A",
                via: "user_request",
                canUndo: false,
                decidedBy: "gate",
                decision: "ask",
                reason: WAITED_REASON,
              })
              .pipe(
                Effect.catch((error) =>
                  Effect.logError("could not record a question put to the person", { root, error: error.message }),
                ),
              )
          const answers = yield* question
            .ask({
              sessionID: ctx.sessionID,
              questions: params.questions,
              tool: ctx.callID ? { messageID: ctx.messageID, callID: ctx.callID } : undefined,
              // The person asked to be asked, so the run waits for them however long that takes.
              movesOn: !waited,
              // Nobody is at the prompt by choice, so the wait would only slow the run. The question is closed, not left open.
              noWait,
            })
            .pipe(Effect.catchTag("QuestionAwayError", () => Effect.succeed(undefined)))

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
              output: noWait
                ? CLOSED_OUTPUT
                : "Nobody answered in time. The user has probably stepped away and can still answer later. Do not ask again. Choose what you would recommend, preferring what is easy to reverse, and carry on. In your final message, say what you assumed.",
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
