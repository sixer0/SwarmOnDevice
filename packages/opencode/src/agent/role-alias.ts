/**
 * Role names that workflow texts written for other tools use (`Agent(subagent_type="task-architect")` and the like),
 * mapped onto Swarm's shipped agents (spec 161 §13.3, D13, D14).
 *
 * This file holds names and fixed text only: no permission, model or prompt of its own. An alias runs as its target,
 * with exactly the target's rules and tier, so an alias can never reach further than its target (SA-18). The register is
 * shipped and fixed; whoever wants a different target defines a real agent of that name, which always wins.
 */

/** Requested role name (lower case) to the Swarm agent it runs as. */
export const ROLE_ALIASES: Readonly<Record<string, string>> = {
  "request-translator": "planner",
  "task-architect": "planner",
  "data-analyst": "planner",
  "document-analyst": "planner",
  "pm-analyst": "planner",
  "pm-planner": "planner",
  "image-prompt-specialist": "planner",
  explore: "explore",
  "data-collector": "data-collector",
  "document-reader": "data-collector",
  "image-analyst": "data-collector",
  "coder-execution": "coder",
  "database-specialist": "coder",
  "git-specialist": "coder",
  "docker-specialist": "coder",
  "design-system-specialist": "coder",
  "document-writer": "document-writer",
  "pm-writer": "document-writer",
  "document-converter": "document-writer",
  "document-translator": "document-writer",
  verifier: "verifier",
  "senior-code-reviewer": "verifier",
  "security-review": "verifier",
  "pm-verifier": "verifier",
  "document-reviewer": "verifier",
  "test-expert": "verifier",
  "vendor-crawler-specialist": "researcher",
  "image-specialist": "general",
  "general-purpose": "general",
}

/** The fixed role line put in front of the child's prompt, per requested role name. A name without a line gets no
 *  prefix (an exact or case-only match of the agent itself, and `general-purpose`). Each line is at most 160 bytes. */
export const ROLE_LINES: Readonly<Record<string, string>> = {
  "request-translator": "Restate the request: intent, scope, constraints and open questions. No plan, no code.",
  "task-architect": "Turn the request into a blueprint table: rows, owner, dependency and the check per row. No code.",
  "data-analyst": "Analyse the collected findings and recommend; give the evidence for every claim.",
  "document-analyst": "Analyse the collected findings and recommend; give the evidence for every claim.",
  "pm-analyst": "Write the project-management analysis or plan as a Markdown document.",
  "pm-planner": "Write the project-management analysis or plan as a Markdown document.",
  "image-prompt-specialist": "Write image-generation prompts as text; do not generate images.",
  "document-reader": "Read and extract from the given files or images; give the source path for every fact.",
  "image-analyst": "Read and extract from the given files or images; give the source path for every fact.",
  "coder-execution": "Implement the specified row and run its checks.",
  "database-specialist": "Schema, migration or query work; run the project's checks.",
  "git-specialist": "Git operations as asked; never push or force anything without the person's approval.",
  "docker-specialist": "Container and compose work; report the commands run and their output.",
  "design-system-specialist": "Design tokens and UI components in code.",
  "pm-writer": "Produce, convert or translate the document in the house style.",
  "document-converter": "Produce, convert or translate the document in the house style.",
  "document-translator": "Produce, convert or translate the document in the house style.",
  "senior-code-reviewer": "Review against the criteria; give a pass or fail verdict with evidence; make no edits.",
  "security-review": "Review against the criteria; give a pass or fail verdict with evidence; make no edits.",
  "pm-verifier": "Review against the criteria; give a pass or fail verdict with evidence; make no edits.",
  "document-reviewer": "Review against the criteria; give a pass or fail verdict with evidence; make no edits.",
  "test-expert": "Run the tests and report. If tests must be written, say so: the controller sends that to coder.",
  "vendor-crawler-specialist": "Collect public vendor information; cite every URL.",
  "image-specialist": "Image generation or editing; there is no dedicated agent for it.",
}

/** Targets that only work with an MCP server connected, and the server they need (spec 161 F3, D7). Without it the
 *  alias runs as `general`. */
export const ALIAS_TARGET_MCP: Readonly<Record<string, string>> = {
  researcher: "swarm-web",
}

/** The agent an alias runs as when its target needs a server that is not connected. */
export const ALIAS_TARGET_FALLBACK = "general"

/** The agent an unknown name runs as (spec 161 D13 step 3). */
export const UNKNOWN_ROLE_AGENT = "general"

/** The requested name as it may be echoed into a prompt or a note, or nothing (S163-04, §13.6.4). */
export function echoName(raw: string) {
  const name = raw.trim()
  return /^[a-z0-9-]{1,40}$/i.test(name) ? name : undefined
}

type Found = { name: string; mode: string } | undefined

export type Resolution =
  /** The name is a registered agent: it runs as itself, with no prefix. */
  | { type: "exact"; name: string }
  /** The name is an alias: it runs as `name`; `role` is the fixed line, when the alias has one. */
  | { type: "alias"; name: string; role?: string }
  /** Unknown name: it runs as general, and the result carries a note. */
  | { type: "fallback"; name: string }
  /** An alias whose target the person disabled or that is missing: an error, never another agent (S163-07). */
  | { type: "unavailable"; target: string }
  /** Unknown name while general itself is gone. */
  | { type: "unknown" }

/** Resolves a requested `subagent_type` (spec 161 D13). `get` is the agent registry's lookup and `connected` lists the
 *  connected MCP servers. An exact registered name always wins, user agents included. */
export function resolveRole(raw: string, get: (name: string) => Found, connected: readonly string[]): Resolution {
  if (get(raw)) return { type: "exact", name: raw }
  const key = raw.trim().toLowerCase()
  const target = ROLE_ALIASES[key]
  if (target === undefined) {
    const same = get(key)
    if (same) return { type: "exact", name: same.name }
    return get(UNKNOWN_ROLE_AGENT) ? { type: "fallback", name: UNKNOWN_ROLE_AGENT } : { type: "unknown" }
  }
  const server = ALIAS_TARGET_MCP[target]
  const effective = server !== undefined && !connected.includes(server) ? ALIAS_TARGET_FALLBACK : target
  const found = get(effective)
  if (!found || found.mode === "primary") return { type: "unavailable", target: effective }
  return { type: "alias", name: found.name, role: ROLE_LINES[key] }
}

/** The text put in front of the child's prompt when an alias with a role line or the fallback was used (D13 step 6).
 *  Only a safe requested name is echoed. */
export function rolePrefix(raw: string, agent: string, role: string) {
  return `<requested_role name="${echoName(raw) ?? "unnamed"}" agent="${agent}">\n${role}\n</requested_role>\n\n`
}

/** The note an unknown name's result carries (D13 step 3). */
export function fallbackNote(raw: string, agent: string) {
  const name = echoName(raw)
  return name === undefined
    ? `No agent matches the requested name; ran as ${agent}.`
    : `No agent named "${name}"; ran as ${agent}.`
}

/** The fixed line for the fallback prefix. */
export const FALLBACK_ROLE_LINE = "No dedicated agent matches this role. Work on the task below as a general agent."

export * as RoleAlias from "./role-alias"
