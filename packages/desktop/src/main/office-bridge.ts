// office-bridge utility process entry (row M2-03; register rev 5 §3 "Main-to-bridge messages"; server-delta spec §5.1,
// §5.2, §6; TS-RC-2 / TR-5). A thin adapter: it turns `parentPort` messages (protocol.ts) into calls on the Electron-free
// bridge core (office-bridge/server.ts) and posts `ready` / `failed` / `pair-request` back. electron-vite builds it as
// the main input `office-bridge` -> out/main/office-bridge.js, which main forks with utilityProcess (M7-03).
//
// Logging: the wire has no log message, so each line goes to stdout (info) or stderr (warn/error) as one JSON object.
// Main forks with `stdio: "pipe"` and forwards both streams to its persistent logger (same pattern as sidecar.ts and
// server.ts). The core passes only codes, hosts, ports and durations (SC-33); this file never logs a command payload
// (the `start` command carries the sidecar password and the leaf key).
//
// Process exit: after `stop` completes, or when the core throws instead of returning a start result (a programming
// fault), the process exits; main observes the exit (BRIDGE_EXITED when unexpected).
import { access } from "node:fs/promises"
import {
  buildPairRequestMessage,
  isBridgeCommand,
  type BridgeCommand,
  type BridgeFactory,
  type BridgeHandle,
  type BridgeLogSink,
  type BridgeMessage,
  type BridgeStartConfig,
  type PairDecision,
  type PairDecisionSource,
} from "./office-bridge/protocol"
import { createOfficeBridgeFactory, notFoundRoutes, type BridgeRoutesFactory } from "./office-bridge/server"
import { paneRootFor } from "./office-bridge/static"

// ── Routes seam (W4 integration row) ──

/**
 * OFFICE_BRIDGE_ROUTES_SEAM. The W4 integration row replaces `notFoundRoutes` with the composed pipeline (admit stages
 * 2-4, static stage 5, admit 6-13 incl. health, pairing, upstream, SSE; spec §9.1). Static and health are deliberately
 * not mounted alone: the Host/Origin checks of admit run before the static stage, so a static-only mount would serve
 * the pane without them. Until then every request is `404 ROUTE_NOT_ALLOWED`.
 */
export const officeBridgeRoutes: BridgeRoutesFactory = notFoundRoutes

// ── Runner (Electron-free; tests drive it with a fake port and factory) ──

export type OfficeBridgeParentPort = {
  postMessage(message: BridgeMessage): void
  on(event: "message", listener: (event: { data: unknown }) => void): void
}

export type OfficeBridgeRunnerOptions = {
  /** Core factory. Default: `createOfficeBridgeFactory({ routes: officeBridgeRoutes })`. */
  factory?: BridgeFactory
  /** Structured log sink. Default: JSON lines on stdout/stderr. */
  log?: BridgeLogSink
  /** Called once the bridge is stopped after a `stop` command (the entry exits 0). */
  onStopped?: () => void
  /** Called when the core threw during start (the entry exits 1; main reports BRIDGE_EXITED). */
  onFatal?: () => void
}

type State =
  | { phase: "idle" }
  | { phase: "starting"; done: Promise<void> }
  | { phase: "running"; bridge: BridgeHandle }
  | { phase: "stopping"; done: Promise<void> }
  | { phase: "stopped" }

export const stdioBridgeLog: BridgeLogSink = (level, source, message, context) => {
  const line = JSON.stringify({ timestamp: new Date().toISOString(), level, source, message, ...(context ? { context } : {}) })
  if (level === "info") {
    process.stdout.write(line + "\n")
    return
  }
  process.stderr.write(line + "\n")
}

function errorName(error: unknown) {
  return error instanceof Error ? error.name : "unknown"
}

function commandType(data: unknown) {
  if (!data || typeof data !== "object" || !("type" in data)) return "none"
  return typeof data.type === "string" ? data.type.slice(0, 32) : "invalid"
}

