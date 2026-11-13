// 1.2.7 row 31 (F-4, AC-F4, N7-093; OP-4, SR7-03, SR7-08): while Swarm's own server listens, a call to it is X `own_api`
// (N7-051) also when the address is indirect: a curl or wget config file (`-K`, `--config`, `-i`), a variable assigned in
// the same text, the default `.curlrc`. A network call whose address cannot be worked out (a variable, a command, stdin,
// an unreadable config) is X `own_api` with a reason (N7-136) and `OWN_API_UNRESOLVED_TEXT` (N7-135). Every spelling of
// loopback counts, and a hostname with the listener's port too. Controls: a literal host that is not this computer's,
// other loopback ports and a stopped listener keep their verdicts. Synthetic values only: no server is contacted, home is
// a fresh mkdtemp folder (both `os.homedir` spellings the source uses), and no real server password file is read.
// 1.2.7 row 47k (U10-1, C76, INTENT): an own-server call whose route can be read now runs under the consent unless the
// route is person-only, so the D forms below name a person-only route (`/autonomy/mode`, a permission reply) where they
// named `/session` or `/`; the address readings, reasons, texts and controls are unchanged.
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

const PORT = 47096
const SELF = { hostname: "127.0.0.1", port: PORT }
const MARKER = "f4-synthetic-marker-7c1d"
const OWN_API: Verdict = { class: "X", decidedBy: "gate", category: "own_api" }
const textOf = (name: string) => (Texts as Record<string, unknown>)[name]

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
  writeFileSync(path.join(dir, "cfg"), `# ${MARKER}\nurl = "http://127.0.0.1:${PORT}/autonomy/mode"\nsilent\n`)
  writeFileSync(path.join(dir, "cfg-other"), `url = "https://example.com/${MARKER}"\n`)
  writeFileSync(path.join(dir, "cfg-name"), `url = "http://box.example:${PORT}/session"\n`)
  writeFileSync(path.join(dir, "cfg-nested"), `config = "cfg"\n`)
  writeFileSync(path.join(dir, "urls"), `http://127.0.0.1:${PORT}/autonomy/mode\n`)
  writeFileSync(path.join(dir, "big"), `url = "https://example.com/"\n# ${"x".repeat(70 * 1024)}\n`)
  delete process.env.CURL_HOME
  delete process.env.WGETRC
})
afterAll(async () => {
  for (const [name, value] of Object.entries(savedEnv)) if (value === undefined) delete process.env[name]
  else process.env[name] = value
  await fixture[Symbol.asyncDispose]()
})
beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), "f4h-"))
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
const layers = (input: Input): [string, Verdict][] => [
  ["base", AutonomyTable.classify(input)],
  ["consent", AutonomyTable.classify({ ...input, bypass: { caller: "root" } })],
  ["consent-subagent", AutonomyTable.classify({ ...input, bypass: { caller: "subagent" } })],
]
/** X own_api in every layer; `reason` absent for a D form (N7-052), named for a U form (N7-135, N7-136). */
const expectOwnApi = (command: string, reason?: "config_file" | "unresolved_target") => {
  for (const [layer, verdict] of layers(bash(command)))
    expect({ command, layer, ...verdict }).toEqual({ command, layer, ...OWN_API, ...(reason ? { reason } : {}) })
}
const expectNotOwnApi = (command: string) => {
  for (const [layer, verdict] of layers(bash(command)))
    expect({ command, layer, category: verdict.category }).not.toEqual({ command, layer, category: "own_api" })
}
const message = (error: unknown) => (error as Error).message

