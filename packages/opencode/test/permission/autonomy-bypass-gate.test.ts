// 1.1.1 R3b (S1.30-S1.39): how the gate routes a call under the person's consent to the bypass. The main agent's own
// opened call runs on the consent; a subagent's goes to the main agent through the Decider seam, which is faked and
// counted here. What the bypass never opens never reaches it, and without the consent everything is as in 1.1.0.
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
  CONSENT_CONTINUE_SUFFIX,
  IRREVERSIBLE_ARCHIVE_TEXT,
  MAIN_AGENT_UNAVAILABLE_TEXT,
  mainAgentDeclined,
} from "../../src/permission/autonomy-texts"
import { AutonomyTable } from "../../src/permission/autonomy-table"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { readSteps } from "../../src/tool/shell"
import { InstanceStore } from "../../src/project/instance-store"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import { Session } from "../../src/session/session"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { expectNoManifestAbove } from "./install-fixture"

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
    // 1.1.1 F17 (P30): an install opens only from a manifest of the project's own; this one runs no hooks. 1.1.1 F19
    // (n41): and only when nothing above the repository's top holds one, which this machine must give.
    expectNoManifestAbove(test.directory)
    writeFileSync(path.join(test.directory, "package.json"), "{}\n")
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

/** The options the gate gives the main agent for a subagent's opened call. */
const SUB = { forSubagent: { agent: "build" } }

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

it.instance("the main agent's own opened call runs on the consent, on its line, and never reaches the decider", () =>
  Effect.gen(function* () {
    const { root } = yield* family()
    expect(Exit.isSuccess(yield* settled(yield* openedCall(root.id)))).toBe(true)
    expect(stub.calls).toEqual([])
    expect(yield* pending).toEqual([])
    const [line] = yield* decisions(root.id)
    expect(line).toMatchObject({
      class: "A",
      category: "by_main_agent",
      bypassed: "not_routine",
      decidedBy: "agent:main/build",
      via: "main_agent",
      decision: "allow",
      reason: Permission.BYPASS_REASON,
      rootAgent: "build",
    })
  }),
)

it.instance("a subagent's opened call goes to the main agent, with forSubagent, and runs on its yes", () =>
  Effect.gen(function* () {
    const { root, child } = yield* family()
    expect(Exit.isSuccess(yield* settled(yield* openedCall(child.id)))).toBe(true)
    expect(stub.calls).toEqual([
      { permission: "bash", category: "not_routine", options: { forSubagent: { agent: "build" } } },
    ])
    const [line] = yield* decisions(root.id)
    // On the main agent's name, whatever name the decider gave.
    expect(line).toMatchObject({
      sessionID: child.id,
      class: "A",
      category: "by_main_agent",
      bypassed: "not_routine",
      decidedBy: "agent:main/build",
      via: "for_subagent",
      decision: "allow",
      reason: "fine",
    })
  }),
)

it.instance("the main agent's name is its root's last agent", () =>
  Effect.gen(function* () {
    const { root, child } = yield* family(true, "review")
    expect(Exit.isSuccess(yield* settled(yield* openedCall(child.id)))).toBe(true)
    expect(stub.calls[0]!.options).toEqual({ forSubagent: { agent: "review" } })
    expect((yield* decisions(root.id))[0]!.decidedBy).toBe("agent:main/review")
  }),
)

it.instance("the main agent's no is refused with its reason for the subagent, and nothing is held", () =>
  Effect.gen(function* () {
    const { root, child } = yield* family()
    stub.answer = () => Effect.succeed({ decision: "reject", decidedBy: "agent:main/build", reason: "not\nneeded." })
    const failure = failureOf(yield* settled(yield* openedCall(child.id)))
    expect(failure).toBeInstanceOf(Permission.MainAgentRefusedError)
    expect(failure).toBeInstanceOf(PermissionV1.DeniedError)
    expect(failure).not.toBeInstanceOf(PermissionV1.RejectedError)
    // One printable line, as the subagent reads it.
    expect((failure as Error).message).toBe(mainAgentDeclined("not needed."))
    expect(yield* pending).toEqual([])
    expect((yield* decisions(root.id))[0]).toMatchObject({
      decision: "reject",
      via: "for_subagent",
      decidedBy: "agent:main/build",
      reason: "not needed.",
    })
  }),
)

