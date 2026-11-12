import { afterEach, beforeEach, expect } from "bun:test"
import { chmodSync, existsSync, mkdirSync, rmSync } from "node:fs"
import path from "node:path"
import { Cause, Effect, Exit, Fiber, Layer } from "effect"
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
import type { SessionID } from "../../src/session/schema"
import { Session } from "../../src/session/session"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const folder = path.join(Global.Path.state, "autonomy")

// Allows everything, so a call that is stopped was stopped by what it is, and a count of zero means it was never asked.
const stub = { calls: [] as string[] }
const decider = Layer.succeed(
  Permission.Decider,
  Permission.Decider.of({
    decide: (input) =>
      Effect.sync(() => {
        stub.calls.push(input.permission)
        return { decision: "allow" as const, decidedBy: "agent:test/stub" }
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
    ]),
    [
      [InstanceStore.bootstrapNode, noopBootstrap],
      [Permission.deciderNode, decider],
    ],
  ),
)

const clean = () => {
  if (existsSync(folder)) chmodSync(folder, 0o755)
  rmSync(folder, { recursive: true, force: true })
}

beforeEach(() => {
  clean()
  stub.calls.length = 0
})
afterEach(clean)

const mcpCall = (sessionID: SessionID) =>
  ({
    sessionID,
    permission: "graft_find_code",
    patterns: ["*"],
    metadata: {},
    always: ["*"],
    ruleset: [],
    agent: "build",
  }) satisfies PermissionV1.AskInput

const editCall = (sessionID: SessionID, file: string, fields: Partial<PermissionV1.AskInput> = {}) =>
  ({
    sessionID,
    permission: "edit",
    patterns: [file],
    metadata: {},
    always: ["*"],
    ruleset: [],
    agent: "build",
    canUndo: true,
    editClass: "ordinary",
    ...fields,
  }) satisfies PermissionV1.AskInput

/** Answers "always" with the mode off, which is the only thing that leaves a rule behind. */
const allowAlways = (input: PermissionV1.AskInput) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    const fiber = yield* permission.ask(input).pipe(Effect.exit, Effect.forkScoped)
    const pending = yield* Effect.gen(function* () {
      while ((yield* permission.list()).length === 0) yield* Effect.sleep("10 millis")
      return yield* permission.list()
    }).pipe(Effect.timeout("2 seconds"))
    yield* permission.reply({ requestID: pending[0]!.id, reply: "always" })
    expect(Exit.isSuccess(yield* Fiber.join(fiber))).toBe(true)
  })

const newRoot = Effect.gen(function* () {
  const sessions = yield* Session.Service
  return yield* sessions.create({})
})

const modeOn = (root: SessionID) =>
  Effect.gen(function* () {
    const autonomy = yield* Autonomy.Service
    yield* autonomy.setMode({ scope: "session", root, on: true })
  })

const decisions = (root: SessionID) =>
  Effect.gen(function* () {
    const autonomy = yield* Autonomy.Service
    const read = yield* autonomy.readAudit(root)
    return read.lines.flatMap((line) => (line.type === "decision" ? [line] : []))
  })

const settled = (input: PermissionV1.AskInput) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    return yield* permission.ask(input).pipe(Effect.timeout("2 seconds"), Effect.exit)
  })

const failureOf = <A, E>(exit: Exit.Exit<A, E>) => {
  if (Exit.isSuccess(exit)) throw new Error("expected the call to be stopped")
  return Cause.squash(exit.cause)
}

it.instance("F6: an earlier \"always\" still runs in the mode, and the audit says a person's rule let it", () =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    const root = yield* newRoot
    yield* allowAlways(mcpCall(root.id))
    yield* modeOn(root.id)

    expect(Exit.isSuccess(yield* settled(mcpCall(root.id)))).toBe(true)
    expect(Exit.isSuccess(yield* settled(mcpCall(root.id)))).toBe(true)

    expect(yield* permission.list()).toEqual([])
    expect(stub.calls).toEqual([])
    const lines = yield* decisions(root.id)
    // One for each call. What it is stays what it is: `decidedBy` is what says it did not wait for anyone.
    expect(
      lines.map((line) => [line.permission, line.class, line.category, line.decision, line.decidedBy, !!line.reason]),
    ).toEqual([
      ["graft_find_code", "D", "external_tool", "allow", "person", true],
      ["graft_find_code", "D", "external_tool", "allow", "person", true],
    ])
  }),
)

