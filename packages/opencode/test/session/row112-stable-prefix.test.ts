// Rows 112 (SB-2) and 105 (MC-6 item 2): the request prefix stays byte-stable across person messages, and each turn
// carries one context fact line.
//
// Part 1 (pure): the turn-facts block. Wording of the fact line (register section 10), numbers from the same functions
// the overflow and price-target checks use (overflow.ts), and the "append, never rewrite" rule for facts that change
// during a session (date, installed tools, MCP instructions, the researcher routing line).
//
// Part 2 (real prompt loop): `SessionPrompt.loop` against a local fake provider (TestLLMServer). Six person messages:
// a text turn, a turn with 20 images, text-only turns, an MCP server connecting (instructions arrive and swarm-web
// connects), and the date rolling over at midnight. The request of turn N+1 must repeat the request of turn N byte for
// byte up to and including turn N's last message; tool definitions must stay identical. Synthetic data only.
import { afterAll, describe, expect, setSystemTime, test } from "bun:test"
import path from "node:path"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Effect, Layer } from "effect"
import { BackgroundJob } from "@/background/job"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { LSP } from "@/lsp/lsp"
import { Provider as ProviderSvc } from "@/provider/provider"
import type { Provider } from "@/provider/provider"
import { Session } from "@/session/session"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { Agent as AgentSvc } from "../../src/agent/agent"
import { Command } from "../../src/command"
import { Env } from "../../src/env"
import { Format } from "../../src/format"
import { Git } from "../../src/git"
import { Image } from "../../src/image/image"
import { MCP } from "../../src/mcp"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { Question } from "../../src/question"
import { SessionCompaction } from "../../src/session/compaction"
import { Instruction } from "../../src/session/instruction"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { count, priceTarget, usable } from "../../src/session/overflow"
import { SessionProcessor } from "../../src/session/processor"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionRevert } from "../../src/session/revert"
import { SessionRunState } from "../../src/session/run-state"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { SessionSummary } from "../../src/session/summary"
import { SystemPrompt } from "../../src/session/system"
import { TurnFacts } from "../../src/session/turn-facts"
import { Todo } from "../../src/session/todo"
import { Skill } from "../../src/skill"
import { Snapshot } from "../../src/snapshot"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"

type Tokens = SessionV1.Assistant["tokens"]
const tokens = (input: number, output: number, read = 0, write = 0, total?: number): Tokens => ({
  input,
  output,
  reasoning: 0,
  cache: { read, write },
  ...(total === undefined ? {} : { total }),
})

const model = (patch: Record<string, unknown> = {}) =>
  ({
    providerID: "test",
    id: "test-model",
    api: { id: "test-model" },
    limit: { context: 100_000, output: 10_000 },
    cost: { input: 0, output: 0 },
    ...patch,
  }) as unknown as Provider.Model

// ================================================================ part 1: the block itself