it.instance("a main agent that cannot answer refuses with the unavailable text, and nothing is held", () =>
  Effect.gen(function* () {
    const { root, child } = yield* family()
    const cases: Array<[() => Effect.Effect<Permission.Decided>, string]> = [
      [() => Effect.succeed({ decision: "reject", decidedBy: "system:main_agent_unavailable", reason: "timeout" }), "timeout"],
      // A fake that ignores the option and holds: still no hold for a subagent.
      [() => Effect.succeed({ decision: "defer", decidedBy: "system:decider_unavailable", reason: "queue_full" }), "queue_full"],
      [() => Effect.die(new Error("boom")), "model_error"],
    ]
    for (const [answer] of cases) {
      stub.answer = answer
      const failure = failureOf(yield* settled(yield* openedCall(child.id)))
      expect(failure).toBeInstanceOf(Permission.MainAgentRefusedError)
      expect((failure as Error).message).toBe(MAIN_AGENT_UNAVAILABLE_TEXT)
    }
    expect(yield* pending).toEqual([])
    expect((yield* decisions(root.id)).map((line) => [line.decision, line.decidedBy, line.reason, line.via])).toEqual(
      cases.map(([, reason]) => ["reject", "system:main_agent_unavailable", reason, "for_subagent"]),
    )
  }),
)

it.instance("X, the irreversible list and admin rights never reach the main agent; a subagent's former waits do (1.1.3)", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    const { root, child } = yield* family()
    const dir = test.directory
    const refused = (yield* settled(bash(child.id, "git reset --hard HEAD~1", dir))) as Exit.Exit<void, unknown>
    // 1.1.3 (matrix rows 26, 33, T3): the irreversible list is answered with the archive method; (matrix row 27, T5, T6)
    // admin rights with the consented suffix.
    expect((failureOf(refused) as Error).message).toBe(IRREVERSIBLE_ARCHIVE_TEXT)
    expect((failureOf(yield* settled(bash(child.id, "sudo rm -rf build", dir))) as Error).message).toBe(
      `${ADMIN_RIGHTS_TEXT} ${CONSENT_CONTINUE_SUFFIX}`,
    )
    for (const command of ["curl https://example.com", "launchctl list", "pkill node", "eval $X"])
      // 1.1.3 (matrix rows 2, 20, 21, 22: a subagent's held D no longer waits; it is opened and goes to the main agent).
      expect(Exit.isSuccess(yield* settled(bash(child.id, command, dir)))).toBe(true)
    // The same from the root itself.
    expect(failureOf(yield* settled(bash(root.id, "git push --force", dir)))).toBeInstanceOf(PermissionV1.DeniedError)
    // 1.1.3: X, the irreversible list and admin rights still never reach the main agent; the four opened D calls of the
    // subagent do (spec section 3: a subagent's opened call goes to the main agent for yes or no, as in 1.1.1).
    expect(stub.calls.map((call) => [call.category, call.options])).toEqual([
      ["outward", SUB],
      ["system_service", SUB],
      ["process_not_own", SUB],
      ["unreadable_command", SUB],
    ])
    expect((yield* decisions(root.id)).map((line) => [line.class, line.category, line.bypassed])).toEqual([
      ["X", "irreversible", undefined],
      ["X", "admin_rights", undefined],
      ["A", "by_main_agent", "outward"],
      ["A", "by_main_agent", "system_service"],
      ["A", "by_main_agent", "process_not_own"],
      ["A", "by_main_agent", "unreadable_command"],
      ["X", "irreversible", undefined],
    ])
  }),
)

it.instance("a verdict that claims to open a never-opened X is not believed; an opened D category is (1.1.3)", () =>
  Effect.gen(function* () {
    const { root, child } = yield* family()
    const forge =
      (bypassed: string) =>
      <A, E, R>(self: Effect.Effect<A, E, R>) =>
        self.pipe(
          Effect.provideService(Permission.Classify, () => ({
            class: "A",
            decidedBy: "agent",
            category: "by_main_agent",
            bypassed: bypassed as never,
          })),
        )
    // 1.1.3 (spec section 3 "Gate": under consent only a never-opened X is not believed; an opened D category is believed).
    expect(Exit.isSuccess(yield* settled(mcpCall(child.id), forge("system_service")))).toBe(true)
    // 1.1.3 (spec section 3 "Gate": under consent only a never-opened X is not believed; an opened D category is believed).
    expect(Exit.isSuccess(yield* settled(mcpCall(root.id, "b"), forge("outward")))).toBe(true)
    expect((failureOf(yield* settled(mcpCall(child.id, "c"), forge("irreversible"))) as Error).message).toBe(
      IRREVERSIBLE_ARCHIVE_TEXT,
    )
    // 1.1.3: the subagent's believed opening goes to the main agent; the root's runs on its consent; the never-opened X
    // is still refused before the decider.
    expect(stub.calls.map((call) => [call.category, call.options])).toEqual([["system_service", SUB]])
    expect((yield* decisions(root.id)).map((line) => [line.class, line.category, line.via, line.bypassed])).toEqual([
      ["A", "by_main_agent", "for_subagent", "system_service"],
      ["A", "by_main_agent", "main_agent", "outward"],
      ["X", "irreversible", undefined, undefined],
    ])
  }),
)

