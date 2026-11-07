// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/contract/dc35-chart-custom.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
// DC-35 (KS-10) — chart.custom ujung ke ujung lewat jalur v2 (register 05 §12, §5.3 AM-03, §13.1 EC28).
// Untuk SETIAP CU-01..CU-09: blok bab v2 `code: "custom"` + `form` + data bentuknya lolos skema
// (0 isu), I68 memberi kode tergambar register, compose (mapBlock) menghasilkan spec kode itu tanpa
// `form`, dan SVG-nya identik byte dengan blok preset kode yang sama (CU-01: dengan sort natural,
// D-368). Untuk SETIAP kombinasi mark x orientation x stacked x bentuk data kustom di LUAR tabel
// (48 - 9 = 39): skema tetap menerima (bukan 400), I68 null, compose melempar 422 EC28 dengan
// `supported` = CU-01..CU-09. Tabel register disalin literal sebagai pembanding independen.
import { describe, expect, it } from '../_vitest';
import type { ChartBlock, ChartV2, StudioChartV1 } from '@/lib/studio/contract';
import { StudioEngineError } from '@/lib/studio/contract/errors';
import type { ChartCustomFormV2 } from '@/lib/studio/contract/types/v2/contract';
import { renderChart } from '@/lib/studio/engine/chart/core';
import { CHART_CUSTOM_FORM_IDS, resolveChartCustom } from '@/lib/studio/registry/charts';
import { mapBlock, type BlockCtx } from '@/lib/studio/services/compose/blocks';
import { validateV2Against } from '@/lib/studio/services/ingest/validate';
import { chartSpecsByCode, clone } from '../figures/_helpers';

type Shape = 'categorical' | 'series' | 'xy';
const REGISTER_CU: Array<[string, 'bar' | 'line' | 'point' | 'area', 'vertical' | 'horizontal', boolean, Shape, string]> = [
  ['CU-01', 'bar', 'horizontal', false, 'categorical', 'P-01'],
  ['CU-02', 'bar', 'vertical', false, 'categorical', 'P-02'],
  ['CU-03', 'bar', 'vertical', false, 'series', 'P-03'],
  ['CU-04', 'bar', 'horizontal', true, 'series', 'K-01'],
  ['CU-05', 'line', 'vertical', false, 'series', 'W-01'],
  ['CU-06', 'area', 'vertical', false, 'categorical', 'W-04'],
  ['CU-07', 'area', 'vertical', true, 'series', 'W-05'],
  ['CU-08', 'point', 'vertical', false, 'xy', 'H-01'],
  ['CU-09', 'line', 'vertical', false, 'xy', 'H-04'],
];
const MARKS = ['bar', 'line', 'point', 'area'] as const;
const ORIENTATIONS = ['vertical', 'horizontal'] as const;
const SHAPES: Shape[] = ['categorical', 'series', 'xy'];

const SPECS = chartSpecsByCode();
/** Data v2 = data fixture paritas tanpa medan v1 `accent` (v2 memakai `highlight` di blok, V1_FIELD). */
function v2Data(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(v2Data);
  if (v !== null && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([k]) => k !== 'accent').map(([k, x]) => [k, v2Data(x)]));
  }
  return v;
}
const dataOf = (code: string) => v2Data(clone(SPECS[code].data));
/** Data contoh per bentuk = data fixture paritas kode tergambar register (bentuk dijamin sah). */
const DATA_BY_SHAPE: Record<Shape, unknown> = {
  categorical: dataOf('P-02'),
  series: dataOf('W-01'),
  xy: dataOf('H-01'),
};

const CTX: BlockCtx = { glyphs: new Set<string>(), params: {}, classification: 'TERBATAS', artifactLabel: 'Gambar 2.1' };
const caption = { runs: [{ t: 'Grafik uji DC-35.' }] };
const source = { runs: [{ t: 'Sumber uji DC-35, 2026.' }] };
const v2Block = (code: string, data: unknown, form?: ChartCustomFormV2) =>
  ({ type: 'chart', code, ...(form ? { form } : {}), data, caption, source }) as unknown as ChartV2;
