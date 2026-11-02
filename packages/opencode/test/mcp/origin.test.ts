import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { expect } from "bun:test"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Global } from "@opencode-ai/core/global"
import { Effect, Layer } from "effect"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { MCP } from "@/mcp"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import { Provider } from "@/provider/provider"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { MessageID, SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { SessionProcessor } from "@/session/processor"
import { SessionTools } from "@/session/tools"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { testEffect } from "../lib/effect"

// Row 105 (U11 rule 5): an MCP permission request names its server, transport and config origin.

const stdio = path.join(import.meta.dir, "../fixture/mcp-lifecycle-stdio.ts")
const local = (...extra: string[]) => ({ type: "local" as const, command: [process.execPath, stdio, ...extra] })

const itMcp = testEffect(LayerNode.compile(LayerNode.group([MCP.node, Config.node])))

/** The user's global config, pointed at a scratch folder for the length of `self`. */
const withGlobalConfig = <A, E, R>(mcp: Record<string, unknown>, self: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const config = yield* Config.Service
    const dir = yield* Effect.acquireRelease(
      Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "row105-global-"))),
      (dir) => Effect.promise(() => fs.rm(dir, { recursive: true, force: true })),
    )
    yield* Effect.promise(() => Bun.write(path.join(dir, "swarm.json"), JSON.stringify({ mcp })))
    return yield* Effect.acquireUseRelease(
      Effect.gen(function* () {
        const previous = Global.Path.config
        ;(Global.Path as { config: string }).config = dir
        yield* config.invalidate()
        return previous
      }),
      () => self,
      (previous) =>
        Effect.gen(function* () {
          ;(Global.Path as { config: string }).config = previous
          yield* config.invalidate()
        }),
    )
  })

const sourceOf = (server: string) =>
  Effect.gen(function* () {
    const mcp = yield* MCP.Service
    const tool = (yield* mcp.tools())[`${server}_current_directory`]
    expect(tool).toBeDefined()
    return tool!.source
  })

itMcp.instance("a server only in the global config is global and local", () =>
  withGlobalConfig(
    { shared: local() },
    Effect.gen(function* () {
      expect(yield* sourceOf("shared")).toEqual({ server: "shared", transport: "local", origin: "global" })
    }),
  ),
)

itMcp.instance(
  "a server only in the project config is project",
  () =>
    withGlobalConfig(
      {},
      Effect.gen(function* () {
        expect(yield* sourceOf("repo")).toEqual({ server: "repo", transport: "local", origin: "project" })
      }),
    ),
  { config: { mcp: { repo: local() } } },
)

itMcp.instance(
  "a project entry that changes a global server makes it project",
  () =>
    withGlobalConfig(
      { shared: local() },
      Effect.gen(function* () {
        expect(yield* sourceOf("shared")).toEqual({ server: "shared", transport: "local", origin: "project" })
      }),
    ),
  { config: { mcp: { shared: local("--project-arg") } } },
)

itMcp.instance("a server added at runtime is project, even under a global name", () =>
  withGlobalConfig(
    { shared: local() },
    Effect.gen(function* () {
      const mcp = yield* MCP.Service
      yield* mcp.add("shared", local())
      expect(yield* sourceOf("shared")).toEqual({ server: "shared", transport: "local", origin: "project" })
    }),
  ),
)

/** A streamable-HTTP MCP server with one `current_directory` tool, so remote names match the stdio fixture. */
const httpServer = Effect.acquireRelease(
  Effect.promise(async () => {
    const protocol = new Server({ name: "row105-remote", version: "1.0.0" }, { capabilities: { tools: {} } })
    protocol.setRequestHandler(ListToolsRequestSchema, () =>
      Promise.resolve({
        tools: [{ name: "current_directory", description: "remote", inputSchema: { type: "object", properties: {} } }],
      }),
    )
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      enableJsonResponse: true,
    })
    await protocol.connect(transport)
    const http = Bun.serve({ port: 0, fetch: (request) => transport.handleRequest(request) })
    return { url: http.url.toString(), close: () => protocol.close().finally(() => http.stop(true)) }
  }),
  (server) => Effect.promise(server.close),
)

itMcp.instance("a remote server in the global config is global and remote", () =>
  Effect.gen(function* () {
    const server = yield* httpServer
    yield* withGlobalConfig(
      { far: { type: "remote", url: server.url, oauth: false } },
      Effect.gen(function* () {
        expect(yield* sourceOf("far")).toEqual({ server: "far", transport: "remote", origin: "global" })
      }),
    )
  }),
)

// The ask itself: what reaches Permission.ask for an MCP tool call.

const asked: Parameters<Permission.Interface["ask"]>[0][] = []
const def = { name: "probe", description: "probe", inputSchema: { type: "object" as const, properties: {} } }
const client = {
  callTool: async () => ({ content: [{ type: "text", text: "ok" }] }),
} as unknown as MCP.McpTool["client"]
const remoteSource: MCP.Source = { server: "far", transport: "remote", origin: "global" }

const sessionLayer = Layer.mergeAll(
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
      ask: (input) => Effect.sync(() => void asked.push(input)),
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
          far_probe: { def, client, source: remoteSource },
          bare_probe: { def, client },
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

const itSession = testEffect(sessionLayer)

const agent: Agent.Info = {
  name: "build",
  mode: "primary",
  options: {},
  permission: [{ permission: "*", pattern: "*", action: "allow" }],
}

const call = (key: string, args: Record<string, unknown>) =>
  Effect.gen(function* () {
    const sessionID = SessionID.make("ses_row105")
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
    const tools = yield* SessionTools.resolve({
      agent,
      model: { providerID: ProviderV2.ID.make("test"), api: { id: "test-model" } } as Provider.Model,
      session: { id: sessionID, permission: [] } as unknown as Session.Info,
      processor,
      bypassAgentCheck: false,
      messages: [],
      promptOps: {} as never,
    })
    const execute = tools[key]?.execute
    if (!execute) throw new Error(`${key} is missing execute`)
    yield* Effect.promise(() =>
      execute(args, { toolCallId: `call-${key}`, abortSignal: new AbortController().signal, messages: [] }),
    )
    return asked.at(-1)!
  })

itSession.instance("the ask carries server, transport and origin, and still binds the call", () =>
  Effect.gen(function* () {
    const request = yield* call("far_probe", { q: 1 })
    expect(request.permission).toBe("far_probe")
    expect(request.metadata).toEqual({ mcp: remoteSource })
    // Row 90: the grant binds to the exact call, not to metadata.
    expect(request.call).toEqual({ tool: "far_probe", args: { q: 1 } })
  }),
)

itSession.instance("a tool without a known source is reported as project", () =>
  Effect.gen(function* () {
    const request = yield* call("bare_probe", {})
    expect(request.metadata).toEqual({ mcp: { origin: "project" } })
    expect(request.call).toEqual({ tool: "bare_probe", args: {} })
  }),
)
