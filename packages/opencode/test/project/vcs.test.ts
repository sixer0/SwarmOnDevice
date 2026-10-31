import { afterEach, describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { parsePatch } from "diff"
import { Deferred, Effect, Layer } from "effect"
import fs from "fs/promises"
import path from "path"
import {
  disposeAllInstances,
  provideInstance,
  testInstanceStoreLayer,
  TestInstance,
  tmpdirScoped,
} from "../fixture/fixture"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Watcher } from "@opencode-ai/core/filesystem/watcher"
import { Git } from "../../src/git"
import { Vcs } from "@/project/vcs"
import { testEffect } from "../lib/effect"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const weird = process.platform === "win32" ? "space file.txt" : "tab\tfile.txt"

const layer = LayerNode.compile(
  LayerNode.group([Vcs.node, Git.node, EventV2Bridge.node, FSUtil.node, CrossSpawnSpawner.node]),
)
const it = testEffect(layer)
const worktreeIt = testEffect(Layer.mergeAll(layer, testInstanceStoreLayer))

const git = Effect.fn("VcsTest.git")(function* (cwd: string, args: string[]) {
  const result = yield* Git.Service.use((git) => git.run(args, { cwd }))
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString("utf8")}`)
})

const write = Effect.fn("VcsTest.write")(function* (file: string, content: string) {
  yield* FSUtil.Service.use((fs) => fs.writeWithDirs(file, content))
})

const remove = Effect.fn("VcsTest.remove")(function* (file: string) {
  yield* FSUtil.Service.use((fs) => fs.remove(file))
})

const symlink = (target: string, file: string) => Effect.promise(() => fs.symlink(target, file))

const init = Effect.fn("VcsTest.init")(function* () {
  const vcs = yield* Vcs.Service
  yield* vcs.init()
  return vcs
})

const nextBranchUpdate = Effect.fn("VcsTest.nextBranchUpdate")(function* () {
  const events = yield* EventV2Bridge.Service
  const updated = yield* Deferred.make<string | undefined>()

  const off = yield* events.listen((event) => {
    if (event.type === Vcs.Event.BranchUpdated.type)
      Deferred.doneUnsafe(updated, Effect.succeed((event.data as typeof Vcs.Event.BranchUpdated.data.Type).branch))
    return Effect.void
  })
  yield* Effect.addFinalizer(() => off)

  return updated
})

const publishHeadChangeUntil = Effect.fn("VcsTest.publishHeadChangeUntil")(function* (
  pending: Deferred.Deferred<string | undefined>,
  head: string,
) {
  const events = yield* EventV2Bridge.Service
  for (let i = 0; i < 50; i++) {
    yield* events.publish(Watcher.Event.Updated, { file: head, event: "change" })
    if (yield* Deferred.isDone(pending)) return
    yield* Effect.sleep("10 millis")
  }
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Vcs", () => {
  afterEach(async () => {
    await disposeAllInstances()
  })

  it.instance(
    "branch() returns current branch name",
    () =>
      Effect.gen(function* () {
        const vcs = yield* init()
        const branch = yield* vcs.branch()

        expect(branch).toBeDefined()
        expect(typeof branch).toBe("string")
      }),
    { git: true },
  )

  it.instance("branch() returns undefined for non-git directories", () =>
    Effect.gen(function* () {
      const vcs = yield* init()
      const branch = yield* vcs.branch()

      expect(branch).toBeUndefined()
    }),
  )

  it.instance(
    "publishes BranchUpdated when .git/HEAD changes",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const branch = `test-${Math.random().toString(36).slice(2)}`
        yield* git(test.directory, ["branch", branch])

        const vcs = yield* init()
        yield* vcs.branch()
        const pending = yield* nextBranchUpdate()

        const head = path.join(test.directory, ".git", "HEAD")
        yield* write(head, `ref: refs/heads/${branch}\n`)
        yield* publishHeadChangeUntil(pending, head)

        const updated = yield* Deferred.await(pending).pipe(Effect.timeout("2 seconds"))
        expect(updated).toBe(branch)
      }),
    { git: true },
  )

  it.instance(
    "branch() reflects the new branch after HEAD change",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const branch = `test-${Math.random().toString(36).slice(2)}`
        yield* git(test.directory, ["branch", branch])

        const vcs = yield* init()
        yield* vcs.branch()
        const pending = yield* nextBranchUpdate()

        const head = path.join(test.directory, ".git", "HEAD")
        yield* write(head, `ref: refs/heads/${branch}\n`)
        yield* publishHeadChangeUntil(pending, head)
        yield* Deferred.await(pending).pipe(Effect.timeout("2 seconds"))

        const current = yield* vcs.branch()
        expect(current).toBe(branch)
      }),
    { git: true },
  )
})

describe("Vcs diff", () => {
  afterEach(async () => {
    await disposeAllInstances()
  })

  it.instance(
    "defaultBranch() falls back to main",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* git(test.directory, ["branch", "-M", "main"])

        const vcs = yield* init()
        const branch = yield* vcs.defaultBranch()

        expect(branch).toBe("main")
      }),
    { git: true },
  )

  it.instance(
    "defaultBranch() uses init.defaultBranch when available",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* git(test.directory, ["branch", "-M", "trunk"])
        yield* git(test.directory, ["config", "init.defaultBranch", "trunk"])

        const vcs = yield* init()
        const branch = yield* vcs.defaultBranch()

        expect(branch).toBe("trunk")
      }),
    { git: true },
  )

  worktreeIt.live("detects current branch from the active worktree", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped({ git: true })
      const wt = yield* tmpdirScoped()
      yield* git(tmp, ["branch", "-M", "main"])
      const dir = path.join(wt, "feature")
      yield* git(tmp, ["worktree", "add", "-b", "feature/test", dir, "HEAD"])

      const [branch, base] = yield* Effect.gen(function* () {
        const vcs = yield* init()
        return yield* Effect.all([vcs.branch(), vcs.defaultBranch()], { concurrency: 2 })
      }).pipe(provideInstance(dir))

      expect(branch).toBeDefined()
      expect(branch).toBe("feature/test")
      expect(base).toBe("main")
    }),
  )

  it.instance(
    "diff('git') returns uncommitted changes",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* write(path.join(test.directory, "file.txt"), "original\n")
        yield* git(test.directory, ["add", "."])
        yield* git(test.directory, ["commit", "--no-gpg-sign", "-m", "add file"])
        yield* write(path.join(test.directory, "file.txt"), "changed\n")

        const vcs = yield* init()
        const diff = yield* vcs.diff("git")

        expect(diff).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              file: "file.txt",
              status: "modified",
            }),
          ]),
        )
        expect(diff.find((item) => item.file === "file.txt")?.patch).toContain("diff --git")
      }),
    { git: true },
  )

  it.instance(
    "diff('git') handles special filenames",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* write(path.join(test.directory, weird), "hello\n")

        const vcs = yield* init()
        const diff = yield* vcs.diff("git")

        expect(diff).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              file: weird,
              status: "added",
            }),
          ]),
        )
      }),
    { git: true },
  )

  it.instance(
    "diff('git') keeps batched patches aligned for type changes",
    () =>
      Effect.gen(function* () {
        if (process.platform === "win32") return

        const test = yield* TestInstance
        yield* write(path.join(test.directory, "a.txt"), "old\n")
        yield* write(path.join(test.directory, "b.txt"), "old\n")
        yield* git(test.directory, ["add", "."])
        yield* git(test.directory, ["commit", "--no-gpg-sign", "-m", "add files"])
        yield* remove(path.join(test.directory, "a.txt"))
        yield* symlink("target", path.join(test.directory, "a.txt"))
        yield* write(path.join(test.directory, "b.txt"), "new\n")

        const vcs = yield* init()
        const diff = yield* vcs.diff("git")
        const a = diff.find((item) => item.file === "a.txt")
        const b = diff.find((item) => item.file === "b.txt")

        expect(a?.patch).toContain("deleted file mode")
        expect(a?.patch).toContain("new file mode")
        expect(b?.patch).toContain("+new")
      }),
    { git: true },
  )

  it.instance(
    "diff('git') keeps carriage returns inside patch hunks",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* write(path.join(test.directory, "file.txt"), "keep\nsame\rdiff --git inside\ndelete\n")
        yield* git(test.directory, ["add", "."])
        yield* git(test.directory, ["commit", "--no-gpg-sign", "-m", "add file"])
        yield* write(path.join(test.directory, "file.txt"), "keep\nadd\nsame\rdiff --git inside\n")

        const vcs = yield* init()
        const diff = yield* vcs.diff("git")
        const file = diff.find((item) => item.file === "file.txt")

        expect(file?.patch).toContain(" same\rdiff --git inside")
        expect(file?.patch).toContain("-delete")
        expect(() => parsePatch(file?.patch ?? "")).not.toThrow()
      }),
    { git: true },
    20_000,
  )

  it.instance(
    "diff('branch') returns changes against default branch",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* git(test.directory, ["branch", "-M", "main"])
        yield* git(test.directory, ["checkout", "-b", "feature/test"])
        yield* write(path.join(test.directory, "branch.txt"), "hello\n")
        yield* git(test.directory, ["add", "."])
        yield* git(test.directory, ["commit", "--no-gpg-sign", "-m", "branch file"])

        const vcs = yield* init()
        const diff = yield* vcs.diff("branch")

        expect(diff).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              file: "branch.txt",
              status: "added",
            }),
          ]),
        )
      }),
    { git: true },
  )
  describe("commit", () => {
    const output = Effect.fn("VcsTest.output")(function* (cwd: string, args: string[]) {
      return (yield* Git.Service.use((git) => git.run(args, { cwd }))).text()
    })

    it.instance(
      "commits exactly the named paths, new, changed and deleted, and leaves everything else alone",
      () =>
        Effect.gen(function* () {
          const test = yield* TestInstance
          const dir = test.directory
          yield* write(path.join(dir, "keep.txt"), "one\n")
          yield* write(path.join(dir, "gone.txt"), "one\n")
          yield* write(path.join(dir, "other.txt"), "one\n")
          yield* write(path.join(dir, "staged.txt"), "one\n")
          yield* git(dir, ["add", "."])
          yield* git(dir, ["commit", "--no-gpg-sign", "-m", "base"])

          yield* write(path.join(dir, "keep.txt"), "two\n")
          yield* remove(path.join(dir, "gone.txt"))
          yield* write(path.join(dir, "a new *.txt"), "new\n")
          yield* write(path.join(dir, "a new b.txt"), "not this one\n")
          yield* write(path.join(dir, "other.txt"), "someone else's\n")
          yield* write(path.join(dir, "staged.txt"), "staged by someone\n")
          yield* git(dir, ["add", "staged.txt"])

          const vcs = yield* init()
          const result = yield* vcs.commit({
            files: ["keep.txt", "gone.txt", "a new *.txt"],
            message: "  Land it\n\n#1 stays a line\n",
          })

          expect([...result.files].sort()).toEqual(["a new *.txt", "gone.txt", "keep.txt"])
          expect(result.hash).toHaveLength(40)
          expect(result.hash.startsWith(result.short)).toBe(true)
          expect(result.branch).toBe(yield* vcs.branch())
          expect((yield* output(dir, ["log", "-1", "--format=%B"])).trim()).toBe("Land it\n\n#1 stays a line")
          const status = yield* output(dir, ["status", "--porcelain=v1", "--untracked-files=all"])
          expect(status.split("\n").filter(Boolean).sort()).toEqual([
            " M other.txt",
            '?? "a new b.txt"',
            "M  staged.txt",
          ])
        }),
      { git: true },
    )

    it.instance(
      "a refusing hook leaves the index as it was and reports what the hook said",
      () =>
        Effect.gen(function* () {
          const test = yield* TestInstance
          const dir = test.directory
          yield* write(path.join(dir, "base.txt"), "one\n")
          yield* git(dir, ["add", "."])
          yield* git(dir, ["commit", "--no-gpg-sign", "-m", "base"])
          const hook = path.join(dir, ".git", "hooks", "pre-commit")
          yield* write(hook, "#!/bin/sh\necho 'lint says no' >&2\nexit 1\n")
          yield* Effect.promise(() => fs.chmod(hook, 0o755))
          yield* write(path.join(dir, "base.txt"), "two\n")
          yield* write(path.join(dir, "new.txt"), "new\n")
          const before = yield* output(dir, ["status", "--porcelain=v1", "--untracked-files=all"])
          const head = yield* output(dir, ["rev-parse", "HEAD"])

          const vcs = yield* init()
          const error = yield* vcs.commit({ files: ["base.txt", "new.txt"], message: "Nope" }).pipe(Effect.flip)

          expect(error.reason).toBe("refused")
          expect(error.message).toContain("lint says no")
          expect(yield* output(dir, ["status", "--porcelain=v1", "--untracked-files=all"])).toBe(before)
          expect(yield* output(dir, ["rev-parse", "HEAD"])).toBe(head)
        }),
      { git: true },
    )

    it.instance(
      "paths are from the top of the repository when working in a subdirectory, and a first commit works",
      () =>
        Effect.gen(function* () {
          const test = yield* TestInstance
          const dir = test.directory
          yield* write(path.join(dir, "sub", "a.txt"), "a\n")
          yield* git(dir, ["update-ref", "-d", "HEAD"])
          const vcs = yield* init()
          const result = yield* vcs.commit({ files: ["sub/a.txt"], message: "First" })
          expect(result.files).toEqual(["sub/a.txt"])
        }),
      { git: true },
    )

    it.instance(
      "refuses an empty message, no files, and a path with nothing to commit",
      () =>
        Effect.gen(function* () {
          const vcs = yield* init()
          expect((yield* vcs.commit({ files: ["a"], message: "  " }).pipe(Effect.flip)).reason).toBe("invalid")
          expect((yield* vcs.commit({ files: [], message: "m" }).pipe(Effect.flip)).reason).toBe("invalid")
          expect((yield* vcs.commit({ files: ["missing.txt"], message: "m" }).pipe(Effect.flip)).reason).toBe("refused")
        }),
      { git: true },
    )

    it.instance("refuses outside git", () =>
      Effect.gen(function* () {
        const vcs = yield* init()
        expect((yield* vcs.commit({ files: ["a"], message: "m" }).pipe(Effect.flip)).reason).toBe("non-git")
      }),
    )
  })
})
