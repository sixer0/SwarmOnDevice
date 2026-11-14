export * as ConfigSkillsV1 from "./skills"

import { Schema } from "effect"

export const Info = Schema.Struct({
  paths: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "Additional paths to skill folders",
  }),
  urls: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "URLs to fetch skills from (e.g., https://example.com/.well-known/skills/)",
  }),
  // N8-038 (SK-c): read from the GLOBAL config only; a project config that names it has no effect.
  disabled: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "Names of skills the person turned off (global config only); required skills ignore it",
  }),
})
export type Info = Schema.Schema.Type<typeof Info>
