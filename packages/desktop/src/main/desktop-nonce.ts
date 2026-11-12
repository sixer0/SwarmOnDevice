// 1.2.6 row 38b (SEC-06, desktop side of row 38a / N-147): the per-launch desktop nonce.
//
// index.ts makes it once per launch and keeps it in Electron main's memory. It reaches the local server only in the
// sidecar's `start` message (sidecar-start.ts), and the renderer only through DESKTOP_NONCE_IPC. It is never put in the
// environment, a file, the store or a log, so an agent's shell, which can read the server password, cannot read it.
// The server's revert and archive/empty routes need both (header `x-swarm-desktop-nonce`).
//
// This file imports only electron types, so bun tests it without mocking modules (the mission-ipc.ts pattern).

import { randomBytes } from "node:crypto"
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent, WebContents } from "electron"
import { DESKTOP_NONCE_IPC } from "../preload/desktop-nonce-channel"

// The server's accepted form (OC server/desktop-nonce.ts FORMAT).
const FORMAT = /^[A-Za-z0-9_-]{32,128}$/

export function isDesktopNonce(value: unknown): value is string {
  return typeof value === "string" && FORMAT.test(value)
}

/** 32 random bytes as base64url (43 characters). Call once per launch. */
export function createDesktopNonce(random: (size: number) => Buffer = randomBytes) {
  const value = random(32).toString("base64url")
  if (!isDesktopNonce(value)) throw new Error("desktop nonce generation failed")
  return value
}

export type DesktopNonceIpcDeps = {
  ipcMain: Pick<IpcMain, "handle">
  windowOf: (sender: WebContents) => Pick<BrowserWindow, "isDestroyed" | "webContents"> | null
  isRendererUrl: (url: string | undefined) => boolean
  /** This launch's nonce when the local sidecar was started with it; undefined otherwise. */
  nonce: () => string | undefined
}

// Same sender rule as mission-ipc.ts: the main frame of a live window main created, on the renderer origin.
function senderOk(deps: DesktopNonceIpcDeps, event: IpcMainInvokeEvent) {
  const win = deps.windowOf(event.sender)
  return !!(
    win &&
    !win.isDestroyed() &&
    win.webContents === event.sender &&
    event.senderFrame &&
    event.senderFrame === event.sender.mainFrame &&
    deps.isRendererUrl(event.senderFrame.url)
  )
}

/** Answers the nonce to the app's renderer, and null to any other sender or when no nonce is held. */
export function registerDesktopNonceHandler(deps: DesktopNonceIpcDeps) {
  deps.ipcMain.handle(DESKTOP_NONCE_IPC, (event: IpcMainInvokeEvent) => {
    if (!senderOk(deps, event)) return null
    return deps.nonce() ?? null
  })
}
