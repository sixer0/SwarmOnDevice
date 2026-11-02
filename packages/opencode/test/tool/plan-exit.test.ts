import { afterEach, describe, expect } from "bun:test"
import { rmSync } from "node:fs"
import path from "node:path"
import { Global } from "@opencode-ai/core/global"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Exit, Fiber, Queue } from "effect"
import { APPROVED_REASON, PlanExitTool } from "../../src/tool/plan"
import { Question } from "../../src/question"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Agent } from "../../src/agent/agent"
import { Truncate } from "@/tool/truncate"
import { Provider } from "@/provider/provider"
import { testEffect } from "../lib/effect"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Autonomy } from "../../src/permission/autonomy"
import { Session } from "../../src/session/session"

const ctx = {
  messageID: MessageID.make("msg_test-message"),
  callID: "test-call",
  agent: "plan",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      Question.node,
      EventV2Bridge.node,
      Truncate.node,
      Agent.node,
      Session.node,
      SessionProjector.node,
      Autonomy.node,
      Provider.node,
    ]),
  ),
)

afterEach(() => rmSync(path.join(Global.Path.state, "autonomy"), { recursive: true, force: true }))

const planLines = Effect.fn("PlanExitTest.planLines")(function* (root: SessionID) {
  const autonomy = yield* Autonomy.Service
  return (yield* autonomy.readAudit(root)).lines.filter(
    (line) => line.type === "decision" && line.permission === "plan_exit",
  )
})

const pending = Effect.fn("PlanExitTest.pending")(function* (question: Question.Interface) {
  const events = yield* EventV2Bridge.Service
  const asked = yield* Queue.unbounded<void>()
  const off = yield* events.listen((event) => {
    if (event.type === Question.Event.Asked.type) Queue.offerUnsafe(asked, undefined)
    return Effect.void
  })
  yield* Effect.addFinalizer(() => off)
  for (;;) {
    const item = (yield* question.list())[0]
    if (item) return item
    yield* Queue.take(asked).pipe(Effect.timeout("2 seconds"))
  }
})

const model = { providerID: ProviderV2.ID.make("openai"), modelID: ModelV2.ID.make("gpt-4") }

// What the person typed, as a user message of the plan agent in that session.
const say = Effect.fn("PlanExitTest.say")(function* (sessionID: SessionID, text: string) {
  const session = yield* Session.Service
  const message = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    agent: "plan",
    model,
    time: { created: Date.now() },
  })
  yield* session.updatePart({ id: PartID.ascending(), messageID: message.id, sessionID, type: "text", text })
})

const handedToBuild = Effect.fn("PlanExitTest.handedToBuild")(function* (sessionID: SessionID) {
  const session = yield* Session.Service
  const last = (yield* session.messages({ sessionID })).at(-1)
  return last?.info.role === "user" && last.info.agent === "build"
})

