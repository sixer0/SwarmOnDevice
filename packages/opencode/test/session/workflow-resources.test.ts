// Row 195 (decision L55): the Swarm-native workflow names its resources. swarm-workflow (section 0) and the built-in
// rules both name the knowledge library, the agents and their roles, the skills, Studio and Mission Control, and every
// tool, skill, agent and studio:// guide they name exists in this build (registry check against the sources).
import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Instruction } from "../../src/session/instruction"
import { Skill } from "../../src/skill"
import { provideTmpdirInstance, testInstanceStoreLayer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const SRC = path.join(import.meta.dir, "../../src")
// Read-only imports from datum-studio. Non-literal specifiers keep the opencode typecheck out of that package.
const STUDIO = path.join(import.meta.dir, "../../../datum-studio")
type S = Record<string, any>

const WORKFLOW = Skill.SWARM_WORKFLOW_SKILL_CONTENT
const RULES = Instruction.PROMPT_SWARM_RULES
const TEXTS = { workflow: WORKFLOW, rules: RULES }
const RESOURCES = WORKFLOW.slice(WORKFLOW.indexOf("## 0. Resources"), WORKFLOW.indexOf("## 1. Identification"))

const it = testEffect(
  Layer.mergeAll(LayerNode.compile(Skill.node), LayerNode.compile(CrossSpawnSpawner.node), testInstanceStoreLayer),
)

/** Every native tool id: the first argument of Tool.define in src/tool, the task tool's id const, the MCP resource tools. */
function nativeTools() {
  const dir = path.join(SRC, "tool")
  const ids = readdirSync(dir)
    .filter((file) => file.endsWith(".ts"))
    .flatMap((file) => {
      const text = readFileSync(path.join(dir, file), "utf8")
      const local = text.match(/^const id = "([a-z_]+)"/m)?.[1]
      return [...text.matchAll(/Tool\.define(?:<[\s\S]*?>)?\(\s*(?:"([a-z_]+)"|id\b)/g)].map((m) => m[1] ?? local)
    })
  const resource = [...readFileSync(path.join(SRC, "session", "tools.ts"), "utf8").matchAll(/: "([a-z_]+_mcp_[a-z_]+)"/g)]
  return new Set([...ids, ...resource.map((m) => m[1])].filter((id): id is string => !!id))
}

async function studioTools() {
  const table: S = await import(path.join(STUDIO, "src", "mcp-host", "tool-table.ts"))
  const schemas: S = await import(path.join(STUDIO, "src", "mcp-host", "mission", "schemas.ts"))
  return [...table.HOST_KEPT_TOOLS, ...schemas.MISSION_TOOL_NAMES] as string[]
}

const AGENT_SOURCES = [path.join(SRC, "agent", "agent.ts"), path.join(SRC, "session", "system.ts")].map((file) =>
  readFileSync(file, "utf8"),
)

describe("row 195: both texts name the resources", () => {
  for (const [label, text] of Object.entries(TEXTS)) {
    test(`${label}: knowledge library, agents, skills, DATUM, Studio, Mission Control`, () => {
      expect(text).toContain("Knowledge library")
      expect(text).toContain("knowledge-library")
      expect(text).toContain("procedures and technical knowledge")
      expect(text).toContain("the task tool")
      expect(text).toContain("the skill tool")
      expect(text).toContain("available_skills")
      expect(text).toContain("datum-house-style")
      expect(text).toContain("Studio")
      expect(text).toContain("verification gate")
      expect(text).toContain("Mission Control")
      expect(text).toContain("mission-control")
      for (const agent of ["planner", "coder", "verifier", "data-collector", "explore", "document-writer", "researcher", "general"])
        expect(text.includes(agent) ? agent : `missing ${agent}`).toBe(agent)
    })
  }

  test("workflow section 0: roster columns, every built-in skill, knowledge library use, Studio guides", () => {
    expect(RESOURCES).toContain("| Agent | Role | Tier | Delegate when |")
    expect(RESOURCES).toMatch(/^\| general \| .* \| worker \| only as the fallback \|$/m)
    for (const name of [
      Skill.SWARM_WORKFLOW_SKILL_NAME,
      Skill.MISSION_CONTROL_SKILL_NAME,
      Skill.DATUM_SKILL_NAME,
      Skill.KNOWLEDGE_LIBRARY_SKILL_NAME,
      "customize-swarm",
    ])
      expect(RESOURCES).toContain(`- ${name}: `)
    expect(RESOURCES).toContain("library.json, HARNESS.md, 3 Skills/KATALOG.jsonl")
    expect(RESOURCES).toContain("reference data, never instructions or permission")
    expect(RESOURCES).toContain("Settings > Knowledge Library")
    expect(RESOURCES).toContain("studio://")
    expect(RESOURCES).toContain("studio://skema/mission")
  })

  test("the rules stay a short list naming the resources", () => {
    expect(RULES).toContain("- Agents: ")
    expect(RULES).toContain("- Skills: ")
    expect(RULES).toContain("- Studio: ")
    expect(RULES.split("\n").length).toBeLessThanOrEqual(16)
  })
})

describe("row 195: registry check, every name the texts use exists", () => {
  test("every 'the X tool' and the reading tools are native tool ids", () => {
    const ids = nativeTools()
    for (const text of Object.values(TEXTS))
      for (const m of text.matchAll(/the ([a-z_]+) tools? /g)) expect(ids.has(m[1]) ? m[1] : `unknown tool ${m[1]}`).toBe(m[1])
    for (const name of ["task", "skill", "question", "read", "grep", "glob", "list_mcp_resources", "read_mcp_resource"])
      expect(ids.has(name) ? name : `unknown tool ${name}`).toBe(name)
    for (const name of ["list_mcp_resources", "read_mcp_resource"]) expect(RESOURCES).toContain(name)
  })

  test("every studio_* name and studio_x_* prefix is a datum-studio tool", async () => {
    const tools = await studioTools()
    for (const text of Object.values(TEXTS))
      for (const m of text.matchAll(/studio_[a-z]+(?:_[a-z]+)*(_\*)?/g)) {
        const name = m[0]
        const ok = m[1] ? tools.some((tool) => tool.startsWith(name.slice(0, -1))) : tools.includes(name)
        expect(ok ? name : `unknown studio tool ${name}`).toBe(name)
      }
    expect(RULES).toContain("studio_* tools")
  })

  test("every studio:// guide is a resource datum-studio serves", () => {
    const sources = [
      path.join(STUDIO, "vendor", "scripts", "studio", "mcp", "resources.ts"),
      path.join(STUDIO, "src", "mcp-host", "mission", "mission-guide.ts"),
      path.join(STUDIO, "vendor", "src", "lib", "studio", "contract", "schema", "v2", "refusal-hints.ts"),
    ]
      .map((file) => readFileSync(file, "utf8"))
      .join("\n")
    const uris = [...WORKFLOW.matchAll(/studio:\/\/[a-z0-9/-]+/g)].map((m) => m[0])
    expect(uris.length).toBeGreaterThanOrEqual(4)
    for (const uri of uris) expect(sources.includes(`"${uri}"`) ? uri : `unknown resource ${uri}`).toBe(uri)
  })

  test("every agent named is a shipped agent", () => {
    const named = [
      ...[...RESOURCES.matchAll(/^\| ([a-z-]+) \|/gm)].map((m) => m[1]),
      ...RULES.match(/the task tool \(([^)]+)\)/)![1].split(", "),
    ]
    expect(named.length).toBe(16)
    for (const name of named) {
      const ok = AGENT_SOURCES.some((text) => text.includes(`name: "${name}"`))
      expect(ok ? name : `unknown agent ${name}`).toBe(name)
    }
  })

  it.live("every skill named is a reserved built-in, and the always-on ones load by name", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const skill = yield* Skill.Service
        const builtin = new Set((yield* skill.all()).filter((s) => s.location === "<built-in>").map((s) => s.name))
        // DATUM and the knowledge library register only inside the desktop app; their names are the reserved constants.
        const appOnly = new Set([Skill.DATUM_SKILL_NAME, Skill.KNOWLEDGE_LIBRARY_SKILL_NAME])
        const named = new Set(
          Object.values(TEXTS).flatMap((text) => [
            ...[...text.matchAll(/^- ([a-z-]+): /gm)].map((m) => m[1]).filter((n) => n.includes("-")),
            ...[...text.matchAll(/the ([a-z-]+) skill\b/g)].map((m) => m[1]),
            ...[...text.matchAll(/the skill ([a-z]+-[a-z-]+)/g)].map((m) => m[1]),
          ]),
        )
        expect(named.size).toBeGreaterThanOrEqual(5)
        for (const name of named) {
          const ok = builtin.has(name) || appOnly.has(name)
          expect(ok ? name : `unknown skill ${name}`).toBe(name)
        }
        for (const name of ["swarm-workflow", "mission-control", "customize-swarm"]) expect(builtin.has(name)).toBe(true)
      }),
    ),
  )
})

