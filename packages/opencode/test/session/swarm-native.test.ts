// Row 192 (decision L49, spec 191 masterplan/04_specs_swarm_native_workflow.md): Swarm's own instructions and workflow.
// SW-01..SW-15 that are not pinned elsewhere (see the row report for the map), plus O3 (a global config change takes
// effect without a restart) and L51 (datum-studio tool calls carry the calling session in _meta).
// Every HOME here is a temp folder: the global layer gets `home`/`config` from tmpdirScoped, and the preload pins
// OPENCODE_TEST_HOME and XDG_* under the OS temp folder.
import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "path"
import { Effect, Layer, Logger } from "effect"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { Global } from "@opencode-ai/core/global"
import { ProjectTrust } from "@opencode-ai/core/project/trust"
import { Instruction } from "../../src/session/instruction"
import { SystemPrompt } from "../../src/session/system"
import { Skill } from "../../src/skill"
import { Config } from "../../src/config/config"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { InstanceStore } from "@/project/instance-store"
import { InstanceBootstrap } from "@/project/bootstrap"
import { McpCatalog } from "../../src/mcp/catalog"
import { resolveRole } from "../../src/agent/role-alias"
import { MessageID } from "../../src/session/schema"
import { provideInstance, testInstanceStoreLayer, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { TestConfig } from "../fixture/config"

const SRC = path.join(import.meta.dir, "../../src")
const RULES = Instruction.PROMPT_SWARM_RULES
const WORKFLOW = Skill.SWARM_WORKFLOW_SKILL_CONTENT

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([CrossSpawnSpawner.node, LayerNodePlatform.filesystem, InstanceStore.node]), [
    [
      InstanceBootstrap.node,
      Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void })),
    ],
  ]),
)

/** A Config whose GLOBAL part is `global` (what claude_compat is read from) and whose merged part is `merged`. */
const configOf = (global: Record<string, unknown>, merged: Record<string, unknown> = {}) =>
  TestConfig.make({ getGlobal: () => Effect.succeed(global as never), get: () => Effect.succeed(merged as never) })

const instruction = (
  dirs: { home: string; config: string },
  config: Config.Interface,
  flags: Partial<RuntimeFlags.Info> = {},
) =>
  AppNodeBuilder.build(Instruction.node, [
    [Config.node, Layer.succeed(Config.Service, config)],
    [Global.node, Global.layerWith(dirs)],
    [RuntimeFlags.node, RuntimeFlags.layer(flags)],
  ])

const skillLayer = (dirs: { home: string; config: string }, config: Config.Interface, flags: Partial<RuntimeFlags.Info> = {}) =>
  AppNodeBuilder.build(Skill.node, [
    [Config.node, Layer.succeed(Config.Service, config)],
    [Global.node, Global.layerWith(dirs)],
    [RuntimeFlags.node, RuntimeFlags.layer(flags)],
  ])

const files = (dir: string, map: Record<string, string>) =>
  Effect.promise(() =>
    Promise.all(Object.entries(map).map(([file, content]) => Bun.write(path.join(dir, file), content))).then(() => {}),
  )

const skillFile = (name: string) => `---\nname: ${name}\ndescription: Synthetic ${name}.\n---\n\n# ${name}\n`

/** A HOME with every Claude Code file the spec names, a separate global config folder and a project. */
const claudeWorld = Effect.gen(function* () {
  const home = yield* tmpdirScoped()
  const config = yield* tmpdirScoped()
  const project = yield* tmpdirScoped({ git: true })
  // The temp folders sit under the OS temp folder, never under the real home.
  expect(home.startsWith(path.resolve(process.env.HOME ?? "/nonexistent") + path.sep + ".claude")).toBe(false)
  yield* files(home, {
    ".claude/CLAUDE.md": "# Home Claude",
    ".claude/skills/x/SKILL.md": skillFile("x"),
  })
  yield* files(project, {
    "CLAUDE.md": "# Project Claude",
    ".claude/skills/y/SKILL.md": skillFile("y"),
  })
  return { home, config, project }
})

const pathsOf = (w: { home: string; config: string; project: string }, config: Config.Interface, flags = {}) =>
  Effect.gen(function* () {
    const svc = yield* Instruction.Service
    return { paths: [...(yield* svc.systemPaths())], system: yield* svc.system() }
  }).pipe(provideInstance(w.project), Effect.provide(instruction({ home: w.home, config: w.config }, config, flags)))

