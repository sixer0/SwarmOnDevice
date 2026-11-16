// SD-1 (office add-in spec SD §10.3 item 8, REG §7.8, decisions C9, C11, C12, C13): a session whose metadata says
// `swarm.origin = office-addin` gets a stripped system prompt; every other session keeps the full one.
// Synthetic fixtures only: a global AGENTS.md, a project AGENTS.md, a project skill and a zero-tool MCP server.
import { describe, expect, test } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Effect, Fiber, Layer } from "effect"
import { BackgroundJob } from "@/background/job"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { LSP } from "@/lsp/lsp"
import { Provider as ProviderSvc } from "@/provider/provider"
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
import { OfficeProfile } from "../../src/session/office-profile"
import { SessionProcessor } from "../../src/session/processor"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionRevert } from "../../src/session/revert"
import { SessionRunState } from "../../src/session/run-state"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { SessionSummary } from "../../src/session/summary"
import { SystemPrompt } from "../../src/session/system"
import { Todo } from "../../src/session/todo"
import { Skill } from "../../src/skill"
import { Snapshot } from "../../src/snapshot"
import { TestInstance } from "../fixture/fixture"
import { awaitWithTimeout, testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"

const GLOBAL_MARK = "SD1-GLOBAL-INSTRUCTION-FIXTURE"
const PROJECT_MARK = "SD1-PROJECT-INSTRUCTION-FIXTURE"
const MCP_MARK = "SD1-ZERO-TOOL-MCP-FIXTURE"
const SKILL_NAME = "sd1-fixture-skill"

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

// A connected MCP server with zero tools: its instructions are always listed today (S-35).
const mcp = Layer.succeed(
  MCP.Service,
  MCP.Service.of({
    status: () => Effect.succeed({}),
    clients: () => Effect.succeed({}),
    instructions: () => Effect.succeed([{ name: "sd1-zero-tool", instructions: MCP_MARK, tools: [] }]),
    tools: () => Effect.succeed({}),
    prompts: () => Effect.succeed({}),
    resources: () => Effect.succeed({}),
    resourceTemplates: () => Effect.succeed({}),
    add: () => Effect.succeed({ status: { status: "disabled" as const } }),
    connect: () => Effect.void,
    disconnect: () => Effect.void,
    getPrompt: () => Effect.succeed(undefined),
    readResource: () => Effect.succeed(undefined),
    startAuth: () => Effect.die("unexpected MCP auth in office-profile tests"),
    authenticate: () => Effect.die("unexpected MCP auth in office-profile tests"),
    finishAuth: () => Effect.die("unexpected MCP auth in office-profile tests"),
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

// The same graph with `experimentalPlanMode`, whose reminders name the plan file path (`reminders.ts:52-82`).
const itPlanMode = testEffect(
  LayerNode.compile(root, [
    [SessionSummary.node, summary],
    [LSP.node, lsp],
    [MCP.node, mcp],
    [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true, experimentalPlanMode: true })],
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

const globalInstruction = Effect.acquireRelease(
  Effect.sync(() => {
    mkdirSync(Global.Path.config, { recursive: true })
    const file = path.join(Global.Path.config, "AGENTS.md")
    writeFileSync(file, `# Global\n\n${GLOBAL_MARK}\n`)
    return file
  }),
  (file) => Effect.sync(() => rmSync(file, { force: true })),
)

const systemOf = (body: unknown) =>
  ((body as { messages?: { role: string; content: unknown }[] }).messages ?? [])
    .filter((message) => message.role === "system")
    .map((message) => (typeof message.content === "string" ? message.content : JSON.stringify(message.content)))
    .join("\n")

/** Writes the synthetic fixtures (global and project AGENTS.md, a project skill, the provider config plus `config`) and
 *  returns the instance directory. */
const fixtures = (config?: Record<string, unknown>) =>
  Effect.gen(function* () {
    yield* globalInstruction
    const dir = (yield* TestInstance).directory
    const llm = yield* TestLLMServer
    const fs = yield* FSUtil.Service
    yield* fs.writeWithDirs(
      path.join(dir, "swarm.json"),
      JSON.stringify({ $schema: "https://opencode.ai/config.json", ...providerCfg(llm.url), ...config }),
    )
    yield* fs.writeWithDirs(path.join(dir, "AGENTS.md"), `# Project\n\n${PROJECT_MARK}\n`)
    yield* fs.writeWithDirs(
      path.join(dir, ".swarm", "skills", SKILL_NAME, "SKILL.md"),
      `---\nname: ${SKILL_NAME}\ndescription: Synthetic SD-1 skill.\n---\n\n# Synthetic\n`,
    )
    return dir
  })

/** Runs one turn of a build session and returns the system text the provider received. With `title`, the session
 *  keeps its default title so the first turn also fires the title model call (`prompt.ts` `ensureTitle`). */
const systemFor = (
  metadata: Record<string, unknown> | undefined,
  opts?: { title?: boolean; agent?: string; config?: Record<string, unknown> },
) =>
  Effect.gen(function* () {
    const dir = yield* fixtures(opts?.config)
    const llm = yield* TestLLMServer
    const sessions = yield* Session.Service
    const prompt = yield* SessionPrompt.Service
    const chat = yield* sessions.create({
      ...(opts?.title ? {} : { title: "SD-1" }),
      permission: [{ permission: "*", pattern: "*", action: metadata ? "deny" : "allow" }],
      ...(metadata ? { metadata } : {}),
    })
    const msg = yield* sessions.updateMessage({
      id: MessageID.ascending(),
      role: "user",
      sessionID: chat.id,
      agent: opts?.agent ?? "build",
      model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") },
      time: { created: Date.now() },
    })
    yield* sessions.updatePart({
      id: PartID.ascending(),
      messageID: msg.id,
      sessionID: chat.id,
      type: "text",
      text: "Summarise the selected paragraph.",
    })
    yield* llm.hang
    const fiber = yield* prompt.loop({ sessionID: chat.id as SessionID }).pipe(Effect.forkChild)
    // Hits accumulate on the shared server across runs in one test, so wait for this run's calls and read the latest.
    const count = (yield* llm.calls) + (opts?.title ? 2 : 1)
    yield* awaitWithTimeout(llm.wait(count), "timed out waiting for the requests", "10 seconds")
    const hits = yield* llm.hits
    const titleHit = hits.find((hit) => isTitleCall(hit.body))
    const mainHit = hits.findLast((hit) => !isTitleCall(hit.body))
    yield* Fiber.interrupt(fiber)
    return {
      system: systemOf(mainHit?.body),
      body: JSON.stringify(mainHit?.body ?? {}),
      dir,
      title: titleHit ? { system: systemOf(titleHit.body), body: JSON.stringify(titleHit.body) } : undefined,
    }
  })

const TITLE_ASK = "Generate a title for this conversation"
const isTitleCall = (body: unknown) => JSON.stringify(body).includes(TITLE_ASK)

/** Everything SD-1 strips from an Office prompt; none of it may reach any model call of an Office session. */
const stripped = (dir: string) => [
  GLOBAL_MARK,
  PROJECT_MARK,
  MCP_MARK,
  SKILL_NAME,
  "<agent_routing>",
  "<auto_workflow>",
  "<gsp_workflow>",
  "<mcp_instructions>",
  "<available_skills>",
  "<suggested_skills>",
  "<swarm_rules>",
  "<env>",
  "Working directory:",
  "Platform:",
  dir,
  Global.Path.home,
  os.homedir(),
]

const OFFICE = {
  [OfficeProfile.OFFICE_ORIGIN_METADATA_KEY]: OfficeProfile.OFFICE_ORIGIN_VALUE,
  "swarm.office.host": "Word",
}

describe("SD-1 Office prompt profile", () => {
  test("constants equal the add-in's metadata literals (REG §7.1, source-read, no import)", async () => {
    const source = await Bun.file(path.join(import.meta.dir, "../../../office-addin/src/constants.ts")).text()
    expect(source).toContain(`export const OFFICE_ORIGIN_METADATA_KEY = "${OfficeProfile.OFFICE_ORIGIN_METADATA_KEY}"`)
    expect(source).toContain(`export const OFFICE_ORIGIN_VALUE = "${OfficeProfile.OFFICE_ORIGIN_VALUE}"`)
  })

  test("isOfficeSession is true only for the exact origin value", () => {
    expect(OfficeProfile.isOfficeSession({ metadata: OFFICE })).toBe(true)
    expect(OfficeProfile.isOfficeSession({})).toBe(false)
    expect(OfficeProfile.isOfficeSession({ metadata: {} })).toBe(false)
    expect(OfficeProfile.isOfficeSession({ metadata: { "swarm.origin": "Office-Addin" } })).toBe(false)
    expect(OfficeProfile.isOfficeSession({ metadata: { "swarm.origin": ["office-addin"] } })).toBe(false)
  })

  test("the Office prefix is one date line and nothing else", () => {
    const [skills, env, instructions, remembered, mcpInstructions, delegation] = OfficeProfile.prefix()
    expect(env).toEqual([`Today's date: ${new Date().toDateString()}`])
    expect([skills, remembered, mcpInstructions]).toEqual([undefined, undefined, undefined])
    expect([...instructions, ...delegation]).toEqual([])
  })

  it.instance(
    "an Office session's system prompt has none of the stripped blocks and keeps the date line",
    () =>
      Effect.gen(function* () {
        const result = yield* systemFor(OFFICE)
        const system = result.system
        expect(system.length).toBeGreaterThan(0)
        expect(system).toContain(`Today's date: ${new Date().toDateString()}`)
        for (const absent of stripped(result.dir)) expect(system).not.toContain(absent)
        const user = os.userInfo().username
        if (user.length >= 3) expect(system).not.toContain(user)
      }),
    20_000,
  )

  it.instance(
    "a session without the Office metadata keeps the full prompt (regression)",
    () =>
      Effect.gen(function* () {
        const result = yield* systemFor(undefined)
        const system = result.system
        for (const present of [
          GLOBAL_MARK,
          PROJECT_MARK,
          MCP_MARK,
          SKILL_NAME,
          "<agent_routing>",
          "<auto_workflow>",
          "<gsp_workflow>",
          "<mcp_instructions>",
          "<available_skills>",
          "<swarm_rules>",
          "<env>",
          `Working directory: ${result.dir}`,
          `Today's date: ${new Date().toDateString()}`,
        ])
          expect(system).toContain(present)
      }),
    20_000,
  )

  // CP-M6 title call: `ensureTitle` (src/session/prompt.ts) calls the hidden `title` agent with `system: []`, so its
  // system text is the title prompt plus `SystemPrompt.workflow("title")` (empty, src/session/system.ts:105) plus the
  // first user message's own `system` field. No instruction file, env block, skill, MCP or memory producer runs there.
  it.instance(
    "an Office session's title call carries none of the stripped blocks",
    () =>
      Effect.gen(function* () {
        const result = yield* systemFor(OFFICE, { title: true })
        expect(result.title).toBeDefined()
        const call = result.title ?? { system: "", body: "" }
        expect(call.system).toContain("You are a title generator")
        expect(call.body).toContain("Summarise the selected paragraph.")
        for (const absent of [...stripped(result.dir), "Today's date:"]) expect(call.body).not.toContain(absent)
        const user = os.userInfo().username
        if (user.length >= 3) expect(call.body).not.toContain(user)
        // The main call of the same turn is still the stripped Office prompt.
        expect(result.system).toContain(`Today's date: ${new Date().toDateString()}`)
        expect(result.system).not.toContain(GLOBAL_MARK)
      }),
    20_000,
  )

  it.instance(
    "the title call is the same for a non-Office session (title path is independent of SD-1)",
    () =>
      Effect.gen(function* () {
        const result = yield* systemFor(undefined, { title: true })
        const call = result.title ?? { system: "", body: "" }
        expect(call.system).toContain("You are a title generator")
        for (const absent of [GLOBAL_MARK, PROJECT_MARK, MCP_MARK, SKILL_NAME, "<gsp_workflow>", "<env>"])
          expect(call.body).not.toContain(absent)
        // Non-vacuous: the main call of the same non-Office turn does carry the full prompt.
        expect(result.system).toContain(GLOBAL_MARK)
        expect(result.system).toContain("<env>")
      }),
    20_000,
  )

  it.instance(
    "metadata with another origin value keeps the full prompt",
    () =>
      Effect.gen(function* () {
        const system = (yield* systemFor({ "swarm.origin": "something-else" })).system
        expect(system).toContain(GLOBAL_MARK)
        expect(system).toContain("<gsp_workflow>")
        expect(system).toContain("<env>")
      }),
    20_000,
  )

  // M6-01b (CP-M6 F-M6-2): no plan-mode or build-switch reminder reaches an Office session's model call.
  it.instance(
    "an Office session on the plan agent gets no plan reminder (classic plan mode)",
    () =>
      Effect.gen(function* () {
        const office = yield* systemFor(OFFICE, { agent: "plan" })
        expect(office.body).toContain("Summarise the selected paragraph.")
        expect(office.body).not.toContain("Plan Mode - System Reminder")
        for (const absent of stripped(office.dir)) expect(office.body).not.toContain(absent)
      }),
    20_000,
  )

  it.instance(
    "a non-Office session on the plan agent keeps the plan reminder (regression)",
    () =>
      Effect.gen(function* () {
        const control = yield* systemFor(undefined, { agent: "plan" })
        expect(control.body).toContain("Plan Mode - System Reminder")
      }),
    20_000,
  )

  itPlanMode.instance(
    "an Office session on the plan agent gets no plan-file reminder (experimental plan mode)",
    () =>
      Effect.gen(function* () {
        const office = yield* systemFor(OFFICE, { agent: "plan" })
        expect(office.body).toContain("Summarise the selected paragraph.")
        expect(office.body).not.toContain("plan file")
        expect(office.body).not.toContain(Global.Path.data)
        for (const absent of stripped(office.dir)) expect(office.body).not.toContain(absent)
        const user = os.userInfo().username
        if (user.length >= 3) expect(office.body).not.toContain(user)
      }),
    20_000,
  )

  itPlanMode.instance(
    "a non-Office session on the plan agent keeps the plan-file reminder (experimental plan mode, regression)",
    () =>
      Effect.gen(function* () {
        const control = yield* systemFor(undefined, { agent: "plan" })
        expect(control.body).toContain("No plan file exists yet. You should create your plan at")
      }),
    20_000,
  )

  // M6-01b (CP-M6 F-M6-2): a configured agent prompt (a custom default agent, or an override of build's prompt) never
  // reaches an Office session; the built-in provider prompt is used instead.
  const CUSTOM_DEFAULT = "SD1-CUSTOM-DEFAULT-AGENT-PROMPT"
  const BUILD_OVERRIDE = "SD1-BUILD-PROMPT-OVERRIDE"
  const agentConfig = {
    default_agent: "sd1-custom",
    agent: {
      "sd1-custom": { mode: "primary", description: "Synthetic SD-1 default agent.", prompt: CUSTOM_DEFAULT },
      build: { prompt: BUILD_OVERRIDE },
    },
  }
  for (const agent of ["sd1-custom", "build"])
    it.instance(
      `an Office session on ${agent} gets the built-in prompt, not the configured one`,
      () =>
        Effect.gen(function* () {
          const office = yield* systemFor(OFFICE, { agent, config: agentConfig })
          expect(office.system.length).toBeGreaterThan(0)
          expect(office.system).not.toContain(CUSTOM_DEFAULT)
          expect(office.system).not.toContain(BUILD_OVERRIDE)
          expect(office.system).toContain(`Today's date: ${new Date().toDateString()}`)
          const control = yield* systemFor(undefined, { agent, config: agentConfig })
          expect(control.system).toContain(agent === "build" ? BUILD_OVERRIDE : CUSTOM_DEFAULT)
        }),
      30_000,
    )

  // Runs `SessionCompaction.process` once for a fresh session and returns the body of that model call.
  const compactionCall = (metadata: Record<string, unknown> | undefined, config?: Record<string, unknown>) =>
    Effect.gen(function* () {
      const dir = yield* fixtures(config)
      const llm = yield* TestLLMServer
      const sessions = yield* Session.Service
      const compaction = yield* SessionCompaction.Service
      const chat = yield* sessions.create({
        title: "SD-1",
        permission: [{ permission: "*", pattern: "*", action: metadata ? "deny" : "allow" }],
        ...(metadata ? { metadata } : {}),
      })
      const msg = yield* sessions.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        sessionID: chat.id,
        agent: "build",
        model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") },
        time: { created: Date.now() },
      })
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: msg.id,
        sessionID: chat.id,
        type: "text",
        text: "Summarise the selected paragraph.",
      })
      const before = yield* llm.calls
      yield* llm.text("Synthetic summary.")
      yield* compaction.process({
        parentID: msg.id,
        messages: yield* sessions.messages({ sessionID: chat.id }),
        sessionID: chat.id,
        auto: false,
      })
      const hits = yield* llm.hits
      expect(hits).toHaveLength(before + 1)
      return { dir, body: JSON.stringify(hits.at(-1)?.body) }
    })

  // M6-01b (CP-M6 F-M6-3): the compaction call of an Office session (hidden agent `compaction`, `system: []`,
  // src/session/compaction.ts) carries none of the stripped blocks.
  it.instance(
    "an Office session's compaction call carries none of the stripped blocks",
    () =>
      Effect.gen(function* () {
        const call = yield* compactionCall(OFFICE)
        expect(call.body).toContain("You are a context summarization agent.")
        expect(call.body).toContain("Summarise the selected paragraph.")
        for (const absent of [...stripped(call.dir), "Today's date:"]) expect(call.body).not.toContain(absent)
        const user = os.userInfo().username
        if (user.length >= 3) expect(call.body).not.toContain(user)
      }),
    20_000,
  )

  // M6-01c (C64): a configured prompt for the hidden `compaction` and `title` agents never reaches an Office session;
  // the shipped prompt is used instead. A non-Office session still gets the configured one.
  const COMPACTION_OVERRIDE = "SD1-COMPACTION-PROMPT-OVERRIDE"
  const TITLE_OVERRIDE = "SD1-TITLE-PROMPT-OVERRIDE"
  const hiddenConfig = { agent: { compaction: { prompt: COMPACTION_OVERRIDE }, title: { prompt: TITLE_OVERRIDE } } }

  it.instance(
    "an Office session's compaction call uses the shipped prompt, not the configured one",
    () =>
      Effect.gen(function* () {
        const call = yield* compactionCall(OFFICE, hiddenConfig)
        expect(call.body).not.toContain(COMPACTION_OVERRIDE)
        expect(call.body).toContain("You are a context summarization agent.")
        for (const absent of stripped(call.dir)) expect(call.body).not.toContain(absent)
      }),
    20_000,
  )

  it.instance(
    "a non-Office session's compaction call keeps the configured prompt (regression)",
    () =>
      Effect.gen(function* () {
        const call = yield* compactionCall(undefined, hiddenConfig)
        expect(call.body).toContain(COMPACTION_OVERRIDE)
        expect(call.body).not.toContain("You are a context summarization agent.")
      }),
    20_000,
  )

  it.instance(
    "an Office session's title call uses the shipped prompt, not the configured one",
    () =>
      Effect.gen(function* () {
        const result = yield* systemFor(OFFICE, { title: true, config: hiddenConfig })
        const call = result.title ?? { system: "", body: "" }
        expect(call.system).toContain("You are a title generator")
        expect(call.body).not.toContain(TITLE_OVERRIDE)
        for (const absent of stripped(result.dir)) expect(call.body).not.toContain(absent)
      }),
    20_000,
  )

  it.instance(
    "a non-Office session's title call keeps the configured prompt (regression)",
    () =>
      Effect.gen(function* () {
        const result = yield* systemFor(undefined, { title: true, config: hiddenConfig })
        const call = result.title ?? { system: "", body: "" }
        expect(call.system).toContain(TITLE_OVERRIDE)
        expect(call.system).not.toContain("You are a title generator")
      }),
    20_000,
  )

  test("OfficeProfile.agent keeps the shipped hidden-agent prompts and drops every other prompt", () => {
    expect(OfficeProfile.agent({ name: "compaction", prompt: "x" }).prompt).toContain(
      "You are a context summarization agent.",
    )
    expect(OfficeProfile.agent({ name: "title", prompt: "x" }).prompt).toContain("You are a title generator")
    expect(OfficeProfile.agent({ name: "build", prompt: "x" }).prompt).toBeUndefined()
    expect(OfficeProfile.agent({ name: "sd1-custom", prompt: "x" }).prompt).toBeUndefined()
  })
})