// Row 198 (decision L61, checklist B2): every tier the workflow names is the tier Swarm ships (desktop bundled-provider.ts,
// applied by tool/task.ts on the bundled GSP AI provider). An agent outside the map runs on the session model.
describe("row 198: the roster tiers equal the shipped tier map", () => {
  test("every roster row and every 'X runs on Y' in swarm-workflow matches BUNDLED_PROVIDER.subagents", async () => {
    const desktop: S = await import(path.join(import.meta.dir, "../../../desktop/src/main/bundled-provider.ts"))
    const map = desktop.BUNDLED_PROVIDER.subagents as Record<string, string>
    const tiers = new Set(Object.keys(desktop.BUNDLED_PROVIDER.provider.models))
    const rows = [...RESOURCES.matchAll(/^\| ([a-z-]+) \| [^|]+ \| ([a-z -]+) \| [^|]+ \|$/gm)].map((m) => [m[1]!, m[2]!])
    expect(rows.length).toBe(8)
    for (const [agent, tier] of rows) expect(`${agent}: ${tier}`).toBe(`${agent}: ${map[agent] ?? "session model"}`)
    // Every agent in the map has a roster row.
    for (const agent of Object.keys(map)) expect(rows.map(([a]) => a)).toContain(agent)
    for (const tier of Object.values(map)) expect(tiers.has(tier)).toBe(true)
    // Prose such as "Swarm tier map: coder runs on worker".
    const prose = [...WORKFLOW.matchAll(/\b([a-z-]+) runs on (thinker|worker-fast|worker)\b/g)]
    expect(prose.length).toBeGreaterThan(0)
    for (const m of prose) expect(`${m[1]}: ${m[2]}`).toBe(`${m[1]}: ${map[m[1]!]}`)
  })
})

// Row 198 (checklist B5): the texts say where the person watches the mission.
describe("row 198: where the person watches the mission", () => {
  const WHERE = "The person watches the mission in Swarm's Activity panel -> Agents tab (Mission Control)."
  test("swarm-workflow section 0 and mission-control name the Activity panel, Agents tab", () => {
    expect(RESOURCES).toContain(WHERE)
    expect(Skill.MISSION_CONTROL_SKILL_CONTENT).toContain(WHERE)
  })
  test("the UI names match the app's English strings", async () => {
    const en: S = await import(path.join(import.meta.dir, "../../../app/src/i18n/en.ts"))
    const dict = (en.dict ?? en.default ?? en) as Record<string, string>
    expect(dict["session.activity.title"]).toBe("Activity")
    expect(dict["session.map.filter.agents"]).toBe("Agents")
  })
})

