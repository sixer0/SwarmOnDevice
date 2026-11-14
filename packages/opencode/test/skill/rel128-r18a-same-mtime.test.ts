// Swarm 1.2.8 row 40, AC-R18a (N8-324, R-18a C65): the skill set is rebuilt when its change key moves. The key was
// path + mtime + ctime + size, so a same-length rewrite whose times stay the same (a restored mtime, a coarse clock)
// kept serving the old text. A SKILL.md up to SKILL_HASH_MAX_BYTES now adds a sha256 of its bytes; a bigger one keeps
// the stat key alone (branch tested). The times are pinned through a spy on `stat`, because ctime cannot be set from
// user space; only the test's own SKILL.md is affected.
import { afterEach, describe, expect, spyOn } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Effect, Layer } from "effect"
import fsp from "node:fs/promises"
import * as fspNamespace from "node:fs/promises"
import path from "path"
import { Skill } from "../../src/skill"
import { provideTmpdirInstance, testInstanceStoreLayer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  Layer.mergeAll(LayerNode.compile(Skill.node), LayerNode.compile(CrossSpawnSpawner.node), testInstanceStoreLayer),
)

const realStat = fsp.stat
let pinned: string | undefined
const spy = spyOn(fspNamespace, "stat").mockImplementation((async (...args: Parameters<typeof fsp.stat>) => {
  const info = await realStat(...args)
  if (pinned && path.resolve(String(args[0])) === pinned) {
    // Same times on every call, so only the content can tell the two versions apart.
    return Object.assign(info, { mtimeMs: 1_700_000_000_000, ctimeMs: 1_700_000_000_000 })
  }
  return info
}) as typeof fsp.stat)

afterEach(() => {
  pinned = undefined
})

const skillText = (body: string) => `---\nname: same-length\ndescription: Same-length rewrite.\n---\n\n${body}\n`

const run = (body1: string, body2: string) =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const file = path.join(dir, ".swarm", "skills", "same-length", "SKILL.md")
        yield* Effect.promise(() => Bun.write(file, skillText(body1)))
        pinned = path.resolve(file)
        const skill = yield* Skill.Service
        const first = yield* skill.get("same-length")
        expect(first?.content).toContain(body1.slice(0, 20))
        expect(body2.length).toBe(body1.length)
        yield* Effect.promise(() => Bun.write(file, skillText(body2)))
        const second = yield* skill.get("same-length")
        expect(spy).toHaveBeenCalled()
        return second?.content ?? ""
      }),
    { git: true },
  )

describe("AC-R18a a same-length rewrite with unchanged times is seen", () => {
  it.live("the next load returns the new content", () =>
    Effect.gen(function* () {
      const content = yield* run("# Version AAAA", "# Version BBBB")
      expect(content).toContain("# Version BBBB")
    }),
  )

  it.live("a file over SKILL_HASH_MAX_BYTES keeps the stat key (the old content stays until the stat moves)", () =>
    Effect.gen(function* () {
      expect(Skill.SKILL_HASH_MAX_BYTES).toBe(1048576)
      const filler = "x".repeat(Skill.SKILL_HASH_MAX_BYTES)
      const content = yield* run(`# Version AAAA\n${filler}`, `# Version BBBB\n${filler}`)
      expect(content).toContain("# Version AAAA")
    }),
  )
})
