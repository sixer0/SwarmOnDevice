// Row 111 (SB-2, diagnosis): after an image enters the conversation, does the next request repeat the previous request's
// bytes up to the previous last message? A provider's prefix cache can only hit on bytes it has seen before, so the first
// differing byte inside that prefix is where the cache stops serving.
//
// The harness drives the session's real conversion: `MessageV2.toModelMessages` (and `filterCompacted` for the
// compaction case) -> `LLM.stream` -> `ProviderTransform.message` -> the AI SDK provider -> HTTP. The body is captured as
// raw text at a local fake provider (Bun.serve on port 0), after serialization. Nothing is sent to a real provider.
//
// Prefix rule: request A carries messages[0..n-1]; request B (the next one) must carry the same bytes from offset 0 to
// the end of A's message n-1 (A's closing `]` becomes `,` in B and is excluded). Tool definitions are serialized after
// the messages in the body but rendered before them by chat templates, so they are compared separately.
import { afterAll, beforeAll, describe, expect, setSystemTime } from "bun:test"
import path from "path"
import { tool } from "ai"
import z from "zod"
import { Effect, Stream } from "effect"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { ModelsDev } from "@opencode-ai/core/models-dev"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { LLM } from "../../src/session/llm"
import { Provider } from "@/provider/provider"
import { MessageV2 } from "../../src/session/message-v2"
import { SystemPrompt } from "../../src/session/system"
import { SessionID, MessageID, PartID } from "../../src/session/schema"
import type { Agent } from "../../src/agent/agent"
import { testEffect } from "../lib/effect"

type ConfigModel = NonNullable<NonNullable<ConfigV1.Info["provider"]>[string]["models"]>[string]

const it = testEffect(AppNodeBuilder.build(LayerNode.group([LLM.node, Provider.node])))

// ---------------------------------------------------------------- fake provider (HTTP layer)

const server = {
  instance: null as ReturnType<typeof Bun.serve> | null,
  bodies: [] as string[],
}

const encoder = new TextEncoder()
function sse(lines: unknown[]) {
  const payload = lines.map((line) => `data: ${typeof line === "string" ? line : JSON.stringify(line)}`).join("\n\n")
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(payload + "\n\n"))
        controller.close()
      },
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  )
}

const openAIReply = () =>
  sse([
    { id: "c1", object: "chat.completion.chunk", choices: [{ delta: { role: "assistant" } }] },
    { id: "c1", object: "chat.completion.chunk", choices: [{ delta: { content: "ok" } }] },
    { id: "c1", object: "chat.completion.chunk", choices: [{ delta: {}, finish_reason: "stop" }] },
    "[DONE]",
  ])

