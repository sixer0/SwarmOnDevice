import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { eq } from "drizzle-orm"
import { EventV2Bridge } from "@/event-v2-bridge"
import { expect, mock } from "bun:test"
import { Cause, Deferred, Duration, Effect, Exit, Fiber, Layer, Logger } from "effect"
import path from "path"
import { fileURLToPath } from "url"
import { NamedError } from "@opencode-ai/core/util/error"
import { Agent as AgentSvc } from "../../src/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Command } from "../../src/command"
import { Config } from "@/config/config"
import { LSP } from "@/lsp/lsp"
import { MCP } from "../../src/mcp"
import { Permission } from "../../src/permission"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { QuestionID } from "../../src/question/schema"
import { Plugin } from "../../src/plugin"
import { Provider as ProviderSvc } from "@/provider/provider"
import { Env } from "../../src/env"
import { Git } from "../../src/git"
import { Image } from "../../src/image/image"

import { Question } from "../../src/question"
import { Todo } from "../../src/session/todo"
import { Session } from "@/session/session"
import { SessionSpend } from "@/session/spend"
import { LateAnswer } from "@/session/late-answer"
import { RunLease } from "@/session/run-lease"
import { SessionResume } from "@/session/resume"
import { Global } from "@opencode-ai/core/global"
import { ProjectTrust } from "@opencode-ai/core/project/trust"
import { mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { SessionMessageTable } from "@opencode-ai/core/session/sql"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { SessionCompaction } from "../../src/session/compaction"
import { SessionSummary } from "../../src/session/summary"
import { Instruction } from "../../src/session/instruction"
import { SessionProcessor } from "../../src/session/processor"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionRevert } from "../../src/session/revert"
import { SessionRunState } from "../../src/session/run-state"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { Skill } from "../../src/skill"
import { LibraryRoot } from "../../src/skill/library-root"
import { SystemPrompt } from "../../src/session/system"
import { Shell } from "@opencode-ai/core/shell"
import { Snapshot } from "../../src/snapshot"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Format } from "../../src/format"
import { TestInstance } from "../fixture/fixture"
import { awaitWithTimeout, pollWithTimeout, testEffect } from "../lib/effect"
import { reply, TestLLMServer } from "../lib/llm-server"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { LocationServiceMap, locationServiceMapLayer } from "@opencode-ai/core/location-services"

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

function withSh<A, E, R>(fx: () => Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const prev = process.env.SHELL
      process.env.SHELL = "/bin/sh"
      Shell.preferred.reset()
      return prev
    }),
    () => fx(),
    (prev) =>
      Effect.sync(() => {
        if (prev === undefined) delete process.env.SHELL
        else process.env.SHELL = prev
        Shell.preferred.reset()
      }),
  )
}

function toolPart(parts: SessionV1.Part[]) {
  return parts.find((part): part is SessionV1.ToolPart => part.type === "tool")
}

type CompletedToolPart = SessionV1.ToolPart & { state: SessionV1.ToolStateCompleted }
type ErrorToolPart = SessionV1.ToolPart & { state: SessionV1.ToolStateError }

function completedTool(parts: SessionV1.Part[]) {
  const part = toolPart(parts)
  expect(part?.state.status).toBe("completed")
  return part?.state.status === "completed" ? (part as CompletedToolPart) : undefined
}

function errorTool(parts: SessionV1.Part[]) {
  const part = toolPart(parts)
  expect(part?.state.status).toBe("error")
  return part?.state.status === "error" ? (part as ErrorToolPart) : undefined
}

function makeMcp(
  instructions: MCP.ServerInstructions[] = [],
  prompts: Effect.Success<ReturnType<MCP.Interface["prompts"]>> = {},
) {
  return Layer.succeed(
    MCP.Service,
    MCP.Service.of({
      status: () => Effect.succeed({}),
      clients: () => Effect.succeed({}),
      instructions: () => Effect.succeed(instructions),
      tools: () => Effect.succeed({}),
      prompts: () => Effect.succeed(prompts),
      resources: () => Effect.succeed({}),
      resourceTemplates: () => Effect.succeed({}),
      add: () => Effect.succeed({ status: { status: "disabled" as const } }),
      connect: () => Effect.void,
      disconnect: () => Effect.void,
      getPrompt: () => Effect.succeed(undefined),
      readResource: () => Effect.succeed(undefined),
      startAuth: () => Effect.die("unexpected MCP auth in prompt-effect tests"),
      authenticate: () => Effect.die("unexpected MCP auth in prompt-effect tests"),
      finishAuth: () => Effect.die("unexpected MCP auth in prompt-effect tests"),
      removeAuth: () => Effect.void,
      supportsOAuth: () => Effect.succeed(false),
      hasStoredTokens: () => Effect.succeed(false),
      getAuthStatus: () => Effect.succeed("not_authenticated" as const),
    }),
  )
}

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

const processorCreateStarted: Array<() => void> = []
const blockingProcessor = Layer.succeed(
  SessionProcessor.Service,
  SessionProcessor.Service.of({
    create: () => Effect.sync(() => processorCreateStarted.shift()?.()).pipe(Effect.andThen(Effect.never)),
  }),
)

const runtimeFlags = RuntimeFlags.layer({ experimentalEventSystem: true })

const testLLMServerNode = LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] })

const promptRoot = LayerNode.group([
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
])

function makePrompt(input?: {
  mcpInstructions?: MCP.ServerInstructions[]
  mcpPrompts?: Effect.Success<ReturnType<MCP.Interface["prompts"]>>
  processor?: "blocking"
}) {
  const replacements = [
    [SessionSummary.node, summary],
    [LSP.node, lsp],
    [MCP.node, makeMcp(input?.mcpInstructions, input?.mcpPrompts)],
    [RuntimeFlags.node, runtimeFlags],
  ] as const
  if (input?.processor === "blocking") {
    return LayerNode.compile(promptRoot, [...replacements, [SessionProcessor.node, blockingProcessor]])
  }
  return LayerNode.compile(promptRoot, replacements)
}

function makeHttp(input?: { mcpInstructions?: MCP.ServerInstructions[]; processor?: "blocking" }) {
  const root = LayerNode.group([promptRoot, testLLMServerNode])
  const replacements = [
    [SessionSummary.node, summary],
    [LSP.node, lsp],
    [MCP.node, makeMcp(input?.mcpInstructions)],
    [RuntimeFlags.node, runtimeFlags],
  ] as const
  if (input?.processor === "blocking") {
    return LayerNode.compile(root, [...replacements, [SessionProcessor.node, blockingProcessor]])
  }
  return LayerNode.compile(root, replacements)
}

function makeHttpNoLLMServer(input?: { mcpInstructions?: MCP.ServerInstructions[]; processor?: "blocking" }) {
  return makePrompt(input)
}

const it = testEffect(makeHttp())
const noLLMServer = testEffect(makeHttpNoLLMServer())
const raceNoLLMServer = testEffect(makeHttpNoLLMServer({ processor: "blocking" }))
const withMcpInstructions = testEffect(
  makeHttp({
    mcpInstructions: [
      {
        name: "guide-server",
        instructions: "Use lookup before mutate.",
        tools: ["guide-server_lookup"],
      },
    ],
  }),
)
const unix = process.platform !== "win32" ? it.instance : it.instance.skip
const unixNoLLMServer = process.platform !== "win32" ? noLLMServer.instance : noLLMServer.instance.skip

// Config that registers a custom "test" provider with a "test-model" model
// so provider model lookup succeeds inside the loop.
const cfg = {
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
      options: {
        apiKey: "test-key",
        baseURL: "http://localhost:1/v1",
      },
    },
  },
}

function providerCfg(url: string) {
  return {
    ...cfg,
    provider: {
      ...cfg.provider,
      test: {
        ...cfg.provider.test,
        options: {
          ...cfg.provider.test.options,
          baseURL: url,
        },
      },
    },
  }
}

const writeText = Effect.fn("test.writeText")(function* (file: string, text: string) {
  const fs = yield* FSUtil.Service
  yield* fs.writeWithDirs(file, text)
})

const writeConfig = Effect.fn("test.writeConfig")(function* (dir: string, config: Partial<ConfigV1.Info>) {
  yield* writeText(
    path.join(dir, "swarm.json"),
    JSON.stringify({ $schema: "https://opencode.ai/config.json", ...config }),
  )
})

const useServerConfig = Effect.fn("test.useServerConfig")(function* (config: (url: string) => Partial<ConfigV1.Info>) {
  const { directory: dir } = yield* TestInstance
  const llm = yield* TestLLMServer
  yield* writeConfig(dir, config(llm.url))
  return { dir, llm }
})

// Wait for a session's runner to enter a busy state. SessionStatus is flipped
// inside Runner.startShell's serialized transition, so cancel can't no-op once
// we observe it.
const waitForBusy = (sessionID: SessionID, duration: Duration.Input = "2 seconds") =>
  pollWithTimeout(
    Effect.gen(function* () {
      const status = yield* SessionStatus.Service
      const s = yield* status.get(sessionID)
      return s.type === "busy" ? (true as const) : undefined
    }),
    `session ${sessionID} never became busy`,
    duration,
  )

const hasBash = Effect.sync(() => Bun.which("bash") !== null)

const deferredAsPromise = <A>(deferred: Deferred.Deferred<A>): PromiseLike<A> => ({
  then: (onfulfilled, onrejected) => {
    Effect.runFork(
      Deferred.await(deferred).pipe(
        Effect.match({
          onFailure: (error) => {
            onrejected?.(error)
          },
          onSuccess: (value) => {
            onfulfilled?.(value)
          },
        }),
      ),
    )
    return deferredAsPromise(deferred) as PromiseLike<never>
  },
})

function defer<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const succeedVoid = (deferred: Deferred.Deferred<void>) => {
  Effect.runSync(Deferred.succeed(deferred, void 0).pipe(Effect.ignore))
}

const user = Effect.fn("test.user")(function* (sessionID: SessionID, text: string) {
  const session = yield* Session.Service
  const msg = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: msg.id,
    sessionID,
    type: "text",
    text,
  })
  return msg
})

const seed = Effect.fn("test.seed")(function* (sessionID: SessionID, opts?: { finish?: string }) {
  const session = yield* Session.Service
  const msg = yield* user(sessionID, "hello")
  const assistant: SessionV1.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    parentID: msg.id,
    sessionID,
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    time: { created: Date.now() },
    ...(opts?.finish ? { finish: opts.finish } : {}),
  }
  yield* session.updateMessage(assistant)
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: assistant.id,
    sessionID,
    type: "text",
    text: "hi there",
  })
  return { user: msg, assistant }
})

const addSubtask = (sessionID: SessionID, messageID: MessageID, model = ref) =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    yield* session.updatePart({
      id: PartID.ascending(),
      messageID,
      sessionID,
      type: "subtask",
      prompt: "look into the cache key path",
      description: "inspect bug",
      agent: "general",
      model,
    })
  })

const boot = Effect.fn("test.boot")(function* (input?: { title?: string }) {
  const config = yield* Config.Service
  const prompt = yield* SessionPrompt.Service
  const run = yield* SessionRunState.Service
  const sessions = yield* Session.Service
  yield* config.get()
  const chat = yield* sessions.create(input ?? { title: "Pinned" })
  return { prompt, run, sessions, chat }
})

// Loop semantics

noLLMServer.instance(
  "loop exits immediately when last assistant has stop finish",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* seed(chat.id, { finish: "stop" })

      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")
      if (result.info.role === "assistant") expect(result.info.finish).toBe("stop")
    }),
  { config: cfg },
)

noLLMServer.instance(
  "loop exits for a completed parent turn with nonmonotonic message IDs",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      const userID = MessageID.make("msg_z_user")
      const assistantID = MessageID.make("msg_a_assistant")
      yield* sessions.updateMessage({
        id: userID,
        role: "user",
        sessionID: chat.id,
        agent: "build",
        model: ref,
        time: { created: 100 },
      })
      yield* sessions.updateMessage({
        id: assistantID,
        role: "assistant",
        parentID: userID,
        sessionID: chat.id,
        mode: "build",
        agent: "build",
        cost: 0,
        path: { cwd: "/tmp", root: "/tmp" },
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: ref.modelID,
        providerID: ref.providerID,
        time: { created: 200, completed: 201 },
        finish: "stop",
      })

      const result = yield* prompt.loop({ sessionID: chat.id })

      expect(result.info.id).toBe(assistantID)
    }),
  { config: cfg },
)

it.instance("loop exits without an LLM request for interrupted orphan tool calls", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })
    const seeded = yield* seed(chat.id, { finish: "stop" })
    yield* sessions.updatePart({
      id: PartID.ascending(),
      messageID: seeded.assistant.id,
      sessionID: chat.id,
      type: "tool",
      callID: "interrupted-call",
      tool: "edit",
      state: {
        status: "error",
        input: {},
        error: "Tool execution aborted",
        metadata: { interrupted: true },
        time: { start: 1, end: 2 },
      },
    })

    const result = yield* prompt.loop({ sessionID: chat.id })
    expect(result.info.id).toBe(seeded.assistant.id)
    expect(yield* llm.hits).toHaveLength(0)
  }),
)

