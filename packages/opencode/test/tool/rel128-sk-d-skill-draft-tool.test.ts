// 1.2.8 row 40d, AC-SKd2 (N8-412, 01b section 6, SR8-06): the skill_draft tool. Red at BASE e1f9673772: there is no
// skill_draft tool, so the module import fails and the registry has no such id. Synthetic inputs only; HOME is a mkdtemp
// folder and os.homedir is stubbed to it for the whole file.
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Global } from "@opencode-ai/core/global"
import { Skill } from "../../src/skill"
import { ToolRegistry } from "@/tool/registry"
import * as Truncate from "../../src/tool/truncate"
import { Agent } from "@/agent/agent"
import { Session } from "@/session/session"
import { Config } from "@/config/config"
import { Permission } from "@/permission"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import type { Tool } from "@/tool/tool"
import { SessionID, MessageID } from "../../src/session/schema"
import { disposeAllInstances, provideTmpdirInstance, testInstanceStoreLayer } from "../fixture/fixture"
import { TestConfig } from "../fixture/config"
import { testEffect } from "../lib/effect"

let home = ""
let restore: (() => void) | undefined
beforeAll(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "r40d-"))
  const spy = spyOn(os, "homedir").mockReturnValue(home)
  restore = () => spy.mockRestore()
})
afterAll(async () => {
  restore?.()
  await fs.rm(home, { recursive: true, force: true })
})
afterEach(async () => {
  await disposeAllInstances()
})

// At BASE the module does not exist: every case below then fails on its own line instead of the file failing to load.
const draftModule = () => import("../../src/tool/skill_draft").catch(() => undefined)

const it = testEffect(
  Layer.mergeAll(LayerNode.compile(Skill.node), LayerNode.compile(CrossSpawnSpawner.node), testInstanceStoreLayer),
)

const RESULT = (name: string, scope: string) =>
  `Draft "${name}" saved for the person's approval in Settings > Skills (${scope}). It is not loaded or offered until the person approves it. Tell the person it is waiting.`
const FULL =
  "SKILL_DRAFTS_FULL: 20 drafts are already waiting in this scope; ask the person to approve or discard some first."

const skillText = (name: string, body = "Use the synthetic steps.") =>
  `---\nname: ${name}\ndescription: A synthetic draft skill for tests.\n---\n\n${body}\n`

// Message builders in the shape `readUntrustedInput` reads (as rel128-mem-a's SEC06 cases).
const toolPart = (name: string, input: Record<string, unknown>, metadata: Record<string, unknown> = {}) => ({
  info: { role: "assistant" },
  parts: [{ type: "tool", tool: name, state: { status: "completed", input, output: "", metadata } }],
})
const taskPart = (sessionId: string) => toolPart("task", { prompt: "look it up" }, { sessionId })
const children: Record<string, unknown[]> = {
  ses_web: [toolPart("webfetch", { url: "https://example.com" })],
  ses_local: [toolPart("read", { filePath: "a.ts" })],
  ses_mid: [taskPart("ses_web")],
}

let asked = 0
const ctx = (messages: unknown[] = []) =>
  ({
    sessionID: SessionID.make("ses_r40d"),
    messageID: MessageID.make("msg_r40d"),
    callID: "",
    agent: "build",
    abort: AbortSignal.any([]),
    messages,
    metadata: () => Effect.void,
    ask: () => Effect.sync(() => void asked++),
    extra: {},
  }) as unknown as Tool.Context

const build = Effect.gen(function* () {
  const mod = yield* Effect.promise(draftModule)
  if (!mod) throw new Error("skill_draft tool does not exist (src/tool/skill_draft.ts)")
  const sessions = Session.Service.of({
    messages: ({ sessionID }: { sessionID: string }) =>
      children[sessionID] ? Effect.succeed(children[sessionID]) : Effect.fail(new Error("not found")),
  } as unknown as Session.Interface)
  const info = yield* mod.SkillDraftTool.pipe(
    Effect.provideService(Session.Service, sessions),
    Effect.provideService(
      Truncate.Service,
      Truncate.Service.of({
        output: (text: string) => Effect.succeed({ content: text, truncated: false }),
      } as unknown as Truncate.Interface),
    ),
    Effect.provideService(
      Agent.Service,
      Agent.Service.of({ get: () => Effect.succeed(undefined) } as unknown as Agent.Interface),
    ),
  )
  return yield* info.init()
})

