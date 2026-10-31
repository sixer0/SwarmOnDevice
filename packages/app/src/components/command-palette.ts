import { getFilename } from "@opencode-ai/core/util/path"
import type { GlobalSearchResponse, Project, Session } from "@opencode-ai/sdk/v2/client"
import type { SessionInfo } from "@opencode-ai/client/promise"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { createMemo, createSignal, onCleanup } from "solid-js"
import { commandPaletteOptions, useCommand, type CommandOption } from "@/context/command"
import { useFile, type SelectedLineRange } from "@/context/file"
import { useGlobal } from "@/context/global"
import { useLanguage } from "@/context/language"
import { useLayout, type LocalProject } from "@/context/layout"
import { ServerConnection } from "@/context/server"
import { useSDK } from "@/context/sdk"
import { useServerSDK } from "@/context/server-sdk"
import { useTabs } from "@/context/tabs"
import { displayName, projectForSession } from "@/pages/layout/helpers"
import { createSessionTabs } from "@/pages/session/helpers"
import { useSessionLayout } from "@/pages/session/session-layout"
import { normalizeSessionInfo } from "@/utils/session"

export type CommandPaletteEntry = {
  id: string
  type: "command" | "file" | "session"
  title: string
  description?: string
  keybind?: string
  category: string
  option?: CommandOption
  path?: string
  directory?: string
  sessionID?: string
  server?: ServerConnection.Key
  project?: LocalProject
  archived?: number
  updated?: number
  /** The turn to scroll to when this session opens. */
  anchor?: string
  /** Where the session matched: who said it, or which file, then the words. Absent when only the title matched. */
  hit?: { label?: string; snippet: ReadonlyArray<{ text: string; hit: boolean }> }
}

export type SessionSearchStatus = { indexing?: number; titlesOnly?: boolean; failed?: boolean }

const ENTRY_LIMIT = 5
const COMMON_COMMAND_IDS = [
  "session.new",
  "workspace.new",
  "session.previous",
  "session.next",
  "terminal.toggle",
  "review.toggle",
] as const

export function uniqueCommandPaletteEntries(items: CommandPaletteEntry[]) {
  const seen = new Set<string>()
  return items.filter((item) => {
    if (seen.has(item.id)) return false
    seen.add(item.id)
    return true
  })
}

export function createCommandPaletteFileEntry(path: string, category: string): CommandPaletteEntry {
  return {
    id: "file:" + path,
    type: "file",
    title: path,
    category,
    path,
  }
}

export function createCommandPaletteFileOpener(onOpenFile?: (path: string) => void) {
  const file = useFile()
  const layout = useLayout()
  const { tabs, view } = useSessionLayout()

  return (path: string) => {
    const value = file.tab(path)
    void tabs().open(value)
    void file.load(path)
    if (!view().reviewPanel.opened()) view().reviewPanel.open()
    layout.fileTree.setTab("all")
    onOpenFile?.(path)
    tabs().setActive(value)
  }
}

