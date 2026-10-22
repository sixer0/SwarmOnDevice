import { Server } from "@/server/server"
import { InstanceRuntime } from "@/project/instance-runtime"
import { Rpc } from "@/util/rpc"
import { upgrade } from "@/cli/upgrade"
import { Config } from "@/config/config"
import { GlobalBus } from "@/bus/global"
import { ServerAuth } from "@/server/auth"
import { serverPasswordSet } from "@/cli/network"
import { writeHeapSnapshot } from "node:v8"
import { Heap } from "@/cli/heap"
import { AppRuntime } from "@/effect/app-runtime"
import { Effect } from "effect"
import { disposeAllInstancesAndEmitGlobalDisposed } from "@/server/global-lifecycle"

Heap.start()

const onUnhandledRejection = (_error: unknown) => {}

const onUncaughtException = (_error: Error) => {}

process.on("unhandledRejection", onUnhandledRejection)
process.on("uncaughtException", onUncaughtException)

// Subscribe to global events and forward them via RPC
GlobalBus.on("event", (event) => {
  Rpc.emit("global.event", event)
})

let server: Awaited<ReturnType<typeof Server.listen>> | undefined

export const rpc = {
  async fetch(input: { url: string; method: string; headers: Record<string, string>; body?: string }) {
    const headers = { ...input.headers }
    const auth = ServerAuth.header()
    if (auth && !headers["authorization"] && !headers["Authorization"]) {
      headers["Authorization"] = auth
    }
    const request = new Request(input.url, {
      method: input.method,
      headers,
      body: input.body,
    })
    const response = await Server.Default().app.fetch(request)
    const body = await response.text()
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body,
    }
  },
  snapshot() {
    const result = writeHeapSnapshot("server.heapsnapshot")
    return result
  },
  async server(input: { port: number; hostname: string; mdns?: boolean; cors?: string[] }) {
    // F-207-1 (row 207b): this was the only Server.listen call site without the refusal its
    // siblings carry (cmd/serve.ts:18, cmd/web.ts:42, cmd/acp.ts:32); row 207 measured it
    // answering GET /global/setup anonymously with 200 when no password was set, or with
    // OPENCODE_SERVER_PASSWORD="" (arms A/D). serverPasswordSet() decides from process.env at
    // call time — empty counts as unset, SWARM_* wins precedence (cli/network.ts:49-52). The
    // default TUI never reaches this method: tui.ts:273 only calls rpc.server() in external
    // mode (--port/--hostname/--mdns), and serves over rpc.fetch otherwise, binding no socket.
    // The refusal answers nothing rather than rejecting: util/rpc.ts has no error channel, so
    // a rejected worker message reaches the parent as an unhandled worker exception (fatal
    // under bun test, measured exit 133). Arms A/D therefore leave the parent's rpc "server"
    // call pending after this stderr line, and the unsecured listener simply never binds.
    if (!serverPasswordSet()) {
      console.error(
        "No server password is set; refusing to start an unsecured server. Set SWARM_SERVER_PASSWORD or OPENCODE_SERVER_PASSWORD to a non-empty value.",
      )
      await new Promise<never>(() => {})
    }
    if (server) await server.stop(true)
    server = await Server.listen(input)
    return { url: server.url.toString() }
  },
  async checkUpgrade(input: { directory: string }) {
    await InstanceRuntime.load({ directory: input.directory })
    return upgrade().catch(() => undefined)
  },
  async reload() {
    await AppRuntime.runPromise(
      Effect.gen(function* () {
        const cfg = yield* Config.Service
        yield* cfg.invalidate()
        yield* disposeAllInstancesAndEmitGlobalDisposed({ swallowErrors: true })
      }),
    )
  },
  async shutdown() {
    await InstanceRuntime.disposeAllInstances()
    if (server) await server.stop(true)
    process.off("unhandledRejection", onUnhandledRejection)
    process.off("uncaughtException", onUncaughtException)
  },
}

Rpc.listen(rpc)
