// U7 tool-health regime: shapes and names (register N-116..N-128, N-151; spec 01c section 3, amended by 01_specs TH-01).
// No Electron import and no machine path: the registry is built from a context object, so tests use temp folders.

/** N-122: per-probe budget unless the probe sets its own `timeoutMs`. */
export const HEALTH_PROBE_TIMEOUT_MS = 3000
/** N-123: from a revive until the re-probe gives up, unless the component sets `reviveTimeoutMs`. */
export const REVIVE_WAIT_MS = 30000
/** N-124: automatic revive attempts per component per app launch. */
export const REVIVE_MAX_PER_LAUNCH = 1

/** Upper bounds used when a user file sets a timeout (validation only; shipped values sit below them). */
export const PROBE_TIMEOUT_MAX_MS = 60000
export const REVIVE_TIMEOUT_MAX_MS = 600000
/** Bodies and outputs read by a probe or kept from a revive (01c 3.2, 3.3). */
export const PROBE_BODY_MAX_BYTES = 64 * 1024

/** Component id rule (01c 3.1). */
export const TOOL_HEALTH_ID_PATTERN = /^[a-z][a-z0-9-]{1,39}$/
export const TOOL_HEALTH_LABEL_MAX = 60

/** N-121 */
export type ToolHealthStatus =
  | "healthy"
  | "revived"
  | "dead"
  | "revive_failed"
  | "skipped_never_healthy"
  | "skipped_not_installed"

/** N-151: closed reason set; messages in 01c section 9. */
export const TOOL_HEALTH_REASONS = [
  "OK",
  "REVIVED",
  "NOT_INSTALLED",
  "NEVER_HEALTHY",
  "CONSENT_MANUAL",
  "REVIVE_LIMIT",
  "REQUIRES_DOWN",
  "HTTP_UNREACHABLE",
  "HTTP_STATUS",
  "HTTP_HOST_REFUSED",
  "HTTP_BODY_MISMATCH",
  "SOCKET_UNREACHABLE",
  "FILE_MISSING",
  "BRIDGE_NOT_STARTED",
  "BRIDGE_SOCKET_GONE",
  "BRIDGE_BAD_REPLY",
  "SETUP_BUSY",
  "SETUP_NO_START_VERB",
  "START_NOT_INSTALLED",
  "RUNTIME_PROFILE_MISSING",
  "START_CONTAINERS_MISSING",
  "REVIVE_EXIT",
  "REVIVE_TIMEOUT",
  "USER_REGISTRY_UNSAFE",
  "USER_REGISTRY_INVALID",
  "PROBE_URL_NOT_LOOPBACK",
  "REVIVE_BUILTIN_IN_USER_FILE",
  "SHIPPED_FIELD_LOCKED",
  "ENTRY_INVALID",
  "WATCHED_FILE_CHANGED",
] as const
export type ToolHealthReason = (typeof TOOL_HEALTH_REASONS)[number]

/** N-119 (amended RA-3): loopback-only http, status arrays, http over a Unix socket, file presence, the in-process bridge. */
export type ToolHealthProbe =
  | {
      kind: "http"
      url: string
      expectStatus: number | number[]
      expectJson?: Record<string, string | number | boolean>
      timeoutMs?: number
    }
  | { kind: "http-unix"; socketPath: string; path: string; expectStatus: number; timeoutMs?: number }
  | { kind: "file"; path: string; timeoutMs?: number }
  | { kind: "process"; check: "render-bridge"; timeoutMs?: number }

/** N-120 (amended RA-4): `builtin` only on shipped components; `argv` absolute, no shell. */
export type ToolHealthRevive =
  | { argv: string[]; fallbackArgv?: string[] }
  | { builtin: "compose-start" | "render-bridge-restart" }

export type ToolHealthInstalledWhen = { setupComponent: string } | { path: string }

/** SEC-18 / SR-18 (U21 form): a changed hash warns (`WATCHED_FILE_CHANGED`), never blocks. */
export type ToolHealthWatch = { path: string; sha256: string }

/** N-117 (amended RA-2 + `watch`). */
export type ToolHealthComponent = {
  id: string
  label: string
  probe: ToolHealthProbe
  revive?: ToolHealthRevive
  startup: "probe" | "off"
  consent: "auto" | "manual"
  requires?: string[]
  installedWhen?: ToolHealthInstalledWhen
  reviveTimeoutMs?: number
  platforms?: string[]
  watch?: ToolHealthWatch[]
}

export type ToolHealthSource = "shipped" | "user"

/** A component as the regime sees it after the shipped and user registries are merged. */
export type ResolvedToolHealthComponent = ToolHealthComponent & { source: ToolHealthSource }

/** N-186 input: everything a path in the shipped registry is computed from. */
export type ToolHealthContext = {
  home: string
  platform: NodeJS.Platform | string
  isPackaged: boolean
  resourcesPath?: string
  appPath: string
}