it.instance("loop calls LLM and returns assistant message", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
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
      parts: [{ type: "text", text: "hello" }],
    })
    yield* llm.text("world")

    const result = yield* prompt.loop({ sessionID: chat.id })
    expect(result.info.role).toBe("assistant")
    const parts = result.parts.filter((p) => p.type === "text")
    expect(parts.some((p) => p.type === "text" && p.text === "world")).toBe(true)
    expect(yield* llm.hits).toHaveLength(1)
  }),
)

withMcpInstructions.instance(
  "loop includes MCP instructions in model system context",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* llm.hang
      yield* user(chat.id, "hello")

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* awaitWithTimeout(llm.wait(1), "timed out waiting for MCP instruction request", "10 seconds")

      const hits = yield* llm.hits
      const body = JSON.stringify(hits[0]?.body)
      expect(body).toContain('<server name=\\"guide-server\\">')
      expect(body).toContain("Use lookup before mutate.")
      yield* Fiber.interrupt(fiber)
    }),
  15_000,
)

it.instance("legacy prompt emits message events without session.next events", () =>
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({
      title: "Pinned",
      agent: "plan",
      model: { providerID: ProviderV2.ID.make("old"), id: ModelV2.ID.make("old-model") },
    })
    const seen: string[] = []
    const off = yield* events.listen((event) => {
      seen.push(event.type)
      return Effect.void
    })

    const first = yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      model: ref,
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })
    const second = yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "again" }],
    })
    yield* off

    expect(first.info.role).toBe("user")
    expect(second.info.role).toBe("user")
    if (first.info.role === "user" && second.info.role === "user") {
      expect(first.info.model).toEqual(ref)
      expect(second.info.model).toEqual(ref)
    }
    expect(yield* sessions.get(chat.id)).toMatchObject({
      agent: "build",
      model: { providerID: ref.providerID, id: ref.modelID },
    })
    expect(seen).toContain(Session.Event.Updated.type)
    expect(seen).toContain(MessageV2.Event.Updated.type)
    expect(seen).toContain(MessageV2.Event.PartUpdated.type)
    expect(seen.filter((type) => type.startsWith("session.next."))).toEqual([])
  }),
)

it.instance("loop surfaces content-filter finishes as session errors", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const events = yield* EventV2Bridge.Service
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })
    const errors: NonNullable<SessionV1.Assistant["error"]>[] = []
    const expected = {
      name: "ContentFilterError",
      data: { message: "The response was blocked by the provider's content filter" },
    } satisfies NonNullable<SessionV1.Assistant["error"]>
    const off = yield* events.listen((event) => {
      if (event.type !== Session.Event.Error.type) return Effect.void
      const data = event.data as typeof Session.Event.Error.data.Type
      if (data.sessionID === chat.id && data.error) errors.push(data.error)
      return Effect.void
    })

    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })
    yield* llm.push(reply().text("partial response").contentFilter())

    const result = yield* prompt.loop({ sessionID: chat.id })
    const stored = yield* MessageV2.get({ sessionID: chat.id, messageID: result.info.id })
    yield* off

    expect(yield* llm.hits).toHaveLength(1)
    expect(result.info.role).toBe("assistant")
    expect(stored.info.role).toBe("assistant")
    if (result.info.role === "assistant" && stored.info.role === "assistant") {
      expect(result.info.finish).toBe("content-filter")
      expect(result.info.error).toEqual(expected)
      expect(stored.info.error).toEqual(result.info.error)
      expect(errors).toContainEqual(expected)
    }
    expect(result.parts).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "text", text: "partial response" })]),
    )
  }),
)

it.instance("loop stops provider overflow instead of auto-compacting when disabled", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig((url) => ({
      ...providerCfg(url),
      compaction: { auto: false },
    }))
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })

    yield* llm.error(413, { error: { message: "request entity too large" } })
    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })

    const result = yield* prompt.loop({ sessionID: chat.id })
    const messages = yield* sessions.messages({ sessionID: chat.id })

    expect(result.info.role).toBe("assistant")
    if (result.info.role === "assistant") {
      expect(result.info.error?.name).toBe("ContextOverflowError")
      expect(result.info.finish).toBe("error")
    }
    expect(messages.some((message) => message.parts.some((part) => part.type === "compaction"))).toBe(false)
  }),
)

noLLMServer.instance.skip(
  "prompt emits v2 prompted and synthetic events (v2 projector disabled)",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })

      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        parts: [
          { type: "text", text: "hello v2" },
          {
            type: "file",
            mime: "text/plain",
            filename: "note.txt",
            url: "data:text/plain;base64,bm90ZSBjb250ZW50",
          },
        ],
      })

      const messages = yield* SessionV2.Service.use((session) => session.messages({ sessionID: chat.id })).pipe(
        Effect.provide(
          LayerNode.compile(SessionV2.node, [
            [SessionExecution.node, SessionExecution.noopLayer],
            [LocationServiceMap.node, locationServiceMapLayer],
          ]),
        ),
      )
      const { db } = yield* Database.Service
      const row = yield* db
        .select()
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, chat.id))
        .get()
        .pipe(Effect.orDie)
      expect(messages.find((message) => message.type === "user")).toMatchObject({ type: "user", text: "hello v2" })
      expect(typeof row?.data.time.created).toBe("number")
      expect(messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "synthetic", text: expect.stringContaining("Called the Read tool") }),
          expect.objectContaining({ type: "synthetic", text: "note content" }),
        ]),
      )
    }),
  { config: cfg },
)

it.instance("static loop returns assistant text through local provider", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "Prompt provider",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })

    yield* llm.text("world")

    const result = yield* prompt.loop({ sessionID: session.id })
    expect(result.info.role).toBe("assistant")
    expect(result.parts.some((part) => part.type === "text" && part.text === "world")).toBe(true)
    expect(yield* llm.hits).toHaveLength(1)
    expect(yield* llm.pending).toBe(0)
  }),
)

it.instance("static loop consumes queued replies across turns", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "Prompt provider turns",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello one" }],
    })

    yield* llm.text("world one")

    const first = yield* prompt.loop({ sessionID: session.id })
    expect(first.info.role).toBe("assistant")
    expect(first.parts.some((part) => part.type === "text" && part.text === "world one")).toBe(true)

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello two" }],
    })

    yield* llm.text("world two")

    const second = yield* prompt.loop({ sessionID: session.id })
    expect(second.info.role).toBe("assistant")
    expect(second.parts.some((part) => part.type === "text" && part.text === "world two")).toBe(true)

    expect(yield* llm.hits).toHaveLength(2)
    expect(yield* llm.pending).toBe(0)
  }),
)

it.instance("loop continues when finish is tool-calls", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "Pinned",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })
    yield* llm.tool("first", { value: "first" })
    yield* llm.text("second")

    const result = yield* prompt.loop({ sessionID: session.id })
    expect(yield* llm.calls).toBe(2)
    expect(result.info.role).toBe("assistant")
    if (result.info.role === "assistant") {
      expect(result.parts.some((part) => part.type === "text" && part.text === "second")).toBe(true)
      expect(result.info.finish).toBe("stop")
    }
  }),
)

it.instance("loop continues when finish is unknown", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "Pinned",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })
    yield* llm.push(reply())
    yield* llm.text("second")

    const result = yield* prompt.loop({ sessionID: session.id })
    expect(yield* llm.calls).toBe(2)
    expect(result.info.role).toBe("assistant")
    if (result.info.role === "assistant") {
      expect(result.parts.some((part) => part.type === "text" && part.text === "second")).toBe(true)
      expect(result.info.finish).toBe("stop")
    }
  }),
)

it.instance("glob tool keeps instance context during prompt runs", () =>
  Effect.gen(function* () {
    const { dir, llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "Glob context",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    const file = path.join(dir, "probe.txt")
    yield* writeText(file, "probe")

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "find text files" }],
    })
    yield* llm.tool("glob", { pattern: "**/*.txt" })
    yield* llm.text("done")

    const result = yield* prompt.loop({ sessionID: session.id })
    expect(result.info.role).toBe("assistant")

    const msgs = yield* MessageV2.filterCompactedEffect(session.id)
    const tool = msgs
      .flatMap((msg) => msg.parts)
      .find(
        (part): part is CompletedToolPart =>
          part.type === "tool" && part.tool === "glob" && part.state.status === "completed",
      )
    if (!tool) return

    expect(tool.state.output).toContain(file)
    expect(tool.state.output).not.toContain("No context found for instance")
    expect(result.parts.some((part) => part.type === "text" && part.text === "done")).toBe(true)
  }),
)

it.instance("loop continues when finish is stop but assistant has tool parts", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "Pinned",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })
    yield* llm.push(reply().tool("first", { value: "first" }).stop())
    yield* llm.text("second")

    const result = yield* prompt.loop({ sessionID: session.id })
    expect(yield* llm.calls).toBe(2)
    expect(result.info.role).toBe("assistant")
    if (result.info.role === "assistant") {
      expect(result.parts.some((part) => part.type === "text" && part.text === "second")).toBe(true)
      expect(result.info.finish).toBe("stop")
    }
  }),
)

it.instance("failed subtask preserves metadata on error tool state", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig((url) => ({
      ...providerCfg(url),
      // Baseline-aware grant: row 96 ships `"*": "ask"`, so dispatching the `task` tool would wait for
      // a consent answer this non-interactive test never gives. The case is about the error-state
      // metadata carried on the subtask tool part, so the config layer grants the dispatch; it is the
      // same layer that outranks the baseline seed. Consent behaviour has its own coverage elsewhere
      // (test/cli/run/run-process.test.ts "rejects requested permissions by default …").
      permission: { "*": "allow", task: "allow" },
      agent: {
        general: {
          model: "test/missing-model",
        },
      },
    }))
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })
    yield* llm.tool("task", {
      description: "inspect bug",
      prompt: "look into the cache key path",
      subagent_type: "general",
    })
    yield* llm.text("done")
    const msg = yield* user(chat.id, "hello")
    yield* addSubtask(chat.id, msg.id)

    const result = yield* prompt.loop({ sessionID: chat.id })
    expect(result.info.role).toBe("assistant")
    expect(yield* llm.calls).toBe(2)

    const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
    const taskMsg = msgs.find((item) => item.info.role === "assistant" && item.info.agent === "general")
    expect(taskMsg?.info.role).toBe("assistant")
    if (!taskMsg || taskMsg.info.role !== "assistant") return

    const tool = errorTool(taskMsg.parts)
    if (!tool) return

    expect(tool.state.error).toContain("Tool execution failed")
    expect(tool.state.metadata).toBeDefined()
    expect(tool.state.metadata?.sessionId).toBeDefined()
    expect(tool.state.metadata?.model).toEqual({
      providerID: ProviderV2.ID.make("test"),
      modelID: ModelV2.ID.make("missing-model"),
    })
  }),
)

it.instance("subtask child inherits parent session external_directory allow", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({
      title: "Parent",
      permission: [{ permission: "external_directory", pattern: "/tmp/allowed/*", action: "allow" }],
    })
    yield* llm.text("done")
    const msg = yield* user(chat.id, "hello")
    yield* addSubtask(chat.id, msg.id)

    yield* prompt.loop({ sessionID: chat.id })

    const kids = yield* sessions.children(chat.id)
    expect(kids).toHaveLength(1)
    const child = kids[0]!
    const rules = child.permission ?? []
    expect(rules).toEqual(
      expect.arrayContaining([{ permission: "external_directory", pattern: "/tmp/allowed/*", action: "allow" }]),
    )
    expect(Permission.evaluate("external_directory", "/tmp/allowed/file", rules).action).toBe("allow")
    expect(Permission.evaluate("task", "anything", rules).action).toBe("deny")
  }),
)

noLLMServer.instance("prompt tools replace previous prompt tool rules", () =>
  Effect.gen(function* () {
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    // A noReply prompt still resolves a default model in createUserMessage, and Swarm ships no
    // provider out of the box: BASELINE_CONFIG disables the Zen providers
    // (packages/core/src/swarm-defaults.ts:18) and nothing else is configured, so the lookup that
    // used to land on Zen's public models now fails with ProviderNoProvidersError. This case is
    // about permission replacement, so it registers the local test provider like its siblings do and
    // keeps every assertion below unchanged.
    const { directory: dir } = yield* TestInstance
    yield* writeConfig(dir, cfg)
    const session = yield* sessions.create({ title: "Prompt tools" })

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      tools: { bash: false },
      parts: [{ type: "text", text: "first" }],
    })
    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      tools: { read: true },
      parts: [{ type: "text", text: "second" }],
    })

    const reloaded = yield* sessions.get(session.id)
    expect(reloaded.permission).toEqual([{ permission: "read", pattern: "*", action: "allow" }])
    expect(Permission.evaluate("bash", "anything", reloaded.permission ?? []).action).toBe("ask")
  }),
)

