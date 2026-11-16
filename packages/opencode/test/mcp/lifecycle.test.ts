import path from "node:path"
import { pathToFileURL } from "node:url"
import { expect } from "bun:test"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import {
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  type ServerCapabilities,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Cause, Effect, Exit, Fiber } from "effect"
import type { MCP as MCPNS } from "../../src/mcp/index"
import { MCP } from "../../src/mcp/index"
import { McpOAuthCallback } from "../../src/mcp/oauth-callback"
import { disposeAllInstancesEffect, TestInstance } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { withCapturedLog, type CapturedLog } from "../lib/log-capture"

const it = testEffect(LayerNode.compile(MCP.node))
const stdioFixture = path.join(import.meta.dir, "../fixture/mcp-lifecycle-stdio.ts")

type Page<T> = { items: T[]; nextCursor?: string }

interface LifecycleServerState {
  tools: Tool[]
  prompts: Array<{ name: string; description?: string }>
  resources: Array<{ name: string; uri: string; description?: string }>
  resourceTemplates: Array<{ name: string; uriTemplate: string; description?: string }>
  toolPages?: Record<string, Page<Tool>>
  promptPages?: Record<string, Page<{ name: string; description?: string }>>
  resourcePages?: Record<string, Page<{ name: string; uri: string; description?: string }>>
  resourceTemplatePages?: Record<string, Page<{ name: string; uriTemplate: string; description?: string }>>
  listToolsError?: string
  requestDelay?: number
  roots?: Array<{ uri: string; name?: string }>
  requests: string[]
  aborted: number
}

function lifecycleServer(input?: { capabilities?: ServerCapabilities; instructions?: string; requestRoots?: boolean }) {
  const capabilities = input?.capabilities ?? { tools: {}, prompts: {}, resources: {} }
  return Effect.acquireRelease(
    Effect.promise(async () => {
      const state: LifecycleServerState = {
        tools: [{ name: "test_tool", description: "A test tool", inputSchema: { type: "object", properties: {} } }],
        prompts: [],
        resources: [],
        resourceTemplates: [],
        requests: [],
        aborted: 0,
      }

      const makeProtocol = async () => {
        const protocol = new Server(
          { name: "mcp-lifecycle", version: "1.0.0" },
          { capabilities, instructions: input?.instructions },
        )
        const transport = new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: () => crypto.randomUUID(),
          enableJsonResponse: true,
        })

        if (capabilities.tools) {
          protocol.setRequestHandler(ListToolsRequestSchema, (request) => {
            if (state.listToolsError) throw new Error(state.listToolsError)
            const page = state.toolPages?.[request.params?.cursor ?? "initial"]
            return Promise.resolve({ tools: page?.items ?? state.tools, nextCursor: page?.nextCursor })
          })
        }
        if (capabilities.prompts) {
          protocol.setRequestHandler(ListPromptsRequestSchema, (request) => {
            const page = state.promptPages?.[request.params?.cursor ?? "initial"]
            return Promise.resolve({ prompts: page?.items ?? state.prompts, nextCursor: page?.nextCursor })
          })
          protocol.setRequestHandler(GetPromptRequestSchema, async () => {
            if (state.requestDelay) await Bun.sleep(state.requestDelay)
            return { messages: [{ role: "user", content: { type: "text", text: "prompt result" } }] }
          })
        }
        if (capabilities.resources) {
          protocol.setRequestHandler(ListResourcesRequestSchema, (request) => {
            const page = state.resourcePages?.[request.params?.cursor ?? "initial"]
            return Promise.resolve({ resources: page?.items ?? state.resources, nextCursor: page?.nextCursor })
          })
          protocol.setRequestHandler(ListResourceTemplatesRequestSchema, (request) => {
            const page = state.resourceTemplatePages?.[request.params?.cursor ?? "initial"]
            return Promise.resolve({
              resourceTemplates: page?.items ?? state.resourceTemplates,
              nextCursor: page?.nextCursor,
            })
          })
          protocol.setRequestHandler(ReadResourceRequestSchema, async (request) => {
            if (state.requestDelay) await Bun.sleep(state.requestDelay)
            return { contents: [{ uri: request.params.uri, text: "resource result" }] }
          })
        }

        protocol.oninitialized = () => {
          if (!input?.requestRoots) return
          if (!protocol.getClientCapabilities()?.roots) return
          void Bun.sleep(25)
            .then(() => protocol.listRoots())
            .then((result) => {
              state.roots = result.roots
            })
            .catch(() => {})
        }
        await protocol.connect(transport)
        return { protocol, transport }
      }

      let current = await makeProtocol()
      const http = Bun.serve({
        port: 0,
        fetch(request) {
          state.requests.push(request.method)
          request.signal.addEventListener("abort", () => state.aborted++)
          return current.transport.handleRequest(request)
        },
      })

      return {
        state,
        url: http.url.toString(),
        sendToolListChanged: () => current.protocol.sendToolListChanged(),
        restart: async () => {
          current = await makeProtocol()
        },
        close: async () => {
          await current.protocol.close().catch(() => {})
          http.stop(true)
        },
      }
    }),
    (server) => Effect.promise(server.close),
  )
}

