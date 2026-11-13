import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { afterAll, describe, expect, mock } from "bun:test"
import fs from "node:fs"
import path from "path"
import { Cause, Effect, Exit, Fiber, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import type { Tool } from "@/tool/tool"
import { assertExternalDirectoryEffect, libraryRead, touchesLibrary } from "../../src/tool/external-directory"
import { Filesystem } from "@/util/filesystem"
import { provideInstance, TestInstance, testInstanceStoreLayer, tmpdirScoped } from "../fixture/fixture"
import { TestConfig } from "../fixture/config"
import { Permission } from "../../src/permission"
import { SessionID, MessageID } from "../../src/session/schema"
import { pollWithTimeout, testEffect } from "../lib/effect"
import * as RealLibraryRoot from "@/skill/library-root"
import { Agent } from "../../src/agent/agent"
import { Config } from "@/config/config"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Format } from "../../src/format"
import { LSP } from "@/lsp/lsp"
import { Plugin } from "../../src/plugin"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Instruction } from "../../src/session/instruction"
import { SessionTools } from "@/session/tools"
import { ApplyPatchTool } from "../../src/tool/apply_patch"
import { EditTool } from "../../src/tool/edit"
import { GlobTool } from "../../src/tool/glob"
import { GrepTool } from "../../src/tool/grep"
import { LspTool } from "../../src/tool/lsp"
import { ReadTool } from "../../src/tool/read"
import { ShellTool } from "../../src/tool/shell"
import { Truncate } from "@/tool/truncate"
import { WriteTool } from "../../src/tool/write"

// Only `current` changes, and with nothing set it gives this process's real answer, so the tests above the library ones,
// and a file sharing this process, see the real module.
const real = { ...RealLibraryRoot }
let status: RealLibraryRoot.Status | undefined
const current = () => status ?? real.current()
mock.module(path.join(import.meta.dir, "../../src/skill/library-root.ts"), () => ({
  ...real,
  current,
  LibraryRoot: { ...real, current },
}))
afterAll(() => {
  status = undefined
})

const it = testEffect(LayerNode.compile(CrossSpawnSpawner.node))

const baseCtx: Omit<Tool.Context, "ask"> = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
}

const glob = (p: string) =>
  process.platform === "win32" ? Filesystem.normalizePathPattern(p) : p.replaceAll("\\", "/")

function makeCtx() {
  const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
  const ctx: Tool.Context = {
    ...baseCtx,
    ask: (req) =>
      Effect.sync(() => {
        requests.push(req)
      }),
  }
  return { requests, ctx }
}

