// Swarm 1.2.8 row 40e (AC-SKe, SK-e, N8-352; SR8-10, SR8-03; C11 S14-D2). An agent's write into a skill folder is
// refused in every mode: the edit tools (`write`, `edit`, `apply_patch`) refuse before any prompt with the N8-058 text
// (R20-C15), whatever a person's "always" says; the autonomy table refuses an edit or a shell write there as X
// `skill_folder` (N8-411) with autonomous mode on, with and without the consent, a consent item covering the file
// included. Reads stay allowed. A checkout file that is not in a skill folder, and `src/x.ts` beside a project-root
// SKILL.md (SR8-10), are unaffected. HOME is a mkdtemp folder with `os.homedir` stubbed; every file is synthetic.
// Namespace imports only, so the file loads at BASE (e1f9673772) and fails there by its assertions.
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs"
import os from "node:os"
import * as osModule from "node:os"
import path from "node:path"
import { Effect, Exit, Cause } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import * as TableModule from "../../src/permission/autonomy-table"
import * as Texts from "../../src/permission/autonomy-texts"
import * as PermissionModule from "../../src/permission"
import * as ReachModule from "../../src/tool/reach"
import * as SkillModule from "../../src/skill"
import type { InstanceContext } from "../../src/project/instance-context"
import { readSteps } from "../../src/tool/shell"
import { WriteTool } from "../../src/tool/write"
import { EditTool } from "../../src/tool/edit"
import { ApplyPatchTool } from "../../src/tool/apply_patch"
import { LSP } from "@/lsp/lsp"
import { Format } from "../../src/format"
import { Agent } from "../../src/agent/agent"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Truncate } from "@/tool/truncate"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { SessionID, MessageID } from "../../src/session/schema"
import { disposeAllInstances, TestInstance, tmpdir } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { Layer } from "effect"
import { Plugin } from "../../src/plugin"
import { MCP } from "../../src/mcp"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { ToolRegistry } from "../../src/tool/registry"
import * as SessionToolsModule from "../../src/session/tools"
import * as InstanceStateModule from "../../src/effect/instance-state"

const { AutonomyTable } = TableModule
const Reach = ReachModule.Reach as typeof ReachModule.Reach & Record<string, any>
const Skill = SkillModule.Skill
const Permission = PermissionModule.Permission

// R20-C15: the corrected N8-058 text, written out so the test does not take it from the code under test.
const N8_058 =
  "This write is not allowed: skills are saved only from Settings > Skills after the person approves them. Draft the skill with the skill_draft tool (see the skill-authoring skill) and tell the person it is waiting."

let fixture: Awaited<ReturnType<typeof tmpdir>>
let dir: string
let instance: InstanceContext
let home: string
let spies: { mockRestore(): void }[] = []

beforeAll(async () => {
  fixture = await tmpdir({ git: true })
  dir = fixture.path
  instance = { directory: dir, worktree: dir, project: { vcs: "git" } } as InstanceContext
  execFileSync("git", ["config", "--unset", "core.fsmonitor"], { cwd: dir })
  execFileSync("git", ["config", "--unset", "commit.gpgsign"], { cwd: dir })
  for (const sub of [".swarm/skills/x", "src/skill", "custom/x"]) mkdirSync(path.join(dir, sub), { recursive: true })
  writeFileSync(path.join(dir, ".swarm/skills/x/SKILL.md"), "---\nname: x\ndescription: synthetic\n---\nbody\n")
  writeFileSync(path.join(dir, "src/skill/mission-control.md"), "synthetic checkout file\n")
  writeFileSync(path.join(dir, "src/x.ts"), "export const x = 1\n")
  writeFileSync(path.join(dir, "a.md"), "synthetic\n")
  home = mkdtempSync(path.join(os.tmpdir(), "ske-"))
  mkdirSync(path.join(home, ".agents/skills/x"), { recursive: true })
  writeFileSync(path.join(home, ".agents/skills/x/SKILL.md"), "---\nname: x\ndescription: synthetic\n---\nbody\n")
  spies = [spyOn(os, "homedir").mockReturnValue(home), spyOn(osModule, "homedir").mockReturnValue(home)]
})
afterAll(async () => {
  for (const spy of spies) spy.mockRestore()
  Reach.forgetSkillFolders?.()
  rmSync(home, { recursive: true, force: true })
  await fixture[Symbol.asyncDispose]()
})

