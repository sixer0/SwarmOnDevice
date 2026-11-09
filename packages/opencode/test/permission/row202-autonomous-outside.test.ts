// Row 202 (2026-11-09): with autonomous mode on, a file tool may read and write folders outside the project without a
// prompt; protected places (keys, credentials, Swarm's auth.json, system folders, the app) stay refused. With the mode off
// nothing changes: the folder prompt is asked. A subagent follows its root's mode.
import { afterEach, beforeEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Cause, Effect, Exit, Fiber } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Layer } from "effect"
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
import { MessageID, type SessionID } from "../../src/session/schema"
import { Session } from "../../src/session/session"
import { Instruction } from "../../src/session/instruction"
import { ReadTool } from "../../src/tool/read"
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
const documents = path.join(home, "Documents")
const ssh = path.join(home, ".ssh")
const authFile = path.join(Global.Path.data, "auth.json")
const modeFolder = path.join(Global.Path.state, "autonomy")

// The pinned home: never the person's real one.
test("row 202 fixture: HOME and XDG are pinned under the temporary folder", () => {
  const tmp = FSUtil.resolve(os.tmpdir())
  expect(FSUtil.resolve(home).startsWith(tmp)).toBe(true)
  expect(FSUtil.resolve(Global.Path.data).startsWith(tmp)).toBe(true)
  expect(home).not.toBe(process.env.HOME)
})

beforeEach(() => {
  decided.length = 0
  rmSync(modeFolder, { recursive: true, force: true })
  mkdirSync(documents, { recursive: true })
  mkdirSync(ssh, { recursive: true })
  mkdirSync(path.dirname(authFile), { recursive: true })
  writeFileSync(path.join(ssh, "id"), "-----not a real key-----\n")
  writeFileSync(authFile, '{"note":"not a real credential"}\n')
})
afterEach(() => {
  rmSync(documents, { recursive: true, force: true })
  rmSync(ssh, { recursive: true, force: true })
  rmSync(authFile, { force: true })
  rmSync(modeFolder, { recursive: true, force: true })
})

/** A tool context as the session gives one: every prompt goes through the real permission service and its gate. */
const context = (sessionID: SessionID) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    // The build agent's own rules, as `SessionTools.resolve` passes them: the shipped baseline asks about a folder outside.
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
        permission
          .ask({ ...request, sessionID, agent: "build", canUndo: true, ruleset: agent!.permission })
          .pipe(Effect.orDie),
    } as unknown as Tool.Context
  })

const write = (sessionID: SessionID, filePath: string, content: string) =>
  Effect.gen(function* () {
    const tool = yield* (yield* WriteTool).init()
    return yield* tool.execute({ filePath, content }, yield* context(sessionID))
  })

const read = (sessionID: SessionID, filePath: string) =>
  Effect.gen(function* () {
    const tool = yield* (yield* ReadTool).init()
    return yield* tool.execute({ filePath }, yield* context(sessionID))
  })

/** The error of a call that must settle at once (no wait for a person). */
const failure = <A, E, R>(self: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const exit = yield* self.pipe(Effect.timeout("3 seconds"), Effect.exit)
    if (Exit.isFailure(exit)) return Cause.squash(exit.cause)
    throw new Error("expected the call to be refused")
  })

const pending = Effect.gen(function* () {
  return yield* (yield* Permission.Service).list()
})

const audit = (root: SessionID) =>
  Effect.gen(function* () {
    const read = yield* (yield* Autonomy.Service).readAudit(root)
    return read.lines.flatMap((line) => (line.type === "decision" ? [line] : []))
  })

const rootInMode = (on: boolean) =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const root = yield* sessions.create({})
    const child = yield* sessions.create({ parentID: root.id })
    if (on) yield* (yield* Autonomy.Service).setMode({ scope: "session", root: root.id, on: true })
    return { root, child }
  })

it.instance("row 202: mode ON, a file tool writes and reads ~/Documents/x outside the project without a prompt", () =>
  Effect.gen(function* () {
    const { root } = yield* rootInMode(true)
    const target = path.join(documents, "x.txt")
    yield* write(root.id, target, "written by the agent\n")
    expect(readFileSync(target, "utf8")).toBe("written by the agent\n")
    // An existing file is overwritten as well (the person agreed to it when turning the mode on).
    yield* write(root.id, target, "changed\n")
    expect(readFileSync(target, "utf8")).toBe("changed\n")
    const result = yield* read(root.id, target)
    expect(result.output).toContain("changed")
    // Nothing waited for a person and nothing went to the decider.
    expect(yield* pending).toEqual([])
    expect(decided).toEqual([])
    const lines = yield* audit(root.id)
    expect(lines.filter((line) => line.category === "outside_edit").length).toBeGreaterThanOrEqual(2)
    expect(lines.some((line) => line.category === "outside_read")).toBe(true)
    expect(lines.every((line) => line.class === "A")).toBe(true)
  }),
)

