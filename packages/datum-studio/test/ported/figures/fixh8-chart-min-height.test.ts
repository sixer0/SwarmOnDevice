// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/figures/fixh8-chart-min-height.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
// INTENDED CHANGE (Swarm 1.2.6 row 65, T-09, decision U14 reverses D-322; 01g_spec_tests.md lists this file).
// Was: FIX-H8 raised the body of the datum bar family (P-01 bar, P-11 threshold) to 32 mm for n <= 3
// categories and thickened the bars (BAR_MAX_THICK_MM 8.8 mm), noted as BAR_MIN_HEIGHT.
// Now: honest DC geometry for every n (body n * 7.2 + 6 mm, bars 4.4 mm, lengths proportional to the data);
// BAR_MIN_BODY_MM (32 mm = PANEL_DEFAULT_PLOT_MM) is only a threshold, and a body below it gets one
// BAR_SUBMIN REPORT note. BAR_MAX_THICK_MM (N-028) and BAR_MIN_HEIGHT (N-027) are retired;
// BarRows.scaled (N-029) is always false. Columns (P-02/W-02) and the gallery style are unchanged.
import { describe, expect, it } from '../_vitest';
import type { StudioChartV1 } from '@/lib/studio/contract';
import {
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

const DC_ROWS = { pitch: 7.2, thick: 4.4, inset: 0, scaled: false };

describe('T-09 (U14) geometri batang jujur, ambang BAR_SUBMIN', () => {
  it('ambang = tinggi plot panel bawaan Manual 000; BAR_MAX_THICK_MM pensiun', async () => {
    expect(BAR_MIN_BODY_MM).toBe(PANEL_DEFAULT_PLOT_MM);
    const core = await import('@/lib/studio/engine/chart/core');
    expect('BAR_MAX_THICK_MM' in core).toBe(false);
  });

  it('n >= 4: tinggi dan geometri = DC persis, tanpa catatan', () => {
    for (const n of [4, 5, 6, 12]) {
      expect(estimateHeightMm(spec('P-01', n))).toBe(n * 7.2 + 6);
      expect(estimateHeightMm(spec('P-11', n))).toBe(n * 7.2 + 6 + 5);
      expect(barRows(n)).toEqual(DC_ROWS);
      const r = renderChart(spec('P-01', n));
      expect(r.report.issues.some((i) => i.checkId === 'BAR_SUBMIN' || i.checkId === 'BAR_MIN_HEIGHT')).toBe(false);
      expect(bars(r.svg).every((b) => Math.abs(b.h - 4.4) < 1e-6)).toBe(true);
    }
  });

  it('n = 2 (kasus Hermes P-01): badan tetap 20,4 mm, batang 4,4 mm, satu REPORT BAR_SUBMIN', () => {
    const s = spec('P-01', 2);
    expect(barRows(2)).toEqual(DC_ROWS);
    expect(dcHeightMm(s, 'bar')).toBeCloseTo(20.4, 9);
    expect(estimateHeightMm(s)).toBeCloseTo(20.4, 9);
    const r = renderChart(s);
    expect(r.heightMm).toBeCloseTo(20.4, 9);
    const b = bars(r.svg);
    expect(b).toHaveLength(2);
    for (const x of b) expect(x.h).toBeCloseTo(4.4, 6);
    expect(b[1].y - b[0].y).toBeCloseTo(7.2, 6);
    // Batang terakhir + garis dasar tetap di dalam kanvas.
    expect(b[1].y + b[1].h + 1.4).toBeLessThan(r.heightMm);
    const rep = r.report.issues.filter((i) => i.checkId === 'BAR_SUBMIN');
    expect(rep).toHaveLength(1);
    expect(rep[0].status).toBe('REPORT');
    expect(rep[0].detail).toContain('20.4 mm');
    expect(rep[0].detail).toContain('32 mm');
    expect(r.report.issues.some((i) => i.checkId === 'BAR_MIN_HEIGHT')).toBe(false);
  });

  it('n = 1: tebal tetap token DC 4,4 mm di y = 3 (tidak ada blok yang diperbesar)', () => {
    const r = renderChart(spec('P-01', 1));
    expect(r.heightMm).toBeCloseTo(13.2, 9);
    const [b] = bars(r.svg);
    expect(b.h).toBeCloseTo(4.4, 6);
    expect(b.y).toBeCloseTo(3, 6);
    expect(r.report.issues.filter((i) => i.checkId === 'BAR_SUBMIN')).toHaveLength(1);
  });

  it('n = 3 dan threshold P-11 n = 2: rumus DC, pita tambahan (catatan, limit) tetap ditambahkan', () => {
    expect(estimateHeightMm(spec('P-01', 3))).toBeCloseTo(27.6, 9);
    expect(estimateHeightMm(spec('P-11', 2, { limit: 10 } as Partial<StudioChartV1>))).toBeCloseTo(20.4 + 5, 9);
    expect(estimateHeightMm(spec('P-01', 2, { note: 'Catatan.' } as Partial<StudioChartV1>))).toBeCloseTo(20.4 + 6, 9);
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
