import { describe, expect, test } from "bun:test"
import { runOfficeBridge, type OfficeBridgeParentPort } from "./office-bridge"
import type {
  BridgeCoreDeps,
  BridgeFactory,
  BridgeLogLevel,
  BridgeMessage,
  BridgeStartConfig,
  BridgeStartResult,
  LeafTls,
  PairDecision,
} from "./office-bridge/protocol"

const SECRET = "synthetic-password-never-logged"

const config: BridgeStartConfig = {
  serverUrl: "http://127.0.0.1:4096",
  username: "opencode",
  password: SECRET,
  userDataDir: "/nonexistent/user-data",
  resourcesDir: "/nonexistent/resources",
  port: 47317,
  cert: "CERT",
  key: "KEY",
}

function fakePort() {
  const posted: BridgeMessage[] = []
  const listeners: Array<(event: { data: unknown }) => void> = []
  const port: OfficeBridgeParentPort = {
    postMessage: (message) => posted.push(message),
    on: (_event, listener) => listeners.push(listener),
  }
  const send = (data: unknown) => {
    for (const listener of listeners) listener({ data })
  }
  return { port, posted, send }
}

function fakeCore(result: "ok" | BridgeStartResult | "throw") {
  const calls = { tls: [] as LeafTls[], cleared: 0, stopped: 0, deps: undefined as BridgeCoreDeps | undefined }
  const factory: BridgeFactory = async (_config, deps) => {
    calls.deps = deps
    if (result === "throw") throw new Error("boom")
    if (result !== "ok") return result
    return {
      ok: true,
      bridge: {
        port: _config.port,
        updateTls: (tls) => {
          if (tls.cert === "BAD") throw new Error("bad leaf")
          calls.tls.push(tls)
        },
        pairingsCleared: () => {
          calls.cleared++
        },
        stop: async () => {
          calls.stopped++
        },
      },
    }
  }
  return { factory, calls }
}

function collectLog() {
  const lines: Array<{ level: BridgeLogLevel; source: string; message: string; context?: Record<string, unknown> }> = []
  return { lines, log: (level: BridgeLogLevel, source: string, message: string, context?: Record<string, unknown>) => lines.push({ level, source, message, context }) }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 10))

describe("office-bridge entry runner (M2-03)", () => {
  test("start posts ready with the bound port; commands reach the handle; stop ends it", async () => {
    const { port, posted, send } = fakePort()
    const core = fakeCore("ok")
    const logs = collectLog()
    let stopped = 0
    runOfficeBridge(port, { factory: core.factory, log: logs.log, onStopped: () => stopped++ })

    send({ type: "start", ...config })
    await flush()
    expect(posted).toEqual([{ type: "ready", port: 47317 }])

    send({ type: "tls-update", cert: "C2", key: "K2" })
    send({ type: "pairings-cleared" })
    expect(core.calls.tls).toEqual([{ cert: "C2", key: "K2" }])
    expect(core.calls.cleared).toBe(1)

    send({ type: "stop" })
    await flush()
    expect(core.calls.stopped).toBe(1)
    expect(stopped).toBe(1)
    expect(JSON.stringify(logs.lines)).not.toContain(SECRET)
  })

  test("a start failure result is posted as failed with its code", async () => {
    const { port, posted, send } = fakePort()
    const core = fakeCore({ ok: false, code: "PORT_IN_USE" })
    runOfficeBridge(port, { factory: core.factory, log: collectLog().log })
    send({ type: "start", ...config })
    await flush()
    expect(posted).toEqual([{ type: "failed", code: "PORT_IN_USE" }])
  })

  test("a throwing core calls onFatal and posts nothing", async () => {
    const { port, posted, send } = fakePort()
    let fatal = 0
    runOfficeBridge(port, { factory: fakeCore("throw").factory, log: collectLog().log, onFatal: () => fatal++ })
    send({ type: "start", ...config })
    await flush()
    expect(posted).toEqual([])
    expect(fatal).toBe(1)
  })

  test("pair requests are posted and pair decisions reach subscribers", async () => {
    const { port, posted, send } = fakePort()
    const core = fakeCore("ok")
    runOfficeBridge(port, { factory: core.factory, log: collectLog().log })
    send({ type: "start", ...config })
    await flush()
    const seen: PairDecision[] = []
    core.calls.deps?.pairDecisions.subscribe((decision) => seen.push(decision))
    const requestId = "AAAAAAAAAAAAAAAAAAAAAA"
    core.calls.deps?.pairRequests({ requestId, host: "Word", code: "1234" })
    send({ type: "pair-decision", requestId, allow: true })
    expect(posted[1]).toEqual({ type: "pair-request", requestId, host: "Word", code: "1234" })
    expect(seen).toEqual([{ requestId, allow: true }])
  })

  test("invalid commands are dropped without logging their payload; a bad leaf is rejected", async () => {
    const { port, posted, send } = fakePort()
    const core = fakeCore("ok")
    const logs = collectLog()
    runOfficeBridge(port, { factory: core.factory, log: logs.log })
    send({ type: "start", ...config, port: 0 })
    send({ type: "tls-update", cert: "C", key: "K" })
    await flush()
    expect(posted).toEqual([])
    expect(core.calls.tls).toEqual([])

    send({ type: "start", ...config })
    await flush()
    send({ type: "tls-update", cert: "BAD", key: "K" })
    send({ type: "start", ...config })
    expect(core.calls.tls).toEqual([])
    expect(logs.lines.map((l) => l.message)).toContain("tls update rejected")
    expect(logs.lines.map((l) => l.message)).toContain("start ignored")
    expect(JSON.stringify(logs.lines)).not.toContain(SECRET)
  })

  test("stop during start stops the bridge without posting ready", async () => {
    const { port, posted, send } = fakePort()
    const core = fakeCore("ok")
    let stopped = 0
    runOfficeBridge(port, { factory: core.factory, log: collectLog().log, onStopped: () => stopped++ })
    send({ type: "start", ...config })
    send({ type: "stop" })
    await flush()
    expect(posted).toEqual([])
    expect(core.calls.stopped).toBe(1)
    expect(stopped).toBe(1)
  })
})
