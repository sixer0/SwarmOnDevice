// 1.2.6 row 37b (P-01b, U6, D5, SEC-19; spec 01b sections 3.3 and 9.3, 01_specs P-01b). In autonomous mode an action
// nothing could undo (I-F: known local files with no Undo snapshot; I-G: git that moves or drops refs or discards work)
// runs once a checkpoint of what it changes exists, and only then: the shell saves the targets and refs, the audit gets
// its `checkpointed` line, and only then does the command run. What no checkpoint can hold (I-N: a database, a service's
// data, a device) and a checkpoint that cannot be made (I-X) are refused `checkpoint_failed`, and nothing runs. Text-only
// destruction (I-U) and outward actions keep their 1.2.5 verdicts. Every ordering case asserts that the copy exists, with
// the bytes from before, at the moment the audit line is written, which is before the command runs.
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
import type { ActionCheckpoint } from "../../src/tool/checkpoint"
import * as ShellModule from "../../src/tool/shell"
import { EditTool } from "../../src/tool/edit"
import { WriteTool } from "../../src/tool/write"
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
beforeAll(() => {
  process.env.GIT_CONFIG_GLOBAL = "/dev/null"
  process.env.FILTER_BRANCH_SQUELCH_WARNING = "1"
})
afterAll(() => {
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

/** A Git fixture with two commits on its branch and the given uncommitted change. */
function repository(dir: string) {
  // The fixture sets `core.fsmonitor` and `commit.gpgsign`, which the git guard (rightly) does not vouch for; a plain
  // repository has neither. The person's own global settings are kept out of the run (see `GIT_CONFIG_GLOBAL` above).
  git(dir, "config", "--unset", "core.fsmonitor")
  git(dir, "config", "--unset", "commit.gpgsign")
  fs.writeFileSync(path.join(dir, "a.txt"), "one\n")
  git(dir, "add", "a.txt")
  git(dir, "commit", "-q", "-m", "one")
  fs.writeFileSync(path.join(dir, "a.txt"), "two\n")
  git(dir, "commit", "-q", "-am", "two")
  return { branch: git(dir, "symbolic-ref", "-q", "HEAD"), head: git(dir, "rev-parse", "HEAD") }
}

describe("U6 checkpoint: I-F files with no Undo (folder without Git)", () => {
  posixOnly("CK-1: `echo new > notes.txt` runs as A `checkpointed`; the copy of the old bytes exists before the write", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const notes = path.join(dir, "notes.txt")
      fs.writeFileSync(notes, "old\n")
      let atRecord: string | undefined
      const { result, lines, asked } = yield* runShell(dir, "echo new > notes.txt", {
        canUndo: false,
        seen: (line) => {
          if (line.outcome === "checkpointed") atRecord = fs.readFileSync(notes, "utf8")
        },
      })
      expect(failure(result)).toBe("")
      // Both layers: the 1.1.0 table and the consented overlay.
      expect(asked[0]!.base).toEqual(CHECKPOINTED)
      expect(asked[0]!.consent).toEqual(CHECKPOINTED)
      expect((asked[0]!.metadata as Line).checkpointTargets).toEqual([notes])
      const id = idOf(output(result))!
      expect(output(result)).toContain(`.swarm/checkpoint/${id}`)
      // Ordering: when the line was written the file still held the old bytes, and the copy holds them now.
      expect(atRecord).toBe("old\n")
      expect(sha(copyOf(dir, id, "notes.txt"))).toBe(sha("old\n"))
      expect(fs.readFileSync(notes, "utf8")).toBe("new\n")
      expect(lines).toEqual([expect.objectContaining({ type: "outcome", outcome: "checkpointed", checkpoint: id, entries: 1 })])
      expect(lines[0]!.manifestSha256).toBe(sha(fs.readFileSync(path.join(checkpointFolder(dir), id, "manifest.json"))))
    }),
  )

  posixOnly("CK-2: `sed -i '' 's/a/b/' a.md` runs as A `checkpointed`, the copy holds the bytes from before", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const file = path.join(dir, "a.md")
      fs.writeFileSync(file, "a\n")
      let atRecord: string | undefined
      const { result, asked } = yield* runShell(dir, "sed -i '' 's/a/b/' a.md", {
        canUndo: false,
        seen: (line) => {
          if (line.outcome === "checkpointed") atRecord = fs.readFileSync(file, "utf8")
        },
      })
      expect(failure(result)).toBe("")
      expect(asked[0]!.consent).toEqual(CHECKPOINTED)
      const id = idOf(output(result))!
      expect(atRecord).toBe("a\n")
      expect(copyOf(dir, id, "a.md").toString()).toBe("a\n")
      expect(fs.readFileSync(file, "utf8")).toBe("b\n")
    }),
  )

  posixOnly("I-F keeps every other reason: a secret and a sensitive file are not checkpointed and keep their 1.2.5 verdict", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      fs.writeFileSync(path.join(dir, "package.json"), "{}\n")
      fs.writeFileSync(path.join(dir, ".env"), "A=1\n")
      const expected: Record<string, [string, string]> = {
        "echo x > package.json": ["sensitive_file", "not_reversible"],
        "echo x > .env": ["secret_file", "not_reversible"],
      }
      for (const [command, [base, consent]] of Object.entries(expected)) {
        const { result, asked } = yield* runShell(dir, command, { canUndo: false })
        expect(Exit.isFailure(result)).toBe(true)
        expect({ command, base: (asked[0]!.base as Line).category, consent: (asked[0]!.consent as Line).category }).toEqual({ command, base, consent })
      }
      // A look at a secret beside a write is no checkpoint case either; its verdict is the 1.2.5 one (T-INV-2).
      const { asked } = yield* runShell(dir, "cat .env > out.txt", { canUndo: false })
      expect((asked[0]!.metadata as Line).checkpointTargets).toBeUndefined()
      for (const layer of ["base", "consent"] as const) expect((asked[0]![layer] as Line).category).not.toBe("checkpointed")
      expect(fs.readFileSync(path.join(dir, "package.json"), "utf8")).toBe("{}\n")
      expect(fs.readFileSync(path.join(dir, ".env"), "utf8")).toBe("A=1\n")
      expect(fs.existsSync(checkpointFolder(dir))).toBe(false)
    }),
  )
})

