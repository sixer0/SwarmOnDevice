// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/renderers/implw4-chart-raster.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
/* eslint-disable @typescript-eslint/no-explicit-any -- snapshot JSON dibaca bebas-bentuk di uji */
// IMPL-W4 butir 4 (D-544/D-547): label kategori Gambar 6.1 ("Medium-High", "Low-Medium") terpotong di tepi kiri PNG
// DOCX r5 dan r5b (PNG identik byte). Direproduksi dengan data r5b RV-4 lewat jalur render DOCX yang sama
// (compose v2 -> pureChartSvg -> rasterizeSvg Chromium 300 dpi): PNG lama sha ae6dfcb8... = PNG di DOCX r5b.
// Akar: halaman raster memakai fon sistem; "IBM Plex Sans Condensed" jatuh ke Plex Sans (lebih lebar) dan
// "IBM Plex Mono" ke serif bawaan, sedangkan geometri + lint diukur dengan metrik Plex Condensed. Perbaikan: fon Plex
// yang dirujuk SVG ditanam di halaman raster (SVG tidak berubah). Uji ini membaca piksel PNG.
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { afterAll, describe, expect, it } from '../_vitest';
import { getStudioEnv, resetStudioEnvCache } from '@/lib/studio/contract/env';
import { closeBrowser, rasterizeSvg } from '@/lib/studio/engine/browser';
import { rasterFontCss, svgFontFamilies } from '@/lib/studio/engine/browser/raster-fonts';
import { CHART_LINT_OPTIONS, lintChartGeometry } from '@/lib/studio/engine/chart/core/geometry';
import { composeV2 } from '@/lib/studio/services/compose';
import { pureChartSvg } from '@/lib/studio/services/render/pure/chart';
import { datumSlots, defaultParams, e1, merge, skeletonInput } from '../structure/_kit';
import { benchmarkTemplate } from './_kit';

/** Data RV-4 (doc_ud2b/source/revisi.md): kategori Likelihood, seri Impact, batang bertumpuk. */
const RV4 = {
  type: 'chart', code: 'K-01', caption: { text: 'Jumlah ancaman per tingkat Likelihood dan Impact (Table 6.1)' }, source: { text: 'Table 6.1, bab 6 dokumen ini' },
  data: { shape: 'series', categories: ['High', 'Medium-High', 'Medium', 'Low-Medium', 'Low', 'N/A'], series: [{ name: 'Critical', values: [0, 0, 1, 1, 0, 1] }, { name: 'High', values: [1, 0, 5, 2, 3, 0] }, { name: 'Medium', values: [3, 1, 2, 1, 0, 0] }] },
};

async function rv4Svg() {
  const d = e1();
  d.sections.content.chapters[1].sections[0].blocks.push(structuredClone(RV4));
  const slots = datumSlots();
  const snap: any = composeV2({ source: merge(d, undefined, { slots }).doc, skeleton: skeletonInput(slots), params: defaultParams() }).snapshot;
  const spec = snap.blocks.find((b: any) => b.type === 'chart').content.spec;
  return pureChartSvg(spec, await benchmarkTemplate());
}

/** Dekoder PNG kecil (8 bit, RGB/RGBA, tanpa interlace) -> fungsi kecerahan piksel. */
function decodePng(png: Uint8Array) {
  const b = Buffer.from(png);
  const w = b.readUInt32BE(16);
  const h = b.readUInt32BE(20);
  const ct = b[25];
  const bpp = ct === 6 ? 4 : 3;
  const idat: Buffer[] = [];
  for (let o = 8; o < b.length; ) {
    const len = b.readUInt32BE(o);
    const type = b.toString('ascii', o + 4, o + 8);
    if (type === 'IDAT') idat.push(b.subarray(o + 8, o + 8 + len));
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
  const lum = (x: number, y: number) => {
    const i = y * stride + x * bpp;
    return (px[i] + px[i + 1] + px[i + 2]) / 3;
  };
  return { w, h, lum };
}

/** Piksel bertinta (lebih gelap dari kertas) di kolom x, seluruh tinggi. */
const inkInColumn = (img: ReturnType<typeof decodePng>, x: number) => {
  let n = 0;
  for (let y = 0; y < img.h; y++) if (img.lum(x, y) < 200) n++;
  return n;
};

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

describe('IMPL-W4 butir 4: label kategori grafik bertumpuk tidak terpotong di PNG DOCX', () => {
  const avail = chromiumAvailability();
  afterAll(async () => {
    if (avail.ok) await closeBrowser();
  }, 30_000);

  it('SVG RV-4 bersih menurut lint geometri dan merujuk keluarga Plex yang ditanam di halaman raster', async () => {
    const r = await rv4Svg();
    expect(lintChartGeometry(r.svg, CHART_LINT_OPTIONS).counts).toEqual({ textOverlap: 0, textOutside: 0, textStraddleMark: 0, lineThroughText: 0 });
    expect(svgFontFamilies(r.svg)).toEqual(expect.arrayContaining(['IBM Plex Sans Condensed', 'IBM Plex Mono']));
    const f = rasterFontCss(r.svg);
    expect(f.families).toEqual(expect.arrayContaining(['IBM Plex Sans Condensed', 'IBM Plex Mono']));
    expect(f.css).toContain('font-family:"IBM Plex Sans Condensed"');
  });

  // row42 W8: vitest passes a test context (ctx.skip); bun:test treats a 1-arg test fn as a done-callback. Same guard as it.skipIf (no Chromium here: playwright-core is not installed; the engine reaches Chromium only through the Electron render bridge, row 108).

  it.skipIf(!avail.ok)('PNG 300 dpi: tidak ada tinta label di kolom tepi kiri/kanan; "IBM Plex Mono" bukan serif cadangan', async () => {
    const r = await rv4Svg();
    const img = decodePng(await rasterizeSvg(r.svg, { widthMm: r.widthMm, heightMm: r.heightMm, dpi: 300 }));
    for (const x of [0, 1, 2]) expect(inkInColumn(img, x), `kolom x=${x}`).toBe(0);
    for (const x of [img.w - 1, img.w - 2]) expect(inkInColumn(img, x), `kolom x=${x}`).toBe(0);
    const probe = (fam: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="40mm" height="8mm" viewBox="0 0 40 8"><rect width="40" height="8" fill="#fff"/><text x="1" y="6" font-family="${fam}" font-size="4">Medium-High 0248</text></svg>`;
    const mono = Buffer.from(await rasterizeSvg(probe('IBM Plex Mono'), { widthMm: 40, heightMm: 8, dpi: 300 }));
    const serif = Buffer.from(await rasterizeSvg(probe('NoSuchFontXyz'), { widthMm: 40, heightMm: 8, dpi: 300 }));
    expect(mono.equals(serif)).toBe(false);
  }, 120_000);
});
