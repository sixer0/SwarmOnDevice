// 1.2.8 row 28c (AC-R17, N8-318; R-17 PROBE, timebox S). Under the person's consent a SUBAGENT's package script that wraps a
// network call in a shell function and calls it (`f() { curl https://example.com; }; f`, `function f { wget -q ...; }; f`)
// must be flagged like the same inline call: it goes to the main agent (where "cannot tell" refuses), not the parity path.
// A function that only reads (`f() { ls; }; f`) keeps parity. The root's calls are pinned unchanged (CHAR).
// Row 28e (C68 option b) widened it: any network step inside a script body a subagent runs, wrapped or not.
// Home is a fresh mkdtemp folder (os.homedir stubbed); every file is synthetic.
import { afterAll, afterEach, beforeAll, beforeEach, expect, spyOn } from "bun:test"
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
const INLINE_LOCAL = "curl -s http://127.0.0.1:4321/health"
const SCRIPTS = {
  fn: `f() { ${INLINE_CURL}; }; f`,
  "fn-kw": "function f { wget -q https://example.com; }; f",
  "fn-ls": "f() { ls; }; f",
  net: INLINE_CURL,
  "net-step": `echo start && ${INLINE_CURL}`,
  "net-file": "sh ./net.sh",
  "net-nested": "bun run net",
  local: INLINE_LOCAL,
  build: "echo build",
}
const project = (dir: string) => {
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "p", version: "1.0.0", scripts: SCRIPTS }))
  writeFileSync(path.join(dir, "net.sh"), `#!/bin/sh\necho fetching\n${INLINE_CURL}\n`)
}

// 1.2.8 row 28e (C68 option b, N8-318 flipped from todo): a network step inside a package script a subagent runs is
// judged as the same call written inline: it goes to the main agent (the subagent decider), not the parity path. The
// plain body (`bun run net`, `npm run net`), a step of a longer body, a script file the body runs (`sh ./net.sh`), a script
// that runs another by name, and both function wrappers (`f() {...}; f`, `function f {...}; f`).
const PROBE = [
  "bun run fn",
  "npm run fn",
  "bun run fn-kw",
  "npm run fn-kw",
  "bun run net",
  "npm run net",
  "bun run net-step",
  "bun run net-file",
  "bun run net-nested",
] as const
it.instance(
  `R-17: a subagent's package script that calls the network (${PROBE.join(", ")}) goes to the main agent like the inline call`,
  () =>
    Effect.gen(function* () {
      const dir = (yield* TestInstance).directory
      project(dir)
      const { root, child } = yield* family()
      const inline = yield* outcome(child.id, root.id, INLINE_CURL, dir)
      expect([inline.ran, inline.decider, inline.via]).toEqual([false, 1, "for_subagent"])
      for (const command of PROBE) {
        const got = yield* outcome(child.id, root.id, command, dir)
        expect([command, got.ran, got.decider, got.via]).toEqual([command, inline.ran, inline.decider, inline.via])
      }
    }),
  { git: true },
)

// CHAR (C46): a send the person's consent lets out (a local host) keeps the inline call's answer inside a script too, and
// a script with no network step keeps parity.
it.instance(
  "R-17 CHAR: a script's local send and a script with no network step are judged as the inline call and keep parity",
  () =>
    Effect.gen(function* () {
      const dir = (yield* TestInstance).directory
      project(dir)
      const { root, child } = yield* family()
      const inline = yield* outcome(child.id, root.id, INLINE_LOCAL, dir)
      const script = yield* outcome(child.id, root.id, "bun run local", dir)
      expect([script.ran, script.decider]).toEqual([inline.ran, inline.decider])
      const build = yield* outcome(child.id, root.id, "bun run build", dir)
      expect([build.ran, build.decider, build.via]).toEqual([true, 0, "main_agent"])
    }),
  { git: true },
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
      for (const command of ["bun run fn", "bun run fn-kw", "bun run net", "bun run net-file"]) {
        const got = yield* outcome(root.id, root.id, command, dir)
        expect([command, got.ran, got.decider, got.via]).toEqual([command, true, 0, "main_agent"])
      }
    }),
  { git: true },
)