describe("U6 checkpoint: I-G git in a repository", () => {
  posixOnly("CK-3: `git reset --hard HEAD~1` is checkpointed with refs, a keep-alive ref and the uncommitted file", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const { branch, head } = repository(dir)
      fs.writeFileSync(path.join(dir, "a.txt"), "uncommitted\n")
      let refsAtRecord = ""
      const { result, asked } = yield* runShell(dir, "git reset --hard HEAD~1", {
        canUndo: true,
        seen: (line) => {
          if (line.outcome === "checkpointed") refsAtRecord = git(dir, "rev-parse", "HEAD")
        },
      })
      expect(failure(result)).toBe("")
      expect(asked[0]!.base).toEqual(CHECKPOINTED)
      expect(asked[0]!.consent).toEqual(CHECKPOINTED)
      const id = idOf(output(result))!
      // Ordering: HEAD had not moved when the checkpoint was on record.
      expect(refsAtRecord).toBe(head)
      const manifest = manifestOf(dir, id)
      expect(manifest.refs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "HEAD", sha: head }),
          expect.objectContaining({ name: branch, sha: head }),
        ]),
      )
      for (const ref of manifest.refs!) expect(git(dir, "rev-parse", ref.keep)).toBe(ref.sha)
      expect(copyOf(dir, id, "a.txt").toString()).toBe("uncommitted\n")
      expect(git(dir, "rev-parse", "HEAD")).not.toBe(head)
      expect(output(result)).toContain("refs/swarm-checkpoint")
    }),
  )

  posixOnly("CK-4: `git clean -fdx` copies an ignored and a large untracked file first, and spares .swarm", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      repository(dir)
      fs.writeFileSync(path.join(dir, ".gitignore"), "dist/\n")
      git(dir, "add", ".gitignore")
      git(dir, "commit", "-q", "-m", "ignore")
      fs.mkdirSync(path.join(dir, "dist"))
      fs.writeFileSync(path.join(dir, "dist", "x.js"), "built\n")
      const large = Buffer.alloc(3 * 1024 * 1024, 7)
      fs.writeFileSync(path.join(dir, "big.bin"), large)
      let atRecord = false
      const { result, asked } = yield* runShell(dir, "git clean -fdx", {
        canUndo: true,
        seen: (line) => {
          if (line.outcome === "checkpointed") atRecord = fs.existsSync(path.join(dir, "dist", "x.js")) && fs.existsSync(path.join(dir, "big.bin"))
        },
      })
      expect(failure(result)).toBe("")
      expect(asked[0]!.consent).toEqual(CHECKPOINTED)
      const id = idOf(output(result))!
      expect(atRecord).toBe(true)
      const manifest = manifestOf(dir, id)
      const how = Object.fromEntries(manifest.entries.map((entry) => [entry.path, entry.how]))
      expect(how).toMatchObject({ "dist/x.js": "copy", "big.bin": "copy" })
      expect(copyOf(dir, id, "dist/x.js").toString()).toBe("built\n")
      expect(sha(copyOf(dir, id, "big.bin"))).toBe(sha(large))
      expect(fs.existsSync(path.join(dir, "dist"))).toBe(false)
      expect(fs.existsSync(path.join(dir, "big.bin"))).toBe(false)
      // The clean ran with the session's .swarm left out, so the checkpoint made for it is still there.
      expect(fs.existsSync(path.join(checkpointFolder(dir), id, "manifest.json"))).toBe(true)
    }),
  )

  posixOnly("CK-5: `git branch -D`, `git stash drop` and `git commit --amend` are checkpointed with their refs", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const { branch, head } = repository(dir)
      git(dir, "branch", "topic")
      const topic = git(dir, "rev-parse", "topic")
      fs.writeFileSync(path.join(dir, "a.txt"), "stashed\n")
      git(dir, "stash", "-q")
      const stash = git(dir, "rev-parse", "refs/stash")
      const cases: [string, Record<string, string>][] = [
        ["git branch -D topic", { "refs/heads/topic": topic }],
        ["git stash drop", { "refs/stash": stash }],
        ["git commit --amend -m amended", { HEAD: head, [branch]: head }],
      ]
      for (const [command, refs] of cases) {
        const { result, asked } = yield* runShell(dir, command, { canUndo: true })
        expect({ command, failure: failure(result) }).toEqual({ command, failure: "" })
        expect({ command, verdict: asked[0]!.consent }).toEqual({ command, verdict: CHECKPOINTED })
        const id = idOf(output(result))!
        const kept = Object.fromEntries(manifestOf(dir, id).refs!.map((ref) => [ref.name, ref.sha]))
        expect(kept).toMatchObject(refs)
        for (const [name, value] of Object.entries(refs)) expect(git(dir, "rev-parse", `refs/swarm-checkpoint/${id}/${Object.keys(kept).indexOf(name)}`)).toBe(value)
      }
      expect(git(dir, "branch", "--list", "topic")).toBe("")
    }),
  )

  // SEC-19 (CK-5 extended): after a history rewrite the agent is told where the old commits stay. `git reflog expire` and
  // `git gc --prune` left this list in row 37c (C17): they are refused, see "37c" below.
  posixOnly("SEC-19: after `git filter-branch` the agent line names refs/swarm-checkpoint", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const { head } = repository(dir)
      for (const command of ["git filter-branch -f HEAD"]) {
        const { result, asked } = yield* runShell(dir, command, { canUndo: true })
        expect({ command, verdict: asked[0]!.consent }).toEqual({ command, verdict: CHECKPOINTED })
        const id = idOf(output(result))!
        expect(output(result)).toContain(`Old commits stay under refs/swarm-checkpoint/${id}`)
        expect(manifestOf(dir, id).refs!.some((ref) => ref.sha === head)).toBe(true)
      }
    }),
  )
})

