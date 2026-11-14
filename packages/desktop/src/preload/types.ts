import type { DesktopMenuAction } from "@opencode-ai/app/desktop-menu"
import type { WslServersPlatform } from "@opencode-ai/app/wsl/types"
import type { UpdaterState } from "@opencode-ai/app/updater"
import type { DesktopNativeBundle } from "@opencode-ai/app/i18n/desktop-native"
export type {
  WslDistroProbe,
  WslInstalledDistro,
  WslJob,
  WslOnlineDistro,
  WslOpencodeCheck,
  WslRuntimeCheck,
  WslServerConfig,
  WslServerItem,
  WslServerRuntime,
  WslServersEvent,
  WslServersState,
} from "@opencode-ai/app/wsl/types"

/** 1.2.7 row 47c (M1-03): answer of `check-directory-exists`; equal to the app's platform DirectoryCheck. */
export type DirectoryCheck = "exists" | "missing" | "refused"

export type ServerReadyData = {
  url: string
  username: string | null
  password: string | null
}

export type WslServersAPI = WslServersPlatform
export type UpdaterAPI = {
  subscribe: (cb: (state: UpdaterState) => void) => Promise<() => void>
  check: () => Promise<UpdaterState>
  install: () => Promise<void>
}

// Same shapes as SetupToolsRun, SetupToolsState and SetupToolsPlatform in
// app/src/context/platform.tsx (row 227). Restated here because importing the app root into the preload
// lets app.tsx's own `window.api` declaration replace ElectronAPI in the desktop program.
export type SetupToolsRun = {
  exitCode: number | null
  stdout: string
  stderr: string
}
export type SetupToolsState = {
  components: Partial<Record<string, string>>
  offerPending: boolean
}
export type SetupToolsPlatform = {
  preview: () => Promise<SetupToolsRun>
  install: (ids: string[]) => Promise<SetupToolsRun>
  state: () => Promise<SetupToolsState>
  onProgress: (cb: (state: SetupToolsState) => void) => () => void
  /** C74 `setup-tools:mark-offered`: "Not now" or an install start marks this release as offered */
  markOffered: () => Promise<void>
}
export type SetupToolsAPI = SetupToolsPlatform

// Mission control (row 127; masterplan/01_specs_mission_control_ui.md §3.2, §9.1). Wire types are the host JSON as
// returned through IPC (row 126 produces the fields marked G1-G4). Type-only import: nothing of datum-studio is bundled.
export type {
  MissionListItem,
  MissionDoc,
  MissionDerived,
  DecisionRequest,
  MissionMessage,
} from "../../../datum-studio/src/store/mission/types"
import type {
  MissionListItem,
  MissionDoc,
  MissionDerived,
  DecisionRequest,
  MissionMessage,
} from "../../../datum-studio/src/store/mission/types"

export type MissionControlResult<T> = { ok: true; data: T } | { ok: false; code: string; message: string }
export type MissionListItemWire = MissionListItem & { activityAt: string } // G2
export type DeliverableOutputWire = {
  fileId: string
  format: "DOCX" | "PDF" | "HTML" | "SVG" | "PNG"
  role: "PRIMARY" | "FIGURE"
  finalFileName: string
  /** Row 165D/165E (F56-2): the delivered DATUM title name (`<Judul> 012-GSP-KT-XI-2026 RevA.docx`); null when unsafe. */
  fileName: string | null
  sha256: string
  bytes: number
  createdAt: string
  verified: boolean // G4
}
export type DeliverableWire = {
  documentId: string
  docNumber: string
  title: string
  docKey: string | null
  rowId?: string
  revisionNo: number
  docRev: string
  updatedAt: string
  outputs: DeliverableOutputWire[]
  verified: boolean // C160: host one rule (revisionOutputState)
  final: boolean // C160
}
export type MissionGetWire = {
  mission: Omit<MissionDoc, "findings" | "locks">
  derived: MissionDerived
  requests: DecisionRequest[]
  messages: MissionMessage[] // newest N (G3), ascending seq
  deliverables: DeliverableWire[] // G1
}
export type MissionControlPlatform = {
  /** Row 183 (L36): sessions = the current session and its subagent sessions (their linked missions are listed too). */
  list(input: { directory: string; sessions?: string[] }): Promise<MissionControlResult<{ items: MissionListItemWire[] }>>
  get(input: { mission: string }): Promise<MissionControlResult<MissionGetWire>>
  answer(input: {
    mission: string
    request: string
    option: string
  }): Promise<MissionControlResult<{ decision: string; released: string[] }>>
  instruct(input: { mission: string; text: string; row?: string }): Promise<MissionControlResult<{ seq: number }>>
  /** 1.2.8 row 46 (N8-144): join/new of an open placement request; main answers, moves and places in one sequence. */
  place?(input: { mission: string; request: string; option: string }): Promise<MissionControlResult<{ decision: string; group: string }>>
}
export type MissionControlAPI = MissionControlPlatform

export type LinuxDisplayBackend = "wayland" | "auto"
export type TitlebarTheme = {
  mode: "light" | "dark"
  scheme?: "system" | "light" | "dark"
}
export type FatalRendererError = {
  error: string
  url: string
  version?: string
  platform: string
  os?: string
}

