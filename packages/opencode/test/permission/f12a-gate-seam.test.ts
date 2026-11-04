// Swarm 1.1.1 F12a (healing loop 5, m33, P4, m29, P5): the gate's seams around the script reader and the own-process
// lookup. (1) The first consented script call after a start is opened: the gate waits for the reader. (2) The wait is
// bounded: a reader that never starts leaves scripts at 1.1.0 after `SCRIPT_READER_WAIT`. (3) A reader that fails starts
// once and warns once over several requests. (4) The own-process lookup runs only for a call that runs `kill`.
// The harness is the one of autonomy-bypass-gate.test.ts.
import { afterEach, beforeEach, expect } from "bun:test"
import { chmodSync, existsSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { Cause, Effect, Exit, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Permission } from "../../src/permission"
import { Autonomy } from "../../src/permission/autonomy"
import type { AutonomyDecider } from "../../src/permission/autonomy-decider"
import {
  ADMIN_RIGHTS_TEXT,
  IRREVERSIBLE_TEXT,
  MAIN_AGENT_UNAVAILABLE_TEXT,
  mainAgentDeclined,
} from "../../src/permission/autonomy-texts"
import { AutonomyTable } from "../../src/permission/autonomy-table"
import { ScriptReader } from "../../src/permission/script-reader"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { readSteps } from "../../src/tool/shell"
import { InstanceStore } from "../../src/project/instance-store"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import { Session } from "../../src/session/session"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const folder = path.join(Global.Path.state, "autonomy")

type Call = { permission: string; category?: string; options?: AutonomyDecider.Options }
// The counting seam: every call that reaches the main agent is here, with what the gate told it.
const stub = {
  calls: [] as Call[],
  answer: (): Effect.Effect<Permission.Decided> =>
    Effect.succeed({ decision: "allow", decidedBy: "agent:test/stub", reason: "fine" }),
}
const decider = Layer.succeed(
  Permission.Decider,
  Permission.Decider.of({
    decide: (input, _root, category, _script, options) =>
      Effect.suspend(() => {
        stub.calls.push({ permission: input.permission, category, options })
        return stub.answer()
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
  rmSync(path.join(Global.Path.state, "trust.json"), { force: true })
}

beforeEach(() => {
  clean()
  stub.calls.length = 0
  stub.answer = () => Effect.succeed({ decision: "allow", decidedBy: "agent:test/stub", reason: "fine" })
})
afterEach(clean)

// D `external_tool` in 1.1.0 (a tool that says nothing about itself). Since 1.1.1 F9 the bypass keeps it at that verdict.
// Distinct patterns keep two calls of one family from joining one held entry (E3) before the gate sees the second.
const mcpCall = (sessionID: SessionID, pattern = "*") =>
  ({
    sessionID,
    permission: "graft_find_code",
    patterns: [pattern],
    metadata: {},
    always: ["*"],
    ruleset: [],
    agent: "build",
  }) satisfies PermissionV1.AskInput

// 1.1.1 F9 (P15 G2-5, P16): an MCP or plugin tool now keeps its 1.1.0 verdict under the consent, so the call these tests
// route through the main agent is a shell call the allowlist opens: `bun install`, D `not_routine` in 1.1.0.
const openedCall = (sessionID: SessionID) =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    return bash(sessionID, "bun install", test.directory)
  })

const bash = (sessionID: SessionID, command: string, directory: string) =>
  ({
    sessionID,
    permission: "bash",
    patterns: [command],
    metadata: { command, workdir: directory },
    always: ["*"],
    ruleset: [],
    canUndo: true,
    agent: "general",
  }) satisfies PermissionV1.AskInput

const say = (sessionID: SessionID, agent = "build") =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const message = yield* sessions.updateMessage({
      id: MessageID.ascending(),
      sessionID,
      role: "user",
      time: { created: Date.now() },
      agent,
      model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("free") },
    } satisfies SessionV1.User)
    yield* sessions.updatePart({
      id: PartID.ascending(),
      messageID: message.id,
      sessionID,
      type: "text",
      text: "fix the build",
    } satisfies SessionV1.TextPart)
  })

