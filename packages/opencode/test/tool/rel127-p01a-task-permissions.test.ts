// 1.2.7 row 30 (P-01a, AC-P01a, N7-092; SR7-04, OP-3): the task tool's `permissions` parameter lets a parent grant its
// child exact literal shell commands for that task only. Validated before any child session exists against the parent's
// own effective rules (never wider) and the child's effective merged ruleset (a role deny is final); held in the
// permission service's memory (`grantTask`, N7-133), never as a session allow rule; acting only in the gate, only under
// consent, by judging an exactly granted call with the parent's caller kind (`via: "task_grant"`, N7-134). X refusals,
// `own_api` and the mode-off prompt are unchanged.
import { afterEach, beforeEach, describe, expect, spyOn } from "bun:test"
import { chmodSync, existsSync, mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import * as osModule from "node:os"
import path from "node:path"
import { Cause, Effect, Exit, Fiber, Layer, Schema } from "effect"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Agent } from "../../src/agent/agent"
import { BackgroundJob } from "@/background/job"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Permission } from "../../src/permission"
import { Autonomy } from "../../src/permission/autonomy"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import { SelfAddress } from "../../src/server/self-address"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import { Session } from "../../src/session/session"
import type { SessionPrompt } from "../../src/session/prompt"
import { readSteps } from "../../src/tool/shell"
import * as Task from "../../src/tool/task"
import { Truncate } from "@/tool/truncate"
import { ToolRegistry } from "@/tool/registry"
import { ToolJsonSchema } from "../../src/tool/json-schema"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const ref = { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") }
const PORT = 47131
const SELF = { hostname: "127.0.0.1", port: PORT }

// Temp HOME through os.homedir (driver rules): nothing reads the person's home.
let home: string
let spies: { mockRestore(): void }[] = []
const folder = path.join(Global.Path.state, "autonomy")
const clean = () => {
  if (existsSync(folder)) chmodSync(folder, 0o755)
  rmSync(folder, { recursive: true, force: true })
  rmSync(path.join(Global.Path.state, "trust.json"), { force: true })
}
beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), "p01a-"))
  spies = [spyOn(os, "homedir").mockReturnValue(home), spyOn(osModule, "homedir").mockReturnValue(home)]
  clean()
  stub.calls.length = 0
})
afterEach(async () => {
  for (const spy of spies) spy.mockRestore()
  rmSync(home, { recursive: true, force: true })
  clean()
  await disposeAllInstances()
})

// ---------------------------------------------------------------------------------------------------------------------
// Part 1: the task tool (validation before any child session; the grant handed to the permission service).
// ---------------------------------------------------------------------------------------------------------------------

const taskLayer = LayerNode.compile(
  LayerNode.group([
    Agent.node,
    BackgroundJob.node,
    EventV2Bridge.node,
    Config.node,
    CrossSpawnSpawner.node,
    Session.node,
    SessionProjector.node,
    SessionRunState.node,
    SessionStatus.node,
    Truncate.node,
    ToolRegistry.node,
    Database.node,
    RuntimeFlags.node,
    Ripgrep.node,
  ]),
  [[RuntimeFlags.node, RuntimeFlags.layer({})]],
)
const tool = testEffect(taskLayer)

const seed = Effect.fn("P01a.seed")(function* () {
  const session = yield* Session.Service
  const chat = yield* session.create({ title: "Pinned" })
  const user = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: chat.id,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  const assistant: SessionV1.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    parentID: user.id,
    sessionID: chat.id,
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    time: { created: Date.now() },
  }
  yield* session.updateMessage(assistant)
  return { chat, assistant }
})

const reply = (input: SessionPrompt.PromptInput): SessionV1.WithParts => {
  const id = MessageID.ascending()
  return {
    info: {
      id,
      role: "assistant",
      parentID: input.messageID ?? MessageID.ascending(),
      sessionID: input.sessionID,
      mode: input.agent ?? "general",
      agent: input.agent ?? "general",
      cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: ref.modelID,
      providerID: ref.providerID,
      time: { created: Date.now() },
      finish: "stop",
    },
    parts: [{ id: PartID.ascending(), messageID: id, sessionID: input.sessionID, type: "text", text: "done" }],
  }
}

type GrantCall = { child: string; patterns: string[]; caller: string; during?: boolean }