describe("tool.assertExternalDirectory", () => {
  it.live("no-ops for empty target", () =>
    Effect.gen(function* () {
      const { requests, ctx } = makeCtx()

      yield* assertExternalDirectoryEffect(ctx)

      expect(requests.length).toBe(0)
    }),
  )

  it.instance("no-ops for paths inside the instance directory", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { requests, ctx } = makeCtx()

      yield* assertExternalDirectoryEffect(ctx, path.join(test.directory, "file.txt"))

      expect(requests.length).toBe(0)
    }),
  )

  it.instance("asks with a single canonical glob", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { requests, ctx } = makeCtx()

      const target = path.join(path.dirname(test.directory), "outside", "file.txt")
      const expected = glob(path.join(path.dirname(target), "*"))

      yield* assertExternalDirectoryEffect(ctx, target)

      const req = requests.find((r) => r.permission === "external_directory")
      expect(req).toBeDefined()
      expect(req!.patterns).toEqual([expected])
      expect(req!.always).toEqual([expected])
    }),
  )

  it.instance("uses target directory when kind=directory", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { requests, ctx } = makeCtx()

      const target = path.join(path.dirname(test.directory), "outside")
      const expected = glob(path.join(target, "*"))

      yield* assertExternalDirectoryEffect(ctx, target, { kind: "directory" })

      const req = requests.find((r) => r.permission === "external_directory")
      expect(req).toBeDefined()
      expect(req!.patterns).toEqual([expected])
      expect(req!.always).toEqual([expected])
    }),
  )

  it.live("skips prompting when bypass=true", () =>
    Effect.gen(function* () {
      const { requests, ctx } = makeCtx()

      yield* assertExternalDirectoryEffect(ctx, "/tmp/outside/file.txt", { bypass: true })

      expect(requests.length).toBe(0)
    }),
  )

  if (process.platform === "win32") {
    it.instance(
      "normalizes Windows path variants to one glob",
      () =>
        Effect.gen(function* () {
          const { requests, ctx } = makeCtx()

          const outerTmp = yield* tmpdirScoped()
          yield* Effect.promise(() => Bun.write(path.join(outerTmp, "outside.txt"), "x"))

          const target = path.join(outerTmp, "outside.txt")
          const alt = target
            .replace(/^[A-Za-z]:/, "")
            .replaceAll("\\", "/")
            .toLowerCase()

          yield* assertExternalDirectoryEffect(ctx, alt)

          const req = requests.find((r) => r.permission === "external_directory")
          const expected = glob(path.join(outerTmp, "*"))
          expect(req).toBeDefined()
          expect(req!.patterns).toEqual([expected])
          expect(req!.always).toEqual([expected])
        }),
      { git: true },
    )

    it.instance(
      "uses drive root glob for root files",
      () =>
        Effect.gen(function* () {
          const { requests, ctx } = makeCtx()

          const tmp = yield* TestInstance
          const root = path.parse(tmp.directory).root
          const target = path.join(root, "boot.ini")

          yield* assertExternalDirectoryEffect(ctx, target)

          const req = requests.find((r) => r.permission === "external_directory")
          const expected = path.join(root, "*")
          expect(req).toBeDefined()
          expect(req!.patterns).toEqual([expected])
          expect(req!.always).toEqual([expected])
        }),
      { git: true },
    )
  }
})