type Mode = "off" | "on" | "consent"
const ROLES = [undefined, "build", "coder", "verifier", "planner"] as const

function editInput(file: string, mode: Mode, agent?: string, editClass?: string): TableModule.AutonomyTable.Input {
  const consent = mode === "consent" ? { consent: { id: "c1", files: new Map([[file, "item-1"]]) } } : {}
  return {
    permission: "edit",
    patterns: [path.relative(dir, file)],
    metadata: { filepath: file },
    instance,
    cwd: dir,
    canUndo: true,
    folder: "clean",
    // What the edit tools would have said at BASE, before the guard: a sensitive edit.
    editClass: (editClass ?? "sensitive") as TableModule.AutonomyTable.Input["editClass"],
    ...(agent !== undefined && { agent }),
    ...(mode === "consent" && { bypass: { caller: agent === undefined || agent === "build" ? "root" : "subagent" } }),
    ...consent,
  } as TableModule.AutonomyTable.Input
}

async function shellInput(command: string, mode: Mode, consented: string[] = []): Promise<TableModule.AutonomyTable.Input> {
  return {
    permission: "bash",
    patterns: [command],
    metadata: { command, workdir: dir, steps: await readSteps(command, dir) },
    instance,
    cwd: dir,
    canUndo: true,
    folder: "clean",
    ...(mode === "consent" && {
      bypass: { caller: "root" as const },
      consent: { id: "c1", files: new Map(consented.map((file) => [file, "item-1"])) },
    }),
  } as TableModule.AutonomyTable.Input
}

const verdictOf = (input: TableModule.AutonomyTable.Input) =>
  input.bypass ? AutonomyTable.classify(input) : AutonomyTable.classifyBase(input)

describe("SK-e N8-058: the refusal text", () => {
  test("SKILL_FOLDER_HELD_TEXT is the R20-C15 text", () => {
    expect((Texts as Record<string, unknown>).SKILL_FOLDER_HELD_TEXT).toBe(N8_058)
  })

  test("skill_folder is a DeferredCategory literal and an X with its own text, with and without consent", async () => {
    const { PermissionV1 } = await import("@opencode-ai/core/v1/permission")
    expect(PermissionV1.DeferredCategory.literals as readonly string[]).toContain("skill_folder")
    expect(PermissionV1.EditClass.literals as readonly string[]).toContain("skill_folder")
    for (const error of [Permission.refusedByMode("skill_folder"), Permission.refusedUnderConsent("skill_folder")]) {
      expect((error as Error).message).toContain(N8_058)
      expect((error as Error).message.startsWith("This call did not run.")).toBe(true)
    }
  })
})

