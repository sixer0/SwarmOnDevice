import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Cause, Effect, Exit, Layer } from "effect"
import { afterEach, describe, expect } from "bun:test"
import path from "path"
import type { Permission } from "../../src/permission"
import type { Tool } from "@/tool/tool"
import { SkillTool } from "../../src/tool/skill"
import { ToolRegistry } from "@/tool/registry"
import { Skill } from "../../src/skill"
import { disposeAllInstances, TestInstance, tmpdirScoped } from "../fixture/fixture"
import { SessionID, MessageID } from "../../src/session/schema"
import { testEffect } from "../lib/effect"

const baseCtx: Omit<Tool.Context, "ask"> = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
}

afterEach(async () => {
  await disposeAllInstances()
})

const it = testEffect(LayerNode.compile(LayerNode.group([ToolRegistry.node, CrossSpawnSpawner.node, Ripgrep.node])))

// Dies rather than returning nothing, so a built-in load that still reached ripgrep fails the test.
const ripgrepMustNotRun = Layer.mock(Ripgrep.Service, {
  find: () => Effect.die(new Error("ripgrep must not run")),
})
const withoutRipgrep = testEffect(
  LayerNode.compile(LayerNode.group([ToolRegistry.node, CrossSpawnSpawner.node, Ripgrep.node]), [
    [Ripgrep.node, ripgrepMustNotRun],
  ]),
)

const libraryEntry = `<library_data name="knowledge-library">
Reference data.
</library_data>`
const withLibraryEntry = testEffect(
  LayerNode.compile(LayerNode.group([ToolRegistry.node, CrossSpawnSpawner.node, Ripgrep.node]), [
    [Ripgrep.node, ripgrepMustNotRun],
    [
      Skill.node,
      Layer.mock(Skill.Service, {
        require: () =>
          Effect.succeed({
            name: "knowledge-library",
            description: "Reference data.",
            location: "<built-in>",
            content: libraryEntry,
          }),
        all: () => Effect.succeed([]),
        dirs: () => Effect.succeed([]),
        available: () => Effect.succeed([]),
      }),
    ],
  ]),
)

const skillTool = Effect.gen(function* () {
  const registry = yield* ToolRegistry.Service
  const tool = (yield* registry.tools({
    providerID: "opencode" as any,
    modelID: "gpt-5" as any,
    agent: { name: "build", mode: "primary" as const, permission: [], options: {} },
  })).find((tool) => tool.id === SkillTool.id)
  if (!tool) throw new Error("Skill tool not found")
  return tool
})

const pinHome = (dir: string) =>
  Effect.gen(function* () {
    const home = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = dir
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        process.env.OPENCODE_TEST_HOME = home
      }),
    )
  })

