import { afterEach, beforeEach, describe, expect } from "bun:test"
import { rmSync } from "node:fs"
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
import { Question } from "../../src/question"
import { SessionID } from "../../src/session/schema"
import { Session } from "../../src/session/session"
import { testEffect } from "../lib/effect"

// 1.1.4 item 2 (U2, U5): outside autonomous mode, every "Always allow in this session" belongs to the session family that
// gave it, and to nothing else. Expected values are the literals of masterplan/01_specs_permission.md section 2.7.

const folder = path.join(Global.Path.state, "autonomy")
const trustFile = path.join(Global.Path.state, "trust.json")

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
})
afterEach(clean)

type AskIn = PermissionV1.AskInput

// Not stored sessions: the root of each is the session itself.
const A = SessionID.make("ses_spec_a")
const B = SessionID.make("ses_spec_b")

const list = Permission.Service.use((svc) => svc.list())

const waitFor = (count: number) =>
  Effect.gen(function* () {
    for (let i = 0; i < 200; i++) {
      const pending = yield* list
      if (pending.length === count) return pending
      yield* Effect.sleep("5 millis")
    }
    throw new Error(`timed out waiting for ${count} pending request(s)`)
  })

const make = (
  sessionID: SessionID,
  permission: string,
  patterns: string[],
  extra: Partial<Omit<AskIn, "sessionID" | "permission" | "patterns">> = {},
): AskIn => ({ sessionID, permission, patterns, metadata: {}, always: [], ruleset: [], ...extra })

/** Asks, waits for the one prompt, answers it "always" and expects the asking call to succeed. */
const answerAlways = (input: AskIn) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    const fiber = yield* permission.ask(input).pipe(Effect.forkScoped)
    const [asked] = yield* waitFor(1)
    expect(asked!.patterns).toEqual(input.patterns)
    yield* permission.reply({ requestID: asked!.id, reply: "always" })
    const exit = yield* Fiber.await(fiber)
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(yield* list).toHaveLength(0)
  })

/**
 * "allowed": the call returned without a prompt (nothing listed meanwhile).
 * "asked <patterns>": a prompt was listed; it is rejected afterwards so the next case starts clean.
 */
const verdict = (input: AskIn) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    const before = new Set((yield* list).map((item) => item.id))
    const fiber = yield* permission.ask(input).pipe(Effect.forkScoped)
    for (let i = 0; i < 200; i++) {
      const done = fiber.pollUnsafe()
      if (done) {
        if (Exit.isSuccess(done)) return (yield* list).length === before.size ? "allowed" : "allowed but listed"
        return `failed ${(Cause.squash(done.cause) as Error).constructor.name}`
      }
      const added = (yield* list).filter((item) => !before.has(item.id))
      if (added.length === 1 && !added[0]!.deferred) {
        const shown = `asked ${JSON.stringify(added[0]!.patterns)}`
        yield* permission.reply({ requestID: added[0]!.id, reply: "reject" })
        yield* Fiber.await(fiber)
        expect(yield* list).toHaveLength(before.size)
        return shown
      }
      if (added.length > 1) return `listed ${added.length}`
      yield* Effect.sleep("5 millis")
    }
    return "hung"
  })

