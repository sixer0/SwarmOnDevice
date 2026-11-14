import { afterAll, afterEach, describe, expect, mock, test } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Cause, Effect, Exit, Layer, Logger } from "effect"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { ProjectTrust } from "@opencode-ai/core/project/trust"
import { ConfigMarkdown } from "../../src/config/markdown"
import { Skill } from "../../src/skill"
import { LibraryRoot } from "../../src/skill/library-root"
import { MessageID, SessionID } from "../../src/session/schema"
import { SkillTool } from "../../src/tool/skill"
import { SystemPrompt } from "../../src/session/system"
import { ToolRegistry } from "../../src/tool/registry"
import { Discovery } from "../../src/skill/discovery"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Config } from "../../src/config/config"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import {
  provideInstance,
  provideTmpdirInstance,
  testInstanceStoreLayer,
  tmpdir,
  tmpdirScoped,
} from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import path from "path"
import os from "os"
import fs from "fs/promises"
import nodeFs from "node:fs"

const node = LayerNode.compile(CrossSpawnSpawner.node)

const it = testEffect(Layer.mergeAll(LayerNode.compile(Skill.node), node, testInstanceStoreLayer))
const itWithoutClaudeCodeSkills = testEffect(
  Layer.mergeAll(
    LayerNode.compile(Skill.node, [[RuntimeFlags.node, RuntimeFlags.layer({ disableClaudeCodeSkills: true })]]),
    node,
    testInstanceStoreLayer,
  ),
)
const itWithoutExternalSkills = testEffect(
  Layer.mergeAll(
    LayerNode.compile(Skill.node, [[RuntimeFlags.node, RuntimeFlags.layer({ disableExternalSkills: true })]]),
    node,
    testInstanceStoreLayer,
  ),
)

async function createGlobalSkill(homeDir: string) {
  const skillDir = path.join(homeDir, ".claude", "skills", "global-test-skill")
  await fs.mkdir(skillDir, { recursive: true })
  await Bun.write(
    path.join(skillDir, "SKILL.md"),
    `---
name: global-test-skill
description: A global skill from ~/.claude/skills for testing.
---

# Global Test Skill

This skill is loaded from the global home directory.
`,
  )
}

const withHome = <A, E, R>(home: string, self: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const prev = process.env.OPENCODE_TEST_HOME
      process.env.OPENCODE_TEST_HOME = home
      return prev
    }),
    () => self,
    (prev) =>
      Effect.sync(() => {
        process.env.OPENCODE_TEST_HOME = prev
      }),
  )

// Row 192 (spec 191 §2.2, L49): .claude skills load only with claude_compat in the GLOBAL config. The tests that cover
// that path turn it on through the global swarm.json (restored afterwards); each test builds its own Config layer, and
// the global config is read lazily at the first skill call, so the file is in place before it is read.
const withClaudeCompat = <A, E, R>(self: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.promise(async () => {
      const file = path.join(Global.Path.config, "swarm.json")
      const prev = await fs.readFile(file, "utf8").catch(() => undefined)
      await fs.mkdir(path.dirname(file), { recursive: true })
      await Bun.write(file, JSON.stringify({ claude_compat: true }))
      return { file, prev }
    }),
    () => self,
    ({ file, prev }) =>
      Effect.promise(() => (prev === undefined ? fs.rm(file, { force: true }) : Bun.write(file, prev).then(() => {}))),
  )

