import { describe, expect, test } from "bun:test"
import type { Session } from "@opencode-ai/sdk/v2/client"
import type { ServerConnection } from "@/context/server"
import { tabKey, type SessionTab, type Tab } from "@/context/tabs"
import {
  chooseSession,
  PROJECT_SESSIONS_MAX,
  projectDirectories,
  projectSessions,
  rootSessionID,
  type SessionStore,
  type SwitcherTabs,
} from "./session-switcher-model"

const server = "local\nhttp://localhost:4096" as ServerConnection.Key
const other = "remote\nhttp://example.test:4096" as ServerConnection.Key

function session(
  id: string,
  directory: string,
  updated: number,
  extra: { parentID?: string; archived?: number; title?: string } = {},
): Session {
  return {
    id,
    directory,
    parentID: extra.parentID,
    title: extra.title ?? `title ${id}`,
    time: { created: updated, updated, archived: extra.archived },
  } as unknown as Session
}

function store(directory: string, sessions: Session[]): SessionStore {
  return { path: { directory }, session: sessions }
}

function sessionTab(sessionId: string, srv = server): SessionTab {
  return { type: "session", server: srv, sessionId }
}

/** Mirrors `addSessionTab`/`select` of context/tabs.tsx: idempotent add keyed by `tabKey`, select records order. */
function tabModel(initial: Tab[] = []) {
  const list: Tab[] = [...initial]
  const calls: string[] = []
  const selected: Tab[] = []
  const tabs: SwitcherTabs = {
    addSessionTab: (tab) => {
      calls.push(`add:${tab.sessionId}`)
      const next = { type: "session" as const, ...tab }
      const existing = list.find((item) => tabKey(item) === tabKey(next))
      if (existing) return existing
      list.push(next)
      return next
    },
    select: (tab) => {
      calls.push(`select:${tab.type === "session" ? tab.sessionId : tab.draftID}`)
      selected.push(tab)
    },
  }
  return { tabs, list, calls, selected }
}

describe("projectSessions", () => {
  const worktree = "/repo/app"
  const sandbox = "/repo/app-sandbox"
  const foreign = "/repo/other"

  test("only the current project's worktree and sandbox roots, newest first", () => {
    const stores = [
      store(worktree, [session("a", worktree, 10), session("b", worktree, 30)]),
      store(sandbox, [session("c", sandbox, 20)]),
    ]
    // A store of another project is never passed in; a stray session of another directory inside a project store
    // is still dropped by `roots`.
    stores[0]!.session!.push(session("x", foreign, 99))
    const result = projectSessions(stores, "", [], server)
    expect(result.map((item) => item.session.id)).toEqual(["b", "c", "a"])
  })

  test("excludes child and archived sessions", () => {
    const stores = [
      store(worktree, [
        session("root", worktree, 10),
        session("child", worktree, 50, { parentID: "root" }),
        session("gone", worktree, 60, { archived: 61 }),
      ]),
    ]
    expect(projectSessions(stores, "", [], server).map((item) => item.session.id)).toEqual(["root"])
  })

  test("dedupes a session present in two stores", () => {
    const shared = session("s", worktree, 10)
    const stores = [store(worktree, [shared]), store(worktree, [shared, session("t", worktree, 5)])]
    expect(projectSessions(stores, "", [], server).map((item) => item.session.id)).toEqual(["s", "t"])
  })

  test("ties sort by id, and the list is capped", () => {
    const many = Array.from({ length: PROJECT_SESSIONS_MAX + 7 }, (_, i) =>
      session(`s${String(i).padStart(3, "0")}`, worktree, 1),
    )
    const result = projectSessions([store(worktree, many)], "", [], server)
    expect(result).toHaveLength(PROJECT_SESSIONS_MAX)
    expect(result[0]!.session.id).toBe("s000")
  })

  test("marks the current session and sessions open in a tab of this server", () => {
    const stores = [store(worktree, [session("a", worktree, 3), session("b", worktree, 2), session("c", worktree, 1)])]
    const open = [sessionTab("b"), sessionTab("c", other)]
    const result = projectSessions(stores, "a", open, server)
    expect(result.map(({ session, current, open }) => ({ id: session.id, current, open }))).toEqual([
      { id: "a", current: true, open: false },
      { id: "b", current: false, open: true },
      { id: "c", current: false, open: false },
    ])
  })

  test("empty stores give an empty list", () => {
    expect(projectSessions([store(worktree, [])], "a", [], server)).toEqual([])
    expect(projectSessions([{ path: { directory: worktree } }], "a", [], server)).toEqual([])
  })
})

describe("projectDirectories", () => {
  test("worktree plus sandboxes, deduped", () => {
    expect(projectDirectories({ worktree: "/w", sandboxes: ["/s1", "/w", "/s2"] }, "/route")).toEqual([
      "/w",
      "/s1",
      "/s2",
    ])
  })

  test("route directory when no project matches", () => {
    expect(projectDirectories(undefined, "/route")).toEqual(["/route"])
    expect(projectDirectories(undefined, "")).toEqual([])
  })
})

describe("chooseSession", () => {
  test("adds a tab then selects it", () => {
    const model = tabModel([sessionTab("a")])
    expect(chooseSession(model.tabs, server, { id: "b" }, "a")).toBe(true)
    expect(model.calls).toEqual(["add:b", "select:b"])
    expect(model.list.map((tab) => tabKey(tab))).toEqual([tabKey(sessionTab("a")), tabKey(sessionTab("b"))])
    expect(model.selected).toEqual([sessionTab("b")])
  })

  test("an already open session is focused, not duplicated", () => {
    const existing = sessionTab("b")
    const model = tabModel([sessionTab("a"), existing])
    chooseSession(model.tabs, server, { id: "b" }, "a")
    expect(model.list).toHaveLength(2)
    expect(model.selected[0]).toBe(existing)
    expect(model.calls).toEqual(["add:b", "select:b"])
  })

  test("choosing the current session does nothing", () => {
    const model = tabModel([sessionTab("a")])
    expect(chooseSession(model.tabs, server, { id: "a" }, "a")).toBe(false)
    expect(model.calls).toEqual([])
    expect(model.list).toHaveLength(1)
  })
})

describe("rootSessionID (code review m10)", () => {
  const sessions: Record<string, { parentID?: string }> = {
    root: {},
    child: { parentID: "root" },
    grandchild: { parentID: "child" },
    orphan: { parentID: "gone" },
    loopA: { parentID: "loopB" },
    loopB: { parentID: "loopA" },
  }
  const get = (id: string) => sessions[id]

  test("a root is its own root, a child climbs one level", () => {
    expect(rootSessionID("root", get)).toBe("root")
    expect(rootSessionID("child", get)).toBe("root")
  })

  test("a grandchild subagent climbs to the true root, not to its parent", () => {
    expect(rootSessionID("grandchild", get)).toBe("root")
  })

  test("a parent the store cannot read is the furthest root known; a loop ends", () => {
    expect(rootSessionID("orphan", get)).toBe("gone")
    expect(rootSessionID("unknown", get)).toBe("unknown")
    expect(["loopA", "loopB"]).toContain(rootSessionID("loopA", get))
  })
})
