// DATUM render bridge: Unix socket server (runtime spec §3.2a).
//
// <os.tmpdir()>/swarm-datum-<random>/render.sock, folder 0700, socket 0600. Every request line
// carries the per-launch token; it is compared in constant time and never logged.
//
// 1.2.6 row 93 (TH-04, DP-1): `socketPath` restarts the server on a known endpoint (same path, same token from the
// caller). The folder is recreated 0700 when it is missing; an existing folder must be a real directory owned by this
// user; a stale socket file is unlinked (any other file type is refused, never deleted). Close removes only this
// server's own socket file (same inode) and the folder when empty, so a late close of an old server never removes the
// socket of the server that replaced it.
//
// 1.3.3 row 131 (SB-1, F1 and F5 of the row 21 diagnosis):
// - Receive path: incoming chunks are kept in a list and joined once when the newline arrives (`createLineReader`).
//   Before, every chunk was concatenated onto the accumulated buffer, which copied the whole partial line per chunk:
//   1,030 MB allocated for one 4 MiB request, 14,453 MB for 15 MiB. Framing, the line cap and the replies are unchanged;
//   the cap acts on the running byte count, before any join.
// - One "render job memory" log line per job (every op but `hello`), with `process.memoryUsage()` before and after in
//   the field names of the main memory line (register section 10), through the logger the caller already passes in.

import { createHash, timingSafeEqual } from "node:crypto"
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, rmdirSync, statSync, unlinkSync } from "node:fs"
import { createServer, type Server, type Socket } from "node:net"
import { tmpdir } from "node:os"
import { basename, dirname, isAbsolute, join } from "node:path"
import { BridgeError, errorResponse, MAX_LINE_BYTES, parseLine } from "./protocol"

export type BridgeLog = (level: "error" | "warn" | "info", source: string, message: string, context?: Record<string, unknown>) => void

export type SocketServerOptions = {
  token: string
  dispatch: (body: unknown) => Promise<Record<string, unknown>>
  log: BridgeLog
  baseDir?: string
  /** Row 93: listen on this exact path (a same-endpoint restart) instead of a new temp folder. */
  socketPath?: string
  maxConnections?: number
  maxLineBytes?: number
  /** Row 131: the one join per request line. Tests inject a counting version; the default is `Buffer.concat`. */
  concat?: (list: Buffer[], totalBytes: number) => Buffer
}

export type SocketServerHandle = { socketPath: string; dir: string; close(): Promise<void> }

function digest(s: string) {
  return createHash("sha256").update(s, "utf8").digest()
}

export function tokenMatches(given: string, expected: string) {
  return timingSafeEqual(digest(given), digest(expected)) && given.length === expected.length
}

function errno(error: unknown) {
  return (error as NodeJS.ErrnoException | undefined)?.code
}

class SocketPathError extends Error {
  readonly code = "BRIDGE_SOCKET_UNSAFE"
}

/** Row 93: make `socketPath` listenable again: folder 0700 owned by this user, no stale socket file. */
export function prepareSocketPath(socketPath: string) {
  if (!isAbsolute(socketPath) || basename(socketPath) !== "render.sock") throw new SocketPathError("socket path must be an absolute .../render.sock")
  const dir = dirname(socketPath)
  let st: ReturnType<typeof lstatSync> | undefined
  try {
    st = lstatSync(dir)
  } catch (error) {
    if (errno(error) !== "ENOENT") throw error
  }
  if (!st) mkdirSync(dir, { mode: 0o700 })
  else {
    if (!st.isDirectory() || st.isSymbolicLink()) throw new SocketPathError("socket folder is not a directory")
    const uid = process.getuid?.()
    if (uid !== undefined && st.uid !== uid) throw new SocketPathError("socket folder belongs to another user")
  }
  chmodSync(dir, 0o700)
  let file: ReturnType<typeof lstatSync> | undefined
  try {
    file = lstatSync(socketPath)
  } catch (error) {
    if (errno(error) !== "ENOENT") throw error
  }
  if (file) {
    if (!file.isSocket()) throw new SocketPathError("socket path holds a file that is not a socket")
    unlinkSync(socketPath)
  }
  return dir
}

type LineReaderOptions = {
  maxLine: number
  /** A complete, non-blank line without its newline (and without a trailing CR); `bytes` is its size on the wire. */
  onLine: (line: string, bytes: number) => void
  /** The unfinished line grew past `maxLine`; `bytes` is its size. The reader has already dropped it. */
  onTooLong: (bytes: number) => void
  concat?: (list: Buffer[], totalBytes: number) => Buffer
}

/**
 * Row 131: newline framing over a chunk list. The unfinished line is held as the chunks that arrived (no copy); it is
 * joined once, when its newline arrives, and not at all when the whole line sits in one chunk. Same lines, same order
 * and the same cap rule as the per-chunk concat it replaces: after the complete lines of a chunk are handed out, an
 * unfinished rest larger than `maxLine` is refused and dropped.
 */