it.instance("an opened verdict without the consent is not believed either", () =>
  Effect.gen(function* () {
    const { root } = yield* family(false)
    const exit = yield* settled(mcpCall(root.id), (self) =>
      self.pipe(
        Effect.provideService(Permission.Classify, () => ({
          class: "A" as const,
          decidedBy: "agent" as const,
          category: "by_main_agent" as const,
          bypassed: "external_tool" as const,
        })),
      ),
    )
    expect(failureOf(exit)).toBeInstanceOf(PermissionV1.DeferredError)
    expect(stub.calls).toEqual([])
  }),
)

it.instance("a change to the state files from outside turns the bypass off for the request: 1.1.0 classes", () =>
  Effect.gen(function* () {
    const { root, child } = yield* family()
    const autonomy = yield* Autonomy.Service
    writeFileSync(path.join(folder, "mode.json"), JSON.stringify({ v: 1, sessions: {}, directories: {} }))
    const seen: Array<unknown> = []
    const exit = yield* settled(mcpCall(child.id), (self) =>
      self.pipe(
        Effect.provideService(Permission.Classify, (input) => {
          seen.push(input.bypass)
          return AutonomyTable.classify(input)
        }),
      ),
    )
    expect(failureOf(exit)).toBeInstanceOf(PermissionV1.DeferredError)
    expect(seen).toEqual([undefined])
    expect(stub.calls).toEqual([])
    expect((yield* decisions(root.id)).map((line) => [line.class, line.category, line.via])).toEqual([
      ["D", "external_tool", undefined],
    ])
    // The consent itself is still there; only this request went without it.
    expect(yield* autonomy.bypassOf({ root: root.id, directory: (yield* TestInstance).directory })).toBeDefined()
  }),
)

it.instance("mode on without the consent is 1.1.0: no bypass reaches the table, the same lines as before", () =>
  Effect.gen(function* () {
    const { root, child } = yield* family(false)
    const seen: Array<unknown> = []
    const spy = <A, E, R>(self: Effect.Effect<A, E, R>) =>
      self.pipe(
        Effect.provideService(Permission.Classify, (input) => {
          seen.push([input.bypass, input.ownProcesses])
          return AutonomyTable.classify(input)
        }),
      )
    expect(failureOf(yield* settled(mcpCall(root.id), spy))).toBeInstanceOf(PermissionV1.DeferredError)
    expect(failureOf(yield* settled(mcpCall(child.id, "b"), spy))).toBeInstanceOf(PermissionV1.DeferredError)
    expect(seen).toEqual([
      [undefined, undefined],
      [undefined, undefined],
    ])
    expect(stub.calls).toEqual([])
    const lines = yield* decisions(root.id)
    expect(lines.map((line) => [line.class, line.category, line.decidedBy, line.via, line.bypassed])).toEqual([
      ["D", "external_tool", "gate", undefined, undefined],
      // The table's own 1.1.0 answer for that pattern; nothing of the bypass is on either line.
      ["D", "not_routine", "gate", undefined, undefined],
    ])
  }),
)

it.instance("the gate tells the table root or subagent, and which processes are Swarm's only for a kill", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    const { root, child } = yield* family()
    const seen: Array<unknown> = []
    const asked: SessionID[] = []
    const spy = <A, E, R>(self: Effect.Effect<A, E, R>) =>
      self.pipe(
        Effect.provideService(Permission.OwnProcesses, async (session) => {
          asked.push(session)
          return new Set([4242])
        }),
        Effect.provideService(Permission.Classify, (input) => {
          seen.push([input.bypass?.caller, input.ownProcesses && [...input.ownProcesses]])
          return AutonomyTable.classify(input)
        }),
      )
    yield* settled(mcpCall(root.id), spy)
    yield* settled(bash(child.id, "kill 4242", test.directory), spy)
    expect(seen).toEqual([
      ["root", undefined],
      ["subagent", [4242]],
    ])
    // Asked once, for the session that runs the kill: its own shell tool's processes, nobody else's.
    expect(asked).toEqual([child.id])
  }),
)

