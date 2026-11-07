// Row 157 (C130, C156): start / reuse the REAL render bridge in the repo's Electron 42 binary for the verification-gate
// e2e test. The Electron main is packages/desktop/test/datum-render-electron/row157-harness-main.ts (the app's own
// allow-list, STUDIO_BRIDGE_EXTRA_SCRIPTS of start.ts). Isolation as rows 151/151b: env -i style env with the fixture
// HOME, dead proxy, --use-mock-keychain (also appended inside the harness), userData under the work dir. The Electron
// PID is written to <work>/electron.pid so the caller's shell trap can always kill it; this module also kills it on
// stop() and on process exit.
// When ROW157_BRIDGE_JSON names an existing bridge.json (the mutation runs, row157-mutations.test.ts), the bridge of the
// parent run is reused and no Electron is started here.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"

const PKG = path.resolve(import.meta.dir, "..", "..")
const DESKTOP = path.resolve(PKG, "..", "desktop")
export const ELECTRON_BIN = path.join(DESKTOP, "node_modules", "electron", "dist", "Electron.app", "Contents", "MacOS", "Electron")
export const FONTS_DIR = path.join(DESKTOP, "datum", "datum-house-style", "assets", "fonts")
const HARNESS = path.join(DESKTOP, "test", "datum-render-electron", "row157-harness-main.ts")

export const realBridgeRunnable = process.platform === "darwin" && existsSync(ELECTRON_BIN) && !ELECTRON_BIN.startsWith("/Applications/")

export type BridgeInfo = { DATUM_RENDER_SOCKET: string; DATUM_RENDER_TOKEN: string; scripts: string[]; pid: number }
export type RealBridge = { info: BridgeInfo; work: string; owned: boolean; stop(): Promise<{ result: Record<string, unknown> | null }> }

export async function startRealBridge(work: string, home: string): Promise<RealBridge> {
  const reuse = process.env.ROW157_BRIDGE_JSON
  if (reuse && existsSync(reuse)) {
    const info = JSON.parse(readFileSync(reuse, "utf8")) as BridgeInfo
    return { info, work: path.dirname(reuse), owned: false, stop: async () => ({ result: null }) }
  }
  mkdirSync(work, { recursive: true })
  mkdirSync(home, { recursive: true })
  for (const f of ["bridge.json", "stop", "result.json"]) rmSync(path.join(work, f), { force: true })
  const main = await Bun.build({ entrypoints: [HARNESS], target: "node", format: "esm", external: ["electron"], outdir: path.join(work, "bundle"), naming: "main.mjs" })
  if (!main.success) throw new Error(`row157 harness bundle failed: ${main.logs.join("\n")}`)
  const env = {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: home,
    TMPDIR: path.join(work, "tmp"),
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    HTTP_PROXY: "http://127.0.0.1:9",
    HTTPS_PROXY: "http://127.0.0.1:9",
    ALL_PROXY: "http://127.0.0.1:9",
    NO_PROXY: "127.0.0.1,localhost",
    ROW157_WORK: work,
    ROW157_FONTS: FONTS_DIR,
    ELECTRON_ENABLE_LOGGING: "1",
  }
  mkdirSync(env.TMPDIR, { recursive: true })
  const logFile = Bun.file(path.join(work, "electron.log"))
  const child = Bun.spawn([ELECTRON_BIN, "--use-mock-keychain", path.join(work, "bundle", "main.mjs")], { env, stdout: logFile, stderr: logFile })
  writeFileSync(path.join(work, "electron.pid"), String(child.pid))
  const kill = () => {
    if (child.exitCode === null && !child.killed) child.kill("SIGKILL")
  }
  process.on("exit", kill)
  const deadline = Date.now() + 60_000
  while (!existsSync(path.join(work, "bridge.json"))) {
    if (child.exitCode !== null) {
      const res = existsSync(path.join(work, "result.json")) ? readFileSync(path.join(work, "result.json"), "utf8") : ""
      throw new Error(`row157 harness exited early (${child.exitCode}): ${res}`)
    }
    if (Date.now() > deadline) {
      kill()
      throw new Error("row157: render bridge did not start in 60 s")
    }
    await Bun.sleep(100)
  }
  const info = JSON.parse(readFileSync(path.join(work, "bridge.json"), "utf8")) as BridgeInfo
  return {
    info,
    work,
    owned: true,
    async stop() {
      writeFileSync(path.join(work, "stop"), "")
      const until = Date.now() + 10_000
      while (child.exitCode === null && Date.now() < until) await Bun.sleep(100)
      kill()
      const rf = path.join(work, "result.json")
      return { result: existsSync(rf) ? (JSON.parse(readFileSync(rf, "utf8")) as Record<string, unknown>) : null }
    },
  }
}
