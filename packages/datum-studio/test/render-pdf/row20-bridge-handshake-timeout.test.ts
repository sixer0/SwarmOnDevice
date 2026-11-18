// Swarm 1.3.3 row 20 (SB-1): the render bridge handshake is bounded and reports the true cause.
//
// Before: a bridge that accepts the connection and never answers (Electron main frozen, hang trace
// 2026-11-17) held `hello` for 30 000 + 45 000 = 75 000 ms and the preflight then named the cause
// PDF_ENGINE_MISSING ("bridge not reachable"). Now: `bridgeHandshake` ends at
// BRIDGE_HANDSHAKE_TIMEOUT_MS (register section 10: 8 000, no BRIDGE_READ_MARGIN_MS) with the message
// `render bridge handshake timed out`, and the preflight maps it to PDF_BRIDGE_TIMEOUT.
//
// No test waits real seconds: the limit is injected (`timeoutMs`) as 40-60 ms.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import * as runtime from "../../vendor/src/lib/studio/engine/browser/runtime";
import { assertPdfRenderReady, layCausesOf } from "../../vendor/src/lib/studio/services/render/preflight";
import { bridgePdfReadiness, resetBridgePdfReadiness } from "../../vendor/src/lib/studio/services/render/readiness";

const GOOD_INFO = { electron: "0", chrome: "0", sandbox: true, contextIsolation: true, nodeIntegration: false, network: "blocked" };
const SHORT_MS = 50;
/** Generous ceiling for a 50 ms limit on a loaded host; far below the real 8 000 ms. */
const CEILING_MS = 2000;

async function errOf(p: Promise<unknown>): Promise<Error & { code?: string; reason?: string }> {
  try {
    await p;
  } catch (e) {
    return e as Error & { code?: string; reason?: string };
  }
  throw new Error("expected a rejection");
}

afterEach(() => {
  runtime.setRenderBridgeTransport(null);
  runtime.setBrowserLogSink(null);
  resetBridgePdfReadiness();
  delete process.env.DATUM_RENDER_SOCKET;
  delete process.env.DATUM_RENDER_TOKEN;
});

describe("row 20: bounded render bridge handshake", () => {
  test("register value: BRIDGE_HANDSHAKE_TIMEOUT_MS = 8000, inside 5-10 s, margin not added", () => {
    expect(runtime.BRIDGE_HANDSHAKE_TIMEOUT_MS).toBe(8000);
    expect(runtime.BRIDGE_HANDSHAKE_TIMEOUT_MS).toBeGreaterThanOrEqual(5000);
    expect(runtime.BRIDGE_HANDSHAKE_TIMEOUT_MS).toBeLessThanOrEqual(10000);
    expect(runtime.BRIDGE_READ_MARGIN_MS).toBe(45000);
  });

  test("hung transport: handshake rejects at the limit with the named message, and asks the transport for the exact read limit", async () => {
    const seen: Array<runtime.BridgeTransportOptions | undefined> = [];
    const logs: string[] = [];
    runtime.setBrowserLogSink((e) => logs.push(e.message));
    runtime.setRenderBridgeTransport((_req, opts) => {
      seen.push(opts);
      return new Promise(() => {});
    });
    const t0 = performance.now();
    const e = await errOf(runtime.bridgeHandshake({ timeoutMs: SHORT_MS }));
    const waited = performance.now() - t0;
    expect(waited).toBeGreaterThanOrEqual(SHORT_MS - 5);
    expect(waited).toBeLessThan(CEILING_MS);
    expect(e.code).toBe("BROWSER_UNAVAILABLE");
    expect(e.message).toContain("render bridge handshake timed out");
    expect(e.message).toContain(`${SHORT_MS} ms`);
    expect(seen).toEqual([{ timeoutMs: SHORT_MS, readTimeoutMs: SHORT_MS }]);
    expect(logs.some((m) => /render bridge handshake timed out/.test(m))).toBe(true);
  });

  test("default limit is the register constant (transport sees readTimeoutMs 8000, no margin)", async () => {
    const seen: Array<runtime.BridgeTransportOptions | undefined> = [];
    runtime.setRenderBridgeTransport(async (_req, opts) => {
      seen.push(opts);
      return { ok: true, ...GOOD_INFO };
    });
    const info = await runtime.bridgeHandshake();
    expect(info.sandbox).toBe(true);
    expect(seen).toEqual([{ timeoutMs: 8000, readTimeoutMs: 8000 }]);
  });

  test("real socket that accepts and never answers (frozen main): socket transport ends at the limit, same named message", async () => {
    const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "row20-")));
    const sockPath = path.join(dir, "r.sock");
    const conns: net.Socket[] = [];
    const server = net.createServer((c) => {
      conns.push(c);
      c.on("error", () => {});
    });
    await new Promise<void>((r) => server.listen(sockPath, () => r()));
    try {
      process.env.DATUM_RENDER_SOCKET = sockPath;
      process.env.DATUM_RENDER_TOKEN = "row20-token";
      runtime.setRenderBridgeTransport(null);
      const t0 = performance.now();
      const e = await errOf(runtime.bridgeHandshake({ timeoutMs: SHORT_MS }));
      expect(performance.now() - t0).toBeLessThan(CEILING_MS);
      expect(e.message).toContain("render bridge handshake timed out");
    } finally {
      for (const c of conns) c.destroy();
      await new Promise<void>((r) => server.close(() => r()));
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a slow answer after the limit does not resurrect the handshake or raise an unhandled rejection", async () => {
    runtime.setRenderBridgeTransport(() => new Promise((_res, rej) => setTimeout(() => rej(new Error("late failure")), SHORT_MS * 2)));
    const e = await errOf(runtime.bridgeHandshake({ timeoutMs: SHORT_MS }));
    expect(e.message).toContain("render bridge handshake timed out");
    await new Promise((r) => setTimeout(r, SHORT_MS * 3));
  });
});