describe("F-4 texts and category (N7-051, N7-052, N7-135, N7-136)", () => {
  test("OWN_API_TEXT and OWN_API_UNRESOLVED_TEXT have the register values", () => {
    expect(textOf("OWN_API_TEXT")).toBe(
      // 1.2.7 row 47l (C79, INTENT): agents may call Swarm's own server; the text names the routes that are the person's.
      "This call did not run. Agents may call Swarm's own server, but not the routes that act as the person (the autonomous mode and consent, answers to permissions and questions, reverts, folder trust, configuration, shell commands run as the person, control of the person's app, repository commits and patches, upgrades and shutdowns), and not by a socket or program code whose route cannot be read. Use the tools you were given, or write what is needed into your final message for the person.",
    )
    expect(textOf("OWN_API_UNRESOLVED_TEXT")).toBe(
      "This call did not run. Autonomous mode cannot tell where this network call goes (the address comes from a variable, a config file or another command), and it never calls Swarm's own server. Write the host and port into the command itself.",
    )
  })
  test("refusals name the text by reason, with and without consent", () => {
    for (const refuse of [Permission.refusedByMode, Permission.refusedUnderConsent]) {
      expect(message(refuse("own_api"))).toBe(textOf("OWN_API_TEXT") as string)
      expect(message(refuse("own_api", "config_file"))).toBe(textOf("OWN_API_UNRESOLVED_TEXT") as string)
      expect(message(refuse("own_api", "unresolved_target"))).toBe(textOf("OWN_API_UNRESOLVED_TEXT") as string)
      // A reason outside the closed list is never echoed.
      expect(message(refuse("own_api", MARKER))).toBe(textOf("OWN_API_TEXT") as string)
    }
  })
  test("the literal own-API call is X own_api, not app_state (CHAR-03 intent)", () =>
    expectOwnApi(`curl -s http://127.0.0.1:${PORT}/autonomy/mode`))
})

describe("F4-R1 / D2: a config file that names the listener", () => {
  test("`curl -s -K cfg` with no URL on the line", () => expectOwnApi("curl -s -K cfg"))
  test("every spelling of the config option, and a config naming another config", () => {
    for (const command of ["curl -Kcfg", "curl -sK cfg", "curl --config cfg", "curl --config=cfg", `curl -K ${path.join(dir, "cfg")}`, "curl -K cfg-nested"])
      expectOwnApi(command)
  })
  test("wget's URL list naming the listener", () => {
    expectOwnApi("wget -q -i urls")
    expectOwnApi("wget --input-file=urls")
  })
  test("the verdict never carries the config file's content (OP-4)", () => {
    for (const [, verdict] of layers(bash("curl -s -K cfg"))) expect(JSON.stringify(verdict)).not.toContain(MARKER)
    expect(message(Permission.refusedByMode("own_api"))).not.toContain(MARKER)
  })
  test("U1: a config from stdin, missing, oversized or in a protected place is X own_api `config_file`", () => {
    for (const command of ["curl -s -K - < cfg", "curl -K /nonexistent/f4.cfg", "curl -K big", "curl -K ~/.ssh/f4.cfg", "curl -K $CFG"])
      expectOwnApi(command, "config_file")
  })
  test("control: a config file that names another host keeps its verdict", () => expectNotOwnApi("curl -K cfg-other"))
})

describe("F4-R2 / D3: host or port in a variable assigned in the same text", () => {
  test("`H=127.0.0.1; curl -s $H:<port>/autonomy/mode` and `P=<port>; curl 127.0.0.1:$P/autonomy/mode`", () => {
    expectOwnApi(`H=127.0.0.1; curl -s $H:${PORT}/autonomy/mode`)
    expectOwnApi(`P=${PORT}; curl 127.0.0.1:$P/autonomy/mode`)
  })
  test("export, braces, quotes and both parts at once", () => {
    for (const command of [
      `export H=127.0.0.1; curl http://\${H}:${PORT}/autonomy/mode`,
      `H="localhost" P=${PORT}; curl "http://$H:$P/autonomy/mode"`,
      `U=http://127.0.0.1:${PORT}; curl -s -X POST "$U/permission/per_1/reply"`,
    ])
      expectOwnApi(command)
  })
})

describe("F4-R3 / U2-U4: the address is not written out", () => {
  test("`curl -s $SWARM_URL/session` (unassigned) is X own_api `unresolved_target`", () =>
    expectOwnApi("curl -s $SWARM_URL/session", "unresolved_target"))
  test("command substitutions, operators, eval, a shell's -c, xargs, stdin lists and sockets", () => {
    for (const command of [
      `curl "$(cat host)":${PORT}`,
      "curl `cat host`/session",
      `curl \${H:-127.0.0.1}:${PORT}/`,
      `eval "curl $U"`,
      `sh -c 'curl -s $U'`,
      `curl 127.0.0.1:$Q/session`,
      `curl http://[::1]:$Q/`,
      "xargs curl -s < urls",
      "wget -i -",
      `nc $H ${PORT}`,
      `exec 3<>/dev/tcp/$H/${PORT}`,
      `http_proxy=$PX curl http://example.com/`,
      `wget -e http_proxy=$PX http://example.com/`,
    ])
      expectOwnApi(command, "unresolved_target")
  })
  test("SR7-08: a hostname that is not an IP address, with the listener's port", () => {
    expectOwnApi(`curl -s http://box.example:${PORT}/session`, "unresolved_target")
    expectOwnApi("curl -K cfg-name", "unresolved_target")
    const fetch = request("webfetch", { patterns: [`http://box.example:${PORT}/`], metadata: { url: `http://box.example:${PORT}/` } })
    expect(AutonomyTable.classify(fetch)).toEqual({ ...OWN_API, reason: "unresolved_target" })
  })
})