/** Runs the task tool from a root `build` session, with a stand-in permission service that records `grantTask`. */
const runTask = (subagent_type: string, permissions: unknown) =>
  Effect.gen(function* () {
    const { chat, assistant } = yield* seed()
    const grants: GrantCall[] = []
    let running = false
    const prompts: string[] = []
    const permission = Permission.Service.of({
      ask: () => Effect.void,
      reply: () => Effect.succeed(undefined),
      grant: () => Effect.void,
      list: () => Effect.succeed([]),
      grantTask: (child, patterns, caller) =>
        Effect.sync(() => {
          grants.push({ child, patterns: [...patterns], caller, ...(running ? { during: true } : {}) })
        }),
    })
    const def = yield* (yield* Task.TaskTool).init()
    const result = yield* def
      .execute(
        {
          description: "check build",
          prompt: "run the check",
          subagent_type,
          ...(permissions === undefined ? {} : { permissions }),
        } as never,
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              cancel: () => Effect.void,
              resolvePromptParts: (template: string) => Effect.succeed([{ type: "text" as const, text: template }]),
              prompt: (input: SessionPrompt.PromptInput) =>
                Effect.sync(() => {
                  running = true
                  prompts.push(input.sessionID)
                  const out = reply(input)
                  running = false
                  return out
                }),
            } satisfies Task.TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )
      .pipe(Effect.provideService(Permission.Service, permission), Effect.exit)
    const sessions = yield* Session.Service
    const children = yield* sessions.children(chat.id)
    return { result, grants, prompts, children, chat }
  })

const failure = (exit: Exit.Exit<unknown, unknown>) => (Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "")

