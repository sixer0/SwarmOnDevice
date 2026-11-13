// 1.2.7 row 29 (U-7, N7-090; C7, C21, OP-1, SR7-02, SR7-03, SR7-20): under the person's consent a subagent's call that the
// overlay opened in a local category (`SUBAGENT_RUNS_LIKE_ROOT`) runs like the root's, with no decider call and the root's
// line. `sh|bash|zsh -c '<literal>'` is judged as the command line it runs (C21 b), and `sh|bash|zsh <file>` as running
// that script (C21 c). Every other opened category still goes to the main agent, where "cannot tell" refuses.
import { afterEach, beforeEach, expect, spyOn } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
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

/** `probe.sh` = `echo ok`, screen-clean, and the hash the shell would hand over for it (`metadata.scripts`, row 154). */
const probeScript = (directory: string) => {
  const file = path.join(directory, "probe.sh")
  const body = "echo ok\n"
  writeFileSync(file, body)
  return { scripts: [{ file, sha256: createHash("sha256").update(body).digest("hex") }] }
}

const SUB = { forSubagent: { agent: "build" } }

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

// U7-R1 (redefined by C21). At 04067a9d02: (1) the subagent's `sh -c 'ls'` is refused while the root's runs; (2) the
// subagent's `./probe.sh` is refused while the root's runs; (3) `sh probe.sh` is refused for both (not_reversible).
it.instance("U7-R1: `sh -c 'ls'`, `./probe.sh` and `sh probe.sh` run for root and subagent alike under consent", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    const dir = test.directory
    const { root, child } = yield* family()
    const extra = probeScript(dir)
    const seen: Array<Record<string, unknown>> = []
    for (const command of ["sh -c 'ls'", "./probe.sh", "sh probe.sh"])
      for (const [who, id] of [
        ["root", root.id],
        ["subagent", child.id],
      ] as const) {
        const got = yield* outcome(id, root.id, command, dir, extra)
        seen.push({ command, who, ran: got.ran, decider: got.decider, bypassed: got.bypassed ?? null })
      }
    expect(seen).toEqual([
      { command: "sh -c 'ls'", who: "root", ran: true, decider: [], bypassed: null },
      { command: "sh -c 'ls'", who: "subagent", ran: true, decider: [], bypassed: null },
      { command: "./probe.sh", who: "root", ran: true, decider: [], bypassed: "script" },
      { command: "./probe.sh", who: "subagent", ran: true, decider: [], bypassed: "script" },
      { command: "sh probe.sh", who: "root", ran: true, decider: [], bypassed: "script" },
      { command: "sh probe.sh", who: "subagent", ran: true, decider: [], bypassed: "script" },
    ])
    // The subagent's line is the root's, except for the session it ran in (K7-03: `via: "main_agent"`).
    const lines = yield* decisions(root.id)
    expect(lines).toHaveLength(6)
    for (const at of [0, 2, 4]) {
      const [rootLine, childLine] = [lines[at]!, lines[at + 1]!]
      expect(rootLine.sessionID).toBe(root.id)
      expect(childLine.sessionID).toBe(child.id)
      expect(shape(childLine)).toEqual(shape(rootLine))
    }
    for (const line of lines.slice(2))
      expect(line).toMatchObject({
        class: "A",
        category: "by_main_agent",
        decidedBy: "agent:main/build",
        via: "main_agent",
        decision: "allow",
        reason: Permission.BYPASS_REASON,
      })
  }),
)

// U7-R1 (C21 b, a): a readable inner command gets its own category, so a local one runs like the root's for a subagent
// (`bun install`, a screened script) and a decided one still reaches the main agent.
it.instance("U7-R1: `sh -c` takes the inner command's category, for root and subagent alike", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    const dir = test.directory
    const { root, child } = yield* family()
    const extra = probeScript(dir)
    for (const [command, bypassed, decided] of [
      ["sh -c 'bun install'", "not_routine", false],
      ["bash -c 'bun install'", "not_routine", false],
      ["zsh -c './probe.sh'", "script", false],
      ["sh -c 'curl https://example.com'", "outward", true],
      ["sh -c 'launchctl list'", "system_service", true],
    ] as const) {
      const rootGot = yield* outcome(root.id, root.id, command, dir, extra)
      expect([command, rootGot]).toEqual([
        command,
        { ran: true, decider: [], class: "A", category: "by_main_agent", bypassed, via: "main_agent" },
      ])
      const childGot = yield* outcome(child.id, root.id, command, dir, extra)
      expect([command, childGot]).toEqual([
        command,
        decided
          ? { ran: false, decider: [bypassed], class: "A", category: "by_main_agent", bypassed, via: "for_subagent" }
          : { ran: true, decider: [], class: "A", category: "by_main_agent", bypassed, via: "main_agent" },
      ])
    }
  }),
)

// N7-129 equality pin (SR7-02): a later addition to the positive list fails here. Row 29c (C41) added `check`.
it.instance("SUBAGENT_RUNS_LIKE_ROOT is exactly check, not_routine, script and outside_folder", () =>
  Effect.sync(() => {
    expect([...Permission.SUBAGENT_RUNS_LIKE_ROOT].sort()).toEqual(["check", "not_routine", "outside_folder", "script"])
  }),
)

