// Swarm 1.1.1 F25 (healing loop 12, CR11-3): the write and edit tools write a path at its tidied spelling and judge it also
// where the path as given lands. A path through an in-project link and `..` lands beside the link's target, so a link
// that leads out of the project asks as a plain path outside does, and nothing is ever written outside unseen.

import { afterAll, afterEach, describe, expect } from "bun:test"
import fsSync from "node:fs"
import path from "path"
import { Cause, Effect, Exit } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { LSP } from "@/lsp/lsp"
import { Truncate } from "@/tool/truncate"
import { Agent } from "../../src/agent/agent"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Format } from "../../src/format"
import { SessionID, MessageID } from "../../src/session/schema"
import { EditTool } from "../../src/tool/edit"
import { Reach } from "../../src/tool/reach"
import type * as Tool from "../../src/tool/tool"
import { WriteTool } from "../../src/tool/write"
import { disposeAllInstances, TestInstance, tmpdir } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([LSP.node, FSUtil.node, EventV2Bridge.node, Format.node, CrossSpawnSpawner.node, Truncate.node, Agent.node]),
  ),
)

const outsides: Awaited<ReturnType<typeof tmpdir>>[] = []
afterEach(async () => {
  await disposeAllInstances()
})
afterAll(async () => {
  for (const made of outsides) await made[Symbol.asyncDispose]()
})

type Asked = { permission: string; filepath?: unknown }
function makeCtx(refuse = false) {
  const asked: Asked[] = []
  const ctx: Tool.Context = {
    sessionID: SessionID.make("ses_test-f25-file-target"),
    messageID: MessageID.make("msg_test"),
    callID: "",
    agent: "build",
    abort: AbortSignal.any([]),
    messages: [],
    metadata: () => Effect.void,
    ask: (req) =>
      Effect.suspend(() => {
        asked.push({ permission: req.permission, filepath: req.metadata?.filepath })
        return refuse && req.permission === "external_directory" ? Effect.die(new Error("refused")) : Effect.void
      }),
  }
  return { asked, ctx }
}

/** The project gets `lnk` -> a folder outside (`<outside>/a`), and a link loop. */
const layout = Effect.fn("F25.layout")(function* (directory: string) {
  const made = yield* Effect.promise(() => tmpdir())
  outsides.push(made)
  const outside = fsSync.realpathSync(made.path)
  fsSync.mkdirSync(path.join(outside, "a"), { recursive: true })
  fsSync.symlinkSync(path.join(outside, "a"), path.join(directory, "lnk"))
  fsSync.symlinkSync("loop-b", path.join(directory, "loop-a"))
  fsSync.symlinkSync("loop-a", path.join(directory, "loop-b"))
  return outside
})

const write = (args: { filePath: string; content: string }, ctx: Tool.Context) =>
  Effect.gen(function* () {
    const tool = yield* (yield* WriteTool).init()
    return yield* tool.execute(args, ctx)
  })

const edit = (args: { filePath: string; oldString: string; newString: string }, ctx: Tool.Context) =>
  Effect.gen(function* () {
    const tool = yield* (yield* EditTool).init()
    return yield* tool.execute(args, ctx)
  })

const outsideAsks = (asked: Asked[]) => asked.filter((entry) => entry.permission === "external_directory")

