// Messages between Electron main and the office-bridge utility process (row 43, plan M1-02; server-delta spec §5.1,
// §5.2, §6; register rev 4 §3, §4, §7.6). Shared by the main-side controller and the bridge entry (office-bridge.ts),
// which is a thin adapter over the Electron-free bridge core (TS-RC-2 / TR-5). No Electron import.
//
// Secrets: the sidecar password and the leaf key travel only in `start` / `tls-update` (postMessage, in memory). Never in
// env, argv, a file or a log line (spec §6). The CA private key is never sent (spec PM-2). Main holds every other
// per-launch secret of the desktop; none of them is a field here (SC-34).

export const OFFICE_BRIDGE_SERVICE_NAME = "office-bridge"

/** Office hosts that can pair (register §5 pairing store schema). */
export type OfficeHost = "Word" | "Excel"
export const OFFICE_HOSTS: readonly OfficeHost[] = ["Word", "Excel"]

// ── Failure codes (register §7.6) ──

/** Codes the bridge reports to main in `failed` at start (register §7.6 "(bridge start)"; rev 5 adds DATA_DIR_UNSAFE, SC-12, C25). */
type BridgeStartFailureCode = "PORT_IN_USE" | "CERT_UNTRUSTED" | "CERT_MISSING" | "DATA_DIR_UNSAFE"
const BRIDGE_START_FAILURE_CODES: readonly BridgeStartFailureCode[] = ["PORT_IN_USE", "CERT_UNTRUSTED", "CERT_MISSING", "DATA_DIR_UNSAFE"]

/** Main-side only: the utility process exited unexpectedly (SD-RC-4). Never sent over the wire. */
type BridgeExitedCode = "BRIDGE_EXITED"
export const BRIDGE_EXITED: BridgeExitedCode = "BRIDGE_EXITED"

/** Main-side only: the 60 s start timeout elapsed with no `ready` or `failed` (C25). Never sent over the wire. */
type BridgeStartTimeoutCode = "START_TIMEOUT"
export const START_TIMEOUT: BridgeStartTimeoutCode = "START_TIMEOUT"

/** Every failure code main can hold for the bridge (the `failed` lifecycle state's cause). */
export type BridgeFailureCode = BridgeStartFailureCode | BridgeExitedCode | BridgeStartTimeoutCode

// ── Lifecycle (spec §5.2; internal to main, no IPC channel exposes it: C11 OQ-3, IA-6) ──

export type BridgeLifecycleState = "off" | "starting" | "running" | "failed" | "stopping"
const BRIDGE_LIFECYCLE_STATES: readonly BridgeLifecycleState[] = ["off", "starting", "running", "failed", "stopping"]

/** Main's view of the bridge. `failed` carries the code that drives the error dialog (spec §5.3). */
export type BridgeLifecycle =
  | { state: "off" }
  | { state: "starting" }
  | { state: "running"; port: number }
  | { state: "failed"; code: BridgeFailureCode }
  | { state: "stopping" }

// ── Shared payloads ──

/** Leaf certificate and its private key, both PEM. Issued and renewed by main (spec §7). */
export type LeafTls = {
  cert: string
  key: string
}

/** The fields of `start`, minus the discriminant. Also the input of the in-process bridge core (TS-RC-2). */
export type BridgeStartConfig = {
  /** Sidecar base URL from main's `serverReady` (spec §6), e.g. `http://127.0.0.1:<port>`. Only host and port are logged. */
  serverUrl: string
  /** Sidecar Basic-auth user (`opencode`, sidecar-start.ts). */
  username: string
  /** Per-launch sidecar password. Held in a closure, never serialised or logged (spec §6). */
  password: string
  /** `<userData>` of the desktop app; the bridge uses `<userDataDir>/office-addin/` (register §3). */
  userDataDir: string
  /** Packaged or dev root that holds `office-addin/pane/` (register §3). */
  resourcesDir: string
  /** Listen port: 46317 in production, 47317 in tests (TS-RC-1). Host/Origin allow-values derive from it. */
  port: number
  /** Leaf certificate, PEM. */
  cert: string
  /** Leaf private key, PEM. */
  key: string
}

/** Bridge -> main: a pane asked to pair. Carries only the correct code; main generates the two decoys (RM-19). */
export type PairRequest = {
  /** base64url of 16 random bytes (register §5 `POST /pair/request`). */
  requestId: string
  host: OfficeHost
  /** 4 decimal digits; for visual matching, not a secret (register §5). */
  code: string
}

/** Main -> bridge: the user's answer in the number-matching dialog (spec §11.2). */
export type PairDecision = {
  requestId: string
  allow: boolean
}

// ── Wire messages (register §3 "Main-to-bridge messages") ──

type BridgeStartCommand = { type: "start" } & BridgeStartConfig
export type BridgeTlsUpdateCommand = { type: "tls-update" } & LeafTls
type BridgePairDecisionCommand = { type: "pair-decision" } & PairDecision
type BridgePairingsClearedCommand = { type: "pairings-cleared" }
type BridgeStopCommand = { type: "stop" }

/** main -> bridge. */
export type BridgeCommand =
  | BridgeStartCommand
  | BridgeTlsUpdateCommand
  | BridgePairDecisionCommand
  | BridgePairingsClearedCommand
  | BridgeStopCommand

type BridgeReadyMessage = { type: "ready"; port: number }
type BridgeFailedMessage = { type: "failed"; code: BridgeStartFailureCode }
type BridgePairRequestMessage = { type: "pair-request" } & PairRequest