const chapterDoc = (block: unknown) => ({
  $schema: 'studio.chapter/v2',
  target: { mission: { folder: '2026-10-30_hermes-retrial' }, docKey: 'laporan-kerja-dc02' },
  chapter: { key: '1', title: { text: 'Ringkasan' }, sections: [{ title: { text: 'Grafik' }, blocks: [block] }] },
});
const specOfBlock = (b: ChartV2) => (mapBlock(b, 'p-1', CTX) as ChartBlock).spec as StudioChartV1;
function thrown(fn: () => unknown): StudioEngineError {
  try {
    fn();
  } catch (e) {
    if (e instanceof StudioEngineError) return e;
    throw e;
  }
  throw new Error('diharapkan melempar StudioEngineError, ternyata tidak');
}

describe('DC-35 chart.custom: setiap CU dirender lewat jalur v2', () => {
  it('tabel register = 9 baris, id = CHART_CUSTOM_FORM_IDS', () => {
    expect(REGISTER_CU.map((r) => r[0])).toEqual([...CHART_CUSTOM_FORM_IDS]);
  });

  for (const [id, mark, orientation, stacked, shape, code] of REGISTER_CU) {
    it(`${id} ${mark}/${orientation}/${stacked ? 'stacked' : 'flat'} x ${shape} -> ${code}: skema 0 isu, I68, compose, SVG = preset`, () => {
      const form: ChartCustomFormV2 = { mark, orientation, stacked };
      const data = dataOf(code);
      const custom = v2Block('custom', data, form);

      expect(validateV2Against('studio.chapter/v2', chapterDoc(custom))).toEqual([]);
      expect(resolveChartCustom(form, shape)).toBe(code);

      const spec = specOfBlock(custom);
      expect(spec.kind).toBe(code);
      expect('form' in spec).toBe(false);

      const preset = specOfBlock(v2Block(code, data));
      expect(preset.kind).toBe(code);
      const presetSpec: StudioChartV1 =
        id === 'CU-01' ? { ...preset, params: { ...(preset.params ?? {}), 'chart.kind.P-01.sort': 'natural' } } : preset;
      expect(spec).toEqual(presetSpec);

      const svg = renderChart(spec).svg;
      expect(svg.startsWith('<svg')).toBe(true);
      expect(svg).toBe(renderChart(presetSpec).svg);
    });
  }
});

describe('DC-35 chart.custom: setiap kombinasi di luar tabel -> 422 EC28 (bukan 400)', () => {
  const inTable = new Set(REGISTER_CU.map(([, m, o, s, sh]) => `${m}|${o}|${s}|${sh}`));
  const outside: Array<[string, ChartCustomFormV2, Shape]> = [];
  for (const mark of MARKS)
    for (const orientation of ORIENTATIONS)
      for (const stacked of [false, true])
        for (const shape of SHAPES)
          if (!inTable.has(`${mark}|${orientation}|${stacked}|${shape}`)) outside.push([`${mark}/${orientation}/${stacked ? 'stacked' : 'flat'} x ${shape}`, { mark, orientation, stacked }, shape]);

  it('39 kombinasi di luar tabel (4 x 2 x 2 x 3 - 9)', () => {
    expect(outside).toHaveLength(39);
  });

  for (const [name, form, shape] of outside) {
    it(name, () => {
      const block = v2Block('custom', DATA_BY_SHAPE[shape], form);
      expect(validateV2Against('studio.chapter/v2', chapterDoc(block))).toEqual([]);
      expect(resolveChartCustom(form, shape)).toBeNull();
      const e = thrown(() => mapBlock(block, 'p-1', CTX));
      expect([e.code, e.httpStatus]).toEqual(['CHART_CUSTOM_FORM_UNSUPPORTED', 422]);
      expect(e.details).toMatchObject({ form, dataShape: shape, supported: [...CHART_CUSTOM_FORM_IDS] });
    });
  }

  it('bawaan T2-66 (orientation/stacked absen) = vertical/flat: bar x categorical -> P-02, bar x xy -> EC28', () => {
    expect(specOfBlock(v2Block('custom', DATA_BY_SHAPE.categorical, { mark: 'bar' })).kind).toBe('P-02');
    expect(thrown(() => mapBlock(v2Block('custom', DATA_BY_SHAPE.xy, { mark: 'bar' }), 'p-1', CTX)).code).toBe('CHART_CUSTOM_FORM_UNSUPPORTED');
  });
});