function hangingLifecycleServer() {
  return Effect.acquireRelease(
    Effect.promise(async () => {
      const protocol = new Server({ name: "mcp-lifecycle-hanging", version: "1.0.0" }, { capabilities: { tools: {} } })
      protocol.setRequestHandler(ListToolsRequestSchema, () => Promise.resolve({ tools: [] }))
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        enableJsonResponse: true,
      })
      await protocol.connect(transport)
      const requests: string[] = []
      let aborted = 0
      const http = Bun.serve({
        port: 0,
        fetch(request) {
          requests.push(request.method)
          request.signal.addEventListener("abort", () => aborted++)
          return new Promise<Response>(() => {})
        },
      })
      return {
        requests,
        aborted: () => aborted,
        url: http.url.toString(),
        close: async () => {
          await protocol.close().catch(() => {})
          http.stop(true)
        },
      }
    }),
    (server) => Effect.promise(server.close),
  )
}

function statusName(status: Record<string, MCPNS.Status> | MCPNS.Status, server: string) {
  if ("status" in status) return status.status
  return status[server]?.status
}

const remote = (url: string, timeout?: number) => ({ type: "remote" as const, url, oauth: false as const, timeout })

it.instance("advertises and lists the instance directory as its root", () =>
  Effect.gen(function* () {
    const server = yield* lifecycleServer({ requestRoots: true })
    const mcp = yield* MCP.Service
    const test = yield* TestInstance
    yield* mcp.add("roots", remote(server.url))

    const roots = yield* pollWithTimeout(
      Effect.sync(() => server.state.roots),
      "server did not receive roots",
    )
    expect(roots).toEqual([{ uri: pathToFileURL(test.directory).href }])
  }),
)

it.instance(
  "local mcp cwd resolves relative paths against instance directory",
  () =>
    Effect.gen(function* () {
      const mcp = yield* MCP.Service
      const test = yield* TestInstance
      yield* mcp.add("rel-cwd", {
        type: "local",
        command: [process.execPath, stdioFixture],
        cwd: "plugins/sub",
      })

      expect((yield* mcp.tools())["rel-cwd_current_directory"]?.def.description).toBe(
        path.resolve(test.directory, "plugins/sub"),
      )
    }),
  { init: (directory) => Effect.promise(() => Bun.$`mkdir -p ${path.join(directory, "plugins/sub")}`.quiet()) },
)

it.instance("tools() reuses cached definitions until a protocol notification", () =>
  Effect.gen(function* () {
    const server = yield* lifecycleServer({ capabilities: { tools: { listChanged: true } } })
    const mcp = yield* MCP.Service
    yield* mcp.add("cache-server", remote(server.url))
    server.state.tools = [{ name: "next_tool", inputSchema: { type: "object", properties: {} } }]

    expect(Object.keys(yield* mcp.tools())).toEqual(["cache-server_test_tool"])
    yield* Effect.promise(server.sendToolListChanged)
    yield* pollWithTimeout(
      Effect.gen(function* () {
        const keys = Object.keys(yield* mcp.tools())
        return keys.includes("cache-server_next_tool") ? keys : undefined
      }),
      "tool cache did not refresh",
    )
    expect(Object.keys(yield* mcp.tools())).toEqual(["cache-server_next_tool"])
  }),
)

