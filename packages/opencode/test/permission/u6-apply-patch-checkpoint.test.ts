// 1.2.6 review wave F, fix row FX-1 (gate M1 B1, decision C19g; P-01b, U6, INV-H). `apply_patch` takes the same checkpoint
// path as edit and write (commit 069d49682b): in autonomous mode, an existing file no Undo snapshot covers is copied before
// the patch overwrites it (an update, a move's source, a move or an add onto an existing file), and a checkpoint that
// cannot be made refuses the whole patch with `checkpointFailedText(reason)` and nothing written. With Undo on, inside
// the project, nothing changes. Red at HEAD before the fix: apply_patch wrote over the bytes with no checkpoint.
import { describe, expect } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { Cause, Effect, Exit, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Global } from "@opencode-ai/core/global"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Autonomy } from "@/permission/autonomy"
// Namespace import, as in u6-checkpoint: a missing name fails on behaviour, not on load.
import * as AutonomyTexts from "@/permission/autonomy-texts"
import { Session } from "@/session/session"
import { Truncate } from "@/tool/truncate"
import { Tool } from "@/tool/tool"
import { Agent } from "../../src/agent/agent"
import { Plugin } from "../../src/plugin"
import { MessageID, SessionID } from "../../src/session/schema"
import type { ActionCheckpoint } from "../../src/tool/checkpoint"
import { ApplyPatchTool } from "../../src/tool/apply_patch"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Format } from "../../src/format"
import { LSP } from "../../src/lsp/lsp"
import { Permission } from "../../src/permission"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import { Question } from "../../src/question"
import { Instruction } from "../../src/session/instruction"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const texts = AutonomyTexts as unknown as { checkpointFailedText?: (reason: string) => string }
const checkpointFailedText = (reason: string) => texts.checkpointFailedText?.(reason) ?? `(no checkpointFailedText for ${reason})`

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

type Line = Record<string, unknown>
const idOf = (text: string) => /checkpoint (\d{8}-\d{6}-\d{1,4}) of/.exec(text)?.[1]
const checkpointFolder = (dir: string) => path.join(dir, ".swarm", "checkpoint")
const manifestOf = (dir: string, id: string) =>
  JSON.parse(fs.readFileSync(path.join(checkpointFolder(dir), id, "manifest.json"), "utf8")) as ActionCheckpoint.Manifest
const copyOf = (dir: string, id: string, rel: string) => fs.readFileSync(path.join(checkpointFolder(dir), id, rel), "utf8")
const failure = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? String((Cause.squash(exit.cause) as Error).message ?? Cause.squash(exit.cause)) : ""

