// Bridge core factory (row 47, plan M2-01; TS-RC-2 / TR-5). Electron-free: Bun tests and the utility-process adapter
// (office-bridge.ts, row M2-03) both construct it in-process. Register rev 5 §3 (start fields, data directory), §4 (bind,
// port, Host/Origin, TLS, no HSTS), §7.6 (start failure codes); server-delta spec §8 (BIND-1 rules 1-4); security spec
// SC-12, SC-14, SC-32, SC-36..SC-38.
//
// What this module owns: the two listeners, both-or-none, the shared secure context and its hot swap, stopping with open
// streams, the data-directory mode gate and `workspace/`. What it does not own: the request pipeline. Routes (static,
// admit, pairing, upstream, SSE) are injected through `BridgeRoutesFactory`; the default answers every request with
// `404 ROUTE_NOT_ALLOWED`, so a core with nothing wired in exposes nothing.
import type { IncomingMessage, ServerResponse } from "node:http"
import https from "node:https"
import type { Socket } from "node:net"
import { chmod, lstat, mkdir, readdir, realpath } from "node:fs/promises"
import { join } from "node:path"
import tls from "node:tls"
import { BRIDGE_SECURITY_HEADERS } from "./static"
import {
  isBridgePort,
  type BridgeCoreDeps,
  type BridgeFactory,
  type BridgeHandle,
  type BridgeLogSink,
  type BridgeStartConfig,
  type BridgeStartResult,
  type LeafTls,
} from "./protocol"

// ── Register values ──

/** Literal bind addresses (SC-36). Never `0.0.0.0` or `::`. Order is the bind order. */
const OFFICE_BRIDGE_LISTEN_ADDRESSES = ["127.0.0.1", "::1"] as const
type OfficeBridgeListenAddress = (typeof OFFICE_BRIDGE_LISTEN_ADDRESSES)[number]

/** SC-32: TLS 1.2 minimum (1.3 negotiated when the client offers it), HTTP/1.1 only. No HSTS anywhere in this module. */
const OFFICE_BRIDGE_TLS_MIN_VERSION = "TLSv1.2"
const OFFICE_BRIDGE_ALPN = ["http/1.1"]

/** Register §3: `<userData>/office-addin/` and its subdirectories, mode 0700 (SC-12). */
export const OFFICE_BRIDGE_DATA_DIR = "office-addin"
const OFFICE_BRIDGE_WORKSPACE_DIR = "workspace"
const OFFICE_BRIDGE_DIR_MODE = 0o700

/** Host and Origin allow-values for a port (TS-RC-1; register §4). `[::1]:<port>` is deliberately absent (SC-09). */
type BridgeExpectations = {
  port: number
  hosts: readonly string[]
  origin: string
}

/** @internal test seam */
export function bridgeExpectations(port: number): BridgeExpectations {
  if (!isBridgePort(port)) throw new RangeError(`office bridge port out of range: ${port}`)
  return { port, hosts: [`localhost:${port}`, `127.0.0.1:${port}`], origin: `https://localhost:${port}` }
}

// ── Data directory (SC-12, C25) ──

/** @internal test seam */
export type BridgeDataPaths = {
  /** `<userData>/office-addin/`. */
  root: string
  /**
   * `<userData>/office-addin/workspace/`, the Office session directory (register §7). Created empty by the bridge. In the
   * paths `prepareBridgeDataDir` returns (and routes receive) this is the realpath, the form the sidecar stores (C54).
   */
  workspace: string
  /** `<userData>/office-addin/pairings.json` (owned by the pairing store, row M4-01). */
  pairings: string
}

/** @internal test seam */
export function bridgeDataPaths(userDataDir: string): BridgeDataPaths {
  const root = join(userDataDir, OFFICE_BRIDGE_DATA_DIR)
  return { root, workspace: join(root, OFFICE_BRIDGE_WORKSPACE_DIR), pairings: join(root, "pairings.json") }
}

/** Directories checked at start besides the root. `ca/` and `tls/` are written by main (register §6.1). */
const CHECKED_SUBDIRS = ["ca", "tls", OFFICE_BRIDGE_WORKSPACE_DIR]
/** Secret files that must be 0600 or narrower and singly linked when present (SC-12): leaf key, encrypted CA key, pairings. */
const CHECKED_SECRET_FILES = ["pairings.json", join("tls", "localhost.key.pem"), join("ca", "swarm-office-ca.key.enc")]
/** Public files main writes 0644 (register §6.1): strict like the secrets, except group/other may read. */
const PUBLIC_FILES = [join("ca", "swarm-office-ca.cert.pem"), join("ca", "fingerprint.json"), join("tls", "localhost.cert.pem")]
/**
 * Directories whose unknown entries are reported (C48). `workspace/` is excluded: the sidecar writes session files there
 * with its own umask, and none of them is a bridge secret.
 */
