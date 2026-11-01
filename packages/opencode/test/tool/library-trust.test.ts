import { afterAll, describe, expect, mock, test } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { Effect, Exit, Layer, Schema } from "effect"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { EventV2Bridge } from "@/event-v2-bridge"
import { LSP } from "@/lsp/lsp"
import { MCP } from "@/mcp"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { SessionPrompt } from "@/session/prompt"
import { Session } from "@/session/session"
import { SessionSummary } from "@/session/summary"
import { SessionTools } from "@/session/tools"
import * as RealLibraryRoot from "@/skill/library-root"
import { ToolRegistry } from "@/tool/registry"
import type { Tool } from "@/tool/tool"
import { TestConfig } from "../fixture/config"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"

const ROOT = "/synthetic/Resources/knowledge-library"
const AVAILABLE: RealLibraryRoot.Status = { kind: "available", root: ROOT }

// Only `current` changes, and with nothing set it gives this process's real answer, so a file that shares this process and
// was loaded after this one still sees the real module.
const real = { ...RealLibraryRoot }
let status: RealLibraryRoot.Status | undefined
const current = () => status ?? real.current()
mock.module(path.join(import.meta.dir, "../../src/skill/library-root.ts"), () => ({
  ...real,
  current,
  LibraryRoot: { ...real, current },
}))
afterAll(() => {
  status = undefined
})

const available = <A, E, R>(effect: Effect.Effect<A, E, R>, value: RealLibraryRoot.Status = AVAILABLE) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      status = value
    }),
    () => effect,
    () =>
      Effect.sync(() => {
        status = undefined
      }),
  )

const agentWith = (permission: Agent.Info["permission"]): Agent.Info => ({
  name: "build",
  mode: "primary",
  options: {},
  permission,
})
const anyAgent = agentWith([{ permission: "*", pattern: "*", action: "allow" }])

// A project config must never be consulted, so reading it fails the test instead of answering.
const globalOnly = (read: () => ConfigV1.Info) =>
  TestConfig.make({
    get: () => Effect.die(new Error("config.get() must not decide the library")),
    getGlobal: () => Effect.sync(read),
  })

const library = (agent: Agent.Info, global: ConfigV1.Info = {}) =>
  SessionTools.library({ agent, config: globalOnly(() => global) })

describe("SessionTools.library", () => {
  test.each([
    ["unset", {}, ROOT],
    ["true", { knowledge_library: true }, ROOT],
    ["false", { knowledge_library: false }, undefined],
  ])("the global key %s", async (_name, global, expected) => {
    expect(await Effect.runPromise(available(library(anyAgent, global)))).toBe(expected as string)
  })

  test.each<[string, Agent.Info["permission"], string | undefined]>([
    ["no skill rule", [], ROOT],
    ["skill ask", [{ permission: "skill", pattern: "*", action: "ask" }], ROOT],
    ["skill allow", [{ permission: "skill", pattern: "*", action: "allow" }], ROOT],
    ["skill deny", [{ permission: "skill", pattern: "*", action: "deny" }], undefined],
    ["a deny that names the entry", [{ permission: "skill", pattern: "knowledge-library", action: "deny" }], undefined],
    ["a deny on every permission", [{ permission: "*", pattern: "*", action: "deny" }], undefined],
    ["a deny on another skill", [{ permission: "skill", pattern: "other", action: "deny" }], ROOT],
    [
      "a later allow over a deny",
      [
        { permission: "skill", pattern: "*", action: "deny" },
        { permission: "skill", pattern: "knowledge-library", action: "allow" },
      ],
      ROOT,
    ],
  ])("%s", async (_name, permission, expected) => {
    expect(await Effect.runPromise(available(library(agentWith(permission))))).toBe(expected as string)
  })

  test.each<[string, RealLibraryRoot.Status]>([
    ["outside the app", { kind: "no-app" }],
    ["a missing folder", { kind: "failed", code: "missing" }],
    ["a symlink", { kind: "failed", code: "symlink" }],
    ["another edition", { kind: "failed", code: "edition" }],
  ])("%s gives no root and does not read the config", async (_name, value) => {
    let reads = 0
    const config = globalOnly(() => {
      reads++
      return {}
    })
    const result = await Effect.runPromise(available(SessionTools.library({ agent: anyAgent, config }), value))
    expect(result).toBeUndefined()
    expect(reads).toBe(0)
  })

  test("a global config that cannot be read fails instead of reading as on", async () => {
    const config = TestConfig.make({ getGlobal: () => Effect.die(new Error("broken config")) })
    const exit = await Effect.runPromiseExit(available(SessionTools.library({ agent: anyAgent, config })))
    expect(Exit.isFailure(exit)).toBe(true)
  })
})

const seen: Array<Tool.Context["trust"]> = []

const probe = {
  id: "probe",
  description: "records the trust a real run hands a tool",
  parameters: Schema.Struct({}),
  jsonSchema: { type: "object", properties: {} },
  execute: (_args, ctx) =>
    Effect.sync(() => {
      seen.push(ctx.trust)
      return { title: "probe", metadata: {}, output: "ok" }
    }),
} satisfies Tool.Def