const anthropicReply = () =>
  sse([
    {
      type: "message_start",
      message: { id: "m1", model: "claude-opus-4-6", usage: { input_tokens: 3, cache_read_input_tokens: null } },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ])

beforeAll(() => {
  server.instance = Bun.serve({
    port: 0,
    async fetch(req) {
      // Raw bytes as they left the provider SDK: this is what a prefix cache sees.
      server.bodies.push(await req.text())
      return new URL(req.url).pathname.endsWith("/messages") ? anthropicReply() : openAIReply()
    },
  })
})

afterAll(() => {
  void server.instance?.stop()
  setSystemTime()
  console.log(["", "ROW 111 SB-2 REQUEST DIFF REPORT", ...report, ""].join("\n"))
})

const MODELS = JSON.parse(
  await Bun.file(path.join(import.meta.dir, "../tool/fixtures/models-api.json")).text(),
) as Record<string, ModelsDev.Provider>
const claude = MODELS.anthropic!.models["claude-opus-4-6"]!

// Default deployment shape (memory gsp_ai_default_llm): provider gsp-ai-tail, model thinker, OpenAI-compatible.
const config = () => ({
  enabled_providers: ["gsp-ai-tail", "anthropic"],
  provider: {
    "gsp-ai-tail": {
      name: "GSP AI",
      npm: "@ai-sdk/openai-compatible",
      options: { apiKey: "test-key", baseURL: `${server.instance!.url.origin}/v1` },
      models: {
        thinker: {
          name: "thinker",
          attachment: true,
          tool_call: true,
          modalities: { input: ["text", "image"], output: ["text"] },
          limit: { context: 200_000, output: 0 },
        } as ConfigModel,
      },
    },
    anthropic: {
      name: "Anthropic",
      npm: "@ai-sdk/anthropic",
      api: "https://api.anthropic.com/v1",
      options: { apiKey: "test-anthropic-key", baseURL: `${server.instance!.url.origin}/v1` },
      models: {
        [claude.id]: {
          id: claude.id,
          name: claude.name,
          family: claude.family,
          release_date: claude.release_date,
          attachment: claude.attachment,
          reasoning: claude.reasoning,
          temperature: claude.temperature,
          tool_call: claude.tool_call,
          modalities: claude.modalities,
          limit: claude.limit,
        } as ConfigModel,
      },
    },
  },
})

// ---------------------------------------------------------------- synthetic conversation

const sessionID = SessionID.make("ses_row111")
const agent = {
  name: "build",
  mode: "primary",
  options: {},
  permission: [{ permission: "*", pattern: "*", action: "allow" }],
} satisfies Agent.Info

// A tool set like a real turn's, so tool definitions are part of the comparison.
const tools = {
  read: tool({
    description: "Read a file",
    inputSchema: z.object({ filePath: z.string() }),
    execute: async () => "unused",
  }),
}

// Synthetic PNG: the 1x1 PNG signature and chunks, with the index appended so each image's bytes differ.
const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
const png = (index: number) =>
  `data:image/png;base64,${Buffer.concat([Buffer.from(PNG_1X1, "base64"), Buffer.from(`#${index}`)]).toString("base64")}`

type Model = Provider.Model
let clock = 1_000
const ids = { n: 0 }
const nextID = (prefix: string) => `${prefix}_row111_${String(++ids.n).padStart(4, "0")}`

function userMsg(parts: Array<Record<string, unknown>>, model: Model): SessionV1.WithParts {
  const id = MessageID.make(nextID("msg"))
  return {
    info: {
      id,
      sessionID,
      role: "user",
      time: { created: clock++ },
      agent: agent.name,
      model: { providerID: model.providerID, modelID: model.id },
    } as unknown as SessionV1.User,
    parts: parts.map((part) => ({ id: PartID.make(nextID("prt")), sessionID, messageID: id, ...part })) as SessionV1.Part[],
  }
}

function assistantMsg(
  parentID: string,
  parts: Array<Record<string, unknown>>,
  model: Model,
  extra: Record<string, unknown> = {},
): SessionV1.WithParts {
  const id = MessageID.make(nextID("msg"))
  return {
    info: {
      id,
      sessionID,
      role: "assistant",
      parentID,
      time: { created: clock++, completed: clock },
      modelID: model.id,
      providerID: model.providerID,
      mode: agent.name,
      agent: agent.name,
      path: { cwd: "/", root: "/" },
      cost: 0,
      finish: "stop",
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      ...extra,
    } as unknown as SessionV1.Assistant,
    parts: [{ type: "step-start" }, ...parts].map((part) => ({
      id: PartID.make(nextID("prt")),
      sessionID,
      messageID: id,
      ...part,
    })) as SessionV1.Part[],
  }
}

const text = (value: string) => ({ type: "text", text: value })
const filePart = (index: number) => ({ type: "file", mime: "image/png", filename: `img-${index}.png`, url: png(index) })
const reply = (n: number) => text(`Answer ${n}.`)
const readTool = (count: number, compacted = false) => ({
  type: "tool",
  callID: `call_row111_${count}`,
  tool: "read",
  state: {
    status: "completed",
    input: { filePath: "/synthetic/images" },
    output: `Read ${count} image(s)`,
    title: "Read",
    metadata: {},
    time: { start: 1, end: 2, ...(compacted ? { compacted: 3 } : {}) },
    attachments: Array.from({ length: count }, (_, index) => ({
      id: PartID.make(`prt_row111_att_${index}`),
      sessionID,
      messageID: MessageID.make("msg_row111_att"),
      type: "file",
      mime: "image/png",
      filename: `tool-img-${index}.png`,
      url: png(100 + index),
    })),
  },
})

// ---------------------------------------------------------------- one request through the real path

const send = Effect.fn("row111.send")(function* (model: Model, history: SessionV1.WithParts[], system: string[]) {
  const before = server.bodies.length
  const lastUser = history.findLast((msg) => msg.info.role === "user")!.info as SessionV1.User
  const messages = yield* Effect.promise(() => MessageV2.toModelMessages(history, model))
  yield* LLM.Service.use((svc) =>
    svc.stream({ user: lastUser, sessionID, model, agent, system, messages, tools }).pipe(Stream.runDrain),
  )
  expect(server.bodies.length).toBe(before + 1)
  return server.bodies.at(-1)!
})

// ---------------------------------------------------------------- diff

type Diff =
  | { identical: true; prefixBytes: number; previousMessages: number }
  | {
      identical: false
      prefixBytes: number
      previousMessages: number
      offset: number
      path: string
      before: string
      after: string
    }

const cut = (value: unknown) => {
  const json = JSON.stringify(value) ?? "undefined"
  return json.length > 140 ? `${json.slice(0, 140)}...(${json.length} chars)` : json
}

function firstPath(a: unknown, b: unknown, at: string): { path: string; before: string; after: string } | undefined {
  if (a === b) return
  if (typeof a === "string" && typeof b === "string") {
    // Show the window where the two strings part, not their (shared) opening.
    const at0 = Array.from({ length: Math.max(a.length, b.length) }, (_, index) => index).find((i) => a[i] !== b[i])!
    const window = (value: string) => cut(`[char ${at0} of ${value.length}] ${value.slice(Math.max(0, at0 - 30), at0 + 60)}`)
    return { path: at, before: window(a), after: window(b) }
  }
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null || Array.isArray(a) !== Array.isArray(b))
    return { path: at, before: cut(a), after: cut(b) }
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let index = 0; index < Math.max(a.length, b.length); index++) {
      const found = firstPath(a[index], b[index], `${at}[${index}]`)
      if (found) return found
    }
    return
  }
  const left = a as Record<string, unknown>
  const right = b as Record<string, unknown>
  const keysLeft = Object.keys(left)
  const keysRight = Object.keys(right)
  for (const key of [...new Set([...keysLeft, ...keysRight])]) {
    const found = firstPath(left[key], right[key], `${at}.${key}`)
    if (found) return found
  }
  if (keysLeft.join() !== keysRight.join()) return { path: `${at} (key order)`, before: cut(keysLeft), after: cut(keysRight) }
}

