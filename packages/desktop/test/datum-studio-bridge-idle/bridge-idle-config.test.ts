// Row FX-4 (1.2.6 review wave F, gate M2 finding S2): fast config pin for the stdio bridge transport limits.
//
// The real-time evidence is bridge-idle-probe.long.test.ts (manual, ~10 min, skipped by default): Bun 1.3.14 `fetch`
// cuts a silent request at 300 s unless `timeout: false`; the node:http host has no idle limit. This file pins the
// configuration that result depends on, so a later edit cannot quietly bring the 300 s cut back:
// - the bridge passes BRIDGE_FETCH_OPTIONS ({ timeout: false }) on its one fetch call;
// - the host endpoint applies HOST_HTTP_TIMEOUTS (no request or socket idle limit);
// - both sit above the ladder: STUDIO_RENDER_CALL_TIMEOUT_MS (540 s) < experimental.mcp_timeout (600 s) <= the
//   bridge's floor, with nothing in the transport that ends earlier.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import * as baseline from "../../../core/src/swarm-permission-baseline"
import * as httpClient from "../../../datum-studio/vendor/scripts/studio/_http-client"
import * as transport from "../../scripts/datum-studio-bridge-transport"
import * as host from "../../../datum-studio/src/mcp-host/http-server"

const DESKTOP = join(import.meta.dir, "..", "..")
const BRIDGE_SRC = readFileSync(join(DESKTOP, "scripts", "datum-studio-bridge.ts"), "utf8")
const HOST_SRC = readFileSync(join(DESKTOP, "..", "datum-studio", "src", "mcp-host", "http-server.ts"), "utf8")
const t = transport as Record<string, unknown>
const h = host as Record<string, unknown>
const mcpTimeout = (baseline.SWARM_PERMISSION_BASELINE as { experimental?: { mcp_timeout?: number } }).experimental
  ?.mcp_timeout
const renderCall = (httpClient as Record<string, unknown>).STUDIO_RENDER_CALL_TIMEOUT_MS as number

describe("FX-4 bridge transport idle limits (S2)", () => {
  test("bridge fetch disables Bun's 300 s idle cut", () => {
    expect(t.BRIDGE_FETCH_OPTIONS).toEqual({ timeout: false })
    expect(t.BRIDGE_IDLE_LIMIT_FLOOR_MS).toBe(600_000)
  })

  test("the bridge's only fetch call spreads BRIDGE_FETCH_OPTIONS", () => {
    expect(BRIDGE_SRC).toContain('import { BRIDGE_FETCH_OPTIONS } from "./datum-studio-bridge-transport"')
    const calls = BRIDGE_SRC.match(/\bawait fetch\(/g) ?? []
    expect(calls.length).toBe(1)
    expect(BRIDGE_SRC).toMatch(/await fetch\(this\.endpoint\.url, \{[^}]*\.\.\.BRIDGE_FETCH_OPTIONS \}/)
  })

  test("host endpoint: no request or socket idle limit, applied to the server", () => {
    expect(h.HOST_HTTP_TIMEOUTS).toEqual({ requestTimeout: 0, headersTimeout: 30_000, timeout: 0 })
    expect(HOST_SRC).toContain("http.requestTimeout = HOST_HTTP_TIMEOUTS.requestTimeout")
    expect(HOST_SRC).toContain("http.headersTimeout = HOST_HTTP_TIMEOUTS.headersTimeout")
    expect(HOST_SRC).toContain("http.timeout = HOST_HTTP_TIMEOUTS.timeout")
    // The host is node:http in an Electron utilityProcess, never Bun.serve (whose default idleTimeout is 10 s).
    expect(HOST_SRC).toContain('import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http"')
    expect(HOST_SRC).not.toMatch(/Bun\.serve\(/)
  })

  test("ladder: R17 540 s < mcp_timeout 600 s <= bridge floor; transport adds no earlier cut", () => {
    expect(renderCall).toBe(540_000)
    expect(mcpTimeout).toBe(600_000)
    expect(renderCall).toBeLessThan(mcpTimeout as number)
    expect(t.BRIDGE_IDLE_LIMIT_FLOOR_MS as number).toBeGreaterThanOrEqual(mcpTimeout as number)
    // 0 = disabled for node:http; any non-zero host idle limit must also clear the floor.
    const limits = host.HOST_HTTP_TIMEOUTS
    for (const v of [limits.requestTimeout, limits.timeout])
      expect(v === 0 || v >= (t.BRIDGE_IDLE_LIMIT_FLOOR_MS as number)).toBe(true)
  })
})
