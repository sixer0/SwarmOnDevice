import { createSimpleContext } from "@opencode-ai/ui/context"
import type { AsyncStorage, SyncStorage } from "@solid-primitives/storage"
import type { Accessor } from "solid-js"
import type { DesktopMenuAction } from "../desktop-menu"
import { ServerConnection } from "./server"
import type { WslServersPlatform } from "../wsl/types"
import type { UpdaterPlatform } from "../updater"
import type { DraftStore } from "@/utils/draft-store"
import type { MissionSource } from "@/pages/session/swarm/mission-poll"
import type { MissionWriter } from "@/pages/session/swarm/mission-command-model"

type PickerPaths = string | string[] | null
type OpenDirectoryPickerOptions = { title?: string; multiple?: boolean }
type OpenAttachmentPickerOptions = {
  title?: string
  multiple?: boolean
  accept?: string[]
  extensions?: string[]
  defaultPath?: string
}
type SaveFilePickerOptions = { title?: string; defaultPath?: string }
type PlatformName = "web" | "desktop"
type DesktopOS = "macos" | "windows" | "linux"

export type FatalRendererErrorLog = {
  error: string
  url: string
  version?: string
  platform: PlatformName
  os?: DesktopOS
}

type PlatformBase = {
  /** App version */
  version?: string

  /** Source commit of the knowledge library edition bundled with the app (desktop only) */
  knowledgeLibraryCommit?: string

  /** Open a web or mail URL in the default system application */
  openExternal(url: string): void

  /** Open a local path in a local app (desktop only) */
  openPath?(path: string, app?: string): Promise<void>

  /** Open a local file URL in its default app (desktop only) */
  openLocalFile?(url: string): void

  /** Reveal a local path in the system file manager; false when the path does not exist (desktop only) */
  revealPath?(path: string): Promise<boolean>

  /** Restart the app  */
  restart(): Promise<void>

  /** Send a system notification */
  notify(title: string, description?: string, onClick?: () => void): Promise<void>

  /** Open a native attachment picker and read selected files sequentially (desktop only) */
  openAttachmentPickerDialog?(
    opts: OpenAttachmentPickerOptions,
    onFile: (file: File) => Promise<unknown>,
  ): Promise<void>

  /** Resolve the native source path for a desktop File. */
  getPathForFile?(file: File): string

  /** Open a native save file picker dialog (desktop only) */
  saveFilePickerDialog?(opts?: SaveFilePickerOptions): Promise<string | null>

  /** Storage mechanism, defaults to localStorage */
  storage?: (name?: string) => SyncStorage | AsyncStorage

  /** Prompt drafts, history, and their blobs. */
  draftStore?: DraftStore

  /** Stable platform window identity for window-scoped persistence */
  windowID?: string

  /** Application-global desktop updater */
  updater?: UpdaterPlatform

  /** Fetch override */
  fetch?: typeof fetch

  /** Get the configured default server URL (platform-specific) */
  getDefaultServer?(): Promise<ServerConnection.Key | null>

  /** Set the default server URL to use on app startup (platform-specific) */
  setDefaultServer?(url: ServerConnection.Key | null): Promise<void> | void

  /** Manage WSL sidecar servers (Electron on Windows only) */
  wslServers?: WslServersPlatform

  /** Get the preferred display backend (desktop only) */
  getDisplayBackend?(): Promise<DisplayBackend | null> | DisplayBackend | null

  /** Set the preferred display backend (desktop only) */
  setDisplayBackend?(backend: DisplayBackend): Promise<void>

  /** Webview zoom level (desktop only) */
  webviewZoom?: Accessor<number>

  /** Whether the native desktop window is fullscreen */
  windowFullscreen?: Accessor<boolean>

  /** Get whether native pinch/Ctrl-scroll zoom gestures are enabled (desktop only) */
  getPinchZoomEnabled?(): Promise<boolean> | boolean

  /** Allow native pinch/Ctrl-scroll zoom gestures (desktop only) */
  setPinchZoomEnabled?(enabled: boolean): Promise<void> | void

  /** Run a desktop-only menu action from the app chrome */
  runDesktopMenuAction?(action: DesktopMenuAction): Promise<void> | void

  /** Check if an editor app exists (desktop only) */
  checkAppExists?(appName: string): Promise<boolean>

  /** Read image from clipboard (desktop only) */
  readClipboardImage?(): Promise<File | null>

  /** Export collected diagnostic logs (desktop only) */
  exportDebugLogs?(): Promise<string>

  /** Force focus styles on interactive elements through desktop devtools (desktop only) */
  setForceFocus?(enabled: boolean): Promise<void>

  /** Record a fatal renderer error in platform logs (desktop only) */
  recordFatalRendererError?(error: FatalRendererErrorLog): Promise<void>
}

/** One swarm-setup run. stdout and stderr are passed through unedited, so the dialog shows the
 *  same `step <id>: <TOKEN>` and `RESULT <TOKEN>` lines and error text as Terminal. */
export type SetupToolsRun = {
  exitCode: number | null
  stdout: string
  stderr: string
}

/** Per-component `state` values read from swarm-setup's state.json, keyed by component id. */
export type SetupToolsState = {
  components: Partial<Record<string, string>>
  /** Whether this release has not yet offered the tools dialog */
  offerPending: boolean
}

/** Bundled swarm-setup (desktop only). A renderer call alone never installs: main shows a native confirmation
 *  for the ticked ids first (C80 F1), and a cancel there rejects with `SETUP_TOOLS_REFUSED:cancelled`. */
export type SetupToolsPlatform = {
  /** `install --dry-run`: the consent text to show as-is (it ends REFUSED_NO_CONSENT by design) */
  preview(): Promise<SetupToolsRun>
  /** After main's native confirmation: `install <ids> --non-interactive` with one terms token per checked id */
  install(ids: string[]): Promise<SetupToolsRun>
  state(): Promise<SetupToolsState>
  /** state.json polled while a run is active; returns the unsubscribe function */
  onProgress(cb: (state: SetupToolsState) => void): () => void
  /** Marks this release as offered (C74): call on "Not now" or when an install starts, not on read */
  markOffered(): Promise<void>
}

/** Mission control bridge (desktop only, row 127 window.api.missions; spec 01_specs_mission_control_ui.md §3.2).
 *  The wire types live in the mission modules (row 129 read half, row 131 write half). */
export type MissionControlPlatform = MissionSource & MissionWriter

export type Platform = PlatformBase &
  (
    | { platform: "web"; os?: never; setupTools?: never; missions?: never }
    | {
        platform: "desktop"
        os?: DesktopOS
        openDirectoryPickerDialog(opts?: OpenDirectoryPickerOptions): Promise<PickerPaths>
        /** Absent until the preload exposes it; callers hide the tools triggers when undefined */
        setupTools?: SetupToolsPlatform
        /** Absent = mission control absent (row 133 mount hides it) */
        missions?: MissionControlPlatform
      }
  )

export type DisplayBackend = "auto" | "wayland"

export const { use: usePlatform, provider: PlatformProvider } = createSimpleContext({
  name: "Platform",
  init: (props: { value: Platform }) => {
    return props.value
  },
})