it.instance("instructions() returns non-empty connected server instructions with tool names", () =>
  Effect.gen(function* () {
    const guide = yield* lifecycleServer({ instructions: "Use lookup before mutate." })
    const blank = yield* lifecycleServer({ instructions: "   " })
    const mcp = yield* MCP.Service
    yield* mcp.add("guide-server", remote(guide.url))
    yield* mcp.add("blank-server", remote(blank.url))

    expect(yield* mcp.instructions()).toEqual([
      { name: "guide-server", instructions: "Use lookup before mutate.", tools: ["guide-server_test_tool"] },
    ])
    yield* mcp.disconnect("guide-server")
    expect(yield* mcp.instructions()).toEqual([])
  }),
)

it.instance("follows cursors when listing tools, prompts, resources, and templates", () =>
  Effect.gen(function* () {
    const server = yield* lifecycleServer()
    server.state.toolPages = {
      initial: { items: [{ name: "tool-one", inputSchema: { type: "object" } }], nextCursor: "tools-2" },
      "tools-2": { items: [{ name: "tool-two", inputSchema: { type: "object" } }] },
    }
    server.state.promptPages = {
      initial: { items: [{ name: "prompt-one" }], nextCursor: "prompts-2" },
      "prompts-2": { items: [{ name: "prompt-two" }] },
    }
    server.state.resourcePages = {
      initial: { items: [{ name: "resource-one", uri: "test://one" }], nextCursor: "resources-2" },
      "resources-2": { items: [{ name: "resource-two", uri: "test://two" }] },
    }
    server.state.resourceTemplatePages = {
      initial: { items: [{ name: "template-one", uriTemplate: "test://one/{id}" }], nextCursor: "templates-2" },
      "templates-2": { items: [{ name: "template-two", uriTemplate: "test://two/{id}" }] },
    }
    const mcp = yield* MCP.Service
    yield* mcp.add("paged-server", remote(server.url))

    expect(Object.keys(yield* mcp.tools())).toEqual(["paged-server_tool-one", "paged-server_tool-two"])
    expect(Object.keys(yield* mcp.prompts())).toEqual(["paged-server:prompt-one", "paged-server:prompt-two"])
    expect(Object.keys(yield* mcp.resources())).toEqual(["paged-server:test://one", "paged-server:test://two"])
    expect(Object.keys(yield* mcp.resourceTemplates())).toEqual([
      "paged-server:test://one/{id}",
      "paged-server:test://two/{id}",
    ])
  }),
)

it.instance("accepts empty cursors and rejects repeated cursors", () =>
  Effect.gen(function* () {
    const empty = yield* lifecycleServer({ capabilities: { prompts: {} } })
    empty.state.promptPages = {
      initial: { items: [{ name: "prompt-one" }], nextCursor: "" },
      "": { items: [{ name: "prompt-two" }] },
    }
    const looping = yield* lifecycleServer({ capabilities: { tools: {} } })
    looping.state.toolPages = {
      initial: { items: [], nextCursor: "repeat" },
      repeat: { items: [], nextCursor: "repeat" },
    }
    const mcp = yield* MCP.Service
    yield* mcp.add("empty-cursor", remote(empty.url))
    const result = yield* mcp.add("looping-cursor", remote(looping.url))

    expect(Object.keys(yield* mcp.prompts())).toEqual(["empty-cursor:prompt-one", "empty-cursor:prompt-two"])
    expect(statusName(result.status, "looping-cursor")).toBe("failed")
  }),
)

it.instance("disconnect removes protocol data and reconnect establishes a new session", () =>
  Effect.gen(function* () {
    const server = yield* lifecycleServer()
    const mcp = yield* MCP.Service
    yield* mcp.add("reconnect-server", remote(server.url))
    expect((yield* mcp.status())["reconnect-server"]?.status).toBe("connected")

    yield* mcp.disconnect("reconnect-server")
    expect((yield* mcp.status())["reconnect-server"]?.status).toBe("disabled")
    expect(Object.keys(yield* mcp.tools())).toEqual([])
    yield* pollWithTimeout(
      Effect.sync(() => (server.state.aborted > 0 ? server.state.aborted : undefined)),
      "disconnected HTTP session was not aborted",
    )

    yield* Effect.promise(server.restart)
    yield* mcp.connect("reconnect-server")
    expect((yield* mcp.status())["reconnect-server"]?.status).toBe("connected")
    expect(Object.keys(yield* mcp.tools())).toEqual(["reconnect-server_test_tool"])
  }),
)