// R18 part 5 with `real` injected, so nothing here opens a file. `always` follows KL-12: anything whose pattern would cover
// the root is withheld too, which moves I1-I3 and D4 from R18's `[glob]` to `[]`.
describe("the library predicate and IZ-5", () => {
  const R = "/synthetic/Swarm.app/Contents/Resources"
  const S = `${R}/knowledge-library`
  const FAR = "/di-luar"
  const same = (file: string) => file

  type Row = {
    id: string
    reads: boolean
    target: string
    kind?: "file" | "directory"
    real?: (file: string) => string | undefined
    passes: boolean
    withheld: boolean
  }

  const rows: Row[] = [
    { id: "S1", reads: true, target: S, kind: "directory", passes: true, withheld: true },
    { id: "S2", reads: true, target: `${S}/library.json`, passes: true, withheld: true },
    { id: "S3", reads: true, target: S, kind: "directory", passes: true, withheld: true },
    { id: "S4", reads: true, target: `${S}/./a.md`, passes: true, withheld: true },
    { id: "S5", reads: true, target: `${S}//a.md`, passes: true, withheld: true },
    { id: "F1", reads: true, target: `${S}/3 Skills/a/SKILL.md`, passes: true, withheld: true },
    { id: "F2", reads: true, target: `${S}/4 Knowledge Bank`, kind: "directory", passes: true, withheld: true },
    { id: "F3", reads: true, target: `${S}/x/.env`, passes: true, withheld: true },
    { id: "F4", reads: true, target: `${S}/x/.git/config`, passes: true, withheld: true },
    { id: "I1", reads: true, target: R, kind: "directory", passes: false, withheld: true },
    { id: "I2", reads: true, target: `${R}/app.asar`, passes: false, withheld: true },
    { id: "I3", reads: true, target: "/", kind: "directory", passes: false, withheld: true },
    { id: "N1", reads: true, target: `${S}.x/a.md`, passes: false, withheld: false },
    { id: "N2", reads: true, target: `${S}.lama`, kind: "directory", passes: false, withheld: false },
    { id: "N3", reads: true, target: `${S}X/a.md`, passes: false, withheld: false },
    { id: "N4", reads: true, target: `${S}-baru/a.md`, passes: false, withheld: false },
    { id: "N5", reads: true, target: `${S.replace("Swarm.app", "swarm.app")}/a.md`, passes: false, withheld: false },
    { id: "T1", reads: false, target: `${S}/a.md`, passes: false, withheld: true },
    { id: "T2", reads: false, target: `${S}/3 Skills/a/SKILL.md`, passes: false, withheld: true },
    { id: "T3", reads: false, target: `${S}/a.md`, passes: false, withheld: true },
    { id: "T4", reads: false, target: `${S}/a.ts`, passes: false, withheld: true },
    { id: "B1", reads: false, target: S, kind: "directory", passes: false, withheld: true },
    { id: "B2", reads: false, target: `${S}/3 Skills`, kind: "directory", passes: false, withheld: true },
    { id: "L1", reads: true, target: `${S}/link-out/f.md`, real: () => `${FAR}/f.md`, passes: false, withheld: true },
    { id: "L2", reads: true, target: `${S}/loop/f.md`, real: () => undefined, passes: false, withheld: true },
    { id: "L3", reads: true, target: "/proyek/lnk/f.md", real: () => `${S}/f.md`, passes: false, withheld: true },
    { id: "D1", reads: true, target: `${S}/link-out/../x.md`, real: () => `${FAR}/x.md`, passes: false, withheld: true },
    {
      id: "D2",
      reads: true,
      target: `${S}/../lnk/../pustaka/x.md`,
      real: () => `${FAR}/pustaka/x.md`,
      passes: false,
      withheld: true,
    },
    { id: "D3", reads: true, target: `${S}/a/../b.md`, real: () => `${S}/b.md`, passes: false, withheld: true },
    {
      id: "D4",
      reads: true,
      target: `${S}/../../rahasia.md`,
      real: () => "/synthetic/Swarm.app/Contents/rahasia.md",
      passes: false,
      withheld: true,
    },
  ]

  for (const row of rows) {
    it.live(`${row.id}: ${row.passes ? "passes" : "asks"}, always ${row.withheld ? "withheld" : "offered"}`, () =>
      Effect.sync(() => {
        const resolve = row.real ?? same
        expect(row.reads && libraryRead(row.target, S, resolve)).toBe(row.passes)
        expect(touchesLibrary(row.target, row.kind ?? "file", S, resolve)).toBe(row.withheld)
      }),
    )
  }

  it.live("the table is all 30 rows", () => Effect.sync(() => expect(rows.length).toBe(30)))

  it.live("a root holding wildcard characters is only ever compared as text", () =>
    Effect.sync(() => {
      for (const root of ["/App*/lib", "/App?/lib"]) {
        expect(libraryRead(`${root}/a.md`, root, same)).toBe(true)
        expect(libraryRead("/Appx/lib/a.md", root, same)).toBe(false)
      }
    }),
  )

  it.live("a relative target never passes", () =>
    Effect.sync(() => {
      expect(libraryRead("knowledge-library/a.md", S, same)).toBe(false)
    }),
  )

  it.live("`..` is refused whatever realpath answers", () =>
    Effect.sync(() => {
      expect(libraryRead(`${S}/a/../b.md`, S, () => `${S}/b.md`)).toBe(false)
      expect(libraryRead(`${S}/a\\..\\b.md`, S, () => `${S}/b.md`)).toBe(false)
    }),
  )

  // An approved `/Sw*/*` or `/a\b/*` answers for a write under the root as well as a plain parent does.
  it.live("a pattern that would match the root by its own wildcard is withheld", () =>
    Effect.sync(() => {
      expect(touchesLibrary("/synthetic/Sw*/x.md", "file", S, same)).toBe(true)
      expect(touchesLibrary("/synthetic/Swarm.ap?", "directory", S, same)).toBe(true)
      expect(touchesLibrary(`/synthetic\\Swarm.app/Contents/Resources/x.md`, "file", S, same)).toBe(true)
      expect(touchesLibrary("/elsewhere/star*.md", "file", S, same)).toBe(false)
    }),
  )

  it.live("a parent reached by another spelling is still a parent", () =>
    Effect.sync(() => {
      const lower = R.replace("Swarm.app", "swarm.app")
      expect(touchesLibrary(`${lower}/x.md`, "file", S, () => `${R}/x.md`)).toBe(true)
    }),
  )
})