it.instance("kill: a process this session's shell tool started is the main agent's on the consent (P5 A2d); since 1.1.3 any other runs too", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    const { root } = yield* family()
    const own = (pids: number[]) => <A, E, R>(self: Effect.Effect<A, E, R>) =>
      self.pipe(
        Effect.provideService(Permission.OwnProcesses, async (session) =>
          session === root.id ? new Set(pids) : new Set<number>(),
        ),
      )
    expect(Exit.isSuccess(yield* settled(bash(root.id, "kill 4242", test.directory), own([4242])))).toBe(true)
    // 1.1.3 (matrix row 21: a process Swarm did not start no longer waits; it runs as the main agent's).
    expect(Exit.isSuccess(yield* settled(bash(root.id, "kill 4343", test.directory), own([4242])))).toBe(true)
    // A process tree that cannot be read is none.
    const broken = <A, E, R>(self: Effect.Effect<A, E, R>) =>
      self.pipe(
        Effect.provideService(Permission.OwnProcesses, (_session) => {
          throw new Error("no ps")
        }),
      )
    // 1.1.3 (matrix row 21: a process Swarm did not start no longer waits; it runs as the main agent's).
    expect(Exit.isSuccess(yield* settled(bash(root.id, "kill 4444", test.directory), broken))).toBe(true)
    // 1.1.3 (matrix row 21): the other two run as well, recorded as process_not_own.
    expect((yield* decisions(root.id)).map((line) => [line.class, line.category, line.via, line.bypassed])).toEqual([
      ["A", "by_main_agent", "main_agent", "not_routine"],
      ["A", "by_main_agent", "main_agent", "process_not_own"],
      ["A", "by_main_agent", "main_agent", "process_not_own"],
    ])
    expect(stub.calls).toEqual([])
  }),
)

it.instance("a subagent's compound call of two allowed steps reaches the main agent in either order (M1)", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    const { child } = yield* family()
    const dir = test.directory
    // 1.1.1 F17 (P30): an install opens only from a manifest of the project's own; this one runs no hooks. 1.1.1 F19
    // (n41): and only when nothing above the repository's top holds one, which this machine must give.
    expectNoManifestAbove(dir)
    writeFileSync(path.join(dir, "package.json"), "{}\n")
    const compound = (command: string) =>
      Effect.promise(async () => {
        const call = bash(child.id, command, dir)
        const steps = await readSteps(command, dir)
        return { ...call, metadata: { ...call.metadata, ...(steps ? { steps } : {}) } }
      })
    // 1.1.1 F20 (P34, S9-4): `ls` reads only; `mkdir` beside an install would be a write beside one, which keeps 1.1.0.
    for (const command of ["ls && bun install", "bun install && ls"])
      expect(Exit.isSuccess(yield* settled(yield* compound(command)))).toBe(true)
    expect(stub.calls.map((call) => [call.permission, call.category, call.options])).toEqual([
      ["bash", "not_routine", { forSubagent: { agent: "build" } }],
      ["bash", "not_routine", { forSubagent: { agent: "build" } }],
    ])
  }),
)

it.instance("an opening of a sensitive file or a hard-flagged script is believed under consent since 1.1.3 (was F1a)", () =>
  Effect.gen(function* () {
    const { root, child } = yield* family()
    const forge =
      (verdict: Permission.Answer) =>
      <A, E, R>(self: Effect.Effect<A, E, R>) =>
        self.pipe(Effect.provideService(Permission.Classify, () => verdict))
    const opened = { class: "A", decidedBy: "agent", category: "by_main_agent" } as const
    // 1.1.3 (spec section 3 "Gate": the `KEPT_D`/`hardScript` terms are dropped; the opening is believed (noWait refuses sudo/delete flags itself)).
    expect(Exit.isSuccess(yield* settled(mcpCall(child.id), forge({ ...opened, bypassed: "sensitive_file" })))).toBe(true)
    const screen = { bytes: 10, lines: 1, sha256: "0".repeat(64), flags: ["network"] as const }
    // 1.1.3 (spec section 3 "Gate": the `KEPT_D`/`hardScript` terms are dropped; the opening is believed (noWait refuses sudo/delete flags itself)).
    expect(Exit.isSuccess(yield* settled(mcpCall(child.id, "b"), forge({ ...opened, bypassed: "script_flagged", screen })))).toBe(true)
    // 1.1.3: both are the subagent's, so both go to the main agent for yes or no.
    expect(stub.calls.map((call) => [call.category, call.options])).toEqual([
      ["sensitive_file", SUB],
      ["script_flagged", SUB],
    ])
    expect((yield* decisions(root.id)).map((line) => [line.class, line.category, line.via, line.bypassed])).toEqual([
      ["A", "by_main_agent", "for_subagent", "sensitive_file"],
      ["A", "by_main_agent", "for_subagent", "script_flagged"],
    ])
  }),
)

