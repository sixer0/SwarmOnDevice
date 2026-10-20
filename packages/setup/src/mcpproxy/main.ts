// swarm-web-proxy entry point (row 94). Compiled by row 106 to PC-PATH-14
// (~/.swarm/setup/bin/swarm-web-proxy, PC-PKG-06); runs as the stdio MCP server OpenCode
// spawns via the config entry wiring.ts builds for row 97. This file is ONLY the stdio loop:
// policy, sanitising, envelope and audit live in proxy.ts; env/artefact resolution and the
// real transport live in resolve.ts (split so units can import those without opening fd 0).
//
// NO NETWORK AT IMPORT TIME (§6.2): the loop starts when this ENTRY executes, and the first
// socket opens only inside a tools/call. Importing this module from a test would start reading
// fd 0, so tests import proxy.ts / resolve.ts instead — same entry discipline as index.ts.

import { readSync, writeSync } from "node:fs"
import { handleRpc, type ProxyDeps, type RpcRequest } from "./proxy.ts"
import { newNonce } from "./sanitise.ts"
import {
  makeFetchTransport,
  searxngBaseFromEnvOrArtefact,
  firecrawlBaseFromEnv,
  firecrawlTokenFromEnv,
  inboxDirFromEnv,
} from "./resolve.ts"

function deps(): ProxyDeps {
  return {
    transport: makeFetchTransport(),
    searxngBase: () => searxngBaseFromEnvOrArtefact(),
    firecrawlBase: () => firecrawlBaseFromEnv(),
    firecrawlToken: () => firecrawlTokenFromEnv(),
    inboxDir: () => inboxDirFromEnv(),
    audit: {}, // appendAudit resolves PC-ENV-04 override else PC-PATH-10
    now: () => new Date(),
    nonce: () => newNonce(),
  }
}

/** Newline-delimited JSON-RPC over fd 0 -> fd 1 (the MCP stdio framing). A malformed line
 *  answers -32700 and keeps the session alive; EOF ends the process cleanly. Requests are
 *  handled one at a time — correct for the thin proxy's role, and it keeps the
 *  one-line-per-call audit ordering trivially inspectable. */
async function serveStdio(d: ProxyDeps): Promise<void> {
  const enc = new TextEncoder()
  let pending = ""
  const buf = new Uint8Array(64 * 1024)
  for (;;) {
    const n = readSync(0, buf, 0, buf.length)
    if (n <= 0) return // EOF
    pending += new TextDecoder().decode(buf.subarray(0, n))
    let nl = pending.indexOf("\n")
    while (nl >= 0) {
      const line = pending.slice(0, nl).trim()
      pending = pending.slice(nl + 1)
      if (line !== "") await handleLine(line, d, enc)
      nl = pending.indexOf("\n")
    }
  }
}

async function handleLine(line: string, d: ProxyDeps, enc: TextEncoder): Promise<void> {
  let req: RpcRequest
  try {
    req = JSON.parse(line) as RpcRequest
  } catch {
    writeSync(
      1,
      enc.encode(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } })}\n`),
    )
    return
  }
  const res = await handleRpc(req, d)
  if (res !== null) writeSync(1, enc.encode(`${JSON.stringify(res)}\n`))
}

await serveStdio(deps())
