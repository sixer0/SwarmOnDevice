// N8-356 (Swarm 1.2.8 row 47): the built-in skill pack and the rule texts it ships with.
// - "MEM-f" (AC-MEMf, 01e section 6): the close order report -> index entry -> done in swarm-workflow and mission-control,
//   remember.txt names kind "index", swarm-rules.txt stays 2213 B; skill_draft counts as a local tool for remember (C54).
// - "skill-authoring" (AC-SKi, 01b SK-i): a reserved built-in with the 01b section 3.4 triggers; the trigger suggests it
//   and a person who turned it off in skills.disabled never gets it suggested (C36).
// - "obsidian-memory" (AC-OBSg, 01c section 8.1 with the 01_specs section 5.2 link rule): required and reserved.
// - "project-folders" (AC-PROJh, 01d section 8 with C8 batches of 200 and the N8-150 naming rule).
// Every tool a skill names is a registered one. Red at BASE e1f9673772: none of the three skills exists, the rule texts
// keep the old close order, and skill_draft is not a tool. Synthetic inputs only; the global config folder is a
// per-test temporary folder.
import { describe, expect, test } from "bun:test"
import { readFileSync, readdirSync } from "node:fs"
import path from "node:path"
import { Effect, Layer, Logger } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Global } from "@opencode-ai/core/global"
import { ProjectTrust } from "@opencode-ai/core/project/trust"
import { Skill } from "../../src/skill"
import { Config } from "../../src/config/config"
import { ConfigMarkdown } from "../../src/config/markdown"
import { SystemPrompt } from "../../src/session/system"
import { readUntrustedInput } from "../../src/tool/remember"
import { ShellID } from "../../src/tool/shell/id"
import { provideTmpdirInstance, testInstanceStoreLayer, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  Layer.mergeAll(
    LayerNode.compile(LayerNode.group([Skill.node, Config.node])),
    LayerNode.compile(CrossSpawnSpawner.node),
    testInstanceStoreLayer,
  ),
)

const OC = path.join(import.meta.dir, "..", "..")
const SRC = path.join(OC, "src")
const PACKAGES = path.join(OC, "..")
const read = (...parts: string[]) => readFileSync(path.join(...parts), "utf8")
const readOptional = (...parts: string[]) => {
  try {
    return read(...parts)
  } catch {
    return ""
  }
}
const skillFile = (file: string) => readOptional(SRC, "skill", file)
const s = Skill as unknown as Record<string, unknown>

// --- The tools that exist in this build -------------------------------------------------------------------------------
/** Built-in tool ids: the first string literal after each Tool.define in src/tool, plus the shell tool's id. */
const BUILTIN_TOOLS = new Set<string>([
  ShellID.ToolID,
  ...readdirSync(path.join(SRC, "tool"))
    .filter((file) => file.endsWith(".ts"))
    .flatMap((file) => {
      const text = read(SRC, "tool", file)
      return [...text.matchAll(/Tool\.define/g)].flatMap((m) => {
        const id = /"([a-z_]+)"/.exec(text.slice(m.index! + 11, m.index! + 311))
        return id ? [id[1]] : []
      })
    }),
])
const STUDIO_SCHEMAS = read(PACKAGES, "datum-studio", "src", "mcp-host", "mission", "schemas.ts")
const STUDIO_TOOLS = new Set([...STUDIO_SCHEMAS.matchAll(/"(studio_[a-z_]+)"/g)].map((m) => m[1]))
const SWARM_WEB_TOOLS = new Set(
  [...read(PACKAGES, "setup", "src", "mcpproxy", "wiring.ts").matchAll(/"(swarm-web_[a-z_]+)"/g)].map((m) => m[1]),
)

