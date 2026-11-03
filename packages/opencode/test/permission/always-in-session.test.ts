import { afterEach, beforeEach, expect } from "bun:test"
import { rmSync } from "node:fs"
import path from "node:path"
import { Cause, Effect, Exit, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Permission } from "../../src/permission"
import { Autonomy } from "../../src/permission/autonomy"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import { Question } from "../../src/question"
import { LateAnswer } from "../../src/session/late-answer"
import { SessionPrompt } from "../../src/session/prompt"
import type { SessionID } from "../../src/session/schema"
import { Session } from "../../src/session/session"
import { testEffect } from "../lib/effect"

// Row 258: "Always allow in this session" on what autonomous mode held for the person.

const folder = path.join(Global.Path.state, "autonomy")
const trustFile = path.join(Global.Path.state, "trust.json")

const stub = { calls: [] as string[], answer: "allow" as Permission.Decided["decision"] }
const decider = Layer.succeed(
  Permission.Decider,
  Permission.Decider.of({
    decide: (input) =>
      Effect.sync(() => {
        stub.calls.push(input.permission)
        return { decision: stub.answer, decidedBy: "agent:test/stub" }
      }),
  }),
)
const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Permission.node,
      Session.node,
      Autonomy.node,
      EventV2Bridge.node,
      SessionProjector.node,
      CrossSpawnSpawner.node,
      InstanceStore.node,
      Question.node,
    ]),
    [
      [InstanceStore.bootstrapNode, noopBootstrap],
      [Permission.deciderNode, decider],
    ],
  ),
)

const clean = () => {
  rmSync(folder, { recursive: true, force: true })
  rmSync(trustFile, { force: true })
  delete process.env.SWARM_UNATTENDED_AFTER_MS
}
beforeEach(() => {
  clean()
  stub.calls.length = 0
  stub.answer = "allow"
  sent.length = 0
})
afterEach(clean)

const ask = (input: PermissionV1.AskInput) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    return yield* permission.ask(input)
  })
const list = Effect.gen(function* () {
  const permission = yield* Permission.Service
  return yield* permission.list()
})
const reply = (input: Parameters<Permission.Interface["reply"]>[0]) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    return yield* permission.reply(input)
  })

/** A root in the mode, with a child under it. */
const lineage = Effect.gen(function* () {
  const sessions = yield* Session.Service
  const autonomy = yield* Autonomy.Service
  const root = yield* sessions.create({})
  const child = yield* sessions.create({ parentID: root.id })
  yield* autonomy.setMode({ scope: "session", root: root.id, on: true })
  return { root, child }
})

const lines = (root: SessionID) =>
  Effect.gen(function* () {
    const autonomy = yield* Autonomy.Service
    return (yield* autonomy.readAudit(root)).lines
  })
const decisions = (root: SessionID) =>
  lines(root).pipe(Effect.map((all) => all.flatMap((line) => (line.type === "decision" ? [line] : []))))

/** An edit of a secret file: class D, held for the person, with no decider asked. */
const secret = (sessionID: SessionID, file: string, always = ["a/*"], metadata: Record<string, unknown> = {}) =>
  ({
    sessionID,
    permission: "edit",
    patterns: [file],
    metadata,
    always,
    ruleset: [],
    editClass: "secret",
    canUndo: true,
  }) satisfies PermissionV1.AskInput

const outcome = <A, E, R>(self: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const exit = yield* self.pipe(Effect.timeout("2 seconds"), Effect.exit)
    return Exit.isFailure(exit) ? Cause.squash(exit.cause) : "ran"
  })

/** Holds the call and answers its entry with "always". */
const alwaysOn = (input: PermissionV1.AskInput) =>
  Effect.gen(function* () {
    expect(yield* outcome(ask(input))).toBeInstanceOf(PermissionV1.DeferredError)
    const entry = (yield* list).find((item) => item.patterns[0] === input.patterns[0])!
    return yield* reply({ requestID: entry.id, reply: "always" })
  })

const sent: string[] = []
const late = LateAnswer.make.pipe(
  Effect.provideService(
    SessionPrompt.Service,
    SessionPrompt.Service.of({
      prompt: (input: SessionPrompt.PromptInput) =>
        Effect.sync(() => {
          sent.push((input.parts[0] as { text: string }).text)
          return {} as never
        }),
    } as unknown as SessionPrompt.Interface),
  ),
)

it.instance("the held entry offers its own patterns for the app, and only the server can name them", () =>
  Effect.gen(function* () {
    const { root } = yield* lineage
    yield* outcome(ask(secret(root.id, "a/.env", ["a/*"], { sessionAlways: ["*"] })))
    yield* outcome(ask(secret(root.id, "b/.env", [], { sessionAlways: ["*"] })))
    const [offered, none] = yield* list
    expect(offered).toMatchObject({ deferred: true, always: [] })
    expect(offered!.metadata.sessionAlways).toEqual(["a/*"])
    // No "always" from the tool: nothing for the app to offer, whatever the tool's own metadata said.
    expect(none!.metadata).not.toHaveProperty("sessionAlways")
  }),
)

it.instance("a later matching call in the same session runs without a hold, on record as the person's", () =>
  Effect.gen(function* () {
    const { root, child } = yield* lineage
    const before = (yield* (yield* Session.Service).get(root.id)).permission
    const answered = yield* alwaysOn(secret(root.id, "a/.env"))
    expect(answered?.released).toBeUndefined()

    expect(yield* outcome(ask(secret(root.id, "a/.env.local")))).toBe("ran")
    // Its subagent is the same session to the person, as every grant of a root is.
    expect(yield* outcome(ask(secret(child.id, "a/b/.env")))).toBe("ran")
    expect(yield* list).toEqual([])
    const [, first, second] = yield* decisions(root.id)
    expect(first).toMatchObject({
      class: "D",
      decision: "allow",
      decidedBy: "person",
      via: "grant",
      reason: 'a person\'s "always in this session"',
    })
    expect(second).toMatchObject({ sessionID: child.id, decision: "allow", decidedBy: "person", via: "grant" })
    // Nothing is written as a rule, and the session's own permission is untouched.
    expect((yield* (yield* Session.Service).get(root.id)).permission).toEqual(before)
    expect(stub.calls).toEqual([])
  }),
)

