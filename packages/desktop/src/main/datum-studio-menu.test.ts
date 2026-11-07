import { afterAll, describe, expect, mock, test } from "bun:test"
import type { MenuItemConstructorOptions, MessageBoxOptions } from "electron"
import { spawnSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Row 34b (decisions C63/C64): the "Install DATUM Studio for Claude..." menu item and its call in index.ts.
// Same layout as patch-menu-wiring.test.ts: electron and ./windows are mocked only inside a child `bun test` process
// (bun's mock.module is process-wide), and index.ts, which cannot be imported in a test, is checked by its source.
// The installer itself is built the way index.ts builds it, with the real nativeT, against a fixture bin dir only.

const CHILD = process.env.SWARM_ROW34B_CHILD === "1"

let template: MenuItemConstructorOptions[] = []
async function loadMocked() {
  mock.module("electron", () => ({
    BrowserWindow: { getFocusedWindow: () => null },
    Menu: {
      buildFromTemplate: (t: MenuItemConstructorOptions[]) => {
        template = t
        return { template: t }
      },
      setApplicationMenu: () => {},
    },
  }))
  mock.module("./windows", () => ({ openExternalURL: () => {}, createMainWindow: () => {}, updateTitlebar: () => {} }))
  const { createMenu } = await import("./menu")
  const { runDesktopMenuAction } = await import("./desktop-menu-actions")
  return { createMenu, runDesktopMenuAction }
}
const mocked = CHILD ? await loadMocked() : undefined

const { nativeT } = await import("./native-translations")
const { createDatumStudioInstaller, claudeMcpAddLine, datumStudioLauncherPath, DATUM_STUDIO_WRAPPER_MARKER } = await import(
  "./cli-install"
)
const T = realpathSync(mkdtempSync(join(tmpdir(), "swarm-row34b-menu-")))
afterAll(() => rmSync(T, { recursive: true, force: true }))

test.if(!CHILD)("menu cases pass in an isolated child bun process (electron mocked there only)", () => {
  const home = join(T, "child-home")
  mkdirSync(home, { recursive: true })
  const child = spawnSync(process.execPath, ["test", import.meta.path], {
    cwd: join(import.meta.dir, "..", ".."),
    env: { ...process.env, HOME: home, SWARM_ROW34B_CHILD: "1" },
    encoding: "utf8",
    timeout: 60_000,
  })
  const out = `${child.stdout}\n${child.stderr}`
  // darwin: 2 menu.ts cases + 1 desktop-menu-actions case.
  const expected = process.platform === "darwin" ? 3 : 1
  expect({ status: child.status, out }).toMatchObject({ status: 0 })
  expect(out).toMatch(new RegExp(`\\b${expected} pass\\b`))
  expect(out).toMatch(/\b0 fail\b/)
})

function buildMenu() {
  const calls: string[] = []
  template = []
  // createMenu reads process.resourcesPath (patch gate); outside Electron it is unset, so point it at a fixture.
  const previous = process.resourcesPath
  const res = join(T, "Menu.app", "Contents", "Resources")
  mkdirSync(res, { recursive: true })
  Object.defineProperty(process, "resourcesPath", { value: res, configurable: true, writable: true })
  try {
    mocked!.createMenu({
      trigger: (id: string) => calls.push(`trigger:${id}`),
      checkForUpdates: () => calls.push("checkForUpdates"),
      installCli: () => calls.push("installCli"),
      installDatumStudio: () => calls.push("installDatumStudio"),
      relaunch: () => calls.push("relaunch"),
      updateFromFile: () => calls.push("updateFromFile"),
      undoLastUpdate: () => calls.push("undoLastUpdate"),
    })
  } finally {
    Object.defineProperty(process, "resourcesPath", { value: previous, configurable: true, writable: true })
  }
  const items = template.flatMap((menu) => (menu.submenu ?? []) as MenuItemConstructorOptions[])
  return { calls, items, labels: items.map((item) => item.label) }
}

const click = (item: MenuItemConstructorOptions | undefined) => (item?.click as unknown as (() => void) | undefined)?.()

describe.if(CHILD && process.platform === "darwin")("menu.ts: Install DATUM Studio for Claude...", () => {
  test("the item sits right below Install Command Line Tool... with its English label", () => {
    const m = buildMenu()
    const cli = m.labels.indexOf(nativeT("desktop.menu.installCli"))
    expect(cli).toBeGreaterThanOrEqual(0)
    expect(m.labels[cli + 1]).toBe("Install DATUM Studio for Claude...")
    expect(m.labels.filter((label) => label === "Install DATUM Studio for Claude...")).toHaveLength(1)
  })

  test("a click calls only the injected installDatumStudio handler, once", () => {
    const m = buildMenu()
    click(m.items.find((item) => item.label === nativeT("desktop.menu.installDatumStudio")))
    expect(m.calls).toEqual(["installDatumStudio"])
  })
})

describe.if(CHILD)("desktop-menu-actions.ts", () => {
  test("app.installDatumStudio calls only its handler; a missing handler does not throw", () => {
    const calls: string[] = []
    mocked!.runDesktopMenuAction(null, "app.installDatumStudio", {
      installCli: () => calls.push("cli"),
      installDatumStudio: () => calls.push("datum"),
    })
    expect(calls).toEqual(["datum"])
    expect(() => mocked!.runDesktopMenuAction(null, "app.installDatumStudio", {})).not.toThrow()
  })
})

describe.if(!CHILD)("index.ts wiring", () => {
  const source = readFileSync(join(import.meta.dir, "index.ts"), "utf8")

  test("menuDeps.installDatumStudio calls createDatumStudioInstaller with the bundle launcher, stateHome and ~/.local/bin", () => {
    const start = source.indexOf("installDatumStudio: () =>")
    expect(start).toBeGreaterThan(source.indexOf("const menuDeps = {"))
    const block = source.slice(start, source.indexOf("relaunch,", start))
    expect(block).toContain("void createDatumStudioInstaller({")
    expect(block).toContain("t: nativeT,")
    expect(block).toContain("launcher: datumStudioLauncherPath(process.resourcesPath),")
    expect(block).toContain("stateHome,")
    expect(block).toContain('binDir: join(homedir(), ".local", "bin"),')
    expect(block).toContain("pathEnv: () => shellEnv?.PATH ?? process.env.PATH,")
    expect(block).toContain(".catch((error) => logger.error(")
    // The same menuDeps object reaches createMenu at both call sites (locale rebuild and window start).
    expect(source.split("createMenu(menuDeps)").length - 1).toBe(2)
  })

  test("built as index.ts builds it, with the real nativeT: Install writes only the fixture wrapper; dialogs in English", async () => {
    const res = join(T, "Swarm.app", "Contents", "Resources")
    mkdirSync(join(res, "datum-studio"), { recursive: true })
    mkdirSync(join(res, "swarm-cli"), { recursive: true })
    for (const file of [datumStudioLauncherPath(res), join(res, "swarm-cli", "swarm")]) {
      writeFileSync(file, "#!/bin/sh\nexit 0\n")
      chmodSync(file, 0o755)
    }
    const binDir = join(T, "home", ".local", "bin")
    const dialogs: MessageBoxOptions[] = []
    const installed = await createDatumStudioInstaller({
      window: () => null,
      showMessageBox: async (_win, options) => {
        dialogs.push(options)
        return { response: 0, checkboxChecked: false }
      },
      t: nativeT,
      launcher: datumStudioLauncherPath(res),
      stateHome: join(T, "state"),
      binDir,
      pathEnv: () => "/usr/bin:/bin",
    })()
    expect(installed).toBe(join(binDir, "datum-studio"))
    expect(readdirSync(binDir)).toEqual(["datum-studio"])
    expect(readFileSync(installed!, "utf8")).toContain(DATUM_STUDIO_WRAPPER_MARKER)
    expect(dialogs.map((d) => [d.title, d.message])).toEqual([
      ["Install DATUM Studio for Claude...", "Install the datum-studio command for Claude?"],
      ["Install DATUM Studio for Claude...", "The datum-studio command is installed"],
    ])
    expect(dialogs[0].detail).toContain(join(binDir, "datum-studio"))
    expect(dialogs[0].buttons).toEqual(["Install", "Cancel"])
    // binDir is not on the fixture PATH: the path hint, ending with the `claude mcp add` line (shown, never run).
    expect(dialogs[1].detail).toContain(`export PATH="${binDir}:$PATH"`)
    expect(dialogs[1].detail!.endsWith(claudeMcpAddLine(installed!))).toBe(true)
    for (const d of dialogs) expect(`${d.title}${d.message}${d.detail}`).not.toContain("{{")
  })
})
