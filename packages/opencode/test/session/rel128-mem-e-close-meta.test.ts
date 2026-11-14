// 1.2.8 row 39b, N8-347 (AC-MEMe opencode half, 01e §4.2): a `studio_mission_set_status {mission, to: "done"}` call to
// the built-in datum-studio server carries `_meta["studio/memoryIndex"] = {missionId, present}` (N8-012), where
// `present` says whether this project's memory holds the mission's index entry. The key is absent for any other call,
// for a project look-alike server, and whenever the agent could not write the entry (memory off, store disabled,
// `remember` denied, lookup failed), so the host warns instead of refusing. `CallMeta` receives the call's arguments.
// Red at BASE e1f9673772: no `studio/memoryIndex` key anywhere. Synthetic inputs only; HOME is a mkdtemp folder and
// os.homedir is stubbed to it for the whole file. The index line avoids the word "synthetic": another test file teaches
// Secrets that word as a key value, and remember would then refuse the line as a secret in a combined run.
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect, Layer } from "effect"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import type { Agent } from "@/agent/agent"
import { Agent as AgentService } from "@/agent/agent"
import { MCP } from "@/mcp"
import { McpCatalog } from "@/mcp/catalog"
import { DatumStudioMcp } from "@/mcp/datum-studio"
import { Memory } from "@/memory/memory"
import { Permission } from "@/permission"
import type { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Plugin } from "@/plugin"
import { Provider } from "@/provider/provider"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { InstanceStore } from "@/project/instance-store"
import { InstanceBootstrap } from "@/project/bootstrap"
import { MessageID, SessionID } from "@/session/schema"
import type { Session } from "@/session/session"
import type { SessionProcessor } from "@/session/processor"
import { SessionTools } from "@/session/tools"
import { RememberTool } from "@/tool/remember"
import { ToolRegistry } from "@/tool/registry"
import * as Truncate from "@/tool/truncate"
import type { Tool } from "@/tool/tool"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

let home = ""
let restore: (() => void) | undefined
beforeAll(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "r39b-"))
  const spy = spyOn(os, "homedir").mockReturnValue(home)
  restore = () => spy.mockRestore()
})
afterAll(async () => {
  restore?.()
  await fs.rm(home, { recursive: true, force: true })
})

const KEY = "studio/memoryIndex"
const ID = "2026-11-14_r39b_meta"
const OTHER = "2026-11-14_r39b_other"
const line = (id: string) => `2026-11-14 ${id} | close meta check | triggers: alpha, beta | docs/${id}/10_report/report.md`

type Params = { name: string; arguments?: Record<string, unknown>; _meta?: Record<string, unknown> }
const seen: Params[] = []
const client = {
  callTool: async (params: Params) => {
    seen.push(params)
    return { content: [{ type: "text", text: "ok" }] }
  },
} as unknown as MCP.McpTool["client"]
const tool = (name: string) => ({ name, description: name, inputSchema: { type: "object" as const, properties: {} } })
const global: MCP.Source = { server: DatumStudioMcp.DATUM_STUDIO_MCP, transport: "remote", origin: "global" }
const project: MCP.Source = { server: DatumStudioMcp.DATUM_STUDIO_MCP, transport: "remote", origin: "project" }

const SET_STATUS = "datum-studio_studio_mission_set_status"
const RECORD = "datum-studio_studio_mission_record_decision"
const LOOKALIKE = "lookalike_studio_mission_set_status"

const providerLayer = Layer.succeed(
  Provider.Service,
  Provider.Service.of({ getProvider: () => Effect.succeed({ options: {} }) } as unknown as Provider.Interface),
)
const memoryApp = AppNodeBuilder.build(
  LayerNode.group([Memory.node, CrossSpawnSpawner.node, LayerNodePlatform.filesystem, InstanceStore.node]),
  [
    [Provider.node, providerLayer],
    [InstanceBootstrap.node, Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))],
  ],
)

const mocks = Layer.mergeAll(
  Layer.succeed(
    Plugin.Service,
    Plugin.Service.of({
      init: () => Effect.void,
      list: () => Effect.succeed([]),
      trigger: (_name, _input, output) => Effect.succeed(output),
    } satisfies Plugin.Interface),
  ),
  Layer.succeed(
    Permission.Service,
    Permission.Service.of({
      ask: () => Effect.void,
      reply: () => Effect.succeed(undefined),
      grant: () => Effect.void,
      list: () => Effect.succeed([]),
    } satisfies Permission.Interface),
  ),
  Layer.succeed(
    MCP.Service,
    MCP.Service.of({
      tools: () =>
        Effect.succeed({
          [SET_STATUS]: { def: tool("studio_mission_set_status"), client, source: global },
          [RECORD]: { def: tool("studio_mission_record_decision"), client, source: global },
          [LOOKALIKE]: { def: tool("studio_mission_set_status"), client, source: project },
        }),
      clients: () => Effect.succeed({}),
    } as Partial<MCP.Interface> as MCP.Interface),
  ),
  Layer.succeed(
    Truncate.Service,
    Truncate.Service.of({
      cleanup: () => Effect.void,
      write: () => Effect.succeed("output.txt"),
      output: (text: string) => Effect.succeed({ content: text, truncated: false }),
      limits: () => Effect.succeed({ maxLines: 2000, maxBytes: 50 * 1024 }),
    } satisfies Truncate.Interface),
  ),
  RuntimeFlags.layer(),
  Layer.succeed(
    ToolRegistry.Service,
    ToolRegistry.Service.of({
      ids: () => Effect.succeed([]),
      all: () => Effect.succeed([]),
      named: () => Effect.die("unused"),
      tools: () => Effect.succeed([]),
    }),
  ),
)