const kit = testEffect(
  Layer.mergeAll(
    LayerNode.compile(
      LayerNode.group([
        CrossSpawnSpawner.node,
        LSP.node,
        FSUtil.node,
        Format.node,
        EventV2Bridge.node,
        Truncate.node,
        Agent.node,
        Instruction.node,
        Ripgrep.node,
        Plugin.node,
        Config.node,
        RuntimeFlags.node,
        Permission.node,
      ]),
    ),
    testInstanceStoreLayer,
  ),
)

type Asked = Parameters<Tool.Context["ask"]>[0]

// A throwaway install, with the links and neighbours R18 names. The project is somewhere else, as it is in real use.
const install = Effect.gen(function* () {
  const base = yield* tmpdirScoped()
  const project = yield* tmpdirScoped()
  const R = path.join(base, "Swarm.app", "Contents", "Resources")
  const S = path.join(R, "knowledge-library")
  const far = path.join(base, "far", "deep")
  const put = (file: string, text = "one\n") => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, text)
  }
  for (const file of ["library.json", "a.md", "b.md", "f.md", "a.ts", "3 Skills/a/SKILL.md", "4 Knowledge Bank/k.md"])
    put(path.join(S, file))
  put(path.join(S, "x/.env"), "KEY=synthetic-extdir-w4n8c2j6\n")
  put(path.join(S, "x/.git/config"))
  fs.mkdirSync(path.join(S, "a"))
  put(path.join(R, "app.asar"))
  for (const sibling of [".x", "X", "-baru"]) put(path.join(`${S}${sibling}`, "a.md"))
  put(path.join(`${S}.lama`, "a.md"))
  put(path.join(far, "f.md"))
  put(path.join(base, "far", "x.md"))
  put(path.join(base, "far", "pustaka", "x.md"))
  fs.symlinkSync(far, path.join(S, "link-out"))
  fs.symlinkSync(path.join(S, "loop"), path.join(S, "loop"))
  fs.symlinkSync(far, path.join(R, "lnk"))
  fs.symlinkSync(S, path.join(project, "lnk"))
  return { base, project, R, S, far }
})

const onLibrary = <A, E, R>(root: string, effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      status = { kind: "available", root }
    }),
    () => effect,
    () =>
      Effect.sync(() => {
        status = undefined
      }),
  )

