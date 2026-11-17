import { afterEach, describe, expect } from "bun:test"
import { Database } from "@opencode-ai/core/database/database"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Effect, Layer } from "effect"
import { EventV2Bridge } from "@/event-v2-bridge"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Provider } from "@/provider/provider"
import { Session as SessionNs } from "@/session/session"
import { SessionCompaction } from "../../src/session/compaction"
import { MissionBinding } from "../../src/session/mission-binding"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionProcessor } from "../../src/session/processor"
import { ProviderTest } from "../fake/provider"
import { testEffect } from "../lib/effect"

// MC-6 item 1 / KL-2 item 3 (1.3.3 row 104): after an auto-compact a mission-bound session is told to read its mission
// first, and the summary carries the mission state in a fixed block the model did not write.
// Ids are synthetic. The binding is filled through `MissionBinding.observe` with the host's result shapes, the same way
// session/tools.ts fills it (test/session/mission-binding.test.ts).

const ref = { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") }
const M1 = "2026-11-17_alpha"
const CONTINUE = "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed."
const INSTRUCTION = `Read the mission state first: call datum-studio_studio_mission_get for mission ${M1} before any other step.`

const model = {
  id: "test-model",
  providerID: "test",
  name: "Test",
  limit: { context: 100_000, output: 32_000 },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  capabilities: {
    toolcall: true,
    attachment: false,
    reasoning: false,
    temperature: true,
    input: { text: true, image: false, audio: false, video: false },
    output: { text: true, image: false, audio: false, video: false },
  },
  api: { npm: "@ai-sdk/anthropic" },
  options: {},
} as Provider.Model

// The model-written summary: the fake processor writes this text as the summary's own part, as a real reply would.
const MODEL_SUMMARY = "Goal: finish the report. Progress: chapter 2 drafted."

// The session service of the running test, so the fake's `process` (typed without requirements) can write the part.
const current: { ssn?: SessionNs.Interface } = {}

const processor = Layer.succeed(
  SessionProcessor.Service,
  SessionProcessor.Service.of({
    create: Effect.fn("TestSessionProcessor.create")((input) =>
      Effect.succeed({
        get message() {
          return input.assistantMessage
        },
        updateToolCall: Effect.fn("TestSessionProcessor.updateToolCall")(() => Effect.succeed(undefined)),
        completeToolCall: Effect.fn("TestSessionProcessor.completeToolCall")(() => Effect.void),
        process: Effect.fn("TestSessionProcessor.process")(function* () {
          const ssn = current.ssn
          if (!ssn) return yield* Effect.die("session service not set")
          yield* ssn.updatePart({
            id: PartID.ascending(),
            messageID: input.assistantMessage.id,
            sessionID: input.sessionID,
            type: "text",
            text: MODEL_SUMMARY,
          })
          return "continue" as const
        }),
        endWithoutWork: Effect.fn("TestSessionProcessor.endWithoutWork")(() => Effect.void),
      } satisfies SessionProcessor.Handle),
    ),
  }),
)

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      SessionCompaction.node,
      SessionNs.node,
      SessionProjector.node,
      Database.node,
      EventV2Bridge.node,
      CrossSpawnSpawner.node,
    ]),
    [
      [Provider.node, ProviderTest.fake({ model }).layer],
      [SessionProcessor.node, processor],
      [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true })],
    ],
  ),
)

afterEach(() => MissionBinding.reset())

const ok = (tool: string, data: Record<string, unknown>) => ({
  content: [{ type: "text", text: "x" }],
  structuredContent: { ok: true, tool, ...data },
})

function bindRunning(sessionID: string) {
  MissionBinding.observe({
    sessionID,
    tool: "studio_mission_get",
    args: { mission: M1 },
    result: ok("studio_mission_get", {
      mission: {
        id: M1,
        status: "running",
        rows: [
          { id: "1", status: "done" },
          {
            id: "2",
            status: "running",
            knowledge: { domains: [{ domain: "COMPUTER-VISION", firstFile: "cv/00_index.md", consulted: [] }] },
          },
          { id: "5", status: "running" },
        ],
        locks: [{ resource: "lock:build", row: "2", holder: "h", acquiredAt: "2026-11-17T00:00:00Z" }],
      },
    }),
  })
}

function bindEmpty(sessionID: string) {
  MissionBinding.observe({
    sessionID,
    tool: "studio_mission_create",
    args: {},
    result: ok("studio_mission_create", { id: M1, status: "draft", rows: 2, waves: [], issues: [], dryRun: false }),
  })
}

function seed(sessionID: SessionID) {
  return Effect.gen(function* () {
    const ssn = yield* SessionNs.Service
    const msg = yield* ssn.updateMessage({
      id: MessageID.ascending(),
      role: "user",
      sessionID,
      agent: "build",
      model: ref,
      time: { created: Date.now() },
    })
    yield* ssn.updatePart({ id: PartID.ascending(), messageID: msg.id, sessionID, type: "text", text: "hello" })
    return msg
  })
}