it.instance(
  "running subtask preserves metadata after tool-call transition",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* llm.hang
      const msg = yield* user(chat.id, "hello")
      yield* addSubtask(chat.id, msg.id)

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)

      const tool = yield* pollWithTimeout(
        Effect.gen(function* () {
          const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
          const taskMsg = msgs.find((item) => item.info.role === "assistant" && item.info.agent === "general")
          const tool = taskMsg?.parts.find((part): part is SessionV1.ToolPart => part.type === "tool")
          if (tool?.state.status === "running" && tool.state.metadata?.sessionId) return tool
        }),
        "timed out waiting for running subtask metadata",
      )

      if (tool.state.status !== "running") return
      expect(typeof tool.state.metadata?.sessionId).toBe("string")
      expect(tool.state.title).toBeDefined()
      expect(tool.state.metadata?.model).toBeDefined()

      yield* prompt.cancel(chat.id)
      yield* Fiber.await(fiber)
    }),
  5_000,
)

it.instance(
  "running task tool preserves metadata after tool-call transition",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* llm.tool("task", {
        description: "inspect bug",
        prompt: "look into the cache key path",
        subagent_type: "general",
      })
      yield* llm.hang
      yield* user(chat.id, "hello")

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)

      const tool = yield* pollWithTimeout(
        Effect.gen(function* () {
          const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
          const assistant = msgs.findLast((item) => item.info.role === "assistant" && item.info.agent === "build")
          const tool = assistant?.parts.find(
            (part): part is SessionV1.ToolPart => part.type === "tool" && part.tool === "task",
          )
          if (tool?.state.status === "running" && tool.state.metadata?.sessionId) return tool
        }),
        "timed out waiting for running task metadata",
      )

      if (tool.state.status !== "running") return
      expect(typeof tool.state.metadata?.sessionId).toBe("string")
      expect(tool.state.title).toBe("inspect bug")
      expect(tool.state.metadata?.model).toBeDefined()

      yield* prompt.cancel(chat.id)
      yield* Fiber.await(fiber)
    }),
  10_000,
)

it.instance(
  "loop sets status to busy then idle",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const status = yield* SessionStatus.Service

      yield* llm.hang

      const chat = yield* sessions.create({})
      yield* user(chat.id, "hi")

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* llm.wait(1)
      expect((yield* status.get(chat.id)).type).toBe("busy")
      yield* prompt.cancel(chat.id)
      yield* Fiber.await(fiber)
      expect((yield* status.get(chat.id)).type).toBe("idle")
    }),
  3_000,
)

// Cancel semantics

it.instance("cancel interrupts loop and resolves with an assistant message", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })
    yield* seed(chat.id)

    yield* llm.hang

    yield* user(chat.id, "more")

    const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
    yield* llm.wait(1)
    yield* waitForBusy(chat.id)
    yield* prompt.cancel(chat.id)
    const exit = yield* Fiber.await(fiber)
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      expect(exit.value.info.role).toBe("assistant")
    }
  }),
)

it.instance("cancel records MessageAbortedError on interrupted process", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })
    yield* llm.hang
    yield* user(chat.id, "hello")

    const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
    yield* llm.wait(1)
    yield* waitForBusy(chat.id)
    yield* prompt.cancel(chat.id)
    const exit = yield* Fiber.await(fiber)
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      const info = exit.value.info
      if (info.role === "assistant") {
        expect(info.error?.name).toBe("MessageAbortedError")
      }
    }
  }),
)

raceNoLLMServer.instance(
  "finalizes assistant when cancelled before processor creation completes",
  () =>
    Effect.gen(function* () {
      processorCreateStarted.length = 0
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          processorCreateStarted.length = 0
        }),
      )

      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Processor creation race" })

      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "first" }],
      })

      const firstCreate = defer<void>()
      processorCreateStarted.push(firstCreate.resolve)
      const first = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* Effect.promise(() => firstCreate.promise)

      yield* prompt.cancel(chat.id)
      const firstExit = yield* Fiber.await(first)
      expect(Exit.isSuccess(firstExit)).toBe(true)

      let messages = yield* sessions.messages({ sessionID: chat.id })
      const firstInterrupted = messages.at(-1)
      expect(firstInterrupted?.info.role).toBe("assistant")
      expect(firstInterrupted?.parts).toHaveLength(0)
      if (firstInterrupted?.info.role === "assistant") {
        expect(firstInterrupted.info.finish).toBeUndefined()
        expect(firstInterrupted.info.time.completed).toBeNumber()
        expect(firstInterrupted.info.error?.name).toBe("MessageAbortedError")
      }

      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "second" }],
      })

      const secondCreate = defer<void>()
      processorCreateStarted.push(secondCreate.resolve)
      const second = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* Effect.promise(() => secondCreate.promise)

      yield* prompt.cancel(chat.id)
      const secondExit = yield* Fiber.await(second)
      expect(Exit.isSuccess(secondExit)).toBe(true)

      messages = yield* sessions.messages({ sessionID: chat.id })
      const poisonMessages = messages.filter(
        (message) =>
          message.info.role === "assistant" &&
          message.parts.length === 0 &&
          !message.info.finish &&
          !message.info.time.completed &&
          !message.info.error,
      )
      expect(poisonMessages).toHaveLength(0)

      const interruptedMessages = messages.filter(
        (message) =>
          message.info.role === "assistant" &&
          message.parts.length === 0 &&
          message.info.time.completed &&
          message.info.error?.name === "MessageAbortedError",
      )
      expect(interruptedMessages).toHaveLength(2)

      const lastUser = messages.at(-2)
      const lastAssistant = messages.at(-1)
      expect(lastUser?.info.role).toBe("user")
      expect(lastAssistant?.info.role).toBe("assistant")
      if (lastUser?.info.role === "user" && lastAssistant?.info.role === "assistant") {
        expect(lastAssistant.info.parentID).toBe(lastUser?.info.id)
      }
    }),
  { config: cfg },
  3_000,
)

noLLMServer.instance(
  "cancel finalizes subtask tool state",
  () =>
    Effect.gen(function* () {
      const ready = yield* Deferred.make<void>()
      const aborted = yield* Deferred.make<void>()
      const registry = yield* ToolRegistry.Service
      const { task } = yield* registry.named()
      const original = task.execute
      task.execute = (_args, ctx) =>
        Effect.callback<never>((_resume) => {
          ctx.abort.addEventListener("abort", () => succeedVoid(aborted), { once: true })
          if (ctx.abort.aborted) succeedVoid(aborted)
          succeedVoid(ready)
          return Effect.sync(() => succeedVoid(aborted))
        })
      yield* Effect.addFinalizer(() => Effect.sync(() => void (task.execute = original)))

      const { prompt, chat } = yield* boot()
      const msg = yield* user(chat.id, "hello")
      yield* addSubtask(chat.id, msg.id)

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* awaitWithTimeout(Deferred.await(ready), "timed out waiting for task tool to start", "10 seconds")
      yield* prompt.cancel(chat.id)

      const exit = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)
      yield* awaitWithTimeout(Deferred.await(aborted), "timed out waiting for task tool abort", "10 seconds")

      const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
      const taskMsg = msgs.find((item) => item.info.role === "assistant" && item.info.agent === "general")
      expect(taskMsg?.info.role).toBe("assistant")
      if (!taskMsg || taskMsg.info.role !== "assistant") return

      const tool = toolPart(taskMsg.parts)
      expect(tool?.type).toBe("tool")
      if (!tool) return

      expect(tool.state.status).not.toBe("running")
      expect(taskMsg.info.time.completed).toBeDefined()
      expect(taskMsg.info.finish).toBeDefined()
    }),
  { config: cfg },
  30_000,
)

it.instance(
  "cancel propagates from slash command subtask to child session",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const status = yield* SessionStatus.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* llm.hang
      const msg = yield* user(chat.id, "hello")
      yield* addSubtask(chat.id, msg.id)

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* llm.wait(1)

      const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
      const taskMsg = msgs.find((item) => item.info.role === "assistant" && item.info.agent === "general")
      const tool = taskMsg ? toolPart(taskMsg.parts) : undefined
      const sessionID = tool?.state.status === "running" ? tool.state.metadata?.sessionId : undefined
      expect(typeof sessionID).toBe("string")
      if (typeof sessionID !== "string") throw new Error("missing child session id")
      const childID = SessionID.make(sessionID)
      expect((yield* status.get(childID)).type).toBe("busy")

      yield* prompt.cancel(chat.id)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)

      expect((yield* status.get(chat.id)).type).toBe("idle")
      expect((yield* status.get(childID)).type).toBe("idle")
    }),
  10_000,
)

it.instance(
  "cancel with queued callers resolves all cleanly",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* llm.hang
      yield* user(chat.id, "hello")

      const a = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* llm.wait(1)
      const b = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* Effect.sleep(50)

      yield* prompt.cancel(chat.id)
      const [exitA, exitB] = yield* Effect.all([Fiber.await(a), Fiber.await(b)])
      expect(Exit.isSuccess(exitA)).toBe(true)
      expect(Exit.isSuccess(exitB)).toBe(true)
      if (Exit.isSuccess(exitA) && Exit.isSuccess(exitB)) {
        expect(exitA.value.info.id).toBe(exitB.value.info.id)
      }
    }),
  { git: true },
  10_000,
)

// Queue semantics

noLLMServer.instance("concurrent loop callers get same result", () =>
  Effect.gen(function* () {
    const { prompt, run, chat } = yield* boot()
    yield* seed(chat.id, { finish: "stop" })

    const [a, b] = yield* Effect.all([prompt.loop({ sessionID: chat.id }), prompt.loop({ sessionID: chat.id })], {
      concurrency: "unbounded",
    })

    expect(a.info.id).toBe(b.info.id)
    expect(a.info.role).toBe("assistant")
    yield* run.assertNotBusy(chat.id)
  }),
)

it.instance("concurrent loop callers all receive same error result", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })

    yield* llm.fail("boom")
    yield* user(chat.id, "hello")

    const [a, b] = yield* Effect.all([prompt.loop({ sessionID: chat.id }), prompt.loop({ sessionID: chat.id })], {
      concurrency: "unbounded",
    })
    expect(a.info.id).toBe(b.info.id)
    expect(a.info.role).toBe("assistant")
  }),
)

it.instance("prompt submitted during an active run is included in the next LLM input", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const gate = yield* Deferred.make<void>()
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })

    yield* llm.hold("first", deferredAsPromise(gate))
    yield* llm.text("second")

    const a = yield* prompt
      .prompt({
        sessionID: chat.id,
        agent: "build",
        model: ref,
        parts: [{ type: "text", text: "first" }],
      })
      .pipe(Effect.forkChild)

    yield* llm.wait(1)
    yield* waitForBusy(chat.id)

    const id = MessageID.ascending()
    const b = yield* prompt
      .prompt({
        sessionID: chat.id,
        messageID: id,
        agent: "build",
        model: ref,
        parts: [{ type: "text", text: "second" }],
      })
      .pipe(Effect.forkChild)

    yield* pollWithTimeout(
      sessions
        .messages({ sessionID: chat.id })
        .pipe(
          Effect.map((msgs) => (msgs.some((msg) => msg.info.role === "user" && msg.info.id === id) ? true : undefined)),
        ),
      "timed out waiting for second prompt to save",
    )

    yield* Deferred.succeed(gate, void 0)

    const [ea, eb] = yield* Effect.all([Fiber.await(a), Fiber.await(b)])
    expect(Exit.isSuccess(ea)).toBe(true)
    expect(Exit.isSuccess(eb)).toBe(true)
    expect(yield* llm.calls).toBe(2)

    const msgs = yield* sessions.messages({ sessionID: chat.id })
    const assistants = msgs.filter((msg) => msg.info.role === "assistant")
    expect(assistants).toHaveLength(2)
    const last = assistants.at(-1)
    if (!last || last.info.role !== "assistant") throw new Error("expected second assistant")
    expect(last.info.parentID).toBe(id)
    expect(last.parts.some((part) => part.type === "text" && part.text === "second")).toBe(true)

    const inputs = yield* llm.inputs
    expect(inputs).toHaveLength(2)
    const messages = inputs.at(-1)?.messages
    if (!Array.isArray(messages)) throw new Error("expected LLM messages")
    expect(messages.at(-1)).toEqual({ role: "user", content: "second" })
  }),
)

it.instance("assertNotBusy fails with BusyError when loop running", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const run = yield* SessionRunState.Service
    const sessions = yield* Session.Service
    yield* llm.hang

    const chat = yield* sessions.create({})
    yield* user(chat.id, "hi")

    const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
    yield* llm.wait(1)
    yield* waitForBusy(chat.id)

    const exit = yield* run.assertNotBusy(chat.id).pipe(Effect.exit)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(Cause.squash(exit.cause)).toBeInstanceOf(Session.BusyError)
      expect(Cause.squash(exit.cause)).toMatchObject({ _tag: "SessionBusyError", sessionID: chat.id })
    }

    yield* prompt.cancel(chat.id)
    yield* Fiber.await(fiber)
  }),
)