const session = (ask: Tool.Context["ask"], trust: Tool.Context["trust"]): Tool.Context => ({
  sessionID: SessionID.make("ses_library"),
  messageID: MessageID.make("msg_library"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  trust,
  ask,
})

const STOP = new Error("stopped before anything ran")

// Whether Permission.ask would stop for this request: the same three outcomes it reads, on the agent's real rules.
const prompts = (request: Asked, ruleset: PermissionV1.Ruleset) =>
  request.patterns.some((pattern) => {
    const rule = Permission.evaluate(request.permission, pattern, ruleset)
    if (rule.action === "allow") return false
    return !(request.harmless && Permission.isShippedCatchAll(rule))
  })

type Env = Effect.Success<typeof install>
type Run = (ctx: Tool.Context, env: Env) => Effect.Effect<unknown, unknown, never>

// Every row below goes through the tool that really makes the call, with the agent's real rules.
describe("R18 rows through the real tools", () => {
  const read = (target: (env: Env) => string) => (ctx: Tool.Context, env: Env) =>
    Effect.gen(function* () {
      const tool = yield* (yield* ReadTool).init()
      return yield* tool.execute({ filePath: target(env) }, ctx)
    })
  const grep = (target: (env: Env) => string) => (ctx: Tool.Context, env: Env) =>
    Effect.gen(function* () {
      const tool = yield* (yield* GrepTool).init()
      return yield* tool.execute({ pattern: "one", path: target(env) }, ctx)
    })
  const glob = (target: (env: Env) => string) => (ctx: Tool.Context, env: Env) =>
    Effect.gen(function* () {
      const tool = yield* (yield* GlobTool).init()
      return yield* tool.execute({ pattern: "*.md", path: target(env) }, ctx)
    })
  const shell = (command: (env: Env) => string) => (ctx: Tool.Context, env: Env) =>
    Effect.gen(function* () {
      const tool = yield* (yield* ShellTool).init()
      return yield* tool.execute({ command: command(env) } as never, ctx)
    })

  type Row = {
    id: string
    run: (ctx: Tool.Context, env: Env) => Effect.Effect<unknown, unknown, any>
    // false: the gate asks. second: the next gate's own answer, unset when the row stops before it.
    passes: boolean
    second?: "passes" | "asks"
    always: "withheld" | "offered" | "either"
    pattern?: (env: Env) => string
    stopAt?: string
  }

  const offered = (row: Omit<Row, "always">): Row => ({ ...row, always: "offered" })
  const withheld = (row: Omit<Row, "always">): Row => ({ ...row, always: "withheld" })

  const rows: Row[] = [
    withheld({ id: "S1", run: read((e) => e.S), passes: true, second: "passes" }),
    withheld({ id: "S2", run: read((e) => `${e.S}/library.json`), passes: true, second: "passes" }),
    withheld({ id: "S3", run: glob((e) => e.S), passes: true, second: "passes" }),
    withheld({ id: "S4", run: read((e) => `${e.S}/./a.md`), passes: true, second: "passes" }),
    withheld({ id: "S5", run: read((e) => `${e.S}//a.md`), passes: true, second: "passes" }),
    withheld({ id: "F1", run: read((e) => `${e.S}/3 Skills/a/SKILL.md`), passes: true, second: "passes" }),
    withheld({ id: "F2", run: grep((e) => `${e.S}/4 Knowledge Bank`), passes: true, second: "passes" }),
    withheld({ id: "F3", run: read((e) => `${e.S}/x/.env`), passes: true, second: "asks" }),
    withheld({ id: "F4", run: read((e) => `${e.S}/x/.git/config`), passes: true, second: "asks" }),
    withheld({ id: "I1", run: glob((e) => e.R), passes: false, second: "passes" }),
    withheld({ id: "I2", run: read((e) => `${e.R}/app.asar`), passes: false, second: "passes" }),
    // Stops at the gate: a real walk from `/` is not something a test may start.
    withheld({ id: "I3", run: grep(() => "/"), passes: false, stopAt: "external_directory" }),
    offered({ id: "N1", run: read((e) => `${e.S}.x/a.md`), passes: false, second: "passes" }),
    offered({ id: "N2", run: grep((e) => `${e.S}.lama`), passes: false, second: "passes" }),
    offered({ id: "N3", run: read((e) => `${e.S}X/a.md`), passes: false, second: "passes" }),
    offered({ id: "N4", run: read((e) => `${e.S}-baru/a.md`), passes: false, second: "passes" }),
    // A case-insensitive disk canonicalises this spelling onto the root, which withholds always; the injected row pins the other.
    {
      id: "N5",
      run: read((e) => `${e.S.replace("Swarm.app", "swarm.app")}/a.md`),
      passes: false,
      second: "passes",
      always: "either",
    },
    withheld({
      id: "T1",
      run: (ctx, e) =>
        Effect.gen(function* () {
          const tool = yield* (yield* WriteTool).init()
          return yield* tool.execute({ filePath: `${e.S}/a.md`, content: "two\n" }, ctx)
        }),
      passes: false,
      second: "asks",
    }),
    withheld({
      id: "T2",
      run: (ctx, e) =>
        Effect.gen(function* () {
          const tool = yield* (yield* EditTool).init()
          return yield* tool.execute(
            { filePath: `${e.S}/3 Skills/a/SKILL.md`, oldString: "one", newString: "two" },
            ctx,
          )
        }),
      passes: false,
      second: "asks",
    }),
    withheld({
      id: "T3",
      run: (ctx, e) =>
        Effect.gen(function* () {
          const tool = yield* (yield* ApplyPatchTool).init()
          return yield* tool.execute(
            { patchText: `*** Begin Patch\n*** Update File: ${e.S}/a.md\n@@\n-one\n+two\n*** End Patch` },
            ctx,
          )
        }),
      passes: false,
      second: "asks",
    }),
    withheld({
      id: "T4",
      run: (ctx, e) =>
        Effect.gen(function* () {
          const tool = yield* (yield* LspTool).init()
          return yield* tool.execute({ operation: "hover", filePath: `${e.S}/a.ts`, line: 1, character: 1 }, ctx)
        }),
      passes: false,
      // R18 used `edit` as a stand-in here and counted two prompts. `lsp` is harmless itself, so the folder is the only one.
      second: "passes",
      stopAt: "lsp",
    }),
    withheld({ id: "B1", run: shell((e) => `cat ${e.S}/a.md`), passes: false, second: "asks", stopAt: "bash" }),
    withheld({
      id: "B2",
      run: shell((e) => `rm -rf "${e.S}/3 Skills"`),
      passes: false,
      second: "asks",
      stopAt: "bash",
    }),
    withheld({
      id: "L1",
      run: read((e) => `${e.S}/link-out/f.md`),
      passes: false,
      second: "passes",
      pattern: (e) => `${e.far}/*`,
    }),
    withheld({
      id: "L3",
      run: read((e) => `${e.project}/lnk/f.md`),
      passes: false,
      second: "passes",
      pattern: (e) => `${e.S}/*`,
    }),
    withheld({ id: "D1", run: read((e) => `${e.S}/link-out/../x.md`), passes: false, second: "passes" }),
    withheld({ id: "D2", run: read((e) => `${e.S}/../lnk/../pustaka/x.md`), passes: false, second: "passes" }),
    withheld({ id: "D3", run: read((e) => `${e.S}/a/../b.md`), passes: false, second: "passes" }),
    withheld({ id: "D4", run: read((e) => `${e.S}/../../rahasia.md`), passes: false, second: "passes" }),
  ]

  for (const row of rows) {
    kit.live(row.id, () =>
      Effect.gen(function* () {
        const env = yield* install
        const asked: Asked[] = []
        const ctx = session(
          (request) =>
            Effect.suspend(() => {
              asked.push(request)
              return request.permission === row.stopAt ? Effect.die(STOP) : Effect.void
            }),
          { canUndo: true, library: env.S },
        )
        const ruleset = yield* Effect.gen(function* () {
          const agents = yield* Agent.Service
          const build = yield* agents.get("build")
          const exit = yield* Effect.exit(row.run(ctx, env))
          if (Exit.isFailure(exit) && row.stopAt && Cause.squash(exit.cause) !== STOP) throw Cause.squash(exit.cause)
          return build.permission
        }).pipe(provideInstance(env.project), (effect) => onLibrary(env.S, effect))

        const gate = asked.find((request) => request.permission === "external_directory")
        expect(gate).toBeDefined()
        expect(prompts(gate!, ruleset)).toBe(!row.passes)
        expect(gate!.harmless).toBe(row.passes ? true : undefined)
        if (row.always === "withheld") expect(gate!.always).toEqual([])
        if (row.always === "offered") expect(gate!.always).toEqual([...gate!.patterns])
        if (row.pattern) expect(gate!.patterns).toEqual([row.pattern(env)])
        if (!row.second) return
        const others = asked.filter((request) => request.permission !== "external_directory")
        expect(others.some((request) => prompts(request, ruleset))).toBe(row.second === "asks")
      }),
    )
  }

  // The gate on its own, then through `read`, which must not open anything on the way to or past it.
  kit.live("L2: a real link loop asks, with always withheld", () =>
    Effect.gen(function* () {
      const env = yield* install
      const asked: Asked[] = []
      const ctx = session(
        (request) =>
          Effect.sync(() => {
            asked.push(request)
          }),
        { canUndo: true, library: env.S },
      )
      yield* assertExternalDirectoryEffect(ctx, `${env.S}/loop/f.md`, { readOnly: true }).pipe(
        provideInstance(env.project),
        (effect) => onLibrary(env.S, effect),
      )
      expect(asked[0]!.harmless).toBeUndefined()
      expect(asked[0]!.always).toEqual([])

      asked.length = 0
      const exit = yield* Effect.gen(function* () {
        const tool = yield* (yield* ReadTool).init()
        return yield* tool.execute({ filePath: `${env.S}/loop/f.md` }, ctx)
      }).pipe(provideInstance(env.project), (effect) => onLibrary(env.S, effect), Effect.exit)
      // R18 expected a prompt here. `stat` fails on the loop first, so the call ends with no prompt and nothing opened.
      expect(Exit.isFailure(exit)).toBe(true)
      expect(asked).toEqual([])
    }),
  )
})

describe("who decides the library's gate", () => {
  const gate = (trust: Tool.Context["trust"], target: (env: Env) => string, options?: { readOnly?: boolean }) =>
    Effect.gen(function* () {
      const env = yield* install
      const asked: Asked[] = []
      const ctx = session(
        (request) =>
          Effect.sync(() => {
            asked.push(request)
          }),
        trust && { ...trust, library: trust.library && env.S },
      )
      yield* assertExternalDirectoryEffect(ctx, target(env), options).pipe(provideInstance(env.project))
      return { request: asked[0]!, env }
    })

  const fromSession = (permission: Agent.Info["permission"], global: { knowledge_library?: boolean }) =>
    Effect.gen(function* () {
      const env = yield* install
      const asked: Asked[] = []
      return yield* onLibrary(
        env.S,
        Effect.gen(function* () {
          const library = yield* SessionTools.library({
            agent: { name: "build", mode: "primary", options: {}, permission },
            config: TestConfig.make({ getGlobal: () => Effect.succeed(global) }),
          })
          const ctx = session(
            (request) =>
              Effect.sync(() => {
                asked.push(request)
              }),
            { canUndo: true, library },
          )
          yield* assertExternalDirectoryEffect(ctx, `${env.S}/a.md`, { readOnly: true }).pipe(
            provideInstance(env.project),
          )
          return asked[0]!
        }),
      )
    })

  kit.live("the key on: harmless, always withheld", () =>
    Effect.gen(function* () {
      const request = yield* fromSession([], {})
      expect(request.harmless).toBe(true)
      expect(request.always).toEqual([])
    }),
  )

  kit.live("the key off takes harmless away and still withholds always", () =>
    Effect.gen(function* () {
      const request = yield* fromSession([], { knowledge_library: false })
      expect(request.harmless).toBeUndefined()
      expect(request.always).toEqual([])
    }),
  )

  kit.live("a skill deny takes harmless away and still withholds always", () =>
    Effect.gen(function* () {
      const request = yield* fromSession([{ permission: "skill", pattern: "*", action: "deny" }], {})
      expect(request.harmless).toBeUndefined()
      expect(request.always).toEqual([])
    }),
  )

  kit.live("outside a session nothing passes", () =>
    Effect.gen(function* () {
      const env = yield* install
      const asked: Asked[] = []
      const ctx = session(
        (request) =>
          Effect.sync(() => {
            asked.push(request)
          }),
        undefined,
      )
      yield* assertExternalDirectoryEffect(ctx, `${env.S}/a.md`, { readOnly: true }).pipe(
        provideInstance(env.project),
        (effect) => onLibrary(env.S, effect),
      )
      expect(asked[0]!.harmless).toBeUndefined()
      expect(asked[0]!.always).toEqual([])
    }),
  )

  kit.live("a caller that does not say it only reads never passes", () =>
    Effect.gen(function* () {
      const env = yield* install
      const asked: Asked[] = []
      const ctx = session(
        (request) =>
          Effect.sync(() => {
            asked.push(request)
          }),
        { canUndo: true, library: env.S },
      )
      yield* assertExternalDirectoryEffect(ctx, `${env.S}/a.md`).pipe(provideInstance(env.project), (effect) =>
        onLibrary(env.S, effect),
      )
      expect(asked[0]!.harmless).toBeUndefined()
    }),
  )

  kit.live("the prompt carries readOnly only when the caller only reads", () =>
    Effect.gen(function* () {
      const reads = yield* gate(undefined, (e) => `${e.S}/a.md`, { readOnly: true })
      expect(reads.request.metadata.readOnly).toBe(true)
      const plain = yield* gate(undefined, (e) => `${e.S}/a.md`)
      expect("readOnly" in plain.request.metadata).toBe(false)
      const no = yield* gate(undefined, (e) => `${e.S}/a.md`, { readOnly: false })
      expect("readOnly" in no.request.metadata).toBe(false)
    }),
  )

  for (const absent of [{ kind: "no-app" }, { kind: "failed", code: "edition" }] as RealLibraryRoot.Status[]) {
    kit.live(`without a root (${absent.kind}) the gate is what it was`, () =>
      Effect.gen(function* () {
        status = absent
        const { request, env } = yield* gate({ canUndo: true }, (e) => `${e.S}/link-out/f.md`, { readOnly: true }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              status = undefined
            }),
          ),
        )
        expect(request.harmless).toBeUndefined()
        // The name, not where the link leads: this gate does not follow links outside the project.
        expect(request.patterns).toEqual([`${env.S}/link-out/*`])
        expect(request.always).toEqual([...request.patterns])
      }),
    )
  }
})

