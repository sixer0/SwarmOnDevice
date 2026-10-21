import { describe, expect, test } from "bun:test"
import { Persist } from "@/utils/persist"

// Safety property behind row 173's layer choice: `pathKey` mints persisted localStorage storage names
// (utils/persist.ts:367,384-385) and rows 173/173b only add canonical COMPARISONS, so these names must
// stay byte-identical. This suite pins the exact names the production minting path produces for the two
// macOS spellings and for ordinary paths. It passes before AND after the 173b edits — that equality is
// the proof; if any edit folded key minting, the pinned values here would change and this file goes red.
// The path inputs are synthetic but shape-identical to the row-161 experiment pair.
const SHORT = "/var/folders/sy/nt4h2c8t/kilo/r173b/home/.cache"
const RESOLVED = `/private${SHORT}`
const HOME = "/Users/dev/repo"
const WINDOWS = "C:\\Users\\dev\\repo"

describe("persisted storage names are stable across the 173b comparison edits", () => {
  test("workspace storage name for the short /var spelling is unchanged", () => {
    expect(Persist.workspace(SHORT, "layout").storage).toBe("opencode.workspace.-var-folders.1bwh8ix.dat")
  })

  test("workspace storage name for the resolved /private/var spelling is its OWN name, not the short one", () => {
    // This is the orphan risk in one line: the two spellings mint two different storage names today,
    // which is exactly why folding happened in canonicalPathKey and NOT inside pathKey.
    const resolved = Persist.workspace(RESOLVED, "layout")
    const short = Persist.workspace(SHORT, "layout")
    expect(resolved.storage).not.toBe(short.storage)
    expect(resolved.storage).toBe("opencode.workspace.-private-var.c8poxt.dat")
  })

  test("workspace, session and scoped targets agree on one name per spelling", () => {
    const workspace = Persist.workspace(HOME, "layout")
    const scoped = Persist.scoped(HOME, undefined, "layout")
    const session = Persist.session(HOME, "ses_1", "layout")
    expect(scoped.storage).toBe(workspace.storage)
    expect(session.storage).toBe(workspace.storage)
    expect(workspace.storage).toBe("opencode.workspace.-Users-dev-r.3v1iaf.dat")
  })

  test("an already-normalised POSIX path mints no legacy candidates (pathKey is the identity on it)", () => {
    // legacyWorkspaceStorage (persist.ts:366-381) only adds a candidate when workspaceStorage(dir)
    // differs from workspaceStorage(pathKey(dir)); pinning the absence proves that comparison
    // still runs through unfolded pathKey rather than a folded key.
    expect(Persist.workspace(SHORT, "layout").legacyStorageNames).toBeUndefined()
  })

  test("Windows spellings keep their drive-root normalisation and backslash legacy name", () => {
    const target = Persist.workspace(WINDOWS, "layout")
    expect(target.storage).toBe("opencode.workspace.C--Users-dev.6mfs2g.dat")
    expect(target.legacyStorageNames).toEqual(["opencode.workspace.C--Users-dev.1wqs8dd.dat"])
  })
})
