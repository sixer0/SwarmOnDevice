import { afterEach, describe, expect } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { ModelsDev } from "@opencode-ai/core/models-dev"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Cause, Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { Agent } from "../../src/agent/agent"
import { BackgroundJob } from "@/background/job"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Config } from "@/config/config"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Session } from "@/session/session"
import type { SessionPrompt } from "../../src/session/prompt"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"

import { TaskTool, subagentStoppedMessage, type TaskPromptOps } from "../../src/tool/task"
import { Truncate } from "@/tool/truncate"
import { ToolRegistry } from "@/tool/registry"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Permission } from "@/permission"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { RoleAlias } from "../../src/agent/role-alias"

afterEach(async () => {
  await disposeAllInstances()
})

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

const layer = (flags: Partial<RuntimeFlags.Info> = {}) =>
  LayerNode.compile(
    LayerNode.group([
      Agent.node,
      BackgroundJob.node,
      EventV2Bridge.node,
      Config.node,
      CrossSpawnSpawner.node,
      Session.node,
      SessionProjector.node,
      SessionRunState.node,
      SessionStatus.node,
      Truncate.node,
      ToolRegistry.node,
      Database.node,
      RuntimeFlags.node,
      Ripgrep.node,
    ]),
    [[RuntimeFlags.node, RuntimeFlags.layer(flags)]],
  )

const it = testEffect(layer())
const background = testEffect(layer({ experimentalBackgroundSubagents: true }))

function defer<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const seed = Effect.fn("TaskToolTest.seed")(function* (title = "Pinned", parent = ref) {
  const session = yield* Session.Service
  const chat = yield* session.create({ title })
  const user = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: chat.id,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  const assistant: SessionV1.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    parentID: user.id,
    sessionID: chat.id,
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: parent.modelID,
    providerID: parent.providerID,
    variant: "xhigh",
    time: { created: Date.now() },
  }
  yield* session.updateMessage(assistant)
  return { chat, assistant }
})

function stubOps(opts?: {
  onPrompt?: (input: SessionPrompt.PromptInput) => void
  text?: string
  error?: NonNullable<SessionV1.Assistant["error"]>
  toolError?: string
}): TaskPromptOps {
  return {
    cancel: () => Effect.void,
    resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
    prompt: (input) =>
      Effect.sync(() => {
        opts?.onPrompt?.(input)
        return reply(input, opts?.text ?? "done", opts?.error, opts?.toolError)
      }),
  }
}

function reply(
  input: SessionPrompt.PromptInput,
  text: string,
  error?: NonNullable<SessionV1.Assistant["error"]>,
  toolError?: string,
): SessionV1.WithParts {
  const id = MessageID.ascending()
  return {
    info: {
      id,
      role: "assistant",
      parentID: input.messageID ?? MessageID.ascending(),
      sessionID: input.sessionID,
      mode: input.agent ?? "general",
      agent: input.agent ?? "general",
      cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: input.model?.modelID ?? ref.modelID,
      providerID: input.model?.providerID ?? ref.providerID,
      time: { created: Date.now() },
      finish: "stop",
      error,
    },
    parts: [
      {
        id: PartID.ascending(),
        messageID: id,
        sessionID: input.sessionID,
        type: "text",
        text,
      },
      ...(toolError
        ? [
            {
              id: PartID.ascending(),
              messageID: id,
              sessionID: input.sessionID,
              type: "tool" as const,
              tool: "read",
              callID: "call-1",
              state: {
                status: "error" as const,
                input: { filePath: "/external" },
                error: toolError,
                time: { start: Date.now(), end: Date.now() },
              },
            },
          ]
        : []),
    ],
  }
}

