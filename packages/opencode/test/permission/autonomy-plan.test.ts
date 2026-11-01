import { afterEach, beforeEach, expect } from "bun:test"
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import path from "node:path"
import { Effect, Fiber, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { Agent } from "../../src/agent/agent"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { MCP } from "../../src/mcp"
import { Permission } from "../../src/permission"
import { Autonomy } from "../../src/permission/autonomy"
import { Plugin } from "../../src/plugin"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import type { Provider } from "../../src/provider/provider"
import type { SessionProcessor } from "../../src/session/processor"
import { MessageID } from "../../src/session/schema"
import type { SessionID } from "../../src/session/schema"
import { Session } from "../../src/session/session"
import { SessionTools } from "../../src/session/tools"
import { ToolRegistry } from "../../src/tool/registry"
import { Truncate } from "../../src/tool/truncate"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// Real registry, real tools, real permission and gate: a lineage check that the production wiring failed to reach is what
// these have to catch, and a test with its own `ask` would not.
const folder = path.join(Global.Path.state, "autonomy")
const dataPlans = path.join(Global.Path.data, "plans")

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
      ToolRegistry.node,
      Agent.node,
      Permission.node,
      Session.node,
      Autonomy.node,
      Plugin.node,
      MCP.node,
      Truncate.node,
      RuntimeFlags.node,
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
  rmSync(folder, { recursive: true, force: true })
  rmSync(dataPlans, { recursive: true, force: true })
}
beforeEach(() => {
  clean()
  stub.calls.length = 0
})
afterEach(clean)

// The baseline is what writes the shipped catch-all, so nothing here may name `"*"`: a config that does means every call.
const shipped = { git: true } as const

// Models get either the patch tool or the two edit tools, not both.
const modelFor = (tool: string) =>
  ({ providerID: ProviderV2.ID.make("test"), api: { id: tool === "apply_patch" ? "gpt-5" : "test-model" } }) as Provider.Model

/** Runs one tool the way a session's run does, through `SessionTools.resolve` and its own `ctx.ask`. */
const call = (session: Session.Info, agentName: string, tool: string, args: Record<string, unknown>) =>
  Effect.gen(function* () {
    const agents = yield* Agent.Service
    const agent = yield* agents.get(agentName)
    if (!agent) return yield* Effect.die(`no agent ${agentName}`)
    const processor = {
      message: {
        id: MessageID.ascending(),
        sessionID: session.id,
        role: "assistant",
        parentID: MessageID.ascending(),
        agent: agentName,
        mode: agentName,
        path: { cwd: "/tmp", root: "/tmp" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: ModelV2.ID.make("test-model"),
        providerID: ProviderV2.ID.make("test"),
        time: { created: 1 },
      },
      updateToolCall: () => Effect.succeed(undefined),
      completeToolCall: () => Effect.void,
    } as unknown as Pick<SessionProcessor.Handle, "message" | "updateToolCall" | "completeToolCall">
    const tools = yield* SessionTools.resolve({
      agent,
      session,
      model: modelFor(tool),
      processor,
      bypassAgentCheck: false,
      messages: [],
      promptOps: {} as never,
      canUndo: true,
    })
    const execute = tools[tool]?.execute
    if (!execute) return yield* Effect.die(`no tool ${tool}`)
    return yield* Effect.promise(() =>
      Promise.resolve(execute(args, { toolCallId: "call", messages: [], abortSignal: AbortSignal.any([]) })).then(
        () => "ran" as const,
        (error: unknown) => error,
      ),
    )
  })

const said = (sessionID: SessionID, agent: string) =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    yield* sessions.updateMessage({
      id: MessageID.ascending(),
      sessionID,
      role: "user",
      time: { created: 0 },
      agent,
      model: { providerID: "test", modelID: "test" },
      tools: {},
    } as unknown as SessionV1.User)
  })