describe("skill", () => {
  it.effect("formats verbose locations as XML-safe filesystem paths", () =>
    Effect.sync(() => {
      const output = Skill.fmt(
        [
          {
            name: "tagged-skill",
            description: "A tagged skill.",
            location: "/tmp/plugin.git#v1.3.0/SKILL.md",
            content: "",
          },
          {
            name: "built-in-skill",
            description: "A built-in skill.",
            location: "<built-in>",
            content: "",
          },
        ],
        { verbose: true },
      )

      expect(output).toContain("<location>/tmp/plugin.git#v1.3.0/SKILL.md</location>")
      expect(output).toContain("<location>&lt;built-in&gt;</location>")
      expect(output).not.toContain("file://")
      expect(output).not.toContain("%23")
    }),
  )

  it.live("discovers skills from .swarm/skill/ directory", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Bun.write(
              path.join(dir, ".swarm", "skill", "test-skill", "SKILL.md"),
              `---
name: test-skill
description: A test skill for verification.
---

# Test Skill

Instructions here.
`,
            ),
          )

          const skill = yield* Skill.Service
          const list = (yield* skill.all()).filter((s) => s.location !== "<built-in>")
          expect(list.length).toBe(1)
          const item = list.find((x) => x.name === "test-skill")
          expect(item).toBeDefined()
          expect(item!.description).toBe("A test skill for verification.")
          expect(item!.location).toContain(path.join("skill", "test-skill", "SKILL.md"))
        }),
      { git: true },
    ),
  )

  it.live("returns skill directories from Skill.dirs", () =>
    provideTmpdirInstance(
      (dir) =>
        withHome(
          dir,
          Effect.gen(function* () {
            yield* Effect.promise(() =>
              Bun.write(
                path.join(dir, ".swarm", "skill", "dir-skill", "SKILL.md"),
                `---
name: dir-skill
description: Skill for dirs test.
---

# Dir Skill
`,
              ),
            )

            const skill = yield* Skill.Service
            const dirs = yield* skill.dirs()
            expect(dirs).toContain(path.join(dir, ".swarm", "skill", "dir-skill"))
            expect(dirs.length).toBe(1)
          }),
        ),
      { git: true },
    ),
  )

  it.live("discovers multiple skills from .swarm/skill/ directory", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Promise.all([
              Bun.write(
                path.join(dir, ".swarm", "skill", "skill-one", "SKILL.md"),
                `---
name: skill-one
description: First test skill.
---

# Skill One
`,
              ),
              Bun.write(
                path.join(dir, ".swarm", "skill", "skill-two", "SKILL.md"),
                `---
name: skill-two
description: Second test skill.
---

# Skill Two
`,
              ),
            ]),
          )

          const skill = yield* Skill.Service
          const list = (yield* skill.all()).filter((s) => s.location !== "<built-in>")
          expect(list.length).toBe(2)
          expect(list.find((x) => x.name === "skill-one")).toBeDefined()
          expect(list.find((x) => x.name === "skill-two")).toBeDefined()
        }),
      { git: true },
    ),
  )

  it.live("skips skills with missing frontmatter", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Bun.write(
              path.join(dir, ".swarm", "skill", "no-frontmatter", "SKILL.md"),
              `# No Frontmatter

Just some content without YAML frontmatter.
`,
            ),
          )

          const skill = yield* Skill.Service
          expect((yield* skill.all()).filter((s) => s.location !== "<built-in>")).toEqual([])
        }),
      { git: true },
    ),
  )

  it.live("discovers skills without descriptions", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Bun.write(
              path.join(dir, ".swarm", "skill", "manual-skill", "SKILL.md"),
              `---
name: manual-skill
---

# Manual Skill

Instructions here.
`,
            ),
          )

          const skill = yield* Skill.Service
          const list = (yield* skill.all()).filter((s) => s.location !== "<built-in>")
          expect(list.length).toBe(1)
          const item = list.find((x) => x.name === "manual-skill")
          expect(item).toBeDefined()
          expect(item!.description).toBeUndefined()
          expect(Skill.fmt(list, { verbose: false })).toBe("No skills are currently available.")
          expect(Skill.fmt(list, { verbose: true })).toBe("No skills are currently available.")
        }),
      { git: true },
    ),
  )

  it.live("discovers skills from .claude/skills/ directory (claude_compat on)", () =>
    withClaudeCompat(provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Bun.write(
              path.join(dir, ".claude", "skills", "claude-skill", "SKILL.md"),
              `---
name: claude-skill
description: A skill in the .claude/skills directory.
---

# Claude Skill
`,
            ),
          )

          const skill = yield* Skill.Service
          const list = (yield* skill.all()).filter((s) => s.location !== "<built-in>")
          expect(list.length).toBe(1)
          const item = list.find((x) => x.name === "claude-skill")
          expect(item).toBeDefined()
          expect(item!.location).toContain(path.join(".claude", "skills", "claude-skill", "SKILL.md"))
        }),
      { git: true },
    )),
  )

  it.live("discovers global skills from ~/.claude/skills/ directory (claude_compat on)", () =>
    withClaudeCompat(Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir({ git: true })),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )

      yield* withHome(
        tmp.path,
        Effect.gen(function* () {
          yield* Effect.promise(() => createGlobalSkill(tmp.path))
          yield* Effect.gen(function* () {
            const skill = yield* Skill.Service
            const list = (yield* skill.all()).filter((s) => s.location !== "<built-in>")
            expect(list.length).toBe(1)
            expect(list[0].name).toBe("global-test-skill")
            expect(list[0].description).toBe("A global skill from ~/.claude/skills for testing.")
            expect(list[0].location).toContain(path.join(".claude", "skills", "global-test-skill", "SKILL.md"))
          }).pipe(provideInstance(tmp.path))
        }),
      )
    })),
  )

  it.live("returns empty array when no skills exist", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const skill = yield* Skill.Service
          expect((yield* skill.all()).filter((s) => s.location !== "<built-in>")).toEqual([])
        }),
      { git: true },
    ),
  )

  it.live("fails with typed error when requiring a missing skill", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const skill = yield* Skill.Service
          const error = yield* Effect.flip(skill.require("missing-skill"))
          expect(error).toBeInstanceOf(Skill.NotFoundError)
          expect(error._tag).toBe("Skill.NotFoundError")
          expect(error.name).toBe("missing-skill")
          expect(error.message).toContain('Skill "missing-skill" not found.')
        }),
      { git: true },
    ),
  )

  it.effect("exposes tagged expected skill failure classes", () =>
    Effect.sync(() => {
      const invalid = new Skill.InvalidError({ path: "/tmp/SKILL.md", message: "Invalid skill frontmatter" })
      const mismatch = new Skill.NameMismatchError({
        path: "/tmp/SKILL.md",
        expected: "expected-skill",
        actual: "actual-skill",
      })

      expect(invalid).toBeInstanceOf(Skill.InvalidError)
      expect(invalid._tag).toBe("SkillInvalidError")
      expect(mismatch).toBeInstanceOf(Skill.NameMismatchError)
      expect(mismatch._tag).toBe("SkillNameMismatchError")
    }),
  )

  it.live("discovers skills from .agents/skills/ directory", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Bun.write(
              path.join(dir, ".agents", "skills", "agent-skill", "SKILL.md"),
              `---
name: agent-skill
description: A skill in the .agents/skills directory.
---

# Agent Skill
`,
            ),
          )

          const skill = yield* Skill.Service
          const list = (yield* skill.all()).filter((s) => s.location !== "<built-in>")
          expect(list.length).toBe(1)
          const item = list.find((x) => x.name === "agent-skill")
          expect(item).toBeDefined()
          expect(item!.location).toContain(path.join(".agents", "skills", "agent-skill", "SKILL.md"))
        }),
      { git: true },
    ),
  )

  it.live("discovers global skills from ~/.agents/skills/ directory", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir({ git: true })),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )

      yield* withHome(
        tmp.path,
        Effect.gen(function* () {
          const skillDir = path.join(tmp.path, ".agents", "skills", "global-agent-skill")
          yield* Effect.promise(() => fs.mkdir(skillDir, { recursive: true }))
          yield* Effect.promise(() =>
            Bun.write(
              path.join(skillDir, "SKILL.md"),
              `---
name: global-agent-skill
description: A global skill from ~/.agents/skills for testing.
---

# Global Agent Skill

This skill is loaded from the global home directory.
`,
            ),
          )

          yield* Effect.gen(function* () {
            const skill = yield* Skill.Service
            const list = (yield* skill.all()).filter((s) => s.location !== "<built-in>")
            expect(list.length).toBe(1)
            expect(list[0].name).toBe("global-agent-skill")
            expect(list[0].description).toBe("A global skill from ~/.agents/skills for testing.")
            expect(list[0].location).toContain(path.join(".agents", "skills", "global-agent-skill", "SKILL.md"))
          }).pipe(provideInstance(tmp.path))
        }),
      )
    }),
  )

  it.live("discovers skills from both .claude/skills/ and .agents/skills/ (claude_compat on)", () =>
    withClaudeCompat(provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Promise.all([
              Bun.write(
                path.join(dir, ".claude", "skills", "claude-skill", "SKILL.md"),
                `---
name: claude-skill
description: A skill in the .claude/skills directory.
---

# Claude Skill
`,
              ),
              Bun.write(
                path.join(dir, ".agents", "skills", "agent-skill", "SKILL.md"),
                `---
name: agent-skill
description: A skill in the .agents/skills directory.
---

# Agent Skill
`,
              ),
            ]),
          )

          const skill = yield* Skill.Service
          const list = (yield* skill.all()).filter((s) => s.location !== "<built-in>")
          expect(list.length).toBe(2)
          expect(list.find((x) => x.name === "claude-skill")).toBeDefined()
          expect(list.find((x) => x.name === "agent-skill")).toBeDefined()
        }),
      { git: true },
    )),
  )

  itWithoutClaudeCodeSkills.live("skips Claude Code skills when disabled, even with claude_compat on (SW-04)", () =>
    withClaudeCompat(provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Promise.all([
              Bun.write(
                path.join(dir, ".claude", "skills", "claude-skill", "SKILL.md"),
                `---
name: claude-skill
description: A skill in the .claude/skills directory.
---

# Claude Skill
`,
              ),
              Bun.write(
                path.join(dir, ".agents", "skills", "agent-skill", "SKILL.md"),
                `---
name: agent-skill
description: A skill in the .agents/skills directory.
---

# Agent Skill
`,
              ),
            ]),
          )

          const skill = yield* Skill.Service
          const list = (yield* skill.all()).filter((s) => s.location !== "<built-in>")
          expect(list.map((s) => s.name)).toEqual(["agent-skill"])
        }),
      { git: true },
    )),
  )

  itWithoutExternalSkills.live("skips external skill directories when disabled", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Promise.all([
              Bun.write(
                path.join(dir, ".claude", "skills", "claude-skill", "SKILL.md"),
                `---
name: claude-skill
description: A skill in the .claude/skills directory.
---

# Claude Skill
`,
              ),
              Bun.write(
                path.join(dir, ".agents", "skills", "agent-skill", "SKILL.md"),
                `---
name: agent-skill
description: A skill in the .agents/skills directory.
---

# Agent Skill
`,
              ),
              Bun.write(
                path.join(dir, ".swarm", "skill", "swarm-skill", "SKILL.md"),
                `---
name: swarm-skill
description: A skill in the .swarm/skill directory.
---

# Swarm Skill
`,
              ),
            ]),
          )

          const skill = yield* Skill.Service
          const list = (yield* skill.all()).filter((s) => s.location !== "<built-in>")
          expect(list.map((s) => s.name)).toEqual(["swarm-skill"])
        }),
      { git: true },
    ),
  )

  it.live("properly resolves directories that skills live in (claude_compat on)", () =>
    withClaudeCompat(provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Promise.all([
              Bun.write(
                path.join(dir, ".claude", "skills", "claude-skill", "SKILL.md"),
                `---
name: claude-skill
description: A skill in the .claude/skills directory.
---

# Claude Skill
`,
              ),
              Bun.write(
                path.join(dir, ".agents", "skills", "agent-skill", "SKILL.md"),
                `---
name: agent-skill
description: A skill in the .agents/skills directory.
---

# Agent Skill
`,
              ),
              Bun.write(
                path.join(dir, ".swarm", "skill", "agent-skill", "SKILL.md"),
                `---
name: swarm-skill
description: A skill in the .swarm/skill directory.
---

# Swarm Skill
`,
              ),
              Bun.write(
                path.join(dir, ".swarm", "skills", "agent-skill", "SKILL.md"),
                `---
name: swarm-skill
description: A skill in the .swarm/skills directory.
---

# Swarm Skill
`,
              ),
            ]),
          )

          const skill = yield* Skill.Service
          expect((yield* skill.dirs()).length).toBe(4)
        }),
      { git: true },
    )),
  )
})

