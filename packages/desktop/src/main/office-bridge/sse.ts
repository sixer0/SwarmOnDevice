// SSE passthrough of the office bridge (row M5-03, plan M5-03). Server-delta spec §9.5 (P8), §9.3 (response header
// allow-list); register rev 5 §7.3 P8, §7.6 (`429 STREAM_LIMIT`, rev 3 change 3.1); security spec SC-31 (RC-5, accepted
// by C15 RM-26; code registered by C16), SC-05, SC-07, SC-33.
//
// What this module owns: the per-token stream cap, the downstream headers, the unbuffered byte pump and teardown in both
// directions. What it does not own: admission (admit.ts already matched P8 and verified the token) and the upstream
// request (URL, forced `directory`, Basic auth, header allow-list), which the upstream builder (M5-02, upstream.ts)
// provides as an injected `openUpstream`. This keeps the row on a contract dependency only.
//
// Contract for `openUpstream` (M5-02): it must GET `/event?directory=<Office workspace>` on the `start` URL, honour
// `signal` (abort closes the upstream socket) and disable the upstream idle/body timeout (spec §9.5 "timeouts 0"). The
// downstream timeouts are set to 0 here.
import { createHash } from "node:crypto"
import { OFFICE_ERROR_STREAM_LIMIT, OFFICE_ERROR_SWARM_UNAVAILABLE, OFFICE_STREAM_LIMIT } from "@swarm/office-addin/constants"
import type { BridgeLogSink } from "./protocol"
import { BRIDGE_SECURITY_HEADERS } from "./static"

/** Downstream headers of P8 (spec §9.3, §9.5; S-19). Upstream headers are never copied: the set is fixed here. */
/** @internal test seam */
export const SSE_RESPONSE_HEADERS: Readonly<Record<string, string>> = {
  ...BRIDGE_SECURITY_HEADERS,
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache, no-transform",
}

/** The upstream opener injected by the upstream builder (M5-02). `signal` aborts the upstream request. */
/** @internal test seam */
export type OpenUpstream = (signal: AbortSignal) => Promise<Response>

/** The part of `ServerResponse` the relay uses; `node:http` `ServerResponse` satisfies it. */
export type SseDownstream = {
  readonly headersSent: boolean
  readonly writableEnded: boolean
  readonly destroyed: boolean
  readonly socket?: {
    setTimeout(ms: number): unknown
    setNoDelay(noDelay?: boolean): unknown
    once(event: "close", listener: () => void): unknown
    off(event: "close", listener: () => void): unknown
  } | null
  setTimeout(ms: number): unknown
  writeHead(status: number, headers: Record<string, string | number>): unknown
  flushHeaders(): void
  write(chunk: Uint8Array): boolean
  end(chunk?: string): unknown
  destroy(): unknown
  once(event: "close" | "drain", listener: () => void): unknown
  off(event: "close" | "drain", listener: () => void): unknown
}

type SseRelayResult =
  /** The stream ran and has ended; `by` names the side that closed first. */
  | { kind: "ended"; by: "upstream" | "client" | "stop" | "revoked" | "upstream-error" }
  /** Refused before any byte was streamed; a JSON error body was sent. */
  | { kind: "rejected"; status: number; code: string }

type SseRelayOptions = {
  /** Concurrent streams per token. Defaults to OFFICE_STREAM_LIMIT (4, SC-31). */
  limit?: number
  log?: BridgeLogSink
}

function sendError(response: SseDownstream, status: number, code: string) {
  const body = JSON.stringify({ error: code })
  response.writeHead(status, {
    ...BRIDGE_SECURITY_HEADERS,
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  })
  response.end(body)
  return { kind: "rejected", status, code } as const
}

/**
 * Create the P8 relay. One instance per bridge: the per-token counter lives here. Tokens are counted by their SHA-256
 * so the relay holds no raw token. `stop()` ends every open stream (bridge `stop`, spec §9.5).
 */
