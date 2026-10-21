import { describe, expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import { createServerProjects, visibleRecentlyClosed } from "./server"
import { ServerScope } from "@/utils/server-scope"

// Synthetic paths, shape-identical to the pair used by the row-161 causal experiment
// ($D/verification/s5_promotions/f137_causal_test.md §0): the client stores the short macOS
// spelling emitted by the directory picker, the server reports the realpath'd spelling of the
// SAME directory. Nothing here touches a real filesystem.
const SHORT = "/var/folders/1b/wh8ix/dat/proj"
const RESOLVED = "/private/var/folders/1b/wh8ix/dat/proj"
const OTHER_SHORT = "/var/folders/2c/xy9zq/dat/proj"
const PRIVATE_OTHER = "/private/opt/data"
const OPT = "/opt/data"

function withProjects(run: (projects: ReturnType<typeof createServerProjects>) => void) {
  createRoot((dispose) => {
    const [scope] = createSignal(ServerScope.local)
    const [store, setStore] = createStore({ projects: {}, lastProject: {}, recentlyClosed: {} })
    run(createServerProjects({ scope, store, setStore }))
    dispose()
  })
}

describe("createServerProjects dedup across the two macOS spellings", () => {
  // Symptom 1: reopening a project through the server's spelling leaves the old entry behind, so
  // the same directory shows up once as active and once as recently closed.
  test("reopening through the server spelling drops the client-spelled closed entry", () => {
    withProjects((projects) => {
      projects.open(SHORT)
      projects.close(SHORT)
      expect(projects.recentlyClosed()).toEqual([SHORT])

      projects.open(RESOLVED)

      expect(projects.recentlyClosed()).toEqual([])
      expect(projects.list()).toEqual([{ worktree: RESOLVED, expanded: true }])
    })
  })

  test("reopening in the opposite direction drops the server-spelled closed entry", () => {
    withProjects((projects) => {
      projects.open(RESOLVED)
      projects.close(RESOLVED)
      expect(projects.recentlyClosed()).toEqual([RESOLVED])

      projects.open(SHORT)

      expect(projects.recentlyClosed()).toEqual([])
      expect(projects.list()).toEqual([{ worktree: SHORT, expanded: true }])
    })
  })

  // Symptom 2: two spellings of one directory occupy two slots of the recently-closed history,
  // eating a slot of the 16-entry store and the 5-entry display cap.
  test("closing both spellings records one entry, not two", () => {
    withProjects((projects) => {
      projects.open(SHORT)
      projects.close(SHORT)
      projects.open(RESOLVED)
      projects.close(RESOLVED)

      // Exact array equality plus length: a tail-append that kept both spellings fails here, and so
      // does an implementation that dropped the newest entry instead of the stale one.
      expect(projects.recentlyClosed()).toEqual([RESOLVED])
      expect(projects.recentlyClosed()).toHaveLength(1)
      expect(projects.recentlyClosed()).not.toContain(SHORT)
    })
  })

  // Surviving representative: the entry that stays must be a raw path some caller actually held,
  // never a derived key, because remove/expand/collapse/move and the child-store + localStorage
  // names are all keyed off that exact string.
  test("the surviving entry is the raw spelling most recently supplied", () => {
    withProjects((projects) => {
      projects.open(SHORT)
      projects.close(SHORT)
      projects.open(RESOLVED)
      projects.close(RESOLVED)

      const survivor = projects.recentlyClosed()[0]
      expect(survivor).toBe(RESOLVED)
      // Round-trip through the still-raw lookups: closing the survivor empties the active list,
      // which only works if the stored string is the one those lookups match.
      projects.open(survivor)
      expect(projects.list().map((project) => project.worktree)).toEqual([RESOLVED])
      projects.close(survivor)
      expect(projects.list()).toEqual([])
      expect(projects.recentlyClosed()).toEqual([RESOLVED])
    })
  })

  // Folding the active-list guard means a cross-spelling reopen keeps the ALREADY-STORED entry
  // instead of prepending a second one; the stored string is the one the app navigates with.
  test("reopen across spellings keeps the stored representative rather than adding a second", () => {
    withProjects((projects) => {
      projects.open(SHORT)
      projects.open(RESOLVED)

      expect(projects.list()).toEqual([{ worktree: SHORT, expanded: true }])
      expect(projects.list()).toHaveLength(1)
    })
  })

  test("negative control: a different directory is still its own closed entry", () => {
    withProjects((projects) => {
      projects.open(SHORT)
      projects.close(SHORT)
      projects.open(OTHER_SHORT)

      expect(projects.recentlyClosed()).toEqual([SHORT])
      expect(projects.list().map((project) => project.worktree)).toEqual([OTHER_SHORT])
    })
  })

  test("scope control: /private/opt is not folded onto /opt", () => {
    withProjects((projects) => {
      projects.open(PRIVATE_OTHER)
      projects.close(PRIVATE_OTHER)
      projects.open(OPT)

      expect(projects.recentlyClosed()).toEqual([PRIVATE_OTHER])
      expect(projects.list().map((project) => project.worktree)).toEqual([OPT])
    })
  })

  test("no-op control: identical spellings behave exactly as before", () => {
    withProjects((projects) => {
      projects.open(SHORT)
      projects.close(SHORT)
      projects.open(SHORT)

      expect(projects.recentlyClosed()).toEqual([])
      expect(projects.list()).toEqual([{ worktree: SHORT, expanded: true }])
    })
  })
})

describe("visibleRecentlyClosed across the two macOS spellings", () => {
  // The server knows the directory under its own spelling; the stored history holds the client
  // spelling. A missed match here silently removes a project from the Home "recently closed" list.
  test("keeps a client-spelled entry the server knows under the resolved spelling", () => {
    const result = visibleRecentlyClosed({
      known: [{ worktree: RESOLVED }],
      closed: [SHORT],
      limit: 5,
    })

    expect(result).toEqual([SHORT])
    // The surviving entry is the stored string itself, not the server's spelling.
    expect(result[0]).toBe(SHORT)
  })

  test("keeps a resolved-spelled entry the server knows under the short spelling", () => {
    const result = visibleRecentlyClosed({
      known: [{ worktree: SHORT }],
      closed: [RESOLVED],
      limit: 5,
    })

    expect(result).toEqual([RESOLVED])
    expect(result[0]).toBe(RESOLVED)
  })

  // Position and cap are asserted, not membership: a filter that merely kept everything, or kept
  // the wrong order, would pass a membership-only assertion.
  test("keeps stored order and applies the display cap", () => {
    const result = visibleRecentlyClosed({
      known: [{ worktree: RESOLVED }, { worktree: "/Users/dev/repo" }, { worktree: OTHER_SHORT }],
      closed: [SHORT, "/Users/dev/repo", OTHER_SHORT],
      limit: 2,
    })

    expect(result).toEqual([SHORT, "/Users/dev/repo"])
    expect(result).toHaveLength(2)
  })

  test("sandboxes and extra server entries do not widen the match", () => {
    const result = visibleRecentlyClosed({
      known: [{ worktree: "/Users/dev/other" }],
      closed: [SHORT],
      limit: 5,
    })

    expect(result).toEqual([])
  })

  test("scope control: /private/opt does not match a stored /opt entry", () => {
    expect(visibleRecentlyClosed({ known: [{ worktree: PRIVATE_OTHER }], closed: [OPT], limit: 5 })).toEqual([])
    expect(visibleRecentlyClosed({ known: [{ worktree: OPT }], closed: [PRIVATE_OTHER], limit: 5 })).toEqual([])
  })

  test("no-op control: same-spelling entries still pass through unchanged", () => {
    expect(visibleRecentlyClosed({ known: [{ worktree: SHORT }], closed: [SHORT], limit: 5 })).toEqual([SHORT])
    expect(visibleRecentlyClosed({ known: [], closed: [SHORT], limit: 5 })).toEqual([])
  })
})