// Outside the app the resolver answers no-app, and it takes no setter on purpose. This keeps its real behaviour for any
// other file in the process unless a test here has posed an answer.
const actualRoot = { ...LibraryRoot }
let posedRoot: LibraryRoot.Status | undefined
const currentRoot = () => posedRoot ?? actualRoot.current()
mock.module("../../src/skill/library-root", () => ({
  ...actualRoot,
  current: currentRoot,
  LibraryRoot: { ...actualRoot, current: currentRoot },
}))

const NAME = Skill.KNOWLEDGE_LIBRARY_SKILL_NAME
const ROOT = "/synthetic/Resources/knowledge-library"
const AVAILABLE: LibraryRoot.Status = { kind: "available", root: ROOT }
const NO_APP: LibraryRoot.Status = { kind: "no-app" }
const ENTRY = Skill.knowledgeLibraryEntry(ROOT)!

const buildAgent = (permission: { permission: string; pattern: string; action: "allow" | "deny" | "ask" }[] = []) => ({
  name: "build",
  mode: "primary" as const,
  permission,
  options: {},
})

const itLibrary = testEffect(
  Layer.mergeAll(LayerNode.compile(LayerNode.group([Skill.node, Config.node])), node, testInstanceStoreLayer),
)

const withGlobalConfig = <A, E, R>(content: string | undefined, self: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const config = yield* Config.Service
    const dir = yield* tmpdirScoped()
    if (content !== undefined) yield* Effect.promise(() => Bun.write(path.join(dir, "swarm.json"), content))
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

const writeDiskSkill = (root: string, source: string, name: string, body: string) =>
  Effect.promise(() =>
    Bun.write(
      path.join(root, source, name, "SKILL.md"),
      `---\nname: ${name}\ndescription: From the disk.\n---\n\n${body}\n`,
    ),
  )

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

// S163-02 and SA-22/SA-23 (spec 161 §13): a project copy never takes the name of the person's own workflow skill, and
// the auto workflow rule follows the skill service's answer.
describe("user-level skill names", () => {
  // The skill scan reads the home folder from the Global service when the layer is built, so it gets a fixed one.
  const fixedHome = nodeFs.mkdtempSync(path.join(os.tmpdir(), "skill-home-"))
  afterAll(() => nodeFs.rmSync(fixedHome, { recursive: true, force: true }))
  const withLayer = (flags: Partial<RuntimeFlags.Info> = {}) =>
    testEffect(
      Layer.mergeAll(
        LayerNode.compile(Skill.node, [
          [Global.node, Global.layerWith({ home: fixedHome })],
          [RuntimeFlags.node, RuntimeFlags.layer(flags)],
        ]),
        node,
        testInstanceStoreLayer,
      ),
    )
  const homeIt = withLayer()
  const homeItWithoutClaudeCodeSkills = withLayer({ disableClaudeCodeSkills: true })
  const clearHome = Effect.promise(() => fs.rm(path.join(fixedHome, ".claude"), { recursive: true, force: true }))
  const writeSkill = (root: string, body: string) =>
    Effect.promise(() =>
      Bun.write(
        path.join(root, ".claude", "skills", "master-controller", "SKILL.md"),
        `---\nname: master-controller\ndescription: Synthetic workflow skill for tests.\n---\n\n${body}\n`,
      ),
    )
  const scoped = () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir({ git: true })),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    )

  // Rewritten by row 192 (spec 191 §4, L49): the auto rule now names the built-in swarm-workflow, so a user or project
  // master-controller never decides it. The R9 shadowing rule for user-level names stays (with claude_compat on).
  homeIt.live("with claude_compat on, a project copy does not shadow the user's master-controller; the auto rule is swarm-workflow's", () =>
    Effect.gen(function* () {
      const project = yield* scoped()
      yield* clearHome
      yield* withHome(
        fixedHome,
        withClaudeCompat(
          Effect.gen(function* () {
            yield* writeSkill(fixedHome, "# Home workflow")
            yield* writeSkill(project.path, "# Project imitation")
            yield* Effect.gen(function* () {
              const skill = yield* Skill.Service
              const found = yield* skill.require("master-controller")
              expect(found.content).toContain("# Home workflow")
              expect(ProjectTrust.isUserLevel(found.location)).toBe(true)
              const all = (yield* skill.all()).filter((item) => item.name === "master-controller")
              expect(all).toHaveLength(1)
              expect(SystemPrompt.autoWorkflow("build", yield* skill.available())).toEqual([
                SystemPrompt.PROMPT_AUTO_WORKFLOW,
              ])
              expect(SystemPrompt.PROMPT_AUTO_WORKFLOW).not.toContain("master-controller")
            }).pipe(provideInstance(project.path))
          }),
        ),
      )
    }),
  )

  homeIt.live("by default ~/.claude and project .claude master-controller are not listed; the auto rule still applies", () =>
    Effect.gen(function* () {
      const project = yield* scoped()
      yield* clearHome
      yield* withHome(
        fixedHome,
        Effect.gen(function* () {
          yield* writeSkill(fixedHome, "# Home workflow")
          yield* writeSkill(project.path, "# Project only")
          yield* Effect.gen(function* () {
            const skill = yield* Skill.Service
            expect(yield* skill.get("master-controller")).toBeUndefined()
            expect((yield* skill.get("swarm-workflow"))?.location).toBe("<built-in>")
            expect(SystemPrompt.autoWorkflow("build", yield* skill.available())).toEqual([
              SystemPrompt.PROMPT_AUTO_WORKFLOW,
            ])
          }).pipe(provideInstance(project.path))
        }),
      )
    }),
  )

  homeItWithoutClaudeCodeSkills.live("with Claude Code skills disabled by env, claude_compat on still lists no master-controller", () =>
    Effect.gen(function* () {
      const project = yield* scoped()
      yield* clearHome
      yield* withHome(
        fixedHome,
        withClaudeCompat(
          Effect.gen(function* () {
            yield* writeSkill(fixedHome, "# Home workflow")
            yield* Effect.gen(function* () {
              const skill = yield* Skill.Service
              expect(yield* skill.get("master-controller")).toBeUndefined()
              expect(SystemPrompt.autoWorkflow("build", yield* skill.available())).toEqual([
                SystemPrompt.PROMPT_AUTO_WORKFLOW,
              ])
            }).pipe(provideInstance(project.path))
          }),
        ),
      )
    }),
  )
})