/** Every tool-shaped name in a skill text: studio_*, swarm-web_*, and snake_case ids (skill_draft, apply_patch). */
function namedTools(text: string) {
  const web = [...text.matchAll(/\bswarm-web_[a-z_]*[a-z]\b/g)].map((m) => m[0])
  const rest = text.replace(/\bswarm-web_[a-z_]*[a-z]\b/g, " ")
  const snake = [...rest.matchAll(/(?<![\w./-])[a-z]+(?:_[a-z]+)+(?![\w/-])/g)].map((m) => m[0])
  return [...new Set([...web, ...snake])]
}
const isRealTool = (name: string) => BUILTIN_TOOLS.has(name) || STUDIO_TOOLS.has(name) || SWARM_WEB_TOOLS.has(name)
function expectRealTools(text: string, mustName: string[]) {
  for (const name of mustName) expect(text.includes(name) ? name : `text does not name ${name}`).toBe(name)
  for (const name of [...namedTools(text), ...mustName])
    expect(isRealTool(name) ? name : `not a registered tool: ${name}`).toBe(name)
}

/** The guards every built-in text passes (mission-control's): no frontmatter, no shell or argument template, no @file. */
function expectBuiltinShape(text: string) {
  expect(text.startsWith("# ")).toBe(true)
  expect(ProjectTrust.isTextSkill(text)).toBe(true)
  expect(/\$(?:\d|ARGUMENTS)/.test(text)).toBe(false)
  expect(ConfigMarkdown.files(text)).toHaveLength(0)
  expect(text).not.toMatch(/alugra|iris|gsp-budi|\/Users\/|ses_[0-9a-f]|100\.102\./i)
}

// --- Global config (skills.disabled) and log capture -----------------------------------------------------------------
const withGlobalConfig = <A, E, R>(content: unknown, self: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const config = yield* Config.Service
    const dir = yield* tmpdirScoped()
    yield* Effect.promise(() => Bun.write(path.join(dir, "swarm.json"), JSON.stringify(content)))
    return yield* Effect.acquireUseRelease(
      Effect.gen(function* () {
        const previous = Global.Path.config
        ;(Global.Path as { config: string }).config = dir
        yield* config.invalidate()
        return previous
      }),
      () => self,
      (previous) =>
        Effect.gen(function* () {
          ;(Global.Path as { config: string }).config = previous
          yield* config.invalidate()
        }),
    )
  })

const captureLogs = <A, E, R>(messages: string[], self: Effect.Effect<A, E, R>) =>
  self.pipe(
    Effect.provide(
      Logger.layer([
        Logger.make<unknown, void>((options) => {
          messages.push(JSON.stringify(options.message))
        }),
      ]),
    ),
  )

/** The built-in is listed, loads its bundled file, and a project copy of the name is ignored with the reserved warning. */
const expectReservedBuiltin = (name: string, file: string) => {
  const logs: string[] = []
  return captureLogs(
    logs,
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          for (const where of [".swarm/skill", ".agents/skills"])
            yield* Effect.promise(() =>
              Bun.write(
                path.join(dir, where, name, "SKILL.md"),
                `---\nname: ${name}\ndescription: Imitation from the disk.\n---\n\n# Imitation body\n`,
              ),
            )
          const skill = yield* Skill.Service
          expect(Skill.RESERVED_SKILL_NAMES.has(name)).toBe(true)
          const all = (yield* skill.all()).filter((item) => item.name === name)
          expect(all.length).toBe(1)
          expect(all[0]?.location).toBe("<built-in>")
          expect((yield* skill.require(name)).content).toBe(skillFile(file))
          expect(logs.filter((line) => line.includes("reserved skill name ignored")).length).toBe(2)
        }),
      { git: true },
    ),
  )
}

// --- MEM-f ------------------------------------------------------------------------------------------------------------
const N8_023 =
  'After the final report: write one mission index entry with remember {kind: "index", missionId} in the format "YYYY-MM-DD <mission-id> | <outcome> | triggers: k1, k2, k3 | <report path>" (one line, <= 300 characters), then close the mission as done. A done close without it is refused (MEMORY_INDEX_MISSING).'

