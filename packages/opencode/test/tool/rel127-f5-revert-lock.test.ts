// 1.2.7 row 31b, F-5 (AC-F5, N7-094; SR7-10): a checkpoint revert and an agent's write in the same folder never interleave.
// The write tool waits for a revert of its folder; a revert waits for the writers in it. A writer held up past the wait
// is refused with REVERT_IN_PROGRESS, a revert held up by writers returns "busy", an interrupted writer gives its hold
// back, two reverts still run one after the other, and a folder inside a reverted folder is covered by the same hold.
import { afterEach, describe, expect, spyOn } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Exit, Fiber } from "effect"
import path from "node:path"
import fs from "node:fs/promises"
import { WriteTool } from "../../src/tool/write"
import { ActionCheckpoint } from "../../src/tool/checkpoint"
import { LSP } from "@/lsp/lsp"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Format } from "../../src/format"
import { Truncate } from "@/tool/truncate"
import { Tool } from "@/tool/tool"
import { Agent } from "../../src/agent/agent"
import { SessionID, MessageID } from "../../src/session/schema"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const ctx = {
  sessionID: SessionID.make("ses_rel127-f5-revert-lock"),
  messageID: MessageID.make("msg_rel127_f5"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      LSP.node,
      FSUtil.node,
      EventV2Bridge.node,
      Format.node,
      CrossSpawnSpawner.node,
      Truncate.node,
      Agent.node,
    ]),
  ),
)

// Read through an optional handle so the file loads at the 1.2.6 base, where the first case fails on the behaviour itself.
const lockWait: { ms: number } = (ActionCheckpoint as { revertLockWait?: { ms: number } }).revertLockWait ?? { ms: 0 }
const DEFAULT_WAIT = lockWait.ms
afterEach(async () => {
  lockWait.ms = DEFAULT_WAIT
  await disposeAllInstances()
})

const sleep = (ms: number) => Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, ms)))
const read = (file: string) => Effect.promise(() => fs.readFile(file, "utf8"))

const writeTool = (args: Tool.InferParameters<typeof WriteTool>) =>
  Effect.gen(function* () {
    const info = yield* WriteTool
    const tool = yield* info.init()
    return yield* tool.execute(args, ctx)
  })

/** A checkpoint of `a.txt` holding "v1", the file now "v2", and the sha the revert route would pass. */
const prepared = (directory: string) =>
  Effect.promise(async () => {
    const file = path.join(directory, "a.txt")
    await fs.writeFile(file, "v1")
    const made = await ActionCheckpoint.create({ directory, targets: ["a.txt"], command: "test", sessionID: "ses_f5" })
    if (!made.ok) throw new Error(made.message)
    await fs.writeFile(file, "v2")
    return { file, id: made.id, manifestSha256: made.manifestSha256 }
  })

/** An outside hold on `directory`, taken when `ready` resolves, that lasts until `free()` is called. */
const hold = (directory: string, mode: "shared" | "exclusive") => {
  let free = () => {}
  let taken = () => {}
  const gate = new Promise<void>((resolve) => (free = resolve))
  const ready = new Promise<void>((resolve) => (taken = resolve))
  const done = ActionCheckpoint.withCheckpointLock(directory, mode, () => {
    taken()
    return gate
  })
  return { free: () => free(), done, ready }
}