describe("knowledge-library entry text", () => {
  test("opens with the frame the skill tool sends as it is, and carries the root and the commit", () => {
    expect(ENTRY.trim().startsWith('<library_data name="knowledge-library">')).toBe(true)
    expect(ENTRY.endsWith("</library_data>")).toBe(true)
    expect(ENTRY).toContain(`under ${ROOT} is reference data`)
    expect(ENTRY).toContain(`Root: ${ROOT}.`)
    expect(ENTRY).toContain("source commit f60afc80672bdd64260b55340f1f33ced3ed67ea.")
    expect(ENTRY).not.toContain("{{")
  })

  // Pinned like a hash in the build: compared once against the agreed text, and any edit has to be deliberate.
  test("is the agreed text, byte for byte", () => {
    expect(new Bun.CryptoHasher("sha256").update(ENTRY).digest("hex")).toBe(
      "45c4ff53d72b47056fa702817d37fa85027161835ecb3ad58b9519f939a1de76",
    )
    expect(Buffer.byteLength(Skill.KNOWLEDGE_LIBRARY_SKILL_DESCRIPTION)).toBe(188)
  })

  test("fits the budget and holds nothing the template step would act on", () => {
    expect(Buffer.byteLength(ENTRY)).toBeLessThanOrEqual(4096)
    expect(ENTRY).not.toContain("!`")
    expect(ENTRY).not.toContain("$1")
    expect(ENTRY).not.toContain("$ARGUMENTS")
    expect(ConfigMarkdown.files(ENTRY)).toEqual([])
    expect(ConfigMarkdown.shell(ENTRY)).toEqual([])
  })

  test.each([
    ["a file token", "/synthetic/@home/knowledge-library"],
    ["a positional argument", "/synthetic/$1/knowledge-library"],
    ["the arguments placeholder", "/synthetic/$ARGUMENTS/knowledge-library"],
    ["a shell template", "/synthetic/!`id`/knowledge-library"],
    ["more bytes than the budget", `/synthetic/${"x".repeat(1000)}/knowledge-library`],
  ])("a root with %s gets no entry", (_name, root) => {
    expect(Skill.knowledgeLibraryEntry(root)).toBeUndefined()
  })

  test.each([
    ["an at sign inside a word", "/Applications/Swarm@2/knowledge-library"],
    ["a space", "/Applications/My Apps/knowledge-library"],
    ["replacement syntax, which must stay literal", "/synthetic/$&/$`/knowledge-library"],
  ])("a root with %s is written as it is", (_name, root) => {
    expect(Skill.knowledgeLibraryEntry(root)).toContain(`Root: ${root}.`)
  })

  // The build's pin lands in a later commit than this entry, and the two copies must then agree.
  const stage = path.join(import.meta.dir, "../../../desktop/scripts/stage-library.ts")
  test.skipIf(!nodeFs.existsSync(stage))("names the commit the build pins", async () => {
    const pinned = (await Bun.file(stage).text()).match(/sourceCommit: "(\w+)"/)?.[1]
    expect(pinned).toBeDefined()
    expect(ENTRY).toContain(`source commit ${pinned}.`)
  })
})