describe("SK-e Reach.editTrust: a skill-folder file is refused before any prompt", () => {
  const trust = (files: string[], canUndo = true) =>
    Effect.runPromiseExit(Reach.editTrust({ trust: { canUndo } }, instance, files) as Effect.Effect<unknown>)
  const refusedWith = (exit: Exit.Exit<unknown, unknown>) =>
    Exit.isFailure(exit) ? String(Cause.squash(exit.cause) instanceof Error ? (Cause.squash(exit.cause) as Error).message : "") : ""

  test("<project>/.swarm/skills/x/SKILL.md, with and without Undo", async () => {
    for (const canUndo of [true, false]) {
      const exit = await trust([path.join(dir, ".swarm/skills/x/SKILL.md")], canUndo)
      expect(refusedWith(exit)).toBe(N8_058)
    }
  })

  test("a new file in a project skill folder and in the project drafts root (written only by skill_draft)", async () => {
    for (const file of [".swarm/skills/y/notes.txt", ".agents/skills/y/a.md", ".swarm/skill-drafts/y/SKILL.md"])
      expect(refusedWith(await trust([path.join(dir, file)]))).toBe(N8_058)
  })

  test("~/.agents/skills/x/SKILL.md outside the project (no Undo there)", async () => {
    expect(refusedWith(await trust([path.join(home, ".agents/skills/x/SKILL.md")], false))).toBe(N8_058)
  })

  test("a folder only the Skill service names (skills.paths): read from Skill.Service.folders()", async () => {
    Reach.forgetSkillFolders?.()
    const custom = path.join(dir, "custom")
    const service = Skill.Service.of({
      get: () => Effect.succeed(undefined),
      require: () => Effect.die("unused"),
      all: () => Effect.succeed([]),
      dirs: () => Effect.succeed([custom]),
      available: () => Effect.succeed([]),
      folders: () => Effect.succeed([custom]),
    } as unknown as SkillModule.Skill.Interface)
    const exit = await Effect.runPromiseExit(
      (Reach.editTrust({ trust: { canUndo: true } }, instance, [path.join(custom, "x/run.sh")]) as Effect.Effect<unknown>).pipe(
        Effect.provideService(Skill.Service, service),
      ),
    )
    expect(refusedWith(exit)).toBe(N8_058)
    Reach.forgetSkillFolders?.()
  })

  test("a checkout file that is not a discovered folder (src/skill/mission-control.md) is unaffected", async () => {
    const exit = await trust([path.join(dir, "src/skill/mission-control.md")])
    expect(Exit.isSuccess(exit)).toBe(true)
  })

  test("SR8-10: a SKILL.md at the project root makes the project root no skill folder; src/x.ts is unaffected", async () => {
    Reach.rememberSkillFolders?.(instance, [dir, home, "/"])
    expect(Exit.isSuccess(await trust([path.join(dir, "src/x.ts")]))).toBe(true)
    expect(refusedWith(await trust([path.join(dir, "SKILL.md")]))).toBe(N8_058)
    expect(refusedWith(await trust([path.join(dir, "docs/Skill.MD")]))).toBe(N8_058)
    Reach.forgetSkillFolders?.()
  })
})

describe("SK-e the autonomy table: an edit into a skill folder is X skill_folder in every mode and role", () => {
  for (const mode of ["on", "consent"] as const)
    for (const agent of ROLES)
      test(`mode ${mode}, ${agent ?? "no agent"}: .swarm/skills/x/SKILL.md`, () => {
        const verdict = verdictOf(editInput(path.join(dir, ".swarm/skills/x/SKILL.md"), mode, agent))
        expect([verdict.class, verdict.category]).toEqual(["X", "skill_folder"])
      })

  test("an editClass skill_folder from the edit tools is refused, consent item or not", () => {
    for (const mode of ["on", "consent"] as const) {
      const verdict = verdictOf(editInput(path.join(dir, ".swarm/skills/x/SKILL.md"), mode, undefined, "skill_folder"))
      expect([verdict.class, verdict.category]).toEqual(["X", "skill_folder"])
    }
  })

  test("the checkout file src/skill/mission-control.md keeps its verdict (not skill_folder)", () => {
    const verdict = verdictOf(editInput(path.join(dir, "src/skill/mission-control.md"), "on", undefined, "ordinary"))
    expect(verdict.category).not.toBe("skill_folder")
  })
})

