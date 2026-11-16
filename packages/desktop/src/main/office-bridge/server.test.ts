// Row 47 (M2-01) unit tests for the bridge core factory. No socket is bound here: listeners are injected doubles that
// record what the core asks of them. Real binds (both-or-none on 47317) are in test/office-bridge/bind.test.ts.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { chmod, mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ServerOptions } from "node:https"
import { throwawayLeaf } from "../../../test/office-bridge/tls-fixture"
import type { BridgeCoreDeps, BridgeLogLevel, BridgeStartConfig, LeafTls } from "./protocol"
import {
  bridgeExpectations,
  bridgeTlsOptions,
  createOfficeBridgeFactory,
  prepareBridgeDataDir,
  type BridgeListener,
  type BridgeRequestHandler,
  type BridgeRoutes,
} from "./server"

type ListenCall = { host: string; port: number; ipv6Only: boolean; exclusive: boolean }

class FakeListener extends EventEmitter {
  listenCalls: ListenCall[] = []
  closed = 0
  contexts: unknown[] = []
  constructor(
    readonly options: ServerOptions,
    readonly handler: BridgeRequestHandler,
    readonly failWith: string | undefined,
  ) {
    super()
  }
  listen(options: ListenCall, callback: () => void) {
    this.listenCalls.push(options)
    queueMicrotask(() => {
      if (this.failWith) return void this.emit("error", Object.assign(new Error(this.failWith), { code: this.failWith }))
      callback()
    })
    return this
  }
  close(callback: () => void) {
    this.closed++
    queueMicrotask(callback)
    return this
  }
  address() {
    return null
  }
  setSecureContext(options: unknown) {
    this.contexts.push(options)
  }
}

let root: string
let leaf: LeafTls

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "swo-m201-"))
  leaf = await throwawayLeaf()
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function config(overrides: Partial<BridgeStartConfig> = {}): BridgeStartConfig {
  return {
    serverUrl: "http://127.0.0.1:55317",
    username: "opencode",
    password: "synthetic-test-password",
    userDataDir: join(root, "userData"),
    resourcesDir: join(root, "resources"),
    port: 47317,
    cert: leaf.cert,
    key: leaf.key,
    ...overrides,
  }
}

function deps(logs: { level: BridgeLogLevel; message: string; context?: Record<string, unknown> }[] = []) {
  const value: BridgeCoreDeps = {
    pairRequests: () => {},
    pairDecisions: { subscribe: () => () => {} },
    log: (level, _source, message, context) => void logs.push({ level, message, context }),
  }
  return value
}

function harness(fail: Partial<Record<string, string>> = {}, routes: Partial<BridgeRoutes> = {}) {
  const made: FakeListener[] = []
  const calls = { stop: 0, cleared: 0 }
  let index = 0
  const hosts = ["127.0.0.1", "::1"]
  const factory = createOfficeBridgeFactory({
    createListener: (options, handler) => {
      const listener = new FakeListener(options, handler, fail[hosts[index++]!])
      made.push(listener)
      return listener as unknown as BridgeListener
    },
    routes: () => ({
      handle: routes.handle ?? ((_req, res) => void res.end()),
      pairingsCleared: () => void calls.cleared++,
      stop: () => void calls.stop++,
    }),
  })
  return { factory, made, calls }
}

async function userData() {
  const dir = join(root, "userData")
  await mkdir(dir, { recursive: true })
  return dir
}

describe("bridgeExpectations (TS-RC-1)", () => {
  test("Host and Origin values derive from the port; [::1] is never accepted", () => {
    expect(bridgeExpectations(47317)).toEqual({
      port: 47317,
      hosts: ["localhost:47317", "127.0.0.1:47317"],
      origin: "https://localhost:47317",
    })
    expect(bridgeExpectations(46317).hosts).toEqual(["localhost:46317", "127.0.0.1:46317"])
    expect(bridgeExpectations(46317).hosts.some((h) => h.startsWith("["))).toBe(false)
  })

  test("an out-of-range port is a programming error", () => {
    expect(() => bridgeExpectations(0)).toThrow(RangeError)
    expect(() => bridgeExpectations(70000)).toThrow(RangeError)
  })
})

describe("bridgeTlsOptions (SC-32)", () => {
  test("TLS 1.2 minimum and nothing else besides the leaf", () => {
    expect(bridgeTlsOptions(leaf)).toEqual({ cert: leaf.cert, key: leaf.key, minVersion: "TLSv1.2" })
  })
})

