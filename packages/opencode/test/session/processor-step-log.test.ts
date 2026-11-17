// 1.3.3 row 113 (SB-2): every step finish writes one log line with the four token counts.
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2Bridge } from "@/event-v2-bridge"
import { expect, test } from "bun:test"
import { Effect, Layer, Logger, Stream } from "effect"
import path from "path"
import { Provider } from "@/provider/provider"
import { Session } from "@/session/session"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionProcessor } from "../../src/session/processor"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { SessionSummary } from "../../src/session/summary"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { LLMEvent, Usage } from "@opencode-ai/llm"

const LOG = "step finish"

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

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
      options: { apiKey: "test-key", baseURL: "http://localhost:1/v1" },
    },
  },
}

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

// One step whose usage is set per test. No network, no port.
let current: Usage | undefined
const plainLLM = Layer.succeed(
  LLM.Service,
  LLM.Service.of({
    stream: () =>
      Stream.suspend(() =>
        Stream.make(
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.textStart({ id: "text-1" }),
          LLMEvent.textDelta({ id: "text-1", text: "hello" }),
          LLMEvent.textEnd({ id: "text-1" }),
          LLMEvent.stepFinish({ index: 0, reason: "stop", ...(current ? { usage: current } : {}) }),
          LLMEvent.finish({ reason: "stop" }),
        ),
      ),
  }),
)

const root = LayerNode.group([
  SessionProcessor.node,
  Session.node,
  SessionProjector.node,
  Provider.node,
  Database.node,
  EventV2Bridge.node,
  SessionStatus.node,
  CrossSpawnSpawner.node,
])
const env = LayerNode.compile(root, [
  [SessionSummary.node, summary],
  [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true })],
  [LLM.node, plainLLM],
])
const it = testEffect(env)

type Line = { message: string; fields: Record<string, unknown> }

/** Collects every log line as its text plus the merged annotation objects. */
const captureLogs = <A, E, R>(lines: Line[], self: Effect.Effect<A, E, R>) =>
  self.pipe(
    Effect.provide(
      Logger.layer([
        Logger.make<unknown, void>((options) => {
          const items = Array.isArray(options.message) ? options.message : [options.message]
          const fields: Record<string, unknown> = {}
          for (const item of items) if (item && typeof item === "object") Object.assign(fields, item)
          lines.push({ message: items.filter((item) => typeof item === "string").join(" "), fields })
        }),
      ]),
    ),
  )

const setup = Effect.fn("test.setup")(function* (dir: string) {
  const processors = yield* SessionProcessor.Service
  const session = yield* Session.Service
  const provider = yield* Provider.Service
  const chat = yield* session.create({})
  const parent = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: chat.id,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  yield* session.updatePart({ id: PartID.ascending(), messageID: parent.id, sessionID: chat.id, type: "text", text: "hi" })
  const msg: SessionV1.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    sessionID: chat.id,
    mode: "build",
    agent: "build",
    path: { cwd: path.resolve(dir), root: path.resolve(dir) },
    cost: 0,
    tokens: { total: 0, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    parentID: parent.id,
    time: { created: Date.now() },
  }
  yield* session.updateMessage(msg)
  const model = yield* provider.getModel(ref.providerID, ref.modelID)
  const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model })
  const input = {
    user: {
      id: parent.id,
      sessionID: chat.id,
      role: "user",
      time: parent.time,
      agent: parent.agent,
      model: { providerID: ref.providerID, modelID: ref.modelID },
    } satisfies SessionV1.User,
    sessionID: chat.id,
    model,
    agent: {
      name: "build",
      mode: "primary" as const,
      options: {},
      permission: [{ permission: "*", pattern: "*", action: "allow" as const }],
    },
    system: [],
    messages: [{ role: "user" as const, content: "hi" }],
    tools: {},
  } satisfies LLM.StreamInput
  return { chat, msg, handle, input }
})


const run = (usage: Usage | undefined, check: (lines: Line[], ids: { session: string; message: string }) => void) => {
  current = usage
  const lines: Line[] = []
  return captureLogs(
    lines,
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const { chat, msg, handle, input } = yield* setup(dir)
          expect(yield* handle.process(input)).toBe("continue")
          check(lines, { session: chat.id, message: msg.id })
        }),
      { config: cfg },
    ),
  )
}

it.live("row 113: one step finish line carries input, output, cache read and cache write", () =>
  run(new Usage({ inputTokens: 1000, outputTokens: 50, cacheReadInputTokens: 600, cacheWriteInputTokens: 100 }), (lines, ids) => {
    const hits = lines.filter((line) => line.message === LOG)
    expect(hits.length).toBe(1)
    expect(hits[0].fields["session.id"]).toBe(ids.session)
    expect(hits[0].fields.messageID).toBe(ids.message)
    expect(hits[0].fields.reason).toBe("stop")
    // input is the non-cached count (1000 - 600 - 100), as stored on the step-finish part
    expect(hits[0].fields["tokens.input"]).toBe(300)
    expect(hits[0].fields["tokens.output"]).toBe(50)
    expect(hits[0].fields["tokens.cache.read"]).toBe(600)
    expect(hits[0].fields["tokens.cache.write"]).toBe(100)
  }),
)

it.live("row 113: a provider without cache fields logs zeros", () =>
  run(new Usage({ inputTokens: 40, outputTokens: 7 }), (lines) => {
    const hits = lines.filter((line) => line.message === LOG)
    expect(hits.length).toBe(1)
    expect(hits[0].fields["tokens.input"]).toBe(40)
    expect(hits[0].fields["tokens.output"]).toBe(7)
    expect(hits[0].fields["tokens.cache.read"]).toBe(0)
    expect(hits[0].fields["tokens.cache.write"]).toBe(0)
  }),
)

it.live("row 113: no usage at all logs zeros", () =>
  run(undefined, (lines) => {
    const hits = lines.filter((line) => line.message === LOG)
    expect(hits.length).toBe(1)
    for (const key of ["tokens.input", "tokens.output", "tokens.cache.read", "tokens.cache.write"])
      expect(hits[0].fields[key]).toBe(0)
  }),
)