describe("U6 checkpoint: apply_patch (FX-1, gate M1 B1)", () => {
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
  const patching = Effect.gen(function* () {
    return yield* (yield* ApplyPatchTool).init()
  })

  full.instance("AP-1: an update of an existing file without Undo is checkpointed first; the copy holds the old bytes", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const file = path.join(test.directory, "a.md")
      fs.writeFileSync(file, "old text\n")
      const { root, autonomy } = yield* start
      const ctx = yield* context(root.id, false)
      const tool = yield* patching
      const result = yield* tool.execute(
        { patchText: "*** Begin Patch\n*** Update File: a.md\n@@\n-old text\n+new text\n*** End Patch" },
        ctx,
      )
      expect(fs.readFileSync(file, "utf8")).toBe("new text\n")
      const id = idOf(result.output)
      expect(id).toBeDefined()
      expect(copyOf(test.directory, id!, "a.md")).toBe("old text\n")
      expect(result.output).toContain("Success. Updated the following files")
      const lines = yield* audit(autonomy, root.id)
      const decision = lines.findIndex((line) => line.type === "decision" && line.permission === "edit")
      const saved = lines.findIndex((line) => line.type === "outcome" && line.outcome === "checkpointed")
      // The gate's verdict is the 1.2.5 one; the checkpoint is on record after it and before the write.
      expect(lines[decision]).toMatchObject({ class: "A", decision: "allow" })
      expect(saved).toBeGreaterThan(decision)
      expect(lines[saved]).toMatchObject({ checkpoint: id, entries: 1 })
      fs.rmSync(modeFolder, { recursive: true, force: true })
    }),
  )

  full.instance("AP-2: a move onto an existing file keeps both the source and the overwritten target in one checkpoint", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const source = path.join(test.directory, "src.txt")
      const target = path.join(test.directory, "dst.txt")
      fs.writeFileSync(source, "source\n")
      fs.writeFileSync(target, "target before\n")
      const { root } = yield* start
      const ctx = yield* context(root.id, false)
      const tool = yield* patching
      const result = yield* tool.execute(
        { patchText: "*** Begin Patch\n*** Update File: src.txt\n*** Move to: dst.txt\n@@\n-source\n+moved\n*** End Patch" },
        ctx,
      )
      expect(fs.existsSync(source)).toBe(false)
      expect(fs.readFileSync(target, "utf8")).toBe("moved\n")
      const id = idOf(result.output)!
      expect(id).toBeDefined()
      expect(manifestOf(test.directory, id).entries.map((entry) => entry.path).sort()).toEqual(["dst.txt", "src.txt"])
      expect(copyOf(test.directory, id, "dst.txt")).toBe("target before\n")
      expect(copyOf(test.directory, id, "src.txt")).toBe("source\n")
      fs.rmSync(modeFolder, { recursive: true, force: true })
    }),
  )

  full.instance("AP-3: an Add File onto an existing file is checkpointed; a new file alone makes no checkpoint", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const file = path.join(test.directory, "b.txt")
      fs.writeFileSync(file, "was here\n")
      const { root } = yield* start
      const ctx = yield* context(root.id, false)
      const tool = yield* patching
      const result = yield* tool.execute({ patchText: "*** Begin Patch\n*** Add File: b.txt\n+replaced\n*** End Patch" }, ctx)
      expect(fs.readFileSync(file, "utf8")).toBe("replaced\n")
      expect(copyOf(test.directory, idOf(result.output)!, "b.txt")).toBe("was here\n")
      const fresh = yield* tool.execute({ patchText: "*** Begin Patch\n*** Add File: c.txt\n+new\n*** End Patch" }, ctx)
      expect(idOf(fresh.output)).toBeUndefined()
      fs.rmSync(modeFolder, { recursive: true, force: true })
    }),
  )

  full.instance("AP-4: with Undo on, inside the project, no checkpoint is made (as edit and write)", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const file = path.join(test.directory, "a.md")
      fs.writeFileSync(file, "old\n")
      const { root } = yield* start
      const ctx = yield* context(root.id, true)
      const tool = yield* patching
      const result = yield* tool.execute({ patchText: "*** Begin Patch\n*** Update File: a.md\n@@\n-old\n+new\n*** End Patch" }, ctx)
      expect(fs.readFileSync(file, "utf8")).toBe("new\n")
      expect(idOf(result.output)).toBeUndefined()
      expect(fs.existsSync(checkpointFolder(test.directory))).toBe(false)
      fs.rmSync(modeFolder, { recursive: true, force: true })
    }),
    // Undo needs a Git folder, as for CK-7; without it the gate holds the edit as not_reversible.
    { git: true },
  )

  full.instance("AP-5: a checkpoint that cannot be made refuses the patch with checkpointFailedText; nothing is written", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const file = path.join(test.directory, "a.md")
      const other = path.join(test.directory, "b.md")
      fs.writeFileSync(file, "old\n")
      fs.writeFileSync(other, "keep\n")
      // `.swarm` as a link is refused by ActionCheckpoint.create (reason checkpoint_link).
      const away = fs.mkdtempSync(path.join(path.dirname(test.directory), "u6-ap-away-"))
      fs.symlinkSync(away, path.join(test.directory, ".swarm"))
      const { root, autonomy } = yield* start
      const ctx = yield* context(root.id, false)
      const tool = yield* patching
      const exit = yield* tool
        .execute(
          {
            patchText:
              "*** Begin Patch\n*** Update File: b.md\n@@\n-keep\n+changed\n*** Update File: a.md\n@@\n-old\n+new\n*** End Patch",
          },
          ctx,
        )
        .pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(failure(exit)).toBe(checkpointFailedText("checkpoint_link"))
      expect(fs.readFileSync(file, "utf8")).toBe("old\n")
      expect(fs.readFileSync(other, "utf8")).toBe("keep\n")
      const lines = yield* audit(autonomy, root.id)
      expect(lines.some((line) => line.type === "outcome" && line.outcome === "not_run" && line.by === "system:checkpoint_failed")).toBe(true)
      expect(lines.some((line) => line.type === "outcome" && line.outcome === "checkpointed")).toBe(false)
      fs.rmSync(path.join(test.directory, ".swarm"))
      fs.rmSync(away, { recursive: true, force: true })
      fs.rmSync(modeFolder, { recursive: true, force: true })
    }),
  )
})
