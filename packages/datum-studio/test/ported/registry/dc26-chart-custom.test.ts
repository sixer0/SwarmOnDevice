// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/registry/dc26-chart-custom.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
// DC-26 (D-367): registri chart.custom (05 §12) — C59 CHART_CUSTOM_FORMS (CU-01..CU-09),
// C60 CHART_CUSTOM_FORM_COUNT, I68 resolveChartCustom. Setiap bentuk dipetakan ke kode
// keluarga tergambar yang sudah ada dengan dataShape sama (AC-20), dirender asap, dan
// orientasi batang dicek terhadap SVG perender (CA-4).
import { describe, it, expect } from '../_vitest';
import type { StudioChartV1 } from '@/lib/studio/contract';
import { CHART_CUSTOM_MARKS, CHART_CUSTOM_ORIENTATIONS, DRAWN_CHART_CODES } from '@/lib/studio/contract/enums';
import { CHART_DATA_SHAPES } from '@/lib/studio/contract/types/chart';
import type { ChartCustomFormV2 } from '@/lib/studio/contract/types/v2/contract';
import { CHART_RENDERERS } from '@/lib/studio/contract/dispatch';
import { renderChart } from '@/lib/studio/engine/chart/core';
import {
  CHART_BY_CODE,
  CHART_CUSTOM_DATA_SHAPES,
  CHART_CUSTOM_FORM_COUNT,
  CHART_CUSTOM_FORM_IDS,
  CHART_CUSTOM_FORMS,
  CHART_REGISTRY,
  CHART_REGISTRY_COUNT,
  resolveChartCustom,
} from '@/lib/studio/registry/charts';
import { chartSpecsByCode, clone } from '../figures/_helpers';

const SPECS = chartSpecsByCode();

/** Register 05 §12, disalin literal sebagai pembanding independen. */
const SPEC_TABLE = [
  ['CU-01', 'bar', 'horizontal', false, 'categorical', 'P-01'],
  ['CU-02', 'bar', 'vertical', false, 'categorical', 'P-02'],
  ['CU-03', 'bar', 'vertical', false, 'series', 'P-03'],
  ['CU-04', 'bar', 'horizontal', true, 'series', 'K-01'],
  ['CU-05', 'line', 'vertical', false, 'series', 'W-01'],
  ['CU-06', 'area', 'vertical', false, 'categorical', 'W-04'],
  ['CU-07', 'area', 'vertical', true, 'series', 'W-05'],
  ['CU-08', 'point', 'vertical', false, 'xy', 'H-01'],
  ['CU-09', 'line', 'vertical', false, 'xy', 'H-04'],
] as const;

const specOf = (code: string) => clone(SPECS[code]) as unknown as StudioChartV1;

/** Ukuran `<rect data-mark=...>` batang/segmen di SVG. */
function markRects(svg: string): Array<{ w: number; h: number }> {
  const out: Array<{ w: number; h: number }> = [];
  for (const m of svg.matchAll(/<rect data-mark="(?:bar|column|segment)"[^>]*?\swidth="([\d.]+)" height="([\d.]+)"/g)) {
    out.push({ w: Number(m[1]), h: Number(m[2]) });
  }
  return out;
}