describe("prepareBridgeDataDir (SC-12, C25)", () => {
  test("creates office-addin/ and workspace/ with mode 0700", async () => {
    const dir = await userData()
    const result = await prepareBridgeDataDir(dir)
    expect(result.ok).toBe(true)
    expect((await stat(join(dir, "office-addin"))).mode & 0o777).toBe(0o700)
    expect((await stat(join(dir, "office-addin", "workspace"))).mode & 0o777).toBe(0o700)
  })

  test("keeps an existing 0700 tree and its files", async () => {
    const dir = await userData()
    await mkdir(join(dir, "office-addin", "workspace"), { recursive: true, mode: 0o700 })
    await chmod(join(dir, "office-addin"), 0o700)
    await writeFile(join(dir, "office-addin", "workspace", "keep.txt"), "x")
    await writeFile(join(dir, "office-addin", "pairings.json"), "{}", { mode: 0o600 })
    expect((await prepareBridgeDataDir(dir)).ok).toBe(true)
    expect((await stat(join(dir, "office-addin", "workspace", "keep.txt"))).isFile()).toBe(true)
  })

  test("a pre-existing 0755 office-addin/ is refused, not repaired (U-PS-03 second half)", async () => {
    const dir = await userData()
    await mkdir(join(dir, "office-addin"), { mode: 0o755 })
    await chmod(join(dir, "office-addin"), 0o755)
    expect(await prepareBridgeDataDir(dir)).toEqual({ ok: false, code: "DATA_DIR_UNSAFE", entry: ".", mode: 0o755 })
    expect((await stat(join(dir, "office-addin"))).mode & 0o777).toBe(0o755)
  })

  for (const sub of ["ca", "tls", "workspace"]) {
    test(`a group-readable ${sub}/ is refused`, async () => {
      const dir = await userData()
      await mkdir(join(dir, "office-addin", sub), { recursive: true, mode: 0o700 })
      await chmod(join(dir, "office-addin"), 0o700)
      await chmod(join(dir, "office-addin", sub), 0o750)
      const result = await prepareBridgeDataDir(dir)
      expect(result).toEqual({ ok: false, code: "DATA_DIR_UNSAFE", entry: sub, mode: 0o750 })
    })
  }

  for (const file of ["pairings.json", "tls/localhost.key.pem", "ca/swarm-office-ca.key.enc"]) {
    test(`a 0644 ${file} is refused`, async () => {
      const dir = await userData()
      const base = join(dir, "office-addin")
      for (const sub of ["", "ca", "tls"]) await mkdir(join(base, sub), { recursive: true, mode: 0o700 })
      for (const sub of ["", "ca", "tls"]) await chmod(join(base, sub), 0o700)
      await writeFile(join(base, file), "secret", { mode: 0o600 })
      await chmod(join(base, file), 0o644)
      const result = await prepareBridgeDataDir(dir)
      expect(result).toEqual({ ok: false, code: "DATA_DIR_UNSAFE", entry: file, mode: 0o644 })
    })
  }

  test("a symlinked office-addin/ is refused even when the target is 0700", async () => {
    const dir = await userData()
    await mkdir(join(root, "elsewhere"), { mode: 0o700 })
    await chmod(join(root, "elsewhere"), 0o700)
    await symlink(join(root, "elsewhere"), join(dir, "office-addin"))
    const result = await prepareBridgeDataDir(dir)
    expect(result.ok).toBe(false)
  })
})

