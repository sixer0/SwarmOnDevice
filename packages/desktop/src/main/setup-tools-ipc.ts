import type {
  BrowserWindow,
  IpcMain,
  IpcMainInvokeEvent,
  MessageBoxOptions,
  MessageBoxReturnValue,
  WebContents,
} from "electron"
import { SETUP_TOOLS_IPC } from "../preload/setup-tools-channels"
import type { SetupToolsRun, SetupToolsState } from "../preload/types"
import {
  SETUP_COMPONENT_IDS,
  tickedIds,
  type SetupComponentId,
  type SetupRefusal,
  type SetupResult,
  type SetupRunner,
} from "./setup-runner"

// The setup-tools channels (names in ../preload/setup-tools-channels.ts). ipc.ts registers them with the real
// ipcMain, BrowserWindow lookup, native dialog, runner and offer flag; this file only imports electron types,
// so bun can test it without mocking modules.

export type SetupToolsIpcDeps = {
  ipcMain: Pick<IpcMain, "handle">
  windowOf: (sender: WebContents) => Pick<BrowserWindow, "isDestroyed" | "webContents"> | null
  // F9: the sender frame must also be on the renderer origin (windows.ts isRendererUrl).
  isRendererUrl: (url: string | undefined) => boolean
  // Built on first use, so main startup does not touch the bundle.
  runner: () => Pick<SetupRunner, "home" | "state" | "preview" | "install" | "busy">
  // F1 (C80): main's own confirmation. Resolves true only when the person pressed Install in it.
  confirmInstall: (sender: WebContents, ids: readonly SetupComponentId[]) => Promise<boolean>
  isOfferPending: (home: string) => boolean
  markOffered: () => void
  log: (message: string, meta?: Record<string, unknown>) => void
}

export function registerSetupToolsHandlers(deps: SetupToolsIpcDeps) {
  // C82 (b), closing C79 without a new channel: the first window that reads a pending offer holds it, and every
  // other window reads offerPending false until the holder marks the offer (Not now, install start) or closes.
  // Nothing is persisted here; C74's rule that only showing the offer marks it stays with markOffered.
  // A closed window's webContents reports isDestroyed(), which frees the claim without a listener.
  let holder: WebContents | undefined
  let confirming = false
  const offerPending = (sender: WebContents) => {
    if (!deps.isOfferPending(deps.runner().home)) return false
    if (holder === undefined || holder.isDestroyed()) holder = sender
    return holder === sender
  }
  const state = (sender: WebContents, components = deps.runner().state()): SetupToolsState => ({
    components,
    offerPending: offerPending(sender),
  })

  deps.ipcMain.handle(SETUP_TOOLS_IPC.preview, async (event: IpcMainInvokeEvent) => {
    assertSender(deps, event)
    return toSetupToolsRun(await deps.runner().preview())
  })
  deps.ipcMain.handle(SETUP_TOOLS_IPC.install, async (event: IpcMainInvokeEvent, ids: unknown) => {
    assertSender(deps, event)
    const ticked = parseSetupToolsIds(ids)
    const sender = event.sender
    const selection = tickedIds(ticked)
    // An empty list goes straight to the runner, which refuses it; there is nothing to confirm.
    if (selection.ok && selection.ids.length > 0) {
      // One confirmation at a time, and none while a run is going: a second request is busy, not a second dialog.
      if (confirming || deps.runner().busy()) return toSetupToolsRun(refused("busy"))
      confirming = true
      const confirmed = await deps.confirmInstall(sender, selection.ids).finally(() => {
        confirming = false
      })
      if (!confirmed || sender.isDestroyed()) {
        deps.log("swarm-setup install cancelled in the native confirmation", { ids: selection.ids })
        return toSetupToolsRun(refused("cancelled"))
      }
    }
    // Progress goes back only to the window that asked for the run.
    const result = await deps.runner().install(ticked, (components) => {
      if (sender.isDestroyed()) return
      sender.send(SETUP_TOOLS_IPC.progress, state(sender, components))
    })
    return toSetupToolsRun(result)
  })
  deps.ipcMain.handle(SETUP_TOOLS_IPC.state, (event: IpcMainInvokeEvent) => {
    assertSender(deps, event)
    return state(event.sender)
  })
  // C74: called on "Not now" or when an install starts, never when state is merely read.
  deps.ipcMain.handle(SETUP_TOOLS_IPC.markOffered, (event: IpcMainInvokeEvent) => {
    assertSender(deps, event)
    deps.markOffered()
    holder = undefined
  })
}

