import { Effect } from "effect"
import { effectCmd, fail } from "../effect-cmd"
import { RunLease } from "@/session/run-lease"
import { withNetworkOptions, resolveNetworkOptions, serverPasswordSet } from "../network"

export const ServeCommand = effectCmd({
  command: "serve",
  builder: (yargs) => withNetworkOptions(yargs),
  describe: "starts a headless swarm server",
  // Server loads instances per-request via x-opencode-directory header — no
  // need for an ambient project InstanceContext at startup.
  instance: false,
  handler: Effect.fn("Cli.serve")(function* (args) {
    const { Server } = yield* Effect.promise(() => import("../../server/server"))
    // Swarm refuses the unsecured server (research/03e C7-4): the local PTY websocket is a shell
    // door, so an unprotected listener must never come up. serverPasswordSet() resolves both public
    // names at handler time, which keeps this guard equal to what the auth layer will actually see
    // even in the compiled binary where the defaults shim runs after flag.ts (see network.ts).
    if (!serverPasswordSet())
      return yield* fail(
        "No server password is set; refusing to start an unsecured server. Set SWARM_SERVER_PASSWORD or OPENCODE_SERVER_PASSWORD to a non-empty value and run serve again.",
      )
    const opts = yield* resolveNetworkOptions(args)
    // Server.listen forwards its options to the CORS config, so the bound address and the mDNS
    // name are the Host values this listener will answer for (loopback needs no entry: cors.ts
    // accepts it unconditionally).
    RunLease.host()
    const server = yield* Effect.promise(() =>
      Server.listen({ ...opts, hosts: [opts.hostname, ...(opts.mdns ? [opts.mdnsDomain] : [])] }),
    )
    // Register J01 emitter, byte-paired with the parsers at packages/sdk/js/src/server.ts:56 and
    // packages/sdk/js/src/v2/server.ts:56 (landed by row 43) and with the brand-agnostic test regex
    // at packages/opencode/test/lib/cli-process.ts:349. Changing one side without the other breaks
    // every SDK caller that boots a local server (X-10).
    console.log(`swarm server listening on http://${server.hostname}:${server.port}`)

    yield* Effect.never
  }),
})
