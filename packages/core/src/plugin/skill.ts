/// <reference path="../markdown.d.ts" />

export * as SkillPlugin from "./skill"

import { define } from "./internal"
import { Effect } from "effect"
import { AbsolutePath } from "../schema"
import { SkillV2 } from "../skill"
import customizeSwarmContent from "./skill/customize-swarm.md" with { type: "text" }

export const CustomizeSwarmContent = customizeSwarmContent

export const Plugin = define({
  id: "skill",
  effect: Effect.fn(function* (ctx) {
    yield* ctx.skill.transform((draft) => {
      draft.source(
        SkillV2.EmbeddedSource.make({
          type: "embedded",
          skill: SkillV2.Info.make({
            name: "customize-swarm",
            description:
              "Use ONLY when the user is editing or creating Swarm's own configuration: swarm.json, swarm.jsonc, files under .swarm/, or files under ~/.config/swarm/. Also use when creating or fixing Swarm agents, subagents, commands, skills, plugins, MCP servers, or permission rules. Do not use for the user's own application code, or for any project that is not configuring Swarm itself.",
            location: AbsolutePath.make("/builtin/customize-swarm.md"),
            content: CustomizeSwarmContent,
          }),
        }),
      )
    })
  }),
})