describe("each withheld source (always: []): the very prompt, same session only", () => {
  it.instance("W1 shell external directory: same session and folder allowed, other session or folder asked", () =>
    Effect.gen(function* () {
      const first = make(A, "external_directory", ["/tmp/out/*"], { metadata: { workdir: "/w" } })
      yield* answerAlways(first)
      expect(yield* verdict(first)).toBe("allowed")
      expect(yield* verdict({ ...first, sessionID: B })).toBe('asked ["/tmp/out/*"]')
      expect(yield* verdict({ ...first, metadata: { workdir: "/v" } })).toBe('asked ["/tmp/out/*"]')
    }),
  )

  it.instance("W2 risky shell command (noAlways): to the letter, same folder, same session", () =>
    Effect.gen(function* () {
      const first = make(A, "bash", ["rm -rf build"], {
        noAlways: true,
        metadata: { command: "rm -rf build", workdir: "/w" },
      })
      yield* answerAlways(first)
      expect(yield* verdict(first)).toBe("allowed")
      expect(yield* verdict({ ...first, sessionID: B })).toBe('asked ["rm -rf build"]')
      expect(yield* verdict({ ...first, metadata: { command: "rm -rf build", workdir: "/v" } })).toBe(
        'asked ["rm -rf build"]',
      )
      expect(
        yield* verdict({ ...first, patterns: ["rm -rf build2"], metadata: { command: "rm -rf build2", workdir: "/w" } }),
      ).toBe('asked ["rm -rf build2"]')
    }),
  )

  it.instance("W2 a remembered `rm -rf *` is a string, never a glob", () =>
    Effect.gen(function* () {
      const first = make(A, "bash", ["rm -rf *"], { noAlways: true, metadata: { workdir: "/w" } })
      yield* answerAlways(first)
      expect(yield* verdict(first)).toBe("allowed")
      expect(yield* verdict({ ...first, sessionID: B })).toBe('asked ["rm -rf *"]')
      expect(yield* verdict({ ...first, patterns: ["rm -rf /"] })).toBe('asked ["rm -rf /"]')
    }),
  )

  it.instance("W3/W4 write or edit of a risky file: that file only", () =>
    Effect.gen(function* () {
      const first = make(A, "edit", ["src/a.ts"])
      yield* answerAlways(first)
      expect(yield* verdict(first)).toBe("allowed")
      expect(yield* verdict({ ...first, sessionID: B })).toBe('asked ["src/a.ts"]')
      expect(yield* verdict({ ...first, patterns: ["src/b.ts"] })).toBe('asked ["src/b.ts"]')
    }),
  )

  it.instance("W5 apply_patch: the same ordered set of files only", () =>
    Effect.gen(function* () {
      const first = make(A, "edit", ["a.ts", "b.ts"])
      yield* answerAlways(first)
      expect(yield* verdict(first)).toBe("allowed")
      expect(yield* verdict({ ...first, sessionID: B })).toBe('asked ["a.ts","b.ts"]')
      expect(yield* verdict({ ...first, patterns: ["a.ts"] })).toBe('asked ["a.ts"]')
      expect(yield* verdict({ ...first, patterns: ["b.ts", "a.ts"] })).toBe('asked ["b.ts","a.ts"]')
    }),
  )

  it.instance("W6 read of a secret file: that file only", () =>
    Effect.gen(function* () {
      const first = make(A, "read", [".env"])
      yield* answerAlways(first)
      expect(yield* verdict(first)).toBe("allowed")
      expect(yield* verdict({ ...first, sessionID: B })).toBe('asked [".env"]')
      expect(yield* verdict({ ...first, patterns: [".env.local"] })).toBe('asked [".env.local"]')
    }),
  )

  it.instance("W7 grep / glob on a secret path", () =>
    Effect.gen(function* () {
      const first = make(A, "read", ["secrets"], { metadata: { filepath: "/w/secrets", pattern: "x" } })
      yield* answerAlways(first)
      expect(yield* verdict(first)).toBe("allowed")
      expect(yield* verdict({ ...first, sessionID: B })).toBe('asked ["secrets"]')
    }),
  )

  it.instance("W8 external directory of a bundled library, no workdir", () =>
    Effect.gen(function* () {
      const first = make(A, "external_directory", ["/lib/x/*"])
      yield* answerAlways(first)
      expect(yield* verdict(first)).toBe("allowed")
      expect(yield* verdict({ ...first, sessionID: B })).toBe('asked ["/lib/x/*"]')
    }),
  )

  it.instance("W9 plan-limited shape (noAlways, always ['*']) stores the prompt, never `edit *`", () =>
    Effect.gen(function* () {
      const first = make(A, "edit", ["src/a.ts"], { always: ["*"], noAlways: true })
      yield* answerAlways(first)
      expect(yield* verdict(first)).toBe("allowed")
      expect(yield* verdict({ ...first, sessionID: B })).toBe('asked ["src/a.ts"]')
      expect(yield* verdict({ ...first, patterns: ["src/b.ts"] })).toBe('asked ["src/b.ts"]')
    }),
  )

  it.instance("W10 spend limit (U5): an always is a once, and the next limit is asked again", () =>
    Effect.gen(function* () {
      const first = make(A, "spend_limit", ["$5.00 of $5.00"])
      yield* answerAlways(first)
      expect(yield* verdict(first)).toBe('asked ["$5.00 of $5.00"]')
      expect(yield* verdict({ ...first, sessionID: B })).toBe('asked ["$5.00 of $5.00"]')
    }),
  )
})

describe("a prompt with always patterns: the session's, not the project's (U2)", () => {
  it.instance("ordinary always ['ls']: same session allowed, another session asked", () =>
    Effect.gen(function* () {
      const first = make(A, "bash", ["ls"], { always: ["ls"] })
      yield* answerAlways(first)
      expect(yield* verdict(first)).toBe("allowed")
      expect(yield* verdict({ ...first, sessionID: B })).toBe('asked ["ls"]')
      // The request next.test.ts:776 used to let through in its second session.
      expect(yield* verdict({ ...first, sessionID: B, always: [] })).toBe('asked ["ls"]')
    }),
  )

  it.instance("a glob always ['echo *'] covers matching commands in the session only", () =>
    Effect.gen(function* () {
      yield* answerAlways(make(A, "bash", ["echo hi"], { always: ["echo *"] }))
      expect(yield* verdict(make(A, "bash", ["echo bye"], { always: ["echo *"] }))).toBe("allowed")
      expect(yield* verdict(make(B, "bash", ["echo bye"], { always: ["echo *"] }))).toBe('asked ["echo bye"]')
      // A pattern rule never answers a prompt marked noAlways (as next.test.ts:1304).
      expect(yield* verdict(make(A, "bash", ["echo x > a"], { noAlways: true }))).toBe('asked ["echo x > a"]')
    }),
  )

  it.instance("doom_loop always ['bash']: same session allowed, another session asked", () =>
    Effect.gen(function* () {
      const first = make(A, "doom_loop", ["bash"], { always: ["bash"] })
      yield* answerAlways(first)
      expect(yield* verdict(first)).toBe("allowed")
      expect(yield* verdict({ ...first, sessionID: B })).toBe('asked ["bash"]')
    }),
  )
})

