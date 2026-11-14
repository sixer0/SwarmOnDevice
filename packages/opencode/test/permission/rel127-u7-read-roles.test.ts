// 1.2.7 row 29e (AC-U7 U7-R2/U7-R3, decision U4, 01b 5.1 Part B): the read roles (planner, data-collector) get the read
// and diagnostic shell only. The shell tool is visible to them; a read-class call takes the same path as any subagent's
// (mode off: the person is asked; consented mode: it runs), and every other command is refused by the role check that
// runs first in `Permission.ask`, with the text that names the substitute (N7-054). Neither a person's "always", a P-01a
// task grant nor `agent.<role>.permission.bash: "allow"` in user config reopens it.
//
// End to end at the permission service: the real agents' rulesets (Agent.Service), real sessions, the real autonomous
// mode store and consent, the shell's own reading of each command (`readSteps`). Home is a fresh mkdtemp folder with
// `os.homedir` stubbed (row 29d method).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn } from "bun:test"
import { execFileSync } from "node:child_process"
import { chmodSync, existsSync, mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import * as osModule from "node:os"
import path from "node:path"
import { Cause, Effect, Exit, Fiber, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { Agent } from "../../src/agent/agent"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Permission } from "../../src/permission"
import { Autonomy } from "../../src/permission/autonomy"
import { AutonomyTable } from "../../src/permission/autonomy-table"
import { ROLE_SHELL_OUTSIDE_READ_TEXT } from "../../src/permission/autonomy-texts"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import { Question } from "../../src/question"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import { Session } from "../../src/session/session"
import { readSteps } from "../../src/tool/shell"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const folder = path.join(Global.Path.state, "autonomy")

// The decider must never be asked for a read role's call: a read-class call runs as the gate's own A line, and anything
// else is refused before the gate. Its "cannot tell" refuses, so a call that reached it would show as refused.
const stub = { calls: [] as string[] }
const decider = Layer.succeed(
  Permission.Decider,
  Permission.Decider.of({
    decide: (input, _root, category) =>
      Effect.sync(() => {
        stub.calls.push(`${input.permission}:${category}`)
        return { decision: "reject" as const, decidedBy: "agent:main/build", reason: "cannot tell" }
      }),
  }),
)
const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Agent.node,
      Permission.node,
      Session.node,
      Autonomy.node,
      EventV2Bridge.node,
      SessionProjector.node,
      CrossSpawnSpawner.node,
      InstanceStore.node,
      Question.node,
    ]),
    [
      [InstanceStore.bootstrapNode, noopBootstrap],
      [Permission.deciderNode, decider],
    ],
  ),
)

let home = ""
let spies: { mockRestore(): void }[] = []
beforeAll(() => {
  home = mkdtempSync(path.join(os.tmpdir(), "u4w-"))
  spies = [spyOn(os, "homedir").mockReturnValue(home), spyOn(osModule, "homedir").mockReturnValue(home)]
})
afterAll(() => {
  for (const spy of spies) spy.mockRestore()
  rmSync(home, { recursive: true, force: true })
})
const clean = () => {
  if (existsSync(folder)) chmodSync(folder, 0o755)
  rmSync(folder, { recursive: true, force: true })
  rmSync(path.join(Global.Path.state, "trust.json"), { force: true })
}
beforeEach(() => {
  clean()
  stub.calls.length = 0
})
afterEach(clean)

const ROLES = ["planner", "data-collector"] as const
const READS = ["git log -1", "ls", "pdftotext a.pdf -"] as const
// U7-R3 boundary set from the row brief and 01b 5.1: tests, writes, network, scripts, installs, repo-changing git.
const OUTSIDE = [
  "bun test",
  "pdftotext a.pdf",
  "echo x > f",
  "curl https://example.com",
  "sh -c 'ls'",
  "npm i",
  "git commit -m x",
  "unzip x.zip",
  "graft build .",
] as const

const rulesOf = (name: string) =>
  Agent.Service.use((svc) => svc.get(name)).pipe(
    Effect.map((agent) => {
      if (!agent) throw new Error(`agent ${name} is not registered`)
      return agent.permission
    }),
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
      text: "look at the project",
    } satisfies SessionV1.TextPart)
  })

/** A root with a person's last message and a subagent session below it. Mode off until `consent` is called. */
const family = () =>
  Effect.gen(function* () {
    // The fixture sets keys `GitGuard` refuses (as autonomy-table.test.ts notes), so git looks are vetted here.
    const directory = (yield* TestInstance).directory
    for (const key of ["core.fsmonitor", "commit.gpgsign"])
      try {
        execFileSync("git", ["config", "--unset", key], { cwd: directory })
      } catch {
        // Not set in this folder: nothing to unset.
      }
    const sessions = yield* Session.Service
    const root = yield* sessions.create({})
    yield* say(root.id)
    const child = yield* sessions.create({ parentID: root.id })
    return { root, child }
  })
