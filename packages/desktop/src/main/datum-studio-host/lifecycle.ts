// Main-side lifecycle of the datum-studio-host utility process (row 111; Studio spec §3.1, §9.1, §10.1).
//   fork(entry, cwd = layout.root, env = minimal + DATUM_RENDER_* + STUDIO_*) -> {type:"start", token, ...}
//   <- {type:"ready", url, pid, cwd}  (cwd must equal layout.root: M4)  -> write <stateHome>/swarm/datum-studio.env 0600
//   stop(): remove the descriptor (sync), {type:"stop"}, wait for "stopped"/exit, kill after the timeout.
// No Electron import: `fork` is injected (start.ts passes utilityProcess.fork; tests pass a double).

import { randomBytes } from "node:crypto"
import { realpathSync } from "node:fs"
import { resolve } from "node:path"
import { removeStudioDescriptor, writeStudioDescriptor } from "./descriptor"
import { assertLayoutUsable, assertStoreRootAllowed, studioStoreLogFile, type StudioLayout } from "./layout"
import { isHostMessage, STUDIO_HOST_SERVICE_NAME, STUDIO_RELEASE, type HostCommand, type HostErrorPayload, type HostMessage } from "./protocol"

/** The part of Electron's UtilityProcess this module uses. */
export type HostChild = {
  readonly pid: number | undefined
  postMessage(message: HostCommand): void
  on(event: "message", listener: (message: unknown) => void): unknown
  on(event: "exit", listener: (code: number) => void): unknown
  off(event: "message", listener: (message: unknown) => void): unknown
  off(event: "exit", listener: (code: number) => void): unknown
  kill(): boolean
  stdout?: NodeJS.ReadableStream | null
  stderr?: NodeJS.ReadableStream | null
}

export type ForkHost = (
  modulePath: string,
  args: string[],
  options: { cwd: string; env: Record<string, string>; serviceName: string; stdio: "pipe" },
) => HostChild

export type HostLog = (level: "info" | "warn" | "error", source: string, message: string, context?: Record<string, unknown>) => void

export type StudioHostStartOptions = {
  fork: ForkHost
  /** Absolute path of the built entry (`out/main/datum-studio-host.js`). */
  entryPath: string
  layout: StudioLayout
  storeRoot: string
  /** `<stateHome>/swarm/datum-studio.env` */
  descriptorPath: string
  /** Swarm main PID written to the descriptor (launcher check, spec §9.3). */
  mainPid: number
  home: string
  resourcesPath?: string
  /** The process env the minimal host env is picked from. */
  baseEnv: NodeJS.ProcessEnv
  /** DATUM_RENDER_SOCKET / DATUM_RENDER_TOKEN of the render bridge (row 24); absent when the bridge did not start. */
  renderEnv?: { DATUM_RENDER_SOCKET: string; DATUM_RENDER_TOKEN: string }
  log: HostLog
  readyTimeoutMs?: number
  stopTimeoutMs?: number
  /** Called once when the host exits on its own after ready (descriptor already removed). */
  onUnexpectedExit?: (code: number) => void
  /** Aborting during start (a quit) stops the child at once instead of waiting for the ready timeout. */
  signal?: AbortSignal
}

export type StudioHostHandle = {
  url: string
  hostPid: number
  stop(): Promise<void>
  readonly running: boolean
}

export class StudioHostError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = "StudioHostError"
  }
}

export const HOST_READY_TIMEOUT_MS = 60_000
export const HOST_STOP_TIMEOUT_MS = 6_000

/** Env keys the host may inherit. The user's shell env (API keys etc., preferAppEnv) is not passed on. */
export const HOST_ENV_ALLOW = [
  "HOME",
  "USER",
  "LOGNAME",
  "PATH",
  "SHELL",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "NO_PROXY",
  "no_proxy",
] as const

export function createHostEnv(opts: Pick<StudioHostStartOptions, "baseEnv" | "renderEnv" | "layout" | "storeRoot">) {
  const env: Record<string, string> = {}
  for (const key of HOST_ENV_ALLOW) {
    const value = opts.baseEnv[key]
    if (typeof value === "string") env[key] = value
  }
  if (opts.renderEnv) {
    env.DATUM_RENDER_SOCKET = opts.renderEnv.DATUM_RENDER_SOCKET
    env.DATUM_RENDER_TOKEN = opts.renderEnv.DATUM_RENDER_TOKEN
  }
  env.STUDIO_ASSETS_ROOT = opts.layout.assetsRoot
  env.STUDIO_WORKSPACE_ROOT = opts.storeRoot
  env.STUDIO_VENDOR_ROOT = opts.layout.vendorRoot
  return env
}

function real(path: string) {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

function delay(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms))
}