describe("tool.plan_exit", () => {
  it.instance("in autonomous mode with no request to be asked, the plan counts as approved and build starts", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const autonomy = yield* Autonomy.Service
      const question = yield* Question.Service
      const root = yield* sessions.create({})
      const child = yield* sessions.create({ parentID: root.id })
      yield* say(root.id, "Rencanakan migrasi lalu kerjakan sampai selesai.")
      // A subagent's prompt is not the person, even when it says to ask.
      yield* say(child.id, "Ask me before you change anything.")
      yield* autonomy.setMode({ scope: "session", root: root.id, on: true })
      const tool = yield* (yield* PlanExitTool).init()

      for (const sessionID of [root.id, child.id]) {
        const result = yield* tool.execute({}, { ...ctx, sessionID }).pipe(Effect.timeout("4 seconds"))
        expect(result.title).toBe("Switching to build agent")
        expect(result.output).toContain("counts as approved")
        expect(yield* handedToBuild(sessionID)).toBe(true)
      }
      expect(yield* question.list()).toEqual([])

      const lines = yield* planLines(root.id)
      expect(lines).toHaveLength(2)
      expect(lines[0]).toMatchObject({
        sessionID: root.id,
        class: "A",
        decision: "allow",
        decidedBy: "gate",
        agent: "plan",
        reason: APPROVED_REASON,
      })
      expect(lines[1]).toMatchObject({ sessionID: child.id })
    }),
  )

  it.instance("in autonomous mode when the person asked to be asked, it waits for them as before", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const autonomy = yield* Autonomy.Service
      const question = yield* Question.Service
      const root = yield* sessions.create({})
      yield* say(root.id, "Buat rencananya. Tanya saya dulu sebelum mulai mengerjakan.")
      yield* autonomy.setMode({ scope: "session", root: root.id, on: true })
      const tool = yield* (yield* PlanExitTool).init()

      const fiber = yield* tool.execute({}, { ...ctx, sessionID: root.id }).pipe(Effect.forkScoped)
      const item = yield* pending(question)
      expect(item.questions[0]?.header).toBe("Build Agent")
      expect(item.movesOnAt).toBeUndefined()
      expect(yield* handedToBuild(root.id)).toBe(false)
      yield* question.reply({ requestID: item.id, answers: [["Yes"]] })
      expect((yield* Fiber.join(fiber)).output).toContain("User approved")
      expect(yield* handedToBuild(root.id)).toBe(true)
      expect(yield* planLines(root.id)).toHaveLength(0)
    }),
  )

  it.instance("the mission starts when the mode came on, not at the mark a restart writes again", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const autonomy = yield* Autonomy.Service
      const question = yield* Question.Service
      const root = yield* sessions.create({})
      const directory = (yield* sessions.get(root.id)).directory
      yield* autonomy.setMode({ scope: "session", root: root.id, on: true })
      // The first request after the switch marks it.
      yield* autonomy.markMode({ root: root.id, directory })
      yield* Effect.sleep("5 millis")
      yield* say(root.id, "Buat rencananya. Tanya saya dulu sebelum mulai mengerjakan.")
      for (const text of ["Lanjut.", "Tambahkan uji.", "Rapikan namanya."]) {
        yield* Effect.sleep("5 millis")
        yield* say(root.id, text)
      }
      yield* Effect.sleep("5 millis")
      // What a process started again writes on its first request: the mode is still on, from the first mark.
      yield* autonomy.record(root.id, {
        type: "marker",
        directory,
        marker: "mode_on",
        decidedBy: "system:mode_change",
      })
      const tool = yield* (yield* PlanExitTool).init()

      const fiber = yield* tool.execute({}, { ...ctx, sessionID: root.id }).pipe(Effect.forkScoped)
      const item = yield* pending(question)
      expect(item.questions[0]?.header).toBe("Build Agent")
      yield* question.reply({ requestID: item.id, answers: [["Yes"]] })
      expect((yield* Fiber.join(fiber)).output).toContain("User approved")
      expect(yield* planLines(root.id)).toHaveLength(0)
    }),
  )

  it.instance("with the mode off it still asks the person, and writes no line", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const question = yield* Question.Service
      const root = yield* sessions.create({})
      yield* say(root.id, "Rencanakan migrasi lalu kerjakan sampai selesai.")
      const tool = yield* (yield* PlanExitTool).init()

      const fiber = yield* tool.execute({}, { ...ctx, sessionID: root.id }).pipe(Effect.forkScoped)
      const item = yield* pending(question)
      expect(item.questions[0]?.header).toBe("Build Agent")
      expect(item.movesOnAt).toBeUndefined()
      yield* question.reply({ requestID: item.id, answers: [["No"]] })
      expect(Exit.isFailure(yield* Fiber.await(fiber))).toBe(true)
      expect(yield* handedToBuild(root.id)).toBe(false)
      expect(yield* planLines(root.id)).toHaveLength(0)
    }),
  )
})