describe("F4-R4 / D4: the default config files", () => {
  test("a home `.curlrc` naming the listener turns a plain `curl -s` into X own_api", () => {
    expectNotOwnApi("curl -s")
    writeFileSync(path.join(home, ".curlrc"), `url = "http://127.0.0.1:${PORT}/autonomy/mode"\n`)
    expectOwnApi("curl -s")
    expectOwnApi("curl -s https://example.com/")
  })
  test("`$CURL_HOME/.curlrc` and a home `.wgetrc` proxy", () => {
    const curlHome = mkdtempSync(path.join(os.tmpdir(), "f4c-"))
    try {
      writeFileSync(path.join(curlHome, ".curlrc"), `proxy = "http://localhost:${PORT}"\n`)
      process.env.CURL_HOME = curlHome
      expectOwnApi("curl -s https://example.com/")
    } finally {
      delete process.env.CURL_HOME
      rmSync(curlHome, { recursive: true, force: true })
    }
    writeFileSync(path.join(home, ".wgetrc"), `http_proxy = http://127.0.0.1:${PORT}/\n`)
    expectOwnApi("wget -q http://example.com/")
  })
  test("control: `curl -q` first and `wget --no-config` do not read them", () => {
    writeFileSync(path.join(home, ".curlrc"), `url = "http://127.0.0.1:${PORT}/autonomy/mode"\n`)
    writeFileSync(path.join(home, ".wgetrc"), `http_proxy = http://127.0.0.1:${PORT}/\n`)
    expectNotOwnApi("curl -q -s https://example.com/")
    expectNotOwnApi("wget --no-config -q http://example.com/")
  })
})

describe("SR7-08: every spelling of loopback is the listener's host", () => {
  test.each([
    "127.0.0.1", "127.0.0.2", "127.255.255.254", "127.1", "2130706433", "0x7f000001", "0x7f.0.0.1", "0177.0.0.1",
    "017700000001", "0", "0.0.0.0", "localhost", "LOCALHOST", "localhost.", "swarm.localhost", "[::1]",
    "[0:0:0:0:0:0:0:1]", "[0000:0000::0001]", "[::ffff:127.0.0.1]", "[::ffff:7f00:1]", "[::]",
  ])("curl to %s", (host) => expectOwnApi(`curl -s http://${host}:${PORT}/autonomy/mode`))
  test("host and port apart, and bash's sockets", () => {
    for (const command of [`nc 127.1 ${PORT}`, `nc ::1 ${PORT}`, `nc localhost. ${PORT}`, `exec 3<>/dev/tcp/0x7f000001/${PORT}`])
      expectOwnApi(command)
  })
})

