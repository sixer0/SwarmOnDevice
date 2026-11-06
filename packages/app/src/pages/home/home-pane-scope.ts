import type { HomeProjectSelection, LayoutRoute, LocalProject } from "@/context/layout"
import type { ServerConnection } from "@/context/server"
import { type Tab, type TabInfo, tabKey } from "@/context/tabs"
import { canonicalPathKey } from "@/utils/path-key"
import { isChatRoute } from "./home-pane-state"

/** The tab that shows the route, by exact match (child sessions fall back to their own directory). */
export function routeTab(route: LayoutRoute, tabs: readonly Tab[]): Tab | undefined {
  if (route.type === "draft") return tabs.find((tab) => tab.type === "draft" && tab.draftID === route.draftID)
  if (route.type === "session")
    return tabs.find(
      (tab) =>
        tab.type === "session" &&
        tab.sessionId === route.sessionId &&
        (route.server === undefined || tab.server === route.server),
    )
}

/**
 * The project the pane lists: the current chat's, never the persisted Home selection and never `params.dir` (the
 * new-layout session URL has no directory, which is why the old switcher stayed empty). Undefined until known.
 */
export function homePaneScope(input: {
  route: LayoutRoute
  tab: Tab | undefined
  info: Record<string, TabInfo | undefined>
  serverKey: ServerConnection.Key
  projects: (server: ServerConnection.Key) => LocalProject[]
  /** The session's own directory from the server's session store, for a session without tab info yet. */
  sessionDirectory?: () => string | undefined
}): HomeProjectSelection | undefined {
  const route = input.route
  if (!isChatRoute(route)) return undefined
  const tab = input.tab
  const server = tab?.server ?? ("server" in route ? route.server : undefined) ?? input.serverKey
  const raw = (() => {
    if (tab?.type === "draft") return tab.worktree ?? tab.directory
    if (tab?.type === "session") return input.info[tabKey(tab)]?.directory ?? input.sessionDirectory?.()
    if (route.type === "dir-new-sesssion") return route.dir
    if (route.type === "session") return input.sessionDirectory?.()
  })()
  if (!raw) return undefined
  const key = canonicalPathKey(raw)
  const project = input
    .projects(server)
    .find(
      (item) =>
        canonicalPathKey(item.worktree) === key || item.sandboxes?.some((sandbox) => canonicalPathKey(sandbox) === key),
    )
  return { server, directory: project?.worktree ?? raw }
}
