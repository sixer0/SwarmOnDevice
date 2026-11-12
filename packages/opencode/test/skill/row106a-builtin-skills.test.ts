// Row 106a (1.2.6, OFF-02/OFF-03, 01c 11.9): tool-health and flux3-image-gen ship as built-in skills. Both are imported
// as text like mission-control.md, listed with location "<built-in>", load the bundled text by name, and are reserved:
// a disk copy of either name (this Mac still has ~/.config/swarm/skills/flux3-image-gen) is ignored with the
// "reserved skill name ignored" warning, so the bundled text is the one that loads.
import { describe, expect, test } from "bun:test"
import { Effect, Layer, Logger } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Global } from "@opencode-ai/core/global"
import { readFileSync } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { Skill } from "../../src/skill"
import { provideTmpdirInstance, testInstanceStoreLayer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  Layer.mergeAll(LayerNode.compile(Skill.node), LayerNode.compile(CrossSpawnSpawner.node), testInstanceStoreLayer),
)

const SRC = path.join(import.meta.dir, "..", "..", "src", "skill")
const CASES = [
  { name: "tool-health", file: "tool-health.md" },
  { name: "flux3-image-gen", file: "flux3-image-gen.md" },
] as const

const captureLogs = <A, E, R>(messages: string[], self: Effect.Effect<A, E, R>) =>
  self.pipe(
    Effect.provide(
      Logger.layer([
        Logger.make<unknown, void>((options) => {
          messages.push(JSON.stringify(options.message))
        }),
      ]),
    ),
  )

const imitation = (name: string) => `---\nname: ${name}\ndescription: Imitation from the disk.\n---\n\n# Imitation body\n`

describe("1.2.6 row 106a built-in tool-health and flux3-image-gen", () => {
  test("names and contents are exported from the skill module and equal the bundled files", () => {
    const s = Skill as unknown as Record<string, string | undefined>
    expect(s.TOOL_HEALTH_SKILL_NAME).toBe("tool-health")
    expect(s.FLUX3_IMAGE_GEN_SKILL_NAME).toBe("flux3-image-gen")
    expect(s.TOOL_HEALTH_SKILL_CONTENT).toBe(readFileSync(path.join(SRC, "tool-health.md"), "utf8"))
    expect(s.FLUX3_IMAGE_GEN_SKILL_CONTENT).toBe(readFileSync(path.join(SRC, "flux3-image-gen.md"), "utf8"))
    for (const d of [s.TOOL_HEALTH_SKILL_DESCRIPTION, s.FLUX3_IMAGE_GEN_SKILL_DESCRIPTION]) {
      expect(typeof d).toBe("string")
      expect(d!.length).toBeLessThanOrEqual(600)
      expect(d).toContain("Load it when")
    }
  })

  for (const c of CASES) {
    it.live(`${c.name} is listed as a built-in and loads the bundled text`, () =>
      provideTmpdirInstance(() =>
        Effect.gen(function* () {
          const skill = yield* Skill.Service
          const listed = (yield* skill.available()).find((s) => s.name === c.name)
          expect(listed?.location).toBe("<built-in>")
          expect(listed?.description?.length ?? 0).toBeGreaterThan(0)
          const got = yield* skill.require(c.name)
          expect(got.content).toBe(readFileSync(path.join(SRC, c.file), "utf8"))
        }),
      ),
    )

    it.live(`${c.name}: a disk copy (global config and project) is refused with the reserved-name warning`, () => {
      const globalCopy = path.join(Global.Path.config, "skills", c.name)
      const logs: string[] = []
      return captureLogs(
        logs,
        Effect.gen(function* () {
          yield* Effect.addFinalizer(() => Effect.promise(() => fs.rm(globalCopy, { recursive: true, force: true })))
          yield* Effect.promise(() => Bun.write(path.join(globalCopy, "SKILL.md"), imitation(c.name)))
          yield* provideTmpdirInstance(
            (dir) =>
              Effect.gen(function* () {
                for (const where of [".swarm/skill", ".agents/skills"])
                  yield* Effect.promise(() => Bun.write(path.join(dir, where, c.name, "SKILL.md"), imitation(c.name)))
                const skill = yield* Skill.Service
                const all = (yield* skill.all()).filter((s) => s.name === c.name)
                expect(all).toHaveLength(1)
                expect(all[0].location).toBe("<built-in>")
                expect(all[0].content).not.toContain("Imitation body")
                expect((yield* skill.require(c.name)).content).toBe(readFileSync(path.join(SRC, c.file), "utf8"))
                const refused = logs.filter((l) => l.includes("reserved skill name ignored"))
                expect(refused.length).toBe(3)
              }),
            { git: true },
          )
        }).pipe(Effect.scoped),
      )
    })
  }
})
