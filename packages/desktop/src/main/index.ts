import "../../../core/src/swarm-defaults"
import { randomUUID } from "node:crypto"
import * as http from "node:http"
import { createServer } from "node:net"
import { homedir } from "node:os"
import { join } from "node:path"
import { getCACertificates, setDefaultCACertificates } from "node:tls"
import type { Event, MessageBoxOptions } from "electron"
import { app, BrowserWindow, dialog } from "electron"

import { Deferred, Effect, Fiber } from "effect"

import type { ServerReadyData } from "../preload/types"
import { checkAppExists, resolveAppPath } from "./apps"
import { CHANNEL } from "./constants"
import { registerIpcHandlers, sendDeepLinks, sendMenuCommand } from "./ipc"
import { createDesktopNonce } from "./desktop-nonce"
import { forwardInitializationFailure } from "./initialization"
import { exportDebugLogs, initCrashReporter, initLogging, startNetLog, write as writeLog } from "./logging"
import { createMenu } from "./menu"
import {
  finishFirstLaunchOnboarding,
  initializeOldLayoutEligibility,
  isFirstLaunchOnboardingPending,
  isOldLayoutEligible,
} from "./onboarding"
import { prepareOnboardingTestRoot } from "./onboarding-test-root"
import { applyLoopbackProxyBypass } from "./proxy-bypass"
import {
  getDefaultServerUrl,
  preferAppEnv,
  setDefaultServerUrl,
  spawnLocalServer,
  type SidecarListener,
} from "./server"
import { setupAutoUpdater, showUpdaterDialog } from "./updater"
import { safeWebContentsURL } from "./window-state"
import {
  getLastFocusedWindow,
  registerRendererProtocol,
  setRelaunchHandler,
  setAppQuitting,
  setBackgroundColor,
  setDockIcon,
  restoreMainWindows,
} from "./windows"
import { createWslServersController } from "./wsl/servers"
import { registerWslIpcHandlers } from "./wsl/ipc"
import { spawnWslSidecar } from "./wsl/sidecar"
import { migrate } from "./migrate"
import { cleanupStoreFiles } from "./store-cleanup"
import { startBackgroundCli } from "./background-cli"
import { nativeT, setNativeTranslations } from "./native-translations"
import { aboutPanelOptions } from "./about-panel"
import { appServerFilePath, appStateHome, removeAppServerFile, writeAppServerFile } from "./app-server-file"
import { cliLauncherPath, createCliInstaller, createDatumStudioInstaller, datumStudioLauncherPath } from "./cli-install"
import { createExecFileRunner, createPatchFlowGuard, patchApplierPath, runPatchStatus } from "./patch-common"
import { createPatchUpdateFlow } from "./patch-update-flow"
import { createUndoLastUpdate } from "./patch-undo"
import { createHandoffLauncher } from "./swarm-patch-handoff"
import { createPatchResultReader, HANDOFF_RESULT_FILE_NAME } from "./swarm-patch-result"
import { createDatumStudio } from "./datum-studio-host/start"
import { startRenderBridge } from "./datum-render"
import { createRenderEnvGate } from "./sidecar-env"
import { createToolHealth } from "./tool-health/startup"
import { refreshStagedProxy } from "./proxy-refresh"
import { crashSignalListenerReport, getStore } from "./store"
import { createMemoryWatch } from "./memory-watch"
import { OFFICE_ADDIN_ENABLED_KEY } from "./store-keys"
import type { OfficeAddinController } from "./office-addin/controller"

// Row 33: longest the sidecar spawn waits for the render bridge (normally a socket listen, milliseconds).
const SIDECAR_RENDER_ENV_WAIT_MS = 5_000

const APP_NAMES: Record<string, string> = {
  dev: "Swarm Dev",
  beta: "Swarm Beta",
  prod: "Swarm",
}
const APP_IDS: Record<string, string> = {
  dev: "id.co.gsp.swarm.desktop.dev",
  beta: "id.co.gsp.swarm.desktop.beta",
  prod: "id.co.gsp.swarm.desktop",
}
// Row 175 (user 2026-11-08): About shows name, version and the build commit date only. The MIT/OpenCode
// notices keep shipping as Resources/LICENSE, NOTICE, THIRD_PARTY_LICENSES.txt (electron-builder.config.ts).
const BUILD_DATE: string | undefined = import.meta.env.SWARM_BUILD_DATE
const setAboutPanel = (locale: string) =>
  app.setAboutPanelOptions(aboutPanelOptions({ name: app.getName(), version: app.getVersion(), buildDate: BUILD_DATE, locale }))
