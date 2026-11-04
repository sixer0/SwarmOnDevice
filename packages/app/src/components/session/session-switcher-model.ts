import type { Session } from "@opencode-ai/sdk/v2/client"
import type { ServerConnection } from "@/context/server"
import { sessionHasOpenTab, type SessionTab, type Tab } from "@/context/tabs"
import { compareSessionTime, roots } from "@/pages/layout/helpers"

/** The part of a directory store the switcher reads (same shape the sidebar helpers take). */
export type SessionStore = {
  session?: Session[]
  path: { directory: string }
}

export type ProjectSessionItem = {
  session: Session
  current: boolean
  open: boolean
}

export const PROJECT_SESSIONS_MAX = 50

/**
 * Root sessions of the current project: the union of `roots(store)` over the project's directory stores
 * (worktree + sandboxes), deduped by id, newest first, capped at PROJECT_SESSIONS_MAX. `roots` already drops
 * child and archived sessions and sessions whose directory is not the store's directory.
 */
export function projectSessions(
  stores: SessionStore[],
  currentRootID: string,
  openTabs: Tab[],
  server: ServerConnection.Key,
): ProjectSessionItem[] {
  const byID = new Map<string, Session>()
  for (const store of stores) {
    for (const session of roots(store)) {
      if (!byID.has(session.id)) byID.set(session.id, session)
    }
  }
  return [...byID.values()]
    .sort(compareSessionTime)
    .slice(0, PROJECT_SESSIONS_MAX)
    .map((session) => ({
      session,
      current: session.id === currentRootID,
      open: sessionHasOpenTab(openTabs, server, session),
    }))
}

/** Project directories the switcher reads: worktree plus sandboxes, or the route directory when no project matches. */
export function projectDirectories(
  project: { worktree: string; sandboxes?: string[] } | undefined,
  fallback: string,
): string[] {
  const list = project ? [project.worktree, ...(project.sandboxes ?? [])] : [fallback]
  return [...new Set(list.filter((dir) => !!dir))]
}

/**
 * The root a session belongs to: `parentID` followed to the top, as the server's `rootOf` does, so a grandchild
 * subagent's page marks the same root as its parent's. Stops at a session it cannot read (the furthest one known
 * is returned) and at a loop, which a well-formed store never has.
 */
export function rootSessionID(id: string, get: (id: string) => Pick<Session, "parentID"> | undefined): string {
  const seen = new Set<string>()
  let current = id
  while (!seen.has(current)) {
    seen.add(current)
    const parent = get(current)?.parentID
    if (!parent) return current
    current = parent
  }
  return current
}

export type SwitcherTabs = {
  addSessionTab: (tab: Omit<SessionTab, "type">) => Tab
  select: (tab: Tab) => void
}

/**
 * Open the chosen session in a tab, or focus its tab when one is open (`addSessionTab` is idempotent).
 * Choosing the current session does nothing; the caller only closes the menu. Returns whether it navigated.
 */
export function chooseSession(
  tabs: SwitcherTabs,
  server: ServerConnection.Key,
  session: Pick<Session, "id">,
  currentRootID: string,
): boolean {
  if (session.id === currentRootID) return false
  const tab = tabs.addSessionTab({ server, sessionId: session.id })
  tabs.select(tab)
  return true
}
