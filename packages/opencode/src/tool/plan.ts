import path from "path"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { Question } from "../question"
import { Session } from "@/session/session"
import { MessageV2 } from "../session/message-v2"
import { Provider } from "@/provider/provider"
import { Autonomy } from "@/permission/autonomy"
import { MissionWindow } from "@/permission/mission-window"
import { InstanceState } from "@/effect/instance-state"
import { MessageID, PartID } from "../session/schema"
import EXIT_DESCRIPTION from "./plan-exit.txt"

export const Parameters = Schema.Struct({})

export const APPROVED_REASON = "autonomous mode: the user did not ask to be asked, plan approved"

export const PlanExitTool = Tool.define(
  "plan_exit",
  Effect.gen(function* () {
    const session = yield* Session.Service
    const question = yield* Question.Service
    const provider = yield* Provider.Service
    const autonomy = yield* Autonomy.Service

    // The sentences of the root's mission that ask to be asked (row 102's module). `since` is when the mode came on: the
    // first mode_on marker after the last mode_off. A restart marks the mode again on its first request, so the last
    // mode_on would be the restart and not the switch. Now when there is none.
    const missionAsks = Effect.fn("PlanExitTool.missionAsks")(function* (where: Autonomy.Where) {
      yield* autonomy.markMode(where)
      const modes = (yield* autonomy.readAudit(where.root)).lines.flatMap((line) =>
        line.type === "marker" && (line.marker === "mode_on" || line.marker === "mode_off") ? [line] : [],
      )
      const marker = modes.slice(modes.findLastIndex((line) => line.marker === "mode_off") + 1).find(
        (line) => line.marker === "mode_on",
      )
      const messages = yield* session.messages({ sessionID: where.root }).pipe(Effect.orDie)
      return MissionWindow.asks(MissionWindow.window(messages, { root: where.root, since: marker?.at ?? Date.now() }))
    })

    return {
      description: EXIT_DESCRIPTION,
      parameters: Parameters,
      execute: (_params: {}, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const info = yield* session.get(ctx.sessionID)
          const plan = path.relative(instance.worktree, Session.plan(info, instance))
          // Leaving plan is the question "approve this plan?". In autonomous mode it is put to the person only when the
          // mission asked to be asked (rule 9, U13). Otherwise the plan counts as approved and build starts without waiting.
          const place = yield* Autonomy.placeOf(session, ctx.sessionID)
          const where = { root: place.root.id, directory: place.directory }
          const approvedByGate = (yield* autonomy.isOn(where)) && (yield* missionAsks(where)).length === 0
          if (approvedByGate)
            yield* autonomy
              .record(where.root, {
                type: "decision",
                sessionID: ctx.sessionID,
                requestID: ctx.callID ?? ctx.messageID,
                messageID: ctx.messageID,
                callID: ctx.callID,
                agent: ctx.agent,
                directory: where.directory,
                permission: "plan_exit",
                patterns: [plan],
                class: "A",
                canUndo: false,
                decidedBy: "gate",
                decision: "allow",
                reason: APPROVED_REASON,
              })
              .pipe(
                // Same as the question tool: a line that could not be written must not hold the agent up.
                Effect.catch((error) =>
                  Effect.logError("could not record an approved plan exit", { root: where.root, error: error.message }),
                ),
              )
          else {
            const answers = yield* question.ask({
              sessionID: ctx.sessionID,
              questions: [
                {
                  question: `Plan at ${plan} is complete. Would you like to switch to the build agent and start implementing?`,
                  header: "Build Agent",
                  custom: false,
                  options: [
                    { label: "Yes", description: "Switch to build agent and start implementing the plan" },
                    { label: "No", description: "Stay with plan agent to continue refining the plan" },
                  ],
                },
              ],
              tool: ctx.callID ? { messageID: ctx.messageID, callID: ctx.callID } : undefined,
            })

            if (answers[0]?.[0] === "No") yield* new Question.RejectedError()
          }

          const messages = yield* session.messages({ sessionID: ctx.sessionID }).pipe(Effect.orDie)
          const lastUser = messages.findLast((item) => item.info.role === "user" && item.info.model)
          const model =
            lastUser?.info.role === "user" && lastUser.info.model ? lastUser.info.model : yield* provider.defaultModel()

          const msg: SessionV1.User = {
            id: MessageID.ascending(),
            sessionID: ctx.sessionID,
            role: "user",
            time: { created: Date.now() },
            agent: "build",
            model,
          }
          yield* session.updateMessage(msg)
          yield* session.updatePart({
            id: PartID.ascending(),
            messageID: msg.id,
            sessionID: ctx.sessionID,
            type: "text",
            text: `The plan at ${plan} has been approved, you can now edit files. Execute the plan`,
            synthetic: true,
          } satisfies SessionV1.TextPart)

          return {
            title: "Switching to build agent",
            output: approvedByGate
              ? "Autonomous mode is on and the user did not ask to be asked, so the plan counts as approved. Switching to the build agent: carry out the plan."
              : "User approved switching to build agent. Wait for further instructions.",
            metadata: {},
          }
        }).pipe(Effect.orDie),
    }
  }),
)
