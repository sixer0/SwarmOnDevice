import {
  createComponent,
  createContext,
  createSignal,
  ErrorBoundary,
  onCleanup,
  Show,
  untrack,
  useContext,
  type JSX,
} from "solid-js"
import type { DirectoryCheck } from "@/context/platform"
import { dismissToast, showToast } from "@/utils/toast"

// 1.2.9 row 79a (LIVE-C07, C112): a file at a project path makes the server answer its loads with 400
// LOCATION_NOT_FOLDER (row 55). The desktop check calls that path "missing", so the notice below shows, but a reader
// that threw the 400 into an error boundary also put the full error page behind it, and Restore never reset that
// boundary. Window-wide: which folder-missing notices are open (one entry per shown notice, with its path), and who
// resets when a folder comes back.
// Row 79a2 (S9E-01, C116): an entry leaves on EVERY dismissal (the toast's X, Choose, Restore, Recreate), not only in
// the notice's own close(), and a boundary hides an error only for the location that failed.
type OpenNotice = { readonly directory: string }
const [openNotices, setOpenNotices] = createSignal<ReadonlySet<OpenNotice>>(new Set())
const folderBackListeners = new Set<() => void>()

function addOpenNotice(entry: OpenNotice) {
  setOpenNotices((all) => new Set(all).add(entry))
}

function dropOpenNotice(entry: OpenNotice) {
  setOpenNotices((all) => {
    if (!all.has(entry)) return all
    const next = new Set(all)
    next.delete(entry)
    return next
  })
}

/** A notice is open for `directory`; with no directory known, whether any notice is open. */
function noticeOpenFor(directory: string | undefined) {
  const all = [...openNotices()]
  if (directory === undefined) return all.length > 0
  return all.some((entry) => entry.directory === directory)
}

// The server's refusal is path-free (instance-store.ts LocationNotFolderError). A `directory` the error (or its SDK
// `cause.body`, or that body's `data`) does carry is honoured; otherwise undefined.
function failedDirectory(error: unknown) {
  const read = (value: unknown): string | undefined => {
    if (typeof value !== "object" || value === null) return undefined
    const item = value as { directory?: unknown; data?: { directory?: unknown } }
    if (typeof item.directory === "string") return item.directory
    if (typeof item.data?.directory === "string") return item.data.directory
    return undefined
  }
  const cause = error instanceof Error ? (error.cause as { body?: unknown } | undefined) : undefined
  return read(error) ?? read(cause?.body)
}

function isLocationNotFolderError(error: unknown) {
  const seen = (value: unknown): boolean => {
    if (typeof value !== "object" || value === null) return false
    const item = value as { name?: unknown; code?: unknown; data?: { code?: unknown } }
    return (
      item.name === "LocationNotFolderError" ||
      item.code === "LOCATION_NOT_FOLDER" ||
      item.data?.code === "LOCATION_NOT_FOLDER"
    )
  }
  if (seen(error)) return true
  const cause = error instanceof Error ? (error.cause as { body?: unknown } | undefined) : undefined
  return seen(cause?.body)
}

/**
 * An error boundary that treats a LOCATION_NOT_FOLDER failure like the missing folder it is: while a folder-missing
 * notice is open, it shows nothing instead of `fallback` (the notice is the recovery), and when Restore or Recreate
 * brings a folder back it resets, so the content renders again without a restart. Every other error, and a
 * LOCATION_NOT_FOLDER with no notice open (web, a remote server), shows `fallback` as before.
 * Row 79a2: only a notice for the failing location hides it — `directory` (the location this boundary renders), else a
 * directory the error carries; with neither known, any open notice does.
 */
export function FolderNoticeBoundary(props: {
  fallback: (error: unknown, reset: () => void) => JSX.Element
  children?: JSX.Element
  directory?: string
}) {
  return createComponent(ErrorBoundary, {
    fallback: (error: unknown, reset: () => void) => {
      if (!isLocationNotFolderError(error)) return props.fallback(error, reset)
      folderBackListeners.add(reset)
      onCleanup(() => folderBackListeners.delete(reset))
      // As in ErrorBoundary itself, the fallback is created untracked.
      return createComponent(Show as (props: { when: boolean; children: JSX.Element }) => JSX.Element, {
        get when() {
          return !noticeOpenFor(props.directory ?? failedDirectory(error))
        },
        get children() {
          return untrack(() => props.fallback(error, reset))
        },
      })
    },
    get children() {
      return props.children
    },
  })
}