const namesOf = (w: { home: string; config: string; project: string }, config: Config.Interface, flags = {}) =>
  Effect.gen(function* () {
    const svc = yield* Skill.Service
    return (yield* svc.all()).map((item) => item.name)
  }).pipe(provideInstance(w.project), Effect.provide(skillLayer({ home: w.home, config: w.config }, config, flags)))

const claudeIn = (paths: string[]) => paths.filter((item) => path.basename(item) === "CLAUDE.md")

describe("SW-01..SW-04: Claude Code files and the claude_compat setting", () => {
  it.live("SW-01 default: no CLAUDE.md in systemPaths, neither x nor y in Skill.all", () =>
    Effect.gen(function* () {
      const w = yield* claudeWorld
      const { paths, system } = yield* pathsOf(w, configOf({}))
      expect(claudeIn(paths)).toEqual([])
      expect(system).toEqual([RULES])
      const names = yield* namesOf(w, configOf({}))
      expect(names).not.toContain("x")
      expect(names).not.toContain("y")
    }),
  )

  it.live("SW-02 global claude_compat true: both CLAUDE.md files and x, y return", () =>
    Effect.gen(function* () {
      const w = yield* claudeWorld
      const on = configOf({ claude_compat: true })
      const { paths } = yield* pathsOf(w, on)
      expect(claudeIn(paths).sort()).toEqual(
        [path.join(w.home, ".claude", "CLAUDE.md"), path.join(w.project, "CLAUDE.md")].sort(),
      )
      const names = yield* namesOf(w, on)
      expect(names).toContain("x")
      expect(names).toContain("y")
    }),
  )

  it.live("SW-02 global SWARM.md still wins over ~/.claude/CLAUDE.md with the setting on", () =>
    Effect.gen(function* () {
      const w = yield* claudeWorld
      yield* files(w.config, { "SWARM.md": "# Global Swarm" })
      const { paths, system } = yield* pathsOf(w, configOf({ claude_compat: true }))
      expect(paths).toContain(path.join(w.config, "SWARM.md"))
      expect(paths).not.toContain(path.join(w.home, ".claude", "CLAUDE.md"))
      expect(system[1]).toBe(`Instructions from: ${path.join(w.config, "SWARM.md")}\n# Global Swarm`)
    }),
  )

  it.live("SW-03 a project config with claude_compat true and the global unset: same as SW-01", () =>
    Effect.gen(function* () {
      const w = yield* claudeWorld
      yield* files(w.project, { "swarm.json": JSON.stringify({ claude_compat: true }) })
      const projectOnly = configOf({}, { claude_compat: true })
      expect(claudeIn((yield* pathsOf(w, projectOnly)).paths)).toEqual([])
      const names = yield* namesOf(w, projectOnly)
      expect(names).not.toContain("x")
      expect(names).not.toContain("y")
    }),
  )

  for (const [name, flags, files, skills] of [
    ["OPENCODE_DISABLE_CLAUDE_CODE", { disableClaudeCodePrompt: true, disableClaudeCodeSkills: true }, false, false],
    ["OPENCODE_DISABLE_CLAUDE_CODE_PROMPT", { disableClaudeCodePrompt: true }, false, true],
    ["OPENCODE_DISABLE_CLAUDE_CODE_SKILLS", { disableClaudeCodeSkills: true }, true, false],
  ] as const)
    it.live(`SW-04 setting true plus ${name}: forced off where the flag applies`, () =>
      Effect.gen(function* () {
        const w = yield* claudeWorld
        const on = configOf({ claude_compat: true })
        expect(claudeIn((yield* pathsOf(w, on, flags)).paths).length > 0).toBe(files)
        const names = yield* namesOf(w, on, flags)
        expect(names.includes("x") && names.includes("y")).toBe(skills)
      }),
    )

  it.live("SW-01 an unreadable global config means off", () =>
    Effect.gen(function* () {
      const w = yield* claudeWorld
      const broken = TestConfig.make({ getGlobal: () => Effect.die(new Error("synthetic broken global config")) })
      expect(claudeIn((yield* pathsOf(w, broken)).paths)).toEqual([])
      const names = yield* namesOf(w, broken)
      expect(names).not.toContain("x")
    }),
  )
})

