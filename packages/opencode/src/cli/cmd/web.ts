import { RunLease } from "@/session/run-lease"
import { Effect } from "effect"
import { UI } from "../ui"
import { effectCmd, fail } from "../effect-cmd"
import { withNetworkOptions, resolveNetworkOptions, serverPasswordSet } from "../network"
import { openUrl } from "@opencode-ai/core/open"
import { networkInterfaces } from "os"

function getNetworkIPs() {
  const nets = networkInterfaces()
  const results: string[] = []

  for (const name of Object.keys(nets)) {
    const net = nets[name]
    if (!net) continue

    for (const netInfo of net) {
      // Skip internal and non-IPv4 addresses
      if (netInfo.internal || netInfo.family !== "IPv4") continue

      // Skip Docker bridge networks (typically 172.x.x.x)
      if (netInfo.address.startsWith("172.")) continue

      results.push(netInfo.address)
    }
  }

  return results
}

export const WebCommand = effectCmd({
  command: "web",
  builder: (yargs) => withNetworkOptions(yargs),
  describe: "start swarm server and open web interface",
  // Server loads instances per-request via x-opencode-directory header — no
  // ambient project InstanceContext needed at startup.
  instance: false,
  handler: Effect.fn("Cli.web")(function* (args) {
    const { Server } = yield* Effect.promise(() => import("../../server/server"))
    // Same refusal as `serve` (research/03e C7-4): `web` starts the identical listener and would
    // otherwise open an unauthenticated shell door plus a browser pointed at it. serverPasswordSet()
    // keeps the guard aligned with the auth layer in the compiled binary (see network.ts).
    if (!serverPasswordSet())
      return yield* fail(
        "No server password is set; refusing to start an unsecured server. Set SWARM_SERVER_PASSWORD or OPENCODE_SERVER_PASSWORD to a non-empty value and run web again.",
      )
    const opts = yield* resolveNetworkOptions(args)
    // Same Host allow-list wiring as `serve`: the bound address and the mDNS name are the Host
    // values this listener answers for; loopback needs no entry because cors.ts accepts it always.
    RunLease.host()
    const server = yield* Effect.promise(() =>
      Server.listen({ ...opts, hosts: [opts.hostname, ...(opts.mdns ? [opts.mdnsDomain] : [])] }),
    )
    UI.empty()
    UI.println(UI.logo("  "))
    UI.empty()

    if (opts.hostname === "0.0.0.0") {
      // Show localhost for local access
      const localhostUrl = `http://localhost:${server.port}`
      UI.println(UI.Style.TEXT_INFO_BOLD + "  Local access:      ", UI.Style.TEXT_NORMAL, localhostUrl)

      // Show network IPs for remote access
      const networkIPs = getNetworkIPs()
      if (networkIPs.length > 0) {
        for (const ip of networkIPs) {
          UI.println(
            UI.Style.TEXT_INFO_BOLD + "  Network access:    ",
            UI.Style.TEXT_NORMAL,
            `http://${ip}:${server.port}`,
          )
        }
      }

      if (opts.mdns) {
        UI.println(
          UI.Style.TEXT_INFO_BOLD + "  mDNS:              ",
          UI.Style.TEXT_NORMAL,
          `${opts.mdnsDomain}:${server.port}`,
        )
      }

      // Open localhost in browser
      openUrl(localhostUrl).catch(() => {})
    } else {
      const displayUrl = server.url.toString()
      UI.println(UI.Style.TEXT_INFO_BOLD + "  Web interface:    ", UI.Style.TEXT_NORMAL, displayUrl)
      openUrl(displayUrl).catch(() => {})
    }

    yield* Effect.never
  }),
})
