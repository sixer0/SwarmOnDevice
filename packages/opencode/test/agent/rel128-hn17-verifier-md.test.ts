import { afterEach, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Agent } from "../../src/agent/agent"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Format } from "../../src/format"
import { LSP } from "../../src/lsp/lsp"
import { Permission } from "../../src/permission"
import { AutonomyTable } from "../../src/permission/autonomy-table"
import { Plugin } from "../../src/plugin"
import type { InstanceContext } from "../../src/project/instance-context"
import { Provider } from "../../src/provider/provider"
import { MessageID, SessionID } from "../../src/session/schema"
import { Skill } from "../../src/skill"
import { EditTool } from "../../src/tool/edit"
import { Risk } from "../../src/tool/risk"
import type { Tool } from "../../src/tool/tool"
import { Truncate } from "../../src/tool/truncate"
import { WriteTool } from "../../src/tool/write"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// 1.2.8 AC-HN17 (N8-317, H-N17, D-H3 option a, C5; N8-393): the verifier may write Markdown with a permission ask, as the
// planner and data-collector do (`markdownOnly`); every other file stays denied by its own rules (an agent's own deny is
// final, CHAR-09). SR8-03: the instruction files it can now reach stay held under consent, exactly as for the planner, and
// a `.md` link whose target is not Markdown stays denied. "The verifier does not edit the artefact it verifies" stays
// guidance in its prompt.

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      Agent.node,
      Plugin.node,
      Provider.node,
      Auth.node,
      Config.node,
      Skill.node,
      RuntimeFlags.node,
      LSP.node,
      FSUtil.node,
      EventV2Bridge.node,
      Format.node,
      CrossSpawnSpawner.node,
      Truncate.node,
    ]),
    [[RuntimeFlags.node, RuntimeFlags.layer({})]],
  ),
)

afterEach(async () => {
  await disposeAllInstances()
})

const role = (name: string) =>
  Agent.Service.use((svc) => svc.get(name)).pipe(
    Effect.map((agent) => {
      if (!agent) throw new Error(`agent ${name} is not registered`)
      return agent
    }),
  )
const at = (agent: Agent.Info, permission: string, pattern: string) => Permission.evaluate(permission, pattern, agent.permission).action

it.instance("N8-317: verifier *.md = ask, every other file = deny", () =>
  Effect.gen(function* () {
    const verifier = yield* role("verifier")
    expect(at(verifier, "edit", "docs/x/verification/01_verification.md")).toBe("ask")
    expect(at(verifier, "edit", "README.md")).toBe("ask")
    for (const file of ["src/a.ts", "package.json", "docs/x/report.docx", "notes.txt", "x.md.ts"])
      expect([file, at(verifier, "edit", file)]).toEqual([file, "deny"])
    // The edit tools are no longer hidden from it (a deny on "*" hid them), so it can reach the Markdown lane.
    expect([...Permission.disabled(["edit", "write", "apply_patch"], verifier.permission)]).toEqual([])
  }),
)

it.instance("N8-317: the verifier keeps no web tools and its shell rules", () =>
  Effect.gen(function* () {
    const verifier = yield* role("verifier")
    for (const tool of ["webfetch", "websearch"]) expect([tool, at(verifier, tool, "*")]).toEqual([tool, "deny"])
    expect(at(verifier, "bash", "bun test")).toBe("ask")
    expect(at(verifier, "bash", "sudo ls")).toBe("deny")
    expect(AutonomyTable.READ_SHELL_ROLES.has("verifier")).toBe(false)
  }),
)

it.instance("N8-317: planner and data-collector are unchanged", () =>
  Effect.gen(function* () {
    for (const name of ["planner", "data-collector"]) {
      const agent = yield* role(name)
      expect([name, at(agent, "edit", "docs/x.md")]).toEqual([name, "ask"])
      expect([name, at(agent, "edit", "src/a.ts")]).toEqual([name, "deny"])
      expect([name, at(agent, "webfetch", "*")]).toEqual([name, "deny"])
      expect(AutonomyTable.READ_SHELL_ROLES.has(name)).toBe(true)
    }
  }),
)

