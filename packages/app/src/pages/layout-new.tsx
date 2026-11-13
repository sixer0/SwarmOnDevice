import { createEffect, lazy, onCleanup, onMount, Show, Suspense, type ParentProps } from "solid-js"
import { createStore } from "solid-js/store"
import { DebugBar } from "@/components/debug-bar"
import { useDirectoryPicker } from "@/components/directory-picker"
import { TabsInfoPopup } from "@/components/help-button"
import { Titlebar, type TitlebarUpdate } from "@/components/titlebar"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { usePlatform } from "@/context/platform"
import { useServer } from "@/context/server"
import { useServerSync } from "@/context/server-sync"
import {
  createFolderMissingNotice,
  FolderMissingContext,
  registerFolderMissingNotice,
} from "@/pages/layout/folder-missing"
import { homePaneOpen } from "@/pages/home/home-pane-state"
import { useAutonomyBlockedAlerts } from "@/pages/autonomy-blocked-alerts"
import { setV2Toast, ToastRegion } from "@/utils/toast"

// Home beside the chat. Loaded on first open, so a layout that never opens it never pulls the Home controllers in.
const HomePaneHost = lazy(() => import("@/pages/home/home-pane").then((module) => ({ default: module.HomePaneHost })))

export default function NewLayout(props: ParentProps) {
  const platform = usePlatform()
  const [state, setState] = createStore({ debugTools: true })

  createEffect(() => setV2Toast(true))
  useAutonomyBlockedAlerts()
  const folderMissing = createNewLayoutFolderMissing()

  const update: TitlebarUpdate = {
    version: () => {
      const state = platform.updater?.state()
      if (state?.status !== "ready") return
      return state.version
    },
    installing: () => platform.updater?.state().status === "installing",
    install: () => void platform.updater?.install(),
  }

  return (
    <FolderMissingContext.Provider value={folderMissing}>
      <div
        class="relative bg-v2-background-bg-deep flex-1 min-h-0 min-w-0 flex flex-col select-none [&_input]:select-text [&_textarea]:select-text [&_[contenteditable]]:select-text"
        style={{
          "padding-top": "env(safe-area-inset-top, 0px)",
          "padding-bottom": "env(safe-area-inset-bottom, 0px)",
        }}
      >
        <Titlebar
          update={update}
          debugTools={
            import.meta.env.DEV
              ? { visible: state.debugTools, toggle: () => setState("debugTools", (value) => !value) }
              : undefined
          }
        />
        <main class="relative flex-1 min-h-0 min-w-0 overflow-x-hidden flex flex-row contain-strict">
          <Show when={homePaneOpen()}>
            <Suspense>
              <HomePaneHost />
            </Suspense>
          </Show>
          <div class="flex-1 min-h-0 min-w-0 flex flex-col items-start">
            <Suspense>{props.children}</Suspense>
          </div>
        </main>
        {import.meta.env.DEV && state.debugTools && <DebugBar inline />}
        <TabsInfoPopup />
        <ToastRegion v2 />
      </div>
    </FolderMissingContext.Provider>
  )
}

// 1.2.7 row 58b (U-8, F-4): the new layout opens projects from Home, its palette and the composer, not through the
// legacy layout's openProject. One shared notice per window (./layout/folder-missing, the same helper as the legacy
// layout) guards those openings through FolderMissingContext, and at start-up the project Home would focus (the last
// opened one, else the first) is checked once: when its folder is gone the notice shows and nothing is opened.
function createNewLayoutFolderMissing() {
  const platform = usePlatform()
  const server = useServer()
  const layout = useLayout()
  const language = useLanguage()
  const serverSync = useServerSync()
  const pickDirectory = useDirectoryPicker()

  // Opening a project in the new layout: it joins the list, becomes the last one and Home focuses it. No navigation.
  const openHere = (directory: string) => () => {
    layout.projects.open(directory)
    server.projects.touch(directory)
    layout.home.setSelection({ server: server.key, directory })
  }

  const notice = createFolderMissingNotice({
    check: () => (server.isLocal() ? platform.checkDirectoryExists : undefined),
    recreate: () => platform.recreateDirectory,
    stored: (directory) =>
      server.projects.last() === directory || layout.projects.list().some((project) => project.worktree === directory),
    t: (key, params) => language.t(key, params),
    choose: () => {
      const conn = server.current
      if (!conn) return
      pickDirectory({
        server: conn,
        title: language.t("command.project.open"),
        multiple: false,
        defaultPath: serverSync().data.path.home,
        onSelect: (result) => {
          const directory = Array.isArray(result) ? result[0] : result
          if (directory) void notice.open(directory, openHere(directory))
        },
      })
    },
  })

  onCleanup(registerFolderMissingNotice(notice))

  onMount(() => {
    void Promise.all([server.ready.promise, layout.ready.promise]).then(() => {
      if (!server.isLocal()) return
      const list = layout.projects.list()
      const last = server.projects.last()
      const directory = list.find((project) => project.worktree === last)?.worktree ?? list[0]?.worktree ?? last
      if (directory) void notice.notice(directory, openHere(directory))
    })
  })

  return notice
}