/** Row 37c: the verdicts plain `git gc` had at 069d49682b (row 37b), pinned so the refusal stays limited to pruning. */
const PLAIN_GC = {
  consent: { class: "A", decidedBy: "agent", category: "by_main_agent", bypassed: "not_routine" },
  base: { class: "D", decidedBy: "gate", category: "not_routine" },
}

describe("U6 checkpoint: what no checkpoint holds, or cannot be made", () => {
  // 1.2.6 row 37c (C17): an expired reflog and a pruning gc drop commits only the reflog reaches. A checkpoint keeps ref
  // names, not reflog entries, so these two cannot be checkpointed and are refused before anything runs.
  posixOnly("37c (C17): `git reflog expire` and `git gc --prune…` are X `checkpoint_failed` with the git reason; nothing runs", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      repository(dir)
      const reflog = git(dir, "reflog", "--all", "--format=%H")
      const commands = [
        "git reflog expire --expire=now --all",
        "git reflog expire --all",
        "git gc --prune=now",
        "git gc --prune",
        "git gc --aggressive --prune=now",
        "git gc --prune=now --aggressive",
      ]
      for (const command of commands) {
        for (const consent of [true, false]) {
          const { result, asked, lines } = yield* runShell(dir, command, { canUndo: true, consent })
          const verdict = (consent ? asked[0]!.consent : asked[0]!.base) as AutonomyTable.Verdict
          expect({ command, consent, verdict }).toEqual({
            command,
            consent,
            verdict: { class: "X", decidedBy: "gate", category: "checkpoint_failed", reason: "git" },
          })
          expect({ command, failure: failure(result) }).toEqual({ command, failure: checkpointFailedText("git") })
          expect(lines).toEqual([])
          expect((asked[0]!.metadata as Line).checkpointTargets).toBeUndefined()
        }
      }
      expect(git(dir, "reflog", "--all", "--format=%H")).toBe(reflog)
      expect(fs.existsSync(checkpointFolder(dir))).toBe(false)
    }),
  )

  posixOnly("37c: plain `git gc` (no prune) keeps the verdict it had before row 37c", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      repository(dir)
      for (const command of ["git gc", "git gc --aggressive", "git gc -q"]) {
        const { asked } = yield* runShell(dir, command, { canUndo: true })
        expect({ command, consent: asked[0]!.consent, base: asked[0]!.base }).toEqual({ command, ...PLAIN_GC })
      }
    }),
  )

  posixOnly("CK-8 (I-N): `dropdb app`, `redis-cli flushall` and `dd` are X `checkpoint_failed` with the not-files reason; nothing runs", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      for (const command of ["dropdb app", "redis-cli flushall", `dd of=${path.join(dir, "out.img")} if=/dev/zero count=1`]) {
        for (const consent of [true, false]) {
          const { result, asked, lines } = yield* runShell(dir, command, { canUndo: false, consent })
          const verdict = (consent ? asked[0]!.consent : asked[0]!.base) as AutonomyTable.Verdict
          expect({ command, consent, verdict }).toEqual({
            command,
            consent,
            verdict: { class: "X", decidedBy: "gate", category: "checkpoint_failed", reason: "not_files" },
          })
          expect(failure(result)).toBe(checkpointFailedText("not_files"))
          expect(failure(result)).not.toContain(command.split(" ")[0]!)
          expect(lines).toEqual([])
        }
      }
      expect(fs.existsSync(path.join(dir, "out.img"))).toBe(false)
      expect(fs.existsSync(checkpointFolder(dir))).toBe(false)
    }),
  )

  posixOnly("CK-9 (I-X): over the cap, or with .swarm a link, the call is refused `checkpoint_failed` and the bytes stay", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const notes = path.join(dir, "notes.txt")
      fs.writeFileSync(notes, "old\n")
      const real = checkpointSeam.create
      checkpointSeam.create = (input) => real({ ...input, maxBytes: 1 })
      const over = yield* runShell(dir, "echo new > notes.txt", { canUndo: false }).pipe(
        Effect.ensuring(Effect.sync(() => (checkpointSeam.create = real))),
      )
      expect(output(over.result)).toBe(checkpointFailedText("too_large"))
      expect(fs.readFileSync(notes, "utf8")).toBe("old\n")
      expect(over.lines).toEqual([expect.objectContaining({ outcome: "not_run", by: "system:checkpoint_failed" })])

      const away = yield* tmpdirScoped()
      fs.symlinkSync(away, path.join(dir, ".swarm"))
      const linked = yield* runShell(dir, "echo new > notes.txt", { canUndo: false })
      expect(output(linked.result)).toBe(checkpointFailedText("checkpoint_link"))
      expect(fs.readFileSync(notes, "utf8")).toBe("old\n")
      expect(fs.readdirSync(away)).toEqual([])
    }),
  )

  posixOnly("CK-12 (INV-4): a checkpoint seam that throws stops an I-F call; the bytes are unchanged", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const notes = path.join(dir, "notes.txt")
      fs.writeFileSync(notes, "old\n")
      const real = checkpointSeam.create
      checkpointSeam.create = () => Promise.reject(new Error("seam"))
      const { result, lines } = yield* runShell(dir, "echo new > notes.txt", { canUndo: false }).pipe(
        Effect.ensuring(Effect.sync(() => (checkpointSeam.create = real))),
      )
      expect(output(result)).toBe(checkpointFailedText("failed"))
      expect(output(result).startsWith(CHECKPOINT_FAILED_TEXT.slice(0, 30))).toBe(true)
      expect(fs.readFileSync(notes, "utf8")).toBe("old\n")
      expect(lines.some((line) => line.outcome === "checkpointed")).toBe(false)
    }),
  )
})

