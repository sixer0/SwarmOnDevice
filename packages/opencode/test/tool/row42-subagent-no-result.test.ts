// 1.2.6 row 42 (S-03a): an empty or unfinished subagent result is reported with SUBAGENT_NO_RESULT and its reason,
// never as an empty <task_result> with state "completed".
import { afterEach, describe, expect } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Cause, Effect, Exit } from "effect"
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
import * as Task from "../../src/tool/task"
import { Truncate } from "@/tool/truncate"
import { ToolRegistry } from "@/tool/registry"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"

afterEach(async () => {
  await disposeAllInstances()
})

// Register N-103.
const PREFIX = "Subagent returned no result:"

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

const it = testEffect(
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
    [[RuntimeFlags.node, RuntimeFlags.layer({})]],
  ),
)

type Finish = SessionV1.Assistant["finish"]

function message(sessionID: SessionID, finish: Finish, texts: string[]): SessionV1.WithParts {
  const id = MessageID.ascending()
  return {
    info: {
      id,
      role: "assistant",
      parentID: MessageID.ascending(),
      sessionID,
      mode: "general",
      agent: "general",
      cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: ref.modelID,
      providerID: ref.providerID,
      time: { created: Date.now() },
      finish,
    },
    parts: texts.map((text) => ({ id: PartID.ascending(), messageID: id, sessionID, type: "text" as const, text })),
  }
}

const seed = Effect.fn("Row42Test.seed")(function* () {
  const session = yield* Session.Service
  const chat = yield* session.create({ title: "row 42" })
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
    modelID: ref.modelID,
    providerID: ref.providerID,
    time: { created: Date.now() },
  }
  yield* session.updateMessage(assistant)
  return { chat, assistant }
})

const runWith = (finish: Finish, texts: string[]) =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const { chat, assistant } = yield* seed()
    const tool = yield* Task.TaskTool
    const def = yield* tool.init()
    const ops: Task.TaskPromptOps = {
      cancel: () => Effect.void,
      resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
      prompt: (input: SessionPrompt.PromptInput) => Effect.sync(() => message(input.sessionID, finish, texts)),
    }
    const exit = yield* def
      .execute(
        { description: "write chapter", prompt: "write the chapter", subagent_type: "general" },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps: ops },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )
      .pipe(Effect.exit)
    const child = (yield* sessions.children(chat.id))[0]
    return { exit, child }
  })

const failureText = (exit: Exit.Exit<unknown, unknown>) => {
  if (Exit.isSuccess(exit)) return `SUCCESS: ${JSON.stringify((exit.value as { output?: string }).output)}`
  const failure = Cause.squash(exit.cause)
  return failure instanceof Error ? failure.message : String(failure)
}

describe("row 42 S-03a: subagent with no result", () => {
  const sid = SessionID.make("ses_row42")

  it.instance("taskOutcome: finish length and no text is an empty outcome with reason length", () =>
    Effect.sync(() => {
      const outcome = Task.taskOutcome(sid, message(sid, "length", [])) as { type: string; reason?: string; text?: string }
      expect(outcome.type).toBe("empty")
      expect(outcome.reason).toBe("length")
      expect(outcome.text?.startsWith(PREFIX)).toBe(true)
      expect(outcome.text).toContain("length")
      expect(outcome.text).toContain(sid)
    }),
  )

  it.instance("taskOutcome: reasons no-text, tool-calls and unfinished", () =>
    Effect.sync(() => {
      const of = (finish: Finish, texts: string[]) =>
        Task.taskOutcome(sid, message(sid, finish, texts)) as { type: string; reason?: string; text?: string }
      expect(of("stop", [""])).toMatchObject({ type: "empty", reason: "no-text" })
      expect(of("stop", ["   "])).toMatchObject({ type: "empty", reason: "no-text" })
      const tools = of("tool-calls", ["half way"])
      expect(tools).toMatchObject({ type: "empty", reason: "tool-calls" })
      expect(tools.text).toContain("half way")
      expect(of(undefined, [])).toMatchObject({ type: "empty", reason: "unfinished" })
      expect(of("unknown", ["x"])).toMatchObject({ type: "empty", reason: "unfinished" })
      // Unchanged: a finished answer with text is completed, a truncated one with text keeps its text.
      expect(of("stop", ["the answer"])).toMatchObject({ type: "completed", text: "the answer" })
      expect(of("length", ["partial answer"])).toMatchObject({ type: "completed", text: "partial answer" })
    }),
  )

  it.instance("the constant is exported beside SUBAGENT_STOPPED and re-exported by the task tool", () =>
    Effect.sync(() => {
      expect((Task as Record<string, unknown>).SUBAGENT_NO_RESULT).toBe(PREFIX)
    }),
  )

  it.instance("task tool: finish length with no text fails with SUBAGENT_NO_RESULT, not an empty task_result", () =>
    Effect.gen(function* () {
      const { exit, child } = yield* runWith("length", [])
      const text = failureText(exit)
      expect(text).not.toContain("<task_result>\n\n</task_result>")
      expect(Exit.isFailure(exit)).toBe(true)
      expect(text.startsWith(PREFIX)).toBe(true)
      expect(text).toContain("length")
      expect(text).toContain(`task_id: ${child?.id}`)
    }),
  )

  it.instance("task tool: a finished run with no text fails with reason no-text", () =>
    Effect.gen(function* () {
      const { exit } = yield* runWith("stop", [""])
      expect(Exit.isFailure(exit)).toBe(true)
      const text = failureText(exit)
      expect(text.startsWith(PREFIX)).toBe(true)
      expect(text).toContain("no-text")
    }),
  )

  it.instance("task tool: a normal answer still completes", () =>
    Effect.gen(function* () {
      const { exit } = yield* runWith("stop", ["done"])
      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isSuccess(exit)) expect(exit.value.output).toContain("<task_result>\ndone\n</task_result>")
    }),
  )
})
