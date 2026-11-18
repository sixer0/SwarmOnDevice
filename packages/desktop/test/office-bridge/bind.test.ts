// Row 47 (M2-01) L2 bind tests for the bridge core (TR-5) on the test port 47317 (register §10, TS-RC-1). They bind
// real loopback sockets, so they run only with SWARM_OFFICE_IT=1 (and outside the command sandbox) under
// `lock:l2-ports`. Covers I-BR-15 (both-or-none, PORT_IN_USE, no IPv4 listener left), SC-32 (TLS 1.2 minimum, no HSTS),
// SC-36 (literal addresses only) and stop() ending an open stream.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises"
import https from "node:https"
import net from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { BridgeHandle, BridgeStartConfig, LeafTls } from "../../src/main/office-bridge/protocol"
import { createOfficeBridgeFactory, startOfficeBridge, type BridgeListener } from "../../src/main/office-bridge/server"
import { throwawayLeaf } from "./tls-fixture"

const PORT = 47317
const enabled = process.env.SWARM_OFFICE_IT === "1"

let root: string
let leaf: LeafTls
let running: BridgeHandle | undefined
const squatters: net.Server[] = []

function config(): BridgeStartConfig {
  return {
    serverUrl: "http://127.0.0.1:55317",
    username: "opencode",
    password: "synthetic-test-password",
    userDataDir: join(root, "userData"),
    resourcesDir: join(root, "resources"),
    port: PORT,
    cert: leaf.cert,
    key: leaf.key,
  }
}

const deps = { pairRequests: () => {}, pairDecisions: { subscribe: () => () => {} } }

function squat(host: string) {
  return new Promise<net.Server>((resolve, reject) => {
    const server = net.createServer()
    server.once("error", reject)
    server.listen({ host, port: PORT, ipv6Only: host === "::1", exclusive: true }, () => {
      squatters.push(server)
      resolve(server)
    })
  })
}

/** Resolves "open" when something accepts on host:PORT, else the error code (ECONNREFUSED when nothing listens). */
function probe(host: string) {
  return new Promise<string>((resolve) => {
    const socket = net.connect({ host, port: PORT })
    socket.once("connect", () => {
      socket.destroy()
      resolve("open")
    })
    socket.once("error", (error: NodeJS.ErrnoException) => resolve(error.code ?? "error"))
  })
}

function insecureFetch(url: string, init: RequestInit = {}) {
  // Self-signed throwaway leaf; this test checks binding and headers, not the trust chain (that is M3).
  return fetch(url, { ...init, tls: { rejectUnauthorized: false } } as RequestInit)
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "swo-it-"))
  await mkdir(join(root, "userData"), { recursive: true })
  leaf = await throwawayLeaf()
})

afterEach(async () => {
  await running?.stop()
  running = undefined
  await Promise.all(squatters.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))))
  await rm(root, { recursive: true, force: true })
})