const SCANNED_DIRS = ["", "ca", "tls"]
/** Finder metadata; never a reason to warn (C48). */
const IGNORED_NAMES = [".DS_Store"]

type DataDirResult =
  | {
      ok: true
      paths: BridgeDataPaths
      /** Unknown entries (relative names, never a path) with group/other bits or another owner. A warning, not a refusal (C48). */
      strays: string[]
    }
  | { ok: false; code: "DATA_DIR_UNSAFE"; entry: string; mode: number }

async function statOrUndefined(path: string) {
  return lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
}

function ownedByUs(uid: number) {
  const self = process.getuid?.()
  return self === undefined || self === uid
}

async function makeDir(path: string) {
  await mkdir(path, { recursive: true, mode: OFFICE_BRIDGE_DIR_MODE })
  await chmod(path, OFFICE_BRIDGE_DIR_MODE) // mkdir's mode is masked by umask
}

/**
 * Check `office-addin/` before binding. Strict (refuse with DATA_DIR_UNSAFE, never repair) for the directories
 * themselves (real directory, no symlink, this owner, no group/other bits), the known secret files (regular file, singly
 * linked so the key is not exposed under another path, this owner, no group/other bits) and the three known public files
 * (same, except group/other may read). Main writes these paths (register §6.1 owner rule), so a wide mode means
 * something else did. Unknown entries in `office-addin/`, `ca/`, `tls/` that are group/other accessible or owned by
 * someone else are returned as `strays` for one warning and do not stop the bridge (ruling C48); `.DS_Store` is ignored.
 * Missing `office-addin/` and `workspace/` are created with 0700.
 *
 * Residual risk (F-M2-3, accepted): macOS extended ACLs are not inspected. Adding an ACL entry needs the owner or root,
 * which is outside the threat model (ADV-3 cannot write a 0700 tree).
 */
/** @internal test seam */
export async function prepareBridgeDataDir(userDataDir: string): Promise<DataDirResult> {
  const paths = bridgeDataPaths(userDataDir)
  if (!(await statOrUndefined(paths.root))) await makeDir(paths.root)

  for (const entry of ["", ...CHECKED_SUBDIRS]) {
    const stat = await statOrUndefined(join(paths.root, entry))
    if (!stat) continue
    const mode = stat.mode & 0o777
    if (!stat.isDirectory() || (mode & 0o077) !== 0 || !ownedByUs(stat.uid))
      return { ok: false, code: "DATA_DIR_UNSAFE", entry: entry || ".", mode }
  }
  for (const entry of [...CHECKED_SECRET_FILES, ...PUBLIC_FILES]) {
    const stat = await statOrUndefined(join(paths.root, entry))
    if (!stat) continue
    const mode = stat.mode & 0o777
    const allowed = PUBLIC_FILES.includes(entry) ? 0o044 : 0
    if (!stat.isFile() || stat.nlink !== 1 || (mode & 0o077 & ~allowed) !== 0 || !ownedByUs(stat.uid))
      return { ok: false, code: "DATA_DIR_UNSAFE", entry, mode }
  }

  const known = [...CHECKED_SUBDIRS, ...CHECKED_SECRET_FILES, ...PUBLIC_FILES]
  const strays: string[] = []
  for (const dir of SCANNED_DIRS) {
    const names = await readdir(join(paths.root, dir)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return []
      throw error
    })
    for (const name of names) {
      const entry = join(dir, name)
      if (IGNORED_NAMES.includes(name) || known.includes(entry)) continue
      const stat = await statOrUndefined(join(paths.root, entry))
      if (stat && ((stat.mode & 0o077) !== 0 || !ownedByUs(stat.uid))) strays.push(entry)
    }
  }

  if (!(await statOrUndefined(paths.workspace))) await makeDir(paths.workspace)
  // C54: the sidecar stores a session's `directory` as its realpath, so the forced `?directory=` and the ownership
  // compare must use the same resolved form, or a symlink anywhere in userData (macOS /var -> /private/var) makes every
  // Office session look foreign. The workspace itself was lstat-checked above (no symlink); only ancestors resolve here.
  return { ok: true, paths: { ...paths, workspace: await realpath(paths.workspace) }, strays }
}

// ── TLS ──

