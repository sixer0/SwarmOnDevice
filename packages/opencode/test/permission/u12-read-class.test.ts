// 1.2.6 row 36 (P-01a; U6, U12, U16, D5): in autonomous mode every read runs with nobody asked, in both layers (the
// 1.1.0 table without consent and the consented no-wait overlay). A read of a secret or sensitive file in the project, of
// a protected or secret place outside it, a diagnostic probe of an installed program, and a look beyond the folder the
// table could not vouch for become gate A `protected_read` (N-073). Writes into those places, network fetches (outward,
// D5), anything that is not a proven read, and a person's own rules keep their 1.2.5 verdict. Spec: 01b sections 3.1, 9.1.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Agent } from "../../src/agent/agent"
import { Config } from "../../src/config/config"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Format } from "../../src/format"
import { LSP } from "../../src/lsp/lsp"
import { Permission } from "../../src/permission"
import { Autonomy } from "../../src/permission/autonomy"
import { AutonomyTable } from "../../src/permission/autonomy-table"
import { Plugin } from "../../src/plugin"
import type { InstanceContext } from "../../src/project/instance-context"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import { Question } from "../../src/question"
import { MessageID, type SessionID } from "../../src/session/schema"
import { Instruction } from "../../src/session/instruction"
import { Session } from "../../src/session/session"
import { ReadTool } from "../../src/tool/read"
import type { Tool } from "../../src/tool/tool"
import { Truncate } from "../../src/tool/truncate"
import { WriteTool } from "../../src/tool/write"
import { TestInstance, tmpdir } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

type Input = AutonomyTable.Input
type Verdict = AutonomyTable.Verdict

const PROTECTED_READ: Verdict = { class: "A", decidedBy: "gate", category: "protected_read" }
// The pinned home of the test run (never the person's real one).
const home = Global.Path.home

let fixture: Awaited<ReturnType<typeof tmpdir>>
let dir: string
let instance: InstanceContext

beforeAll(async () => {
  fixture = await tmpdir({ git: true })
  dir = fixture.path
  instance = { directory: dir, worktree: dir, project: { vcs: "git" } } as InstanceContext
  fs.mkdirSync(path.join(dir, "src"), { recursive: true })
  fs.writeFileSync(path.join(dir, "src/a.ts"), "x\n")
  fs.writeFileSync(path.join(dir, ".env"), "TOKEN=fixture-value-1\n")
  fs.writeFileSync(path.join(dir, ".env.example"), "TOKEN=\n")
  fs.writeFileSync(path.join(dir, ".env.local"), "KEY=fixture-value-2\n")
  fs.writeFileSync(path.join(dir, "server.pem"), "not a real key\n")
})
afterAll(async () => {
  await fixture[Symbol.asyncDispose]()
})

const request = (permission: string, fields: Partial<Input> = {}): Input => ({
  permission,
  patterns: [permission === "bash" ? "x" : "*"],
  metadata: {},
  instance,
  cwd: dir,
  canUndo: true,
  folder: "clean",
  ...fields,
})
const bash = (command: string, fields: Partial<Input> = {}) =>
  request("bash", { patterns: [command], metadata: { command }, ...fields })
const readTool = (name: string, fields: Partial<Input> = {}) => request("read", { patterns: [name], ...fields })
const outsideAsk = (filepath: string, metadata: Record<string, unknown> = { readOnly: true }, fields: Partial<Input> = {}) =>
  request("external_directory", { patterns: [path.join(path.dirname(filepath), "*")], metadata: { filepath, ...metadata }, ...fields })
const outsideWrite = (filepath: string) =>
  request("external_directory", {
    patterns: [path.join(path.dirname(filepath), "*")],
    metadata: { filepath },
    follows: [{ permission: "edit", patterns: [filepath] }] as unknown as Input["follows"],
  })
const edit = (name: string, fields: Partial<Input> = {}) =>
  request("edit", { patterns: [name], metadata: { filepath: path.resolve(dir, name) }, ...fields })

/** Both autonomous layers: the 1.1.0 table, and the consented no-wait overlay of the root. */
const layers = (input: Input): [string, Verdict][] => [
  ["base", AutonomyTable.classify(input)],
  ["consent", AutonomyTable.classify({ ...input, bypass: { caller: "root" } })],
]
const expectProtectedRead = (input: Input) => {
  for (const [layer, verdict] of layers(input)) expect({ layer, ...verdict }).toEqual({ layer, ...PROTECTED_READ })
}

