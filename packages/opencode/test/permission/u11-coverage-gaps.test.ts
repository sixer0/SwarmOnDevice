// Row 253 (C100): the U11 gaps the traceability matrix found (verification/14_u11_traceability.md, section 3). Each test
// is named after the matrix's proposed test, and goes through the real table, gate, shell and task tool.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs"
import path from "node:path"
import { Cause, Effect, Exit, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { Agent } from "../../src/agent/agent"
import { BackgroundJob } from "../../src/background/job"
import { Config } from "../../src/config/config"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Format } from "../../src/format"
import { LSP } from "../../src/lsp/lsp"
import { Permission } from "../../src/permission"
import { Autonomy } from "../../src/permission/autonomy"
import { AutonomyTable } from "../../src/permission/autonomy-table"
import { Plugin } from "../../src/plugin"
import type { InstanceContext } from "../../src/project/instance-context"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import { Question } from "../../src/question"
import { MessageV2 } from "../../src/session/message-v2"
import type { SessionPrompt } from "../../src/session/prompt"
import { SessionRunState } from "../../src/session/run-state"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import { Session } from "../../src/session/session"
import { SessionSpend } from "../../src/session/spend"
import { SessionStatus } from "../../src/session/status"
import { ToolRegistry } from "../../src/tool/registry"
import { ShellTool } from "../../src/tool/shell"
import { subagentStoppedMessage, TaskTool, type TaskPromptOps } from "../../src/tool/task"
import type { Tool } from "../../src/tool/tool"
import { Truncate } from "../../src/tool/truncate"
import { TestInstance, tmpdir } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const folder = path.join(Global.Path.state, "autonomy")
const trustFile = path.join(Global.Path.state, "trust.json")

// A decider that would let everything through: none of these calls may reach it.
const decided: string[] = []
const decider = Layer.succeed(
  Permission.Decider,
  Permission.Decider.of({
    decide: (input) =>
      Effect.sync(() => {
        decided.push(input.permission)
        return { decision: "allow" as const, decidedBy: "agent:test/stub" }
      }),
  }),
)
const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Permission.node,
      Session.node,
      Autonomy.node,
      EventV2Bridge.node,
      SessionProjector.node,
      CrossSpawnSpawner.node,
      InstanceStore.node,
      Question.node,
      FSUtil.node,
      Plugin.node,
      Truncate.node,
      Config.node,
      Agent.node,
      RuntimeFlags.node,
      LSP.node,
      Format.node,
      BackgroundJob.node,
      SessionRunState.node,
      SessionStatus.node,
      ToolRegistry.node,
      Database.node,
      Ripgrep.node,
    ]),
    [
      [InstanceStore.bootstrapNode, noopBootstrap],
      [Permission.deciderNode, decider],
    ],
  ),
)

const clean = () => {
  rmSync(folder, { recursive: true, force: true })
  rmSync(trustFile, { force: true })
}
beforeEach(() => {
  clean()
  decided.length = 0
})
afterEach(clean)

const ref = { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") }

/** A root in the mode with one subagent, and the person's message that is its mission. */
const family = Effect.gen(function* () {
  const sessions = yield* Session.Service
  const autonomy = yield* Autonomy.Service
  const root = yield* sessions.create({})
  yield* person(root.id, "Tidy the cache module and run its tests.")
  const child = yield* sessions.create({ parentID: root.id })
  yield* autonomy.setMode({ scope: "session", root: root.id, on: true })
  return { root, child }
})

const person = (sessionID: SessionID, text: string) =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const message = yield* sessions.updateMessage({
      id: MessageID.ascending(),
      role: "user",
      sessionID,
      agent: "build",
      model: ref,
      time: { created: Date.now() },
    })
    yield* sessions.updatePart({ id: PartID.ascending(), messageID: message.id, sessionID, type: "text", text })
    return message
  })

const lines = (root: SessionID) =>
  Effect.gen(function* () {
    const autonomy = yield* Autonomy.Service
    return (yield* autonomy.readAudit(root)).lines
  })