it.instance("add() closes the old protocol session when replacing a server", () =>
  Effect.gen(function* () {
    const first = yield* lifecycleServer()
    const second = yield* lifecycleServer()
    const mcp = yield* MCP.Service
    yield* mcp.add("replace-server", remote(first.url))
    yield* mcp.add("replace-server", remote(second.url))

    yield* pollWithTimeout(
      Effect.sync(() => (first.state.aborted > 0 ? first.state.aborted : undefined)),
      "replaced HTTP session was not aborted",
    )
    expect(second.state.aborted).toBe(0)
    expect(Object.keys(yield* mcp.tools())).toEqual(["replace-server_test_tool"])
  }),
)

it.instance("one failed server does not affect another connected server", () =>
  Effect.gen(function* () {
    const good = yield* lifecycleServer()
    good.state.tools = [{ name: "good_tool", inputSchema: { type: "object" } }]
    const bad = yield* lifecycleServer()
    bad.state.listToolsError = "listTools failed"
    const mcp = yield* MCP.Service
    yield* mcp.add("good-server", remote(good.url))
    yield* mcp.add("bad-server", remote(bad.url))

    expect((yield* mcp.status())["good-server"]?.status).toBe("connected")
    expect((yield* mcp.status())["bad-server"]?.status).toBe("failed")
    expect(Object.keys(yield* mcp.tools())).toEqual(["good-server_good_tool"])
  }),
)

it.instance("falls back when output schema refs fail SDK tool discovery", () =>
  Effect.gen(function* () {
    const server = yield* lifecycleServer({ capabilities: { tools: {} } })
    server.state.tools = [
      {
        name: "render_screen",
        inputSchema: { type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"] },
        outputSchema: { type: "object", properties: { screen: { $ref: "#/$defs/ScreenInstance" } } },
      },
    ]
    const mcp = yield* MCP.Service
    const result = yield* mcp.add("schema-server", remote(server.url))

    expect(statusName(result.status, "schema-server")).toBe("connected")
    expect(Object.keys(yield* mcp.tools())).toEqual(["schema-server_render_screen"])
  }),
)

it.instance("does not fall back for protocol tool discovery errors", () =>
  Effect.gen(function* () {
    const server = yield* lifecycleServer({ capabilities: { tools: {} } })
    server.state.listToolsError = "transport closed"
    const mcp = yield* MCP.Service
    const result = yield* mcp.add("broken-server", remote(server.url))

    expect(statusName(result.status, "broken-server")).toBe("failed")
  }),
)

it.instance("disabled server is marked disabled without opening a protocol session", () =>
  Effect.gen(function* () {
    const server = yield* lifecycleServer()
    const mcp = yield* MCP.Service
    yield* mcp.add("disabled-server", { ...remote(server.url), enabled: false })

    expect((yield* mcp.status())["disabled-server"]?.status).toBe("disabled")
    expect(server.state.requests).toEqual([])
  }),
)

it.instance("returns prompts and URI-keyed resources from connected servers", () =>
  Effect.gen(function* () {
    const server = yield* lifecycleServer()
    server.state.prompts = [{ name: "my-prompt", description: "A test prompt" }]
    server.state.resources = [
      { name: "same-name", uri: "file:///test.txt" },
      { name: "same-name", uri: "ui://component-state" },
    ]
    const mcp = yield* MCP.Service
    yield* mcp.add("content-server", remote(server.url))

    expect(Object.keys(yield* mcp.prompts())).toEqual(["content-server:my-prompt"])
    expect(Object.keys(yield* mcp.resources())).toEqual([
      "content-server:file:///test.txt",
      "content-server:ui://component-state",
    ])
    yield* mcp.disconnect("content-server")
    expect(yield* mcp.prompts()).toEqual({})
  }),
)

it.instance("uses per-server timeouts for prompt and resource requests", () =>
  Effect.gen(function* () {
    const server = yield* lifecycleServer()
    server.state.requestDelay = 200
    const mcp = yield* MCP.Service
    yield* mcp.add("timeout-server", remote(server.url, 50))

    expect(yield* mcp.getPrompt("timeout-server", "test")).toBeUndefined()
    expect(yield* mcp.readResource("timeout-server", "test://resource")).toBeUndefined()
  }),
)

it.instance("connects resource-only, prompt-only, and tools-only servers", () =>
  Effect.gen(function* () {
    const resources = yield* lifecycleServer({ capabilities: { resources: {} } })
    resources.state.resources = [{ name: "docs", uri: "docs://readme" }]
    const prompts = yield* lifecycleServer({ capabilities: { prompts: {} } })
    prompts.state.prompts = [{ name: "review" }]
    const tools = yield* lifecycleServer({ capabilities: { tools: {} } })
    const mcp = yield* MCP.Service
    yield* mcp.add("resource-only", remote(resources.url))
    yield* mcp.add("prompt-only", remote(prompts.url))
    yield* mcp.add("tools-only", remote(tools.url))

    expect(Object.keys(yield* mcp.tools())).toEqual(["tools-only_test_tool"])
    expect(Object.keys(yield* mcp.prompts())).toEqual(["prompt-only:review"])
    expect(Object.keys(yield* mcp.resources())).toEqual(["resource-only:docs://readme"])
  }),
)

it.instance("connect and disconnect fail for unknown servers", () =>
  Effect.gen(function* () {
    const mcp = yield* MCP.Service
    for (const operation of [mcp.connect("missing"), mcp.disconnect("missing")]) {
      const exit = yield* operation.pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.squash(exit.cause)).toMatchObject({ _tag: "MCP.NotFoundError", name: "missing" })
      }
    }
    expect(yield* mcp.status()).toEqual({})
    expect(yield* mcp.tools()).toEqual({})
  }),
)