export function createCommandPaletteModel(props: { filesOnly?: () => boolean; onOpenFile?: (path: string) => void }) {
  const command = useCommand()
  const global = useGlobal()
  const language = useLanguage()
  const file = useFile()
  const dialog = useDialog()
  const serverSDK = useServerSDK()()
  const serverCtx = global.ensureServerCtx(serverSDK.server)
  const appTabs = useTabs()
  const { tabs: sessionTabs, view } = useSessionLayout()
  const sdk = useSDK()
  const openFile = createCommandPaletteFileOpener(props.onOpenFile)
  const state = { cleanup: undefined as (() => void) | void, committed: false }
  const filesOnly = () => props.filesOnly?.() ?? false

  const allowedCommands = createMemo(() => {
    if (filesOnly()) return []
    return commandPaletteOptions(command.options)
  })
  const commandEntries = createMemo(() => {
    const category = language.t("palette.group.commands")
    return allowedCommands().map((option) => createCommandPaletteCommandEntry(option, category))
  })
  const preferredCommandEntries = createMemo(() => {
    const all = allowedCommands()
    const order = new Map<string, number>(COMMON_COMMAND_IDS.map((id, index) => [id, index]))
    const picked = all.filter((option) => order.has(option.id))
    const base = picked.length ? picked : all.slice(0, ENTRY_LIMIT)
    const sorted = picked.length ? [...base].sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0)) : base
    const category = language.t("palette.group.commands")
    return sorted.map((option) => createCommandPaletteCommandEntry(option, category))
  })

  const tabState = createSessionTabs({
    tabs: sessionTabs,
    pathFromTab: file.pathFromTab,
    normalizeTab: (tab) => (tab.startsWith("file://") ? file.tab(tab) : tab),
  })
  const recentFileEntries = createMemo(() => {
    const all = tabState.openedTabs()
    const active = tabState.activeFileTab()
    const order = active ? [active, ...all.filter((item) => item !== active)] : all
    const seen = new Set<string>()
    const category = language.t("palette.group.files")
    return order
      .map((item) => file.pathFromTab(item))
      .filter((path): path is string => {
        if (!path || seen.has(path)) return false
        seen.add(path)
        return true
      })
      .slice(0, ENTRY_LIMIT)
      .map((path) => createCommandPaletteFileEntry(path, category))
  })
  const rootFileEntries = createMemo(() => {
    const category = language.t("palette.group.files")
    return file.tree
      .children("")
      .filter((node) => node.type === "file")
      .map((node) => node.path)
      .sort((a, b) => a.localeCompare(b))
      .slice(0, ENTRY_LIMIT)
      .map((path) => createCommandPaletteFileEntry(path, category))
  })

  const sessions = createServerSessionEntries({
    server: ServerConnection.key(serverSDK.server),
    opened: serverCtx.projects.list,
    stored: () => serverCtx.sync.data.project,
    search: (q, signal) =>
      serverSDK.client.global.search({ q, directory: sdk().directory }, { signal, throwOnError: true }).then((r) => r.data),
    load: (search, signal) => serverSDK.api.session.list({ parentID: null, search, limit: 50 }, { signal }),
    untitled: () => language.t("command.session.new"),
    category: () => language.t("command.category.session"),
  })
  /** The line selected in the file on screen, as a query. Opening the palette then answers who wrote it. */
  const selectedLine = () => {
    if (!view().reviewPanel.opened()) return
    const tab = tabState.activeFileTab()
    const path = tab ? file.pathFromTab(tab) : undefined
    const range = path ? (file.selectedLines(path) as SelectedLineRange | undefined) : undefined
    return path && range ? `${path}:${Math.min(range.start, range.end)}` : undefined
  }

  const highlight = (item: CommandPaletteEntry | undefined) => {
    state.cleanup?.()
    state.cleanup = undefined
    if (item?.type !== "command") return
    state.cleanup = item.option?.onHighlight?.()
  }

  const select = (item: CommandPaletteEntry | undefined) => {
    if (!item) return
    state.committed = true
    state.cleanup = undefined
    dialog.close()
    if (item.type === "command") {
      item.option?.onSelect?.("palette")
      return
    }
    if (item.type === "session") {
      if (!item.sessionID || !item.server) return
      const directory = item.project?.worktree ?? item.directory
      if (directory) {
        serverCtx.projects.open(directory)
        serverCtx.projects.touch(directory)
      }
      const tab = appTabs.addSessionTab({
        server: item.server,
        sessionId: item.sessionID,
      })
      appTabs.select(tab, item.anchor)
      return
    }
    if (!item.path) return
    openFile(item.path)
  }

  onCleanup(() => {
    if (state.committed) return
    state.cleanup?.()
  })

  return {
    language,
    file,
    commandEntries,
    preferredCommandEntries,
    recentFileEntries,
    rootFileEntries,
    sessions,
    selectedLine,
    highlight,
    select,
    close: () => dialog.close(),
  }
}

export function createCommandPaletteCommandEntry(option: CommandOption, category: string): CommandPaletteEntry {
  return {
    id: "command:" + option.id,
    type: "command",
    title: option.title,
    description: option.description,
    keybind: option.keybind,
    category,
    option,
  }
}