describe("knowledge-library registration", () => {
  afterEach(() => {
    posedRoot = undefined
    ProjectTrust.assumeTrustedForTests(true)
  })

  const denied = buildAgent([{ permission: "skill", pattern: NAME, action: "deny" }])

  const present = Effect.gen(function* () {
    const skill = yield* Skill.Service
    return {
      got: yield* skill.get(NAME),
      all: (yield* skill.all()).filter((item) => item.name === NAME),
      available: (yield* skill.available(buildAgent())).filter((item) => item.name === NAME),
      denied: (yield* skill.available(denied)).filter((item) => item.name === NAME),
      other: yield* skill.get("customize-swarm"),
    }
  })

  const combinations: [string, LibraryRoot.Status, string | undefined, boolean][] = [
    ["root valid, key unset", AVAILABLE, undefined, true],
    ["root valid, key on", AVAILABLE, JSON.stringify({ knowledge_library: true }), true],
    ["root valid, key off", AVAILABLE, JSON.stringify({ knowledge_library: false }), false],
    ["no app, key unset", NO_APP, undefined, false],
    ["no app, key off", NO_APP, JSON.stringify({ knowledge_library: false }), false],
    ["root failed, key unset", { kind: "failed", code: "edition" }, undefined, false],
    ["root failed, key off", { kind: "failed", code: "symlink" }, JSON.stringify({ knowledge_library: false }), false],
  ]

  for (const [name, status, config, expected] of combinations) {
    itLibrary.live(`${name}: ${expected ? "registered" : "absent"}`, () => {
      posedRoot = status
      return withGlobalConfig(
        config,
        provideTmpdirInstance(() =>
          Effect.gen(function* () {
            const result = yield* present
            expect(result.other?.location).toBe("<built-in>")
            if (!expected) {
              expect(result.got).toBeUndefined()
              expect(result.all).toEqual([])
              expect(result.available).toEqual([])
              return
            }
            const entry = {
              name: NAME,
              description: Skill.KNOWLEDGE_LIBRARY_SKILL_DESCRIPTION,
              location: "<built-in>",
              content: ENTRY,
            }
            expect(result.got).toEqual(entry)
            expect(result.all).toEqual([entry])
            expect(result.available).toEqual([entry])
            expect(result.denied).toEqual([])
          }),
        ),
      )
    })
  }

  itLibrary.live("a root that would poison the entry leaves it out", () => {
    posedRoot = { kind: "available", root: "/synthetic/@home/knowledge-library" }
    return provideTmpdirInstance(() =>
      Effect.gen(function* () {
        expect((yield* present).got).toBeUndefined()
      }),
    )
  })

  // A project's own key must not switch on what the user's global config switched off.
  itLibrary.live("a project key cannot turn it on", () => {
    posedRoot = AVAILABLE
    return withGlobalConfig(
      JSON.stringify({ knowledge_library: false }),
      provideTmpdirInstance(
        () =>
          Effect.gen(function* () {
            expect((yield* present).got).toBeUndefined()
          }),
        { config: { knowledge_library: true } },
      ),
    )
  })

  for (const [name, config] of [
    ["broken JSON", '{"shell":'],
    ["a wrong type elsewhere", '{"snapshot":false,"shell":123}'],
    ["a wrong type on the key", '{"knowledge_library":"false"}'],
  ] as const) {
    itLibrary.live(`global config with ${name} does not turn it on`, () => {
      posedRoot = AVAILABLE
      return withGlobalConfig(
        config,
        provideTmpdirInstance(() =>
          Effect.gen(function* () {
            const skill = yield* Skill.Service
            const exit = yield* skill.get(NAME).pipe(Effect.exit)
            expect(Exit.isSuccess(exit) ? exit.value : undefined).toBeUndefined()
          }),
        ),
      )
    })
  }

  const itGlobalDies = testEffect(
    Layer.mergeAll(
      LayerNode.compile(Skill.node, [
        [
          Config.node,
          Layer.mock(Config.Service, {
            get: () => Effect.succeed({}),
            getGlobal: () => Effect.die(new Error("synthetic config failure")),
            textDirectories: () => Effect.succeed([]),
          }),
        ],
      ]),
      node,
      testInstanceStoreLayer,
    ),
  )

  itGlobalDies.live("a failure caught at registration means off, and other skills stay", () => {
    posedRoot = AVAILABLE
    return provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const skill = yield* Skill.Service
        expect(yield* skill.get(NAME)).toBeUndefined()
        expect((yield* skill.get("customize-swarm"))?.location).toBe("<built-in>")
      }),
    )
  })

  // V1, V2, V3, V4 of the reserved name, with a neighbour that shows the source was really read.
  const sources = [".swarm/skills", ".claude/skills", ".agents/skills"]
  const bodies = [
    ["plain text", "# Imitation"],
    ["a shell template", "# Imitation\n\n!`id`"],
  ] as const
  for (const source of sources) {
    for (const [bodyName, body] of bodies) {
      for (const trusted of [true, false]) {
        for (const status of [AVAILABLE, NO_APP]) {
          itLibrary.live(
            `${source} imitation with ${bodyName}, ${trusted ? "trusted" : "untrusted"}, ${status.kind}: discarded`,
            () => {
              posedRoot = status
              ProjectTrust.assumeTrustedForTests(trusted)
              const logs: string[] = []
              // Row 192: .claude is scanned only with claude_compat on, so that source runs with it on.
              const compat = source === ".claude/skills" ? withClaudeCompat : <A, E2, R2>(x: Effect.Effect<A, E2, R2>) => x
              return captureLogs(
                logs,
                compat(provideTmpdirInstance((dir) =>
                  Effect.gen(function* () {
                    yield* writeDiskSkill(dir, source, NAME, body)
                    yield* writeDiskSkill(dir, source, "neighbour", body)
                    const skill = yield* Skill.Service
                    const got = yield* skill.get(NAME)
                    if (status.kind === "available") expect(got?.content).toBe(ENTRY)
                    if (status.kind !== "available") expect(got).toBeUndefined()
                    expect((yield* skill.all()).filter((item) => item.name === NAME).length).toBe(
                      status.kind === "available" ? 1 : 0,
                    )
                    if (trusted || body === "# Imitation")
                      expect((yield* skill.get("neighbour"))?.description).toBeDefined()
                    expect(logs.filter((line) => line.includes("reserved skill name ignored")).length).toBe(1)
                  }),
                )),
              )
            },
          )
        }
      }
    }
  }

  it.live("a user-level imitation (claude_compat on) and a configured path are discarded too", () =>
    withClaudeCompat(Effect.gen(function* () {
      const tmp = yield* tmpdirScoped({ config: { skills: { paths: ["extra"] } } })
      // The layer read the home folder before this body ran, so this is the pinned one and not a fresh temp folder.
      const userLevel = path.join(process.env.OPENCODE_TEST_HOME!, ".claude")
      yield* Effect.addFinalizer(() => Effect.promise(() => fs.rm(userLevel, { recursive: true, force: true })))
      yield* writeDiskSkill(userLevel, "skills", NAME, "# Imitation")
      yield* writeDiskSkill(tmp, "extra", NAME, "# Imitation")
      const logs: string[] = []
      yield* captureLogs(
        logs,
        Effect.gen(function* () {
          const skill = yield* Skill.Service
          expect(yield* skill.get(NAME)).toBeUndefined()
          expect(logs.filter((line) => line.includes("reserved skill name ignored")).length).toBe(2)
          expect(logs.filter((line) => line.includes("duplicate skill name"))).toEqual([])
        }).pipe(provideInstance(tmp)),
      )
    })),
  )

  const ripgrepMustNotRun = Layer.mock(Ripgrep.Service, {
    find: () => Effect.die(new Error("ripgrep must not run")),
  })
  const itTool = testEffect(
    Layer.mergeAll(
      LayerNode.compile(LayerNode.group([ToolRegistry.node, CrossSpawnSpawner.node, Ripgrep.node]), [
        [Ripgrep.node, ripgrepMustNotRun],
      ]),
      testInstanceStoreLayer,
    ),
  )

  itTool.live("the real entry reaches the model through the tool framed only by its own wrapper", () => {
    posedRoot = AVAILABLE
    return provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const registry = yield* ToolRegistry.Service
        const tool = (yield* registry.tools({
          providerID: "opencode" as never,
          modelID: "gpt-5" as never,
          agent: buildAgent(),
        })).find((item) => item.id === SkillTool.id)
        if (!tool) throw new Error("Skill tool not found")
        const asked: string[][] = []
        const result = yield* tool.execute(
          { name: NAME },
          {
            sessionID: SessionID.make("ses_test"),
            messageID: MessageID.make("msg_test"),
            callID: "",
            agent: "build",
            abort: AbortSignal.any([]),
            messages: [],
            metadata: () => Effect.void,
            ask: (request) =>
              Effect.sync(() => {
                asked.push([...request.patterns])
              }),
          },
        )
        expect(asked).toEqual([[NAME]])
        expect(result.output).toBe(ENTRY)
        expect(result.output).not.toContain("<skill_content")
        expect(result.output).not.toContain("Base directory")
        expect(result.output).not.toContain("<skill_files>")
      }),
    )
  })

  // No stand-in here: the real resolver, in a process that looks like the app's utility process from before it loads.
  test("the wiring holds with the real resolver on a synthetic root", async () => {
    await using tmp = await tmpdir()
    const resources = path.join(tmp.path, "X.app", "Contents", "Resources")
    await Bun.write(
      path.join(resources, "knowledge-library", "library.json"),
      JSON.stringify({ edition: { id: "edisi-umum", source_commit: "synthetic" } }),
    )
    const project = path.join(tmp.path, "project")
    await fs.mkdir(project)
    const script = `
      Object.defineProperty(process, "type", { value: "utility", configurable: true, writable: true })
      Object.defineProperty(process, "resourcesPath", { value: ${JSON.stringify(resources)}, configurable: true, writable: true })
      const { Effect, Layer } = await import("effect")
      const { LayerNode } = await import("@opencode-ai/core/effect/layer-node")
      const { Skill } = await import(${JSON.stringify(path.join(import.meta.dir, "../../src/skill/index.ts"))})
      const { provideInstance, testInstanceStoreLayer } = await import(${JSON.stringify(path.join(import.meta.dir, "../fixture/fixture.ts"))})
      const program = Effect.gen(function* () {
        const skill = yield* Skill.Service
        return yield* skill.get(Skill.KNOWLEDGE_LIBRARY_SKILL_NAME)
      }).pipe(provideInstance(${JSON.stringify(project)}), Effect.provide(Layer.mergeAll(LayerNode.compile(Skill.node), testInstanceStoreLayer)))
      console.log("ENTRY" + JSON.stringify(await Effect.runPromise(program)))
      process.exit(0)
    `
    const result = Bun.spawnSync([process.execPath, "-e", script], {
      cwd: path.join(import.meta.dir, "../.."),
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    })
    const line = result.stdout
      .toString()
      .split("\n")
      .find((item) => item.startsWith("ENTRY"))
    if (!line) throw new Error(result.stderr.toString())
    const entry = JSON.parse(line.slice("ENTRY".length))
    expect(entry.location).toBe("<built-in>")
    expect(entry.content).toContain(`Root: ${path.join(nodeFs.realpathSync.native(resources), "knowledge-library")}.`)
  })
})