describe("U6 checkpoint: I-U and outward keep their 1.2.5 verdicts", () => {
  posixOnly("CK-10 (I-U): `sh -c 'rm -rf build'` and `find -delete` keep their categories; no checkpoint", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      fs.mkdirSync(path.join(dir, "build"))
      fs.writeFileSync(path.join(dir, "build", "a.tmp"), "x")
      const expected: Record<string, string> = { "sh -c 'rm -rf build'": "not_reversible", "find . -name '*.tmp' -delete": "delete_compound" }
      for (const [command, category] of Object.entries(expected)) {
        const { result, asked } = yield* runShell(dir, command, { canUndo: false })
        expect(Exit.isFailure(result)).toBe(true)
        expect({ command, category: (asked[0]!.consent as Line).category }).toEqual({ command, category })
        expect((asked[0]!.metadata as Line).checkpointTargets).toBeUndefined()
      }
      expect(fs.existsSync(path.join(dir, "build", "a.tmp"))).toBe(true)
      expect(fs.existsSync(checkpointFolder(dir))).toBe(false)
    }),
  )

  posixOnly("CK-11 (outward): `git push --force` and `aws s3 rm` stay X `irreversible`; no checkpoint is attempted", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      repository(dir)
      for (const command of ["git push --force origin main", "aws s3 rm s3://b/k"]) {
        const { result, asked } = yield* runShell(dir, command, { canUndo: true })
        expect(Exit.isFailure(result)).toBe(true)
        expect({ command, verdict: (asked[0]!.consent as Line).class, category: (asked[0]!.consent as Line).category }).toEqual({
          command,
          verdict: "X",
          category: "irreversible",
        })
        expect((asked[0]!.metadata as Line).checkpointTargets).toBeUndefined()
      }
      expect(fs.existsSync(checkpointFolder(dir))).toBe(false)
    }),
  )
})

