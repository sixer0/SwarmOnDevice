// Messages between main and the datum-studio-host utility process (row 111; Studio spec §3.1, §9.1, §10).
// Shared by the main-side lifecycle (lifecycle.ts) and the host-side runner (host-runner.ts). No Electron import.

export const STUDIO_HOST_SERVICE_NAME = "datum-studio-host"
export const STUDIO_RELEASE = "1.2.7"

/** main -> host. The endpoint token travels only in this message: never in env, argv or a log line. */
export type HostStartCommand = {
  type: "start"
  /** 32 random bytes, hex; the MCP endpoint's Bearer token (spec §9.1). */
  token: string
  hostname: "127.0.0.1"
  /** Absolute store root (`<XDG_DATA_HOME>/swarm/datum-studio`), equal to STUDIO_WORKSPACE_ROOT (row109 line). */
  storeRoot: string
  /** Absolute JSONL file for the store's structured log (openHostStore logFile). */
  storeLogFile: string
  /** Absolute builtin templates folder (`Res/datum-studio/templates`). */
  templatesDir: string
  /** Absolute root under which `src/lib/studio/assets/...` resolves (configureTemplateSource). */
  assetRepoRoot: string
  release: string
}

export type HostStopCommand = { type: "stop" }
export type HostCommand = HostStartCommand | HostStopCommand

export type HostErrorPayload = { code: string; message: string; stack?: string; details?: Record<string, unknown> }

/** host -> main. `cwd` lets main check the M4 rule (host cwd = Res/datum-studio/) in the real process. */
export type HostMessage =
  | { type: "ready"; url: string; pid: number; cwd: string }
  | { type: "stopped" }
  | { type: "error"; error: HostErrorPayload }
  | { type: "log"; level: "info" | "warn" | "error"; source: string; message: string; context?: Record<string, unknown> }

// ── The host-side module contract (row 31 + row 109 functions, reached through `virtual:datum-studio-host`) ──

/** What the host runner needs from an opened store: only that it can be closed (closing releases the lock). */
export type HostStoreHandle = { close(): Promise<void> } & object

export type HostServerStartOptions = {
  store: HostStoreHandle
  token: string
  hostname: "127.0.0.1"
  /** 0 = ephemeral port (spec §9.1). */
  port: number
  log: (level: "info" | "warn" | "error", source: string, message: string, context?: Record<string, unknown>) => void
}

export type HostServer = { url: string; close(): Promise<void> }

/**
 * The module the host entry loads. Row 31 provides `startStudioHostServer`; the other three are row 109's
 * store bridge and row 29's template source, re-exported by the same barrel (file_requests row111 lines).
 */
export type StudioHostModule = {
  openHostStore(root: string, opts: { release: string; logFile: string; missionGuard?: boolean; isLiveHost?: (pid: number) => boolean }): Promise<HostStoreHandle>
  closeHostStore(store: HostStoreHandle): Promise<void>
  configureTemplateSource(config: { templatesDir: string; assetRepoRoot: string; release: string } | null): void
  startStudioHostServer(opts: HostServerStartOptions): Promise<HostServer>
}

export function isHostCommand(value: unknown): value is HostCommand {
  if (!value || typeof value !== "object") return false
  const v = value as Record<string, unknown>
  if (v.type === "stop") return true
  if (v.type !== "start") return false
  const strings = ["token", "storeRoot", "storeLogFile", "templatesDir", "assetRepoRoot", "release"] as const
  return v.hostname === "127.0.0.1" && strings.every((k) => typeof v[k] === "string" && (v[k] as string).length > 0)
}

export function isHostMessage(value: unknown): value is HostMessage {
  if (!value || typeof value !== "object") return false
  const v = value as Record<string, unknown>
  switch (v.type) {
    case "ready":
      return typeof v.url === "string" && typeof v.pid === "number" && typeof v.cwd === "string"
    case "stopped":
      return true
    case "error":
      return !!v.error && typeof (v.error as Record<string, unknown>).message === "string"
    case "log":
      return typeof v.message === "string" && typeof v.source === "string"
    default:
      return false
  }
}

/** Error code of a thrown value: StoreError/StudioEngineError carry `code`; anything else is HOST_START_FAILED. */
export function errorPayload(error: unknown, fallbackCode = "HOST_START_FAILED"): HostErrorPayload {
  const code =
    error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string"
      ? (error as { code: string }).code
      : fallbackCode
  const details =
    error && typeof error === "object" && (error as { details?: unknown }).details && typeof (error as { details?: unknown }).details === "object"
      ? ((error as { details: Record<string, unknown> }).details)
      : undefined
  if (error instanceof Error) return { code, message: error.message, stack: error.stack, ...(details ? { details } : {}) }
  return { code, message: String(error), ...(details ? { details } : {}) }
}