describe("MEM-f", () => {
  const workflow = skillFile("swarm-workflow.md")
  const missionControl = skillFile("mission-control.md")

  test("swarm-workflow section 7: report, then the N8-023 index entry, then done", () => {
    const close = workflow.slice(workflow.indexOf("## 7. Close"), workflow.indexOf("## docs/ folder"))
    const report = close.indexOf("Write docs/<task>/10_report/report.md")
    const index = close.indexOf(N8_023)
    const done = close.indexOf("Set the mission done")
    expect(report > 0 && index > 0 && done > 0).toBe(true)
    expect(report < index).toBe(true)
    expect(index < done).toBe(true)
    expect(workflow.split(N8_023).length - 1).toBe(1)
  })

  test("mission-control: index entry before closing, the MEMORY_INDEX_MISSING refusal, at most 120 lines", () => {
    const before = missionControl.indexOf(
      'Before closing, write the final report and its mission index entry: remember {kind: "index", missionId, text: "YYYY-MM-DD <mission-id> | <outcome> | triggers: k1, k2 | docs/<mission-id>/10_report/report.md"}.',
    )
    expect(before > 0).toBe(true)
    expect(before < missionControl.indexOf("Close in one call")).toBe(true)
    expect(missionControl).toContain(
      '- MEMORY_INDEX_MISSING: the project memory has no index entry for this mission. Write it with remember {kind: "index", missionId}, then close again. Other clients get warning MEMORY_INDEX_UNCHECKED instead.',
    )
    expect(missionControl.split("\n").length).toBeLessThanOrEqual(120)
  })

  test('remember.txt names kind "index"; swarm-rules.txt stays 2213 B; obsidian-memory does not restate the format', () => {
    expect(read(SRC, "tool", "remember.txt")).toContain('kind "index"')
    expect(Buffer.byteLength(read(SRC, "session", "prompt", "swarm-rules.txt"))).toBe(2213)
    const obsidian = skillFile("obsidian-memory.md")
    expect(obsidian).toContain('`remember` with kind "index"')
    expect(obsidian).not.toContain("YYYY-MM-DD")
  })

  test("C54: a skill_draft call is local input for remember, a webfetch call is not", () => {
    const where = { root: "/work/project", directory: "/work/project" }
    const part = (tool: string, input: Record<string, unknown>) => ({
      info: { role: "assistant" },
      parts: [{ type: "tool", tool, state: { status: "completed", input, output: "", metadata: {} } }],
    })
    expect(BUILTIN_TOOLS.has("skill_draft")).toBe(true)
    expect(readUntrustedInput([part("skill_draft", { name: "x", scope: "project", content: "" })] as never, where)).toBe(
      false,
    )
    expect(readUntrustedInput([part("webfetch", { url: "https://example.com" })] as never, where)).toBe(true)
  })
})

