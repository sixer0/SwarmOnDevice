import { describe, expect, test } from "bun:test"
import { type Session } from "@opencode-ai/sdk/v2/client"
import { projectForSession, effectiveWorkspaceOrder, roots, sortedRootSessions } from "./helpers"

// Mirrors the row-161 causal experiment ($D/verification/s5_promotions/f137_causal_test.md §5) at the
// layout-helper comparison sites: the client stores the short /var spelling while the server reports
// the resolved /private/var spelling of the SAME directory. Before row 173b these helpers compared raw
// pathKeys and diverged; the paths below are synthetic but shape-identical to the experiment's pair.
const STORED = "/var/folders/sy/nt4h2c8t/kilo/r173b/home/.cache"
const RESOLVED = `/private${STORED}`

const session = (input: Partial<Session> & Pick<Session, "id" | "directory">) =>
  ({
    title: "",
    version: "v2",
    parentID: undefined,
    messageCount: 0,
    permissions: { session: {}, share: {} },
    time: { created: 0, updated: 0, archived: undefined },
    ...input,
  }) as Session

const store = (directory: string, sessions: Session[]) => ({ session: sessions, path: { directory } })

describe("roots across the two /private spellings", () => {
  test("a server-resolved session is visible under the stored /var directory", () => {
    const result = roots(store(STORED, [session({ id: "ses_resolved", directory: RESOLVED })]))
    expect(result.map((s) => s.id)).toEqual(["ses_resolved"])
  })

  test("the opposite direction: stored /var session under a /private-resolved directory", () => {
    const result = roots(store(RESOLVED, [session({ id: "ses_short", directory: STORED })]))
    expect(result.map((s) => s.id)).toEqual(["ses_short"])
  })

  test("no-op control: identical spellings stay visible both ways", () => {
    expect(roots(store(STORED, [session({ id: "ses_a", directory: STORED })])).length).toBe(1)
    expect(roots(store(RESOLVED, [session({ id: "ses_b", directory: RESOLVED })])).length).toBe(1)
  })

  test("negative control: an unrelated directory still drops the session (the fold is not accept-all)", () => {
    expect(roots(store("/Users/dev/other", [session({ id: "ses_b", directory: STORED })])).length).toBe(0)
  })

  test("scope control: /private/opt is not a system link and does not fold onto /opt", () => {
    expect(roots(store("/opt/data", [session({ id: "ses_opt", directory: "/private/opt/data" })])).length).toBe(0)
  })

  test("sortedRootSessions inherits the tolerant comparison", () => {
    const result = sortedRootSessions(store(STORED, [session({ id: "ses_resolved", directory: RESOLVED })]), 0)
    expect(result.map((s) => s.id)).toEqual(["ses_resolved"])
  })
})

type Project = { id?: string; worktree: string; sandboxes?: string[] }

describe("projectForSession across the two /private spellings", () => {
  test("a server-resolved session resolves to the stored /var project", () => {
    const projects: Project[] = [{ worktree: STORED }]
    const found = projectForSession(session({ id: "ses_x", directory: RESOLVED }), projects)
    expect(found?.worktree).toBe(STORED)
  })

  test("the opposite direction: stored /var session resolves to a /private project", () => {
    const projects: Project[] = [{ worktree: RESOLVED }]
    const found = projectForSession(session({ id: "ses_x", directory: STORED }), projects)
    expect(found?.worktree).toBe(RESOLVED)
  })

  test("sandbox spellings fold too", () => {
    const sandbox = `${STORED}/worktrees/feat`
    const projects: Project[] = [{ worktree: "/Users/dev/unrelated", sandboxes: [sandbox] }]
    const found = projectForSession(session({ id: "ses_x", directory: `/private${sandbox}` }), projects)
    expect(found?.worktree).toBe("/Users/dev/unrelated")
  })

  test("negative control: an unrelated session directory matches no project", () => {
    const projects: Project[] = [{ worktree: STORED }]
    expect(projectForSession(session({ id: "ses_x", directory: "/Users/dev/other" }), projects)).toBeUndefined()
  })

  test("scope control: /private/opt never folds, so a /opt project is not matched", () => {
    const projects: Project[] = [{ worktree: "/opt/data" }]
    expect(projectForSession(session({ id: "ses_x", directory: "/private/opt/data" }), projects)).toBeUndefined()
  })
})

describe("effectiveWorkspaceOrder matches persisted entries across spellings", () => {
  test("a persisted /private/var entry still re-attaches to its live /var workspace and keeps its position", () => {
    const local = "/var/proj"
    const live = ["/var/proj", "/var/proj/wt-a", "/var/proj/wt-b"]
    // Pre-fix the server-spelled persisted entry failed the raw-pathKey match, so its chosen position
    // was lost: the live value survived only through the tail-append of unmatched entries, reordering
    // the user's saved workspace sequence. The result must carry the RAW live spellings, not the
    // persisted spelling.
    const persisted = ["/private/var/proj/wt-b", "/var/proj/wt-a"]
    expect(effectiveWorkspaceOrder(local, live, persisted)).toEqual([
      "/var/proj",
      "/var/proj/wt-b",
      "/var/proj/wt-a",
    ])
  })

  test("no-op control: identical spellings keep the persisted order", () => {
    const result = effectiveWorkspaceOrder("/var/proj", ["/var/proj", "/var/proj/wt-a"], ["/var/proj/wt-a"])
    expect(result).toEqual(["/var/proj", "/var/proj/wt-a"])
  })

  test("two live spellings of one directory collapse to one entry", () => {
    const result = effectiveWorkspaceOrder("/var/proj", ["/var/proj", "/var/proj/wt-a", "/private/var/proj/wt-a"])
    expect(result).toEqual(["/var/proj", "/var/proj/wt-a"])
  })

  test("negative control: a genuinely different persisted directory is still dropped", () => {
    const result = effectiveWorkspaceOrder("/var/proj", ["/var/proj", "/var/proj/wt-a"], ["/var/proj/wt-b"])
    expect(result).toEqual(["/var/proj", "/var/proj/wt-a"])
  })
})
