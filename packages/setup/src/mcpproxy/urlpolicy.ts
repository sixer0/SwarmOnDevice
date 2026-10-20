// URL policy (row 94; contract = masterplan/01f_tool_wiring_spec.md §6.4). Enforced in the
// PROXY process, never in a prompt — this is layer L3's gate that refuses disallowed targets
// BEFORE any packet leaves (01f §0 "the load-bearing idea"). Pure function: no network, no fs.
//
// DEVIATION NOTE (declared, not silent): §6.4's signature returns Effect.Effect<UrlDecision>.
// packages/setup carries no Effect dependency (self-contained tsconfig, zero npm deps — 01f
// §6.1 "must not add a dependency"), so this export is the synchronous equivalent returning
// UrlDecision directly. Mechanically equivalent for the proxy's single-threaded stdio loop;
// row 110 re-runs the same vectors through the proxy either way.
//
// ALLOW-LIST SEMANTICS (brief + §6.2 read together): §6.4 lists not_in_allow_list as rule 5,
// AFTER the address denial — taken literally, an allow-listed loopback estate service could
// never pass rule 4, and swarm-web_search (which MUST reach the loopback SearXNG per §6.2)
// would be structurally impossible. The brief resolves it explicitly: private/loopback/
// link-local targets are denied EXCEPT the estate's own loopback services allow-listed
// explicitly. So a host matching `allowList` bypasses rules 3-4 (name/address denial) but NOT
// rules 1-2 (scheme, parseability); anything outside a supplied allow-list is refused. Public
// fetch calls pass NO allow-list, so they can never reach an estate service by name or IP.
//
// KNOWN RESIDUAL (§6.4 rule 7, unchanged by this row): DNS-rebinding TOCTOU between check and
// connect, and NAT64/DNS64 synthesis — a name that RESOLVES to a private address passes the
// literal checks here. The backstop is L4 (P-9 egress filtering in the VM), not this function;
// name→address pinning is deliberately NOT faked as implemented. Row 110 records what it
// actually observed refused; anything unexercisable stays UNKNOWN.

export type PolicyReason =
  | "scheme_not_allowed"
  | "url_unparseable"
  | "host_denied_name"
  | "address_denied"
  | "not_in_allow_list"

export type UrlDecision =
  | { readonly ok: true; readonly host: string }
  | { readonly ok: false; readonly reason: PolicyReason }

/** Names denied outright or by suffix (§6.4 rule 3). metadata.google.internal is the cloud
 *  credential endpoint — its value is [H] from general knowledge per 01f, closed by row 110's
 *  corpus; it also ends in .internal, so the suffix rule alone would catch it. */
const DENIED_SUFFIXES: readonly string[] = [".local", ".internal", ".localhost"]
const DENIED_EXACT: readonly string[] = ["localhost", "host.docker.internal", "metadata.google.internal"]

export interface UrlPolicyOptions {
  /** Exact host names or host:port strings. When supplied, ONLY these hosts are allowed, and
   *  they bypass the name/address denials (estate-services exception, header note above). */
  readonly allowList?: readonly string[]
}

/** Check one raw URL against §6.4. Never throws: a parse failure is `url_unparseable`. */
export function checkUrl(raw: string, opts: UrlPolicyOptions = {}): UrlDecision {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return { ok: false, reason: "url_unparseable" }
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return { ok: false, reason: "scheme_not_allowed" }

  const host = normaliseHost(parsed.hostname)
  if (host === "") return { ok: false, reason: "url_unparseable" }

  if (opts.allowList) {
    const port = parsed.port
    return matchesAllowList(host, port, opts.allowList)
      ? { ok: true, host }
      : { ok: false, reason: "not_in_allow_list" }
  }

  if (DENIED_EXACT.includes(host) || DENIED_SUFFIXES.some((s) => host.endsWith(s)))
    return { ok: false, reason: "host_denied_name" }
  if (isDeniedAddress(host)) return { ok: false, reason: "address_denied" }
  return { ok: true, host }
}

