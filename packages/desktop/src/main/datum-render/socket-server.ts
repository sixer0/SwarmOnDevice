// DATUM render bridge: Unix socket server (runtime spec §3.2a).
//
// <os.tmpdir()>/swarm-datum-<random>/render.sock, folder 0700, socket 0600. Every request line
// carries the per-launch token; it is compared in constant time and never logged.

import { createHash, timingSafeEqual } from "node:crypto"
import { chmodSync, mkdtempSync, rmSync } from "node:fs"
import { createServer, type Server, type Socket } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BridgeError, errorResponse, MAX_LINE_BYTES, parseLine } from "./protocol"

export type BridgeLog = (level: "error" | "warn" | "info", source: string, message: string, context?: Record<string, unknown>) => void

export type SocketServerOptions = {
  token: string
  dispatch: (body: unknown) => Promise<Record<string, unknown>>
  log: BridgeLog
  baseDir?: string
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

export async function startSocketServer(opts: SocketServerOptions): Promise<SocketServerHandle> {
  const dir = mkdtempSync(join(opts.baseDir ?? tmpdir(), "swarm-datum-"))
  chmodSync(dir, 0o700)
  const socketPath = join(dir, "render.sock")
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
  server.on("error", (error) => opts.log("error", "datum-render.socket", "server error", { cause: error.message, stack: error.stack }))
  opts.log("info", "datum-render.socket", "render bridge listening", { socketPath })

  return {
    socketPath,
    dir,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of open) s.destroy()
        server.close(() => {
          rmSync(dir, { recursive: true, force: true })
          resolve()
        })
      }),
  }
}
