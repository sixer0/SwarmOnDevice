// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/renderers/implw10-chart-edge.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
// IMPL-W10 (review 17 #4): ruang tepi kiri 0,4 mm (LABEL_EDGE_MM, IMPL-W5 D1) juga untuk label kategori P-05 galeri dan
// P-06 datum (sebelumnya ujung label di x0 - 1,6 mm dengan talang = lebar + 1,6 mm, jadi tepi kiri label terlebar = 0 mm),
// dan `gutterPlan` tidak pernah melampaui `capMm`.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from '../_vitest';
import { renderChart } from '@/lib/studio/engine/chart/core';
import { withFit } from '@/lib/studio/engine/chart/core/fit';
import { gutterPlan, LABEL_EDGE_MM } from '@/lib/studio/engine/chart/core/labelfit';
import { measure } from '@/lib/studio/engine/chart/core/textfit';

const FIX = path.resolve(__dirname, '../_fixtures/tests/parity/fixtures/chart');
const spec = (file: string) => JSON.parse(readFileSync(path.join(FIX, file), 'utf8')) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Label rata kanan yang dikenal: tepi kiri (mm) = x - lebar glif nyata pada ukuran dan wajah yang tercetak. */
function leftEdges(svg: string, labels: readonly string[]) {
  const out: Array<{ text: string; left: number }> = [];
  for (const m of svg.matchAll(/<text\b([^>]*)>([^<]*)<\/text>/g)) {
    const text = m[2].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    if (!/text-anchor="end"/.test(m[1]) || !labels.includes(text)) continue;
    const x = Number(/\bx="([-\d.]+)"/.exec(m[1])?.[1]);
    const pt = (Number(/font-size="([\d.]+)"/.exec(m[1])?.[1]) * 72) / 25.4;
    const face = /font-family="IBM Plex Mono/.test(m[1]) ? ('data' as const) : ('struct' as const);
    out.push({ text, left: x - measure(text, pt, face) });
  }
  return out;
}

const LABELS = ['Lokasi Wawasan Mitra Waduk', 'Medium-High MMW', 'Low-Medium'];
/** Koordinat SVG dicetak dengan 2 desimal: toleransi pembulatan 0,005 mm. */
const EDGE_MIN = LABEL_EDGE_MM - 0.005;

describe('IMPL-W10: tepi kiri label kategori >= 0,4 mm (P-05 galeri, P-06 datum)', () => {
  it('P-05 galeri: label grup terlebar menyisakan LABEL_EDGE_MM', () => {
    const s = spec('p05.json');
    s.style = 'gallery';
    s.data.groups = s.data.groups.slice(0, 3).map((g: { values: number[] }, i: number) => ({ ...g, name: LABELS[i] }));
    const edges = leftEdges(renderChart(s as never).svg, LABELS);
    expect(edges.length).toBe(3);
    for (const e of edges) expect(e.left, e.text).toBeGreaterThanOrEqual(EDGE_MIN);
  });

  it('P-06 datum: label baris terlebar menyisakan LABEL_EDGE_MM', () => {
    const s = spec('p06.json');
    s.style = 'datum';
    s.data.categories = s.data.categories.map((c: string, i: number) => LABELS[i % 3] + (i >= 3 ? ` ${i}` : ''));
    const names = s.data.categories as string[];
    const edges = leftEdges(renderChart(s as never).svg, names);
    expect(edges.length).toBe(names.length);
    for (const e of edges) expect(e.left, e.text).toBeGreaterThanOrEqual(EDGE_MIN);
  });

  it('keluarga lain yang sudah 0,4 mm tidak berubah: P-04 dan P-06 galeri tetap >= 0,4 mm', () => {
    for (const [file, style] of [['p04.json', 'datum'], ['p06.json', 'gallery']] as const) {
      const s = spec(file);
      s.style = style;
      const cats: string[] = s.data.categories ?? s.data.points?.map((p: { label: string }) => p.label) ?? [];
      const edges = leftEdges(renderChart(s as never).svg, cats);
      for (const e of edges) expect(e.left, `${file} ${style} ${e.text}`).toBeGreaterThanOrEqual(EDGE_MIN);
    }
  });
});

describe('IMPL-W10: gutterPlan tidak melampaui capMm', () => {
  it('label sangat panjang: gutterMm <= capMm, ruang tepi tetap di dalam cap', () => {
    const font = { pt: 6.4, face: 'struct' as const };
    const long = ['Dinas Pekerjaan Umum dan Penataan Ruang Kabupaten Bandung Barat', 'B'];
    const plan = withFit({ widthMm: 120, notes: [] }, () => gutterPlan(long, font, { currentMm: 10, capMm: 20, padMm: 1.6, pitchMm: 5 }));
    expect(plan).not.toBeNull();
    expect(plan!.gutterMm).toBeLessThanOrEqual(20 + 1e-9);
    const widest = Math.max(...plan!.lines.flat().map((l) => measure(l, font.pt, font.face)));
    // Ruang tepi tetap utuh di dalam cap: baris terlebar + ruang tepi + pad <= talang.
    expect(widest + LABEL_EDGE_MM + 1.6).toBeLessThanOrEqual(plan!.gutterMm + 1e-9);
  });

  it('label yang muat dengan ruang tepi: talang = teks + LABEL_EDGE_MM + pad (perilaku IMPL-W5 tetap)', () => {
    const font = { pt: 6.4, face: 'struct' as const };
    const plan = withFit({ widthMm: 120, notes: [] }, () => gutterPlan(['Low-Medium-High'], font, { currentMm: 6, capMm: 40, padMm: 1.6, pitchMm: 5 }));
    expect(plan).not.toBeNull();
    expect(plan!.gutterMm).toBeCloseTo(measure('Low-Medium-High', 6.4) + LABEL_EDGE_MM + 1.6, 6);
  });
});