describe("U12 read class: R2-R5 are gate A protected_read in both layers", () => {
  test("R-1: the read tool on a secret file in the project", () => {
    for (const name of [".env", ".env.local", "server.pem"]) expectProtectedRead(readTool(name))
  })

  test("R-2: a shell look at a secret file in the project", () => {
    for (const command of ["cat .env", "diff .env .env.example", "cat .git/config", "head server.pem", "grep KEY .env.local"])
      expectProtectedRead(bash(command))
  })

  test("R-3: the read tool's prompt for a protected place outside: ~/.ssh/config and Swarm's auth.json", () => {
    for (const file of [path.join(home, ".ssh/config"), path.join(Global.Path.data, "auth.json")]) {
      expectProtectedRead(outsideAsk(file))
      expectProtectedRead(readTool(file))
    }
  })

  test("R-4: an outside readOnly prompt for ~/.ssh/id_rsa, ~/.aws/credentials and x/.git/config", () => {
    for (const file of [path.join(home, ".ssh/id_rsa"), path.join(home, ".aws/credentials"), path.join(home, "x/.git/config")])
      expectProtectedRead(outsideAsk(file))
  })

  test("R-5: a shell look at a protected place outside", () => {
    for (const command of ["cat ~/.ssh/config", `cat ${home}/.ssh/config`, `ls ${home}/.aws`, "ls ~/.aws"])
      expectProtectedRead(bash(command))
    // The prompt the shell raises beside it for the folder outside agrees.
    expectProtectedRead(
      request("external_directory", { patterns: [path.join(home, ".ssh/*")], metadata: { command: `cat ${home}/.ssh/config` } }),
    )
  })

  test("R-6: a diagnostic probe of an installed program", () => {
    for (const command of ["node --version", "npm -v", "dot -V", "python3 --version", "qlmanage -h", "go version", "printenv PATH", "printenv", "env"])
      expectProtectedRead(bash(command))
  })

  test("R-7: a hidden search outside and a walk outside", () => {
    expectProtectedRead(outsideAsk(path.join(home, "Documents/x"), { readOnly: true, hidden: true }))
    for (const command of [`find ${home}/x -name '*.md'`, `tree ${home}/x`, `rg pattern ${home}/x`]) expectProtectedRead(bash(command))
  })

  test("plan lineage: reading is what plan mode does (01b 3.1 rule 5)", () => {
    for (const command of ["cat .env", `cat ${home}/.ssh/id_rsa`]) expectProtectedRead(bash(command, { plan: true }))
    expectProtectedRead(readTool(".env", { plan: true }))
  })
})

