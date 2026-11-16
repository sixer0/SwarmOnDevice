import { describe, expect, test } from "bun:test"
import { DESKTOP_MENU, desktopMenuVisible } from "./desktop-menu"
import { DESKTOP_NATIVE_ENGLISH } from "./i18n/desktop-native"

describe("desktop menu", () => {
  test("exports logs through the desktop command registry", () => {
    const items = DESKTOP_MENU.flatMap((menu) => menu.items ?? []).filter(
      (item) => item.type === "item" && item.labelKey === "desktop.menu.exportLogs",
    )

    expect(items).toHaveLength(2)
    expect(items.every((item) => item.type === "item" && item.command === "logs.export" && !item.action)).toBe(true)
  })

  test("provides translated labels for role-backed entries", () => {
    const windowMenu = DESKTOP_MENU.find((menu) => menu.role === "windowMenu")
    const roleItems = DESKTOP_MENU.flatMap((menu) => menu.items ?? []).filter(
      (item) => item.type === "item" && item.role && item.labelKey,
    )

    expect(windowMenu?.labelKey).toBe("desktop.menu.window")
    expect(roleItems.length).toBeGreaterThan(0)
  })

  // UM-01 (register BN-22..26 as superseded by 14.5): the patch items sit right
  // after Check for Updates, in the macOS-only app menu, gated by "patch".
  test("places the signed-patch items after Check for Updates on macOS only", () => {
    const app = DESKTOP_MENU.find((menu) => menu.id === "app")
    const items = app?.items ?? []
    const actions = items.flatMap((item) => (item.type === "item" && item.action ? [item.action] : []))
    const start = actions.indexOf("app.checkForUpdates")

    expect(app?.platforms).toEqual(["macos"])
    // 1.2.6 row 91 (C9, SEC-05): +1 for "Re-check Tools" (16 -> 17).
    // Office add-in M1-03 (SD-RC-3, IA-3): +1 for the "Office Add-in" submenu entry (17 -> 18).
    expect(items).toHaveLength(18)
    expect(actions.slice(start, start + 3)).toEqual(["app.checkForUpdates", "app.updateFromFile", "app.undoLastUpdate"])

    const patch = items.filter((item) => item.type === "item" && item.enabled === "patch")
    expect(patch).toEqual([
      { type: "item", labelKey: "desktop.menu.updateFromFile", action: "app.updateFromFile", enabled: "patch" },
      { type: "item", labelKey: "desktop.menu.undoLastUpdate", action: "app.undoLastUpdate", enabled: "patch" },
    ])
    expect(DESKTOP_NATIVE_ENGLISH["desktop.menu.updateFromFile"]).toBe("Update from File…")
    expect(DESKTOP_NATIVE_ENGLISH["desktop.menu.undoLastUpdate"]).toBe("Undo Last Update")

    const elsewhere = DESKTOP_MENU.filter((menu) => menu.id !== "app")
      .flatMap((menu) => menu.items ?? [])
      .filter((item) => item.type === "item" && (item.action === "app.updateFromFile" || item.action === "app.undoLastUpdate"))
    expect(elsewhere).toHaveLength(0)
  })

  // Row 34b (C63/C64): Install DATUM Studio for Claude... right below Install Command Line Tool..., macOS app menu only.
  test("places Install DATUM Studio for Claude below Install Command Line Tool in the macOS app menu only", () => {
    const app = DESKTOP_MENU.find((menu) => menu.id === "app")
    const actions = (app?.items ?? []).flatMap((item) => (item.type === "item" && item.action ? [item.action] : []))
    const at = actions.indexOf("app.installCli")
    expect(actions.slice(at, at + 2)).toEqual(["app.installCli", "app.installDatumStudio"])
    expect(app?.items).toContainEqual({
      type: "item",
      labelKey: "desktop.menu.installDatumStudio",
      action: "app.installDatumStudio",
    })
    const elsewhere = DESKTOP_MENU.filter((menu) => menu.id !== "app")
      .flatMap((menu) => menu.items ?? [])
      .filter((item) => item.type === "item" && item.action === "app.installDatumStudio")
    expect(elsewhere).toHaveLength(0)
  })

  // SEC-05 / C9 (1.2.6 row 91): one "Re-check Tools" item, below Install DATUM Studio for Claude, macOS app menu only.
  test("places Re-check Tools below Install DATUM Studio for Claude in the macOS app menu only", () => {
    const app = DESKTOP_MENU.find((menu) => menu.id === "app")
    const actions = (app?.items ?? []).flatMap((item) => (item.type === "item" && item.action ? [item.action] : []))
    const at = actions.indexOf("app.installDatumStudio")
    expect(actions.slice(at, at + 2)).toEqual(["app.installDatumStudio", "app.recheckTools"])
    expect(app?.items).toContainEqual({ type: "item", labelKey: "desktop.menu.recheckTools", action: "app.recheckTools" })
    const all = DESKTOP_MENU.flatMap((menu) => menu.items ?? []).filter(
      (item) => item.type === "item" && item.action === "app.recheckTools",
    )
    expect(all).toHaveLength(1)
  })

  // Office add-in M1-03 (SD-RC-3, IA-3, SD §13.1): one macOS-only submenu below Re-check Tools in the app menu.
  test("places the Office Add-in submenu below Re-check Tools in the macOS app menu only", () => {
    const app = DESKTOP_MENU.find((menu) => menu.id === "app")
    const items = app?.items ?? []
    const at = items.findIndex((item) => item.type === "item" && item.action === "app.recheckTools")
    const office = items[at + 1]

    expect(office).toEqual({
      type: "item",
      labelKey: "desktop.menu.officeAddin",
      platforms: ["macos"],
      items: [
        { type: "item", labelKey: "desktop.menu.officeAddin.enable", action: "app.officeAddinToggle", checked: "officeAddin" },
        {
          type: "item",
          labelKey: "desktop.menu.officeAddin.disconnect",
          action: "app.officeAddinDisconnect",
          enabled: "officeAddinRunning",
        },
        { type: "item", labelKey: "desktop.menu.officeAddin.clearCache", action: "app.officeAddinClearCache" },
      ],
    })

    const officeActions = ["app.officeAddinToggle", "app.officeAddinDisconnect", "app.officeAddinClearCache"]
    const topLevel = DESKTOP_MENU.flatMap((menu) => menu.items ?? []).filter(
      (item) => item.type === "item" && item.action !== undefined && officeActions.includes(item.action),
    )
    expect(topLevel).toHaveLength(0)
  })

  // C15 RM-28: the Windows renderer filter (windows-app-menu.tsx) must still drop the macOS-only submenu.
  test("keeps the Office Add-in submenu out of the Windows menu", () => {
    const windows = DESKTOP_MENU.filter((menu) => desktopMenuVisible(menu, "windows")).flatMap((menu) =>
      (menu.items ?? []).filter((entry) => desktopMenuVisible(entry, "windows")),
    )
    const app = DESKTOP_MENU.find((menu) => menu.id === "app")
    const office = (app?.items ?? []).find((item) => item.type === "item" && item.labelKey === "desktop.menu.officeAddin")

    expect(office).toBeDefined()
    expect(desktopMenuVisible(office ?? {}, "windows")).toBe(false)
    expect(windows.length).toBeGreaterThan(0)
    expect(windows.filter((entry) => entry.type === "item" && (entry.items || entry.checked))).toHaveLength(0)
    expect(windows.filter((entry) => entry.type === "item" && entry.action?.startsWith("app.officeAddin"))).toHaveLength(0)
  })
})
