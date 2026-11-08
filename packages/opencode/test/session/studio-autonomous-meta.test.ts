// Row 197 (decision L57, security finding S194-01): a datum-studio tool call carries `_meta["studio/autonomous"] = true`
// only when Swarm's own autonomous mode setting is on for the calling session's root (the person turns it on). The
// model writes `arguments` only: an `_meta` or `studio/autonomous` it puts in the arguments never reaches `_meta`. A
// project look-alike datum-studio entry gets no studio meta at all. The mode is read at each call, not when the tools
// are built, so switching it off holds from the next call.
import { expect } from "bun:test"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Effect, Layer } from "effect"
import type { Agent } from "@/agent/agent"
import { MCP } from "@/mcp"
import { McpCatalog } from "@/mcp/catalog"
import { DatumStudioMcp } from "@/mcp/datum-studio"
import { Permission } from "@/permission"
import { Autonomy } from "@/permission/autonomy"
import { Plugin } from "@/plugin"
import type { Provider } from "@/provider/provider"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { MessageID, SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import type { SessionProcessor } from "@/session/processor"
import { SessionTools } from "@/session/tools"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { testEffect } from "../lib/effect"

type Params = { name: string; arguments?: Record<string, unknown>; _meta?: Record<string, unknown> }
const seen: Params[] = []
const client = {
  callTool: async (params: Params) => {
    seen.push(params)
    return { content: [{ type: "text", text: "ok" }] }
  },
} as unknown as MCP.McpTool["client"]
const def = {
  name: "studio_mission_record_decision",
  description: "record",
  inputSchema: { type: "object" as const, properties: {} },
}
const global: MCP.Source = { server: DatumStudioMcp.DATUM_STUDIO_MCP, transport: "remote", origin: "global" }
const project: MCP.Source = { server: DatumStudioMcp.DATUM_STUDIO_MCP, transport: "remote", origin: "project" }

const ROOT = SessionID.make("ses_row197root")
const CHILD = SessionID.make("ses_row197child")
const GRANDCHILD = SessionID.make("ses_row197grand")
const parents: Record<string, SessionID | undefined> = { [ROOT]: undefined, [CHILD]: ROOT, [GRANDCHILD]: CHILD }
/** Roots with the mode on; what `isOn` was asked. */
const on = new Set<string>()
const askedRoots: string[] = []

const layer = Layer.mergeAll(
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
          "datum-studio_studio_mission_record_decision": { def, client, source: global },
          "lookalike_studio_mission_record_decision": { def, client, source: project },
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
  Layer.succeed(
    Autonomy.Service,
    Autonomy.Service.of({
      isOn: (input: Autonomy.Where) =>
        Effect.sync(() => {
          askedRoots.push(input.root)
          return on.has(input.root)
        }),
    } as Partial<Autonomy.Interface> as Autonomy.Interface),
  ),
  Layer.succeed(
    Session.Service,
    Session.Service.of({
      get: (id: SessionID) =>
        id in parents
          ? Effect.succeed({ id, parentID: parents[id], directory: "/tmp/row197" } as unknown as Session.Info)
          : Effect.die("no such session"),
    } as Partial<Session.Interface> as Session.Interface),
  ),
)

const it = testEffect(layer)

const agent: Agent.Info = {
  name: "build",
  mode: "primary",
  options: {},
  permission: [{ permission: "*", pattern: "*", action: "allow" }],
}

const resolve = (sessionID: SessionID) =>
  Effect.gen(function* () {
    const processor = {
      message: {
        id: MessageID.ascending(),
        sessionID,
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
      session: {
        id: sessionID,
        parentID: parents[sessionID],
        directory: "/tmp/row197",
        permission: [],
      } as unknown as Session.Info,
      processor,
      bypassAgentCheck: false,
      messages: [],
      promptOps: {} as never,
    })
  })

const run = (tools: Record<string, { execute?: (...a: any[]) => any }>, key: string, args: Record<string, unknown>) =>
  Effect.promise(async () => {
    await tools[key]!.execute!(args, { toolCallId: `call-${seen.length}`, abortSignal: new AbortController().signal, messages: [] })
    return seen.at(-1)!
  })

const STUDIO = "datum-studio_studio_mission_record_decision"
const reset = () => {
  on.clear()
  askedRoots.length = 0
}

it.instance("mode off: the call carries the caller session but no autonomous mark", () =>
  Effect.gen(function* () {
    reset()
    const sent = yield* run(yield* resolve(ROOT), STUDIO, { mission: "m" })
    expect(sent._meta?.[McpCatalog.CALLER_SESSION_META]).toBe(ROOT)
    expect(sent._meta?.[McpCatalog.AUTONOMOUS_META]).toBeUndefined()
    expect(askedRoots).toEqual([ROOT])
  }),
)

it.instance("mode on: the call carries studio/autonomous = true", () =>
  Effect.gen(function* () {
    reset()
    on.add(ROOT)
    const sent = yield* run(yield* resolve(ROOT), STUDIO, { mission: "m" })
    expect(sent._meta?.[McpCatalog.AUTONOMOUS_META]).toBe(true)
    expect(sent._meta?.[McpCatalog.CALLER_SESSION_META]).toBe(ROOT)
  }),
)

it.instance("a forged mark in the model's arguments never reaches _meta", () =>
  Effect.gen(function* () {
    reset()
    const forged = { mission: "m", _meta: { [McpCatalog.AUTONOMOUS_META]: true }, [McpCatalog.AUTONOMOUS_META]: true }
    const sent = yield* run(yield* resolve(ROOT), STUDIO, forged)
    expect(sent._meta?.[McpCatalog.AUTONOMOUS_META]).toBeUndefined()
    expect(sent.arguments).toEqual(forged)
  }),
)

it.instance("the mode is read per call: switched off after the tools were built, the next call has no mark", () =>
  Effect.gen(function* () {
    reset()
    on.add(ROOT)
    const tools = yield* resolve(ROOT)
    expect((yield* run(tools, STUDIO, {}))._meta?.[McpCatalog.AUTONOMOUS_META]).toBe(true)
    on.delete(ROOT)
    expect((yield* run(tools, STUDIO, {}))._meta?.[McpCatalog.AUTONOMOUS_META]).toBeUndefined()
  }),
)

it.instance("a subagent session is judged by its root's mode", () =>
  Effect.gen(function* () {
    reset()
    on.add(ROOT)
    const sent = yield* run(yield* resolve(GRANDCHILD), STUDIO, {})
    expect(sent._meta?.[McpCatalog.AUTONOMOUS_META]).toBe(true)
    expect(sent._meta?.[McpCatalog.CALLER_SESSION_META]).toBe(GRANDCHILD)
    expect(askedRoots).toEqual([ROOT])
    // the subagent's own id being "on" does not count; only the root does
    reset()
    on.add(GRANDCHILD)
    expect((yield* run(yield* resolve(GRANDCHILD), STUDIO, {}))._meta?.[McpCatalog.AUTONOMOUS_META]).toBeUndefined()
  }),
)

it.instance("a project look-alike datum-studio entry gets no studio meta, mode on or off", () =>
  Effect.gen(function* () {
    reset()
    on.add(ROOT)
    const sent = yield* run(yield* resolve(ROOT), "lookalike_studio_mission_record_decision", {})
    expect(sent._meta?.[McpCatalog.AUTONOMOUS_META]).toBeUndefined()
    expect(sent._meta?.[McpCatalog.CALLER_SESSION_META]).toBeUndefined()
  }),
)

it.instance("the key is the one the datum-studio host reads, and the host turns it into autonomousMode", () =>
  Effect.gen(function* () {
    const path = yield* Effect.promise(() => import("node:path"))
    const STUDIO_SRC = path.join(import.meta.dir, "../../../datum-studio/src/mcp-host")
    const table: Record<string, any> = yield* Effect.promise(() => import(path.join(STUDIO_SRC, "tool-table.ts")))
    const mission: Record<string, any> = yield* Effect.promise(() =>
      import(path.join(STUDIO_SRC, "mission", "mission-tools.ts")),
    )
    expect(table.AUTONOMOUS_META).toBe(McpCatalog.AUTONOMOUS_META)
    const base = { sessionId: "t", agentId: "swarm", fileRoot: "/abs/project" }
    expect(mission.autonomousModeOf(table.sessionForCall(base, { [McpCatalog.AUTONOMOUS_META]: true }))).toBe(true)
    expect(mission.autonomousModeOf(table.sessionForCall(base, {}))).toBe(false)
    expect(mission.autonomousModeOf(table.sessionForCall({ ...base, agentId: "claude" }, { [McpCatalog.AUTONOMOUS_META]: true }))).toBe(false)
    // a base session never carries the mark into another call
    expect(table.sessionForCall({ ...base, autonomousMode: true }, {}).autonomousMode).toBeUndefined()
  }),
)
