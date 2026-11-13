// 1.2.7 row 47h (C70, from row 47a M1-04): zsh's noclobber-override redirects (`>|`, `>!`, and the `&>|`/`&>!`/`>&|`/
// `>&!` forms) replace an existing file exactly as `>` does. In autonomous mode, with no Undo snapshot (a folder without
// Git), such an overwrite is checkpointed first (1.2.6 U6, AC-F5): the shell's own redirect reading sees the target, the
// copy of the old bytes exists before the command runs, and the person's revert puts them back. Plain `>` is unchanged.
import { afterAll, beforeAll, describe, expect } from "bun:test"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { Cause, Effect, Exit, Layer } from "effect"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Autonomy } from "@/permission/autonomy"
import { AutonomyTable } from "@/permission/autonomy-table"
// Namespace imports, so that at 1.2.5 (where these names do not exist yet) the file loads and fails on behaviour (U3).
import * as AutonomyTexts from "@/permission/autonomy-texts"
import { refusedByMode, refusedUnderConsent } from "@/permission"
import { Session } from "@/session/session"
import { Truncate } from "@/tool/truncate"
import { Tool } from "@/tool/tool"
import { Agent } from "../../src/agent/agent"
import { Plugin } from "../../src/plugin"
import { MessageID, SessionID } from "../../src/session/schema"
import { ActionCheckpoint } from "../../src/tool/checkpoint"
import * as ShellModule from "../../src/tool/shell"
import { EditTool } from "../../src/tool/edit"
import { WriteTool } from "../../src/tool/write"
import { ApplyPatchTool } from "../../src/tool/apply_patch"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Format } from "../../src/format"
import { LSP } from "../../src/lsp/lsp"
import { Permission } from "../../src/permission"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import { Question } from "../../src/question"
import { Instruction } from "../../src/session/instruction"
import { Global } from "@opencode-ai/core/global"
import { Shell } from "@opencode-ai/core/shell"
import { TestInstance } from "../fixture/fixture"
import { AutonomyReport } from "../../src/session/autonomy-report"
import { provideInstance, testInstanceStoreLayer, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const ShellTool = ShellModule.ShellTool
type Create = (input: ActionCheckpoint.CreateInput) => Promise<ActionCheckpoint.CreateResult>
const checkpointSeam: { create: Create } =
  (ShellModule as unknown as { checkpointSeam?: { create: Create } }).checkpointSeam ?? { create: async () => ({ ok: false, reason: "failed", message: "" }) }
const texts = AutonomyTexts as unknown as { CHECKPOINT_FAILED_TEXT?: string; checkpointFailedText?: (reason: string) => string }
const CHECKPOINT_FAILED_TEXT = texts.CHECKPOINT_FAILED_TEXT ?? "(CHECKPOINT_FAILED_TEXT is not there)"
const checkpointFailedText = (reason: string) => texts.checkpointFailedText?.(reason) ?? `(no checkpointFailedText for ${reason})`

const it = testEffect(
  Layer.mergeAll(
    LayerNode.compile(
      LayerNode.group([CrossSpawnSpawner.node, FSUtil.node, Plugin.node, Truncate.node, Config.node, Agent.node, RuntimeFlags.node]),
    ),
    testInstanceStoreLayer,
  ),
)
const posixOnly = process.platform === "win32" ? it.live.skip : it.live

// The person's own git settings (a signing key, hooks) are no part of this test, for the fixture's git and the shell's.
const savedGlobal = process.env.GIT_CONFIG_GLOBAL
// The tool runs the configured shell, else $SHELL; these cases are zsh's, so the run uses zsh.
const savedShell = process.env.SHELL
beforeAll(() => {
  process.env.SHELL = "/bin/zsh"
  Shell.acceptable.reset()
  process.env.GIT_CONFIG_GLOBAL = "/dev/null"
  process.env.FILTER_BRANCH_SQUELCH_WARNING = "1"
})
afterAll(() => {
  if (savedShell === undefined) delete process.env.SHELL
  else process.env.SHELL = savedShell
  Shell.acceptable.reset()
  if (savedGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL
  else process.env.GIT_CONFIG_GLOBAL = savedGlobal
  delete process.env.FILTER_BRANCH_SQUELCH_WARNING
})

const sha = (data: string | Buffer) => createHash("sha256").update(data).digest("hex")
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim()

type Line = Record<string, unknown>

/**
 * The shell with the mode on (a stub audit that keeps every line) and a gate that is the table itself, as the real gate
 * asks it: consented (`bypass`) or not. Whatever the table does not answer A stops the call before anything runs. `seen`
 * is called with each audit line as it is written, so a test can look at the disk at that moment.
 */
const shellWith = (lines: Line[], seen: (line: Line) => void = () => {}) =>
  ShellTool.pipe(
    Effect.flatMap((info) => info.init()),
    Effect.provideService(
      Autonomy.Service,
      Autonomy.Service.of({
        isOn: () => Effect.succeed(true),
        record: (_root: unknown, line: Line) =>
          Effect.sync(() => {
            seen(line)
            lines.push(line)
          }),
      } as unknown as Autonomy.Interface),
    ),
    Effect.provideService(
      Session.Service,
      Session.Service.of({ get: () => Effect.fail(new Error("no session")) } as unknown as Session.Interface),
    ),
  )

const gated = (asked: Line[], options: { canUndo: boolean; consent: boolean }) =>
  Effect.gen(function* () {
    const instance = yield* InstanceState.context
    return {
      sessionID: SessionID.make("ses_u6_checkpoint"),
      messageID: MessageID.make("msg_u6_checkpoint"),
      callID: "call_u6",
      agent: "build",
      abort: AbortSignal.any([]),
      messages: [],
      metadata: () => Effect.void,
      trust: { canUndo: options.canUndo },
      ask: (req: Omit<PermissionV1.Request, "id" | "sessionID" | "tool">) =>
        Effect.suspend(() => {
          if (req.permission !== "bash") return Effect.void
          const input: AutonomyTable.Input = {
            permission: req.permission,
            patterns: req.patterns,
            metadata: req.metadata,
            instance,
            cwd: String(req.metadata.workdir),
            canUndo: options.canUndo,
            folder: "clean",
          }
          const base = AutonomyTable.classify(input)
          const consent = AutonomyTable.classify({ ...input, bypass: { caller: "root" } })
          asked.push({ metadata: req.metadata, base, consent })
          const verdict = options.consent ? consent : base
          if (verdict.class === "A") return Effect.void
          const error = options.consent ? refusedUnderConsent(verdict.category, verdict.reason) : refusedByMode(verdict.category, verdict.reason)
          return Effect.fail(error)
        }),
    } as unknown as Tool.Context
  })

const CHECKPOINTED = { class: "A", decidedBy: "gate", category: "checkpointed" }

/** Runs `command` in `dir` through the shell and the table, both layers recorded; the consented one decides. */
const runShell = (dir: string, command: string, options: { canUndo: boolean; consent?: boolean; seen?: (line: Line) => void }) =>
  Effect.gen(function* () {
    const lines: Line[] = []
    const asked: Line[] = []
    const result = yield* Effect.gen(function* () {
      const tool = yield* shellWith(lines, options.seen)
      return yield* tool.execute({ command }, yield* gated(asked, { canUndo: options.canUndo, consent: options.consent ?? true }))
    }).pipe(provideInstance(dir), Effect.exit)
    return { result, lines, asked }
  })

const output = (exit: Exit.Exit<Tool.ExecuteResult, unknown>) => (Exit.isSuccess(exit) ? exit.value.output : "")
const failure = (exit: Exit.Exit<Tool.ExecuteResult, unknown>) =>
  Exit.isFailure(exit) ? String((Cause.squash(exit.cause) as Error).message ?? Cause.squash(exit.cause)) : ""
const idOf = (text: string) => /checkpoint (\d{8}-\d{6}-\d{1,4}) of/.exec(text)?.[1]
const checkpointFolder = (dir: string) => path.join(dir, ".swarm", "checkpoint")
const manifestOf = (dir: string, id: string) =>
  JSON.parse(fs.readFileSync(path.join(checkpointFolder(dir), id, "manifest.json"), "utf8")) as ActionCheckpoint.Manifest
const copyOf = (dir: string, id: string, rel: string) => fs.readFileSync(path.join(checkpointFolder(dir), id, rel))

const readSteps = (ShellModule as unknown as {
  readSteps: (text: string, cwd: string, options?: { zsh?: boolean }) => Promise<{ writes: string[]; steps: { argv: string[] }[] } | undefined>
}).readSteps
const zshOnly = process.platform === "win32" || !fs.existsSync("/bin/zsh") ? it.live.skip : it.live

/**
 * Runs `command` over an existing notes.txt ("old") in a folder without Git, consented and not: the call must be A
 * `checkpointed` in both layers, the copy of "old" must exist when the audit line is written (before the write), the
 * write must land, and the person's revert must bring "old" back.
 */
const checkpointedAndRevertible = (command: string, written: string) =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    const notes = path.join(dir, "notes.txt")
    fs.writeFileSync(notes, "old\n")
    let atRecord: string | undefined
    const { result, lines, asked } = yield* runShell(dir, command, {
      canUndo: false,
      seen: (line) => {
        if (line.outcome === "checkpointed") atRecord = fs.readFileSync(notes, "utf8")
      },
    })
    expect({ command, failure: failure(result) }).toEqual({ command, failure: "" })
    expect({ command, base: asked[0]!.base, consent: asked[0]!.consent }).toEqual({ command, base: CHECKPOINTED, consent: CHECKPOINTED })
    expect((asked[0]!.metadata as Line).checkpointTargets).toEqual([notes])
    const id = idOf(output(result))!
    expect(id).toBeDefined()
    expect(atRecord).toBe("old\n")
    expect(copyOf(dir, id, "notes.txt").toString()).toBe("old\n")
    expect(fs.readFileSync(notes, "utf8")).toBe(written)
    const line = lines.find((item) => item.outcome === "checkpointed")!
    const reverted = yield* Effect.promise(() =>
      ActionCheckpoint.revert({ directory: dir, id, manifestSha256: String(line.manifestSha256) }),
    )
    expect(reverted.ok).toBe(true)
    expect(fs.readFileSync(notes, "utf8")).toBe("old\n")
  })

