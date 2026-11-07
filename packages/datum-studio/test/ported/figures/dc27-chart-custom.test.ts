// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/figures/dc27-chart-custom.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
// DC-27 (05 §12, D-367 AM-03, D-368): dispatch `chart.custom` di mesin chart.
// Setiap CU-01..CU-09 dirender perender keluarga lewat I68 (SVG valid, identik byte dengan
// spec preset kode tujuan), CU-01 mempertahankan urutan data agen (`sort = natural`),
// bentuk/data di luar tabel -> 422 EC28 terstruktur, compose meneruskan `custom` + `form`,
// dan lint struktur menilai spec kustom sebagai kode tujuannya. Murni lokal.
import { describe, it, expect } from '../_vitest';
import type { ChartBlock, ChartV2, StudioChartV1 } from '@/lib/studio/contract';
import type { ChartCustomFormV2 } from '@/lib/studio/contract/types/v2/contract';
import {
  chartSpecFromDraft,
  customChartCode,
  estimateHeightMm,
  renderChart,
  resolveCustomChart,
  toStudioChart,
  type StudioChartCustomV1,
} from '@/lib/studio/engine/chart/core';
import { CHART_CUSTOM_FORMS, CHART_CUSTOM_FORM_IDS } from '@/lib/studio/registry/charts';
import { mapBlock, type BlockCtx } from '@/lib/studio/services/compose/blocks';
import { lintStructure } from '@/lib/studio/engine/lint/structure';
import { canonicalTemplate, makeDoc, snapshotOf } from '../engine-core/fixtures';
import { assertBalancedXml, catchErr, chartSpecsByCode, clone } from './_helpers';

const SPECS = chartSpecsByCode();
const SORT_P01 = 'chart.kind.P-01.sort';

function customOf(code: string, form: ChartCustomFormV2): StudioChartCustomV1 {
  const base = clone(SPECS[code]) as unknown as StudioChartV1;
  return { ...base, kind: 'custom', form };
}

function formOf(f: (typeof CHART_CUSTOM_FORMS)[number]): ChartCustomFormV2 {
  return { mark: f.mark, orientation: f.orientation, stacked: f.stacked };
}

/** Urutan kemunculan label di teks SVG. */
function labelOrder(svg: string, labels: string[]): string[] {
  return [...labels].sort((a, b) => svg.indexOf(`>${a}<`) - svg.indexOf(`>${b}<`));
}

const CU01_SPEC = (): StudioChartCustomV1 => ({
  $schema: 'studio.chart/v1',
  kind: 'custom',
  form: { mark: 'bar', orientation: 'horizontal' },
  title: 'Urutan penulis dipertahankan.',
  source: 'Sumber uji DC-27, 2026.',
  widthMm: 166,
  data: {
    shape: 'categorical',
    points: [
      { label: 'Alfa', value: 1 },
      { label: 'Bravo', value: 5 },
      { label: 'Charlie', value: 3 },
      { label: 'Delta', value: 4 },
    ],
  },
});