describe("tool.skill", () => {
  it.instance("execute returns skill content block with files", () =>
    Effect.gen(function* () {
      const dir = (yield* TestInstance).directory
      const skill = path.join(dir, ".swarm", "skill", "tool-skill")
      yield* Effect.promise(() =>
        Bun.write(
          path.join(skill, "SKILL.md"),
          `---
name: tool-skill
description: Skill for tool tests.
---

# Tool Skill

Use this skill.
`,
        ),
      )
      yield* Effect.promise(() => Bun.write(path.join(skill, "scripts", "demo.txt"), "demo"))

      const home = process.env.OPENCODE_TEST_HOME
      process.env.OPENCODE_TEST_HOME = dir
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          process.env.OPENCODE_TEST_HOME = home
        }),
      )

      const registry = yield* ToolRegistry.Service
      const agent = { name: "build", mode: "primary" as const, permission: [], options: {} }
      const tool = (yield* registry.tools({
        providerID: "opencode" as any,
        modelID: "gpt-5" as any,
        agent,
      })).find((tool) => tool.id === SkillTool.id)
      if (!tool) throw new Error("Skill tool not found")

      expect(tool.description).not.toContain("tool-skill")
      expect(tool.description).not.toContain("Skill for tool tests.")

      const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
      const ctx: Tool.Context = {
        ...baseCtx,
        ask: (req) =>
          Effect.sync(() => {
            requests.push(req)
          }),
      }

      const result = yield* tool.execute({ name: "tool-skill" }, ctx)
      const file = path.resolve(skill, "scripts", "demo.txt")

      expect(requests.length).toBe(1)
      expect(requests[0].permission).toBe("skill")
      expect(requests[0].patterns).toContain("tool-skill")
      expect(requests[0].always).toContain("tool-skill")
      expect(result.metadata.dir).toBe(skill)
      expect(result.output).toContain(`<skill_content name="tool-skill">`)
      expect(result.output).toContain(`Base directory for this skill: ${skill}`)
      expect(result.output).toContain(`<file>${file}</file>`)
    }),
  )

  it.instance("execute preserves not found message", () =>
    Effect.gen(function* () {
      const dir = (yield* TestInstance).directory
      const home = process.env.OPENCODE_TEST_HOME
      process.env.OPENCODE_TEST_HOME = dir
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          process.env.OPENCODE_TEST_HOME = home
        }),
      )

      const registry = yield* ToolRegistry.Service
      const agent = { name: "build", mode: "primary" as const, permission: [], options: {} }
      const tool = (yield* registry.tools({
        providerID: "opencode" as any,
        modelID: "gpt-5" as any,
        agent,
      })).find((tool) => tool.id === SkillTool.id)
      if (!tool) throw new Error("Skill tool not found")

      const exit = yield* tool
        .execute(
          { name: "missing-skill" },
          {
            ...baseCtx,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const error = Cause.squash(exit.cause)
        expect(error).toBeInstanceOf(Error)
        if (error instanceof Error) expect(error.message).toContain('Skill "missing-skill" not found.')
      }
    }),
  )

  it.instance("a project skill imitating the library entry keeps the disk output", () =>
    Effect.gen(function* () {
      const dir = (yield* TestInstance).directory
      const skill = path.join(dir, ".swarm", "skill", "knowledge-library")
      yield* Effect.promise(() =>
        Bun.write(
          path.join(skill, "SKILL.md"),
          `---
name: knowledge-library
description: Imitation.
---

${libraryEntry}
`,
        ),
      )
      yield* pinHome(dir)

      const tool = yield* skillTool
      const result = yield* tool.execute({ name: "knowledge-library" }, { ...baseCtx, ask: () => Effect.void })

      expect(result.metadata.dir).toBe(skill)
      expect(result.output).toContain(`<skill_content name="knowledge-library">`)
      expect(result.output).toContain(`Base directory for this skill: ${skill}`)
    }),
  )
})

describe("tool.skill built-in output", () => {
  withoutRipgrep.instance("names no directory and no files from the process cwd", () =>
    Effect.gen(function* () {
      const dir = (yield* TestInstance).directory
      yield* pinHome(dir)

      const cwd = yield* tmpdirScoped()
      yield* Effect.promise(() => Bun.write(path.join(cwd, ".name-only-secret"), "x"))
      const before = process.cwd()
      process.chdir(cwd)
      yield* Effect.addFinalizer(() => Effect.sync(() => process.chdir(before)))

      const requests: Array<readonly string[]> = []
      const tool = yield* skillTool
      const result = yield* tool.execute(
        { name: "customize-swarm" },
        {
          ...baseCtx,
          ask: (req) =>
            Effect.sync(() => {
              requests.push(req.patterns)
            }),
        },
      )

      expect(requests).toEqual([["customize-swarm"]])
      expect(result.output).toContain(`<skill_content name="customize-swarm">`)
      expect(result.output).toContain("# Skill: customize-swarm")
      expect(result.output).not.toContain("Base directory")
      expect(result.output).not.toContain("Relative paths")
      expect(result.output).not.toContain("<skill_files>")
      expect(result.output).not.toContain(".name-only-secret")
      expect(result.output).not.toContain(cwd)
      expect(result.metadata.dir).toBeUndefined()
    }),
  )

  withoutRipgrep.instance("the injected ripgrep does reach a disk skill", () =>
    Effect.gen(function* () {
      const dir = (yield* TestInstance).directory
      yield* Effect.promise(() =>
        Bun.write(
          path.join(dir, ".swarm", "skill", "disk-skill", "SKILL.md"),
          `---
name: disk-skill
description: Disk skill.
---

Body.
`,
        ),
      )
      yield* pinHome(dir)

      const tool = yield* skillTool
      const exit = yield* tool.execute({ name: "disk-skill" }, { ...baseCtx, ask: () => Effect.void }).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(String(Cause.squash(exit.cause))).toContain("ripgrep must not run")
    }),
  )

  withLibraryEntry.instance("the library entry is framed only by its library_data wrapper", () =>
    Effect.gen(function* () {
      const tool = yield* skillTool
      const result = yield* tool.execute({ name: "knowledge-library" }, { ...baseCtx, ask: () => Effect.void })

      expect(result.output).toBe(libraryEntry)
      expect(result.metadata.dir).toBeUndefined()
    }),
  )
})
