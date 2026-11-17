// DATUM Studio in main (row 111): the render bridge (row 24) and the datum-studio-host utility process, started
// after app.whenReady without blocking the window, stopped on quit (descriptor removed, store lock released).
//
// index.ts:  const datumStudio = createDatumStudio({...}); void datumStudio.start()
//            app.on("before-quit", (e) => datumStudio.holdQuit(e, () => app.quit()))

import { lstatSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
// Studio's one fixed page script (row108 line: STUDIO_BRIDGE_SCRIPTS = [{ name: "studio.measure", text: MEASURE_SCRIPT }]).
// measure.ts has no imports, so main does not pull the engine in; start.test.ts pins equality with STUDIO_BRIDGE_SCRIPTS.
import { MEASURE_SCRIPT } from "../../../../datum-studio/vendor/src/lib/studio/engine/browser/measure"
import { defaultFontsDir, startRenderBridge, type RenderBridge, type RenderBridgeOptions } from "../datum-render"
import { probeRenderBridge, type RenderBridgeEndpoint } from "../tool-health/bridge"
import { studioDescriptorPath } from "./descriptor"
import { resolveStudioLayout, studioStoreRoot } from "./layout"
import { startStudioHost, type ForkHost, type HostLog, type StudioHostHandle, type StudioHostStartOptions } from "./lifecycle"

// Row 151/152: the OVERLAP_CLIP page script (overlap-script.ts has no imports, like measure.ts).
import { OVERLAP_SCRIPT } from "../../../../datum-studio/src/mcp-host/verify/overlap-script"

export const STUDIO_BRIDGE_EXTRA_SCRIPTS: Record<string, string> = {
  "studio.measure": MEASURE_SCRIPT,
  "swarm.verify.overlap": OVERLAP_SCRIPT,
}

export type DatumStudioState =
  | { status: "idle" | "starting" | "stopped" }
  | { status: "running"; url: string; hostPid: number }
  | { status: "unavailable"; code: string; message: string }

export type DatumStudioDeps = {
  isPackaged: boolean
  resourcesPath?: string
  appPath: string
  /** appStateHome(process.env, userData): where app-server.env and datum-studio.env live. */
  stateHome: string
  env: NodeJS.ProcessEnv
  home?: string
  mainPid?: number
  log: HostLog
  /** Default: Electron utilityProcess.fork (lazy import, so tests never load Electron). */
  fork?: ForkHost
  /** Default: `<dir of the built main>/datum-studio-host.js`, next to sidecar.js. */
  entryPath?: string
  /** Test seam for the bridge (default startRenderBridge). */
  startBridge?: (opts: RenderBridgeOptions) => Promise<RenderBridge>
  /** Test seam (default startStudioHost). */
  startHost?: (opts: StudioHostStartOptions) => Promise<StudioHostHandle>
}

async function electronFork(): Promise<ForkHost> {
  const { utilityProcess } = await import("electron")
  return (modulePath, args, options) => utilityProcess.fork(modulePath, args, options) as unknown as ReturnType<ForkHost>
}

export function createDatumStudio(deps: DatumStudioDeps) {
  let state: DatumStudioState = { status: "idle" }
  let bridge: RenderBridge | undefined
  // Row 93 (TH-04): the endpoint of the bridge that started in this launch. Kept after a failed revive so a later
  // probe reports the socket as gone (revivable) rather than "never started". Held in main only, never logged.
  let endpoint: RenderBridgeEndpoint | undefined
  let reviving: Promise<void> | undefined
  let host: StudioHostHandle | undefined
  let starting: Promise<void> | undefined
  let stopping: Promise<void> | undefined
  let stopRequested = false
  let held = false
  const abort = new AbortController()

  const home = deps.home ?? homedir()
  const res = deps.isPackaged ? deps.resourcesPath : undefined
  const skillRoot = res ? join(res, "datum-house-style") : join(deps.appPath, "datum", "datum-house-style")

  // Row 151c (C161 I1): one store root for the host and for the bridge's narrow store grants.
  const storeRoot = studioStoreRoot(deps.env, home)

  const bridgeOptions = (): RenderBridgeOptions => ({
    fontsDir: defaultFontsDir(deps.resourcesPath, deps.isPackaged, deps.appPath),
    renderScriptPath: join(skillRoot, "scripts", "datum_render.py"),
    extraScripts: STUDIO_BRIDGE_EXTRA_SCRIPTS,
    log: deps.log,
    home,
    storeRoot,
  })

  /** Row 93 (TH-04, DP-1, N-184): close the old server, listen again on the same socket path with the same token. */
  async function revive() {
    await starting?.catch(() => {})
    if (stopRequested) throw Object.assign(new Error("DATUM Studio is stopping"), { code: "BRIDGE_STOPPING" })
    const pair = endpoint
    if (!pair)
      throw Object.assign(new Error("the render bridge did not start in this launch; quit and reopen Swarm"), { code: "BRIDGE_NOT_STARTED" })
    const old = bridge
    bridge = undefined
    await old?.close().catch((error) => deps.log("warn", "datum-studio.bridge", "old render bridge close failed", errorContext(error)))
    try {
      bridge = await (deps.startBridge ?? startRenderBridge)({ ...bridgeOptions(), reuse: { token: pair.token, socketPath: pair.socketPath } })
    } catch (error) {
      deps.log("error", "datum-studio.bridge", "render bridge restart failed", errorContext(error))
      throw error
    }
    deps.log("info", "datum-studio.bridge", "render bridge restarted on the same endpoint", { socketPath: pair.socketPath })
  }

  async function run() {
    state = { status: "starting" }
    try {
      bridge = await (deps.startBridge ?? startRenderBridge)(bridgeOptions())
      endpoint = { socketPath: bridge.env.DATUM_RENDER_SOCKET, token: bridge.env.DATUM_RENDER_TOKEN }
    } catch (error) {
      // Without the bridge the host still serves the store and templates; renders fail BROWSER_UNAVAILABLE.
      deps.log("error", "datum-studio.bridge", "render bridge failed to start", errorContext(error))
    }
    if (stopRequested) return
    try {
      const layout = resolveStudioLayout({ isPackaged: deps.isPackaged, resourcesPath: deps.resourcesPath, appPath: deps.appPath })
      const started = await (deps.startHost ?? startStudioHost)({
        fork: deps.fork ?? (await electronFork()),
        entryPath: deps.entryPath ?? join(dirname(fileURLToPath(import.meta.url)), "datum-studio-host.js"),
        layout,
        storeRoot,
        descriptorPath: studioDescriptorPath(deps.stateHome),
        mainPid: deps.mainPid ?? process.pid,
        home,
        resourcesPath: deps.resourcesPath,
        baseEnv: deps.env,
        renderEnv: bridge?.env,
        libraryRoot: studioLibraryRoot(deps),
        skillRoots: studioSkillRoots(deps),
        log: deps.log,
        signal: abort.signal,
        onUnexpectedExit: (code) => {
          state = { status: "unavailable", code: "HOST_EXITED", message: `DATUM Studio stopped (exit ${code})` }
        },
      })
      host = started
      if (stopRequested) {
        await started.stop()
        return
      }
      state = { status: "running", url: started.url, hostPid: started.hostPid }
      deps.log("info", "datum-studio", "datum-studio-host ready", { hostPid: started.hostPid })
    } catch (error) {
      const code = codeOf(error)
      if (code === "HOST_START_ABORTED") return
      const pid = (error as { details?: { pid?: unknown } })?.details?.pid
      // Spec §10.1: "DATUM Studio unavailable: store in use by PID n".
      const message = code === "STORE_LOCKED" && typeof pid === "number" ? `DATUM Studio unavailable: store in use by PID ${pid}` : "DATUM Studio unavailable"
      state = { status: "unavailable", code, message }
      deps.log("error", "datum-studio", message, errorContext(error))
    }
  }

  return {
    get state() {
      return state
    },
    /** Row 127: the running host's mission control client (token inside it), or undefined when not running. */
    missions() {
      return state.status === "running" && host?.running ? host.missions : undefined
    },
    start() {
      starting ??= run()
      return starting
    },
    /**
     * Row 93 (TH-04): tool-health's `process: render-bridge` probe. Waits for start(); `hello` on the socket; a bridge
     * that is connected but does not answer in time is busy and healthy. The result never carries the token.
     */
    async probeBridge(timeoutMs: number) {
      await starting?.catch(() => {})
      return probeRenderBridge(endpoint, timeoutMs)
    },
    /** Row 93 (N-184): same-endpoint restart. Throws when the bridge never started, during stop, or when the restart fails. */
    reviveBridge() {
      reviving ??= revive().finally(() => {
        reviving = undefined
      })
      return reviving
    },
    /** Descriptor removal is synchronous inside host.stop(); the wait closes the server and releases the store lock. */
    stop() {
      stopRequested = true
      abort.abort()
      stopping ??= (async () => {
        await starting?.catch(() => {})
        await host?.stop().catch((error) => deps.log("error", "datum-studio", "host stop failed", errorContext(error)))
        await reviving?.catch(() => {})
        await bridge?.close().catch((error) => deps.log("error", "datum-studio.bridge", "bridge close failed", errorContext(error)))
        state = { status: "stopped" }
      })()
      return stopping
    },
    /**
     * For `before-quit`: hold the quit once until the host has stopped (lock released, at most the stop timeout),
     * then quit again. Every later before-quit passes.
     */
    holdQuit(event: { preventDefault(): void }, quitAgain: () => void) {
      if (held || !starting) return
      held = true
      event.preventDefault()
      void this.stop().finally(quitAgain)
    },
  }
}

/**
 * 1.3.3 row 100 (KL-2, C7 item 6): the bundled technical library the Studio host serves with studio_library_read
 * (STUDIO_LIBRARY_ROOT). Packaged: `<Resources>/knowledge-library` (electron-builder maps `.library-stage` there);
 * dev: the staged copy `<appPath>/.library-stage` (scripts/stage-library.ts). A missing folder, a file or a symlink in
 * its place gives none: the host then answers "not available".
 */
export function studioLibraryRoot(input: { isPackaged: boolean; resourcesPath?: string; appPath: string }): string | undefined {
  const dir = input.isPackaged ? (input.resourcesPath ? join(input.resourcesPath, "knowledge-library") : undefined) : join(input.appPath, ".library-stage")
  if (!dir) return undefined
  const st = lstatSync(dir, { throwIfNoEntry: false })
  return st?.isDirectory() && !st.isSymbolicLink() ? dir : undefined
}

/** C33: the bundled on-disk skills whose files studio_library_read serves as `skill:<name>/...`. */
export const STUDIO_SKILL_ROOT_NAMES = ["gsp-diagram-standard"] as const

/**
 * 1.3.3 row 100 / C33: STUDIO_SKILL_ROOTS. Packaged: `<Resources>/<name>` (electron-builder.config.ts maps
 * datum/<name> there); dev: `<appPath>/datum/<name>`. A missing folder, a file or a symlink in its place is left out.
 */
export function studioSkillRoots(input: { isPackaged: boolean; resourcesPath?: string; appPath: string }): Record<string, string> | undefined {
  const base = input.isPackaged ? input.resourcesPath : join(input.appPath, "datum")
  if (!base) return undefined
  const found = STUDIO_SKILL_ROOT_NAMES.flatMap((name) => {
    const st = lstatSync(join(base, name), { throwIfNoEntry: false })
    return st?.isDirectory() && !st.isSymbolicLink() ? [[name, join(base, name)] as const] : []
  })
  return found.length > 0 ? Object.fromEntries(found) : undefined
}

function codeOf(error: unknown) {
  return error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : "HOST_START_FAILED"
}

function errorContext(error: unknown): Record<string, unknown> {
  return {
    code: codeOf(error),
    message: error instanceof Error ? error.message : String(error),
    ...(error instanceof Error && error.stack ? { stack_trace: error.stack } : {}),
  }
}