describe("P-01a task tool", () => {
  tool.instance("the parameter is in the schema the model sees (N7-055, K7-07)", () =>
    Effect.gen(function* () {
      const decoded = Schema.decodeUnknownSync(Task.Parameters)({
        description: "d",
        prompt: "p",
        subagent_type: "coder",
        permissions: { bash: ["curl https://example.com"] },
      })
      expect(decoded.permissions).toEqual({ bash: ["curl https://example.com"] })
      const schema = JSON.stringify(ToolJsonSchema.fromSchema(Task.Parameters))
      expect(schema).toContain('"permissions"')
      expect(schema).toContain("Only patterns this session may run itself are accepted.")
    }),
  )

  tool.instance("R1: a coder task with a grant starts, hands the grant over for its child only, and drops it at the end", () =>
    Effect.gen(function* () {
      const { result, grants, prompts, children } = yield* runTask("coder", { bash: ["curl https://example.com"] })
      expect(failure(result)).toBe("")
      expect(children.length).toBe(1)
      const child = children[0]!.id
      expect(prompts).toEqual([child])
      // Issued before the run, for the child, judged as the root; dropped once the run is over.
      expect(grants).toEqual([
        { child, patterns: ["curl https://example.com"], caller: "root" },
        { child, patterns: [], caller: "root" },
      ])
      // Never written as a session allow rule (01b: last match would let it skip the gate).
      expect(children[0]!.permission?.some((rule) => rule.action === "allow" && rule.pattern.includes("curl"))).toBe(false)
    }),
  )

  tool.instance("a task without permissions drops any earlier grant for that child (a resume keeps none)", () =>
    Effect.gen(function* () {
      const { result, grants, children } = yield* runTask("coder", undefined)
      expect(failure(result)).toBe("")
      const child = children[0]!.id
      expect(grants).toEqual([
        { child, patterns: [], caller: "root" },
        { child, patterns: [], caller: "root" },
      ])
    }),
  )

  tool.instance("R2: `sudo ls` exceeds the parent: TASK_GRANT_EXCEEDS_PARENT and no child session", () =>
    Effect.gen(function* () {
      const { result, grants, children } = yield* runTask("coder", { bash: ["sudo ls"] })
      expect(failure(result)).toContain(
        `${Task.TASK_GRANT_EXCEEDS_PARENT} Task not started: permissions grants "sudo ls", which this session may not run itself.`,
      )
      expect(children).toEqual([])
      expect(grants).toEqual([])
    }),
  )

  tool.instance("R3: a planner task with `bun test`: TASK_GRANT_ROLE_DENIED and no child session", () =>
    Effect.gen(function* () {
      for (const [role, command] of [
        ["planner", "bun test"],
        ["data-collector", "bun test"],
        // A read role takes no grant at all, even inside its read class (U4: it never widens it).
        ["planner", "ls"],
        // Role aliases resolve first: task-architect runs as planner.
        ["task-architect", "bun test"],
      ] as const) {
        const { result, children } = yield* runTask(role, { bash: [command] })
        const shownRole = role === "task-architect" ? "planner" : role
        expect([role, command, failure(result)]).toEqual([
          role,
          command,
          expect.stringContaining(
            `${Task.TASK_GRANT_ROLE_DENIED} Task not started: the ${shownRole} role may not run "${command}". Hand it to a coder subagent.`,
          ),
        ])
        expect(children).toEqual([])
      }
    }),
  )

  tool.instance(
    "CHAR-09: a grant never reopens the child's own deny (role or config), even when the parent may run it",
    () =>
      Effect.gen(function* () {
        const { result, children } = yield* runTask("coder", { bash: ["rm build/x"] })
        expect(failure(result)).toContain(`${Task.TASK_GRANT_ROLE_DENIED} Task not started: the coder role may not run "rm build/x".`)
        expect(children).toEqual([])
      }),
    { config: { agent: { coder: { permission: { bash: { "rm *": "deny" } } } } } },
  )

  tool.instance("SR7-04: TASK_GRANT_INVALID for every non-literal form, before any session", () =>
    Effect.gen(function* () {
      const forms = [
        "curl https://*.example.com",
        "ls ?",
        "echo $HOME",
        "curl $(cat url)",
        "echo `id`",
        "cat < x",
        "echo x > y",
        "ls | sh",
        "ls; rm x",
        "ls & rm x",
        "ls && rm x",
        "(ls)",
        "{ ls; }",
        "ls [a]",
        "ls ]",
        "FOO=1 make",
        " PATH=/tmp ls",
        "ls\nrm x",
        "ls\rrm x",
        "ls\u0000",
        "ls\u001b[2J",
        "ls rm",
        "",
        "   ",
        "x".repeat(501),
      ]
      for (const form of forms) {
        const { result, children } = yield* runTask("coder", { bash: [form] })
        expect([JSON.stringify(form).slice(0, 40), failure(result)]).toEqual([
          JSON.stringify(form).slice(0, 40),
          expect.stringContaining(`${Task.TASK_GRANT_INVALID} Task not started: permissions entry `),
        ])
        expect(children).toEqual([])
      }
      // At most 20 entries.
      const many = Array.from({ length: 21 }, (_, index) => `echo ${index}`)
      const { result } = yield* runTask("coder", { bash: many })
      expect(failure(result)).toContain(`${Task.TASK_GRANT_INVALID} Task not started: permissions entry "echo 20"`)
      // One invalid entry refuses the whole task.
      const mixed = yield* runTask("coder", { bash: ["echo ok", "echo $X"] })
      expect(failure(mixed.result)).toContain(Task.TASK_GRANT_INVALID)
      expect(mixed.children).toEqual([])
    }),
  )

  tool.instance("literal forms with quotes, flags and paths are accepted", () =>
    Effect.gen(function* () {
      for (const form of ["sh ./scripts/check.sh", "git status --short", 'grep -n "TODO" src/a.ts', "x".repeat(500)]) {
        expect(Task.taskGrantRefusal({ patterns: [form], role: "coder", parent: [], child: [] })).toBeUndefined()
      }
    }),
  )
})

// ---------------------------------------------------------------------------------------------------------------------
// Part 2: the gate (memory-only grant; consent only; parent's caller kind; X unchanged; one audit line at issue).
// ---------------------------------------------------------------------------------------------------------------------

type Call = { permission: string; category?: string }
const stub = { calls: [] as Call[] }
const decider = Layer.succeed(
  Permission.Decider,
  Permission.Decider.of({
    decide: (input, _root, category) =>
      Effect.suspend(() => {
        stub.calls.push({ permission: input.permission, category })
        return Effect.succeed({ decision: "reject", decidedBy: "agent:main/build", reason: "cannot tell" } as Permission.Decided)
      }),
  }),
)
const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
const gate = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Permission.node,
      Session.node,
      Autonomy.node,
      EventV2Bridge.node,
      SessionProjector.node,
      CrossSpawnSpawner.node,
      InstanceStore.node,
    ]),
    [
      [InstanceStore.bootstrapNode, noopBootstrap],
      [Permission.deciderNode, decider],
    ],
  ),
)

