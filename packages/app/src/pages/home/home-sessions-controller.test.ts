import { describe, expect, test } from "bun:test"
import { type Session } from "@opencode-ai/sdk/v2/client"
import { type LocalProject } from "@/context/layout"
import { buildHomeSessionRecords } from "./home-sessions-controller"

// Mirrors the row-161 causal experiment
// ($D/verification/s5_promotions/f137_causal_test.md §5): the client stores the short /var
// spelling of the project worktree while the server reports each session's directory in the
// resolved /private/var spelling. Before the fix, buildHomeSessionRecords dropped the session
// row on that mismatch; these paths are synthetic but shape-identical to the experiment's pair.
const STORED = "/var/folders/sy/nt4h2c8t/kilo/r173/home/.cache"
const RESOLVED = `/private${STORED}`

const session = (input: Partial<Session> & Pick<Session, "id" | "directory">): Session =>
  ({
    title: "",
    version: "v2",
    parentID: undefined,
    messageCount: 0,
    permissions: { session: {}, share: {} },
    time: { created: 1, updated: 1, archived: undefined },
    ...input,
  }) as Session

const project = (worktree: string, sandboxes?: string[]): LocalProject => ({
  worktree,
  expanded: true,
  ...(sandboxes ? { sandboxes } : {}),
})

const input = (directories: string[], sessions: Session[], projects: LocalProject[]) => ({
  sessions: () => sessions,
  projectDirectories: () => directories,
  projects: () => projects,
  projectByID: () => new Map<string, LocalProject>(),
})

describe("buildHomeSessionRecords across the two /private spellings", () => {
  test("lists a session whose server-resolved directory matches the stored /var worktree", () => {
    const records = buildHomeSessionRecords(
      input([STORED], [session({ id: "ses_resolved", directory: RESOLVED })], [project(STORED)]),
    )
    expect(records.map((record) => record.session.id)).toEqual(["ses_resolved"])
    expect(records[0].project.worktree).toBe(STORED)
  })

  test("lists a session in the opposite direction: stored /var session under a /private project", () => {
    const records = buildHomeSessionRecords(
      input([RESOLVED], [session({ id: "ses_short", directory: STORED })], [project(RESOLVED)]),
    )
    expect(records.map((record) => record.session.id)).toEqual(["ses_short"])
    expect(records[0].project.worktree).toBe(RESOLVED)
  })

  test("no-op control: identical spellings still list (the fix cannot be an accident of ordering)", () => {
    const bothShort = buildHomeSessionRecords(input([STORED], [session({ id: "ses_a", directory: STORED })], [project(STORED)]))
    expect(bothShort.map((record) => record.session.id)).toEqual(["ses_a"])
    const bothResolved = buildHomeSessionRecords(input([RESOLVED], [session({ id: "ses_b", directory: RESOLVED })], [project(RESOLVED)]))
    expect(bothResolved.map((record) => record.session.id)).toEqual(["ses_b"])
  })

  test("negative control: an unrelated directory still drops the row (the fold is not accept-all)", () => {
    const other = "/var/folders/zz/other000/kilo/r173/home/.cache"
    const records = buildHomeSessionRecords(input([other], [session({ id: "ses_x", directory: RESOLVED })], [project(other)]))
    expect(records).toEqual([])
  })

  test("scope control: /private/opt is not a macOS system link, so it does not fold", () => {
    const records = buildHomeSessionRecords(
      input(["/opt/data"], [session({ id: "ses_opt", directory: "/private/opt/data" })], [project("/opt/data")]),
    )
    expect(records).toEqual([])
  })

  test("sandbox spellings fold too: a session matching a sandbox resolves to its project", () => {
    const home = "/Users/dev/repo"
    const records = buildHomeSessionRecords(
      input([home, RESOLVED], [session({ id: "ses_sandbox", directory: STORED })], [project(home, [RESOLVED])]),
    )
    expect(records.map((record) => record.session.id)).toEqual(["ses_sandbox"])
    expect(records[0].project.worktree).toBe(home)
  })
})