describe("SW-05..SW-07: SWARM.md order, precedence, nesting", () => {
  it.live("SW-05 system()[0] is the built-in rules, then global SWARM.md, then project SWARM.md", () =>
    Effect.gen(function* () {
      const w = yield* claudeWorld
      yield* files(w.config, { "SWARM.md": "# G swarm", "AGENTS.md": "# G agents" })
      yield* files(w.project, { "SWARM.md": "# P swarm", "AGENTS.md": "# P agents" })
      const { paths, system } = yield* pathsOf(w, configOf({}))
      expect(system[0]).toBe(RULES)
      expect(system[1]).toBe(`Instructions from: ${path.join(w.config, "SWARM.md")}\n# G swarm`)
      expect(system[2]).toBe(`Instructions from: ${path.join(w.project, "SWARM.md")}\n# P swarm`)
      expect(system).toHaveLength(3)
      expect(paths).not.toContain(path.join(w.config, "AGENTS.md"))
      expect(paths).not.toContain(path.join(w.project, "AGENTS.md"))
    }),
  )

  it.live("SW-05 with only AGENTS.md (global and project) both are used: no regression", () =>
    Effect.gen(function* () {
      const w = yield* claudeWorld
      yield* files(w.config, { "AGENTS.md": "# G agents" })
      yield* files(w.project, { "AGENTS.md": "# P agents" })
      const { system } = yield* pathsOf(w, configOf({}))
      expect(system).toEqual([
        RULES,
        `Instructions from: ${path.join(w.config, "AGENTS.md")}\n# G agents`,
        `Instructions from: ${path.join(w.project, "AGENTS.md")}\n# P agents`,
      ])
    }),
  )

  it.live("SW-07 resolve() attaches sub/SWARM.md when reading sub/file", () =>
    Effect.gen(function* () {
      const w = yield* claudeWorld
      yield* files(w.project, { "sub/SWARM.md": "# Sub swarm", "sub/AGENTS.md": "# Sub agents", "sub/file.ts": "x" })
      const found = yield* Effect.gen(function* () {
        const svc = yield* Instruction.Service
        return yield* svc.resolve([], path.join(w.project, "sub", "file.ts"), MessageID.make("msg_row192-nested"))
      }).pipe(
        provideInstance(w.project),
        Effect.provide(instruction({ home: w.home, config: w.config }, configOf({}))),
      )
      expect(found.map((item) => item.filepath)).toEqual([path.join(w.project, "sub", "SWARM.md")])
      expect(found[0].content).toBe(`Instructions from: ${path.join(w.project, "sub", "SWARM.md")}\n# Sub swarm`)
    }),
  )

  test("SW-06 no source writes SWARM.md: every mention is a read list, a doc or a comment", () => {
    const hits: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const file = path.join(dir, name)
        if (statSync(file).isDirectory()) walk(file)
        else if (/\.(ts|tsx)$/.test(name)) {
          readFileSync(file, "utf8")
            .split("\n")
            .forEach((line, i) => {
              if (line.includes("SWARM.md")) hits.push(`${path.relative(SRC, file)}:${i + 1}: ${line.trim()}`)
            })
        }
      }
    }
    walk(SRC)
    walk(path.join(SRC, "../../core/src"))
    expect(hits.length).toBeGreaterThan(0)
    for (const hit of hits) expect(hit).not.toMatch(/write|mkdir|appendFile|copyFile|rename/i)
    // The only code (non-comment) mentions are the read lists in instruction.ts.
    const code = hits.filter((hit) => !/^\S+:\d+: (\/\/|\*|\/\*\*)/.test(hit))
    expect(code.length).toBeGreaterThan(0)
    for (const hit of code) expect(hit.startsWith("session/instruction.ts:") ? "ok" : hit).toBe("ok")
  })
})

