// 1.2.7 row 29d (U-7, C46, OP-1): under the person's consent a subagent's deploy (the hosted-deploy forms the 1.1.1 rules
// recognise, `vercel deploy --prod`) and an install that adds a named registry package (`bun add`, `npm install <pkg>`,
// `pnpm add`, `yarn add`) leave the parity path and go to the main agent, where "cannot tell" refuses. The root's calls
// run as before; lockfile installs (`bun install`, `npm ci`, `npm install`) and checks (`bun test`) keep parity.
import { afterEach, beforeEach, expect } from "bun:test"
import { chmodSync, existsSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { Cause, Effect, Exit, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Permission } from "../../src/permission"
import { Autonomy } from "../../src/permission/autonomy"
import type { AutonomyDecider } from "../../src/permission/autonomy-decider"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { readSteps } from "../../src/tool/shell"
import { InstanceStore } from "../../src/project/instance-store"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import { Session } from "../../src/session/session"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const folder = path.join(Global.Path.state, "autonomy")

type Call = { permission: string; category?: string; options?: AutonomyDecider.Options }
// The counting seam. The default answer is the decider's "cannot tell" for a subagent (C7): a reject.
const CANNOT_TELL = (): Effect.Effect<Permission.Decided> =>
  Effect.succeed({ decision: "reject", decidedBy: "agent:main/build", reason: "cannot tell" })
const stub = { calls: [] as Call[], answer: CANNOT_TELL }
const decider = Layer.succeed(
  Permission.Decider,
  Permission.Decider.of({
    decide: (input, _root, category, _script, options) =>
      Effect.suspend(() => {
        stub.calls.push({ permission: input.permission, category, options })
        return stub.answer()
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
    ]),
    [
      [InstanceStore.bootstrapNode, noopBootstrap],
      [Permission.deciderNode, decider],
    ],
  ),
)

const clean = () => {
  if (existsSync(folder)) chmodSync(folder, 0o755)
  rmSync(folder, { recursive: true, force: true })
  rmSync(path.join(Global.Path.state, "trust.json"), { force: true })
}
beforeEach(() => {
  clean()
  stub.calls.length = 0
  stub.answer = CANNOT_TELL
})
afterEach(clean)

const say = (sessionID: SessionID, agent = "build") =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const message = yield* sessions.updateMessage({
      id: MessageID.ascending(),
      sessionID,
      role: "user",
      time: { created: Date.now() },
      agent,
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

/** A consented root with a person's last message, and a subagent below it. */
const family = () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const autonomy = yield* Autonomy.Service
    const root = yield* sessions.create({})
    yield* say(root.id)
    const child = yield* sessions.create({ parentID: root.id })
    yield* autonomy.setMode({ scope: "session", root: root.id, on: true, bypassConsent: "bypass-v1", reportLanguage: "en" })
    return { root, child }
  })

/** A shell call as the shell tool asks it: with its own reading of the text (`steps`) and the scripts it hashed. */
const bash = (sessionID: SessionID, command: string, directory: string, extra: Record<string, unknown> = {}) =>
  Effect.promise(async () => {
    const steps = await readSteps(command, directory)
    return {
      sessionID,
      permission: "bash",
      patterns: [command],
      metadata: { command, workdir: directory, ...(steps ? { steps } : {}), ...extra },
      always: ["*"],
      ruleset: [],
      canUndo: true,
      agent: "general",
    } satisfies PermissionV1.AskInput
  })

const settled = (input: PermissionV1.AskInput) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    return yield* permission.ask(input).pipe(Effect.timeout("2 seconds"), Effect.exit)
  })

const failureOf = <A, E>(exit: Exit.Exit<A, E>) => {
  if (Exit.isSuccess(exit)) throw new Error("expected the call to be stopped")
  return Cause.squash(exit.cause)
}

const decisions = (root: SessionID) =>
  Effect.gen(function* () {
    const autonomy = yield* Autonomy.Service
    const read = yield* autonomy.readAudit(root)
    return read.lines.flatMap((line) => (line.type === "decision" ? [line] : []))
  })

/** The fields of a decision line that say how it was decided; `sessionID`, ids, times and the chain's links left out. */
const shape = (line: Record<string, unknown>) => {
  const { sessionID: _s, requestID: _r, messageID: _m, callID: _c, time: _t, at: _a, id: _i, prev: _p, seq: _q, ...rest } = line
  return rest
}

/** How one call went: whether it ran, what the decider was asked, and the line's verdict fields. */
const outcome = (sessionID: SessionID, root: SessionID, command: string, dir: string, extra: Record<string, unknown> = {}) =>
  Effect.gen(function* () {
    stub.calls.length = 0
    const exit = yield* settled(yield* bash(sessionID, command, dir, extra))
    const line = (yield* decisions(root)).at(-1)!
    return {
      ran: Exit.isSuccess(exit),
      decider: stub.calls.map((call) => call.category),
      class: line.class,
      category: line.category,
      bypassed: line.bypassed,
      via: line.via,
    }
  })

const SENDS = [
  "vercel deploy --prod",
  "vercel --prod",
  "npx vercel deploy --prod",
  "bun add left-pad",
  "bun add -d left-pad",
  "npm install left-pad",
  "npm i --save-dev left-pad",
  "pnpm add left-pad",
  "yarn add left-pad",
  "bun add left-pad && bun test",
  "bun test && bun add left-pad",
  "sh -c 'bun add left-pad'",
] as const
const LOCAL = ["bun install", "npm ci", "npm install", "bun test"] as const

const project = (dir: string) => writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "p", version: "1.0.0" }))

// U7-D1 (C46). At 96ff87e304 a subagent's deploy and registry add run with no decider call, like the root's.
it.instance(
  "U7-D1: a subagent's deploy and registry add go to the main agent; cannot tell refuses",
  () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const dir = test.directory
      project(dir)
      const { root, child } = yield* family()
      const seen = []
      for (const command of SENDS) {
        const got = yield* outcome(child.id, root.id, command, dir)
        seen.push([command, got.ran, got.decider.length, got.via])
      }
      expect(seen).toEqual(SENDS.map((command) => [command, false, 1, "for_subagent"]))
    }),
  { git: true },
)

// CHAR (C46 root unchanged): the root's same calls run on the consent with no decider call, `via main_agent`.
it.instance(
  "CHAR: the root's deploy and registry add run as before",
  () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const dir = test.directory
      project(dir)
      const { root } = yield* family()
      const seen = []
      for (const command of SENDS) {
        const got = yield* outcome(root.id, root.id, command, dir)
        seen.push([command, got.ran, got.decider, got.class, got.via])
      }
      expect(seen).toEqual(SENDS.map((command) => [command, true, [], "A", "main_agent"]))
    }),
  { git: true },
)

// CHAR (C46 lockfile installs and checks keep parity): a subagent's line equals the root's, no decider call.
it.instance(
  "CHAR: a subagent's lockfile installs and checks still run like the root's",
  () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const dir = test.directory
      project(dir)
      const { root, child } = yield* family()
      for (const command of LOCAL) {
        const rootGot = yield* outcome(root.id, root.id, command, dir)
        const childGot = yield* outcome(child.id, root.id, command, dir)
        expect([command, childGot]).toEqual([command, rootGot])
        expect([command, childGot.ran, childGot.decider, childGot.via]).toEqual([command, true, [], "main_agent"])
      }
    }),
  { git: true },
)
