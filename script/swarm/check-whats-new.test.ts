/**
 * Release guard WHATS-NEW (owner standard 2026-11-18): the built-in swarm-whats-new skill must carry the brief of the
 * release being built. The last test runs the guard on this repository, so a full test run before a release fails
 * when the brief was forgotten, as it was in 1.3.3 before this change.
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { checkWhatsNew } from "./check-whats-new"

const ROOT = path.resolve(import.meta.dir, "..", "..")
const body = "- A real line about what an agent can do in this release, long enough to count as a brief.\n".repeat(6)
const skill = (version: string, extra = "") =>
  `# Swarm whats-new: agent briefs 1.2.0 to ${version}\n\nIntro.\n\n## ${version} (this build)\n${body}${extra}\n## 1.3.1\nOld.\n`
const changelog = (version: string) => `# Changelog\n\n## ${version} (2026-11-18)\n\nNotes.\n`

describe("check-whats-new", () => {
  test("passes when title, marker, first heading, section and changelog all name the release", () => {
    expect(checkWhatsNew({ version: "1.3.4", skill: skill("1.3.4"), changelog: changelog("1.3.4") })).toEqual([])
  })

  test("fails the 1.3.3 case: brief stops at an older version", () => {
    const stale = skill("1.3.1").replace("\n## 1.3.1\nOld.\n", "")
    const problems = checkWhatsNew({ version: "1.3.3", skill: stale, changelog: changelog("1.3.3") })
    expect(problems.some((p) => p.includes('title must end with "to 1.3.3"'))).toBe(true)
    expect(problems.some((p) => p.includes('missing heading "## 1.3.3 (this build)"'))).toBe(true)
  })

  test("fails on two markers, a placeholder section and a missing changelog heading", () => {
    const twice = skill("1.3.4").replace("## 1.3.1\n", "## 1.3.1 (this build)\n")
    expect(checkWhatsNew({ version: "1.3.4", skill: twice, changelog: changelog("1.3.4") }).join("\n")).toContain(
      'exactly one "(this build)" marker, found 2',
    )
    const thin = "# Swarm whats-new: agent briefs 1.2.0 to 1.3.4\n\n## 1.3.4 (this build)\nTBD.\n"
    expect(checkWhatsNew({ version: "1.3.4", skill: thin, changelog: changelog("1.3.4") }).join("\n")).toContain(
      "the 1.3.4 section is",
    )
    expect(checkWhatsNew({ version: "1.3.4", skill: skill("1.3.4"), changelog: changelog("1.3.3") })).toEqual([
      'CHANGELOG.md has no "## 1.3.4" heading',
    ])
  })

  test("fails on call-shaped text and on an oversized file", () => {
    const shaped = skill("1.3.4", "- Call datum-studio_studio_render {documentId} to render.\n")
    expect(checkWhatsNew({ version: "1.3.4", skill: shaped, changelog: changelog("1.3.4") }).join("\n")).toContain(
      "call-shaped text",
    )
    const big = skill("1.3.4", "x".repeat(17_000))
    expect(checkWhatsNew({ version: "1.3.4", skill: big, changelog: changelog("1.3.4") }).join("\n")).toContain(
      "at most 16384",
    )
  })

  test("this repository: the bundled brief covers the release in packages/desktop/package.json", () => {
    const version = String(JSON.parse(readFileSync(path.join(ROOT, "packages", "desktop", "package.json"), "utf8")).version)
    const problems = checkWhatsNew({
      version,
      skill: readFileSync(path.join(ROOT, "packages", "opencode", "src", "skill", "swarm-whats-new.md"), "utf8"),
      changelog: readFileSync(path.join(ROOT, "CHANGELOG.md"), "utf8"),
    })
    expect(problems).toEqual([])
  })
})