it.instance("SR8-03: AGENTS.md, .swarm/x.md and .claude/x.md are held under consent for the verifier, as for the planner", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    const verifier = yield* role("verifier")
    const planner = yield* role("planner")
    const instance = { directory: test.directory, worktree: test.directory, project: { vcs: "git" } } as InstanceContext
    for (const file of ["AGENTS.md", ".swarm/x.md", ".claude/x.md"]) {
      // The role layer asks for both alike; the file is a sensitive one, whatever role asks.
      expect([file, at(verifier, "edit", file)]).toEqual([file, at(planner, "edit", file)])
      expect([file, at(verifier, "edit", file)]).toEqual([file, "ask"])
      expect([file, Risk.sensitive(file)]).toEqual([file, true])
      // The autonomy table takes no role: under a consent that does not name the file, the edit is held for the person.
      const input: AutonomyTable.Input = {
        permission: "edit",
        patterns: [file],
        metadata: { filepath: path.join(test.directory, file) },
        instance,
        cwd: test.directory,
        canUndo: true,
        folder: "clean",
        editClass: "sensitive",
        consent: { id: "list-1", files: new Map([["docs/**", "sensitive:docs/**"]]) },
      }
      expect([file, AutonomyTable.classify(input)]).toEqual([file, { class: "D", decidedBy: "gate", category: "sensitive_file" }])
    }
  }),
)

const ctxFor = (agent: Agent.Info, asked: string[][]): Tool.Context => ({
  sessionID: SessionID.make("ses_rel128-hn17"),
  messageID: MessageID.make("msg_rel128-hn17"),
  callID: "",
  agent: agent.name,
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  // The agent-rule half of Permission.ask: a deny on any pattern of the call refuses it (S163-01, final).
  ask: (request) =>
    Effect.gen(function* () {
      if (request.permission !== "edit") return
      asked.push([...request.patterns])
      if (request.patterns.some((pattern) => Permission.evaluate("edit", pattern, agent.permission).action === "deny"))
        return yield* Effect.fail(new PermissionV1.DeniedError({ ruleset: [] }))
    }) as never,
})

it.instance("SR8-03: a .md link to a non-.md file stays denied for the verifier (write and edit)", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    const verifier = yield* role("verifier")
    yield* Effect.promise(() => fs.mkdir(path.join(test.directory, "src"), { recursive: true }))
    yield* Effect.promise(() => fs.writeFile(path.join(test.directory, "src/a.ts"), "export const a = 1\n"))
    yield* Effect.promise(() => fs.symlink(path.join(test.directory, "src/a.ts"), path.join(test.directory, "notes.md")))

    const writeInfo = yield* WriteTool
    const write = yield* writeInfo.init()
    const asked: string[][] = []
    const exit = yield* write.execute({ filePath: "notes.md", content: "overwritten\n" }, ctxFor(verifier, asked)).pipe(Effect.exit)
    expect(exit._tag).toBe("Failure")
    expect(asked.at(-1)).toEqual(["notes.md", "src/a.ts"])

    const editInfo = yield* EditTool
    const edit = yield* editInfo.init()
    const edited = yield* edit
      .execute({ filePath: "notes.md", oldString: "export const a = 1", newString: "export const a = 2" }, ctxFor(verifier, asked))
      .pipe(Effect.exit)
    expect(edited._tag).toBe("Failure")
    expect(yield* Effect.promise(() => fs.readFile(path.join(test.directory, "src/a.ts"), "utf8"))).toBe("export const a = 1\n")

    // A plain Markdown file is written after the ask; its prompt names only itself.
    const plain: string[][] = []
    yield* write.execute({ filePath: "docs/report.md", content: "# Report\n" }, ctxFor(verifier, plain))
    expect(plain).toEqual([["docs/report.md"]])
    expect(yield* Effect.promise(() => fs.readFile(path.join(test.directory, "docs/report.md"), "utf8"))).toBe("# Report\n")
  }),
  { git: true },
)