describe("rows 112/105: turn facts block (pure)", () => {
  test("fact line wording is the register's, exactly", () => {
    expect(TurnFacts.contextLine({ used: 12_345, limit: 200_000, threshold: 180_000 })).toBe(
      "Context: 12345 of 200000 tokens used; compaction at 180000.",
    )
  })

  test("numbers are the overflow check's: count(), limit.context, lower of usable() and priceTarget()", () => {
    const cfg = {}
    const free = model()
    const t = tokens(30_000, 2_000, 10_000, 500)
    expect(TurnFacts.context({ cfg, model: free, tokens: t })).toEqual({
      used: count(t),
      limit: 100_000,
      threshold: usable({ cfg, model: free }),
    })
    // `total` wins when the provider reported it, as in count().
    expect(TurnFacts.context({ cfg, model: free, tokens: tokens(1, 1, 0, 0, 777) }).used).toBe(777)

    // A paid model with a big window: the price target is lower than the window and is the one that fires first.
    const paid = model({ limit: { context: 1_000_000, output: 32_000 }, cost: { input: 3, output: 15 } })
    const target = priceTarget({ cfg, model: paid })!
    expect(target).toBeLessThan(usable({ cfg, model: paid }))
    expect(TurnFacts.context({ cfg, model: paid, tokens: t }).threshold).toBe(target)
    // The loop turned the price target off for the rest of the run: only the window is left.
    expect(TurnFacts.context({ cfg, model: paid, tokens: t, priceTargetOff: true }).threshold).toBe(
      usable({ cfg, model: paid }),
    )
    // The same flags the check uses reach the numbers (outputTokenMax moves usable()).
    expect(TurnFacts.context({ cfg, model: free, tokens: t, outputTokenMax: 4_000 }).threshold).toBe(
      usable({ cfg, model: free, outputTokenMax: 4_000 }),
    )
  })

  test("no finished step yet, or the last one is a summary: used is 0, as the check does not run then", () => {
    expect(TurnFacts.context({ cfg: {}, model: model() }).used).toBe(0)
  })

  test("auto compaction off: the line says off", () => {
    const facts = TurnFacts.context({ cfg: { compaction: { auto: false } }, model: model(), tokens: tokens(5, 5) })
    expect(facts.threshold).toBeUndefined()
    expect(TurnFacts.contextLine(facts)).toBe("Context: 10 of 100000 tokens used; compaction at off.")
  })

  const now = (patch: Partial<TurnFacts.Volatile> = {}): TurnFacts.Volatile => ({
    date: "Tue Nov 17 2026",
    tools: "<installed_tools>\n  rtk\n</installed_tools>",
    mcp: undefined,
    routing: undefined,
    ...patch,
  })
  const line = "Context: 0 of 100000 tokens used; compaction at 90000."

  const userWith = (id: string, emitted?: TurnFacts.Emitted) =>
    ({
      info: { id, role: "user" },
      parts: [
        { id: `${id}_a`, type: "text", text: "person text" },
        ...(emitted ? [{ id: `${id}_b`, type: "text", text: "x", synthetic: true, metadata: { turnFacts: emitted } }] : []),
      ],
    }) as unknown as SessionV1.WithParts

  test("first turn: every known fact, then the fact line last, inside one tagged block", () => {
    const out = TurnFacts.render({ seen: {}, now: now(), line })
    expect(out.text).toBe(
      [
        "<turn_facts>",
        "Today's date: Tue Nov 17 2026",
        "<installed_tools>\n  rtk\n</installed_tools>",
        line,
        "</turn_facts>",
      ].join("\n"),
    )
    expect(out.emitted).toEqual({ date: "Tue Nov 17 2026", tools: "<installed_tools>\n  rtk\n</installed_tools>" })
  })

  test("later turn with nothing changed: only the fact line", () => {
    const seen = TurnFacts.seen([userWith("msg_1", { date: "Tue Nov 17 2026", tools: now().tools })])
    const out = TurnFacts.render({ seen, now: now(), line })
    expect(out.text).toBe(["<turn_facts>", line, "</turn_facts>"].join("\n"))
    expect(out.emitted).toEqual({})
  })

  test("a change appends only the changed fact; a removal is said, not hidden", () => {
    const seen = TurnFacts.seen([
      userWith("msg_1", { date: "Tue Nov 17 2026", tools: now().tools }),
      userWith("msg_2", {}),
    ])
    const mcp = "<mcp_instructions>\n  <server name=\"a\">\n    hi\n  </server>\n</mcp_instructions>"
    const connected = TurnFacts.render({ seen, now: now({ mcp, date: "Wed Nov 18 2026" }), line })
    expect(connected.text).toBe(["<turn_facts>", "Today's date: Wed Nov 18 2026", mcp, line, "</turn_facts>"].join("\n"))
    expect(connected.emitted).toEqual({ date: "Wed Nov 18 2026", mcp })

    const after = TurnFacts.seen([
      userWith("msg_1", { date: "Tue Nov 17 2026", tools: now().tools }),
      userWith("msg_3", connected.emitted),
    ])
    const gone = TurnFacts.render({ seen: after, now: now({ date: "Wed Nov 18 2026", tools: undefined }), line })
    expect(gone.emitted).toEqual({ tools: null, mcp: null })
    expect(gone.text).toContain("<installed_tools>\n  none now\n</installed_tools>")
    expect(gone.text).toContain("<mcp_instructions>\n  none now\n</mcp_instructions>")
  })

  test("after a compaction hides the earlier blocks, the facts are stated again", () => {
    // filterCompacted leaves only the summary and the tail; no block in view means nothing was seen.
    const out = TurnFacts.render({ seen: TurnFacts.seen([userWith("msg_9", {})]), now: now(), line })
    expect(out.emitted).toEqual({ date: "Tue Nov 17 2026", tools: now().tools })
  })

  test("has(): a person message carries at most one block (once per turn)", () => {
    expect(TurnFacts.has(userWith("msg_1"))).toBe(false)
    expect(TurnFacts.has(userWith("msg_1", {}))).toBe(true)
  })
})