const say = (sessionID: SessionID) =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const message = yield* sessions.updateMessage({
      id: MessageID.ascending(),
      sessionID,
      role: "user",
      time: { created: Date.now() },
      agent: "build",
      model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("free") },
    } satisfies SessionV1.User)
    yield* sessions.updatePart({
      id: PartID.ascending(),
      messageID: message.id,
      sessionID,
      type: "text",
      text: "fix the build",
    } satisfies SessionV1.TextPart)
  })

/** A root with a person's last message, a coder child and a grandchild; consented autonomous mode unless `mode` says. */
const family = (mode: "consent" | "off" = "consent") =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const autonomy = yield* Autonomy.Service
    const root = yield* sessions.create({})
    yield* say(root.id)
    const child = yield* sessions.create({ parentID: root.id, agent: "coder" })
    const grandchild = yield* sessions.create({ parentID: child.id, agent: "coder" })
    if (mode === "consent")
      yield* autonomy.setMode({ scope: "session", root: root.id, on: true, bypassConsent: "bypass-v1", reportLanguage: "en" })
    return { root, child, grandchild }
  })

const bash = (sessionID: SessionID, command: string, directory: string) =>
  Effect.promise(async () => {
    const steps = await readSteps(command, directory)
    return {
      sessionID,
      permission: "bash",
      patterns: [command],
      metadata: { command, workdir: directory, ...(steps ? { steps } : {}) },
      always: ["*"],
      ruleset: [],
      canUndo: true,
      agent: "coder",
    } satisfies PermissionV1.AskInput
  })

const decisions = (root: SessionID) =>
  Effect.gen(function* () {
    const autonomy = yield* Autonomy.Service
    const read = yield* autonomy.readAudit(root)
    return read.lines.flatMap((line) => (line.type === "decision" ? [line] : []))
  })

/** One call: whether it ran, which categories reached the decider, and its line. */
const outcome = (sessionID: SessionID, root: SessionID, command: string, dir: string) =>
  Effect.gen(function* () {
    stub.calls.length = 0
    const permission = yield* Permission.Service
    const exit = yield* permission.ask(yield* bash(sessionID, command, dir)).pipe(Effect.timeout("2 seconds"), Effect.exit)
    const line = (yield* decisions(root)).filter((item) => item.permission === "bash").at(-1)
    return {
      ran: Exit.isSuccess(exit),
      decider: stub.calls.map((call) => call.category),
      category: line?.category,
      via: line?.via,
      error: Exit.isFailure(exit) ? String(Cause.squash(exit.cause)) : undefined,
    }
  })

const grantTask = (child: SessionID, patterns: string[], caller: "root" | "subagent" = "root") =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    yield* permission.grantTask!(child, patterns, caller)
  })