const decisions = (root: SessionID) =>
  lines(root).pipe(Effect.map((all) => all.flatMap((line) => (line.type === "decision" ? [line] : []))))
const markers = (root: SessionID) =>
  lines(root).pipe(Effect.map((all) => all.flatMap((line) => (line.type === "marker" ? [line.marker] : []))))

const ask = (input: PermissionV1.AskInput) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    return yield* permission.ask(input).pipe(Effect.timeout("5 seconds"), Effect.exit)
  })
const failure = (exit: Exit.Exit<unknown, unknown>) => (Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined)

const bash = (sessionID: SessionID, command: string, ruleset: PermissionV1.Ruleset, workdir?: string) =>
  ({
    sessionID,
    permission: "bash",
    patterns: [command],
    metadata: { command, ...(workdir ? { workdir } : {}) },
    always: ["*"],
    ruleset,
    canUndo: true,
  }) satisfies PermissionV1.AskInput

// ---------------------------------------------------------------------------------------------------------------------
// Table only: rules 2 and 8.

let fixture: Awaited<ReturnType<typeof tmpdir>>
const table = (permission: string, fields: Partial<AutonomyTable.Input> = {}): AutonomyTable.Input => {
  const directory = fixture.path
  return {
    permission,
    patterns: ["*"],
    metadata: {},
    instance: { directory, worktree: directory, project: { vcs: "git" } } as InstanceContext,
    cwd: directory,
    canUndo: true,
    folder: "clean",
    ...fields,
  }
}