// SR7-02: a shell write outside the project, in any spelling of home (and inside `sh -c`), is `outside_write_held` under
// consent: decided, so the subagent's call reaches the main agent, whose "cannot tell" refuses it. A copy that would
// replace there is refused outright.
// Row 29d (C46): hermetic. Home is a fresh mkdtemp folder for this test (both `os.homedir` spellings the source uses), so
// a real `~/.zshrc` on the machine running it (which would make the write an X replacement) never changes the outcome.
const tempHome = () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "h7-"))
  const spies = [spyOn(os, "homedir").mockReturnValue(home), spyOn(osModule, "homedir").mockReturnValue(home)]
  return Effect.sync(() => {
    for (const spy of spies) spy.mockRestore()
    rmSync(home, { recursive: true, force: true })
  })
}

it.instance("SR7-02: a subagent's home-spelled shell write outside the project reaches the decider", () =>
  Effect.gen(function* () {
    const restore = tempHome()
    yield* Effect.addFinalizer(() => restore)
    const test = yield* TestInstance
    const dir = test.directory
    const { root, child } = yield* family()
    writeFileSync(path.join(dir, "x"), "x\n")
    // Synthetic targets only: the home of this test run, never a real profile (the call is judged, not run).
    const home = os.homedir()
    mkdirSync(path.join(dir, "sub"), { recursive: true })
    const relativeOut = path.relative(path.join(dir, "sub"), path.join(home, ".zshrc"))
    for (const command of [
      "cat x >> ~/.zshrc",
      "cat x >> $HOME/.zshrc",
      "cat x >> ${HOME}/.zshrc",
      `cat x >> ${path.join(home, ".zshrc")}`,
      "echo x > ~/Library/LaunchAgents/com.example.probe.plist",
      "cat x | tee -a ~/.zshrc",
      `cd sub && cat ../x >> ${relativeOut}`,
      "sh -c 'echo x > ~/.zshrc'",
      "sh -c 'cat x >> $HOME/.zshrc'",
      "sh -c 'echo x >| ~/Library/LaunchAgents/com.example.probe.plist'",
      "sh -c 'ls &> ~/.zshrc'",
    ]) {
      const got = yield* outcome(child.id, root.id, command, dir)
      expect([command, got.ran, got.decider, got.bypassed, got.via]).toEqual([
        command,
        false,
        ["outside_write_held"],
        "outside_write_held",
        "for_subagent",
      ])
      expect(stub.calls[0]!.options).toEqual(SUB)
    }
    const copy = yield* outcome(child.id, root.id, "cp x ~/Library/LaunchAgents/com.example.probe.plist", dir)
    expect([copy.ran, copy.decider, copy.class]).toEqual([false, [], "X"])
  }),
)

// SR7-02: a compound call that holds one local piece and one decided piece reaches the decider, in either order.
it.instance("SR7-02: a subagent's compound of a local piece and a decided piece reaches the decider", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    const dir = test.directory
    const { root, child } = yield* family()
    const extra = probeScript(dir)
    for (const command of [
      "sh ./probe.sh && curl https://example.com",
      "curl https://example.com && sh ./probe.sh",
      "bun install && launchctl list",
      "sh -c 'ls' && launchctl list",
      "launchctl list; sh -c 'ls'",
      "sh -c 'bun install; curl https://example.com'",
    ]) {
      const got = yield* outcome(child.id, root.id, command, dir, extra)
      expect([command, got.ran, got.decider.length, got.via]).toEqual([command, false, 1, "for_subagent"])
      expect([command, Permission.SUBAGENT_RUNS_LIKE_ROOT.has(got.decider[0] ?? "")]).toEqual([command, false])
    }
  }),
)