noLLMServer.instance("assertNotBusy succeeds when idle", () =>
  Effect.gen(function* () {
    const run = yield* SessionRunState.Service
    const sessions = yield* Session.Service

    const chat = yield* sessions.create({})
    const exit = yield* run.assertNotBusy(chat.id).pipe(Effect.exit)
    expect(Exit.isSuccess(exit)).toBe(true)
  }),
)

// Shell semantics

it.instance("shell rejects with BusyError when loop running", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })
    yield* llm.hang
    yield* user(chat.id, "hi")

    const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
    yield* llm.wait(1)
    yield* waitForBusy(chat.id)

    const exit = yield* prompt.shell({ sessionID: chat.id, agent: "build", command: "echo hi" }).pipe(Effect.exit)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(Cause.squash(exit.cause)).toBeInstanceOf(Session.BusyError)
      expect(Cause.squash(exit.cause)).toMatchObject({ _tag: "SessionBusyError", sessionID: chat.id })
    }

    yield* prompt.cancel(chat.id)
    yield* Fiber.await(fiber)
  }),
)

unixNoLLMServer(
  "shell captures stdout and stderr in completed tool output",
  () =>
    Effect.gen(function* () {
      const { prompt, run, chat } = yield* boot()
      const result = yield* prompt.shell({
        sessionID: chat.id,
        agent: "build",
        command: "printf out && printf err >&2",
      })

      expect(result.info.role).toBe("assistant")
      const tool = completedTool(result.parts)
      if (!tool) return

      expect(tool.state.output).toContain("out")
      expect(tool.state.output).toContain("err")
      expect(tool.state.metadata.output).toContain("out")
      expect(tool.state.metadata.output).toContain("err")
      yield* run.assertNotBusy(chat.id)
    }),
  { config: cfg },
)

unixNoLLMServer(
  "shell records the exit code so a failing command does not read as a pass",
  () =>
    Effect.gen(function* () {
      const { prompt, chat } = yield* boot()
      const failed = completedTool(
        (yield* prompt.shell({ sessionID: chat.id, agent: "build", command: "printf nope && exit 3" })).parts,
      )
      const passed = completedTool((yield* prompt.shell({ sessionID: chat.id, agent: "build", command: "true" })).parts)
      expect(failed?.state.metadata.exit).toBe(3)
      expect(passed?.state.metadata.exit).toBe(0)
    }),
  { config: cfg },
)

unixNoLLMServer(
  "shell completes a fast command on the preferred shell",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const { prompt, run, chat } = yield* boot()
      const result = yield* prompt.shell({
        sessionID: chat.id,
        agent: "build",
        command: "pwd",
      })

      expect(result.info.role).toBe("assistant")
      const tool = completedTool(result.parts)
      if (!tool) return

      expect(tool.state.input.command).toBe("pwd")
      expect(tool.state.output).toContain(dir)
      expect(tool.state.metadata.output).toContain(dir)
      yield* run.assertNotBusy(chat.id)
    }),
  { config: cfg },
)

unixNoLLMServer(
  "shell uses configured shell over env shell",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        if (!(yield* hasBash)) return

        const { prompt, chat } = yield* boot()
        const result = yield* prompt.shell({
          sessionID: chat.id,
          agent: "build",
          command: "[[ 1 -eq 1 ]] && printf configured",
        })

        const tool = completedTool(result.parts)
        if (!tool) return
        expect(tool.state.output).toContain("configured")
      }),
    ),
  { config: { ...cfg, shell: "bash" } },
  30_000,
)

unixNoLLMServer(
  "shell commands can change directory after startup",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        const { directory: dir } = yield* TestInstance
        const { prompt, run, chat } = yield* boot()
        const parent = path.dirname(dir)
        const result = yield* prompt.shell({
          sessionID: chat.id,
          agent: "build",
          command: "cd .. && pwd",
        })

        expect(result.info.role).toBe("assistant")
        const tool = completedTool(result.parts)
        if (!tool) return

        expect(tool.state.output).toContain(parent)
        expect(tool.state.metadata.output).toContain(parent)
        yield* run.assertNotBusy(chat.id)
      }),
    ),
  { config: cfg },
)

unixNoLLMServer(
  "shell lists files from the project directory",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const { prompt, run, chat } = yield* boot()
      yield* writeText(path.join(dir, "README.md"), "# e2e\n")

      const result = yield* prompt.shell({
        sessionID: chat.id,
        agent: "build",
        command: "command ls",
      })

      expect(result.info.role).toBe("assistant")
      const tool = completedTool(result.parts)
      if (!tool) return

      expect(tool.state.input.command).toBe("command ls")
      expect(tool.state.output).toContain("README.md")
      expect(tool.state.metadata.output).toContain("README.md")
      yield* run.assertNotBusy(chat.id)
    }),
  { config: cfg },
)

unixNoLLMServer(
  "shell captures stderr from a failing command",
  () =>
    Effect.gen(function* () {
      const { prompt, run, chat } = yield* boot()
      const result = yield* prompt.shell({
        sessionID: chat.id,
        agent: "build",
        command: "command -v __nonexistent_cmd_e2e__ || echo 'not found' >&2; exit 1",
      })

      expect(result.info.role).toBe("assistant")
      const tool = completedTool(result.parts)
      if (!tool) return

      expect(tool.state.output).toContain("not found")
      expect(tool.state.metadata.output).toContain("not found")
      yield* run.assertNotBusy(chat.id)
    }),
  { config: cfg },
)

unixNoLLMServer(
  "shell updates running metadata before process exit",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        const { prompt, chat } = yield* boot()

        const fiber = yield* prompt
          .shell({ sessionID: chat.id, agent: "build", command: "printf first && sleep 0.2 && printf second" })
          .pipe(Effect.forkChild)

        yield* pollWithTimeout(
          Effect.gen(function* () {
            const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
            const taskMsg = msgs.find((item) => item.info.role === "assistant")
            const tool = taskMsg ? toolPart(taskMsg.parts) : undefined
            if (tool?.state.status === "running" && tool.state.metadata?.output.includes("first")) return true
          }),
          "timed out waiting for running shell metadata",
        )

        const exit = yield* Fiber.await(fiber)
        expect(Exit.isSuccess(exit)).toBe(true)
      }),
    ),
  { config: cfg },
  30_000,
)

it.instance(
  "loop waits while shell runs and starts after shell exits",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* llm.text("after-shell")

      const sh = yield* prompt
        .shell({ sessionID: chat.id, agent: "build", command: "sleep 0.2" })
        .pipe(Effect.forkChild)
      yield* waitForBusy(chat.id)

      const loop = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* Effect.sleep(50)

      expect(yield* llm.calls).toBe(0)

      yield* Fiber.await(sh)
      const exit = yield* Fiber.await(loop)

      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isSuccess(exit)) {
        expect(exit.value.info.role).toBe("assistant")
        expect(exit.value.parts.some((part) => part.type === "text" && part.text === "after-shell")).toBe(true)
      }
      expect(yield* llm.calls).toBe(1)
    }),
  { git: true },
  10_000,
)

it.instance(
  "shell completion resumes queued loop callers",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* llm.text("done")

      const sh = yield* prompt
        .shell({ sessionID: chat.id, agent: "build", command: "sleep 0.2" })
        .pipe(Effect.forkChild)
      yield* waitForBusy(chat.id)

      const a = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      const b = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* Effect.sleep(50)

      expect(yield* llm.calls).toBe(0)

      yield* Fiber.await(sh)
      const [ea, eb] = yield* Effect.all([Fiber.await(a), Fiber.await(b)])

      expect(Exit.isSuccess(ea)).toBe(true)
      expect(Exit.isSuccess(eb)).toBe(true)
      if (Exit.isSuccess(ea) && Exit.isSuccess(eb)) {
        expect(ea.value.info.id).toBe(eb.value.info.id)
        expect(ea.value.info.role).toBe("assistant")
      }
      expect(yield* llm.calls).toBe(1)
    }),
  { git: true },
  10_000,
)

unix(
  "command ! expansion uses configured shell over env shell",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        if (!(yield* hasBash)) return
        const { llm } = yield* useServerConfig((url) => ({
          ...providerCfg(url),
          shell: "bash",
          command: {
            probe: {
              template: "Probe: !`[[ 1 -eq 1 ]] && printf configured`",
            },
          },
        }))

        const { prompt, chat } = yield* boot()
        yield* llm.text("done")

        const result = yield* prompt.command({
          sessionID: chat.id,
          command: "probe",
          arguments: "",
        })

        expect(result.info.role).toBe("assistant")
        const inputs = yield* llm.inputs
        expect(JSON.stringify(inputs.at(-1)?.messages)).toContain("configured")
      }),
    ),
  30_000,
)

unixNoLLMServer(
  "cancel interrupts shell and resolves cleanly",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        const { prompt, run, chat } = yield* boot()
        const { directory: dir } = yield* TestInstance
        const afs = yield* FSUtil.Service
        const ready = path.join(dir, ".shell-ready")

        const sh = yield* prompt
          .shell({ sessionID: chat.id, agent: "build", command: ": > '.shell-ready'; sleep 30" })
          .pipe(Effect.forkChild)
        yield* pollWithTimeout(
          afs.existsSafe(ready).pipe(Effect.map((exists) => (exists ? (true as const) : undefined))),
          "shell never created readiness marker",
        )

        yield* prompt.cancel(chat.id)

        const status = yield* SessionStatus.Service
        expect((yield* status.get(chat.id)).type).toBe("idle")
        const busy = yield* run.assertNotBusy(chat.id).pipe(Effect.exit)
        expect(Exit.isSuccess(busy)).toBe(true)

        const exit = yield* Fiber.await(sh)
        expect(Exit.isSuccess(exit)).toBe(true)
        if (Exit.isSuccess(exit)) {
          expect(exit.value.info.role).toBe("assistant")
          const tool = completedTool(exit.value.parts)
          if (tool) {
            expect(tool.state.output).toContain("User aborted the command")
          }
        }
      }),
    ),
  { git: true, config: cfg },
  30_000,
)

unixNoLLMServer(
  "cancel persists aborted shell result when shell ignores TERM",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        const { prompt, chat } = yield* boot()
        const { directory: dir } = yield* TestInstance
        const afs = yield* FSUtil.Service
        const ready = path.join(dir, ".trap-ready")

        const sh = yield* prompt
          .shell({
            sessionID: chat.id,
            agent: "build",
            // Touch marker AFTER trap installs so the test waits for the actual
            // ignore-TERM state before cancelling; otherwise SIGTERM can arrive
            // before `trap` runs and the escalation path is never exercised.
            command: `trap '' TERM; touch "${ready}"; sleep 30`,
          })
          .pipe(Effect.forkChild)

        yield* Effect.gen(function* () {
          while (!(yield* afs.existsSafe(ready))) {
            yield* Effect.sleep(Duration.millis(10))
          }
        }).pipe(Effect.timeout(Duration.seconds(5)))

        yield* prompt.cancel(chat.id)

        const exit = yield* Fiber.await(sh)
        expect(Exit.isSuccess(exit)).toBe(true)
        if (Exit.isSuccess(exit)) {
          expect(exit.value.info.role).toBe("assistant")
          const tool = completedTool(exit.value.parts)
          if (tool) {
            expect(tool.state.output).toContain("User aborted the command")
          }
        }
      }),
    ),
  { git: true, config: cfg },
  30_000,
)

unix(
  "cancel finalizes interrupted bash tool output through normal truncation",
  () =>
    Effect.gen(function* () {
      const { dir, llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Interrupted bash truncation",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })

      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "run bash" }],
      })

      yield* llm.tool("bash", {
        command:
          'i=0; while [ "$i" -lt 4000 ]; do printf "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx %05d\\n" "$i"; i=$((i + 1)); done; printf truncation-ready; sleep 30',
        timeout: 30_000,
        workdir: path.resolve(dir),
      })

      const run = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* llm.wait(1)
      yield* pollWithTimeout(
        Effect.gen(function* () {
          const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
          const assistant = msgs.findLast((item) => item.info.role === "assistant")
          const tool = assistant ? toolPart(assistant.parts) : undefined
          if (tool?.state.status === "running" && tool.state.metadata?.output.includes("truncation-ready")) return true
        }),
        "timed out waiting for truncated shell output",
      )
      yield* prompt.cancel(chat.id)

      const exit = yield* Fiber.await(run)
      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isFailure(exit)) return

      const tool = completedTool(exit.value.parts)
      if (!tool) return

      expect(tool.state.metadata.truncated).toBe(true)
      expect(typeof tool.state.metadata.outputPath).toBe("string")
      expect(tool.state.output).toMatch(/\.\.\.output truncated\.\.\./)
      expect(tool.state.output).toMatch(/Full output saved to:\s+\S+/)
      expect(tool.state.output).not.toContain("Tool execution aborted")
    }),
  { git: true },
  30_000,
)

