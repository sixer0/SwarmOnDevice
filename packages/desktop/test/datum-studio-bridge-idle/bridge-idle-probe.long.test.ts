// Row FX-4 (1.2.6 review wave F, gate M2 finding S2): real-time idle probe for the stdio bridge transport.
//
// MANUAL / LONG test, skipped by default. It needs about 10 minutes of wall time, local listen (run it outside the agent
// sandbox) and the Electron binary of packages/desktop (falls back to `node` on PATH). Run:
//   SWARM_FX4_LONG_PROBE=1 bun test ./test/datum-studio-bridge-idle/bridge-idle-probe.long.test.ts --timeout 900000
// Optional: SWARM_FX4_DELAYS="330,545" (seconds), SWARM_FX4_NODE=<node or Electron binary>.
//
// Question (S2): does Bun (repo bun 1.3.14) end a silent HTTP request before the 540 s R17 budget
// (STUDIO_RENDER_CALL_TIMEOUT_MS), on the client `fetch` side the bridge uses, or on the server side?
// Production pair: the bridge (packages/desktop/scripts/datum-studio-bridge.ts) runs on the bundled Bun and calls
// `fetch()`; the host endpoint (packages/datum-studio/src/mcp-host/http-server.ts) is a `node:http` server running in an
// Electron utilityProcess (Node runtime), so the server child here is Electron run as Node with the same settings.
// Bun.serve is probed as well because the S2 hypothesis names its idle ceiling.
//
// Every case answers once after D seconds with NO bytes in between ("plain"), or sends the SSE response headers at
// once and then nothing until D ("sse", the shape StreamableHTTPServerTransport produces for a pending tools/call).
import { afterAll, beforeAll, expect, test } from "bun:test"
import { spawn, type ChildProcess } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { HOST_HTTP_TIMEOUTS } from "../../../datum-studio/src/mcp-host/http-server"
import { BRIDGE_FETCH_OPTIONS } from "../../scripts/datum-studio-bridge-transport"

const LONG = process.env.SWARM_FX4_LONG_PROBE === "1"
const DELAYS = (process.env.SWARM_FX4_DELAYS ?? "330,545").split(",").map((s) => Number(s.trim()))
const DESKTOP = join(import.meta.dir, "..", "..")
const ELECTRON = join(DESKTOP, "node_modules", "electron", "dist", "Electron.app", "Contents", "MacOS", "Electron")
const NODE_BIN = process.env.SWARM_FX4_NODE ?? (existsSync(ELECTRON) ? ELECTRON : "node")

// The node:http server, with the host's own limits (HOST_HTTP_TIMEOUTS from http-server.ts, injected below).
const NODE_SERVER = `
const http = require("node:http")
const srv = http.createServer((req, res) => {
  const m = /^\\/(sse|plain)\\/(\\d+)$/.exec(req.url || "")
  req.resume()
  if (!m) { res.writeHead(404); res.end(); return }
  const ms = Number(m[2]) * 1000
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { waited: Number(m[2]) } })
  if (m[1] === "sse") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
    res.flushHeaders()
    setTimeout(() => res.end("event: message\\ndata: " + body + "\\n\\n"), ms)
  } else {
    setTimeout(() => { res.writeHead(200, { "content-type": "application/json" }); res.end(body) }, ms)
  }
})
const T = JSON.parse(process.env.FX4_HOST_TIMEOUTS)
srv.requestTimeout = T.requestTimeout
srv.headersTimeout = T.headersTimeout
srv.timeout = T.timeout
srv.listen(0, "127.0.0.1", () => {
  process.stdout.write(JSON.stringify({ port: srv.address().port, runtime: process.versions.electron ? "electron " + process.versions.electron + " node " + process.versions.node : "node " + process.versions.node, serverTimeout: srv.timeout, keepAliveTimeout: srv.keepAliveTimeout, requestTimeout: srv.requestTimeout, headersTimeout: srv.headersTimeout }) + "\\n")
})
`

type Outcome = { case: string; delay: number; ok: boolean; elapsedS: number; detail: string }

let nodeChild: ChildProcess | undefined
let nodeInfo: Record<string, unknown> = {}
const bunServers: ReturnType<typeof Bun.serve>[] = []

function bunServer(idleTimeout: number | undefined) {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    ...(idleTimeout === undefined ? {} : { idleTimeout }),
    fetch(req) {
      const m = /^\/(sse|plain)\/(\d+)$/.exec(new URL(req.url).pathname)
      if (!m) return new Response("", { status: 404 })
      const ms = Number(m[2]) * 1000
      const body = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { waited: Number(m[2]) } })
      if (m[1] === "plain")
        return new Promise<Response>((r) =>
          setTimeout(() => r(new Response(body, { headers: { "content-type": "application/json" } })), ms),
        )
      const stream = new ReadableStream({
        start(c) {
          setTimeout(() => {
            // The server may already have cut the stream (Bun.serve idleTimeout); then the controller is closed.
            try {
              c.enqueue(new TextEncoder().encode(`event: message\ndata: ${body}\n\n`))
              c.close()
            } catch {}
          }, ms)
        },
      })
      return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } })
    },
  })
  bunServers.push(server)
  return server
}