// --- skill-authoring --------------------------------------------------------------------------------------------------
describe("skill-authoring", () => {
  const text = skillFile("skill-authoring.md")
  const focus = { text: "Please write a new skill for checking invoices.", files: [] as string[] }

  it.live("listed as a built-in with its description and the 01b section 3.4 triggers", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const skill = yield* Skill.Service
        const listed = (yield* skill.available()).find((item) => item.name === "skill-authoring")
        expect(listed?.location).toBe("<built-in>")
        expect(listed?.description).toBe(s.SKILL_AUTHORING_SKILL_DESCRIPTION as string)
        expect(listed?.description).toContain("Load it when")
        expect(listed?.triggers).toEqual({
          keywords: ["skill", "skills", "keahlian", "skill.md"],
          files: ["**/skill.md"],
          missionTypes: [],
        })
        expect((yield* skill.require("skill-authoring")).content).toBe(text)
      }),
    ),
  )

  it.live("reserved: a disk copy never replaces it", () => expectReservedBuiltin("skill-authoring", "skill-authoring.md"))

  it.live("its keyword suggests it; turned off in skills.disabled it is never suggested (C36)", () =>
    withGlobalConfig(
      { skills: { disabled: [] } },
      provideTmpdirInstance(() =>
        Effect.gen(function* () {
          const skill = yield* Skill.Service
          const block = SystemPrompt.suggestedSkills(yield* skill.available(), focus)
          expect(block).toContain('- skill-authoring: matched keywords "skill"')
          expect(SystemPrompt.suggestedSkills(yield* skill.available(), { text: "x", files: ["notes/SKILL.md"] })).toContain(
            "- skill-authoring: matched files",
          )
        }),
      ),
    ).pipe(
      Effect.andThen(
        withGlobalConfig(
          { skills: { disabled: ["skill-authoring"] } },
          provideTmpdirInstance(() =>
            Effect.gen(function* () {
              const skill = yield* Skill.Service
              const available = yield* skill.available()
              expect(available.some((item) => item.name === "skill-authoring")).toBe(false)
              expect(SystemPrompt.suggestedSkills(available, focus) ?? "").not.toContain("skill-authoring")
              expect(SystemPrompt.missionTypeSuggestion(available, "document") ?? "").not.toContain("skill-authoring")
              expect((yield* skill.all()).find((item) => item.name === "skill-authoring")?.disabled).toBe(true)
            }),
          ),
        ),
      ),
    ),
  )

  test("text: skill_draft, the triggers keys, Settings > Skills, explicit confirmation for commands, real tools only", () => {
    expectBuiltinShape(text)
    for (const word of ["skill_draft", "triggers", "keywords", "files", "missionTypes", "Settings > Skills"])
      expect(text).toContain(word)
    expect(text).toContain("explicit confirmation")
    expect(text).toMatch(/runs shell commands/)
    expectRealTools(text, ["skill_draft", "edit", "write", "apply_patch", "bash"])
  })

  test("text: no instruction to write into a skills folder", () => {
    const flat = text.replace(/\s+/g, " ")
    const sentences = flat.split(/(?<=\.)\s/).filter((line) => /(?:^|[\s(])\.?(?:agents\/|claude\/)?skills?\//.test(line))
    expect(sentences.length).toBeGreaterThan(0)
    for (const sentence of sentences) expect(sentence).toMatch(/\bNever\b/)
    expect(flat).not.toMatch(/\b(?:write|save|put|create)\b[^.]*\binto (?:the |a )?skills? folder\b(?![^.]*refused)/i)
  })
})