describe("U6 checkpoint: the gate believes `checkpointed` only with the shell's word", () => {
  posixOnly("without `checkpointTargets` an I-F or I-G call keeps its 1.2.5 verdict", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      repository(dir)
      const instance = yield* InstanceState.context.pipe(provideInstance(dir))
      for (const command of ["git reset --hard HEAD~1", "git branch -D topic"]) {
        const input: AutonomyTable.Input = {
          permission: "bash",
          patterns: [command],
          metadata: { command, workdir: dir, risk: "irreversible" },
          instance,
          cwd: dir,
          canUndo: true,
          folder: "clean",
        }
        expect(AutonomyTable.classify(input)).toEqual({ class: "D", decidedBy: "gate", category: "not_reversible" })
        expect(AutonomyTable.classify({ ...input, bypass: { caller: "root" } })).toEqual({ class: "X", decidedBy: "gate", category: "irreversible" })
        // With the word, but a target the shell left out: still not believed.
        expect(AutonomyTable.classify({ ...input, metadata: { ...input.metadata, checkpointTargets: [] } }).category).toBe("checkpointed")
      }
      const nogit = yield* tmpdirScoped()
      fs.writeFileSync(path.join(nogit, "notes.txt"), "old\n")
      const plain = yield* InstanceState.context.pipe(provideInstance(nogit))
      const steps = { v: 1, steps: [{ argv: ["echo", "new"], cwds: [nogit] }], writes: [path.join(nogit, "notes.txt")] }
      const input: AutonomyTable.Input = {
        permission: "bash",
        patterns: ["echo new > notes.txt"],
        metadata: { command: "echo new > notes.txt", workdir: nogit, steps, checkpointTargets: [] },
        instance: plain,
        cwd: nogit,
        canUndo: false,
        folder: "clean",
      }
      expect(AutonomyTable.classify({ ...input, bypass: { caller: "root" } }).category).not.toBe("checkpointed")
    }),
  )
})

