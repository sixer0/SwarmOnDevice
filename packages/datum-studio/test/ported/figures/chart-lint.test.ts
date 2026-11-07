// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/figures/chart-lint.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
// S73: lint keluaran chart (engine/chart/core/guards.ts) DATUM-25/26/28, tinggi acuan
// (core/heights.ts), dan penjaga titik panggil renderChart (IP-25 / D-108).
import { describe, it, expect } from '../_vitest';
import type { ChartCode, StudioChartV1 } from '@/lib/studio/contract';
import {
  CHART_REFERENCE_HEIGHT_MM,
  DEFAULT_HEIGHT_RATIO,
  EMPTY_CHART_TEMPLATE,
  FIGURE_APPARATUS_BAND_MM,
  FONT_PT_TOLERANCE,
  MM_PER_PT,
  accentSubjectKey,
  chartPalette,
  colorFamily,
  estimateHeightMm,
  isCoreCode,
  lintChartSvg,
  referenceHeightMm,
  renderChart,
  scanSvg,
} from '@/lib/studio/engine/chart/core';
import { CHART_REGISTRY } from '@/lib/studio/registry/charts';
import { catchErr, checkIdOf, chartSpecsByCode, clone } from './_helpers';

const SPECS = chartSpecsByCode();
const PAL = chartPalette({} as StudioChartV1, EMPTY_CHART_TEMPLATE);
const family = (h: string) => colorFamily(h, PAL);
const BASE_OPTS = { minFontPt: 5.5, maxColors: 5, family, widths: [128, 166] as const };

/** SVG 128 x 60 mm dengan satuan pengguna = mm. */
const svg = (body: string, w = 128, h = 60) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}mm" height="${h}mm" viewBox="0 0 ${w} ${h}">${body}</svg>`;
const fail = (l: { issues: Array<{ checkId: string; status: string }> }, id: string) =>
  l.issues.some((i) => i.checkId === id && i.status === 'FAIL');

