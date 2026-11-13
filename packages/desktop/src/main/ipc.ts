import { execFile } from "node:child_process"
import { stat } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from "electron"
import type { IpcMain, IpcMainEvent, IpcMainInvokeEvent, WebContents } from "electron"
import type { DesktopMenuAction } from "@opencode-ai/app/desktop-menu"
import { parseDesktopNativeBundle, type DesktopNativeBundle } from "@opencode-ai/app/i18n/desktop-native"

import type { FatalRendererError, ServerReadyData, TitlebarTheme } from "../preload/types"
import { runDesktopMenuAction } from "./desktop-menu-actions"
import { setForceFocus } from "./debug"
import { assertAttachmentBudget, createPickedFileAuthorizations } from "./attachment-picker"
import { getStore, removeStoreFileIfEmpty } from "./store"
import {
  getPinchZoomEnabled,
  getWindowID,
  isRendererUrl,
  openExternalURL,
  openLocalFileURL,
  setPinchZoomEnabled,
  setTitlebar,
  updateTitlebar,
} from "./windows"
import type { UpdaterController } from "./updater-controller"
import { createUpdaterSubscriptions } from "./updater-subscriptions"
import { createDesktopDraftStore } from "./draft-store"
import { nativeT } from "./native-translations"
import { getLogger } from "./logging"
import { isSetupToolsOfferPending, markSetupToolsOffered } from "./onboarding"
import { createSetupRunner, setupDir, type SetupRunner } from "./setup-runner"
import { createInstallConfirm, registerSetupToolsHandlers } from "./setup-tools-ipc"
import { registerMissionControlHandlers } from "./datum-studio-host/mission-ipc"
import { registerDesktopNonceHandler } from "./desktop-nonce"
import { revealInFolder } from "./reveal-path"
import { registerMissingDirectoryHandlers } from "./missing-directory"
import { MISSION_CONTROL_IPC } from "../preload/mission-control-channels"
import type { MissionControlPlatform } from "../preload/types"

const pickerFilters = (ext?: string[]) => {
  if (!ext || ext.length === 0) return undefined
  return [{ name: nativeT("desktop.dialog.files"), extensions: ext }]
}

const pickedFiles = createPickedFileAuthorizations()

type Deps = {
  killSidecar: () => Promise<void> | void
  relaunch: () => void
  awaitInitialization: () => Promise<ServerReadyData>
  consumeInitialDeepLinks: () => Promise<string[]> | string[]
  getDefaultServerUrl: () => Promise<string | null> | string | null
  setDefaultServerUrl: (url: string | null) => Promise<void> | void
  isFirstLaunchOnboardingPending: () => Promise<boolean> | boolean
  finishFirstLaunchOnboarding: (createDefaultProject: boolean) => Promise<string | null> | string | null
  isOldLayoutEligible: () => Promise<boolean> | boolean
  getDisplayBackend: () => Promise<string | null>
  setDisplayBackend: (backend: string | null) => Promise<void> | void
  checkAppExists: (appName: string) => Promise<boolean> | boolean
  resolveAppPath: (appName: string) => Promise<string | null>
  updater: UpdaterController
  showUpdater: () => Promise<void> | void
  setBackgroundColor: (color: string) => void
  exportDebugLogs: () => Promise<string>
  recordFatalRendererError: (error: FatalRendererError) => Promise<void> | void
  setNativeTranslations: (bundle: DesktopNativeBundle) => void
  /** Row 127: the running DATUM Studio host's mission control client (index.ts: () => datumStudio.missions()). */
  missionControl?: () => MissionControlPlatform | undefined
  /** Row 38b (SEC-06): this launch's desktop nonce when the local sidecar holds it (index.ts, memory only). */
  desktopNonce?: () => string | undefined
  /**
   * 1.2.7 row 25 (N7-126, U-2): the reveal roots of a window: (a) the folders it listed in Mission Control, (b) home.
   * Default: the folders recorded from this file's mission-control list channel plus the home folder.
   */
  revealRoots?: (sender: WebContents) => string[]
}

