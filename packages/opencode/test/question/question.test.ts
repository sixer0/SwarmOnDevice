import { afterEach, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Cause, Effect, Exit, Fiber, Layer, Queue } from "effect"
import { Question } from "../../src/question"
import { InstanceRef } from "../../src/effect/instance-ref"
import { InstanceStore } from "../../src/project/instance-store"
import { QuestionID } from "../../src/question/schema"
import { disposeAllInstances, provideInstance, testInstanceStoreLayer, tmpdirScoped } from "../fixture/fixture"
import { SessionID } from "../../src/session/schema"
import { testEffect } from "../lib/effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { EventV2Bridge } from "../../src/event-v2-bridge"

const questionLayer = LayerNode.compile(LayerNode.group([Question.node, EventV2Bridge.node, CrossSpawnSpawner.node]))
const it = testEffect(questionLayer)
const lifecycle = testEffect(Layer.mergeAll(questionLayer, testInstanceStoreLayer))

const askEffect = Effect.fn("QuestionTest.ask")(function* (input: {
  sessionID: SessionID
  questions: ReadonlyArray<Question.Info>
  tool?: Question.Tool
}) {
  const question = yield* Question.Service
  return yield* question.ask(input)
})

const listEffect = Question.Service.use((svc) => svc.list())

const replyEffect = Effect.fn("QuestionTest.reply")(function* (input: {
  requestID: QuestionID
  answers: ReadonlyArray<Question.Answer>
}) {
  const question = yield* Question.Service
  yield* question.reply(input)
})

const rejectEffect = Effect.fn("QuestionTest.reject")(function* (id: QuestionID) {
  const question = yield* Question.Service
  yield* question.reject(id)
})

afterEach(async () => {
  await disposeAllInstances()
})

/** Reject all pending questions so dangling Deferred fibers don't hang the test. */
const rejectAll = Effect.gen(function* () {
  yield* Effect.forEach(yield* listEffect, (req) => rejectEffect(req.id), { discard: true })
})

const waitForPending = Effect.fn("QuestionTest.waitForPending")(function* (count: number) {
  const question = yield* Question.Service
  const events = yield* EventV2Bridge.Service
  const asked = yield* Queue.unbounded<void>()
  const off = yield* events.listen((event) => {
    if (event.type === Question.Event.Asked.type) Queue.offerUnsafe(asked, undefined)
    return Effect.void
  })
  yield* Effect.addFinalizer(() => off)

  for (;;) {
    const pending = yield* question.list()
    if (pending.length === count) return pending
    yield* Queue.take(asked).pipe(Effect.timeout("2 seconds"))
  }
})

it.instance(
  "ask - remains pending until answered",
  () =>
    Effect.gen(function* () {
      const fiber = yield* askEffect({
        sessionID: SessionID.make("ses_test"),
        questions: [
          {
            question: "What would you like to do?",
            header: "Action",
            options: [
              { label: "Option 1", description: "First option" },
              { label: "Option 2", description: "Second option" },
            ],
          },
        ],
      }).pipe(Effect.forkScoped)

      expect(yield* waitForPending(1)).toHaveLength(1)
      yield* rejectAll
      expect((yield* Fiber.await(fiber))._tag).toBe("Failure")
    }),
  { git: true },
)

it.instance(
  "ask - adds to pending list",
  () =>
    Effect.gen(function* () {
      const questions = [
        {
          question: "What would you like to do?",
          header: "Action",
          options: [
            { label: "Option 1", description: "First option" },
            { label: "Option 2", description: "Second option" },
          ],
        },
      ]

      const fiber = yield* askEffect({
        sessionID: SessionID.make("ses_test"),
        questions,
      }).pipe(Effect.forkScoped)

      const pending = yield* waitForPending(1)
      expect(pending.length).toBe(1)
      expect(pending[0].questions).toEqual(questions)
      yield* rejectAll
      expect((yield* Fiber.await(fiber))._tag).toBe("Failure")
    }),
  { git: true },
)

