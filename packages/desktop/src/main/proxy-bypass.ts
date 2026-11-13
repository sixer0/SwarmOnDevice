// AC-R5 (1.2.8 row 51a): the app's own loopback traffic (its local server, the DATUM Studio host) never goes to a proxy.
//
// Chromium bypasses loopback implicitly for every proxy mode (fixed, PAC, system). The token `<-loopback>` in
// `--proxy-bypass-list` SUBTRACTS that implicit rule, so with a fixed `--proxy-server` every request to
// 127.0.0.1:<sidecar port> went to the proxy ("Could not reach Local Server", 311 requests in the 1.2.8 mid live check).
// This module keeps the implicit rule and lists the loopback hosts explicitly as well. Any bypass entries the person
// passed on the command line are kept, so non-loopback traffic is routed exactly as before.

/** Explicit loopback entries in Chromium ProxyBypassRules syntax (the same set as Chromium's implicit rule). */
export const LOOPBACK_PROXY_BYPASS = ["localhost", "*.localhost", "127.0.0.1/8", "[::1]"] as const

const SUBTRACT_IMPLICIT = "<-loopback>"

/** The bypass list to hand Chromium: the existing entries minus `<-loopback>`, plus every loopback entry once. */
export function loopbackProxyBypassList(existing?: string | null): string {
  const items = (existing ?? "")
    .split(/[;,]/)
    .map((value) => value.trim())
    .filter((value) => value && value.toLowerCase() !== SUBTRACT_IMPLICIT)
  for (const host of LOOPBACK_PROXY_BYPASS) {
    if (items.some((value) => value.toLowerCase() === host)) continue
    items.push(host)
  }
  return items.join(";")
}

type CommandLine = {
  getSwitchValue(name: string): string
  appendSwitch(name: string, value?: string): void
}

/** Sets `proxy-bypass-list` on Electron's `app.commandLine` (call before the app is ready). */
export function applyLoopbackProxyBypass(commandLine: CommandLine): string {
  const value = loopbackProxyBypassList(commandLine.getSwitchValue("proxy-bypass-list"))
  commandLine.appendSwitch("proxy-bypass-list", value)
  return value
}