describe("controls: unchanged verdicts", () => {
  test("a literal host that is not this computer's, whatever the port or path", () => {
    for (const command of [
      "curl https://example.com/$PATHPART",
      "curl https://example.com:$P/x",
      `curl -s http://8.8.8.8:${PORT}/`,
      'curl -s -H "Authorization: Bearer $TOKEN" -o "$OUT" https://example.com/x > "$LOG" 2>&1',
      "wget -q -O $OUT https://example.com/file",
    ])
      expectNotOwnApi(command)
  })
  test("other loopback ports (fx14 controls)", () => {
    for (const command of [
      "curl -s http://127.0.0.1:7863/health",
      "curl -s http://localhost:14096/",
      `curl -s http://127.0.0.1:${PORT}0/`,
      "head -c 47096 cfg",
      `seq 0 ${PORT}`,
    ])
      expectNotOwnApi(command)
  })
  test("no network client: a variable or a config word is not refused", () => {
    for (const command of [`echo $H:${PORT}`, "cat $CFG", "grep -K cfg x", "ls -la"]) expectNotOwnApi(command)
  })
  test("once the listener stopped, R1-R4 keep their verdicts", () => {
    SelfAddress.remove(SELF)
    writeFileSync(path.join(home, ".curlrc"), `url = "http://127.0.0.1:${PORT}/autonomy/mode"\n`)
    for (const command of [
      "curl -s -K cfg",
      `H=127.0.0.1; curl -s $H:${PORT}/autonomy/mode`,
      `P=${PORT}; curl 127.0.0.1:$P/autonomy/mode`,
      "curl -s $SWARM_URL/session",
      "curl -s",
      `curl -s http://box.example:${PORT}/session`,
    ]) {
      expectNotOwnApi(command)
      for (const [, verdict] of layers(bash(command))) expect(verdict.category).not.toBe("app_state")
    }
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// Through the gate (index.ts): the refusal text per reason, never the decider, `own_api` never opened (CHAR-10), and
// a subagent's inline interpreter network code still goes to the decider (SR7-03, residual R-F4).

const folder = path.join(Global.Path.state, "autonomy")
type Call = { permission: string; category?: string; options?: AutonomyDecider.Options }
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
type Wrap = <A, E, R>(self: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
const settled = (input: PermissionV1.AskInput, wrap: Wrap = (self) => self) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    return yield* wrap(permission.ask(input)).pipe(Effect.timeout("2 seconds"), Effect.exit)
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

it.instance("gate: R1-R3 are refused with their text for root and subagent, and never reach the decider", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    const work = test.directory
    fs.writeFileSync(path.join(work, "cfg"), `url = "http://127.0.0.1:${PORT}/autonomy/mode"\n`)
    const { root, child } = yield* family()
    for (const id of [root.id, child.id])
      for (const [command, text] of [
        ["curl -s -K cfg", "OWN_API_TEXT"],
        [`P=${PORT}; curl 127.0.0.1:$P/autonomy/mode`, "OWN_API_TEXT"],
        ["curl -s $SWARM_URL/session", "OWN_API_UNRESOLVED_TEXT"],
        ["curl -K /nonexistent/f4.cfg", "OWN_API_UNRESOLVED_TEXT"],
      ] as const) {
        stub.calls.length = 0
        const exit = yield* settled(yield* ask(id, command, work))
        expect([command, message(failureOf(exit))]).toEqual([command, textOf(text) as string])
        expect([command, stub.calls]).toEqual([command, []])
      }
    expect((yield* decisions(root.id)).map((line) => [line.class, line.category])).toEqual(
      Array.from({ length: 8 }, () => ["X", "own_api"]),
    )
  }),
)

it.instance("CHAR-10: a verdict that claims to have opened own_api is not believed", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    const { root, child } = yield* family()
    const forge = <A, E, R>(self: Effect.Effect<A, E, R>) =>
      self.pipe(
        Effect.provideService(Permission.Classify, () => ({
          class: "A" as const,
          decidedBy: "agent" as const,
          category: "by_main_agent" as const,
          bypassed: "own_api" as never,
        })),
      )
    for (const id of [root.id, child.id]) {
      const exit = yield* settled(yield* ask(id, "echo f4", test.directory), forge)
      expect(message(failureOf(exit))).toBe(textOf("OWN_API_TEXT") as string)
    }
    expect(stub.calls).toEqual([])
    expect((yield* decisions(root.id)).map((line) => [line.class, line.category])).toEqual([
      ["X", "own_api"],
      ["X", "own_api"],
    ])
  }),
)

it.instance("SR7-03 CHAR: with the listener up, a subagent's inline interpreter network code still reaches the decider", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    const { child } = yield* family()
    for (const command of [
      `python3 -c 'import os, urllib.request; urllib.request.urlopen("http://127.0.0.1:" + os.environ["P"])'`,
      `node -e 'fetch(process.env.U)'`,
      `bun -e 'fetch(process.env.U)'`,
    ]) {
      stub.calls.length = 0
      const exit = yield* settled(yield* ask(child.id, command, test.directory))
      expect([command, Exit.isFailure(exit), stub.calls.length]).toEqual([command, true, 1])
      expect([command, ["script_flagged", "outward"].includes(stub.calls[0]!.category ?? "")]).toEqual([command, true])
    }
  }),
)