it.instance("an MCP or plugin tool's kept 1.1.0 verdict no longer waits under the consent (F9, G2-5; 1.1.3)", () =>
  Effect.gen(function* () {
    const { root, child } = yield* family()
    // 1.1.3 (matrix rows 6, 8: the kept 1.1.0 D no longer waits; it runs as the main agent's).
    expect(Exit.isSuccess(yield* settled(mcpCall(root.id)))).toBe(true)
    // 1.1.3 (matrix rows 6, 8: the kept 1.1.0 D no longer waits; it runs as the main agent's).
    expect(Exit.isSuccess(yield* settled(mcpCall(child.id, "b")))).toBe(true)
    const source = { server: "outside", transport: "local", origin: "project" }
    const mcp = { ...mcpCall(child.id, "c"), permission: "outside_lookup", metadata: { mcp: source } }
    // A local MCP tool the 1.1.0 gate opens runs as it did, on the gate's own line, and still never reaches the main agent.
    expect(Exit.isSuccess(yield* settled(mcp))).toBe(true)
    // 1.1.3: the subagent's opened call goes to the main agent; the root's runs on its consent.
    expect(stub.calls.map((call) => [call.category, call.options])).toEqual([["not_routine", SUB]])
    expect((yield* decisions(root.id)).map((line) => [line.class, line.category, line.via, line.bypassed])).toEqual([
      ["A", "by_main_agent", "main_agent", "external_tool"],
      ["A", "by_main_agent", "for_subagent", "not_routine"],
      ["A", "mcp_tool", undefined, undefined],
    ])
  }),
)

// 1.1.1 F26 (P42): a send the consent lets out runs on the root's consent with its destination on the line; a verdict
// that claims to open an outward category the table does not find again is not believed.
it.instance("F26: a local request runs with its destination recorded; since 1.1.3 a remote one and a forged send run too", () =>
  Effect.gen(function* () {
    const { root, child } = yield* family()
    const test = yield* TestInstance
    const fetchCall = (sessionID: SessionID, url: string) =>
      ({
        sessionID,
        permission: "webfetch",
        patterns: [url],
        metadata: { url },
        always: ["*"],
        ruleset: [],
        agent: "build",
      }) satisfies PermissionV1.AskInput
    expect(Exit.isSuccess(yield* settled(fetchCall(root.id, "http://localhost:3000/")))).toBe(true)
    expect(Exit.isSuccess(yield* settled(bash(root.id, "curl -s http://127.0.0.1:8080/x", test.directory)))).toBe(true)
    // 1.1.3 (matrix row 15 and spec section 3 "Gate" (the `sent` term dropped): no longer waits).
    expect(Exit.isSuccess(yield* settled(fetchCall(root.id, "https://example.com/")))).toBe(true)
    const forged = (self: Effect.Effect<any, any, any>) =>
      self.pipe(
        Effect.provideService(Permission.Classify, () => ({
          class: "A" as const,
          decidedBy: "agent" as const,
          category: "by_main_agent" as const,
          bypassed: "outward_not_in_mission" as const,
          destination: "localhost:3000",
        })),
      )
    // 1.1.3 (matrix row 15 and spec section 3 "Gate" (the `sent` term dropped): no longer waits).
    expect(Exit.isSuccess(yield* settled(mcpCall(child.id, "z"), forged))).toBe(true)
    // 1.1.3: the subagent's believed send goes to the main agent; the remote fetch runs, and (T7 F1) its line carries the
    // host it went to although nobody named it.
    expect(stub.calls.map((call) => [call.category, call.options])).toEqual([["outward_not_in_mission", SUB]])
    expect((yield* decisions(root.id)).map((line) => [line.class, line.category, line.via, line.bypassed, line.destination])).toEqual([
      ["A", "by_main_agent", "main_agent", "outward_not_in_mission", "localhost:3000"],
      ["A", "by_main_agent", "main_agent", "not_routine", "127.0.0.1:8080"],
      ["A", "by_main_agent", "main_agent", "outward_not_in_mission", "example.com"],
      ["A", "by_main_agent", "for_subagent", "outward_not_in_mission", "localhost:3000"],
    ])
  }),
)

