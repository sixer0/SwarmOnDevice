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
    let buf = Buffer.alloc(0)
    let pending = Promise.resolve()
    const reply = (obj: unknown) => {
      if (!sock.destroyed) sock.write(JSON.stringify(obj) + "\n")
    }

    const handle = async (line: string) => {
      let id: string | number | undefined
      try {
        const env = parseLine(line)
        id = env.id
        if (!tokenMatches(env.token, opts.token)) throw new BridgeError("UNAUTHORIZED", "missing or wrong token")
        const result = await opts.dispatch(env.body)
        reply({ id, ok: true, ...result })
      } catch (error) {
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

    sock.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk])
      for (let nl = buf.indexOf(10); nl >= 0; nl = buf.indexOf(10)) {
        const line = buf.subarray(0, nl).toString("utf8").replace(/\r$/, "")
        buf = buf.subarray(nl + 1)
        if (line.trim() === "") continue
        pending = pending.then(() => handle(line))
      }
      if (buf.length > maxLine) {
        opts.log("warn", "datum-render.socket", "request line too long", { conn, bytes: buf.length })
        reply(errorResponse(undefined, new BridgeError("LINE_TOO_LONG", "request line is larger than the line cap")))
        buf = Buffer.alloc(0)
        sock.end()
      }
    })
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
