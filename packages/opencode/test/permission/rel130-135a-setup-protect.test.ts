// C115 (S13-05; 1.3.0 row 135a): ~/.swarm/setup holds the installed setup tools, among them bin/swarm-web-proxy, which
// every session starts. An agent's Write or Edit there is refused in autonomous mode and under the consent (row 135 found
// the consented Write class A and planting the file). The pinned temporary home only; synthetic content only.
import { afterEach, beforeEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Cause, Effect, Exit, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { Agent } from "../../src/agent/agent"
import { Config } from "../../src/config/config"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Format } from "../../src/format"
import { LSP } from "../../src/lsp/lsp"
import { Plugin } from "../../src/plugin"
import { Question } from "../../src/question"
import { Permission } from "../../src/permission"
import { Autonomy } from "../../src/permission/autonomy"
import { AutonomyTable } from "../../src/permission/autonomy-table"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import { Session } from "../../src/session/session"
import { Instruction } from "../../src/session/instruction"
import type { Tool } from "../../src/tool/tool"
import { Truncate } from "../../src/tool/truncate"
import { WriteTool } from "../../src/tool/write"
import { testEffect } from "../lib/effect"

const decided: string[] = []
const decider = Layer.succeed(
  Permission.Decider,
  Permission.Decider.of({
    decide: (input) =>
      Effect.sync(() => {
        decided.push(input.permission)
        return { decision: "reject" as const, decidedBy: "agent:test/stub" }
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
      FSUtil.node,
      Plugin.node,
      Truncate.node,
      Config.node,
      Agent.node,
      RuntimeFlags.node,
      LSP.node,
      Format.node,
      Instruction.node,
    ]),
    [
      [InstanceStore.bootstrapNode, noopBootstrap],
      [Permission.deciderNode, decider],
    ],
  ),
)

const home = Global.Path.home
const bin = path.join(home, ".swarm", "setup", "bin")
const proxy = path.join(bin, "swarm-web-proxy")

test("135a fixture: HOME is pinned under the temporary folder", () => {
  const tmp = FSUtil.resolve(os.tmpdir())
  expect(FSUtil.resolve(home).startsWith(tmp)).toBe(true)
  expect(home).not.toBe(process.env.HOME)
})

beforeEach(() => {
  decided.length = 0
  mkdirSync(bin, { recursive: true })
})
afterEach(() => {
  rmSync(path.join(home, ".swarm"), { recursive: true, force: true })
})

const say = (sessionID: SessionID) =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const message = yield* sessions.updateMessage({
      id: MessageID.ascending(),
      sessionID,
      role: "user",
      time: { created: Date.now() },
      agent: "build",
      model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("free") },
    } satisfies SessionV1.User)
    yield* sessions.updatePart({
      id: PartID.ascending(),
      messageID: message.id,
      sessionID,
      type: "text",
      text: "update the notes",
    } satisfies SessionV1.TextPart)
  })

/** A root session in autonomous mode, with the person's consent when `consent` is true. */
const root = (consent: boolean) =>
  Effect.gen(function* () {
    const session = yield* (yield* Session.Service).create({})
    yield* say(session.id)
    yield* (yield* Autonomy.Service).setMode({
      scope: "session",
      root: session.id,
      on: true,
      ...(consent && { bypassConsent: "bypass-v1" as const, reportLanguage: "en" as const }),
    })
    return session
  })

const context = (sessionID: SessionID) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    const agent = yield* (yield* Agent.Service).get("build")
    return {
      sessionID,
      messageID: MessageID.ascending(),
      callID: "",
      agent: "build",
      abort: AbortSignal.any([]),
      messages: [],
      trust: { canUndo: true },
      metadata: () => Effect.void,
      ask: (request: Parameters<Tool.Context["ask"]>[0]) =>
        permission.ask({ ...request, sessionID, agent: "build", canUndo: true, ruleset: agent!.permission }).pipe(Effect.orDie),
    } as unknown as Tool.Context
  })

/** The protected-place refusal (`protected_path`), not another reason such as a write Swarm cannot save first. */
const PROTECTED = "Autonomous mode never writes to a protected place"

/** The agent's Write onto the staged proxy; it must settle at once (refused), never wait for a person. */
const plant = (sessionID: SessionID) =>
  Effect.gen(function* () {
    const tool = yield* (yield* WriteTool).init()
    const exit = yield* tool
      .execute({ filePath: proxy, content: "#!/bin/sh\n# synthetic t135a plant\nexit 0\n" }, yield* context(sessionID))
      .pipe(Effect.timeout("3 seconds"), Effect.exit)
    return Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
  })

it.instance("135a: under the consent, the agent's Write to <HOME>/.swarm/setup/bin/swarm-web-proxy is refused", () =>
  Effect.gen(function* () {
    const session = yield* root(true)
    const error = yield* plant(session.id)
    expect(String(error)).toContain(PROTECTED)
    expect(existsSync(proxy)).toBe(false)
    expect(yield* (yield* Permission.Service).list()).toEqual([])
    expect(decided).toEqual([])
  }),
)

it.instance("135a: mode on without the consent, the same Write is refused", () =>
  Effect.gen(function* () {
    const session = yield* root(false)
    expect(String(yield* plant(session.id))).toContain(PROTECTED)
    expect(existsSync(proxy)).toBe(false)
    expect(yield* (yield* Permission.Service).list()).toEqual([])
  }),
)

// The table, for the two asks a Write or Edit makes (row 135 probe B3: `edit` and `external_directory` were class A
// `by_main_agent` under the consent).
const instance = { directory: "/work/project", worktree: "/work/project" } as AutonomyTable.Input["instance"]
const bypass = { bypass: { caller: "root" as const }, consent: { id: "c1", files: new Map() } }
const asks = (file: string) =>
  [
    {
      permission: "edit",
      patterns: [file],
      metadata: { filepath: file },
      instance,
      cwd: instance.directory,
      canUndo: true,
      folder: "clean",
      editClass: "no_undo",
    },
    {
      permission: "external_directory",
      patterns: [path.join(path.dirname(file), "*")],
      metadata: { filepath: file },
      instance,
      cwd: instance.directory,
      canUndo: true,
      follows: [{ permission: "edit", patterns: [file] }],
    },
  ] as unknown as AutonomyTable.Input[]

test("135a table: an edit or write anywhere under <HOME>/.swarm/setup is X protected_path, with and without the consent", () => {
  for (const file of [proxy, path.join(bin, "swarm-setup"), path.join(home, ".swarm", "setup", "tools.lock.json")])
    for (const input of asks(file)) {
      expect(AutonomyTable.classify({ ...input, ...bypass } as AutonomyTable.Input)).toMatchObject({ class: "X", category: "protected_path" })
      expect(AutonomyTable.classifyBase(input)).toMatchObject({ class: "X" })
    }
})

test("135a table: a neighbour of ~/.swarm/setup keeps its verdict (only the setup folder is added)", () => {
  const neighbour = path.join(home, ".swarm", "setup-notes", "x.md")
  for (const input of asks(neighbour))
    expect(AutonomyTable.classify({ ...input, ...bypass } as AutonomyTable.Input)).not.toMatchObject({ category: "protected_path" })
})
