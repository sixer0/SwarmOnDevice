// 1.2.7 row 47j (user decision U9, controller C76; supersedes the matching parts of C61/C70/C59 and SR7-01). Consent given
// when autonomous mode is switched on covers these, for the main agent and its subagents alike (parity), so they are no
// longer refused:
// - U9-2: a read program's option that runs a program (`rg --pre`, `diff -l`, `file -z`, `git cat-file --filters`,
//   `--show-signature`, signature placeholders) leaves the read class and runs as a program under the consent rules.
// - U9-3: every graft sub-command runs under the consent except `graft init` (machine-wide configuration), refused for
//   both callers. A read role (planner, data-collector) gets graft queries with or without `--no-refresh`, never build/init.
// - U9-5: zsh's network builtins are judged exactly as curl is for the same destination (no block beyond curl's): a local
//   host runs for both callers, a remote one runs on the root's consent and goes to the main agent for a subagent.
// - U9-6: a content search over folders holding Swarm's state (`rg x ~`, `grep -r x ~/.config`) runs under the consent;
//   a search of a state FILE, a write there, and a read role's search stay refused (X app_state). Masking: 47j shell test.
// - U9-9: zsh `print x >| f` (checkpointed in `rel127-47h-clobber-checkpoint`), here: it is no refusal under consent.
// With autonomous mode off every one of them still asks the person (nothing runs, no decider call).
// Home is a fresh mkdtemp folder (os.homedir stubbed), Swarm's config folder in it is the test's; every file is synthetic.
import { afterAll, afterEach, beforeAll, beforeEach, expect, spyOn } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import * as osModule from "node:os"
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
import { Permission, RoleShellRefusedError } from "../../src/permission"
import { Autonomy } from "../../src/permission/autonomy"
import { AutonomyTable } from "../../src/permission/autonomy-table"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { readSteps } from "../../src/tool/shell"
import { InstanceStore } from "../../src/project/instance-store"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import { Session } from "../../src/session/session"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const folder = path.join(Global.Path.state, "autonomy")

// The counting seam. The default answer is the decider's "cannot tell" for a subagent (C7): a reject.
const CANNOT_TELL = (): Effect.Effect<Permission.Decided> =>
  Effect.succeed({ decision: "reject", decidedBy: "agent:main/build", reason: "cannot tell" })
const stub = { calls: 0 }
const decider = Layer.succeed(
  Permission.Decider,
  Permission.Decider.of({
    decide: () =>
      Effect.suspend(() => {
        stub.calls++
        return CANNOT_TELL()
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
let homeConfig: string
let spies: { mockRestore(): void }[] = []
const savedConfigDir = process.env.SWARM_CONFIG_DIR
beforeAll(() => {
  home = mkdtempSync(path.join(os.tmpdir(), "u9-"))
  spies = [spyOn(os, "homedir").mockReturnValue(home), spyOn(osModule, "homedir").mockReturnValue(home)]
  // A Swarm config folder in the home folder, as the person's would be (SWARM_CONFIG_DIR is one of the app-state roots).
  homeConfig = path.join(home, ".config", "swarm")
  mkdirSync(homeConfig, { recursive: true })
  writeFileSync(path.join(homeConfig, "secret.env"), "PASSWORD=Synthetic47jValue9\n")
  process.env.SWARM_CONFIG_DIR = homeConfig
})
afterAll(() => {
  for (const spy of spies) spy.mockRestore()
  if (savedConfigDir === undefined) delete process.env.SWARM_CONFIG_DIR
  else process.env.SWARM_CONFIG_DIR = savedConfigDir
  rmSync(home, { recursive: true, force: true })
})

const clean = () => {
  if (existsSync(folder)) chmodSync(folder, 0o755)
  rmSync(folder, { recursive: true, force: true })
  rmSync(path.join(Global.Path.state, "trust.json"), { force: true })
}
beforeEach(() => {
  clean()
  stub.calls = 0
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
      text: "look into the build",
    } satisfies SessionV1.TextPart)
  })

/** A root with a person's last message and a subagent below it; consented autonomous mode when `on`, else mode off. */
const family = (on: boolean) =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const autonomy = yield* Autonomy.Service
    const root = yield* sessions.create({})
    yield* say(root.id)
    const child = yield* sessions.create({ parentID: root.id })
    if (on) yield* autonomy.setMode({ scope: "session", root: root.id, on: true, bypassConsent: "bypass-v1", reportLanguage: "en" })
    return { root, child }
  })

const bash = (sessionID: SessionID, command: string, directory: string, agent: string) =>
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
      agent,
    } satisfies PermissionV1.AskInput
  })