// reply tests

it.instance(
  "reply - resolves the pending ask with answers",
  () =>
    Effect.gen(function* () {
      const questions = [
        {
          question: "What would you like to do?",
          header: "Action",
          options: [
            { label: "Option 1", description: "First option" },
            { label: "Option 2", description: "Second option" },
          ],
        },
      ]

      const fiber = yield* askEffect({
        sessionID: SessionID.make("ses_test"),
        questions,
      }).pipe(Effect.forkScoped)

      const pending = yield* waitForPending(1)
      const requestID = pending[0].id

      yield* replyEffect({
        requestID,
        answers: [["Option 1"]],
      })

      expect(yield* Fiber.join(fiber)).toEqual([["Option 1"]])
    }),
  { git: true },
)

it.instance(
  "reply - removes from pending list",
  () =>
    Effect.gen(function* () {
      const fiber = yield* askEffect({
        sessionID: SessionID.make("ses_test"),
        questions: [
          {
            question: "What would you like to do?",
            header: "Action",
            options: [
              { label: "Option 1", description: "First option" },
              { label: "Option 2", description: "Second option" },
            ],
          },
        ],
      }).pipe(Effect.forkScoped)

      const pending = yield* waitForPending(1)
      expect(pending.length).toBe(1)

      yield* replyEffect({
        requestID: pending[0].id,
        answers: [["Option 1"]],
      })
      yield* Fiber.join(fiber)

      const after = yield* listEffect
      expect(after.length).toBe(0)
    }),
  { git: true },
)

it.instance(
  "reply - fails for unknown requestID",
  () =>
    Effect.gen(function* () {
      const exit = yield* replyEffect({
        requestID: QuestionID.make("que_unknown"),
        answers: [["Option 1"]],
      }).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.squash(exit.cause)).toMatchObject({ _tag: "Question.NotFoundError", requestID: "que_unknown" })
      }
    }),
  { git: true },
)

// reject tests

it.instance(
  "reject - throws RejectedError",
  () =>
    Effect.gen(function* () {
      const fiber = yield* askEffect({
        sessionID: SessionID.make("ses_test"),
        questions: [
          {
            question: "What would you like to do?",
            header: "Action",
            options: [
              { label: "Option 1", description: "First option" },
              { label: "Option 2", description: "Second option" },
            ],
          },
        ],
      }).pipe(Effect.forkScoped)

      const pending = yield* waitForPending(1)
      yield* rejectEffect(pending[0].id)

      const exit = yield* Fiber.await(fiber)
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") expect(exit.cause.toString()).toContain("QuestionRejectedError")
    }),
  { git: true },
)

it.instance(
  "reject - removes from pending list",
  () =>
    Effect.gen(function* () {
      const fiber = yield* askEffect({
        sessionID: SessionID.make("ses_test"),
        questions: [
          {
            question: "What would you like to do?",
            header: "Action",
            options: [
              { label: "Option 1", description: "First option" },
              { label: "Option 2", description: "Second option" },
            ],
          },
        ],
      }).pipe(Effect.forkScoped)

      const pending = yield* waitForPending(1)
      expect(pending.length).toBe(1)

      yield* rejectEffect(pending[0].id)
      expect((yield* Fiber.await(fiber))._tag).toBe("Failure")

      const after = yield* listEffect
      expect(after.length).toBe(0)
    }),
  { git: true },
)

it.instance(
  "reject - fails for unknown requestID",
  () =>
    Effect.gen(function* () {
      const exit = yield* rejectEffect(QuestionID.make("que_unknown")).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.squash(exit.cause)).toMatchObject({ _tag: "Question.NotFoundError", requestID: "que_unknown" })
      }
    }),
  { git: true },
)

// multiple questions tests