describe('DC-27 dispatch CU-01..CU-09 ke perender keluarga', () => {
  for (const f of CHART_CUSTOM_FORMS) {
    it(`${f.id} (${f.mark}/${f.orientation}/${f.stacked ? 'stacked' : 'flat'}/${f.dataShape}) -> ${f.code}: SVG valid, identik dengan preset`, () => {
      const spec = customOf(f.code, formOf(f));
      expect(spec.data?.shape).toBe(f.dataShape);
      const before = JSON.stringify(spec);
      const res = renderChart(spec);
      expect(JSON.stringify(spec), 'masukan tidak dimutasi').toBe(before);
      expect(res.svg.startsWith('<svg')).toBe(true);
      expect(res.svg.trimEnd().endsWith('</svg>')).toBe(true);
      assertBalancedXml(res.svg);
      expect(res.report.issues.filter((i) => i.status === 'FAIL')).toEqual([]);

      const preset = clone(SPECS[f.code]) as unknown as StudioChartV1;
      if (f.id === 'CU-01') preset.params = { ...preset.params, [SORT_P01]: 'natural' };
      expect(res.svg).toBe(renderChart(preset).svg);
      expect(estimateHeightMm(spec)).toBe(estimateHeightMm(preset));
    });
  }

  it('bawaan T2-66: orientation vertical, stacked false', () => {
    expect(customChartCode({ form: { mark: 'bar' }, data: { shape: 'categorical' } })).toBe('P-02');
    expect(customChartCode({ form: { mark: 'line' }, data: { shape: 'xy' } })).toBe('H-04');
  });

  it('resolveCustomChart: tanpa form, kind = kode tujuan; hanya CU-01 mendapat sort natural', () => {
    for (const f of CHART_CUSTOM_FORMS) {
      const out = resolveCustomChart(customOf(f.code, formOf(f)));
      expect(out.kind).toBe(f.code);
      expect('form' in out).toBe(false);
      expect(out.params?.[SORT_P01] === 'natural').toBe(f.id === 'CU-01');
    }
  });

  it('spec preset melewati dispatch tanpa disalin (objek sama)', () => {
    const p = clone(SPECS['P-01']) as unknown as StudioChartV1;
    expect(toStudioChart(p)).toBe(p);
  });
});

describe('DC-27 CU-01 mempertahankan urutan data (D-368)', () => {
  const LABELS = ['Alfa', 'Bravo', 'Charlie', 'Delta'];

  it('custom bar horizontal: urutan label = urutan data agen (datum dan gallery)', () => {
    for (const style of ['datum', 'gallery'] as const) {
      const svg = renderChart({ ...CU01_SPEC(), style }).svg;
      expect(labelOrder(svg, LABELS), style).toEqual(LABELS);
    }
  });

  it('P-01 preset dengan data sama tetap mengurutkan valueDesc (perilaku preset tidak berubah)', () => {
    const { form: _f, ...rest } = CU01_SPEC();
    void _f;
    const svg = renderChart({ ...rest, kind: 'P-01' } as StudioChartV1).svg;
    expect(labelOrder(svg, LABELS)).toEqual(['Bravo', 'Delta', 'Charlie', 'Alfa']);
  });

  it('sort natural menang atas sort di params agen (urutan isi milik penulis)', () => {
    const spec = { ...CU01_SPEC(), params: { [SORT_P01]: 'valueDesc' } };
    expect(labelOrder(renderChart(spec).svg, LABELS)).toEqual(LABELS);
  });
});

describe('DC-27 bentuk/data di luar tabel -> 422 EC28', () => {
  const cases: Array<[string, Record<string, unknown>, unknown, string | null]> = [
    ['point x categorical', { mark: 'point' }, { shape: 'categorical', points: [{ label: 'a', value: 1 }] }, 'categorical'],
    ['bar horizontal stacked x categorical', { mark: 'bar', orientation: 'horizontal', stacked: true }, { shape: 'categorical', points: [] }, 'categorical'],
    ['bar x matrix', { mark: 'bar' }, { shape: 'matrix', rows: [], cols: [], values: [] }, 'matrix'],
    ['area horizontal x series', { mark: 'area', orientation: 'horizontal' }, { shape: 'series', categories: [], series: [] }, 'series'],
  ];
  for (const [name, form, data, shape] of cases) {
    it(name, () => {
      const spec = { ...CU01_SPEC(), form, data } as unknown as StudioChartCustomV1;
      const e = catchErr(() => renderChart(spec));
      expect(e.code).toBe('CHART_CUSTOM_FORM_UNSUPPORTED');
      expect(e.httpStatus).toBe(422);
      expect(e.details).toEqual({ form, dataShape: shape, supported: [...CHART_CUSTOM_FORM_IDS] });
    });
  }

  it('form absen atau data absen -> EC28 (tanpa menebak)', () => {
    const noForm = { ...CU01_SPEC(), form: undefined } as unknown as StudioChartCustomV1;
    expect(catchErr(() => renderChart(noForm)).details).toEqual({ form: null, dataShape: 'categorical', supported: [...CHART_CUSTOM_FORM_IDS] });
    const noData = { ...CU01_SPEC(), data: undefined } as unknown as StudioChartCustomV1;
    expect(catchErr(() => renderChart(noData)).details).toEqual({ form: { mark: 'bar', orientation: 'horizontal' }, dataShape: null, supported: [...CHART_CUSTOM_FORM_IDS] });
  });
});

