import { Context } from "effect"

export type CorsOptions = {
  readonly cors?: ReadonlyArray<string>
  /**
   * Hostnames this server answers for — the resolved `--hostname` value or an mDNS domain. A
   * request whose Host header names anything outside this list and outside the loopback range is
   * rejected by `isAllowedHost`.
   */
  readonly hosts?: ReadonlyArray<string>
}

export const CorsConfig = Context.Reference<CorsOptions | undefined>("@opencode/ServerCorsConfig", {
  defaultValue: () => undefined,
})

export function isAllowedCorsOrigin(input: string | undefined, opts?: CorsOptions) {
  if (!input) return true
  if (input.startsWith("http://localhost:")) return true
  if (input.startsWith("http://127.0.0.1:")) return true
  if (input.startsWith("oc://renderer")) return true
  return opts?.cors?.includes(input) ?? false
}

export function isAllowedRequestOrigin(input: string | undefined, host: string | undefined, opts?: CorsOptions) {
  if (!input) return true
  // The same-host shortcut is only trusted for hosts on the allow-list. Without this gate a
  // DNS-rebinding page sends Origin and Host both equal to its own domain and passes sameHost,
  // which is how the PTY websocket (the shell door) would open for a remote page.
  if (host && sameHost(input, host) && isAllowedHost(host, opts)) return true
  return isAllowedCorsOrigin(input, opts)
}

/**
 * Host-header allow-list: loopback names are always accepted, anything else has to be a hostname
 * the operator configured through `CorsOptions.hosts`. A missing Host header is rejected — every
 * HTTP/1.1 request must carry one, so an absent value is not a client Swarm ships.
 */
export function isAllowedHost(host: string | undefined, opts?: CorsOptions) {
  const name = hostName(host)
  if (!name) return false
  if (isLoopbackHost(name)) return true
  return opts?.hosts?.includes(name) ?? false
}

function sameHost(origin: string, host: string) {
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

// Host headers carry the port ("127.0.0.1:4096") while the allow-list is written in bare hostnames,
// and IPv6 arrives bracketed ("[::1]:4096").
function hostName(host: string | undefined) {
  if (!host) return undefined
  const value = host.trim()
  if (value.startsWith("[")) return value.slice(1, value.indexOf("]"))
  const first = value.indexOf(":")
  // Bracket-less IPv6 ("::1") has no single port separator to cut on.
  if (first === -1 || value.indexOf(":", first + 1) !== -1) return value
  return value.slice(0, first)
}

// "localhost", "::1" and all of 127.0.0.0/8. Octets are validated numerically rather than by a
// "127." prefix so rebinding hostnames spelled like an address ("127.attacker.example") fail closed.
function isLoopbackHost(host: string) {
  if (host === "localhost" || host === "::1") return true
  const octets = host.split(".")
  return octets.length === 4 && octets[0] === "127" && octets.every(isNumericOctet)
}

function isNumericOctet(octet: string) {
  if (octet.length === 0 || octet.length > 3) return false
  for (const char of octet) if (char < "0" || char > "9") return false
  return Number(octet) < 256
}