describe.skipIf(!enabled)("office bridge bind (SWARM_OFFICE_IT=1, port 47317)", () => {
  test("binds both literals; each answers over HTTPS with the default 404 and no HSTS", async () => {
    const result = await startOfficeBridge(config(), deps)
    if (!result.ok) throw new Error(`start failed: ${result.code}`)
    running = result.bridge
    for (const url of [`https://127.0.0.1:${PORT}/`, `https://[::1]:${PORT}/`]) {
      const response = await insecureFetch(url)
      expect(response.status).toBe(404)
      expect(await response.json()).toEqual({ error: "ROUTE_NOT_ALLOWED" })
      expect(response.headers.get("strict-transport-security")).toBeNull()
    }
    expect((await stat(join(root, "userData", "office-addin", "workspace"))).mode & 0o777).toBe(0o700)
  })

  test("squat ::1 only: PORT_IN_USE and no IPv4 listener left (I-BR-15, SC-37)", async () => {
    await squat("::1")
    expect(await startOfficeBridge(config(), deps)).toEqual({ ok: false, code: "PORT_IN_USE" })
    expect(await probe("127.0.0.1")).toBe("ECONNREFUSED")
    // The IPv4 port is genuinely free again: a fresh bind succeeds.
    await squat("127.0.0.1")
  })

  test("squat 127.0.0.1 only: PORT_IN_USE and nothing new on ::1", async () => {
    await squat("127.0.0.1")
    expect(await startOfficeBridge(config(), deps)).toEqual({ ok: false, code: "PORT_IN_USE" })
    expect(await probe("::1")).toBe("ECONNREFUSED")
  })

  test("TLS 1.1 is refused, TLS 1.2 accepted (SC-32)", async () => {
    // Bun's own tls client ignores maxVersion, so the handshake is driven by curl (present on macOS).
    const curl = Bun.which("curl")
    if (!curl) throw new Error("curl not found; SC-32 bind check needs it")
    const result = await startOfficeBridge(config(), deps)
    if (!result.ok) throw new Error(`start failed: ${result.code}`)
    running = result.bridge
    const run = async (args: string[]) => {
      const child = Bun.spawn([curl, "-sk", "-o", "/dev/null", "-w", "%{http_code}", ...args], { stdout: "pipe", stderr: "ignore" })
      const out = await new Response(child.stdout).text()
      return { exit: await child.exited, out }
    }
    const old = await run(["--tlsv1.0", "--tls-max", "1.1", `https://127.0.0.1:${PORT}/`])
    expect(old.exit).not.toBe(0)
    const v12 = await run(["--tlsv1.2", "--tls-max", "1.2", `https://127.0.0.1:${PORT}/`])
    expect(v12).toEqual({ exit: 0, out: "404" })
  })

  test("stop() ends an open stream and frees both addresses", async () => {
    let opened: () => void = () => {}
    const streamOpen = new Promise<void>((resolve) => (opened = resolve))
    const factory = createOfficeBridgeFactory({
      routes: () => ({
        handle: (_request, response) => {
          response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" })
          response.write("data: hello\n\n")
          opened()
        },
      }),
    })
    const result = await factory(config(), deps)
    if (!result.ok) throw new Error(`start failed: ${result.code}`)
    running = result.bridge
    const response = await insecureFetch(`https://[::1]:${PORT}/stream`)
    const reader = response.body!.getReader()
    await streamOpen
    const first = await reader.read()
    expect(new TextDecoder().decode(first.value)).toContain("hello")
    await Promise.race([
      result.bridge.stop(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("stop() hung")), 5000)),
    ])
    running = undefined
    const end = await reader.read().then(
      (chunk) => (chunk.done ? "done" : "data"),
      () => "errored",
    )
    expect(["done", "errored"]).toContain(end)
    expect(await probe("127.0.0.1")).toBe("ECONNREFUSED")
    expect(await probe("::1")).toBe("ECONNREFUSED")
  })
  test("M2-01a F-M2-2: squat ::1 with a client connected to 127.0.0.1 between the binds -> PORT_IN_USE promptly", async () => {
    await squat("::1")
    const clients: net.Socket[] = []
    let index = 0
    const factory = createOfficeBridgeFactory({
      createListener: (options, handler) => {
        const server = https.createServer(options, handler)
        if (index++ === 0) return server
        // The ::1 listener: before it binds (and fails), hold an idle TCP connection open on the IPv4 listener.
        const listen = server.listen.bind(server)
        return Object.assign(server, {
          listen: (opts: net.ListenOptions, callback: () => void) => {
            const client = net.connect({ host: "127.0.0.1", port: PORT })
            clients.push(client)
            client.once("connect", () => listen(opts, callback))
            client.once("error", () => listen(opts, callback))
            return server
          },
        }) as BridgeListener
      },
    })
    const started = Date.now()
    const result = await Promise.race([
      factory(config(), deps),
      new Promise((resolve) => setTimeout(() => resolve("hung"), 3000)),
    ])
    expect(result).toEqual({ ok: false, code: "PORT_IN_USE" })
    expect(Date.now() - started).toBeLessThan(3000)
    expect(clients.length).toBe(1)
    clients.forEach((c) => c.destroy())
    expect(await probe("127.0.0.1")).toBe("ECONNREFUSED")
  })
})