describe("SK-e the autonomy table: a shell write into a skill folder is X skill_folder, even with a consent item", () => {
  const target = () => path.join(home, ".agents/skills/x/SKILL.md")
  const WRITES = [
    "cat > ~/.agents/skills/x/SKILL.md <<'EOF'\nsynthetic\nEOF",
    "echo synthetic > ~/.agents/skills/x/notes.md",
    "cp a.md ~/.agents/skills/x/",
    "cp a.md ~/.agents/skills/x/SKILL.md",
    "cd ~/.agents/skills && cp " + "a.md x/b.md",
    "pushd ~/.agents/skills/x && tee SKILL.md < /dev/null",
    "mkdir -p .swarm/skills/z && cp a.md .swarm/skills/z/SKILL.md",
    "sed -i '' 's/a/b/' .swarm/skills/x/SKILL.md",
  ]
  for (const mode of ["on", "consent"] as const)
    for (const command of WRITES)
      test(`mode ${mode}: ${command.split("\n")[0]}`, async () => {
        const verdict = verdictOf(await shellInput(command, mode, [target(), path.join(dir, ".swarm/skills/x/SKILL.md")]))
        expect([verdict.class, verdict.category]).toEqual(["X", "skill_folder"])
      })

  const READS = ["cat ~/.agents/skills/x/SKILL.md", "ls .swarm/skills/x", "head -n 3 .swarm/skills/x/SKILL.md", "cp ~/.agents/skills/x/SKILL.md copy.md"]
  for (const command of READS)
    test(`reads stay allowed (mode consent): ${command}`, async () => {
      const verdict = verdictOf(await shellInput(command, "consent"))
      expect(verdict.category).not.toBe("skill_folder")
    })
})

describe("SK-e the edit tools: refused without asking, mode on and off, with an \"always\" edit rule present", () => {
  afterEach(async () => {
    await disposeAllInstances()
  })
  const it = testEffect(
    LayerNode.compile(
      LayerNode.group([LSP.node, FSUtil.node, EventV2Bridge.node, Format.node, CrossSpawnSpawner.node, Truncate.node, Agent.node]),
    ),
  )
  // The ask answers yes to everything, as a person's "always" for edits (or an allowing mode) would.
  const context = (asked: string[]) => ({
    sessionID: SessionID.make("ses_test-ske"),
    messageID: MessageID.make("msg_test"),
    callID: "",
    agent: "build",
    abort: AbortSignal.any([]),
    messages: [],
    metadata: () => Effect.void,
    trust: { canUndo: true },
    ask: (input: { permission: string }) => Effect.sync(() => void asked.push(input.permission)),
  })
  const failure = (exit: Exit.Exit<unknown, unknown>) => {
    if (!Exit.isFailure(exit)) return "succeeded"
    const error = Cause.squash(exit.cause)
    return error instanceof Error ? error.message : String(error)
  }

  it.instance("write, edit and apply_patch into .swarm/skills: refused with N8-058, nothing asked, nothing written", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const skillDir = path.join(test.directory, ".swarm/skills/x")
      yield* Effect.promise(async () => {
        mkdirSync(skillDir, { recursive: true })
        writeFileSync(path.join(skillDir, "SKILL.md"), "---\nname: x\ndescription: synthetic\n---\nold\n")
      })
      const asked: string[] = []
      const write = yield* (yield* WriteTool).init()
      const edit = yield* (yield* EditTool).init()
      const patch = yield* (yield* ApplyPatchTool).init()
      const ctx = context(asked) as never
      const results = [
        yield* write.execute({ filePath: path.join(skillDir, "SKILL.md"), content: "new\n" }, ctx).pipe(Effect.exit),
        yield* write.execute({ filePath: path.join(skillDir, "extra.md"), content: "new\n" }, ctx).pipe(Effect.exit),
        yield* edit.execute({ filePath: path.join(skillDir, "SKILL.md"), oldString: "old", newString: "new" }, ctx).pipe(Effect.exit),
        yield* patch
          .execute({ patchText: "*** Begin Patch\n*** Add File: .swarm/skills/x/added.md\n+new\n*** End Patch" }, ctx)
          .pipe(Effect.exit),
      ]
      for (const exit of results) expect(failure(exit)).toContain(N8_058)
      expect(asked).toEqual([])
      expect(existsSync(path.join(skillDir, "extra.md"))).toBe(false)
      expect(existsSync(path.join(skillDir, "added.md"))).toBe(false)
    }),
  )

  it.instance("a checkout file src/skill/mission-control.md is still written (asked as usual)", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const asked: string[] = []
      const write = yield* (yield* WriteTool).init()
      const file = path.join(test.directory, "src/skill/mission-control.md")
      const exit = yield* write.execute({ filePath: file, content: "synthetic\n" }, context(asked) as never).pipe(Effect.exit)
      expect(Exit.isSuccess(exit)).toBe(true)
      expect(asked).toContain("edit")
    }),
  )
})

