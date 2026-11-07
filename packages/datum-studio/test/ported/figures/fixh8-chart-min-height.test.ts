// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/figures/fixh8-chart-min-height.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
// FIX-H8 (D-322, uji Hermes E): tinggi minimum terbaca chart batang dengan sedikit kategori.
// Aturan: badan keluarga batang (P-01 bar, P-11 threshold) gaya datum >= 32 mm
// (= PANEL_DEFAULT_PLOT_MM Manual 000 Gambar 8.1) hanya bila DC `n * 7,2 + 6 < 32`
// (n <= 3); n >= 4, kolom (P-02/W-02) dan gaya gallery tetap rumus DC persis.
import { describe, expect, it } from '../_vitest';
import type { StudioChartV1 } from '@/lib/studio/contract';
import {
  BAR_MAX_THICK_MM,
  BAR_MIN_BODY_MM,
  PANEL_DEFAULT_PLOT_MM,
  barRows,
  dcHeightMm,
  estimateHeightMm,
  renderChart,
  renderComposite,
} from '@/lib/studio/engine/chart/core';

function spec(kind: StudioChartV1['kind'], n: number, extra: Partial<StudioChartV1> = {}): StudioChartV1 {
  const points = Array.from({ length: n }, (_, i) => ({ label: `Kategori ${i + 1}`, value: (n - i) * 3 }));
  return { kind, widthMm: 128, title: 'Uji.', source: 'Data uji sintetis.', data: { shape: 'categorical', points }, unit: 'unit', dec: 0, ...extra } as StudioChartV1;
}

function bars(svg: string): Array<{ y: number; h: number }> {
  return [...svg.matchAll(/<rect\b[^>]*data-mark="bar"[^>]*>/g)].map((m) => ({
    y: Number(/\sy="([-0-9.]+)"/.exec(m[0])![1]),
    h: Number(/\sheight="([-0-9.]+)"/.exec(m[0])![1]),
  }));
}

describe('FIX-H8 tinggi minimum chart batang', () => {
  it('ambang = tinggi plot panel bawaan Manual 000 (satu nilai, tanpa angka ajaib kedua)', () => {
    expect(BAR_MIN_BODY_MM).toBe(PANEL_DEFAULT_PLOT_MM);
    expect(BAR_MAX_THICK_MM).toBeCloseTo(8.8, 9);
  });

  it('n >= 4: tinggi dan geometri = DC persis (paritas Python tidak tersentuh)', () => {
    for (const n of [4, 5, 6, 12]) {
      expect(estimateHeightMm(spec('P-01', n))).toBe(n * 7.2 + 6);
      expect(estimateHeightMm(spec('P-11', n))).toBe(n * 7.2 + 6 + 5);
      expect(barRows(n)).toEqual({ pitch: 7.2, thick: 4.4, inset: 0, scaled: false });
      const r = renderChart(spec('P-01', n));
      expect(r.report.issues.some((i) => i.checkId === 'BAR_MIN_HEIGHT')).toBe(false);
      expect(bars(r.svg).every((b) => Math.abs(b.h - 4.4) < 1e-6)).toBe(true);
    }
  });

  it('n = 2 (kasus Hermes P-01): 20,4 mm -> 32 mm, batang 7,94 mm, REPORT tercatat', () => {
    const s = spec('P-01', 2);
    expect(dcHeightMm(s, 'bar')).toBeCloseTo(20.4, 9);
    expect(estimateHeightMm(s)).toBe(32);
    const r = renderChart(s);
    expect(r.heightMm).toBe(32);
    const b = bars(r.svg);
    expect(b).toHaveLength(2);
    for (const x of b) expect(x.h).toBeCloseTo((13 * 4.4) / 7.2, 2);
    expect(b[1].y - b[0].y).toBeCloseTo(13, 2);
    // Batang terakhir + garis dasar tetap di dalam kanvas.
    expect(b[1].y + b[1].h + 1.4).toBeLessThan(32);
    const rep = r.report.issues.find((i) => i.checkId === 'BAR_MIN_HEIGHT');
    expect(rep?.status).toBe('REPORT');
  });

  it('n = 1: tebal dibatasi 2 x token (8,8 mm), batang di tengah slot', () => {
    const r = renderChart(spec('P-01', 1));
    expect(r.heightMm).toBe(32);
    const [b] = bars(r.svg);
    expect(b.h).toBeCloseTo(8.8, 2);
    const slot = 26;
    const prop = (slot * 4.4) / 7.2;
    expect(b.y).toBeCloseTo(3 + (prop - 8.8) / 2, 2);
  });

  it('n = 3 dan threshold P-11 n = 2: aturan sama, pita tambahan (catatan, limit, aparatus) tetap ditambahkan', () => {
    expect(estimateHeightMm(spec('P-01', 3))).toBe(32);
    expect(estimateHeightMm(spec('P-11', 2, { limit: 10 } as Partial<StudioChartV1>))).toBe(32 + 5);
    expect(estimateHeightMm(spec('P-01', 2, { note: 'Catatan.' } as Partial<StudioChartV1>))).toBe(32 + 6);
  });

  it('kolom P-02/W-02 dan gaya gallery tidak berubah', () => {
    expect(estimateHeightMm(spec('P-02', 2))).toBe(46);
    expect(estimateHeightMm(spec('P-01', 2, { style: 'gallery' } as Partial<StudioChartV1>))).toBeCloseTo(20.4, 9);
  });

  it('panel komposit lebih pendek dari ambang: geometri DC tetap (tanpa luapan)', () => {
    const r = renderComposite({
      kind: 'composite',
      widthMm: 166,
      title: 'Uji.',
      source: 'Data uji sintetis.',
      composite: {
        columns: 2,
        panels: [
          { name: 'Dua', code: 'P-01', spec: { kind: 'P-01', style: 'datum', heightMm: 20, data: spec('P-01', 2).data } },
          { name: 'Enam', code: 'P-01', spec: { kind: 'P-01', style: 'datum', heightMm: 20, data: spec('P-01', 6).data } },
        ],
      },
    } as never);
    const b = bars(r.svg);
    expect(b.length).toBe(8);
    expect(b.every((x) => Math.abs(x.h - 4.4) < 1e-6)).toBe(true);
  });
});