/** Compare request B against request A up to the end of A's last message. */
function diff(a: string, b: string, strip?: (key: string) => boolean): Diff {
  const parse = (raw: string) =>
    JSON.parse(raw, strip ? (key, value) => (strip(key) ? undefined : value) : undefined) as Record<string, unknown>
  const left = parse(a)
  const right = parse(b)
  // The bodies are compact JSON.stringify output, so re-stringifying reproduces the bytes (asserted).
  const rawA = JSON.stringify(left)
  const rawB = JSON.stringify(right)
  if (!strip) expect(rawA).toBe(a)
  const messagesA = left.messages as unknown[]
  const marker = `"messages":`
  const start = rawA.indexOf(marker)
  expect(start).toBeGreaterThan(-1)
  const prefixBytes = start + marker.length + JSON.stringify(messagesA).length - 1
  const offset = Array.from({ length: prefixBytes }, (_, index) => index).find((index) => rawA[index] !== rawB[index])
  // Tools serialize after messages but render before them in a chat template: a change there is a miss too.
  const toolsDiff = firstPath(left.tools, right.tools, "$.tools")
  if (offset === undefined && !toolsDiff) return { identical: true, prefixBytes, previousMessages: messagesA.length }
  const { messages: _a, tools: _ta, ...restA } = left
  const { messages: _b, tools: _tb, ...restB } = right
  const found =
    firstPath(restA, restB, "$") ??
    firstPath(messagesA, (right.messages as unknown[]).slice(0, messagesA.length), "$.messages") ??
    toolsDiff!
  return {
    identical: false,
    prefixBytes,
    previousMessages: messagesA.length,
    offset: offset ?? -1,
    ...found,
  }
}

const report: string[] = []
function record(name: string, label: string, result: Diff) {
  const head = `${name} | ${label} | prefix ${result.prefixBytes} B over ${result.previousMessages} messages`
  report.push(
    result.identical
      ? `${head} | IDENTICAL`
      : `${head} | DIFFERS at byte ${result.offset} | ${result.path} | before=${result.before} | after=${result.after}`,
  )
  return result
}

// ---------------------------------------------------------------- the conversation driver

/**
 * text turn -> user turn carrying the image(s) -> two text-only turns. Returns the raw bodies of the request after the
 * image turn (R1), after the first text-only turn (R2) and after the second (R3).
 */
