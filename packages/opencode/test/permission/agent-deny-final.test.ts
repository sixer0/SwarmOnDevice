import { afterEach, beforeEach, describe, expect } from "bun:test"
import { rmSync } from "node:fs"
import path from "node:path"
import { Cause, Effect, Exit, Fiber, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Agent } from "../../src/agent/agent"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Permission } from "../../src/permission"
import { Autonomy } from "../../src/permission/autonomy"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import { Question } from "../../src/question"
import { SessionID } from "../../src/session/schema"
import { Session } from "../../src/session/session"
import { testEffect } from "../lib/effect"

// Row 164 (1.2.2, S163-01 of research/08_security_impact_subagents.md): a deny from the asking agent's own rules is final
// over a standing "always". Before the fix, evaluate(ruleset, standingRules) matched the "always" last, so an "always" on
// an ordinary edit let planner and data-collector edit code, and an "always" on a task prompt let plan hand work to coder.

const folder = path.join(Global.Path.state, "autonomy")
const trustFile = path.join(Global.Path.state, "trust.json")

const decider = Layer.succeed(
  Permission.Decider,
  Permission.Decider.of({
    decide: () => Effect.succeed({ decision: "allow" as const, decidedBy: "agent:test/stub" }),
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

const clean = () => {
  rmSync(folder, { recursive: true, force: true })
  rmSync(trustFile, { force: true })
}
beforeEach(clean)
afterEach(clean)

type AskIn = PermissionV1.AskInput

// Not a stored session: its root is itself, so a family "always" given here covers every later ask in it.
const S = SessionID.make("ses_row164_family")

const list = Permission.Service.use((svc) => svc.list())
const rules = (name: string) =>
  Agent.Service.use((svc) => svc.get(name)).pipe(
    Effect.map((agent) => {
      if (!agent) throw new Error(`agent ${name} is not registered`)
      return agent.permission
    }),
  )

const waitFor = (count: number) =>
  Effect.gen(function* () {
    for (let i = 0; i < 200; i++) {
      const pending = yield* list
      if (pending.length === count) return pending
      yield* Effect.sleep("5 millis")
    }
    throw new Error(`timed out waiting for ${count} pending request(s)`)
  })

const make = (permission: string, patterns: string[], ruleset: PermissionV1.Ruleset): AskIn => ({
  sessionID: S,
  permission,
  patterns,
  metadata: {},
  always: ["*"],
  ruleset,
})

/** The person answers the one prompt "always", as for an ordinary edit or a task call (always: ["*"]). */
const answerAlways = (input: AskIn) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    const fiber = yield* permission.ask(input).pipe(Effect.forkScoped)
    const [asked] = yield* waitFor(1)
    yield* permission.reply({ requestID: asked!.id, reply: "always" })
    expect(Exit.isSuccess(yield* Fiber.await(fiber))).toBe(true)
    expect(yield* list).toHaveLength(0)
  })

/** "allowed", "denied", or "asked" (a prompt was listed; it is rejected so the next case starts clean). */
const verdict = (input: AskIn) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    const fiber = yield* permission.ask(input).pipe(Effect.forkScoped)
    for (let i = 0; i < 200; i++) {
      const done = fiber.pollUnsafe()
      if (done) {
        if (Exit.isSuccess(done)) return "allowed"
        return Cause.squash(done.cause) instanceof PermissionV1.DeniedError ? "denied" : "failed"
      }
      const pending = yield* list
      if (pending.length === 1) {
        yield* permission.reply({ requestID: pending[0]!.id, reply: "reject" })
        yield* Fiber.await(fiber)
        return "asked"
      }
      yield* Effect.sleep("5 millis")
    }
    return "hung"
  })

describe("S163-01: an agent's own deny is final over a standing always", () => {
  it.instance("planner and data-collector edit after an always on an ordinary edit (SA-04)", () =>
    Effect.gen(function* () {
      const build = yield* rules("build")
      expect(yield* verdict(make("edit", ["src/a.ts"], build))).toBe("asked")
      yield* answerAlways(make("edit", ["src/a.ts"], build))
      // The always works where the agent's rules ask: build and coder now edit without a prompt.
      expect(yield* verdict(make("edit", ["src/b.ts"], build))).toBe("allowed")
      expect(yield* verdict(make("edit", ["src/b.ts"], yield* rules("coder")))).toBe("allowed")
      // ...but never where the agent's own rules deny.
      for (const name of ["planner", "data-collector", "verifier"]) {
        expect(yield* verdict(make("edit", ["src/a.ts"], yield* rules(name)))).toBe("denied")
        expect(yield* verdict(make("edit", ["package.json"], yield* rules(name)))).toBe("denied")
      }
      // The Markdown lane of planner and data-collector asks, and the family's always covers it, as it covers build.
      expect(yield* verdict(make("edit", ["docs/x.md"], yield* rules("planner")))).toBe("allowed")
    }),
  )

  it.instance("plan to coder after an always on a task prompt (SA-07)", () =>
    Effect.gen(function* () {
      const build = yield* rules("build")
      yield* answerAlways(make("task", ["explore"], build))
      expect(yield* verdict(make("task", ["coder"], build))).toBe("allowed")
      // The same session switches to plan: the always given under build does not reopen plan's denies.
      const plan = yield* rules("plan")
      expect(yield* verdict(make("task", ["coder"], plan))).toBe("denied")
      expect(yield* verdict(make("task", ["document-writer"], plan))).toBe("denied")
      expect(yield* verdict(make("task", ["explore"], plan))).toBe("allowed")
    }),
  )

  it.instance("a specialist may not load master-controller after an always on skills (C5)", () =>
    Effect.gen(function* () {
      yield* answerAlways(make("skill", ["some-skill"], [{ permission: "skill", pattern: "*", action: "ask" }]))
      for (const name of ["coder", "planner", "verifier", "data-collector", "document-writer"])
        expect(yield* verdict(make("skill", ["master-controller"], yield* rules(name)))).toBe("denied")
    }),
  )

  it.instance("a plain ruleset deny stays final over a standing allow", () =>
    Effect.gen(function* () {
      const ask: PermissionV1.Ruleset = [{ permission: "bash", pattern: "*", action: "ask" }]
      yield* answerAlways(make("bash", ["make"], ask))
      expect(yield* verdict(make("bash", ["make"], ask))).toBe("allowed")
      const denied: PermissionV1.Ruleset = [...ask, { permission: "bash", pattern: "make*", action: "deny" }]
      expect(yield* verdict(make("bash", ["make"], denied))).toBe("denied")
    }),
  )
})
