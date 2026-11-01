import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Cause, Effect, Exit } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { RipgrepBinary } from "@opencode-ai/core/ripgrep/binary"
import { RelativePath } from "@opencode-ai/core/schema"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(LayerNode.compile(Ripgrep.node))

describe("Ripgrep", () => {
  it.live("keeps ignored files out of catch-all find results", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => fs.mkdir(path.join(tmp.path, "node_modules", "pkg"), { recursive: true }))
          yield* Effect.promise(() => fs.mkdir(path.join(tmp.path, "src")))
          yield* Effect.promise(() => Bun.$`git init -q ${tmp.path}`)
          yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, ".gitignore"), "node_modules/\n"))
          yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "node_modules", "pkg", "index.js"), "ignored\n"))
          yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "src", "index.js"), "included\n"))

          const files = yield* (yield* Ripgrep.Service).find({ cwd: tmp.path, pattern: "*", limit: 10 })
          expect(files.map((item) => item.path)).toContain(RelativePath.make("src/index.js"))
          expect(files.map((item) => item.path)).not.toContain(RelativePath.make("node_modules/pkg/index.js"))
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("never includes git metadata", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => fs.mkdir(path.join(tmp.path, ".opencode")))
          yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, ".opencode", "config"), "needle\n"))
          yield* Effect.promise(() => fs.mkdir(path.join(tmp.path, ".git")))
          yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, ".git", "config"), "needle\n"))
          const ripgrep = yield* Ripgrep.Service

          const files = yield* ripgrep.find({ cwd: tmp.path, pattern: "**/*", limit: 10 })
          expect(files.map((item) => item.path)).toContain(RelativePath.make(".opencode/config"))
          expect(files.map((item) => item.path)).not.toContain(RelativePath.make(".git/config"))

          const observed: string[] = []
          const limited = yield* ripgrep.find({
            cwd: tmp.path,
            pattern: "**/*",
            limit: 1,
            onEntry: (entry) => Effect.sync(() => observed.push(entry.path)),
          })
          expect(observed).toEqual(limited.map((item) => item.path))

          const matches = yield* ripgrep.grep({ cwd: tmp.path, pattern: "needle", include: "config", limit: 10 })
          expect(matches.map((item) => item.entry.path)).toContain(RelativePath.make(".opencode/config"))
          expect(matches.map((item) => item.entry.path)).not.toContain(RelativePath.make(".git/config"))
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )
  it.live("does not split surrogate pairs in oversized line previews", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            fs.writeFile(path.join(tmp.path, "unicode.txt"), `needle${"x".repeat(1_993)}😀\n`),
          )

          const matches = yield* (yield* Ripgrep.Service).grep({
            cwd: tmp.path,
            pattern: "needle",
            limit: 10,
          })

          expect(matches[0]?.text).toBe(`needle${"x".repeat(1_993)}...`)
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )
})

describe("RipgrepBinary", () => {
  const binary = testEffect(LayerNode.compile(RipgrepBinary.node))
  const name = process.platform === "win32" ? "rg.exe" : "rg"

  const writeExecutable = async (dir: string) => {
    await fs.mkdir(dir, { recursive: true })
    const file = path.join(dir, name)
    await fs.writeFile(file, "#!/bin/sh\n")
    await fs.chmod(file, 0o755)
    return file
  }

  // Bun has no resourcesPath, Electron's utilityProcess does: the tests set it the way Electron exposes it.
  const withEnvironment = <A, E, R>(
    resourcesPath: { readonly value: unknown } | undefined,
    use: (dir: string) => Effect.Effect<A, E, R>,
  ) =>
    Effect.acquireUseRelease(
      Effect.promise(async () => {
        const tmp = await tmpdir()
        const previous = { path: process.env.PATH, bin: Global.Path.bin }
        process.env.PATH = path.join(tmp.path, "path")
        Global.Path.bin = path.join(tmp.path, "bin")
        if (resourcesPath)
          Object.defineProperty(process, "resourcesPath", { value: resourcesPath.value, configurable: true })
        return { tmp, previous }
      }),
      ({ tmp }) => use(tmp.path),
      ({ tmp, previous }) =>
        Effect.promise(async () => {
          process.env.PATH = previous.path
          Global.Path.bin = previous.bin
          Reflect.deleteProperty(process, "resourcesPath")
          await tmp[Symbol.asyncDispose]()
        }),
    )

  binary.live("finds the copy packaged in the app resources before the one on PATH", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() => tmpdir())
      yield* Effect.addFinalizer(() => Effect.promise(() => fixture[Symbol.asyncDispose]()))
      const packaged = yield* Effect.promise(() => writeExecutable(fixture.path))
      yield* withEnvironment({ value: fixture.path }, (dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => writeExecutable(path.join(dir, "path")))
          expect(yield* (yield* RipgrepBinary.Service).filepath).toBe(packaged)
        }),
      )
    }),
  )

  binary.live("falls through to PATH when the app resources hold no ripgrep", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() => tmpdir())
      yield* Effect.addFinalizer(() => Effect.promise(() => fixture[Symbol.asyncDispose]()))
      yield* withEnvironment({ value: fixture.path }, (dir) =>
        Effect.gen(function* () {
          const onPath = yield* Effect.promise(() => writeExecutable(path.join(dir, "path")))
          expect(yield* (yield* RipgrepBinary.Service).filepath).toBe(onPath)
        }),
      )
    }),
  )

  for (const [label, resourcesPath] of [
    ["undefined", undefined],
    ["not a string", { value: 42 }],
    ["empty", { value: "" }],
    ["relative", { value: "Resources" }],
  ] as const) {
    binary.live(`ignores a resourcesPath that is ${label}`, () =>
      withEnvironment(resourcesPath, (dir) =>
        Effect.gen(function* () {
          const onPath = yield* Effect.promise(() => writeExecutable(path.join(dir, "path")))
          expect(yield* (yield* RipgrepBinary.Service).filepath).toBe(onPath)
        }),
      ),
    )
  }

  binary.live("reports every place it tried without a stray entry for a missing resourcesPath", () =>
    withEnvironment(undefined, () =>
      Effect.gen(function* () {
        const exit = yield* (yield* RipgrepBinary.Service).filepath.pipe(Effect.exit)
        const message = Cause.pretty(Exit.isFailure(exit) ? exit.cause : Cause.empty)
        expect(message).toContain("ripgrep binary not found")
        expect(message).toContain(`${name} on PATH (not found)`)
        expect(message).not.toContain("undefined")
        expect(message).not.toContain("ERR_INVALID_ARG_TYPE")
      }),
    ),
  )

  binary.live("names the app resources among the places it tried", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() => tmpdir())
      yield* Effect.addFinalizer(() => Effect.promise(() => fixture[Symbol.asyncDispose]()))
      yield* withEnvironment({ value: fixture.path }, () =>
        Effect.gen(function* () {
          const exit = yield* (yield* RipgrepBinary.Service).filepath.pipe(Effect.exit)
          expect(Cause.pretty(Exit.isFailure(exit) ? exit.cause : Cause.empty)).toContain(path.join(fixture.path, name))
        }),
      )
    }),
  )
})