const lineage = (on = true) =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const autonomy = yield* Autonomy.Service
    const root = yield* sessions.create({})
    const child = yield* sessions.create({ parentID: root.id })
    const grandchild = yield* sessions.create({ parentID: child.id })
    if (on) yield* autonomy.setMode({ scope: "session", root: root.id, on: true })
    return { root, child, grandchild }
  })

const audit = (root: SessionID) =>
  Effect.gen(function* () {
    const autonomy = yield* Autonomy.Service
    const read = yield* autonomy.readAudit(root)
    return read.lines.flatMap((line) => (line.type === "decision" ? [[line.class, line.category]] : []))
  })

const patchAdding = (file: string) => `*** Begin Patch\n*** Add File: ${file}\n+x\n*** End Patch`

it.instance(
  "ADV-A9: the plan agent's edit of a source file is refused by every edit tool, and nothing is written",
  () =>
    Effect.gen(function* () {
      const { root } = yield* lineage()
      const test = yield* TestInstance
      yield* said(root.id, "plan")
      const file = (name: string) => path.join(test.directory, "src", name)

      const refused = [
        yield* call(root, "plan", "write", { filePath: file("a.ts"), content: "x\n" }),
        yield* call(root, "plan", "edit", { filePath: file("b.ts"), oldString: "", newString: "x\n" }),
        yield* call(root, "plan", "apply_patch", { patchText: patchAdding("src/c.ts") }),
      ]

      expect(refused.every((error) => error instanceof PermissionV1.DeniedError)).toBe(true)
      expect(["a.ts", "b.ts", "c.ts"].filter((name) => existsSync(file(name)))).toEqual([])
      expect(stub.calls).toEqual([])
      expect(yield* audit(root.id)).toEqual([
        ["X", "plan_mode"],
        ["X", "plan_mode"],
        ["X", "plan_mode"],
      ])
    }),
  shipped,
)

it.instance(
  "ADV-A9: the plan agent's own plan under .swarm/plans is written by every edit tool",
  () =>
    Effect.gen(function* () {
      const { root } = yield* lineage()
      const test = yield* TestInstance
      yield* said(root.id, "plan")
      const plan = (name: string) => path.join(test.directory, ".swarm", "plans", name)

      expect(yield* call(root, "plan", "write", { filePath: plan("p.md"), content: "# p\n" })).toBe("ran")
      expect(yield* call(root, "plan", "edit", { filePath: plan("q.md"), oldString: "", newString: "# q\n" })).toBe("ran")
      expect(yield* call(root, "plan", "apply_patch", { patchText: patchAdding(".swarm/plans/r.md") })).toBe("ran")

      expect(["p.md", "q.md", "r.md"].every((name) => existsSync(plan(name)))).toBe(true)
      expect(stub.calls).toEqual([])
      expect((yield* audit(root.id)).map((line) => line[0])).toEqual(["A", "A", "A"])
    }),
  shipped,
)

it.instance(
  "only a markdown file directly in the plans folder counts, whatever its name or link says",
  () =>
    Effect.gen(function* () {
      const { root } = yield* lineage()
      const test = yield* TestInstance
      yield* said(root.id, "plan")
      const plans = path.join(test.directory, ".swarm", "plans")
      mkdirSync(path.join(plans, "deep"), { recursive: true })
      mkdirSync(path.join(test.directory, "src"), { recursive: true })
      writeFileSync(path.join(test.directory, "src", "real.ts"), "x\n")
      symlinkSync(path.join(test.directory, "src", "real.ts"), path.join(plans, "link.md"))

      const attempts = [
        yield* call(root, "plan", "write", { filePath: path.join(plans, "run.sh"), content: "x\n" }),
        yield* call(root, "plan", "write", { filePath: path.join(plans, "deep", "n.md"), content: "x\n" }),
        yield* call(root, "plan", "write", { filePath: path.join(plans, "link.md"), content: "y\n" }),
        yield* call(root, "plan", "apply_patch", {
          patchText: `*** Begin Patch\n*** Add File: .swarm/plans/ok.md\n+x\n*** Add File: src/mixed.ts\n+x\n*** End Patch`,
        }),
      ]

      expect(attempts.every((error) => error instanceof PermissionV1.DeniedError)).toBe(true)
      expect(existsSync(path.join(plans, "ok.md"))).toBe(false)
      expect(yield* Effect.promise(() => Bun.file(path.join(test.directory, "src", "real.ts")).text())).toBe("x\n")
    }),
  shipped,
)