const consent = (root: SessionID) =>
  Autonomy.Service.use((autonomy) =>
    autonomy.setMode({ scope: "session", root, on: true, bypassConsent: "bypass-v1", reportLanguage: "en" }),
  )

/** A shell call as the shell tool asks it, by `agent`, with that agent's own ruleset. */
const bash = (sessionID: SessionID, agent: string, command: string) =>
  Effect.gen(function* () {
    const directory = (yield* TestInstance).directory
    const steps = yield* Effect.promise(() => readSteps(command, directory))
    return {
      sessionID,
      permission: "bash",
      patterns: [command],
      metadata: { command, workdir: directory, ...(steps ? { steps } : {}) },
      always: ["*"],
      ruleset: yield* rulesOf(agent),
      canUndo: true,
      agent,
    } satisfies PermissionV1.AskInput
  })

type Outcome = { verdict: "ran" | "asked" | "refused" | "denied" | "failed" | "hung"; message?: string }

/** How one call went: ran, asked the person (the prompt is rejected so the next case starts clean), or refused. */
const outcome = (input: PermissionV1.AskInput) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    const fiber = yield* permission.ask(input).pipe(Effect.forkScoped)
    for (let i = 0; i < 400; i++) {
      const done = fiber.pollUnsafe()
      if (done) {
        if (Exit.isSuccess(done)) return { verdict: "ran" } as Outcome
        const error = Cause.squash(done.cause)
        if (!(error instanceof PermissionV1.DeniedError)) return { verdict: "failed", message: String(error) } as Outcome
        return {
          verdict: error.message === ROLE_SHELL_OUTSIDE_READ_TEXT ? "refused" : "denied",
          message: error.message,
        } as Outcome
      }
      const pending = yield* permission.list()
      if (pending.length === 1) {
        yield* permission.reply({ requestID: pending[0]!.id, reply: "reject" })
        yield* Fiber.await(fiber)
        return { verdict: "asked" } as Outcome
      }
      yield* Effect.sleep("5 millis")
    }
    return { verdict: "hung" } as Outcome
  })

const run = (sessionID: SessionID, agent: string, command: string) =>
  Effect.gen(function* () {
    return { agent, command, ...(yield* outcome(yield* bash(sessionID, agent, command))) }
  })

// `git log` is a look only inside a repository the guard vets, so every test folder is one.
const GIT = { git: true }
const REFUSED = { verdict: "refused" as const, message: ROLE_SHELL_OUTSIDE_READ_TEXT }

describe("U7-R2: the read roles see the shell", () => {
  it.instance("bash is visible for planner and data-collector, and READ_SHELL_ROLES is re-exported by the agent module", () =>
    Effect.gen(function* () {
      expect([...Agent.READ_SHELL_ROLES].sort()).toEqual(["data-collector", "planner"])
      expect(Agent.READ_SHELL_ROLES).toBe(AutonomyTable.READ_SHELL_ROLES)
      for (const role of ROLES) {
        const rules = yield* rulesOf(role)
        expect({ role, hidden: Permission.disabled(["bash"], rules).has("bash") }).toEqual({ role, hidden: false })
        // The baseline's bash gates apply again: sudo stays denied, the rest asks.
        expect(Permission.evaluate("bash", "sudo ls", rules).action).toBe("deny")
        expect(Permission.evaluate("bash", "ls", rules).action).toBe("ask")
      }
      // 1.2.8 AC-HN1 (INTENT, N8-391): the text names the final-message route, not a coder subagent.
      expect(ROLE_SHELL_OUTSIDE_READ_TEXT).toContain("final message")
    }),
    GIT,
  )
})

describe("U7-R2/R3 consented autonomous mode: the read class runs, everything else is refused with N7-054", () => {
  it.instance("planner and data-collector subagents", () =>
    Effect.gen(function* () {
      const { root, child } = yield* family()
      yield* consent(root.id)
      const seen: unknown[] = []
      for (const role of ROLES) {
        for (const command of READS) seen.push(yield* run(child.id, role, command))
        for (const command of OUTSIDE) seen.push(yield* run(child.id, role, command))
      }
      expect(seen).toEqual(
        ROLES.flatMap((agent) => [
          ...READS.map((command) => ({ agent, command, verdict: "ran" })),
          ...OUTSIDE.map((command) => ({ agent, command, ...REFUSED })),
        ]),
      )
      // Nothing reached the main agent: the read class is the gate's own A, the rest is refused before the gate.
      expect(stub.calls).toEqual([])
      // The refusal leaves one line in the audit, as a shipped rule's deny.
      const audit = yield* Autonomy.Service.use((autonomy) => autonomy.readAudit(root.id))
      const refusals = audit.lines.filter(
        (line) => line.type === "decision" && line.class === "X" && line.decidedBy === "system:shipped_rule",
      )
      expect(refusals).toHaveLength(ROLES.length * OUTSIDE.length)
    }),
    GIT,
  )
})