/** @internal test seam */
export function createLineReader(opts: LineReaderOptions) {
  // Looked up per call, so a wrapped `Buffer.concat` (growth-harness.ts) still counts this join.
  const concat = opts.concat ?? ((list: Buffer[], totalBytes: number) => Buffer.concat(list, totalBytes))
  let parts: Buffer[] = []
  let partBytes = 0
  return {
    push(chunk: Buffer) {
      let start = 0
      for (let nl = chunk.indexOf(10, start); nl >= 0; nl = chunk.indexOf(10, start)) {
        const tail = chunk.subarray(start, nl)
        start = nl + 1
        let whole = tail
        if (parts.length > 0) {
          parts.push(tail)
          whole = concat(parts, partBytes + tail.length)
          parts = []
          partBytes = 0
        }
        const line = whole.toString("utf8").replace(/\r$/, "")
        if (line.trim() === "") continue
        opts.onLine(line, whole.length)
      }
      if (start < chunk.length) {
        const rest = start === 0 ? chunk : chunk.subarray(start)
        parts.push(rest)
        partBytes += rest.length
      }
      if (partBytes > opts.maxLine) {
        const bytes = partBytes
        parts = []
        partBytes = 0
        opts.onTooLong(bytes)
      }
    },
  }
}

const MB = 1024 * 1024

/** Row 131: the four figures of the main memory line (register section 10), integers in MB. */
function memoryMb() {
  const m = process.memoryUsage()
  return {
    rssMb: Math.round(m.rss / MB),
    heapUsedMb: Math.round(m.heapUsed / MB),
    heapTotalMb: Math.round(m.heapTotal / MB),
    externalMb: Math.round(m.external / MB),
  }
}

/** The op name for the log: a short plain word, or "unknown". Request content never reaches the log. */
function opName(body: unknown) {
  const op = (body as { op?: unknown } | null | undefined)?.op
  return typeof op === "string" && /^[A-Za-z]{1,24}$/.test(op) ? op : "unknown"
}

export async function startSocketServer(opts: SocketServerOptions): Promise<SocketServerHandle> {
  let dir: string
  if (opts.socketPath) dir = prepareSocketPath(opts.socketPath)
  else {
    dir = mkdtempSync(join(opts.baseDir ?? tmpdir(), "swarm-datum-"))
    chmodSync(dir, 0o700)
  }
  const socketPath = opts.socketPath ?? join(dir, "render.sock")
  const maxLine = opts.maxLineBytes ?? MAX_LINE_BYTES
  let seq = 0
  const open = new Set<Socket>()

  const server: Server = createServer({ allowHalfOpen: false }, (sock: Socket) => {
    const conn = ++seq
    open.add(sock)
    sock.on("close", () => open.delete(sock))
    let pending = Promise.resolve()
    const reply = (obj: unknown) => {
      if (!sock.destroyed) sock.write(JSON.stringify(obj) + "\n")
    }

    const handle = async (line: string, lineBytes: number) => {
      let id: string | number | undefined
      // Row 131 (F5): set once the request is authorised and handed to dispatch; `hello` is a handshake, not a job.
      let job: { op: string; started: number; before: ReturnType<typeof memoryMb> } | undefined
      const jobDone = (ok: boolean) => {
        if (!job) return
        opts.log("info", "datum-render.job", "render job memory", {
          conn,
          id,
          op: job.op,
          ok,
          lineBytes,
          ms: Date.now() - job.started,
          before: job.before,
          after: memoryMb(),
        })
      }
      try {
        const env = parseLine(line)
        id = env.id
        if (!tokenMatches(env.token, opts.token)) throw new BridgeError("UNAUTHORIZED", "missing or wrong token")
        const op = opName(env.body)
        if (op !== "hello") job = { op, started: Date.now(), before: memoryMb() }
        const result = await opts.dispatch(env.body)
        jobDone(true)
        reply({ id, ok: true, ...result })
      } catch (error) {
        jobDone(false)
        const res = errorResponse(id, error)
        opts.log(res.code === "RENDER_FAILED" || res.code === "RENDER_TIMEOUT" ? "error" : "warn", "datum-render.request", res.message, {
          conn,
          id,
          code: res.code,
          // Never the token, never the content: only the error itself.
          stack: error instanceof Error && !(error instanceof BridgeError) ? error.stack : undefined,
          cause: error instanceof Error && !(error instanceof BridgeError) ? error.message : undefined,
        })
        reply(res)
      }
    }

    const reader = createLineReader({
      maxLine,
      concat: opts.concat,
      onLine: (line, bytes) => {
        pending = pending.then(() => handle(line, bytes))
      },
      onTooLong: (bytes) => {
        opts.log("warn", "datum-render.socket", "request line too long", { conn, bytes })
        reply(errorResponse(undefined, new BridgeError("LINE_TOO_LONG", "request line is larger than the line cap")))
        sock.end()
      },
    })
    sock.on("data", (chunk: Buffer) => reader.push(chunk))
    sock.on("error", (error) => opts.log("warn", "datum-render.socket", "connection error", { conn, cause: error.message }))
  })
  server.maxConnections = opts.maxConnections ?? 16

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(socketPath, () => {
      server.off("error", reject)
      resolve()
    })
  })
  chmodSync(socketPath, 0o600)
  const own = statSync(socketPath)
  server.on("error", (error) => opts.log("error", "datum-render.socket", "server error", { cause: error.message, stack: error.stack }))
  opts.log("info", "datum-render.socket", "render bridge listening", { socketPath })

  return {
    socketPath,
    dir,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of open) s.destroy()
        server.close(() => {
          // Only this server's socket file; the folder only when it is empty (a successor may already listen there).
          try {
            const now = lstatSync(socketPath)
            if (now.ino === own.ino && now.dev === own.dev) unlinkSync(socketPath)
          } catch {}
          try {
            rmdirSync(dir)
          } catch {}
          resolve()
        })
      }),
  }
}