it.instance("unavailable remote server is marked failed without tools", () =>
  Effect.gen(function* () {
    const server = yield* Effect.acquireRelease(
      Effect.sync(() => Bun.serve({ port: 0, fetch: () => new Response("unavailable", { status: 503 }) })),
      (http) => Effect.promise(() => http.stop(true)),
    )
    const mcp = yield* MCP.Service
    yield* mcp.add("unavailable", remote(server.url.toString(), 500))

    expect((yield* mcp.status()).unavailable?.status).toBe("failed")
    expect(yield* mcp.tools()).toEqual({})
  }),
)

it.instance("tools() prefixes sanitized server and tool names", () =>
  Effect.gen(function* () {
    const server = yield* lifecycleServer({ capabilities: { tools: {} } })
    server.state.tools = [
      { name: "tool-a", inputSchema: { type: "object" } },
      { name: "tool.b", inputSchema: { type: "object" } },
    ]
    const mcp = yield* MCP.Service
    yield* mcp.add("my.special-server", remote(server.url))

    expect(Object.keys(yield* mcp.tools())).toEqual(["my_special-server_tool-a", "my_special-server_tool_b"])
  }),
)

it.instance("local stdio timeout terminates the real server process", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    const pidFile = path.join(test.directory, "mcp.pid")
    const mcp = yield* MCP.Service
    const result = yield* mcp.add("hanging-stdio", {
      type: "local",
      command: [process.execPath, stdioFixture, "--hang"],
      environment: { MCP_LIFECYCLE_PID_FILE: pidFile },
      timeout: 100,
    })

    expect(statusName(result.status, "hanging-stdio")).toBe("failed")
    const pid = yield* pollWithTimeout(
      Effect.promise(async () => {
        const file = Bun.file(pidFile)
        return (await file.exists()) ? Number(await file.text()) : undefined
      }),
      "stdio fixture did not publish its pid",
    )
    yield* pollWithTimeout(
      Effect.sync(() => {
        try {
          process.kill(pid, 0)
          return undefined
        } catch {
          return true
        }
      }),
      "stdio fixture process was not terminated",
    )
  }),
)

it.instance("remote timeout aborts both real HTTP transport attempts", () =>
  Effect.gen(function* () {
    const server = yield* hangingLifecycleServer()
    const mcp = yield* MCP.Service
    const result = yield* mcp.add("hanging-remote", remote(server.url, 100))

    expect(statusName(result.status, "hanging-remote")).toBe("failed")
    yield* pollWithTimeout(
      Effect.sync(() => (server.aborted() >= 2 ? server.aborted() : undefined)),
      "remote transport requests were not aborted",
    )
    expect(server.requests).toEqual(["POST", "GET"])
  }),
)

