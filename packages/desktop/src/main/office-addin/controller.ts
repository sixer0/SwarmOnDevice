// Office add-in main-side controller (plan rows M7-03 and M7-04; server-delta spec §5.2, §5.3, §5.4, §12.2, §13.2;
// register rev 5 §3, §6.1, §6.3; U11, C11 OQ-5, C26(a), C31, C33, C38, C41, C44).
//
// Owns the bridge lifecycle (off / starting / running / failed / stopping) and the user-visible flows:
// - Enable (SD §5.4): CA -> leaf -> trust -> verify -> fork + start -> wef install -> persist -> notify. Any failure
//   rolls back every earlier step and leaves the setting false. A wef refusal (EPERM/EACCES) is not a failure: the
//   Finder-guided copy (U11) replaces the "installed" notice and steps 1-5 stay.
// - Disable (SD §5.3, §13.2): confirm with "also remove certificate" checked by default; both branches.
// - Launch (SD §5.3, C26(a)): renew the leaf if due, fork + start, re-sync a missing or stale wef manifest.
// - Pairing: `pair-request` -> number-matching dialog (pair-dialog.ts) -> `pair-decision`.
//
// Part 2 (M7-04): Disconnect (SD §11.4), Clear cache (SD §12.3), crash -> startFailed with no automatic restart
// (SD-RC-4), the final error dialog set (register §7.6), the uninstall Finder guide (C49 D6), SC-25 wiring (leaf check at
// bridge start, 24 h timer with `tls-update`, renewal failure -> `failed` in the menu), and the crash-safe CA rotation of
// renewal.ts (`ca/previous/`, C49 D4) for Enable and Disable. M7-05 wires `createOfficeAddinController` from index.ts
// by dynamic `import()` and passes `menuHandlers()` to the menu.
//
// Secrets (SC-34, spec §6): the sidecar password and the leaf key travel only in the `start` / `tls-update`
// postMessage. The bridge is forked with an explicit minimal env (`bridgeEnv`), never `OPENCODE_SERVER_PASSWORD`.
// Log lines carry codes, paths and counts only; thrown errors log `errorFields` (name, code), never message or stack.
//
// Lazy X.509 (IA-5): certs.ts, keychain.ts and renewal.ts (and so pkijs) are reached only by dynamic `import()`, so
// this module itself is safe to import; index.ts still loads it lazily (M7-05).
import { lstat, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type { MessageBoxOptions } from "electron"
import { OFFICE_BRIDGE_PORT, OFFICE_MANIFEST_FILE } from "@swarm/office-addin/constants"
import type { DesktopNativeKey } from "@opencode-ai/app/i18n/desktop-native"
import { nativeT } from "../native-translations"
import {
  OFFICE_BRIDGE_SERVICE_NAME,
  START_TIMEOUT,
  BRIDGE_EXITED,
  buildPairDecisionCommand,
  buildStartCommand,
  isBridgeMessage,
  type BridgeCommand,
  type BridgeFailureCode,
  type BridgeLifecycle,
  type BridgeLifecycleState,
  type BridgeStartConfig,
  type LeafTls,
  type PairRequest,
} from "../office-bridge/protocol"
import { OFFICE_BRIDGE_DATA_DIR } from "../office-bridge/server"
import { createPairingStore, pairingsPath } from "../office-bridge/pairing-store"
import { createKeyCustody, errorFields, type OfficeLogSink, type SafeStorageLike } from "./key-custody"
import type { CertPaths } from "./certs"
import type { Keychain } from "./keychain"
import type { RenewalClock, RenewalDeps, RenewalResult, RenewalTimer } from "./renewal"
import { showPairDialog, type PairDialogDeps } from "./pair-dialog"
import {
  clearCache,
  installManifest,
  nodeWefFs,
  UNSAFE_PATH,
  uninstallManifest,
  needsResync,
  type WefFs,
} from "./wef"

const SOURCE = "office-addin.controller"
/** SD §5.4 step 5: wait for `ready` or `failed` (the sidecar's `server.ts:22` value). */
const BRIDGE_START_TIMEOUT_MS = 60_000
/** SD §5.3 "Quit": `stop`, then a kill after 6 s (`server.ts:23`). */
const BRIDGE_STOP_TIMEOUT_MS = 6_000
/** Env keys the bridge may inherit (SC-34, SD-AC-14). No proxy, no API keys, no OPENCODE_* variable. */
/** @internal test seam */
export const BRIDGE_ENV_ALLOW = ["HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "TZ"] as const

// ── Injected surfaces (TR-5: no Electron runtime import; M7-05 adapts the real modules) ──

/** The part of Electron's UtilityProcess the controller uses. */
/** @internal test seam */
export type BridgeChild = {
  postMessage(message: BridgeCommand): void
  on(event: "message", listener: (message: unknown) => void): unknown
  on(event: "exit", listener: (code: number) => void): unknown
  kill(): boolean
  stdout?: NodeJS.ReadableStream | null
  stderr?: NodeJS.ReadableStream | null
}

/** @internal test seam */
export type ForkBridge = (
  modulePath: string,
  args: string[],
  options: { env: Record<string, string>; serviceName: string; stdio: "pipe" },
) => BridgeChild

type OfficeDialog = {
  /** App-modal `dialog.showMessageBox(options)`. */
  showMessageBox(options: MessageBoxOptions): Promise<{ response: number; checkboxChecked: boolean }>
}

type OfficeShell = {
  /** Reveal a file selected in Finder (`shell.showItemInFolder`). */
  showItemInFolder(path: string): void
  /** Open a folder in Finder (`shell.openPath`); resolves to an error string, empty on success. */
  openPath(path: string): Promise<string>
}

type OfficeSettings = {
  /** `officeAddinEnabled` (OFFICE_ADDIN_ENABLED_KEY, default false; M7-05 adds the key). */
  enabled(): boolean
  setEnabled(value: boolean): void | Promise<void>
}

/** Sidecar credentials from main's `serverReady` (spec §6). Rejects or resolves undefined when the sidecar is not up. */
type SidecarCredentials = { url: string; username: string; password: string }

/** @internal test seam */
export type ControllerClock = RenewalClock & {
  /** One-shot timer; returns a cancel function. */
  after(ms: number, fn: () => void): () => void
}

const systemControllerClock: ControllerClock = {
  now: () => new Date(),
  every(ms, tick) {
    const timer = setInterval(tick, ms)
    timer.unref?.()
    return () => clearInterval(timer)
  },
  after(ms, fn) {
    const timer = setTimeout(fn, ms)
    return () => clearTimeout(timer)
  },
}

type OfficeResources = {
  /** `app.isPackaged`. */
  packaged: boolean
  /** `process.resourcesPath` (packaged: holds `office-addin/pane` and `office-addin/manifest`, register §3). */
  resourcesPath: string
  /** Dev only: `packages/office-addin` (holds `manifest/` and the built `dist/pane`), C33. */
  devPackageDir: string
}

/** @internal test seam */
export type OfficeAddinControllerDeps = {
  userDataDir: string
  resources: OfficeResources
  /** Absolute path of `out/main/office-bridge.js`. */
  bridgeEntryPath: string
  /** Default OFFICE_BRIDGE_PORT (46317); tests use 47317 (TS-RC-1). */
  port?: number
  /** The env the minimal bridge env is picked from (process.env in production). */
  baseEnv: NodeJS.ProcessEnv
  server: () => Promise<SidecarCredentials | undefined>
  settings: OfficeSettings
  fork: ForkBridge
  dialog: OfficeDialog
  shell: OfficeShell
  pairDialog: PairDialogDeps
  safeStorage: SafeStorageLike
  /** Default: `createKeychain({ run: createExecFileRunner(), log })`, loaded lazily. */
  keychain?: Keychain
  /** Default: the Word and Excel wef folders under `home` (register §6.3). */
  wefRoots?: string[]
  /** Default: `~/Library/Containers/com.Microsoft.OsfWebHost/Data` (register §6.3, SD §12.3); only its contents go. */
  cacheRoot?: string
  wefFs?: WefFs
  home?: string
  clock?: ControllerClock
  log: OfficeLogSink
  /** Called on every lifecycle change (M7-05: the one `rebuildMenu` helper, IA-2). */
  onStateChange?: (state: BridgeLifecycleState) => void
  t?: (key: DesktopNativeKey, params?: Record<string, string | number>) => string
  startTimeoutMs?: number
  stopTimeoutMs?: number
}

type EnableStep = "server" | "ca" | "trust" | "verify" | "leaf" | "start" | "install" | "persist"
type ControllerFailureCode =
  | BridgeFailureCode
  | "INSTALL_FAILED"
  | "SERVER_UNAVAILABLE"
  | "ENABLE_FAILED"
  | "SIDECAR_UNSUPPORTED"
  /** wef.ts refused a symlinked or wrong-type wef path (M7-02a, F-M7-3). */
  | "UNSAFE_PATH"
  /** Neither Word nor Excel has a container (C63). */
  | "OFFICE_NOT_INSTALLED"

type EnableResult =
  | { ok: true; install: "installed" | "guided"; refused: string[] }
  /** busy: a transition runs; aborted: quit interrupted it (M7-04a); unsupported: the v2 sidecar (C5, F-M7-5). */
  | { ok: false; reason: "busy" | "aborted" | "unsupported" }
  | { ok: false; step: EnableStep; code: ControllerFailureCode }

type DisableResult =
  | { ok: true; removedCertificate: boolean; uninstallRefused: string[] }
  | { ok: false; reason: "busy" | "cancelled" }

type LaunchResult =
  | { ok: true; resynced: string[] }
  | { ok: false; reason: "busy" | "disabled" | "unsupported" }
  | { ok: false; code: ControllerFailureCode }

/** Where the empty pairing set went: the running bridge, the file (bridge stopped), nowhere (no data dir), or skipped. */
type DisconnectResult = { cleared: "bridge" | "file" | "none" } | { cleared: "skipped"; reason: "transition" | "error" }

type ClearCacheResult =
  | { ok: false; reason: "cancelled" | "busy" }
  | { ok: true; removed: number; refused: string[]; failed: number; pairings: DisconnectResult }

type OfficeAddinMenuHandlers = {
  officeAddinState: () => BridgeLifecycleState
  officeAddinToggle: () => void
  officeAddinDisconnect: () => void
  officeAddinClearCache: () => void
}

export type OfficeAddinController = {
  lifecycle(): BridgeLifecycle
  state(): BridgeLifecycleState
  enable(): Promise<EnableResult>
  disable(): Promise<DisableResult>
  /** Launch with the setting true (M7-05 calls it after the loading task, darwin, not v2). */
  launch(): Promise<LaunchResult>
  /** Menu `desktop.menu.officeAddin.disconnect` (SD §11.4, SC-16): every token gets 401 afterwards. No dialog. */
  disconnect(): Promise<DisconnectResult>
  /** Menu `desktop.menu.officeAddin.clearCache` (SD §12.3): confirm (Cancel default), cache contents, then pairings. */
  clearCache(): Promise<ClearCacheResult>
  /** Quit / relaunch / update: stop the bridge only (no uninstall, no keychain). Joins `stopSidecars()` (M7-05). */
  shutdown(): Promise<void>
  /** Menu entry points (M7-01 handler names). */
  menuHandlers(): OfficeAddinMenuHandlers
  /** Resolves when the flow started by the last menu click has settled (tests, quit). */
  idle(): Promise<void>
}

// ── Pure helpers (exported for tests) ──

/** SC-34 / SD-AC-14: only the allow-listed keys, never a secret. */
/** @internal test seam */
export function bridgeEnv(baseEnv: NodeJS.ProcessEnv) {
  return Object.fromEntries(
    BRIDGE_ENV_ALLOW.flatMap((key) => {
      const value = baseEnv[key]
      return typeof value === "string" ? [[key, value]] : []
    }),
  )
}

/**
 * The certs.ts `certPaths()` layout (register §6.1), computed here so the controller needs no static X.509 import
 * (certs.ts loads pkijs, IA-5). controller.test.ts asserts it equals `certPaths()` so the two cannot drift.
  * @internal test seam
 */
export function officeCertPaths(userDataDir: string): CertPaths {
  const root = join(userDataDir, OFFICE_BRIDGE_DATA_DIR)
  const caDir = join(root, "ca")
  const tlsDir = join(root, "tls")
  return {
    root,
    caDir,
    tlsDir,
    caCert: join(caDir, "swarm-office-ca.cert.pem"),
    caKeyEnc: join(caDir, "swarm-office-ca.key.enc"),
    fingerprint: join(caDir, "fingerprint.json"),
    leafKey: join(tlsDir, "localhost.key.pem"),
    leafCert: join(tlsDir, "localhost.cert.pem"),
    previousDir: join(caDir, "previous"),
    previousCert: join(caDir, "previous", "swarm-office-ca.cert.pem"),
    previousFingerprint: join(caDir, "previous", "fingerprint.json"),
  }
}

/** Register §6.3 / SD §12.3 Office web-host cache root (capital `M` as given by the source). */
/** @internal test seam */
export function defaultCacheRoot(home: string) {
  return join(home, "Library", "Containers", "com.Microsoft.OsfWebHost", "Data")
}

/** Register §6.3 wef folders. */
function defaultWefRoots(home: string) {
  return ["com.microsoft.Word", "com.microsoft.Excel"].map((id) => join(home, "Library", "Containers", id, "Data", "Documents", "wef"))
}

/** C33: packaged `process.resourcesPath`; dev a staging dir under userData whose `office-addin/pane` links to the build. */
/** @internal test seam */
export function officeResourcePaths(resources: OfficeResources, userDataDir: string) {
  if (resources.packaged) {
    return {
      resourcesDir: resources.resourcesPath,
      manifestPath: join(resources.resourcesPath, "office-addin", "manifest", OFFICE_MANIFEST_FILE),
      devPaneLink: undefined,
    }
  }
  const resourcesDir = join(userDataDir, "office-addin-dev")
  return {
    resourcesDir,
    manifestPath: join(resources.devPackageDir, "manifest", OFFICE_MANIFEST_FILE),
    devPaneLink: { link: join(resourcesDir, "office-addin", "pane"), target: join(resources.devPackageDir, "dist", "pane") },
  }
}

/** M7-04a (F-M7-1): `office-addin/enable-pending.json` while an Enable has not committed or rolled back. */
const ENABLE_MARKER_FILE = "enable-pending.json"

/** What an interrupted Enable may have left: our new CA and whether its trust was (possibly) added. */
type EnableMarker = {
  version: 1
  /** `office-addin/` did not exist before this Enable: reconcile removes it entirely. */
  rootCreated: boolean
  /** SHA-1 of the CA this Enable wrote (new-CA branch). */
  newCaSha1?: string
  /** SHA-1 of the CA whose `add-trusted-cert` this Enable started; reconcile removes it from the login keychain. */
  trustSha1?: string
}

/** Thrown at an Enable checkpoint once `shutdown` asked it to stop. */
class EnableAborted extends Error {}

/**
 * Final error dialog set (M7-04; register §7.6, SD §5.3). Every failure code is listed so a new code fails typecheck
 * instead of silently falling back. `INSTALL_FAILED` (a non-refusal wef error, rolled back) has no `{{path}}` to show,
 * so it is `startFailed`; the refusal copy `installFailed` is the Finder guide, not this table.
 */
const ERROR_KEYS: Record<ControllerFailureCode, DesktopNativeKey> = {
  PORT_IN_USE: "desktop.officeAddin.error.portInUse",
  CERT_UNTRUSTED: "desktop.officeAddin.error.certUntrusted",
  CERT_MISSING: "desktop.officeAddin.error.startFailed",
  DATA_DIR_UNSAFE: "desktop.officeAddin.error.startFailed",
  BRIDGE_EXITED: "desktop.officeAddin.error.startFailed",
  START_TIMEOUT: "desktop.officeAddin.error.startFailed",
  SIDECAR_UNSUPPORTED: "desktop.officeAddin.error.startFailed",
  UNSAFE_PATH: "desktop.officeAddin.error.startFailed",
  // C63 / C65: `{{path}}` = both container Documents folders.
  OFFICE_NOT_INSTALLED: "desktop.officeAddin.error.notInstalled",
  INSTALL_FAILED: "desktop.officeAddin.error.startFailed",
  SERVER_UNAVAILABLE: "desktop.officeAddin.error.startFailed",
  ENABLE_FAILED: "desktop.officeAddin.error.startFailed",
}

/** Error dialog key for a failure code. */
/** @internal test seam */
export function errorKey(code: ControllerFailureCode): DesktopNativeKey {
  return ERROR_KEYS[code]
}

function unsafeDir(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "DATA_DIR_UNSAFE"
}

type FileSnapshot = { path: string; bytes: Uint8Array | undefined; mode: number }

/** The certificate files before Enable touched them, so rollback restores them byte for byte (SD §5.4). */
async function snapshotCertFiles(paths: CertPaths) {
  const dirExists = (dir: string) => nodeWefFs.exists(dir)
  const files: FileSnapshot[] = await Promise.all(
    [
      { path: paths.caCert, mode: 0o644 },
      { path: paths.caKeyEnc, mode: 0o600 },
      { path: paths.fingerprint, mode: 0o644 },
      { path: paths.leafKey, mode: 0o600 },
      { path: paths.leafCert, mode: 0o644 },
    ].map(async (file) => ({ ...file, bytes: await readFile(file.path).catch(() => undefined) })),
  )
  return {
    files,
    rootExisted: await dirExists(paths.root),
    caDirExisted: await dirExists(paths.caDir),
    tlsDirExisted: await dirExists(paths.tlsDir),
  }
}

async function restoreCertFiles(paths: CertPaths, snapshot: Awaited<ReturnType<typeof snapshotCertFiles>>) {
  // A root this flow created goes entirely (the bridge may have written pairings.json into it): "no office-addin/
  // directory when off" (M7-05).
  if (!snapshot.rootExisted) {
    await rm(paths.root, { recursive: true, force: true })
    return
  }
  for (const file of snapshot.files) {
    if (!file.bytes) {
      await rm(file.path, { force: true })
      continue
    }
    await mkdir(dirname(file.path), { recursive: true, mode: 0o700 })
    await writeFile(file.path, file.bytes, { mode: file.mode })
  }
  if (!snapshot.tlsDirExisted) await rm(paths.tlsDir, { recursive: true, force: true })
  if (!snapshot.caDirExisted) await rm(paths.caDir, { recursive: true, force: true })
}

// ── Controller ──

type BridgeRun = {
  child: BridgeChild
  /** True once `stop` was sent or the child was killed on purpose. */
  stopping: boolean
  /** Set on `ready`; commands other than start/stop/pair-decision are only accepted by a running bridge. */
  port: number | undefined
  exited: Promise<number>
}

type Undo = { step: EnableStep; run: () => Promise<unknown> }

type EnableProgress = { aborted: boolean; marker: EnableMarker | undefined }

export function createOfficeAddinController(deps: OfficeAddinControllerDeps): OfficeAddinController {
  const t = deps.t ?? nativeT
  const clock = deps.clock ?? systemControllerClock
  const home = deps.home ?? homedir()
  const wefRoots = deps.wefRoots ?? defaultWefRoots(home)
  const cacheRoot = deps.cacheRoot ?? defaultCacheRoot(home)
  const wefFs = deps.wefFs ?? nodeWefFs
  const port = deps.port ?? OFFICE_BRIDGE_PORT
  const dataDir = join(deps.userDataDir, OFFICE_BRIDGE_DATA_DIR)
  const resources = officeResourcePaths(deps.resources, deps.userDataDir)
  const log = deps.log
  const custodyPaths = officeCertPaths(deps.userDataDir)
  const custody = createKeyCustody({ safeStorage: deps.safeStorage, paths: custodyPaths, log })

  const state: {
    life: BridgeLifecycle
    bridge: BridgeRun | undefined
    renewal: RenewalTimer | undefined
    pending: Promise<unknown>
    pairQueue: Promise<unknown>
    pairOpen: boolean
    keychain: Keychain | undefined
    enabling: { progress: EnableProgress; done: Promise<EnableResult> } | undefined
  } = {
    life: { state: "off" },
    bridge: undefined,
    renewal: undefined,
    pending: Promise.resolve(),
    pairQueue: Promise.resolve(),
    pairOpen: false,
    keychain: deps.keychain,
    enabling: undefined,
  }
  const markerPath = join(dataDir, ENABLE_MARKER_FILE)

  const set = (life: BridgeLifecycle) => {
    state.life = life
    log("info", SOURCE, "office add-in state", life.state === "failed" ? { state: life.state, code: life.code } : { state: life.state })
    deps.onStateChange?.(life.state)
  }

  const keychain = async () => {
    if (state.keychain) return state.keychain
    const { createKeychain } = await import("./keychain")
    const { createExecFileRunner } = await import("../patch-common")
    state.keychain = createKeychain({ run: createExecFileRunner(), log, home })
    return state.keychain
  }

  const showBox = (options: MessageBoxOptions) =>
    deps.dialog.showMessageBox(options).catch((error: unknown) => {
      log("error", SOURCE, "dialog failed", errorFields(error))
      return { response: -1, checkboxChecked: false }
    })

  /** Error dialog, every string via `nativeT` (`errorKey`). Not awaited by the flows. */
  const showError = (code: ControllerFailureCode, params?: Record<string, string>) => {
    void showBox({ type: "error", message: t(errorKey(code), params), noLink: true })
  }

  // ── Bridge process ──

  const forwardStream = (stream: NodeJS.ReadableStream | null | undefined, fallback: "info" | "warn") => {
    // The entry writes one JSON object per line (office-bridge.ts `stdioBridgeLog`); it never logs a command payload.
    stream?.on("data", (chunk: Buffer | string) => {
      for (const line of chunk.toString().split("\n").filter((item) => item.trim().length > 0)) {
        const parsed: unknown = (() => {
          try {
            return JSON.parse(line)
          } catch {
            return undefined
          }
        })()
        if (!parsed || typeof parsed !== "object" || !("message" in parsed) || typeof parsed.message !== "string") {
          log(fallback, "office-bridge", "bridge output", { line: line.slice(0, 500) })
          continue
        }
        const level = "level" in parsed && (parsed.level === "warn" || parsed.level === "error") ? parsed.level : "info"
        const source = "source" in parsed && typeof parsed.source === "string" ? parsed.source : "office-bridge"
        const context = "context" in parsed && parsed.context && typeof parsed.context === "object" ? (parsed.context as Record<string, unknown>) : undefined
        log(level, source, parsed.message, context)
      }
    })
  }

  const onPairRequest = (run: BridgeRun, request: PairRequest) => {
    // CP-M4 I-2: at most ONE pair dialog at a time. An app-modal dialog cannot be closed at expiry, so a queue would
    // pile dialogs up; a request that arrives while one is open is denied at once (the pane may ask again).
    if (state.pairOpen) {
      log("warn", SOURCE, "pair request denied: another pair dialog is open", { host: request.host })
      if (state.bridge === run && !run.stopping) run.child.postMessage(buildPairDecisionCommand({ requestId: request.requestId, allow: false }))
      return
    }
    state.pairOpen = true
    state.pairQueue = (async () => {
      const outcome = await showPairDialog(request, deps.pairDialog).catch((error: unknown) => {
        log("error", SOURCE, "pair dialog failed", errorFields(error))
        return undefined
      })
      state.pairOpen = false
      if (!outcome || outcome.kind === "expired") {
        log("info", SOURCE, "pair request expired", { host: request.host })
        return
      }
      log("info", SOURCE, "pair decision", { host: request.host, choice: outcome.decision.allow ? "allow" : "deny" })
      if (state.bridge !== run || run.stopping) return
      run.child.postMessage(buildPairDecisionCommand(outcome.decision))
    })()
  }

  /**
   * Bridge exit nobody asked for (SD §5.3 "Bridge crash", SD-RC-4): `failed BRIDGE_EXITED`, logged under `utility`, the
   * startFailed dialog, and no automatic restart. Recovery is relaunch or Disable then Enable. An exit while starting is
   * reported by `startBridge` to the flow that started it, which shows its own dialog.
   */
  const onUnexpectedExit = (code: number) => {
    log("error", "utility", "office bridge exited", { code: BRIDGE_EXITED, exitCode: code })
    state.renewal?.stop()
    state.renewal = undefined
    state.bridge = undefined
    if (state.life.state !== "running" && state.life.state !== "failed") return
    set({ state: "failed", code: BRIDGE_EXITED })
    showError(BRIDGE_EXITED)
  }

  /** SD §5.4 step 5: fork with the minimal env, send `start`, wait for `ready` / `failed` / exit / 60 s. */
  const startBridge = async (config: BridgeStartConfig) => {
    const child = deps.fork(deps.bridgeEntryPath, [], {
      env: bridgeEnv(deps.baseEnv),
      serviceName: OFFICE_BRIDGE_SERVICE_NAME,
      stdio: "pipe",
    })
    forwardStream(child.stdout, "info")
    forwardStream(child.stderr, "warn")
    const exited = Promise.withResolvers<number>()
    const run: BridgeRun = { child, stopping: false, exited: exited.promise, port: undefined }
    state.bridge = run
    const started = Promise.withResolvers<{ ok: true; port: number } | { ok: false; code: BridgeFailureCode }>()

    child.on("exit", (code) => {
      exited.resolve(code)
      started.resolve({ ok: false, code: BRIDGE_EXITED })
      if (run.stopping || state.bridge !== run) return
      onUnexpectedExit(code)
    })
    child.on("message", (message) => {
      if (!isBridgeMessage(message)) {
        log("warn", SOURCE, "invalid bridge message dropped")
        return
      }
      if (message.type === "ready") {
        run.port = message.port
        started.resolve({ ok: true, port: message.port })
        return
      }
      if (message.type === "failed") {
        started.resolve({ ok: false, code: message.code })
        return
      }
      onPairRequest(run, message)
    })

    // START_TIMEOUT (register rev 5.2, main-only): the caller stops the child (`stop`, then a kill after 6 s) and shows
    // startFailed. A `ready` that arrives after the timeout is ignored: `started` has already settled.
    const cancel = clock.after(deps.startTimeoutMs ?? BRIDGE_START_TIMEOUT_MS, () => started.resolve({ ok: false, code: START_TIMEOUT }))
    child.postMessage(buildStartCommand(config))
    const result = await started.promise
    cancel()
    if (!result.ok) log("error", SOURCE, "office bridge did not start", { code: result.code })
    if (result.ok) log("info", SOURCE, "office bridge ready", { port: result.port })
    return result
  }

  /** `stop`, then a kill after 6 s (SD §5.3 "Quit"). Idempotent. */
  const stopBridge = async () => {
    const run = state.bridge
    if (!run) return
    state.renewal?.stop()
    state.renewal = undefined
    run.stopping = true
    state.bridge = undefined
    try {
      run.child.postMessage({ type: "stop" })
    } catch (error) {
      log("warn", SOURCE, "stop could not be sent", errorFields(error))
    }
    const timer = Promise.withResolvers<boolean>()
    const cancel = clock.after(deps.stopTimeoutMs ?? BRIDGE_STOP_TIMEOUT_MS, () => timer.resolve(true))
    const timedOut = await Promise.race([run.exited.then(() => false), timer.promise])
    cancel()
    if (!timedOut) return
    log("warn", SOURCE, "office bridge did not stop in time; killing it")
    run.child.kill()
  }

  const renewalDeps = async (send: RenewalDeps["send"]): Promise<RenewalDeps> => ({
    paths: custodyPaths,
    custody,
    keychain: await keychain(),
    send,
    log,
  })

  /**
   * SC-25: the 24 h leaf check while the bridge runs (the start-time check is in `launch` / Enable's `prepareTls`). A
   * renewed leaf goes to this child as `tls-update`. A failure makes the menu show `failed {code}` with its dialog once
   * (the bridge keeps serving the current leaf, and the timer keeps trying); a later good check returns to `running`.
   */
  const startRenewal = async () => {
    const { startRenewalTimer } = await import("./renewal")
    const run = state.bridge
    if (!run) return
    const alive = () => state.bridge === run && !run.stopping
    state.renewal = startRenewalTimer({
      deps: await renewalDeps((command) => {
        if (alive()) run.child.postMessage(command)
      }),
      clock,
      onResult: (result) => onRenewalResult(run, alive(), result),
    })
  }

  const onRenewalResult = (run: BridgeRun, alive: boolean, result: RenewalResult) => {
    if (!alive) return
    if (result.action === "failed") {
      log("error", SOURCE, "leaf renewal failed", { code: result.code })
      if (state.life.state !== "running") return
      set({ state: "failed", code: result.code })
      showError(result.code)
      return
    }
    if (state.life.state !== "failed" || run.port === undefined) return
    log("info", SOURCE, "leaf renewal recovered", { action: result.action })
    set({ state: "running", port: run.port })
  }

  const prepareDevResources = async () => {
    if (!resources.devPaneLink) return
    const link = resources.devPaneLink
    await mkdir(dirname(link.link), { recursive: true })
    await rm(link.link, { force: true })
    await symlink(link.target, link.link, "dir")
  }

  const startConfig = async (server: SidecarCredentials, tls: LeafTls): Promise<BridgeStartConfig> => {
    await prepareDevResources()
    return {
      serverUrl: server.url,
      username: server.username,
      password: server.password,
      userDataDir: deps.userDataDir,
      resourcesDir: resources.resourcesDir,
      port,
      cert: tls.cert,
      key: tls.key,
    }
  }

  const readLeaf = async (): Promise<LeafTls | undefined> => {
    const cert = await readFile(custodyPaths.leafCert, "utf8").catch(() => undefined)
    const key = await readFile(custodyPaths.leafKey, "utf8").catch(() => undefined)
    if (!cert || !key) return undefined
    return { cert, key }
  }

  // ── Finder-guided fallback (U11; SD §12.2) ──

  /**
   * F-M7-2 / C63: open the wef.ts `reveal` entries, each the nearest path at or above a refusing one that `lstat`
   * reports as a real directory (never a symlink, a file or an app reached through a link).
   */
  const revealRefused = async (reveal: string[]) => {
    for (const target of reveal) {
      const error = await deps.shell.openPath(target).catch((caught: unknown) => String(caught))
      if (error) log("warn", SOURCE, "Finder could not open a wef folder", { path: target, error: error.slice(0, 200) })
    }
  }

  const showInstallGuide = async (refused: string[], reveal: string[]) => {
    log("warn", SOURCE, "wef install refused; Finder-guided copy", { refused })
    deps.shell.showItemInFolder(resources.manifestPath)
    await revealRefused(reveal)
    await showBox({
      type: "warning",
      message: t("desktop.officeAddin.error.installFailed", { path: refused.join(", ") }),
      noLink: true,
    })
  }

  /** Uninstall mirror (U11, C49 D6): open each refusing folder, then `uninstallFailed` with the folders. */
  const showUninstallGuide = async (refused: string[], reveal: string[]) => {
    log("warn", SOURCE, "wef uninstall refused; Finder-guided delete", { refused })
    await revealRefused(reveal)
    await showBox({
      type: "warning",
      message: t("desktop.officeAddin.error.uninstallFailed", { path: refused.join(", ") }),
      noLink: true,
    })
  }

  // ── Enable (SD §5.4) ──

  const rollback = async (undo: Undo[]) => {
    for (const item of [...undo].reverse()) {
      await item.run().catch((error: unknown) => log("error", SOURCE, "rollback step failed", { step: item.step, ...errorFields(error) }))
    }
  }

  /** Steps 1-4. Pushes an undo for each change it makes; `commit` holds work that runs only after step 8. */
  const prepareTls = async (input: {
    undo: Undo[]
    commit: (() => Promise<unknown>)[]
    progress: EnableProgress
    checkpoint: () => void
  }) => {
    const undo = input.undo
    const commit = input.commit
    const checkpoint = input.checkpoint
    const x509 = await import("./certs")
    const { finishPendingRemoval } = await import("./renewal")
    const chain = await keychain()
    // C49 D4: finish an old-CA removal a crashed rotation (or an earlier Enable) left in `ca/previous/`, as checkLeaf
    // does at every bridge start. No backup: no keychain call and nothing created.
    const rotation = await renewalDeps(() => {})
    await finishPendingRemoval(rotation)
    checkpoint()
    const snapshot = await snapshotCertFiles(custodyPaths)
    undo.push({ step: "ca", run: () => restoreCertFiles(custodyPaths, snapshot) })
    // M7-04a: the marker is on disk before any certificate or keychain change, so a quit or crash from here on is
    // reconciled at the next menu action even when the process dies inside the trust prompt.
    await saveMarker(input.progress, { rootCreated: !snapshot.rootExisted })
    const now = clock.now()
    const caPem = await readFile(custodyPaths.caCert, "utf8").catch(() => undefined)
    const retained = caPem ? await custody.readCaKey() : ({ state: "absent" } as const)

    // Step 1, reuse: a retained CA whose key decrypts. Renew the leaf if due; if the chain already verifies, no
    // keychain prompt at all (the Disable-without-removal branch, C11 OQ-5).
    if (caPem && retained.state === "ok") {
      const renewed = await x509.renewLeafIfDue({ paths: custodyPaths, now, caKey: async () => retained.key })
      if ("error" in renewed) return { ok: false as const, step: "leaf" as const, code: renewed.error }
      checkpoint()
      if (await chain.verify(custodyPaths.leafCert)) return { ok: true as const }
      checkpoint()
      const print = (await x509.readFingerprint(custodyPaths)) ?? x509.fingerprint(caPem)
      undo.push({ step: "trust", run: () => chain.remove({ caCertPath: custodyPaths.caCert, sha1: print.sha1 }) })
      await saveMarker(input.progress, { trustSha1: print.sha1 })
      const trusted = await chain.trust(custodyPaths.caCert)
      checkpoint()
      if (!trusted.ok) return { ok: false as const, step: "trust" as const, code: trusted.code }
      if (!(await chain.verify(custodyPaths.leafCert))) return { ok: false as const, step: "verify" as const, code: "CERT_UNTRUSTED" as const }
      return { ok: true as const }
    }

    // Step 1, new CA (none, SC-22 mode, or C26(c) unreadable blob). C49 D4: the old CA goes to `ca/previous/` first
    // (renewal.ts crash-safe order); it is removed from the keychain by its recorded SHA-1 by `finishPendingRemoval`
    // only after the whole flow committed. A rollback drops the backup and restores the old files.
    if (caPem) {
      await x509.writePreviousCa(custodyPaths, caPem, (await x509.readFingerprint(custodyPaths)) ?? x509.fingerprint(caPem))
      undo.push({ step: "ca", run: () => rm(custodyPaths.previousDir, { recursive: true, force: true }) })
      commit.push(() => finishPendingRemoval(rotation))
    }
    const ca = await x509.createCa(now)
    if (retained.state === "unreadable") await custody.discard()
    const print = await x509.writeCa({ paths: custodyPaths, ca, encryptKey: custody.encryptKey() })
    await saveMarker(input.progress, { newCaSha1: print.sha1 })
    // Step 4 runs before 2-3 here: `security verify-cert` needs the leaf. In the SC-22 mode the CA key is not
    // written (no `encryptKey`) and goes out of scope with `ca` right after this issue.
    await x509.writeLeaf(custodyPaths, await x509.issueLeaf(ca, now))
    checkpoint()
    // Step 2. The undo is registered first: a half-applied add-trusted-cert is still removed by hash.
    undo.push({ step: "trust", run: () => chain.remove({ caCertPath: custodyPaths.caCert, sha1: print.sha1 }) })
    await saveMarker(input.progress, { trustSha1: print.sha1 })
    const trusted = await chain.trust(custodyPaths.caCert)
    // A quit while the trust prompt was open: never run `verify` (or any keychain call) during quit.
    checkpoint()
    if (!trusted.ok) return { ok: false as const, step: "trust" as const, code: trusted.code }
    // Step 3.
    if (!(await chain.verify(custodyPaths.leafCert))) return { ok: false as const, step: "verify" as const, code: "CERT_UNTRUSTED" as const }
    return { ok: true as const }
  }

  // ── Enable marker (M7-04a, F-M7-1) ──

  /** `office-addin/` must be a real directory (not a symlink, not a file) before main writes the marker into it. */
  const realDataDir = () =>
    lstat(dataDir).then(
      (stats) => (stats.isDirectory() && !stats.isSymbolicLink() ? ("real" as const) : ("unsafe" as const)),
      () => "absent" as const,
    )

  const saveMarker = async (progress: EnableProgress, patch: Partial<EnableMarker>) => {
    const dir = await realDataDir()
    if (dir === "unsafe") throw Object.assign(new Error("office-addin data directory is unsafe"), { code: "DATA_DIR_UNSAFE" })
    if (dir === "absent") await mkdir(dataDir, { recursive: true, mode: 0o700 })
    const marker: EnableMarker = { ...(progress.marker ?? { rootCreated: false }), ...patch, version: 1 }
    progress.marker = marker
    await writeFile(markerPath, `${JSON.stringify(marker)}\n`, { mode: 0o600 })
  }

  const readMarker = async (): Promise<EnableMarker | undefined> => {
    if ((await realDataDir()) !== "real") return undefined
    const text = await readFile(markerPath, "utf8").catch(() => undefined)
    if (!text) return undefined
    const parsed: unknown = (() => {
      try {
        return JSON.parse(text)
      } catch {
        return undefined
      }
    })()
    if (!parsed || typeof parsed !== "object") return { version: 1, rootCreated: false }
    const record = parsed as Record<string, unknown>
    const sha1 = (value: unknown) => (typeof value === "string" && /^[0-9A-F]{40}$/.test(value) ? value : undefined)
    return {
      version: 1,
      rootCreated: record.rootCreated === true,
      newCaSha1: sha1(record.newCaSha1),
      trustSha1: sha1(record.trustSha1),
    }
  }

  const dropMarker = () => rm(markerPath, { force: true })

  /**
   * Next menu action after an interrupted Enable (M7-04a). Setting true: the Enable committed, the marker is stale.
   * Setting false: undo what the marker records, now that the user is acting (a keychain prompt is acceptable here,
   * never at quit): remove our trust by SHA-1, the wef copies, our CA files (or the whole `office-addin/` this Enable
   * created) and `pairings.json`; then finish a `ca/previous/` removal. A failed keychain removal keeps the files and
   * the marker for the next action. No dialog: the action the user clicked shows its own.
   */
  const reconcile = async () => {
    if (state.enabling || state.bridge || state.life.state !== "off") return
    const marker = await readMarker()
    if (!marker) return
    if (deps.settings.enabled()) {
      log("info", SOURCE, "enable marker dropped: the Enable had committed")
      await dropMarker()
      return
    }
    log("warn", SOURCE, "interrupted Enable found; rolling it back", { trustAdded: marker.trustSha1 !== undefined, rootCreated: marker.rootCreated })
    if (marker.trustSha1) {
      const chain = await keychain()
      const removal = await chain.remove({ caCertPath: custodyPaths.caCert, sha1: marker.trustSha1 }).catch((error: unknown) => {
        log("error", SOURCE, "keychain removal threw", errorFields(error))
        return { trustRemoved: false, deleted: false }
      })
      if (!removal.deleted) {
        log("error", SOURCE, "interrupted Enable: CA still in the login keychain; kept for retry", { reason: "remove-failed" })
        return
      }
    }
    const uninstalled = await uninstallManifest({ roots: wefRoots, fs: wefFs })
    if (uninstalled.refused.length > 0 || uninstalled.failed.length > 0) {
      log("warn", SOURCE, "interrupted Enable: wef copies left", { refused: uninstalled.refused, failed: uninstalled.failed.map((item) => item.code) })
    }
    if (marker.rootCreated) {
      await rm(dataDir, { recursive: true, force: true })
      log("info", SOURCE, "interrupted Enable rolled back", { removed: "office-addin" })
      return
    }
    const current = await readFile(custodyPaths.fingerprint, "utf8")
      .then((text) => (JSON.parse(text) as { sha1?: unknown }).sha1)
      .catch(() => undefined)
    if (marker.newCaSha1 && current === marker.newCaSha1) {
      await Promise.all([custodyPaths.caCert, custodyPaths.caKeyEnc, custodyPaths.fingerprint].map((path) => rm(path, { force: true })))
      await rm(custodyPaths.tlsDir, { recursive: true, force: true })
    }
    await rm(pairingsPath(dataDir), { force: true })
    await finishRotation()
    await dropMarker()
    log("info", SOURCE, "interrupted Enable rolled back", { removed: marker.newCaSha1 ? "new-ca" : "trust" })
  }

  const enable = async (): Promise<EnableResult> => {
    if (state.life.state !== "off" && state.life.state !== "failed") return { ok: false, reason: "busy" }
    // F-M7-5 / C5: the bridge supports the v1 sidecar only; under v2 (the same env switch index.ts reads) Enable stops
    // here with startFailed and changes nothing.
    if (deps.baseEnv.OPENCODE_SIDECAR_V2 === "1") {
      log("warn", SOURCE, "enable refused: the v2 sidecar is not supported", { code: "SIDECAR_UNSUPPORTED" })
      showError("SIDECAR_UNSUPPORTED")
      return { ok: false, reason: "unsupported" }
    }
    const progress: EnableProgress = { aborted: false, marker: undefined }
    const done = runEnable(progress)
    state.enabling = { progress, done }
    return done.finally(() => {
      if (state.enabling?.done === done) state.enabling = undefined
    })
  }

  const runEnable = async (progress: EnableProgress): Promise<EnableResult> => {
    // From `failed` (a launch-time start failure) the old child is gone or idle; make sure.
    await stopBridge()
    set({ state: "starting" })
    const undo: Undo[] = []
    const commit: (() => Promise<unknown>)[] = []
    const checkpoint = () => {
      if (progress.aborted) throw new EnableAborted()
    }
    /**
     * Quit interrupted the flow (F-M7-1): undo without the keychain and without a dialog. When a trust was (possibly)
     * added, the CA files and the marker stay so the next menu action can remove that trust by SHA-1 (`reconcile`);
     * otherwise everything is undone here and the marker goes.
     */
    const abort = async (): Promise<EnableResult> => {
      const trustAttempted = progress.marker?.trustSha1 !== undefined
      log("warn", SOURCE, "enable interrupted by quit; rolling back without the keychain", { trustAttempted })
      await rollback(undo.filter((item) => item.step !== "trust" && !(trustAttempted && item.step === "ca")))
      if (!trustAttempted) await dropMarker().catch((error: unknown) => log("error", SOURCE, "enable marker not removed", errorFields(error)))
      set({ state: "off" })
      return { ok: false, reason: "aborted" }
    }
    const fail = async (step: EnableStep, code: ControllerFailureCode, params?: Record<string, string>) => {
      if (progress.aborted) return abort()
      log("error", SOURCE, "enable failed; rolling back", { step, code })
      await rollback(undo)
      await dropMarker().catch((error: unknown) => log("error", SOURCE, "enable marker not removed", errorFields(error)))
      set({ state: "off" })
      showError(code, params)
      return { ok: false as const, step, code }
    }

    const outcome = await (async (): Promise<EnableResult> => {
      const server = await deps.server().catch((error: unknown) => {
        log("error", SOURCE, "sidecar credentials unavailable", errorFields(error))
        return undefined
      })
      if (!server) return fail("server", "SERVER_UNAVAILABLE")
      checkpoint()

      const tls = await prepareTls({ undo, commit, progress, checkpoint })
      if (!tls.ok) return fail(tls.step, tls.code)
      checkpoint()
      const leaf = await readLeaf()
      if (!leaf) return fail("leaf", "CERT_MISSING")

      // Step 5.
      undo.push({ step: "start", run: stopBridge })
      const started = await startBridge(await startConfig(server, leaf))
      if (!started.ok) return fail("start", started.code)
      checkpoint()

      // Step 6: attempt; refused roots go to the Finder-guided copy, any other failure rolls everything back.
      const installed = await installManifest({ manifestPath: resources.manifestPath, roots: wefRoots, fs: wefFs })
      if (installed.done.length > 0) undo.push({ step: "install", run: () => uninstallManifest({ roots: installed.done, fs: wefFs }) })
      if (installed.rollbackErrors.length > 0) log("error", SOURCE, "wef rollback left changes", { errors: installed.rollbackErrors })
      if (installed.failed.length > 0) {
        log("error", SOURCE, "wef install failed", { failed: installed.failed.map((item) => ({ path: item.path, code: item.code })) })
        return fail("install", installed.failed.some((item) => item.code === UNSAFE_PATH) ? "UNSAFE_PATH" : "INSTALL_FAILED")
      }
      // C63 (M7-02a, F-M7-6): a host whose container `Data/Documents` does not exist is skipped. One skipped host is
      // logged and Enable continues; neither Word nor Excel installed is a failure (notInstalled with both paths, C65).
      if (installed.notInstalled.length > 0) log("warn", SOURCE, "Office host not installed; skipped", { notInstalled: installed.notInstalled })
      if (installed.notInstalled.length === wefRoots.length) {
        return fail("install", "OFFICE_NOT_INSTALLED", { path: wefRoots.map((root) => dirname(root)).join(", ") })
      }
      checkpoint()

      // Step 8 before step 7 (the order is open for M7-03, SD §5.4): the notice must not claim "on" before the setting
      // is committed, and a dialog waiting for the user must not hold the `starting` state.
      const persisted = await Promise.resolve()
        .then(() => deps.settings.setEnabled(true))
        .then(
          () => true,
          (error: unknown) => {
            log("error", SOURCE, "officeAddinEnabled could not be saved", errorFields(error))
            return false
          },
        )
      if (!persisted) return fail("persist", "ENABLE_FAILED")
      await dropMarker().catch((error: unknown) => log("warn", SOURCE, "enable marker not removed", errorFields(error)))
      // Committed, but quit came meanwhile: the bridge is already stopped; the `ca/previous/` removal (a keychain call)
      // waits for the next bridge start (`checkLeaf`).
      if (progress.aborted) {
        log("info", SOURCE, "enable committed during quit; post-enable cleanup deferred")
        set({ state: "off" })
        return { ok: false, reason: "aborted" }
      }

      for (const item of commit) {
        await item().catch((error: unknown) => log("warn", SOURCE, "post-enable cleanup failed", errorFields(error)))
      }
      set({ state: "running", port: started.port })
      await startRenewal()

      // Step 7.
      if (installed.refused.length > 0) {
        void showInstallGuide(installed.refused, installed.reveal)
        return { ok: true, install: "guided", refused: installed.refused }
      }
      void showBox({ type: "info", message: t("desktop.officeAddin.installed"), noLink: true })
      return { ok: true, install: "installed", refused: [] }
    })().catch(async (error: unknown) => {
      if (error instanceof EnableAborted || progress.aborted) return abort()
      // certs.ts refuses a symlinked or non-directory certificate path (F-M3-4): DATA_DIR_UNSAFE, nothing written.
      if (unsafeDir(error)) {
        log("error", SOURCE, "certificate directory is unsafe", { code: "DATA_DIR_UNSAFE" })
        return fail("ca", "DATA_DIR_UNSAFE")
      }
      log("error", SOURCE, "enable threw", errorFields(error))
      return fail("start", "ENABLE_FAILED")
    })
    return outcome
  }

  // ── Disable (SD §5.3, §13.2) ──

  const disable = async (): Promise<DisableResult> => {
    if (state.life.state !== "running" && state.life.state !== "failed") return { ok: false, reason: "busy" }
    const answer = await showBox({
      type: "question",
      message: t("desktop.officeAddin.disable.confirm"),
      checkboxLabel: t("desktop.officeAddin.disable.removeCertificate"),
      checkboxChecked: true,
      // Cancel label: the existing `desktop.patch.cancel` key is reused (no Office-specific key in the register; see row report).
      buttons: [t("desktop.officeAddin.disable.confirmButton"), t("desktop.patch.cancel")],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    })
    if (answer.response !== 0) {
      // The native checkbox already flipped on click; rebuild so it shows the unchanged state again.
      deps.onStateChange?.(state.life.state)
      return { ok: false, reason: "cancelled" }
    }
    const removeCertificate = answer.checkboxChecked
    log("info", SOURCE, "disable confirmed", { removeCertificate })
    set({ state: "stopping" })

    await stopBridge()
    const uninstalled = await uninstallManifest({ roots: wefRoots, fs: wefFs })
    if (uninstalled.failed.length > 0) {
      log("error", SOURCE, "wef uninstall failed", { failed: uninstalled.failed.map((item) => ({ path: item.path, code: item.code })) })
    }
    await rm(pairingsPath(dataDir), { force: true }).catch((error: unknown) => log("error", SOURCE, "pairings.json not deleted", errorFields(error)))
    await Promise.resolve()
      .then(() => deps.settings.setEnabled(false))
      .catch((error: unknown) => log("error", SOURCE, "officeAddinEnabled could not be cleared", errorFields(error)))

    // C49 D4: both branches finish a pending old-CA removal; the checked branch then removes the current CA.
    await finishRotation()
    const certificate = removeCertificate ? await removeCertificateFiles() : "kept-by-choice"
    set({ state: "off" })
    // C65 (F-M7-4): one dialog per Disable whose keychain removal failed; the `ca/previous/` retry stays.
    if (certificate === "removal-pending") {
      void showBox({ type: "warning", message: t("desktop.officeAddin.error.certRemovalFailed"), noLink: true })
    }
    if (uninstalled.refused.length > 0) void showUninstallGuide(uninstalled.refused, uninstalled.reveal)
    return { ok: true, removedCertificate: removeCertificate, uninstallRefused: uninstalled.refused }
  }

  const finishRotation = async () => {
    const { finishPendingRemoval } = await import("./renewal")
    const outcome = await finishPendingRemoval(await renewalDeps(() => {})).catch((error: unknown) => {
      log("error", SOURCE, "pending CA removal threw", errorFields(error))
      return "kept" as const
    })
    if (outcome !== "none") log("info", SOURCE, "pending CA removal at disable", { outcome })
  }

  /** Checked branch: keychain removal by recorded SHA-1 (§7.4), then `ca/` and `tls/`. `workspace/` stays. */
  const removeCertificateFiles = async () => {
    const caPem = await readFile(custodyPaths.caCert, "utf8").catch(() => undefined)
    if (caPem) {
      const x509 = await import("./certs")
      const print = (await x509.readFingerprint(custodyPaths)) ?? x509.fingerprint(caPem)
      const chain = await keychain()
      const removal = await chain
        .remove({ caCertPath: custodyPaths.caCert, sha1: print.sha1 })
        .catch((error: unknown) => {
          log("error", SOURCE, "keychain removal threw", errorFields(error))
          return { trustRemoved: false, deleted: false }
        })
      log(removal.deleted ? "info" : "error", SOURCE, "CA removal from the login keychain", removal)
      // F-M7-4: a failed removal keeps the CA record (cert + recorded SHA-1) in `ca/previous/`, so the existing
      // `finishPendingRemoval` retries it at the next Enable or bridge start; the key and the current files still go.
      if (!removal.deleted) {
        await x509.writePreviousCa(custodyPaths, caPem, print)
        await Promise.all([custodyPaths.caCert, custodyPaths.caKeyEnc, custodyPaths.fingerprint].map((path) => rm(path, { force: true })))
        await rm(custodyPaths.tlsDir, { recursive: true, force: true })
        log("error", SOURCE, "CA kept in ca/previous/ for a retry", { reason: "remove-failed" })
        return "removal-pending" as const
      }
    }
    await rm(custodyPaths.caDir, { recursive: true, force: true })
    await rm(custodyPaths.tlsDir, { recursive: true, force: true })
    return "removed" as const
  }

  // ── Launch (SD §5.3; C26(a)) ──

  const launch = async (): Promise<LaunchResult> => {
    if (!deps.settings.enabled()) return { ok: false, reason: "disabled" }
    if (deps.baseEnv.OPENCODE_SIDECAR_V2 === "1") return { ok: false, reason: "unsupported" }
    if (state.life.state !== "off") return { ok: false, reason: "busy" }
    // With the setting true a leftover marker is stale (the Enable committed); no keychain call at launch.
    await reconcile().catch((error: unknown) => log("error", SOURCE, "enable reconcile threw", errorFields(error)))
    set({ state: "starting" })
    const failLaunch = (code: ControllerFailureCode) => {
      set({
        state: "failed",
        code:
          code === "INSTALL_FAILED" ||
          code === "SERVER_UNAVAILABLE" ||
          code === "ENABLE_FAILED" ||
          code === "SIDECAR_UNSUPPORTED" ||
          code === "UNSAFE_PATH" ||
          code === "OFFICE_NOT_INSTALLED"
            ? BRIDGE_EXITED
            : code,
      })
      showError(code)
      return { ok: false as const, code }
    }
    return (async (): Promise<LaunchResult> => {
      const server = await deps.server().catch(() => undefined)
      if (!server) return failLaunch("SERVER_UNAVAILABLE")
      const { checkLeaf } = await import("./renewal")
      // Before the fork there is no child: a renewed leaf is read from disk below, so `tls-update` is not needed.
      const renewal = await checkLeaf({ paths: custodyPaths, custody, keychain: await keychain(), send: () => {}, log }, clock.now())
      if (renewal.action === "failed") return failLaunch(renewal.code)
      const leaf = await readLeaf()
      if (!leaf) return failLaunch("CERT_MISSING")
      const started = await startBridge(await startConfig(server, leaf))
      if (!started.ok) {
        await stopBridge()
        return failLaunch(started.code)
      }
      set({ state: "running", port: started.port })
      await startRenewal()
      return { ok: true, resynced: await resync() }
    })().catch(async (error: unknown) => {
      log("error", SOURCE, "launch threw", errorFields(error))
      await stopBridge()
      return failLaunch("ENABLE_FAILED")
    })
  }

  /** C26(a): re-copy the manifest into roots whose copy is missing or differs from the bundled one. No Finder flow. */
  const resync = async () => {
    const bundled = await wefFs.readFile(resources.manifestPath).catch(() => undefined)
    if (!bundled) {
      log("error", SOURCE, "bundled manifest missing", { path: resources.manifestPath })
      return []
    }
    const stale = (
      await Promise.all(
        wefRoots.map(async (root) => ((await needsResync(bundled, join(root, OFFICE_MANIFEST_FILE), wefFs).catch(() => false)) ? root : undefined)),
      )
    ).filter((root): root is string => root !== undefined)
    if (stale.length === 0) return []
    const result = await installManifest({ manifestPath: resources.manifestPath, roots: stale, fs: wefFs })
    log(result.ok ? "info" : "warn", SOURCE, "wef manifest re-sync", {
      done: result.done,
      refused: result.refused,
      failed: result.failed.map((item) => ({ path: item.path, code: item.code })),
    })
    return result.done
  }

  // ── Disconnect and Clear cache (SD §11.4, §12.3; SC-16) ──

  /**
   * Empty the pairing set. Running bridge: `pairings-cleared` (the bridge empties its set and writes the empty store).
   * No bridge: main writes the empty store through pairing-store.ts, but only when `office-addin/` exists (nothing to
   * clear otherwise, and "no office-addin/ directory when off"). A bridge that is starting or stopping is skipped: it
   * would ignore the command, and writing the file under it would race its own store.
   */
  const clearPairings = async (): Promise<DisconnectResult> => {
    const run = state.bridge
    if (run && !run.stopping && run.port !== undefined) {
      run.child.postMessage({ type: "pairings-cleared" })
      log("info", SOURCE, "pairings cleared", { via: "bridge" })
      return { cleared: "bridge" }
    }
    if (run) {
      log("warn", SOURCE, "pairings not cleared during a transition", { state: state.life.state })
      return { cleared: "skipped", reason: "transition" }
    }
    if (!(await wefFs.exists(dataDir).catch(() => false))) return { cleared: "none" }
    const store = createPairingStore({ dir: dataDir, log: (event, fields) => log("info", "office-bridge.pairing-store", event, fields) })
    return store.clear().then(
      () => {
        log("info", SOURCE, "pairings cleared", { via: "file" })
        return { cleared: "file" as const }
      },
      (error: unknown) => {
        log("error", SOURCE, "pairings.json not cleared", errorFields(error))
        return { cleared: "skipped" as const, reason: "error" as const }
      },
    )
  }

  const disconnect = () => clearPairings()

  const clearOfficeCache = async (): Promise<ClearCacheResult> => {
    if (state.life.state === "starting" || state.life.state === "stopping") return { ok: false, reason: "busy" }
    const answer = await showBox({
      type: "question",
      message: t("desktop.officeAddin.clearCache.confirm"),
      buttons: [t("desktop.officeAddin.clearCache.confirmButton"), t("desktop.patch.cancel")],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    })
    if (answer.response !== 0) return { ok: false, reason: "cancelled" }
    const cleared = await clearCache({ root: cacheRoot, fs: wefFs })
    log(cleared.ok ? "info" : "warn", SOURCE, "office cache cleared", {
      removed: cleared.done.length,
      refused: cleared.refused,
      failed: cleared.failed.map((item) => ({ path: item.path, code: item.code })),
    })
    // A refusal (TCC, as for wef) opens the cache folder in Finder; there is no register string for it, so no dialog.
    // An entry inside the root reveals the root itself (clearCache lstat-checked it as a real directory before reading
    // it), so a TCC refusal of every entry opens one Finder window, not one per entry.
    if (cleared.refused.length > 0) {
      await revealRefused([...new Set(cleared.reveal.map((target) => (target.startsWith(`${cacheRoot}/`) ? cacheRoot : target)))])
    }
    const pairings = await clearPairings()
    return { ok: true, removed: cleared.done.length, refused: cleared.refused, failed: cleared.failed.length, pairings }
  }

  /**
   * Quit / relaunch / update (SD §5.3): stop the bridge only; never the keychain or wef. An in-flight Enable is asked to
   * stop at its next checkpoint (F-M7-1) and awaited up to the stop budget (6 s); one blocked in the trust prompt leaves
   * its marker for `reconcile`.
   */
  const shutdown = async () => {
    const enabling = state.enabling
    if (!state.bridge && !enabling) return
    if (enabling) enabling.progress.aborted = true
    if (state.bridge) {
      set({ state: "stopping" })
      await stopBridge()
    }
    if (enabling) {
      const timer = Promise.withResolvers<void>()
      const cancel = clock.after(deps.stopTimeoutMs ?? BRIDGE_STOP_TIMEOUT_MS, () => timer.resolve())
      const settled = await Promise.race([enabling.done.then(() => true), timer.promise.then(() => false)])
      cancel()
      if (!settled) log("warn", SOURCE, "enable still waiting at quit; its marker is reconciled at the next menu action")
    }
    if (state.life.state !== "off") set({ state: "off" })
  }

  // ── Menu (M7-01 handler names) ──

  /** Menu actions run one after another, each after reconciling an interrupted Enable (M7-04a). */
  const track = (work: () => Promise<unknown>) => {
    state.pending = state.pending
      .then(() => reconcile().catch((error: unknown) => log("error", SOURCE, "enable reconcile threw", errorFields(error))))
      .then(work)
      .catch((error: unknown) => log("error", SOURCE, "menu action threw", errorFields(error)))
  }

  const toggle = () => {
    const current = state.life.state
    if (current === "off") return track(enable)
    if (current === "running" || current === "failed") return track(disable)
    log("info", SOURCE, "toggle ignored during a transition", { state: current })
  }

  return {
    lifecycle: () => state.life,
    state: () => state.life.state,
    enable,
    disable,
    launch,
    disconnect,
    clearCache: clearOfficeCache,
    shutdown,
    menuHandlers: () => ({
      officeAddinState: () => state.life.state,
      officeAddinToggle: toggle,
      officeAddinDisconnect: () => track(disconnect),
      officeAddinClearCache: () => track(clearOfficeCache),
    }),
    idle: async () => {
      await state.pending
      await state.pairQueue
    },
  }
}