// 1.2.8 row 40h (C82, the two row-40e requests): (1) the edit tools check the skill folder BEFORE the outside-folder
// prompt, so a write into ~/.agents/skills (outside the project) is refused with nothing asked first; (2) resolving a
// session's tools records Skill.Service.folders(), so a skills.paths folder holds from the very first call, before any
// edit tool asked the service (the autonomy table judges a shell write against it, and the edit tools refuse it).
describe("SK-e row 40h: skill folder before the outside-folder prompt, and the Skill folders known from tool resolve", () => {
  afterEach(async () => {
    Reach.forgetSkillFolders?.()
    await disposeAllInstances()
  })
  // A skills.paths folder outside the project, only the Skill service names it.
  const extra = () => path.join(home, "extra-skills")
  const skillStub = Layer.succeed(
    Skill.Service,
    Skill.Service.of({
      get: () => Effect.succeed(undefined),
      require: () => Effect.die("unused"),
      all: () => Effect.succeed([]),
      dirs: () => Effect.succeed([extra()]),
      available: () => Effect.succeed([]),
      folders: () => Effect.succeed([extra()]),
    } as unknown as SkillModule.Skill.Interface),
  )
  const stubs = Layer.mergeAll(
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
      } satisfies PermissionModule.Permission.Interface),
    ),
    Layer.succeed(
      MCP.Service,
      MCP.Service.of({ tools: () => Effect.succeed({}), clients: () => Effect.succeed({}) } as Partial<MCP.Interface> as MCP.Interface),
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
  )
  const tools = LayerNode.compile(
    LayerNode.group([LSP.node, FSUtil.node, EventV2Bridge.node, Format.node, CrossSpawnSpawner.node, Truncate.node, Agent.node]),
  )
  // Edit tools without the Skill service: only what is known before the call (fixed roots, the resolve record) holds.
  const bare = testEffect(tools)
  const withSkills = testEffect(Layer.mergeAll(tools, stubs, skillStub))

  const asking = (asked: string[]) => ({
    sessionID: SessionID.make("ses_test-ske40h"),
    messageID: MessageID.make("msg_test"),
    callID: "",
    agent: "build",
    abort: AbortSignal.any([]),
    messages: [],
    metadata: () => Effect.void,
    trust: { canUndo: true },
    ask: (input: { permission: string }) => Effect.sync(() => void asked.push(input.permission)),
  })
  const failure = (exit: Exit.Exit<unknown, unknown>) => {
    if (!Exit.isFailure(exit)) return "succeeded"
    const error = Cause.squash(exit.cause)
    return error instanceof Error ? error.message : String(error)
  }
  const SESSION = SessionID.make("ses_test-ske40h")
  const resolve = () =>
    SessionToolsModule.SessionTools.resolve({
      agent: { name: "build", mode: "primary", permission: Permission.fromConfig({ "*": "allow" }), options: {} } as never,
      model: { providerID: "test", api: { id: "test-model" } } as never,
      session: { id: SESSION, permission: [] } as never,
      processor: {
        message: { id: MessageID.make("msg_test"), sessionID: SESSION, role: "assistant" },
        updateToolCall: () => Effect.succeed(undefined),
        completeToolCall: () => Effect.void,
      } as never,
      bypassAgentCheck: false,
      messages: [],
      promptOps: {} as never,
    })

  bare.instance("~/.agents/skills outside the project: write, edit and apply_patch refused with N8-058, nothing asked first", () =>
    Effect.gen(function* () {
      const skillDir = path.join(home, ".agents/skills/x")
      const asked: string[] = []
      const ctx = asking(asked) as never
      const write = yield* (yield* WriteTool).init()
      const edit = yield* (yield* EditTool).init()
      const patch = yield* (yield* ApplyPatchTool).init()
      const results = [
        yield* write.execute({ filePath: path.join(skillDir, "SKILL.md"), content: "new\n" }, ctx).pipe(Effect.exit),
        yield* write.execute({ filePath: path.join(skillDir, "extra.md"), content: "new\n" }, ctx).pipe(Effect.exit),
        yield* edit.execute({ filePath: path.join(skillDir, "SKILL.md"), oldString: "body", newString: "new" }, ctx).pipe(Effect.exit),
        yield* patch
          .execute({ patchText: `*** Begin Patch\n*** Add File: ${path.join(skillDir, "added.md")}\n+new\n*** End Patch` }, ctx)
          .pipe(Effect.exit),
      ]
      for (const exit of results) expect(failure(exit)).toContain(N8_058)
      // No external_directory prompt (or any other) came before the refusal.
      expect(asked).toEqual([])
      expect(existsSync(path.join(skillDir, "extra.md"))).toBe(false)
      expect(existsSync(path.join(skillDir, "added.md"))).toBe(false)
    }),
  )

  bare.instance("a plain folder outside the project still gets its outside-folder prompt (unchanged)", () =>
    Effect.gen(function* () {
      const asked: string[] = []
      const write = yield* (yield* WriteTool).init()
      const exit = yield* write
        .execute({ filePath: path.join(home, "plain/notes.md"), content: "new\n" }, asking(asked) as never)
        .pipe(Effect.exit)
      expect(failure(exit)).not.toContain(N8_058)
      expect(asked[0]).toBe("external_directory")
    }),
  )

  withSkills.instance("a skills.paths folder is a skill folder once the session's tools resolve, before any edit tool ran", () =>
    Effect.gen(function* () {
      const context = yield* InstanceStateModule.InstanceState.context
      const file = path.join(extra(), "x/run.sh")
      Reach.forgetSkillFolders?.()
      expect(Reach.skillFolder?.(file, context) ?? false).toBe(false)
      yield* resolve()
      expect(Reach.skillFolder?.(file, context) ?? false).toBe(true)
      // The autonomy table (mode on, no service to ask) refuses a shell write there on this first call.
      const command = `echo synthetic > ${file}`
      const verdict = AutonomyTable.classifyBase({
        permission: "bash",
        patterns: [command],
        metadata: { command, workdir: context.directory, steps: yield* Effect.promise(() => readSteps(command, context.directory)) },
        instance: context,
        cwd: context.directory,
        canUndo: true,
        folder: "clean",
      } as TableModule.AutonomyTable.Input)
      expect([verdict.class, verdict.category]).toEqual(["X", "skill_folder"])
    }),
  )

  withSkills.instance("a skills.paths folder outside the project: the first write is refused with nothing asked", () =>
    Effect.gen(function* () {
      yield* resolve()
      const asked: string[] = []
      const write = yield* (yield* WriteTool).init()
      const exit = yield* write
        .execute({ filePath: path.join(extra(), "x/SKILL.md"), content: "new\n" }, asking(asked) as never)
        .pipe(Effect.exit)
      expect(failure(exit)).toContain(N8_058)
      expect(asked).toEqual([])
      expect(existsSync(path.join(extra(), "x/SKILL.md"))).toBe(false)
    }),
  )
})