it.instance(
  "ask - handles multiple questions",
  () =>
    Effect.gen(function* () {
      const questions = [
        {
          question: "What would you like to do?",
          header: "Action",
          options: [
            { label: "Build", description: "Build the project" },
            { label: "Test", description: "Run tests" },
          ],
        },
        {
          question: "Which environment?",
          header: "Env",
          options: [
            { label: "Dev", description: "Development" },
            { label: "Prod", description: "Production" },
          ],
        },
      ]

      const fiber = yield* askEffect({
        sessionID: SessionID.make("ses_test"),
        questions,
      }).pipe(Effect.forkScoped)

      const pending = yield* waitForPending(1)

      yield* replyEffect({
        requestID: pending[0].id,
        answers: [["Build"], ["Dev"]],
      })

      expect(yield* Fiber.join(fiber)).toEqual([["Build"], ["Dev"]])
    }),
  { git: true },
)

// list tests

it.instance(
  "list - returns all pending requests",
  () =>
    Effect.gen(function* () {
      const fiber1 = yield* askEffect({
        sessionID: SessionID.make("ses_test1"),
        questions: [
          {
            question: "Question 1?",
            header: "Q1",
            options: [{ label: "A", description: "A" }],
          },
        ],
      }).pipe(Effect.forkScoped)

      const fiber2 = yield* askEffect({
        sessionID: SessionID.make("ses_test2"),
        questions: [
          {
            question: "Question 2?",
            header: "Q2",
            options: [{ label: "B", description: "B" }],
          },
        ],
      }).pipe(Effect.forkScoped)

      const pending = yield* waitForPending(2)
      expect(pending.length).toBe(2)
      yield* rejectAll
      expect((yield* Fiber.await(fiber1))._tag).toBe("Failure")
      expect((yield* Fiber.await(fiber2))._tag).toBe("Failure")
    }),
  { git: true },
)

it.instance(
  "list - returns empty when no pending",
  () =>
    Effect.gen(function* () {
      const pending = yield* listEffect
      expect(pending.length).toBe(0)
    }),
  { git: true },
)

lifecycle.live("questions stay isolated by directory", () =>
  Effect.gen(function* () {
    const one = yield* tmpdirScoped({ git: true })
    const two = yield* tmpdirScoped({ git: true })

    const fiber1 = yield* askEffect({
      sessionID: SessionID.make("ses_one"),
      questions: [
        {
          question: "Question 1?",
          header: "Q1",
          options: [{ label: "A", description: "A" }],
        },
      ],
    }).pipe(provideInstance(one), Effect.forkScoped)

    const fiber2 = yield* askEffect({
      sessionID: SessionID.make("ses_two"),
      questions: [
        {
          question: "Question 2?",
          header: "Q2",
          options: [{ label: "B", description: "B" }],
        },
      ],
    }).pipe(provideInstance(two), Effect.forkScoped)

    const onePending = yield* waitForPending(1).pipe(provideInstance(one))
    const twoPending = yield* waitForPending(1).pipe(provideInstance(two))

    expect(onePending.length).toBe(1)
    expect(twoPending.length).toBe(1)
    expect(onePending[0].sessionID).toBe(SessionID.make("ses_one"))
    expect(twoPending[0].sessionID).toBe(SessionID.make("ses_two"))

    yield* rejectEffect(onePending[0].id).pipe(provideInstance(one))
    yield* rejectEffect(twoPending[0].id).pipe(provideInstance(two))

    expect((yield* Fiber.await(fiber1))._tag).toBe("Failure")
    expect((yield* Fiber.await(fiber2))._tag).toBe("Failure")
  }),
)

lifecycle.live("pending question rejects on instance dispose", () =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped({ git: true })
    const fiber = yield* askEffect({
      sessionID: SessionID.make("ses_dispose"),
      questions: [
        {
          question: "Dispose me?",
          header: "Dispose",
          options: [{ label: "Yes", description: "Yes" }],
        },
      ],
    }).pipe(provideInstance(dir), Effect.forkScoped)

    expect(yield* waitForPending(1).pipe(provideInstance(dir))).toHaveLength(1)
    const ctx = yield* Effect.gen(function* () {
      return yield* InstanceRef
    }).pipe(provideInstance(dir))
    if (!ctx) return yield* Effect.die(new Error("missing test instance"))
    yield* InstanceStore.Service.use((store) => store.dispose(ctx))

    const exit = yield* Fiber.await(fiber)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(Question.RejectedError)
  }),
)

