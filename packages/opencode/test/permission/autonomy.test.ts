import { afterEach, beforeEach, expect } from "bun:test"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { Cause, Effect, Exit, Fiber, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Permission } from "../../src/permission"
import { Autonomy } from "../../src/permission/autonomy"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import { MessageID, SessionID } from "../../src/session/schema"
import { Session } from "../../src/session/session"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const folder = path.join(Global.Path.state, "autonomy")
const trustFile = path.join(Global.Path.state, "trust.json")

// A decider that would let everything through: what it is never asked about is the whole point of most of these.
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
const group = LayerNode.group([
  Permission.node,
  Session.node,
  Autonomy.node,
  EventV2Bridge.node,
  SessionProjector.node,
  CrossSpawnSpawner.node,
  InstanceStore.node,
])
const it = testEffect(
  AppNodeBuilder.build(group, [
    [InstanceStore.bootstrapNode, noopBootstrap],
    [Permission.deciderNode, decider],
  ]),
)
const shipped = testEffect(AppNodeBuilder.build(group, [[InstanceStore.bootstrapNode, noopBootstrap]]))

const clean = () => {
  rmSync(folder, { recursive: true, force: true })
  rmSync(trustFile, { force: true })
  delete process.env.SWARM_UNATTENDED_AFTER_MS
}

beforeEach(() => {
  clean()
  stub.calls.length = 0
  stub.answer = "allow"
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

const reply = (input: PermissionV1.ReplyInput) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    return yield* permission.reply(input)
  })

/** A root in the mode, with a child and a grandchild under it. */
const lineage = Effect.gen(function* () {
  const sessions = yield* Session.Service
  const autonomy = yield* Autonomy.Service
  const root = yield* sessions.create({})
  const child = yield* sessions.create({ parentID: root.id })
  const grandchild = yield* sessions.create({ parentID: child.id })
  yield* autonomy.setMode({ scope: "session", root: root.id, on: true })
  return { root, child, grandchild }
})

const audit = (root: SessionID) =>
  Effect.gen(function* () {
    const autonomy = yield* Autonomy.Service
    const read = yield* autonomy.readAudit(root)
    return read.lines.flatMap((line) => (line.type === "decision" ? [line] : []))
  })

const bash = (sessionID: SessionID, command: string, directory?: string) =>
  ({
    sessionID,
    permission: "bash",
    patterns: [command],
    metadata: { command, ...(directory ? { workdir: directory } : {}) },
    always: ["*"],
    ruleset: [],
    canUndo: true,
  }) satisfies PermissionV1.AskInput

/** Fails the test if the call has not settled quickly: that it does not wait is what is being claimed. */
const failure = <A, E, R>(self: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const exit = yield* self.pipe(Effect.timeout("2 seconds"), Effect.exit)
    if (Exit.isFailure(exit)) return Cause.squash(exit.cause)
    throw new Error("expected the request to fail")
  })

const waitForPending = (count: number) =>
  Effect.gen(function* () {
    while ((yield* list).length !== count) yield* Effect.sleep("10 millis")
    return yield* list
  }).pipe(Effect.timeout("2 seconds"))

it.instance("without the mode the path is what it was: a prompt with a wait, no decider, no audit", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const root = yield* sessions.create({})
    const fiber = yield* ask(bash(root.id, "git push origin main")).pipe(Effect.exit, Effect.forkScoped)
    const [waiting] = yield* waitForPending(1)
    expect(waiting!.movesOnAt).toBeNumber()
    expect(waiting!.movedOnAt).toBeUndefined()
    expect(waiting!.always).toEqual(["*"])
    yield* reply({ requestID: waiting!.id, reply: "once" })
    expect(Exit.isSuccess(yield* Fiber.join(fiber))).toBe(true)
    expect(stub.calls).toEqual([])
    expect(existsSync(path.join(folder, `${root.id}.jsonl`))).toBe(false)
  }),
)

