// Swarm 1.2.6 row 55a (M-04): adaptive raster limit for rasterizeSvg.
// A fake bridge transport answers the first png op in 31 s (cold render of a figure with many text
// elements). The old fixed 30 s page limit failed with RENDER_TIMEOUT; the adaptive limit
// min(RASTER_TIMEOUT_MAX_MS, STUDIO_CHROMIUM_TIMEOUT_MS + labels x RASTER_TIMEOUT_PER_LABEL_MS) lets it succeed.
// The timeout-ladder invariants I-1..I-5 are tested by row 55 (desktop timeout-ladder.test.ts), not here.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BridgeTransport } from "../../vendor/src/lib/studio/engine/browser/runtime";

const PKG = path.resolve(import.meta.dir, "..", "..");
const STUDIO = path.join(PKG, "vendor", "src", "lib", "studio");
const SCRATCH = realpathSync(mkdtempSync(path.join(tmpdir(), "row55a-")));

process.env.STUDIO_ASSETS_ROOT = path.join(STUDIO, "assets");
process.env.STUDIO_WORKSPACE_ROOT = path.join(SCRATCH, "ws");
mkdirSync(process.env.STUDIO_WORKSPACE_ROOT, { recursive: true });
delete process.env.DATUM_RENDER_SOCKET;
delete process.env.DATUM_RENDER_TOKEN;
delete process.env.STUDIO_CHROMIUM_QUEUE_WAIT_MS;

const env = (await import("../../vendor/src/lib/studio/contract/env")) as Record<string, unknown>;
const runtime = await import("../../vendor/src/lib/studio/engine/browser/runtime");
const browser = await import("../../vendor/src/lib/studio/engine/browser/index");

function crc32(b: Uint8Array): number {
  let c = 0xffffffff;
  for (const x of b) {
    c ^= x;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
/** Header-only PNG of the requested size (readPngSize/withPngDpi read IHDR and chunks only). */
function fakePng(w: number, h: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", Buffer.from([0x78, 0x9c, 0x63, 0, 0, 0, 1, 0, 1])), chunk("IEND", Buffer.alloc(0))]);
}

const GOOD_INFO = { electron: "42.3.3", chrome: "142.0.0.0", partition: "datum-render", sandbox: true, contextIsolation: true, nodeIntegration: false, javascriptContent: false, network: "blocked", fonts: 20, scripts: ["studio.measure"] };

const SLOW_MS = 31_000;
const LABELS = 120;

/** Figure with LABELS text elements: adaptive limit = min(120000, 30000 + 120 x 250) = 60000 ms. */
function manyLabelSvg(): string {
  const texts = Array.from({ length: LABELS }, (_, k) => `<text x="${2 + (k % 12) * 10}" y="${4 + Math.floor(k / 12) * 5}" font-size="3">L${k}</text>`).join("");
  return `<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="128mm" height="60mm" viewBox="0 0 128 60"><rect width="128" height="60" fill="#fff"/>${texts}</svg>`;
}

afterEach(() => {
  runtime.setRenderBridgeTransport(null);
});

describe("M-04 constants equal the register (N-045..N-048)", () => {
  test("RASTER_TIMEOUT_MAX_MS 120000, RASTER_TIMEOUT_PER_LABEL_MS 250, BRIDGE_READ_MARGIN_MS 45000, BROWSER_QUEUE_WAIT_MS_DEFAULT 240000", () => {
    expect(env.RASTER_TIMEOUT_MAX_MS).toBe(120000);
    expect(env.RASTER_TIMEOUT_PER_LABEL_MS).toBe(250);
    expect((runtime as Record<string, unknown>).BRIDGE_READ_MARGIN_MS).toBe(45000);
    expect(runtime.BROWSER_QUEUE_WAIT_MS_DEFAULT).toBe(240000);
    expect(runtime.browserQueueLimits().maxWaitMs).toBe(240000);
  });
});

describe("M-04 rasterizeSvg adaptive limit", () => {
  test(
    "fake bridge answers the first png in 31 s for a figure with many text elements: rasterizeSvg succeeds",
    async () => {
      const seen: Array<{ op: string; timeoutMs?: number; at: number }> = [];
      const t0 = Date.now();
      let pngCalls = 0;
      const transport: BridgeTransport = async (req, opts?: { timeoutMs?: number }) => {
        seen.push({ op: req.op, timeoutMs: opts?.timeoutMs, at: Date.now() - t0 });
        if (req.op === "hello") return { ok: true, ...GOOD_INFO };
        if (req.op === "png") {
          if (pngCalls++ === 0) await new Promise((r) => setTimeout(r, SLOW_MS));
          writeFileSync(String(req.dst), fakePng(Number(req.width), Number(req.height)));
          return { ok: true, electron: "42.3.3", dst: req.dst, width: req.width, height: req.height };
        }
        return { ok: false, code: "UNKNOWN_OP", message: "?" };
      };
      runtime.setRenderBridgeTransport(transport);
      const png = await browser.rasterizeSvg(manyLabelSvg(), { widthMm: 128, heightMm: 60, dpi: 300 });
      expect(png.byteLength).toBeGreaterThan(0);
      const pngs = seen.filter((s) => s.op === "png");
      expect(pngs.length).toBeGreaterThanOrEqual(2);
      // The per-op limit reaches the transport, so the socket read waits limit + BRIDGE_READ_MARGIN_MS.
      expect(pngs[0].timeoutMs).toBe(30000 + LABELS * 250);
      expect(Date.now() - t0).toBeGreaterThanOrEqual(SLOW_MS);
    },
    90_000,
  );
});
