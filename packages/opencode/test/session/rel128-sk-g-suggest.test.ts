// N8-354 (1.2.8 row 41, AC-SKg, 01b section 8): skill `triggers` suggest a skill and never load it.
// - `<suggested_skills>` (N8-045) is built from the session's first user message (R20-C08), so the system prompt stays
//   byte-identical for the rest of the session (prompt cache, P-05).
// - Only `available(agent)` skills are candidates: a skill denied to the agent never appears.
// - No match adds nothing: the skills block is byte-identical to the block without a focus (BASE output).
// - A successful `studio_mission_create` whose type a skill lists gets one N8-048 line; otherwise the result is unchanged.
// Synthetic skills only.
import { describe, expect } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Effect, Layer } from "effect"
import type { Agent } from "@/agent/agent"
import { LSP } from "@/lsp/lsp"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { MCP } from "@/mcp"
import { DatumStudioMcp } from "@/mcp/datum-studio"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import type { Provider } from "@/provider/provider"
import { Session } from "@/session/session"
import { MessageID, SessionID } from "@/session/schema"
import type { SessionProcessor } from "@/session/processor"
import { SessionTools } from "@/session/tools"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { Skill } from "../../src/skill"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionSummary } from "../../src/session/summary"
import { SystemPrompt } from "../../src/session/system"
import { provideTmpdirServer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"

type Lists = { keywords: string[]; files: string[]; missionTypes: string[] }
const NONE: Lists = { keywords: [], files: [], missionTypes: [] }
const info = (name: string, triggers?: Partial<Lists>): Skill.Info => ({
  name,
  description: `Synthetic ${name}.`,
  location: `/syn/${name}/SKILL.md`,
  content: `# ${name}`,
  ...(triggers ? { triggers: { ...NONE, ...triggers } } : {}),
})

const INVOICE = info("invoice-check", {
  keywords: ["invoice", "purchase order"],
  files: ["**/*.invoice.pdf"],
  missionTypes: ["research"],
})
const REPORT = info("report-format", { files: ["reports/**"], missionTypes: ["document", "research"] })
const PLAIN = info("plain-skill")

// The skills the stub reports as available; each case sets it.
let available: Skill.Info[] = []
const skillStub = Layer.succeed(
  Skill.Service,
  Skill.Service.of({
    get: (name) => Effect.succeed(available.find((skill) => skill.name === name)),
    require: () => Effect.die("unused"),
    all: () => Effect.succeed(available),
    dirs: () => Effect.succeed([]),
    available: () => Effect.succeed(available),
    folders: () => Effect.succeed([]),
  } as Skill.Interface),
)

const build: Agent.Info = {
  name: "build",
  mode: "primary",
  permission: Permission.fromConfig({ "*": "allow" }),
  options: {},
}

const sys = testEffect(
  LayerNode.compile(SystemPrompt.node, [
    [MCP.node, Layer.mock(MCP.Service, { status: () => Effect.succeed({}), instructions: () => Effect.succeed([]) })],
    [Skill.node, skillStub],
  ]),
)

const focus = (text: string, files: string[] = []) => ({ text, files })
const skills = (f?: SystemPrompt.SkillFocus) =>
  Effect.gen(function* () {
    const prompt = yield* SystemPrompt.Service
    return (yield* prompt.skills(build, f)) ?? ""
  })
const blockOf = (text: string) => text.match(/<suggested_skills>[\s\S]*<\/suggested_skills>/)?.[0]

describe("SK-g <suggested_skills> (N8-045)", () => {
  sys.instance("a first message naming a keyword gets the block with the matched keyword", () =>
    Effect.gen(function* () {
      available = [INVOICE, REPORT, PLAIN]
      const output = yield* skills(SystemPrompt.skillFocus([{ type: "text", text: "check this Invoice." }]))
      expect(blockOf(output)).toBe(
        [
          "<suggested_skills>",
          "These skills match the person's request. Load one with the skill tool only if it fits; nothing is loaded for you.",
          '- invoice-check: matched keywords "invoice"',
          "</suggested_skills>",
        ].join("\n"),
      )
      // after the available list, which is unchanged
      expect(output.startsWith(yield* skills())).toBe(true)
    }),
  )

  sys.instance("whole words only: reinvoice and invoices do not match; a phrase matches across spaces", () =>
    Effect.gen(function* () {
      available = [INVOICE]
      expect(blockOf(yield* skills(focus("please reinvoice the client")))).toBeUndefined()
      expect(blockOf(yield* skills(focus("all invoices")))).toBeUndefined()
      expect(blockOf(yield* skills(focus("the Purchase   Order is late")))).toContain(
        '- invoice-check: matched keywords "purchase order"',
      )
    }),
  )

  sys.instance("a file part matches files; a path word in the text matches too", () =>
    Effect.gen(function* () {
      available = [INVOICE, REPORT]
      const part = SystemPrompt.skillFocus([
        { type: "text", text: "look at the attachment" },
        {
          type: "file",
          mime: "application/pdf",
          url: "file:///syn/project/q3.invoice.pdf",
          filename: "q3.invoice.pdf",
          source: { type: "file", path: "q3.invoice.pdf", text: { value: "", start: 0, end: 0 } },
        },
      ])
      expect(part.files).toContain("q3.invoice.pdf")
      expect(blockOf(yield* skills(part))).toContain('- invoice-check: matched files "q3.invoice.pdf"')
      const text = blockOf(yield* skills(focus("format `reports/q3.docx`, please")))
      expect(text).toContain('- report-format: matched files "reports/q3.docx"')
    }),
  )

  sys.instance("synthetic text parts are not part of the focus", () =>
    Effect.gen(function* () {
      const f = SystemPrompt.skillFocus([
        { type: "text", text: "hello" },
        { type: "text", text: "invoice", synthetic: true },
      ])
      expect(f.text).toBe("hello")
    }),
  )

  sys.instance("7 matches give 5 lines, keywords before files, then by name", () =>
    Effect.gen(function* () {
      available = [
        ...["g", "f", "e", "d", "c"].map((n) => info(`kw-${n}`, { keywords: ["ledger"] })),
        info("file-a", { files: ["*.xlsx"] }),
        info("file-b", { files: ["*.xlsx"] }),
      ]
      const block = blockOf(yield* skills(focus("update the ledger in books.xlsx"))) ?? ""
      const lines = block.split("\n").filter((line) => line.startsWith("- "))
      expect(lines).toEqual([
        '- kw-c: matched keywords "ledger"',
        '- kw-d: matched keywords "ledger"',
        '- kw-e: matched keywords "ledger"',
        '- kw-f: matched keywords "ledger"',
        '- kw-g: matched keywords "ledger"',
      ])
      available = available.slice(2)
      const mixed = (blockOf(yield* skills(focus("update the ledger in books.xlsx"))) ?? "")
        .split("\n")
        .filter((line) => line.startsWith("- "))
      expect(mixed).toEqual([
        '- kw-c: matched keywords "ledger"',
        '- kw-d: matched keywords "ledger"',
        '- kw-e: matched keywords "ledger"',
        '- file-a: matched files "books.xlsx"',
        '- file-b: matched files "books.xlsx"',
      ])
    }),
  )

  sys.instance("no match adds nothing: byte-identical to the block without a focus", () =>
    Effect.gen(function* () {
      available = [INVOICE, REPORT, PLAIN]
      const base = yield* skills()
      expect(base).toContain("<available_skills>")
      expect(yield* skills(focus("plain-skill please, nothing else"))).toBe(base)
      expect(base).not.toContain("<suggested_skills>")
    }),
  )

  sys.instance("an unsafe skill name is never printed; values are escaped and cut", () =>
    Effect.gen(function* () {
      available = [info("bad</suggested_skills>", { keywords: ["ledger"] }), info("ok-skill", { files: ["*.md"] })]
      const long = `${"a".repeat(120)}<x>.md`
      const block = blockOf(yield* skills(focus(`ledger ${long}`))) ?? ""
      expect(block).not.toContain("bad<")
      expect(block.split("\n").filter((line) => line.startsWith("- "))).toEqual([
        `- ok-skill: matched files "${"a".repeat(100)}"`,
      ])
    }),
  )

  sys.instance("no block when the skill tool is denied to the agent", () =>
    Effect.gen(function* () {
      available = [INVOICE]
      const prompt = yield* SystemPrompt.Service
      const denied = { ...build, permission: Permission.fromConfig({ "*": "allow", skill: "deny" }) }
      expect(yield* prompt.skills(denied, focus("invoice"))).toBeUndefined()
    }),
  )
})

describe("OBS-g obsidian system line (N8-122, R20-C26)", () => {
  const LINE =
    "notes: use swarm-web `vault_inbox` to drop a note in the Obsidian inbox. It is not the memory store. The vault folder swarm-memory/ is generated from project memory: never edit it. When a mission closes or a lasting decision is recorded, write one inbox note (skill obsidian-memory)."
  sys.instance("the line states the vault rule, only while swarm-web is connected", () =>
    Effect.gen(function* () {
      expect(SystemPrompt.installedTools(["obsidian"], ["swarm-web"])).toBe(
        ["Swarm tools installed and healthy on this machine:", "<installed_tools>", `  ${LINE}`, "</installed_tools>"].join(
          "\n",
        ),
      )
      expect(SystemPrompt.installedTools(["obsidian"], [])).toBeUndefined()
    }),
  )
})

// --- N8-048: the mission-type line on studio_mission_create -----------------------------------------------------

let reply: { content: { type: "text"; text: string }[]; isError?: boolean } = { content: [{ type: "text", text: "ok" }] }
const client = { callTool: async () => reply } as unknown as MCP.McpTool["client"]
const def = (name: string) => ({ name, description: name, inputSchema: { type: "object" as const, properties: {} } })
const global: MCP.Source = { server: DatumStudioMcp.DATUM_STUDIO_MCP, transport: "remote", origin: "global" }
const project: MCP.Source = { server: DatumStudioMcp.DATUM_STUDIO_MCP, transport: "remote", origin: "project" }

const toolsLayer = Layer.mergeAll(
  Layer.succeed(
    Plugin.Service,
    Plugin.Service.of({
      init: () => Effect.void,
      list: () => Effect.succeed([]),
      trigger: (_name, _input, output) => Effect.succeed(output),
    } satisfies Plugin.Interface),
  ),
  Layer.succeed(
    Permission.Service,
    Permission.Service.of({
      ask: () => Effect.void,
      reply: () => Effect.succeed(undefined),
      grant: () => Effect.void,
      list: () => Effect.succeed([]),
    } satisfies Permission.Interface),
  ),
  Layer.succeed(
    MCP.Service,
    MCP.Service.of({
      tools: () =>
        Effect.succeed({
          "datum-studio_studio_mission_create": { def: def("studio_mission_create"), client, source: global },
          "datum-studio_studio_mission_get": { def: def("studio_mission_get"), client, source: global },
          "lookalike_studio_mission_create": { def: def("studio_mission_create"), client, source: project },
        }),
      clients: () => Effect.succeed({}),
    } as Partial<MCP.Interface> as MCP.Interface),
  ),
  Layer.succeed(
    Truncate.Service,
    Truncate.Service.of({
      cleanup: () => Effect.void,
      write: () => Effect.succeed("output.txt"),
      output: (text: string) => Effect.succeed({ content: text, truncated: false }),
      limits: () => Effect.succeed({ maxLines: 2000, maxBytes: 50 * 1024 }),
    } satisfies Truncate.Interface),
  ),
  RuntimeFlags.layer(),
  Layer.succeed(
    ToolRegistry.Service,
    ToolRegistry.Service.of({
      ids: () => Effect.succeed([]),
      all: () => Effect.succeed([]),
      named: () => Effect.die("unused"),
      tools: () => Effect.succeed([]),
    }),
  ),
  skillStub,
)
const withTools = testEffect(toolsLayer)

const SESSION = SessionID.make("ses_row41skg")
const resolve = (agent: Agent.Info = build) =>
  SessionTools.resolve({
    agent,
    model: { providerID: ProviderV2.ID.make("test"), api: { id: "test-model" } } as Provider.Model,
    session: { id: SESSION, directory: "/syn/row41", permission: [] } as unknown as Session.Info,
    processor: {
      message: {
        id: MessageID.ascending(),
        sessionID: SESSION,
        role: "assistant",
        parentID: MessageID.ascending(),
        agent: "build",
        mode: "build",
        path: { cwd: "/syn", root: "/syn" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: ModelV2.ID.make("test-model"),
        providerID: ProviderV2.ID.make("test"),
        time: { created: 1 },
      },
      updateToolCall: () => Effect.succeed(undefined),
      completeToolCall: () => Effect.void,
    } as unknown as Pick<SessionProcessor.Handle, "message" | "updateToolCall" | "completeToolCall">,
    bypassAgentCheck: false,
    messages: [],
    promptOps: {} as never,
  })

const call = (tools: Record<string, { execute?: (...a: any[]) => any }>, key: string, args: Record<string, unknown>) =>
  Effect.promise(async () => {
    const out = await tools[key]!.execute!(args, {
      toolCallId: `call-${Math.random()}`,
      abortSignal: new AbortController().signal,
      messages: [],
    })
    return out.output as string
  })

const CREATE = "datum-studio_studio_mission_create"
const LINE = 'Skills suggested for mission type "Research": invoice-check, report-format. Load one with the skill tool if it helps.'

describe("SK-g mission-type line (N8-048)", () => {
  withTools.instance("a created mission whose type skills list gets one line, names sorted", () =>
    Effect.gen(function* () {
      available = [REPORT, PLAIN, INVOICE]
      reply = { content: [{ type: "text", text: "ok" }] }
      const output = yield* call(yield* resolve(), CREATE, { id: "2026-11-14_syn", type: "Research" })
      expect(output).toBe(`ok\n\n${LINE}`)
      expect(output.split("Skills suggested for").length).toBe(2)
    }),
  )

  withTools.instance("no match, an error result, another tool or a look-alike server: the result is unchanged", () =>
    Effect.gen(function* () {
      available = [REPORT, PLAIN, INVOICE]
      reply = { content: [{ type: "text", text: "ok" }] }
      const tools = yield* resolve()
      expect(yield* call(tools, CREATE, { type: "Engineering" })).toBe("ok")
      expect(yield* call(tools, CREATE, {})).toBe("ok")
      expect(yield* call(tools, "datum-studio_studio_mission_get", { type: "Research" })).toBe("ok")
      expect(yield* call(tools, "lookalike_studio_mission_create", { type: "Research" })).toBe("ok")
      // A refused create surfaces as the tool error, with no suggestion in it.
      reply = { content: [{ type: "text", text: "refused" }], isError: true }
      const failed = yield* call(tools, CREATE, { type: "Research" }).pipe(
        Effect.map(() => "resolved"),
        Effect.catchCause((cause) => Effect.succeed(String(cause))),
      )
      expect(failed).toContain("refused")
      expect(failed).not.toContain("Skills suggested for")
    }),
  )

  withTools.instance("the type is escaped and cut to 64 characters", () =>
    Effect.gen(function* () {
      const type = `<b>${"r".repeat(80)}`
      available = [info("odd-type", { missionTypes: [type.toLowerCase()] })]
      reply = { content: [{ type: "text", text: "ok" }] }
      const output = yield* call(yield* resolve(), CREATE, { type })
      expect(output).toBe(
        `ok\n\nSkills suggested for mission type "&lt;b&gt;${"r".repeat(61)}": odd-type. Load one with the skill tool if it helps.`,
      )
    }),
  )
})

// --- Real prompt loop: first-message focus, prompt cache, denied skill, no load --------------------------------------

const mcpStub = Layer.succeed(
  MCP.Service,
  MCP.Service.of({
    status: () => Effect.succeed({}),
    clients: () => Effect.succeed({}),
    instructions: () => Effect.succeed([]),
    tools: () => Effect.succeed({}),
    prompts: () => Effect.succeed({}),
    resources: () => Effect.succeed({}),
    resourceTemplates: () => Effect.succeed({}),
    add: () => Effect.succeed({ status: { status: "disabled" as const } }),
    connect: () => Effect.void,
    disconnect: () => Effect.void,
    getPrompt: () => Effect.succeed(undefined),
    readResource: () => Effect.succeed(undefined),
    startAuth: () => Effect.die("unexpected MCP auth"),
    authenticate: () => Effect.die("unexpected MCP auth"),
    finishAuth: () => Effect.die("unexpected MCP auth"),
    removeAuth: () => Effect.void,
    supportsOAuth: () => Effect.succeed(false),
    hasStoredTokens: () => Effect.succeed(false),
    getAuthStatus: () => Effect.succeed("not_authenticated" as const),
  }),
)
const lspStub = Layer.mock(LSP.Service, {
  init: () => Effect.void,
  status: () => Effect.succeed([]),
  hasClients: () => Effect.succeed(false),
  touchFile: () => Effect.void,
  diagnostics: () => Effect.succeed({}),
})
const summaryStub = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const loop = testEffect(
  LayerNode.compile(
    LayerNode.group([
      SessionPrompt.node,
      Session.node,
      SessionProjector.node,
      SessionSummary.node,
      Database.node,
      CrossSpawnSpawner.node,
      LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] }),
    ]),
    [
      [MCP.node, mcpStub],
      [LSP.node, lspStub],
      [SessionSummary.node, summaryStub],
      [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true })],
    ],
  ),
)

