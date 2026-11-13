// 1.2.7 row 47k (user rulings U9 item 7 and U10, controller C76). U10-1: while Swarm's own server listens, an agent's call
// to it runs under the person's consent, for the main agent and its subagents alike, unless it asks for a route only the
// person calls (`AutonomyTable.personOnlyRoute`): the autonomous mode and consent, answering a permission or question on
// the person's behalf, emptying the archive and putting a checkpoint back, folder trust, and configuration writes. Those
// stay X `own_api` with the existing texts, by any spelling row 31 reads (literal, a config file, a variable, a shell's
// -c). A route that cannot be read (a path or method not written out, an unread config, a socket, interpreter code) stays
// refused. `swarm autonomy` from an agent's shell stays refused (U10-8). With the mode off, such a call asks the person.
// U9-7: a write that reaches the state folder only through a glob, a link or a variable is held for the person (D), as in
// 1.2.6. Synthetic values only: no server is contacted, home is a fresh mkdtemp folder.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test"
import fs, { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
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
import { Permission } from "../../src/permission"
import { Autonomy } from "../../src/permission/autonomy"
import type { AutonomyDecider } from "../../src/permission/autonomy-decider"
import { AutonomyTable } from "../../src/permission/autonomy-table"
import * as Texts from "../../src/permission/autonomy-texts"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import type { InstanceContext } from "../../src/project/instance-context"
import { InstanceStore } from "../../src/project/instance-store"
import { SelfAddress } from "../../src/server/self-address"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import { Session } from "../../src/session/session"
import { readSteps } from "../../src/tool/shell"
import { TestInstance, tmpdir } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

type Input = AutonomyTable.Input
type Verdict = AutonomyTable.Verdict

const PORT = 47196
const SELF = { hostname: "127.0.0.1", port: PORT }
const OWN = `http://127.0.0.1:${PORT}`
const OWN_API: Verdict = { class: "X", decidedBy: "gate", category: "own_api" }
const textOf = (name: string) => (Texts as Record<string, unknown>)[name] as string

let fixture: Awaited<ReturnType<typeof tmpdir>>
let dir: string
let instance: InstanceContext
let home: string
let spies: { mockRestore(): void }[] = []
const savedEnv = { CURL_HOME: process.env.CURL_HOME, WGETRC: process.env.WGETRC }

beforeAll(async () => {
  fixture = await tmpdir({ git: true })
  dir = fixture.path
  instance = { directory: dir, worktree: dir, project: { vcs: "git" } } as InstanceContext
  writeFileSync(path.join(dir, "cfg-list"), `url = "${OWN}/session"\nsilent\n`)
  writeFileSync(path.join(dir, "cfg-mode"), `url = "${OWN}/autonomy/mode"\nrequest = PUT\n`)
  writeFileSync(path.join(dir, "cfg-patch"), `request = PATCH\n`)
  writeFileSync(path.join(dir, "cfg-target"), `request-target = /autonomy/mode\n`)
  writeFileSync(path.join(dir, "urls-reply"), `${OWN}/permission/per_1/reply\n`)
  writeFileSync(path.join(dir, "urls-list"), `${OWN}/session\n`)
  delete process.env.CURL_HOME
  delete process.env.WGETRC
})
afterAll(async () => {
  for (const [name, value] of Object.entries(savedEnv))
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  await fixture[Symbol.asyncDispose]()
})
beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), "47kh-"))
  spies = [spyOn(os, "homedir").mockReturnValue(home), spyOn(osModule, "homedir").mockReturnValue(home)]
  SelfAddress.add(SELF)
})
afterEach(() => {
  SelfAddress.remove(SELF)
  for (const spy of spies) spy.mockRestore()
  rmSync(home, { recursive: true, force: true })
})