describe('C59/C60 CHART_CUSTOM_FORMS', () => {
  it('pin C60 = panjang array = 9; id unik CU-01..CU-09 berurutan', () => {
    expect(CHART_CUSTOM_FORM_COUNT).toBe(9);
    expect(CHART_CUSTOM_FORMS).toHaveLength(CHART_CUSTOM_FORM_COUNT);
    expect(CHART_CUSTOM_FORM_IDS).toEqual(CHART_CUSTOM_FORMS.map((f) => f.id));
    expect(CHART_CUSTOM_FORM_IDS).toEqual(Array.from({ length: 9 }, (_, i) => `CU-0${i + 1}`));
  });

  it('isi sama persis dengan register 05 §12', () => {
    expect(CHART_CUSTOM_FORMS.map((f) => [f.id, f.mark, f.orientation, f.stacked, f.dataShape, f.code])).toEqual(
      SPEC_TABLE.map((r) => [...r]),
    );
  });

  it('kombinasi (mark, orientation, stacked, dataShape) unik', () => {
    const keys = CHART_CUSTOM_FORMS.map((f) => `${f.mark}|${f.orientation}|${f.stacked}|${f.dataShape}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('nilai dalam enum E51/E52; bentuk data hanya categorical/series/xy', () => {
    expect(CHART_CUSTOM_DATA_SHAPES).toEqual(['categorical', 'series', 'xy']);
    for (const s of CHART_CUSTOM_DATA_SHAPES) expect(CHART_DATA_SHAPES).toContain(s);
    for (const f of CHART_CUSTOM_FORMS) {
      expect(CHART_CUSTOM_MARKS, f.id).toContain(f.mark);
      expect(CHART_CUSTOM_ORIENTATIONS, f.id).toContain(f.orientation);
      expect(CHART_CUSTOM_DATA_SHAPES, f.id).toContain(f.dataShape);
    }
  });

  it('AC-20: setiap kode tujuan tergambar, dataShape sama, punya perender; CHART_REGISTRY_COUNT tetap 76', () => {
    expect(CHART_REGISTRY_COUNT).toBe(76);
    expect(CHART_REGISTRY).toHaveLength(76);
    for (const f of CHART_CUSTOM_FORMS) {
      const def = CHART_BY_CODE.get(f.code);
      expect(def, f.id).toBeDefined();
      expect(def!.drawn, f.id).toBe(true);
      expect(def!.dataShape, f.id).toBe(f.dataShape);
      expect(DRAWN_CHART_CODES, f.id).toContain(f.code);
      expect(typeof CHART_RENDERERS[f.code], f.id).toBe('function');
    }
  });
});

describe('kode tujuan benar-benar tergambar (render asap)', () => {
  for (const f of CHART_CUSTOM_FORMS) {
    it(`${f.id} -> ${f.code} (${f.dataShape}) menghasilkan SVG bertanda data tanpa FAIL`, () => {
      const spec = specOf(f.code);
      expect((spec.data as { shape: string }).shape).toBe(f.dataShape);
      const r = renderChart(spec);
      expect(r.report.issues.filter((i) => i.status === 'FAIL')).toEqual([]);
      expect(r.svg).toMatch(/data-mark="/);
      expect(r.svg).not.toMatch(/NaN|Infinity|undefined/);
    });
  }
});

describe('CA-4: orientasi batang perender cocok dengan tabel', () => {
  for (const f of CHART_CUSTOM_FORMS.filter((x) => x.mark === 'bar')) {
    it(`${f.id} ${f.code} ${f.orientation}`, () => {
      const rects = markRects(renderChart(specOf(f.code)).svg);
      expect(rects.length).toBeGreaterThan(1);
      const widths = new Set(rects.map((r) => r.w));
      const heights = new Set(rects.map((r) => r.h));
      // Mendatar: tebal batang (tinggi) seragam, panjang (lebar) mengikuti nilai; tegak sebaliknya.
      if (f.orientation === 'horizontal') {
        expect(heights.size).toBe(1);
        expect(widths.size).toBeGreaterThan(1);
      } else {
        expect(widths.size).toBe(1);
        expect(heights.size).toBeGreaterThan(1);
      }
    });
  }

  it('P-01 mengurutkan nilai menurun secara bawaan; sort=natural mempertahankan urutan data', () => {
    // Fixture p01 sudah urut menurun; dibalik agar urutan data != urutan nilai.
    const reversed = (): StudioChartV1 => {
      const s = specOf('P-01');
      const d = s.data as { points: Array<{ value: number }> };
      return { ...s, data: { ...d, points: [...d.points].reverse() } } as unknown as StudioChartV1;
    };
    const base = reversed();
    const values = (base.data as { points: Array<{ value: number }> }).points.map((p) => p.value);
    expect(values).not.toEqual([...values].sort((a, b) => b - a));
    const lengths = (s: StudioChartV1) => markRects(renderChart(s).svg).map((r) => r.w);
    const sorted = lengths(reversed());
    expect(sorted).toEqual([...sorted].sort((a, b) => b - a));
    const natural = { ...reversed(), params: { ...(base.params ?? {}), 'chart.kind.P-01.sort': 'natural' } } as StudioChartV1;
    const nat = lengths(natural);
    expect(nat).toHaveLength(values.length);
    // Panjang batang natural berurutan sama dengan nilai data (skala linear monoton).
    for (let i = 1; i < values.length; i++) {
      expect(Math.sign(nat[i] - nat[i - 1]), `i=${i}`).toBe(Math.sign(values[i] - values[i - 1]));
    }
  });
});

describe('I68 resolveChartCustom', () => {
  it('setiap baris CU memetakan ke kodenya', () => {
    for (const f of CHART_CUSTOM_FORMS) {
      expect(resolveChartCustom({ mark: f.mark, orientation: f.orientation, stacked: f.stacked }, f.dataShape), f.id).toBe(f.code);
    }
  });

  it('bawaan T2-66: orientation vertical, stacked false', () => {
    expect(resolveChartCustom({ mark: 'bar' }, 'categorical')).toBe('P-02');
    expect(resolveChartCustom({ mark: 'bar' }, 'series')).toBe('P-03');
    expect(resolveChartCustom({ mark: 'line' }, 'series')).toBe('W-01');
    expect(resolveChartCustom({ mark: 'line' }, 'xy')).toBe('H-04');
    expect(resolveChartCustom({ mark: 'point' }, 'xy')).toBe('H-01');
    expect(resolveChartCustom({ mark: 'area' }, 'categorical')).toBe('W-04');
    expect(resolveChartCustom({ mark: 'area', stacked: true }, 'series')).toBe('W-05');
    expect(resolveChartCustom({ mark: 'bar', orientation: 'horizontal' }, 'categorical')).toBe('P-01');
    expect(resolveChartCustom({ mark: 'bar', orientation: 'horizontal', stacked: true }, 'series')).toBe('K-01');
  });

  it('semua kombinasi di luar tabel -> null (mark x orientation x stacked x 11 bentuk data)', () => {
    const table = new Map(CHART_CUSTOM_FORMS.map((f) => [`${f.mark}|${f.orientation}|${f.stacked}|${f.dataShape}`, f.code]));
    let hits = 0;
    for (const mark of CHART_CUSTOM_MARKS) {
      for (const orientation of CHART_CUSTOM_ORIENTATIONS) {
        for (const stacked of [false, true]) {
          for (const shape of CHART_DATA_SHAPES) {
            const got = resolveChartCustom({ mark, orientation, stacked }, shape);
            const want = table.get(`${mark}|${orientation}|${stacked}|${shape}`) ?? null;
            expect(got, `${mark}|${orientation}|${stacked}|${shape}`).toBe(want);
            if (got !== null) hits++;
          }
        }
      }
    }
    expect(hits).toBe(CHART_CUSTOM_FORM_COUNT);
  });

  it('contoh EC28: point x categorical, bar x xy, data di luar 3 bentuk -> null', () => {
    expect(resolveChartCustom({ mark: 'point' }, 'categorical')).toBeNull();
    expect(resolveChartCustom({ mark: 'bar' }, 'xy')).toBeNull();
    expect(resolveChartCustom({ mark: 'bar', orientation: 'horizontal', stacked: true }, 'categorical')).toBeNull();
    expect(resolveChartCustom({ mark: 'line' }, 'matrix')).toBeNull();
    expect(resolveChartCustom({ mark: 'area' }, 'distribution')).toBeNull();
  });

  it('masukan rusak saat runtime -> null, tidak melempar', () => {
    const bad = (x: unknown) => resolveChartCustom(x as ChartCustomFormV2, 'categorical');
    expect(bad(null)).toBeNull();
    expect(bad(undefined)).toBeNull();
    expect(bad('bar')).toBeNull();
    expect(bad({})).toBeNull();
    expect(bad({ mark: 'pie' })).toBeNull();
    expect(bad({ mark: 'bar', orientation: 'diagonal' })).toBeNull();
    expect(bad({ mark: 'bar', stacked: 'false' })).toBeNull();
    expect(resolveChartCustom({ mark: 'bar' }, 'nope' as never)).toBeNull();
  });
});
