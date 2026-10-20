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
import { parsePublishedPorts, searxngPlan } from "../stacklib.ts"
import { expandTilde } from "../paths.ts"
import type { Transport, TransportRequest, TransportResponse } from "./proxy.ts"
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

// --- fetch-backed transport -----------------------------------------------------------------

/** One HTTP exchange, redirects NOT followed (proxy.getChecked re-checks every hop). The
 *  bearer header for the crawl leg arrives through req.headers and is never echoed back. */
export function makeFetchTransport(): Transport {
  return {
    async request(url: string, req: TransportRequest): Promise<TransportResponse> {
      try {
        const res = await fetch(url, {
          method: req.method ?? "GET",
          headers: req.headers,
          redirect: "manual",
          body: req.body,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        })
        const bytes = await readCapped(res)
        if (bytes === null)
          return { status: res.status, bytes: null, error: `response exceeded ${MAX_RESPONSE_BYTES} bytes` }
        const location = res.headers.get("location")
        return { status: res.status, bytes, ...(location ? { location } : {}) }
      } catch (err) {
        const msg = (err as Error).message ?? String(err)
        return {
          status: 0,
          bytes: null,
          error:
            /timeout/i.test(msg) || (err as Error).name === "TimeoutError"
              ? "request timed out"
              : `connection failed: ${msg}`,
        }
      }
    },
  }
}

/** Stream the body up to the cap; null when over. WHATWG reader protocol per bun-net.d.ts. */
async function readCapped(res: ResponseLike): Promise<Uint8Array | null> {
  if (!res.body) return new Uint8Array(0)
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    const chunk = value as Uint8Array
    total += chunk.byteLength
    if (total > MAX_RESPONSE_BYTES) return null
    chunks.push(chunk)
  }
  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.byteLength
  }
  return out
}