/** Lowercase, strip the root-dot and IPv6 brackets, drop any zone id. WHATWG URL already
 *  lowercases and normalises numeric/octal/hex IPv4 forms into dotted-quad at parse time; the
 *  defensive literal encodings are still handled by parseIPv4/parseIPv6 below for hosts that
 *  arrive raw (T-W7-2 vectors), which is why §6.4's [H] about parser normalisation is tested,
 *  not assumed. */
function normaliseHost(h: string): string {
  let host = h.trim().toLowerCase()
  if (host.endsWith(".")) host = host.slice(0, -1)
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1)
  const zone = host.indexOf("%")
  if (zone >= 0) host = host.slice(0, zone)
  return host
}

function matchesAllowList(host: string, port: string, allowList: readonly string[]): boolean {
  for (const entryRaw of allowList) {
    const entry = normaliseHost(entryRaw)
    if (entry === "") continue
    const sep = entry.lastIndexOf(":")
    // An entry carrying a port (host-colon-digits) must match host AND port; a bare host matches
    // any port. lastIndexOf is safe: IPv6 allow-list entries are rejected upstream (the estate
    // bases are IPv4 loopback literals derived from artefacts, never bracketed names).
    if (sep > 0 && /^\d+$/.test(entry.slice(sep + 1))) {
      if (entry.slice(0, sep) === host && entry.slice(sep + 1) === port) return true
      continue
    }
    if (entry === host) return true
  }
  return false
}

// --- address ranges (§6.4 rule 4) ---------------------------------------------------------

/** True when the host is an IP literal (after parser normalisation) inside a denied range:
 *  127.0.0.0/8, ::1, 0.0.0.0/8, 169.254.0.0/16, 10/8, 172.16/12, 192.168/16, 100.64.0.0/10
 *  (CGNAT), fc00::/7, fe80::/10 — including IPv4-mapped IPv6 (::ffff:x) forms. */
export function isDeniedAddress(host: string): boolean {
  const v4 = parseIPv4(host)
  if (v4) return deniedV4(v4)
  const v6 = parseIPv6(host)
  if (!v6) return false // a plain domain name is not an address test
  if (deniedV6(v6)) return true
  const mapped = ipv4MappedFromV6(v6)
  return mapped !== null && deniedV4(mapped)
}

/** Parse dotted-quad IPv4 incl. decimal/octal/hex components and 1-4-part short forms
 *  (a.b.c -> a.b.0.c style legacy forms are NOT accepted: only full 4-part literals count,
 *  because WHATWG normalisation already expands the rest; anything else is a name). */
function parseIPv4(host: string): Uint8Array | null {
  const parts = host.split(".")
  if (parts.length !== 4) return null
  const bytes = new Uint8Array(4)
  for (let i = 0; i < 4; i++) {
    const part = parts[i] ?? ""
    if (part === "") return null
    const value = parseNumericPart(part)
    if (value === null || value > 255) return null
    bytes[i] = value
  }
  return bytes
}

/** 0x.. hex, 0.. octal, else decimal — the encodings §6.4 names as normalisation vectors. */
function parseNumericPart(part: string): number | null {
  if (/^0x[0-9a-f]+$/.test(part)) return Number.parseInt(part.slice(2), 16)
  if (/^0[0-7]+$/.test(part)) return Number.parseInt(part.slice(1), 8)
  if (/^[0-9]+$/.test(part)) return Number.parseInt(part, 10)
  return null
}

function deniedV4(b: Uint8Array): boolean {
  const inCidr = (o0: number, o1: number, bits: number): boolean => cidrMatch(b, [o0, o1, 0, 0], bits)
  return (
    inCidr(127, 0, 8) || // loopback
    inCidr(0, 0, 8) || // "this network" incl. 0.0.0.0 itself
    inCidr(169, 254, 16) || // link-local / cloud metadata
    inCidr(10, 0, 8) ||
    inCidr(172, 16, 12) ||
    inCidr(192, 168, 16) ||
    inCidr(100, 64, 10) // CGNAT
  )
}

