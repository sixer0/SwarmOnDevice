import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { beforeEach, expect } from "bun:test"
import { Effect, Layer } from "effect"
import path from "path"
import { Agent as AgentSvc } from "../../src/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Command } from "../../src/command"
import { Config } from "@/config/config"
import { LSP } from "@/lsp/lsp"
import { MCP } from "../../src/mcp"
import { DatumStudioMcp } from "@/mcp/datum-studio"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { Provider as ProviderSvc } from "@/provider/provider"
import { Env } from "../../src/env"
import { Git } from "../../src/git"
import { Image } from "../../src/image/image"
import { Question } from "../../src/question"
import { Todo } from "../../src/session/todo"
import { Session } from "@/session/session"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { SessionCompaction } from "../../src/session/compaction"
import { SessionSummary } from "../../src/session/summary"
import { Instruction } from "../../src/session/instruction"
import { SessionProcessor } from "../../src/session/processor"
import { SessionPrompt } from "../../src/session/prompt"
import { MissionBinding } from "../../src/session/mission-binding"
import { SessionRevert } from "../../src/session/revert"
import { SessionRunState } from "../../src/session/run-state"
import { SessionStatus } from "../../src/session/status"
import { Skill } from "../../src/skill"
import { SystemPrompt } from "../../src/session/system"
import { Snapshot } from "../../src/snapshot"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Format } from "../../src/format"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { reply, TestLLMServer } from "../lib/llm-server"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"

// MC-1 (1.3.3 row 11): the session loop does not end a turn on a tool call written as text or on an empty step of a
// session with a running mission row. Mock provider (TestLLMServer); the Studio tools are a stub MCP client whose
// `callTool` is counted, so "never executed from text" is an observation and not an assumption. Harness as in
// prompt.test.ts. All ids and texts are synthetic.

const CREATE = "datum-studio_studio_mission_create"
const GET = "datum-studio_studio_mission_get"
const MISSION = "2026-11-17_guard"

const studio = {
  calls: 0,
  tools: (): Effect.Effect<Record<string, MCP.McpTool>> => Effect.succeed({}),
}
const client = {
  callTool: async () => {
    studio.calls++
    return { content: [{ type: "text", text: "ok" }] }
  },
} as unknown as MCP.McpTool["client"]
const builtin: MCP.Source = { server: DatumStudioMcp.DATUM_STUDIO_MCP, transport: "remote", origin: "global" }
const createDef = {
  name: "studio_mission_create",
  description: "create a mission",
  inputSchema: {
    type: "object" as const,
    properties: { mission: { type: "object" }, dryRun: { type: "boolean" } },
    required: ["mission"],
  },
}
const getDef = {
  name: "studio_mission_get",
  description: "read a mission",
  inputSchema: { type: "object" as const, properties: { id: { type: "string" } }, required: ["id"] },
}
const withCreate = () =>
  Effect.succeed({ [CREATE]: { def: createDef, client, source: builtin } } as unknown as Record<string, MCP.McpTool>)
const withGetOnly = () =>
  Effect.succeed({ [GET]: { def: getDef, client, source: builtin } } as unknown as Record<string, MCP.McpTool>)

beforeEach(() => {
  studio.calls = 0
  studio.tools = () => Effect.succeed({})
  MissionBinding.reset()
})

