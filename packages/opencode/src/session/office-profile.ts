/** SD-1, the Office prompt profile (office add-in spec SD §10.3, REG §7.8, decisions C9, C11, C13).
 *
 *  A session the Office bridge creates carries `metadata["swarm.origin"] === "office-addin"`. Document text can ask the
 *  model to repeat its system prompt, so such a session gets a stripped prefix: no agent routing or auto workflow, no
 *  `<gsp_workflow>`, no global or project instruction files, no memory, no MCP or skill lists and no environment block
 *  with paths, only one date line (C11 OQ-6). The producers of the stripped blocks are not called at all.
 *
 *  The literals equal the bridge's metadata values (REG §7.1); `packages/opencode` does not import
 *  `@swarm/office-addin` (AGENTS.md dependency direction), and a test pins the two equal. */

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

export * as OfficeProfile from "./office-profile"
