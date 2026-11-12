// DATUM render bridge: entry point for main (row 24). Wiring into app start, createSidecarEnv and
// the datum-studio-host env is requested of the owning rows (file_requests.md, row24 lines).
//
//   const bridge = await startRenderBridge({ fontsDir, renderScriptPath, extraScripts, log })
//   env.DATUM_RENDER_SOCKET = bridge.env.DATUM_RENDER_SOCKET
//   env.DATUM_RENDER_TOKEN  = bridge.env.DATUM_RENDER_TOKEN
//   app.on("will-quit", () => bridge.close())

import { randomBytes } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { createDispatcher, type PageEngine } from "./dispatch"
import { buildFontBundle } from "./fonts"
import { defaultPolicy, studioStoreGrants, type PathPolicy } from "./paths"
import { extractRenderPyCheckScript, ScriptAllowList } from "./scripts"
import { startSocketServer, type BridgeLog, type SocketServerHandle } from "./socket-server"

export type RenderBridgeOptions = {
  /** Folder holding the 16 IBM Plex files (Res/datum-house-style/assets/fonts in the app). */
  fontsDir: string
  /** datum_render.py of the bundled skill copy; its check-page function is allow-listed. */
  renderScriptPath?: string
  /** Further fixed scripts, e.g. Studio's MEASURE_SCRIPT (engine/browser/measure.ts:25). */
  extraScripts?: Record<string, string>
  log: BridgeLog
  policy?: PathPolicy
  /** Row 151c (C161 I1): HOME the default policy protects (default os.homedir()). */
  home?: string
  /**
   * Row 151c (C161 I1): the Studio store root from the host lifecycle (layout.ts studioStoreRoot), never from a
   * request. The default policy then grants read of `<store>/docs/**.html` and write of `<store>/verify/<id>/*.png`.
   */
  storeRoot?: string
  /** Test seam: a page engine other than Electron's. */
  engine?: PageEngine
  baseDir?: string
  /**
   * 1.2.6 row 93 (TH-04, DP-1, N-184), internal: restart on the SAME endpoint. The server listens on `socketPath`
   * (folder recreated 0700 if missing, socket 0600) and keeps `token`, so the host and the sidecar, which read the
   * pair per request, keep working without a respawn or an env refresh. The caller closes the old bridge first.
   */
  reuse?: { token: string; socketPath: string }
}

export type RenderBridge = {
  env: { DATUM_RENDER_SOCKET: string; DATUM_RENDER_TOKEN: string }
  close(): Promise<void>
  scripts: string[]
}

/** Default font folder: packaged Resources, or the repo copy in dev. */
export function defaultFontsDir(resourcesPath: string | undefined, isPackaged: boolean, appPath: string) {
  if (isPackaged && resourcesPath) return join(resourcesPath, "datum-house-style", "assets", "fonts")
  return join(appPath, "datum", "datum-house-style", "assets", "fonts")
}

export function buildScriptAllowList(renderScriptPath: string | undefined, extra: Record<string, string> | undefined, log: BridgeLog) {
  const list = new ScriptAllowList()
  if (renderScriptPath && existsSync(renderScriptPath)) {
    const text = extractRenderPyCheckScript(readFileSync(renderScriptPath, "utf8"))
    if (text) list.add("datum_render.check_page", text)
    else log("warn", "datum-render.scripts", "check-page function not found in datum_render.py", { renderScriptPath })
  }
  for (const [name, text] of Object.entries(extra ?? {})) list.add(name, text)
  return list
}

export async function startRenderBridge(opts: RenderBridgeOptions): Promise<RenderBridge> {
  const fonts = buildFontBundle(opts.fontsDir)
  const scripts = buildScriptAllowList(opts.renderScriptPath, opts.extraScripts, opts.log)
  const policy = opts.policy ?? defaultPolicy(opts.home, [], opts.storeRoot ? studioStoreGrants(opts.storeRoot) : [])
  const engine =
    opts.engine ?? (await import("./electron-renderer")).createElectronEngine(new Set(fonts.files), opts.log)
  const token = opts.reuse?.token ?? randomBytes(32).toString("hex")
  const dispatch = createDispatcher({ engine, policy, fonts: () => fonts, scripts })
  const server: SocketServerHandle = await startSocketServer({
    token,
    dispatch,
    log: opts.log,
    baseDir: opts.baseDir,
    socketPath: opts.reuse?.socketPath,
  })
  return {
    env: { DATUM_RENDER_SOCKET: server.socketPath, DATUM_RENDER_TOKEN: token },
    close: () => server.close(),
    scripts: scripts.names(),
  }
}
