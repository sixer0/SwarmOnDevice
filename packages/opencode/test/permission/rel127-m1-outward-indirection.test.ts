// 1.2.7 row 47e (decisions C61, C70; M1 review findings M1-05, M1-06, M1-07, M1-18, and the 47a alias residual). Under the
// person's consent a SUBAGENT's shell call leaves the parity path and goes to the main agent (where "cannot tell" refuses)
// when it sends anyway one level further down than row 29d read:
// - M1-05: a package script that runs a local script file (`./deploy.sh`, `bash scripts/x.sh`) or a Makefile target whose
//   recipe deploys; a script file or recipe that cannot be read in full goes to the decider too (conservative).
// - M1-06: `gh pr create`, `gh release create` (and the other gh write sub-commands); zsh `ztcp`/`zsocket` and
//   `zmodload zsh/net/*` are network for BOTH callers (outward, as curl is).
// - M1-07: named package adds of pip/pip3/`python -m pip`/uv/poetry/cargo/go/gem/composer; lockfile and requirements
//   installs keep parity.
// - M1-18: a P-01a task grant never skips this rule: a granted literal deploy still goes to the decider.
// - Alias residual (47a): a call that defines an alias and uses it later goes to the decider.
// The root's calls are pinned unchanged (except ztcp, which is network for both). Home is a fresh mkdtemp folder
// (os.homedir stubbed); every file is synthetic.
import { afterAll, afterEach, beforeAll, beforeEach, expect, spyOn } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
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

const DEPLOY = "vercel deploy --prod"

/** The synthetic project: package scripts and a Makefile, each one level away from a deploy (or from nothing). */
const project = (dir: string) => {
  const scripts = {
    ship: "./deploy.sh",
    "ship-bash": "bash scripts/x.sh",
    "ship-sh": "sh ./deploy.sh",
    vague: "./vague.sh",
    gone: "./missing.sh",
    al: "alias x=vercel; x deploy --prod",
    "al-ls": "alias ll='ls -la'; ll",
    ok: "./ok.sh",
    "ok-bash": "bash scripts/ok.sh",
  }
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "p", version: "1.0.0", scripts }))
  const file = (name: string, text: string) => {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true })
    writeFileSync(path.join(dir, name), text)
    chmodSync(path.join(dir, name), 0o755)
  }
  file("deploy.sh", `#!/bin/sh\n${DEPLOY}\n`)
  file("scripts/x.sh", `${DEPLOY}\n`)
  // A body the reader cannot read in full (an expansion): what it runs cannot be told.
  file("vague.sh", '#!/bin/sh\n"$DEPLOYER" deploy\n')
  file("ok.sh", "#!/bin/sh\necho hi\n")
  file("scripts/ok.sh", "echo ok\n")
  writeFileSync(
    path.join(dir, "Makefile"),
    [
      "all: deploy",
      "deploy:",
      `\t@${DEPLOY}`,
      "build: compile",
      `\t${DEPLOY}`,
      "compile:",
      "\techo compiled",
      "vague:",
      "\t$(DEPLOYER) deploy",
      "al:",
      "\talias x=vercel; x deploy --prod",
      "ok:",
      "\techo ok",
      "test: ok",
      "\techo tested",
      ".PHONY: all deploy build compile vague al ok test",
      "",
    ].join("\n"),
  )
}

// M1-05: one level of indirection (package script -> local script file; Makefile target -> recipe).
const INDIRECT = [
  "npm run ship",
  "bun run ship",
  "npm run ship-bash",
  "npm run ship-sh",
  "npm run vague",
  "npm run gone",
  "make deploy",
  "make build",
  "make",
  "make vague",
  "make nosuchtarget",
] as const
// M1-06: gh writes the consent lets out for the root (`not_routine`), and zsh's network builtins.
const GH_WRITES = ["gh pr create --fill", "gh release create v1"] as const
const ZSH_NET = [
  "zmodload zsh/net/tcp && ztcp example.com 80",
  "ztcp example.com 80",
  "zmodload zsh/net/socket",
  "zsh -c 'zmodload zsh/net/tcp; ztcp example.com 80'",
] as const
// M1-07: named registry adds outside the JS tools.
const ADDS = [
  "pip install requests",
  "pip3 install requests",
  "python3 -m pip install requests",
  "uv add requests",
  "uv pip install requests",
  "poetry add requests",
  "cargo add serde",
  "go get example.com/x",
  "composer require a/b",
] as const
// Alias residual (47a): an alias defined and used later in the same call, in a package script and in a recipe.
const ALIASES = ["npm run al", "npm run al-ls", "make al"] as const