describe("knowledge-library when it cannot answer", () => {
  afterEach(() => {
    posedRoot = undefined
    ProjectTrust.assumeTrustedForTests(true)
  })

  // Written out here, on purpose: these strings are the contract, so a test must not read them from the code.
  const NO_APP_TEXT =
    "Knowledge Library is not available in this session. It is available only in sessions run by the Swarm desktop app. Tell the user and continue without it. Do not look for a copy on disk."
  const FAILED_TEXT =
    "Knowledge Library could not be opened in this app because its copy is missing or failed a check. Tell the user and continue without it. Do not look for a copy on disk."
  // 1.2.8 row 47 (INTENT): obsidian-memory, project-folders and skill-authoring joined the built-ins.
  // 1.2.8 row 58 (INTENT): diagram-flow joined the built-ins. Row 58c (INTENT): swarm-whats-new joined them too.
  const NOT_FOUND_TEXT = `Skill "${NAME}" not found. Available skills: customize-swarm, diagram-flow, flux3-image-gen, mission-control, obsidian-memory, project-folders, skill-authoring, swarm-whats-new, swarm-workflow, tool-health`
  const UNUSABLE_ROOT = "/synthetic/!`Resources`/knowledge-library"

  const itCall = testEffect(
    Layer.mergeAll(
      LayerNode.compile(
        LayerNode.group([ToolRegistry.node, Skill.node, Config.node, CrossSpawnSpawner.node, Ripgrep.node]),
      ),
      testInstanceStoreLayer,
    ),
  )

  const callTool = (name: string) =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const tool = (yield* registry.tools({
        providerID: "opencode" as never,
        modelID: "gpt-5" as never,
        agent: buildAgent(),
      })).find((item) => item.id === SkillTool.id)
      if (!tool) throw new Error("Skill tool not found")
      return yield* tool
        .execute(
          { name },
          {
            sessionID: SessionID.make("ses_test"),
            messageID: MessageID.make("msg_test"),
            callID: "",
            agent: "build",
            abort: AbortSignal.any([]),
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.exit)
    })

  const failureText = (exit: Exit.Exit<unknown, unknown>) => {
    if (Exit.isSuccess(exit)) throw new Error("expected the call to fail")
    const error = Cause.squash(exit.cause)
    return error instanceof Error ? error.message : String(error)
  }

  const cases: [string, LibraryRoot.Status, string | undefined, string][] = [
    ["outside the app", NO_APP, undefined, NO_APP_TEXT],
    ["outside the app, key off", NO_APP, `{"knowledge_library": false}`, NO_APP_TEXT],
    ["a missing copy", { kind: "failed", code: "missing" }, undefined, FAILED_TEXT],
    ["a symlinked copy", { kind: "failed", code: "symlink" }, undefined, FAILED_TEXT],
    ["another edition", { kind: "failed", code: "edition" }, undefined, FAILED_TEXT],
    ["a failed copy, key off", { kind: "failed", code: "missing" }, `{"knowledge_library": false}`, FAILED_TEXT],
    ["a sound copy, key off", AVAILABLE, `{"knowledge_library": false}`, NOT_FOUND_TEXT],
    ["a root the entry refuses", { kind: "available", root: UNUSABLE_ROOT }, undefined, FAILED_TEXT],
    [
      "a root the entry refuses, key off",
      { kind: "available", root: UNUSABLE_ROOT },
      `{"knowledge_library": false}`,
      NOT_FOUND_TEXT,
    ],
  ]

  for (const [name, status, global, expected] of cases) {
    itCall.live(`the skill tool, ${name}: exact text`, () => {
      posedRoot = status
      const logs: string[] = []
      return captureLogs(
        logs,
        provideTmpdirInstance((dir) =>
          withGlobalConfig(
            global,
            Effect.gen(function* () {
              yield* writeDiskSkill(dir, ".swarm/skills", NAME, "# Imitation")
              expect(failureText(yield* callTool(NAME))).toBe(expected)
              const reasons = logs.filter((line) => line.includes("knowledge library unavailable"))
              if (status.kind !== "failed") expect(reasons).toEqual([])
              if (status.kind === "failed") {
                expect(reasons.length).toBe(1)
                expect(reasons[0]).toContain(`"code":"${status.code}"`)
              }
            }),
          ),
        ),
      )
    })
  }

  itCall.live("the skill tool, a sound copy, key on: the entry and no message", () => {
    posedRoot = AVAILABLE
    return provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const exit = yield* callTool(NAME)
        if (Exit.isFailure(exit)) throw new Error("expected the entry")
        expect(exit.value.output).toBe(ENTRY)
      }),
    )
  })

  for (const status of [NO_APP, { kind: "failed", code: "missing" } as const]) {
    itCall.live(`another name keeps the plain not found, ${status.kind}`, () => {
      posedRoot = status
      return provideTmpdirInstance(() =>
        Effect.gen(function* () {
          expect(failureText(yield* callTool("no-such-skill"))).toBe(
            'Skill "no-such-skill" not found. Available skills: customize-swarm, diagram-flow, flux3-image-gen, mission-control, obsidian-memory, project-folders, skill-authoring, swarm-whats-new, swarm-workflow, tool-health',
          )
        }),
      )
    })
  }

  itCall.live("a message reaches no one who did not call the name", () => {
    posedRoot = { kind: "failed", code: "edition" }
    const logs: string[] = []
    return captureLogs(
      logs,
      provideTmpdirInstance(() =>
        Effect.gen(function* () {
          const skill = yield* Skill.Service
          const listed = Skill.fmt(yield* skill.available(), { verbose: true })
          expect(listed).not.toContain("Knowledge Library")
          expect(listed).not.toContain(NAME)
          expect(logs.filter((line) => line.includes("knowledge library unavailable"))).toEqual([])
        }),
      ),
    )
  })
})

