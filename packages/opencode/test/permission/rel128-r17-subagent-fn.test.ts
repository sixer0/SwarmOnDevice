// 1.2.8 row 28c (AC-R17, N8-318; R-17 PROBE, timebox S). Under the person's consent a SUBAGENT's package script that wraps a
// network call in a shell function and calls it (`f() { curl https://example.com; }; f`, `function f { wget -q ...; }; f`)
// must be flagged like the same inline call: it goes to the main agent (where "cannot tell" refuses), not the parity path.
// A function that only reads (`f() { ls; }; f`) keeps parity. The root's calls are pinned unchanged (CHAR).
// Home is a fresh mkdtemp folder (os.homedir stubbed); every file is synthetic.
import { afterAll, afterEach, beforeAll, beforeEach, expect, spyOn, test } from "bun:test"
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import * as osModule from "node:os"
import path from "node:path"
import { Effect, Exit, Layer } from "effect"
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

let home: string
let spies: { mockRestore(): void }[] = []
beforeAll(() => {
  home = mkdtempSync(path.join(os.tmpdir(), "m1e-"))
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
  stub.answer = CANNOT_TELL
})
afterEach(clean)

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
      agent: "general",
    } satisfies PermissionV1.AskInput
  })

const decisions = (root: SessionID) =>
  Effect.gen(function* () {
    const autonomy = yield* Autonomy.Service
    const read = yield* autonomy.readAudit(root)
    return read.lines.flatMap((line) => (line.type === "decision" ? [line] : []))
  })

/** How one call went: whether it ran, what the decider was asked, and the line's verdict fields. */
const outcome = (sessionID: SessionID, root: SessionID, command: string, dir: string) =>
  Effect.gen(function* () {
    stub.calls.length = 0
    const permission = yield* Permission.Service
    const exit = yield* permission.ask(yield* bash(sessionID, command, dir)).pipe(Effect.timeout("2 seconds"), Effect.exit)
    const line = (yield* decisions(root)).filter((item) => item.permission === "bash").at(-1)
    return {
      ran: Exit.isSuccess(exit),
      decider: stub.calls.length,
      class: line?.class,
      bypassed: line?.bypassed,
      via: line?.via,
    }
  })

const INLINE_CURL = "curl https://example.com"
const SCRIPTS = {
  fn: `f() { ${INLINE_CURL}; }; f`,
  "fn-kw": "function f { wget -q https://example.com; }; f",
  "fn-ls": "f() { ls; }; f",
}
const project = (dir: string) =>
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "p", version: "1.0.0", scripts: SCRIPTS }))

// AC-R17 stays OPEN (row 28c, timebox S exceeded; C-decision proposed in implementation/28c_r17_subagent_fn.md). The
// probe's premise does not hold: at BASE and HEAD a subagent's package script that calls curl WITHOUT a function wrapper
// (`"net": "curl https://example.com"`, `bun run net`) also runs on the parity path with no decider call, because
// `subagentSendsAnyway` flags only deploys, publishes, image pushes, named adds, gh writes and alias/`function` reuse
// (C46, C61), and the screen reads a project script's steps for X triggers only. So "flagged like the inline call" needs
// a network-step rule for every script body a subagent runs (a policy change to C46 parity, and a step-outward predicate
// that `bypass-screen.ts` does not export), not a function-wrapper rule. Observed at BASE (red log 28c_R17_base.log):
// `bun run fn` / `npm run fn` run (0 decider calls), `bun run fn-kw` / `npm run fn-kw` go to the main agent (the 47e
// `function` reuse rule), `bun run net` runs, inline `curl https://example.com` goes to the main agent.
// Flip to a real test when the C-decision opens the fix row: expect each of PROBE to be [false, 1, "for_subagent"].
const PROBE = ["bun run fn", "npm run fn", "bun run fn-kw", "npm run fn-kw"] as const
test.todo(
  `R-17: a subagent's package script that calls a network function (${PROBE.join(", ")}) goes to the main agent like the inline call`,
  () => {},
)

// CHAR (pass at BASE and HEAD): a function that only reads keeps parity; the root's calls run as before.
it.instance(
  "R-17 CHAR: a reading function keeps parity for a subagent; the root's function scripts run as before",
  () =>
    Effect.gen(function* () {
      const dir = (yield* TestInstance).directory
      project(dir)
      const { root, child } = yield* family()
      const rootLs = yield* outcome(root.id, root.id, "bun run fn-ls", dir)
      const childLs = yield* outcome(child.id, root.id, "bun run fn-ls", dir)
      expect([childLs.ran, childLs.decider, childLs.via]).toEqual([true, 0, "main_agent"])
      expect(childLs).toEqual(rootLs)
      for (const command of ["bun run fn", "bun run fn-kw"]) {
        const got = yield* outcome(root.id, root.id, command, dir)
        expect([command, got.ran, got.decider, got.via]).toEqual([command, true, 0, "main_agent"])
      }
    }),
  { git: true },
)