/** The options both listeners share, and the exact set `setSecureContext` receives on a swap (SC-38). */
/** @internal test seam */
export function bridgeTlsOptions(leaf: LeafTls): tls.SecureContextOptions {
  return { cert: leaf.cert, key: leaf.key, minVersion: OFFICE_BRIDGE_TLS_MIN_VERSION }
}

function leafUsable(leaf: LeafTls) {
  if (!leaf.cert || !leaf.key) return false
  try {
    tls.createSecureContext(bridgeTlsOptions(leaf))
    return true
  } catch {
    return false
  }
}

// ── Seams ──

/** @internal test seam */
export type BridgeRequestHandler = (request: IncomingMessage, response: ServerResponse) => void | Promise<void>

/** What later rows inject: one handler for both listeners (SC-38), plus hooks the handle forwards. */
/** @internal test seam */
export type BridgeRoutes = {
  handle: BridgeRequestHandler
  /** Called by `BridgeHandle.pairingsCleared` (pairing row M4-02). */
  pairingsCleared?(): void
  /** Called once by `stop()` before the listeners close (timers, upstream aborts). */
  stop?(): void | Promise<void>
}

export type BridgeRoutesContext = {
  /** The full `start` config. `password` stays in memory: routes may use it for upstream auth, never log it (spec §6). */
  config: Readonly<BridgeStartConfig>
  deps: BridgeCoreDeps
  log: BridgeLogSink
  expectations: BridgeExpectations
  paths: BridgeDataPaths
}

export type BridgeRoutesFactory = (context: BridgeRoutesContext) => BridgeRoutes

/** The subset of `https.Server` the core uses. Injected only by unit tests; production uses `https.createServer`. */
/** @internal test seam */
export type BridgeListener = Pick<https.Server, "listen" | "once" | "off" | "on" | "close" | "address"> & {
  setSecureContext?: (options: tls.SecureContextOptions) => void
}

type BridgeListenerFactory = (options: https.ServerOptions, handler: BridgeRequestHandler) => BridgeListener

type OfficeBridgeFactoryOptions = {
  routes?: BridgeRoutesFactory
  createListener?: BridgeListenerFactory
}

function sendError(response: ServerResponse, status: number, code: string) {
  const body = JSON.stringify({ error: code })
  // SC-07: the same header set as static/health responses (F-M2-1).
  response.writeHead(status, {
    ...BRIDGE_SECURITY_HEADERS,
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(Buffer.byteLength(body)),
  })
  response.end(body)
}

/** Default routes: nothing is exposed until the pipeline rows are wired in. */
/** @internal test seam */
export const notFoundRoutes: BridgeRoutesFactory = () => ({
  handle: (_request, response) => sendError(response, 404, "ROUTE_NOT_ALLOWED"),
})

const defaultListener: BridgeListenerFactory = (options, handler) => https.createServer(options, handler)

const noLog: BridgeLogSink = () => {}

function listen(listener: BridgeListener, host: OfficeBridgeListenAddress, port: number) {
  return new Promise<NodeJS.ErrnoException | undefined>((resolve) => {
    const onError = (error: NodeJS.ErrnoException) => resolve(error)
    listener.once("error", onError)
    // `exclusive`: no handle sharing with cluster workers. `ipv6Only` on `::1` (SC-36); harmless on the IPv4 literal.
    listener.listen({ host, port, ipv6Only: host === "::1", exclusive: true }, () => {
      listener.off("error", onError)
      resolve(undefined)
    })
  })
}

function close(listener: BridgeListener) {
  return new Promise<void>((resolve) => {
    listener.close(() => resolve())
  })
}

/**
 * Build a `BridgeFactory` (protocol.ts) with the given routes. Start order: port check, data directory (DATA_DIR_UNSAFE),
 * leaf (CERT_MISSING when absent or unparsable), routes, then bind `127.0.0.1` and `::1`. Any bind error closes what
 * was bound and gives PORT_IN_USE (SC-14, SC-37); there is no port hopping and no HTTP fallback.
 */