export function createServerSessionEntries(props: {
  server: ServerConnection.Key
  opened: () => LocalProject[]
  stored: () => Project[]
  search: (text: string, signal: AbortSignal) => Promise<GlobalSearchResponse | undefined>
  /** Title search, for a server too old to have content search. */
  load: (search: string, signal: AbortSignal) => Promise<{ data: SessionInfo[] }>
  untitled: () => string
  category: () => string
}) {
  const language = useLanguage()
  const [status, setStatus] = createSignal<SessionSearchStatus>({})
  let abort: AbortController | undefined

  onCleanup(() => abort?.abort())

  const fromSearch = (response: GlobalSearchResponse, entry: (session: Session) => CommandPaletteEntry) => {
    const heading = searchHeading(response, props.category(), language.intl())
    return response.results.map((result) => {
      const base = entry(result.session)
      return {
        ...base,
        category: heading,
        sessionID: result.openID,
        archived: result.session.time.archived,
        anchor: result.anchor,
        hit:
          result.snippet.length > 0 || result.verdict
            ? { label: hitLabel(result, language.t), snippet: result.snippet }
            : undefined,
      }
    })
  }

  const entries = async (text: string): Promise<CommandPaletteEntry[]> => {
    const search = text.trim()
    if (!search) {
      abort?.abort()
      setStatus({})
      return []
    }
    abort?.abort()
    const current = new AbortController()
    abort = current
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 100)
      current.signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer)
          resolve()
        },
        { once: true },
      )
    })
    if (current.signal.aborted) return []
    const opened = props.opened()
    const openedByID = new Map(opened.flatMap((project) => (project.id ? [[project.id, project] as const] : [])))
    const stored = props.stored().map((project) => ({ ...project, expanded: false }))
    const storedByID = new Map(stored.map((project) => [project.id, project] as const))
    const entry = (session: Session): CommandPaletteEntry => {
      const project = projectForSession(session, opened, openedByID) ?? projectForSession(session, stored, storedByID)
      return {
        id: `session:${props.server}:${session.id}`,
        type: "session",
        title: session.title || props.untitled(),
        description: project ? displayName(project) : getFilename(session.directory),
        category: props.category(),
        directory: session.directory,
        sessionID: session.id,
        server: props.server,
        project,
        updated: session.time.updated,
      }
    }
    const response = await props.search(search, current.signal).catch(() => undefined)
    if (current.signal.aborted) return []
    if (response) {
      setStatus({
        indexing: response.progress < 1 && response.available ? response.progress : undefined,
        titlesOnly: !response.available,
      })
      return fromSearch(response, entry)
    }
    return props
      .load(search, current.signal)
      .then((result) => {
        setStatus({ titlesOnly: true })
        return result.data
          .map(normalizeSessionInfo)
          .filter((session) => !session.time.archived)
          .map(entry)
      })
      .catch(() => {
        if (!current.signal.aborted) setStatus({ failed: true })
        return [] as CommandPaletteEntry[]
      })
  }

  return Object.assign(entries, { status })
}

function hitLabel(result: GlobalSearchResponse["results"][number], t: ReturnType<typeof useLanguage>["t"]) {
  if (result.verdict === "wrote") return t("palette.sessions.wroteLine")
  if (result.verdict === "edited") return t("palette.sessions.editedFile")
  if (result.kind === "prompt") return t("palette.sessions.you")
  if (result.kind === "said" || result.kind === "thought") return t("palette.sessions.agent")
  if (result.kind === "edit") return result.label ? getFilename(result.label) : undefined
  return result.label
}

/** What was searched, when it was more than words: which line of which file, or which dates a phrase meant. */
function searchHeading(response: GlobalSearchResponse, category: string, locale: string) {
  if (response.file) {
    const place = response.file.line ? `${response.file.path}:${response.file.line}` : response.file.path
    return response.file.text ? `${place}  ${response.file.text}` : place
  }
  if (!response.range) return category
  const dates = new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" })
  // `to` is exclusive, and a whole day like "yesterday" reads better as one date than as a range.
  return `${category} · ${dates.formatRange(response.range.from, response.range.to - 1)}`
}
