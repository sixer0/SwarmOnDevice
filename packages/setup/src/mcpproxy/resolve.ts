// Estate-resolution + real transport for the swarm-web proxy (row 94). SPLIT from main.ts so
// the resolvers and the fetch transport are UNIT-TESTABLE: importing main.ts would start the
// stdio loop on fd 0. This module performs no I/O at import time (§6.2) and opens no socket
// until a Transport.request is called.
//
// PORT RULE (controller broadcast; decisions.md PORT BLOCK): ZERO port literals anywhere in
// mcpproxy/. The SearXNG base is READ from PC-ENV-01 when set (row 97 writes it after the
// component reaches healthy, P-15), else DERIVED from the r85-rendered compose artefact via
// stacklib.parsePublishedPorts — the exact mechanism whose live output s93 PROBE 1 proved
// against the running stack ("parsed by healthProbeUrls, never hardcoded", s93 §3). Firecrawl
// base + bearer token are env-only (PC-ENV-02/03): the crawl service live-blocked at s93
// (H-R93-5/6), so deriving its URL from an artefact that may not serve would be dishonest —
// absent env means crawl refuses with BLOCKED_BY_NETWORK, exactly §5.2's safe dead-end.

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import nodeHttp from "node:http"
import nodeHttps from "node:https"
import { lookup } from "node:dns"
import { parsePublishedPorts, searxngPlan } from "../stacklib.ts"
import { expandTilde } from "../paths.ts"
import type { Transport, TransportRequest, TransportResponse } from "./proxy.ts"
import { checkResolvedAddresses, hostInAllowList, isIpLiteral, normaliseHost } from "./urlpolicy.ts"
import { ENV_NAMES, VAULT_ROOT } from "./register.ts"

export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024 // 2 MiB memory guard (design choice; §6.3 caps CHARS separately)
const REQUEST_TIMEOUT_MS = 30_000 // one hop; bounded independently of the MCP entry's startup patience

export function searxngBaseFromEnvOrArtefact(
  env: Readonly<Record<string, string | undefined>> = process.env,
  home?: string,
): string | null {
  const fromEnv = env[ENV_NAMES.SEARXNG_URL]
  if (fromEnv && fromEnv.trim() !== "") return trimSlash(fromEnv.trim())
  const composeFile = searxngPlan(home).composeFile
  if (!existsSync(composeFile)) return null
  let text: string
  try {
    text = readFileSync(composeFile, "utf8")
  } catch {
    return null
  }
  // The searxng service's loopback publish, exactly as rendered (service-name match keeps a
  // future multi-publish artefact from silently picking the wrong port).
  for (const p of parsePublishedPorts(text)) {
    if (p.service.includes("searxng")) return `http://${p.hostIp}:${p.hostPort}`
  }
  return null
}

export function firecrawlBaseFromEnv(env: Readonly<Record<string, string | undefined>> = process.env): string | null {
  const v = env[ENV_NAMES.FIRECRAWL_URL]
  return v && v.trim() !== "" ? trimSlash(v.trim()) : null
}

export function firecrawlTokenFromEnv(env: Readonly<Record<string, string | undefined>> = process.env): string | null {
  const v = env[ENV_NAMES.FIRECRAWL_TOKEN]
  return v && v.trim() !== "" ? v : null // value NEVER logged; used only as a bearer header
}

/** Absolute inbox dir (PC-PATH-12): SWARM_VAULT_DIR (=PC-PATH-13) or the register root, plus /inbox. */
export function inboxDirFromEnv(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const vault = env[ENV_NAMES.VAULT_DIR]
  return join(expandTilde(vault && vault.trim() !== "" ? vault : VAULT_ROOT), "inbox")
}

function trimSlash(u: string): string {
  return u.endsWith("/") ? u.slice(0, -1) : u
}