const request = (permission: string, fields: Partial<Input> = {}): Input => ({
  permission,
  patterns: ["*"],
  metadata: {},
  instance,
  cwd: dir,
  canUndo: true,
  folder: "clean",
  ...fields,
})
const bash = (command: string) => request("bash", { patterns: [command], metadata: { command } })
const fetchOf = (url: string) => request("webfetch", { patterns: [url], metadata: { url } })
const layers = (input: Input): [string, Verdict][] => [
  ["base", AutonomyTable.classify(input)],
  ["consent", AutonomyTable.classify({ ...input, bypass: { caller: "root" } })],
  ["consent-subagent", AutonomyTable.classify({ ...input, bypass: { caller: "subagent" } })],
]
const label = (input: Input) => String(input.metadata.command ?? input.metadata.url)
const expectRefused = (input: Input, reason?: "config_file" | "unresolved_target") => {
  for (const [layer, verdict] of layers(input))
    expect({ call: label(input), layer, ...verdict }).toEqual({ call: label(input), layer, ...OWN_API, ...(reason ? { reason } : {}) })
}
/** Runs under the consent: not refused, and for root and subagent the same answer as the same call to a port not Swarm's. */
const expectRuns = (input: Input) => {
  for (const [layer, verdict] of layers(input))
    expect({ call: label(input), layer, ownApi: verdict.category === "own_api", refused: verdict.class === "X" }).toEqual({
      call: label(input),
      layer,
      ownApi: false,
      refused: false,
    })
  const other = (value: string) => value.replaceAll(String(PORT), String(PORT + 1))
  const twin =
    input.permission === "webfetch" ? fetchOf(other(label(input))) : bash(other(String(input.metadata.command)))
  // The twin's destination names its own port; otherwise the answers are the same.
  const same = (verdict: Verdict) => JSON.stringify(verdict).replaceAll(String(PORT + 1), String(PORT))
  for (const caller of ["root", "subagent"] as const)
    expect([label(input), caller, JSON.stringify(AutonomyTable.classify({ ...input, bypass: { caller } }))]).toEqual([
      label(input),
      caller,
      same(AutonomyTable.classify({ ...twin, bypass: { caller } })),
    ])
}

