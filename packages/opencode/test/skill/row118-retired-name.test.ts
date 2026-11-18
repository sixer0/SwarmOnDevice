// Row 118: the retired built-in name studio-mission-ops (merged into mission-control, 1.3.3 MANIFEST row 1) is reserved.
// A user-level skill of that name is ignored, so it cannot shadow or appear beside the merged built-in.
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import path from "node:path"
import { Skill } from "../../src/skill"
import { provideTmpdirInstance, testInstanceStoreLayer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  Layer.mergeAll(LayerNode.compile(Skill.node), LayerNode.compile(CrossSpawnSpawner.node), testInstanceStoreLayer),
)

describe("row 118: retired name studio-mission-ops", () => {
  test("the name is reserved and is not a registered built-in", () => {
    expect(Skill.RETIRED_MISSION_OPS_SKILL_NAME).toBe("studio-mission-ops")
    expect(Skill.RESERVED_SKILL_NAMES.has("studio-mission-ops")).toBe(true)
  })

  it.live("a disk copy of the retired name is ignored, in every skill folder", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          for (const where of [".swarm/skill", ".claude/skills", ".agents/skills"])
            yield* Effect.promise(() =>
              Bun.write(
                path.join(dir, where, "studio-mission-ops", "SKILL.md"),
                "---\nname: studio-mission-ops\ndescription: Old copy.\n---\n\n# Old body\n",
              ),
            )
          const skill = yield* Skill.Service
          const all = yield* skill.all()
          expect(all.filter((s) => s.name === "studio-mission-ops")).toHaveLength(0)
          expect(all.filter((s) => s.name === "mission-control")).toHaveLength(1)
        }),
      { git: true },
    ),
  )
})