it.live("McpOAuthCallback.cancelPending rejects the pending callback", () =>
  Effect.acquireUseRelease(
    Effect.sync(() => McpOAuthCallback.waitForCallback("abc123hexstate", "my-mcp-server")),
    (callback) =>
      Effect.gen(function* () {
        McpOAuthCallback.cancelPending("my-mcp-server")
        const exit = yield* Effect.tryPromise({
          try: () => callback,
          catch: (error) => (error instanceof Error ? error : new Error(String(error))),
        }).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
      }),
    () => Effect.promise(() => McpOAuthCallback.stop()).pipe(Effect.ignore),
  ),
)

// --- Swarm 1.3.2 row 17 (S2): the five silent paths of mcp/index.ts must leave a durable line (F0b, F2, F2b, F3, F4) ---

// --- Swarm 1.3.2 row 16b: the review's and security review's asks (F-N1, F-N2, F-N3, F-N6, F-N7, NB-1) ---



/** The `error` text a failed status carries — F2b moves this same text into the `server unavailable` line. */
function failureText(status: Record<string, MCPNS.Status> | MCPNS.Status, server: string) {
  const item = "status" in status ? status : status[server]
  return item && "error" in item ? item.error : undefined
}

it.instance(
  "F2b server unavailable carries the error text that status already held",
  () =>
    withCapturedLog((log) =>
      Effect.gen(function* () {
        const mcp = yield* MCP.Service
        const result = yield* mcp.add("no-launcher", { type: "local", command: ["swarm-mcp-missing-launcher-132"] })

        expect(statusName(result.status, "no-launcher")).toBe("failed")
        const reason = failureText(result.status, "no-launcher")
        expect(reason).toBeDefined()

        const lines = yield* log.matching("server unavailable")
        expect(lines).toHaveLength(1)
        // The three fields that were already there have not moved.
        expect(lines[0]).toContain("key=no-launcher")
        expect(lines[0]).toContain("type=local")
        expect(lines[0]).toContain("status=failed")
        // F2b: the reason that was already sitting in status.error now travels in the line. Asserted as two
        // quote-free substrings of it because the appender JSON-quotes a value holding spaces and quotes.
        expect(lines[0]).toContain("Executable not found")
        expect(lines[0]).toContain("swarm-mcp-missing-launcher-132")

        // And it is scrubbed: an absolute command path never reaches the file in the clear.
        yield* mcp.add("no-launcher-abs", {
          type: "local",
          command: ["/tmp/opencode-private-vault-132/swarm-mcp-missing-launcher"],
        })
        const abs = yield* log.matching("server unavailable", "key=no-launcher-abs")
        expect(abs).toHaveLength(1)
        expect(abs[0]).not.toContain("opencode-private-vault-132")
        expect(abs[0]).toContain("error=")
      }),
    ),
  { timeout: 30_000 },
)

it.instance(
  "F2 a thrown defs cause is logged before the status flip",
  () =>
    withCapturedLog((log) =>
      Effect.gen(function* () {
        const server = yield* lifecycleServer({ capabilities: { tools: {} } })
        server.state.listToolsError = "listTools exploded"
        const mcp = yield* MCP.Service
        const result = yield* mcp.add("defs-threw", remote(server.url))

        // CreateResult is unchanged: the caller still sees a plain failure.
        expect(statusName(result.status, "defs-threw")).toBe("failed")
        expect(yield* mcp.tools()).toEqual({})

        const lines = yield* log.matching("MCP create failed")
        expect(lines).toHaveLength(1)
        expect(lines[0]).toContain("key=defs-threw")
        expect(lines[0]).toContain("Failed to get tools")
        expect(lines[0]).not.toContain("/Users/")
      }),
    ),
  { timeout: 30_000 },
)

it.instance(
  "F0b a connected server with an empty cached list warns and offers nothing",
  () =>
    withCapturedLog((log) =>
      Effect.gen(function* () {
        const server = yield* lifecycleServer({ capabilities: { tools: {} } })
        server.state.tools = []
        const mcp = yield* MCP.Service
        yield* mcp.add("empty-server", remote(server.url))

        expect((yield* mcp.status())["empty-server"]?.status).toBe("connected")
        expect(Object.keys(yield* mcp.tools())).toEqual([])

        const warnings = yield* log.matching("connected server contributed no tools")
        expect(warnings).toHaveLength(1)
        expect(warnings[0]).toContain("clientName=empty-server")
        // The absence warning keeps its own message, so existing log parsing does not move.
        const all = yield* log.lines()
        expect(all.filter((line) => line.includes("missing cached tools for connected server"))).toHaveLength(0)
      }),
    ),
  { timeout: 30_000 },
)