/** Expand an IPv6 literal to 16 bytes, honouring one `::` compression and a trailing
 *  IPv4 suffix (::ffff:1.2.3.4 dotted form). Returns null for anything non-literal. */
function parseIPv6(host: string): Uint8Array | null {
  if (!host.includes(":")) return null
  const doubleIdx = host.indexOf("::")
  if (doubleIdx >= 0 && host.indexOf("::", doubleIdx + 1) >= 0) return null // one compression max
  const headStr = doubleIdx >= 0 ? host.slice(0, doubleIdx) : host
  const tailStr = doubleIdx >= 0 ? host.slice(doubleIdx + 2) : ""
  const head = splitGroups(headStr)
  if (head === null) return null
  let tail: number[]
  if (doubleIdx >= 0) {
    const t = splitGroups(tailStr)
    if (t === null) return null
    tail = t
  } else {
    tail = []
  }
  const fill = 8 - head.length - tail.length
  if (fill < 0 || (doubleIdx < 0 && head.length !== 8)) return null
  const groups = [...head, ...new Array<number>(fill).fill(0), ...tail]
  const out = new Uint8Array(16)
  for (let i = 0; i < 8; i++) {
    out[i * 2] = ((groups[i] ?? 0) >> 8) & 0xff
    out[i * 2 + 1] = (groups[i] ?? 0) & 0xff
  }
  return out
}

/** Colon-separated hex groups with an optional trailing dotted IPv4 (which counts as two
 *  groups). Null on any malformed component. */
function splitGroups(s: string): number[] | null {
  if (s === "") return []
  const parts = s.split(":")
  const out: number[] = []
  for (let i = 0; i < parts.length; i++) {
    const c = parts[i] ?? ""
    if (c.includes(".")) {
      if (i !== parts.length - 1) return null // IPv4 suffix must be last
      const v4 = parseIPv4(c)
      if (!v4) return null
      out.push(((v4[0] ?? 0) << 8) | (v4[1] ?? 0), ((v4[2] ?? 0) << 8) | (v4[3] ?? 0))
      continue
    }
    const g = parseHexGroup(c)
    if (g === null) return null
    out.push(g)
  }
  return out
}

function parseHexGroup(c: string): number | null {
  if (!/^[0-9a-f]{1,4}$/.test(c)) return null
  return Number.parseInt(c, 16)
}

function deniedV6(b: Uint8Array): boolean {
  const b0 = b[0] ?? 0
  if (cidrMatch(b, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1], 128)) return true // ::1
  if (cidrMatch(b, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 128)) return true // :: unspecified — same semantics as the denied 0.0.0.0
  if ((b0 & 0xfe) === 0xfc) return true // fc00::/7 unique-local
  if (b0 === 0xfe && (b[1] ?? 0) >= 0x80 && (b[1] ?? 0) < 0xc0) return true // fe80::/10 link-local
  return false
}

/** IPv4-mapped IPv6: first 10 bytes zero, bytes 10-11 0xff — covers ::ffff:a.b.c.d AND the
 *  hex form ::ffff:7f00:1 (both land on the same 16-byte pattern). */
function ipv4MappedFromV6(b: Uint8Array): Uint8Array | null {
  for (let i = 0; i < 10; i++) if ((b[i] ?? 0) !== 0) return null
  if ((b[10] ?? 0) !== 0xff || (b[11] ?? 0) !== 0xff) return null
  return new Uint8Array([b[12] ?? 0, b[13] ?? 0, b[14] ?? 0, b[15] ?? 0])
}

function cidrMatch(b: Uint8Array, base: readonly number[], bits: number): boolean {
  const full = Math.floor(bits / 8)
  for (let i = 0; i < full; i++) if ((b[i] ?? 0) !== (base[i] ?? 0)) return false
  const rem = bits % 8
  if (rem === 0) return true
  const mask = (0xff << (8 - rem)) & 0xff
  return ((b[full] ?? 0) & mask) === ((base[full] ?? 0) & mask)
}