describe("U11 rules 2 and 8 in the table", () => {
  beforeEach(async () => {
    fixture = await tmpdir({ git: true })
  })
  afterEach(async () => {
    await fixture[Symbol.asyncDispose]()
  })

  test("expect X when an agent raises a permission request named autonomy_consent", () => {
    // Only the server makes a consent entry (register U11). An agent asking for one is refused, in every folder and agent.
    for (const fields of [
      {},
      { plan: true },
      { folder: undefined },
      { canUndo: false },
      { harmless: true },
    ] satisfies Partial<AutonomyTable.Input>[])
      expect(
        AutonomyTable.classify(table(PermissionV1.AUTONOMY_CONSENT, { patterns: [".env"], ...fields })).class,
      ).toBe("X")
  })

  const ticked: AutonomyTable.Outward = {
    allowed: [{ id: "destination:0", destination: { kind: "host", host: "docs.example.com" } }],
  }
  const fetch = (url: string, fields: Partial<AutonomyTable.Input> = {}) =>
    table("webfetch", { patterns: [url], metadata: { url, format: "markdown" }, outward: ticked, ...fields })

  test("expect A when the plan agent fetches a URL whose host the person ticked (a fetch is a read)", () => {
    expect(AutonomyTable.classify(fetch("https://docs.example.com/guide", { plan: true }))).toEqual(
      AutonomyTable.classify(fetch("https://docs.example.com/guide")),
    )
    expect(AutonomyTable.classify(fetch("https://docs.example.com/guide", { plan: true })).class).toBe("A")
    // A host nobody ticked still waits, plan or not.
    expect(AutonomyTable.classify(fetch("https://evil.example.net/", { plan: true }))).toEqual({
      class: "D",
      decidedBy: "gate",
      category: "outward_not_in_mission",
    })
  })

  const mcp = (name: string, server: string, fields: Partial<AutonomyTable.Input> = {}) =>
    table(name, { metadata: { mcp: { server, transport: "local", origin: "global" } }, ...fields })
  const PLAN_MODE: AutonomyTable.Verdict = { class: "X", decidedBy: "gate", category: "plan_mode" }

  test("expect X plan_mode when the plan agent calls an MCP tool from a server other than swarm-web or graft", () => {
    for (const [name, server] of [
      ["github_create_issue", "github"],
      ["filesystem_write_file", "filesystem"],
      ["my_server_ping", "my.server"],
    ] as const) {
      expect([name, AutonomyTable.classify(mcp(name, server, { plan: true }))]).toEqual([name, PLAN_MODE])
      // The build agent keeps rule 5.
      expect([name, AutonomyTable.classify(mcp(name, server)).category]).toEqual([name, "mcp_tool"])
    }
    // A name that borrows a read-only server's source is not that server's tool.
    expect(AutonomyTable.classify(mcp("evil_send", "graft", { plan: true }))).toEqual(PLAN_MODE)
    // A tool with a source that names no server is no known server either.
    expect(AutonomyTable.classify(table("x_tool", { plan: true, metadata: { mcp: { origin: "project" } } }))).toEqual(
      PLAN_MODE,
    )
  })

  test("expect A when the plan agent calls an MCP tool from swarm-web or graft", () => {
    for (const [name, server] of [
      ["graft_find_code", "graft"],
      ["graft_file_api", "graft"],
      ["swarm-web_fetch", "swarm-web"],
      ["swarm-web_search", "swarm-web"],
    ] as const)
      expect([name, AutonomyTable.classify(mcp(name, server, { plan: true }))]).toEqual([
        name,
        { class: "A", decidedBy: "gate", category: "mcp_tool" },
      ])
    // Rules 5 and 7 still hold for them: a remote server waits as a way out.
    expect(
      AutonomyTable.classify(
        table("graft_find_code", {
          plan: true,
          metadata: { mcp: { server: "graft", transport: "remote", origin: "global" } },
        }),
      ),
    ).toEqual({ class: "D", decidedBy: "gate", category: "outward_not_in_mission" })
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// Through the real gate.

it.instance(
  "rule 2 through the gate: an agent's autonomy_consent request is refused, on record, and allows nothing",
  () =>
    Effect.gen(function* () {
      const { root, child } = yield* family
      const autonomy = yield* Autonomy.Service
      for (const sessionID of [root.id, child.id]) {
        const exit = yield* ask({
          sessionID,
          permission: PermissionV1.AUTONOMY_CONSENT,
          patterns: [".env"],
          metadata: {},
          always: [],
          ruleset: [],
        })
        expect(failure(exit)).toBeInstanceOf(PermissionV1.DeniedError)
      }
      expect((yield* decisions(root.id)).map((line) => [line.permission, line.class, line.decision])).toEqual([
        ["autonomy_consent", "X", "reject"],
        ["autonomy_consent", "X", "reject"],
      ])
      expect((yield* autonomy.consent(root.id))?.given.size ?? 0).toBe(0)
      expect(decided).toEqual([])
      expect(yield* (yield* Permission.Service).list()).toEqual([])
    }),
)

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" })

it.instance(
  "expect A archived when git rm moves a tracked file and the git index is unchanged afterwards",
  () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const dir = test.directory
      // The fixture sets core.fsmonitor and commit.gpgsign, which GitGuard refuses; a repository from `git init` has neither.
      git(dir, "config", "--unset", "core.fsmonitor")
      git(dir, "config", "--unset", "commit.gpgsign")
      mkdirSync(path.join(dir, "src"), { recursive: true })
      writeFileSync(path.join(dir, "src/a.ts"), "x\n")
      git(dir, "add", "src/a.ts")
      git(dir, "commit", "-q", "-m", "seed")
      const index = git(dir, "ls-files", "--stage")
      expect(index).toContain("src/a.ts")

      const { root } = yield* family
      const permission = yield* Permission.Service
      const asked: PermissionV1.AskInput[] = []
      const context: Tool.Context = {
        sessionID: root.id,
        messageID: MessageID.ascending(),
        callID: "call_git_rm",
        agent: "build",
        abort: AbortSignal.any([]),
        messages: [],
        metadata: () => Effect.void,
        ask: (request) => {
          const input = { ...request, sessionID: root.id, agent: "build", canUndo: true, ruleset: [] }
          asked.push(input)
          return permission.ask(input).pipe(Effect.orDie)
        },
      }
      const tool = yield* (yield* ShellTool).init()
      const result = yield* tool.execute({ command: "git rm src/a.ts", workdir: dir }, context)

      const id = result.output.match(/\.swarm\/archive\/(\S+) instead/)?.[1]
      expect(result.output).toBe(
        `Swarm moved 1 path(s) to .swarm/archive/${id} instead of deleting them. The person empties the archive when they return.`,
      )
      expect(existsSync(path.join(dir, "src/a.ts"))).toBe(false)
      expect(existsSync(path.join(dir, ".swarm/archive", id!, "src/a.ts"))).toBe(true)
      // Moved, not staged: the index still holds the file as committed, and nothing is staged for the next commit.
      expect(git(dir, "ls-files", "--stage")).toBe(index)
      expect(git(dir, "diff", "--cached", "--name-only")).toBe("")
      // The table read the shell's request as a move, and the gate put that on record.
      const request = asked.find((item) => item.permission === "bash")!
      expect(request.metadata.archive).toBe(true)
      const line = (yield* decisions(root.id)).find((item) => item.permission === "bash")!
      expect([line.class, line.category, line.decision]).toEqual(["A", "archived", "allow"])
      expect(decided).toEqual([])
    }),
  { git: true },
)

it.instance("rule 8 through the gate: the plan agent's MCP call to another server is refused, graft runs", () =>
  Effect.gen(function* () {
    const { root } = yield* family
    const call = (name: string, server: string) =>
      ask({
        sessionID: root.id,
        agent: "plan",
        permission: name,
        patterns: ["*"],
        metadata: { mcp: { server, transport: "local", origin: "global" } },
        always: ["*"],
        ruleset: [],
      })
    expect(Exit.isSuccess(yield* call("graft_find_code", "graft"))).toBe(true)
    expect(failure(yield* call("github_create_issue", "github"))).toBeInstanceOf(PermissionV1.DeniedError)
    expect((yield* decisions(root.id)).map((line) => [line.permission, line.class, line.category])).toEqual([
      ["graft_find_code", "A", "mcp_tool"],
      ["github_create_issue", "X", "plan_mode"],
    ])
  }),
)

// ---------------------------------------------------------------------------------------------------------------------
// Rule 11, through the real gate and the real `task` tool.

it.instance("expect B force_stop when a subagent's paid call reaches the family spend limit", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const permission = yield* Permission.Service
    const { root, child } = yield* family
    // The subagent's own run spent past the family's limit of $1.
    const asked = yield* person(child.id, "subagent prompt")
    const assistant: SessionV1.Assistant = {
      id: MessageID.ascending(),
      role: "assistant",
      parentID: asked.id,
      sessionID: child.id,
      mode: "general",
      agent: "general",
      cost: 1.5,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: ref.modelID,
      providerID: ref.providerID,
      time: { created: Date.now(), completed: Date.now() },
      finish: "tool-calls",
    }
    yield* sessions.updateMessage(assistant)
    yield* sessions.updatePart({
      id: PartID.ascending(),
      messageID: assistant.id,
      sessionID: child.id,
      type: "step-finish",
      reason: "tool-calls",
      cost: 1.5,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    })

    // The subagent's next paid call: what `session/prompt.ts` runs before every model request.
    const stopped = yield* SessionSpend.check({
      session: yield* sessions.get(child.id),
      sessions,
      permission,
      model: { cost: { input: 5, output: 25, cache: { read: 0, write: 0 } } },
      limit: 1,
    }).pipe(Effect.timeout("5 seconds"))

    expect(stopped).toBe(1)
    // Asked on the root, since the limit is the family's: the family is force stopped, and nobody is waited for.
    expect(
      (yield* decisions(root.id)).map((line) => [
        line.permission,
        line.sessionID,
        line.class,
        line.decision,
        line.decidedBy,
      ]),
    ).toEqual([["spend_limit", root.id, "B", "reject", "system:force_stop"]])
    expect(yield* markers(root.id)).toEqual(expect.arrayContaining(["force_stop", "b1"]))
    expect(yield* permission.list()).toEqual([])
    expect(decided).toEqual([])
  }),
)

