// Render-bridge probe (1.2.6 row 93, TH-04 / SEC-15; spec 01c 4.4, N-126).
//
// Runs in main, next to the bridge. One connection, one `hello` line, one reply:
// - no endpoint (the bridge never started)            -> dead  BRIDGE_NOT_STARTED (no in-session revive)
// - connect fails (socket file or folder gone, refused) -> dead  BRIDGE_SOCKET_GONE, detail = the error code
// - reply `ok: true` with id "health"                  -> healthy OK
// - `UNAUTHORIZED`, a malformed reply, or a close without reply -> dead BRIDGE_BAD_REPLY, detail = the reply code
// - connected but no reply within timeoutMs            -> healthy, detail "busy". `hello` is queued behind running
//   jobs (dispatch.ts), so a long render is ahead of it; a busy bridge is never restarted.
//
// SEC-15: the token is written to the socket only. It is never part of a ProbeResult, a log line or an error text;
// details carry codes, never reply text.

import { createConnection } from "node:net"
import type { ProbeResult } from "./probe"

export type RenderBridgeEndpoint = { socketPath: string; token: string }

export const BRIDGE_PROBE_ID = "health"
const MAX_REPLY_BYTES = 64 * 1024
const CODE_RE = /^[A-Z][A-Z0-9_]{0,40}$/

function codeOf(value: unknown) {
  return typeof value === "string" && CODE_RE.test(value) ? value : "UNKNOWN"
}

export function probeRenderBridge(endpoint: RenderBridgeEndpoint | undefined, timeoutMs: number): Promise<ProbeResult> {
  if (!endpoint) return Promise.resolve({ healthy: false, reason: "BRIDGE_NOT_STARTED", detail: "no bridge in this launch" })
  return new Promise<ProbeResult>((resolve) => {
    let settled = false
    let connected = false
    let size = 0
    const chunks: Buffer[] = []
    const sock = createConnection({ path: endpoint.socketPath })
    const done = (result: ProbeResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      sock.destroy()
      resolve(result)
    }
    const bad = (detail: string) => done({ healthy: false, reason: "BRIDGE_BAD_REPLY", detail })
    const timer = setTimeout(() => {
      if (connected) done({ healthy: true, reason: "OK", detail: "busy" })
      else done({ healthy: false, reason: "BRIDGE_SOCKET_GONE", detail: "CONNECT_TIMEOUT" })
    }, Math.max(1, timeoutMs))
    sock.on("connect", () => {
      connected = true
      sock.write(`${JSON.stringify({ op: "hello", token: endpoint.token, id: BRIDGE_PROBE_ID })}\n`)
    })
    sock.on("error", (error) => {
      if (connected) return bad(codeOf((error as NodeJS.ErrnoException).code))
      done({ healthy: false, reason: "BRIDGE_SOCKET_GONE", detail: codeOf((error as NodeJS.ErrnoException).code) })
    })
    sock.on("data", (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_REPLY_BYTES) return bad("REPLY_TOO_LARGE")
      const nl = chunk.indexOf(0x0a)
      if (nl < 0) {
        chunks.push(chunk)
        return
      }
      chunks.push(chunk.subarray(0, nl))
      let reply: unknown
      try {
        reply = JSON.parse(Buffer.concat(chunks).toString("utf8"))
      } catch {
        return bad("REPLY_NOT_JSON")
      }
      if (!reply || typeof reply !== "object") return bad("REPLY_NOT_OBJECT")
      const r = reply as { ok?: unknown; id?: unknown; code?: unknown }
      if (r.ok === true && r.id === BRIDGE_PROBE_ID) return done({ healthy: true, reason: "OK", detail: "hello ok" })
      if (r.ok === false) return bad(codeOf(r.code))
      return bad("REPLY_MALFORMED")
    })
    sock.on("close", () => {
      if (connected) bad("CLOSED_WITHOUT_REPLY")
      else done({ healthy: false, reason: "BRIDGE_SOCKET_GONE", detail: "CLOSED" })
    })
  })
}