type Outcome = { ran: boolean; decider: number; role?: boolean }
/** How one call went: whether the gate let it run, how often the main agent was asked, and whether the role check refused. */
const outcome = (sessionID: SessionID, command: string, dir: string, agent = "general", wait: "2 seconds" | "300 millis" = "2 seconds") =>
  Effect.gen(function* () {
    stub.calls = 0
    const permission = yield* Permission.Service
    const exit = yield* permission.ask(yield* bash(sessionID, command, dir, agent)).pipe(Effect.timeout(wait), Effect.exit)
    const role = Exit.isFailure(exit) && Cause.squash(exit.cause) instanceof RoleShellRefusedError
    return { ran: Exit.isSuccess(exit), decider: stub.calls, ...(role && { role }) } as Outcome
  })

const files = (dir: string) => {
  for (const name of ["a.md", "b.md", "f", "notes.txt"]) writeFileSync(path.join(dir, name), "foo\n")
}

const RAN = { ran: true, decider: 0 }

// U9-2 (supersedes 47a's refusal for these callers): each runs on the consent for the root and for a subagent.
const READ_EXEC = [
  "rg --pre ./marker.sh foo f",
  "rg --hostname-bin=./marker.sh foo f",
  "rg --search-zip foo f",
  "diff -l a.md b.md",
  "file -z f",
  "git cat-file --filters HEAD:a.md",
  "git log --show-signature -1",
  "git log --pretty=format:%GS -1",
] as const
// U9-3.
const GRAFT_RUNS = ["graft ask where", "graft map", "graft build .", "graft blast --name", "graft callers classify -d all"] as const
const GRAFT_INIT = ["graft init", "rtk graft init", "graft init --force"] as const
// U9-5: each zsh form beside the curl call to the same destination.
const ZSH_NET: readonly (readonly [string, string])[] = [
  ["ztcp localhost 3999", "curl http://localhost:3999"],
  ["ztcp 127.0.0.1 3999", "curl http://127.0.0.1:3999"],
  ["zmodload zsh/net/tcp && ztcp localhost 3999", "curl http://localhost:3999"],
  ["zftp open localhost", "curl http://localhost"],
  ["ztcp example.com 80", "curl http://example.com:80"],
  ["zmodload zsh/net/tcp && ztcp example.com 80", "curl http://example.com:80"],
  ["zftp open example.com", "curl http://example.com"],
]
// U9-6: content searches over folders that hold Swarm's state.
const STATE_SEARCH = ["rg PASSWORD ~", "rg -c PASSWORD ~/.config", "grep -r PASSWORD ~/.config", "rg PASSWORD ~ | head -5"] as const
// What stays X app_state for every caller: a state FILE, a write there, a search beside a deletion of state.
const STATE_STAYS = [
  "grep PASSWORD ~/.config/swarm/secret.env",
  "grep -c PASSWORD ~/.config/swarm/secret.env",
  "rg PASSWORD ~ > ~/.config/swarm/out.txt",
  "grep -r PASSWORD ~/.config; rm -rf ~/.config/swarm",
  "cat ~/.con*/swarm/secret.env",
] as const

it.instance(
  "U9-2: a read option that runs a program runs on the consent, root and subagent alike (never as a read)",
  () =>
    Effect.gen(function* () {
      const dir = (yield* TestInstance).directory
      files(dir)
      const { root, child } = yield* family(true)
      const seen = []
      for (const command of READ_EXEC)
        seen.push([command, yield* outcome(root.id, command, dir), yield* outcome(child.id, command, dir)])
      expect(seen).toEqual(READ_EXEC.map((command) => [command, RAN, RAN]))
      // It left the read class: the U4 roles never get it, and the table never calls it a read.
      for (const command of READ_EXEC) expect([command, AutonomyTable.isReadOnlyShell(command, dir, { directory: dir, worktree: dir, project: { vcs: "git" } } as never)]).toEqual([command, false])
    }),
  { git: true },
)

it.instance(
  "U9-3: every graft sub-command runs on the consent except `graft init`, refused for root and subagent",
  () =>
    Effect.gen(function* () {
      const dir = (yield* TestInstance).directory
      const { root, child } = yield* family(true)
      for (const command of GRAFT_RUNS) {
        expect([command, yield* outcome(root.id, command, dir)]).toEqual([command, RAN])
        expect([command, yield* outcome(child.id, command, dir)]).toEqual([command, RAN])
      }
      for (const command of GRAFT_INIT) {
        expect([command, yield* outcome(root.id, command, dir)]).toEqual([command, { ran: false, decider: 0 }])
        expect([command, yield* outcome(child.id, command, dir)]).toEqual([command, { ran: false, decider: 0 }])
      }
    }),
  { git: true },
)

