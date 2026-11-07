// Runs inside the datum-studio-host utility process (row 111). Order at start (row109 line, Studio spec §10.1):
//   1. openHostStore(storeRoot): takes `<store>/datum-studio.lock` (O_EXCL) before the database opens; a live holder
//      -> STORE_LOCKED, a stale one is renamed to `datum-studio.lock.stale-<ms>` (never deleted; row 30 lock.ts).
//   2. configureTemplateSource({templatesDir, assetRepoRoot, release}).
//   3. startStudioHostServer({store, token, hostname, port: 0}) (row 31): the loopback MCP endpoint.
// On stop, or on a failure after step 1: server.close(), then closeHostStore (which releases the lock).
// Every failure is posted to main as {type:"error", error:{code,...}}; main persists it (logging.ts write).

import { errorPayload, isHostCommand, type HostMessage, type HostServer, type HostStartCommand, type HostStoreHandle, type StudioHostModule } from "./protocol"

export type ParentPortLike = {
  postMessage(message: HostMessage): void
  on(event: "message", listener: (event: { data: unknown }) => void): void
}

export type HostRunnerOptions = {
  /** Test seam: lock liveness for the store (default: row 30 defaultIsLiveHost). */
  isLiveHost?: (pid: number) => boolean
  /** Called after "stopped" is posted (the entry exits the process). */
  onStopped?: () => void
}

type State =
  | { phase: "idle" }
  | { phase: "starting"; done: Promise<void> }
  | { phase: "running"; store: HostStoreHandle; server: HostServer; mod: StudioHostModule }
  | { phase: "stopping"; done: Promise<void> }
  | { phase: "stopped" }

export function runStudioHost(port: ParentPortLike, load: () => Promise<StudioHostModule>, opts: HostRunnerOptions = {}) {
  let state: State = { phase: "idle" }
  let stopRequested = false

  const log = (level: "info" | "warn" | "error", source: string, message: string, context?: Record<string, unknown>) =>
    port.postMessage({ type: "log", level, source, message, ...(context ? { context } : {}) })

  async function start(command: HostStartCommand) {
    let mod: StudioHostModule | undefined
    let store: HostStoreHandle | undefined
    let server: HostServer | undefined
    try {
      mod = await load()
      store = await mod.openHostStore(command.storeRoot, {
        release: command.release,
        logFile: command.storeLogFile,
        // I-2 (row 119b, U19): every work report the store writes must carry a mission.
        missionGuard: true,
        ...(opts.isLiveHost ? { isLiveHost: opts.isLiveHost } : {}),
      })
      mod.configureTemplateSource({ templatesDir: command.templatesDir, assetRepoRoot: command.assetRepoRoot, release: command.release })
      server = await mod.startStudioHostServer({ store, token: command.token, hostname: command.hostname, port: 0, log })
      state = { phase: "running", store, server, mod }
      port.postMessage({ type: "ready", url: server.url, pid: process.pid, cwd: process.cwd() })
    } catch (error) {
      await release(mod, store, server)
      state = { phase: "idle" }
      port.postMessage({ type: "error", error: errorPayload(error) })
    }
  }

  async function release(mod: StudioHostModule | undefined, store: HostStoreHandle | undefined, server: HostServer | undefined) {
    if (server) await server.close().catch((e) => log("error", "datum-studio-host.stop", "server close failed", { error: errorPayload(e) }))
    if (mod) {
      try {
        mod.configureTemplateSource(null)
      } catch {}
    }
    if (mod && store) await mod.closeHostStore(store).catch((e) => log("error", "datum-studio-host.stop", "store close failed", { error: errorPayload(e) }))
  }

  async function stop() {
    if (state.phase === "starting") await state.done
    if (state.phase === "stopping") return state.done
    if (state.phase === "running") {
      const { mod, store, server } = state
      const done = release(mod, store, server)
      state = { phase: "stopping", done }
      await done
    }
    state = { phase: "stopped" }
    port.postMessage({ type: "stopped" })
    opts.onStopped?.()
  }

  port.on("message", (event) => {
    const command = event.data
    if (!isHostCommand(command)) {
      port.postMessage({ type: "error", error: { code: "HOST_BAD_COMMAND", message: "unrecognised command" } })
      return
    }
    if (command.type === "stop") {
      stopRequested = true
      void stop()
      return
    }
    if (state.phase !== "idle" || stopRequested) {
      port.postMessage({ type: "error", error: { code: "HOST_ALREADY_STARTED", message: `start refused in phase ${state.phase}` } })
      return
    }
    const done = start(command)
    state = { phase: "starting", done }
  })
}