/** A root in the mode with a person's last message, and a subagent below it. `consent` false is 1.1.0's mode on. */
const family = (consent = true, agent = "build") =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const autonomy = yield* Autonomy.Service
    const root = yield* sessions.create({})
    yield* say(root.id, agent)
    const child = yield* sessions.create({ parentID: root.id })
    yield* autonomy.setMode({
      scope: "session",
      root: root.id,
      on: true,
      ...(consent && { bypassConsent: "bypass-v1" as const, reportLanguage: "en" as const }),
    })
    return { root, child }
  })

type Wrap = <A, E, R>(self: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
const settled = (input: PermissionV1.AskInput, wrap: Wrap = (self) => self) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    return yield* wrap(permission.ask(input)).pipe(Effect.timeout("2 seconds"), Effect.exit)
  })

const failureOf = <A, E>(exit: Exit.Exit<A, E>) => {
  if (Exit.isSuccess(exit)) throw new Error("expected the call to be stopped")
  return Cause.squash(exit.cause)
}

const decisions = (root: SessionID) =>
  Effect.gen(function* () {
    const autonomy = yield* Autonomy.Service
    const read = yield* autonomy.readAudit(root)
    return read.lines.flatMap((line) => (line.type === "decision" ? [line] : []))
  })

const pending = Effect.gen(function* () {
  const permission = yield* Permission.Service
  return yield* permission.list()
})


const SCRIPTS = { test: "tsc", build: "tsc" }
const withManifest = Effect.gen(function* () {
  const test = yield* TestInstance
  writeFileSync(path.join(test.directory, "package.json"), JSON.stringify({ scripts: SCRIPTS }))
  return test
})
const long = (input: PermissionV1.AskInput, wrap: Wrap = (self) => self) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    return yield* wrap(permission.ask(input)).pipe(Effect.timeout("8 seconds"), Effect.exit)
  })
/** Puts a reader state in place for one test and takes it away again, whatever happens. */
const withReader = (next: Parameters<typeof ScriptReader.testing.replace>[0]) =>
  Effect.acquireRelease(
    Effect.sync(() => ScriptReader.testing.replace(next)),
    (restore) => Effect.sync(restore),
  )

it.instance("m33 (1): the first consented script call after a start is opened, the gate waiting for the reader", () =>
  Effect.gen(function* () {
    const test = yield* withManifest
    const { root } = yield* family()
    // Not ready, with the real loader: as after a server start.
    yield* withReader({})
    expect(ScriptReader.isReady()).toBe(false)
    const started = performance.now()
    expect(Exit.isSuccess(yield* long(bash(root.id, "npm test", test.directory)))).toBe(true)
    const took = performance.now() - started
    expect(ScriptReader.isReady()).toBe(true)
    // Opened by the consent, so the decider was never asked.
    expect(stub.calls).toEqual([])
    const [line] = yield* decisions(root.id)
    expect(line).toMatchObject({ class: "A", category: "by_main_agent", via: "main_agent" })
    // Ready now: the next call does not wait for it.
    const again = performance.now()
    expect(Exit.isSuccess(yield* long(bash(root.id, "npm run build", test.directory)))).toBe(true)
    console.log(`[F12a P4] first consented script call ${took.toFixed(1)} ms, next ${(performance.now() - again).toFixed(1)} ms`)
  }),
  { timeout: 30_000 },
)

it.instance("P4: warm() at consent time makes the first consented call find the reader ready", () =>
  Effect.gen(function* () {
    const test = yield* withManifest
    yield* withReader({})
    const { root } = yield* family()
    const warming = performance.now()
    ScriptReader.warm()
    yield* Effect.promise(() => ScriptReader.prepare())
    const warmed = performance.now() - warming
    expect(ScriptReader.isReady()).toBe(true)
    const started = performance.now()
    yield* Effect.promise(() => ScriptReader.prepare())
    const seam = performance.now() - started
    expect(seam).toBeLessThan(5)
    expect(Exit.isSuccess(yield* long(bash(root.id, "npm test", test.directory)))).toBe(true)
    expect(stub.calls).toEqual([])
    console.log(`[F12a P4] warm-up ${warmed.toFixed(1)} ms, seam await after warm-up ${seam.toFixed(3)} ms`)
  }),
  { timeout: 30_000 },
)