it.instance(
  "U9-3: a read role gets graft queries with or without --no-refresh; build and init stay refused by the role check",
  () =>
    Effect.gen(function* () {
      const dir = (yield* TestInstance).directory
      const { child } = yield* family(true)
      for (const agent of ["planner", "data-collector"]) {
        for (const command of ["graft ask where", "graft ask where --no-refresh", "graft callers classify --direction in", "graft map"])
          expect([agent, command, yield* outcome(child.id, command, dir, agent)]).toEqual([agent, command, RAN])
        for (const command of ["graft build .", "graft init", "graft ask x --pr-author someone"])
          expect([agent, command, yield* outcome(child.id, command, dir, agent)]).toEqual([
            agent,
            command,
            { ran: false, decider: 0, role: true },
          ])
      }
    }),
  { git: true },
)

it.instance(
  "U9-5: zsh's network builtins are judged as curl to the same destination, root and subagent",
  () =>
    Effect.gen(function* () {
      const dir = (yield* TestInstance).directory
      const { root, child } = yield* family(true)
      for (const [zsh, curl] of ZSH_NET) {
        for (const session of [root.id, child.id]) {
          const asCurl = yield* outcome(session, curl, dir)
          const asZsh = yield* outcome(session, zsh, dir)
          expect({ zsh, caller: session === root.id ? "root" : "subagent", got: asZsh }).toEqual({
            zsh,
            caller: session === root.id ? "root" : "subagent",
            got: asCurl,
          })
        }
      }
      // What that parity means: local runs for both, remote runs on the root's consent and is the main agent's for a child.
      expect(yield* outcome(child.id, "ztcp localhost 3999", dir)).toEqual(RAN)
      expect(yield* outcome(root.id, "ztcp example.com 80", dir)).toEqual(RAN)
      expect(yield* outcome(child.id, "ztcp example.com 80", dir)).toEqual({ ran: false, decider: 1 })
      // Loading the module alone sends nothing.
      expect(yield* outcome(child.id, "zmodload zsh/net/tcp", dir)).toEqual(RAN)
    }),
  { git: true },
)

it.instance(
  "U9-6: a content search over folders holding Swarm's state runs on the consent, root and subagent; a state file stays refused",
  () =>
    Effect.gen(function* () {
      const dir = (yield* TestInstance).directory
      const { root, child } = yield* family(true)
      for (const command of STATE_SEARCH) {
        expect([command, yield* outcome(root.id, command, dir)]).toEqual([command, RAN])
        expect([command, yield* outcome(child.id, command, dir)]).toEqual([command, RAN])
        expect([command, yield* outcome(root.id, command.replaceAll("~", home), dir)]).toEqual([command, RAN])
      }
      for (const command of STATE_STAYS)
        for (const session of [root.id, child.id])
          expect([command, yield* outcome(session, command, dir)]).toEqual([command, { ran: false, decider: 0 }])
    }),
  { git: true },
)

it.instance(
  "U9-6 / U4: a read role's search over Swarm's state stays refused under the consent",
  () =>
    Effect.gen(function* () {
      const dir = (yield* TestInstance).directory
      const { child } = yield* family(true)
      for (const agent of ["planner", "data-collector"])
        for (const command of ["rg PASSWORD ~", "rg -c PASSWORD ~/.config"])
          expect([agent, command, yield* outcome(child.id, command, dir, agent)]).toEqual([agent, command, { ran: false, decider: 0 }])
      // U9-2 for a read role: a program-running option is outside its read class.
      expect(yield* outcome(child.id, "rg --pre ./marker.sh foo f", dir, "planner")).toEqual({ ran: false, decider: 0, role: true })
    }),
  { git: true },
)

it.instance(
  "U9-9: zsh `print x >| f` is no refusal under the consent (the shell checkpoints it where no Undo reaches)",
  () =>
    Effect.gen(function* () {
      const dir = (yield* TestInstance).directory
      files(dir)
      const { root, child } = yield* family(true)
      for (const command of ["print new >| notes.txt", "print -r new >| notes.txt"]) {
        expect([command, yield* outcome(root.id, command, dir)]).toEqual([command, RAN])
        expect([command, yield* outcome(child.id, command, dir)]).toEqual([command, RAN])
      }
    }),
  { git: true },
)

it.instance(
  "mode off: each loosened form still asks the person (nothing runs, the main agent is not asked)",
  () =>
    Effect.gen(function* () {
      const dir = (yield* TestInstance).directory
      files(dir)
      const { root, child } = yield* family(false)
      const forms = [
        "rg --pre ./marker.sh foo f",
        "git cat-file --filters HEAD:a.md",
        "graft build .",
        "ztcp localhost 3999",
        "ztcp example.com 80",
        "grep -r PASSWORD ~/.config",
        "print new >| notes.txt",
      ]
      for (const command of forms)
        for (const session of [root.id, child.id])
          expect([command, yield* outcome(session, command, dir, "general", "300 millis")]).toEqual([command, { ran: false, decider: 0 }])
    }),
  { git: true },
)