// RED at HEAD-before (5c0814355d): each runs for a subagent with no decider call.
it.instance(
  "M1-05/06/07/alias: a subagent's indirect deploy, gh write, zsh network, named add or alias goes to the main agent",
  () =>
    Effect.gen(function* () {
      const dir = (yield* TestInstance).directory
      project(dir)
      const { root, child } = yield* family()
      const seen = []
      const all = [...INDIRECT, ...GH_WRITES, ...ZSH_NET, ...ADDS, ...ALIASES]
      for (const command of all) {
        const got = yield* outcome(child.id, root.id, command, dir)
        seen.push([command, got.ran, got.decider, got.via])
      }
      expect(seen).toEqual(all.map((command) => [command, false, 1, "for_subagent"]))
    }),
  { git: true },
)

// RED at HEAD-before: zsh's network builtins were `not_routine` for the root too; now `outward`, as curl is.
it.instance(
  "M1-06: zsh ztcp/zsocket are outward for the root as curl is (runs on the consent, line says outward)",
  () =>
    Effect.gen(function* () {
      const dir = (yield* TestInstance).directory
      project(dir)
      const { root } = yield* family()
      const curl = yield* outcome(root.id, root.id, "curl https://example.com", dir)
      expect(curl.bypassed).toBe("outward")
      for (const command of ZSH_NET) {
        const got = yield* outcome(root.id, root.id, command, dir)
        expect([command, got.ran, got.decider, got.bypassed, got.via]).toEqual([command, true, 0, "outward", "main_agent"])
      }
    }),
  { git: true },
)

// RED at HEAD-before (M1-18): the grant lifted the child to the root, and the deploy ran via task_grant.
it.instance(
  "M1-18: a P-01a grant never skips the outward decider: a granted literal deploy and add still go to the main agent",
  () =>
    Effect.gen(function* () {
      const dir = (yield* TestInstance).directory
      project(dir)
      const { root, child } = yield* family()
      const permission = yield* Permission.Service
      const granted = [DEPLOY, "bun add left-pad", "npm run ship", "pip install requests"]
      yield* permission.grantTask!(child.id, granted, "root")
      for (const command of granted) {
        const got = yield* outcome(child.id, root.id, command, dir)
        expect([command, got.ran, got.decider, got.via]).toEqual([command, false, 1, "for_subagent"])
      }
      // A granted call that sends nothing the rule names still runs on the grant (P-01a unchanged).
      yield* permission.grantTask!(child.id, ["npm run ok"], "root")
      const ok = yield* outcome(child.id, root.id, "npm run ok", dir)
      expect([ok.ran, ok.decider, ok.via]).toEqual([true, 0, "task_grant"])
    }),
  { git: true },
)

// CHAR (pass at HEAD-before and after): the root's same calls run as before, on the consent, no decider call.
it.instance(
  "CHAR: the root's indirect deploys, gh writes, named adds and aliases run as before",
  () =>
    Effect.gen(function* () {
      const dir = (yield* TestInstance).directory
      project(dir)
      const { root } = yield* family()
      const all = [...INDIRECT, ...GH_WRITES, ...ADDS, ...ALIASES]
      const seen = []
      for (const command of all) {
        const got = yield* outcome(root.id, root.id, command, dir)
        seen.push([command, got.ran, got.decider, got.via])
      }
      expect(seen).toEqual(all.map((command) => [command, true, 0, "main_agent"]))
    }),
  { git: true },
)

// CHAR (pass at HEAD-before and after): readable, clean indirections and lockfile installs keep parity for a subagent.
const PARITY = [
  "npm run ok",
  "npm run ok-bash",
  "make ok",
  "make test",
  "pip install -r requirements.txt",
  "uv sync",
  "cargo build",
  "go build",
  "bundle install",
  "composer install",
  "gh pr view 1",
] as const
it.instance(
  "CHAR: a subagent's clean indirections and lockfile installs still run like the root's",
  () =>
    Effect.gen(function* () {
      const dir = (yield* TestInstance).directory
      project(dir)
      const { root, child } = yield* family()
      for (const command of PARITY) {
        const rootGot = yield* outcome(root.id, root.id, command, dir)
        const childGot = yield* outcome(child.id, root.id, command, dir)
        if (rootGot.bypassed === "outward") {
          // `gh pr view` is outward already (decided for a subagent before and after): unchanged.
          expect([command, childGot.decider]).toEqual([command, 1])
          continue
        }
        expect([command, childGot]).toEqual([command, rootGot])
        expect([command, childGot.ran, childGot.decider, childGot.via]).toEqual([command, true, 0, "main_agent"])
      }
    }),
  { git: true },
)