/** bridge -> main. */
export type BridgeMessage = BridgeReadyMessage | BridgeFailedMessage | BridgePairRequestMessage

// ── Bridge core factory (TS-RC-2 / TR-5): constructible in-process, without Electron `parentPort` ──

/** Where the core sends pair requests. The utility adapter posts `pair-request`; a test collects them. */
export type PairRequestSink = (request: PairRequest) => void

/** Where the core receives pair decisions. Returns an unsubscribe. The adapter feeds `pair-decision` into it. */
export type PairDecisionSource = {
  subscribe(listener: (decision: PairDecision) => void): () => void
}

/** @internal test seam */
export type BridgeLogLevel = "info" | "warn" | "error"

/** Structured log line. Callers pass only method, route id, status, host, duration and codes (SC-33). */
export type BridgeLogSink = (level: BridgeLogLevel, source: string, message: string, context?: Record<string, unknown>) => void

export type BridgeCoreDeps = {
  pairRequests: PairRequestSink
  pairDecisions: PairDecisionSource
  log?: BridgeLogSink
}

/** A running bridge: both listeners bound (both or none, register §4). */
export type BridgeHandle = {
  /** The bound port (equals `config.port`; no port hopping). */
  readonly port: number
  /** Swap the leaf on both listeners with `setSecureContext` (SD-RC-6). */
  updateTls(tls: LeafTls): void
  /** Drop in-memory pairings after main deleted `pairings.json` (Disconnect / Disable). */
  pairingsCleared(): void
  /** Close both listeners and end open streams. Resolves once both are closed. */
  stop(): Promise<void>
}

export type BridgeStartResult = { ok: true; bridge: BridgeHandle } | { ok: false; code: BridgeStartFailureCode }

/** The core's factory signature. The export name of the implementation is M2-01's choice (register §3). */
export type BridgeFactory = (config: BridgeStartConfig, deps: BridgeCoreDeps) => Promise<BridgeStartResult>

// ── Guards (structural checks on postMessage payloads; same pattern as datum-studio-host/protocol.ts) ──

const PAIR_CODE_RE = /^[0-9]{4}$/
const REQUEST_ID_RE = /^[A-Za-z0-9_-]{22}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object"
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
}

export function isBridgePort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 65535
}

export function isOfficeHost(value: unknown): value is OfficeHost {
  return value === "Word" || value === "Excel"
}

function isBridgeStartFailureCode(value: unknown): value is BridgeStartFailureCode {
  return BRIDGE_START_FAILURE_CODES.some((code) => code === value)
}

function isPairRequest(value: unknown): value is PairRequest {
  if (!isRecord(value)) return false
  if (typeof value.requestId !== "string" || !REQUEST_ID_RE.test(value.requestId)) return false
  if (!isOfficeHost(value.host)) return false
  return typeof value.code === "string" && PAIR_CODE_RE.test(value.code)
}

function isPairDecision(value: unknown): value is PairDecision {
  if (!isRecord(value)) return false
  if (typeof value.requestId !== "string" || !REQUEST_ID_RE.test(value.requestId)) return false
  return typeof value.allow === "boolean"
}

function isLeafTls(value: unknown): value is LeafTls {
  if (!isRecord(value)) return false
  return isNonEmptyString(value.cert) && isNonEmptyString(value.key)
}

function isBridgeStartConfig(value: unknown): value is BridgeStartConfig {
  if (!isRecord(value)) return false
  const strings = ["serverUrl", "username", "password", "userDataDir", "resourcesDir"] as const
  if (!strings.every((k) => isNonEmptyString(value[k]))) return false
  if (!isBridgePort(value.port)) return false
  return isLeafTls(value)
}

export function isBridgeCommand(value: unknown): value is BridgeCommand {
  if (!isRecord(value)) return false
  switch (value.type) {
    case "start":
      return isBridgeStartConfig(value)
    case "tls-update":
      return isLeafTls(value)
    case "pair-decision":
      return isPairDecision(value)
    case "pairings-cleared":
      return true
    case "stop":
      return true
    default:
      return false
  }
}

export function isBridgeMessage(value: unknown): value is BridgeMessage {
  if (!isRecord(value)) return false
  switch (value.type) {
    case "ready":
      return isBridgePort(value.port)
    case "failed":
      return isBridgeStartFailureCode(value.code)
    case "pair-request":
      return isPairRequest(value)
    default:
      return false
  }
}

/** Builders keep the wire shape exact: only the registered fields, nothing extra copied from the input. */
export function buildStartCommand(config: BridgeStartConfig): BridgeStartCommand {
  return {
    type: "start",
    serverUrl: config.serverUrl,
    username: config.username,
    password: config.password,
    userDataDir: config.userDataDir,
    resourcesDir: config.resourcesDir,
    port: config.port,
    cert: config.cert,
    key: config.key,
  }
}

export function buildTlsUpdateCommand(tls: LeafTls): BridgeTlsUpdateCommand {
  return { type: "tls-update", cert: tls.cert, key: tls.key }
}

export function buildPairDecisionCommand(decision: PairDecision): BridgePairDecisionCommand {
  return { type: "pair-decision", requestId: decision.requestId, allow: decision.allow }
}

export function buildPairRequestMessage(request: PairRequest): BridgePairRequestMessage {
  return { type: "pair-request", requestId: request.requestId, host: request.host, code: request.code }
}