// SR7-20 (C21 b): parse differences. A form the shell's reader does not read in full stays decided `unreadable_command`
// (the subagent's call reaches the main agent); a form it does read is judged exactly as the same text given directly,
// so wrapping a command in `sh -c` never opens more than the command itself, for root or subagent.
it.instance("SR7-20: `sh -c` parse-difference forms are never opened beyond the direct text", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    const dir = test.directory
    const { root, child } = yield* family()
    writeFileSync(path.join(dir, "x"), "x\n")
    // Read by nobody in full: decided `unreadable_command`, or a decided category the whole text shows (a URL: `outward`).
    const unread = [
      "sh -c 'ls `pwd`'",
      "sh -c 'ls $(pwd)'",
      "sh -c 'cat <(ls)'",
      "sh -c 'diff x >(cat)'",
      "sh -c 'cat <<< x'",
      "sh -c 'ls $X'",
      "sh -c 'FOO=1 bun install'",
      "sh -c 'ls\rcurl https://example.com'",
      "sh -c 'ls\u0000curl https://example.com'",
      "sh -c 'ls \\\ncurl https://example.com'",
      `sh -c "sh -c 'ls'"`,
      `bash -c "zsh -c 'bun install'"`,
      "sh -c 'eval ls'",
      "sh -c 'ls' extra",
      "sh -ec 'ls'",
    ]
    for (const command of unread) {
      const got = yield* outcome(child.id, root.id, command, dir)
      const decided = command.includes("https://") ? ["outward", "unreadable_command"] : ["unreadable_command"]
      expect([command, got.ran, got.decider.length, got.via]).toEqual([command, false, 1, "for_subagent"])
      expect([command, decided.includes(got.decider[0]!)]).toEqual([command, true])
    }
    for (const inner of [
      "ls &> out.txt",
      "ls; curl https://example.com",
      "ls || curl https://example.com",
      "curl https://example.com &",
      "bun install && ls",
      "NODE_ENV=test bun install",
      "ls -la",
    ]) {
      for (const id of [root.id, child.id]) {
        const direct = yield* outcome(id, root.id, inner, dir)
        const wrapped = yield* outcome(id, root.id, `sh -c '${inner}'`, dir)
        expect([inner, id === root.id ? "root" : "subagent", wrapped]).toEqual([inner, id === root.id ? "root" : "subagent", direct])
      }
    }
    // Expanded by the outer shell before `sh` starts, so the literal `sh` gets is the direct text's.
    for (const id of [root.id, child.id]) {
      const direct = yield* outcome(id, root.id, "ls $HOME", dir)
      const wrapped = yield* outcome(id, root.id, `sh -c "ls $HOME"`, dir)
      expect(wrapped).toEqual(direct)
    }
  }),
)

// SR7-03 CHAR: a subagent's inline interpreter code with a network reach still reaches the decider, in a decided category
// (`script_flagged` by the screen's network flag, or `outward` where the text names a URL), never a local one.
it.instance("SR7-03: a subagent's inline python3 network, node fetch and bun -e still reach the decider", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    const dir = test.directory
    const { child } = yield* family()
    for (const command of [
      `python3 -c 'import urllib.request; urllib.request.urlopen("https://example.com")'`,
      `node -e 'fetch("https://example.com")'`,
      `bun -e 'fetch("https://example.com")'`,
      `python3 -c 'import socket; socket.create_connection((h, 80))'`,
    ]) {
      stub.calls.length = 0
      const exit = yield* settled(yield* bash(child.id, command, dir))
      expect([command, Exit.isFailure(exit), stub.calls.length, stub.calls[0]?.options]).toEqual([command, true, 1, SUB])
      expect([command, ["script_flagged", "outward"].includes(stub.calls[0]!.category ?? "")]).toEqual([command, true])
    }
  }),
)

// C21 c: a script run through a shell is screened as the script it is: one that deletes is refused, never opened.
it.instance("C21 c: `sh <file>` that deletes is refused by the script screen, for root and subagent", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    const dir = test.directory
    const { root, child } = yield* family()
    const file = path.join(dir, "wipe.sh")
    const body = "rm -rf build\n"
    writeFileSync(file, body)
    const extra = { scripts: [{ file, sha256: createHash("sha256").update(body).digest("hex") }] }
    for (const id of [root.id, child.id]) {
      const got = yield* outcome(id, root.id, "sh wipe.sh", dir, extra)
      expect([got.ran, got.decider, got.class]).toEqual([false, [], "X"])
    }
    // A script the shell did not hash for this request is not opened as `script`.
    const plain = path.join(dir, "plain.sh")
    writeFileSync(plain, "echo ok\n")
    const unhashed = yield* outcome(child.id, root.id, "sh plain.sh", dir)
    expect(unhashed.ran).toBe(false)
  }),
)

// CHAR-04, CHAR-07, CHAR-08, CHAR-10 under parity: decided categories still reach the main agent for a subagent; the
// irreversible list, admin rights and plain deletions never run, wrapped in `sh -c` or not.
it.instance("CHAR: decided categories still reach the main agent for a subagent; X and admin rights never do", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    const dir = test.directory
    const { child } = yield* family()
    writeFileSync(path.join(dir, "x"), "x\n")
    stub.answer = () => Effect.succeed({ decision: "allow", decidedBy: "agent:test/stub", reason: "fine" })
    for (const command of ["curl https://example.com", "launchctl list", "pkill node", "eval $X"])
      expect(Exit.isSuccess(yield* settled(yield* bash(child.id, command, dir)))).toBe(true)
    for (const command of [
      "git reset --hard HEAD~1",
      "sudo rm -rf build",
      "git push --force",
      "sh -c 'sudo ls'",
      "sh -c 'git push --force'",
      "sh -c 'rm x'",
      "bash -c 'rm -rf build'",
    ])
      expect([command, failureOf(yield* settled(yield* bash(child.id, command, dir))) instanceof PermissionV1.DeniedError]).toEqual([
        command,
        true,
      ])
    expect(stub.calls.map((call) => [call.category, call.options])).toEqual([
      ["outward", SUB],
      ["system_service", SUB],
      ["process_not_own", SUB],
      ["unreadable_command", SUB],
    ])
  }),
)