const exists = (file: string) =>
  fs.lstat(file).then(
    () => true,
    () => false,
  )
const readJson = async (file: string) => JSON.parse(await fs.readFile(file, "utf8"))

describe("AC-SKd2 skill_draft writes drafts only", () => {
  it.live("a project draft lands in .swarm/skill-drafts/<name>/ with draft.json, never under skills/, no prompt", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        asked = 0
        const tool = yield* build
        const result = yield* tool.execute({ name: "alpha-steps", scope: "project", content: skillText("alpha-steps") }, ctx())
        expect(result.metadata.refused).toBeUndefined()
        expect(result.output).toBe(RESULT("alpha-steps", "project"))
        const folder = path.join(dir, ".swarm", "skill-drafts", "alpha-steps")
        expect(yield* Effect.promise(() => fs.readFile(path.join(folder, "SKILL.md"), "utf8"))).toBe(
          skillText("alpha-steps"),
        )
        const record = yield* Effect.promise(() => readJson(path.join(folder, "draft.json")))
        expect(record).toMatchObject({ sessionID: "ses_r40d", untrusted: false, runsCommands: false })
        expect(typeof record.time).toBe("number")
        expect(yield* Effect.promise(() => fs.readFile(path.join(dir, ".swarm", "skill-drafts", ".gitignore"), "utf8"))).toBe(
          "*\n",
        )
        expect(yield* Effect.promise(() => exists(path.join(dir, ".swarm", "skills")))).toBe(false)
        expect(yield* Effect.promise(() => exists(path.join(dir, ".swarm", "skill")))).toBe(false)
        expect(asked).toBe(0)
        // The drafts root is one of the folders the skill-folder guard knows (RA-17).
        const folders = yield* (yield* Skill.Service).folders()
        expect(folders).toContain(path.join(dir, ".swarm", "skill-drafts"))
      }),
    ),
  )

  it.live("a global draft lands in <data>/skill-drafts/<name>/", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const tool = yield* build
        const name = "r40d-global-draft"
        const folder = path.join(Global.Path.data, "skill-drafts", name)
        yield* Effect.addFinalizer(() => Effect.promise(() => fs.rm(folder, { recursive: true, force: true })))
        const result = yield* tool.execute({ name, scope: "global", content: skillText(name) }, ctx())
        expect(result.output).toBe(RESULT(name, "global"))
        expect(yield* Effect.promise(() => exists(path.join(folder, "SKILL.md")))).toBe(true)
        expect(yield* Effect.promise(() => exists(path.join(folder, "draft.json")))).toBe(true)
        expect(yield* Effect.promise(() => exists(path.join(Global.Path.config, "skills", name)))).toBe(false)
      }),
    ),
  )

  it.live("the draft is absent from all() even with skills.paths pointing at the drafts root's parent", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const tool = yield* build
          yield* tool.execute({ name: "hidden-draft", scope: "project", content: skillText("hidden-draft") }, ctx())
          expect(yield* Effect.promise(() => exists(path.join(dir, ".swarm", "skill-drafts", "hidden-draft", "SKILL.md")))).toBe(
            true,
          )
          const skill = yield* Skill.Service
          expect((yield* skill.all()).map((item) => item.name)).not.toContain("hidden-draft")
          expect(yield* skill.get("hidden-draft")).toBeUndefined()
        }),
      { config: { skills: { paths: [".swarm"] } } },
    ),
  )

  it.live("runsCommands is reported, not refused, for a skill that runs shell commands", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const tool = yield* build
        const result = yield* tool.execute(
          { name: "shell-steps", scope: "project", content: skillText("shell-steps", "Status: !`git status`") },
          ctx(),
        )
        expect(result.metadata.refused).toBeUndefined()
        expect(result.metadata.runsCommands).toBe(true)
        const record = yield* Effect.promise(() =>
          readJson(path.join(dir, ".swarm", "skill-drafts", "shell-steps", "draft.json")),
        )
        expect(record.runsCommands).toBe(true)
      }),
    ),
  )
})

