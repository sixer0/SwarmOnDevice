// Swarm 1.2.7 row U11 (item U-11, decisions U6, C63 D-11b/D-11c): the CLI and the desktop see the same skill set.
// - A skill written after the first listing is in the next listing, without a restart (re-scan on each request).
// - A project skill hidden by the trust filter is named in one log line with the reason.
// - customize-swarm tells a session to write new skills to the global folder by default, shared by app and CLI.
import { describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { ProjectTrust } from "@opencode-ai/core/project/trust"
import { SkillPlugin } from "@opencode-ai/core/plugin/skill"
import { Effect, Layer, Logger } from "effect"
import path from "path"
import fs from "fs/promises"
import { Skill } from "../../src/skill"
import { provideTmpdirInstance, testInstanceStoreLayer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  Layer.mergeAll(LayerNode.compile(Skill.node), LayerNode.compile(CrossSpawnSpawner.node), testInstanceStoreLayer),
)

const skillText = (name: string, description: string, body = "# Body") =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`

const writeSkill = (dir: string, name: string, description: string, body?: string) =>
  Effect.promise(() => Bun.write(path.join(dir, ".swarm", "skills", name, "SKILL.md"), skillText(name, description, body)))

const projectSkills = Effect.gen(function* () {
  const skill = yield* Skill.Service
  return (yield* skill.all()).filter((item) => item.location !== "<built-in>")
})

describe("U-11 skills are re-scanned on each request", () => {
  it.live("a skill created after the first list is in the second list", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* writeSkill(dir, "early-skill", "Written before the first list.")
          const first = yield* projectSkills
          expect(first.map((item) => item.name)).toEqual(["early-skill"])

          // A CLI session (another process) writes a new skill while this server keeps running.
          yield* writeSkill(dir, "late-skill", "Written after the first list.")
          const second = yield* projectSkills
          expect(second.map((item) => item.name).toSorted()).toEqual(["early-skill", "late-skill"])

          const skill = yield* Skill.Service
          expect((yield* skill.get("late-skill"))?.description).toBe("Written after the first list.")
          expect(yield* skill.dirs()).toContain(path.join(dir, ".swarm", "skills", "late-skill"))
          expect((yield* skill.available()).some((item) => item.name === "late-skill")).toBe(true)
        }),
      { git: true },
    ),
  )

  it.live("an edited skill shows its new text and a removed skill is gone", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* writeSkill(dir, "edit-skill", "First description.", "# First body")
          yield* writeSkill(dir, "gone-skill", "Removed later.")
          const skill = yield* Skill.Service
          expect((yield* skill.get("edit-skill"))?.description).toBe("First description.")

          yield* writeSkill(dir, "edit-skill", "Second description, a longer one.", "# Second body")
          yield* Effect.promise(() => fs.rm(path.join(dir, ".swarm", "skills", "gone-skill"), { recursive: true }))

          const edited = yield* skill.get("edit-skill")
          expect(edited?.description).toBe("Second description, a longer one.")
          expect(edited?.content).toContain("# Second body")
          expect(yield* skill.get("gone-skill")).toBeUndefined()
        }),
      { git: true },
    ),
  )

  it.live("an unchanged folder returns the same parsed entries (no re-parse)", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* writeSkill(dir, "steady-skill", "Does not change.")
          const skill = yield* Skill.Service
          const a = yield* skill.get("steady-skill")
          const b = yield* skill.get("steady-skill")
          expect(a).toBeDefined()
          expect(b).toBe(a!)
        }),
      { git: true },
    ),
  )
})

describe("U-11 a skill hidden by project trust is logged", () => {
  it.live("an untrusted project's program-running skill is absent and named in one log line with the reason", () =>
    Effect.gen(function* () {
      const messages: string[] = []
      yield* Effect.acquireRelease(
        Effect.sync(() => ProjectTrust.assumeTrustedForTests(false)),
        () => Effect.sync(() => ProjectTrust.assumeTrustedForTests(true)),
      )
      yield* provideTmpdirInstance(
        (dir) =>
          Effect.gen(function* () {
            yield* writeSkill(dir, "runs-programs", "Runs a program in its template.", "Run !`echo hi` first.")
            yield* writeSkill(dir, "plain-text", "Plain text only.")
            const names = (yield* projectSkills).map((item) => item.name)
            expect(names).toEqual(["plain-text"])
            // A second request with nothing changed does not log again.
            yield* projectSkills
          }),
        { git: true },
      ).pipe(
        Effect.provide(
          Logger.layer([
            Logger.make<unknown, void>((options) => {
              messages.push(JSON.stringify(options.message))
            }),
          ]),
        ),
      )
      const hidden = messages.filter((line) => line.includes("project skill hidden"))
      expect(hidden).toHaveLength(1)
      expect(hidden[0]).toContain("runs-programs")
      expect(hidden[0]).toContain("not trusted")
      expect(hidden.join("\n")).not.toContain("echo hi")
    }).pipe(Effect.scoped),
  )
})

describe("U-11 customize-swarm names the default skill folder", () => {
  const text = SkillPlugin.CustomizeSwarmContent
  it.effect("new skills go to the global folder by default, the project only when the skill belongs to the repo", () =>
    Effect.sync(() => {
      expect(text).toContain("write a new skill to `~/.config/swarm/skills/<name>/SKILL.md` by default")
      expect(text).toContain("`.swarm/skills/<name>/SKILL.md` only when the skill belongs to the repository")
      expect(text).toContain("The Swarm app and the `swarm` CLI on one machine read the same `~/.config/swarm/skills` folder")
      expect(text).toContain("tell the person the path you wrote")
    }),
  )
})