// --- obsidian-memory --------------------------------------------------------------------------------------------------
describe("obsidian-memory", () => {
  const text = skillFile("obsidian-memory.md")

  it.live("listed by available() even with skills.disabled naming it; required", () =>
    withGlobalConfig(
      { skills: { disabled: ["obsidian-memory"] } },
      provideTmpdirInstance(() =>
        Effect.gen(function* () {
          const skill = yield* Skill.Service
          const listed = (yield* skill.available()).find((item) => item.name === "obsidian-memory")
          expect(listed?.location).toBe("<built-in>")
          expect(listed?.required).toBe(true)
          expect(listed?.description).toBe(
            "Mandatory: at mission close and when a lasting decision is recorded, write one note to the Swarm vault inbox that links the mission and its report. The swarm-memory folder is generated by Swarm and is never edited.",
          )
          expect((yield* skill.require("obsidian-memory")).content).toBe(text)
          expect(Skill.REQUIRED_SKILL_NAMES.has("obsidian-memory")).toBe(true)
        }),
      ),
    ),
  )

  it.live("a project skill of that name does not replace it", () =>
    expectReservedBuiltin("obsidian-memory", "obsidian-memory.md"),
  )

  test("body: section 5.2 link rule, the mission tag always, never a vault path, never swarm-memory/ edits", () => {
    expectBuiltinShape(text)
    expect(text).toContain("This skill cannot be turned off.")
    expect(text).toContain("You never write, edit, rename or delete anything in `swarm-memory/`")
    expect(text).toContain("tags: `swarm-memory/mission/<mission-id>`")
    expect(text).toContain("Always set this tag, on every note.")
    expect(text).toContain("never write a vault path")
    expect(text).toContain("[[<mission note name>]] and [[<report note name>]]")
    expect(text).toContain("Copy exactly those two links")
    expect(text).toContain("link by the\n  tag only")
    // The old 01c section 8.1 link form is superseded by 01_specs section 5.2.
    expect(text).not.toContain("[[<mission-id>]]")
    expect(text).not.toContain("[[<mission-id>-report]]")
  })

  test("the nudge the close result carries is the one the skill quotes", async () => {
    const { VaultMirror } = await import("../../src/memory/vault-mirror")
    const nudge = VaultMirror.closeNudge("2026-11-14_syn-check", true)
    const quoted = /`(next: write the vault note for this mission \(skill obsidian-memory\); link)/.exec(text)
    expect(quoted).not.toBeNull()
    expect(nudge.startsWith(quoted![1])).toBe(true)
    expect(nudge).toMatch(/link \[\[[a-z0-9-]+-[0-9a-f]{6}\]\] and \[\[[a-z0-9-]+-[0-9a-f]{6}\]\]\.$/)
  })

  test("names only real tools; the obsidian system line equals N8-122 as corrected", () => {
    expectRealTools(text, ["swarm-web_vault_inbox", "studio_mission_set_status", "studio_mission_record_decision"])
    expect(text).toContain("`remember`")
    expect(BUILTIN_TOOLS.has("remember")).toBe(true)
    expect(read(SRC, "session", "system.ts")).toContain(
      "notes: use swarm-web `vault_inbox` to drop a note in the Obsidian inbox. It is not the memory store. The vault folder swarm-memory/ is generated from project memory: never edit it. When a mission closes or a lasting decision is recorded, write one inbox note (skill obsidian-memory).",
    )
  })
})

// --- project-folders --------------------------------------------------------------------------------------------------
describe("project-folders", () => {
  const text = skillFile("project-folders.md")
  const rehome = readOptional(SRC, "project", "rehome.ts")

  it.live("loads as a built-in", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const skill = yield* Skill.Service
        const listed = (yield* skill.available()).find((item) => item.name === "project-folders")
        expect(listed?.location).toBe("<built-in>")
        expect(listed?.description).toContain("Load it after creating a mission")
        expect((yield* skill.require("project-folders")).content).toBe(text)
      }),
    ),
  )

  it.live("reserved: a disk copy never replaces it", () => expectReservedBuiltin("project-folders", "project-folders.md"))

  test('01d section 8 pins: "Never answer this request yourself", "only propose", batches of 200', () => {
    expectBuiltinShape(text)
    expect(text).toContain("Never answer this request yourself, not even in autonomous mode.")
    expect(text).toContain("You only propose.")
    expect(text).toContain("Never call studio_mission_place")
    expect(text).toContain("(at most 200 items)")
    expect(text).toContain("batches of 200, one request per batch, each approved once")
    expect(text).toContain('topic "project-placement"')
    expect(text).toContain('topic "project-tidy"')
    expect(text).toContain("Do not set blockingRows")
    expect(text).not.toContain("/Users/")
    expect(text).not.toContain("~/Documents/Default Project")
    expect(text).not.toMatch(/(?:^|[\s"'(`])(?:~\/|\/[A-Za-z])/m)
  })

  test("names only real tools; studio_mission_place is person-only", () => {
    expectRealTools(text, [
      "studio_mission_create",
      "studio_mission_list",
      "studio_mission_get",
      "studio_mission_request_decision",
      "studio_mission_place",
    ])
    for (const tool of ["glob", "read"]) {
      expect(text).toContain(`${tool} `)
      expect(BUILTIN_TOOLS.has(tool)).toBe(true)
    }
    expect(read(SRC, "mcp", "catalog.ts")).toContain('PERSON_ONLY_MCP_TOOLS: readonly string[] = ["studio_mission_place"]')
  })

  test("the naming rule matches GROUP_NAME_PATTERN and RESERVED_GROUP_NAMES (N8-150)", () => {
    const pattern = /export const GROUP_NAME_PATTERN = \/(.+)\/\n/.exec(rehome)
    const reserved = /export const RESERVED_GROUP_NAMES = \[([^\]]*)\]/.exec(rehome)
    expect(pattern?.[1]).toBe("^[^./\\\\][^/\\\\]{0,59}$")
    const names = [...(reserved?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1])
    expect(names).toEqual(["docs"])
    const rule = new RegExp(pattern![1])
    // The text's rule: at most 60 characters, no slash or backslash, not starting with a dot, not a reserved name.
    expect(text).toContain("at most 60\n   characters, no slash or backslash, not starting with a dot")
    for (const name of names) expect(text).toContain(`not "${name}"`)
    expect(rule.test("A".repeat(60))).toBe(true)
    expect(rule.test("A".repeat(61))).toBe(false)
    for (const bad of ["a/b", "a\\b", ".hidden"]) expect(rule.test(bad)).toBe(false)
    expect(rule.test("Kajian Tarif")).toBe(true)
  })
})