const TEST_ONBOARDING = process.env.OPENCODE_TEST_ONBOARDING === "1"
const SIDECAR_VERSION = process.env.OPENCODE_SIDECAR_V2 === "1" ? "v2" : "v1"
const jsCallStackFeature = "DocumentPolicyIncludeJSCallStacksInCrashReports"

let logger: ReturnType<typeof initLogging>
let server: SidecarListener | null = null

const pendingDeepLinks: string[] = []

function useEnvProxy() {
  try {
    // Electron 41.2 runs Node 24.14.1; latest @types/node@24 is 24.12.2.
    ;(http as any).setGlobalProxyFromEnv()
  } catch (error) {
    logger.warn("failed to load proxy environment", error)
  }
}

function emitDeepLinks(urls: string[]) {
  if (urls.length === 0) return
  pendingDeepLinks.push(...urls)
  const win = getLastFocusedWindow()
  if (win) sendDeepLinks(win, urls)
}

async function killSidecar(options?: { resume?: boolean }) {
  if (!server) return
  const current = server
  server = null
  await current.stop(options)
}

function ensureLoopbackNoProxy() {
  const loopback = ["127.0.0.1", "localhost", "::1"]
  const upsert = (key: string) => {
    const items = (process.env[key] ?? "")
      .split(",")
      .map((value: string) => value.trim())
      .filter((value: string) => Boolean(value))

    for (const host of loopback) {
      if (items.some((value: string) => value.toLowerCase() === host)) continue
      items.push(host)
    }

    process.env[key] = items.join(",")
  }

  upsert("NO_PROXY")
  upsert("no_proxy")
}

