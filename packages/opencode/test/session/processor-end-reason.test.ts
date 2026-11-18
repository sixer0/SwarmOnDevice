// 1.3.3 row 8 (MC-2 item 2): a turn that ends without work stores its reason in `finish` and writes one log line.
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
import { LLMEvent } from "@opencode-ai/llm"

const LOG = "turn ended without work"

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

// A plain answer: one text part, provider reason "stop". No network, no port.
const plainLLM = Layer.succeed(
  LLM.Service,
  LLM.Service.of({
    stream: () =>
      Stream.make(
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.textStart({ id: "text-1" }),
        LLMEvent.textDelta({ id: "text-1", text: "hello" }),
        LLMEvent.textEnd({ id: "text-1" }),
        LLMEvent.stepFinish({ index: 0, reason: "stop" }),
        LLMEvent.finish({ reason: "stop" }),
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

const stored = (sessionID: SessionID, messageID: MessageID) =>
  Effect.gen(function* () {
    const found = yield* MessageV2.get({ sessionID, messageID })
    if (found.info.role !== "assistant") throw new Error("not an assistant message")
    return found.info
  })

const cases: {
  name: string
  end: SessionProcessor.TurnEnd
  finish: string
  reason: SessionProcessor.TurnEndReason
  server?: string
}[] = [
  { name: "text call", end: { reason: "text-tool-call", corrections: 2 }, finish: "text-tool-call", reason: "text-tool-call" },
  {
    name: "server tools unavailable",
    end: { reason: "tools-unavailable", server: "datum-studio", corrections: 0 },
    finish: "tools-unavailable:datum-studio",
    reason: "tools-unavailable",
    server: "datum-studio",
  },
  { name: "empty step", end: { reason: "empty-step", corrections: 2 }, finish: "empty-step", reason: "empty-step" },
]

for (const item of cases) {
  it.live(`row 8: ${item.name} is stored in finish and logged once`, () => {
    const lines: Line[] = []
    return captureLogs(
      lines,
      provideTmpdirInstance(
        (dir) =>
          Effect.gen(function* () {
            const { chat, msg, handle, input } = yield* setup(dir)
            // The step itself ends normally (provider reason "stop"); the loop then decides the turn did no work.
            expect(yield* handle.process(input)).toBe("continue")
            expect(handle.message.finish).toBe("stop")

            yield* handle.endWithoutWork(item.end)

            const info = yield* stored(chat.id, msg.id)
            expect(info.finish).toBe(item.finish)
            expect(info.error).toBeUndefined()
            expect(info.time.completed).toBeNumber()
            expect(handle.message.finish).toBe(item.finish)
            expect(SessionProcessor.parseTurnEnd(info.finish)).toEqual(
              item.server ? { reason: item.reason, server: item.server } : { reason: item.reason },
            )
            // The provider's own reason stays on the step-finish part.
            const parts = yield* MessageV2.parts(msg.id)
            expect(parts.filter((part) => part.type === "step-finish").map((part) => part.reason)).toEqual(["stop"])

            const hits = lines.filter((line) => line.message === LOG)
            expect(hits.length).toBe(1)
            expect(hits[0].fields["session.id"]).toBe(chat.id)
            expect(hits[0].fields.messageID).toBe(msg.id)
            expect(hits[0].fields.reason).toBe(item.reason)
            expect(hits[0].fields.corrections).toBe(item.end.corrections)
            if (item.server) expect(hits[0].fields.server).toBe(item.server)
            else expect("server" in hits[0].fields).toBe(false)
          }),
        { config: cfg },
      ),
    )
  })
}

it.live("row 8: a normal finish carries no end reason and writes no line", () => {
  const lines: Line[] = []
  return captureLogs(
    lines,
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const { chat, msg, handle, input } = yield* setup(dir)
          expect(yield* handle.process(input)).toBe("continue")
          const info = yield* stored(chat.id, msg.id)
          expect(info.finish).toBe("stop")
          expect(info.error).toBeUndefined()
          expect(SessionProcessor.parseTurnEnd(info.finish)).toBeUndefined()
          expect(lines.filter((line) => line.message === LOG).length).toBe(0)
        }),
      { config: cfg },
    ),
  )
})

test("row 8: finish values and parsing", () => {
  expect(SessionProcessor.TURN_END_REASONS).toEqual(["text-tool-call", "tools-unavailable", "empty-step"])
  expect(SessionProcessor.turnEndFinish({ reason: "text-tool-call", corrections: 2 })).toBe("text-tool-call")
  expect(SessionProcessor.turnEndFinish({ reason: "empty-step", corrections: 2 })).toBe("empty-step")
  expect(SessionProcessor.turnEndFinish({ reason: "tools-unavailable", server: "datum-studio", corrections: 0 })).toBe(
    "tools-unavailable:datum-studio",
  )
  // A server name may itself hold a colon: everything after the first one is the server.
  expect(SessionProcessor.parseTurnEnd("tools-unavailable:my:server")).toEqual({
    reason: "tools-unavailable",
    server: "my:server",
  })
  expect(SessionProcessor.parseTurnEnd("tools-unavailable")).toEqual({ reason: "tools-unavailable" })
  for (const value of [undefined, "", "stop", "tool-calls", "unknown", "length", "error", "content-filter", "end_turn"])
    expect(SessionProcessor.parseTurnEnd(value)).toBeUndefined()
  // Only exact values: a provider reason that merely starts alike is not an end reason.
  expect(SessionProcessor.parseTurnEnd("empty-step-2")).toBeUndefined()
  expect(SessionProcessor.parseTurnEnd("text-tool-call:x")).toBeUndefined()
})