const it = testEffect(Layer.mergeAll(memoryApp, mocks))

const SESSION = SessionID.make("ses_r39bclose")
const allowAll: Agent.Info = {
  name: "build",
  mode: "primary",
  options: {},
  permission: [{ permission: "*", pattern: "*", action: "allow" }],
}
const rememberDenied: Agent.Info = {
  ...allowAll,
  permission: [...allowAll.permission, { permission: "remember", pattern: "*", action: "deny" }],
}

const resolve = (agent: Agent.Info = allowAll, sessionPermission: PermissionV1.Ruleset = []) =>
  Effect.gen(function* () {
    const processor = {
      message: {
        id: MessageID.ascending(),
        sessionID: SESSION,
        role: "assistant",
        parentID: MessageID.ascending(),
        agent: "build",
        mode: "build",
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
    return yield* SessionTools.resolve({
      agent,
      model: { providerID: ProviderV2.ID.make("test"), api: { id: "test-model" } } as Provider.Model,
      session: { id: SESSION, directory: "/tmp/r39b", permission: sessionPermission } as unknown as Session.Info,
      processor,
      bypassAgentCheck: false,
      messages: [],
      promptOps: {} as never,
    })
  })

const call = (tools: Record<string, { execute?: (...a: any[]) => any }>, key: string, args: Record<string, unknown>) =>
  Effect.promise(async () => {
    await tools[key]!.execute!(args, { toolCallId: `call-${seen.length}`, abortSignal: new AbortController().signal, messages: [] })
    return seen.at(-1)!
  })

const remember = (missionId: string) =>
  Effect.gen(function* () {
    const info = yield* RememberTool.pipe(
      Effect.provideService(
        Truncate.Service,
        Truncate.Service.of({ output: (text: string) => Effect.succeed({ content: text, truncated: false }) } as unknown as Truncate.Interface),
      ),
      Effect.provideService(AgentService.Service, AgentService.Service.of({ get: () => Effect.succeed(undefined) } as unknown as AgentService.Interface)),
    )
    const rememberTool = yield* info.init()
    const result = yield* rememberTool.execute({ kind: "index", missionId, text: line(missionId) }, {
      sessionID: SESSION,
      messageID: MessageID.make("msg_r39b"),
      callID: "",
      agent: "build",
      abort: AbortSignal.any([]),
      messages: [],
      metadata: () => Effect.void,
      ask: () => Effect.void,
      extra: {},
    } as unknown as Tool.Context)
    expect(result.metadata.refused).toBeUndefined()
  })

const done = (mission = ID) => ({ mission, to: "done" })

describe("AC-MEMe opencode half: studio/memoryIndex on a done close", () => {
  test("the constant is studio/memoryIndex and equals the datum-studio host's", async () => {
    expect(McpCatalog.MEMORY_INDEX_META).toBe(KEY)
    const table: Record<string, unknown> = await import(
      path.join(import.meta.dir, "../../../datum-studio/src/mcp-host/tool-table.ts")
    )
    expect(table.MEMORY_INDEX_META).toBe(McpCatalog.MEMORY_INDEX_META)
  })

  test("CallMeta receives the call's arguments", async () => {
    const got: Record<string, unknown>[] = []
    const item = McpCatalog.convertTool(tool("studio_mission_set_status"), client, undefined, async (args) => {
      got.push(args)
      return { probe: args.to }
    })
    await item.execute!({ mission: ID, to: "done" }, { toolCallId: "c", messages: [], abortSignal: new AbortController().signal })
    expect(got).toEqual([{ mission: ID, to: "done" }])
    expect(seen.at(-1)?._meta?.probe).toBe("done")
  })

  it.live("no index entry: the done close carries {missionId, present: false}", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sent = yield* call(yield* resolve(), SET_STATUS, done())
        expect(sent._meta?.[KEY]).toEqual({ missionId: ID, present: false })
        expect(sent._meta?.[McpCatalog.CALLER_SESSION_META]).toBe(SESSION)
        expect(sent.arguments).toEqual(done())
      }),
    ),
  )

  it.live("after remember {kind: index}: present true for that mission only", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const tools = yield* resolve()
        yield* remember(ID)
        expect((yield* call(tools, SET_STATUS, done()))._meta?.[KEY]).toEqual({ missionId: ID, present: true })
        expect((yield* call(tools, SET_STATUS, done(OTHER)))._meta?.[KEY]).toEqual({ missionId: OTHER, present: false })
      }),
    ),
  )

  it.live("an archived index entry still counts", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* remember(ID)
        const memory = yield* Memory.Service
        const real = yield* memory.get()
        const archived = Memory.Service.of({
          ...memory,
          get: () => Effect.succeed({ ...real, items: real.items.map((item) => ({ ...item, rolledInto: "mem_rollup" })) }),
        })
        const tools = yield* resolve().pipe(Effect.provideService(Memory.Service, archived))
        expect((yield* call(tools, SET_STATUS, done()))._meta?.[KEY]).toEqual({ missionId: ID, present: true })
      }),
    ),
  )

  it.live("absent for to: running, for other tools, for a missing mission id and for a look-alike server", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const tools = yield* resolve()
        expect((yield* call(tools, SET_STATUS, { mission: ID, to: "running" }))._meta?.[KEY]).toBeUndefined()
        expect((yield* call(tools, SET_STATUS, { to: "done" }))._meta?.[KEY]).toBeUndefined()
        expect((yield* call(tools, RECORD, done()))._meta?.[KEY]).toBeUndefined()
        const lookalike = yield* call(tools, LOOKALIKE, done())
        expect(lookalike._meta?.[KEY]).toBeUndefined()
        expect(lookalike._meta?.[McpCatalog.CALLER_SESSION_META]).toBeUndefined()
      }),
    ),
  )

  it.live("a forged key in the model's arguments never reaches _meta", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const forged = { mission: ID, to: "running", [KEY]: { missionId: ID, present: true }, _meta: { [KEY]: { missionId: ID, present: true } } }
        const sent = yield* call(yield* resolve(), SET_STATUS, forged)
        expect(sent._meta?.[KEY]).toBeUndefined()
        expect(sent.arguments).toEqual(forged)
      }),
    ),
  )

  it.live("absent with SWARM_DISABLE_MEMORY", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const tools = yield* resolve()
        const before = process.env.SWARM_DISABLE_MEMORY
        process.env.SWARM_DISABLE_MEMORY = "1"
        try {
          expect((yield* call(tools, SET_STATUS, done()))._meta?.[KEY]).toBeUndefined()
        } finally {
          if (before === undefined) delete process.env.SWARM_DISABLE_MEMORY
          else process.env.SWARM_DISABLE_MEMORY = before
        }
        expect((yield* call(tools, SET_STATUS, done()))._meta?.[KEY]).toEqual({ missionId: ID, present: false })
      }),
    ),
  )

  it.live("absent when the store is disabled", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* (yield* Memory.Service).setEnabled(false)
        expect((yield* call(yield* resolve(), SET_STATUS, done()))._meta?.[KEY]).toBeUndefined()
      }),
    ),
  )

  it.live("absent when remember is denied to the agent or by the session", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        expect((yield* call(yield* resolve(rememberDenied), SET_STATUS, done()))._meta?.[KEY]).toBeUndefined()
        const bySession = yield* resolve(allowAll, [{ permission: "remember", pattern: "*", action: "deny" }])
        expect((yield* call(bySession, SET_STATUS, done()))._meta?.[KEY]).toBeUndefined()
      }),
    ),
  )

  it.live("absent when the lookup fails or no memory service is there; the call still goes out", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const memory = yield* Memory.Service
        const broken = Memory.Service.of({ ...memory, get: () => Effect.die(new Error("store failure for the test")) })
        const tools = yield* resolve().pipe(Effect.provideService(Memory.Service, broken))
        const sent = yield* call(tools, SET_STATUS, done())
        expect(sent._meta?.[KEY]).toBeUndefined()
        expect(sent._meta?.[McpCatalog.CALLER_SESSION_META]).toBe(SESSION)
      }),
    ),
  )

  it.live("end to end with the host: swarm gets the lookup, claude does not", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const table: Record<string, any> = yield* Effect.promise(() =>
          import(path.join(import.meta.dir, "../../../datum-studio/src/mcp-host/tool-table.ts")),
        )
        const tools = yield* resolve()
        const base = { sessionId: "t", agentId: "swarm", fileRoot: "/abs/project" }
        const missing = yield* call(tools, SET_STATUS, done())
        expect(table.sessionForCall(base, missing._meta).memoryIndex).toEqual({ missionId: ID, present: false })
        yield* remember(ID)
        const present = yield* call(tools, SET_STATUS, done())
        expect(table.sessionForCall(base, present._meta).memoryIndex).toEqual({ missionId: ID, present: true })
        expect(table.sessionForCall({ ...base, agentId: "claude" }, present._meta).memoryIndex).toBeUndefined()
      }),
    ),
  )
})