/** Rona `pct`% dari kertas menuju `to` (hex tanpa #). */
function tint(to: string, pct: number, from = PAL.paper): string {
  const c = (h: string) => [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [F, T] = [c(from), c(to)];
  return F.map((f, i) => Math.round(f + ((T[i] - f) * pct) / 100).toString(16).padStart(2, '0')).join('').toUpperCase();
}

describe('DATUM-28 huruf minimum (toleransi 1e-3 pt)', () => {
  const mm = (pt: number) => pt * MM_PER_PT;

  it('toleransi = 1e-3 pt', () => {
    expect(FONT_PT_TOLERANCE).toBe(1e-3);
  });

  it('5,5 pt yang dibulatkan 2 desimal mm (1.94 = 5,4992 pt) lolos berkat toleransi', () => {
    const l = lintChartSvg(svg(`<text font-size="1.94">a</text>`), BASE_OPTS);
    expect(l.checksRun).toContain('DATUM-28');
    expect(fail(l, 'DATUM-28')).toBe(false);
  });

  it('di bawah toleransi (1.939 mm = 5,4964 pt) gagal', () => {
    expect(fail(lintChartSvg(svg(`<text font-size="1.939">a</text>`), BASE_OPTS), 'DATUM-28')).toBe(true);
  });

  it('font-size dalam pt dibaca sebagai pt fisik; huruf terkecil yang menentukan', () => {
    expect(fail(lintChartSvg(svg(`<text font-size="${mm(7).toFixed(5)}">a</text><text font-size="${mm(5).toFixed(5)}">b</text>`), BASE_OPTS), 'DATUM-28')).toBe(true);
    expect(fail(lintChartSvg(svg(`<text font-size="${mm(6).toFixed(5)}">a</text>`), BASE_OPTS), 'DATUM-28')).toBe(false);
  });

  it('skala viewBox diperhitungkan (viewBox 2x lebar fisik = huruf separuh)', () => {
    const doubled = `<svg width="128mm" height="60mm" viewBox="0 0 256 120"><text font-size="${(mm(6) * 2).toFixed(5)}">a</text></svg>`;
    expect(scanSvg(doubled).fontPts[0]).toBeCloseTo(6, 3);
  });
});

describe('DATUM-25 keluarga warna maksimum', () => {
  const rect = (hex: string) => `<rect fill="#${hex}" width="1" height="1"/>`;
  const hues = [PAL.signal, PAL.alert, PAL.verd];

  it('tinta + kertas + putih + hitam = satu keluarga "ink"', () => {
    for (const h of [PAL.paper, PAL.ink100, PAL.ink200, PAL.ink400, PAL.ink700, PAL.ink900, 'FFFFFF', '000000']) {
      expect(family(h)).toBe('ink');
    }
  });

  it('rona kertas -> palet dihitung keluarga palet itu (bukan warna baru)', () => {
    expect(family(tint(PAL.alert, 40))).toBe(PAL.alert);
    expect(family(tint(PAL.signal, 25))).toBe(PAL.signal);
    expect(family(tint(PAL.ink900, 50))).toBe('ink');
  });

  it('5 keluarga lolos; keluarga ke-6 gagal', () => {
    const five = [PAL.ink400, ...hues, 'AA3377'].map(rect).join('');
    expect(fail(lintChartSvg(svg(five), BASE_OPTS), 'DATUM-25')).toBe(false);
    const six = five + rect('123456');
    const l = lintChartSvg(svg(six), BASE_OPTS);
    expect(fail(l, 'DATUM-25')).toBe(true);
    expect(l.issues.find((i) => i.checkId === 'DATUM-25')?.detail).toMatch(/^6 keluarga warna/);
  });

  it('banyak rona satu palet tetap satu keluarga', () => {
    const body = [10, 20, 40, 60, 80].map((p) => rect(tint(PAL.alert, p))).join('') + rect(PAL.alert);
    expect(fail(lintChartSvg(svg(body), { ...BASE_OPTS, maxColors: 2 }), 'DATUM-25')).toBe(false);
  });
});

describe('DATUM-26 subjek beraksen (konvensi subjek IP-25)', () => {
  const ACC = PAL.role.accent;
  const opts = { ...BASE_OPTS, accentHex: ACC, maxAccent: 1 };
  const mark = (attrs: string, colour = ACC) => `<rect data-mark="bar" ${attrs} fill="#${colour}" width="1" height="1"/>`;

  it('dua tanda indeks subjek sama (posisi beda di data-obs) = satu subjek', () => {
    const l = lintChartSvg(svg(mark('data-series="a" data-index="0" data-obs="0"') + mark('data-series="a" data-index="0" data-obs="1"')), opts);
    expect(l.checksRun).toContain('DATUM-26');
    expect(fail(l, 'DATUM-26')).toBe(false);
  });

  it('dua indeks subjek berbeda = dua subjek -> gagal', () => {
    expect(fail(lintChartSvg(svg(mark('data-series="a" data-index="0"') + mark('data-series="a" data-index="1"')), opts), 'DATUM-26')).toBe(true);
  });

  it('data-accent-group menyatukan indeks berbeda', () => {
    const body = mark('data-series="a" data-index="0" data-accent-group="q1"') + mark('data-series="a" data-index="3" data-accent-group="q1"');
    expect(fail(lintChartSvg(svg(body), opts), 'DATUM-26')).toBe(false);
  });

  it('data-accent="series" = seluruh seri satu subjek', () => {
    const body = mark('data-series="s1" data-index="0" data-accent="series"') + mark('data-series="s1" data-index="5" data-accent="series"');
    expect(fail(lintChartSvg(svg(body), opts), 'DATUM-26')).toBe(false);
  });

  it('tanda ber-data-rule dilewati (warna dari aturan nilai)', () => {
    const body = mark('data-series="a" data-index="0"') + mark('data-series="t" data-index="2" data-rule="over"');
    expect(fail(lintChartSvg(svg(body), opts), 'DATUM-26')).toBe(false);
  });

  it('accentSubjectKey: prioritas group > series > series#index', () => {
    expect(accentSubjectKey({ mark: 'x', accentGroup: 'g', accentSeries: true, series: 's', index: '1' })).toBe('group:g');
    expect(accentSubjectKey({ mark: 'x', accentSeries: true, series: 's', index: '1' })).toBe('series:s');
    expect(accentSubjectKey({ mark: 'x', series: 's', index: '1' })).toBe('s#1');
  });

  it('renderChart P-01 dengan dua titik beraksen ditolak di titik panggil (DATUM-26)', () => {
    const s = clone(SPECS['P-01']) as unknown as StudioChartV1 & { data: { points: Array<{ accent?: boolean }> } };
    s.data.points[1].accent = true;
    const e = catchErr(() => renderChart(s));
    expect(e.code).toBe('BY_CONSTRUCTION_FAILED');
    expect(checkIdOf(e)).toBe('DATUM-26');
  });
});

describe('tinggi acuan per kode (core/heights.ts)', () => {
  const entries = Object.entries(CHART_REFERENCE_HEIGHT_MM) as Array<[ChartCode, number]>;

  it('22 kode: P1 6, H1 5, K1 4, S1 4, W2 3; semua tergambar dan bukan kode inti', () => {
    expect(entries).toHaveLength(22);
    const prefix = (p: string) => entries.filter(([c]) => c.startsWith(p)).length;
    expect([prefix('P-'), prefix('H-'), prefix('K-'), prefix('S-'), prefix('W-')]).toEqual([6, 5, 4, 4, 3]);
    for (const [c, h] of entries) {
      expect(CHART_REGISTRY.find((d) => d.code === c)?.drawn).toBe(true);
      expect(isCoreCode(c)).toBe(false);
      expect(h).toBeGreaterThan(0);
      expect(h).toBeLessThanOrEqual(247);
      expect(referenceHeightMm(c)).toBe(h);
    }
  });

  for (const [code, ref] of Object.entries(CHART_REFERENCE_HEIGHT_MM) as Array<[ChartCode, number]>) {
    it(`${code}: tanpa heightMm = ${ref} mm (page), +pita aparatus (figure), heightMm spec menang`, () => {
      const base = { kind: code, widthMm: 128, source: 'S', title: 'T.' } as StudioChartV1;
      expect(estimateHeightMm(base)).toBe(ref);
      expect(estimateHeightMm({ ...base, apparatus: 'figure', id: '8.1' })).toBe(ref + FIGURE_APPARATUS_BAND_MM);
      expect(estimateHeightMm({ ...base, heightMm: 99 })).toBe(99);
    });
  }

  it('kode tanpa acuan (bukan inti): lebar x 0,5', () => {
    expect(DEFAULT_HEIGHT_RATIO).toBe(0.5);
    for (const code of ['P-09', 'K-07', 'G-04'] as ChartCode[]) {
      expect(referenceHeightMm(code)).toBeUndefined();
      expect(estimateHeightMm({ kind: code, widthMm: 128 } as StudioChartV1)).toBe(64);
      expect(estimateHeightMm({ kind: code, widthMm: 166 } as StudioChartV1)).toBe(83);
    }
  });

  it('renderChart memakai tinggi acuan bila spec tanpa heightMm (P-03 = 58, S-02 = 56)', () => {
    for (const [code, h] of [['P-03', 58], ['S-02', 56]] as const) {
      const s = clone(SPECS[code]) as Record<string, unknown>;
      delete s.heightMm;
      expect(renderChart(s as unknown as StudioChartV1).heightMm).toBe(h);
    }
  });
});

describe('penjaga titik panggil renderChart', () => {
  const base = SPECS['P-01'] as unknown as StudioChartV1;

  it.each([
    ['G2', { widthMm: 150 }],
    ['DATUM-10', { source: '  ' }],
    ['N1', { id: '8_1' }],
    ['DATUM-36', { apparatus: 'figure', id: '8.1', inDocument: true }],
    ['DATUM-30', { apparatus: 'figure', id: undefined }],
    ['DATUM-33', { heightMm: 300 }],
  ])('%s', (checkId, patch) => {
    const e = catchErr(() => renderChart({ ...clone(base), ...patch } as StudioChartV1));
    expect(e.code).toBe('BY_CONSTRUCTION_FAILED');
    expect(checkIdOf(e)).toBe(checkId);
  });

  it('dec di luar 0..3 -> SCHEMA_INVALID', () => {
    expect(catchErr(() => renderChart({ ...clone(base), dec: 7 } as unknown as StudioChartV1)).code).toBe('SCHEMA_INVALID');
  });

  it('kode tidak dikenal -> CHART_KIND_UNKNOWN', () => {
    expect(catchErr(() => renderChart({ ...clone(base), kind: 'Z-99' } as unknown as StudioChartV1)).code).toBe('CHART_KIND_UNKNOWN');
  });

  it('setiap kode drawn=false -> CHART_KIND_NOT_DRAWN dengan alternatives tergambar', () => {
    const undrawn = CHART_REGISTRY.filter((d) => !d.drawn);
    expect(undrawn).toHaveLength(18);
    for (const d of undrawn) {
      const e = catchErr(() => renderChart({ ...clone(base), kind: d.code } as unknown as StudioChartV1));
      expect(e.code).toBe('CHART_KIND_NOT_DRAWN');
      const alts = (e.details as { alternatives: string[] }).alternatives;
      expect(alts).toEqual(d.alternatives ?? []);
      for (const a of alts) expect(CHART_REGISTRY.find((x) => x.code === a)?.drawn).toBe(true);
    }
  });
});