// 1.2.7 row 25 (U-2, SR7-11): Swarm's own folders a reveal never points at (the home credential places are added by
// reveal-path.ts). Both the inherited XDG folder and its default, since the sidecar may run with either.
// 1.2.7 row 47c (M1-03): split in two, since SR7-13 refuses the folder check only in Swarm's config, state, userData
// and sessionData folders; the data folder holds the session worktrees, which must open as in 1.2.6.
function swarmFolders() {
  const home = app.getPath("home")
  const env = process.env
  const xdg = (name: string, fallback: string) => [env[name], join(home, fallback)].filter((p): p is string => !!p)
  return {
    state: [
      app.getPath("userData"),
      app.getPath("sessionData"),
      ...xdg("XDG_CONFIG_HOME", ".config").map((p) => join(p, "swarm")),
      ...xdg("XDG_STATE_HOME", join(".local", "state")).map((p) => join(p, "swarm")),
    ],
    data: [
      ...xdg("XDG_DATA_HOME", join(".local", "share")).map((p) => join(p, "swarm")),
      ...xdg("XDG_CACHE_HOME", ".cache").map((p) => join(p, "swarm")),
    ],
  }
}

function revealExcluded() {
  const folders = swarmFolders()
  return [...folders.state, ...folders.data]
}