// 1.1.1 F29 (P44, D-F26-3 reversed): a host the person names in a message sent after the mode came on opens a request at
// the next call; a host only an agent's message, a tool's output or a file the agent read names stays held.
it.instance("F29: a host named in a later message of the person opens; one in an agent, tool or file text runs, its host on the line (1.1.3, T7 F1)", () =>
  Effect.gen(function* () {
    const { root } = yield* family()
    const sessions = yield* Session.Service
    const test = yield* TestInstance
    const fetchCall = (url: string) =>
      ({
        sessionID: root.id,
        permission: "webfetch",
        patterns: [url],
        metadata: { url },
        always: ["*"],
        ruleset: [],
        agent: "build",
      }) satisfies PermissionV1.AskInput
    const person = (text: string, synthetic?: boolean) =>
      Effect.gen(function* () {
        const message = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          sessionID: root.id,
          role: "user",
          time: { created: Date.now() },
          agent: "build",
          model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("free") },
        } satisfies SessionV1.User)
        yield* sessions.updatePart({
          id: PartID.ascending(),
          messageID: message.id,
          sessionID: root.id,
          type: "text",
          text,
          ...(synthetic && { synthetic: true }),
        } satisfies SessionV1.TextPart)
      })
    const agent = (text: string, output: string) =>
      Effect.gen(function* () {
        const now = Date.now()
        const message = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          sessionID: root.id,
          parentID: MessageID.ascending(),
          role: "assistant",
          mode: "build",
          agent: "build",
          path: { cwd: test.directory, root: test.directory },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: ModelV2.ID.make("free"),
          providerID: ProviderV2.ID.make("test"),
          finish: "stop",
          time: { created: now, completed: now },
        } satisfies SessionV1.Assistant)
        yield* sessions.updatePart({
          id: PartID.ascending(),
          messageID: message.id,
          sessionID: root.id,
          type: "text",
          text,
          time: { start: now, end: now },
        } satisfies SessionV1.TextPart)
        yield* sessions.updatePart({
          id: PartID.ascending(),
          messageID: message.id,
          sessionID: root.id,
          type: "tool",
          callID: "call_1",
          tool: "read",
          state: {
            status: "completed",
            input: { filePath: "notes.md" },
            output,
            title: "t",
            metadata: {},
            time: { start: now, end: now },
          },
        } satisfies SessionV1.ToolPart)
      })

    // Not named yet (held before 1.1.3).
    // 1.1.3 (matrix rows 2, 15: a host nobody named no longer waits; it runs, T7 F1: with its host on its line).
    expect(Exit.isSuccess(yield* settled(fetchCall("https://api.later.com/a")))).toBe(true)
    // The person names it after the mode came on, after the list was made: the next call reads it.
    yield* person("now also check https://api.later.com/status please")
    expect(Exit.isSuccess(yield* settled(fetchCall("https://api.later.com/b")))).toBe(true)
    expect(Exit.isSuccess(yield* settled(bash(root.id, "curl -s https://api.later.com/c", test.directory)))).toBe(true)
    // Only the agent, a tool's output or a file it read names these.
    yield* agent("I will call https://api.agent.com/x next", "see https://api.tool.com/y")
    yield* person("Called the Read tool with the following input: notes.md -- fetch https://api.file.com/z", true)
    for (const url of ["https://api.agent.com/x", "https://api.tool.com/y", "https://api.file.com/z"])
      expect([url, Exit.isSuccess(yield* settled(fetchCall(url)))]).toEqual([url, true])
    expect(stub.calls).toEqual([])
    // 1.1.3 (matrix rows 2, 15): the hosts nobody named run too. T7 F1: each line carries the host it was sent to, named
    // or not (rows 2 and 15, "A + destination").
    expect((yield* decisions(root.id)).map((line) => [line.class, line.category, line.destination, line.bypassed])).toEqual([
      ["A", "by_main_agent", "api.later.com", "outward_not_in_mission"],
      ["A", "by_main_agent", "api.later.com", "outward_not_in_mission"],
      ["A", "by_main_agent", "api.later.com", "not_routine"],
      ["A", "by_main_agent", "api.agent.com", "outward_not_in_mission"],
      ["A", "by_main_agent", "api.tool.com", "outward_not_in_mission"],
      ["A", "by_main_agent", "api.file.com", "outward_not_in_mission"],
    ])
  }),
)