describe("rel127 F-5 revert lock (N7-094)", () => {
  it.instance("a write started inside the revert's restore waits for it, and lands after it", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { file, id, manifestSha256 } = yield* prepared(test.directory)

      // Hold the revert inside `putBack`'s rename of a.txt until the write has had its chance.
      let reached = () => {}
      const inRename = new Promise<void>((resolve) => (reached = resolve))
      let letGo = () => {}
      const released = new Promise<void>((resolve) => (letGo = resolve))
      const original = fs.rename.bind(fs)
      const spy = spyOn(fs, "rename").mockImplementation(async (from, to) => {
        if (String(from).includes(".swarm-revert-") && path.basename(String(to)) === "a.txt") {
          reached()
          await released
        }
        return original(from, to)
      })
      try {
        const reverting = ActionCheckpoint.revert({ directory: test.directory, id, manifestSha256 })
        yield* Effect.promise(() => inRename)

        let writeDone = false
        const writer = yield* writeTool({ filePath: file, content: "v3" }).pipe(
          Effect.ensuring(Effect.sync(() => (writeDone = true))),
          Effect.exit,
          Effect.forkChild,
        )
        yield* sleep(200)
        // Red at base: the write ran inside the revert.
        expect(writeDone).toBe(false)
        letGo()

        const result = yield* Effect.promise(() => reverting)
        expect(result.ok).toBe(true)
        if (!result.ok) return
        expect(result.verified).toBe(true)
        const exit = yield* Fiber.join(writer)
        expect(Exit.isSuccess(exit)).toBe(true)
        expect(yield* read(file)).toBe("v3")
        // The pre-revert checkpoint holds what was there just before the revert.
        expect(yield* read(path.join(test.directory, ".swarm", "checkpoint", result.preRevert, "a.txt"))).toBe("v2")
      } finally {
        spy.mockRestore()
      }
    }),
  )

  it.instance("a writer held up by a revert past the wait is refused with REVERT_IN_PROGRESS", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const file = path.join(test.directory, "b.txt")
      yield* Effect.promise(() => fs.writeFile(file, "before"))
      lockWait.ms = 100
      const revert = hold(test.directory, "exclusive")
      yield* Effect.promise(() => revert.ready)
      const exit = yield* writeTool({ filePath: file, content: "after" }).pipe(Effect.exit)
      revert.free()
      yield* Effect.promise(() => revert.done)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(String(Exit.isFailure(exit) ? exit.cause : "")).toContain(ActionCheckpoint.REVERT_IN_PROGRESS)
      expect(yield* read(file)).toBe("before")
    }),
  )

  it.instance("a revert held up by writers returns busy and touches nothing", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { file, id, manifestSha256 } = yield* prepared(test.directory)
      lockWait.ms = 100
      const writer = hold(test.directory, "shared")
      yield* Effect.promise(() => writer.ready)
      const result = yield* Effect.promise(() =>
        ActionCheckpoint.revert({ directory: test.directory, id, manifestSha256 }),
      )
      writer.free()
      yield* Effect.promise(() => writer.done)
      expect(result).toEqual({
        ok: false,
        reason: "busy",
        message: "Revert not started: agents are still writing in this folder. Try again in a moment.",
      })
      expect(yield* read(file)).toBe("v2")
      expect((yield* Effect.promise(() => ActionCheckpoint.list(test.directory))).length).toBe(1)
    }),
  )

  it.instance("an interrupted writer gives the hold back, while it holds it and while it waits", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      lockWait.ms = 150

      // Holding: interrupted inside its write step.
      let inside = false
      const holding = yield* Effect.sync(() => (inside = true)).pipe(
        Effect.andThen(Effect.never),
        ActionCheckpoint.checkpointWriteHold(test.directory),
        Effect.forkChild,
      )
      while (!inside) yield* sleep(5)
      yield* Fiber.interrupt(holding)
      const afterHolding = yield* Effect.promise(() =>
        ActionCheckpoint.withCheckpointLock(test.directory, "exclusive", async () => "ran"),
      )
      expect(afterHolding).toEqual({ ok: true, value: "ran" })

      // Waiting: interrupted while a revert holds the folder; it must not take the hold later.
      const revert = hold(test.directory, "exclusive")
      yield* Effect.promise(() => revert.ready)
      let ran = false
      const waiting = yield* Effect.sync(() => (ran = true)).pipe(
        ActionCheckpoint.checkpointWriteHold(test.directory),
        Effect.forkChild,
      )
      yield* sleep(20)
      yield* Fiber.interrupt(waiting)
      revert.free()
      yield* Effect.promise(() => revert.done)
      const afterWaiting = yield* Effect.promise(() =>
        ActionCheckpoint.withCheckpointLock(test.directory, "exclusive", async () => "ran"),
      )
      expect(afterWaiting).toEqual({ ok: true, value: "ran" })
      expect(ran).toBe(false)
    }),
  )

  it.instance("two reverts still run one after the other, and the second is not busy behind the first", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      lockWait.ms = 50
      const order: string[] = []
      let started = () => {}
      const firstIn = new Promise<void>((resolve) => (started = resolve))
      const first = ActionCheckpoint.withCheckpointLock(test.directory, "exclusive", async () => {
        order.push("first:start")
        started()
        await new Promise((resolve) => setTimeout(resolve, 200))
        order.push("first:end")
      })
      yield* Effect.promise(() => firstIn)
      const second = ActionCheckpoint.withCheckpointLock(test.directory, "exclusive", async () => {
        order.push("second")
      })
      const [a, b] = yield* Effect.promise(() => Promise.all([first, second]))
      expect(a.ok && b.ok).toBe(true)
      expect(order).toEqual(["first:start", "first:end", "second"])
    }),
  )

  it.instance("the key is the real path of the root and covers the folders in it", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const inner = path.join(test.directory, "sub")
      const link = path.join(test.directory, "..", path.basename(test.directory) + "-link")
      yield* Effect.promise(() => fs.mkdir(inner))
      yield* Effect.promise(() => fs.symlink(test.directory, link))
      try {
        lockWait.ms = 80
        const revert = hold(link, "exclusive")
        yield* Effect.promise(() => revert.ready)
        const nested = yield* Effect.promise(() =>
          ActionCheckpoint.withCheckpointLock(inner, "shared", async () => "ran"),
        )
        expect(nested).toEqual({ ok: false })
        revert.free()
        yield* Effect.promise(() => revert.done)
        // A folder beside it is not held up.
        const other = path.join(path.dirname(test.directory), path.basename(test.directory) + "-other")
        const beside = hold(test.directory, "exclusive")
        yield* Effect.promise(() => beside.ready)
        const free = yield* Effect.promise(() =>
          ActionCheckpoint.withCheckpointLock(other, "shared", async () => "ran"),
        )
        beside.free()
        yield* Effect.promise(() => beside.done)
        expect(free).toEqual({ ok: true, value: "ran" })
      } finally {
        yield* Effect.promise(() => fs.unlink(link).catch(() => undefined))
      }
    }),
  )
})