export function createSseRelay(options: SseRelayOptions = {}) {
  const limit = options.limit ?? OFFICE_STREAM_LIMIT
  const log = options.log ?? (() => {})
  const counts = new Map<string, number>()
  /** Open streams: the teardown of each, keyed to its token key (lowercase hex SHA-256, as in `keyOf`). */
  const open = new Map<(by: "stop" | "revoked") => void, string>()
  let stopped = false

  const keyOf = (token: string) => createHash("sha256").update(token).digest("hex")

  const release = (key: string) => {
    const next = (counts.get(key) ?? 1) - 1
    if (next <= 0) return void counts.delete(key)
    counts.set(key, next)
  }

  async function relay(input: {
    token: string
    response: SseDownstream
    openUpstream: OpenUpstream
  }): Promise<SseRelayResult> {
    const response = input.response
    if (stopped) return sendError(response, 503, OFFICE_ERROR_SWARM_UNAVAILABLE)
    const key = keyOf(input.token)
    // Reserve the slot before the first await, so concurrent opens cannot pass the cap together.
    if ((counts.get(key) ?? 0) >= limit) {
      log("warn", "office-bridge.sse", "stream limit reached", { route: "P8", status: 429, code: OFFICE_ERROR_STREAM_LIMIT })
      return sendError(response, 429, OFFICE_ERROR_STREAM_LIMIT)
    }
    counts.set(key, (counts.get(key) ?? 0) + 1)

    const abort = new AbortController()
    let closedBy: "client" | "stop" | "revoked" | undefined
    const onClientClose = () => {
      closedBy ??= "client"
      abort.abort()
    }
    const stopThis = (by: "stop" | "revoked") => {
      closedBy ??= by
      abort.abort()
      response.destroy()
    }
    // Client gone: Node emits `close` on the response; Bun's node:http only on the socket. Both are watched.
    const socket = response.socket
    response.once("close", onClientClose)
    socket?.once("close", onClientClose)
    open.set(stopThis, key)

    // Timeouts 0 on the downstream leg (spec §9.5); the 10 s upstream heartbeat keeps it alive.
    response.setTimeout(0)
    response.socket?.setTimeout(0)
    response.socket?.setNoDelay(true)

    const finish = (result: SseRelayResult) => {
      response.off("close", onClientClose)
      socket?.off("close", onClientClose)
      open.delete(stopThis)
      release(key)
      return result
    }

    const upstream = await input.openUpstream(abort.signal).catch((error: unknown) => {
      log("error", "office-bridge.sse", "upstream open failed", {
        route: "P8",
        error: error instanceof Error ? error.name : "unknown",
      })
      return undefined
    })
    if (closedBy) {
      await upstream?.body?.cancel().catch(() => {})
      return finish({ kind: "ended", by: closedBy })
    }
    if (!upstream || !upstream.ok || !upstream.body) {
      await upstream?.body?.cancel().catch(() => {})
      // Upstream 401 (and any other failure) is 503 to the pane: it never sees the sidecar's auth state (spec §9.3).
      log("warn", "office-bridge.sse", "upstream unavailable", { route: "P8", status: upstream?.status ?? 0 })
      return finish(sendError(response, 503, OFFICE_ERROR_SWARM_UNAVAILABLE))
    }

    response.writeHead(200, { ...SSE_RESPONSE_HEADERS })
    response.flushHeaders()

    const reader = upstream.body.getReader()
    // Client gone: cancel the upstream body too, so a pending read() settles and the socket is released.
    abort.signal.addEventListener("abort", () => void reader.cancel().catch(() => {}), { once: true })

    const waitDrain = () =>
      new Promise<void>((resolve) => {
        const done = () => {
          response.off("drain", done)
          response.off("close", done)
          resolve()
        }
        response.once("drain", done)
        response.once("close", done)
      })

    const pumped = await (async () => {
      while (!closedBy) {
        const chunk = await reader.read()
        // A cancel from the client side also settles read() as done; the closing side is what counts.
        if (closedBy) return closedBy
        if (chunk.done) return "upstream" as const
        // Bytes pass unchanged: no parser, no filter (D5c, C22).
        if (!response.write(chunk.value)) await waitDrain()
      }
      return closedBy
    })().catch((error: unknown) => {
      if (closedBy) return closedBy
      log("warn", "office-bridge.sse", "upstream stream failed", {
        route: "P8",
        error: error instanceof Error ? error.name : "unknown",
      })
      return "upstream-error" as const
    })

    // Upstream ended normally: end the client. Upstream failed: destroy the client so the pane reconnects.
    if (pumped === "upstream" && !response.writableEnded) response.end()
    if (pumped === "upstream-error" && !response.destroyed) response.destroy()
    if (pumped !== "client" && pumped !== "stop" && pumped !== "revoked") abort.abort()
    return finish({ kind: "ended", by: pumped })
  }

  return {
    relay,
    /** Open streams for a token (tests, diagnostics). */
    active(token: string) {
      return counts.get(keyOf(token)) ?? 0
    },
    /** End every open stream and refuse new ones. Called from the routes' `stop` hook. */
    stop() {
      stopped = true
      for (const stopThis of [...open.keys()]) stopThis("stop")
    },
    /**
     * Disconnect (M5-F1): end every open stream at once (downstream destroyed, upstream aborted) but keep accepting
     * new ones; a new stream still needs a token admit() accepts.
     */
    closeAll() {
      for (const stopThis of [...open.keys()]) stopThis("revoked")
    },
    /**
     * Revocation sweep (M5-F1): end the streams whose token key matches. The key is the lowercase hex SHA-256 of the
     * token, the same digest the pairing store keeps as `sha256:<hex>`; the relay never holds the raw token.
     */
    closeWhere(predicate: (tokenKey: string) => boolean) {
      const matched = [...open.entries()].filter((entry) => predicate(entry[1]))
      for (const entry of matched) entry[0]("revoked")
      return matched.length
    },
  }
}

type SseRelay = ReturnType<typeof createSseRelay>