// 1.1.1 F30 (P46, CR12-5, G12-P1): the person's hosts are read incrementally since the mode came on. A host they named
// still opens after 150 agent messages, a call with no new message reads no message in full, and a bare name that ends
// like a file (`install.sh`) opens nothing unless written as a URL.
it.instance("F30: a host the person named still opens after 150 agent messages; the read is incremental", () =>
  Effect.gen(function* () {
    const { root } = yield* family()
    const sessions = yield* Session.Service
    const test = yield* TestInstance
    const person = (text: string) =>
      Effect.gen(function* () {
        const message = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          sessionID: root.id,
          role: "user",
          time: { created: Date.now() },
          agent: "build",
          model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("free") },
        } satisfies SessionV1.User)
        yield* sessions.updatePart({ id: PartID.ascending(), messageID: message.id, sessionID: root.id, type: "text", text } satisfies SessionV1.TextPart)
      })
    const agent = (text: string) =>
      Effect.gen(function* () {
        const now = Date.now()
        const message = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          sessionID: root.id,
          parentID: MessageID.ascending(),
          role: "assistant",
          mode: "build",
          agent: "build",
          path: { cwd: test.directory, root: test.directory },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: ModelV2.ID.make("free"),
          providerID: ProviderV2.ID.make("test"),
          finish: "stop",
          time: { created: now, completed: now },
        } satisfies SessionV1.Assistant)
        yield* sessions.updatePart({
          id: PartID.ascending(),
          messageID: message.id,
          sessionID: root.id,
          type: "text",
          text,
          time: { start: now, end: now },
        } satisfies SessionV1.TextPart)
      })
    // The run's first call makes the consent list; the host is not named yet.
    // 1.1.3 (matrix row 2: a host not named yet no longer waits; it runs, with no destination on its line).
    expect(Exit.isSuccess(yield* settled(bash(root.id, "curl -s https://api.later.com/a", test.directory)))).toBe(true)
    yield* person("now also check https://api.later.com/status, then run install.sh")
    expect(Exit.isSuccess(yield* settled(bash(root.id, "curl -s https://api.later.com/b", test.directory)))).toBe(true)
    for (let index = 0; index < 150; index++) yield* agent(`step ${index}`)
    expect(Exit.isSuccess(yield* settled(bash(root.id, "curl -s https://api.later.com/c", test.directory)))).toBe(true)
    // Nothing new: the next call reads no message in full.
    const before = Autonomy.missionCounters.hydrated
    expect(Exit.isSuccess(yield* settled(bash(root.id, "curl -s https://api.later.com/d", test.directory)))).toBe(true)
    expect(Autonomy.missionCounters.hydrated).toBe(before)
    // A bare name that ends like a file is no host; written as a URL by the person it is one.
    // 1.1.3 (matrix row 2: a host not named yet no longer waits; it runs, with no destination on its line).
    expect(Exit.isSuccess(yield* settled(bash(root.id, "curl -s https://install.sh/x", test.directory)))).toBe(true)
    yield* person("ok, and fetch https://install.sh/latest too")
    expect(Exit.isSuccess(yield* settled(bash(root.id, "curl -s https://install.sh/y", test.directory)))).toBe(true)
    expect(Autonomy.missionCounters.hydrated).toBe(before + 1)
    expect(stub.calls).toEqual([])
  }),
)