describe("AC-SKd2 SR8-06 untrusted draft badge", () => {
  const draftUntrusted = (messages: unknown[], name: string) =>
    Effect.gen(function* () {
      const tool = yield* build
      const result = yield* tool.execute({ name, scope: "project", content: skillText(name) }, ctx(messages))
      expect(result.metadata.refused).toBeUndefined()
      return result.metadata.untrusted as boolean
    })

  it.live("untrusted: true after a webfetch part in the session", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        expect(yield* draftUntrusted([toolPart("webfetch", { url: "https://example.com" })], "web-draft")).toBe(true)
        const record = yield* Effect.promise(() =>
          readJson(path.join(dir, ".swarm", "skill-drafts", "web-draft", "draft.json")),
        )
        expect(record.untrusted).toBe(true)
        // The drafts reader behind GET /skill/drafts (row 40c) shows the same badge.
        const manage = yield* Effect.promise(() => import("../../src/skill/manage").catch(() => undefined))
        if (!manage) throw new Error("skill drafts reader does not exist (src/skill/manage.ts)")
        const draft = yield* Effect.promise(() => manage.readDraft("project", "web-draft", { directory: dir, worktree: dir }))
        expect(draft).toMatchObject({ name: "web-draft", scope: "project", untrusted: true, sessionID: "ses_r40d" })
      }),
    ),
  )

  it.live("untrusted: true after a completed task whose child read the web, directly or one level down", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        expect(yield* draftUntrusted([taskPart("ses_web")], "child-web")).toBe(true)
        expect(yield* draftUntrusted([taskPart("ses_mid")], "child-mid")).toBe(true)
        const record = yield* Effect.promise(() =>
          readJson(path.join(dir, ".swarm", "skill-drafts", "child-web", "draft.json")),
        )
        expect(record.untrusted).toBe(true)
      }),
    ),
  )

  it.live("a child that cannot be read counts as untrusted; a local-only child and a local session do not", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        expect(yield* draftUntrusted([taskPart("ses_missing")], "child-missing")).toBe(true)
        expect(yield* draftUntrusted([taskPart("ses_local")], "child-local")).toBe(false)
        expect(yield* draftUntrusted([toolPart("read", { filePath: "a.ts" })], "plain-local")).toBe(false)
      }),
    ),
  )
})

