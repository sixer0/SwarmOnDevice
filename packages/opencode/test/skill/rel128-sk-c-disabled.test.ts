// Swarm 1.2.8 row 40b, AC-SKc (N8-350, spec 01b section 4): the person turns skills off through the GLOBAL config key
// `skills.disabled` (N8-038). A disabled skill leaves the agent-facing list, `get`/`require` and the slash-command list;
// `all()` (and so `GET /skill`) still returns it with `disabled: true` (N8-039). The same key in a project config has no
// effect. `obsidian-memory` is required (REQUIRED_SKILL_NAMES, N8-396): naming it in the list changes nothing, and it is
// returned with `required: true`, `disabled: false` (N8-397).
// The global config folder is a per-test temporary folder; nothing here reads the real home or ~/.config/swarm.
import { describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Global } from "@opencode-ai/core/global"
import { Effect, Exit, Layer } from "effect"
import path from "path"
import { Skill } from "../../src/skill"
import { Command } from "../../src/command"
import { Config } from "../../src/config/config"
import { provideTmpdirInstance, testInstanceStoreLayer, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  Layer.mergeAll(
    LayerNode.compile(LayerNode.group([Command.node, Skill.node, Config.node])),
    LayerNode.compile(CrossSpawnSpawner.node),
    testInstanceStoreLayer,
  ),
)

const OFF = "synthetic-off"
const ON = "synthetic-on"
const REQUIRED = "obsidian-memory"

const withGlobalConfig = <A, E, R>(content: unknown, self: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const config = yield* Config.Service
    const dir = yield* tmpdirScoped()
    if (content !== undefined)
      yield* Effect.promise(() => Bun.write(path.join(dir, "swarm.json"), JSON.stringify(content)))
    return yield* Effect.acquireUseRelease(
      Effect.gen(function* () {
        const previous = Global.Path.config
        ;(Global.Path as { config: string }).config = dir
        yield* config.invalidate()
        return previous
      }),
      () => self,
      (previous) =>
        Effect.gen(function* () {
          ;(Global.Path as { config: string }).config = previous
          yield* config.invalidate()
        }),
    )
  })

const writeSkills = (dir: string, names: string[]) =>
  Effect.promise(() =>
    Promise.all(
      names.map((name) =>
        Bun.write(
          path.join(dir, ".swarm", "skills", name, "SKILL.md"),
          `---\nname: ${name}\ndescription: Synthetic skill ${name}.\n---\n\n# Body\n`,
        ),
      ),
    ),
  )

const view = (name: string) =>
  Effect.gen(function* () {
    const skill = yield* Skill.Service
    const command = yield* Command.Service
    const all = (yield* skill.all()).find((item) => item.name === name) as
      | (Skill.Info & { disabled?: boolean; required?: boolean })
      | undefined
    return {
      available: (yield* skill.available()).some((item) => item.name === name),
      got: yield* skill.get(name),
      required: yield* Effect.exit(skill.require(name)),
      all,
      command: (yield* command.list()).some((item) => item.name === name && item.source === "skill"),
    }
  })

describe("AC-SKc skills.disabled", () => {
  it.live("a globally disabled skill leaves available(), get, require and the command list; all() marks it", () =>
    withGlobalConfig(
      { skills: { disabled: [OFF] } },
      provideTmpdirInstance(
        (dir) =>
          Effect.gen(function* () {
            yield* writeSkills(dir, [OFF, ON])
            const off = yield* view(OFF)
            expect(off.available).toBe(false)
            expect(off.got).toBeUndefined()
            expect(Exit.isFailure(off.required)).toBe(true)
            expect(String(Exit.isFailure(off.required) ? off.required.cause : "")).toContain(
              "turned off by the person in Settings > Skills",
            )
            expect(off.command).toBe(false)
            expect(off.all?.disabled).toBe(true)

            const on = yield* view(ON)
            expect(on.available).toBe(true)
            expect(on.got?.name).toBe(ON)
            expect(Exit.isSuccess(on.required)).toBe(true)
            expect(on.command).toBe(true)
            expect(on.all?.disabled).not.toBe(true)
          }),
        { git: true },
      ),
    ),
  )

  it.live("a built-in can be turned off too", () =>
    withGlobalConfig(
      { skills: { disabled: ["tool-health"] } },
      provideTmpdirInstance(
        () =>
          Effect.gen(function* () {
            const off = yield* view("tool-health")
            expect(off.available).toBe(false)
            expect(off.command).toBe(false)
            expect(off.all?.disabled).toBe(true)
            expect(off.all?.location).toBe("<built-in>")
          }),
        { git: true },
      ),
    ),
  )

  it.live("the key in a project config has no effect", () =>
    withGlobalConfig(
      undefined,
      provideTmpdirInstance(
        (dir) =>
          Effect.gen(function* () {
            yield* writeSkills(dir, [OFF])
            const off = yield* view(OFF)
            expect(off.available).toBe(true)
            expect(off.got?.name).toBe(OFF)
            expect(off.command).toBe(true)
            expect(off.all?.disabled).not.toBe(true)
          }),
        { git: true, config: { skills: { disabled: [OFF] } } as never },
      ),
    ),
  )

  it.live("obsidian-memory is required: listing it in skills.disabled changes nothing", () =>
    withGlobalConfig(
      { skills: { disabled: [REQUIRED] } },
      provideTmpdirInstance(
        (dir) =>
          Effect.gen(function* () {
            expect(Skill.REQUIRED_SKILL_NAMES.has(REQUIRED)).toBe(true)
            yield* writeSkills(dir, [REQUIRED])
            const req = yield* view(REQUIRED)
            expect(req.available).toBe(true)
            expect(req.got?.name).toBe(REQUIRED)
            expect(Exit.isSuccess(req.required)).toBe(true)
            expect(req.command).toBe(true)
            expect(req.all?.required).toBe(true)
            expect(req.all?.disabled).toBe(false)
          }),
        { git: true },
      ),
    ),
  )

  it.live("obsidian-memory is reported as required with no disabled list at all", () =>
    withGlobalConfig(
      undefined,
      provideTmpdirInstance(
        (dir) =>
          Effect.gen(function* () {
            yield* writeSkills(dir, [REQUIRED])
            const req = yield* view(REQUIRED)
            expect(req.all?.required).toBe(true)
            expect(req.all?.disabled).toBe(false)
          }),
        { git: true },
      ),
    ),
  )
})
