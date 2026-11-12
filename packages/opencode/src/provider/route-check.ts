import { execFile } from "child_process"
import { Effect } from "effect"
import { GlobalBus } from "@/bus/global"

export * as ProviderRoute from "./route-check"

// SEC-08 (SR-08 as decided by U22). The provider this app ships with speaks plain HTTP to an address in the Tailscale
// range. That traffic is private only while the route to the host goes over Tailscale: on a network that uses the
// same carrier-grade NAT space, with Tailscale down, the address can be another machine. Swarm still sends the
// request (U22), but says so once a minute: `PROVIDER_ROUTE_UNVERIFIED`, "connect Tailscale".
//
// The check never holds a request back. The first request starts the probe and goes out at once; the answer is kept
// for CACHE_MS, and a failed or missing answer counts as unverified.

export const CODE = "PROVIDER_ROUTE_UNVERIFIED"
export const CACHE_MS = 60_000
const PROBE_TIMEOUT_MS = 2_000

export const message = (host: string) =>
  `${CODE}: the route to the built-in AI (${host}) does not go through Tailscale. Requests are still sent, unencrypted. Connect Tailscale.`

/** What the OS says about the route to a host: the interface name, or undefined when it cannot tell. */
export type Probe = (host: string) => Promise<string | undefined>
export type Warning = { code: typeof CODE; host: string; iface?: string; sessionID?: string; message: string }
export type Sink = (warning: Warning) => void

/** What the OS says about an interface's IPv4 addresses, or undefined when it cannot tell. */
export type Addresses = (iface: string) => Promise<string[] | undefined>

/** An IPv4 address in Tailscale's carrier-grade NAT range, 100.64.0.0/10 (100.64.0.0 to 100.127.255.255). */
export const inTailscaleRange = (address: string) => {
  const parts = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address.trim())
  if (!parts) return false
  const [a, b, c, d] = parts.slice(1).map(Number) as [number, number, number, number]
  if ([a, b, c, d].some((n) => n > 255)) return false
  return a === 100 && b >= 64 && b <= 127
}

const namedByTailscale = (iface: string) => /tailscale/i.test(iface)
const isUtun = (iface: string) => /^utun\d+$/.test(iface)

/**
 * A Tailscale interface. Linux and Windows name it `tailscale0` / "Tailscale". On macOS it is a `utunN`, but so is the
 * tunnel of every other VPN client (WireGuard, Cisco and so on), so 1.2.6 (M1 S1) counts a utun only when it carries an
 * IPv4 address in 100.64.0.0/10. No addresses known: not verified.
 */
export const isTailscale = (iface: string | undefined, addresses?: readonly string[]) => {
  if (!iface) return false
  if (namedByTailscale(iface)) return true
  return isUtun(iface) && !!addresses?.some(inTailscaleRange)
}

const run = (cmd: string, args: string[]) =>
  new Promise<string | undefined>((resolve) => {
    try {
      execFile(cmd, args, { timeout: PROBE_TIMEOUT_MS, windowsHide: true }, (error, stdout) =>
        resolve(error ? undefined : String(stdout)),
      )
    } catch {
      resolve(undefined)
    }
  })

/** Default probe. macOS: `route -n get`; Linux: `ip route get`; Windows: `tailscale status --json` lists the peer. */
export const osProbe: Probe = async (host) => {
  if (process.platform === "darwin") {
    const out = await run("/sbin/route", ["-n", "get", host])
    return out?.match(/^\s*interface:\s*(\S+)/m)?.[1]
  }
  if (process.platform === "linux") {
    const out = await run("ip", ["route", "get", host])
    return out?.match(/\bdev\s+(\S+)/)?.[1]
  }
  if (process.platform === "win32") {
    const out = await run("tailscale", ["status", "--json"])
    if (!out) return undefined
    try {
      const status = JSON.parse(out) as { Peer?: Record<string, { TailscaleIPs?: string[] }> }
      const peer = Object.values(status.Peer ?? {}).some((p) => p.TailscaleIPs?.includes(host))
      return peer ? "Tailscale" : undefined
    } catch {
      return undefined
    }
  }
  return undefined
}

