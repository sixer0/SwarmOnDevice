// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/renderers/implw5-chart-gutter.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
/* eslint-disable @typescript-eslint/no-explicit-any -- snapshot JSON dibaca bebas-bentuk di uji */
// IMPL-W5 D1 (D-557, uji Hermes ronde 6): grafik batang bertumpuk horizontal (kategori High, Medium, Low-Medium, Low,
// N/A) memotong huruf pertama label terpanjang "Low-Medium" di tepi kiri PNG DOCX, padahal fon Plex sudah ditanam
// (IMPL-W4). Akar terukur: talang label kategori dihitung dengan taksiran rerata 0,5 em per glif (`textWidthMm`),
// sedangkan "Low-Medium" berlebar nyata 5,29 em (L, w, M, m lebar) > 5,0 em taksiran; label rata kanan di x0 - 1,6 mm
// sehingga meluber 0,26 mm ke kiri (di bawah toleransi lint 0,3 mm). "Medium-High" (5,49 em < 5,5 em taksiran) muat.
// Uji ini mengukur label dengan metrik glif nyata yang sama dengan rasteriser (textfit, Plex Sans Condensed) dan,
// bila Chromium tersedia, membaca piksel PNG.
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { afterAll, describe, expect, it } from '../_vitest';
import { getStudioEnv, resetStudioEnvCache } from '@/lib/studio/contract/env';
import { closeBrowser, rasterizeSvg } from '@/lib/studio/engine/browser';
import { measure } from '@/lib/studio/engine/chart/core/textfit';
import { composeV2 } from '@/lib/studio/services/compose';
import { pureChartSvg } from '@/lib/studio/services/render/pure/chart';
import { datumSlots, defaultParams, e1, merge, skeletonInput } from '../structure/_kit';
import { benchmarkTemplate } from './_kit';

const R6 = { categories: ['High', 'Medium', 'Low-Medium', 'Low', 'N/A'], series: [{ name: 'Critical', values: [1, 2, 1, 0, 1] }, { name: 'High', values: [2, 3, 1, 2, 0] }, { name: 'Medium', values: [1, 1, 2, 1, 0] }] };
const LONG = ['MMMMMMMMMMMMMMMMMMMMMMMM', 'Wawasan Mitra Waduk Wetan', 'Low-Medium', 'iiii'];

async function svgOf(block: Record<string, unknown>) {
  const d = e1();
  d.sections.content.chapters[1].sections[0].blocks.push({ type: 'chart', caption: { text: 'Uji talang label' }, source: { text: 'Uji IMPL-W5' }, ...block });
  const slots = datumSlots();
  const snap: any = composeV2({ source: merge(d, undefined, { slots }).doc, skeleton: skeletonInput(slots), params: defaultParams() }).snapshot;
  const spec = snap.blocks.find((b: any) => b.type === 'chart').content.spec;
  return pureChartSvg(spec, await benchmarkTemplate());
}

/** Teks rata kanan (label kategori) dari SVG: x, ukuran pt, teks. */
function endTexts(svg: string, labels: readonly string[]) {
  const out: Array<{ x: number; pt: number; text: string; face: 'data' | 'struct' }> = [];
  for (const m of svg.matchAll(/<text\b([^>]*)>([^<]*)<\/text>/g)) {
    const attrs = m[1];
    const text = m[2].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    // Label panjang boleh dipendekkan mesin dengan elipsis (teks lengkap di <title>); yang diukur = teks tercetak.
    const known = labels.includes(text) || (text.endsWith('…') && labels.some((l) => l.startsWith(text.slice(0, -1))));
    if (!/text-anchor="end"/.test(attrs) || !known) continue;
    const x = Number(/\bx="([-\d.]+)"/.exec(attrs)?.[1]);
    // font-size SVG grafik = satuan pengguna (mm); textfit.measure memakai pt.
    const mm = Number(/font-size="([\d.]+)"/.exec(attrs)?.[1]);
    const pt = (mm * 72) / 25.4;
    // Wajah sesuai keluarga yang benar-benar dicetak: Plex Mono = "data" (0,6 em tetap), selain itu Plex Sans Condensed.
    const face = /font-family="IBM Plex Mono/.test(attrs) ? ('data' as const) : ('struct' as const);
    out.push({ x, pt, text, face });
  }
  return out;
}

