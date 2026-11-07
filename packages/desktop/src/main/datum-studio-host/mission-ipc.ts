// The four mission control IPC handlers (row 127; masterplan/01_specs_mission_control_ui.md §3). ipc.ts registers
// them with the real ipcMain and BrowserWindow lookup; this file imports only electron types, so bun tests it
// without mocking modules (the setup-tools-ipc.ts pattern).
//
// Sender rule (spec §3.3 "sender"; the same check as setup-tools-ipc.ts assertSender and set-native-translations):
// the sender is the main frame of a live window main created, on the renderer origin (windows.ts isRendererUrl).
// A refused sender gets {ok:false, code:"BAD_SENDER"} and no host call.
// Every handler answers a MissionControlResult and never throws to the renderer.

import type { BrowserWindow, IpcMain, IpcMainInvokeEvent, WebContents } from "electron"
import { MISSION_CONTROL_IPC } from "../../preload/mission-control-channels"
import type { MissionControlPlatform, MissionControlResult } from "../../preload/types"

export type MissionIpcDeps = {
  ipcMain: Pick<IpcMain, "handle">
  windowOf: (sender: WebContents) => Pick<BrowserWindow, "isDestroyed" | "webContents"> | null
  isRendererUrl: (url: string | undefined) => boolean
  /** The running host's client, or undefined while DATUM Studio is not running. */
  client: () => MissionControlPlatform | undefined
  log: (level: "warn" | "error", message: string, context?: Record<string, unknown>) => void
}

const unavailable: MissionControlResult<never> = { ok: false, code: "HOST_UNAVAILABLE", message: "DATUM Studio is not running" }

function senderOk(deps: MissionIpcDeps, event: IpcMainInvokeEvent) {
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

// Row 135 L2 (C150): per window, the missions it listed and the project folder each was listed for. get / answer /
// instruct take only those ids, and a get is returned only when the mission's project folder is still that folder, so a
// renderer reaches the missions of its session's project and no others. Kept per sender webContents, dropped with it.
type Scope = Map<string, string>
const OUT_OF_SCOPE: MissionControlResult<never> = { ok: false, code: "BAD_ARGUMENT", message: "mission is not in this session's project" }

const missionOf = (input: unknown) =>
  input && typeof input === "object" && typeof (input as { mission?: unknown }).mission === "string"
    ? (input as { mission: string }).mission
    : undefined

/** After an ok list: the listed ids replace this folder's ids in the scope. */
function remember(scope: Scope, input: unknown, result: MissionControlResult<unknown>) {
  if (!result.ok) return
  const directory = (input as { directory: string }).directory
  const items = (result.data as { items?: Array<{ id?: unknown }> }).items ?? []
  for (const [id, dir] of [...scope]) if (dir === directory) scope.delete(id)
  for (const item of items) if (typeof item?.id === "string") scope.set(item.id, directory)
}

export function registerMissionControlHandlers(deps: MissionIpcDeps) {
  const scopes = new WeakMap<object, Scope>()
  const scopeOf = (sender: object) => {
    const known = scopes.get(sender)
    if (known) return known
    const scope: Scope = new Map()
    scopes.set(sender, scope)
    return scope
  }
  const channels = Object.entries(MISSION_CONTROL_IPC) as Array<[keyof MissionControlPlatform, string]>
  for (const [method, channel] of channels) {
    deps.ipcMain.handle(channel, async (event: IpcMainInvokeEvent, input: unknown) => {
      if (!senderOk(deps, event)) {
        deps.log("warn", "mission control call from an unexpected sender refused", { channel })
        return { ok: false, code: "BAD_SENDER", message: "mission control is only available to the Swarm window" }
      }
      const client = deps.client()
      if (!client) return unavailable
      try {
        const scope = scopeOf(event.sender)
        const mission = method === "list" ? undefined : missionOf(input)
        // A missing or malformed id is left to the client's own check (BAD_ARGUMENT, no host call).
        if (mission !== undefined && !scope.has(mission)) return OUT_OF_SCOPE
        // The client validates `input` itself (§3.3) before any host call.
        const result = await (client[method] as (input: unknown) => Promise<MissionControlResult<unknown>>)(input)
        if (method === "list") remember(scope, input, result)
        if (method === "get" && mission !== undefined && result.ok) {
          const dir = (result.data as { mission?: { project?: { dir?: unknown } } }).mission?.project?.dir
          if (dir !== scope.get(mission)) return OUT_OF_SCOPE
        }
        return result
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error))
        deps.log("error", "mission control handler failed", { channel, message: err.message, stack_trace: err.stack })
        return { ok: false, code: "INTERNAL_ERROR", message: "mission control failed; details are in the Swarm log" }
      }
    })
  }
}