describe("U10-1: an own-server call runs under the consent unless its route is person-only", () => {
  test("allowed routes: session list, health, project list, file search, a config read, the permission list", () => {
    for (const command of [
      `curl -s ${OWN}/session`,
      `curl -s http://localhost:${PORT}/global/health`,
      `curl -s ${OWN}/project`,
      `curl -s '${OWN}/find/file?query=a'`,
      `curl -s ${OWN}/config`,
      `curl -s ${OWN}/config/providers`,
      `curl -s ${OWN}/permission`,
      `curl -s -X GET ${OWN}/global/config`,
      `wget -qO- ${OWN}/session`,
      `http :${PORT}/session`,
      `xh GET :${PORT}/session/ses_1/message`,
      `H=127.0.0.1; curl -s $H:${PORT}/session`,
      `sh -c 'curl -s ${OWN}/session'`,
      `curl -s --url ${OWN}/session`,
      "curl -s -K cfg-list",
      "wget -q -i urls-list",
      `curl -s ${OWN}/session | head`,
    ])
      expectRuns(bash(command))
  })
  test("a webfetch of an allowed route", () => expectRuns(fetchOf(`${OWN}/session`)))

  test("person-only: mode and consent, by any method", () => {
    for (const command of [
      `curl -s -X PUT ${OWN}/autonomy/mode -d '{"on":true}'`,
      `curl -s ${OWN}/autonomy/mode`,
      `curl -s -X POST ${OWN}/autonomy/confirm`,
      `curl -s -X POST ${OWN}/session/ses_1/autonomy/consent -d '{}'`,
      `curl -s ${OWN}/session/ses_1/autonomy/consent`,
      `http PUT :${PORT}/autonomy/mode on:=true`,
    ])
      expectRefused(bash(command))
  })
  test("person-only: answering a permission, a question or a TUI request on the person's behalf", () => {
    for (const command of [
      `curl -s -X POST ${OWN}/permission/per_1/reply -d '{"reply":"always"}'`,
      `curl -s -X POST ${OWN}/session/ses_1/permissions/per_1 -d '{"response":"once"}'`,
      `curl -s -X POST ${OWN}/question/que_1/reply -d '{"answers":[]}'`,
      `curl -s -X POST ${OWN}/question/que_1/reject`,
      `curl -s -X POST ${OWN}/tui/control/response -d '{}'`,
    ])
      expectRefused(bash(command))
  })
  test("person-only: checkpoint revert and archive-empty (the nonce routes)", () => {
    for (const command of [
      `curl -s -X POST ${OWN}/session/ses_1/autonomy/checkpoint/chk_1/revert`,
      `curl -s -X POST ${OWN}/session/ses_1/autonomy/archive/empty`,
    ])
      expectRefused(bash(command))
  })
  test("person-only: folder trust, by any method", () => {
    for (const command of [`curl -s -X POST ${OWN}/project/trust -d '{"decision":"trust"}'`, `curl -s ${OWN}/project/trust`])
      expectRefused(bash(command))
  })
  test("person-only: configuration writes (config, global config, lanes, credentials)", () => {
    for (const command of [
      `curl -s -X PATCH ${OWN}/config -d '{}'`,
      `curl -s -XPATCH ${OWN}/global/config -d '{}'`,
      `curl -s -d '{}' ${OWN}/config`,
      `curl -s --json '{}' ${OWN}/global/config`,
      `curl -s -X PATCH ${OWN}/global/lanes -d '{}'`,
      `curl -s -X PUT ${OWN}/auth/anthropic -d '{}'`,
      `curl -s -X DELETE ${OWN}/auth/anthropic`,
      `curl -s -T body.json ${OWN}/config`,
      `curl -s -H 'X-HTTP-Method-Override: PATCH' ${OWN}/config`,
      `http PATCH :${PORT}/config model=x`,
      `http :${PORT}/global/config model=x`,
      `wget -q --method=PATCH --body-data='{}' ${OWN}/config`,
      `wget -q --post-data='{}' ${OWN}/global/config`,
      `wget -q -e method=PATCH ${OWN}/config`,
    ])
      expectRefused(bash(command))
  })
  test("person-only, indirect: a config file, a URL list, a variable, a shell's -c, a webfetch", () => {
    for (const command of [
      "curl -s -K cfg-mode",
      `curl -s -K cfg-patch ${OWN}/config`,
      "wget -q -i urls-reply",
      `P=/autonomy/mode; curl -s -X PUT ${OWN}$P`,
      `U=${OWN}; curl -s -X POST "$U/project/trust"`,
      `sh -c 'curl -s -X POST ${OWN}/permission/per_1/reply'`,
      `eval "curl -s -X PATCH ${OWN}/config"`,
      `curl -s ${OWN}/session && curl -s -X PUT ${OWN}/autonomy/mode`,
    ])
      expectRefused(bash(command))
    expectRefused(fetchOf(`${OWN}/autonomy/mode`))
  })
  test("person-only, respelled paths: dot segments, percent-encoding, case, a prefix, a trailing slash", () => {
    for (const command of [
      `curl -s -X PUT ${OWN}/session/../autonomy/mode`,
      `curl -s -X PUT ${OWN}/%61utonomy/mode`,
      `curl -s -X PUT ${OWN}/AUTONOMY/Mode`,
      `curl -s -X PUT ${OWN}//autonomy//mode/`,
      `curl -s -X POST ${OWN}/experimental/workspace/w1/project/trust`,
    ])
      expectRefused(bash(command))
  })

  test("unresolvable route: a path or method not written out, globbing, a replaced target, an unread config", () => {
    for (const command of [
      `curl -s ${OWN}/session/$ID`,
      `curl -s "${OWN}/$(cat route)"`,
      `curl -s '${OWN}/{session,autonomy/mode}'`,
      `curl -s '${OWN}/[a-z]'`,
      `curl -s --request-target /autonomy/mode ${OWN}/session`,
      "curl -s -K cfg-target " + `${OWN}/session`,
      `curl -s ${OWN}/session%252f`,
    ])
      expectRefused(bash(command), "unresolved_target")
    expectRefused(bash(`curl -s -K /nonexistent/47k.cfg ${OWN}/session`), "config_file")
    // A method not written out counts as a write, so on a configuration route it is the person's.
    expectRefused(bash(`curl -s -X $M ${OWN}/config`))
  })
  test("no route can be read: sockets, interpreter code and other mentions stay refused as before", () => {
    for (const command of [
      `nc 127.0.0.1 ${PORT}`,
      `exec 3<>/dev/tcp/127.0.0.1/${PORT}`,
      `printf 'GET /session HTTP/1.0\\r\\n\\r\\n' | nc 127.0.0.1 ${PORT}`,
      `python3 -c 'import urllib.request; urllib.request.urlopen("${OWN}/session")'`,
      `curl -s -x ${OWN} https://example.com/`,
    ])
      expectRefused(bash(command))
  })
  test("controls: other ports and a stopped listener keep their verdicts", () => {
    for (const command of [`curl -s http://127.0.0.1:${PORT + 1}/autonomy/mode -X PUT`, "curl -s https://example.com/config -X PATCH"])
      for (const [, verdict] of layers(bash(command))) expect([command, verdict.category]).not.toEqual([command, "own_api"])
    SelfAddress.remove(SELF)
    for (const [, verdict] of layers(bash(`curl -s -X PUT ${OWN}/autonomy/mode`))) expect(verdict.category).not.toBe("own_api")
  })
})

