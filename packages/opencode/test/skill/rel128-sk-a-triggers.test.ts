// Swarm 1.2.8 row 40, AC-SKa (N8-349, spec 01b section 3): a SKILL.md may carry a `triggers:` map of keywords, file
// globs and mission types. Valid maps are normalised onto Skill.Info; a map over TRIGGER_LIMITS or with an unknown key
// is ignored, the skill still loads, and one SKILL_TRIGGERS_INVALID warning is logged per path and reason.
// Also RA-17: Skill.folders() is exported as the contract for the skill-folder guard (row 40e).
// HOME is the test preload's temporary home (OPENCODE_TEST_HOME); nothing here reads the real home.
import { describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Effect, Layer, Logger } from "effect"
import path from "path"
import { Skill } from "../../src/skill"
import { provideTmpdirInstance, testInstanceStoreLayer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  Layer.mergeAll(LayerNode.compile(Skill.node), LayerNode.compile(CrossSpawnSpawner.node), testInstanceStoreLayer),
)

const writeSkill = (dir: string, name: string, frontmatter: string) =>
  Effect.promise(() =>
    Bun.write(
      path.join(dir, ".swarm", "skills", name, "SKILL.md"),
      `---\nname: ${name}\ndescription: Synthetic skill ${name}.\n${frontmatter}---\n\n# Body\n`,
    ),
  )

const getSkill = (name: string) =>
  Effect.gen(function* () {
    const skill = yield* Skill.Service
    return (yield* skill.get(name)) as (Skill.Info & { triggers?: unknown }) | undefined
  })

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

describe("AC-SKa SKILL.md triggers", () => {
  it.live("valid triggers are parsed, trimmed, lower-cased and de-duplicated", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* writeSkill(
            dir,
            "invoice-check",
            [
              "triggers:",
              '  keywords: ["  Invoice ", invoice, Faktur, "Purchase Order"]',
              '  files: ["**/*.invoice.pdf", " Invoices/** ", "**/*.invoice.pdf"]',
              "  missionTypes: [Document, research, RESEARCH]",
              "",
            ].join("\n"),
          )
          const info = yield* getSkill("invoice-check")
          expect(info?.triggers).toEqual({
            keywords: ["invoice", "faktur", "purchase order"],
            files: ["**/*.invoice.pdf", "Invoices/**"],
            missionTypes: ["document", "research"],
          })
        }),
      { git: true },
    ),
  )

  it.live("a map with one list gets the other two as empty lists; a skill without triggers has none", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* writeSkill(dir, "keywords-only", "triggers:\n  keywords: [ledger]\n")
          yield* writeSkill(dir, "no-triggers", "")
          expect((yield* getSkill("keywords-only"))?.triggers).toEqual({
            keywords: ["ledger"],
            files: [],
            missionTypes: [],
          })
          const plain = yield* getSkill("no-triggers")
          expect(plain).toBeDefined()
          expect(plain?.triggers).toBeUndefined()
        }),
      { git: true },
    ),
  )

  it.live("11 keywords, a 41-char keyword or an unknown key: the skill loads without triggers, one warning each across two rescans", () => {
    const messages: string[] = []
    return withLog(
      messages,
      provideTmpdirInstance(
        (dir) =>
          Effect.gen(function* () {
            const eleven = Array.from({ length: 11 }, (_, i) => `word${i}`).join(", ")
            yield* writeSkill(dir, "too-many", `triggers:\n  keywords: [${eleven}]\n`)
            yield* writeSkill(dir, "too-long", `triggers:\n  keywords: [${"k".repeat(41)}]\n`)
            yield* writeSkill(dir, "odd-key", "triggers:\n  keywords: [fine]\n  agents: [build]\n")

            for (const name of ["too-many", "too-long", "odd-key"]) {
              const info = yield* getSkill(name)
              expect(info?.name).toBe(name)
              expect(info?.triggers).toBeUndefined()
            }

            // A second rescan that really rebuilds the set (a new skill changes the key) does not warn again.
            yield* writeSkill(dir, "another", "")
            expect((yield* getSkill("another"))?.name).toBe("another")
            yield* getSkill("too-many")

            const warnings = messages.filter((line) => line.includes("SKILL_TRIGGERS_INVALID"))
            for (const name of ["too-many", "too-long", "odd-key"]) {
              expect(warnings.filter((line) => line.includes(`${name}/SKILL.md`))).toHaveLength(1)
            }
            expect(warnings).toHaveLength(3)
          }),
        { git: true },
      ),
    )
  })

  it.live("ten keywords of at most 40 characters are within the limits", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const nine = Array.from({ length: 9 }, (_, i) => `word${i}`).join(", ")
          yield* writeSkill(dir, "ten-words", `triggers:\n  keywords: [${nine}, ${"k".repeat(40)}]\n`)
          expect(((yield* getSkill("ten-words"))?.triggers as { keywords: string[] } | undefined)?.keywords).toHaveLength(10)
        }),
      { git: true },
    ),
  )

  it.live("a keyword list that is not a list of strings invalidates the map", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* writeSkill(dir, "scalar", "triggers:\n  keywords: invoice\n")
          yield* writeSkill(dir, "numbers", "triggers:\n  missionTypes: [2024]\n")
          yield* writeSkill(dir, "blank", 'triggers:\n  files: ["  "]\n')
          for (const name of ["scalar", "numbers", "blank"]) {
            const info = yield* getSkill(name)
            expect(info?.name).toBe(name)
            expect(info?.triggers).toBeUndefined()
          }
        }),
      { git: true },
    ),
  )
})

describe("RA-17 Skill.folders() is the skill-folder contract for row 40e", () => {
  it.live("lists config skill folders, .agents/skills, discovered folders and both drafts roots", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* writeSkill(dir, "listed-skill", "")
          const skill = yield* Skill.Service
          const folders = yield* skill.folders()
          const has = (target: string) => expect(folders).toContain(path.resolve(target))
          has(path.join(dir, ".swarm", "skills"))
          has(path.join(dir, ".swarm", "skill"))
          has(path.join(dir, ".swarm", "skills", "listed-skill"))
          has(path.join(dir, ".agents", "skills"))
          has(path.join(dir, ".swarm", "skill-drafts"))
          has(path.join(process.env.OPENCODE_TEST_HOME!, ".agents", "skills"))
          expect(folders.some((item) => item.endsWith(path.join("", "skill-drafts")) && !item.startsWith(dir))).toBe(true)
          expect(folders.every((item) => path.isAbsolute(item))).toBe(true)
          // .claude is left out while claude_compat is off, as discovery does.
          expect(folders).not.toContain(path.resolve(path.join(dir, ".claude", "skills")))
        }),
      { git: true },
    ),
  )
})