const main = Effect.gen(function* () {
  // 1.3.4 (T-06): the context menu is attached per app window in windows.ts (wireContextMenu), not app-wide. The
  // app-wide form registered every BrowserWindow, including each hidden render window, and kept them all.

  // on macOS apps run in `/` which can cause issues with ripgrep
  try {
    process.chdir(homedir())
  } catch {}

  process.env.OPENCODE_DISABLE_EMBEDDED_WEB_UI = "true"

  const appId = app.isPackaged ? APP_IDS[CHANNEL] : "id.co.gsp.swarm.desktop.dev"
  const onboardingTestRoot = prepareOnboardingTestRoot(process.env)
  app.setName(app.isPackaged ? APP_NAMES[CHANNEL] : "Swarm Dev")
  app.setAppUserModelId(appId)
  setAboutPanel("id")
  app.setPath(
    "userData",
    onboardingTestRoot ? join(onboardingTestRoot, "desktop") : join(app.getPath("appData"), appId),
  )
  if (onboardingTestRoot) app.setPath("sessionData", join(onboardingTestRoot, "session"))
  initializeOldLayoutEligibility(app.getPath("userData"))
  logger = initLogging()
  initCrashReporter()

  const wslServers = createWslServersController(
    app.getVersion(),
    async (distro) => {
      logger.log("spawning wsl sidecar", { distro })
      return spawnWslSidecar(distro, {
        onLine: (line) => logger.log("wsl sidecar", { distro, stream: line.stream, text: line.text }),
      })
    },
    {
      logger: {
        log: (message, meta) => logger.log(message, meta),
        error: (message, meta) => logger.error(message, meta),
      },
    },
  )
  // M7-05: the Office add-in controller (loadOfficeAddin below); its bridge stop runs beside the sidecar stop (IM-09).
  const officeAddin: { loading?: Promise<OfficeAddinController>; controller?: OfficeAddinController } = {}
  const stopSidecars = async (options?: { resume?: boolean }) => {
    await Promise.all([
      killSidecar(options),
      officeAddin.loading
        ?.then((controller) => controller.shutdown())
        .catch((error) => logger.error("office add-in shutdown failed", error)),
    ])
    wslServers.stopAll()
  }
  const relaunch = (options?: { resume?: boolean }) => {
    setAppQuitting()
    void stopSidecars(options).finally(() => {
      app.relaunch()
      app.quit()
    })
  }
  // 1.3.4 (T-12): the person chose Restart in the menu or accepted the memory reopen. The running agent turns carry on
  // after the relaunch (the sidecar hands its run leases over) instead of being stopped and left idle.
  const relaunchAndResume = () => relaunch({ resume: true })
  // The app's normal quit, without app.relaunch (also H4 of the patch handoff: the wrapper relaunches after the applier).
  const quit = () => {
    setAppQuitting()
    void stopSidecars().finally(() => app.quit())
  }

  try {
    setDefaultCACertificates([...new Set([...getCACertificates("default"), ...getCACertificates("system")])])
  } catch (error) {
    logger.warn("failed to load system certificates", error)
  }

  logger.log("app starting", {
    version: app.getVersion(),
    packaged: app.isPackaged,
    onboardingTest: Boolean(onboardingTestRoot),
  })

  ensureLoopbackNoProxy()
  useEnvProxy()
  // AC-R5: loopback always bypasses any proxy (fixed, PAC, system); `<-loopback>` used to send it to a fixed proxy.
  applyLoopbackProxyBypass(app.commandLine)
  const features = app.commandLine.getSwitchValue("enable-features")
  app.commandLine.appendSwitch("enable-features", features ? `${jsCallStackFeature},${features}` : jsCallStackFeature)
  if (!app.isPackaged) app.commandLine.appendSwitch("remote-debugging-port", "9222")

  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return
  }

  const shellEnv = preferAppEnv(app.getPath("userData"))
  // After preferAppEnv this is the state root the sidecar uses; the swarm command is pointed at the same one (C120).
  const stateHome = appStateHome(process.env, app.getPath("userData"))
  const serverFile = appServerFilePath(stateHome)

  app.on("second-instance", (_event: Event, argv: string[]) => {
    const urls = argv.filter((arg: string) => arg.startsWith("swarm://"))
    if (urls.length) {
      logger.log("deep link received via second-instance", { urls })
      emitDeepLinks(urls)
    }
    const win = getLastFocusedWindow()
    if (win) {
      win.show()
      win.focus()
    }
  })

  app.on("open-url", (event: Event, url: string) => {
    event.preventDefault()
    logger.log("deep link received via open-url", { url })
    emitDeepLinks([url])
  })

  app.on("before-quit", () => {
    setAppQuitting()
    void stopSidecars()
  })

  app.on("will-quit", () => {
    setAppQuitting()
    removeAppServerFile(serverFile)
    void stopSidecars()
  })

  app.on("child-process-gone", (_event, details) => {
    writeLog("utility", "child process gone", { details }, "error")
  })

  app.on("render-process-gone", (_event, webContents, details) => {
    writeLog("window", "app render process gone", { url: safeWebContentsURL(webContents), details }, "error")
  })

  setRelaunchHandler(() => {
    relaunch()
  })

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, quit)
  }

  const serverReady = Deferred.makeUnsafe<ServerReadyData, unknown>()
  // Row 38b (SEC-06): one desktop nonce per launch, in memory only. It goes to the local sidecar in its start message
  // and to the renderer over IPC (desktopNonce), never to env, disk or a log. Held for the renderer only once the
  // local sidecar was started with it (not for the v2 background CLI).
  const desktopNonce = createDesktopNonce()
  let localDesktopNonce: string | undefined

  yield* Effect.promise(() => app.whenReady())

  if (!TEST_ONBOARDING) migrate()
  yield* Effect.promise(() => cleanupStoreFiles(app.getPath("userData"))).pipe(
    Effect.tap((result) =>
      Effect.sync(() => {
        if (result.deleted.length === 0) return
        logger.log("cleaned scoped store files", { count: result.deleted.length, scanned: result.scanned })
      }),
    ),
    Effect.catch((error) =>
      Effect.sync(() => {
        logger.warn("failed to clean scoped store files", error)
      }),
    ),
  )
  app.setAsDefaultProtocolClient("swarm")
  registerRendererProtocol()
  setDockIcon()
  // DATUM Studio (row 111): render bridge + datum-studio-host utility process; started in the background, and the
  // first quit waits for its stop (descriptor removed, store lock released; bounded by the host stop timeout).
  // Row 33: the same bridge's DATUM_RENDER_* also go to the sidecar (createSidecarEnv), for datum-python in its shell.
  const sidecarRenderEnv = createRenderEnvGate()
  const datumStudio = createDatumStudio({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
    stateHome,
    env: process.env,
    log: (level, source, message, context) => writeLog(source, message, context, level),
    startBridge: (options) => sidecarRenderEnv.track(startRenderBridge(options)),
  })
  void datumStudio.start()
  app.on("before-quit", (event) => datumStudio.holdQuit(event, () => app.quit()))
  // U7 tool-health (1.2.6 row 91, TH-02): probes once per launch in the background; never awaited here, so window
  // creation and the sidecar spawn are never delayed. Revives only installed AND previously healthy tools and never
  // installs (D6). The setup runner is the IPC layer's one instance (assigned below), so a revive during a user install
  // is refused SETUP_BUSY.
  let ipcSetupRunner: ReturnType<typeof registerIpcHandlers>["setupRunner"] | undefined
  // 1.3.0 row 132 (AC-S6a, F4): refresh an already staged swarm-web-proxy from this bundle once per packaged launch,
  // synchronously, before tool-health probes it and before the sidecar spawns the MCP servers. Never creates
  // ~/.swarm; logs one fixed code.
  refreshStagedProxy({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    home: homedir(),
    log: (level, code, context) => writeLog("proxy-refresh", code, context, level),
  })
  const toolHealth = createToolHealth({
    home: homedir(),
    platform: process.platform,
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
    appVersion: app.getVersion(),
    setupRunner: () => ipcSetupRunner?.(),
    datumStudio,
    log: (level, message, context) => writeLog("tool-health", message, context, level),
  })
  void toolHealth.runStartup()
  app.on("before-quit", () => toolHealth.stop())
  const updater = setupAutoUpdater(stopSidecars)
  // Update from File… / Undo Last Update (rows 56-59). One handoff launcher (row 57) and one M8 guard for both flows;
  // each flow is created once and run per click. The launcher calls `quit` itself once the wrapper has spawned (H4);
  // neither flow has an exit step of its own. Both keep the guard after a started handoff (C27 D-1).
  const launchHandoff = createHandoffLauncher(
    { resourcesPath: process.resourcesPath, userData: app.getPath("userData"), home: homedir() },
    { logger, quit },
  )
  const handoff = (applierArgv: readonly string[]) => launchHandoff([...applierArgv])
  const patchGuard = createPatchFlowGuard()
  // Language of the memory-watch offer (row 19); follows the renderer's language like the menu does.
  let memoryWatchLocale = "en"
  const patchWindow = () => getLastFocusedWindow() ?? null
  const patchMessageBox = (win: BrowserWindow | null, options: MessageBoxOptions) =>
    win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options)
  const patchLog = (level: "info" | "warn" | "error", message: string, extra?: Record<string, unknown>) =>
    writeLog("swarm-patch", message, extra, level)
  // SB-1 (rows 18, 19). Row 18's seam: what the store's signal pass removed, logged once (its catch path only
  // returns `error`). Then the memory watch: one "main memory" line per minute, one event per threshold, and the
  // offer of a controlled reopen through the same message box and the same `relaunch` as the menu's Reload.
  const crashSignals = crashSignalListenerReport()
  writeLog(
    "main",
    "crash signal listeners",
    { ...crashSignals },
    crashSignals.error || crashSignals.remaining !== 0 ? "error" : "info",
  )
  const memoryWatch = createMemoryWatch({
    clock: {
      setInterval: (fn, ms) => {
        const timer = setInterval(fn, ms)
        timer.unref()
        return timer
      },
      clearInterval: (timer) => clearInterval(timer as ReturnType<typeof setInterval>),
    },
    readMemory: () => process.memoryUsage(),
    showMessageBox: (options) => patchMessageBox(patchWindow(), options),
    relaunch: relaunchAndResume,
    log: writeLog,
    locale: () => memoryWatchLocale,
  })
  memoryWatch.start()
  app.once("will-quit", () => memoryWatch.stop())
  const updateFromFile = createPatchUpdateFlow({
    window: patchWindow,
    showOpenDialog: (win, options) => (win ? dialog.showOpenDialog(win, options) : dialog.showOpenDialog(options)),
    showMessageBox: patchMessageBox,
    t: nativeT,
    resourcesPath: process.resourcesPath,
    home: homedir(),
    handoff,
    log: patchLog,
    guard: patchGuard,
  })
  const undoLastUpdate = createUndoLastUpdate({
    window: patchWindow,
    showMessageBox: patchMessageBox,
    handoff,
    resourcesPath: () => process.resourcesPath,
    log: {
      info: (message, meta) => patchLog("info", message, meta),
      error: (message, meta) => patchLog("error", message, meta),
    },
    guard: patchGuard,
  })
  const menuDeps = {
    trigger: (id: string) => {
      const win = getLastFocusedWindow()
      if (win) sendMenuCommand(win, id)
    },
    checkForUpdates: () => void showUpdaterDialog(updater, true),
    installCli: () =>
      void createCliInstaller({
        window: () => getLastFocusedWindow() ?? null,
        showMessageBox: (win, options) => (win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options)),
        t: nativeT,
        launcher: cliLauncherPath(process.resourcesPath),
        stateHome,
        binDir: join(homedir(), ".local", "bin"),
        pathEnv: () => shellEnv?.PATH ?? process.env.PATH,
      })().catch((error) => logger.error("install command line tool failed", error)),
    // Install DATUM Studio for Claude (rows 34/34b): same consent flow; the done dialog shows the `claude mcp add` line.
    installDatumStudio: () =>
      void createDatumStudioInstaller({
        window: () => getLastFocusedWindow() ?? null,
        showMessageBox: (win, options) => (win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options)),
        t: nativeT,
        launcher: datumStudioLauncherPath(process.resourcesPath),
        stateHome,
        binDir: join(homedir(), ".local", "bin"),
        pathEnv: () => shellEnv?.PATH ?? process.env.PATH,
      })().catch((error) => logger.error("install DATUM Studio for Claude failed", error)),
    relaunch: relaunchAndResume,
    updateFromFile: () => void updateFromFile().catch((error) => logger.error("update from file failed", error)),
    undoLastUpdate: () => void undoLastUpdate().catch((error) => logger.error("undo last update failed", error)),
    // SEC-05 / C9: person trigger; may revive consent "manual" tools (an agent's recheck.json cannot).
    recheckTools: () => void toolHealth.recheck().catch((error) => logger.error("tool-health re-check failed", error)),
  }
  // M7-05 (SD §5.3, §5.4; IM-07): the Office add-in controller is loaded by import() only on auto-start or a menu click,
  // so with the setting off nothing is parsed, forked or written (no office-addin/ folder, SD-AC-2).
  const loadOfficeAddin = () => {
    officeAddin.loading ??= (async () => {
      const { createOfficeAddinController } = await import("./office-addin/controller")
      const { electronPairDialogDeps } = await import("./office-addin/pair-dialog")
      const { safeStorage, shell, utilityProcess } = await import("electron")
      officeAddin.controller = createOfficeAddinController({
        userDataDir: app.getPath("userData"),
        // C33: packaged pane and manifest under Resources/office-addin; dev reads packages/office-addin.
        resources: {
          packaged: app.isPackaged,
          resourcesPath: process.resourcesPath,
          devPackageDir: join(app.getAppPath(), "..", "office-addin"),
        },
        bridgeEntryPath: join(import.meta.dirname, "office-bridge.js"),
        baseEnv: process.env,
        server: async () => {
          const ready = await Effect.runPromise(Deferred.await(serverReady))
          return ready.username && ready.password
            ? { url: ready.url, username: ready.username, password: ready.password }
            : undefined
        },
        settings: {
          enabled: () => getStore().get(OFFICE_ADDIN_ENABLED_KEY) === true,
          setEnabled: (value) => getStore().set(OFFICE_ADDIN_ENABLED_KEY, value),
        },
        fork: (modulePath, args, options) => utilityProcess.fork(modulePath, args, options),
        dialog: { showMessageBox: (options) => dialog.showMessageBox(options) },
        shell: { showItemInFolder: (path) => shell.showItemInFolder(path), openPath: (path) => shell.openPath(path) },
        pairDialog: electronPairDialogDeps({ dialog, app, window: () => getLastFocusedWindow() ?? null }),
        safeStorage,
        log: (level, source, message, context) => writeLog(source, message, context, level),
        onStateChange: () => rebuildMenu(),
      })
      return officeAddin.controller
    })().catch((error: unknown) => {
      officeAddin.loading = undefined
      throw error
    })
    return officeAddin.loading
  }
  const officeAddinAction = (name: "officeAddinToggle" | "officeAddinDisconnect" | "officeAddinClearCache") => () =>
    void loadOfficeAddin()
      .then((controller) => controller.menuHandlers()[name]())
      .catch((error) => logger.error("office add-in menu action failed", error))
  // IA-2: the one place the menu is built (locale change, window start, Office state change).
  const rebuildMenu = () =>
    createMenu({
      ...menuDeps,
      officeAddinState: () => officeAddin.controller?.state() ?? "off",
      officeAddinToggle: SIDECAR_VERSION === "v2" ? undefined : officeAddinAction("officeAddinToggle"),
      officeAddinDisconnect: officeAddinAction("officeAddinDisconnect"),
      officeAddinClearCache: officeAddinAction("officeAddinClearCache"),
    })
  const ipc = registerIpcHandlers({
    killSidecar: () => killSidecar(),
    relaunch,
    awaitInitialization: Effect.fnUntraced(
      function* () {
        logger.log("awaiting server ready")
        const res = yield* Deferred.await(serverReady)
        logger.log("server ready", { url: res.url })
        return res
      },
      (e) => Effect.runPromise(e),
    ),
    consumeInitialDeepLinks: () => pendingDeepLinks.splice(0),
    getDefaultServerUrl: () => getDefaultServerUrl(),
    setDefaultServerUrl: (url) => setDefaultServerUrl(url),
    isFirstLaunchOnboardingPending,
    finishFirstLaunchOnboarding,
    isOldLayoutEligible,
    getDisplayBackend: async () => null,
    setDisplayBackend: async () => undefined,
    checkAppExists: (appName) => checkAppExists(appName),
    resolveAppPath: async (appName) => resolveAppPath(appName),
    updater,
    showUpdater: () => showUpdaterDialog(updater, true),
    setBackgroundColor: (color) => setBackgroundColor(color),
    exportDebugLogs: () => exportDebugLogs(),
    recordFatalRendererError: (error) => writeLog("renderer", "fatal renderer error", { ...error }, "error"),
    setNativeTranslations: (bundle) => {
      memoryWatchLocale = bundle.locale
      if (setNativeTranslations(bundle)) {
        rebuildMenu()
        setAboutPanel(bundle.locale)
      }
    },
    missionControl: () => datumStudio.missions(),
    desktopNonce: () => localDesktopNonce,
  })
  ipcSetupRunner = ipc.setupRunner
  registerWslIpcHandlers(wslServers)
  void updater.start()
  const updateTimer = setInterval(() => void updater.check(), 10 * 60 * 1000)
  updateTimer.unref()
  app.once("will-quit", () => clearInterval(updateTimer))
  yield* Effect.promise(() => startNetLog()).pipe(
    Effect.catch((error) =>
      Effect.sync(() => {
        logger.warn("failed to start net log", error)
      }),
    ),
  )

  const loadingTask = yield* Effect.gen(function* () {
    logger.log("sidecar connection started", { version: SIDECAR_VERSION })

    ensureLoopbackNoProxy()
    useEnvProxy()

    if (SIDECAR_VERSION === "v2") {
      logger.log("spawning v2 sidecar")
      const sidecar = yield* Effect.promise(() => startBackgroundCli(logger, shellEnv?.XDG_STATE_HOME))
      yield* Deferred.succeed(serverReady, {
        url: sidecar.url,
        username: sidecar.username,
        password: sidecar.password,
      })

      if (process.platform === "win32") {
        void wslServers.initialize().catch((error) => logger.error("wsl server initialization failed", error))
      }

      logger.log("loading task finished")
      return
    }

    const port = yield* Effect.gen(function* () {
      const fromEnv = process.env.OPENCODE_PORT
      if (fromEnv) {
        const parsed = Number.parseInt(fromEnv, 10)
        if (!Number.isNaN(parsed)) return parsed
      }

      const res = yield* Deferred.make<number, unknown>()
      const socket = createServer()
      socket.on("error", (e) => Deferred.failSync(res, () => e))
      socket.listen(0, "127.0.0.1", () => {
        const address = socket.address()
        if (typeof address !== "object" || !address) {
          socket.close()
          Deferred.failSync(res, () => new Error("Failed to get port"))
          return
        }
        const port = address.port
        socket.close(() => Effect.runSync(Deferred.succeed(res, port)))
      })

      return yield* Deferred.await(res)
    })
    const hostname = "127.0.0.1"
    const url = `http://${hostname}:${port}`
    const password = randomUUID()

    logger.log("spawning sidecar", { url })
    const renderEnv = yield* Effect.promise(() => sidecarRenderEnv.wait(SIDECAR_RENDER_ENV_WAIT_MS))
    if (!renderEnv) logger.warn("sidecar starts without the DATUM render bridge")
    localDesktopNonce = desktopNonce
    const { listener, health } = yield* Effect.promise(() =>
      spawnLocalServer(hostname, port, password, {
        userDataPath: app.getPath("userData"),
        renderEnv,
        desktopNonce: localDesktopNonce,
        onStdout: (message) => writeLog("server", "stdout", { message }),
        onStderr: (message) => writeLog("server", "stderr", { message }, "warn"),
        onExit: (code) => writeLog("utility", "sidecar exited", { code }, "warn"),
      }),
    )
    server = listener
    yield* Deferred.succeed(serverReady, {
      url,
      username: "opencode",
      password,
    })

    if (process.platform === "win32") {
      void wslServers.initialize().catch((error) => logger.error("wsl server initialization failed", error))
    }

    yield* Effect.promise(() => health.wait).pipe(
      Effect.timeout("30 seconds"),
      Effect.catch((e) =>
        Effect.sync(() => {
          logger.error("sidecar health check failed", e.toString())
        }),
      ),
    )
    yield* Effect.promise(() =>
      writeAppServerFile(serverFile, { url, username: "opencode", password, pid: process.pid }).catch((error) =>
        logger.warn("failed to write the app server descriptor for the swarm command", error),
      ),
    )

    logger.log("loading task finished")
  }).pipe(forwardInitializationFailure(serverReady), Effect.forkChild)

  yield* Fiber.await(loadingTask)
  // M7-05 (SD §5.3): auto-start the Office bridge only with the setting on, on macOS, and with the v1 sidecar.
  if (process.platform === "darwin" && SIDECAR_VERSION !== "v2" && getStore().get(OFFICE_ADDIN_ENABLED_KEY) === true) {
    void loadOfficeAddin()
      .then((controller) => controller.launch())
      .catch((error) => logger.error("office add-in launch failed", error))
  }

  app.on("window-all-closed", () => {
    if (process.platform === "darwin") return
    app.quit()
  })
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length > 0) return
    restoreMainWindows()
  })

  const windows = restoreMainWindows()
  if (windows.length) rebuildMenu()
  // Result of a patch handoff (row 58), once per start after the first window is shown. `installedRelease` is the S-1
  // `status` of this bundle (row 56); it runs only when the result file claims success.
  if (process.platform === "darwin" && windows[0]) {
    const readPatchResult = createPatchResultReader({
      resultFile: join(app.getPath("userData"), HANDOFF_RESULT_FILE_NAME),
      resourcesPath: process.resourcesPath,
      window: patchWindow,
      showMessageBox: patchMessageBox,
      t: nativeT,
      installedRelease: () =>
        runPatchStatus({
          run: createExecFileRunner(),
          applier: patchApplierPath(process.resourcesPath),
          home: homedir(),
        }).then((status) => (status.ok ? status.status.release : undefined)),
      log: (message, extra, level) => writeLog("swarm-patch", message, extra, level),
    })
    windows[0].once("ready-to-show", () =>
      void readPatchResult().catch((error) => logger.error("patch result check failed", error)),
    )
  }
})

Effect.runFork(main)
