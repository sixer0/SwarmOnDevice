/** SD-1, the Office prompt profile (office add-in spec SD §10.3, REG §7.8, decisions C9, C11, C13).
 *
 *  A session the Office bridge creates carries `metadata["swarm.origin"] === "office-addin"`. Document text can ask the
 *  model to repeat its system prompt, so such a session gets a stripped prefix: no agent routing or auto workflow, no
 *  `<gsp_workflow>`, no global or project instruction files, no memory, no MCP or skill lists and no environment block
 *  with paths, only one date line (C11 OQ-6). The producers of the stripped blocks are not called at all.
 *
 *  The literals equal the bridge's metadata values (REG §7.1); `packages/opencode` does not import
 *  `@swarm/office-addin` (AGENTS.md dependency direction), and a test pins the two equal. */

import PROMPT_COMPACTION from "../agent/prompt/compaction.txt"
import PROMPT_TITLE from "../agent/prompt/title.txt"

export const OFFICE_ORIGIN_METADATA_KEY = "swarm.origin"
export const OFFICE_ORIGIN_VALUE = "office-addin"

/** True for a session the Office bridge created. Anyone can set the value on their own session; the only effect is a
 *  smaller prompt, so nothing is gained by it (SD §10.3 item 6). */
export function isOfficeSession(session: { readonly metadata?: Readonly<Record<string, unknown>> }) {
  return session.metadata?.[OFFICE_ORIGIN_METADATA_KEY] === OFFICE_ORIGIN_VALUE
}

/** The one line an Office session keeps from the environment block: the same text as `system.ts`'s `<env>` date line,
 *  with no user name, path, platform or host. */
export function dateLine() {
  return `Today's date: ${new Date().toDateString()}`
}

/** The frozen system prefix parts for an Office session, in the order `prompt.ts` destructures them:
 *  skills, env, instructions, remembered, mcpInstructions, delegation. */
export function prefix() {
  return [undefined, [dateLine()], [] as string[], undefined, undefined, [] as string[]] as const
}

/** The prompts the hidden agents ship with (`agent/agent.ts`), which an Office session's compaction and title calls keep
 *  even when the person's config overrides them (M6-01c, C64). */
const SHIPPED_PROMPTS: Readonly<Record<string, string>> = { compaction: PROMPT_COMPACTION, title: PROMPT_TITLE }

/** M6-01b/M6-01c (CP-M6 F-M6-2, C64): the agent an Office session's model call uses, with the shipped prompt instead
 *  of a configured one. For `compaction` and `title` that is their own built-in prompt; every other agent gets none,
 *  so the request takes the built-in provider prompt (`llm/request.ts`), which is what the shipped default agent
 *  `build` gets (no shipped visible primary agent has a prompt of its own). So only a person's config is removed
 *  (`agent.<name>.prompt`, `agent/agent.ts:388`, or a custom `default_agent`). Name, options and permissions stay. */
export function agent<T extends { readonly name: string; readonly prompt?: string }>(info: T): T {
  return { ...info, prompt: SHIPPED_PROMPTS[info.name] }
}

export * as OfficeProfile from "./office-profile"