describe("tool.task", () => {
  it.instance(
    "description sorts subagents by name and is stable across calls",
    () =>
      Effect.gen(function* () {
        const agent = yield* Agent.Service
        const build = yield* agent.get("build")
        const registry = yield* ToolRegistry.Service
        const get = Effect.fnUntraced(function* () {
          const tools = yield* registry.tools({ ...ref, agent: build })
          return tools.find((tool) => tool.id === TaskTool.id)?.description ?? ""
        })
        const first = yield* get()
        const second = yield* get()

        expect(first).toBe(second)

        const alpha = first.indexOf("- alpha: Alpha agent")
        const explore = first.indexOf("- explore:")
        const general = first.indexOf("- general:")
        const zebra = first.indexOf("- zebra: Zebra agent")

        expect(alpha).toBeGreaterThan(-1)
        expect(explore).toBeGreaterThan(alpha)
        expect(general).toBeGreaterThan(explore)
        expect(zebra).toBeGreaterThan(general)
      }),
    {
      config: {
        agent: {
          zebra: {
            description: "Zebra agent",
            mode: "subagent",
          },
          alpha: {
            description: "Alpha agent",
            mode: "subagent",
          },
        },
      },
    },
  )

  it.instance(
    "description hides denied subagents for the caller",
    () =>
      Effect.gen(function* () {
        const agent = yield* Agent.Service
        const build = yield* agent.get("build")
        const registry = yield* ToolRegistry.Service
        const description =
          (yield* registry.tools({ ...ref, agent: build })).find((tool) => tool.id === TaskTool.id)?.description ?? ""

        expect(description).toContain("- alpha: Alpha agent")
        expect(description).not.toContain("- zebra: Zebra agent")
      }),
    {
      config: {
        permission: {
          task: {
            "*": "allow",
            zebra: "deny",
          },
        },
        agent: {
          zebra: {
            description: "Zebra agent",
            mode: "subagent",
          },
          alpha: {
            description: "Alpha agent",
            mode: "subagent",
          },
        },
      },
    },
  )

  it.instance("execute resumes an existing task session from task_id", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "Existing child" })
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let seen: SessionPrompt.PromptInput | undefined
      const promptOps = stubOps({ text: "resumed", onPrompt: (input) => (seen = input) })

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          task_id: child.id,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const kids = yield* sessions.children(chat.id)
      expect(kids).toHaveLength(1)
      expect(kids[0]?.id).toBe(child.id)
      expect(result.metadata.sessionId).toBe(child.id)
      expect(result.output).toContain(`<task id="${child.id}" state="completed">`)
      expect(seen?.sessionID).toBe(child.id)
      expect(seen?.variant).toBe("xhigh")
    }),
  )

  it.instance("execute surfaces child errors with a resumable task_id", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const exit = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: {
              promptOps: stubOps({
                text: "",
                error: new SessionV1.APIError({ message: "Network connection lost", isRetryable: false }).toObject(),
              }),
            },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isSuccess(exit)) throw new Error("expected task failure")
      const child = (yield* sessions.children(chat.id))[0]
      expect(child).toBeDefined()
      const failure = Cause.squash(exit.cause)
      expect(failure).toBeInstanceOf(Error)
      if (!(failure instanceof Error)) throw new Error("expected Error defect")
      expect(failure.message).toBe(`Subagent failed (task_id: ${child?.id}): Network connection lost`)
    }),
  )

  it.instance("execute surfaces terminal child tool errors with a resumable task_id", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const exit = yield* def
        .execute(
          {
            description: "inspect external directory",
            prompt: "read the external directory",
            subagent_type: "general",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: {
              promptOps: stubOps({
                text: "I will inspect the directory.",
                toolError: "The user rejected permission to use this specific tool call.",
              }),
            },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isSuccess(exit)) throw new Error("expected task failure")
      const child = (yield* sessions.children(chat.id))[0]
      const failure = Cause.squash(exit.cause)
      expect(failure).toBeInstanceOf(Error)
      if (!(failure instanceof Error)) throw new Error("expected Error defect")
      expect(failure.message).toBe(
        `Subagent failed (task_id: ${child?.id}): The user rejected permission to use this specific tool call.`,
      )
    }),
  )

  it.instance("execute hands an autonomous stop back to the parent with the partial result", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect cache",
          prompt: "look into the cache key path",
          subagent_type: "general",
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: stubOps({
              text: "The key is built in cache.ts:40.",
              toolError: subagentStoppedMessage("read"),
            }),
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const child = (yield* sessions.children(chat.id))[0]
      expect(result.output).toContain(`state="completed"`)
      expect(result.output).toContain(`Stopped by autonomous mode: repeated calls to \`read\`. (task_id: ${child?.id})`)
      expect(result.output).toContain("Decide the next step yourself")
      expect(result.output).toContain("What the subagent had so far:\nThe key is built in cache.ts:40.")
    }),
  )

  it.instance("execute hands back an autonomous stop on the message error when nothing was written", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect cache",
          prompt: "look into the cache key path",
          subagent_type: "general",
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: stubOps({
              text: "",
              error: new SessionV1.APIError({ message: subagentStoppedMessage("bash"), isRetryable: false }).toObject(),
            }),
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      expect(result.output).toContain("Stopped by autonomous mode: repeated calls to `bash`.")
      expect(result.output).toContain("The subagent left no partial result.")
      expect(result.output).not.toContain("Subagent failed")
    }),
  )

  it.instance("execute asks by default and skips checks when bypassed", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const calls: unknown[] = []
      const promptOps = stubOps()

      const exec = (extra?: Record<string, any>) =>
        def.execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps, ...extra },
            messages: [],
            metadata: () => Effect.void,
            ask: (input) =>
              Effect.sync(() => {
                calls.push(input)
              }),
          },
        )

      yield* exec()
      yield* exec({ bypassAgentCheck: true })

      expect(calls).toHaveLength(1)
      expect(calls[0]).toEqual({
        permission: "task",
        patterns: ["general"],
        always: ["*"],
        metadata: {
          description: "inspect bug",
          subagent_type: "general",
          requested: "general",
        },
        // Sent to the permission layer in every mode. Only an entry autonomous mode held ever publishes it.
        call: {
          tool: "task",
          args: {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
        },
      })
    }),
  )

  it.instance("execute cancels child session when abort signal fires", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const ready = defer<SessionPrompt.PromptInput>()
      const cancelled = defer<SessionID>()
      const abort = new AbortController()
      const promptOps: TaskPromptOps = {
        cancel: (sessionID) =>
          Effect.sync(() => {
            cancelled.resolve(sessionID)
          }),
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: (input) =>
          Effect.promise(() => {
            ready.resolve(input)
            return cancelled.promise
          }).pipe(Effect.as(reply(input, "cancelled"))),
      }

      const fiber = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: abort.signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.forkChild)

      const input = yield* Effect.promise(() => ready.promise)
      abort.abort()
      expect(yield* Effect.promise(() => cancelled.promise)).toBe(input.sessionID)

      const exit = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)
    }),
  )

  it.instance("execute creates a child when task_id does not exist", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let seen: SessionPrompt.PromptInput | undefined
      const promptOps = stubOps({ text: "created", onPrompt: (input) => (seen = input) })

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          task_id: "ses_missing",
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const kids = yield* sessions.children(chat.id)
      expect(kids).toHaveLength(1)
      expect(kids[0]?.id).toBe(result.metadata.sessionId)
      expect(result.metadata.sessionId).not.toBe("ses_missing")
      expect(result.output).toContain(`<task id="${result.metadata.sessionId}" state="completed">`)
      expect(seen?.sessionID).toBe(result.metadata.sessionId)
    }),
  )

  it.instance("prevents subagents from launching subagents by default", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "child" })
      const nestedAssistant = yield* sessions.updateMessage({
        ...assistant,
        id: MessageID.ascending(),
        parentID: MessageID.ascending(),
        sessionID: child.id,
      })
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let asked = false

      const exit = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: child.id,
            messageID: nestedAssistant.id,
            agent: "general",
            abort: new AbortController().signal,
            extra: { promptOps: stubOps() },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.sync(() => (asked = true)),
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      expect(asked).toBe(false)
      expect(yield* sessions.children(child.id)).toHaveLength(0)
    }),
  )

  it.instance(
    "allows nested subagents up to the configured depth",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seed()
        const child = yield* sessions.create({ parentID: chat.id, title: "child" })
        const nestedAssistant = yield* sessions.updateMessage({
          ...assistant,
          id: MessageID.ascending(),
          parentID: MessageID.ascending(),
          sessionID: child.id,
        })
        const tool = yield* TaskTool
        const def = yield* tool.init()

        const result = yield* def.execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: child.id,
            messageID: nestedAssistant.id,
            agent: "general",
            abort: new AbortController().signal,
            extra: { promptOps: stubOps() },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )

        expect((yield* sessions.get(result.metadata.sessionId)).parentID).toBe(child.id)
      }),
    { config: { subagent_depth: 2 } },
  )

  it.instance(
    "execute shapes child permissions for task, todowrite, and primary tools",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()
        let seen: SessionPrompt.PromptInput | undefined
        const promptOps = stubOps({ onPrompt: (input) => (seen = input) })

        const result = yield* def.execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "reviewer",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )

        const child = yield* sessions.get(result.metadata.sessionId)
        expect(child.parentID).toBe(chat.id)
        expect(child.agent).toBe("reviewer")
        expect(child.permission).toEqual([
          {
            permission: "todowrite",
            pattern: "*",
            action: "deny",
          },
          {
            permission: "bash",
            pattern: "*",
            action: "deny",
          },
          {
            permission: "read",
            pattern: "*",
            action: "deny",
          },
        ])
        expect(seen?.tools).toBeUndefined()
      }),
    {
      config: {
        agent: {
          reviewer: {
            mode: "subagent",
            permission: {
              task: "allow",
            },
          },
        },
        experimental: {
          primary_tools: ["bash", "read"],
        },
      },
    },
  )

  it.instance("rejects background execution when the experiment is disabled", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const exit = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
            background: true,
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps: stubOps() },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )

  it.instance("promotes a running foreground task without restarting it", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const ready = yield* Deferred.make<void>()
      const done = yield* Deferred.make<void>()
      const injected = yield* Deferred.make<SessionPrompt.PromptInput>()
      let runs = 0
      const promptOps: TaskPromptOps = {
        cancel: () => Effect.void,
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: (input) => {
          if (input.sessionID === chat.id) {
            return Deferred.succeed(injected, input).pipe(Effect.as(reply(input, "injected")))
          }
          return Effect.gen(function* () {
            runs += 1
            yield* Deferred.succeed(ready, undefined)
            yield* Deferred.await(done)
            return reply(input, "background done")
          })
        },
      }

      const fiber = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.forkChild)

      yield* Deferred.await(ready)
      const job = (yield* jobs.list())[0]
      expect(job).toBeDefined()
      if (!job) throw new Error("task job not found")
      expect(job.metadata?.parentSessionId).toBe(chat.id)
      yield* jobs.promote(job.id)

      const result = yield* Fiber.join(fiber)
      expect(result.metadata.background).toBe(true)
      expect(result.output).toContain(`state="running"`)
      expect((yield* jobs.get(result.metadata.sessionId))?.status).toBe("running")
      expect(runs).toBe(1)

      yield* Deferred.succeed(done, undefined)
      expect((yield* jobs.wait({ id: result.metadata.sessionId })).info?.output).toBe("background done")
      expect((yield* Deferred.await(injected)).parts[0]?.type).toBe("text")
      expect(runs).toBe(1)
    }),
  )

  background.instance("execute launches background tasks without waiting for completion", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: () => Effect.never,
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const job = yield* jobs.get(result.metadata.sessionId)
      expect(result.metadata.background).toBe(true)
      expect(result.output).toContain(`state="running"`)
      expect(job?.status).toBe("running")
    }),
  )

  background.instance("background task completion waits for running updates", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const first = defer<void>()
      const second = defer<void>()
      const updated = defer<SessionPrompt.PromptInput>()
      const injected = defer<SessionPrompt.PromptInput>()
      let prompts = 0
      const promptOps: TaskPromptOps = {
        ...stubOps(),
        prompt: (input) => {
          if (input.sessionID === chat.id) {
            injected.resolve(input)
            return Effect.succeed(reply(input, "done"))
          }
          prompts++
          if (prompts === 1) return Effect.promise(() => first.promise).pipe(Effect.as(reply(input, "first done")))
          updated.resolve(input)
          return Effect.promise(() => second.promise).pipe(Effect.as(reply(input, "second done")))
        },
      }
      const context = {
        sessionID: chat.id,
        messageID: assistant.id,
        agent: "build",
        abort: new AbortController().signal,
        extra: { promptOps },
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      }

      const started = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        context,
      )
      const result = yield* def.execute(
        {
          description: "add investigation scope",
          prompt: "also inspect cancellation",
          subagent_type: "general",
          task_id: started.metadata.sessionId,
        },
        context,
      )

      expect(result.metadata.sessionId).toBe(started.metadata.sessionId)
      expect(result.metadata.background).toBe(true)
      expect(result.output).toContain("Background task updated")
      first.resolve()
      expect((yield* jobs.get(started.metadata.sessionId))?.status).toBe("running")
      expect((yield* Effect.promise(() => updated.promise)).parts).toEqual([
        { type: "text", text: "also inspect cancellation" },
      ])

      second.resolve()
      const waited = yield* jobs.wait({ id: started.metadata.sessionId, timeout: 1_000 })
      expect(waited.info?.status).toBe("completed")
      expect(waited.info?.output).toBe("second done")
      const notification = yield* Effect.promise(() => injected.promise)
      expect(notification.variant).toBe("xhigh")
      expect(notification.parts[0]?.type).toBe("text")
      if (notification.parts[0]?.type === "text") expect(notification.parts[0].text).toContain("second done")
    }),
  )

  background.instance("background tasks complete through the background job service", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps: stubOps({ text: "background done" }) },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("completed")
      expect(waited.info?.output).toBe("background done")
    }),
  )

  background.instance("background task completion does not wait for the parent async prompt", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps({ text: "background done" }),
              prompt: (input) =>
                input.sessionID === chat.id ? Effect.never : Effect.succeed(reply(input, "background done")),
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("completed")
    }),
  )

  background.instance("removing the parent session cancels running background tasks", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: () => Effect.never,
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      yield* sessions.remove(chat.id)
      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("cancelled")
    }),
  )

  background.instance("removing the child task session cancels its running background task", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: () => Effect.never,
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      yield* sessions.remove(result.metadata.sessionId)
      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("cancelled")
    }),
  )

  background.instance("cancelling the parent run cancels running background tasks", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const runState = yield* SessionRunState.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: () => Effect.never,
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      yield* runState.cancel(chat.id)
      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("cancelled")
    }),
  )

  it.instance("cancelling a child run cancels its own pre-runner task job", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const runState = yield* SessionRunState.Service
      const sessions = yield* Session.Service
      const { chat } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "child" })

      yield* jobs.start({
        id: child.id,
        type: "task",
        metadata: { parentSessionId: chat.id, sessionId: child.id },
        run: Effect.never,
      })

      yield* runState.cancel(child.id)

      expect((yield* jobs.get(child.id))?.status).toBe("cancelled")
    }),
  )

  it.instance("cancelling a parent run recursively cancels descendant background tasks", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const runState = yield* SessionRunState.Service
      const sessions = yield* Session.Service
      const { chat } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "child" })
      const grandchild = yield* sessions.create({ parentID: child.id, title: "grandchild" })

      yield* jobs.start({
        id: child.id,
        type: "task",
        metadata: { parentSessionId: chat.id, sessionId: child.id },
        run: Effect.never,
      })
      yield* jobs.start({
        id: grandchild.id,
        type: "task",
        metadata: { parentSessionId: child.id, sessionId: grandchild.id },
        run: Effect.never,
      })

      yield* runState.cancel(chat.id)

      expect((yield* jobs.get(child.id))?.status).toBe("cancelled")
      expect((yield* jobs.get(grandchild.id))?.status).toBe("cancelled")
    }),
  )

  describe("a shipped provider's subagents", () => {
    const shipped = { providerID: ProviderV2.ID.make("shipped-ai"), modelID: ModelV2.ID.make("thinker") }
    const withShipped = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          process.env[ModelsDev.BUNDLED_ENV] = JSON.stringify({
            provider: { id: "shipped-ai", name: "Shipped", env: [], models: {} },
            subagents: { general: "worker", explore: "worker-fast" },
          })
        }),
        () => effect,
        () => Effect.sync(() => delete process.env[ModelsDev.BUNDLED_ENV]),
      )
    const run = (subagent_type: string, parent = shipped) =>
      Effect.gen(function* () {
        const { chat, assistant } = yield* seed("Pinned", parent)
        const def = yield* (yield* TaskTool).init()
        let seen: SessionPrompt.PromptInput | undefined
        yield* def.execute(
          { description: "inspect bug", prompt: "look", subagent_type },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps: stubOps({ onPrompt: (input) => (seen = input) }) },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        return seen
      })

    it.instance("run on the models it names while the session is on it", () =>
      withShipped(
        Effect.gen(function* () {
          const general = yield* run("general")
          expect(String(general?.model?.modelID)).toBe("worker")
          expect(String(general?.model?.providerID)).toBe("shipped-ai")
          expect(general?.variant).toBeUndefined()
          expect(String((yield* run("explore"))?.model?.modelID)).toBe("worker-fast")
        }),
      ),
    )

    it.instance("stay on the session's model on any other provider", () =>
      withShipped(
        Effect.gen(function* () {
          expect((yield* run("general", ref))?.model).toEqual(ref)
        }),
      ),
    )

    it.instance(
      "an agent model the user set wins",
      () =>
        withShipped(
          Effect.gen(function* () {
            expect(String((yield* run("general"))?.model?.modelID)).toBe("mine")
          }),
        ),
      { config: { agent: { general: { model: "shipped-ai/mine" } } } },
    )

    it.instance(
      "anyone who wrote their own providers keeps the session's model",
      () =>
        withShipped(
          Effect.gen(function* () {
            expect(String((yield* run("general"))?.model?.modelID)).toBe("thinker")
          }),
        ),
      {
        config: {
          provider: {
            own: { npm: "@ai-sdk/openai-compatible", options: { baseURL: "http://127.0.0.1:2/v1" }, models: { own: {} } },
          },
        },
      },
    )

    it.instance("without the app's handover nothing is mapped", () =>
      Effect.gen(function* () {
        expect(String((yield* run("general"))?.model?.modelID)).toBe("thinker")
      }),
    )
  })

  // Spec 161 §13.3 (D13, D14), SA-17 to SA-20, and S163-03, S163-04, S163-07. Row 164's agents are fixtures here with
  // the spec's names, so these cases hold before and after it lands.
  describe("role aliases", () => {
    const specialists = {
      coder: { mode: "subagent" as const, description: "Implements code." },
      planner: { mode: "subagent" as const, description: "Plans." },
      verifier: { mode: "subagent" as const, description: "Checks." },
      "data-collector": { mode: "subagent" as const, description: "Reads." },
      "document-writer": { mode: "subagent" as const, description: "Writes documents." },
    }
    const withAgents = { config: { agent: specialists } }
    type Call = { seen?: SessionPrompt.PromptInput; asks: { patterns: string[]; metadata: Record<string, unknown> }[] }
    const call = (
      subagent_type: string,
      opts: { extra?: Record<string, unknown>; deny?: PermissionV1.Ruleset; args?: Record<string, unknown> } = {},
      parent = ref,
    ) =>
      Effect.gen(function* () {
        const { chat, assistant } = yield* seed("Pinned", parent)
        const def = yield* (yield* TaskTool).init()
        const out: Call = { asks: [] }
        const result = yield* def
          .execute({ description: "inspect bug", prompt: "look", subagent_type, ...opts.args } as never, {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps: stubOps({ onPrompt: (input) => (out.seen = input) }), ...opts.extra },
            messages: [],
            metadata: () => Effect.void,
            ask: (input) =>
              Effect.gen(function* () {
                out.asks.push({ patterns: [...input.patterns], metadata: { ...input.metadata } })
                // The parent agent's rules decide, as the permission service would (plan's D10 denies).
                if (
                  opts.deny &&
                  input.patterns.some((pattern) => Permission.evaluate("task", pattern, opts.deny!).action === "deny")
                )
                  return yield* Effect.die(new Error(`denied: ${input.patterns.join(",")}`))
              }),
          })
          .pipe(Effect.exit)
        return { ...out, result }
      })
    const firstText = (input?: SessionPrompt.PromptInput) => {
      const part = input?.parts[0]
      return part?.type === "text" ? part.text : ""
    }
    const output = (exit: Exit.Exit<{ output: string }, unknown>) => (Exit.isSuccess(exit) ? exit.value.output : "")
    const failure = (exit: Exit.Exit<unknown, unknown>) => (Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "")

    it.instance(
      "role aliases resolve to Swarm agents",
      () =>
        Effect.gen(function* () {
          for (const [name, target] of Object.entries(RoleAlias.ROLE_ALIASES)) {
            const expected = target === "researcher" ? "general" : target
            const { seen, result } = yield* call(name)
            expect([name, Exit.isSuccess(result)]).toEqual([name, true])
            expect([name, seen?.agent]).toEqual([name, expected])
          }
          expect((yield* call("Explore")).seen?.agent).toBe("explore")
          expect((yield* call("TASK-ARCHITECT")).seen?.agent).toBe("planner")
          const session = yield* Session.Service
          const child = (yield* call("task-architect")).seen!
          expect((yield* session.get(child.sessionID)).title).toBe("inspect bug (@planner subagent)")
        }),
      withAgents,
    )

    it.instance("the register covers every role name the workflow uses, with short fixed lines only", () =>
      Effect.gen(function* () {
        const roles = [
          "request-translator",
          "task-architect",
          "data-analyst",
          "document-analyst",
          "pm-analyst",
          "pm-planner",
          "image-prompt-specialist",
          "explore",
          "data-collector",
          "document-reader",
          "image-analyst",
          "coder-execution",
          "database-specialist",
          "git-specialist",
          "docker-specialist",
          "design-system-specialist",
          "document-writer",
          "pm-writer",
          "document-converter",
          "document-translator",
          "verifier",
          "senior-code-reviewer",
          "security-review",
          "pm-verifier",
          "document-reviewer",
          "test-expert",
          "vendor-crawler-specialist",
          "image-specialist",
          "general-purpose",
        ]
        expect(Object.keys(RoleAlias.ROLE_ALIASES).toSorted()).toEqual(roles.toSorted())
        for (const line of Object.values(RoleAlias.ROLE_LINES)) expect(Buffer.byteLength(line)).toBeLessThanOrEqual(160)
        // Names and text only (SA-18): every value of both maps is a string, no rules, models or prompts.
        for (const value of [...Object.values(RoleAlias.ROLE_ALIASES), ...Object.values(RoleAlias.ROLE_LINES)])
          expect(typeof value).toBe("string")
        expect(Object.values(RoleAlias.ROLE_LINES).join("\n")).not.toMatch(
          /alugra|iris|gsp-budi|\/Users\/|ses_[0-9a-f]|100\.102\./i,
        )
      }),
    )

    it.instance("researcher alias needs swarm-web, otherwise general", () =>
      Effect.gen(function* () {
        const get = (name: string) =>
          ["researcher", "general"].includes(name) ? { name, mode: "subagent" } : undefined
        expect(RoleAlias.resolveRole("vendor-crawler-specialist", get, ["swarm-web"])).toMatchObject({
          type: "alias",
          name: "researcher",
        })
        expect(RoleAlias.resolveRole("vendor-crawler-specialist", get, [])).toMatchObject({
          type: "alias",
          name: "general",
        })
      }),
    )

    it.instance(
      "an exact registered name wins over the alias",
      () =>
        Effect.gen(function* () {
          const { seen } = yield* call("task-architect")
          expect(seen?.agent).toBe("task-architect")
          expect(firstText(seen)).toBe("look")
        }),
      { config: { agent: { ...specialists, "task-architect": { mode: "subagent", description: "Mine." } } } },
    )

    it.instance(
      "the bundled tier follows the resolved agent",
      () =>
        Effect.acquireUseRelease(
          Effect.sync(() => {
            process.env[ModelsDev.BUNDLED_ENV] = JSON.stringify({
              provider: { id: "shipped-ai", name: "Shipped", env: [], models: {} },
              subagents: { general: "worker", explore: "worker-fast", coder: "worker", planner: "thinker" },
            })
          }),
          () =>
            Effect.gen(function* () {
              const shipped = { providerID: ProviderV2.ID.make("shipped-ai"), modelID: ModelV2.ID.make("thinker") }
              expect(String((yield* call("task-architect", {}, shipped)).seen?.model?.modelID)).toBe("thinker")
              expect(String((yield* call("coder-execution", {}, shipped)).seen?.model?.modelID)).toBe("worker")
            }),
          () => Effect.sync(() => delete process.env[ModelsDev.BUNDLED_ENV]),
        ),
      withAgents,
    )

    it.instance(
      "alias permission uses the resolved agent",
      () =>
        Effect.gen(function* () {
          const ok = yield* call("coder-execution")
          expect(ok.asks).toEqual([
            {
              patterns: ["coder"],
              metadata: { description: "inspect bug", subagent_type: "coder", requested: "coder-execution" },
            },
          ])
          // plan's binding denies (spec 161 D10) hold for every alias of the target, and never fall back to general.
          const plan = Permission.fromConfig({ task: { coder: "deny", "document-writer": "deny" } })
          for (const name of ["coder", "coder-execution", "git-specialist", "pm-writer", "document-writer"]) {
            const denied = yield* call(name, { deny: plan })
            expect([name, Exit.isFailure(denied.result)]).toEqual([name, true])
            expect([name, denied.seen]).toEqual([name, undefined])
          }
          expect(Exit.isSuccess((yield* call("task-architect", { deny: plan })).result)).toBe(true)
        }),
      withAgents,
    )

    it.instance(
      "an agent mention lets only that agent skip the ask",
      () =>
        Effect.gen(function* () {
          const plan = Permission.fromConfig({ task: { coder: "deny" } })
          const mentioned = yield* call("explore", { extra: { bypassAgentCheck: ["explore"] }, deny: plan })
          expect(mentioned.asks).toEqual([])
          expect(Exit.isSuccess(mentioned.result)).toBe(true)
          // S163-03: "@explore" in plan mode must not open the way to coder.
          const other = yield* call("coder", { extra: { bypassAgentCheck: ["explore"] }, deny: plan })
          expect(other.asks.map((ask) => ask.patterns)).toEqual([["coder"]])
          expect(Exit.isFailure(other.result)).toBe(true)
          expect((yield* call("coder-execution", { extra: { bypassAgentCheck: [] }, deny: plan })).seen).toBeUndefined()
          // A command's subtask (true) still skips it, as before.
          expect((yield* call("coder", { extra: { bypassAgentCheck: true } })).asks).toEqual([])
        }),
      withAgents,
    )

    it.instance(
      "an alias whose target is disabled is an error, not general",
      () =>
        Effect.gen(function* () {
          const { result, seen, asks } = yield* call("coder-execution")
          expect(Exit.isFailure(result)).toBe(true)
          expect(failure(result)).toContain('runs as the agent "coder", which is disabled or not available')
          expect(seen).toBeUndefined()
          expect(asks).toEqual([])
          // An unknown name still falls back.
          expect((yield* call("foo-bar")).seen?.agent).toBe("general")
        }),
      { config: { agent: { ...specialists, coder: { disable: true } } } },
    )

    it.instance(
      "unknown subagent_type runs as general with a note",
      () =>
        Effect.gen(function* () {
          const named = yield* call("foo-bar")
          expect(named.seen?.agent).toBe("general")
          expect(output(named.result as never)).toContain('No agent named "foo-bar"; ran as general.')
          for (const raw of ["<script>alert(1)</script>", "x".repeat(60), '"><x']) {
            const hidden = yield* call(raw)
            expect(hidden.seen?.agent).toBe("general")
            expect(output(hidden.result as never)).toContain("No agent matches the requested name; ran as general.")
            expect(output(hidden.result as never)).not.toContain(raw)
          }
        }),
      withAgents,
    )

    it.instance(
      "unknown subagent_type fails only when general is gone",
      () =>
        Effect.gen(function* () {
          const { result } = yield* call("foo-bar")
          expect(failure(result)).toContain("Unknown agent type: foo-bar is not a valid agent type")
        }),
      { config: { agent: { ...specialists, general: { disable: true } } } },
    )

    it.instance(
      "requested role prefix",
      () =>
        Effect.gen(function* () {
          const architect = firstText((yield* call("task-architect")).seen)
          expect(
            architect.startsWith(
              `<requested_role name="task-architect" agent="planner">\n${RoleAlias.ROLE_LINES["task-architect"]}\n</requested_role>\n\nlook`,
            ),
          ).toBe(true)
          for (const exact of ["planner", "explore", "Explore", "general-purpose"])
            expect([exact, firstText((yield* call(exact)).seen)]).toEqual([exact, "look"])
          // S163-04: the fallback prefix never carries an unsafe requested name.
          for (const raw of ['"><x', "y".repeat(60), "a b"]) {
            const text = firstText((yield* call(raw)).seen)
            expect(text.startsWith('<requested_role name="unnamed" agent="general">')).toBe(true)
            expect(text).not.toContain(raw)
          }
          expect(
            firstText((yield* call("foo-bar")).seen).startsWith('<requested_role name="foo-bar" agent="general">'),
          ).toBe(true)
          // A model argument written for another tool is dropped, and the call still runs (spec 161 C2).
          const extraKey = yield* call("coder-execution", { args: { model: "sonnet" } })
          expect(Exit.isSuccess(extraKey.result)).toBe(true)
          expect(extraKey.seen?.agent).toBe("coder")
        }),
      withAgents,
    )
  })
})