it.instance(
  "expect B subagent_stopped when a subagent's doom_loop goes through the real gate and the real task tool, and the parent's turn goes on",
  () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const permission = yield* Permission.Service
      const agents = yield* Agent.Service
      const { root } = yield* family
      const parent = yield* person(root.id, "Look into the cache key path.")
      const assistant: SessionV1.Assistant = {
        id: MessageID.ascending(),
        role: "assistant",
        parentID: parent.id,
        sessionID: root.id,
        mode: "build",
        agent: "build",
        cost: 0,
        path: { cwd: "/tmp", root: "/tmp" },
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: ref.modelID,
        providerID: ref.providerID,
        time: { created: Date.now() },
      }
      yield* sessions.updateMessage(assistant)
      const general = (yield* agents.get("general"))!

      // The subagent's run: it repeats a call, and `session/processor.ts` asks `doom_loop` with the agent's own rules
      // through the real gate. The error the gate ends the run with becomes the message error, as `halt` makes it.
      const ops: TaskPromptOps = {
        cancel: () => Effect.void,
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: (input: SessionPrompt.PromptInput) =>
          Effect.gen(function* () {
            const exit = yield* permission
              .ask({
                permission: "doom_loop",
                patterns: ["read"],
                sessionID: input.sessionID,
                metadata: { tool: "read", input: { filePath: "src/cache.ts" } },
                always: ["read"],
                ruleset: general.permission,
              })
              .pipe(Effect.timeout("5 seconds"), Effect.exit)
            const id = MessageID.ascending()
            return {
              info: {
                id,
                role: "assistant",
                parentID: input.messageID ?? MessageID.ascending(),
                sessionID: input.sessionID,
                mode: "general",
                agent: "general",
                cost: 0,
                path: { cwd: "/tmp", root: "/tmp" },
                tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                modelID: ref.modelID,
                providerID: ref.providerID,
                time: { created: Date.now() },
                finish: "error",
                error: Exit.isFailure(exit)
                  ? MessageV2.fromError(Cause.squash(exit.cause), { providerID: ref.providerID, aborted: false })
                  : undefined,
              },
              parts: [
                {
                  id: PartID.ascending(),
                  messageID: id,
                  sessionID: input.sessionID,
                  type: "text",
                  text: "The key is built in cache.ts:40.",
                },
              ],
            } satisfies SessionV1.WithParts
          }),
      }

      const tool = yield* (yield* TaskTool).init()
      const result = yield* tool.execute(
        { description: "inspect cache", prompt: "look into the cache key path", subagent_type: "general" },
        {
          sessionID: root.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps: ops },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      // The parent's turn goes on: the task call succeeded, with the stop and the partial result for the parent to decide on.
      const child = (yield* sessions.children(root.id)).at(-1)!
      expect(result.output).toContain(`state="completed"`)
      expect(result.output).toContain(`${subagentStoppedMessage("read")} (task_id: ${child.id})`)
      expect(result.output).toContain("Decide the next step yourself")
      expect(result.output).toContain("What the subagent had so far:\nThe key is built in cache.ts:40.")
      expect(
        (yield* decisions(root.id)).map((line) => [
          line.permission,
          line.sessionID,
          line.class,
          line.decision,
          line.decidedBy,
        ]),
      ).toEqual([["doom_loop", child.id, "B", "reject", "system:subagent_stopped"]])
      // The subagent's stop is no force stop of the family, and nobody is waited for.
      const marked = yield* markers(root.id)
      expect(marked).toContain("subagent_stopped")
      expect(marked).not.toContain("force_stop")
      expect(marked).not.toContain("b1")
      expect(yield* permission.list()).toEqual([])
      expect(decided).toEqual([])
    }),
)

