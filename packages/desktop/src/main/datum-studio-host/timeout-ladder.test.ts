// Render-timeout ladder (Swarm 1.2.6 row 55, CFG-07; register A4 I-1..I-5, 01d §2 / T7).
//
// The M-01/M-04 timeouts only work as a set: raising one constant alone re-orders the ladder and turns a
// named error into a client-side -32001 or a socket hang-up. Each invariant below compares the REAL
// exported constants from their owning files (imported by relative path, as bundled-provider.test.ts does
// for core). Namespace imports so a missing export fails its expect instead of crashing the file.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import * as baseline from "../../../../core/src/swarm-permission-baseline"
import * as httpClient from "../../../../datum-studio/vendor/scripts/studio/_http-client"
import * as env from "../../../../datum-studio/vendor/src/lib/studio/contract/env"
import * as runtime from "../../../../datum-studio/vendor/src/lib/studio/engine/browser/runtime"
import * as lifecycle from "./lifecycle"

// electron-renderer.ts imports BrowserWindow/session from "electron". Importing it here needs an electron
// mock, and bun keeps the first electron mock of the process: after onboarding.test.ts mocks electron as
// { app } the import fails with "Export named 'session' not found" (S2 seal F3, row 55-fix). So the constant
// is read from the owning file's source (the register's own `TIMEOUT_MS\s*=` locator), independent of order.
const rendererSource = readFileSync(new URL("../datum-render/electron-renderer.ts", import.meta.url), "utf8")
const jobTimeoutMatch = /^export const JOB_TIMEOUT_MS = ([\d_]+)\s*$/m.exec(rendererSource)
const renderer: Record<string, unknown> = {
  JOB_TIMEOUT_MS: jobTimeoutMatch ? Number(jobTimeoutMatch[1].replaceAll("_", "")) : undefined,
}

const mcpTimeout = (baseline.SWARM_PERMISSION_BASELINE as { experimental?: { mcp_timeout?: number } }).experimental?.mcp_timeout
const h = httpClient as Record<string, unknown>
const e = env as Record<string, unknown>
const r = runtime as Record<string, unknown>
const l = lifecycle as Record<string, unknown>

describe("render-timeout ladder I-1..I-5 (CFG-07)", () => {
  test("register values (N-044..N-049, N-071, E-04)", () => {
    expect(mcpTimeout).toBe(600000)
    expect(h.STUDIO_RENDER_CALL_TIMEOUT_MS).toBe(540000)
    expect(e.STUDIO_RENDER_JOB_TIMEOUT_MS).toBe(600000)
    expect(e.RASTER_TIMEOUT_MAX_MS).toBe(120000)
    expect(r.BRIDGE_READ_MARGIN_MS).toBe(45000)
    expect(renderer.JOB_TIMEOUT_MS).toBe(150000)
    expect(r.BROWSER_QUEUE_WAIT_MS_DEFAULT).toBe(240000)
  })

  test("I-1: STUDIO_RENDER_CALL_TIMEOUT_MS < experimental.mcp_timeout", () => {
    expect(typeof h.STUDIO_RENDER_CALL_TIMEOUT_MS).toBe("number")
    expect(h.STUDIO_RENDER_CALL_TIMEOUT_MS as number).toBeLessThan(mcpTimeout as number)
  })

  test("I-2: STUDIO_RENDER_CALL_TIMEOUT_MS <= STUDIO_RENDER_JOB_TIMEOUT_MS", () => {
    expect(typeof h.STUDIO_RENDER_CALL_TIMEOUT_MS).toBe("number")
    expect(h.STUDIO_RENDER_CALL_TIMEOUT_MS as number).toBeLessThanOrEqual(e.STUDIO_RENDER_JOB_TIMEOUT_MS as number)
  })

  test("I-3: RASTER_TIMEOUT_MAX_MS < JOB_TIMEOUT_MS < RASTER_TIMEOUT_MAX_MS + BRIDGE_READ_MARGIN_MS", () => {
    expect(typeof e.RASTER_TIMEOUT_MAX_MS).toBe("number")
    expect(typeof r.BRIDGE_READ_MARGIN_MS).toBe("number")
    const job = renderer.JOB_TIMEOUT_MS as number
    expect(e.RASTER_TIMEOUT_MAX_MS as number).toBeLessThan(job)
    expect(job).toBeLessThan((e.RASTER_TIMEOUT_MAX_MS as number) + (r.BRIDGE_READ_MARGIN_MS as number))
  })

  test("I-4: HOST_READY_TIMEOUT_MS and STUDIO_HTTP_TIMEOUT_MS stay 60000", () => {
    expect(l.HOST_READY_TIMEOUT_MS).toBe(60000)
    expect(h.STUDIO_HTTP_TIMEOUT_MS).toBe(60000)
  })

  test("I-5: BROWSER_QUEUE_WAIT_MS_DEFAULT >= JOB_TIMEOUT_MS (a queued call outlasts one raced bridge job)", () => {
    expect(r.BROWSER_QUEUE_WAIT_MS_DEFAULT as number).toBeGreaterThanOrEqual(renderer.JOB_TIMEOUT_MS as number)
  })
})