// --- resolve→check→pin transport (senior review 107 MAJOR-3 fix) --------------------------------
//
// A host-side page-fetch must not trust name→address resolution at face value: a hostile name can
// rebind to 127.0.0.1 between check and connect, and DNS64 can wrap any denied IPv4 inside the
// NAT64 well-known prefix. This transport closes that on the CONNECT side with ONE resolution:
//
//   1. IP-literal hosts connect directly — no DNS step exists; checkUrl already vetted the literal
//      (and the estate loopback bases are literals reached via their explicit allow-list).
//   2. Named hosts: resolveAll() ONCE (node:dns lookup, all:true verbatim:true), then
//      urlpolicy.checkResolvedAddresses over EVERY answer; ANY denied answer returns
//      TransportResponse.deniedReason — the proxy audits decision:"denied" and NO socket opens.
//   3. The connect uses a custom `lookup` callback that serves ONLY the vetted pinned address,
//      so the socket dials exactly the address we checked — the classic rebinding race has no
//      window because there is no second resolution at connect time (TOCTOU closed by design).
//   4. For https, `host` and `servername` stay the ORIGINAL hostname: TLS SNI and certificate
//      verification bind to the name, not to the pin. Measured on bun 1.3.14 (proofs PROOF 5,
//      fresh transcript per run): right servername + pinned lookup → 200; wrong servername →
//      ERR_TLS_CERT_ALTNAME_INVALID; untrusted CA → still refused. Pinning therefore does NOT
//      weaken TLS identity — the node:http/node:https `lookup` connect option (Node ≥10.11 API)
//      is honoured by this runtime for both protocols.
//
// Honest residuals (stated, not claimed away): (i) application-layer SSRF — a legitimately public
// server that proxies onward to an internal service — is beyond any URL policy; L1/L2 prompts and
// row 110's harness own it. (ii) The crawl leg POSTs to the estate Firecrawl base (IP literal by
// derivation); Firecrawl's own target-side fetches stay governed by squid/L4 (01e §10.4), not by
// this transport. (iii) We dial exactly ONE vetted answer (first verbatim), skipping Happy-
// Eyeballs racing — deterministic beats racing when the point is "connect where we checked".

export type ResolveOutcome = { readonly ok: true; readonly addresses: string[] } | { readonly ok: false; readonly error: string }
export type Resolver = (host: string) => Promise<ResolveOutcome>

/** Opens one request; `secure` selects http vs https. TEST SEAM via TransportOverrides.open. */
export type Connector = (secure: boolean, options: SwarmHttpRequestOptions) => SwarmClientRequest

export interface TransportOverrides {
  /** TEST SEAM ONLY (r88 npmRunner discipline): replaces system DNS so units drive rebinding
   *  fixtures deterministically. Cannot weaken production: main.ts passes nothing. */
  readonly resolveAll?: Resolver
  /** TEST SEAM ONLY: replaces the socket-opening connector so units assert ZERO connection
   *  attempts on resolved-answer refusals (T-W7-5 extended to the DNS leg). */
  readonly open?: Connector
  /** TEST SEAM ONLY: explicit trust anchor for the https leg (unit fixtures use self-signed
   *  certs). NEVER set in shipped wiring: undefined keeps the system CA store, and setting it
   *  NARROWS trust to the given PEM rather than widening it — it cannot disable verification. */
  readonly ca?: string
}

/** The default resolver: every answer, v4+v6, unfiltered (verbatim keeps the full set for the
 *  check instead of the OS's preferred-family subset). */
export function systemResolver(): Resolver {
  return (host: string) =>
    new Promise<ResolveOutcome>((resolve) => {
      lookup(host, { all: true, verbatim: true }, (err, addresses) => {
        if (err) resolve({ ok: false, error: err.message })
        else resolve({ ok: true, addresses: addresses.map((a) => a.address) })
      })
    })
}

/** One HTTP exchange with redirects NOT followed (proxy.getChecked re-checks every hop) and the
 *  resolved-IP pin described in the header. The bearer header for the crawl leg arrives through
 *  req.headers and is never echoed back. */