it.instance("m29: a reader that never starts is waited for at most SCRIPT_READER_WAIT; the script keeps 1.1.0", () =>
  Effect.gen(function* () {
    const test = yield* withManifest
    const { root } = yield* family()
    let loads = 0
    yield* withReader({
      loader: () => {
        loads++
        return new Promise<never>(() => undefined)
      },
    })
    const started = performance.now()
    const exit = yield* long(bash(root.id, "npm test", test.directory))
    const took = performance.now() - started
    expect(took).toBeGreaterThanOrEqual(1900)
    expect(took).toBeLessThan(5000)
    // Not opened: the 1.1.0 verdict (P, check) went to the decider, which the stub answers.
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(stub.calls).toEqual([expect.objectContaining({ permission: "bash", category: "check" })])
    // A second request waits on the same start, not a new one.
    // 1.1.1 F14 (G5-P4): and not for another 2 s: the bound counts from when the start began, so it is used up.
    const second = performance.now()
    const again = yield* long(bash(root.id, "npm run build", test.directory))
    const secondTook = performance.now() - second
    expect(loads).toBe(1)
    expect(secondTook).toBeLessThan(200)
    // Still the 1.1.0 verdict: the decider was asked again.
    expect(Exit.isSuccess(again)).toBe(true)
    expect(stub.calls).toEqual([
      expect.objectContaining({ permission: "bash", category: "check" }),
      expect.objectContaining({ permission: "bash", category: "check" }),
    ])
    console.log(`[F14 G5-P4] hanging start: first request ${took.toFixed(0)} ms, second ${secondTook.toFixed(1)} ms`)
  }),
  { timeout: 30_000 },
)

// 1.1.1 F14 (m34): the consent itself starts the reader (`setMode`, P24 seam); no test code calls `warm` or `prepare`. The
// loader never settles, so only the start is counted. Fails if the `setMode` line is removed.
it.instance("m34: setMode with the bypass consent starts the reader; without the consent it does not", () =>
  Effect.gen(function* () {
    let loads = 0
    yield* withReader({
      loader: () => {
        loads++
        return new Promise<never>(() => undefined)
      },
    })
    yield* family(false)
    expect(loads).toBe(0)
    yield* family()
    expect(loads).toBe(1)
  }),
)

it.instance("m29: a reader that fails starts once and warns once over three requests, and again only after a minute", () =>
  Effect.gen(function* () {
    const test = yield* withManifest
    const { root } = yield* family()
    let loads = 0
    const warnings: unknown[] = []
    yield* withReader({
      loader: async () => {
        loads++
        throw new Error("no grammar")
      },
      warn: (error) => warnings.push(error),
    })
    for (const command of ["npm test", "npm run build", "npm run test"])
      expect(Exit.isSuccess(yield* long(bash(root.id, command, test.directory)))).toBe(true)
    expect([loads, warnings.length]).toEqual([1, 1])
    // Each kept its 1.1.0 verdict and went to the decider.
    expect(stub.calls.length).toBe(3)
    expect(ScriptReader.read("tsc", test.directory)).toBeUndefined()
    expect([loads, warnings.length]).toEqual([1, 1])
    ScriptReader.testing.expireFailure()
    yield* Effect.promise(() => ScriptReader.prepare())
    expect([loads, warnings.length]).toEqual([2, 2])
  }),
  { timeout: 30_000 },
)

it.instance("P5: the own-process lookup runs for a call that runs kill, not for a word kill in a message", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    const { root } = yield* family()
    let asked = 0
    const counted = <A, E, R>(self: Effect.Effect<A, E, R>) =>
      self.pipe(
        Effect.provideService(Permission.OwnProcesses, async () => {
          asked++
          return new Set([4242])
        }),
      )
    yield* settled(bash(root.id, 'git commit -m "kill the flaky test"', test.directory), counted)
    yield* settled(bash(root.id, "git log --grep kill", test.directory), counted)
    expect(asked).toBe(0)
    expect(Exit.isSuccess(yield* settled(bash(root.id, "kill 4242", test.directory), counted))).toBe(true)
    expect(asked).toBe(1)
  }),
)
