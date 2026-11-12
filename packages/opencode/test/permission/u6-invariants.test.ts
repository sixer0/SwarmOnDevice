// 1.2.6 row 37b (P-01b; U6, U12, D5; spec 01b sections 2, 4 and 9.8): what U6 must not change. Every fixture below is
// classified in both autonomous layers (the 1.1.0 table, and the consented no-wait overlay of the root) and compared with
// the verdicts the same fixtures had at 1.2.5 (e363918a69), recorded once in `fixtures/u6-baseline-1.2.5.json`.
//   T-INV-1  other reasons stand: every hold or refusal other than the ones U6/U12 name keeps its 1.2.5 verdict.
//   T-INV-2  a read must be proven: these are no `protected_read`, and no `checkpointed` either.
//   T-INV-3/5 outward unchanged (D5): every outward fixture deep-equals 1.2.5, with or without a forged `checkpointTargets`.
//   T-INV-4  no checkpoint, no run: the shell's checkpoint seam fails, the bytes stay, the answer is CHECKPOINT_FAILED_TEXT.
//   T-INV-6  never stricter: every fixture that was A at 1.2.5 is A still.
// The baseline is written by running this file at e363918a69 with U6_BASELINE_WRITE set to the fixture's path; the cases
// read nothing of the code under test, so the same file runs at both commits.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { Effect, Exit, Layer } from "effect"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Autonomy } from "@/permission/autonomy"
import { Session } from "@/session/session"
import { Truncate } from "@/tool/truncate"
import { Tool } from "@/tool/tool"
import { Agent } from "../../src/agent/agent"
import { Plugin } from "../../src/plugin"
import { AutonomyTable } from "../../src/permission/autonomy-table"
import type { InstanceContext } from "../../src/project/instance-context"
import { MessageID, SessionID } from "../../src/session/schema"
import { ShellTool, readSteps } from "../../src/tool/shell"
import { provideInstance, testInstanceStoreLayer, tmpdir, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

type Input = AutonomyTable.Input
type Verdict = AutonomyTable.Verdict
type Recorded = Record<string, { base: Verdict; consent: Verdict }>

const BASELINE = path.join(import.meta.dir, "fixtures", "u6-baseline-1.2.5.json")

let git: Awaited<ReturnType<typeof tmpdir>>
let plain: Awaited<ReturnType<typeof tmpdir>>
let inGit: InstanceContext
let inPlain: InstanceContext

beforeAll(async () => {
  git = await tmpdir({ git: true })
  plain = await tmpdir()
  for (const dir of [git.path, plain.path]) {
    fs.mkdirSync(path.join(dir, "src"), { recursive: true })
    fs.writeFileSync(path.join(dir, "src/a.ts"), "export const a = 1\n")
    fs.writeFileSync(path.join(dir, "notes.txt"), "old\n")
    fs.writeFileSync(path.join(dir, "package.json"), "{}\n")
    fs.writeFileSync(path.join(dir, ".env"), "TOKEN=fixture-value\n")
    fs.writeFileSync(path.join(dir, "f"), "payload\n")
  }
  inGit = { directory: git.path, worktree: git.path, project: { vcs: "git" } } as unknown as InstanceContext
  inPlain = { directory: plain.path, worktree: "/", project: {} } as unknown as InstanceContext
})
afterAll(async () => {
  await git[Symbol.asyncDispose]()
  await plain[Symbol.asyncDispose]()
})

type Case = { name: string; input: () => Promise<Input> }
const where = (fields: { nogit?: boolean }) => (fields.nogit ? { instance: inPlain, cwd: plain.path, canUndo: false } : { instance: inGit, cwd: git.path, canUndo: true })
const request = (permission: string, fields: Partial<Input> & { nogit?: boolean } = {}): Input => {
  const { nogit, ...rest } = fields
  return { permission, patterns: ["*"], metadata: {}, folder: "clean", ...where({ nogit }), ...rest }
}
/** A shell call as the shell asks it in the mode: the text, its folder, the risk label it gives and its own reading. */
const shell = (command: string, fields: { nogit?: boolean; risk?: string; extra?: Record<string, unknown> } & Partial<Input> = {}) =>
  async () => {
    const { nogit, risk, extra, ...rest } = fields
    const base = where({ nogit })
    const steps = await readSteps(command, base.cwd)
    return request("bash", {
      nogit,
      patterns: [command],
      metadata: { command, workdir: base.cwd, ...(risk ? { risk } : {}), ...(steps ? { steps } : {}), ...extra },
      ...rest,
    })
  }
const edit = (name: string, fields: Partial<Input> & { nogit?: boolean } = {}) => async () => {
  const base = where({ nogit: fields.nogit })
  return request("edit", { patterns: [name], metadata: { filepath: path.resolve(base.cwd, name) }, editClass: "ordinary", ...fields })
}
const of = (name: string, input: () => Promise<Input>): Case => ({ name, input })

// T-INV-1: a fixture per hold or refusal U6 and U12 leave alone (01b section 2, INV-1).
const OTHER_REASONS: Case[] = [
  of("admin sudo", shell("sudo ls")),
  of("admin doas", shell("doas make install")),
  of("credential remote add", shell("git remote add x https://example.com/x.git")),
  of("credential helper", shell("git config credential.helper store")),
  of("outside write tee", shell("echo x | tee /tmp/u6-invariant-x")),
  of("sensitive edit", edit("package.json", { editClass: "sensitive" })),
  of("sensitive shell write, no git", shell("echo x > package.json", { nogit: true })),
  of("secret edit", edit(".env", { editClass: "secret" })),
  of("secret shell write, no git", shell("echo x > .env", { nogit: true })),
  of("folder not trusted", shell("bun test", { folder: "ask" })),
  of("plan edits source", edit("src/a.ts", { plan: true })),
  of("plan runs a check", shell("bun test", { plan: true })),
  of("stops Swarm", shell("pkill -f Swarm")),
  of("deletion beside another command", shell("rm src/a.ts && rm notes.txt")),
  of("a person's ask-every-time", shell("ls src", { rule: "user_catch_all" })),
  of("a person's deny", shell("ls src", { rule: "deny" })),
  of("program run", shell("node x.js")),
  of("project script inline", shell("python3 -c 'print(1)'")),
  of("delete by find", shell("find . -name '*.tmp' -delete")),
  of("shell text deletes", shell("sh -c 'rm -rf build'")),
  of("system service", shell("launchctl unload x.plist")),
  of("host shutdown", shell("shutdown -h now", { risk: "irreversible" })),
]

// T-INV-2: not proven reads (01b R7, INV-2).
const NOT_READS: Case[] = [
  of("lsp without readOnly", async () => request("lsp", { metadata: { filepath: path.join(git.path, "src/a.ts") } })),
  of("secret look into a file", shell("cat .env > out.txt")),
  of("secret look into a file, no git", shell("cat .env > out.txt", { nogit: true })),
  of("env runs a program", shell("env FOO=1 node x.js")),
]

// T-INV-3/5: outward (O1-O4), each also with a `checkpointTargets` the shell never gives for it.
const OUTWARD_COMMANDS: [string, string?][] = [
  ["curl https://example.com"],
  ["curl -X POST -d @f https://api.example.com/x"],
  ["wget https://example.org/a.tgz"],
  ["scp f host.example.com:/x"],
  ["rsync f host.example.com:x"],
  ["rclone copy f remote:x"],
  ["git push origin main", "remote"],
  ["git push", "remote"],
  ["git push --force origin main", "irreversible"],
  ["git push origin :topic", "irreversible"],
  ["aws s3 rm s3://b/k", "remote"],
  ["gh repo delete o/x", "remote"],
  ["kubectl delete ns x", "remote"],
  ["npm publish", "remote"],
  ["gh release create v1", "remote"],
  ["vercel deploy --prod", "remote"],
  ["terraform destroy", "remote"],
]
const OUTWARD: Case[] = [
  ...OUTWARD_COMMANDS.flatMap(([command, risk]) => [
    of(`outward ${command}`, shell(command, { risk })),
    of(`outward ${command} with a forged word`, shell(command, { risk, extra: { checkpointTargets: [] } })),
    of(`outward ${command}, no git`, shell(command, { risk, nogit: true })),
  ]),
  of("outward webfetch", async () => request("webfetch", { patterns: ["https://example.com/x"], metadata: { url: "https://example.com/x" } })),
]

// T-INV-6: calls that ran at 1.2.5 (with these, every A among the fixtures above counts too).
const RAN: Case[] = [
  of("look ls", shell("ls src")),
  of("look cat", shell("cat src/a.ts")),
  of("git status", shell("git status")),
  of("make a folder", shell("mkdir -p ab2")),
  of("touch", shell("touch n.md")),
  of("copy to a new name", shell("cp src/a.ts src/c.ts")),
  of("ordinary edit", edit("src/a.ts")),
  of("edit with no undo", edit("src/a.ts", { nogit: true, editClass: "no_undo" })),
  of("new file by redirect, no git", shell("echo x > fresh.txt", { nogit: true })),
  of("append, no git", shell("echo x >> notes.txt", { nogit: true })),
  of("read tool", async () => request("read", { patterns: [path.join(git.path, "src/a.ts")], metadata: { filepath: path.join(git.path, "src/a.ts") } })),
]

const ALL = [...OTHER_REASONS, ...NOT_READS, ...OUTWARD, ...RAN]

/** What a verdict says, for the comparison: a `reason` is new in 1.2.6 and appears only on `checkpoint_failed`. */
const shown = (verdict: Verdict) => JSON.parse(JSON.stringify(verdict)) as Verdict

async function classifyAll(cases: readonly Case[]): Promise<Recorded> {
  const out: Recorded = {}
  for (const item of cases) {
    const input = await item.input()
    out[item.name] = {
      base: shown(AutonomyTable.classify(input)),
      consent: shown(AutonomyTable.classify({ ...input, bypass: { caller: "root" } })),
    }
  }
  return out
}

const writing = process.env.U6_BASELINE_WRITE

describe("U6 invariants against the 1.2.5 verdicts", () => {
  if (writing) {
    test("write the 1.2.5 baseline (run at e363918a69 only)", async () => {
      const recorded = await classifyAll(ALL)
      fs.mkdirSync(path.dirname(writing), { recursive: true })
      fs.writeFileSync(writing, JSON.stringify({ commit: "e363918a69", recorded }, null, 2) + "\n")
      expect(Object.keys(recorded)).toHaveLength(ALL.length)
    })
    return
  }
  const baseline = (JSON.parse(fs.readFileSync(BASELINE, "utf8")) as { recorded: Recorded }).recorded

  test("the baseline holds every fixture", () => {
    for (const item of ALL) expect({ name: item.name, present: item.name in baseline }).toEqual({ name: item.name, present: true })
  })

  test("T-INV-1: every other reason to hold or refuse keeps its 1.2.5 verdict, in both layers", async () => {
    const now = await classifyAll(OTHER_REASONS)
    for (const item of OTHER_REASONS) expect({ name: item.name, ...now[item.name] }).toEqual({ name: item.name, ...baseline[item.name] })
  })

  test("T-INV-2: a call that is not a proven read is no protected_read and no checkpointed, and keeps its 1.2.5 verdict", async () => {
    const now = await classifyAll(NOT_READS)
    for (const item of NOT_READS) {
      for (const layer of ["base", "consent"] as const) {
        expect(now[item.name]![layer].category).not.toBe("protected_read")
        expect(now[item.name]![layer].category).not.toBe("checkpointed")
      }
      expect({ name: item.name, ...now[item.name] }).toEqual({ name: item.name, ...baseline[item.name] })
    }
  })

  test("T-INV-3/5 (D5): every outward fixture deep-equals its 1.2.5 verdict, a forged checkpoint word included", async () => {
    const now = await classifyAll(OUTWARD)
    for (const item of OUTWARD) expect({ name: item.name, ...now[item.name] }).toEqual({ name: item.name, ...baseline[item.name] })
  })

  test("T-INV-6: never stricter: what was A at 1.2.5 is A still, in the layer it was A", async () => {
    const now = await classifyAll(ALL)
    let counted = 0
    for (const item of ALL)
      for (const layer of ["base", "consent"] as const)
        if (baseline[item.name]![layer].class === "A") {
          counted++
          expect({ name: item.name, layer, class: now[item.name]![layer].class }).toEqual({ name: item.name, layer, class: "A" })
        }
    expect(counted).toBeGreaterThan(20)
  })
})

// T-INV-4: no checkpoint, no run. The shell's checkpoint seam is made to fail; nothing of the command runs.
const it = testEffect(
  Layer.mergeAll(
    LayerNode.compile(
      LayerNode.group([CrossSpawnSpawner.node, FSUtil.node, Plugin.node, Truncate.node, Config.node, Agent.node, RuntimeFlags.node]),
    ),
    testInstanceStoreLayer,
  ),
)
const live = process.platform === "win32" || writing ? it.live.skip : it.live

describe("U6 invariant T-INV-4", () => {
  live("no checkpoint, no run: the target bytes are unchanged, the answer is CHECKPOINT_FAILED_TEXT, no checkpointed line", () =>
    Effect.gen(function* () {
      const { checkpointSeam } = yield* Effect.promise(() => import("../../src/tool/shell"))
      const { checkpointFailedText } = yield* Effect.promise(() => import("../../src/permission/autonomy-texts"))
      const dir = yield* tmpdirScoped()
      const notes = path.join(dir, "notes.txt")
      fs.writeFileSync(notes, "old\n")
      const lines: Record<string, unknown>[] = []
      const real = checkpointSeam.create
      checkpointSeam.create = async (input) => ({ ok: false, reason: "unreadable", message: `${input.targets.length}` })
      const exit = yield* Effect.gen(function* () {
        const tool = yield* ShellTool.pipe(
          Effect.flatMap((info) => info.init()),
          Effect.provideService(
            Autonomy.Service,
            Autonomy.Service.of({
              isOn: () => Effect.succeed(true),
              record: (_root: unknown, line: Record<string, unknown>) => Effect.sync(() => void lines.push(line)),
            } as unknown as Autonomy.Interface),
          ),
          Effect.provideService(
            Session.Service,
            Session.Service.of({ get: () => Effect.fail(new Error("no session")) } as unknown as Session.Interface),
          ),
        )
        const instance = yield* InstanceState.context
        const ctx = {
          sessionID: SessionID.make("ses_u6_inv"),
          messageID: MessageID.make("msg_u6_inv"),
          callID: "call_u6_inv",
          agent: "build",
          abort: AbortSignal.any([]),
          messages: [],
          metadata: () => Effect.void,
          trust: { canUndo: false },
          ask: (req: Omit<PermissionV1.Request, "id" | "sessionID" | "tool">) => {
            const verdict = AutonomyTable.classify({
              permission: req.permission,
              patterns: req.patterns,
              metadata: req.metadata,
              instance,
              cwd: String(req.metadata.workdir),
              canUndo: false,
              folder: "clean",
              bypass: { caller: "root" },
            })
            return verdict.class === "A" ? Effect.void : Effect.die(new Error(`held ${verdict.category}`))
          },
        } as unknown as Tool.Context
        return yield* tool.execute({ command: "echo new > notes.txt" }, ctx)
      }).pipe(provideInstance(dir), Effect.exit, Effect.ensuring(Effect.sync(() => (checkpointSeam.create = real))))
      expect(Exit.isSuccess(exit) && exit.value.output).toBe(checkpointFailedText("unreadable"))
      expect(fs.readFileSync(notes, "utf8")).toBe("old\n")
      expect(lines).toEqual([expect.objectContaining({ outcome: "not_run", by: "system:checkpoint_failed" })])
      expect(lines.some((line) => line.outcome === "checkpointed" || line.outcome === "ran")).toBe(false)
    }),
  )
})

