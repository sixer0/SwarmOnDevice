import { expect } from "bun:test"
import { $ } from "bun"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Snapshot } from "../../src/snapshot"
import { Vcs } from "../../src/project/vcs"
import { ProjectTrust } from "@opencode-ai/core/project/trust"
import { provideInstance, testInstanceStoreLayer, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  Layer.mergeAll(
    LayerNode.compile(LayerNode.group([Snapshot.node, Vcs.node, FSUtil.node, CrossSpawnSpawner.node])),
    testInstanceStoreLayer,
  ),
)

const seen = (file: string) =>
  Bun.file(file)
    .text()
    .catch(() => "")

// A submodule whose own config names programs. git runs any of them if it starts a child inside the submodule, whichever
// repository the outer command is pointed at. Trust has no part here: Snapshot must not run them in any folder.
const plant = (dir: string, registered: boolean) =>
  Effect.promise(async () => {
    const log = path.join(dir, ".fired")
    const program = path.join(dir, ".program.sh")
    await Bun.write(program, `#!/bin/sh\necho "$0 $1" >> ${JSON.stringify(log)}\ncat\n`)
    await fs.chmod(program, 0o755)
    const mod = path.join(dir, "mod")
    await fs.mkdir(mod, { recursive: true })
    await $`git init -q .`.cwd(mod).quiet()
    await $`git config user.email t@t.test`.cwd(mod).quiet()
    await $`git config user.name t`.cwd(mod).quiet()
    await Bun.write(path.join(mod, "a.dat"), "one\n")
    await Bun.write(path.join(mod, ".gitattributes"), "*.dat filter=evil\n")
    await $`git add .`.cwd(mod).quiet()
    await $`git commit -qm m`.cwd(mod).quiet()
    await $`git config core.fsmonitor ${program}`.cwd(mod).quiet()
    await $`git config filter.evil.clean ${program}`.cwd(mod).quiet()
    await Bun.write(path.join(mod, ".git/hooks/post-index-change"), `#!/bin/sh\necho hook >> ${JSON.stringify(log)}\n`)
    await fs.chmod(path.join(mod, ".git/hooks/post-index-change"), 0o755)
    await Bun.write(path.join(dir, "note.txt"), "one\n")
    await Bun.write(path.join(dir, ".gitignore"), ".fired\n.program.sh\n")
    if (registered) {
      await $`git add -f note.txt .gitignore mod`.cwd(dir).quiet().nothrow()
      await $`git commit -qm base`.cwd(dir).quiet()
    }
    // The same length as before: git must hash the file to tell, and that is what runs a clean filter.
    await Bun.write(path.join(mod, "a.dat"), "two\n")
    await fs.rm(log, { force: true })
    return log
  })

const run = (registered: boolean) =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped({ git: true })
    const log = yield* plant(dir, registered)
    return yield* Effect.gen(function* () {
      const snapshot = yield* Snapshot.Service
      const first = yield* snapshot.track()
      yield* Effect.promise(() => Bun.write(path.join(dir, "note.txt"), "two\n"))
      yield* Effect.promise(() => Bun.write(path.join(dir, "new.txt"), "new\n"))
      const patch = yield* snapshot.patch(first!)
      const second = yield* snapshot.track()
      const diff = yield* snapshot.diff(first!)
      yield* snapshot.revert([patch])
      const reverted = yield* Effect.promise(() => Bun.file(path.join(dir, "note.txt")).text())
      yield* snapshot.restore(second!)
      const restored = yield* Effect.promise(() => Bun.file(path.join(dir, "note.txt")).text())
      return { log: yield* Effect.promise(() => seen(log)), patch, diff, reverted, restored }
    }).pipe(provideInstance(dir))
  })

it.live("a registered submodule's programs do not run through Snapshot, and ordinary files are still tracked", () =>
  Effect.gen(function* () {
    const result = yield* run(true)
    expect(result.log).toBe("")
    expect(result.patch.files.map((file) => path.basename(file)).toSorted()).toEqual(["new.txt", "note.txt"])
    expect(result.diff).toContain("note.txt")
    expect(result.reverted).toBe("one\n")
    expect(result.restored).toBe("two\n")
  }),
)