it.instance("F6: class X is refused whatever \"always\" a person gave before, and the refusal is on record", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    const root = yield* newRoot
    const target = path.join(test.directory, "src", "a.ts")
    yield* allowAlways(editCall(root.id, target))
    yield* modeOn(root.id)

    const failure = failureOf(yield* settled(editCall(root.id, target, { agent: "plan" })))
    expect(failure).toBeInstanceOf(PermissionV1.DeniedError)
    // 1.2.6 row 39 (P-01d, INTENT): plan_mode is refused with its own text, which names the way on.
    expect((failure as Error).message).toContain("The plan agent only reads and writes its plan file.")
    expect(stub.calls).toEqual([])
    expect((yield* decisions(root.id)).map((line) => [line.class, line.category, line.decision])).toEqual([
      ["X", "plan_mode", "reject"],
    ])
  }),
)

it.instance("F6: an ordinary edit is on record as the gate's, as it is without any rule, since the mode lets it with no person", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    const root = yield* newRoot
    const target = path.join(test.directory, "src", "a.ts")
    yield* allowAlways(editCall(root.id, target))
    yield* modeOn(root.id)

    expect(Exit.isSuccess(yield* settled(editCall(root.id, target)))).toBe(true)
    // One class A line (C58), and not a person's: the "always" was not needed.
    expect((yield* decisions(root.id)).map((line) => [line.class, line.decidedBy, line.decision, line.reason])).toEqual([
      ["A", "gate", "allow", undefined],
    ])
  }),
)

it.instance("F6: an edit the mode would have held does leave a line, under the same rule", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    const root = yield* newRoot
    const target = path.join(test.directory, "package.json")
    yield* allowAlways(editCall(root.id, target, { editClass: "sensitive" }))
    yield* modeOn(root.id)

    expect(Exit.isSuccess(yield* settled(editCall(root.id, target, { editClass: "sensitive" })))).toBe(true)
    expect((yield* decisions(root.id)).map((line) => [line.class, line.category, line.decidedBy])).toEqual([
      ["D", "sensitive_file", "person"],
    ])
  }),
)

it.instance("F6: with the line unwritable the call does not run, and waits for a person instead", () =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    const root = yield* newRoot
    yield* allowAlways(mcpCall(root.id))
    yield* modeOn(root.id)
    mkdirSync(folder, { recursive: true })
    chmodSync(folder, 0o500)

    const failure = failureOf(yield* settled(mcpCall(root.id)))
    chmodSync(folder, 0o755)
    expect(failure).toBeInstanceOf(PermissionV1.DeferredError)
    expect((yield* permission.list()).map((item) => [item.permission, item.deferred, item.always])).toEqual([
      ["graft_find_code", true, []],
    ])
  }),
)

it.instance("F6: a rule from config is not this path; in the mode it leaves the person's line (AU-02, E2 C100)", () =>
  Effect.gen(function* () {
    const root = yield* newRoot
    yield* modeOn(root.id)
    const input = {
      ...mcpCall(root.id),
      ruleset: [{ permission: "graft_find_code", pattern: "*", action: "allow" as const }],
    }
    expect(Exit.isSuccess(yield* settled(input))).toBe(true)
    // E2 (C100): a way out of ask through a rule the person wrote has its line, as theirs, and the class does not change.
    expect((yield* decisions(root.id)).map((line) => [line.class, line.decision, line.decidedBy, line.via])).toEqual([
      ["A", "allow", "person", undefined],
    ])
  }),
)

it.instance("F6: a call that does not take an \"always\" is not covered by one, and is held as usual", () =>
  Effect.gen(function* () {
    const root = yield* newRoot
    yield* allowAlways(mcpCall(root.id))
    yield* modeOn(root.id)
    const failure = failureOf(yield* settled({ ...mcpCall(root.id), noAlways: true }))
    expect(failure).toBeInstanceOf(PermissionV1.DeferredError)
    expect((yield* decisions(root.id)).map((line) => [line.decision, line.decidedBy])).toEqual([["defer", "gate"]])
  }),
)

it.instance("F6: with the mode off an earlier \"always\" is what it was: no prompt, no audit file", () =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    const root = yield* newRoot
    yield* allowAlways(mcpCall(root.id))
    expect(Exit.isSuccess(yield* settled(mcpCall(root.id)))).toBe(true)
    expect(yield* permission.list()).toEqual([])
    expect(existsSync(path.join(folder, `${root.id}.jsonl`))).toBe(false)
  }),
)