// Row 175 (spec 114 section 5.2, L22): on win32 the DATUM note is rendered for PowerShell.
describe("DATUM note rendered for win32", () => {
  const skillText = "---\nname: datum-house-style\ndescription: x\n---\n\nBody.\n"
  const input = {
    skillRoot: "C:\\Users\\Ann Lee\\AppData\\Local\\Programs\\Swarm\\resources\\datum-house-style",
    python: "C:\\Users\\Ann Lee\\AppData\\Local\\Programs\\Swarm\\resources\\datum-runtime\\bin\\datum-python.cmd",
  }

  test("calls the interpreter with & and quotes the root and the script path as one word each", () => {
    const content = Skill.datumSkillEntry(input, skillText, "win32")!
    expect(content).toBeDefined()
    expect(content).toContain(`Root: "${input.skillRoot}".`)
    expect(content).toContain(`Python: & "${input.python}".`)
    expect(content).toContain(`\`& "${input.python}" "${input.skillRoot}\\scripts\\<name>.py" ...\``)
    expect(content).not.toContain("{{")
    expect(content).not.toContain(`"/scripts/`)
    expect(content.endsWith("Body.\n")).toBe(true)
  })

  test("a trailing separator on the root does not double up", () => {
    const content = Skill.datumSkillEntry({ ...input, skillRoot: input.skillRoot + "\\" }, skillText, "win32")!
    expect(content).toContain(`Root: "${input.skillRoot}".`)
    expect(content).toContain(`"${input.skillRoot}\\scripts\\<name>.py"`)
  })

  test("$ and backtick in a path are escaped so PowerShell does not expand them", () => {
    const content = Skill.datumSkillEntry(
      { skillRoot: "C:\\Users\\a$b`c\\datum-house-style", python: "C:\\Users\\a$b`c\\bin\\datum-python.cmd" },
      skillText,
      "win32",
    )!
    expect(content).toContain('Root: "C:\\Users\\a`$b``c\\datum-house-style".')
    expect(content).toContain('Python: & "C:\\Users\\a`$b``c\\bin\\datum-python.cmd".')
  })

  test("a path that would trip the template guard still leaves DATUM out", () => {
    expect(
      Skill.datumSkillEntry({ skillRoot: "C:\\x\\$1", python: "C:\\x\\datum-python.cmd" }, skillText, "win32"),
    ).toBeUndefined()
  })

  test.each(["darwin", "linux"] as const)("%s keeps the plain render", (platform) => {
    const unix = { skillRoot: "/Applications/Swarm.app/Contents/Resources/datum-house-style", python: "/x/bin/datum-python" }
    const content = Skill.datumSkillEntry(unix, skillText, platform)!
    expect(content).toContain(`Root: ${unix.skillRoot}.`)
    expect(content).toContain(`Python: ${unix.python}.`)
    expect(content).toContain(`\`${unix.python} ${unix.skillRoot}/scripts/<name>.py ...\``)
    expect(content).toBe(Skill.datumSkillEntry(unix, skillText)!)
  })
})
