import * as http from "node:http"
import * as tls from "node:tls"
import { BUNDLED_PROVIDER_ENV } from "./bundled-provider"
import { listenWithNonce, parseSidecarCommand, type StartCommand } from "./sidecar-start"

type NodeHttpWithEnvProxy = typeof http & {
  setGlobalProxyFromEnv: () => void
}

type NodeTlsWithSystemCertificates = typeof tls & {
  getCACertificates: (type: "default" | "system") => string[]
  setDefaultCACertificates: (certificates: string[]) => void
}

type SidecarMessage =
  | { type: "ready" }
  | { type: "stopped" }
  | { type: "error"; error: { message: string; stack?: string } }

type ParentPort = {
  postMessage(message: SidecarMessage): void
  on(event: "message", listener: (event: { data: unknown }) => void): void
}

type Listener = {
  stop(close?: boolean): void | Promise<void>
}

const parentPort = getParentPort()
let listener: Listener | undefined
let runLease: { handOver: () => number } | undefined

parentPort.on("message", (event) => {
  const command = parseSidecarCommand(event.data)
  if (!command) return
  if (command.type === "stop") {
    if (command.resume) handOver()
    else void stop()
    return
  }
  void start(command)
})

async function start(command: StartCommand) {
  try {
    prepareSidecarEnv(command.password, command.userDataPath)
    ensureLoopbackNoProxy()
    useSystemCertificates()
    useEnvProxy()
    // Row 38b (SEC-06): DesktopNonce.set with the start message's nonce runs before Server.listen (sidecar-start.ts).
    listener = await listenWithNonce(command, await import("virtual:opencode-server"))
    // 1.3.4 (T-12): the same (cached) module instance; its RunLease holds this process's leases for a hand-over.
    runLease = (await import("virtual:opencode-server")).RunLease
    parentPort.postMessage({ type: "ready" })
  } catch (error) {
    parentPort.postMessage({ type: "error", error: serializeError(error) })
    setImmediate(() => process.exit(1))
  }
}

async function stop() {
  try {
    await listener?.stop()
  } finally {
    listener = undefined
    parentPort.postMessage({ type: "stopped" })
    setImmediate(() => process.exit(0))
  }
}

// 1.3.4 (T-12): a restart that keeps the work going. The running turns are not stopped: their leases stay in place and
// this process exits with a code that does not mean "stop" (75, EX_TEMPFAIL), so the relaunched server continues them
// through the crash-recovery path (SessionResume), each open tool call marked as interrupted for the model to check.
function handOver() {
  let runs = 0
  try {
    runs = runLease?.handOver() ?? 0
  } finally {
    console.log(`sidecar hand-over for restart: ${runs} running turn(s) left to resume`)
    listener = undefined
    parentPort.postMessage({ type: "stopped" })
    setImmediate(() => process.exit(75))
  }
}

function prepareSidecarEnv(password: string, userDataPath: string) {
  Object.assign(process.env, {
    OPENCODE_SERVER_USERNAME: "opencode",
    OPENCODE_SERVER_PASSWORD: password,
    XDG_STATE_HOME: process.env.XDG_STATE_HOME ?? userDataPath,
    ...BUNDLED_PROVIDER_ENV,
  })
}

function ensureLoopbackNoProxy() {
  const loopback = ["127.0.0.1", "localhost", "::1"]
  const upsert = (key: string) => {
    const items = (process.env[key] ?? "")
      .split(",")
      .map((value: string) => value.trim())
      .filter((value: string) => Boolean(value))

    for (const host of loopback) {
      if (items.some((value: string) => value.toLowerCase() === host)) continue
      items.push(host)
    }

    process.env[key] = items.join(",")
  }

  upsert("NO_PROXY")
  upsert("no_proxy")
}

function useSystemCertificates() {
  try {
    const nodeTls = tls as NodeTlsWithSystemCertificates
    nodeTls.setDefaultCACertificates([
      ...new Set([...nodeTls.getCACertificates("default"), ...nodeTls.getCACertificates("system")]),
    ])
  } catch (error) {
    console.warn("failed to load system certificates", error)
  }
}

function useEnvProxy() {
  try {
    ;(http as NodeHttpWithEnvProxy).setGlobalProxyFromEnv()
  } catch (error) {
    console.warn("failed to load proxy environment", error)
  }
}

function serializeError(error: unknown) {
  if (error instanceof Error) return { message: error.message, stack: error.stack }
  return { message: String(error) }
}

function getParentPort() {
  const port = process.parentPort as ParentPort | undefined
  if (!port) throw new Error("Sidecar parent port unavailable")
  return port
}