it.instance(
  "F3 disposing an instance logs one teardown line per live client",
  () =>
    withCapturedLog((log) =>
      Effect.gen(function* () {
        const first = yield* lifecycleServer()
        const second = yield* lifecycleServer()
        const mcp = yield* MCP.Service
        yield* mcp.add("teardown-one", remote(first.url))
        yield* mcp.add("teardown-two", remote(second.url))
        expect(Object.keys(yield* mcp.clients())).toHaveLength(2)

        // Disposal inside the capture: the finalizer's lines have to reach the file, which is what F3 is about.
        yield* disposeAllInstancesEffect
        const lines = yield* log.matching("MCP connection closing")
        expect(lines).toHaveLength(2)
        expect(lines.filter((line) => line.includes("server=teardown-one"))).toHaveLength(1)
        expect(lines.filter((line) => line.includes("server=teardown-two"))).toHaveLength(1)
        expect(lines.every((line) => line.includes("instance disposed"))).toBe(true)
      }),
    ),
  { timeout: 30_000 },
)

it.instance(
  "F4 a local child's stderr reaches the log",
  () =>
    withCapturedLog((log) =>
      Effect.gen(function* () {
        const mcp = yield* MCP.Service
        const result = yield* mcp.add("stdio-stderr", {
          type: "local",
          command: [process.execPath, stdioFixture, "--stderr", "BRIDGE_START pid=1"],
        })
        expect(statusName(result.status, "stdio-stderr")).toBe("connected")

        const lines = yield* log.matching("BRIDGE_START")
        expect(lines).toHaveLength(1)
        expect(lines[0]).toContain("server=stdio-stderr")
      }),
    ),
  { timeout: 30_000 },
)

// --- Swarm 1.3.2 row 16b: review round (F-N1 pre-handshake stderr, F-N3 capability gate, F-N6 caps and interrupt,
// F-N7 logged stop, NB-1 credential masking) ---

/** Polls the capture for lines holding every needle, so a line written by another fiber still counts as arrived. */
function appearing(log: CapturedLog, ...needles: string[]) {
  return pollWithTimeout(
    Effect.gen(function* () {
      const all = yield* log.lines()
      const hits = all.filter((line) => needles.every((needle) => line.includes(needle)))
      return hits.length > 0 ? hits : undefined
    }),
    `no captured line holding ${needles.join(" + ")}`,
    "10 seconds",
  )
}

it.instance(
  "F4 a child that dies during the handshake still leaves its stderr line",
  () =>
    withCapturedLog((log) =>
      Effect.gen(function* () {
        const mcp = yield* MCP.Service
        const result = yield* mcp.add("dying-server", {
          type: "local",
          command: [process.execPath, stdioFixture, "--die", "HOST_UNREACHABLE port=57302"],
          timeout: 5000,
        })

        // The connect itself must still fail the way it always did; only the reason's survival is new.
        expect(statusName(result.status, "dying-server")).toBe("failed")
        const lines = yield* appearing(log, "HOST_UNREACHABLE", "server=dying-server")
        expect(lines.length).toBeGreaterThan(0)
      }),
    ),
  { timeout: 30_000 },
)

it.instance(
  "F4 masks credential shapes in a child's stderr before they reach the log",
  () =>
    withCapturedLog((log) =>
      Effect.gen(function* () {
        const secret = "sk-live-0123456789abcdef0123456789abcdef"
        const opaque = "Q1b3Az9Kf2Ld7Hs4Jg6Kp8Mo0Ni2Ru5Ty7Vw9Xa1Bc3De"
        const mcp = yield* MCP.Service
        yield* mcp.add("chatty-server", {
          type: "local",
          command: [
            process.execPath,
            stdioFixture,
            "--stderr",
            `request rejected Authorization: Bearer ${secret} via https://svc:hw63Jkaf82Lm@gsp.invalid/mcp blob ${opaque}`,
          ],
        })

        const lines = yield* appearing(log, "request rejected")
        expect(lines).toHaveLength(1)
        // NB-1: every credential shape goes, the diagnosis around it stays.
        expect(lines[0]).not.toContain(secret)
        expect(lines[0]).not.toContain(opaque)
        expect(lines[0]).not.toContain("hw63Jkaf82Lm")
        expect(lines[0]).toContain("Bearer [redacted]")
        expect(lines[0]).toContain("svc:[redacted]@gsp.invalid")
        expect(lines[0]).toContain("request rejected")
      }),
    ),
  { timeout: 30_000 },
)