it.instance(
  "the plan agent's plan in the data folder is written with nobody asked",
  () =>
    Effect.gen(function* () {
      const { root } = yield* lineage()
      yield* said(root.id, "plan")
      mkdirSync(dataPlans, { recursive: true })
      const plan = path.join(dataPlans, "p.md")

      expect(yield* call(root, "plan", "write", { filePath: plan, content: "# p\n" })).toBe("ran")
      expect(existsSync(plan)).toBe(true)
      expect(yield* audit(root.id)).toEqual([["A", undefined]])
    }),
  shipped,
)

it.instance(
  "ADV-A10: a subagent and its own subagent under a plan session are refused the same edit, and may not skip the gate",
  () =>
    Effect.gen(function* () {
      const { root, child, grandchild } = yield* lineage()
      const test = yield* TestInstance
      yield* said(root.id, "plan")
      const file = (name: string) => path.join(test.directory, "src", name)

      // `general` asks nothing about an ordinary edit. Under a plan root that would be the whole hole.
      const refused = [
        yield* call(child, "general", "write", { filePath: file("a.ts"), content: "x\n" }),
        yield* call(grandchild, "general", "edit", { filePath: file("b.ts"), oldString: "", newString: "x\n" }),
        yield* call(grandchild, "general", "apply_patch", { patchText: patchAdding("src/c.ts") }),
      ]

      expect(refused.every((error) => error instanceof PermissionV1.DeniedError)).toBe(true)
      expect(["a.ts", "b.ts", "c.ts"].filter((name) => existsSync(file(name)))).toEqual([])
      expect(yield* audit(root.id)).toEqual([
        ["X", "plan_mode"],
        ["X", "plan_mode"],
        ["X", "plan_mode"],
      ])
    }),
  shipped,
)

it.instance(
  "a rule that allows edits does not get a plan lineage past the gate",
  () =>
    Effect.gen(function* () {
      const { root, child } = yield* lineage()
      const test = yield* TestInstance
      yield* said(root.id, "plan")
      const target = path.join(test.directory, "src", "a.ts")

      expect(yield* call(root, "plan", "write", { filePath: target, content: "x\n" })).toBeInstanceOf(
        PermissionV1.DeniedError,
      )
      expect(yield* call(child, "general", "write", { filePath: target, content: "x\n" })).toBeInstanceOf(
        PermissionV1.DeniedError,
      )
      expect(existsSync(target)).toBe(false)
      expect(yield* audit(root.id)).toEqual([
        ["X", "plan_mode"],
        ["X", "plan_mode"],
      ])
    }),
  { git: true, config: { permission: { edit: "allow" } } },
)

it.instance(
  "neither does an earlier \"always\" from a person, though it still answers for the build agent",
  () =>
    Effect.gen(function* () {
      const permission = yield* Permission.Service
      const autonomy = yield* Autonomy.Service
      const { root } = yield* lineage(false)
      const test = yield* TestInstance
      yield* said(root.id, "build")

      const fiber = yield* call(root, "build", "write", {
        filePath: path.join(test.directory, "package.json"),
        content: "{}\n",
      }).pipe(Effect.forkScoped)
      const pending = yield* Effect.gen(function* () {
        while ((yield* permission.list()).length === 0) yield* Effect.sleep("10 millis")
        return yield* permission.list()
      }).pipe(Effect.timeout("2 seconds"))
      yield* permission.reply({ requestID: pending[0]!.id, reply: "always" })
      expect(yield* Fiber.join(fiber)).toBe("ran")

      yield* autonomy.setMode({ scope: "session", root: root.id, on: true })
      yield* said(root.id, "plan")
      const target = path.join(test.directory, "src", "a.ts")
      expect(yield* call(root, "plan", "write", { filePath: target, content: "x\n" })).toBeInstanceOf(
        PermissionV1.DeniedError,
      )
      expect(existsSync(target)).toBe(false)
    }),
  shipped,
)