/** Default address lookup. macOS: `ifconfig <iface>`; Linux: `ip -4 -o addr show dev <iface>`. The `inet` lines. */
export const osAddresses: Addresses = async (iface) => {
  if (!/^[\w.-]+$/.test(iface)) return undefined
  const out =
    process.platform === "darwin"
      ? await run("/sbin/ifconfig", [iface])
      : process.platform === "linux"
        ? await run("ip", ["-4", "-o", "addr", "show", "dev", iface])
        : undefined
  if (!out) return undefined
  return [...out.matchAll(/\binet\s+(\d{1,3}(?:\.\d{1,3}){3})/g)].map((m) => m[1]!)
}

// The existing notice surface: the log, and the toast event the session view already shows (no new panel, INV-K).
export const defaultSink: Sink = (warning) => {
  Effect.runFork(
    Effect.logWarning(warning.message, {
      service: "provider.route",
      code: warning.code,
      host: warning.host,
      iface: warning.iface ?? "unknown",
      sessionID: warning.sessionID ?? "",
    }),
  )
  GlobalBus.emit("event", {
    payload: {
      type: "tui.toast.show",
      properties: { title: "GSP AI", message: warning.message, variant: "warning", duration: 10_000 },
    },
  })
}

let probe: Probe = osProbe
let addressesOf: Addresses = osAddresses
let sink: Sink = defaultSink
let now = () => Date.now()
const routes = new Map<string, { at: number; iface?: string; verified: boolean }>()
const warnedAt = new Map<string, number>()
const pending = new Set<Promise<void>>()

/** Test seam: replace the probe, the address lookup, the sink or the clock; `reset()` restores the defaults. */
export const setProbe = (next: Probe) => void (probe = next)
export const setAddresses = (next: Addresses) => void (addressesOf = next)
export const setSink = (next: Sink) => void (sink = next)
export const setClock = (next: () => number) => void (now = next)
export const reset = () => {
  probe = osProbe
  addressesOf = osAddresses
  sink = defaultSink
  now = () => Date.now()
  routes.clear()
  warnedAt.clear()
}
/** Resolves when every probe started so far has answered (tests only; requests never wait for it). */
export const settled = async () => {
  while (pending.size) await Promise.all([...pending])
}

const warnOnce = (host: string, iface: string | undefined, sessionID: string | undefined) => {
  const last = warnedAt.get(host)
  if (last !== undefined && now() - last < CACHE_MS) return
  warnedAt.set(host, now())
  try {
    sink({ code: CODE, host, iface, sessionID, message: message(host) })
  } catch {
    // A notice that cannot be shown must never cost the request.
  }
}

/** Looks at the route to `host` (cached CACHE_MS) and warns when it is not a verified Tailscale interface. Never throws. */
export function check(host: string, sessionID?: string) {
  const cached = routes.get(host)
  if (cached && now() - cached.at < CACHE_MS) {
    if (!cached.verified) warnOnce(host, cached.iface, sessionID)
    return
  }
  // Mark it now so a burst of requests starts one probe, not one each.
  routes.set(host, { at: now(), verified: true })
  const task = Promise.resolve()
    .then(() => probe(host))
    .catch(() => undefined)
    .then(async (iface) => {
      // Only a utun needs its addresses read; a name Tailscale gives, or any other interface, decides by itself.
      const addresses =
        iface && isUtun(iface) && !namedByTailscale(iface)
          ? await Promise.resolve()
              .then(() => addressesOf(iface))
              .catch(() => undefined)
          : undefined
      return { iface, addresses }
    })
    .then(({ iface, addresses }) => {
      const verified = isTailscale(iface, addresses)
      routes.set(host, { at: now(), iface, verified })
      if (!verified) warnOnce(host, iface, sessionID)
    })
  pending.add(task)
  void task.finally(() => pending.delete(task))
}

const sessionOf = (input: unknown, init?: RequestInit) => {
  const read = (headers: unknown) => {
    try {
      return headers ? new Headers(headers as HeadersInit).get("x-swarm-session-id") ?? undefined : undefined
    } catch {
      return undefined
    }
  }
  return read(init?.headers) ?? (input instanceof Request ? read(input.headers) : undefined)
}

/**
 * Wraps the fetch of the bundled provider. Plain-HTTP requests start (or reuse) the route check for their host and
 * are passed on unchanged, at once. HTTPS needs no check.
 */
export function guard<F extends (input: any, init?: any) => Promise<Response>>(fetchFn: F): F {
  return ((input: any, init?: any) => {
    try {
      const url = new URL(input instanceof Request ? input.url : String(input))
      if (url.protocol === "http:") check(url.hostname, sessionOf(input, init))
    } catch {
      // An address the check cannot read is sent as it is.
    }
    return fetchFn(input, init)
  }) as F
}