export type ElectronAPI = {
  killSidecar: () => Promise<void>
  installCli: () => Promise<string>
  awaitInitialization: () => Promise<ServerReadyData>
  wslServers: WslServersAPI
  updater: UpdaterAPI
  setupTools: SetupToolsAPI
  /** Mission control (row 127): four allow-listed host calls; the host token stays in main. */
  missions: MissionControlAPI
  consumeInitialDeepLinks: () => Promise<string[]>
  getDefaultServerUrl: () => Promise<string | null>
  setDefaultServerUrl: (url: string | null) => Promise<void>
  isFirstLaunchOnboardingPending: () => Promise<boolean>
  finishFirstLaunchOnboarding: (createDefaultProject: boolean) => Promise<string | null>
  isOldLayoutEligible: () => Promise<boolean>
  getDisplayBackend: () => Promise<LinuxDisplayBackend | null>
  setDisplayBackend: (backend: LinuxDisplayBackend | null) => Promise<void>
  checkAppExists: (appName: string) => Promise<boolean>
  /**
   * 1.2.7 row 32 (U-8, N7-037), tri-state since row 47c (M1-03): "exists" (a directory), "missing" (gone: the app's
   * notice), "refused" (the check may not look there: the app opens the folder as 1.2.6 did).
   */
  checkDirectoryExists: (path: string) => Promise<DirectoryCheck>
  /** 1.2.7 row 32 (U-8, N7-039): creates the one missing leaf this window found missing; never parents. */
  recreateDirectory: (path: string) => Promise<boolean>
  resolveAppPath: (appName: string) => Promise<string | null>
  storeGet: (name: string, key: string) => Promise<string | null>
  storeSet: (name: string, key: string, value: string) => Promise<void>
  storeDelete: (name: string, key: string) => Promise<void>
  storeClear: (name: string) => Promise<void>
  storeKeys: (name: string) => Promise<string[]>
  storeLength: (name: string) => Promise<number>
  draftGet: (key: string) => Promise<string | null>
  draftSet: (key: string, value: string) => Promise<void>
  draftDelete: (key: string) => Promise<void>
  draftBlobPut: (data: ArrayBuffer) => Promise<string>
  draftBlobGet: (id: string) => Promise<ArrayBuffer | null>

  getWindowID: () => Promise<string>
  onMenuCommand: (cb: (id: string) => void) => () => void
  onDeepLink: (cb: (urls: string[]) => void) => () => void

  openDirectoryPicker: (opts?: {
    multiple?: boolean
    title?: string
    defaultPath?: string
  }) => Promise<string | string[] | null>
  openFilePicker: (opts?: {
    multiple?: boolean
    title?: string
    defaultPath?: string
    extensions?: string[]
  }) => Promise<{ token: string; files: { path: string; name: string; size: number }[] } | null>
  readPickedFile: (token: string, path: string) => Promise<ArrayBuffer>
  releasePickedFiles: (token: string) => Promise<void>
  getPathForFile: (file: File) => string
  saveFilePicker: (opts?: { title?: string; defaultPath?: string }) => Promise<string | null>
  openExternal: (url: string) => void
  openLocalFile: (url: string) => void
  openPath: (path: string, app?: string) => Promise<void>
  revealPath: (path: string) => Promise<boolean>
  /** 1.2.8 row 42c (AC-OBSf, N8-116): opens the project's vault hub note in Obsidian; main checks the path. */
  openObsidianNote: (hubPath: string) => Promise<"opened" | "missing" | "outside" | "no-app" | "failed">
  readClipboardImage: () => Promise<{ buffer: ArrayBuffer; width: number; height: number } | null>
  getWindowFocused: () => Promise<boolean>
  getWindowFullscreen: () => Promise<boolean>
  onWindowFullscreenChanged: (cb: (fullscreen: boolean) => void) => () => void
  setWindowFocus: () => Promise<void>
  showWindow: () => Promise<void>
  relaunch: () => void
  getZoomFactor: () => Promise<number>
  setZoomFactor: (factor: number) => Promise<void>
  getPinchZoomEnabled: () => Promise<boolean>
  setPinchZoomEnabled: (enabled: boolean) => Promise<void>
  onPinchZoomEnabledChanged: (cb: (enabled: boolean) => void) => () => void
  onZoomFactorChanged: (cb: (factor: number) => void) => () => void
  setTitlebar: (theme: TitlebarTheme) => Promise<void>
  runDesktopMenuAction: (action: DesktopMenuAction) => Promise<void>
  setBackgroundColor: (color: string) => Promise<void>
  exportDebugLogs: () => Promise<string>
  setForceFocus: (enabled: boolean) => Promise<void>
  recordFatalRendererError: (error: FatalRendererError) => Promise<void>
  setNativeTranslations: (bundle: DesktopNativeBundle) => Promise<void>
  /** Row 38b (SEC-06): the per-launch nonce for revert / archive-empty (header `x-swarm-desktop-nonce`); null if none. */
  desktopNonce: () => Promise<string | null>
}