describe('DC-27 compose (AM-03): ChartV2 code custom', () => {
  const CTX: BlockCtx = { glyphs: new Set<string>(), params: {}, classification: 'TERBATAS', artifactLabel: 'Gambar 3.1' };
  const runs = (t: string) => ({ runs: [{ t }] });
  const v2 = (code: string, form?: Record<string, unknown>): ChartV2 =>
    ({
      type: 'chart',
      code,
      ...(form ? { form } : {}),
      data: { shape: 'categorical', points: [{ label: 'Alfa', value: 1 }, { label: 'Bravo', value: 5 }] },
      caption: runs('Urutan penulis dipertahankan.'),
      source: runs('Sumber uji DC-27, 2026.'),
    }) as unknown as ChartV2;

  it('custom bar horizontal -> spec P-01 + sort natural, tanpa form; dirender', () => {
    const blk = mapBlock(v2('custom', { mark: 'bar', orientation: 'horizontal' }), 'p1', CTX) as ChartBlock;
    const spec = blk.spec as StudioChartV1;
    expect(spec.kind).toBe('P-01');
    expect(spec.params?.[SORT_P01]).toBe('natural');
    expect('form' in spec).toBe(false);
    expect(labelOrder(renderChart(spec).svg, ['Alfa', 'Bravo'])).toEqual(['Alfa', 'Bravo']);
  });

  it('preset P-01 tidak berubah (tanpa sort disuntik)', () => {
    const spec = (mapBlock(v2('P-01'), 'p1', CTX) as ChartBlock).spec as StudioChartV1;
    expect(spec.kind).toBe('P-01');
    expect(spec.params?.[SORT_P01]).toBeUndefined();
  });

  it('custom di luar tabel -> EC28 dari compose', () => {
    const e = catchErr(() => mapBlock(v2('custom', { mark: 'point' }), 'p1', CTX));
    expect(e.code).toBe('CHART_CUSTOM_FORM_UNSUPPORTED');
  });

  it('chartSpecFromDraft: kode preset = objek sama', () => {
    const p = clone(SPECS['P-02']) as unknown as StudioChartV1;
    expect(chartSpecFromDraft(p, undefined)).toBe(p);
  });
});

describe('DC-27 lint struktur menerima chart custom', () => {
  it('D14 menilai custom bar vertical sebagai P-02 (sumbu nol, CH-01)', () => {
    const spec = { ...CU01_SPEC(), form: { mark: 'bar' }, params: { 'chart.zeroBaseline': false } };
    const chartBlock = { type: 'chart', caption: { text: 'Batang kustom 2026.' }, source: { text: 'Sumber uji, 2026.' }, widthMm: 166, spec };
    const doc = makeDoc({ tier: 'SERAH', blocks: [{ type: 'paragraph', text: 'Paragraf uji yang netral dan pendek.' }, chartBlock] as unknown as NonNullable<Parameters<typeof makeDoc>[0]>['blocks'] });
    const snap = snapshotOf(doc);
    const d14 = lintStructure(snap, canonicalTemplate(), 'SERAH').filter((i) => i.checkId === 'D14');
    expect(d14.some((i) => i.status === 'FAIL' && /P-02 dengan zeroBaseline=false/.test(i.detail ?? ''))).toBe(true);
  });
});
