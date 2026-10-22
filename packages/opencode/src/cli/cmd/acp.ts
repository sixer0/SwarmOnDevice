import { Effect } from "effect"
import { effectCmd, fail } from "../effect-cmd"
import { AgentSideConnection, ndJsonStream } from "@agentclientprotocol/sdk"
import { ServerAuth } from "@/server/auth"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { withNetworkOptions, resolveNetworkOptions, serverPasswordSet } from "../network"
import { ACPProfile } from "@/acp/profile"

export const AcpCommand = effectCmd({
  command: "acp",
  describe: "start ACP (Agent Client Protocol) server",
  builder: (yargs) => {
    return withNetworkOptions(yargs).option("cwd", {
      describe: "working directory",
      type: "string",
      default: process.cwd(),
    })
  },
  handler: Effect.fn("Cli.acp")(function* (args) {
    const { Server } = yield* Effect.promise(() => import("@/server/server"))
    const { ACP } = yield* Effect.promise(() => import("@/acp/agent"))
    ACPProfile.mark("cli.acp.handler")
    process.env.OPENCODE_CLIENT = "acp"
    // `acp` starts the same Server.listen listener as `serve`/`web`, so it opens the same local PTY
    // websocket shell door (research/03e C7-4). Without this guard an `acp` process brought up with no
    // password bound loopback and answered GET /global/setup and /global/health anonymously with 200
    // (row 201 measured it; row 194 §1 residual / row 207 claim C-207-c). serverPasswordSet() treats an
    // empty value as unset, so this also refuses the c4 fail-open class on the acp path. The ACP agent
    // talks to its own listener through ServerAuth.headers() below, which carries the credential once a
    // password is set, so requiring one here does not break the internal client — only anonymous
    // third-party reads of the port.
    if (!serverPasswordSet())
      return yield* fail(
        "No server password is set; refusing to start an unsecured server. Set SWARM_SERVER_PASSWORD or OPENCODE_SERVER_PASSWORD to a non-empty value and run acp again.",
      )
    const opts = yield* resolveNetworkOptions(args)
    const server = yield* Effect.promise(() => ACPProfile.measure("cli.acp.server.listen", () => Server.listen(opts)))

    const sdk = createOpencodeClient({
      baseUrl: `http://${server.hostname}:${server.port}`,
      headers: ServerAuth.headers(),
    })

    const input = new WritableStream<Uint8Array>({
      write(chunk) {
        return new Promise<void>((resolve, reject) => {
          process.stdout.write(chunk, (err) => {
            if (err) {
              reject(err)
            } else {
              resolve()
            }
          })
        })
      },
    })
    const output = new ReadableStream<Uint8Array>({
      start(controller) {
        process.stdin.on("data", (chunk: Buffer) => {
          controller.enqueue(new Uint8Array(chunk))
        })
        process.stdin.on("end", () => controller.close())
        process.stdin.on("error", (err) => controller.error(err))
      },
    })

    const stream = ndJsonStream(input, output)
    const agent = ACP.init({ sdk })

    new AgentSideConnection((conn) => {
      ACPProfile.mark("cli.acp.connection.create")
      return agent.create(conn)
    }, stream)

    yield* Effect.logInfo("setup connection")
    process.stdin.resume()
    yield* Effect.promise(
      () =>
        new Promise<void>((resolve, reject) => {
          process.stdin.on("end", () => resolve())
          process.stdin.on("error", reject)
        }),
    )
  }),
})