// The same through the real gate, the real audit and the real tools (the 1.1.0 table: the mode on, no consent). CK-6/CK-7:
// a file tool's write that no Undo covers keeps its verdict and gets a checkpoint first; CK-1 again, end to end.
const full = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Permission.node, Session.node, Autonomy.node, EventV2Bridge.node, SessionProjector.node, CrossSpawnSpawner.node,
      InstanceStore.node, Question.node, FSUtil.node, Plugin.node, Truncate.node, Config.node, Agent.node, RuntimeFlags.node,
      LSP.node, Format.node, Instruction.node,
    ]),
    [
      [InstanceStore.bootstrapNode, Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))],
      [
        Permission.deciderNode,
        Layer.succeed(
          Permission.Decider,
          Permission.Decider.of({ decide: () => Effect.succeed({ decision: "reject" as const, decidedBy: "agent:test/stub" }) }),
        ),
      ],
    ],
  ),
)

describe("U6 checkpoint through the real gate and audit", () => {
  const modeFolder = path.join(Global.Path.state, "autonomy")
  const context = (sessionID: SessionID, canUndo: boolean) =>
    Effect.gen(function* () {
      const permission = yield* Permission.Service
      const agent = yield* (yield* Agent.Service).get("build")
      return {
        sessionID,
        messageID: MessageID.ascending(),
        callID: `call_${Math.random().toString(36).slice(2)}`,
        agent: "build",
        abort: AbortSignal.any([]),
        messages: [],
        trust: { canUndo },
        metadata: () => Effect.void,
        ask: (req: Parameters<Tool.Context["ask"]>[0]) =>
          permission.ask({ ...req, sessionID, agent: "build", canUndo, ruleset: agent!.permission }).pipe(Effect.orDie),
      } as unknown as Tool.Context
    })
  const start = Effect.gen(function* () {
    fs.rmSync(modeFolder, { recursive: true, force: true })
    const sessions = yield* Session.Service
    const autonomy = yield* Autonomy.Service
    const root = yield* sessions.create({})
    yield* autonomy.setMode({ scope: "session", root: root.id, on: true })
    return { root, autonomy }
  })
  const audit = (autonomy: Autonomy.Interface, root: SessionID) =>
    autonomy.readAudit(root).pipe(Effect.map((read) => read.lines as unknown as Line[]))

  full.instance("CK-6: the edit tool on an existing file without Undo runs as before, after a checkpoint of the old bytes", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const file = path.join(test.directory, "a.md")
      fs.writeFileSync(file, "old text\n")
      const { root, autonomy } = yield* start
      const ctx = yield* context(root.id, false)
      const editing = yield* (yield* EditTool).init()
      const result = yield* editing.execute({ filePath: file, oldString: "old", newString: "new" }, ctx)
      expect(fs.readFileSync(file, "utf8")).toBe("new text\n")
      const id = idOf(result.output)!
      expect(copyOf(test.directory, id, "a.md").toString()).toBe("old text\n")
      const lines = yield* audit(autonomy, root.id)
      const decision = lines.findIndex((line) => line.type === "decision" && line.permission === "edit")
      const saved = lines.findIndex((line) => line.type === "outcome" && line.outcome === "checkpointed")
      // The verdict is the 1.2.5 one (A, an ordinary file nothing can undo), and the checkpoint is on record after it.
      expect(lines[decision]).toMatchObject({ class: "A", decision: "allow" })
      expect(saved).toBeGreaterThan(decision)
      expect(lines[saved]).toMatchObject({ checkpoint: id, entries: 1 })
      fs.rmSync(modeFolder, { recursive: true, force: true })
    }),
  )

  // 1.2.6 FX-12 (C23 SF3): edit, write, apply_patch and the shell share one save-or-stop helper. A checkpoint call that
  // throws is a `failed` checkpoint under the edit tool too: the call is refused, nothing is written, and the audit gets
  // its `not_run` line from `system:checkpoint_failed`. At HEAD before FX-12 the edit tool did not go through the seam
  // (and a rejection would have been a defect with no audit line).
  full.instance("CK-12b: under the edit tool a checkpoint call that throws refuses the edit and writes the not_run line", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const file = path.join(test.directory, "a.md")
      fs.writeFileSync(file, "old text\n")
      const { root, autonomy } = yield* start
      const ctx = yield* context(root.id, false)
      const editing = yield* (yield* EditTool).init()
      const real = checkpointSeam.create
      checkpointSeam.create = () => Promise.reject(new Error("seam"))
      const exit = yield* editing
        .execute({ filePath: file, oldString: "old", newString: "new" }, ctx)
        .pipe(Effect.exit, Effect.ensuring(Effect.sync(() => (checkpointSeam.create = real))))
      expect(failure(exit)).toBe(checkpointFailedText("failed"))
      expect(fs.readFileSync(file, "utf8")).toBe("old text\n")
      const lines = yield* audit(autonomy, root.id)
      expect(lines.filter((line) => line.type === "outcome" && line.outcome === "not_run")).toEqual([
        expect.objectContaining({ by: "system:checkpoint_failed", requestID: ctx.callID }),
      ])
      expect(lines.some((line) => line.outcome === "checkpointed")).toBe(false)
      fs.rmSync(modeFolder, { recursive: true, force: true })
    }),
  )

  full.instance("CK-7: the write tool's outside_edit of an existing file outside the project is copied under _outside first", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const away = fs.mkdtempSync(path.join(fs.realpathSync(require("node:os").tmpdir()), "u6-outside-"))
      const file = path.join(away, "a.ts")
      fs.writeFileSync(file, "export const a = 1\n")
      const { root, autonomy } = yield* start
      const ctx = yield* context(root.id, true)
      const writing = yield* (yield* WriteTool).init()
      const result = yield* writing.execute({ filePath: file, content: "export const a = 2\n" }, ctx)
      expect(fs.readFileSync(file, "utf8")).toBe("export const a = 2\n")
      const id = idOf(result.output)!
      const manifest = manifestOf(test.directory, id)
      expect(manifest.entries).toEqual([expect.objectContaining({ path: file, outside: true })])
      expect(copyOf(test.directory, id, manifest.entries[0]!.rel).toString()).toBe("export const a = 1\n")
      expect(manifest.entries[0]!.rel.startsWith("_outside/")).toBe(true)
      const lines = yield* audit(autonomy, root.id)
      expect(lines.some((line) => line.type === "decision" && line.category === "outside_edit" && line.class === "A")).toBe(true)
      expect(lines.some((line) => line.type === "outcome" && line.outcome === "checkpointed" && line.checkpoint === id)).toBe(true)
      fs.rmSync(away, { recursive: true, force: true })
      fs.rmSync(modeFolder, { recursive: true, force: true })
    }),
    { git: true },
  )

  full.instance("CK-1 end to end: the gate's A `checkpointed` line, then the checkpoint line, then the write", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const notes = path.join(test.directory, "notes.txt")
      fs.writeFileSync(notes, "old\n")
      const { root, autonomy } = yield* start
      const ctx = yield* context(root.id, false)
      const shell = yield* (yield* ShellTool).init()
      const result = yield* shell.execute({ command: "echo new > notes.txt" }, ctx)
      expect(fs.readFileSync(notes, "utf8")).toBe("new\n")
      const id = idOf(result.output)!
      expect(sha(copyOf(test.directory, id, "notes.txt"))).toBe(sha("old\n"))
      const lines = yield* audit(autonomy, root.id)
      const decision = lines.findIndex((line) => line.type === "decision" && line.permission === "bash")
      const saved = lines.findIndex((line) => line.type === "outcome" && line.outcome === "checkpointed")
      expect(lines[decision]).toMatchObject({ class: "A", category: "checkpointed", decision: "allow" })
      expect(saved).toBeGreaterThan(decision)
      fs.rmSync(modeFolder, { recursive: true, force: true })
    }),
  )
})