it.instance(
  "F4 caps one stderr line at 500 bytes",
  () =>
    withCapturedLog((log) =>
      Effect.gen(function* () {
        const mcp = yield* MCP.Service
        yield* mcp.add("long-line-server", {
          type: "local",
          command: [process.execPath, stdioFixture, "--stderr", `LONG_START ${"x".repeat(2000)} LONG_END`],
        })

        const lines = yield* appearing(log, "LONG_START")
        expect(lines).toHaveLength(1)
        // Row 18 F-N6 case 2: the byte cap was asserted to exist; here it is exercised. The cut itself stays silent
        // per line (row 18 F-I1 accepted that); only the line-count cap carries its own marker.
        expect(lines[0]!.length).toBeLessThan(700)
        expect(lines[0]).not.toContain("LONG_END")
      }),
    ),
  { timeout: 30_000 },
)

it.instance(
  "F4 stops logging stderr at 1,000 lines per client and says so once",
  () =>
    withCapturedLog((log) =>
      Effect.gen(function* () {
        const mcp = yield* MCP.Service
        yield* mcp.add("flooding-server", {
          type: "local",
          command: [process.execPath, stdioFixture, "--stderr-many", "1002"],
        })

        const summary = yield* appearing(log, "MCP server stderr truncated")
        expect(summary).toHaveLength(1)
        expect(summary[0]).toContain("limit=1000")
        const logged = (yield* log.lines()).filter((line) => line.includes("message=\"MCP server stderr\""))
        expect(logged).toHaveLength(1000)
        // Draining continues past the cap, so the flood never filled the pipe and stalled the child: the server is
        // still connected and still answers tools/list (row 18 §4).
        expect((yield* mcp.status())["flooding-server"]?.status).toBe("connected")
        expect(Object.keys(yield* mcp.tools())).toEqual(["flooding-server_current_directory"])
      }),
    ),
  { timeout: 60_000 },
)

it.instance(
  "F0b stays quiet for a server that never advertised the tools capability",
  () =>
    withCapturedLog((log) =>
      Effect.gen(function* () {
        const server = yield* lifecycleServer({ capabilities: { prompts: {} } })
        server.state.prompts = [{ name: "review" }]
        const mcp = yield* MCP.Service
        yield* mcp.add("prompts-only", remote(server.url))

        expect((yield* mcp.status())["prompts-only"]?.status).toBe("connected")
        expect(Object.keys(yield* mcp.tools())).toEqual([])
        // F-N3: an empty tool list is the honest answer for a prompts-only server, not an anomaly.
        expect(yield* log.matching("contributed no tools")).toHaveLength(0)
      }),
    ),
  { timeout: 30_000 },
)

it.instance(
  "F2 an interrupted create leaves no MCP create failed line",
  () =>
    withCapturedLog((log) =>
      Effect.gen(function* () {
        // Row 18 F-N6 case 4 asks for a test that an interrupted create stays silent, and this pins that observable.
        // What it does NOT cover, measured rather than assumed: removing the `Cause.hasInterruptsOnly` guard inside the
        // F2 tap leaves this test green even with the delay below, because the interrupt is absorbed before the cause
        // reaches that pipe (probed with an unconditional tap). The guard is therefore untested code with a reason, not
        // tested code — see implementation/01_fix.md §Review fix round item 8.
        const server = yield* lifecycleServer()
        server.state.requestDelay = 5000
        const mcp = yield* MCP.Service
        const fiber = yield* Effect.forkScoped(mcp.add("interrupted", remote(server.url, 60000)))
        yield* Effect.sleep("300 millis")
        yield* Fiber.interrupt(fiber)
        // Let any line the interrupted fiber still manages to write land before reading, so absence means absence.
        yield* Effect.sleep("300 millis")
        yield* Effect.logInfo("interrupt settle marker")

        const lines = yield* log.matching("MCP create failed")
        expect(lines).toHaveLength(0)
        // The capture really was live at that point: a line logged from this fiber after the interrupt does reach it.
        expect((yield* log.lines()).some((line) => line.includes("interrupt settle marker"))).toBe(true)
      }),
    ),
  { timeout: 30_000 },
)