unixNoLLMServer(
  "cancel interrupts loop queued behind shell",
  () =>
    Effect.gen(function* () {
      const { prompt, chat } = yield* boot()

      const sh = yield* prompt.shell({ sessionID: chat.id, agent: "build", command: "sleep 30" }).pipe(Effect.forkChild)
      yield* waitForBusy(chat.id)

      const loop = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* Effect.sleep(50)

      yield* prompt.cancel(chat.id)

      const exit = yield* Fiber.await(loop)
      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isSuccess(exit)) {
        const tool = completedTool(exit.value.parts)
        expect(tool?.state.output).toContain("User aborted the command")
      }

      yield* Fiber.await(sh)
    }),
  { git: true, config: cfg },
  30_000,
)

unixNoLLMServer(
  "shell rejects when another shell is already running",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        const { prompt, chat } = yield* boot()

        const a = yield* prompt
          .shell({ sessionID: chat.id, agent: "build", command: "sleep 30" })
          .pipe(Effect.forkChild)
        yield* waitForBusy(chat.id)

        const exit = yield* prompt.shell({ sessionID: chat.id, agent: "build", command: "echo hi" }).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.squash(exit.cause)).toBeInstanceOf(Session.BusyError)
        }

        yield* prompt.cancel(chat.id)
        yield* Fiber.await(a)
      }),
    ),
  { git: true, config: cfg },
  30_000,
)

// Abort signal propagation tests for inline tool execution

function hangUntilAborted(tool: { execute: (...args: any[]) => any }) {
  return Effect.gen(function* () {
    const ready = yield* Deferred.make<void>()
    const aborted = yield* Deferred.make<void>()
    const original = tool.execute
    tool.execute = (_args: any, ctx: any) => {
      ctx.abort.addEventListener("abort", () => succeedVoid(aborted), { once: true })
      if (ctx.abort.aborted) succeedVoid(aborted)
      succeedVoid(ready)
      return Effect.callback<never>(() => Effect.sync(() => succeedVoid(aborted)))
    }
    const restore = Effect.addFinalizer(() => Effect.sync(() => void (tool.execute = original)))
    return { ready, aborted, restore }
  })
}

noLLMServer.instance(
  "interrupt propagates abort signal to read tool via file part (text/plain)",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const registry = yield* ToolRegistry.Service
      const { read } = yield* registry.named()
      const { ready, restore } = yield* hangUntilAborted(read)
      yield* restore

      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Abort Test" })

      const testFile = path.join(dir, "test.txt")
      yield* writeText(testFile, "hello world")

      const fiber = yield* prompt
        .prompt({
          sessionID: chat.id,
          agent: "build",
          parts: [
            { type: "text", text: "read this" },
            { type: "file", url: `file://${testFile}`, filename: "test.txt", mime: "text/plain" },
          ],
        })
        .pipe(Effect.forkChild)

      yield* awaitWithTimeout(Deferred.await(ready), "timed out waiting for read tool to start", "10 seconds")
      yield* prompt.cancel(chat.id)
      yield* Fiber.interrupt(fiber)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  { config: cfg },
  30_000,
)

noLLMServer.instance(
  "interrupt propagates abort signal to read tool via file part (directory)",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const registry = yield* ToolRegistry.Service
      const { read } = yield* registry.named()
      const { ready, restore } = yield* hangUntilAborted(read)
      yield* restore

      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Abort Test" })

      const fiber = yield* prompt
        .prompt({
          sessionID: chat.id,
          agent: "build",
          parts: [
            { type: "text", text: "read this" },
            { type: "file", url: `file://${dir}`, filename: "dir", mime: "application/x-directory" },
          ],
        })
        .pipe(Effect.forkChild)

      yield* awaitWithTimeout(Deferred.await(ready), "timed out waiting for read tool to start", "10 seconds")
      yield* prompt.cancel(chat.id)
      yield* Fiber.interrupt(fiber)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  { config: cfg },
  30_000,
)

// Missing file handling

noLLMServer.instance(
  "does not fail the prompt when a file part is missing",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})

      const missing = path.join(dir, "does-not-exist.ts")
      const msg = yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [
          { type: "text", text: "please review @does-not-exist.ts" },
          {
            type: "file",
            mime: "text/plain",
            url: `file://${missing}`,
            filename: "does-not-exist.ts",
          },
        ],
      })

      if (msg.info.role !== "user") throw new Error("expected user message")
      const hasFailure = msg.parts.some(
        (part) => part.type === "text" && part.synthetic && part.text.includes("Read tool failed to read"),
      )
      expect(hasFailure).toBe(true)

      yield* sessions.remove(session.id)
    }),
  { config: cfg },
)

noLLMServer.instance(
  "keeps stored part order stable when file resolution is async",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})

      const missing = path.join(dir, "still-missing.ts")
      const msg = yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [
          {
            type: "file",
            mime: "text/plain",
            url: `file://${missing}`,
            filename: "still-missing.ts",
          },
          { type: "text", text: "after-file" },
        ],
      })

      if (msg.info.role !== "user") throw new Error("expected user message")

      const stored = yield* MessageV2.get({
        sessionID: session.id,
        messageID: msg.info.id,
      })
      const text = stored.parts.filter((part) => part.type === "text").map((part) => part.text)

      expect(text[0]?.startsWith("Called the Read tool with the following input:")).toBe(true)
      expect(text[1]?.includes("Read tool failed to read")).toBe(true)
      expect(text[2]).toBe("after-file")

      yield* sessions.remove(session.id)
    }),
  { config: cfg },
)

// Special characters in filenames

noLLMServer.instance(
  "handles filenames with # character",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      yield* writeText(path.join(dir, "file#name.txt"), "special content\n")

      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})
      const parts = yield* prompt.resolvePromptParts("Read @file#name.txt")
      const fileParts = parts.filter((part) => part.type === "file")

      expect(fileParts.length).toBe(1)
      expect(fileParts[0].filename).toBe("file#name.txt")
      expect(fileParts[0].url).toContain("%23")

      const decodedPath = fileURLToPath(fileParts[0].url)
      expect(decodedPath).toBe(path.join(dir, "file#name.txt"))

      const message = yield* prompt.prompt({
        sessionID: session.id,
        parts,
        noReply: true,
      })
      const stored = yield* MessageV2.get({ sessionID: session.id, messageID: message.info.id })
      const textParts = stored.parts.filter((part) => part.type === "text")
      const hasContent = textParts.some((part) => part.text.includes("special content"))
      expect(hasContent).toBe(true)

      yield* sessions.remove(session.id)
    }),
  { git: true, config: cfg },
)

// Regression: empty assistant turn loop

it.instance("does not loop empty assistant turns for a simple reply", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({ title: "Prompt regression" })

    yield* llm.text("packages/opencode/src/session/processor.ts")

    const result = yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      parts: [{ type: "text", text: "Where is SessionProcessor?" }],
    })

    expect(result.info.role).toBe("assistant")
    expect(result.parts.some((part) => part.type === "text" && part.text.includes("processor.ts"))).toBe(true)

    const msgs = yield* sessions.messages({ sessionID: session.id })
    expect(msgs.filter((msg) => msg.info.role === "assistant")).toHaveLength(1)
    expect(yield* llm.calls).toBe(1)
  }),
)

it.instance("records aborted errors when prompt is cancelled mid-stream", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({ title: "Prompt cancel regression" })

    yield* llm.hang

    const fiber = yield* prompt
      .prompt({
        sessionID: session.id,
        agent: "build",
        parts: [{ type: "text", text: "Cancel me" }],
      })
      .pipe(Effect.forkChild)

    yield* llm.wait(1)
    yield* waitForBusy(session.id)
    yield* prompt.cancel(session.id)

    const exit = yield* Fiber.await(fiber)
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      expect(exit.value.info.role).toBe("assistant")
      if (exit.value.info.role === "assistant") {
        expect(exit.value.info.error?.name).toBe("MessageAbortedError")
      }
    }

    const msgs = yield* sessions.messages({ sessionID: session.id })
    const last = msgs.findLast((msg) => msg.info.role === "assistant")
    expect(last?.info.role).toBe("assistant")
    if (last?.info.role === "assistant") {
      expect(last.info.error?.name).toBe("MessageAbortedError")
    }
  }),
)

// Agent variant

noLLMServer.instance(
  "applies agent variant only when using agent model",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})

      const other = yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        model: { providerID: ProviderV2.ID.make("opencode"), modelID: ModelV2.ID.make("kimi-k2.5-free") },
        noReply: true,
        parts: [{ type: "text", text: "hello" }],
      })
      if (other.info.role !== "user") throw new Error("expected user message")
      expect(other.info.model.variant).toBeUndefined()

      const match = yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "hello again" }],
      })
      if (match.info.role !== "user") throw new Error("expected user message")
      expect(match.info.model).toEqual({
        providerID: ProviderV2.ID.make("test"),
        modelID: ModelV2.ID.make("test-model"),
        variant: "xhigh",
      })
      expect(match.info.model.variant).toBe("xhigh")

      const override = yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        variant: "high",
        parts: [{ type: "text", text: "hello third" }],
      })
      if (override.info.role !== "user") throw new Error("expected user message")
      expect(override.info.model.variant).toBe("high")

      yield* sessions.remove(session.id)
    }),
  {
    config: {
      ...cfg,
      provider: {
        ...cfg.provider,
        test: {
          ...cfg.provider.test,
          models: {
            "test-model": {
              ...cfg.provider.test.models["test-model"],
              variants: { xhigh: {}, high: {} },
            },
          },
        },
      },
      agent: {
        build: {
          model: "test/test-model",
          variant: "xhigh",
        },
      },
    },
  },
)

// Agent / command resolution errors

noLLMServer.instance(
  "unknown agent throws typed error",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})
      const exit = yield* prompt
        .prompt({
          sessionID: session.id,
          agent: "nonexistent-agent-xyz",
          noReply: true,
          parts: [{ type: "text", text: "hello" }],
        })
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const err = Cause.squash(exit.cause)
        expect(err).not.toBeInstanceOf(TypeError)
        expect(NamedError.Unknown.isInstance(err)).toBe(true)
        if (NamedError.Unknown.isInstance(err)) {
          expect(err.data.message).toContain('Agent not found: "nonexistent-agent-xyz"')
        }
      }
    }),
  30_000,
)

noLLMServer.instance(
  "unknown agent error includes available agent names",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})
      const exit = yield* prompt
        .prompt({
          sessionID: session.id,
          agent: "nonexistent-agent-xyz",
          noReply: true,
          parts: [{ type: "text", text: "hello" }],
        })
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const err = Cause.squash(exit.cause)
        expect(NamedError.Unknown.isInstance(err)).toBe(true)
        if (NamedError.Unknown.isInstance(err)) {
          expect(err.data.message).toContain("build")
        }
      }
    }),
  30_000,
)

noLLMServer.instance(
  "unknown command throws typed error with available names",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})
      const exit = yield* prompt
        .command({
          sessionID: session.id,
          command: "nonexistent-command-xyz",
          arguments: "",
        })
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const err = Cause.squash(exit.cause)
        expect(err).not.toBeInstanceOf(TypeError)
        expect(NamedError.Unknown.isInstance(err)).toBe(true)
        if (NamedError.Unknown.isInstance(err)) {
          expect(err.data.message).toContain('Command not found: "nonexistent-command-xyz"')
          expect(err.data.message).toContain("init")
        }
      }
    }),
  30_000,
)

// Spend limit, cold-cache pruning and system prompt stability

const spent = Effect.fn("test.spent")(function* (sessionID: SessionID, cost: number, finish = "tool-calls") {
  const sessions = yield* Session.Service
  const seeded = yield* seed(sessionID, { finish })
  yield* sessions.updateMessage({ ...seeded.assistant, cost, time: { created: Date.now(), completed: Date.now() } })
  yield* sessions.updatePart({
    id: PartID.ascending(),
    messageID: seeded.assistant.id,
    sessionID,
    type: "step-finish",
    reason: finish,
    cost,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  })
  return seeded
})

const waitForAsk = Effect.fn("test.waitForAsk")(function* (permission: string) {
  const service = yield* Permission.Service
  return yield* pollWithTimeout(
    service.list().pipe(Effect.map((list) => list.find((item) => item.permission === permission))),
    "timed out waiting for the spend limit to ask",
  )
})

const allowAll = [{ permission: "*", pattern: "*", action: "allow" as const }]
const paidCost = { input: 5, output: 25 }

// The same provider with a price on its model, since only a request that costs money can be held.
function paidCfg(url: string) {
  const base = providerCfg(url)
  return {
    ...base,
    provider: {
      test: {
        ...base.provider.test,
        models: { "test-model": { ...base.provider.test.models["test-model"], cost: paidCost } },
      },
    },
  }
}

it.instance("a model with no price never pauses, however much paid models spent in the same run", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig((url) => ({ ...providerCfg(url), spend_limit: 1 }))
    const prompt = yield* SessionPrompt.Service
    const service = yield* Permission.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned", permission: allowAll })
    yield* spent(chat.id, 500)
    yield* llm.text("done")
    const result = yield* prompt.loop({ sessionID: chat.id })
    expect(result.parts.some((part) => part.type === "text" && part.text === "done")).toBe(true)
    expect(yield* service.list()).toEqual([])
  }),
)

