// Row 157 of docs/2026-11-06_swarm_1_2_0_datum_installer (decisions C130, C147, C148, C149, C156): a bare-Electron
// harness that starts the REAL render bridge (startRenderBridge: socket server, per-launch token, dispatcher,
// createElectronEngine) in the repo's own Electron 42 binary, with the APP's allow-list exactly as desktop main
// registers it (STUDIO_BRIDGE_EXTRA_SCRIPTS of src/main/datum-studio-host/start.ts, row 152). The datum-studio
// verification-gate e2e test (packages/datum-studio/test/verify-gate-e2e/) points the real Studio host at this
// socket, so every render (pdf), measure / overlap checkPage and page image (pagePng) of that test runs in real
// Electron, never in a stub.
// Same isolation as rows 151/151b: fixture HOME (env -i by the caller), userData and crashDumps under the work dir,
// the macOS keychain mocked (switch here AND --use-mock-keychain on the command line). It writes the socket path and
// token to $ROW157_WORK/bridge.json (mode 0600) and serves until $ROW157_WORK/stop appears or the watchdog fires.
import { app, BrowserWindow } from "electron"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { startRenderBridge, type RenderBridge } from "../../src/main/datum-render"
import { STUDIO_BRIDGE_EXTRA_SCRIPTS } from "../../src/main/datum-studio-host/start"

// Never touch the macOS keychain from a fixture HOME (driver_rules.md, 2026-11-07).
app.commandLine.appendSwitch("use-mock-keychain")

const work = process.env.ROW157_WORK
const fontsDir = process.env.ROW157_FONTS
if (!work || !fontsDir) throw new Error("ROW157_WORK and ROW157_FONTS are required")
for (const d of ["userData", "crash", "sock"]) mkdirSync(join(work, d), { recursive: true })
app.setPath("userData", join(work, "userData"))
app.setPath("crashDumps", join(work, "crash"))
// The engine destroys its window after each job; without this listener Electron would quit between jobs.
app.on("window-all-closed", () => {})

const result: Record<string, unknown> = { electron: process.versions.electron, chrome: process.versions.chrome, pid: process.pid }
const logs: unknown[] = []
let bridge: RenderBridge | undefined
let poll: ReturnType<typeof setInterval> | undefined
const watchdog = setTimeout(
  () => {
    result.error = "watchdog timeout"
    void finish(2)
  },
  Number(process.env.ROW157_WATCHDOG_MS ?? 1_500_000),
)

async function finish(code: number) {
  clearTimeout(watchdog)
  if (poll) clearInterval(poll)
  try {
    await bridge?.close()
  } catch {}
  result.windowsAfter = BrowserWindow.getAllWindows().length
  result.logs = logs.slice(-300)
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
      extraScripts: STUDIO_BRIDGE_EXTRA_SCRIPTS,
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