it.instance("ADV-A8: spend_limit and doom_loop never reach a decider and keep waiting for a person", () =>
  Effect.gen(function* () {
    const { root, child } = yield* lineage
    for (const [sessionID, name] of [
      [root.id, "spend_limit"],
      [child.id, "doom_loop"],
    ] as const) {
      const fiber = yield* ask({
        sessionID,
        permission: name,
        patterns: ["*"],
        metadata: {},
        always: [],
        ruleset: [],
      }).pipe(Effect.exit, Effect.forkScoped)
      const [waiting] = yield* waitForPending(1)
      expect(waiting!.permission).toBe(name)
      // No time at which the agent carries on, and it has not carried on.
      expect(waiting!.movesOnAt).toBeUndefined()
      expect(waiting!.movedOnAt).toBeUndefined()
      yield* Effect.sleep("50 millis")
      expect(fiber.pollUnsafe()).toBeUndefined()
      yield* reply({ requestID: waiting!.id, reply: "once" })
      expect(Exit.isSuccess(yield* Fiber.join(fiber))).toBe(true)
    }
    expect(stub.calls).toEqual([])
    const lines = yield* audit(root.id)
    expect(lines.map((line) => [line.permission, line.class, line.decision, line.decidedBy])).toEqual([
      ["spend_limit", "B", "ask", "person"],
      ["doom_loop", "B", "ask", "person"],
    ])
  }),
)

it.instance("ADV-A11: a critical call from a subagent fails at once, and the parent is not locked", () =>
  Effect.gen(function* () {
    // Zero means the unattended wait is off, which must not hold anything here.
    process.env.SWARM_UNATTENDED_AFTER_MS = "0"
    const { root, child, grandchild } = yield* lineage
    const test = yield* TestInstance

    for (const sessionID of [child.id, grandchild.id]) {
      const error = yield* failure(ask(bash(sessionID, "git push origin main", test.directory)))
      expect(error).toBeInstanceOf(PermissionV1.AwayError)
    }
    const held = yield* list
    expect(held.map((item) => item.sessionID)).toEqual([child.id, grandchild.id])
    for (const item of held) {
      expect(item.movedOnAt).toBeNumber()
      expect(item.movesOnAt).toBeUndefined()
      expect(item.always).toEqual([])
    }
    expect(stub.calls).toEqual([])

    // The same call again adds nothing and waits for nothing.
    const again = yield* failure(ask(bash(child.id, "git push origin main", test.directory)))
    expect(again).toBeInstanceOf(PermissionV1.AwayError)
    expect((yield* list).length).toBe(2)

    // `task` stays automatic, for the parent while its children's calls sit in the queue.
    yield* ask({
      sessionID: root.id,
      permission: "task",
      patterns: ["general"],
      metadata: {},
      always: ["*"],
      ruleset: [],
    })
    expect((yield* list).length).toBe(2)

    const lines = yield* audit(root.id)
    expect(lines.map((line) => [line.sessionID, line.permission, line.class, line.decision])).toEqual([
      [child.id, "bash", "D", "defer"],
      [grandchild.id, "bash", "D", "defer"],
      [root.id, "task", "A", "allow"],
    ])
    expect(lines[0]!.rootID).toBe(root.id)
    expect(lines[0]!.category).toBe("not_routine")
    expect(lines[0]!.decidedBy).toBe("gate")
  }),
)

it.instance("a grandchild's routine command goes to the decider, and its answer holds for that call only", () =>
  Effect.gen(function* () {
    const { grandchild, root } = yield* lineage
    const test = yield* TestInstance

    yield* ask(bash(grandchild.id, "mkdir -p out", test.directory)).pipe(Effect.timeout("2 seconds"))
    expect(stub.calls).toEqual(["bash"])
    expect(yield* list).toEqual([])

    stub.answer = "reject"
    expect(yield* failure(ask(bash(grandchild.id, "mkdir -p other", test.directory)))).toBeInstanceOf(
      PermissionV1.RejectedError,
    )
    expect(yield* list).toEqual([])

    stub.answer = "defer"
    expect(yield* failure(ask(bash(grandchild.id, "mkdir -p third", test.directory)))).toBeInstanceOf(
      PermissionV1.AwayError,
    )
    expect((yield* list).length).toBe(1)

    const lines = yield* audit(root.id)
    expect(lines.map((line) => [line.class, line.decision, line.decidedBy, line.category])).toEqual([
      ["P", "allow", "agent:test/stub", "file-op"],
      ["P", "reject", "agent:test/stub", "file-op"],
      ["P", "defer", "agent:test/stub", "decider_unavailable"],
    ])
  }),
)