const imageConversation = Effect.fn("row111.imageConversation")(function* (input: {
  model: Model
  images: number
  via: "user-file" | "tool-result"
  system: (turn: number) => string[]
  between?: (history: SessionV1.WithParts[], turn: number) => void
}) {
  const history: SessionV1.WithParts[] = []
  const u0 = userMsg([text("Start of the synthetic session.")], input.model)
  history.push(u0, assistantMsg(u0.info.id, [reply(0)], input.model))
  if (input.via === "user-file") {
    history.push(
      userMsg(
        [text("Look at these images."), ...Array.from({ length: input.images }, (_, index) => filePart(index))],
        input.model,
      ),
    )
  }
  if (input.via === "tool-result") {
    const u1 = userMsg([text("Read the images in /synthetic/images.")], input.model)
    // Step 1 asked for the tool and got the images back; the request after it is the one under test.
    history.push(u1, assistantMsg(u1.info.id, [readTool(input.images)], input.model, { finish: "tool-calls" }))
  }
  const bodies = [yield* send(input.model, history, input.system(1))]
  for (const turn of [2, 3]) {
    const parent = history.findLast((msg) => msg.info.role === "user")!.info.id
    history.push(assistantMsg(parent, [reply(turn - 1)], input.model))
    input.between?.(history, turn)
    history.push(userMsg([text(`Text-only follow-up ${turn}.`)], input.model))
    bodies.push(yield* send(input.model, history, input.system(turn)))
  }
  return bodies
})

const gsp = () => Provider.use.getModel(ProviderV2.ID.make("gsp-ai-tail"), ModelV2.ID.make("thinker"))
const anthropic = () => Provider.use.getModel(ProviderV2.ID.make("anthropic"), ModelV2.ID.make(claude.id))
const staticSystem = () => ["You are a helpful assistant.", "Static environment block."]

const compareAll = (name: string, bodies: string[], strip?: (key: string) => boolean) => [
  record(name, "R1 (image turn) -> R2 (first text-only)", diff(bodies[0]!, bodies[1]!, strip)),
  record(name, "R2 -> R3 (second text-only)", diff(bodies[1]!, bodies[2]!, strip)),
]

// ---------------------------------------------------------------- variations

