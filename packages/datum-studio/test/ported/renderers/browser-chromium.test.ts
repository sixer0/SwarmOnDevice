// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/renderers/browser-chromium.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
// S72: engine/browser (S25). Bagian murni (PNG pHYs, ukuran) selalu jalan;
// bagian Chromium hanya bila playwright-core terpasang DAN biner Chromium
// render-env ada (skip jujur bila tidak). Rasterisasi mengikuti D-94:
// viewport ceil(px CSS), skala dpi/96, PNG bertanda 300 dpi.
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { afterAll, describe, expect, it } from '../_vitest';
import { getStudioEnv, resetStudioEnvCache } from '@/lib/studio/contract/env';
import { closeBrowser, rasterizeSvg, readPngSize, withPngDpi } from '@/lib/studio/engine/browser';
import { makePng, pngInfo, sha256 } from './_kit';

const PX_PER_M_300DPI = Math.round(300 / 0.0254); // 11811

describe('PNG pHYs (murni)', () => {
  it('withPngDpi menanam pHYs 300 dpi (11811 px/m, satuan meter) tanpa mengubah ukuran', () => {
    const src = makePng(30, 10);
    const out = withPngDpi(src, 300);
    expect(pngInfo(out)).toMatchObject({ width: 30, height: 10, physX: PX_PER_M_300DPI, physY: PX_PER_M_300DPI, unit: 1 });
    expect(readPngSize(out)).toEqual({ widthPx: 30, heightPx: 10 });
  });
  it('withPngDpi idempoten (pHYs tidak digandakan)', () => {
    const once = withPngDpi(makePng(5, 5), 300);
    const twice = withPngDpi(once, 300);
    expect(Buffer.from(twice).toString('latin1').split('pHYs').length - 1).toBe(1);
  });
  it('readPngSize: bukan PNG -> null', () => {
    expect(readPngSize(new TextEncoder().encode('GIF89a......................'))).toBeNull();
  });
});

function chromiumAvailability(): { ok: boolean; reason: string } {
  try {
    createRequire(__filename).resolve('playwright-core');
  } catch {
    return { ok: false, reason: 'playwright-core tidak terpasang' };
  }
  resetStudioEnvCache();
  const p = getStudioEnv().chromiumPath;
  return existsSync(p) ? { ok: true, reason: '' } : { ok: false, reason: `biner Chromium tidak ada: ${p}` };
}

describe('rasterizeSvg lewat Chromium', () => {
  const avail = chromiumAvailability();
  afterAll(async () => {
    if (avail.ok) await closeBrowser();
  }, 30_000);

  const SVG = (fill: string) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="128mm" height="40mm" viewBox="0 0 128 40">` +
    `<rect x="0" y="0" width="128" height="40" fill="#FFFFFF"/><rect x="10" y="10" width="60" height="20" fill="${fill}"/></svg>`;

  // row42 W8: vitest passes a test context (ctx.skip); bun:test treats a 1-arg test fn as a done-callback. Same guard as it.skipIf (no Chromium here: playwright-core is not installed; the engine reaches Chromium only through the Electron render bridge, row 108).

  it.skipIf(!avail.ok)('SVG 128 x 40 mm -> PNG 300 dpi; lebar dalam toleransi D-94 (<= ideal, kurang < 1 px CSS)', async () => {
    const png = await rasterizeSvg(SVG('#101418'), { widthMm: 128, heightMm: 40, dpi: 300 });
    const info = pngInfo(png)!;
    expect(info).not.toBeNull();
    expect(info.physX).toBe(PX_PER_M_300DPI);
    const idealW = (128 / 25.4) * 300; // 1511.8
    const idealH = (40 / 25.4) * 300; // 472.4
    const cssPx = 300 / 96; // 1 px CSS = 3,125 px perangkat
    expect(Math.abs(info.width - idealW)).toBeLessThanOrEqual(cssPx + 1);
    expect(Math.abs(info.height - idealH)).toBeLessThanOrEqual(cssPx + 1);
  }, 120_000);

  // row42 W8: vitest passes a test context (ctx.skip); bun:test treats a 1-arg test fn as a done-callback. Same guard as it.skipIf (no Chromium here: playwright-core is not installed; the engine reaches Chromium only through the Electron render bridge, row 108).

  it.skipIf(!avail.ok)('deterministik: SVG sama -> PNG identik; isi berbeda -> PNG berbeda', async () => {
    const a = await rasterizeSvg(SVG('#101418'), { widthMm: 128, heightMm: 40, dpi: 300 });
    const b = await rasterizeSvg(SVG('#101418'), { widthMm: 128, heightMm: 40, dpi: 300 });
    const c = await rasterizeSvg(SVG('#B45309'), { widthMm: 128, heightMm: 40, dpi: 300 });
    expect(sha256(b)).toBe(sha256(a));
    expect(sha256(c)).not.toBe(sha256(a));
  }, 120_000);

  // row42 W8: vitest passes a test context (ctx.skip); bun:test treats a 1-arg test fn as a done-callback. Same guard as it.skipIf (no Chromium here: playwright-core is not installed; the engine reaches Chromium only through the Electron render bridge, row 108).

  it.skipIf(!avail.ok)('masukan bukan SVG ditolak (INPUT_INVALID) tanpa meluncurkan render', async () => {
    await expect(rasterizeSvg('<html><body>x</body></html>', { widthMm: 10, heightMm: 10, dpi: 300 })).rejects.toMatchObject({
      reason: 'INPUT_INVALID',
    });
    await expect(rasterizeSvg('<svg xmlns="http://www.w3.org/2000/svg"/>', { widthMm: -1, heightMm: 10, dpi: 300 })).rejects.toMatchObject({
      reason: 'INPUT_INVALID',
    });
  }, 60_000);

  // row42 W8: vitest passes a test context (ctx.skip); bun:test treats a 1-arg test fn as a done-callback. Same guard as it.skipIf (no Chromium here: playwright-core is not installed; the engine reaches Chromium only through the Electron render bridge, row 108).

  it.skipIf(!avail.ok)('SVG dengan rujukan eksternal tidak memicu jaringan (render tetap selesai, offline)', async () => {
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="20mm" height="20mm" viewBox="0 0 20 20">` +
      `<image href="http://127.0.0.1:9/x.png" width="20" height="20"/><rect width="5" height="5" fill="#000"/></svg>`;
    const png = await rasterizeSvg(svg, { widthMm: 20, heightMm: 20, dpi: 300 });
    expect(pngInfo(png)?.width).toBeGreaterThan(200);
  }, 120_000);
});