describe("createOfficeBridgeFactory", () => {
  test("binds the literal 127.0.0.1 then ::1 (ipv6Only) on the configured port, one shared handler", async () => {
    await userData()
    const { factory, made } = harness()
    const result = await factory(config(), deps())
    expect(result.ok).toBe(true)
    expect(made.map((l) => l.listenCalls)).toEqual([
      [{ host: "127.0.0.1", port: 47317, ipv6Only: false, exclusive: true }],
      [{ host: "::1", port: 47317, ipv6Only: true, exclusive: true }],
    ])
    expect(made[0]!.handler).toBe(made[1]!.handler)
    for (const l of made) {
      expect(l.options.minVersion).toBe("TLSv1.2")
      expect(l.options.ALPNProtocols).toEqual(["http/1.1"])
      expect(l.options.cert).toBe(leaf.cert)
    }
    if (result.ok) expect(result.bridge.port).toBe(47317)
  })

  test("::1 busy: the IPv4 listener is closed and the result is PORT_IN_USE (SC-37)", async () => {
    await userData()
    const { factory, made, calls } = harness({ "::1": "EADDRINUSE" })
    expect(await factory(config(), deps())).toEqual({ ok: false, code: "PORT_IN_USE" })
    expect(made[0]!.closed).toBe(1)
    expect(calls.stop).toBe(1)
  })

  test("127.0.0.1 busy: ::1 is never bound", async () => {
    await userData()
    const { factory, made } = harness({ "127.0.0.1": "EADDRINUSE" })
    expect(await factory(config(), deps())).toEqual({ ok: false, code: "PORT_IN_USE" })
    expect(made[1]!.listenCalls).toEqual([])
  })

  for (const code of ["EADDRNOTAVAIL", "EACCES"]) {
    test(`${code} on ::1 is also PORT_IN_USE (IPv6 disabled is the accepted cost)`, async () => {
      await userData()
      const { factory } = harness({ "::1": code })
      expect(await factory(config(), deps())).toEqual({ ok: false, code: "PORT_IN_USE" })
    })
  }

  test("an unsafe data dir fails with DATA_DIR_UNSAFE before any listener exists; the log has no path", async () => {
    const dir = await userData()
    await mkdir(join(dir, "office-addin"), { mode: 0o755 })
    await chmod(join(dir, "office-addin"), 0o755)
    const logs: { level: BridgeLogLevel; message: string; context?: Record<string, unknown> }[] = []
    const { factory, made } = harness()
    expect(await factory(config(), deps(logs))).toEqual({ ok: false, code: "DATA_DIR_UNSAFE" })
    expect(made).toEqual([])
    expect(JSON.stringify(logs)).not.toContain(root)
  })

  test("an empty or unparsable leaf fails with CERT_MISSING", async () => {
    await userData()
    const { factory, made } = harness()
    expect(await factory(config({ cert: "" }), deps())).toEqual({ ok: false, code: "CERT_MISSING" })
    expect(await factory(config({ key: "not a key" }), deps())).toEqual({ ok: false, code: "CERT_MISSING" })
    expect(made).toEqual([])
  })

  test("updateTls swaps the same context on both listeners; a bad leaf throws and swaps neither", async () => {
    await userData()
    const { factory, made } = harness()
    const result = await factory(config(), deps())
    if (!result.ok) throw new Error("start failed")
    const next = await throwawayLeaf("renewed")
    result.bridge.updateTls(next)
    expect(made[0]!.contexts).toEqual([{ cert: next.cert, key: next.key, minVersion: "TLSv1.2" }])
    expect(made[1]!.contexts).toEqual(made[0]!.contexts)
    expect(() => result.bridge.updateTls({ cert: next.cert, key: "garbage" })).toThrow()
    expect(made[0]!.contexts.length).toBe(1)
    expect(made[1]!.contexts.length).toBe(1)
  })

  test("stop() runs routes.stop once, closes both listeners and destroys tracked sockets; idempotent", async () => {
    await userData()
    const { factory, made, calls } = harness()
    const result = await factory(config(), deps())
    if (!result.ok) throw new Error("start failed")
    const socket = Object.assign(new EventEmitter(), { destroyed: 0, destroy: () => void socket.destroyed++ })
    made[1]!.emit("connection", socket)
    const first = result.bridge.stop()
    const second = result.bridge.stop()
    expect(second).toBe(first)
    await first
    expect(calls.stop).toBe(1)
    expect(made.map((l) => l.closed)).toEqual([1, 1])
    expect(socket.destroyed).toBe(1)
    result.bridge.updateTls(await throwawayLeaf())
    expect(made[0]!.contexts).toEqual([])
  })

  test("pairingsCleared is forwarded to the routes", async () => {
    await userData()
    const { factory, calls } = harness()
    const result = await factory(config(), deps())
    if (!result.ok) throw new Error("start failed")
    result.bridge.pairingsCleared()
    expect(calls.cleared).toBe(1)
  })

  test("a throwing route answers 503 SWARM_UNAVAILABLE without HSTS and logs no password", async () => {
    await userData()
    const logs: { level: BridgeLogLevel; message: string; context?: Record<string, unknown> }[] = []
    const { factory, made } = harness(
      {},
      {
        handle: () => {
          throw new Error("synthetic-test-password")
        },
      },
    )
    const result = await factory(config(), deps(logs))
    expect(result.ok).toBe(true)
    const written: { status?: number; headers?: Record<string, unknown>; body?: string } = {}
    const response = {
      headersSent: false,
      writeHead(status: number, headers: Record<string, unknown>) {
        written.status = status
        written.headers = headers
      },
      end(body: string) {
        written.body = body
      },
      destroy() {},
    }
    await made[0]!.handler({ method: "GET" } as never, response as never)
    expect(written.status).toBe(503)
    expect(written.body).toBe('{"error":"SWARM_UNAVAILABLE"}')
    expect(Object.keys(written.headers ?? {}).map((k) => k.toLowerCase())).not.toContain("strict-transport-security")
    expect(JSON.stringify(logs)).not.toContain("synthetic-test-password")
  })
})
