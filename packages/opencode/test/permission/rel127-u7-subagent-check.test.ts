// 1.2.7 row 29c (U-7, C41, OP-1, SR7-02): under the person's consent a subagent's recognised test or build command (`check`:
// `bun test`, `cargo build`, `make build`, `bun run build`) runs like the root's, with no decider call and the root's line.
// Publishing, pushing, sending, admin rights and a compound with a decided piece keep their 1.2.6 / row 29 handling.
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


const CHECKS = ["bun test", "cargo build", "make build", "bun run build"] as const

// U7-C1 (C41). At 5035575c02 and at 04067a9d02 the root's check runs (A, bypassed `check`, `via main_agent`) while the
// subagent's identical call goes to the decider with `check`, and "cannot tell" refuses it.
it.instance(
  "U7-C1: a subagent's recognised test and build commands run like the root's under consent",
  () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const dir = test.directory
      writeFileSync(path.join(dir, "Makefile"), "build:\n\techo ok\n")
      const { root, child } = yield* family()
      const seen: Array<Record<string, unknown>> = []
      for (const command of CHECKS)
        for (const [who, id] of [
          ["root", root.id],
          ["subagent", child.id],
        ] as const) {
          const got = yield* outcome(id, root.id, command, dir)
          seen.push({ command, who, ...got })
        }
      const ran = { ran: true, decider: [], class: "A", category: "by_main_agent", bypassed: "check", via: "main_agent" }
      expect(seen).toEqual(
        CHECKS.flatMap((command) => [
          { command, who: "root", ...ran },
          { command, who: "subagent", ...ran },
        ]),
      )
      // The subagent's line is the root's, except for the session it ran in.
      const lines = yield* decisions(root.id)
      expect(lines).toHaveLength(CHECKS.length * 2)
      for (let at = 0; at < lines.length; at += 2) {
        const [rootLine, childLine] = [lines[at]!, lines[at + 1]!]
        expect(rootLine.sessionID).toBe(root.id)
        expect(childLine.sessionID).toBe(child.id)
        expect(shape(childLine)).toEqual(shape(rootLine))
        expect(childLine).toMatchObject({ decidedBy: "agent:main/build", decision: "allow", reason: Permission.BYPASS_REASON })
      }
    }),
  { git: true },
)

// CHAR (C41 scope): publishing, pushing and sending stay decided for a subagent ("cannot tell" refuses; the root's runs);
// admin rights and a forced push are refused for both callers alike, with no decider call.
it.instance(
  "CHAR: publish, push, network, sudo and a forced push keep their handling for a subagent",
  () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const dir = test.directory
      const { root, child } = yield* family()
      for (const command of ["npm publish", "git push", "curl https://example.com"]) {
        const rootGot = yield* outcome(root.id, root.id, command, dir)
        const childGot = yield* outcome(child.id, root.id, command, dir)
        expect([command, rootGot.ran, rootGot.decider, rootGot.bypassed]).toEqual([command, true, [], "outward"])
        expect([command, childGot.ran, childGot.decider, childGot.via]).toEqual([command, false, ["outward"], "for_subagent"])
      }
      for (const [command, category] of [
        ["sudo ls", "admin_rights"],
        ["sudo make build", "admin_rights"],
        ["git push --force origin main", undefined],
      ] as const) {
        const rootGot = yield* outcome(root.id, root.id, command, dir)
        const childGot = yield* outcome(child.id, root.id, command, dir)
        expect([command, rootGot.ran, rootGot.decider, rootGot.class]).toEqual([command, false, [], "X"])
        expect([command, childGot]).toEqual([command, rootGot])
        if (category) expect([command, rootGot.category]).toEqual([command, category])
      }
    }),
  { git: true },
)

// CHAR (SR7-02 compound): a check joined with a decided piece reaches the decider in either order for a subagent.
it.instance(
  "CHAR: a check compound with a send reaches the decider for a subagent, in either order",
  () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const dir = test.directory
      const { root, child } = yield* family()
      for (const command of ["bun test && curl https://example.com", "curl https://example.com && bun test", "bun test; git push"]) {
        const got = yield* outcome(child.id, root.id, command, dir)
        expect([command, got.ran, got.decider]).toEqual([command, false, ["outward"]])
      }
    }),
  { git: true },
)