it.instance("a command whose folder is not known goes no further than held, with no decider", () =>
  Effect.gen(function* () {
    const { root } = yield* lineage
    // The prompt has not always carried this, and a relative path means nothing without it.
    expect(yield* failure(ask(bash(root.id, "mkdir -p out")))).toBeInstanceOf(PermissionV1.AwayError)
    expect(yield* failure(ask(bash(root.id, "mkdir -p other", "relative/path")))).toBeInstanceOf(PermissionV1.AwayError)
    expect(yield* failure(ask(bash(root.id, "mkdir -p third", "/nowhere/at/all")))).toBeInstanceOf(
      PermissionV1.AwayError,
    )
    expect(stub.calls).toEqual([])
    expect((yield* audit(root.id)).map((line) => line.class)).toEqual(["D", "D", "D"])
  }),
)

shipped.instance("with no decider in place, class P is held and says why", () =>
  Effect.gen(function* () {
    const { root } = yield* lineage
    const test = yield* TestInstance
    expect(yield* failure(ask(bash(root.id, "mkdir -p out", test.directory)))).toBeInstanceOf(PermissionV1.AwayError)
    const [line] = yield* audit(root.id)
    expect([line!.class, line!.decision, line!.category, line!.decidedBy]).toEqual([
      "P",
      "defer",
      "decider_unavailable",
      "system:decider_unavailable",
    ])
  }),
)

it.instance("the mode writes no rule, and an answer on a held call opens nothing further", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const { root } = yield* lineage
    const test = yield* TestInstance
    const before = (yield* sessions.get(root.id)).permission
    const input = bash(root.id, "git push origin main", test.directory)

    expect(yield* failure(ask(input))).toBeInstanceOf(PermissionV1.AwayError)
    const [held] = yield* list
    const answered = yield* reply({ requestID: held!.id, reply: "always" })
    expect(answered?.id).toBe(held!.id)
    expect(input.ruleset).toEqual([])
    expect((yield* sessions.get(root.id)).permission).toEqual(before)
    expect(readFileSync(path.join(folder, "mode.json"), "utf8")).not.toContain("allow")

    // Nothing was approved: the same command is held again rather than let through.
    expect(yield* failure(ask(input))).toBeInstanceOf(PermissionV1.AwayError)
    expect(stub.calls).toEqual([])
  }),
)

it.instance("rules, a grant and a shipped catch-all settle a request before the gate", () =>
  Effect.gen(function* () {
    const { root } = yield* lineage
    const permission = yield* Permission.Service
    const test = yield* TestInstance
    const push = bash(root.id, "git push origin main", test.directory)

    const denied = yield* failure(ask({ ...push, ruleset: [{ permission: "bash", pattern: "*", action: "deny" }] }))
    expect(denied).toBeInstanceOf(PermissionV1.DeniedError)
    expect((denied as PermissionV1.DeniedError).ruleset).toHaveLength(1)

    yield* ask({ ...push, ruleset: [{ permission: "bash", pattern: "*", action: "allow" }] })
    yield* permission.grant({ sessionID: root.id, permission: "bash", patterns: push.patterns })
    yield* ask(push)
    yield* ask({ ...push, harmless: true, ruleset: Permission.fromConfig({ "*": "ask" }) })

    expect(yield* audit(root.id)).toEqual([])
    expect(yield* list).toEqual([])
    expect(stub.calls).toEqual([])
  }),
)

it.instance("what nobody knows or nobody may be asked about gets no further", () =>
  Effect.gen(function* () {
    const { root } = yield* lineage
    const test = yield* TestInstance
    const edit = {
      sessionID: root.id,
      permission: "edit",
      patterns: ["a.ts"],
      metadata: { filepath: path.join(test.directory, "a.ts") },
      always: ["*"],
      ruleset: [],
      canUndo: true,
    } satisfies PermissionV1.AskInput

    // A permission nothing has heard of.
    expect(
      yield* failure(
        ask({
          sessionID: root.id,
          permission: "workflow_tool_approval",
          patterns: ["*"],
          metadata: {},
          always: [],
          ruleset: [],
        }),
      ),
    ).toBeInstanceOf(PermissionV1.AwayError)
    // Nobody said what kind of edit this is.
    expect(yield* failure(ask(edit))).toBeInstanceOf(PermissionV1.AwayError)
    // The app's own state: refused, not queued for a person, and not an error that ends the run.
    const refused = yield* failure(
      ask({
        ...edit,
        patterns: [path.join(Global.Path.state, "trust.json")],
        metadata: { filepath: path.join(Global.Path.state, "trust.json") },
        editClass: "not_ordinary",
      }),
    )
    expect(refused).toBeInstanceOf(PermissionV1.DeniedError)

    expect((yield* list).length).toBe(2)
    expect(stub.calls).toEqual([])
    expect((yield* audit(root.id)).map((line) => [line.class, line.category])).toEqual([
      ["D", "external_tool"],
      ["D", "not_routine"],
      ["X", "app_state"],
    ])
  }),
)