describe("SW-08, SW-09: the built-in swarm-workflow skill", () => {
  const tskill = testEffect(Layer.mergeAll(LayerNode.compile(Skill.node), LayerNode.compile(CrossSpawnSpawner.node), testInstanceStoreLayer))

  tskill.live("SW-08 discovered as <built-in>, equal to the file, available to build, disk copies ignored", () =>
    Effect.gen(function* () {
      const project = yield* tmpdirScoped({ git: true })
      const userCopy = path.join(Global.Path.config, "skills", "swarm-workflow", "SKILL.md")
      yield* files(project, { ".swarm/skills/swarm-workflow/SKILL.md": skillFile("swarm-workflow") })
      yield* files(path.dirname(userCopy), { "SKILL.md": skillFile("swarm-workflow") })
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => import("node:fs/promises").then((fs) => fs.rm(path.dirname(userCopy), { recursive: true, force: true }))),
      )
      const logs: string[] = []
      const got = yield* Effect.gen(function* () {
        const svc = yield* Skill.Service
        const build = { name: "build", mode: "primary" as const, permission: [], options: {} }
        return {
          one: yield* svc.get("swarm-workflow"),
          all: (yield* svc.all()).filter((item) => item.name === "swarm-workflow"),
          available: (yield* svc.available(build as never)).filter((item) => item.name === "swarm-workflow"),
        }
      }).pipe(
        provideInstance(project),
        Effect.provide(
          Logger.layer([
            Logger.make<unknown, void>((options) => {
              logs.push(JSON.stringify(options.message))
            }),
          ]),
        ),
      )
      expect(got.one?.location).toBe("<built-in>")
      expect(got.one?.content).toBe(readFileSync(path.join(SRC, "skill", "swarm-workflow.md"), "utf8"))
      expect(got.one?.description).toBe(Skill.SWARM_WORKFLOW_SKILL_DESCRIPTION)
      expect(got.all).toHaveLength(1)
      expect(got.available).toHaveLength(1)
      expect(logs.filter((line) => line.includes("reserved skill name ignored")).length).toBe(2)
    }),
  )

  test("SW-09 text limits: <= 150 lines, no Claude names, every agent it names is a shipped one", () => {
    expect(WORKFLOW.split("\n").length).toBeLessThanOrEqual(150)
    expect(WORKFLOW).not.toMatch(/Agent\(|Skill\(|subagent_type|CLAUDE|\.claude|master-controller/)
    expect(WORKFLOW.startsWith("---")).toBe(false)
    expect(WORKFLOW).not.toMatch(/alugra|iris|gsp-budi|\/Users\/|ses_[0-9a-f]|100\.102\./i)
    // Spec 161's set (the shipped agents plus general).
    const shipped = new Set(["planner", "coder", "verifier", "data-collector", "explore", "document-writer", "researcher", "general"])
    const table = [...WORKFLOW.matchAll(/^\| ([a-z-]+) \|/gm)].map((m) => m[1]).filter((name) => name !== "Agent")
    // Row 195 (L55): general joined the roster as the fallback row.
    expect(table.length).toBe(8)
    for (const name of table) expect(shipped.has(name) ? name : `unknown agent ${name}`).toBe(name)
    const listed = WORKFLOW.match(/agent is the Swarm agent name from the table in section 0 \(([^)]+)\)/)![1].split(", ")
    for (const name of listed) expect(shipped.has(name) ? name : `unknown agent ${name}`).toBe(name)
    // Spec 191 §3.2 measured size, raised by row 195 (L55) from 7197 to 9101 B (+1904) for section 0 Resources.
    // Row 197 (L57, S194-01): +84 B to 9185 for "Swarm's autonomous mode setting (the person turns it on)".
    // Row 198 (L61, B2 + B5): general's tier "session model" -> "worker" (-7 B) and the Activity -> Agents line (+90 B).
    // Row 102 (1.2.6, W-07/W-04/W-11/W-02): +902 B to 10170 for four working-norm bullets (sections 0, 2, 6).
    // Row 103 (1.2.6, W-06/W-08/W-18): +829 B to 10999 (one bullet in section 2, line 100 rewritten plus one bullet in section 5).
    // Fix row FX-10 (1.2.6, C19a): +158 B to 11157, section 6 states the shared figure-gate sentence.
    // 1.2.7 row 28 (U-6, C9, R-3, INTENT): +447 B to 11604, numbered docs/ folders in sections 2, 3, 5, 7 and the folder block.
    // 1.2.8 row 28d (C38): +37 B to 11641, verifier wording in section 0 (pin moved here by row 47, C57).
    // 1.2.8 row 47 (MEM-f, N8-023, INTENT): +311 B to 11952, close order report -> index entry -> done in section 7.
    expect(Buffer.byteLength(WORKFLOW)).toBe(11952)
  })
})