function compact(sessionID: SessionID, auto: boolean) {
  return Effect.gen(function* () {
    const ssn = yield* SessionNs.Service
    current.ssn = ssn
    const msg = yield* seed(sessionID)
    const result = yield* SessionCompaction.use.process({
      parentID: msg.id,
      messages: yield* ssn.messages({ sessionID }),
      sessionID,
      auto,
    })
    const all = yield* ssn.messages({ sessionID })
    const summary = all.find((m) => m.info.role === "assistant" && m.info.summary)
    const last = all.at(-1)
    const texts = (parts: typeof all[number]["parts"] | undefined) =>
      (parts ?? []).flatMap((part) => (part.type === "text" ? [part.text] : []))
    return { result, summaryTexts: texts(summary?.parts), last, continueText: texts(last?.parts).join("") }
  })
}

describe("session.compaction mission state (MC-6, row 104)", () => {
  it.instance(
    "unbound session: continue message and summary are unchanged",
    Effect.gen(function* () {
      const ssn = yield* SessionNs.Service
      const session = yield* ssn.create({})
      const out = yield* compact(session.id, true)
      expect(out.result).toBe("continue")
      expect(out.last?.info.role).toBe("user")
      expect(out.continueText).toBe(CONTINUE)
      expect(out.summaryTexts).toEqual([MODEL_SUMMARY])
    }),
  )

  it.instance(
    "bound session: first line of the continue message is the read-mission instruction, then the old text",
    Effect.gen(function* () {
      const ssn = yield* SessionNs.Service
      const session = yield* ssn.create({})
      bindRunning(session.id)
      const out = yield* compact(session.id, true)
      expect(out.result).toBe("continue")
      expect(out.last?.parts[0]).toMatchObject({ type: "text", synthetic: true, metadata: { compaction_continue: true } })
      expect(out.continueText.split("\n")[0]).toBe(INSTRUCTION)
      expect(out.continueText).toBe(`${INSTRUCTION}\n\n${CONTINUE}`)
    }),
  )

  it.instance(
    "bound session: the summary keeps the model text and gains the fixed Mission state block after it",
    Effect.gen(function* () {
      const ssn = yield* SessionNs.Service
      const session = yield* ssn.create({})
      bindRunning(session.id)
      const out = yield* compact(session.id, true)
      expect(out.summaryTexts[0]).toBe(MODEL_SUMMARY)
      expect(out.summaryTexts.at(-1)).toBe(
        [
          "Mission state",
          `- mission: ${M1}`,
          "- running rows: 2, 5",
          "- locks: lock:build",
          "- knowledge: row 2 COMPUTER-VISION, first file cv/00_index.md",
        ].join("\n"),
      )
    }),
  )

  it.instance(
    "bound session with nothing running: the block says none and points to the mission for locks",
    Effect.gen(function* () {
      const ssn = yield* SessionNs.Service
      const session = yield* ssn.create({})
      bindEmpty(session.id)
      const out = yield* compact(session.id, true)
      expect(out.summaryTexts.at(-1)).toBe(
        [
          "Mission state",
          `- mission: ${M1}`,
          "- running rows: none",
          "- locks: none recorded; read from mission",
          "- knowledge: none recorded",
        ].join("\n"),
      )
      expect(out.continueText.split("\n")[0]).toBe(INSTRUCTION)
    }),
  )

  it.instance(
    "manual compaction of a bound session: block in the summary, no continue message",
    Effect.gen(function* () {
      const ssn = yield* SessionNs.Service
      const session = yield* ssn.create({})
      bindRunning(session.id)
      const out = yield* compact(session.id, false)
      expect(out.last?.info.role).toBe("assistant")
      expect(out.summaryTexts.at(-1)?.startsWith("Mission state\n")).toBe(true)
    }),
  )

  it.instance(
    "sub-agent session does not inherit its parent's binding (row 9 rule)",
    Effect.gen(function* () {
      const ssn = yield* SessionNs.Service
      const parent = yield* ssn.create({})
      const child = yield* ssn.create({ parentID: parent.id })
      bindRunning(parent.id)
      const out = yield* compact(child.id, true)
      expect(out.continueText).toBe(CONTINUE)
      expect(out.summaryTexts).toEqual([MODEL_SUMMARY])
    }),
  )

  it.instance(
    "sub-agent session with its own binding gets its own mission state",
    Effect.gen(function* () {
      const ssn = yield* SessionNs.Service
      const parent = yield* ssn.create({})
      const child = yield* ssn.create({ parentID: parent.id })
      bindRunning(child.id)
      const out = yield* compact(child.id, true)
      expect(out.continueText.split("\n")[0]).toBe(INSTRUCTION)
      expect(out.summaryTexts.at(-1)?.startsWith("Mission state\n")).toBe(true)
    }),
  )
})