/** One line per finished case, so a partial run still leaves evidence. */
function report(o: Outcome) {
  console.log(`FX4-RESULT ${JSON.stringify(o)}`)
  return o
}

/** The bridge's request shape (Bridge.fetch + forward/readEvents): POST, redirect "error", body read to the end. */
async function call(name: string, url: string, delay: number, extra: Record<string, unknown>): Promise<Outcome> {
  const t0 = performance.now()
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "studio_render" } }),
      redirect: "error",
      ...extra,
    } as RequestInit)
    let text = ""
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) text += new TextDecoder().decode(chunk)
    const ok = res.status === 200 && text.includes(`"waited":${delay}`)
    return report({ case: name, delay, ok, elapsedS: (performance.now() - t0) / 1000, detail: `status ${res.status}, ${text.length} B` })
  } catch (e) {
    const err = e as Error & { code?: string }
    return report({
      case: name,
      delay,
      ok: false,
      elapsedS: (performance.now() - t0) / 1000,
      detail: `${err?.name ?? "Error"}${err?.code ? ` ${err.code}` : ""}: ${err?.message ?? String(e)}`,
    })
  }
}

beforeAll(async () => {
  if (!LONG) return
  nodeChild = spawn(NODE_BIN, ["-e", NODE_SERVER], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", FX4_HOST_TIMEOUTS: JSON.stringify(HOST_HTTP_TIMEOUTS) },
    stdio: ["ignore", "pipe", "inherit"],
  })
  nodeInfo = await new Promise<Record<string, unknown>>((resolve, reject) => {
    let buf = ""
    nodeChild!.stdout!.on("data", (d: Buffer) => {
      buf += d.toString()
      const line = buf.split("\n")[0]
      if (buf.includes("\n")) resolve(JSON.parse(line) as Record<string, unknown>)
    })
    nodeChild!.once("exit", (code) => reject(new Error(`node server exited ${code}`)))
  })
})

afterAll(() => {
  nodeChild?.kill()
  for (const s of bunServers) s.stop(true)
})

test.skipIf(!LONG)(
  "FX-4 S2: silent responses at 330 s and 545 s reach the bridge's fetch (real time)",
  async () => {
    const node = `http://127.0.0.1:${nodeInfo.port}`
    const bunDefault = bunServer(undefined)
    const bunIdle0 = bunServer(0)
    const cases: Promise<Outcome>[] = []
    for (const d of DELAYS) {
      // Production pair: node:http host <- bridge fetch, with the bridge's own options (BRIDGE_FETCH_OPTIONS).
      cases.push(call("node-host/plain <- bridge fetch (BRIDGE_FETCH_OPTIONS)", `${node}/plain/${d}`, d, BRIDGE_FETCH_OPTIONS))
      cases.push(call("node-host/sse <- bridge fetch (BRIDGE_FETCH_OPTIONS)", `${node}/sse/${d}`, d, BRIDGE_FETCH_OPTIONS))
      // Bun fetch with no extra option (the bridge before FX-4).
      cases.push(call("node-host/plain <- bun fetch default", `${node}/plain/${d}`, d, {}))
      cases.push(call("node-host/sse <- bun fetch default", `${node}/sse/${d}`, d, {}))
      // Bun.serve server side (default idleTimeout, and idleTimeout 0 = disabled).
      cases.push(call("bun.serve default idle/sse <- bun fetch timeout:false", `${bunDefault.url}sse/${d}`, d, { timeout: false }))
      cases.push(call("bun.serve default idle/plain <- bun fetch timeout:false", `${bunDefault.url}plain/${d}`, d, { timeout: false }))
      cases.push(call("bun.serve idleTimeout 0/plain <- bun fetch timeout:false", `${bunIdle0.url}plain/${d}`, d, { timeout: false }))
      cases.push(call("bun.serve idleTimeout 0/sse <- bun fetch timeout:false", `${bunIdle0.url}sse/${d}`, d, { timeout: false }))
    }
    const results = await Promise.all(cases)
    console.log(JSON.stringify({ bun: Bun.version, nodeServer: nodeInfo, results }, null, 1))
    // The binding assertion: the production pair carries a silent answer past every probed delay.
    for (const r of results.filter((x) => x.case.includes("BRIDGE_FETCH_OPTIONS"))) expect(r).toMatchObject({ ok: true })
  },
  900_000,
)
