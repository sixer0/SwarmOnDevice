// Row 151c of docs/2026-11-06_swarm_1_2_0_datum_installer (decision C161 I1, L1/L2): a bare-Electron harness that
// starts the REAL render bridge the way the installed app does (datum-studio-host/start.ts): the app's own script
// allow-list STUDIO_BRIDGE_EXTRA_SCRIPTS, and the default path policy built from the fixture HOME plus the Studio
// store root that layout.ts studioStoreRoot gives for that HOME (`~/.local/share/swarm/datum-studio`, inside the
// protected `~/.local/share/swarm`). It writes the socket and token to $ROW151C_WORK/bridge.json (mode 0600) and
// serves until $ROW151C_WORK/stop appears. Fixture HOME, userData and crashDumps under the work dir, the macOS keychain
// mocked, the render session offline. Never the Swarm app, never /Applications, never the real store.
import { app, BrowserWindow } from "electron"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { startRenderBridge, type RenderBridge } from "../../src/main/datum-render"
import { studioStoreRoot } from "../../src/main/datum-studio-host/layout"
import { STUDIO_BRIDGE_EXTRA_SCRIPTS } from "../../src/main/datum-studio-host/start"

// Never touch the macOS keychain from a fixture HOME (driver_rules.md); --use-mock-keychain is also on the command line.
app.commandLine.appendSwitch("use-mock-keychain")

const work = process.env.ROW151C_WORK
const fontsDir = process.env.ROW151C_FONTS
const home = process.env.HOME
if (!work || !fontsDir || !home || (!home.startsWith("/private/tmp/claude-501/") && !home.includes("/row151c-"))) {
  throw new Error("ROW151C_WORK, ROW151C_FONTS and a fixture HOME are required")
}
for (const d of ["userData", "crash", "sock"]) mkdirSync(join(work, d), { recursive: true })
app.setPath("userData", join(work, "userData"))
app.setPath("crashDumps", join(work, "crash"))
app.on("window-all-closed", () => {})

const storeRoot = studioStoreRoot(process.env, home)
const result: Record<string, unknown> = { electron: process.versions.electron, pid: process.pid, home, storeRoot }
const logs: unknown[] = []
let bridge: RenderBridge | undefined
let poll: ReturnType<typeof setInterval> | undefined
const watchdog = setTimeout(() => {
  result.error = "watchdog timeout"
  void finish(2)
}, 240_000)

async function finish(code: number) {
  clearTimeout(watchdog)
  if (poll) clearInterval(poll)
  try {
    await bridge?.close()
  } catch {}
  result.windowsAfter = BrowserWindow.getAllWindows().length
  result.logs = logs.slice(-200)
  writeFileSync(join(work!, "result.json"), JSON.stringify(result, null, 2))
  app.exit(code)
  setTimeout(() => process.exit(code), 1500).unref()
}

app.whenReady().then(async () => {
  try {
    app.dock?.hide()
    // Exactly the options start.ts passes (row 151c): home + the host's store root; no explicit policy.
    bridge = await startRenderBridge({
      fontsDir,
      extraScripts: STUDIO_BRIDGE_EXTRA_SCRIPTS,
      log: (level, source, message, extra) => logs.push({ level, source, message, extra }),
      baseDir: join(work, "sock"),
      home,
      storeRoot,
    })
    writeFileSync(join(work, "bridge.json"), JSON.stringify({ ...bridge.env, scripts: bridge.scripts, pid: process.pid, storeRoot }), { mode: 0o600 })
    poll = setInterval(() => {
      if (existsSync(join(work, "stop"))) void finish(0)
    }, 200)
  } catch (e) {
    result.error = e instanceof Error ? (e.stack ?? e.message) : String(e)
    void finish(1)
  }
})
