import { describe, expect, test } from "bun:test"
import { DESKTOP_MENU } from "./desktop-menu"
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
    expect(items).toHaveLength(16)
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
})
