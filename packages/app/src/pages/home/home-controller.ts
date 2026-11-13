import { useGlobal } from "@/context/global"
import { type HomeProjectSelection, useLayout } from "@/context/layout"
import { ServerConnection, useServer } from "@/context/server"
import { useServerSync } from "@/context/server-sync"
import { useTabs } from "@/context/tabs"
import { toggleHomeProjectSelection } from "@/pages/layout/helpers"
import {
  type FolderMissingNotice,
  type FolderMissingOpenOptions,
  openCheckedFolder,
  useFolderMissingNotice,
} from "@/pages/layout/folder-missing"
import { createEffect, createMemo } from "solid-js"

export type HomeControllerOptions = {
  /**
   * A fixed scope instead of the persisted Home selection. The Home pane beside a chat follows the chat's project and
   * must never rewrite what the full Home page remembers, so with a scope the selection is read-only.
   */
  scope?: () => HomeProjectSelection
}

/**
 * 1.2.8 R-18c (row 30b): Home "Add project" sends every picked folder through the window's missing-folder notice
 * (../layout/folder-missing) before it is added. A folder that is gone gets the existing notice (Restore / Choose) and
 * is not added, selected or given a draft; Restore adds it once it is back. Without a notice (web, legacy Home) or on a
 * remote server each folder is added at once, as before. Resolves to whether each folder was added.
 */
export function addCheckedProjectFolders(
  notice: FolderMissingNotice | undefined,
  directories: string[],
  add: (directory: string) => unknown,
  options?: FolderMissingOpenOptions,
) {
  return Promise.all(directories.map((directory) => openCheckedFolder(notice, directory, () => add(directory), options)))
}

export function createHomeController(options?: HomeControllerOptions) {
  const sync = useServerSync()
  const layout = useLayout()
  const server = useServer()
  const global = useGlobal()
  const tabs = useTabs()
  const folderMissing = useFolderMissingNotice()
  const scope = options?.scope
  const selection = scope ?? layout.home.selection
  const focusedServer = createMemo(
    () => global.servers.list().find((conn) => ServerConnection.key(conn) === selection().server) ?? server.current,
  )
  const focusedServerCtx = createMemo(() => {
    const conn = focusedServer()
    if (!conn) return undefined
    return global.ensureServerCtx(conn)
  })
  const focusedSync = () => focusedServerCtx()?.sync ?? sync()
  const projects = createMemo(() => focusedServerCtx()?.projects.list() ?? layout.projects.list())
  const recentlyClosed = createMemo(
    () => focusedServerCtx()?.projects.recentlyClosed() ?? layout.projects.recentlyClosed(),
  )
  const homedir = createMemo(() => focusedSync().data.path.home ?? "")
  const selectedProject = createMemo(() => projects().find((project) => project.worktree === selection().directory))
  const newSessionProject = createMemo(
    () =>
      selectedProject() ??
      projects().find((project) => project.worktree === focusedServerCtx()?.projects.last()) ??
      projects()[0],
  )

  createEffect(() => {
    if (scope) return
    const list = global.servers.list()
    if (list.some((conn) => ServerConnection.key(conn) === selection().server)) return
    const conn = list.find((conn) => ServerConnection.key(conn) === server.key) ?? list[0]
    if (conn) setSelection({ server: ServerConnection.key(conn) })
  })

  function setSelection(next: HomeProjectSelection) {
    if (scope) return
    layout.home.setSelection(next)
  }

  // Row 58b (U-8): a project whose folder is gone gets the missing-folder notice, not a draft.
  function openProjectNewSession(conn: ServerConnection.Any, directory: string) {
    const ctx = global.ensureServerCtx(conn)
    return openCheckedFolder(
      folderMissing,
      directory,
      () => {
        ctx.projects.open(directory)
        ctx.projects.touch(directory)
        void tabs.newDraft({ server: ServerConnection.key(conn), directory })
      },
      { local: ServerConnection.local(conn) },
    )
  }

  return {
    selection: {
      value: selection,
      set: setSelection,
      focusServer: (conn: ServerConnection.Any) => setSelection({ server: ServerConnection.key(conn) }),
    },
    server: {
      list: global.servers.list,
      health: (conn: ServerConnection.Any) => global.servers.health[ServerConnection.key(conn)],
      context: (conn: ServerConnection.Any) => global.ensureServerCtx(conn),
      focused: focusedServer,
      focusedContext: focusedServerCtx,
      focusedSync,
    },
    project: {
      list: projects,
      recentlyClosed,
      homedir,
      selected: selectedProject,
      newSession: newSessionProject,
      forServer: (conn: ServerConnection.Any) => global.ensureServerCtx(conn).projects.list(),
      select: (conn: ServerConnection.Any, directory: string) => {
        const key = ServerConnection.key(conn)
        if (global.servers.health[key]?.healthy === false) return
        if (
          !global
            .ensureServerCtx(conn)
            .projects.list()
            .some((project) => project.worktree === directory)
        )
          return
        setSelection(toggleHomeProjectSelection(selection(), key, directory))
      },
      add: (conn: ServerConnection.Any, directories: string[]) => {
        const directory = directories[0]
        if (!directory) return
        const ctx = global.ensureServerCtx(conn)
        const first = ctx.projects.list().length === 0
        const addOne = (item: string) => {
          if (!ctx.projects.list().some((project) => project.worktree === item)) {
            const location = { directory: item }
            void ctx.sdk.api.file
              .list({ path: ".", location })
              .then(async (files) => {
                if (files.data.length > 0) return ctx.sdk.api.project.current({ location })
                const result = await ctx.sdk.client.project.initGit({ directory: item })
                return result.data ?? ctx.sdk.api.project.current({ location })
              })
              .then((project) => ctx.sync.child(item, { bootstrap: false })[1]("project", project.id))
              .catch(() => undefined)
            ctx.projects.open(item)
          }
          if (item !== directory) return
          ctx.projects.touch(directory)
          setSelection({ server: ServerConnection.key(conn), directory })
          // Somebody opening their first project is here to give it a task, and that is the only thing it can offer yet.
          if (first) void openProjectNewSession(conn, directory)
        }
        void addCheckedProjectFolders(folderMissing, directories, addOne, { local: ServerConnection.local(conn) })
      },
      openNewSession: () => {
        const conn = focusedServer()
        const project = newSessionProject()
        if (!conn || !project) return
        void openProjectNewSession(conn, project.worktree)
      },
      openProjectNewSession,
    },
  }
}

export type HomeController = ReturnType<typeof createHomeController>