describe("U7-R3 mode off: the read class asks the person, like any subagent; the rest is refused at once", () => {
  it.instance("planner and data-collector subagents", () =>
    Effect.gen(function* () {
      const { child } = yield* family()
      const seen: unknown[] = []
      for (const role of ROLES) {
        for (const command of READS) seen.push(yield* run(child.id, role, command))
        for (const command of OUTSIDE) seen.push(yield* run(child.id, role, command))
      }
      expect(seen).toEqual(
        ROLES.flatMap((agent) => [
          ...READS.map((command) => ({ agent, command, verdict: "asked" })),
          ...OUTSIDE.map((command) => ({ agent, command, ...REFUSED })),
        ]),
      )
      // Same answer as a coder for the same read-class command (01b section 4 note).
      expect(yield* run(child.id, "coder", "ls")).toEqual({ agent: "coder", command: "ls", verdict: "asked" })
    }),
    GIT,
  )
})

describe("U7-R3: nothing reopens the role check", () => {
  it.instance("a person's always for `bun test` in that session, in mode off and then under consent", () =>
    Effect.gen(function* () {
      const permission = yield* Permission.Service
      const { root, child } = yield* family()
      // The person answers "always" to a coder's `bun test` in the same family.
      const fiber = yield* permission.ask(yield* bash(child.id, "coder", "bun test")).pipe(Effect.forkScoped)
      for (let i = 0; i < 400 && (yield* permission.list()).length === 0; i++) yield* Effect.sleep("5 millis")
      const [asked] = yield* permission.list()
      yield* permission.reply({ requestID: asked!.id, reply: "always" })
      expect(Exit.isSuccess(yield* Fiber.await(fiber))).toBe(true)
      // The always is real: the coder's next `bun test` runs without a prompt.
      expect(yield* run(child.id, "coder", "bun test")).toEqual({ agent: "coder", command: "bun test", verdict: "ran" })
      for (const role of ROLES) {
        expect(yield* run(child.id, role, "bun test")).toEqual({ agent: role, command: "bun test", ...REFUSED })
        expect(yield* run(root.id, role, "bun test")).toEqual({ agent: role, command: "bun test", ...REFUSED })
      }
      yield* consent(root.id)
      for (const role of ROLES)
        expect(yield* run(child.id, role, "bun test")).toEqual({ agent: role, command: "bun test", ...REFUSED })
    }),
    GIT,
  )

  it.instance("a P-01a task grant and a one-call grant for the exact command, under consent", () =>
    Effect.gen(function* () {
      const permission = yield* Permission.Service
      const { root, child } = yield* family()
      yield* consent(root.id)
      yield* permission.grantTask!(child.id, ["bun test", "sh -c 'ls'", "curl https://example.com"], "root")
      for (const role of ROLES)
        for (const command of ["bun test", "sh -c 'ls'", "curl https://example.com"]) {
          yield* permission.grant({ sessionID: child.id, permission: "bash", patterns: [command] })
          expect(yield* run(child.id, role, command)).toEqual({ agent: role, command, ...REFUSED })
        }
      expect(stub.calls).toEqual([])
    }),
    GIT,
  )

  it.instance(
    "user config `agent.<role>.permission.bash: allow`: the read class runs without a prompt, the rest is still refused",
    () =>
      Effect.gen(function* () {
        const { child } = yield* family()
        for (const role of ROLES) {
          expect(yield* run(child.id, role, "ls")).toEqual({ agent: role, command: "ls", verdict: "ran" })
          for (const command of ["bun test", "echo x > f", "sh -c 'ls'"])
            expect(yield* run(child.id, role, command)).toEqual({ agent: role, command, ...REFUSED })
        }
      }),
    {
      git: true,
      config: {
        agent: {
          planner: { permission: { bash: "allow" } },
          "data-collector": { permission: { bash: "allow" } },
        },
      },
    },
  )
})

describe("other agents are untouched by the role check", () => {
  it.instance("a coder's `bun test` under consent is not refused with N7-054", () =>
    Effect.gen(function* () {
      const { root, child } = yield* family()
      yield* consent(root.id)
      const got = yield* run(child.id, "coder", "bun test")
      expect(got.message).not.toBe(ROLE_SHELL_OUTSIDE_READ_TEXT)
    }),
    GIT,
  )
})
