// 1.2.6 row 39 (SEC-04, C8 part of SR-04): in autonomous mode an agent's write to ~/.config/swarm/tool-health.json (the
// startup list of tool-health entries, an autostart surface) is X `app_state` with the app-state text; nothing is written
// and nobody is asked. Outside the mode the same call asks, as any write outside the project does. The person's own edits
// do not pass through here (U21).

import { afterEach, beforeEach, expect } from "bun:test"
import { existsSync, rmSync } from "node:fs"
import path from "node:path"
import { Cause, Effect, Exit, Fiber, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Agent } from "../../src/agent/agent"
import { Config } from "../../src/config/config"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Format } from "../../src/format"
import { LSP } from "../../src/lsp/lsp"
import { Permission } from "../../src/permission"
import { Autonomy } from "../../src/permission/autonomy"
import { Plugin } from "../../src/plugin"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import { Question } from "../../src/question"
import { MessageID, type SessionID } from "../../src/session/schema"
import { Session } from "../../src/session/session"
import type { Tool } from "../../src/tool/tool"
import { Truncate } from "../../src/tool/truncate"
import { WriteTool } from "../../src/tool/write"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const APP_STATE_PHRASE = "Autonomous mode never changes Swarm's own state or settings."
const GENERIC = "Autonomous mode never allows this kind of call"
const toolHealth = () => path.join(Global.Path.config, "tool-health.json")

const stub = { calls: [] as string[] }
const decider = Layer.succeed(
  Permission.Decider,
  Permission.Decider.of({
    decide: (input) =>
      Effect.sync(() => {
        stub.calls.push(input.permission)
        return { decision: "allow" as Permission.Decided["decision"], decidedBy: "agent:test/stub" }
      }),
  }),
)
const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
const flows = testEffect(
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
      FSUtil.node,
      Plugin.node,
      Truncate.node,
      Config.node,
      Agent.node,
      RuntimeFlags.node,
      LSP.node,
      Format.node,
    ]),
    [
      [InstanceStore.bootstrapNode, noopBootstrap],
      [Permission.deciderNode, decider],
    ],
  ),
)

const clean = () => {
  rmSync(path.join(Global.Path.state, "autonomy"), { recursive: true, force: true })
  rmSync(toolHealth(), { force: true })
}
beforeEach(() => {
  clean()
  stub.calls.length = 0
})
afterEach(clean)

const ask = (input: PermissionV1.AskInput) =>
  Effect.gen(function* () {
    return yield* (yield* Permission.Service).ask(input)
  })
const list = Effect.gen(function* () {
  return yield* (yield* Permission.Service).list()
})
const failure = <A, E, R>(self: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const exit = yield* self.pipe(Effect.timeout("2 seconds"), Effect.exit)
    if (Exit.isFailure(exit)) return Cause.squash(exit.cause)
    throw new Error("expected the request to fail")
  })
const waitForPending = (count: number) =>
  Effect.gen(function* () {
    while ((yield* list).length < count) yield* Effect.sleep("10 millis")
    return yield* list
  }).pipe(Effect.timeout("2 seconds"))

const session = (mode: boolean) =>
  Effect.gen(function* () {
    const root = yield* (yield* Session.Service).create({})
    if (mode) yield* (yield* Autonomy.Service).setMode({ scope: "session", root: root.id, on: true })
    return root.id
  })
const audit = (root: SessionID) =>
  Effect.gen(function* () {
    const read = yield* (yield* Autonomy.Service).readAudit(root)
    return read.lines.flatMap((line) => (line.type === "decision" ? [line] : []))
  })

const context = (sessionID: SessionID) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    return {
      sessionID,
      messageID: MessageID.ascending(),
      callID: "",
      agent: "build",
      abort: AbortSignal.any([]),
      messages: [],
      metadata: () => Effect.void,
      ask: (request) =>
        permission.ask({ ...request, sessionID, agent: "build", canUndo: true, ruleset: [] }).pipe(Effect.orDie),
    } satisfies Tool.Context
  })
const write = (sessionID: SessionID, filePath: string, content: string) =>
  Effect.gen(function* () {
    const tool = yield* (yield* WriteTool).init()
    return yield* tool.execute({ filePath, content }, yield* context(sessionID))
  })

const expectAppState = (error: unknown) => {
  expect(error).toBeInstanceOf(PermissionV1.DeniedError)
  expect((error as Error).message).toContain(APP_STATE_PHRASE)
  expect((error as Error).message).toContain("Write what should change into your final message for the person")
  expect((error as Error).message).not.toContain(GENERIC)
}

flows.instance("SEC-04: the write tool onto tool-health.json in autonomous mode is X app_state with its text", () =>
  Effect.gen(function* () {
    const root = yield* session(true)
    expectAppState(yield* failure(write(root, toolHealth(), '{"flux3":{"argv":["/bin/sh"]}}')))
    expect(existsSync(toolHealth())).toBe(false)
    expect(yield* list).toEqual([])
    expect(stub.calls).toEqual([])
    const [line] = yield* audit(root)
    expect(line).toMatchObject({ class: "X", category: "app_state" })
  }),
)

flows.instance("SEC-04: an edit of tool-health.json in autonomous mode is X app_state with its text", () =>
  Effect.gen(function* () {
    const root = yield* session(true)
    const error = yield* failure(
      ask({
        sessionID: root,
        permission: "edit",
        patterns: [toolHealth()],
        metadata: { filepath: toolHealth() },
        always: [],
        ruleset: [],
        editClass: "not_ordinary",
        canUndo: true,
      }),
    )
    expectAppState(error)
    expect(yield* list).toEqual([])
  }),
)

flows.instance("SEC-04: a shell redirect onto tool-health.json in autonomous mode is X app_state with its text", () =>
  Effect.gen(function* () {
    const root = yield* session(true)
    const test = yield* TestInstance
    const command = `printf '{}' > ${toolHealth()}`
    const error = yield* failure(
      ask({
        sessionID: root,
        permission: "bash",
        patterns: [command],
        metadata: { command, workdir: test.directory },
        always: ["*"],
        ruleset: [],
        canUndo: true,
      }),
    )
    expectAppState(error)
    expect(existsSync(toolHealth())).toBe(false)
    expect(yield* list).toEqual([])
  }),
)

flows.instance("SEC-04: outside autonomous mode the same write asks the person", () =>
  Effect.gen(function* () {
    const root = yield* session(false)
    const fiber = yield* write(root, toolHealth(), "{}").pipe(Effect.exit, Effect.forkScoped)
    const [waiting] = yield* waitForPending(1)
    expect(waiting).toBeDefined()
    expect(waiting!.sessionID).toBe(root)
    expect(existsSync(toolHealth())).toBe(false)
    expect(stub.calls).toEqual([])
    yield* Fiber.interrupt(fiber)
  }),
)