describe("U12 read class: what does not change", () => {
  test("R-8 (guard): an ordinary look keeps its 1.2.5 line, with no category", () => {
    for (const command of ["ls src", "which node", "cat src/a.ts"])
      for (const [, verdict] of layers(bash(command))) expect(verdict).toEqual({ class: "A", decidedBy: "gate" })
    // R6: an ordinary readable file outside keeps `outside_read`.
    fs.mkdirSync(path.join(home, "Documents"), { recursive: true })
    fs.writeFileSync(path.join(home, "Documents/note.txt"), "note\n")
    try {
      for (const [, verdict] of layers(bash(`cat ${home}/Documents/note.txt`)))
        expect(verdict).toEqual({ class: "A", decidedBy: "gate", category: "outside_read" })
      for (const [, verdict] of layers(outsideAsk(path.join(home, "Documents/note.txt"))))
        expect(verdict).toEqual({ class: "A", decidedBy: "gate", category: "outside_read" })
    } finally {
      fs.rmSync(path.join(home, "Documents"), { recursive: true, force: true })
    }
  })

  test("R-9 (stays): a send, a copy, a redirect, a program run, an unproven read and a project program are not reads", () => {
    const D = (category: AutonomyTable.HeldCategory): Verdict => ({ class: "D", decidedBy: "gate", category })
    const MAIN = (bypassed: string, extra: Record<string, unknown> = {}) =>
      ({ class: "A", decidedBy: "agent", category: "by_main_agent", bypassed, ...extra }) as Verdict
    // Each with its 1.2.5 verdict in the base layer and under consent (this block passes unchanged at e363918a69).
    const pinned: [Input, Verdict, Verdict][] = [
      [bash("curl https://example.com"), D("not_routine"), MAIN("outward", { destination: "example.com" })],
      [bash(`cp ${home}/.ssh/id_rsa ./k`), D("secret_file"), { class: "X", decidedBy: "gate", category: "not_reversible", bypassed: "secret_file" }],
      [bash("cat .env > out.txt"), D("secret_file"), MAIN("unreadable_command")],
      [bash("source .env && bun test"), D("secret_file"), MAIN("unreadable_command")],
      [bash("env FOO=1 node x.js"), D("not_routine"), MAIN("not_routine")],
      [request("lsp", { metadata: { filepath: path.join(home, ".ssh/config") } }), D("not_routine"), MAIN("not_routine")],
      [outsideAsk(path.join(home, ".ssh/config"), {}), { class: "X", decidedBy: "gate", category: "protected_path" }, { class: "X", decidedBy: "gate", category: "protected_path" }],
      [bash("./node_modules/.bin/x --version"), D("program_not_trusted"), MAIN("program_not_trusted")],
      [bash("xxd .env out.bin"), D("secret_file"), MAIN("secret_file")],
    ]
    for (const [input, base, consent] of pinned) {
      expect(AutonomyTable.classify(input)).toEqual(base)
      expect(AutonomyTable.classify({ ...input, bypass: { caller: "root" } })).toEqual(consent)
    }
  })

  test("R-9 (stays): a program of the project under a probe's name is still not trusted", () => {
    fs.mkdirSync(path.join(dir, "bin"), { recursive: true })
    fs.writeFileSync(path.join(dir, "bin/fixtool"), "#!/bin/sh\n", { mode: 0o755 })
    const saved = process.env.PATH
    process.env.PATH = `bin${path.delimiter}${saved ?? ""}`
    try {
      for (const [, verdict] of layers(bash("fixtool --version"))) expect(verdict.category).not.toBe("protected_read")
    } finally {
      process.env.PATH = saved
      fs.rmSync(path.join(dir, "bin"), { recursive: true, force: true })
    }
  })

  test("R-10 (writes stay): a write into ~/.ssh/config and an edit of .env keep their 1.2.5 verdict", () => {
    expect(AutonomyTable.classify(outsideWrite(path.join(home, ".ssh/config")))).toEqual({ class: "X", decidedBy: "gate", category: "protected_path" })
    expect(AutonomyTable.classify({ ...outsideWrite(path.join(home, ".ssh/config")), bypass: { caller: "root" } })).toMatchObject({
      class: "X",
      category: "protected_path",
    })
    expect(AutonomyTable.classify(edit(".env", { editClass: "secret" }))).toEqual({ class: "D", decidedBy: "gate", category: "secret_file" })
    expect(AutonomyTable.classify(edit(".env", { editClass: "secret", bypass: { caller: "root" } })).category).not.toBe("protected_read")
  })

  test("R-11 (person): a read under a deny rule or a person's own catch-all ask keeps its verdict", () => {
    expect(AutonomyTable.classify(readTool(".env", { rule: "deny" }))).toEqual({ class: "X" })
    expect(AutonomyTable.classify(bash("cat .env", { rule: "deny" }))).toEqual({ class: "X" })
    expect(AutonomyTable.classify(readTool(".env", { rule: "user_catch_all" }))).toEqual({ class: "D", decidedBy: "gate", category: "asks_every_time" })
    expect(AutonomyTable.classify(bash("node --version", { rule: "user_catch_all" }))).toEqual({
      class: "D",
      decidedBy: "gate",
      category: "asks_every_time",
    })
  })

  test("R-12 (AC7 replay, local only): the Graphviz install and thumbnail run under consent do not wait", () => {
    for (const command of ["npm install @viz-js/viz", "qlmanage -t -s 800 -o out/ fig.svg"]) {
      const verdict = AutonomyTable.classify(bash(command, { bypass: { caller: "root" } }))
      expect(verdict.class).toBe("A")
    }
  })
})