// 01b section 9.7: the end report lists each checkpoint under its own heading, by id; `checkpoint_failed` is a refusal,
// and the archive-redirect categories stay under "Redirected".
describe("U6 checkpoint in the end report", () => {
  for (const [language, heading] of [["en", "## Checkpointed"], ["id", "## Disimpan sebagai checkpoint"]] as const)
    it.live(`a checkpointed line is listed under "${heading}" with its id (${language})`, () =>
      Effect.sync(() => {
        let seq = 0
        const at = (n: number) => ({ v: 1 as const, seq: seq++, prev: null, at: 1_000 + n })
        const decision = (n: number, fields: Record<string, unknown>) =>
          ({
            ...at(n),
            type: "decision",
            rootID: "ses_r",
            sessionID: "ses_r",
            requestID: `per_${n}`,
            agent: "build",
            directory: "/project",
            permission: "bash",
            patterns: ["echo new > notes.txt"],
            patternsTruncated: false,
            class: "A",
            risk: null,
            canUndo: false,
            decidedBy: "gate",
            decision: "allow",
            memo: false,
            follows: [],
            ...fields,
          }) as unknown as Autonomy.AuditLine
        const body = AutonomyReport.render({
          run: { root: SessionID.make("ses_r"), directory: "/project", since: 1_000, until: 2_000, language },
          lines: [
            decision(1, { category: "checkpointed" }),
            {
              ...at(2),
              type: "outcome",
              requestID: "per_1",
              outcome: "checkpointed",
              checkpoint: "20261112-101500-1",
              entries: 1,
              bytes: 4,
              refs: 0,
              manifestSha256: "a".repeat(64),
            } as unknown as Autonomy.AuditLine,
            decision(3, { class: "X", category: "checkpoint_failed", decision: "reject", patterns: ["dropdb app"] }),
          ],
          open: [],
          goal: [],
          files: [],
          todos: [],
          attached: [],
          skipped: [],
          sends: new Map(),
        } as unknown as AutonomyReport.Facts)
        const text = typeof body === "string" ? body : JSON.stringify(body)
        expect(text).toContain(heading)
        expect(text).toContain("`20261112-101500-1`")
        expect(text).toContain("dropdb app")
      }),
    )
})