// --- diagram-flow (1.2.8 row 58, AC-VIS10, N8-062 / N8-476) -----------------------------------------------------------
// The text, the resources and every example are checked by the Studio test N8-382
// (datum-studio test/g04-agent-guide/rel128-vis10-guide.test.ts); here: the real Skill service and the trigger match.
describe("diagram-flow", () => {
  const text = skillFile("diagram-flow.md")
  const TRIGGERS = {
    keywords: ["diagram", "flowchart", "bpmn", "swimlane", "business flow", "business process", "visio", "bagan alir", "alur bisnis", "proses bisnis"],
    files: [],
    missionTypes: [],
  }

  it.live("listed as a built-in with its description and English and Indonesian triggers", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const skill = yield* Skill.Service
        const listed = (yield* skill.available()).find((item) => item.name === "diagram-flow")
        expect(listed?.location).toBe("<built-in>")
        expect(listed?.description).toBe(s.DIAGRAM_FLOW_SKILL_DESCRIPTION as string)
        expect(listed?.description).toContain("Load it before writing a diagram spec")
        expect(listed?.triggers).toEqual(TRIGGERS)
        expect(Skill.parseTriggers(TRIGGERS)).toEqual({ triggers: TRIGGERS })
        expect((yield* skill.require("diagram-flow")).content).toBe(text)
      }),
    ),
  )

  it.live("reserved: a disk copy never replaces it", () => expectReservedBuiltin("diagram-flow", "diagram-flow.md"))

  it.live("a request in English or Indonesian suggests it; an unrelated request does not", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const skill = yield* Skill.Service
        const available = yield* skill.available()
        const suggest = (focus: string) => SystemPrompt.suggestedSkills(available, { text: focus, files: [] }) ?? ""
        for (const [focus, keyword] of [
          ["Draw a BPMN process for the claim handling.", "bpmn"],
          ["Make a flowchart of the approval steps.", "flowchart"],
          ["We need a swimlane view per department.", "swimlane"],
          ["Map the business flow from order to invoice.", "business flow"],
          ["Buatkan bagan alir untuk proses pengadaan.", "bagan alir"],
          ["Tolong gambarkan alur bisnis penagihan.", "alur bisnis"],
          ["Susun diagram proses bisnis layanan.", "diagram"],
        ])
          expect(suggest(focus)).toContain(`- diagram-flow: matched keywords "${keyword}"`)
        expect(suggest("Summarise the meeting notes in three bullets.")).not.toContain("diagram-flow")
      }),
    ),
  )

  test("text: built-in shape, points to both Studio resources, names only registered tools", () => {
    expectBuiltinShape(text)
    expect(text).toContain("studio://skema/diagram")
    expect(text).toContain("studio://skema/diagram-visio")
    const studio = [...new Set([...text.matchAll(/\bstudio_[a-z_]*[a-z]\b/g)].map((m) => m[0]))]
    expect(studio.length).toBeGreaterThan(5)
    const studioTools = new Set(
      ["figure-tools.ts", "doc-tools.ts", "write-tools.ts", "tools.ts"].flatMap((file) =>
        [...readOptional(PACKAGES, "datum-studio", "vendor", "scripts", "studio", "mcp", file).matchAll(/"(studio_[a-z_]+)"/g)].map((m) => m[1]),
      ),
    )
    expect(studio.filter((name) => !studioTools.has(name))).toEqual([])
  })
})
