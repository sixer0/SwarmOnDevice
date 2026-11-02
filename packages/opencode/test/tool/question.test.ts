import { afterEach, describe, expect } from "bun:test"
import { mkdirSync, rmSync } from "node:fs"
import path from "node:path"
import { Global } from "@opencode-ai/core/global"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Fiber, Queue } from "effect"
import { QuestionTool } from "../../src/tool/question"
import { Question } from "../../src/question"
import { SessionID, MessageID } from "../../src/session/schema"
import { Agent } from "../../src/agent/agent"
import { Truncate } from "@/tool/truncate"
import { testEffect } from "../lib/effect"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Autonomy } from "../../src/permission/autonomy"
import { Session } from "../../src/session/session"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { ToolRegistry } from "../../src/tool/registry"
import { InstanceRef } from "../../src/effect/instance-ref"
import { InstanceState } from "../../src/effect/instance-state"
import { TestInstance } from "../fixture/fixture"

const ctx = {
  sessionID: SessionID.make("ses_test-session"),
  messageID: MessageID.make("msg_test-message"),
  callID: "test-call",
  agent: "test-agent",
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
    ]),
  ),
)

const pending = Effect.fn("QuestionToolTest.pending")(function* (question: Question.Interface) {
  const events = yield* EventV2Bridge.Service
  const asked = yield* Queue.unbounded<void>()
  const off = yield* events.listen((event) => {
    if (event.type === Question.Event.Asked.type) Queue.offerUnsafe(asked, undefined)
    return Effect.void
  })
  yield* Effect.addFinalizer(() => off)

  for (;;) {
    const items = yield* question.list()
    const item = items[0]
    if (item) return item
    yield* Queue.take(asked).pipe(Effect.timeout("2 seconds"))
  }
})

const movedOnText = "Nobody answered in time."
const prompt = [{ question: "Which database?", header: "Database", options: [{ label: "Postgres", description: "" }] }]
// Far under the two minutes it would otherwise sit there, and far over how long it takes when it does not.
const noLongWait = "4 seconds"

// Sessions and folders differ per test, so memory cannot leak between them. This keeps the file from outliving them.
afterEach(() => rmSync(path.join(Global.Path.state, "autonomy"), { recursive: true, force: true }))

const skippedLines = Effect.fn("QuestionToolTest.skippedLines")(function* (root: SessionID) {
  const autonomy = yield* Autonomy.Service
  return (yield* autonomy.readAudit(root)).lines.filter((line) => line.type === "decision" && line.permission === "question")
})

const movesOnStraightAway = Effect.fn("QuestionToolTest.movesOnStraightAway")(function* (sessionID: SessionID) {
  const question = yield* Question.Service
  const toolInfo = yield* QuestionTool
  const tool = yield* toolInfo.init()

  const result = yield* tool.execute({ questions: prompt }, { ...ctx, sessionID }).pipe(Effect.timeout(noLongWait))
  expect(result.output).toContain(movedOnText)
  expect(result.metadata.answers).toEqual([])

  const [open] = yield* question.list()
  expect(open?.sessionID).toBe(sessionID)
  expect(open?.movedOnAt).toBeNumber()
  const late = yield* question.reply({ requestID: open!.id, answers: [["Postgres"]] })
  expect(late?.id).toBe(open!.id)
  expect(yield* question.list()).toEqual([])
})

const waitsForAnAnswer = Effect.fn("QuestionToolTest.waitsForAnAnswer")(function* (sessionID: SessionID) {
  const question = yield* Question.Service
  const toolInfo = yield* QuestionTool
  const tool = yield* toolInfo.init()

  const fiber = yield* tool.execute({ questions: prompt }, { ...ctx, sessionID }).pipe(Effect.forkScoped)
  const item = yield* pending(question)
  // Measured, because a question that moves on at once is also still listed unmoved for a moment.
  expect(item.movesOnAt! - Date.now()).toBeGreaterThan(30_000)
  expect(item.movedOnAt).toBeUndefined()
  yield* question.reply({ requestID: item.id, answers: [["Postgres"]] })
  expect((yield* Fiber.join(fiber)).output).toContain(`"Which database?"="Postgres"`)
})

// What a real run gets: the registry's own node and what it brings along, with only the client named.
const registered = testEffect(
  LayerNode.compile(LayerNode.group([ToolRegistry.node, Session.node, SessionProjector.node, Autonomy.node, Question.node]), [
    [RuntimeFlags.node, RuntimeFlags.layer({ client: "app" })],
  ]),
)