// ================================================================ part 2: the real prompt loop

const MCP_MARK = "ROW112-MCP-INSTRUCTION-FIXTURE"
const mcpState: {
  status: Record<string, MCP.Status>
  instructions: { name: string; instructions: string; tools: string[] }[]
} = { status: {}, instructions: [] }

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

// An MCP service whose connected set and instructions the test changes between person messages.
const mcp = Layer.succeed(
  MCP.Service,
  MCP.Service.of({
    status: () => Effect.sync(() => ({ ...mcpState.status })),
    clients: () => Effect.succeed({}),
    instructions: () => Effect.sync(() => [...mcpState.instructions]),
    tools: () => Effect.succeed({}),
    prompts: () => Effect.succeed({}),
    resources: () => Effect.succeed({}),
    resourceTemplates: () => Effect.succeed({}),
    add: () => Effect.succeed({ status: { status: "disabled" as const } }),
    connect: () => Effect.void,
    disconnect: () => Effect.void,
    getPrompt: () => Effect.succeed(undefined),
    readResource: () => Effect.succeed(undefined),
    startAuth: () => Effect.die("unexpected MCP auth in row 112 tests"),
    authenticate: () => Effect.die("unexpected MCP auth in row 112 tests"),
    finishAuth: () => Effect.die("unexpected MCP auth in row 112 tests"),
    removeAuth: () => Effect.void,
    supportsOAuth: () => Effect.succeed(false),
    hasStoredTokens: () => Effect.succeed(false),
    getAuthStatus: () => Effect.succeed("not_authenticated" as const),
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

const providerCfg = (url: string) => ({
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
          attachment: true,
          reasoning: false,
          temperature: false,
          tool_call: true,
          release_date: "2025-01-01",
          modalities: { input: ["text", "image"], output: ["text"] },
          limit: { context: 100000, output: 10000 },
          cost: { input: 0, output: 0 },
          options: {},
        },
      },
      options: { apiKey: "test-key", baseURL: url },
    },
  },
})

const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
const png = (index: number) =>
  `data:image/png;base64,${Buffer.concat([Buffer.from(PNG_1X1, "base64"), Buffer.from(`#${index}`)]).toString("base64")}`

/** Byte offset where `next` stops repeating `prev` inside prev's messages, or undefined when it repeats all of them. */
function prefixCheck(prev: Record<string, unknown>, next: Record<string, unknown>) {
  const a = JSON.stringify(prev)
  const b = JSON.stringify(next)
  const marker = `"messages":`
  const start = a.indexOf(marker)
  const prefixBytes = start + marker.length + JSON.stringify(prev.messages).length - 1
  let offset: number | undefined
  for (let index = 0; index < prefixBytes; index++)
    if (a[index] !== b[index]) {
      offset = index
      break
    }
  const tools = JSON.stringify(prev.tools) === JSON.stringify(next.tools)
  return {
    prefixBytes,
    offset,
    tools,
    context: offset === undefined ? "" : `before=${JSON.stringify(a.slice(offset - 40, offset + 60))} after=${JSON.stringify(b.slice(offset - 40, offset + 60))}`,
  }
}

const report: string[] = []
afterAll(() => {
  setSystemTime()
  console.log(["", "ROW 112/105 PROMPT LOOP PREFIX REPORT", ...report, ""].join("\n"))
})

const FACT = /^Context: (\d+) of (\d+) tokens used; compaction at (\d+|off)\.$/m

