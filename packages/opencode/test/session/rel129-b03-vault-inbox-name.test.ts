// 1.2.9 row 42 (AC-B03, N9-119): the system prompt names the real tool `swarm-web_vault_inbox`. (a) the line, (b) the
// name is a real swarm-web tool, (c) prompt cache: with swarm-web connected and no state change, the installed-tools
// block of turn 1 is byte-equal to that of turn 2.

import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Effect, Layer } from "effect"
import { LSP } from "@/lsp/lsp"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Session } from "@/session/session"
import { MCP } from "../../src/mcp"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionSummary } from "../../src/session/summary"
import { SystemPrompt } from "../../src/session/system"
import { InstalledTools } from "../../src/session/installed-tools"
import { provideTmpdirServer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"

let status: Record<string, MCP.Status> = {}
const WEB = ["swarm-web"]
const stateFile = () => InstalledTools.stateFilePath()
const writeState = (record: unknown) => {
  mkdirSync(path.dirname(stateFile()), { recursive: true })
  writeFileSync(stateFile(), JSON.stringify(record))
}
const healthy = (...ids: string[]) => Object.fromEntries(ids.map((id) => [id, { state: "healthy", version: "1" }]))
const blockOf = (text: string) => /<installed_tools>[\s\S]*?<\/installed_tools>/.exec(text)?.[0]

afterEach(() => {
  rmSync(path.dirname(path.dirname(stateFile())), { recursive: true, force: true })
})

const mcpStub = Layer.succeed(
  MCP.Service,
  MCP.Service.of({
    status: () => Effect.sync(() => status),
    clients: () => Effect.succeed({}),
    instructions: () => Effect.succeed([]),
    tools: () => Effect.succeed({}),
    prompts: () => Effect.succeed({}),
    resources: () => Effect.succeed({}),
    resourceTemplates: () => Effect.succeed({}),
    add: () => Effect.succeed({ status: { status: "disabled" as const } }),
    connect: () => Effect.void,
    disconnect: () => Effect.void,
    getPrompt: () => Effect.succeed(undefined),
    readResource: () => Effect.succeed(undefined),
    startAuth: () => Effect.die("unexpected MCP auth"),
    authenticate: () => Effect.die("unexpected MCP auth"),
    finishAuth: () => Effect.die("unexpected MCP auth"),
    removeAuth: () => Effect.void,
    supportsOAuth: () => Effect.succeed(false),
    hasStoredTokens: () => Effect.succeed(false),
    getAuthStatus: () => Effect.succeed("not_authenticated" as const),
  }),
)

const lspStub = Layer.mock(LSP.Service, {
  init: () => Effect.void,
  status: () => Effect.succeed([]),
  hasClients: () => Effect.succeed(false),
  touchFile: () => Effect.void,
  diagnostics: () => Effect.succeed({}),
})

const summaryStub = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const loop = testEffect(
  LayerNode.compile(
    LayerNode.group([
      SessionPrompt.node,
      Session.node,
      SessionProjector.node,
      SessionSummary.node,
      Database.node,
      CrossSpawnSpawner.node,
      LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] }),
    ]),
    [
      [MCP.node, mcpStub],
      [LSP.node, lspStub],
      [SessionSummary.node, summaryStub],
      [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true })],
    ],
  ),
)

const providerCfg = (url: string) => ({
  // Row 96 ships `"*": "ask"`; this file is about the prompt, so dispatching `task` is granted up front.
  permission: { "*": "allow" as const, task: "allow" as const },
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
})

type Message = { role?: string; content?: unknown }

/** Text of the given role's messages in one request the model received. */
const textOf = (body: Record<string, unknown>, role: string) =>
  ((body.messages ?? []) as Message[])
    .filter((message) => message.role === role)
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : Array.isArray(message.content)
          ? message.content.map((part: { text?: string }) => part.text ?? "").join("\n")
          : "",
    )
    .join("\n")

const allowAll = [{ permission: "*", pattern: "*", action: "allow" as const }]


const NEW = "notes: use `swarm-web_vault_inbox` to drop a note in the Obsidian inbox."
const OLD = "swarm-web `vault_inbox`"

describe("N9-119 the system prompt names swarm-web_vault_inbox", () => {
  test("(a) the installed-tools block with swarm-web connected names the real tool", () => {
    const block = SystemPrompt.installedTools(["obsidian"], WEB) ?? ""
    expect(block).toContain(NEW)
    expect(block).not.toContain(OLD)
    expect(SystemPrompt.installedTools(["obsidian"], [])).toBeUndefined()
  })

  test("(b) swarm-web_vault_inbox is a swarm-web tool name in the proxy wiring", () => {
    const wiring = readFileSync(
      path.join(import.meta.dir, "..", "..", "..", "setup", "src", "mcpproxy", "wiring.ts"),
      "utf8",
    )
    const names = new Set([...wiring.matchAll(/"(swarm-web_[a-z_]+)"/g)].map((m) => m[1]))
    expect(names.has("swarm-web_vault_inbox")).toBe(true)
  })

  loop.live(
    "(c) turn-1 and turn-2 installed-tools blocks are byte-equal with swarm-web connected",
    () =>
      provideTmpdirServer(
        Effect.fnUntraced(function* ({ llm }) {
          const prompt = yield* SessionPrompt.Service
          const sessions = yield* Session.Service
          status = { "swarm-web": { status: "connected" } }
          writeState({ version: 1, components: healthy("searxng", "firecrawl", "obsidian") })
          const chat = yield* sessions.create({ title: "B03", permission: allowAll })
          const turn = (text: string) =>
            Effect.gen(function* () {
              yield* llm.text(`reply to ${text}`)
              yield* prompt.prompt({
                sessionID: chat.id,
                agent: "build",
                noReply: true,
                parts: [{ type: "text", text }],
              })
              yield* prompt.loop({ sessionID: chat.id })
            })
          yield* turn("first")
          yield* turn("second")
          // SB-2 (row 112): the block is in turn 1's saved turn facts part; turn 2 repeats that message unchanged.
          const systems = (yield* llm.hits).map((hit) => textOf(hit.body, "user"))
          expect(systems).toHaveLength(2)
          expect(systems[1]!.split("<installed_tools>")).toHaveLength(2)
          const first = blockOf(systems[0]!)
          const second = blockOf(systems[1]!)
          expect(first).toBeDefined()
          expect(first).toContain(NEW)
          expect(Buffer.from(first!).equals(Buffer.from(second!))).toBe(true)
        }),
        { config: providerCfg },
      ),
    30_000,
  )
})