const registry = Layer.succeed(
  ToolRegistry.Service,
  ToolRegistry.Service.of({
    ids: () => Effect.succeed(["probe"]),
    all: () => Effect.succeed([]),
    named: () => Effect.die("unused"),
    tools: () => Effect.succeed([probe]),
  }),
)
const noMcp = Layer.succeed(
  MCP.Service,
  MCP.Service.of({
    status: () => Effect.succeed({}),
    clients: () => Effect.succeed({}),
    instructions: () => Effect.succeed([]),
    tools: () => Effect.succeed({}),
    prompts: () => Effect.succeed({}),
    resources: () => Effect.succeed({}),
    resourceTemplates: () => Effect.succeed({}),
  } as Partial<MCP.Interface> as MCP.Interface),
)
const noLsp = Layer.succeed(
  LSP.Service,
  LSP.Service.of({
    init: () => Effect.void,
    status: () => Effect.succeed([]),
    hasClients: () => Effect.succeed(false),
    touchFile: () => Effect.void,
    diagnostics: () => Effect.succeed({}),
  } as Partial<LSP.Interface> as LSP.Interface),
)
const noSummary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      SessionPrompt.node,
      Session.node,
      SessionProjector.node,
      EventV2Bridge.node,
      Config.node,
      LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] }),
    ]),
    [
      [ToolRegistry.node, registry],
      [MCP.node, noMcp],
      [LSP.node, noLsp],
      [SessionSummary.node, noSummary],
      [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true })],
    ],
  ),
)

const projectConfig = (url: string, extra: object) => ({
  $schema: "https://opencode.ai/config.json",
  provider: {
    test: {
      name: "Test",
      id: "test",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      models: {
        "test-model": {
          id: "test-model",
          name: "Test Model",
          attachment: false,
          reasoning: false,
          temperature: false,
          tool_call: true,
          release_date: "2025-01-01",
          limit: { context: 100000, output: 10000 },
          cost: { input: 0, output: 0 },
          options: {},
        },
      },
      options: { apiKey: "test-key", baseURL: url },
    },
  },
  ...extra,
})

// The global folder is read when the config is first asked for, so it is swapped before that and restored after.
const withGlobalConfig = <A, E, R>(text: string | undefined, effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.gen(function* () {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "library-trust-"))
      if (text !== undefined) fs.writeFileSync(path.join(dir, "swarm.json"), text)
      const previous = Global.Path.config
      ;(Global.Path as { config: string }).config = dir
      yield* Config.Service.use((config) => config.invalidate())
      return { dir, previous }
    }),
    () => effect,
    ({ dir, previous }) =>
      Config.Service.use((config) => config.invalidate()).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            ;(Global.Path as { config: string }).config = previous
            fs.rmSync(dir, { recursive: true, force: true })
          }),
        ),
      ),
  )

// One turn of the real loop: the model calls the probe, and the probe reports what the tool context held.
const trustOfOneTurn = (project: object) =>
  Effect.gen(function* () {
    seen.length = 0
    const { directory } = yield* TestInstance
    const llm = yield* TestLLMServer
    fs.writeFileSync(path.join(directory, "swarm.json"), JSON.stringify(projectConfig(llm.url, project)))
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "Library trust",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") },
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })
    yield* llm.tool("probe", {})
    yield* llm.text("done")
    yield* prompt.loop({ sessionID: session.id })
    expect(seen).toHaveLength(1)
    return seen[0]
  })

describe("a real turn", () => {
  it.instance("the tool context carries the root when nothing turned it off", () =>
    available(
      withGlobalConfig(
        undefined,
        Effect.gen(function* () {
          expect((yield* trustOfOneTurn({}))?.library).toBe(ROOT)
        }),
      ),
    ),
  )

  it.instance("the global key off empties it, and a project key true does not turn it back on", () =>
    available(
      withGlobalConfig(
        JSON.stringify({ knowledge_library: false }),
        Effect.gen(function* () {
          const trust = yield* trustOfOneTurn({ knowledge_library: true })
          // The merged config really does say true, so a reader of config.get() would have turned the library on.
          expect((yield* Config.Service.use((config) => config.get())).knowledge_library).toBe(true)
          expect(trust?.library).toBeUndefined()
        }),
      ),
    ),
  )

  it.instance("a project key false does not turn it off, because the key is global only", () =>
    available(
      withGlobalConfig(
        undefined,
        Effect.gen(function* () {
          expect((yield* trustOfOneTurn({ knowledge_library: false }))?.library).toBe(ROOT)
        }),
      ),
    ),
  )

  it.instance("skill deny for the agent empties it", () =>
    available(
      withGlobalConfig(
        JSON.stringify({ permission: { skill: "deny" } }),
        Effect.gen(function* () {
          expect((yield* trustOfOneTurn({}))?.library).toBeUndefined()
        }),
      ),
    ),
  )

  it.instance("outside the app it is empty, with the rest of the trust unchanged", () =>
    available(
      withGlobalConfig(
        undefined,
        Effect.gen(function* () {
          const trust = yield* trustOfOneTurn({})
          expect(trust?.library).toBeUndefined()
          expect(trust?.canUndo).toBe(false)
        }),
      ),
      { kind: "no-app" },
    ),
  )

  test.each([
    ["broken JSON", '{"knowledge_library":'],
    ["a wrong type", '{"knowledge_library":"no"}'],
  ])("%s in the global config never reads as on", (_name, text) => {
    const run = Effect.gen(function* () {
      const config = yield* Config.Service
      return yield* SessionTools.library({ agent: anyAgent, config })
    })
    return Effect.runPromise(
      available(withGlobalConfig(text, Effect.exit(run))).pipe(
        Effect.tap((exit) => Effect.sync(() => expect(Exit.isFailure(exit)).toBe(true))),
        Effect.scoped,
        Effect.provide(LayerNode.compile(Config.node)),
      ),
    )
  })
})