it.live("a nested repository nobody registered does not run its programs through Snapshot either", () =>
  Effect.gen(function* () {
    const result = yield* run(false)
    expect(result.log).toBe("")
    expect(result.patch.files.map((file) => path.basename(file))).toContain("note.txt")
  }),
)

it.live("the changes panel's git reads do not run a submodule's programs, and a moved submodule still shows", () =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped({ git: true })
    const log = yield* plant(dir, true)
    const result = yield* Effect.gen(function* () {
      const vcs = yield* Vcs.Service
      yield* Effect.promise(() => Bun.write(path.join(dir, "note.txt"), "two\n"))
      const diff = yield* vcs.diff("git")
      const fired = yield* Effect.promise(() => seen(log))
      const mod = path.join(dir, "mod")
      yield* Effect.promise(async () => {
        const quiet = ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "filter.evil.clean=cat"]
        await $`git ${quiet} add .`.cwd(mod).quiet()
        await $`git ${quiet} commit -qm moved`.cwd(mod).quiet()
      })
      const moved = yield* vcs.diff("git")
      return { diff, fired, moved }
    }).pipe(provideInstance(dir))
    expect(result.fired).toBe("")
    expect(result.diff.map((item) => item.file)).toContain("note.txt")
    expect(result.moved.map((item) => item.file)).toContain("mod")
  }),
)

const gitConfigProgram = (dir: string) =>
  Effect.promise(async () => {
    const log = path.join(dir, ".fired")
    const program = path.join(dir, ".program.sh")
    await Bun.write(program, `#!/bin/sh\necho ran >> ${JSON.stringify(log)}\ncat\n`)
    await fs.chmod(program, 0o755)
    await Bun.write(path.join(dir, ".gitattributes"), "*.dat filter=evil diff=evil\n")
    await Bun.write(path.join(dir, "a.dat"), "one\n")
    await Bun.write(path.join(dir, ".gitignore"), ".fired\n.program.sh\n")
    await $`git add .`.cwd(dir).quiet()
    await $`git commit -qm base`.cwd(dir).quiet()
    await $`git config filter.evil.clean ${program}`.cwd(dir).quiet()
    await $`git config diff.evil.textconv ${program}`.cwd(dir).quiet()
    await Bun.write(path.join(dir, "a.dat"), "two\n")
    await fs.rm(log, { force: true })
    return log
  })

const panelRead = (dir: string) =>
  Effect.gen(function* () {
    const vcs = yield* Vcs.Service
    return { diff: yield* vcs.diff("git"), status: yield* vcs.status() }
  }).pipe(provideInstance(dir))

it.live("untrusted: a program named in the repository's own git config does not run through the changes panel", () =>
  Effect.gen(function* () {
    ProjectTrust.assumeTrustedForTests(false)
    yield* Effect.addFinalizer(() => Effect.sync(() => ProjectTrust.assumeTrustedForTests(true)))
    const dir = yield* tmpdirScoped({ git: true })
    const log = yield* gitConfigProgram(dir)
    const result = yield* panelRead(dir)
    expect(yield* Effect.promise(() => seen(log))).toBe("")
    expect(result.diff).toEqual([])
    const status = ProjectTrust.status(dir)
    expect(status.state).toBe("ask")
    expect(status.items.map((item) => item.label).join()).toContain("Let git use its own setting filter.*.clean")
  }),
)

it.live("trusted: the same repository reads as usual", () =>
  Effect.gen(function* () {
    ProjectTrust.assumeTrustedForTests(false)
    yield* Effect.addFinalizer(() => Effect.sync(() => ProjectTrust.assumeTrustedForTests(true)))
    const dir = yield* tmpdirScoped({ git: true })
    const log = yield* gitConfigProgram(dir)
    ProjectTrust.trust(dir)
    const result = yield* panelRead(dir)
    expect(yield* Effect.promise(() => seen(log))).not.toBe("")
    expect(result.diff.map((item) => item.file)).toContain("a.dat")
  }),
)
