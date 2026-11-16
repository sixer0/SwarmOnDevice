import { describe, expect, mock, test } from "bun:test"
import type { MenuItemConstructorOptions } from "electron"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// M7-01 (U-DT-03, IM-05, IM-06, IM-10, IA-6): the macOS "Office Add-in" submenu in menu.ts and the three Office actions
// in desktop-menu-actions.ts. Same layout as patch-menu-wiring.test.ts: electron and ./windows are mocked only inside a
// child `bun test` process (bun's mock.module is process-wide). ipc.ts is checked by reading its source.

const CHILD = process.env.SWARM_M701_CHILD === "1"

type OfficeState = "off" | "starting" | "running" | "failed" | "stopping"

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

test.if(!CHILD)("menu cases pass in an isolated child bun process (electron mocked there only)", () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "swarm-m701-menu-")))
  const child = spawnSync(process.execPath, ["test", import.meta.path], {
    cwd: join(import.meta.dir, "..", ".."),
    env: { ...process.env, HOME: home, SWARM_M701_CHILD: "1" },
    encoding: "utf8",
    timeout: 60_000,
  })
  rmSync(home, { recursive: true, force: true })
  const out = `${child.stdout}\n${child.stderr}`
  // darwin: 3 menu.ts cases + 2 desktop-menu-actions cases.
  const expected = process.platform === "darwin" ? 5 : 2
  expect({ status: child.status, out }).toMatchObject({ status: 0 })
  expect(out).toMatch(new RegExp(`\\b${expected} pass\\b`))
  expect(out).toMatch(/\b0 fail\b/)
})

// IA-6 / IM-06: the renderer IPC must never reach an Office action.
test.if(!CHILD)("ipc.ts run-desktop-menu-action handler object has no Office key", () => {
  const src = readFileSync(join(import.meta.dir, "ipc.ts"), "utf8")
  const start = src.indexOf('"run-desktop-menu-action"')
  expect(start).toBeGreaterThan(-1)
  const end = src.indexOf("})\n  })", start)
  expect(end).toBeGreaterThan(start)
  const block = src.slice(start, end)
  expect(block).toContain("runDesktopMenuAction(")
  expect(block).toContain("checkForUpdates")
  expect(block).not.toMatch(/officeAddin/i)
  expect(src).not.toMatch(/officeAddin/i)
})

function buildMenu(state?: OfficeState) {
  const calls: string[] = []
  const deps = {
    trigger: (id: string) => calls.push(`trigger:${id}`),
    checkForUpdates: () => calls.push("checkForUpdates"),
    installCli: () => calls.push("installCli"),
    relaunch: () => calls.push("relaunch"),
    updateFromFile: () => calls.push("updateFromFile"),
    undoLastUpdate: () => calls.push("undoLastUpdate"),
    officeAddinState: state ? () => state : undefined,
    officeAddinToggle: () => calls.push("officeAddinToggle"),
    officeAddinDisconnect: () => calls.push("officeAddinDisconnect"),
    officeAddinClearCache: () => calls.push("officeAddinClearCache"),
  }
  // process.resourcesPath is unset under bun; menu.ts reads it for the patch gate. Any path works (no applier there).
  const previous = process.resourcesPath
  Object.defineProperty(process, "resourcesPath", { value: tmpdir(), configurable: true, writable: true })
  try {
    template = []
    mocked!.createMenu(deps)
  } finally {
    Object.defineProperty(process, "resourcesPath", { value: previous, configurable: true, writable: true })
  }
  const appItems = template.flatMap((menu) => (menu.submenu ?? []) as MenuItemConstructorOptions[])
  const office = appItems.find((item) => item.label === nativeT("desktop.menu.officeAddin"))
  const sub = (office?.submenu ?? []) as MenuItemConstructorOptions[]
  const find = (
    key: "desktop.menu.officeAddin.enable" | "desktop.menu.officeAddin.disconnect" | "desktop.menu.officeAddin.clearCache",
  ) => sub.find((item) => item.label === nativeT(key))
  return {
    calls,
    office,
    sub,
    enable: find("desktop.menu.officeAddin.enable"),
    disconnect: find("desktop.menu.officeAddin.disconnect"),
    clearCache: find("desktop.menu.officeAddin.clearCache"),
  }
}

const click = (item: MenuItemConstructorOptions | undefined) =>
  (item?.click as unknown as (() => void) | undefined)?.()

describe.if(CHILD && process.platform === "darwin")("menu.ts Office submenu (U-DT-03)", () => {
  test("renders a native submenu with Enable checkbox, Disconnect, Clear cache; labels via nativeT", () => {
    const m = buildMenu()
    expect(m.office).toBeDefined()
    expect(Array.isArray(m.office?.submenu)).toBe(true)
    expect(m.sub.map((item) => item.label)).toEqual([
      nativeT("desktop.menu.officeAddin.enable"),
      nativeT("desktop.menu.officeAddin.disconnect"),
      nativeT("desktop.menu.officeAddin.clearCache"),
    ])
    expect(m.enable?.type).toBe("checkbox")
    // No state dep (older deps shape): off -> unchecked, Disconnect disabled.
    expect(m.enable?.checked).toBe(false)
    expect(m.disconnect?.enabled).toBe(false)
    expect(m.clearCache?.type).toBeUndefined()
  })

  test("checkbox and enabled gates follow the main-side state (SD §5.2)", () => {
    const rows: [OfficeState, boolean, boolean | undefined, boolean][] = [
      ["off", false, undefined, false],
      ["starting", true, false, false],
      ["running", true, undefined, true],
      ["failed", true, undefined, false],
      ["stopping", true, false, false],
    ]
    for (const [state, checked, enableEnabled, disconnectEnabled] of rows) {
      const m = buildMenu(state)
      expect({ state, checked: m.enable?.checked }).toEqual({ state, checked })
      expect({ state, enabled: m.enable?.enabled }).toEqual({ state, enabled: enableEnabled })
      expect({ state, enabled: m.disconnect?.enabled }).toEqual({ state, enabled: disconnectEnabled })
    }
  })

  test("each submenu click reaches only its own injected handler", () => {
    const m = buildMenu("running")
    click(m.enable)
    click(m.disconnect)
    click(m.clearCache)
    expect(m.calls).toEqual(["officeAddinToggle", "officeAddinDisconnect", "officeAddinClearCache"])
  })
})

describe.if(CHILD)("desktop-menu-actions.ts Office actions (IM-05)", () => {
  test("each action reaches its handler", () => {
    const calls: string[] = []
    const handlers = {
      officeAddinToggle: () => calls.push("toggle"),
      officeAddinDisconnect: () => calls.push("disconnect"),
      officeAddinClearCache: () => calls.push("clearCache"),
    }
    mocked!.runDesktopMenuAction(null, "app.officeAddinToggle", handlers)
    mocked!.runDesktopMenuAction(null, "app.officeAddinDisconnect", handlers)
    mocked!.runDesktopMenuAction(null, "app.officeAddinClearCache", handlers)
    expect(calls).toEqual(["toggle", "disconnect", "clearCache"])
  })

  test("without Office handlers (renderer IPC shape) the actions are no-ops", () => {
    const calls: string[] = []
    const handlers = { checkForUpdates: () => calls.push("check"), relaunch: () => calls.push("relaunch") }
    mocked!.runDesktopMenuAction(null, "app.officeAddinToggle", handlers)
    mocked!.runDesktopMenuAction(null, "app.officeAddinDisconnect", handlers)
    mocked!.runDesktopMenuAction(null, "app.officeAddinClearCache", handlers)
    expect(calls).toEqual([])
  })
})