export function makeFetchTransport(overrides: TransportOverrides = {}): Transport {
  const resolveAll = overrides.resolveAll ?? systemResolver()
  const open = overrides.open ?? defaultConnector
  return {
    async request(url: string, req: TransportRequest): Promise<TransportResponse> {
      let u: URL
      try {
        u = new URL(url)
      } catch {
        return { status: 0, bytes: null, error: "url_unparseable in transport" }
      }
      if (u.protocol !== "http:" && u.protocol !== "https:")
        return { status: 0, bytes: null, deniedReason: "scheme_not_allowed", error: "non-http scheme in transport" }
      const host = normaliseHost(u.hostname)
      if (host === "") return { status: 0, bytes: null, error: "empty host" }
      const secure = u.protocol === "https:"
      const literal = isIpLiteral(host)
      let pinned: string | null = null
      if (!literal) {
        const ans = await resolveAll(host)
        if (!ans.ok) return { status: 0, bytes: null, error: `dns resolution failed for ${host}: ${ans.error}` }
        if (ans.addresses.length === 0) return { status: 0, bytes: null, error: `no DNS answers for ${host}` }
        // Estate exception: a host on the leg's configured allow-list skips the resolved-answer
        // DENY (it is trusted by configuration, mirroring checkUrl's rule-3/4 bypass) but STILL
        // resolves once and pins — single-resolution discipline holds for every name, trusted or not.
        const allowListed = req.allowList !== undefined && req.allowList.length > 0 && hostInAllowList(host, u.port, req.allowList)
        const denial = allowListed ? null : checkResolvedAddresses(ans.addresses)
        if (denial !== null)
          return { status: 0, bytes: null, deniedReason: denial, error: `${host} resolves to a refused address` }
        pinned = ans.addresses[0] ?? null
      }
      const headers: Record<string, string> = { ...(req.headers ?? {}) }
      let bodyBytes: Uint8Array | null = null
      if (req.body !== undefined) {
        bodyBytes = new TextEncoder().encode(req.body)
        headers["Content-Length"] = String(bodyBytes.byteLength)
      }
      const qIdx = url.indexOf("?")
      const options: SwarmHttpRequestOptions = {
        host, // ORIGINAL name stays: Host header + TLS identity follow it, the pin follows lookup
        ...(u.port !== "" ? { port: Number(u.port) } : {}), // defaults (80/443) come from the module — no port literals here
        method: req.method ?? "GET",
        path: u.pathname + (qIdx >= 0 ? url.slice(qIdx) : ""),
        headers,
        timeout: REQUEST_TIMEOUT_MS,
        ...(secure && !literal ? { servername: host } : {}),
        ...(pinned !== null ? { lookup: pinnedLookup(pinned) } : {}),
        ...(secure && overrides.ca !== undefined ? { ca: overrides.ca } : {}),
      }
      return await exchange(open, secure, options, bodyBytes)
    },
  }
}

/** Serves ONLY the vetted address — never consults the system resolver again (TOCTOU closure). */
function pinnedLookup(ip: string): NonNullable<SwarmHttpRequestOptions["lookup"]> {
  return (_hostname: string, options: Record<string, unknown>, callback: (err: Error | null, address: string | Array<{ address: string; family: number }>, family?: number) => void) => {
    const family = ip.includes(":") ? 6 : 4
    if (options && options.all === true) callback(null, [{ address: ip, family }])
    else callback(null, ip, family)
  }
}

/** The PRODUCTION connector (system CA store, real sockets). Exported so the unit suite can WRAP
 *  it — capturing the options a pinned request carries — while still dialling a real loopback
 *  fixture; wrapping changes nothing about how the socket is opened. */
export function defaultConnector(secure: boolean, options: SwarmHttpRequestOptions): SwarmClientRequest {
  return secure ? nodeHttps.request(options) : nodeHttp.request(options)
}

async function exchange(
  open: Connector,
  secure: boolean,
  options: SwarmHttpRequestOptions,
  bodyBytes: Uint8Array | null,
): Promise<TransportResponse> {
  return await new Promise<TransportResponse>((resolve) => {
    let settled = false
    const finish = (r: TransportResponse): void => {
      if (!settled) {
        settled = true
        resolve(r)
      }
    }
    let rq: SwarmClientRequest
    try {
      rq = open(secure, options)
    } catch (err) {
      finish({ status: 0, bytes: null, error: `connect failed: ${(err as Error).message}` })
      return
    }
    rq.on("response", (res) => {
      const chunks: Uint8Array[] = []
      let total = 0
      let over = false
      res.on("data", (c) => {
        if (over) return
        total += c.byteLength
        if (total > MAX_RESPONSE_BYTES) {
          over = true
          rq.destroy()
          finish({ status: res.statusCode ?? 0, bytes: null, error: `response exceeded ${MAX_RESPONSE_BYTES} bytes` })
          return
        }
        chunks.push(c)
      })
      res.on("end", () => {
        if (over) return
        const out = new Uint8Array(total)
        let off = 0
        for (const c of chunks) {
          out.set(c, off)
          off += c.byteLength
        }
        const locRaw = res.headers["location"]
        const location = Array.isArray(locRaw) ? locRaw[0] : locRaw
        finish({ status: res.statusCode ?? 0, bytes: out, ...(location !== undefined ? { location } : {}) })
      })
      res.on("error", (err) => finish({ status: 0, bytes: null, error: `stream failed: ${err.message}` }))
    })
    rq.on("error", (err) => {
      const msg = err.message ?? String(err)
      finish({ status: 0, bytes: null, error: /timeout/i.test(msg) ? "request timed out" : `connection failed: ${msg}` })
    })
    if (bodyBytes !== null) rq.write(bodyBytes)
    rq.end()
  })
}