it.instance("the limit counts what was spent after the run began, not what the session held when it started", () =>
  Effect.gen(function* () {
    yield* useServerConfig((url) => ({ ...paidCfg(url), spend_limit: 1 }))
    const service = yield* Permission.Service
    const sessions = yield* Session.Service
    const atStart = yield* sessions.create({ title: "Pinned", permission: allowAll })
    expect(atStart.cost ?? 0).toBe(0)
    yield* spent(atStart.id, 1.5)
    const model = { cost: { ...paidCost, cache: { read: 0, write: 0 } } }
    const fiber = yield* SessionSpend.check({ sessions, permission: service, limit: 1, model, session: atStart }).pipe(
      Effect.forkChild,
    )
    const asked = yield* waitForAsk("spend_limit")
    expect(asked.patterns).toEqual(["$1.50 of $1.00"])
    yield* service.reply({ requestID: asked.id, reply: "reject" })
    expect(yield* Fiber.join(fiber)).toBe(1)
  }),
)

it.instance("a run at its spend limit waits, and stopping it sends nothing more to the model", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig((url) => ({ ...paidCfg(url), spend_limit: 1 }))
    const prompt = yield* SessionPrompt.Service
    const service = yield* Permission.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned", permission: allowAll })
    yield* spent(chat.id, 2.5)

    const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
    const asked = yield* waitForAsk("spend_limit")
    expect(asked.sessionID).toBe(chat.id)
    expect(asked.patterns).toEqual(["$2.50 of $1.00"])
    expect(asked.metadata.next).toBe(3.5)
    // Unattended moving-on must never apply: nobody being there is when the limit matters.
    expect(asked.movesOnAt).toBeUndefined()

    yield* service.reply({ requestID: asked.id, reply: "reject" })
    const result = yield* Fiber.join(fiber)
    expect(yield* llm.calls).toBe(0)
    expect(result.parts.some((part) => part.type === "text" && part.text.includes("$1.00 spend limit"))).toBe(true)

    // Running again does not ask again or spend: the run ended cleanly.
    const again = yield* prompt.loop({ sessionID: chat.id })
    expect(again.info.id).toBe(result.info.id)
    expect(yield* service.list()).toEqual([])
  }),
)

it.instance("continuing past the limit raises it by the same amount and the run goes on", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig((url) => ({ ...paidCfg(url), spend_limit: 1 }))
    const prompt = yield* SessionPrompt.Service
    const service = yield* Permission.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned", permission: allowAll })
    yield* spent(chat.id, 1.5)
    yield* llm.text("all done")

    const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
    const asked = yield* waitForAsk("spend_limit")
    yield* service.reply({ requestID: asked.id, reply: "once" })
    const result = yield* Fiber.join(fiber)
    expect(result.parts.some((part) => part.type === "text" && part.text === "all done")).toBe(true)
    expect(yield* service.list()).toEqual([])
  }),
)

it.instance("a new message starts a new run, so an earlier expensive one does not count", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig((url) => ({ ...paidCfg(url), spend_limit: 1 }))
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned", permission: allowAll })
    yield* spent(chat.id, 40, "stop")
    yield* user(chat.id, "one more thing")
    yield* llm.text("sure")

    const result = yield* prompt.loop({ sessionID: chat.id })
    expect(result.parts.some((part) => part.type === "text" && part.text === "sure")).toBe(true)
  }),
)

it.instance("subagents count toward the run, and they all share one question on the root session", () =>
  Effect.gen(function* () {
    yield* useServerConfig((url) => ({ ...paidCfg(url), spend_limit: 1 }))
    const service = yield* Permission.Service
    const sessions = yield* Session.Service
    const root = yield* sessions.create({ title: "Root", permission: allowAll })
    yield* spent(root.id, 0.25)
    const first = yield* sessions.create({ parentID: root.id, title: "first" })
    const second = yield* sessions.create({ parentID: root.id, title: "second" })
    yield* spent(first.id, 0.5)
    yield* spent(second.id, 0.5)

    const input = { sessions, permission: service, limit: 1, model: { cost: { input: 1, output: 1, cache: { read: 0, write: 0 } } } }
    const a = yield* SessionSpend.check({ ...input, session: first }).pipe(Effect.forkChild)
    const b = yield* SessionSpend.check({ ...input, session: second }).pipe(Effect.forkChild)
    const asked = yield* waitForAsk("spend_limit")
    expect(asked.sessionID).toBe(root.id)
    expect(asked.metadata.subagents).toBe(2)
    expect(asked.metadata.subagentCost).toBe(1)
    expect(asked.patterns).toEqual(["$1.25 of $1.00"])
    expect((yield* service.list()).length).toBe(1)

    yield* service.reply({ requestID: asked.id, reply: "reject" })
    expect(yield* Fiber.join(a)).toBe(1)
    expect(yield* Fiber.join(b)).toBe(1)
  }),
)

it.instance("a subagent resumed from an earlier run counts only what it spent in this one", () =>
  Effect.gen(function* () {
    yield* useServerConfig((url) => ({ ...paidCfg(url), spend_limit: 1 }))
    const service = yield* Permission.Service
    const sessions = yield* Session.Service
    const root = yield* sessions.create({ title: "Root", permission: allowAll })
    const helper = yield* sessions.create({ parentID: root.id, title: "helper" })
    yield* spent(helper.id, 40, "stop")
    yield* Effect.promise(() => Bun.sleep(5))
    yield* user(root.id, "carry on")
    yield* Effect.promise(() => Bun.sleep(5))
    yield* spent(helper.id, 0.5)

    const model = { cost: { ...paidCost, cache: { read: 0, write: 0 } } }
    const input = { sessions, permission: service, limit: 1, model }
    expect(yield* SessionSpend.check({ ...input, session: root })).toBeUndefined()
    expect(yield* service.list()).toEqual([])

    yield* spent(helper.id, 0.75)
    const fiber = yield* SessionSpend.check({ ...input, session: root }).pipe(Effect.forkChild)
    const asked = yield* waitForAsk("spend_limit")
    expect(asked.patterns).toEqual(["$1.25 of $1.00"])
    yield* service.reply({ requestID: asked.id, reply: "reject" })
    expect(yield* Fiber.join(fiber)).toBe(1)
  }),
)

it.instance("a late answer stays inside the run, so it cannot lift a spend limit that has been reached", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig((url) => ({ ...paidCfg(url), spend_limit: 1 }))
    const service = yield* Permission.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned", permission: allowAll })
    yield* spent(chat.id, 2.5)
    yield* llm.text("should wait for the person")

    const late = yield* LateAnswer.make
    const request = {
      id: PermissionV1.ID.ascending(),
      sessionID: chat.id,
      permission: "bash",
      patterns: ["git push"],
      metadata: { command: "git push" },
      always: [],
    }
    const fiber = yield* late.permission(request).pipe(Effect.forkChild)
    const asked = yield* waitForAsk("spend_limit")
    expect(asked.patterns).toEqual(["$2.50 of $1.00"])
    expect(yield* llm.calls).toBe(0)
    yield* service.reply({ requestID: asked.id, reply: "reject" })
    yield* Fiber.join(fiber)
    expect(yield* llm.calls).toBe(0)
  }),
)

it.instance("a late answer to a subagent reaches the root session as the person's message, and the grant holds", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const service = yield* Permission.Service
    const sessions = yield* Session.Service
    const root = yield* sessions.create({ title: "Root", permission: allowAll })
    const child = yield* sessions.create({ parentID: root.id, title: "helper" })
    yield* seed(root.id, { finish: "stop" })
    yield* llm.text("allowed, carrying on")
    yield* llm.text("answered, carrying on")

    const late = yield* LateAnswer.make
    yield* late.permission({
      id: PermissionV1.ID.ascending(),
      sessionID: child.id,
      permission: "bash",
      patterns: ["git push"],
      metadata: { command: "git push" },
      always: [],
    })
    const texts = (yield* sessions.messages({ sessionID: root.id })).flatMap((message) =>
      message.info.role !== "user"
        ? []
        : message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])),
    )
    expect(texts.at(-1)).toContain("`git push`")
    // The one-shot grant is on the root, and lets exactly this call through once with no second prompt.
    yield* service.ask({
      sessionID: root.id,
      permission: "bash",
      patterns: ["git push"],
      metadata: {},
      always: [],
      ruleset: [],
    })
    expect(yield* service.list()).toEqual([])

    yield* late.question(
      {
        id: QuestionID.ascending(),
        sessionID: child.id,
        questions: [{ question: "Which database?", header: "DB", options: [{ label: "SQLite", description: "" }] }],
      },
      [["SQLite"]],
    )
    const last = (yield* sessions.messages({ sessionID: root.id })).findLast((message) => message.info.role === "user")
    expect(last?.parts.some((part) => part.type === "text" && part.text.includes('"Which database?": SQLite'))).toBe(true)
    expect(yield* llm.calls).toBe(2)
  }),
)

it.instance("skipped requests go away with a deleted or archived session, and live ones stay", () =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      process.env.SWARM_UNATTENDED_AFTER_MS = "1"
    }),
    () =>
      Effect.gen(function* () {
        yield* useServerConfig(providerCfg)
        const service = yield* Permission.Service
        const questions = yield* Question.Service
        const sessions = yield* Session.Service
        const late = yield* LateAnswer.make
        const kept = yield* sessions.create({ title: "kept" })
        const archived = yield* sessions.create({ title: "archived" })
        const helper = yield* sessions.create({ parentID: archived.id, title: "helper of archived" })
        const deleted = yield* sessions.create({ title: "deleted" })
        const skip = (sessionID: SessionID) =>
          service
            .ask({ sessionID, permission: "bash", patterns: ["git push"], metadata: {}, always: [], ruleset: [] })
            .pipe(Effect.exit)
        const skipQuestion = (sessionID: SessionID) =>
          questions
            .ask({
              sessionID,
              movesOn: true,
              questions: [{ question: "Which?", header: "Which", options: [{ label: "A", description: "" }] }],
            })
            .pipe(Effect.exit)
        for (const id of [kept.id, archived.id, helper.id, deleted.id]) {
          yield* skip(id)
          yield* skipQuestion(id)
        }
        expect((yield* service.list()).length).toBe(4)

        yield* sessions.setArchived({ sessionID: archived.id, time: Date.now() })
        yield* sessions.remove(deleted.id)
        yield* late.forgetAbandoned()

        expect((yield* service.list()).map((item) => item.sessionID)).toEqual([kept.id])
        expect((yield* questions.list()).map((item) => item.sessionID)).toEqual([kept.id])
      }),
    () =>
      Effect.sync(() => {
        delete process.env.SWARM_UNATTENDED_AFTER_MS
      }),
  ),
)

it.instance("a walked-away `ls` is released, and what the model reads next names the tool that needs nobody", () =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      process.env.SWARM_UNATTENDED_AFTER_MS = "1"
    }),
    () =>
      Effect.gen(function* () {
        const { llm } = yield* useServerConfig(providerCfg)
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Pinned" })
        yield* prompt.prompt({ sessionID: chat.id, agent: "build", noReply: true, parts: [{ type: "text", text: "go" }] })
        yield* llm.tool("bash", { command: "ls", description: "list" })
        yield* llm.text("done")

        yield* prompt.loop({ sessionID: chat.id })

        const sent = JSON.stringify((yield* llm.hits).at(-1)?.body.messages)
        expect(sent).toContain("did not run")
        expect(sent).toContain("read for a file or a directory's listing (instead of cat or ls)")
      }),
    () =>
      Effect.sync(() => {
        delete process.env.SWARM_UNATTENDED_AFTER_MS
      }),
  ),
)

it.instance("a command template's shell runs in the session's project, not where the server started", () =>
  Effect.gen(function* () {
    const { llm, dir } = yield* useServerConfig((url) => ({
      ...providerCfg(url),
      command: { here: { template: "We are in !`pwd` now" } },
    }))
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })
    yield* llm.text("done")

    yield* prompt.command({ sessionID: chat.id, command: "here", arguments: "" })

    const sent = JSON.stringify((yield* llm.hits).at(-1)?.body.messages)
    expect(sent).toContain(`We are in ${realpathSync(dir)}`)
    expect(realpathSync(dir)).not.toBe(realpathSync(process.cwd()))
  }),
)

