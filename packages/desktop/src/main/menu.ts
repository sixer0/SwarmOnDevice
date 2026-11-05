import { BrowserWindow, Menu } from "electron"
import type { MenuItemConstructorOptions } from "electron"
import { homedir } from "node:os"
import {
  DESKTOP_MENU,
  desktopMenuVisible,
  type DesktopMenuEntry,
  type DesktopMenuRole,
} from "@opencode-ai/app/desktop-menu"

import { UPDATER_ENABLED } from "./constants"
import { runDesktopMenuAction } from "./desktop-menu-actions"
import { openExternalURL } from "./windows"
import { nativeT } from "./native-translations"
import { patchMenuEnabled } from "./patch-common"

type Deps = {
  trigger: (id: string) => void
  checkForUpdates: () => void
  installCli: () => void
  relaunch: () => void
  updateFromFile: () => void
  undoLastUpdate: () => void
}

export function createMenu(deps: Deps) {
  // The native menu exists on macOS only; this return is also what keeps the patch items off other platforms.
  if (process.platform !== "darwin") return
  // Register 14.5-8 / D52-3, computed on every createMenu (start and each locale rebuild): the bundled applier exists
  // and this app is not the backup copy inside the state folder.
  const PATCH_MENU_ENABLED = patchMenuEnabled({ resourcesPath: process.resourcesPath, home: homedir() })

  const template = DESKTOP_MENU.filter((menu) => desktopMenuVisible(menu, "macos")).map((menu) => {
    if (menu.role) return { role: nativeRole(menu.role), label: nativeT(menu.labelKey) }
    return {
      label: nativeT(menu.labelKey),
      submenu: menu.items
        ?.filter((entry) => desktopMenuVisible(entry, "macos"))
        .map((entry) => nativeItem(entry, deps, PATCH_MENU_ENABLED)),
    }
  })

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function nativeItem(entry: DesktopMenuEntry, deps: Deps, patchEnabled: boolean): MenuItemConstructorOptions {
  if (entry.type === "separator") return { type: "separator" }
  if (entry.role) return { role: nativeRole(entry.role), label: entry.labelKey ? nativeT(entry.labelKey) : undefined }

  const item: MenuItemConstructorOptions = {
    label: entry.labelKey ? nativeT(entry.labelKey) : undefined,
    accelerator: entry.accelerator?.macos,
    enabled: entry.enabled === "updater" ? UPDATER_ENABLED : entry.enabled === "patch" ? patchEnabled : undefined,
  }

  if (entry.command) {
    const command = entry.command
    item.click = () => deps.trigger(command)
  }
  if (entry.action) {
    const action = entry.action
    item.click = () =>
      runDesktopMenuAction(BrowserWindow.getFocusedWindow(), action, {
        checkForUpdates: deps.checkForUpdates,
        installCli: deps.installCli,
        relaunch: deps.relaunch,
        updateFromFile: deps.updateFromFile,
        undoLastUpdate: deps.undoLastUpdate,
      })
  }
  if (entry.href) {
    const href = entry.href
    item.click = () => openExternalURL(href)
  }

  return item
}

function nativeRole(role: DesktopMenuRole) {
  return role as NonNullable<MenuItemConstructorOptions["role"]>
}