it.instance("edits follow what the tool learned, and an ordinary one leaves no line", () =>
  Effect.gen(function* () {
    const { root } = yield* lineage
    const edit = (patterns: string[], editClass: PermissionV1.EditClass, canUndo = true) =>
      ask({
        sessionID: root.id,
        permission: "edit",
        patterns,
        metadata: {},
        always: ["*"],
        ruleset: [],
        editClass,
        canUndo,
      })

    yield* edit(["src/a.ts"], "ordinary")
    expect(yield* audit(root.id)).toEqual([])

    yield* edit(["scripts/x.sh"], "not_ordinary")
    expect(stub.calls).toEqual(["edit"])

    expect(yield* failure(edit(["package.json"], "sensitive"))).toBeInstanceOf(PermissionV1.AwayError)
    expect(yield* failure(edit([".env"], "secret"))).toBeInstanceOf(PermissionV1.AwayError)
    expect(yield* failure(edit(["b.ts"], "not_ordinary", false))).toBeInstanceOf(PermissionV1.AwayError)
    expect(stub.calls).toEqual(["edit"])
    expect((yield* audit(root.id)).map((line) => [line.class, line.category])).toEqual([
      ["P", "edit-not-ordinary"],
      ["D", "sensitive_file"],
      ["D", "secret_file"],
      ["D", "no_undo"],
    ])
  }),
)

it.instance("a person's own catch-all holds everything that reaches the gate", () =>
  Effect.gen(function* () {
    const { root } = yield* lineage
    const test = yield* TestInstance
    const ruleset = Permission.fromConfig({ "*": "ask", [Permission.USER_CATCH_ALL]: true } as never)
    expect(yield* failure(ask({ ...bash(root.id, "mkdir -p out", test.directory), ruleset }))).toBeInstanceOf(
      PermissionV1.AwayError,
    )
    expect(stub.calls).toEqual([])
    expect((yield* audit(root.id)).map((line) => line.category)).toEqual(["asks_every_time"])
  }),
)

it.instance("a change to the state files from outside stops class P, without reading what it says", () =>
  Effect.gen(function* () {
    const { root } = yield* lineage
    const test = yield* TestInstance
    const autonomy = yield* Autonomy.Service
    writeFileSync(path.join(folder, "mode.json"), JSON.stringify({ v: 1, sessions: {}, directories: {} }))

    expect(yield* failure(ask(bash(root.id, "mkdir -p out", test.directory)))).toBeInstanceOf(PermissionV1.AwayError)
    expect(stub.calls).toEqual([])
    expect(yield* autonomy.isOn({ root: root.id, directory: test.directory })).toBe(true)
    expect((yield* audit(root.id)).map((line) => [line.class, line.category])).toEqual([["D", "not_routine"]])
  }),
)

it.instance("the plan agent's limits reach the whole lineage from the root's last message", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const { root, child, grandchild } = yield* lineage
    const test = yield* TestInstance
    yield* sessions.updateMessage({
      id: MessageID.ascending(),
      sessionID: root.id,
      role: "user",
      time: { created: 0 },
      agent: "plan",
      model: { providerID: "test", modelID: "test" },
      tools: {},
    } as unknown as SessionV1.User)

    const edit = {
      sessionID: grandchild.id,
      permission: "edit",
      patterns: ["src/a.ts"],
      metadata: {},
      always: ["*"],
      ruleset: [],
      editClass: "not_ordinary",
      canUndo: true,
    } satisfies PermissionV1.AskInput
    expect(yield* failure(ask(edit))).toBeInstanceOf(PermissionV1.DeniedError)
    expect(yield* failure(ask(bash(child.id, "mkdir -p out", test.directory)))).toBeInstanceOf(PermissionV1.AwayError)
    expect(stub.calls).toEqual([])
    expect((yield* audit(root.id)).map((line) => [line.class, line.category, line.rootAgent])).toEqual([
      ["X", "plan_mode", "plan"],
      ["D", "plan_mode", "plan"],
    ])
  }),
)