// 1.1.1 F33 (CR13-7, CR13-8): the live host read follows the order rows are stored in, not the time a message carries, and
// a person message that never gets parts does not stop it.
it.instance("F33: a person message stored after a later-stamped agent row is read; a part-less one is passed over", () =>
  Effect.gen(function* () {
    const { root } = yield* family()
    const sessions = yield* Session.Service
    const test = yield* TestInstance
    const user = (created: number) =>
      sessions.updateMessage({
        id: MessageID.ascending(),
        sessionID: root.id,
        role: "user",
        time: { created },
        agent: "build",
        model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("free") },
      } satisfies SessionV1.User)
    const person = (text: string, created = Date.now()) =>
      Effect.gen(function* () {
        const message = yield* user(created)
        yield* sessions.updatePart({ id: PartID.ascending(), messageID: message.id, sessionID: root.id, type: "text", text } satisfies SessionV1.TextPart)
      })
    const agent = (created: number) =>
      Effect.gen(function* () {
        const message = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          sessionID: root.id,
          parentID: MessageID.ascending(),
          role: "assistant",
          mode: "build",
          agent: "build",
          path: { cwd: test.directory, root: test.directory },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: ModelV2.ID.make("free"),
          providerID: ProviderV2.ID.make("test"),
          finish: "stop",
          time: { created, completed: created },
        } satisfies SessionV1.Assistant)
        yield* sessions.updatePart({
          id: PartID.ascending(),
          messageID: message.id,
          sessionID: root.id,
          type: "text",
          text: "working",
          time: { start: created, end: created },
        } satisfies SessionV1.TextPart)
      })
    const curl = (url: string) => settled(bash(root.id, `curl -s ${url}`, test.directory))
    // The run's first call makes the consent list.
    // 1.1.3 (matrix row 2: a host not named yet no longer waits; it runs, with no destination on its line).
    expect(Exit.isSuccess(yield* curl("https://api.late.com/a"))).toBe(true)
    // CR13-7: stamped before an agent row the read has already passed, stored after it.
    yield* Effect.sleep("30 millis")
    const stamped = Date.now()
    yield* Effect.sleep("30 millis")
    yield* agent(Date.now())
    // 1.1.3 (matrix row 2: a host not named yet no longer waits; it runs, with no destination on its line).
    expect(Exit.isSuccess(yield* curl("https://api.late.com/b"))).toBe(true)
    yield* person("please also check https://api.late.com/status", stamped)
    expect(Exit.isSuccess(yield* curl("https://api.late.com/c"))).toBe(true)
    // CR13-8: a person message that never got parts, stamped long enough ago, is passed over.
    yield* user(Date.now() - 60_000)
    yield* person("and https://api.after.com/status")
    expect(Exit.isSuccess(yield* curl("https://api.after.com/x"))).toBe(true)
    // The read moved on: nothing is left to read.
    const before = Autonomy.missionCounters.rows
    expect(Exit.isSuccess(yield* curl("https://api.after.com/y"))).toBe(true)
    expect(Autonomy.missionCounters.rows).toBe(before)
    expect(stub.calls).toEqual([])
  }),
)

// 1.1.1 F36 (CR14-3): a revert removes the newest rows, and SQLite hands their rowids to the next rows. The person's next
// message, stored at a rowid at or below the read's cursor, is still read.
it.instance("F36: after a revert frees the top rowids, the person's next message is read", () =>
  Effect.gen(function* () {
    const { root } = yield* family()
    const sessions = yield* Session.Service
    const test = yield* TestInstance
    const person = (text: string) =>
      Effect.gen(function* () {
        const message = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          sessionID: root.id,
          role: "user",
          time: { created: Date.now() },
          agent: "build",
          model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("free") },
        } satisfies SessionV1.User)
        yield* sessions.updatePart({ id: PartID.ascending(), messageID: message.id, sessionID: root.id, type: "text", text } satisfies SessionV1.TextPart)
      })
    const agent = () =>
      Effect.gen(function* () {
        const now = Date.now()
        const message = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          sessionID: root.id,
          parentID: MessageID.ascending(),
          role: "assistant",
          mode: "build",
          agent: "build",
          path: { cwd: test.directory, root: test.directory },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: ModelV2.ID.make("free"),
          providerID: ProviderV2.ID.make("test"),
          finish: "stop",
          time: { created: now, completed: now },
        } satisfies SessionV1.Assistant)
        yield* sessions.updatePart({
          id: PartID.ascending(),
          messageID: message.id,
          sessionID: root.id,
          type: "text",
          text: "working",
          time: { start: now, end: now },
        } satisfies SessionV1.TextPart)
        return message.id
      })
    const curl = (url: string) => settled(bash(root.id, `curl -s ${url}`, test.directory))
    // 1.1.3 (matrix row 2: a host not named yet no longer waits; it runs, with no destination on its line).
    expect(Exit.isSuccess(yield* curl("https://api.first.com/a"))).toBe(true)
    yield* person("check https://api.first.com/status")
    const removed = [yield* agent(), yield* agent(), yield* agent()]
    // The read passes the three agent rows: its cursor is the newest row of the table.
    expect(Exit.isSuccess(yield* curl("https://api.first.com/b"))).toBe(true)
    // 1.1.1 F39 (G15-P1): a steady read checks for a revert with one statement (the row at the cursor and the top rowid).
    const anchors = Autonomy.missionCounters.anchors
    expect(Exit.isSuccess(yield* curl("https://api.first.com/b2"))).toBe(true)
    expect(Autonomy.missionCounters.anchors - anchors).toBe(1)
    for (const messageID of removed) yield* sessions.removeMessage({ sessionID: root.id, messageID })
    yield* person("instead, check https://api.reverted.com/status")
    expect(Exit.isSuccess(yield* curl("https://api.reverted.com/x"))).toBe(true)
    // Read again from the switch: the host named before the revert still counts.
    expect(Exit.isSuccess(yield* curl("https://api.first.com/c"))).toBe(true)
    expect(stub.calls).toEqual([])
  }),
)
