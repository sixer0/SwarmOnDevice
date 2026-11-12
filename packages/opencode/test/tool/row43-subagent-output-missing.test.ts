// 1.2.6 row 43 (S-03b): a task call with `expected_outputs` returns SUBAGENT_OUTPUT_MISSING naming every listed path
// that is absent after the run (paths resolved against the session directory; existence only).
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
import { InstanceState } from "@/effect/instance-state"
import * as fs from "node:fs"
import * as path from "path"
import { ModelV2 } from "@opencode-ai/core/model"

afterEach(async () => {
  await disposeAllInstances()
})
// Register N-105.
const PREFIX = "Promised output missing:"

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

const seed = Effect.fn("Row43Test.seed")(function* () {
  const session = yield* Session.Service
  const chat = yield* session.create({ title: "row 43" })
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

const runWith = (finish: Finish, texts: string[], expected?: string[]) =>
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
        { description: "write chapter", prompt: "write the chapter", subagent_type: "general", expected_outputs: expected },
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

describe("row 43 S-03b: expected_outputs", () => {
  it.instance("the constant is exported beside SUBAGENT_NO_RESULT and re-exported by the task tool", () =>
    Effect.sync(() => {
      expect((Task as Record<string, unknown>).SUBAGENT_OUTPUT_MISSING).toBe(PREFIX)
      expect(Task.Parameters.fields).toHaveProperty("expected_outputs")
    }),
  )

  it.instance("an absent promised path fails the task with SUBAGENT_OUTPUT_MISSING naming only the absent paths", () =>
    Effect.gen(function* () {
      const dir = (yield* InstanceState.context).directory
      fs.mkdirSync(path.join(dir, "out"), { recursive: true })
      fs.writeFileSync(path.join(dir, "out", "made.md"), "x")
      const absolute = path.join(dir, "out", "absolute-missing.md")
      const { exit, child } = yield* runWith("stop", ["chapter written"], ["out/made.md", "out/never.md", absolute])
      expect(Exit.isFailure(exit)).toBe(true)
      const text = failureText(exit)
      expect(text.startsWith(PREFIX)).toBe(true)
      expect(text).toContain("out/never.md")
      expect(text).toContain(absolute)
      expect(text).not.toContain("out/made.md")
      expect(text).toContain(`task_id: ${child?.id}`)
      expect(text).toContain("chapter written")
    }),
  )

  it.instance("all promised paths present (relative and absolute): the task completes normally", () =>
    Effect.gen(function* () {
      const dir = (yield* InstanceState.context).directory
      fs.writeFileSync(path.join(dir, "a.md"), "a")
      const { exit } = yield* runWith("stop", ["done"], ["a.md", path.join(dir, "a.md")])
      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isSuccess(exit)) expect(exit.value.output).toContain("<task_result>\ndone\n</task_result>")
    }),
  )

  it.instance("without expected_outputs nothing changes", () =>
    Effect.gen(function* () {
      const { exit } = yield* runWith("stop", ["done"])
      expect(Exit.isSuccess(exit)).toBe(true)
    }),
  )
})