export function registerIpcHandlers(deps: Deps) {
  const drafts = createDesktopDraftStore(join(app.getPath("userData"), "drafts.sqlite"))
  const updaterSubscriptions = createUpdaterSubscriptions()
  app.once("will-quit", updaterSubscriptions.clear)
  app.on("before-quit", () => drafts.flush())
  app.once("will-quit", () => drafts.close())
  app.on("browser-window-created", (_event, win) => win.on("session-end", () => drafts.flush()))

  let setupRunner: SetupRunner | undefined
  app.once("will-quit", () => setupRunner?.dispose())
  // One runner per app (one swarm-setup at a time); 1.2.6 row 91: also handed to tool-health for `swarm-setup start`.
  const runner = () =>
    (setupRunner ??= createSetupRunner({
      dir: setupDir({
        packaged: app.isPackaged,
        resourcesPath: process.resourcesPath,
        devRoot: dirname(fileURLToPath(import.meta.url)),
      }),
      logger: getLogger(),
    }))
  registerSetupToolsHandlers({
    ipcMain,
    windowOf: (sender) => BrowserWindow.fromWebContents(sender),
    isRendererUrl,
    runner,
    confirmInstall: createInstallConfirm({
      windowOf: (sender) => BrowserWindow.fromWebContents(sender),
      showMessageBox: (win, options) => (win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options)),
      t: nativeT,
    }),
    isOfferPending: isSetupToolsOfferPending,
    markOffered: markSetupToolsOffered,
    log: (message, meta) => getLogger().log(message, meta),
  })
  // 1.2.7 row 25 (U-2, R-1 (a)): the folders each window listed in Mission Control, recorded after an ok list.
  const listedFolders = new WeakMap<object, Set<string>>()
  const revealRoots =
    deps.revealRoots ??
    ((sender: WebContents) => [...(listedFolders.get(sender) ?? [])].concat(app.getPath("home")))
  // Mission control (row 127): four channels, validated in main; the host token never leaves main.
  registerMissionControlHandlers({
    ipcMain: {
      handle: (channel: string, listener: Parameters<IpcMain["handle"]>[1]) =>
        ipcMain.handle(channel, async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
          const result = await listener(event, ...args)
          const directory = (args[0] as { directory?: unknown } | undefined)?.directory
          if (channel === MISSION_CONTROL_IPC.list && (result as { ok?: unknown })?.ok === true && typeof directory === "string") {
            const known = listedFolders.get(event.sender) ?? new Set<string>()
            known.add(directory)
            listedFolders.set(event.sender, known)
          }
          return result
        }),
    },
    windowOf: (sender) => BrowserWindow.fromWebContents(sender),
    isRendererUrl,
    client: () => deps.missionControl?.(),
    log: (level, message, context) => getLogger()[level](message, { source: "mission-control", ...context }),
  })
  // Row 38b (SEC-06): the app's renderer reads the nonce for the revert and archive-empty calls; other senders get null.
  registerDesktopNonceHandler({
    ipcMain,
    windowOf: (sender) => BrowserWindow.fromWebContents(sender),
    isRendererUrl,
    nonce: () => deps.desktopNonce?.(),
  })
  ipcMain.handle("kill-sidecar", () => deps.killSidecar())
  ipcMain.handle("await-initialization", () => deps.awaitInitialization())
  ipcMain.handle("consume-initial-deep-links", () => deps.consumeInitialDeepLinks())
  ipcMain.handle("get-default-server-url", () => deps.getDefaultServerUrl())
  ipcMain.handle("set-default-server-url", (_event: IpcMainInvokeEvent, url: string | null) =>
    deps.setDefaultServerUrl(url),
  )
  ipcMain.handle("is-first-launch-onboarding-pending", () => deps.isFirstLaunchOnboardingPending())
  ipcMain.handle("finish-first-launch-onboarding", (_event: IpcMainInvokeEvent, createDefaultProject: boolean) =>
    deps.finishFirstLaunchOnboarding(createDefaultProject),
  )
  ipcMain.handle("is-old-layout-eligible", () => deps.isOldLayoutEligible())
  ipcMain.handle("get-display-backend", () => deps.getDisplayBackend())
  ipcMain.handle("set-display-backend", (_event: IpcMainInvokeEvent, backend: string | null) =>
    deps.setDisplayBackend(backend),
  )
  ipcMain.handle("check-app-exists", (_event: IpcMainInvokeEvent, appName: string) => deps.checkAppExists(appName))
  // 1.2.7 row 32 (U-8, SR7-13): check-directory-exists (stat only) and recreate-directory (leaf only, only a path this
  // window found missing). Nothing runs here at startup; the app calls them, and recreate only after a user click.
  registerMissingDirectoryHandlers({
    ipcMain,
    home: app.getPath("home"),
    excluded: swarmFolders().state,
    recreateExcluded: swarmFolders().data,
    isTrustedSender: (event) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      return !!win && !win.isDestroyed() && event.senderFrame === event.sender.mainFrame && isRendererUrl(event.sender.getURL())
    },
    log: (level, message, context) => getLogger()[level](message, context),
  })
  ipcMain.handle("resolve-app-path", (_event: IpcMainInvokeEvent, appName: string) => deps.resolveAppPath(appName))
  ipcMain.handle("updater-subscribe", (event) => {
    const id = event.sender.id
    updaterSubscriptions.set(
      id,
      deps.updater.subscribe((state) => {
        if (event.sender.isDestroyed()) return updaterSubscriptions.delete(id)
        event.sender.send("updater-state", state)
      }),
    )
    event.sender.once("destroyed", () => updaterSubscriptions.delete(id))
  })
  ipcMain.handle("updater-unsubscribe", (event) => updaterSubscriptions.delete(event.sender.id))
  ipcMain.handle("updater-check", () => deps.updater.check())
  ipcMain.handle("updater-install", () => deps.updater.install())
  ipcMain.handle("set-background-color", (_event: IpcMainInvokeEvent, color: string) => deps.setBackgroundColor(color))
  ipcMain.handle("export-debug-logs", () => deps.exportDebugLogs())
  ipcMain.handle("set-force-focus", (event: IpcMainInvokeEvent, enabled: boolean) =>
    setForceFocus(event.sender, enabled),
  )
  ipcMain.handle("record-fatal-renderer-error", (_event: IpcMainInvokeEvent, error: FatalRendererError) =>
    deps.recordFatalRendererError(error),
  )
  ipcMain.handle("set-native-translations", (event: IpcMainInvokeEvent, value: unknown) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || win.isDestroyed() || win.webContents !== event.sender || event.senderFrame !== event.sender.mainFrame) {
      throw new Error("Invalid native translation sender")
    }
    const bundle = parseDesktopNativeBundle(value)
    if (!bundle) throw new Error("Invalid native translation bundle")
    deps.setNativeTranslations(bundle)
  })
  ipcMain.handle("store-get", (_event: IpcMainInvokeEvent, name: string, key: string) => {
    try {
      const store = getStore(name)
      const value = store.get(key)
      if (value === undefined || value === null) return null
      return typeof value === "string" ? value : JSON.stringify(value)
    } catch {
      return null
    }
  })
  ipcMain.handle("store-set", (_event: IpcMainInvokeEvent, name: string, key: string, value: string) => {
    getStore(name).set(key, value)
  })
  ipcMain.handle("store-delete", (_event: IpcMainInvokeEvent, name: string, key: string) => {
    getStore(name).delete(key)
    void removeStoreFileIfEmpty(name)
  })
  ipcMain.handle("store-clear", (_event: IpcMainInvokeEvent, name: string) => {
    getStore(name).clear()
    void removeStoreFileIfEmpty(name)
  })
  ipcMain.handle("store-keys", (_event: IpcMainInvokeEvent, name: string) => {
    const store = getStore(name)
    return Object.keys(store.store)
  })
  ipcMain.handle("store-length", (_event: IpcMainInvokeEvent, name: string) => {
    const store = getStore(name)
    return Object.keys(store.store).length
  })
  ipcMain.handle("draft-get", (_event, key: string) => drafts.get(key))
  ipcMain.handle("draft-set", (_event, key: string, value: string) => drafts.set(key, value))
  ipcMain.handle("draft-delete", (_event, key: string) => drafts.set(key, null))
  ipcMain.handle("draft-blob-put", (_event, data: ArrayBuffer) => drafts.putBlob(new Uint8Array(data)))
  ipcMain.handle("draft-blob-get", (_event, id: string) => {
    const data = drafts.getBlob(id)
    return data ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) : null
  })

  ipcMain.handle(
    "open-directory-picker",
    async (_event: IpcMainInvokeEvent, opts?: { multiple?: boolean; title?: string; defaultPath?: string }) => {
      const result = await dialog.showOpenDialog({
        properties: ["openDirectory", ...(opts?.multiple ? ["multiSelections" as const] : []), "createDirectory"],
        title: opts?.title ?? nativeT("desktop.dialog.chooseFolder"),
        defaultPath: opts?.defaultPath,
      })
      if (result.canceled) return null
      return opts?.multiple ? result.filePaths : result.filePaths[0]
    },
  )

  ipcMain.handle(
    "open-file-picker",
    async (
      event: IpcMainInvokeEvent,
      opts?: { multiple?: boolean; title?: string; defaultPath?: string; extensions?: string[] },
    ) => {
      const result = await dialog.showOpenDialog({
        properties: ["openFile", ...(opts?.multiple ? ["multiSelections" as const] : [])],
        title: opts?.title ?? nativeT("desktop.dialog.chooseFile"),
        defaultPath: opts?.defaultPath,
        filters: pickerFilters(opts?.extensions),
      })
      if (result.canceled) return null
      const files = await Promise.all(
        result.filePaths.map(async (filePath) => ({
          path: filePath,
          name: basename(filePath),
          size: (await stat(filePath)).size,
        })),
      )
      assertAttachmentBudget(files)
      const token = pickedFiles.add(event.sender.id, result.filePaths)
      return { token, files }
    },
  )

  ipcMain.handle("read-picked-file", async (event: IpcMainInvokeEvent, token: string, filePath: string) => {
    return pickedFiles.read(event.sender.id, token, filePath)
  })

  ipcMain.handle("release-picked-files", (event: IpcMainInvokeEvent, token: string) => {
    pickedFiles.release(event.sender.id, token)
  })

  ipcMain.handle(
    "save-file-picker",
    async (_event: IpcMainInvokeEvent, opts?: { title?: string; defaultPath?: string }) => {
      const result = await dialog.showSaveDialog({
        title: opts?.title ?? nativeT("desktop.dialog.saveFile"),
        defaultPath: opts?.defaultPath,
      })
      if (result.canceled) return null
      return result.filePath ?? null
    },
  )

  ipcMain.on("open-external", (_event: IpcMainEvent, url: string) => {
    openExternalURL(url)
  })

  ipcMain.on("open-local-file", (_event: IpcMainEvent, url: string) => {
    openLocalFileURL(url)
  })

  ipcMain.handle("open-path", async (_event: IpcMainInvokeEvent, path: string, app?: string) => {
    if (!app) return shell.openPath(path)
    await new Promise<void>((resolve, reject) => {
      const [cmd, args] =
        process.platform === "darwin" ? (["open", ["-a", app, path]] as const) : ([app, [path]] as const)
      execFile(cmd, args, (err) => (err ? reject(err) : resolve()))
    })
  })

  // 1.2.7 row 25 (U-2, SR7-11): only a path inside this window's roots and outside Swarm's and the credential places;
  // shell.showItemInFolder only, never openPath/openExternal (a `.command` or `.app` is shown, never launched).
  ipcMain.handle("reveal-path", async (event: IpcMainInvokeEvent, path: unknown) =>
    revealInFolder(path, revealRoots(event.sender), {
      shell,
      home: app.getPath("home"),
      excluded: revealExcluded(),
      log: (level, message, context) => getLogger()[level](message, context),
    }),
  )

  ipcMain.handle("read-clipboard-image", () => {
    const image = clipboard.readImage()
    if (image.isEmpty()) return null
    const buffer = image.toPNG().buffer
    const size = image.getSize()
    return { buffer, width: size.width, height: size.height }
  })

  ipcMain.handle("get-window-id", (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) throw new Error("Window not found")
    const id = getWindowID(win)
    if (!id) throw new Error("Window ID not found")
    return id
  })

  ipcMain.handle("get-window-focused", (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    return win?.isFocused() ?? false
  })

  ipcMain.handle("get-window-fullscreen", (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    return win?.isFullScreen() ?? false
  })

  ipcMain.handle("set-window-focus", (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    win?.focus()
  })

  ipcMain.handle("show-window", (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    win?.show()
  })

  ipcMain.on("relaunch", () => {
    deps.relaunch()
  })

  ipcMain.handle("get-zoom-factor", (event: IpcMainInvokeEvent) => event.sender.getZoomFactor())
  ipcMain.handle("set-zoom-factor", (event: IpcMainInvokeEvent, factor: number) => {
    event.sender.setZoomFactor(factor)
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    updateTitlebar(win)
  })
  ipcMain.handle("get-pinch-zoom-enabled", () => getPinchZoomEnabled())
  ipcMain.handle("set-pinch-zoom-enabled", (_event: IpcMainInvokeEvent, enabled: boolean) => {
    setPinchZoomEnabled(enabled)
  })
  ipcMain.handle("set-titlebar", (event: IpcMainInvokeEvent, theme: TitlebarTheme) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    setTitlebar(win, theme)
  })
  ipcMain.handle("run-desktop-menu-action", (event: IpcMainInvokeEvent, action: DesktopMenuAction) => {
    runDesktopMenuAction(BrowserWindow.fromWebContents(event.sender), action, {
      checkForUpdates: () => void deps.showUpdater(),
      relaunch: deps.relaunch,
    })
  })
  return { setupRunner: runner }
}

export function sendMenuCommand(win: BrowserWindow, id: string) {
  win.webContents.send("menu-command", id)
}

export function sendDeepLinks(win: BrowserWindow, urls: string[]) {
  win.webContents.send("deep-link", urls)
}