describe("rows 112/105: the real prompt loop keeps the prefix and adds one fact line per turn", () => {
  it.instance(
    "20 images, text-only turns, an MCP server connecting and the date rolling over",
    () =>
      Effect.gen(function* () {
        mcpState.status = {}
        mcpState.instructions = []
        setSystemTime(new Date("2026-11-17T23:50:00"))

        const dir = (yield* TestInstance).directory
        const llm = yield* TestLLMServer
        const fs = yield* FSUtil.Service
        yield* fs.writeWithDirs(
          path.join(dir, "swarm.json"),
          JSON.stringify({ $schema: "https://opencode.ai/config.json", ...providerCfg(llm.url) }),
        )
        const sessions = yield* Session.Service
        const prompt = yield* SessionPrompt.Service
        const chat = yield* sessions.create({
          title: "row 112",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        const sessionID = chat.id as SessionID

        const turn = (parts: Array<Record<string, unknown>>, usage: { input: number; output: number }) =>
          Effect.gen(function* () {
            const msg = yield* sessions.updateMessage({
              id: MessageID.ascending(),
              role: "user",
              sessionID,
              agent: "build",
              model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") },
              time: { created: Date.now() },
            })
            for (const part of parts)
              yield* sessions.updatePart({ id: PartID.ascending(), messageID: msg.id, sessionID, ...part } as never)
            yield* llm.text(`answer to ${msg.id}`, { usage })
            yield* prompt.loop({ sessionID })
            const hits = yield* llm.hits
            return { body: hits.at(-1)!.body, userID: msg.id }
          })

        const bodies: { label: string; body: Record<string, unknown>; userID: string }[] = []
        const run = (label: string, parts: Array<Record<string, unknown>>, usage: { input: number; output: number }) =>
          Effect.gen(function* () {
            bodies.push({ label, ...(yield* turn(parts, usage)) })
          })

        yield* run("T1 text", [{ type: "text", text: "Start of the synthetic session." }], { input: 4_000, output: 100 })
        yield* run(
          "T2 20 images",
          [
            { type: "text", text: "Look at these images." },
            ...Array.from({ length: 20 }, (_, index) => ({
              type: "file",
              mime: "image/png",
              filename: `img-${index}.png`,
              url: png(index),
            })),
          ],
          { input: 9_000, output: 200 },
        )
        yield* run("T3 text-only", [{ type: "text", text: "Text-only follow-up 3." }], { input: 9_500, output: 150 })
        // An MCP server connects between person messages: its instructions arrive, and swarm-web (which gates the
        // researcher routing line) is connected too.
        mcpState.instructions = [{ name: "row112-server", instructions: MCP_MARK, tools: [] }]
        mcpState.status = { "row112-server": { status: "connected" }, "swarm-web": { status: "connected" } }
        yield* run("T4 after MCP connect", [{ type: "text", text: "Text-only follow-up 4." }], {
          input: 10_000,
          output: 150,
        })
        setSystemTime(new Date("2026-11-18T00:05:00"))
        yield* run("T5 after midnight", [{ type: "text", text: "Text-only follow-up 5." }], {
          input: 10_500,
          output: 150,
        })
        yield* run("T6 text-only", [{ type: "text", text: "Text-only follow-up 6." }], { input: 11_000, output: 150 })

        // ---- a turn with two steps (a tool call, then text): step 2 repeats step 1 and the block is not added again.
        const before = (yield* llm.hits).length
        const t7 = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          sessionID,
          agent: "build",
          model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") },
          time: { created: Date.now() },
        })
        yield* sessions.updatePart({
          id: PartID.ascending(),
          messageID: t7.id,
          sessionID,
          type: "text",
          text: "Make an empty todo list.",
        })
        yield* llm.tool("todowrite", { todos: [] })
        yield* llm.text("done", { usage: { input: 11_500, output: 50 } })
        yield* prompt.loop({ sessionID })
        const steps = (yield* llm.hits).slice(before).map((hit) => hit.body)
        expect(steps).toHaveLength(2)
        const within = prefixCheck(steps[0]!, steps[1]!)
        report.push(
          `T7 step 1 -> T7 step 2 (same turn) | prefix ${within.prefixBytes} B | ${within.offset === undefined ? "IDENTICAL" : `DIFFERS at byte ${within.offset} ${within.context}`}`,
        )
        expect(within.offset).toBeUndefined()
        const across = prefixCheck(bodies.at(-1)!.body, steps[0]!)
        report.push(
          `T6 text-only -> T7 step 1 | prefix ${across.prefixBytes} B | ${across.offset === undefined ? "IDENTICAL" : `DIFFERS at byte ${across.offset}`}`,
        )
        expect(across.offset).toBeUndefined()
        const t7stored = (yield* sessions.messages({ sessionID })).find((m) => m.info.id === t7.id)!
        expect(t7stored.parts.filter((p) => p.type === "text" && p.metadata?.turnFacts)).toHaveLength(1)
        expect(JSON.stringify(steps[1]).match(/Context: \d+ of \d+ tokens used/g)).toHaveLength(7)

        // ---- prefix: request N+1 repeats request N up to and including N's last message; tools identical.
        for (let index = 1; index < bodies.length; index++) {
          const prev = bodies[index - 1]!
          const next = bodies[index]!
          const result = prefixCheck(prev.body, next.body)
          report.push(
            `${prev.label} -> ${next.label} | prefix ${result.prefixBytes} B over ${(prev.body.messages as unknown[]).length} messages | ${
              result.offset === undefined ? "IDENTICAL" : `DIFFERS at byte ${result.offset} ${result.context}`
            } | tools ${result.tools ? "identical" : "DIFFER"}`,
          )
          expect(result.offset).toBeUndefined()
          expect(result.tools).toBe(true)
        }

        // ---- the system message never carries the facts that change during a session.
        for (const { body } of bodies) {
          const system = JSON.stringify((body.messages as { role: string }[]).filter((m) => m.role === "system"))
          expect(system).not.toContain("Today's date:")
          expect(system).not.toContain(MCP_MARK)
          expect(system).not.toContain("Context: ")
          expect(system).not.toContain("researcher: search and read the public web")
        }

        // ---- the facts reach the model in the turn they change, in the newest person message.
        const lastUserText = (body: Record<string, unknown>) => {
          const user = (body.messages as { role: string; content: unknown }[]).findLast((m) => m.role === "user")!
          return typeof user.content === "string" ? user.content : JSON.stringify(user.content)
        }
        expect(lastUserText(bodies[0]!.body)).toContain("Today's date: Tue Nov 17 2026")
        expect(lastUserText(bodies[1]!.body)).not.toContain("Today's date:")
        expect(lastUserText(bodies[3]!.body)).toContain(MCP_MARK)
        expect(lastUserText(bodies[3]!.body)).toContain("- researcher: search and read the public web.")
        expect(lastUserText(bodies[4]!.body)).toContain("Today's date: Wed Nov 18 2026")
        expect(lastUserText(bodies[4]!.body)).not.toContain(MCP_MARK)
        expect(JSON.stringify(bodies[5]!.body).split(MCP_MARK).length - 1).toBe(1)
        // 20 images are in the request and stay in later requests.
        for (const { body } of bodies.slice(1)) expect(JSON.stringify(body).split("data:image/png;base64,").length - 1).toBe(20)

        // ---- the fact line: once per turn, numbers equal to the overflow check's.
        const cfg = yield* (yield* Config.Service).get()
        const flags = yield* RuntimeFlags.Service
        const mdl = yield* (yield* ProviderSvc.Service).getModel(
          ProviderV2.ID.make("test"),
          ModelV2.ID.make("test-model"),
        )
        const threshold = Math.min(
          usable({ cfg, model: mdl, outputTokenMax: flags.outputTokenMax }),
          priceTarget({ cfg, model: mdl, outputTokenMax: flags.outputTokenMax }) ?? Infinity,
        )
        const stored = yield* sessions.messages({ sessionID })
        for (const [index, { userID, body }] of bodies.entries()) {
          const user = stored.find((m) => m.info.id === userID)!
          const blocks = user.parts.filter((p) => p.type === "text" && p.synthetic && p.metadata?.turnFacts)
          expect(blocks).toHaveLength(1)
          const text = (blocks[0] as SessionV1.TextPart).text
          expect(text.match(new RegExp(FACT.source, "gm"))).toHaveLength(1)
          const [, used, limit, at] = text.match(FACT)!
          const prevAssistant = stored.findLast(
            (m) => m.info.role === "assistant" && m.info.id < userID && m.info.summary !== true,
          )
          const expectedUsed = prevAssistant ? count((prevAssistant.info as SessionV1.Assistant).tokens) : 0
          expect(Number(used)).toBe(expectedUsed)
          if (index > 0) expect(Number(used)).toBeGreaterThan(0)
          expect(Number(limit)).toBe(mdl.limit.context)
          expect(Number(at)).toBe(threshold)
          // Exactly one fact line in the whole request per person message so far (old lines stay where they were).
          expect(JSON.stringify(body).match(/Context: \d+ of \d+ tokens used/g)).toHaveLength(index + 1)
          report.push(`${bodies[index]!.label} | fact line: ${text.match(FACT)![0]}`)
        }
      }),
    60_000,
  )
})
