// The four mission control IPC handlers (row 127; masterplan/01_specs_mission_control_ui.md §3). ipc.ts registers
// them with the real ipcMain and BrowserWindow lookup; this file imports only electron types, so bun tests it
// without mocking modules (the setup-tools-ipc.ts pattern).
//
// Sender rule (spec §3.3 "sender"; the same check as setup-tools-ipc.ts assertSender and set-native-translations):
// the sender is the main frame of a live window main created, on the renderer origin (windows.ts isRendererUrl).
// A refused sender gets {ok:false, code:"BAD_SENDER"} and no host call.
// Every handler answers a MissionControlResult and never throws to the renderer.

import { homedir } from "node:os"
import { posix } from "node:path"
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent, WebContents } from "electron"
import { MISSION_CONTROL_IPC } from "../../preload/mission-control-channels"
import type { MissionControlPlatform, MissionControlResult } from "../../preload/types"
import { MISSION_CONTROL_AGENT } from "./mission-client"

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
// Row 183 (L36): the basis of a listed id is the list's folder plus its sessions; a get is returned when the mission's
// project folder is that folder or one inside it (row 181, the store's rule), or the mission is linked (client swarm,
// the client's MCP agent) to one of those sessions.
// Row 185 (S186-02, L42): the folder and the session ids come from the renderer and are checked for shape only, not
// for belonging to this window's own session. This scope keeps a window consistent with what it listed; it is NOT
// window isolation, and a compromised renderer can choose another folder or session (it already has the server API).
type Basis = { directory: string; sessions: string[] }
type Scope = Map<string, Basis>
const OUT_OF_SCOPE: MissionControlResult<never> = { ok: false, code: "BAD_ARGUMENT", message: "mission is not in this session's project" }

const missionOf = (input: unknown) =>
  input && typeof input === "object" && typeof (input as { mission?: unknown }).mission === "string"
    ? (input as { mission: string }).mission
    : undefined

/** After an ok list: the listed ids replace this folder's ids in the scope. */
function remember(scope: Scope, input: unknown, result: MissionControlResult<unknown>) {
  if (!result.ok) return
  const { directory, sessions } = input as { directory: string; sessions?: unknown }
  const basis: Basis = { directory, sessions: Array.isArray(sessions) ? sessions.filter((s): s is string => typeof s === "string") : [] }
  const items = (result.data as { items?: Array<{ id?: unknown }> }).items ?? []
  for (const [id, known] of [...scope]) if (known.directory === directory) scope.delete(id)
  for (const item of items) if (typeof item?.id === "string") scope.set(item.id, basis)
}

/** Same value as datum-studio mission-store.ts PROJECT_PREFIX_MIN_SEGMENTS (row 185, S186-01). */
export const PROJECT_PREFIX_MIN_SEGMENTS = 4

/**
 * Row 183: the mission's project folder is the listed folder or a folder inside it (mission-store.ts projectDirScope).
 * Row 185 (S186-01, L42): the "inside it" part only for a narrow folder - not '/', not the home folder or a folder
 * directly in it ('~/Documents'), and at least PROJECT_PREFIX_MIN_SEGMENTS segments deep - the store's rule.
 */
export function withinDirectory(dir: string, directory: string, home: string = homedir()) {
  if (dir === directory) return true
  if (!dir.startsWith("/") || !directory.startsWith("/")) return false
  const exact = posix.resolve("/", directory)
  if (dir === exact) return true
  if (exact === "/" || exact.split("/").filter(Boolean).length < PROJECT_PREFIX_MIN_SEGMENTS) return false
  const h = home.startsWith("/") ? posix.resolve("/", home) : null
  if (h !== null && (exact === h || posix.dirname(exact) === h)) return false
  return dir.startsWith(`${exact}/`) && !`${dir}/`.includes("/../") && !`${dir}/`.includes("/./")
}

function stillInScope(data: unknown, basis: Basis) {
  const mission = (data as { mission?: { project?: { dir?: unknown }; sessions?: unknown } }).mission
  const dir = mission?.project?.dir
  if (typeof dir === "string" && withinDirectory(dir, basis.directory)) return true
  const links = Array.isArray(mission?.sessions) ? (mission.sessions as Array<{ client?: unknown; ref?: unknown }>) : []
  return links.some((l) => l?.client === MISSION_CONTROL_AGENT && typeof l.ref === "string" && basis.sessions.includes(l.ref))
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
          const basis = scope.get(mission)
          if (!basis || !stillInScope(result.data, basis)) return OUT_OF_SCOPE
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