it.instance("a server's reasoning_content lands in one thinking block per step, apart from the answer", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned", permission: allowAll })
    yield* prompt.prompt({ sessionID: chat.id, agent: "build", noReply: true, parts: [{ type: "text", text: "why?" }] })
    yield* llm.push(reply().reason("Let me work this out.").text("Checking.").tool("bash", { command: "printf one", description: "step" }))
    yield* llm.reason("Now I know.", { text: "Totals round twice." })

    yield* prompt.loop({ sessionID: chat.id })

    const steps = (yield* sessions.messages({ sessionID: chat.id })).filter((message) => message.info.role === "assistant")
    const read = (type: "reasoning" | "text") =>
      steps.flatMap((message) => message.parts.flatMap((part) => (part.type === type ? [part.text] : [])))
    expect(read("reasoning")).toEqual(["Let me work this out.", "Now I know."])
    expect(read("text")).toEqual(["Checking.", "Totals round twice."])
    // Going back to the server it stays in its own field, and never reads as something the assistant said.
    const sent = (yield* llm.hits).at(-1)?.body.messages as Array<Record<string, unknown>>
    const assistant = sent.find((message) => message.role === "assistant")
    expect(assistant?.content).toBe("Checking.")
    expect(assistant?.reasoning_content).toBe("Let me work this out.")
  }),
)

// Crash resume. It starts provider runs with nobody present, so what bounds it has to be pinned here.

const leaseDir = () => path.join(Global.Path.state, "runs")
const deadPid = () => Number(Bun.spawnSync(["sh", "-c", "echo $$"]).stdout.toString().trim())

const interrupted = Effect.fn("test.interrupted")(function* (
  sessionID: SessionID,
  lease: { resumes?: number; stopped?: boolean; parentID?: string } = {},
) {
  const { directory } = yield* TestInstance
  RunLease.enable()
  mkdirSync(leaseDir(), { recursive: true })
  writeFileSync(
    path.join(leaseDir(), `${sessionID}.json`),
    JSON.stringify({ version: 1, directory, pid: deadPid(), resumes: 0, sessionID, ...lease }),
  )
  return directory
})

const leases = () =>
  Effect.sync(() => {
    try {
      return readdirSync(leaseDir())
    } catch {
      return [] as string[]
    }
  })

const clearLeases = Effect.sync(() => rmSync(leaseDir(), { recursive: true, force: true }))

const openTool = Effect.fn("test.openTool")(function* (
  sessionID: SessionID,
  tool: string,
  metadata: Record<string, unknown> = {},
) {
  const sessions = yield* Session.Service
  const seeded = yield* seed(sessionID)
  const part = yield* sessions.updatePart({
    id: PartID.ascending(),
    messageID: seeded.assistant.id,
    sessionID,
    type: "tool",
    callID: `call_${tool}`,
    tool,
    state: {
      status: "running",
      input: { command: "git push origin main" },
      metadata,
      time: { start: Date.now() },
    },
  } satisfies SessionV1.ToolPart)
  return { ...seeded, part }
})

const toolAfter = Effect.fn("test.toolAfter")(function* (sessionID: SessionID, partID: PartID) {
  const sessions = yield* Session.Service
  const part = (yield* sessions.messages({ sessionID }))
    .flatMap((message) => message.parts)
    .find((item) => item.id === partID)
  return part?.type === "tool" ? part : undefined
})

it.instance("resume: an interrupted run continues once, says the call may have run, and does not repeat it", () =>
  Effect.gen(function* () {
    yield* clearLeases
    const { llm } = yield* useServerConfig(providerCfg)
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned", permission: allowAll })
    const seeded = yield* openTool(chat.id, "bash")
    const directory = yield* interrupted(chat.id)
    yield* llm.text("picked up where it left off")

    const claimed = RunLease.claimInterrupted({ only: directory })
    expect(claimed.map((item) => item.action)).toEqual(["continue"])
    expect(claimed[0].lease.resumes).toBe(1)
    // A second server starting at the same moment finds nothing left to take.
    expect(RunLease.claimInterrupted({ only: directory })).toEqual([])
    yield* SessionResume.resumeDirectory(claimed)

    const part = yield* toolAfter(chat.id, seeded.part.id)
    expect(part?.state.status).toBe("error")
    expect(part?.state.status === "error" && part.state.error).toBe(SessionResume.INTERRUPTED_TOOL)
    expect(part?.state.status === "error" && part.state.metadata?.interrupted).toBe(true)
    expect(yield* llm.calls).toBe(1)
    expect(yield* leases()).toEqual([])
    expect(JSON.stringify((yield* llm.hits)[0].body.messages)).toContain(SessionResume.INTERRUPTED_TOOL)
  }),
)

it.instance("resume: a call stopped at a permission prompt reads as not run, and the model is told so", () =>
  Effect.gen(function* () {
    yield* clearLeases
    const { llm } = yield* useServerConfig(providerCfg)
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned", permission: allowAll })
    const seeded = yield* openTool(chat.id, "bash", { waitingOnPermission: true })
    const directory = yield* interrupted(chat.id)
    yield* llm.text("I will ask again")

    yield* SessionResume.resumeDirectory(RunLease.claimInterrupted({ only: directory }))

    const part = yield* toolAfter(chat.id, seeded.part.id)
    expect(part?.state.status === "error" && part.state.error).toBe(SessionResume.NOT_RUN_TOOL)
    expect(part?.state.status === "error" && part.state.metadata).toEqual({ notRun: "away" })
    expect(JSON.stringify((yield* llm.hits)[0].body.messages)).toContain(SessionResume.NOT_RUN_TOOL)
  }),
)

it.instance("resume: an unanswered question reads as not run too", () =>
  Effect.gen(function* () {
    yield* clearLeases
    const { llm } = yield* useServerConfig(providerCfg)
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned", permission: allowAll })
    const seeded = yield* openTool(chat.id, "question")
    const directory = yield* interrupted(chat.id)
    yield* llm.text("I will ask again")

    yield* SessionResume.resumeDirectory(RunLease.claimInterrupted({ only: directory }))

    const part = yield* toolAfter(chat.id, seeded.part.id)
    expect(part?.state.status === "error" && part.state.metadata?.notRun).toBe("away")
  }),
)

it.instance("a tool waiting on permission is marked durably, and the mark goes once it is answered", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const service = yield* Permission.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({
      title: "Pinned",
      permission: [{ permission: "bash", pattern: "*", action: "ask" as const }],
    })
    yield* prompt.prompt({ sessionID: chat.id, agent: "build", noReply: true, parts: [{ type: "text", text: "go" }] })
    yield* llm.tool("bash", { command: "printf one", description: "step" })
    yield* llm.text("done")

    const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
    const asked = yield* waitForAsk("bash")
    const tool = () =>
      sessions
        .messages({ sessionID: chat.id })
        .pipe(Effect.map((messages) => toolPart(messages.flatMap((message) => message.parts))))
    const waiting = yield* tool()
    expect(waiting?.state.status === "running" && waiting.state.metadata?.waitingOnPermission).toBe(true)

    yield* service.reply({ requestID: asked.id, reply: "once" })
    yield* Fiber.join(fiber)
    const finished = yield* tool()
    expect(finished?.state.status).toBe("completed")
    expect(finished?.state.status === "completed" && finished.state.metadata?.waitingOnPermission).toBeUndefined()
  }),
)

it.instance("resume: past the cap nothing is sent, and the run says it was not safe to continue", () =>
  Effect.gen(function* () {
    yield* clearLeases
    const { llm } = yield* useServerConfig(providerCfg)
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned", permission: allowAll })
    const seeded = yield* openTool(chat.id, "bash")
    const directory = yield* interrupted(chat.id, { resumes: RunLease.MAX_RESUMES })

    const claimed = RunLease.claimInterrupted({ only: directory })
    expect(claimed.map((item) => item.action)).toEqual(["exhausted"])
    yield* SessionResume.resumeDirectory(claimed)

    expect(yield* llm.calls).toBe(0)
    expect(yield* leases()).toEqual([])
    const info = (yield* sessions.messages({ sessionID: chat.id })).find((message) => message.info.id === seeded.assistant.id)?.info
    expect(info?.role === "assistant" && info.error?.data).toMatchObject({
      message: expect.stringContaining("not safe to continue"),
    })
  }),
)

it.instance("resume: a run the person stopped stays stopped", () =>
  Effect.gen(function* () {
    yield* clearLeases
    const { llm } = yield* useServerConfig(providerCfg)
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned", permission: allowAll })
    const seeded = yield* openTool(chat.id, "bash")
    const directory = yield* interrupted(chat.id, { stopped: true })

    const claimed = RunLease.claimInterrupted({ only: directory })
    expect(claimed.map((item) => item.action)).toEqual(["stopped"])
    yield* SessionResume.resumeDirectory(claimed)

    expect(yield* llm.calls).toBe(0)
    expect(yield* leases()).toEqual([])
    const info = (yield* sessions.messages({ sessionID: chat.id })).find((message) => message.info.id === seeded.assistant.id)?.info
    expect(info?.role === "assistant" && info.error?.name).toBe("MessageAbortedError")
  }),
)

it.instance("resume: a run over its spend limit asks before sending anything, and Stop ends it", () =>
  Effect.gen(function* () {
    yield* clearLeases
    const { llm } = yield* useServerConfig((url) => ({ ...paidCfg(url), spend_limit: 1 }))
    const service = yield* Permission.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned", permission: allowAll })
    yield* spent(chat.id, 2.5)
    const directory = yield* interrupted(chat.id)

    const fiber = yield* SessionResume.resumeDirectory(RunLease.claimInterrupted({ only: directory })).pipe(
      Effect.forkChild,
    )
    const asked = yield* waitForAsk("spend_limit")
    expect(asked.patterns).toEqual(["$2.50 of $1.00"])
    expect(yield* llm.calls).toBe(0)
    yield* service.reply({ requestID: asked.id, reply: "reject" })
    yield* Fiber.join(fiber)
    expect(yield* llm.calls).toBe(0)
    expect(yield* leases()).toEqual([])
  }),
)

it.instance("resume: a parent waiting on a subagent gets the subagent's answer, from one shared run of it", () =>
  Effect.gen(function* () {
    yield* clearLeases
    const { llm } = yield* useServerConfig(providerCfg)
    const sessions = yield* Session.Service
    const root = yield* sessions.create({ title: "Root", permission: allowAll })
    const child = yield* sessions.create({ parentID: root.id, title: "helper", permission: allowAll })
    yield* user(child.id, "look into it")
    const seeded = yield* openTool(root.id, "task", { sessionId: child.id })
    const directory = yield* interrupted(child.id, { parentID: root.id })
    yield* interrupted(root.id)
    yield* llm.textMatch(
      (hit) => !JSON.stringify(hit.body.messages).includes("the helper found it"),
      "the helper found it",
    )
    yield* llm.text("root finished")

    const claimed = RunLease.claimInterrupted({ only: directory })
    expect(claimed.length).toBe(2)
    yield* SessionResume.resumeDirectory(claimed)

    const part = yield* toolAfter(root.id, seeded.part.id)
    expect(part?.state.status).toBe("completed")
    expect(part?.state.status === "completed" && part.state.output).toContain("the helper found it")
    expect(yield* llm.calls).toBe(2)
    expect(yield* leases()).toEqual([])
  }),
)

it.instance("resume: a lease for a session that no longer exists is dropped", () =>
  Effect.gen(function* () {
    yield* clearLeases
    const { llm } = yield* useServerConfig(providerCfg)
    const directory = yield* interrupted(SessionID.make("ses_gone"))

    yield* SessionResume.resumeDirectory(RunLease.claimInterrupted({ only: directory }))

    expect(yield* llm.calls).toBe(0)
    expect(yield* leases()).toEqual([])
  }),
)

it.instance("still over the price target right after compacting: it does not compact again on every step", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig((url) => ({ ...paidCfg(url), compaction: { max_context: 20_000 } }))
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned", permission: allowAll })
    yield* prompt.prompt({ sessionID: chat.id, agent: "build", noReply: true, parts: [{ type: "text", text: "go" }] })
    const large = { input: 50_000, output: 10 }
    const step = (command: string) => reply().tool("bash", { command, description: "step" }).usage(large)
    yield* llm.push(step("printf one"))
    yield* llm.text("the summary", { usage: { input: 1_000, output: 10 } })
    yield* llm.push(step("printf two"))
    yield* llm.push(step("printf three"))
    yield* llm.text("done", { usage: large })

    yield* prompt.loop({ sessionID: chat.id })

    const parts = (yield* sessions.messages({ sessionID: chat.id })).flatMap((message) => message.parts)
    expect(parts.filter((part) => part.type === "compaction").length).toBe(1)
    expect(yield* llm.pending).toBe(0)
  }),
)

it.instance("a limit of 0 never asks", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig((url) => ({ ...providerCfg(url), spend_limit: 0 }))
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned", permission: allowAll })
    yield* spent(chat.id, 500)
    yield* llm.text("done")
    const result = yield* prompt.loop({ sessionID: chat.id })
    expect(result.parts.some((part) => part.type === "text" && part.text === "done")).toBe(true)
  }),
)

