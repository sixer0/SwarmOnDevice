import { describe, expect, test } from "bun:test"
import { type Session } from "@opencode-ai/sdk/v2/client"
import { type LayoutRoute, type LocalProject } from "@/context/layout"
import { ServerConnection } from "@/context/server"
import { type DraftTab, type SessionTab, tabHref, tabKey, type TabInfo } from "@/context/tabs"
import { sessionHref } from "@/utils/session-route"
import { buildHomeSessionRecords } from "./home-sessions-controller"
import { homePaneScope, routeTab } from "./home-pane-scope"
import { closeHomePane, homeButtonAction, homePaneOpen, openHomePane } from "./home-pane-state"

const SERVER = "local" as ServerConnection.Key
const OTHER = "remote" as ServerConnection.Key
const A = "/Users/me/project-a"
const A_SANDBOX = "/Users/me/.swarm/worktree/project-a/feature"
const B = "/Users/me/project-b"

const projects: Record<string, LocalProject[]> = {
  [SERVER]: [
    { worktree: A, expanded: true, sandboxes: [A_SANDBOX] },
    { worktree: B, expanded: true },
  ],
  [OTHER]: [],
}

const session = (id: string, directory: string, updated: number): Session =>
  ({
    id,
    directory,
    title: id,
    version: "v2",
    parentID: undefined,
    messageCount: 0,
    permissions: { session: {}, share: {} },
    time: { created: updated, updated, archived: undefined },
  }) as unknown as Session

const sessionRoute = (sessionId: string, server = SERVER): LayoutRoute => ({ type: "session", sessionId, server })
const sessionTab = (sessionId: string, server = SERVER): SessionTab => ({ type: "session", server, sessionId })

describe("homeButtonAction", () => {
  test("on the Home route it goes back to the remembered tab", () => {
    expect(homeButtonAction({ route: { type: "home" }, paneOpen: false })).toBe("recent")
    expect(homeButtonAction({ route: { type: "home" }, paneOpen: true })).toBe("recent")
  })

  test("over a session or a draft it only opens and closes the pane", () => {
    for (const route of [sessionRoute("ses_a1"), { type: "draft", draftID: "d1" } as LayoutRoute]) {
      expect(homeButtonAction({ route, paneOpen: false })).toBe("open")
      expect(homeButtonAction({ route, paneOpen: true })).toBe("close")
    }
  })

  test("pane open/close state round-trips", () => {
    expect(homePaneOpen()).toBe(false)
    openHomePane()
    expect(homePaneOpen()).toBe(true)
    closeHomePane()
    expect(homePaneOpen()).toBe(false)
  })
})

describe("homePaneScope", () => {
  const base = { serverKey: SERVER, projects: (server: ServerConnection.Key) => projects[server] ?? [] }

  test("a session tab whose directory is a sandbox resolves to its project's worktree on the tab's server", () => {
    const tab = sessionTab("ses_a1")
    const info: Record<string, TabInfo> = { [tabKey(tab)]: { directory: A_SANDBOX } }
    expect(homePaneScope({ ...base, route: sessionRoute("ses_a1"), tab, info })).toEqual({
      server: SERVER,
      directory: A,
    })
  })

  test("the /private spelling of a worktree still finds the project", () => {
    const tmpProjects = { [SERVER]: [{ worktree: "/var/folders/x/p", expanded: true }] }
    const tab = sessionTab("ses_t")
    const info = { [tabKey(tab)]: { directory: "/private/var/folders/x/p" } }
    expect(
      homePaneScope({ ...base, projects: (key) => tmpProjects[key] ?? [], route: sessionRoute("ses_t"), tab, info }),
    ).toEqual({ server: SERVER, directory: "/var/folders/x/p" })
  })

  test("a draft tab uses worktree, else directory", () => {
    const route: LayoutRoute = { type: "draft", draftID: "d1" }
    const draft: DraftTab = { type: "draft", draftID: "d1", server: SERVER, directory: B, worktree: A_SANDBOX }
    expect(homePaneScope({ ...base, route, tab: draft, info: {} })).toEqual({ server: SERVER, directory: A })
    const plain: DraftTab = { type: "draft", draftID: "d1", server: SERVER, directory: B }
    expect(homePaneScope({ ...base, route, tab: plain, info: {} })).toEqual({ server: SERVER, directory: B })
  })

  test("missing tab info falls back to the session's own directory, else stays undefined (loading)", () => {
    const tab = sessionTab("ses_a1")
    expect(homePaneScope({ ...base, route: sessionRoute("ses_a1"), tab, info: {} })).toBeUndefined()
    expect(homePaneScope({ ...base, route: sessionRoute("ses_a1"), tab, info: {}, sessionDirectory: () => B })).toEqual(
      { server: SERVER, directory: B },
    )
  })

  test("the Home route has no pane scope", () => {
    expect(homePaneScope({ ...base, route: { type: "home" }, tab: undefined, info: {} })).toBeUndefined()
  })

  test("routeTab finds the tab of the shown session on the same server only", () => {
    const tabs = [sessionTab("ses_a1", OTHER), sessionTab("ses_a1"), sessionTab("ses_b1")]
    expect(routeTab(sessionRoute("ses_a1"), tabs)).toBe(tabs[1])
    expect(routeTab({ type: "home" }, tabs)).toBeUndefined()
  })
})

describe("Home pane beside a session", () => {
  const all = [
    session("ses_a1", A, 30),
    session("ses_a2", A_SANDBOX, 20),
    session("ses_b1", B, 25),
    session("ses_b2", B, 10),
  ]

  test("lists only the current project's sessions (worktree and sandboxes)", () => {
    const tab = sessionTab("ses_a1")
    const scope = homePaneScope({
      route: sessionRoute("ses_a1"),
      tab,
      info: { [tabKey(tab)]: { directory: A } },
      serverKey: SERVER,
      projects: (key) => projects[key] ?? [],
    })
    const selected = projects[SERVER].find((project) => project.worktree === scope?.directory)
    expect(selected?.worktree).toBe(A)
    const records = buildHomeSessionRecords({
      sessions: () => all,
      projectDirectories: () => [selected!.worktree, ...(selected!.sandboxes ?? [])],
      projects: () => projects[SERVER],
      projectByID: () => new Map(),
    })
    expect(records.map((record) => record.session.id)).toEqual(["ses_a1", "ses_a2"])
    expect(records.every((record) => record.project.worktree === A)).toBe(true)
  })

  test("opening a listed session keeps a chat route (the session URL), never '/'", () => {
    // The pane opens a row the way Home does: tabs.addSessionTab + tabs.select, which navigates to tabHref(tab).
    const opened = sessionTab("ses_a2")
    const href = tabHref(opened)
    expect(href).not.toBe("/")
    expect(href).toBe(sessionHref(SERVER, "ses_a2"))
    expect(href).toMatch(/^\/server\/[^/]+\/session\/ses_a2$/)
    // Not parsed through currentRoute: submit.test.ts leaks a base64Encode mock that breaks its re-encode check in the full suite.
    const route: LayoutRoute = { type: "session", sessionId: "ses_a2", server: SERVER }
    // And the Home button over that chat still only toggles the pane: no navigation to "/".
    expect(homeButtonAction({ route, paneOpen: true })).toBe("close")
    expect(homeButtonAction({ route, paneOpen: false })).toBe("open")
  })
})