describe("SW-10, SW-12, SW-15", () => {
  test("SW-10 autoWorkflow loads swarm-workflow from the built-in entry only", () => {
    const builtin = [{ name: Skill.SWARM_WORKFLOW_SKILL_NAME, location: "<built-in>" }]
    expect(SystemPrompt.autoWorkflow("build", builtin)).toEqual([SystemPrompt.PROMPT_AUTO_WORKFLOW])
    expect(SystemPrompt.PROMPT_AUTO_WORKFLOW).toContain('"swarm-workflow"')
    expect(SystemPrompt.PROMPT_AUTO_WORKFLOW).not.toContain("master-controller")
    expect(Buffer.byteLength(SystemPrompt.PROMPT_AUTO_WORKFLOW)).toBeLessThanOrEqual(1800)
    expect(SystemPrompt.autoWorkflow("plan", builtin)).toEqual([])
    expect(SystemPrompt.autoWorkflow("build", builtin, false)).toEqual([])
    expect(SystemPrompt.autoWorkflow("build", [])).toEqual([])
    expect(
      SystemPrompt.autoWorkflow("build", [
        { name: "master-controller", location: path.join(Global.Path.home, ".claude", "skills", "master-controller", "SKILL.md") },
      ]),
    ).toEqual([])
  })

  test("SW-12 a role name still resolves to its Swarm agent (task-architect runs planner)", () => {
    const registry = new Map(
      ["build", "general", "planner", "coder", "verifier", "explore", "data-collector", "document-writer"].map((name) => [
        name,
        { name, mode: name === "build" ? "primary" : "subagent" },
      ]),
    )
    const resolved = resolveRole("task-architect", (name) => registry.get(name), [])
    expect(resolved).toMatchObject({ type: "alias", name: "planner" })
  })

  test("SW-15 built-in rules: <= 2300 B, no emoji, no Claude tool names, the spec's text", () => {
    // Row 195 (L55) raised the cap from 1500 to 2100 B (+600) for the three resource lines (1461 -> 2043 B).
    // Row 102a (1.2.6, W-15/W-17) raised the cap from 2100 to 2300 B (+200).
    expect(Buffer.byteLength(RULES)).toBeLessThanOrEqual(2300)
    // Row 197 (L57, S194-01): 2043 -> 2060 B for "Swarm's autonomous mode setting (the person turns it on)"; cap kept.
    // Row 102a (1.2.6, W-15/W-17): 2060 -> 2213 B for the metric corpus/filter rule and the bulk-write rule.
    expect(Buffer.byteLength(RULES)).toBe(2213)
    expect(RULES).not.toMatch(/\p{Extended_Pictographic}/u)
    expect(RULES).not.toMatch(/Agent\(|Skill\(|subagent_type|CLAUDE|\.claude|master-controller|\/docs/)
    expect(RULES.startsWith("<swarm_rules>\n")).toBe(true)
    expect(RULES.trimEnd().endsWith("</swarm_rules>")).toBe(true)
    expect(RULES).toContain("it never lifts Swarm's permission prompts or safety rules")
  })
})

// O3 (spec 191 §8): a global config change takes effect without a restart. The route that saves Settings
// (handlers/global.ts configUpdate) calls Config.updateGlobal, which invalidates the cached global config, and, when it
// changed, disposes every instance. Instruction lists are computed per call; Skill.discovery is instance state.
describe("O3: claude_compat reloads without a restart", () => {
  const live = testEffect(
    Layer.mergeAll(
      LayerNode.compile(LayerNode.group([Skill.node, Instruction.node, Config.node])),
      LayerNode.compile(CrossSpawnSpawner.node),
      testInstanceStoreLayer,
    ),
  )

  live.live("updateGlobal turns CLAUDE.md on for the next systemPaths call; .claude skills after the instance reload", () =>
    Effect.gen(function* () {
      const config = yield* Config.Service
      const dir = yield* tmpdirScoped()
      const project = yield* tmpdirScoped({ git: true })
      yield* files(project, { "CLAUDE.md": "# Project Claude", ".claude/skills/y/SKILL.md": skillFile("y") })
      const previous = Global.Path.config
      ;(Global.Path as { config: string }).config = dir
      yield* config.invalidate()
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          ;(Global.Path as { config: string }).config = previous
          yield* config.invalidate()
        }),
      )
      const look = Effect.gen(function* () {
        const paths = [...(yield* (yield* Instruction.Service).systemPaths())]
        const names = (yield* (yield* Skill.Service).all()).map((item) => item.name)
        return { claude: claudeIn(paths).length, y: names.includes("y") }
      })
      const store = yield* InstanceStore.Service
      expect(yield* look.pipe(provideInstance(project))).toEqual({ claude: 0, y: false })

      const result = yield* config.updateGlobal({ claude_compat: true })
      expect(result.changed).toBe(true)
      // No global file existed, so updateGlobal created swarm.jsonc (config.ts globalConfigFile).
      expect(readFileSync(path.join(dir, "swarm.jsonc"), "utf8")).toContain('"claude_compat": true')
      // What the route does next when the config changed (handlers/global.ts:160).
      yield* store.disposeAll()
      expect(yield* look.pipe(provideInstance(project))).toEqual({ claude: 1, y: true })

      yield* config.updateGlobal({ claude_compat: false })
      yield* store.disposeAll()
      expect(yield* look.pipe(provideInstance(project))).toEqual({ claude: 0, y: false })
    }),
  )
})