describe("U10-8: `swarm autonomy` from an agent's shell stays refused", () => {
  test("X own_api person_only in every layer, root and subagent", () => {
    for (const command of ["swarm autonomy on", "swarm autonomy off", "sh -c 'swarm autonomy status'"])
      for (const [layer, verdict] of layers(bash(command)))
        expect({ command, layer, ...verdict }).toEqual({ command, layer, ...OWN_API, reason: "person_only" })
  })
})

describe("U10-1 texts: person-only routes keep the existing own_api texts", () => {
  test("no reason is OWN_API_TEXT, unresolved is OWN_API_UNRESOLVED_TEXT", () => {
    expect(Permission.refusedUnderConsent("own_api").message).toBe(textOf("OWN_API_TEXT"))
    expect(Permission.refusedUnderConsent("own_api", "unresolved_target").message).toBe(textOf("OWN_API_UNRESOLVED_TEXT"))
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// U9-7: trust-store writes through a glob, a link or a variable are held for the person (D), as in 1.2.6. The shell's own
// reading of the command is passed, as the shell tool does.

describe("U9-7: a write into the state folder through a glob, a link or a variable is D", () => {
  let project: Awaited<ReturnType<typeof tmpdir>>
  let inside: InstanceContext
  beforeAll(async () => {
    project = await tmpdir({ git: true })
    inside = { directory: project.path, worktree: project.path, project: { vcs: "git" } } as InstanceContext
    fs.mkdirSync(path.join(project.path, "src"), { recursive: true })
    writeFileSync(path.join(project.path, "src/a.ts"), "x\n")
    fs.symlinkSync(Global.Path.state, path.join(project.path, "state-dir"))
  })
  afterAll(async () => {
    await project[Symbol.asyncDispose]()
  })
  const judge = async (command: string, bypass?: Input["bypass"]) => {
    const steps = await readSteps(command, project.path)
    return AutonomyTable.classify({
      permission: "bash",
      patterns: [command],
      metadata: { command, ...(steps ? { steps } : {}) },
      instance: inside,
      cwd: project.path,
      canUndo: true,
      folder: "clean",
      ...(bypass ? { bypass } : {}),
    })
  }
  const store = () => path.join(Global.Path.state, "trust.json")

  test("the five 1.2.6 forms are held for the person (D app_state), never P", async () => {
    for (const command of [
      "printf x > $XDG_STATE_HOME/swarm/tr*",
      "cp src/a.ts state-dir/tr",
      "mv src/a.ts state-dir/tr",
      "rm state-dir/tr",
      "cd state-dir && touch tr",
    ])
      expect([command, await judge(command)]).toEqual([command, { class: "D", decidedBy: "gate", category: "app_state" }])
  })
  test("under the consent nothing waits for the person, so they stay refused", async () => {
    for (const command of ["printf x > $XDG_STATE_HOME/swarm/tr*", "rm state-dir/tr"])
      for (const caller of ["root", "subagent"] as const)
        expect([command, caller, await judge(command, { caller })]).toEqual([
          command,
          caller,
          { class: "X", decidedBy: "gate", category: "app_state" },
        ])
  })
  test("controls: a spelled-out write and a read out of state stay X app_state", async () => {
    for (const command of [
      `printf x > ${store()}`,
      "tee state-dir/trust.json",
      "printf x > $HOME/.local/state/swarm/trust.json",
      "cat state-dir/app-server.env > x",
      "cp state-dir/tr x",
      "mv state-dir/tr x",
      "cat $XDG_STATE_HOME/swarm/tr* > x",
    ])
      expect([command, await judge(command)]).toEqual([command, { class: "X", decidedBy: "gate", category: "app_state" }])
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// Through the gate (index.ts): an allowed route runs for the root and a subagent like the same call to another local port;
// a person-only route is refused with OWN_API_TEXT and never reaches the decider; with the mode off the call asks.

const folder = path.join(Global.Path.state, "autonomy")
type Call = { permission: string; category?: string; options?: AutonomyDecider.Options }
const ALLOW = (): Effect.Effect<Permission.Decided> => Effect.succeed({ decision: "allow", decidedBy: "agent:main/build" })
const stub = { calls: [] as Call[], answer: ALLOW }
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
  stub.answer = ALLOW
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
      text: "check the sessions",
    } satisfies SessionV1.TextPart)
  })
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
const ask = (sessionID: SessionID, command: string, directory: string) =>
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
const settled = (input: PermissionV1.AskInput) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    return yield* permission.ask(input).pipe(Effect.timeout("2 seconds"), Effect.exit)
  })
const failureOf = <A, E>(exit: Exit.Exit<A, E>) => {
  if (Exit.isSuccess(exit)) throw new Error("expected the call to be stopped")
  return Cause.squash(exit.cause)
}

it.instance("gate: an allowed route runs for root and subagent exactly as the same call to another local port", () =>
  Effect.gen(function* () {
    const work = (yield* TestInstance).directory
    const { root, child } = yield* family(true)
    for (const id of [root.id, child.id]) {
      const outcomes: [boolean, number][] = []
      for (const port of [PORT, PORT + 1]) {
        stub.calls.length = 0
        const exit = yield* settled(yield* ask(id, `curl -s http://127.0.0.1:${port}/session`, work))
        outcomes.push([Exit.isSuccess(exit), stub.calls.length])
      }
      expect([id === root.id ? "root" : "subagent", outcomes[0]]).toEqual([id === root.id ? "root" : "subagent", outcomes[1]])
      expect(outcomes[0]![0]).toBe(true)
    }
  }),
)

it.instance("gate: person-only routes are refused with OWN_API_TEXT for root and subagent, never the decider", () =>
  Effect.gen(function* () {
    const work = (yield* TestInstance).directory
    const { root, child } = yield* family(true)
    for (const id of [root.id, child.id])
      for (const command of [
        `curl -s -X PUT ${OWN}/autonomy/mode`,
        `curl -s -X POST ${OWN}/permission/per_1/reply`,
        `curl -s -X POST ${OWN}/project/trust`,
        `curl -s -X PATCH ${OWN}/config`,
      ]) {
        stub.calls.length = 0
        const exit = yield* settled(yield* ask(id, command, work))
        expect([command, failureOf(exit) instanceof Error ? (failureOf(exit) as Error).message : ""]).toEqual([
          command,
          textOf("OWN_API_TEXT"),
        ])
        expect([command, stub.calls]).toEqual([command, []])
      }
  }),
)

it.instance("gate: with the mode off an own-server call asks the person", () =>
  Effect.gen(function* () {
    const work = (yield* TestInstance).directory
    const { root } = yield* family(false)
    const permission = yield* Permission.Service
    for (const command of [`curl -s ${OWN}/session`, `curl -s -X PUT ${OWN}/autonomy/mode`]) {
      const input = yield* ask(root.id, command, work)
      // While the ask waits, the person's list shows it; when the two seconds ran out it was neither refused nor run.
      const [exit, pending] = yield* Effect.all(
        [settled(input), Effect.sleep("500 millis").pipe(Effect.andThen(permission.list()))],
        { concurrency: 2 },
      )
      expect([command, Exit.isFailure(exit) && Cause.squash(exit.cause)?.constructor?.name]).toEqual([command, "TimeoutError"])
      expect([command, pending.some((item) => item.sessionID === root.id && item.patterns.includes(command))]).toEqual([command, true])
      expect(stub.calls).toEqual([])
    }
  }),
)