// ---------------------------------------------------------------------------------------------------------------------
// E2: a rule the person wrote settles the call before the gate, and it still leaves one line, with its class unchanged.

const RULE = "a rule the person wrote"

it.instance("expect A on record when an allow rule a person wrote lets a call through in the mode", () =>
  Effect.gen(function* () {
    const { root, child } = yield* family
    const test = yield* TestInstance
    const allow = [{ permission: "bash", pattern: "git push*", action: "allow" as const }]
    for (const sessionID of [root.id, child.id])
      expect(Exit.isSuccess(yield* ask(bash(sessionID, "git push origin main", allow, test.directory)))).toBe(true)
    expect(
      (yield* decisions(root.id)).map((line) => [
        line.sessionID,
        line.permission,
        line.class,
        line.decision,
        line.decidedBy,
        line.reason,
      ]),
    ).toEqual([
      [root.id, "bash", "A", "allow", "person", RULE],
      [child.id, "bash", "A", "allow", "person", RULE],
    ])
    expect(decided).toEqual([])
  }),
)

it.instance("expect X on record when a deny rule settles a call in the mode", () =>
  Effect.gen(function* () {
    const { root } = yield* family
    const test = yield* TestInstance
    const deny = [{ permission: "bash", pattern: "*", action: "deny" as const }]
    const exit = yield* ask(bash(root.id, "ls", deny, test.directory))
    expect(failure(exit)).toBeInstanceOf(PermissionV1.DeniedError)
    expect((failure(exit) as PermissionV1.DeniedError).ruleset).toHaveLength(1)
    expect(
      (yield* decisions(root.id)).map((line) => [
        line.permission,
        line.class,
        line.decision,
        line.decidedBy,
        line.reason,
      ]),
    ).toEqual([["bash", "X", "reject", "person", RULE]])
  }),
)

