// Row 151 of docs/2026-11-06_swarm_1_2_0_datum_installer (decision C130 GAP-2): a bare-Electron harness that starts the
// REAL render bridge (startRenderBridge: socket server, token, dispatcher, createElectronEngine) in the repo's own
// Electron 42 binary, with Studio's `studio.measure` and row 151's `swarm.verify.overlap` registered in its own
// allow-list (the app's allow-list entry is row 152's job in start.ts; this harness does not touch it). It writes the
// socket path and token to $ROW151_WORK/bridge.json (mode 0600) and serves until $ROW151_WORK/stop appears, so the bun
// test next to this file drives the datum-studio host caller (overlap-clip.ts) over the real socket.
// Same isolation as row 24a's harness-main.ts: fixture HOME, userData and crashDumps under the work dir, the macOS
// keychain mocked, the render session offline (configureRenderSession). Never the Swarm app, never /Applications.
import { app, BrowserWindow } from "electron"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { startRenderBridge, type RenderBridge } from "../../src/main/datum-render"
import { MEASURE_SCRIPT } from "../../../datum-studio/vendor/src/lib/studio/engine/browser/measure"
import { OVERLAP_SCRIPT, OVERLAP_SCRIPT_NAME } from "../../../datum-studio/src/mcp-host/verify/overlap-script"

// Never touch the macOS keychain from a fixture HOME (driver_rules.md); --use-mock-keychain is also on the command line.
app.commandLine.appendSwitch("use-mock-keychain")

const work = process.env.ROW151_WORK
const fontsDir = process.env.ROW151_FONTS
if (!work || !fontsDir) throw new Error("ROW151_WORK and ROW151_FONTS are required")
for (const d of ["userData", "crash", "sock"]) mkdirSync(join(work, d), { recursive: true })
app.setPath("userData", join(work, "userData"))
app.setPath("crashDumps", join(work, "crash"))
// The engine destroys its window after each job; without this listener Electron would quit between jobs.
app.on("window-all-closed", () => {})

const result: Record<string, unknown> = { electron: process.versions.electron, chrome: process.versions.chrome, pid: process.pid }
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
    result.userData = app.getPath("userData")
    bridge = await startRenderBridge({
      fontsDir,
      extraScripts: { "studio.measure": MEASURE_SCRIPT, [OVERLAP_SCRIPT_NAME]: OVERLAP_SCRIPT },
      log: (level, source, message, extra) => logs.push({ level, source, message, extra }),
      baseDir: join(work, "sock"),
    })
    result.scripts = bridge.scripts
    writeFileSync(join(work, "bridge.json"), JSON.stringify({ ...bridge.env, scripts: bridge.scripts, pid: process.pid }), { mode: 0o600 })
    poll = setInterval(() => {
      if (existsSync(join(work, "stop"))) void finish(0)
    }, 200)
  } catch (e) {
    result.error = e instanceof Error ? (e.stack ?? e.message) : String(e)
    void finish(1)
  }
})