unix(
  "an instructions file edited mid-run reaches the model at the next message, keeping the cached prefix intact",
  () =>
    Effect.gen(function* () {
      const { dir, llm } = yield* useServerConfig((url) => ({ ...providerCfg(url), shell: "bash" }))
      yield* writeText(path.join(dir, "AGENTS.md"), "# Rules\nFIRST RULE\n")
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned", permission: allowAll })
      yield* user(chat.id, "edit the rules")
      yield* llm.tool("bash", { command: "printf 'SECOND RULE\\n' >> AGENTS.md", description: "Add a rule" })
      yield* llm.text("edited")
      yield* prompt.loop({ sessionID: chat.id })

      const system = (body: unknown) =>
        JSON.stringify((body as { messages: { role: string }[] }).messages.filter((item) => item.role === "system"))
      const steps = (yield* llm.inputs).filter((body) => "tools" in body)
      expect(steps.length).toBe(2)
      expect(system(steps[0])).toContain("FIRST RULE")
      expect(system(steps[1])).toBe(system(steps[0]))

      yield* user(chat.id, "thanks")
      yield* llm.text("welcome")
      yield* prompt.loop({ sessionID: chat.id })
      const last = (yield* llm.inputs).filter((body) => "tools" in body).at(-1)
      expect(system(last)).toContain("SECOND RULE")
    }),
)

const bulkyHistory = Effect.fn("test.bulkyHistory")(function* (sessionID: SessionID, ago: number) {
  const sessions = yield* Session.Service
  const first = yield* seed(sessionID, { finish: "stop" })
  const when = Date.now() - ago
  yield* sessions.updateMessage({ ...first.assistant, time: { created: when, completed: when } })
  const part = yield* sessions.updatePart({
    id: PartID.ascending(),
    messageID: first.assistant.id,
    sessionID,
    type: "tool",
    tool: "bash",
    callID: "old",
    state: {
      status: "completed",
      input: {},
      output: "x".repeat(400_000),
      title: "",
      metadata: {},
      time: { start: when, end: when },
    },
  })
  const next = yield* seed(sessionID, { finish: "stop" })
  yield* sessions.updateMessage({ ...next.assistant, time: { created: when, completed: when } })
  return part.id
})

const oldOutputCleared = Effect.fn("test.oldOutputCleared")(function* (sessionID: SessionID, partID: PartID) {
  const sessions = yield* Session.Service
  const part = (yield* sessions.messages({ sessionID })).flatMap((m) => m.parts).find((item) => item.id === partID)
  return part?.type === "tool" && part.state.status === "completed" && part.state.time.compacted !== undefined
})

it.instance("old tool output is cleared when a session returns to an expired cache", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned", permission: allowAll })
    const partID = yield* bulkyHistory(chat.id, 60 * 60 * 1000)
    yield* user(chat.id, "back again")
    yield* llm.text("hello again")
    yield* prompt.loop({ sessionID: chat.id })
    expect(yield* oldOutputCleared(chat.id, partID)).toBe(true)
    expect(JSON.stringify((yield* llm.inputs).at(-1))).not.toContain("xxxxxxxxxxxxxxxx")
  }),
)

it.instance("old tool output stays while the cache is still warm, since clearing it would cost more", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned", permission: allowAll })
    const partID = yield* bulkyHistory(chat.id, 30 * 1000)
    yield* user(chat.id, "one more")
    yield* llm.text("sure")
    yield* prompt.loop({ sessionID: chat.id })
    expect(yield* oldOutputCleared(chat.id, partID)).toBe(false)
  }),
)

// Outside the app the resolver answers no-app. Only `current` changes, and with nothing posed it gives this process's real
// answer, so another file sharing the process still sees the real module.
const actualRoot = { ...LibraryRoot }
let posedRoot: LibraryRoot.Status | undefined
const currentRoot = () => posedRoot ?? actualRoot.current()
mock.module("../../src/skill/library-root", () => ({
  ...actualRoot,
  current: currentRoot,
  LibraryRoot: { ...actualRoot, current: currentRoot },
}))

const LIBRARY = "knowledge-library"
// Written out here, on purpose: these strings are the contract, so a test must not read them from the code.
const NO_APP_TEXT =
  "Knowledge Library is not available in this session. It is available only in sessions run by the Swarm desktop app. Tell the user and continue without it. Do not look for a copy on disk."
const FAILED_TEXT =
  "Knowledge Library could not be opened in this app because its copy is missing or failed a check. Tell the user and continue without it. Do not look for a copy on disk."
const ROOT_AVAILABLE: LibraryRoot.Status = { kind: "available", root: "/synthetic/Resources/knowledge-library" }
const ROOT_NO_APP: LibraryRoot.Status = { kind: "no-app" }
const ROOT_REFUSED: LibraryRoot.Status = { kind: "available", root: "/synthetic/!`Resources`/knowledge-library" }
const KEY_OFF = `{"knowledge_library": false}`

const posing = <A, E, R>(status: LibraryRoot.Status, trusted: boolean, self: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      posedRoot = status
      ProjectTrust.assumeTrustedForTests(trusted)
    }),
    () => self,
    () =>
      Effect.sync(() => {
        posedRoot = undefined
        ProjectTrust.assumeTrustedForTests(true)
      }),
  )

// The key is global, so it is the global file that has to say it.
const withGlobalFile = <A, E, R>(content: string | undefined, self: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const config = yield* Config.Service
    const { directory } = yield* TestInstance
    const dir = path.join(directory, ".global-config")
    mkdirSync(dir, { recursive: true })
    if (content !== undefined) writeFileSync(path.join(dir, "swarm.json"), content)
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

const slashFailure = Effect.gen(function* () {
  const prompt = yield* SessionPrompt.Service
  const sessions = yield* Session.Service
  const chat = yield* sessions.create({ title: "Pinned" })
  const exit = yield* prompt.command({ sessionID: chat.id, command: LIBRARY, arguments: "" }).pipe(Effect.exit)
  if (Exit.isSuccess(exit)) throw new Error("expected the command to fail")
  const error = Cause.squash(exit.cause)
  if (!NamedError.Unknown.isInstance(error)) throw error
  return error.data.message
})

const genericNotFound = Effect.gen(function* () {
  const commands = yield* Command.Service
  const names = (yield* commands.list()).map((item) => item.name).join(", ")
  return `Command not found: "${LIBRARY}". Available commands: ${names}`
})

const slashCases: [string, LibraryRoot.Status, string | undefined, string | undefined][] = [
  ["outside the app", ROOT_NO_APP, undefined, NO_APP_TEXT],
  ["outside the app, key off", ROOT_NO_APP, KEY_OFF, NO_APP_TEXT],
  ["a missing copy", { kind: "failed", code: "missing" }, undefined, FAILED_TEXT],
  ["a symlinked copy", { kind: "failed", code: "symlink" }, undefined, FAILED_TEXT],
  ["another edition", { kind: "failed", code: "edition" }, undefined, FAILED_TEXT],
  ["a failed copy, key off", { kind: "failed", code: "edition" }, KEY_OFF, FAILED_TEXT],
  ["a sound copy, key on", ROOT_AVAILABLE, undefined, undefined],
  ["a sound copy, key off", ROOT_AVAILABLE, KEY_OFF, undefined],
  ["a root the entry refuses", ROOT_REFUSED, undefined, FAILED_TEXT],
  ["a root the entry refuses, key off", ROOT_REFUSED, KEY_OFF, undefined],
]

for (const [name, status, global, expected] of slashCases) {
  noLLMServer.instance(`/knowledge-library, ${name}: exact text`, () => {
    const logs: string[] = []
    return posing(
      status,
      true,
      withGlobalFile(
        global,
        Effect.gen(function* () {
          expect(yield* slashFailure).toBe(expected ?? (yield* genericNotFound))
          const reasons = logs.filter((line) => line.includes("knowledge library unavailable"))
          if (status.kind !== "failed") expect(reasons).toEqual([])
          if (status.kind === "failed") {
            expect(reasons.length).toBe(1)
            expect(reasons[0]).toContain(`"code":"${status.code}"`)
          }
        }),
      ),
    ).pipe(
      Effect.provide(
        Logger.layer([
          Logger.make<unknown, void>((options) => {
            logs.push(JSON.stringify(options.message))
          }),
        ]),
      ),
    )
  })
}

noLLMServer.instance("another missing command keeps the plain answer outside the app", () =>
  posing(
    ROOT_NO_APP,
    true,
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      const exit = yield* prompt.command({ sessionID: chat.id, command: "no-such", arguments: "" }).pipe(Effect.exit)
      if (Exit.isSuccess(exit)) throw new Error("expected the command to fail")
      const error = Cause.squash(exit.cause)
      if (!NamedError.Unknown.isInstance(error)) throw error
      expect(error.data.message.startsWith('Command not found: "no-such". Available commands: ')).toBe(true)
    }),
  ),
)

// What each imitation source does to the table of commands. The neighbour has the same origin as the imitation, so a
// source that was not read at all cannot pass as one whose imitation was ignored.
const imitations: [string, string, (dir: string) => void][] = [
  [
    "V7 a text command file",
    "file-neighbour",
    (dir) => {
      mkdirSync(path.join(dir, ".swarm", "commands"), { recursive: true })
      writeFileSync(path.join(dir, ".swarm", "commands", `${LIBRARY}.md`), "Imitation text")
      writeFileSync(path.join(dir, ".swarm", "commands", "file-neighbour.md"), "Neighbour text")
    },
  ],
  [
    "V8 a command in swarm.json",
    "config-neighbour",
    (dir) => {
      writeFileSync(
        path.join(dir, "swarm.json"),
        JSON.stringify({
          command: { [LIBRARY]: { template: "Imitation text" }, "config-neighbour": { template: "Neighbour text" } },
        }),
      )
    },
  ],
  [
    "V9 a command file with a shell block",
    "file-neighbour",
    (dir) => {
      mkdirSync(path.join(dir, ".swarm", "commands"), { recursive: true })
      writeFileSync(path.join(dir, ".swarm", "commands", `${LIBRARY}.md`), "Imitation !`touch imitation-ran`")
      writeFileSync(path.join(dir, ".swarm", "commands", "file-neighbour.md"), "Neighbour text")
    },
  ],
]

for (const [name, neighbour, write] of imitations) {
  for (const trusted of [true, false]) {
    for (const status of [ROOT_AVAILABLE, ROOT_NO_APP]) {
      noLLMServer.instance(`${name}, ${trusted ? "trusted" : "untrusted"}, ${status.kind}: ignored`, () =>
        posing(
          status,
          trusted,
          Effect.gen(function* () {
            const { directory } = yield* TestInstance
            write(directory)
            const commands = yield* Command.Service
            expect(yield* commands.get(LIBRARY)).toBeUndefined()
            const names = (yield* commands.list()).map((item) => item.name)
            expect(names).not.toContain(LIBRARY)
            expect(names).toContain(neighbour)
            expect(yield* slashFailure).toBe(status.kind === "no-app" ? NO_APP_TEXT : yield* genericNotFound)
            expect(readdirSync(directory)).not.toContain("imitation-ran")
          }),
        ),
      )
    }
  }
}

noLLMServer.instance("a command file saved after the instance started is ignored too", () =>
  posing(
    ROOT_NO_APP,
    true,
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const commands = yield* Command.Service
      yield* commands.list()
      mkdirSync(path.join(directory, ".swarm", "commands"), { recursive: true })
      writeFileSync(path.join(directory, ".swarm", "commands", `${LIBRARY}.md`), "Imitation text")
      writeFileSync(path.join(directory, ".swarm", "commands", "file-neighbour.md"), "Neighbour text")
      expect(yield* commands.get("file-neighbour")).toBeDefined()
      expect(yield* commands.get(LIBRARY)).toBeUndefined()
      expect(yield* slashFailure).toBe(NO_APP_TEXT)
    }),
  ),
)

noLLMServer.instance("the entry itself is a skill and never a command", () =>
  posing(
    ROOT_AVAILABLE,
    true,
    Effect.gen(function* () {
      const skill = yield* Skill.Service
      const commands = yield* Command.Service
      expect((yield* skill.get(LIBRARY))?.location).toBe("<built-in>")
      expect(yield* commands.get(LIBRARY)).toBeUndefined()
      expect((yield* commands.list()).map((item) => item.name)).toContain("customize-swarm")
    }),
  ),
)

const withLibraryPrompt = testEffect(
  makePrompt({
    mcpPrompts: {
      [LIBRARY]: { name: LIBRARY, description: "Imitation", client: "imitation" },
      "prompt-neighbour": { name: "prompt-neighbour", description: "Neighbour", client: "imitation" },
    },
  }),
)

for (const trusted of [true, false]) {
  for (const status of [ROOT_AVAILABLE, ROOT_NO_APP]) {
    withLibraryPrompt.instance(
      `V19 an MCP prompt of that name, ${trusted ? "trusted" : "untrusted"}, ${status.kind}: ignored`,
      () =>
        posing(
          status,
          trusted,
          Effect.gen(function* () {
            const commands = yield* Command.Service
            expect(yield* commands.get(LIBRARY)).toBeUndefined()
            expect((yield* commands.get("prompt-neighbour"))?.source).toBe("mcp")
            expect(yield* slashFailure).toBe(status.kind === "no-app" ? NO_APP_TEXT : yield* genericNotFound)
          }),
        ),
    )
  }
}