// 1.2.7 U-8 (rows 33, 47c, 58b): the one copy of the missing-project-folder check and its notice, shared by the legacy
// layout and the new layout. A folder that is gone is neither opened nor entered. One persistent toast per path offers
// Restore (re-check, then open the same path), Recreate (stored projects only, and only for a path this window saw
// missing; desktop makes the leaf alone) and Choose (the picker at home). SR7-13 rules 5-7. Only "missing" is a gone
// folder: "exists", "refused" (the desktop may not look there) and a failed check open exactly as 1.2.6 did.

export type FolderMissingKey =
  | "toast.project.folderMissing.title"
  | "toast.project.folderMissing.description"
  | "toast.project.folderMissing.recreateFailed"
  | "toast.project.folderMissing.restore"
  | "toast.project.folderMissing.recreate"
  | "toast.project.folderMissing.choose"

export type FolderMissingDeps = {
  /** The desktop check, or undefined where none applies (web, a remote server): then the folder opens at once. */
  check: () => ((path: string) => Promise<DirectoryCheck>) | undefined
  recreate: () => ((path: string) => Promise<boolean>) | undefined
  /** Whether the path is a stored project (last opened or in the project list): only those are offered Recreate. */
  stored: (directory: string) => boolean
  t: (key: FolderMissingKey, params?: { path: string }) => string
  /** Choose: open the folder picker (at home). */
  choose: () => void
  /**
   * 1.2.9 row 55a (AC-C07b): re-runs the failed load of a path this window saw missing, once it is back (Restore,
   * Recreate), before `onOpen`. Other paths are not reloaded. Undefined: open only, as before.
   */
  reload?: (directory: string) => Promise<unknown> | unknown
}

export type FolderMissingOpenOptions = {
  /** false when the folder lives on another (remote) server: the desktop cannot check it, so it opens at once. */
  local?: boolean
}

export type FolderMissingNotice = {
  /**
   * Runs `onOpen` only when the folder is not missing. Resolves to whether it ran. On "missing" the path is recorded for
   * Recreate and the notice shows; Restore and Recreate call `onOpen` once the folder is there again.
   */
  open: (directory: string, onOpen: () => unknown, options?: FolderMissingOpenOptions) => Promise<boolean>
  /** Re-checks a path without opening it and shows the notice if it is missing (start-up). Resolves to "missing". */
  notice: (directory: string, onOpen: () => unknown) => Promise<boolean>
}