// zsh's overrides that replace the file. `&>|` is the one the bash grammar does not know (an error node for the `|`).
const REPLACING = ["echo new >| notes.txt", "echo new 1>| notes.txt", "echo new &>| notes.txt"]
// The `!` spellings and `>&|`: the shell reads them exactly where the table reads the same file as replaced (row 47i,
// C72: `replacingTargets` skips a `!` after `>`/`>&`, and a `|` after `>&`).
const BANG = ["echo new >! notes.txt", "echo new 1>! notes.txt", "echo new &>! notes.txt", "echo new >&! notes.txt", "echo new >&| notes.txt", "echo new >!notes.txt"]

describe("rel127 47h: zsh noclobber-override redirects are checkpointed like `>` (U6, AC-F5)", () => {
  zshOnly("plain `>` is unchanged: checkpointed, the old bytes copied first, and revertible", () =>
    checkpointedAndRevertible("echo new > notes.txt", "new\n"),
  )

  zshOnly("`>|`, `1>|` and `&>|` over an existing file: checkpointed first, and the revert brings the old bytes back", () =>
    Effect.gen(function* () {
      for (const command of REPLACING) yield* checkpointedAndRevertible(command, "new\n")
    }),
  )

  zshOnly(
    "`>!`, `1>!`, `&>!`, `>&!`, `>&|` and `>!notes.txt`: checkpointed first, and revertible",
    () =>
      Effect.gen(function* () {
        for (const command of BANG) yield* checkpointedAndRevertible(command, "new\n")
      }),
  )

  it.live("the shell reads a zsh override as the redirect it overrides, and only in zsh", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const notes = path.join(dir, "notes.txt")
      const zsh = (text: string) => Effect.promise(() => readSteps(text, dir, { zsh: true }))
      const bash = (text: string) => Effect.promise(() => readSteps(text, dir))
      for (const command of REPLACING) expect({ command, writes: (yield* zsh(command))?.writes }).toEqual({ command, writes: [notes] })
      // Appends stay appends (`>>|`, `>>!`, `&>>!`): read, nothing replaced.
      for (const command of ["echo new >>| notes.txt", "echo new >>! notes.txt", "echo new &>>! notes.txt"])
        expect({ command, writes: (yield* zsh(command))?.writes }).toEqual({ command, writes: [notes] })
      // One source with the table (row 47i): the table reads each `!` spelling and `>&|` as replacing notes.txt, and the
      // shell reads the same write in zsh.
      for (const command of BANG) {
        expect({ command, replaced: AutonomyTable.replacingTargets(command) }).toEqual({ command, replaced: ["notes.txt"] })
        expect({ command, writes: (yield* zsh(command))?.writes }).toEqual({ command, writes: [notes] })
      }
      // The table: appends replace nothing, a stream move names no file, `> ! f` (apart) names the file `!`.
      for (const command of ["echo new >>| notes.txt", "echo new >>! notes.txt", "echo new &>>! notes.txt", "echo new 2>&1"])
        expect({ command, replaced: AutonomyTable.replacingTargets(command) }).toEqual({ command, replaced: [] })
      expect(AutonomyTable.replacingTargets("echo new > ! notes.txt")).toEqual(["!"])
      // `> ! f` (apart) writes a file named `!` in zsh too, and passes `f` on; it is not an override.
      expect((yield* zsh("echo new > ! notes.txt"))?.writes).not.toEqual([notes])
      // bash: `>! f` writes `!` and passes `f` to the program, `>!f` writes `!f`, `&>|` is a syntax error: all stay
      // unread outside zsh, as before.
      expect(yield* bash("echo new >! notes.txt")).toBeUndefined()
      expect(yield* bash("echo new >!notes.txt")).toBeUndefined()
      expect(yield* bash("echo new &>| notes.txt")).toBeUndefined()
      // Any other parse error still leaves the text unread.
      expect(yield* zsh("echo new &>| notes.txt )")).toBeUndefined()
    }),
  )
})