// L51 (row 188 host behaviour): a datum-studio tool call carries the calling session in _meta, and the host's own
// functions (read-only import from datum-studio) turn it into the session link a mission write uses.
describe("L51: caller session _meta on datum-studio tool calls", () => {
  const STUDIO = path.join(import.meta.dir, "../../../datum-studio/src/mcp-host")
  type S = Record<string, any>

  async function served() {
    const seen: S[] = []
    const server = new Server({ name: "datum-studio", version: "1.0.0" }, { capabilities: { tools: {} } })
    server.setRequestHandler(ListToolsRequestSchema, () =>
      Promise.resolve({ tools: [{ name: "studio_mission_get", inputSchema: { type: "object" } }] }),
    )
    server.setRequestHandler(CallToolRequestSchema, (req) => {
      seen.push(req.params as S)
      return Promise.resolve({ content: [{ type: "text", text: "ok" }] })
    })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    const client = new Client({ name: "swarm", version: "1.0.0" })
    await client.connect(clientTransport)
    return { client, seen }
  }
  const def = { name: "studio_mission_get", inputSchema: { type: "object", properties: {} } } as never
  const options = { toolCallId: "call_l51", abortSignal: new AbortController().signal } as never
  const SESSION = "ses_0123456789abABCDEFGHIJKLMN"

  test("the call's _meta holds studio/callerSession next to the SDK's progress token", async () => {
    const { client, seen } = await served()
    const tool = McpCatalog.convertTool(def, client, undefined, McpCatalog.callerSessionMeta(SESSION))
    await tool.execute?.({ mission: "m" }, options)
    expect(seen).toHaveLength(1)
    expect(seen[0]._meta?.[McpCatalog.CALLER_SESSION_META]).toBe(SESSION)
    expect(seen[0]._meta?.progressToken).toBeDefined()
    expect(seen[0].arguments).toEqual({ mission: "m" })
    await client.close()
  })

  test("no meta given: no studio key on the wire (other servers never see the session)", async () => {
    const { client, seen } = await served()
    await McpCatalog.convertTool(def, client).execute?.({}, options)
    expect(seen[0]._meta?.[McpCatalog.CALLER_SESSION_META]).toBeUndefined()
    await client.close()
  })

  test("the key and the session id are what the row 188 host accepts and links", async () => {
    const table: S = await import(path.join(STUDIO, "tool-table.ts"))
    const mission: S = await import(path.join(STUDIO, "mission", "mission-tools.ts"))
    expect(table.CALLER_SESSION_META).toBe(McpCatalog.CALLER_SESSION_META)
    const { client, seen } = await served()
    await McpCatalog.convertTool(def, client, undefined, McpCatalog.callerSessionMeta(SESSION)).execute?.({}, options)
    const base = { sessionId: "t", agentId: "swarm", fileRoot: "/abs/project" }
    const session = table.sessionForCall(base, seen[0]._meta)
    expect(session.callerSession).toBe(SESSION)
    expect(mission.callerRef(session)).toBe(SESSION)
    // A mission write that omits session gets the calling session linked.
    expect(mission.sessionOf({}, session)).toEqual({ client: "swarm", ref: SESSION })
    await client.close()
  })

  test("session/tools.ts sends it only to the global datum-studio entry", () => {
    const text = readFileSync(path.join(SRC, "session", "tools.ts"), "utf8")
    expect(text).toContain(
      'entry.source?.server === DatumStudioMcp.DATUM_STUDIO_MCP && entry.source.origin === "global"',
    )
    expect(text).toContain("McpCatalog.callerSessionMeta(input.session.id)")
  })
})

// The trust listing part of SW-01..SW-04 lives in test/project/trust.test.ts; here only the export is pinned.
test("ProjectTrust exposes the claude_compat check the trust listing uses", () => {
  expect(typeof ProjectTrust.claudeCompatSkills).toBe("function")
})