it.instance("E2: a built-in rule exit in the mode is never credited to the person; with the mode off, no line", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const agents = yield* Agent.Service
    const { root } = yield* family
    const test = yield* TestInstance
    // The build agent's own rules, as `session/tools.ts` sends them. The baseline's `"*": "ask"` comes last, so what still
    // settles before the gate is the baseline's own grants and the agent rules merged after it.
    const build = (yield* agents.get("build"))!.permission
    const grep = { sessionID: root.id, permission: "grep", patterns: ["cache"], metadata: {}, always: ["*"] }
    expect(Exit.isSuccess(yield* ask({ ...grep, ruleset: build }))).toBe(true)
    // `agent.ts` adds the truncation folder as an allowed place out of the project, after every config source.
    const saved = {
      sessionID: root.id,
      permission: "external_directory",
      patterns: [path.join(Truncate.DIR, "tool_output.txt")],
      metadata: {},
      always: ["*"],
    }
    expect(Exit.isSuccess(yield* ask({ ...saved, ruleset: build }))).toBe(true)
    // The baseline's `sudo*` deny, which reaches the agent through the config, and the agent's own rules marked as built in.
    expect(failure(yield* ask(bash(root.id, "sudo ls", build, test.directory)))).toBeInstanceOf(
      PermissionV1.DeniedError,
    )
    const truncate = build.findLast(
      (rule) => rule.permission === "external_directory" && rule.pattern === Truncate.GLOB,
    )!
    expect([
      Permission.isShipped(truncate),
      Permission.isShipped(build.find((rule) => rule.permission === "doom_loop")!),
    ]).toEqual([true, true])
    expect((yield* decisions(root.id)).filter((line) => line.decidedBy === "person")).toEqual([])
    expect(yield* decisions(root.id)).toEqual([])

    const off = yield* sessions.create({})
    const allow = [{ permission: "bash", pattern: "*", action: "allow" as const }]
    expect(Exit.isSuccess(yield* ask(bash(off.id, "git push origin main", allow, test.directory)))).toBe(true)
    expect(Exit.isSuccess(yield* ask({ ...grep, sessionID: off.id, ruleset: build }))).toBe(true)
    expect(existsSync(path.join(folder, `${off.id}.jsonl`))).toBe(false)
  }),
)