// KL-12 end to end: the prompt a person really answers, then what the tool that writes is asked next.
describe('"always" on a shell read of the library', () => {
  const flow = (input: { library: boolean; root: boolean }) =>
    Effect.gen(function* () {
      const env = yield* install
      const body = Effect.gen(function* () {
        const permission = yield* Permission.Service
        const agents = yield* Agent.Service
        const write = yield* (yield* WriteTool).init()
        const cat = yield* (yield* ShellTool).init()
        const ruleset = (yield* agents.get("build")).permission
        const ctx = session(
          (request) => permission.ask({ ...request, sessionID: SessionID.make("ses_library"), ruleset }).pipe(Effect.orDie),
          { canUndo: true, library: input.library ? env.S : undefined },
        )
        const next = (done: () => boolean) =>
          pollWithTimeout(
            Effect.gen(function* () {
              const list = yield* permission.list()
              if (list[0]) return list[0]
              return done() ? ("done" as const) : undefined
            }),
            "neither a prompt nor the end of the call",
          )

        let shellDone = false
        const shellFiber = yield* cat.execute({ command: `cat ${env.S}/a.md` } as never, ctx).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              shellDone = true
            }),
          ),
          Effect.exit,
          Effect.forkChild,
        )
        const first = yield* next(() => shellDone)
        if (first === "done") throw new Error("the shell read never asked")
        expect(first.permission).toBe("external_directory")
        const offered = [...first.always]
        yield* permission.reply({ requestID: first.id, reply: "always" })
        const second = yield* next(() => shellDone)
        if (second !== "done") yield* permission.reply({ requestID: second.id, reply: "reject" })
        yield* Fiber.join(shellFiber)

        let writeDone = false
        const writeFiber = yield* write.execute({ filePath: `${env.S}/a.md`, content: "two\n" }, ctx).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              writeDone = true
            }),
          ),
          Effect.exit,
          Effect.forkChild,
        )
        const after = yield* next(() => writeDone)
        const askedNext = after === "done" ? undefined : after.permission
        if (after !== "done") yield* permission.reply({ requestID: after.id, reply: "reject" })
        yield* Fiber.join(writeFiber)
        return { offered, askedNext }
      })

      return yield* (input.root ? onLibrary(env.S, body) : body).pipe(provideInstance(env.project))
    })

  kit.live("feature on: nothing to keep, and the write still asks about the folder", () =>
    Effect.gen(function* () {
      const result = yield* flow({ library: true, root: true })
      expect(result.offered).toEqual([])
      expect(result.askedNext).toBe("external_directory")
    }),
  )

  kit.live("feature off: the same, because the root comes from the resolver", () =>
    Effect.gen(function* () {
      const result = yield* flow({ library: false, root: true })
      expect(result.offered).toEqual([])
      expect(result.askedNext).toBe("external_directory")
    }),
  )

  // The control: without the withheld always, this is the hole. If this stops holding, the two above prove nothing.
  kit.live("without a root the folder is any other, and always does open it", () =>
    Effect.gen(function* () {
      const result = yield* flow({ library: false, root: false })
      expect(result.offered.length).toBe(1)
      expect(result.askedNext).not.toBe("external_directory")
    }),
  )
})