describe("P-01a gate", () => {
  gate.instance("R1: under consent a granted `curl https://example.com` runs with no decider call, via task_grant", () =>
    Effect.gen(function* () {
      const dir = (yield* TestInstance).directory
      const { root, child } = yield* family()
      // Control: without the grant the child's call goes to the main agent (1.2.6 row 6, decided category).
      const before = yield* outcome(child.id, root.id, "curl https://example.com", dir)
      expect(before.decider.length).toBe(1)
      expect(before.ran).toBe(false)
      yield* grantTask(child.id, ["curl https://example.com"])
      const after = yield* outcome(child.id, root.id, "curl https://example.com", dir)
      expect({ ran: after.ran, decider: after.decider, via: after.via }).toEqual({ ran: true, decider: [], via: "task_grant" })
      // Only the exact granted text: another command, or the granted one with more on the line, is not covered.
      const other = yield* outcome(child.id, root.id, "curl https://example.org", dir)
      expect(other.decider.length).toBe(1)
      expect(other.via).not.toBe("task_grant")
    }),
  )

  gate.instance("SR7-04: one audit line at issue, parent and child named, patterns through scrubAssigned", () =>
    Effect.gen(function* () {
      const { root, child } = yield* family()
      const token = "Zq7Hk2Lm9Np4Rs6Tv8Wx1Yb3Cd5Fg0Jh"
      yield* grantTask(child.id, ["curl https://example.com", `deploy --api-key ${token}`])
      const lines = (yield* decisions(root.id)).filter((line) => line.via === "task_grant")
      expect(lines.length).toBe(1)
      const line = lines[0]!
      expect({ sessionID: line.sessionID, permission: line.permission, class: line.class, decision: line.decision }).toEqual({
        sessionID: child.id,
        permission: "task",
        class: "A",
        decision: "allow",
      })
      expect(line.reason).toContain(`parent session ${root.id}`)
      expect(line.patterns[0]).toBe("curl https://example.com")
      expect(JSON.stringify(line)).not.toContain(token)
      // Dropping a grant writes nothing.
      yield* grantTask(child.id, [])
      expect((yield* decisions(root.id)).filter((item) => item.via === "task_grant").length).toBe(1)
    }),
  )

  gate.instance("lifetime: a dropped grant and a grandchild get no grant; a subagent parent passes on only subagent", () =>
    Effect.gen(function* () {
      const dir = (yield* TestInstance).directory
      const { root, child, grandchild } = yield* family()
      yield* grantTask(child.id, ["curl https://example.com"])
      // Never copied to a grandchild: its call still goes to the main agent.
      const below = yield* outcome(grandchild.id, root.id, "curl https://example.com", dir)
      expect(below.decider.length).toBe(1)
      expect(below.via).not.toBe("task_grant")
      // A grant from a subagent parent is "subagent", which is never wider: unchanged.
      yield* grantTask(grandchild.id, ["curl https://example.com"], "subagent")
      const nested = yield* outcome(grandchild.id, root.id, "curl https://example.com", dir)
      expect(nested.decider.length).toBe(1)
      expect(nested.via).not.toBe("task_grant")
      // Ended with the child: dropped, and the call is the main agent's again.
      yield* grantTask(child.id, [])
      const ended = yield* outcome(child.id, root.id, "curl https://example.com", dir)
      expect(ended.decider.length).toBe(1)
      expect(ended.via).not.toBe("task_grant")
    }),
  )

  gate.instance("R4: a grant never opens an X: `git push --force` stays irreversible, an own-API call stays own_api", () =>
    Effect.gen(function* () {
      const dir = (yield* TestInstance).directory
      const { root, child } = yield* family()
      // 1.2.7 row 47k (U10-1, INTENT): a person-only route; a `/session` read now runs under the consent.
      const own = `curl -X PUT http://127.0.0.1:${PORT}/autonomy/mode`
      SelfAddress.add(SELF)
      try {
        yield* grantTask(child.id, ["git push --force", own, "sudo ls"])
        const push = yield* outcome(child.id, root.id, "git push --force", dir)
        expect({ ran: push.ran, decider: push.decider, category: push.category }).toEqual({
          ran: false,
          decider: [],
          category: "irreversible",
        })
        const api = yield* outcome(child.id, root.id, own, dir)
        expect({ ran: api.ran, decider: api.decider, category: api.category }).toEqual({
          ran: false,
          decider: [],
          category: "own_api",
        })
      } finally {
        SelfAddress.remove(SELF)
      }
    }),
  )

  gate.instance("CHAR-04/07/08: a granted call gets exactly the root's answer for a deletion, sudo and a force push", () =>
    Effect.gen(function* () {
      const dir = (yield* TestInstance).directory
      const { root, child } = yield* family()
      const commands = ["rm build/x", "sudo ls", "git push --force"]
      yield* grantTask(child.id, commands)
      for (const command of commands) {
        const asRoot = yield* outcome(root.id, root.id, command, dir)
        const granted = yield* outcome(child.id, root.id, command, dir)
        expect({ command, ran: granted.ran, decider: granted.decider, category: granted.category, error: granted.error }).toEqual({
          command,
          ran: asRoot.ran,
          decider: asRoot.decider,
          category: asRoot.category,
          error: asRoot.error,
        })
        expect([command, granted.ran]).toEqual([command, false])
      }
    }),
  )

  gate.instance("R4: with the mode off a granted `sh ./x.sh` still asks the person", () =>
    Effect.gen(function* () {
      const dir = (yield* TestInstance).directory
      const { child } = yield* family("off")
      yield* grantTask(child.id, ["sh ./x.sh"])
      const permission = yield* Permission.Service
      const fiber = yield* permission
        .ask({ ...(yield* bash(child.id, "sh ./x.sh", dir)), ruleset: Permission.fromConfig({ "*": "ask" }) })
        .pipe(Effect.exit, Effect.forkScoped)
      yield* Effect.sleep("200 millis")
      const asked = yield* permission.list()
      expect(asked.some((item) => item.sessionID === child.id && item.patterns.includes("sh ./x.sh"))).toBe(true)
      expect(stub.calls).toEqual([])
      yield* Fiber.interrupt(fiber)
    }),
  )
})