it.instance("another session, another pattern, another permission or a call offering no always are still held", () =>
  Effect.gen(function* () {
    const { root } = yield* lineage
    const other = yield* lineage
    yield* alwaysOn(secret(root.id, "a/.env"))

    expect(yield* outcome(ask(secret(other.root.id, "a/.env.local")))).toBeInstanceOf(PermissionV1.DeferredError)
    expect(yield* outcome(ask(secret(root.id, "b/.env")))).toBeInstanceOf(PermissionV1.DeferredError)
    expect(yield* outcome(ask({ ...secret(root.id, "a/.env.x"), permission: "write" }))).toBeInstanceOf(
      PermissionV1.DeferredError,
    )
    // The tool withheld "always" for this one, so no "always" covers it.
    expect(yield* outcome(ask(secret(root.id, "a/.env.y", [])))).toBeInstanceOf(PermissionV1.DeferredError)
    expect(yield* outcome(ask({ ...secret(root.id, "a/.env.z"), noAlways: true }))).toBeInstanceOf(
      PermissionV1.DeferredError,
    )
  }),
)

it.instance("class X is still refused and a decider's no still stands", () =>
  Effect.gen(function* () {
    const { root } = yield* lineage
    yield* alwaysOn(secret(root.id, ".env", ["*"]))

    const refused = yield* outcome(ask({ ...secret(root.id, trustFile, ["*"]), editClass: "not_ordinary" }))
    expect(refused).toBeInstanceOf(PermissionV1.DeniedError)
    expect((yield* decisions(root.id)).at(-1)).toMatchObject({ class: "X", decision: "reject", decidedBy: "gate" })

    stub.answer = "reject"
    const declined = yield* outcome(ask({ ...secret(root.id, "scripts/x.sh", ["*"]), editClass: "not_ordinary" }))
    expect(declined).not.toBe("ran")
    expect(stub.calls).toEqual(["edit"])
    expect((yield* decisions(root.id)).at(-1)).toMatchObject({ class: "P", decision: "reject" })
  }),
)

it.instance("turning the mode off ends it, also once it is on again", () =>
  Effect.gen(function* () {
    process.env.SWARM_UNATTENDED_AFTER_MS = "1"
    const autonomy = yield* Autonomy.Service
    const { root } = yield* lineage
    yield* alwaysOn(secret(root.id, "a/.env"))

    yield* autonomy.setMode({ scope: "session", root: root.id, on: false })
    // Off: an ordinary prompt, which nobody answers, and nothing lets it through.
    expect(yield* outcome(ask(secret(root.id, "a/.env.local")))).toBeInstanceOf(PermissionV1.AwayError)
    yield* Effect.sleep("5 millis")
    yield* autonomy.setMode({ scope: "session", root: root.id, on: true })
    expect(yield* outcome(ask(secret(root.id, "a/.env.prod")))).toBeInstanceOf(PermissionV1.DeferredError)
    // And after the gate has marked the new run: the "always" was given in the one before.
    expect(yield* outcome(ask(secret(root.id, "a/.env.test")))).toBeInstanceOf(PermissionV1.DeferredError)
  }),
)

it.instance("entries of the session already waiting that match are released with it, and run", () =>
  Effect.gen(function* () {
    const { root, child } = yield* lineage
    const other = yield* lineage
    yield* outcome(ask(secret(root.id, "a/.env")))
    yield* outcome(ask(secret(root.id, "a/.env.local")))
    yield* outcome(ask(secret(child.id, "a/b/.env")))
    yield* outcome(ask(secret(root.id, "b/.env")))
    yield* outcome(ask(secret(other.root.id, "a/.env")))
    const held = yield* list
    expect(held).toHaveLength(5)
    const [first, local, nested, elsewhere, otherRoot] = held

    const answered = yield* reply({ requestID: first!.id, reply: "always" })
    expect(answered?.released?.map((item) => item.id)).toEqual([local!.id, nested!.id])
    expect((yield* list).map((item) => item.id)).toEqual([elsewhere!.id, otherRoot!.id])
    const closed = (yield* lines(root.id)).flatMap((line) =>
      line.type === "outcome" ? [[line.requestID, line.outcome, line.by]] : [],
    )
    expect(closed).toEqual([
      [first!.id, "approved_later", "person"],
      [local!.id, "approved_later", "person"],
      [nested!.id, "approved_later", "person"],
    ])

    // Each released entry is answered as its own approval: the agent hears of every one.
    yield* (yield* late).permission(answered!)
    expect(sent).toHaveLength(3)
  }),
)

it.instance("an Allow or a Decline leaves nothing for the session", () =>
  Effect.gen(function* () {
    const { root } = yield* lineage
    yield* outcome(ask(secret(root.id, "a/.env")))
    yield* reply({ requestID: (yield* list)[0]!.id, reply: "once" })
    expect(yield* outcome(ask(secret(root.id, "a/.env.local")))).toBeInstanceOf(PermissionV1.DeferredError)
    yield* reply({ requestID: (yield* list)[0]!.id, reply: "reject" })
    expect(yield* outcome(ask(secret(root.id, "a/.env.prod")))).toBeInstanceOf(PermissionV1.DeferredError)
  }),
)