describe("tool.question", () => {
  it.instance("should successfully execute with valid question parameters", () =>
    Effect.gen(function* () {
      const question = yield* Question.Service
      const toolInfo = yield* QuestionTool
      const tool = yield* toolInfo.init()
      const questions = [
        {
          question: "What is your favorite color?",
          header: "Color",
          options: [
            { label: "Red", description: "The color of passion" },
            { label: "Blue", description: "The color of sky" },
          ],
          multiple: false,
        },
      ]

      const fiber = yield* tool.execute({ questions }, ctx).pipe(Effect.forkScoped)
      const item = yield* pending(question)
      yield* question.reply({ requestID: item.id, answers: [["Red"]] })

      const result = yield* Fiber.join(fiber)
      expect(result.title).toBe("Asked 1 question")
    }),
  )

  it.instance("should now pass with a header longer than 12 but less than 30 chars", () =>
    Effect.gen(function* () {
      const question = yield* Question.Service
      const toolInfo = yield* QuestionTool
      const tool = yield* toolInfo.init()
      const questions = [
        {
          question: "What is your favorite animal?",
          header: "This Header is Over 12",
          options: [{ label: "Dog", description: "Man's best friend" }],
        },
      ]

      const fiber = yield* tool.execute({ questions }, ctx).pipe(Effect.forkScoped)
      const item = yield* pending(question)
      yield* question.reply({ requestID: item.id, answers: [["Dog"]] })

      const result = yield* Fiber.join(fiber)
      expect(result.output).toContain(`"What is your favorite animal?"="Dog"`)
    }),
  )

  describe("autonomous sessions", () => {
    it.instance("a subagent's question does not wait, and stays open for the person", () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const autonomy = yield* Autonomy.Service
        const root = yield* sessions.create({})
        const child = yield* sessions.create({ parentID: root.id })
        yield* autonomy.setMode({ scope: "session", root: root.id, on: true })

        yield* movesOnStraightAway(child.id)

        // Filed under the root, and the answer given afterwards is not in it.
        const lines = yield* skippedLines(root.id)
        expect(lines).toHaveLength(1)
        expect(lines[0]).toMatchObject({
          type: "decision",
          sessionID: child.id,
          messageID: ctx.messageID,
          callID: ctx.callID,
          agent: ctx.agent,
          patterns: ["Which database?"],
          class: "A",
          decidedBy: "gate",
          decision: "defer",
        })
        expect(JSON.stringify(lines)).not.toContain("Postgres")
      }),
    )

    it.instance("so does a grandchild's, and the root's own", () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const autonomy = yield* Autonomy.Service
        const root = yield* sessions.create({})
        const child = yield* sessions.create({ parentID: root.id })
        const grandchild = yield* sessions.create({ parentID: child.id })
        yield* autonomy.setMode({ scope: "session", root: root.id, on: true })

        yield* movesOnStraightAway(grandchild.id)
        expect(yield* skippedLines(root.id)).toHaveLength(1)
        yield* movesOnStraightAway(root.id)
        expect(yield* skippedLines(root.id)).toHaveLength(2)
      }),
    )

    it.instance("the folder's mode counts, unless the session turned it off for itself", () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const autonomy = yield* Autonomy.Service
        const test = yield* TestInstance
        const inherits = yield* sessions.create({})
        const optedOut = yield* sessions.create({})
        yield* autonomy.setMode({ scope: "directory", directory: test.directory, on: true })
        yield* autonomy.setMode({ scope: "session", root: optedOut.id, on: false })

        yield* movesOnStraightAway(inherits.id)
        expect(yield* skippedLines(inherits.id)).toHaveLength(1)
        yield* waitsForAnAnswer(optedOut.id)
        expect(yield* skippedLines(optedOut.id)).toHaveLength(0)
      }),
    )

    // A session has the folder it was opened in, and the instance running a child may be another. The gate reads the root's.
    it.instance("a child in another folder goes by the root's folder, as the gate does", () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const autonomy = yield* Autonomy.Service
        const test = yield* TestInstance
        const here = yield* InstanceState.context
        const elsewhere = `${test.directory}-elsewhere`
        const root = yield* sessions.create({}).pipe(Effect.provideService(InstanceRef, { ...here, directory: elsewhere }))
        const child = yield* sessions.create({ parentID: root.id })
        expect(child.directory).toBe(test.directory)

        yield* autonomy.setMode({ scope: "directory", directory: elsewhere, on: true })
        yield* movesOnStraightAway(child.id)
        const lines = yield* skippedLines(root.id)
        expect(lines).toHaveLength(1)
        expect(lines[0]).toMatchObject({ sessionID: child.id, directory: elsewhere })
      }),
    )

    it.instance("and the mode of the folder it runs in does not count for it", () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const autonomy = yield* Autonomy.Service
        const test = yield* TestInstance
        const here = yield* InstanceState.context
        const root = yield* sessions
          .create({})
          .pipe(Effect.provideService(InstanceRef, { ...here, directory: `${test.directory}-elsewhere` }))
        const child = yield* sessions.create({ parentID: root.id })

        yield* autonomy.setMode({ scope: "directory", directory: test.directory, on: true })
        yield* waitsForAnAnswer(child.id)
        expect(yield* skippedLines(root.id)).toHaveLength(0)
      }),
    )

    it.instance("placeOf reads a session it cannot find as its own root, in this folder", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const id = SessionID.make("ses_nobody")
        const dies = { get: () => Effect.die(new Error("no database")) }
        const fails = { get: () => Effect.fail(new Error("not found")) }
        for (const sessions of [dies, fails]) {
          const place = yield* Autonomy.placeOf(sessions, id)
          expect(place).toMatchObject({ root: { id }, directory: test.directory })
        }
      }),
    )

    it.instance("another session being autonomous changes nothing here", () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const autonomy = yield* Autonomy.Service
        const other = yield* sessions.create({})
        const here = yield* sessions.create({})
        const child = yield* sessions.create({ parentID: here.id })
        yield* autonomy.setMode({ scope: "session", root: other.id, on: true })

        yield* waitsForAnAnswer(here.id)
        yield* waitsForAnAnswer(child.id)
        expect(yield* skippedLines(here.id)).toHaveLength(0)
        expect(yield* skippedLines(other.id)).toHaveLength(0)
      }),
    )

    registered.instance("the tool the registry hands out sees the mode", () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const autonomy = yield* Autonomy.Service
        const question = yield* Question.Service
        const registry = yield* ToolRegistry.Service
        const root = yield* sessions.create({})
        const child = yield* sessions.create({ parentID: root.id })
        yield* autonomy.setMode({ scope: "session", root: root.id, on: true })

        const tool = (yield* registry.all()).find((item) => item.id === "question")
        const result = yield* tool!
          .execute({ questions: prompt }, { ...ctx, sessionID: child.id })
          .pipe(Effect.timeout(noLongWait))

        expect(result.output).toContain(movedOnText)
        expect((yield* question.list())[0]?.movedOnAt).toBeNumber()
        expect(yield* skippedLines(root.id)).toHaveLength(1)
      }),
    )

    it.instance("a question moved on from with the mode off leaves no line", () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const toolInfo = yield* QuestionTool
        const tool = yield* toolInfo.init()
        const root = yield* sessions.create({})
        process.env.SWARM_UNATTENDED_AFTER_MS = "1"
        yield* Effect.addFinalizer(() => Effect.sync(() => delete process.env.SWARM_UNATTENDED_AFTER_MS))

        const result = yield* tool.execute({ questions: prompt }, { ...ctx, sessionID: root.id })

        expect(result.output).toContain(movedOnText)
        expect(yield* skippedLines(root.id)).toHaveLength(0)
      }),
    )

    it.instance("an audit file that cannot be written does not hold the agent up", () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const autonomy = yield* Autonomy.Service
        const root = yield* sessions.create({})
        yield* autonomy.setMode({ scope: "session", root: root.id, on: true })
        mkdirSync(path.join(Global.Path.state, "autonomy", `${root.id}.jsonl`), { recursive: true })

        yield* movesOnStraightAway(root.id)
      }),
    )

    it.instance("does not wait even where moving on is switched off", () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const autonomy = yield* Autonomy.Service
        const root = yield* sessions.create({})
        yield* autonomy.setMode({ scope: "session", root: root.id, on: true })
        process.env.SWARM_UNATTENDED_AFTER_MS = "0"
        yield* Effect.addFinalizer(() => Effect.sync(() => delete process.env.SWARM_UNATTENDED_AFTER_MS))

        yield* movesOnStraightAway(root.id)
      }),
    )
  })

  // intentionally removed the zod validation due to tool call errors, hoping prompting is gonna be good enough
  //   test("should throw an Error for header exceeding 30 characters", async () => {
  //     const tool = await QuestionTool.init()
  //     const questions = [
  //       {
  //         question: "What is your favorite animal?",
  //         header: "This Header is Definitely More Than Thirty Characters Long",
  //         options: [{ label: "Dog", description: "Man's best friend" }],
  //       },
  //     ]
  //     try {
  //       await tool.execute({ questions }, ctx)
  //       // If it reaches here, the test should fail
  //       expect(true).toBe(false)
  //     } catch (e: any) {
  //       expect(e).toBeInstanceOf(Error)
  //       expect(e.cause).toBeInstanceOf(z.ZodError)
  //     }
  //   })

  //   test("should throw an Error for label exceeding 30 characters", async () => {
  //     const tool = await QuestionTool.init()
  //     const questions = [
  //       {
  //         question: "A question with a very long label",
  //         header: "Long Label",
  //         options: [
  //           { label: "This is a very, very, very long label that will exceed the limit", description: "A description" },
  //         ],
  //       },
  //     ]
  //     try {
  //       await tool.execute({ questions }, ctx)
  //       // If it reaches here, the test should fail
  //       expect(true).toBe(false)
  //     } catch (e: any) {
  //       expect(e).toBeInstanceOf(Error)
  //       expect(e.cause).toBeInstanceOf(z.ZodError)
  //     }
  //   })
})