const mcp = Layer.succeed(
  MCP.Service,
  MCP.Service.of({
    status: () => Effect.succeed({}),
    clients: () => Effect.succeed({}),
    instructions: () => Effect.succeed([]),
    tools: () => Effect.suspend(() => studio.tools()),
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

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const lsp = Layer.succeed(
  LSP.Service,
  LSP.Service.of({
    init: () => Effect.void,
    status: () => Effect.succeed([]),
    hasClients: () => Effect.succeed(false),
    touchFile: () => Effect.void,
    diagnostics: () => Effect.succeed({}),
    hover: () => Effect.succeed(undefined),
    definition: () => Effect.succeed([]),
    references: () => Effect.succeed([]),
    implementation: () => Effect.succeed([]),
    documentSymbol: () => Effect.succeed([]),
    workspaceSymbol: () => Effect.succeed([]),
    prepareCallHierarchy: () => Effect.succeed([]),
    incomingCalls: () => Effect.succeed([]),
    outgoingCalls: () => Effect.succeed([]),
  }),
)

const root = LayerNode.group([
  SessionPrompt.node,
  Session.node,
  SessionProjector.node,
  MessageV2.node,
  Snapshot.node,
  LLM.node,
  Env.node,
  AgentSvc.node,
  Command.node,
  Permission.node,
  Plugin.node,
  Config.node,
  ProviderSvc.node,
  LSP.node,
  MCP.node,
  FSUtil.node,
  BackgroundJob.node,
  SessionStatus.node,
  SessionRunState.node,
  Database.node,
  EventV2Bridge.node,
  Question.node,
  Todo.node,
  ToolRegistry.node,
  Skill.node,
  Git.node,
  Ripgrep.node,
  Format.node,
  Truncate.node,
  SessionProcessor.node,
  Image.node,
  SessionCompaction.node,
  SessionRevert.node,
  Instruction.node,
  SystemPrompt.node,
  CrossSpawnSpawner.node,
  RuntimeFlags.node,
  LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] }),
])

const it = testEffect(
  LayerNode.compile(root, [
    [SessionSummary.node, summary],
    [LSP.node, lsp],
    [MCP.node, mcp],
    [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true })],
  ] as const),
)