describe("row 20: preflight cause", () => {
  test("cause rules: the timeout message is PDF_BRIDGE_TIMEOUT; an unreachable bridge stays PDF_ENGINE_MISSING", () => {
    const timeout = layCausesOf(["render bridge not ready: render bridge handshake timed out after 8000 ms (the Swarm app did not answer)"]);
    expect(timeout.causes.map((c) => c.code)).toEqual(["PDF_BRIDGE_TIMEOUT"]);
    expect(timeout.requiresOperatorAction).toBe(true);
    expect(timeout.causes[0].message).not.toMatch(/PDF_ENGINE_MISSING|tidak terjangkau/);
    const missing = layCausesOf(["render bridge not ready: Render bridge unavailable (is the Swarm app running? see engine/browser log)"]);
    expect(missing.causes.map((c) => c.code)).toEqual(["PDF_ENGINE_MISSING"]);
  });

  test("dead bridge end to end: readiness -> assertPdfRenderReady gives PDF_BRIDGE_TIMEOUT within the bound, not PDF_ENGINE_MISSING", async () => {
    runtime.setRenderBridgeTransport(() => new Promise(() => {}));
    const t0 = performance.now();
    const e = (await errOf(
      assertPdfRenderReady(["pdf"], async () => {
        // Same body as bridgePdfReadiness, with the injected short limit.
        const errors: string[] = [];
        try {
          await runtime.bridgeHandshake({ timeoutMs: SHORT_MS });
        } catch (err) {
          errors.push(`render bridge not ready: ${(err as Error).message}`);
        }
        return { ready: errors.length === 0, errors, checkedAt: new Date().toISOString() };
      }),
    )) as Error & { code?: string; details?: { causes: Array<{ code: string }>; stage: string } };
    expect(performance.now() - t0).toBeLessThan(CEILING_MS);
    expect(e.code).toBe("PDF_ENGINE_UNAVAILABLE");
    expect(e.details?.stage).toBe("preflight");
    expect(e.details?.causes.map((c) => c.code)).toEqual(["PDF_BRIDGE_TIMEOUT"]);
  });

  test("bridge not configured (no socket env): still PDF_ENGINE_MISSING through the real bridgePdfReadiness", async () => {
    runtime.setRenderBridgeTransport(null);
    const r = await bridgePdfReadiness({ force: true });
    expect(r.ready).toBe(false);
    expect(layCausesOf(r.errors).causes.map((c) => c.code)).toEqual(["PDF_ENGINE_MISSING"]);
  });
});