export async function startStudioHost(opts: StudioHostStartOptions): Promise<StudioHostHandle> {
  assertStoreRootAllowed(opts.storeRoot, { home: opts.home, resourcesPath: opts.resourcesPath })
  assertLayoutUsable(opts.layout, opts.storeRoot)
  // The descriptor is not touched before ready: a refused second host (STORE_LOCKED) must leave the live host's file
  // alone. A file left by a crash is replaced by the rename at ready; until then the launcher's PID check rejects it.
  const token = randomBytes(32).toString("hex")
  const child = opts.fork(opts.entryPath, [], {
    cwd: opts.layout.root,
    env: createHostEnv(opts),
    serviceName: STUDIO_HOST_SERVICE_NAME,
    stdio: "pipe",
  })

  let exited = false
  let stopping = false
  let resolveExit!: (code: number) => void
  const exit = new Promise<number>((r) => (resolveExit = r))
  const onAnyExit = (code: number) => {
    exited = true
    resolveExit(code)
  }
  child.on("exit", onAnyExit)

  const forward = (message: unknown) => {
    if (!isHostMessage(message)) return
    if (message.type === "log") opts.log(message.level, message.source, message.message, message.context)
    if (message.type === "error") opts.log("error", "datum-studio-host", message.error.message, { code: message.error.code, stack: message.error.stack })
  }
  child.on("message", forward)
  child.stdout?.on("data", (chunk: Buffer) => opts.log("info", "datum-studio-host.stdout", chunk.toString("utf8").trimEnd()))
  child.stderr?.on("data", (chunk: Buffer) => opts.log("warn", "datum-studio-host.stderr", chunk.toString("utf8").trimEnd()))

  const ready = await new Promise<Extract<HostMessage, { type: "ready" }>>((resolveReady, rejectReady) => {
    const timer = setTimeout(
      () => fail(new StudioHostError("HOST_START_TIMEOUT", `datum-studio-host not ready within ${opts.readyTimeoutMs ?? HOST_READY_TIMEOUT_MS}ms`)),
      opts.readyTimeoutMs ?? HOST_READY_TIMEOUT_MS,
    )
    const onAbort = () => fail(new StudioHostError("HOST_START_ABORTED", "datum-studio-host start aborted"))
    const cleanup = () => {
      clearTimeout(timer)
      child.off("message", onMessage)
      child.off("exit", onExit)
      opts.signal?.removeEventListener("abort", onAbort)
    }
    const fail = (error: Error) => {
      cleanup()
      rejectReady(error)
    }
    const onMessage = (message: unknown) => {
      if (!isHostMessage(message)) return
      if (message.type === "ready") {
        cleanup()
        resolveReady(message)
      } else if (message.type === "error") {
        fail(hostError(message.error))
      }
    }
    const onExit = (code: number) => fail(new StudioHostError("HOST_EXITED", `datum-studio-host exited before ready with code ${code}`, { code }))
    child.on("message", onMessage)
    child.on("exit", onExit)
    if (opts.signal?.aborted) return onAbort()
    opts.signal?.addEventListener("abort", onAbort, { once: true })
    child.postMessage({
      type: "start",
      token,
      hostname: "127.0.0.1",
      storeRoot: opts.storeRoot,
      storeLogFile: studioStoreLogFile(opts.storeRoot),
      templatesDir: opts.layout.templatesDir,
      assetRepoRoot: opts.layout.assetRepoRoot,
      release: STUDIO_RELEASE,
    })
  }).catch(async (error) => {
    await stopChild()
    throw error
  })

  // M4: the host must run in the read-only Res/datum-studio/ (no bunfig/.env pickup, no relative write into $HOME).
  if (real(ready.cwd) !== real(opts.layout.root)) {
    await stopChild()
    throw new StudioHostError("HOST_CWD_MISMATCH", "datum-studio-host cwd is not the studio root", { cwd: ready.cwd, root: opts.layout.root })
  }

  try {
    await writeStudioDescriptor(opts.descriptorPath, { url: ready.url, token, pid: opts.mainPid })
  } catch (error) {
    await stopChild()
    throw new StudioHostError("DESCRIPTOR_WRITE_FAILED", error instanceof Error ? error.message : String(error))
  }

  // After ready: an exit we did not ask for removes the descriptor at once, so the launcher reports "start Swarm".
  child.on("exit", (code) => {
    if (stopping) return
    removeStudioDescriptor(opts.descriptorPath)
    opts.log("error", "datum-studio-host", "datum-studio-host exited unexpectedly", { code })
    opts.onUnexpectedExit?.(code)
  })

  let stopPromise: Promise<void> | undefined
  async function stopChild() {
    stopping = true
    if (exited) return
    try {
      child.postMessage({ type: "stop" })
    } catch {}
    // The host posts "stopped" after closing the server and the store (lock released), then exits.
    await Promise.race([exit, delay(opts.stopTimeoutMs ?? HOST_STOP_TIMEOUT_MS)])
    if (!exited) {
      opts.log("warn", "datum-studio-host", "datum-studio-host did not exit in time; killed", { timeoutMs: opts.stopTimeoutMs ?? HOST_STOP_TIMEOUT_MS })
      child.kill()
    }
  }

  return {
    url: ready.url,
    hostPid: ready.pid,
    get running() {
      return !exited && !stopping
    },
    stop() {
      if (stopPromise) return stopPromise
      // The descriptor goes first and synchronously: it is gone even if the process dies during the wait.
      removeStudioDescriptor(opts.descriptorPath)
      stopPromise = stopChild()
      return stopPromise
    },
  }

  function hostError(error: HostErrorPayload) {
    return new StudioHostError(error.code, error.message, error.details)
  }
}
