import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import path from "node:path"

// N9-102 (1.2.9 A03). One describe block per AC line (AC-A03.60, .61, .62, .63a, .63b, .63c, .64); each block carries
// its row's regenerated name list inline. Rows 61-63c add their block under lock export-guard (N9-272), row 64 adds
// the guard script (N9-084) and its shrink-only baseline (N9-085). Run from this folder: `bun test ./rel129-a03-export-guard.test.ts`.

const repo = path.resolve(import.meta.dir, "../..")
const self = path.relative(repo, import.meta.path)

/** Lines of `git grep -n -w <name>` over tracked files, this test file excluded (it names the words it looks for). */
function trackedWordHits(name: string): string[] {
  const out = spawnSync("git", ["grep", "-n", "-w", "-e", name, "--", ".", `:(exclude)${self}`], {
    cwd: repo,
    encoding: "utf8",
  })
  // git grep: 0 = matches, 1 = no match, anything else is an error the test must not read as "no match".
  if (out.status !== 0 && out.status !== 1) throw new Error(`git grep failed (${out.status}): ${out.stderr}`)
  return out.stdout.split("\n").filter(Boolean)
}

describe("AC-A03.60", () => {
  // N9-073: exports with no reader anywhere (01b an3: own 0, outProd 0, outTest 0, textOut 0). Removed, not wired:
  // no reader exists and none is in scope (01a AT-A03.60).
  const dead = [
    ["INDEX_ROLLUP_PERIOD", "packages/opencode/src/memory/memory.ts"],
    ["IndexLimits", "packages/schema/src/project-memory.ts"],
    ["existingDefaultProjectDir", "packages/desktop/src/main/onboarding-test-root.ts"],
  ] as const

  for (const [name, file] of dead) {
    test(`${name} (${file}) is gone from every tracked file`, () => {
      expect(trackedWordHits(name)).toEqual([])
    })
  }

  test("INDEX_LIMITS, the value IndexLimits aliased, stays", () => {
    expect(trackedWordHits("INDEX_LIMITS").length).toBeGreaterThan(1)
  })
})
