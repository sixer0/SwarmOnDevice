// Swarm 1.2.7 row U11b (decision C65): the skill list is re-checked on every request (row U11), so a warning about a
// broken global config must be logged once per distinct cause, not once per request.
import { describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Config } from "../../src/config/config"
import { Effect, Layer, Logger } from "effect"
import { Skill } from "../../src/skill"
import { provideTmpdirInstance, testInstanceStoreLayer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

let failure = "first synthetic failure"

const it = testEffect(
  Layer.mergeAll(
    LayerNode.compile(Skill.node, [
      [
        Config.node,
        Layer.mock(Config.Service, {
          get: () => Effect.succeed({}),
          getGlobal: () => Effect.die(new Error(failure)),
          textDirectories: () => Effect.succeed([]),
        }),
      ],
    ]),
    LayerNode.compile(CrossSpawnSpawner.node),
    testInstanceStoreLayer,
  ),
)

const WARNING = "Claude Code skills stay off"

const withLog = <A, E, R>(messages: string[], effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provide(
      Logger.layer([
        Logger.make<unknown, void>((options) => {
          messages.push(JSON.stringify(options.message))
        }),
      ]),
    ),
  )

describe("U-11b a broken global config is warned about once per cause", () => {
  it.live("two requests with an unchanged broken config log one warning; a changed cause logs again", () => {
    const messages: string[] = []
    failure = "first synthetic failure"
    return withLog(
      messages,
      provideTmpdirInstance(
        () =>
          Effect.gen(function* () {
            const skill = yield* Skill.Service
            yield* skill.all()
            yield* skill.all()
            yield* skill.get("customize-swarm")
            expect(messages.filter((line) => line.includes(WARNING))).toHaveLength(1)

            failure = "second synthetic failure"
            yield* skill.all()
            yield* skill.all()
            expect(messages.filter((line) => line.includes(WARNING))).toHaveLength(2)
          }),
        { git: true },
      ),
    )
  })
})