export const SETUP_CONFIRM_KEYS = {
  title: "desktop.setupTools.confirm.title",
  message: "desktop.setupTools.confirm.message",
  detail: "desktop.setupTools.confirm.detail",
  install: "desktop.setupTools.confirm.install",
  cancel: "desktop.setupTools.confirm.cancel",
} as const

type SetupConfirmKey = (typeof SETUP_CONFIRM_KEYS)[keyof typeof SETUP_CONFIRM_KEYS]

// The native confirmation F1 asks for: it lists every ticked component id (a code token, one per line), Cancel is the default and the Escape
// answer, and only a press of Install (button 0) counts. A dialog that fails to show counts as Cancel.
export function createInstallConfirm(input: {
  windowOf: (sender: WebContents) => BrowserWindow | null
  showMessageBox: (win: BrowserWindow | null, options: MessageBoxOptions) => Promise<MessageBoxReturnValue>
  t: (key: SetupConfirmKey, params?: Record<string, string | number>) => string
}) {
  return async (sender: WebContents, ids: readonly SetupComponentId[]) => {
    const options: MessageBoxOptions = {
      type: "question",
      title: input.t(SETUP_CONFIRM_KEYS.title),
      message: input.t(SETUP_CONFIRM_KEYS.message),
      detail: input.t(SETUP_CONFIRM_KEYS.detail, { components: ids.join("\n") }),
      buttons: [input.t(SETUP_CONFIRM_KEYS.install), input.t(SETUP_CONFIRM_KEYS.cancel)],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    }
    const answer = await input.showMessageBox(input.windowOf(sender), options).catch(() => undefined)
    return answer?.response === 0
  }
}

// The renderer's only input to argv: a list of component ids, each one from the register enum.
// Anything else (non-array, non-string, unknown id, oversized list) is refused before the runner,
// and the runner checks the ids against the same enum again.
export function parseSetupToolsIds(value: unknown) {
  const known: readonly string[] = SETUP_COMPONENT_IDS
  if (!Array.isArray(value) || value.length > known.length * 2) throw new Error("SETUP_TOOLS_INVALID_IDS")
  if (!value.every((id): id is string => typeof id === "string" && known.includes(id))) {
    throw new Error("SETUP_TOOLS_INVALID_IDS")
  }
  return value
}

// A refusal means swarm-setup never ran, so there is no output to pass through: the invoke
// rejects with a code token the dialog maps to its own copy. A run returns its output unedited.
export function toSetupToolsRun(result: SetupResult): SetupToolsRun {
  if (result.kind === "refused") throw new Error(`SETUP_TOOLS_REFUSED:${result.reason}`)
  return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr }
}

function refused(reason: SetupRefusal["reason"]): SetupRefusal {
  return { kind: "refused", reason }
}

// Only a top-level frame of one of our windows, on the renderer origin, may drive swarm-setup.
function assertSender(deps: SetupToolsIpcDeps, event: IpcMainInvokeEvent) {
  const win = deps.windowOf(event.sender)
  if (
    !win ||
    win.isDestroyed() ||
    win.webContents !== event.sender ||
    !event.senderFrame ||
    event.senderFrame !== event.sender.mainFrame ||
    !deps.isRendererUrl(event.senderFrame.url)
  ) {
    throw new Error("SETUP_TOOLS_INVALID_SENDER")
  }
}