const providerCfg = (url: string) => ({
  permission: { "*": "allow" as const, skill: { "*": "allow" as const, "denied-invoice": "deny" as const } },
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

type Message = { role?: string; content?: unknown }
const systemOf = (body: Record<string, unknown>) =>
  ((body.messages ?? []) as Message[])
    .filter((message) => message.role === "system")
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : Array.isArray(message.content)
          ? message.content.map((part: { text?: string }) => part.text ?? "").join("\n")
          : "",
    )
    .join("\n")

const writeSkill = (dir: string, name: string, triggers: string) => {
  const folder = path.join(dir, ".swarm", "skills", name)
  mkdirSync(folder, { recursive: true })
  writeFileSync(
    path.join(folder, "SKILL.md"),
    `---\nname: ${name}\ndescription: Synthetic ${name} for row 41.\n${triggers}---\n\n# ${name}\n`,
  )
}

describe("SK-g through the prompt loop", () => {
  loop.live(
    "the block comes from the first message, stays byte-identical on the next one, and loads nothing",
    () =>
      provideTmpdirServer(
        Effect.fnUntraced(function* ({ dir, llm }) {
          writeSkill(dir, "invoice-check", "triggers:\n  keywords: [invoice]\n")
          writeSkill(dir, "denied-invoice", "triggers:\n  keywords: [invoice]\n")
          const prompt = yield* SessionPrompt.Service
          const sessions = yield* Session.Service
          const chat = yield* sessions.create({
            title: "SK-g",
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          })
          const turn = (text: string) =>
            Effect.gen(function* () {
              yield* llm.text(`reply to ${text}`)
              yield* prompt.prompt({ sessionID: chat.id, agent: "build", noReply: true, parts: [{ type: "text", text }] })
              yield* prompt.loop({ sessionID: chat.id })
            })
          yield* turn("check this Invoice.")
          yield* turn("now something else entirely")

          const systems = (yield* llm.hits).map((hit) => systemOf(hit.body))
          expect(systems).toHaveLength(2)
          expect(systems[0]).toContain('- invoice-check: matched keywords "invoice"')
          // only skills available to the agent: the denied one is neither listed nor suggested
          expect(systems[0]).not.toContain("denied-invoice")
          // P-05: the second turn's system prompt is the first turn's, byte for byte
          expect(systems[1]).toBe(systems[0]!)
          // suggest only: no skill tool part anywhere in the session
          const messages = yield* sessions.messages({ sessionID: chat.id })
          const toolParts = messages.flatMap((message) => message.parts.filter((part) => part.type === "tool"))
          expect(toolParts.filter((part) => part.type === "tool" && part.tool === "skill")).toEqual([])
        }),
        { config: providerCfg },
      ),
    30_000,
  )
})