it.instance(
  "AU-33: switching from plan to build keeps the mode on, and edits take the new agent's class",
  () =>
    Effect.gen(function* () {
      const autonomy = yield* Autonomy.Service
      const { root } = yield* lineage()
      const test = yield* TestInstance
      const target = path.join(test.directory, "src", "a.ts")
      const where = { root: root.id, directory: test.directory }

      yield* said(root.id, "plan")
      expect(yield* call(root, "plan", "write", { filePath: target, content: "x\n" })).toBeInstanceOf(
        PermissionV1.DeniedError,
      )
      expect(existsSync(target)).toBe(false)

      yield* said(root.id, "build")
      expect(yield* autonomy.isOn(where)).toBe(true)
      expect(yield* call(root, "build", "write", { filePath: target, content: "x\n" })).toBe("ran")
      expect(existsSync(target)).toBe(true)
      expect(yield* autonomy.isOn(where)).toBe(true)
      // The refusal is on record. An ordinary edit never leaves a line of its own.
      expect(yield* audit(root.id)).toEqual([["X", "plan_mode"]])
    }),
  shipped,
)

it.instance(
  "the switch also lifts the limits from a subagent, and a sensitive edit gets its ordinary class",
  () =>
    Effect.gen(function* () {
      const { root, child } = yield* lineage()
      const test = yield* TestInstance
      yield* said(root.id, "build")

      expect(
        yield* call(child, "general", "write", { filePath: path.join(test.directory, "src", "a.ts"), content: "x\n" }),
      ).toBe("ran")
      const held = yield* call(child, "general", "write", {
        filePath: path.join(test.directory, "package.json"),
        content: "{}\n",
      })
      expect(held).toBeInstanceOf(PermissionV1.DeferredError)
      expect(yield* audit(root.id)).toEqual([["D", "sensitive_file"]])
    }),
  shipped,
)

it.instance(
  "the plan agent is limited in a root that is not on plan, and the mode reaches it through its folder too",
  () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const autonomy = yield* Autonomy.Service
      const test = yield* TestInstance
      yield* autonomy.setMode({ scope: "directory", directory: test.directory, on: true })
      const root = yield* sessions.create({})
      yield* said(root.id, "build")
      const target = path.join(test.directory, "src", "a.ts")

      expect(yield* call(root, "plan", "write", { filePath: target, content: "x\n" })).toBeInstanceOf(
        PermissionV1.DeniedError,
      )
      expect(existsSync(target)).toBe(false)
    }),
  shipped,
)

it.instance(
  "with the mode off a plan session's ordinary edit goes the way it always did, and nothing turns the mode on",
  () =>
    Effect.gen(function* () {
      const autonomy = yield* Autonomy.Service
      const { root, child } = yield* lineage(false)
      const test = yield* TestInstance
      yield* said(root.id, "plan")
      const target = path.join(test.directory, "src", "a.ts")

      expect(yield* call(root, "plan", "write", { filePath: target, content: "x\n" })).toBe("ran")
      expect(yield* call(child, "general", "write", { filePath: `${target}x`, content: "y\n" })).toBe("ran")
      yield* said(root.id, "build")
      expect(yield* autonomy.isOn({ root: root.id, directory: test.directory })).toBe(false)
      expect(yield* audit(root.id)).toEqual([])
    }),
  shipped,
)