describe("row 111 SB-2: consecutive provider requests after an image", () => {
  for (const images of [1, 20]) {
    for (const via of ["user-file", "tool-result"] as const) {
      it.instance(
        `openai-compatible gsp-ai-tail: ${images} image(s) via ${via}`,
        () =>
          Effect.gen(function* () {
            const model = yield* gsp()
            const bodies = yield* imageConversation({ model, images, via, system: staticSystem })
            // The image bytes really are in the request (not dropped), and remain in later requests.
            for (const body of bodies) expect(body.split("data:image/png;base64,").length - 1).toBe(images)
            const results = compareAll(`OAI ${images} img ${via}`, bodies)
            for (const result of results) expect(result.identical).toBe(true)
          }),
        { config },
      )
    }
  }

  it.instance(
    "openai-compatible: the image is sent as the same data URL, not re-encoded or downloaded",
    () =>
      Effect.gen(function* () {
        const model = yield* gsp()
        const bodies = yield* imageConversation({ model, images: 1, via: "user-file", system: staticSystem })
        for (const body of bodies) expect(body).toContain(JSON.stringify(png(0)))
      }),
    { config },
  )

  it.instance(
    "openai-compatible: system rebuilt per person message with unchanged inputs stays identical",
    () =>
      Effect.gen(function* () {
        const model = yield* gsp()
        const system = () => ["You are a helpful assistant.", SystemPrompt.installedTools(["rtk", "graft"], ["graft"])!]
        const results = compareAll("OAI system rebuilt, same inputs", yield* imageConversation({
          model,
          images: 20,
          via: "user-file",
          system,
        }))
        for (const result of results) expect(result.identical).toBe(true)
      }),
    { config },
  )

  it.instance(
    "openai-compatible: an MCP server that connects between person messages changes the system prompt",
    () =>
      Effect.gen(function* () {
        const model = yield* gsp()
        // system.ts environment(): installed-tool lines are filtered by the MCP servers connected right now, read
        // fresh for every person message; swarm-web connecting between turn 1 and turn 2 is simulated here.
        const system = (turn: number) => [
          "You are a helpful assistant.",
          SystemPrompt.installedTools(["graft", "searxng"], turn === 1 ? ["graft"] : ["graft", "swarm-web"])!,
        ]
        const [first, second] = compareAll(
          "OAI system: MCP connected set changes",
          yield* imageConversation({ model, images: 20, via: "user-file", system }),
        )
        expect(first!.identical).toBe(false)
        // request.ts joins every system part after the header into the one system message, messages[0].
        if (!first!.identical) expect(first!.path).toBe("$.messages[0].content")
        expect(second!.identical).toBe(true)
      }),
    { config },
  )

  it.instance(
    "openai-compatible: the date line rolls over at midnight",
    () =>
      Effect.gen(function* () {
        const model = yield* gsp()
        // system.ts:349 writes `Today's date: ${new Date().toDateString()}`; the line is formed the same way here.
        const system = (turn: number) => {
          setSystemTime(new Date(turn === 1 ? "2026-11-17T23:59:00" : "2026-11-18T00:01:00"))
          return ["You are a helpful assistant.", `<env>\n  Today's date: ${new Date().toDateString()}\n</env>`]
        }
        const [first, second] = compareAll(
          "OAI system: date rollover",
          yield* imageConversation({ model, images: 20, via: "user-file", system }),
        )
        setSystemTime()
        expect(first!.identical).toBe(false)
        if (!first!.identical) expect(first!.path).toBe("$.messages[0].content")
        expect(second!.identical).toBe(true)
      }),
    { config },
  )

  it.instance(
    "openai-compatible: after a compaction (summary + retained tail holding 20 images)",
    () =>
      Effect.gen(function* () {
        const model = yield* gsp()
        const chronological: SessionV1.WithParts[] = []
        const u0 = userMsg([text("Start.")], model)
        const u1 = userMsg([text("Look at these."), ...Array.from({ length: 20 }, (_, index) => filePart(index))], model)
        chronological.push(u0, assistantMsg(u0.info.id, [reply(0)], model), u1, assistantMsg(u1.info.id, [reply(1)], model))
        const compaction = userMsg([{ type: "compaction", auto: true, tail_start_id: u1.info.id }], model)
        chronological.push(
          compaction,
          assistantMsg(compaction.info.id, [text("Summary of the session so far.")], model, { summary: true }),
        )
        const bodies: string[] = []
        for (const turn of [1, 2, 3]) {
          if (turn > 1) {
            const parent = chronological.findLast((msg) => msg.info.role === "user")!.info.id
            chronological.push(assistantMsg(parent, [reply(turn)], model))
          }
          chronological.push(userMsg([text(`After compaction ${turn}.`)], model))
          // MessageV2.stream yields newest first; filterCompacted reorders to [compaction, summary, tail..., rest].
          bodies.push(yield* send(model, MessageV2.filterCompacted(chronological.toReversed()), staticSystem()))
        }
        expect(bodies[0]!).not.toContain("Start.")
        expect(bodies[0]!.split("data:image/png;base64,").length - 1).toBe(20)
        const results = compareAll("OAI after compaction, 20 img tail", bodies)
        for (const result of results) expect(result.identical).toBe(true)
      }),
    { config },
  )

  it.instance(
    "openai-compatible: a tool output pruned between turns changes the prefix (by design of prune)",
    () =>
      Effect.gen(function* () {
        const model = yield* gsp()
        const [first] = compareAll(
          "OAI tool output pruned between turns",
          yield* imageConversation({
            model,
            images: 20,
            via: "tool-result",
            system: staticSystem,
            // compaction.ts prune marks old tool outputs `time.compacted`; the output and attachments then vanish.
            between: (history, turn) => {
              if (turn !== 2) return
              const part = history.flatMap((msg) => msg.parts).find((item) => item.type === "tool")
              if (part?.type === "tool" && part.state.status === "completed") part.state.time.compacted = 99
            },
          }),
        )
        expect(first!.identical).toBe(false)
      }),
    { config },
  )

  for (const images of [1, 20]) {
    it.instance(
      `anthropic: ${images} image(s) via user-file (raw bytes, then with cache_control markers ignored)`,
      () =>
        Effect.gen(function* () {
          const model = yield* anthropic()
          const bodies = yield* imageConversation({ model, images, via: "user-file", system: staticSystem })
          const raw = compareAll(`ANT ${images} img raw`, bodies)
          // applyCaching (transform.ts:359) puts markers on the last two non-system messages, so they move every turn.
          for (const result of raw) expect(result.identical).toBe(false)
          for (const result of raw) if (!result.identical) expect(result.path).toEndWith(".cache_control")
          const content = compareAll(`ANT ${images} img, cache_control ignored`, bodies, (key) => key === "cache_control")
          for (const result of content) expect(result.identical).toBe(true)
        }),
      { config },
    )
  }
})