const providerCfg = (url: string): Partial<ConfigV1.Info> => ({
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

const start = Effect.fn("test.start")(function* () {
  const { directory } = yield* TestInstance
  const llm = yield* TestLLMServer
  const fs = yield* FSUtil.Service
  yield* fs.writeWithDirs(
    path.join(directory, "swarm.json"),
    JSON.stringify({ $schema: "https://opencode.ai/config.json", ...providerCfg(llm.url) }),
  )
  const prompt = yield* SessionPrompt.Service
  const sessions = yield* Session.Service
  const chat = yield* sessions.create({
    title: "Pinned",
    permission: [{ permission: "*", pattern: "*", action: "allow" }],
  })
  yield* prompt.prompt({
    sessionID: chat.id,
    agent: "build",
    noReply: true,
    parts: [{ type: "text", text: "create the mission" }],
  })
  return { llm, prompt, sessions, chat }
})

const runningRow = (sessionID: string) => {
  const ok = (tool: string, data: Record<string, unknown>) => ({
    content: [{ type: "text", text: "x" }],
    structuredContent: { ok: true, tool, ...data },
  })
  MissionBinding.observe({
    sessionID,
    tool: "studio_mission_create",
    args: { mission: { id: MISSION, title: "t", type: "generic", rows: [] } },
    result: ok("studio_mission_create", { id: MISSION, status: "draft", rows: 2, waves: [], issues: [], dryRun: false }),
  })
  MissionBinding.observe({
    sessionID,
    tool: "studio_mission_update_row",
    args: { mission: MISSION, rows: [{ id: "3", status: "running" }] },
    result: ok("studio_mission_update_row", {
      changed: ["3"],
      results: [{ id: "3", ok: true }],
      waves: [],
      ready: [],
      checkpoints: [],
      messages: [],
      dryRun: false,
    }),
  })
  expect(MissionBinding.hasRunningRow(sessionID)).toBe(true)
}

const TEXT_CALL = `${CREATE} {"mission":{"id":"${MISSION}","title":"Guard"}}`
const MARKUP_CALL = [
  "<tool_call>",
  "<function=studio_mission_create>",
  "<parameter=mission>",
  `{"id":"${MISSION}","title":"Guard"}`,
  "</parameter>",
  "</function>",
  "</tool_call>",
].join("\n")

const CORRECTION = `Your last message wrote a tool call as text (${CREATE}). Nothing ran. Call the tool itself now with the same arguments; never write a call in your answer.`
const CONTINUE = `Your last step was empty and mission ${MISSION} still has a running row (3). Continue with a tool call, or set the row's status with its note.`

type Msgs = SessionV1.WithParts[]
const marked = (msgs: Msgs, mark: string) =>
  msgs.flatMap((msg) =>
    msg.info.role === "user"
      ? msg.parts.flatMap((part) => (part.type === "text" && part.metadata?.[mark] === true ? [part] : []))
      : [],
  )
const toolParts = (msgs: Msgs) => msgs.flatMap((msg) => msg.parts.filter((part) => part.type === "tool"))
const finishOf = (msg: SessionV1.WithParts) => (msg.info.role === "assistant" ? msg.info.finish : undefined)
const errorOf = (msg: SessionV1.WithParts) => (msg.info.role === "assistant" ? msg.info.error : undefined)
const textOf = (msg: SessionV1.WithParts) =>
  msg.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")

it.instance("a registered tool call written as text gets one correction and is never executed", () =>
  Effect.gen(function* () {
    studio.tools = withCreate
    const { llm, prompt, sessions, chat } = yield* start()
    yield* llm.text(TEXT_CALL)
    yield* llm.text("The mission was not created.")

    const result = yield* prompt.loop({ sessionID: chat.id })

    expect(yield* llm.hits).toHaveLength(2)
    expect(studio.calls).toBe(0)
    const msgs = yield* sessions.messages({ sessionID: chat.id })
    expect(toolParts(msgs)).toHaveLength(0)
    const corrections = marked(msgs, "text_call_correction")
    expect(corrections).toHaveLength(1)
    expect(corrections[0].text).toBe(CORRECTION)
    expect(corrections[0].synthetic).toBe(true)
    // The second request carries the correction to the model.
    expect(JSON.stringify((yield* llm.inputs)[1])).toContain("Nothing ran. Call the tool itself now")
    expect(textOf(result)).toBe("The mission was not created.")
    expect(finishOf(result)).toBe("stop")
    expect(errorOf(result)).toBeUndefined()
  }),
)

it.instance("the markup form of a registered tool is corrected too, and the real call that follows runs once", () =>
  Effect.gen(function* () {
    studio.tools = withCreate
    const { llm, prompt, sessions, chat } = yield* start()
    yield* llm.text(MARKUP_CALL)
    yield* llm.tool(CREATE, { mission: { id: MISSION, title: "Guard" } })
    yield* llm.text("Created.")

    const result = yield* prompt.loop({ sessionID: chat.id })

    expect(yield* llm.hits).toHaveLength(3)
    expect(studio.calls).toBe(1)
    const msgs = yield* sessions.messages({ sessionID: chat.id })
    expect(marked(msgs, "text_call_correction")).toHaveLength(1)
    expect(toolParts(msgs)).toHaveLength(1)
    expect(finishOf(result)).toBe("stop")
  }),
)

it.instance("an empty final step of a session with a running mission row gets one continue message", () =>
  Effect.gen(function* () {
    const { llm, prompt, sessions, chat } = yield* start()
    runningRow(chat.id)
    yield* llm.push(reply().stop())
    yield* llm.text("Row 3 is done.")

    const result = yield* prompt.loop({ sessionID: chat.id })

    expect(yield* llm.hits).toHaveLength(2)
    const msgs = yield* sessions.messages({ sessionID: chat.id })
    const continues = marked(msgs, "empty_step_continue")
    expect(continues).toHaveLength(1)
    expect(continues[0].text).toBe(CONTINUE)
    expect(marked(msgs, "text_call_correction")).toHaveLength(0)
    expect(textOf(result)).toBe("Row 3 is done.")
    expect(finishOf(result)).toBe("stop")
  }),
)

it.instance("an empty final step without a running mission row exits as before", () =>
  Effect.gen(function* () {
    const { llm, prompt, sessions, chat } = yield* start()
    yield* llm.push(reply().stop())

    const result = yield* prompt.loop({ sessionID: chat.id })

    expect(yield* llm.hits).toHaveLength(1)
    const msgs = yield* sessions.messages({ sessionID: chat.id })
    expect(marked(msgs, "empty_step_continue")).toHaveLength(0)
    expect(finishOf(result)).toBe("stop")
  }),
)

it.instance("the third text call in a row ends the turn with text-tool-call after two corrections", () =>
  Effect.gen(function* () {
    studio.tools = withCreate
    const { llm, prompt, sessions, chat } = yield* start()
    yield* llm.text(TEXT_CALL)
    yield* llm.text(MARKUP_CALL)
    yield* llm.text(TEXT_CALL)
    yield* llm.text("never requested")

    const result = yield* prompt.loop({ sessionID: chat.id })

    expect(yield* llm.hits).toHaveLength(3)
    expect(studio.calls).toBe(0)
    const msgs = yield* sessions.messages({ sessionID: chat.id })
    expect(marked(msgs, "text_call_correction")).toHaveLength(2)
    expect(toolParts(msgs)).toHaveLength(0)
    expect(finishOf(result)).toBe("text-tool-call")
    expect(SessionProcessor.parseTurnEnd(finishOf(result))).toEqual({ reason: "text-tool-call" })
    expect(errorOf(result)).toBeUndefined()
  }),
)

it.instance("the third empty step in a row ends the turn with empty-step after two continues", () =>
  Effect.gen(function* () {
    const { llm, prompt, sessions, chat } = yield* start()
    runningRow(chat.id)
    yield* llm.push(reply().stop())
    yield* llm.push(reply().stop())
    yield* llm.push(reply().stop())

    const result = yield* prompt.loop({ sessionID: chat.id })

    expect(yield* llm.hits).toHaveLength(3)
    const msgs = yield* sessions.messages({ sessionID: chat.id })
    expect(marked(msgs, "empty_step_continue")).toHaveLength(2)
    expect(finishOf(result)).toBe("empty-step")
    expect(errorOf(result)).toBeUndefined()
  }),
)

it.instance("corrections and continues count together: text call, empty step, text call ends the turn", () =>
  Effect.gen(function* () {
    studio.tools = withCreate
    const { llm, prompt, sessions, chat } = yield* start()
    runningRow(chat.id)
    yield* llm.text(TEXT_CALL)
    yield* llm.push(reply().stop())
    yield* llm.text(TEXT_CALL)

    const result = yield* prompt.loop({ sessionID: chat.id })

    expect(yield* llm.hits).toHaveLength(3)
    const msgs = yield* sessions.messages({ sessionID: chat.id })
    expect(marked(msgs, "text_call_correction")).toHaveLength(1)
    expect(marked(msgs, "empty_step_continue")).toHaveLength(1)
    expect(finishOf(result)).toBe("text-tool-call")
  }),
)

it.instance("a real tool call in between resets the count", () =>
  Effect.gen(function* () {
    studio.tools = withCreate
    const { llm, prompt, sessions, chat } = yield* start()
    yield* llm.text(TEXT_CALL)
    yield* llm.text(TEXT_CALL)
    yield* llm.tool(CREATE, { mission: { id: MISSION, title: "Guard" } })
    yield* llm.text(TEXT_CALL)
    yield* llm.text(TEXT_CALL)
    yield* llm.text("Done after four corrections.")

    const result = yield* prompt.loop({ sessionID: chat.id })

    expect(yield* llm.hits).toHaveLength(6)
    expect(studio.calls).toBe(1)
    const msgs = yield* sessions.messages({ sessionID: chat.id })
    expect(marked(msgs, "text_call_correction")).toHaveLength(4)
    expect(textOf(result)).toBe("Done after four corrections.")
    expect(finishOf(result)).toBe("stop")
  }),
)

it.instance("a text call to a Studio tool while the server offers no tools: no correction, tools-unavailable", () =>
  Effect.gen(function* () {
    const { llm, prompt, sessions, chat } = yield* start()
    yield* llm.text(MARKUP_CALL)
    yield* llm.text("never requested")

    const result = yield* prompt.loop({ sessionID: chat.id })

    expect(yield* llm.hits).toHaveLength(1)
    const msgs = yield* sessions.messages({ sessionID: chat.id })
    expect(marked(msgs, "text_call_correction")).toHaveLength(0)
    expect(finishOf(result)).toBe("tools-unavailable:datum-studio")
    expect(SessionProcessor.parseTurnEnd(finishOf(result))).toEqual({
      reason: "tools-unavailable",
      server: "datum-studio",
    })
    expect(errorOf(result)).toBeUndefined()
  }),
)

it.instance("a text call to a tool outside the active set of a server that still has tools: no correction, text-tool-call", () =>
  Effect.gen(function* () {
    studio.tools = withGetOnly
    const { llm, prompt, sessions, chat } = yield* start()
    yield* llm.text(MARKUP_CALL)
    yield* llm.text("never requested")

    const result = yield* prompt.loop({ sessionID: chat.id })

    expect(yield* llm.hits).toHaveLength(1)
    expect(studio.calls).toBe(0)
    const msgs = yield* sessions.messages({ sessionID: chat.id })
    expect(marked(msgs, "text_call_correction")).toHaveLength(0)
    expect(finishOf(result)).toBe("text-tool-call")
  }),
)

it.instance("lost tools at tool resolution end the step with tools-unavailable:<server> and no model request", () =>
  Effect.gen(function* () {
    const { llm, prompt, chat } = yield* start()
    studio.tools = () => Effect.die(new MCP.ToolsUnavailableError({ server: "datum-studio" }))
    yield* llm.text("never requested")

    const result = yield* prompt.loop({ sessionID: chat.id })

    expect(yield* llm.hits).toHaveLength(0)
    expect(result.info.role).toBe("assistant")
    expect(finishOf(result)).toBe("tools-unavailable:datum-studio")
    expect(errorOf(result)).toBeUndefined()
    expect(result.info.role === "assistant" && typeof result.info.time.completed).toBe("number")
  }),
)

it.instance("another defect from tool resolution is not swallowed", () =>
  Effect.gen(function* () {
    const { llm, prompt, chat } = yield* start()
    studio.tools = () => Effect.die(new Error("row 11 synthetic defect"))
    yield* llm.text("never requested")

    const exit = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.exit)

    expect(exit._tag).toBe("Failure")
    expect(yield* llm.hits).toHaveLength(0)
  }),
)

const ORDINARY = [
  "Here is the shape of the call you asked about. A mission is created with studio_mission_create, for example:",
  "",
  "```json",
  `{"mission":{"id":"${MISSION}","title":"Guard"},"dryRun":true}`,
  "```",
  "",
  "```",
  TEXT_CALL,
  "```",
  "",
  'Inline it looks like {"dryRun": true}. Tell me when to run it.',
].join("\n")

it.instance("an ordinary answer with a JSON example and a fenced call exits exactly as before", () =>
  Effect.gen(function* () {
    studio.tools = withCreate
    const { llm, prompt, sessions, chat } = yield* start()
    runningRow(chat.id)
    yield* llm.text(ORDINARY)
    yield* llm.text("never requested")

    const result = yield* prompt.loop({ sessionID: chat.id })

    expect(yield* llm.hits).toHaveLength(1)
    expect(studio.calls).toBe(0)
    const msgs = yield* sessions.messages({ sessionID: chat.id })
    expect(msgs.filter((msg) => msg.info.role === "user")).toHaveLength(1)
    expect(textOf(result)).toBe(ORDINARY)
    expect(finishOf(result)).toBe("stop")
    expect(errorOf(result)).toBeUndefined()
  }),
)