lifecycle.live("pending question rejects on instance reload", () =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped({ git: true })
    const fiber = yield* askEffect({
      sessionID: SessionID.make("ses_reload"),
      questions: [
        {
          question: "Reload me?",
          header: "Reload",
          options: [{ label: "Yes", description: "Yes" }],
        },
      ],
    }).pipe(provideInstance(dir), Effect.forkScoped)

    expect(yield* waitForPending(1).pipe(provideInstance(dir))).toHaveLength(1)
    yield* InstanceStore.Service.use((store) => store.reload({ directory: dir }))

    const exit = yield* Fiber.await(fiber)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(Question.RejectedError)
  }),
)

const awayQuestion: Question.Info = {
  question: "Which database?",
  header: "Database",
  options: [{ label: "Postgres", description: "" }],
}

it.instance("a question that opted in moves on, stays open, and a late reply hands it back", () =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      process.env.SWARM_UNATTENDED_AFTER_MS = "40"
    }),
    () =>
      Effect.gen(function* () {
        const question = yield* Question.Service
        const sessionID = SessionID.make("ses_away")
        const exit = yield* question
          .ask({ sessionID, questions: [awayQuestion], movesOn: true })
          .pipe(Effect.exit)
        expect(Exit.isFailure(exit) && Cause.squash(exit.cause) instanceof Question.AwayError).toBe(true)

        const [moved] = yield* question.list()
        expect(moved?.movedOnAt).toBeNumber()
        const late = yield* question.reply({ requestID: moved!.id, answers: [["Postgres"]] })
        expect(late?.id).toBe(moved?.id)
        expect(yield* question.list()).toHaveLength(0)
      }),
    () =>
      Effect.sync(() => {
        delete process.env.SWARM_UNATTENDED_AFTER_MS
      }),
  ),
)

it.instance("a session keeps only so many skipped questions, dropping the oldest", () =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      process.env.SWARM_UNATTENDED_AFTER_MS = "1"
    }),
    () =>
      Effect.gen(function* () {
        const question = yield* Question.Service
        const sessionID = SessionID.make("ses_night")
        const other = SessionID.make("ses_other")
        yield* question.ask({ sessionID: other, questions: [awayQuestion], movesOn: true }).pipe(Effect.exit)
        for (let index = 0; index < Question.MAX_SKIPPED + 3; index++) {
          yield* question.ask({ sessionID, questions: [awayQuestion], movesOn: true }).pipe(Effect.exit)
        }
        const listed = yield* question.list()
        expect(listed.filter((item) => item.sessionID === sessionID)).toHaveLength(Question.MAX_SKIPPED)
        // Another session's are not this one's to drop.
        expect(listed.filter((item) => item.sessionID === other)).toHaveLength(1)
      }),
    () =>
      Effect.sync(() => {
        delete process.env.SWARM_UNATTENDED_AFTER_MS
      }),
  ),
)

it.instance("a question that did not opt in waits for a person", () =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      process.env.SWARM_UNATTENDED_AFTER_MS = "20"
    }),
    () =>
      Effect.gen(function* () {
        const question = yield* Question.Service
        const fiber = yield* question
          .ask({ sessionID: SessionID.make("ses_stays"), questions: [awayQuestion] })
          .pipe(Effect.forkScoped)
        yield* Effect.sleep("60 millis")
        const [waiting] = yield* question.list()
        expect(waiting?.movesOnAt).toBeUndefined()
        expect(waiting?.movedOnAt).toBeUndefined()
        yield* question.reject(waiting!.id)
        yield* Fiber.await(fiber)
      }),
    () =>
      Effect.sync(() => {
        delete process.env.SWARM_UNATTENDED_AFTER_MS
      }),
  ),
)