/** One in-process fan-out from `pair-decision` messages to the core's subscribers. */
function decisionHub() {
  const listeners = new Set<(decision: PairDecision) => void>()
  const source: PairDecisionSource = {
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  const emit = (decision: PairDecision) => {
    for (const listener of listeners) listener(decision)
  }
  return { source, emit }
}

export function runOfficeBridge(port: OfficeBridgeParentPort, options: OfficeBridgeRunnerOptions = {}) {
  const factory = options.factory ?? createOfficeBridgeFactory({ routes: officeBridgeRoutes })
  const log = options.log ?? stdioBridgeLog
  const decisions = decisionHub()
  let state: State = { phase: "idle" }
  let stopRequested = false

  async function warnIfPaneMissing(resourcesDir: string) {
    // C33: resourcesDir must hold office-addin/pane (packaged: process.resourcesPath; dev: a staging dir). Not a start
    // failure code (register §7.6): the static stage answers 404 until the pane is there.
    const found = await access(paneRootFor(resourcesDir)).then(
      () => true,
      () => false,
    )
    if (!found) log("warn", "office-bridge.entry", "pane root missing under resourcesDir", { code: "PANE_ROOT_MISSING" })
  }

  async function start(config: BridgeStartConfig) {
    await warnIfPaneMissing(config.resourcesDir)
    const result = await factory(config, {
      pairRequests: (request) => port.postMessage(buildPairRequestMessage(request)),
      pairDecisions: decisions.source,
      log,
    }).catch((error: unknown) => {
      log("error", "office-bridge.entry", "bridge core threw during start", { error: errorName(error) })
      return undefined
    })
    if (!result) {
      state = { phase: "idle" }
      options.onFatal?.()
      return
    }
    if (!result.ok) {
      state = { phase: "idle" }
      log("error", "office-bridge.entry", "start failed", { code: result.code })
      port.postMessage({ type: "failed", code: result.code })
      return
    }
    state = { phase: "running", bridge: result.bridge }
    if (stopRequested) return
    log("info", "office-bridge.entry", "ready", { port: result.bridge.port })
    port.postMessage({ type: "ready", port: result.bridge.port })
  }

  async function stop() {
    stopRequested = true
    if (state.phase === "starting") await state.done
    if (state.phase === "stopping") return state.done
    if (state.phase === "running") {
      const bridge = state.bridge
      const done = bridge.stop().catch((error: unknown) => {
        log("error", "office-bridge.entry", "stop failed", { error: errorName(error) })
      })
      state = { phase: "stopping", done }
      await done
    }
    state = { phase: "stopped" }
    options.onStopped?.()
  }

  function handle(command: BridgeCommand) {
    if (command.type === "start") {
      if (state.phase !== "idle" || stopRequested) {
        log("warn", "office-bridge.entry", "start ignored", { phase: state.phase })
        return
      }
      const done = start(command)
      state = { phase: "starting", done }
      return
    }
    if (command.type === "stop") {
      void stop()
      return
    }
    if (command.type === "pair-decision") {
      decisions.emit({ requestId: command.requestId, allow: command.allow })
      return
    }
    if (state.phase !== "running") {
      log("warn", "office-bridge.entry", "command ignored while not running", { command: command.type, phase: state.phase })
      return
    }
    if (command.type === "pairings-cleared") {
      state.bridge.pairingsCleared()
      return
    }
    try {
      state.bridge.updateTls({ cert: command.cert, key: command.key })
    } catch (error) {
      // The core validates before swapping, so both listeners keep the previous leaf.
      log("error", "office-bridge.entry", "tls update rejected", { error: errorName(error) })
    }
  }

  port.on("message", (event) => {
    if (!isBridgeCommand(event.data)) {
      log("warn", "office-bridge.entry", "invalid command dropped", { command: commandType(event.data) })
      return
    }
    handle(event.data)
  })

  return { stop }
}

// ── Entry ──

// Only inside the utility process: Bun tests and the main process have no parentPort, so importing this module there
// runs nothing.
const parentPort = process.parentPort as OfficeBridgeParentPort | undefined
if (parentPort) {
  runOfficeBridge(parentPort, {
    onStopped: () => setTimeout(() => process.exit(0), 0),
    onFatal: () => setTimeout(() => process.exit(1), 0),
  })
}
