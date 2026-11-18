#!/usr/bin/env bun
/**
 * check-whats-new.ts — release guard WHATS-NEW (owner standard 2026-11-18).
 *
 * Every Swarm release ships the agent-facing brief of its own version in the built-in skill `swarm-whats-new`, not
 * only a CHANGELOG entry. CHANGELOG.md is not bundled in the app and is written for the owner; the skill is what an
 * agent can read. Release 1.3.3 shipped with a brief that stopped at 1.3.1, so the agent could not learn its own update.
 *
 * Checks, for the release version in `packages/desktop/package.json`:
 *   1. the skill title (line 1) ends with "to <version>";
 *   2. exactly one "(this build)" marker, on the heading "## <version> (this build)";
 *   3. that heading is the first version heading (newest first);
 *   4. the section is at least MIN_SECTION_BYTES long (a real brief, not a placeholder);
 *   5. no call-shaped text `name {` (a tool name followed by a JSON object): models copy it as a text-form tool call;
 *   6. the file is at most MAX_BYTES (runtime skill cap is 64 KiB; this keeps the on-demand brief small);
 *   7. CHANGELOG.md has a "## <version>" heading, so the two never drift apart in the other direction.
 *
 * Usage: `bun script/swarm/check-whats-new.ts [--root <repo>]`. Exit 0 = pass, 1 = a check failed, 2 = a file is
 * missing. Output: one line per failed check, then "WHATS-NEW PASS <version>" or "WHATS-NEW FAIL <version> (<n>)".
 * Deterministic: no clock, no network.
 */
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"

const MIN_SECTION_BYTES = 400
const MAX_BYTES = 16_384
const SKILL = path.join("packages", "opencode", "src", "skill", "swarm-whats-new.md")
const CHANGELOG = "CHANGELOG.md"
const PACKAGE = path.join("packages", "desktop", "package.json")

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** @internal test seam */
export function checkWhatsNew(input: { version: string; skill: string; changelog: string }): string[] {
  const { version, skill, changelog } = input
  const v = escape(version)
  const problems: string[] = []
  const title = skill.split("\n")[0] ?? ""
  if (!new RegExp(`to ${v}$`).test(title.trim()))
    problems.push(`title must end with "to ${version}" (found: ${JSON.stringify(title.slice(0, 80))})`)
  const markers = skill.match(/\(this build\)/g)?.length ?? 0
  const heading = `\n## ${version} (this build)\n`
  if (markers !== 1) problems.push(`expected exactly one "(this build)" marker, found ${markers}`)
  const at = skill.indexOf(heading)
  if (at < 0) problems.push(`missing heading "## ${version} (this build)"`)
  const first = skill.search(/\n## \d+\.\d+\.\d+/)
  if (at >= 0 && first !== at) problems.push(`"## ${version} (this build)" must be the first version heading`)
  if (at >= 0) {
    const rest = skill.slice(at + heading.length)
    const next = rest.search(/\n## /)
    const section = next < 0 ? rest : rest.slice(0, next)
    const bytes = Buffer.byteLength(section, "utf8")
    if (bytes < MIN_SECTION_BYTES) problems.push(`the ${version} section is ${bytes} bytes, expected at least ${MIN_SECTION_BYTES}`)
  }
  const callShaped = skill.match(/\b[a-z][a-z0-9-]*_[a-z0-9_]+ \{/g) ?? []
  if (callShaped.length) problems.push(`call-shaped text (tool name followed by {): ${[...new Set(callShaped)].join(", ")}`)
  const size = Buffer.byteLength(skill, "utf8")
  if (size > MAX_BYTES) problems.push(`file is ${size} bytes, at most ${MAX_BYTES}: compress the oldest sections`)
  if (!new RegExp(`^## ${v}\\b`, "m").test(changelog)) problems.push(`CHANGELOG.md has no "## ${version}" heading`)
  return problems
}

if (import.meta.main) {
  const flag = process.argv.indexOf("--root")
  const root = flag > 0 ? path.resolve(process.argv[flag + 1] ?? ".") : path.resolve(import.meta.dir, "..", "..")
  for (const file of [SKILL, CHANGELOG, PACKAGE])
    if (!existsSync(path.join(root, file))) {
      console.log(`WHATS-NEW missing file ${file}`)
      process.exit(2)
    }
  const version = String(JSON.parse(readFileSync(path.join(root, PACKAGE), "utf8")).version ?? "")
  const problems = checkWhatsNew({
    version,
    skill: readFileSync(path.join(root, SKILL), "utf8"),
    changelog: readFileSync(path.join(root, CHANGELOG), "utf8"),
  })
  for (const problem of problems) console.log(`WHATS-NEW ${problem}`)
  console.log(problems.length ? `WHATS-NEW FAIL ${version} (${problems.length})` : `WHATS-NEW PASS ${version}`)
  process.exit(problems.length ? 1 : 0)
}