function decodePng(png: Uint8Array) {
  const b = Buffer.from(png);
  const w = b.readUInt32BE(16);
  const h = b.readUInt32BE(20);
  const bpp = b[25] === 6 ? 4 : 3;
  const idat: Buffer[] = [];
  for (let o = 8; o < b.length; ) {
    const len = b.readUInt32BE(o);
    if (b.toString('ascii', o + 4, o + 8) === 'IDAT') idat.push(b.subarray(o + 8, o + 8 + len));
    o += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  const px = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const v = raw[y * (stride + 1) + 1 + x];
      const a = x >= bpp ? px[y * stride + x - bpp] : 0;
      const up = y > 0 ? px[(y - 1) * stride + x] : 0;
      const ul = y > 0 && x >= bpp ? px[(y - 1) * stride + x - bpp] : 0;
      const p = a + up - ul;
      const pa = Math.abs(p - a), pb = Math.abs(p - up), pc = Math.abs(p - ul);
      const pr = f === 0 ? 0 : f === 1 ? a : f === 2 ? up : f === 3 ? (a + up) >> 1 : pa <= pb && pa <= pc ? a : pb <= pc ? up : ul;
      px[y * stride + x] = (v + pr) & 0xff;
    }
  }
  return { w, h, lum: (x: number, y: number) => (px[y * stride + x * bpp] + px[y * stride + x * bpp + 1] + px[y * stride + x * bpp + 2]) / 3 };
}
const inkInColumn = (img: ReturnType<typeof decodePng>, x: number) => {
  let n = 0;
  for (let y = 0; y < img.h; y++) if (img.lum(x, y) < 200) n++;
  return n;
};

function chromiumOk(): boolean {
  try {
    createRequire(__filename).resolve('playwright-core');
  } catch {
    return false;
  }
  resetStudioEnvCache();
  return existsSync(getStudioEnv().chromiumPath);
}

const CASES: Array<[string, Record<string, unknown>, readonly string[]]> = [
  ['K-01 bertumpuk horizontal (data r6)', { code: 'K-01', data: { shape: 'series', ...R6 } }, R6.categories],
  ['K-01 label sampai 24 karakter', { code: 'K-01', data: { shape: 'series', categories: LONG, series: [{ name: 'A', values: [1, 2, 3, 4] }, { name: 'B', values: [2, 1, 1, 0] }] } }, LONG],
  ['P-01 batang horizontal label panjang', { code: 'P-01', data: { shape: 'categorical', points: LONG.map((label, i) => ({ label, value: 10 + i })) } }, LONG],
];

describe('IMPL-W5 D1: talang label kategori grafik batang horizontal memuat label terlebar (metrik glif nyata)', () => {
  const browser = chromiumOk();
  afterAll(async () => {
    if (browser) await closeBrowser();
  }, 30_000);

  it.each(CASES)('%s: tepi kiri setiap label >= 0,2 mm dari tepi gambar', async (_n, block, labels) => {
    const r = await svgOf(block);
    const texts = endTexts(r.svg, labels);
    expect(texts.length, 'label kategori rata kanan ditemukan').toBeGreaterThanOrEqual(labels.length);
    for (const t of texts) {
      const left = t.x - measure(t.text, t.pt, t.face);
      expect(left, `${t.text}: x ${t.x} - lebar ${measure(t.text, t.pt, t.face).toFixed(2)} mm`).toBeGreaterThanOrEqual(0.2);
    }
  });

  // row42 W8: vitest passes a test context (ctx.skip); bun:test treats a 1-arg test fn as a done-callback. Same guard as it.skipIf (no Chromium here: playwright-core is not installed; the engine reaches Chromium only through the Electron render bridge, row 108).

  it.skipIf(!browser)('PNG 300 dpi data r6: kolom piksel tepi kiri tanpa tinta ("Low-Medium" utuh)', async () => {
    const r = await svgOf(CASES[0][1]);
    const img = decodePng(await rasterizeSvg(r.svg, { widthMm: r.widthMm, heightMm: r.heightMm, dpi: 300 }));
    for (const x of [0, 1, 2]) expect(inkInColumn(img, x), `kolom x=${x}`).toBe(0);
  }, 120_000);
});