export function createFolderMissingNotice(deps: FolderMissingDeps): FolderMissingNotice {
  const missingFolders = new Set<string>()
  // Per path: the shown toast, its open-notice entry, and whether Restore / Recreate is still deciding (row 79a2).
  const toasts = new Map<string, { id: number; entry: OpenNotice; acting: boolean }>()

  function close(directory: string) {
    const shown = toasts.get(directory)
    if (shown === undefined) return
    toasts.delete(directory)
    dropOpenNotice(shown.entry)
    dismissToast(shown.id)
  }

  // Row 79a2: the toast went away by itself (its X; or an action button, which dismisses right after its handler).
  // X and Choose drop the entry here. Restore / Recreate keep it until they decide (close() when the folder is back,
  // a new notice when it is still missing), so no error page flashes while the check runs.
  function dismissed(directory: string, entry: OpenNotice) {
    const shown = toasts.get(directory)
    if (shown?.entry !== entry) return dropOpenNotice(entry)
    if (shown.acting) return
    toasts.delete(directory)
    dropOpenNotice(entry)
  }

  function deciding(directory: string) {
    const shown = toasts.get(directory)
    if (shown) shown.acting = true
  }

  async function opened(directory: string, onOpen: () => unknown) {
    const seenMissing = missingFolders.delete(directory)
    // A failed reload must not keep the person from the project: opening still runs, as before.
    if (seenMissing) {
      await (async () => deps.reload?.(directory))().catch(() => undefined)
      // Row 79a: boundaries that hold a LOCATION_NOT_FOLDER failure render their content again (the load re-runs).
      // Before the notice closes, so the error page never shows in between.
      for (const reset of [...folderBackListeners]) reset()
    }
    close(directory)
    await onOpen()
    return true
  }

  async function state(directory: string): Promise<DirectoryCheck> {
    const check = deps.check()
    if (!check) return "exists"
    return check(directory).catch(() => "refused" as const)
  }

  async function open(directory: string, onOpen: () => unknown, options?: FolderMissingOpenOptions) {
    // Row 79a2: this open settles the path's notice (close() or a new notice), so a toast dismissal meanwhile keeps it.
    deciding(directory)
    if (options?.local === false) return opened(directory, onOpen)
    if ((await state(directory)) !== "missing") return opened(directory, onOpen)
    missingFolders.add(directory)
    show(directory, onOpen)
    return false
  }

  async function notice(directory: string, onOpen: () => unknown) {
    if ((await state(directory)) !== "missing") return false
    missingFolders.add(directory)
    show(directory, onOpen)
    return true
  }

  function show(directory: string, onOpen: () => unknown, recreateFailed = false) {
    close(directory)
    const entry: OpenNotice = { directory }
    // Restore and Recreate mark the notice as deciding (in open() / recreateFolder()) before their toast is dismissed.
    const restore = {
      label: deps.t("toast.project.folderMissing.restore"),
      onClick: () => void open(directory, onOpen),
    }
    const recreate = {
      label: deps.t("toast.project.folderMissing.recreate"),
      onClick: () => void recreateFolder(directory, onOpen),
    }
    const choose = {
      label: deps.t("toast.project.folderMissing.choose"),
      onClick: () => {
        close(directory)
        deps.choose()
      },
    }
    const toastId = showToast({
      persistent: true,
      title: deps.t("toast.project.folderMissing.title"),
      description: deps.t(
        recreateFailed ? "toast.project.folderMissing.recreateFailed" : "toast.project.folderMissing.description",
        { path: directory },
      ),
      actions: deps.stored(directory) && !recreateFailed ? [restore, recreate, choose] : [restore, choose],
      onDismiss: () => dismissed(directory, entry),
    })
    toasts.set(directory, { id: toastId, entry, acting: false })
    addOpenNotice(entry)
  }

  async function recreateFolder(directory: string, onOpen: () => unknown) {
    deciding(directory)
    const recreateDirectory = deps.recreate()
    // Nothing to recreate: the button's toast is gone, so its notice is too (row 79a2).
    if (!recreateDirectory || !missingFolders.has(directory)) return close(directory)
    if (await recreateDirectory(directory).catch(() => false)) return opened(directory, onOpen)
    // false: the folder came back meanwhile, or the desktop refused (parent missing, excluded place).
    if (await open(directory, onOpen)) return
    show(directory, onOpen, true)
  }

  return { open, notice }
}

// The new layout shares one notice per window through this context. Dialogs render above the layout (outside the
// context), so the mounted layout also registers its notice for the window; with neither (legacy Home, tests) callers
// open at once.
export const FolderMissingContext = createContext<FolderMissingNotice>()
let windowNotice: FolderMissingNotice | undefined

export function registerFolderMissingNotice(notice: FolderMissingNotice) {
  windowNotice = notice
  return () => {
    if (windowNotice === notice) windowNotice = undefined
  }
}

export function useFolderMissingNotice() {
  return useContext(FolderMissingContext) ?? windowNotice
}

/** Opens through the window's notice when there is one, else at once (as 1.2.6). Resolves to whether it opened. */
export function openCheckedFolder(
  notice: FolderMissingNotice | undefined,
  directory: string,
  onOpen: () => unknown,
  options?: FolderMissingOpenOptions,
) {
  if (!notice) {
    onOpen()
    return Promise.resolve(true)
  }
  return notice.open(directory, onOpen, options)
}