describe("the session family", () => {
  it.instance("a subagent of the root is not asked; another root is", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const root = yield* sessions.create({})
      const child = yield* sessions.create({ parentID: root.id })
      const other = yield* sessions.create({})

      yield* answerAlways(make(root.id, "bash", ["ls"], { always: ["ls"] }))
      expect(yield* verdict(make(child.id, "bash", ["ls"], { always: ["ls"] }))).toBe("allowed")
      expect(yield* verdict(make(other.id, "bash", ["ls"], { always: ["ls"] }))).toBe('asked ["ls"]')

      yield* answerAlways(make(root.id, "edit", ["src/a.ts"]))
      expect(yield* verdict(make(child.id, "edit", ["src/a.ts"]))).toBe("allowed")
      expect(yield* verdict(make(other.id, "edit", ["src/a.ts"]))).toBe('asked ["src/a.ts"]')
    }),
  )
})

describe("prompts already waiting", () => {
  it.instance("an exact always releases the same prompt waiting in the session", () =>
    Effect.gen(function* () {
      const permission = yield* Permission.Service
      const one = yield* permission.ask(make(A, "edit", ["src/a.ts"])).pipe(Effect.forkScoped)
      const two = yield* permission.ask(make(A, "edit", ["src/a.ts"])).pipe(Effect.forkScoped)
      const waiting = yield* waitFor(2)
      yield* permission.reply({ requestID: waiting[0]!.id, reply: "always" })
      expect(yield* list).toHaveLength(0)
      expect(Exit.isSuccess(yield* Fiber.await(one))).toBe(true)
      expect(Exit.isSuccess(yield* Fiber.await(two))).toBe(true)
    }),
  )

  it.instance("the same prompt waiting in another session stays listed", () =>
    Effect.gen(function* () {
      const permission = yield* Permission.Service
      const inA = yield* permission.ask(make(A, "edit", ["src/a.ts"])).pipe(Effect.forkScoped)
      const inB = yield* permission.ask(make(B, "edit", ["src/a.ts"])).pipe(Effect.forkScoped)
      const waiting = yield* waitFor(2)
      const a = waiting.find((item) => item.sessionID === A)!
      const b = waiting.find((item) => item.sessionID === B)!
      yield* permission.reply({ requestID: a.id, reply: "always" })
      expect(Exit.isSuccess(yield* Fiber.await(inA))).toBe(true)
      expect((yield* list).map((item) => item.id)).toEqual([b.id])
      yield* permission.reply({ requestID: b.id, reply: "reject" })
      yield* Fiber.await(inB)
    }),
  )
})

describe("moved on", () => {
  it.instance("an always on a prompt the agent moved on from holds for the session, not another", () =>
    Effect.gen(function* () {
      const permission = yield* Permission.Service
      process.env.SWARM_UNATTENDED_AFTER_MS = "20"
      const first = make(A, "bash", ["ls"], { always: ["ls"] })
      const exit = yield* permission.ask(first).pipe(Effect.exit)
      expect(Exit.isFailure(exit) && Cause.squash(exit.cause) instanceof PermissionV1.AwayError).toBe(true)
      const [moved] = yield* list
      expect(moved!.movedOnAt).toBeNumber()
      yield* permission.reply({ requestID: moved!.id, reply: "always" })
      expect(yield* list).toHaveLength(0)
      delete process.env.SWARM_UNATTENDED_AFTER_MS

      expect(yield* verdict(first)).toBe("allowed")
      expect(yield* verdict({ ...first, sessionID: B })).toBe('asked ["ls"]')
    }),
  )
})

describe("autonomous mode on: an exact answer given outside it does not apply", () => {
  /** An edit of a secret file: an ordinary prompt with the mode off, held for the person with it on. */
  const secret = (sessionID: SessionID) =>
    make(sessionID, "edit", ["a/.env"], { editClass: "secret", canUndo: true })

  it.instance("the same prompt in the same root is held exactly as in a root never answered", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const autonomy = yield* Autonomy.Service
      const root = yield* sessions.create({})
      const control = yield* sessions.create({})

      // Mode off: the exact answer works.
      yield* answerAlways(secret(root.id))
      expect(yield* verdict(secret(root.id))).toBe("allowed")

      yield* autonomy.setMode({ scope: "session", root: root.id, on: true })
      yield* autonomy.setMode({ scope: "session", root: control.id, on: true })
      expect(yield* verdict(secret(control.id))).toBe("failed DeferredError")
      expect(yield* verdict(secret(root.id))).toBe("failed DeferredError")
      expect(stub.calls).toEqual([])
    }),
  )
})