// The same through the real gate and the real tools: the reads run, nothing waits, the decider is never asked, and the
// audit names `protected_read`. The write of a protected place is still refused.
const decided: string[] = []
const decider = Layer.succeed(
  Permission.Decider,
  Permission.Decider.of({
    decide: (input) =>
      Effect.sync(() => {
        decided.push(input.permission)
        return { decision: "reject" as const, decidedBy: "agent:test/stub" }
      }),
  }),
)
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Permission.node, Session.node, Autonomy.node, EventV2Bridge.node, SessionProjector.node, CrossSpawnSpawner.node,
      InstanceStore.node, Question.node, FSUtil.node, Plugin.node, Truncate.node, Config.node, Agent.node, RuntimeFlags.node,
      LSP.node, Format.node, Instruction.node,
    ]),
    [
      [InstanceStore.bootstrapNode, Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))],
      [Permission.deciderNode, decider],
    ],
  ),
)

describe("U12 read class, through the gate", () => {
  const ssh = path.join(home, ".ssh")
  const authFile = path.join(Global.Path.data, "auth.json")
  const modeFolder = path.join(Global.Path.state, "autonomy")
  beforeEach(() => {
    decided.length = 0
    fs.rmSync(modeFolder, { recursive: true, force: true })
    fs.mkdirSync(ssh, { recursive: true })
    fs.mkdirSync(path.dirname(authFile), { recursive: true })
    fs.writeFileSync(path.join(ssh, "config"), "Host fixture\n")
    fs.writeFileSync(authFile, '{"note":"not a real credential"}\n')
  })
  afterEach(() => {
    fs.rmSync(ssh, { recursive: true, force: true })
    fs.rmSync(authFile, { force: true })
    fs.rmSync(modeFolder, { recursive: true, force: true })
  })

  const context = (sessionID: SessionID) =>
    Effect.gen(function* () {
      const permission = yield* Permission.Service
      const agent = yield* (yield* Agent.Service).get("build")
      return {
        sessionID,
        messageID: MessageID.ascending(),
        callID: "",
        agent: "build",
        abort: AbortSignal.any([]),
        messages: [],
        trust: { canUndo: true },
        metadata: () => Effect.void,
        ask: (req: Parameters<Tool.Context["ask"]>[0]) =>
          permission.ask({ ...req, sessionID, agent: "build", canUndo: true, ruleset: agent!.permission }).pipe(Effect.orDie),
      } as unknown as Tool.Context
    })
  const settled = <A, E, R>(self: Effect.Effect<A, E, R>) =>
    self.pipe(
      Effect.timeout("3 seconds"),
      Effect.map(() => "ran"),
      Effect.catchCause(() => Effect.succeed("refused")),
    )

  it.instance(
    "R-1/R-3: the read tool reads .env, server.pem, ~/.ssh/config and auth.json with the mode on; the write of ~/.ssh/config is still refused",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const sessions = yield* Session.Service
        const autonomy = yield* Autonomy.Service
        const root = yield* sessions.create({})
        yield* autonomy.setMode({ scope: "session", root: root.id, on: true })
        const ctx = yield* context(root.id)
        const reading = yield* (yield* ReadTool).init()
        const writing = yield* (yield* WriteTool).init()
        const results: string[] = []
        for (const file of [path.join(test.directory, ".env"), path.join(test.directory, "server.pem"), path.join(ssh, "config"), authFile])
          results.push(yield* settled(reading.execute({ filePath: file }, ctx)))
        results.push(yield* settled(writing.execute({ filePath: path.join(ssh, "config"), content: "replaced\n" }, ctx)))
        expect(results).toEqual(["ran", "ran", "ran", "ran", "refused"])
        expect(fs.readFileSync(path.join(ssh, "config"), "utf8")).toBe("Host fixture\n")
        expect(decided).toEqual([])
        expect(yield* (yield* Permission.Service).list()).toEqual([])
        const lines = (yield* autonomy.readAudit(root.id)).lines.flatMap((line) => (line.type === "decision" ? [line] : []))
        const reads = lines.filter((line) => line.category === "protected_read")
        expect(reads.length).toBeGreaterThanOrEqual(4)
        expect(reads.every((line) => line.class === "A" && line.decision === "allow")).toBe(true)
        expect(lines.some((line) => line.class === "X" && line.category === "protected_path")).toBe(true)
        // Names only: nothing of what the files hold is on record.
        expect(JSON.stringify(lines)).not.toContain("fixture-value")
      }),
    {
      git: true,
      init: (directory: string) =>
        Effect.sync(() => {
          fs.writeFileSync(path.join(directory, ".env"), "TOKEN=fixture-value-3\n")
          fs.writeFileSync(path.join(directory, "server.pem"), "not a key\n")
        }),
    },
  )
})
