// 1.3.0 row 132 (AC-S6a, folded F1 / F3 / F4; N13-371, N13-415). The swarm-web MCP entry runs the staged copy
// ~/.swarm/setup/bin/swarm-web-proxy, and only `swarm-setup install` ever staged it, so a menu patch left an old
// proxy live (C81). Once per packaged launch, before tool-health and before the sidecar spawns the MCP servers,
// the desktop refreshes that copy from the app bundle.
//
// - Source = <resourcesPath>/swarm-setup/swarm-web-proxy, target base = the caller's os.homedir(); neither comes
//   from env, config, argv or the store (F4). Only caller: index.ts. No IPC channel, menu item or renderer trigger.
// - The decision is the stager's (setup/src/wiring/proxy_stage.ts) with `requireExisting: true` (F3): absent
//   target or chain -> nothing written; unsafe parent -> PROXY_REFRESH_UNSAFE_DIR; content compared, never
//   metadata (F1: sizes first, an equal size is hashed bounded by the source size).
// - One log line with one fixed code and the elapsed ms (F4); never the stager's reason text or a path.
// - Synchronous and never throws: a failure leaves the old file as it is and tool-health reports it stale.

import { join } from "node:path"
import {
  PROXY_REFRESH_UNSAFE_DIR,
  stageProxyBinary,
  type ProxyStageOptions,
  type ProxyStageResult,
} from "@swarm-setup/proxy-stage" // = packages/setup/src/wiring/proxy_stage.ts (C110: setup-proxy-stage.d.ts for tsc)

type ProxyRefreshCode = "PROXY_REFRESHED" | "PROXY_CURRENT" | "PROXY_ABSENT" | "PROXY_REFUSED" | "PROXY_FAILED"

interface ProxyRefreshOptions {
  readonly isPackaged: boolean
  /** process.resourcesPath of the running app. */
  readonly resourcesPath: string
  /** os.homedir() of the running app. */
  readonly home: string
  readonly log: (level: "info" | "warn" | "error", code: ProxyRefreshCode, context: { ms: number }) => void
  /**
   * Replaces the stager; defaults to stageProxyBinary.
   * @internal test seam
   */
  readonly stage?: (opts: ProxyStageOptions) => ProxyStageResult
}

// The stager's refusal of a symlink / non-regular target carries no code; its reason starts with this text.
const TARGET_REFUSAL_PREFIX = "refusing to replace"

function classify(result: ProxyStageResult): ProxyRefreshCode {
  if (result.ok) {
    if (!result.staged) return "PROXY_ABSENT"
    return result.changed ? "PROXY_REFRESHED" : "PROXY_CURRENT"
  }
  if (result.code === PROXY_REFRESH_UNSAFE_DIR) return "PROXY_REFUSED"
  if (result.reason.startsWith(TARGET_REFUSAL_PREFIX)) return "PROXY_REFUSED"
  return "PROXY_FAILED"
}

const LEVEL: Record<ProxyRefreshCode, "info" | "warn" | "error"> = {
  PROXY_REFRESHED: "info",
  PROXY_CURRENT: "info",
  PROXY_ABSENT: "info",
  PROXY_REFUSED: "warn",
  PROXY_FAILED: "error",
}

/** Refresh an already staged swarm-web-proxy from the app bundle. Packaged launches only; returns the logged code. */
export function refreshStagedProxy(opts: ProxyRefreshOptions): ProxyRefreshCode | undefined {
  if (!opts.isPackaged) return undefined
  const started = performance.now()
  let code: ProxyRefreshCode
  try {
    const stage = opts.stage ?? stageProxyBinary
    code = classify(
      stage({ base: opts.home, programDir: join(opts.resourcesPath, "swarm-setup"), requireExisting: true }),
    )
  } catch {
    code = "PROXY_FAILED"
  }
  const ms = Math.round(performance.now() - started)
  try {
    opts.log(LEVEL[code], code, { ms })
  } catch {
    // the log is an aid; it never changes the outcome or breaks the launch
  }
  return code
}