describe("AC-SKd2 refusals write nothing", () => {
  it.live("the 21st draft of a new name is refused SKILL_DRAFTS_FULL; an existing name still replaces", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const tool = yield* build
        for (let i = 0; i < 20; i++) {
          const name = `draft-${i}`
          const result = yield* tool.execute({ name, scope: "project", content: skillText(name) }, ctx())
          expect(result.metadata.refused).toBeUndefined()
        }
        const full = yield* tool.execute({ name: "draft-20", scope: "project", content: skillText("draft-20") }, ctx())
        expect(full.metadata.refused).toBe("SKILL_DRAFTS_FULL")
        expect(full.output).toBe(FULL)
        expect(yield* Effect.promise(() => exists(path.join(dir, ".swarm", "skill-drafts", "draft-20")))).toBe(false)
        const again = yield* tool.execute(
          { name: "draft-3", scope: "project", content: skillText("draft-3", "Second version.") },
          ctx(),
        )
        expect(again.metadata.refused).toBeUndefined()
        expect(again.metadata.replaced).toBe(true)
        expect(
          yield* Effect.promise(() => fs.readFile(path.join(dir, ".swarm", "skill-drafts", "draft-3", "SKILL.md"), "utf8")),
        ).toContain("Second version.")
      }),
    ),
  )

  it.live("name ../evil -> SKILL_NAME_INVALID and nothing is written", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const tool = yield* build
        for (const name of ["../evil", "Evil", "a/b", "-x", ""]) {
          const result = yield* tool.execute({ name, scope: "project", content: skillText(name) }, ctx())
          expect({ name, refused: result.metadata.refused }).toEqual({ name, refused: "SKILL_NAME_INVALID" })
          expect(result.output).toStartWith("SKILL_NAME_INVALID: ")
        }
        expect(yield* Effect.promise(() => exists(path.join(dir, ".swarm")))).toBe(false)
        expect(yield* Effect.promise(() => exists(path.join(dir, "evil")))).toBe(false)
      }),
    ),
  )

  it.live("reserved names, a frontmatter mismatch, oversize content and a linked drafts folder are refused", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const tool = yield* build
        const refused = (name: string, content: string) =>
          tool
            .execute({ name, scope: "project", content }, ctx())
            .pipe(Effect.map((result) => result.metadata.refused))
        expect(yield* refused("mission-control", skillText("mission-control"))).toBe("SKILL_NAME_RESERVED")
        expect(yield* refused("drafts", skillText("drafts"))).toBe("SKILL_NAME_RESERVED")
        expect(yield* refused("good-name", skillText("other-name"))).toBe("SKILL_FRONTMATTER_INVALID")
        expect(yield* refused("good-name", "no frontmatter at all")).toBe("SKILL_FRONTMATTER_INVALID")
        expect(yield* refused("good-name", `---\nname: good-name\n---\nbody\n`)).toBe("SKILL_FRONTMATTER_INVALID")
        expect(yield* refused("good-name", skillText("good-name", "x".repeat(65537)))).toBe("SKILL_TOO_LARGE")
        expect(
          yield* refused("good-name", `---\nname: good-name\ndescription: d\ntriggers:\n  colours: [red]\n---\nbody\n`),
        ).toBe("SKILL_TRIGGERS_INVALID")
        expect(yield* Effect.promise(() => exists(path.join(dir, ".swarm")))).toBe(false)

        // A drafts folder that is a link to somewhere else: SKILL_PATH_UNSAFE, nothing written there.
        const elsewhere = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "r40d-out-")))
        yield* Effect.addFinalizer(() => Effect.promise(() => fs.rm(elsewhere, { recursive: true, force: true })))
        yield* Effect.promise(() => fs.mkdir(path.join(dir, ".swarm"), { recursive: true }))
        yield* Effect.promise(() => fs.symlink(elsewhere, path.join(dir, ".swarm", "skill-drafts")))
        expect(yield* refused("good-name", skillText("good-name"))).toBe("SKILL_PATH_UNSAFE")
        expect(yield* Effect.promise(() => fs.readdir(elsewhere))).toEqual([])
      }),
    ),
  )
})

// Registry: the tool is registered, hidden by a deny rule, and not given to an agent whose skill permission is off.
const configLayer = TestConfig.layer({
  directories: () => InstanceState.directory.pipe(Effect.map((dir) => [path.join(dir, ".opencode")])),
})
const registry = testEffect(
  LayerNode.compile(LayerNode.group([ToolRegistry.node, Agent.node]), [
    [Config.node, configLayer],
    [RuntimeFlags.node, RuntimeFlags.layer()],
  ]),
)

describe("AC-SKd2 registry", () => {
  registry.instance("skill_draft is a registered tool and reaches an agent that may load skills", () =>
    Effect.gen(function* () {
      const tools = yield* ToolRegistry.Service
      expect(yield* tools.ids()).toContain("skill_draft")
      const agents = yield* Agent.Service
      const agent = yield* agents.defaultInfo()
      const model = { providerID: ProviderV2.ID.opencode, modelID: ModelV2.ID.make("test") }
      const visible = (yield* tools.tools({ ...model, agent })).map((tool) => tool.id)
      expect(visible).toContain("skill_draft")
      const noSkills = { ...agent, permission: [...agent.permission, { permission: "skill", pattern: "*", action: "deny" as const }] }
      expect((yield* tools.tools({ ...model, agent: noSkills })).map((tool) => tool.id)).not.toContain("skill_draft")
    }),
  )

  test('"skill_draft": "deny" hides the tool', () => {
    expect(Permission.disabled(["skill_draft"], [{ permission: "skill_draft", pattern: "*", action: "deny" }]).has("skill_draft")).toBe(true)
  })
})
