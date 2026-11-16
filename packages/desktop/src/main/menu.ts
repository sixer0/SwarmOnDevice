import { BrowserWindow, Menu } from "electron"
import type { MenuItemConstructorOptions } from "electron"
import { homedir } from "node:os"
import {
  DESKTOP_MENU,
  desktopMenuVisible,
  type DesktopMenuEntry,
  type DesktopMenuItem,
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
  // Install DATUM Studio for Claude (rows 34/34b). Optional so menu tests built before it keep their deps shape.
  installDatumStudio?: () => void
  // "Re-check Tools" (1.2.6 row 91, SEC-05): person trigger of the tool-health regime. Optional for older test deps.
  recheckTools?: () => void
  relaunch: () => void
  updateFromFile: () => void
  undoLastUpdate: () => void
  // Office add-in submenu (M7-01, IM-05/IM-10). All optional so older test deps keep their shape; the Office
  // controller (M7-03) supplies them. The state is internal to main (SD §5.2) and is read on each menu build.
  officeAddinState?: () => "off" | "starting" | "running" | "failed" | "stopping"
  officeAddinToggle?: () => void
  officeAddinDisconnect?: () => void
  officeAddinClearCache?: () => void
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
  if (entry.items)
    return {
      label: entry.labelKey ? nativeT(entry.labelKey) : undefined,
      submenu: entry.items
        .filter((child) => desktopMenuVisible(child, "macos"))
        .map((child) => nativeItem(child, deps, patchEnabled)),
    }

  const officeState = deps.officeAddinState?.() ?? "off"
  const item: MenuItemConstructorOptions = {
    label: entry.labelKey ? nativeT(entry.labelKey) : undefined,
    accelerator: entry.accelerator?.macos,
    enabled: itemEnabled(entry.enabled, patchEnabled, officeState),
  }
  // SD §5.2: the Enable checkbox is checked in every state except off; disabled while starting or stopping so a
  // second click cannot race the transition in progress.
  if (entry.checked === "officeAddin") {
    item.type = "checkbox"
    item.checked = officeState !== "off"
    if (officeState === "starting" || officeState === "stopping") item.enabled = false
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
        installDatumStudio: deps.installDatumStudio,
        recheckTools: deps.recheckTools,
        relaunch: deps.relaunch,
        updateFromFile: deps.updateFromFile,
        undoLastUpdate: deps.undoLastUpdate,
        officeAddinToggle: deps.officeAddinToggle,
        officeAddinDisconnect: deps.officeAddinDisconnect,
        officeAddinClearCache: deps.officeAddinClearCache,
      })
  }
  if (entry.href) {
    const href = entry.href
    item.click = () => openExternalURL(href)
  }

  return item
}

function itemEnabled(gate: DesktopMenuItem["enabled"], patchEnabled: boolean, officeState: string) {
  if (gate === "updater") return UPDATER_ENABLED
  if (gate === "patch") return patchEnabled
  if (gate === "officeAddinRunning") return officeState === "running"
  return undefined
}

function nativeRole(role: DesktopMenuRole) {
  return role as NonNullable<MenuItemConstructorOptions["role"]>
}