it.instance("row 202: mode ON, a subagent follows its root's mode for a folder outside the project", () =>
  Effect.gen(function* () {
    const { child } = yield* rootInMode(true)
    const target = path.join(documents, "from-child.txt")
    yield* write(child.id, target, "child\n")
    expect(readFileSync(target, "utf8")).toBe("child\n")
    expect((yield* read(child.id, target)).output).toContain("child")
    expect(yield* pending).toEqual([])
  }),
)

it.instance("row 202: mode ON still refuses ~/.ssh/id and Swarm's auth.json, read or write, with no prompt", () =>
  Effect.gen(function* () {
    const { root, child } = yield* rootInMode(true)
    const key = path.join(ssh, "id")
    const text = (Permission.refusedByMode("protected_path") as Error).message
    for (const session of [root.id, child.id]) {
      const readKey = yield* failure(read(session, key))
      expect(readKey).not.toBeInstanceOf(PermissionV1.DeferredError)
      expect((readKey as Error).message).toBe(text)
      const writeKey = yield* failure(write(session, key, "replaced\n"))
      expect((writeKey as Error).message).toBe(text)
      const readAuth = yield* failure(read(session, authFile))
      expect((readAuth as Error).message).toBe(text)
    }
    // Writing Swarm's auth.json is refused as Swarm's own state (as before row 202), never run.
    expect(yield* failure(write(root.id, authFile, "{}\n"))).not.toBeInstanceOf(PermissionV1.DeferredError)
    expect(readFileSync(key, "utf8")).toBe("-----not a real key-----\n")
    expect(readFileSync(authFile, "utf8")).toBe('{"note":"not a real credential"}\n')
    expect(yield* pending).toEqual([])
    const lines = yield* audit(root.id)
    expect(lines.filter((line) => line.category === "protected_path").every((line) => line.class === "X")).toBe(true)
    expect(lines.some((line) => line.category === "protected_path")).toBe(true)
  }),
)

it.instance("row 202: mode OFF, a folder outside the project still asks a person, and nothing is written meanwhile", () =>
  Effect.gen(function* () {
    const { root } = yield* rootInMode(false)
    const target = path.join(documents, "off.txt")
    const fiber = yield* write(root.id, target, "should wait\n").pipe(Effect.exit, Effect.forkScoped)
    let asked: readonly PermissionV1.Request[] = []
    for (let tries = 0; tries < 200 && asked.length === 0; tries++) {
      yield* Effect.sleep("10 millis")
      asked = yield* pending
    }
    expect(asked.map((item) => item.permission)).toEqual(["external_directory"])
    expect(asked[0]!.deferred).toBeFalsy()
    expect(existsSync(target)).toBe(false)
    yield* (yield* Permission.Service).reply({ requestID: asked[0]!.id, reply: "reject" })
    const exit = yield* Fiber.join(fiber)
    expect(Exit.isFailure(exit)).toBe(true)
    expect(existsSync(target)).toBe(false)
  }),
)

// The table itself, for what the tools above do not reach.
const instance = { directory: "/work/project", worktree: "/work/project" } as AutonomyTable.Input["instance"]
const outsideAsk = (filepath: string, writes: boolean): AutonomyTable.Input =>
  ({
    permission: "external_directory",
    patterns: [path.join(path.dirname(filepath), "*")],
    metadata: { filepath, ...(writes ? {} : { readOnly: true }) },
    instance,
    cwd: instance.directory,
    canUndo: true,
    ...(writes ? { follows: [{ permission: "edit", patterns: [filepath] }] } : {}),
  }) as unknown as AutonomyTable.Input

test("row 202 table: system folders and the app are never written; secrets never read or written", () => {
  for (const file of ["/etc/hosts", "/usr/local/bin/tool", "/System/x", "/Library/x", "/Applications/Swarm.app/Contents/x"])
    expect(AutonomyTable.classify(outsideAsk(file, true))).toMatchObject({ class: "X", category: "protected_path" })
  for (const place of [".ssh/config", ".gnupg/x", ".aws/credentials", ".swarm-patch-key/gsp_patch", "Library/Keychains/login.keychain-db"]) {
    const file = path.join(home, place)
    expect(AutonomyTable.classify(outsideAsk(file, false))).toMatchObject({ class: "X", category: "protected_path" })
    expect(AutonomyTable.classify(outsideAsk(file, true))).toMatchObject({ class: "X", category: "protected_path" })
  }
  // Under the consented bypass a protected place stays refused (1.1.3 opens only X `outside_write`).
  const bypassed = { ...outsideAsk(path.join(home, ".ssh/id"), true), bypass: { caller: "root" as const } }
  expect(AutonomyTable.classify(bypassed)).toMatchObject({ class: "X", category: "protected_path" })
  // A shell command keeps its own rules: a write outside through the shell is still refused (bash is not widened).
  const shellWrite = {
    ...outsideAsk(path.join(documents, "y"), false),
    metadata: { command: `touch ${path.join(documents, "y")}` },
  } as AutonomyTable.Input
  expect(AutonomyTable.classify(shellWrite)).toMatchObject({ class: "X", category: "outside_write" })
  // The plan agent still writes nowhere outside.
  expect(AutonomyTable.classify({ ...outsideAsk(path.join(documents, "z"), true), plan: true })).toMatchObject({
    class: "X",
    category: "plan_mode",
  })
})