export function createOfficeBridgeFactory(options: OfficeBridgeFactoryOptions = {}): BridgeFactory {
  const makeRoutes = options.routes ?? notFoundRoutes
  const makeListener = options.createListener ?? defaultListener

  return async (config, deps): Promise<BridgeStartResult> => {
    const log = deps.log ?? noLog
    const expectations = bridgeExpectations(config.port)

    const dataDir = await prepareBridgeDataDir(config.userDataDir)
    if (!dataDir.ok) {
      log("error", "office-bridge.start", "data directory unsafe", {
        code: dataDir.code,
        entry: dataDir.entry,
        mode: dataDir.mode.toString(8),
      })
      return { ok: false, code: "DATA_DIR_UNSAFE" }
    }
    if (dataDir.strays.length > 0)
      log("warn", "office-bridge.start", "unexpected entries in data directory", { entries: dataDir.strays.join(",") })

    const leaf = { cert: config.cert, key: config.key }
    if (!leafUsable(leaf)) {
      log("error", "office-bridge.start", "leaf certificate missing or unusable", { code: "CERT_MISSING" })
      return { ok: false, code: "CERT_MISSING" }
    }

    const routes = makeRoutes({ config, deps, log, expectations, paths: dataDir.paths })
    const sockets = new Set<Socket>()

    // One handler for both listeners (SC-38). A throw or rejection never leaves the request hanging.
    const handler: BridgeRequestHandler = async (request, response) => {
      try {
        await routes.handle(request, response)
      } catch (error) {
        log("error", "office-bridge.request", "route handler failed", {
          method: request.method,
          error: error instanceof Error ? error.name : "unknown",
        })
        if (!response.headersSent) return sendError(response, 503, "SWARM_UNAVAILABLE")
        response.destroy()
      }
    }

    const serverOptions: https.ServerOptions = { ...bridgeTlsOptions(leaf), ALPNProtocols: OFFICE_BRIDGE_ALPN }
    const listeners = OFFICE_BRIDGE_LISTEN_ADDRESSES.map((host) => {
      const listener = makeListener(serverOptions, handler)
      // Track raw sockets so stop() can end keep-alive connections and open SSE streams.
      listener.on("connection", (socket: Socket) => {
        sockets.add(socket)
        socket.once("close", () => sockets.delete(socket))
      })
      listener.on("tlsClientError", (error: NodeJS.ErrnoException) => {
        log("warn", "office-bridge.tls", "tls client error", { host, code: error.code ?? "unknown" })
      })
      return { host, listener }
    })

    const bound: BridgeListener[] = []
    for (const { host, listener } of listeners) {
      const error = await listen(listener, host, config.port)
      if (error) {
        log("error", "office-bridge.start", "listen failed", { host, port: config.port, code: error.code ?? "unknown" })
        // Same order as stop() (F-M2-2): close() only stops accepting and resolves after the last connection ends, so a
        // client that connected between the two binds would hold PORT_IN_USE back until it leaves.
        const closed = bound.map(close)
        for (const socket of sockets) socket.destroy()
        await Promise.all(closed)
        await routes.stop?.()
        return { ok: false, code: "PORT_IN_USE" }
      }
      bound.push(listener)
      listener.on("error", (late: NodeJS.ErrnoException) => {
        log("error", "office-bridge.listener", "listener error", { host, code: late.code ?? "unknown" })
      })
    }

    log("info", "office-bridge.start", "listening", { port: config.port, hosts: OFFICE_BRIDGE_LISTEN_ADDRESSES.join(",") })

    let stopping: Promise<void> | undefined
    const bridge: BridgeHandle = {
      port: config.port,
      updateTls(next) {
        if (stopping) return
        // Validate first so a bad leaf never reaches either listener (both swap or neither does).
        const context = bridgeTlsOptions(next)
        tls.createSecureContext(context)
        const swapped = listeners.filter(({ host, listener }) => {
          if (typeof listener.setSecureContext === "function") {
            listener.setSecureContext(context)
            return true
          }
          log("warn", "office-bridge.tls", "setSecureContext unavailable in this runtime", {
            host,
            code: "TLS_SWAP_UNSUPPORTED",
          })
          return false
        }).length
        // F-M2-4: report what really happened, never a success the listeners did not see.
        if (swapped === 0) return log("error", "office-bridge.tls", "leaf not swapped", { code: "TLS_SWAP_UNSUPPORTED" })
        log("info", "office-bridge.tls", "leaf swapped", { listeners: swapped, of: listeners.length })
      },
      pairingsCleared() {
        routes.pairingsCleared?.()
      },
      stop() {
        if (stopping) return stopping
        stopping = (async () => {
          await routes.stop?.()
          const closed = listeners.map(({ listener }) => close(listener))
          // close() only stops accepting; open keep-alive sockets and SSE streams are ended here.
          for (const socket of sockets) socket.destroy()
          await Promise.all(closed)
          log("info", "office-bridge.stop", "stopped", { port: config.port })
        })()
        return stopping
      },
    }
    return { ok: true, bridge }
  }
}

/** The core with default (404-only) routes. The integration row passes the composed pipeline instead. */
/** @internal test seam */
export const startOfficeBridge: BridgeFactory = createOfficeBridgeFactory()