it.instance("the plan agent asking for itself is held the same way in a root that is not on plan", () =>
  Effect.gen(function* () {
    const { root } = yield* lineage
    expect(
      yield* failure(
        ask({
          sessionID: root.id,
          permission: "edit",
          patterns: ["src/a.ts"],
          metadata: {},
          always: ["*"],
          ruleset: [],
          agent: "plan",
          editClass: "not_ordinary",
          canUndo: true,
        }),
      ),
    ).toBeInstanceOf(PermissionV1.DeniedError)
  }),
)

it.instance("turning the mode off leaves held calls answerable and puts new ones back on a prompt", () =>
  Effect.gen(function* () {
    const autonomy = yield* Autonomy.Service
    const { root } = yield* lineage
    const test = yield* TestInstance
    expect(yield* failure(ask(bash(root.id, "git push origin main", test.directory)))).toBeInstanceOf(
      PermissionV1.AwayError,
    )
    yield* autonomy.setMode({ scope: "session", root: root.id, on: false })

    const fiber = yield* ask(bash(root.id, "git status --short", test.directory)).pipe(Effect.exit, Effect.forkScoped)
    const items = yield* waitForPending(2)
    const fresh = items.find((item) => !item.movedOnAt)!
    expect(fresh.movesOnAt).toBeNumber()
    yield* reply({ requestID: fresh.id, reply: "once" })
    expect(Exit.isSuccess(yield* Fiber.join(fiber))).toBe(true)

    const held = items.find((item) => item.movedOnAt)!
    expect((yield* reply({ requestID: held.id, reply: "once" }))?.id).toBe(held.id)
    expect(yield* list).toEqual([])
    expect(stub.calls).toEqual([])
  }),
)

it.instance("a decision that cannot be recorded gives no approval, and refusing or holding still works", () =>
  Effect.gen(function* () {
    const { root } = yield* lineage
    const test = yield* TestInstance
    // A folder where the audit file goes: every write to it fails, whoever runs this.
    mkdirSync(path.join(folder, `${root.id}.jsonl`))

    // The decider says yes, and the command still does not run.
    expect(yield* failure(ask(bash(root.id, "mkdir -p out", test.directory)))).toBeInstanceOf(PermissionV1.AwayError)
    expect(stub.calls).toEqual(["bash"])
    const [held] = yield* list
    expect(held!.movedOnAt).toBeNumber()
    expect(held!.always).toEqual([])

    // The automatic class gets no pass either.
    expect(
      yield* failure(
        ask({ sessionID: root.id, permission: "task", patterns: ["general"], metadata: {}, always: [], ruleset: [] }),
      ),
    ).toBeInstanceOf(PermissionV1.AwayError)

    stub.answer = "reject"
    expect(yield* failure(ask(bash(root.id, "mkdir -p other", test.directory)))).toBeInstanceOf(
      PermissionV1.RejectedError,
    )
    expect(yield* failure(ask(bash(root.id, "git push origin main", test.directory)))).toBeInstanceOf(
      PermissionV1.AwayError,
    )
    expect(
      yield* failure(
        ask({
          sessionID: root.id,
          permission: "edit",
          patterns: [path.join(Global.Path.state, "trust.json")],
          metadata: {},
          always: [],
          ruleset: [],
          editClass: "not_ordinary",
          canUndo: true,
        }),
      ),
    ).toBeInstanceOf(PermissionV1.DeniedError)

    // A spend limit still waits for a person.
    const fiber = yield* ask({
      sessionID: root.id,
      permission: "spend_limit",
      patterns: ["*"],
      metadata: {},
      always: [],
      ruleset: [],
    }).pipe(Effect.exit, Effect.forkScoped)
    const items = yield* waitForPending(4)
    const waiting = items.find((item) => item.permission === "spend_limit")!
    expect(waiting.movedOnAt).toBeUndefined()
    yield* reply({ requestID: waiting.id, reply: "once" })
    expect(Exit.isSuccess(yield* Fiber.join(fiber))).toBe(true)
  }),
)