describe("CR11-3: a file tool's path through a link and `..` is judged where it lands", () => {
  it.instance("write: an absolute path through a link that leads out asks for the folder outside and writes nothing there", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const outside = yield* layout(test.directory)
      const { asked, ctx } = makeCtx()
      // Written out, not joined: `path.join` would take the `..` away.
      yield* write({ filePath: `${test.directory}/lnk/../w.ts`, content: "w\n" }, ctx)
      expect(outsideAsks(asked).map((entry) => entry.filepath)).toEqual([path.join(outside, "w.ts")])
      expect(fsSync.existsSync(path.join(outside, "w.ts"))).toBe(false)
      expect(fsSync.readFileSync(path.join(test.directory, "w.ts"), "utf8")).toBe("w\n")
    }),
  )

  it.instance("write: a relative path through the same link asks the same", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const outside = yield* layout(test.directory)
      const { asked, ctx } = makeCtx()
      yield* write({ filePath: "lnk/../r.ts", content: "r\n" }, ctx)
      expect(outsideAsks(asked).map((entry) => entry.filepath)).toEqual([path.join(outside, "r.ts")])
      expect(fsSync.existsSync(path.join(outside, "r.ts"))).toBe(false)
    }),
  )

  it.instance("write: refused for the folder outside, nothing is written anywhere", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const outside = yield* layout(test.directory)
      const { ctx } = makeCtx(true)
      const exit = yield* write({ filePath: `${test.directory}/lnk/../no.ts`, content: "n\n" }, ctx).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(fsSync.existsSync(path.join(outside, "no.ts"))).toBe(false)
      expect(fsSync.existsSync(path.join(test.directory, "no.ts"))).toBe(false)
    }),
  )

  it.instance("write: a link loop on the way is refused", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* layout(test.directory)
      const { ctx } = makeCtx()
      const exit = yield* write({ filePath: `${test.directory}/loop-a/../x.ts`, content: "x\n" }, ctx).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(String(Cause.squash(exit.cause))).toContain("loops")
      expect(fsSync.existsSync(path.join(test.directory, "x.ts"))).toBe(false)
    }),
  )

  it.instance("write: plain paths inside, and a step back with no link, ask nothing outside", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* layout(test.directory)
      fsSync.mkdirSync(path.join(test.directory, "src"), { recursive: true })
      const { asked, ctx } = makeCtx()
      yield* write({ filePath: path.join(test.directory, "plain.ts"), content: "p\n" }, ctx)
      yield* write({ filePath: "rel.ts", content: "q\n" }, ctx)
      yield* write({ filePath: `${test.directory}/src/../up.ts`, content: "u\n" }, ctx)
      expect(outsideAsks(asked)).toEqual([])
      expect(fsSync.readFileSync(path.join(test.directory, "up.ts"), "utf8")).toBe("u\n")
    }),
  )

  it.instance("edit: creating a file through the link asks for the folder outside and writes nothing there", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const outside = yield* layout(test.directory)
      const { asked, ctx } = makeCtx()
      yield* edit({ filePath: `${test.directory}/lnk/../e.ts`, oldString: "", newString: "e\n" }, ctx)
      expect(outsideAsks(asked).map((entry) => entry.filepath)).toEqual([path.join(outside, "e.ts")])
      expect(fsSync.existsSync(path.join(outside, "e.ts"))).toBe(false)
    }),
  )

  it.instance("edit: an existing file named through the link, relative or absolute, asks; the outside copy is untouched", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const outside = yield* layout(test.directory)
      fsSync.writeFileSync(path.join(outside, "same.ts"), "old\n")
      fsSync.writeFileSync(path.join(test.directory, "same.ts"), "old\n")
      const { asked, ctx } = makeCtx()
      yield* edit({ filePath: "lnk/../same.ts", oldString: "old", newString: "new" }, ctx)
      expect(outsideAsks(asked).map((entry) => entry.filepath)).toEqual([path.join(outside, "same.ts")])
      expect(fsSync.readFileSync(path.join(outside, "same.ts"), "utf8")).toBe("old\n")
    }),
  )

  it.instance("edit: a plain path inside asks nothing outside", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* layout(test.directory)
      fsSync.writeFileSync(path.join(test.directory, "in.ts"), "old\n")
      const { asked, ctx } = makeCtx()
      yield* edit({ filePath: path.join(test.directory, "in.ts"), oldString: "old", newString: "new" }, ctx)
      expect(outsideAsks(asked)).toEqual([])
    }),
  )

  it.live("Reach.fileTarget: one place without a `..` or when the step back passes no link", () =>
    Effect.sync(() => {
      expect(Reach.fileTarget("/p/x.ts", "/q")).toEqual({ written: "/p/x.ts", landing: "/p/x.ts" })
      expect(Reach.fileTarget("x.ts", "/q")).toEqual({ written: "/q/x.ts", landing: "/q/x.ts" })
    }),
  )
})
