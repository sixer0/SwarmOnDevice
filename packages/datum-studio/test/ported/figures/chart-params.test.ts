// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/figures/chart-params.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
// S73: resolver params chart tunggal (engine/chart/core/params.ts, IP-25 / D-87 / D-108).
// Kebijakan: kunci penuh menang; alias pendek sah -> kunci penuh + REPORT PARAM_ALIAS;
// alias bernilai buruk / kunci kode lain / kunci asing -> dibuang + REPORT PARAM_IGNORED;
// accent.* dilipat ke medan `accent`; petunjuk data per kode diteruskan.
import { describe, it, expect } from '../_vitest';
import type { StudioChartV1 } from '@/lib/studio/contract';
import {
  CHART_DATA_HINT_KEYS,
  aliasValueError,
  ignoredChartParamKeys,
  renderChart,
  resolveChartParams,
} from '@/lib/studio/engine/chart/core';
import { PARAMS_BY_KEY } from '@/lib/studio/params';
import { chartSpecsByCode, clone } from './_helpers';

const SPECS = chartSpecsByCode();
const P01 = SPECS['P-01'] as unknown as StudioChartV1;
const withParams = (base: StudioChartV1, params: Record<string, unknown>, extra: Partial<StudioChartV1> = {}): StudioChartV1 =>
  ({ ...clone(base), ...extra, params } as StudioChartV1);
const issue = (r: { report: { issues: Array<{ checkId: string; detail?: string; status: string }> } }, id: string) =>
  r.report.issues.find((i) => i.checkId === id);

describe('resolveChartParams: tanpa params', () => {
  it('spec tanpa params dikembalikan apa adanya (objek sama), laporan kosong', () => {
    const s = clone(P01);
    delete (s as { params?: unknown }).params;
    const r = resolveChartParams(s, 'P-01');
    expect(r.spec).toBe(s);
    expect(r.report).toEqual({ checksRun: [], issues: [] });
    const e = resolveChartParams({ ...s, params: {} }, 'P-01');
    expect(e.aliased).toEqual([]);
    expect(e.ignored).toEqual([]);
  });
});

describe('resolveChartParams: kunci penuh dan alias', () => {
  it('kunci penuh milik kode dipakai apa adanya tanpa laporan', () => {
    const r = resolveChartParams(withParams(P01, { 'chart.kind.P-01.sort': 'valueAsc' }), 'P-01');
    expect(r.spec.params).toEqual({ 'chart.kind.P-01.sort': 'valueAsc' });
    expect(r.report.issues).toEqual([]);
  });

  it('kunci global P7 (chart.minFontPt) diteruskan', () => {
    const r = resolveChartParams(withParams(P01, { 'chart.minFontPt': 6 }), 'P-01');
    expect(r.spec.params).toEqual({ 'chart.minFontPt': 6 });
    expect(r.ignored).toEqual([]);
  });

  it('alias pendek sah -> kunci penuh + REPORT PARAM_ALIAS', () => {
    const r = resolveChartParams(withParams(P01, { sort: 'valueAsc' }), 'P-01');
    expect(r.spec.params).toEqual({ 'chart.kind.P-01.sort': 'valueAsc' });
    expect(r.aliased).toEqual(['sort -> chart.kind.P-01.sort']);
    expect(r.report.checksRun).toEqual(['PARAM_ALIAS']);
    expect(issue(r, 'PARAM_ALIAS')).toMatchObject({ status: 'REPORT' });
  });

  it('kunci penuh menang atas alias (alias dibuang, dilaporkan PARAM_ALIAS)', () => {
    const r = resolveChartParams(withParams(P01, { sort: 'valueAsc', 'chart.kind.P-01.sort': 'natural' }), 'P-01');
    expect(r.spec.params).toEqual({ 'chart.kind.P-01.sort': 'natural' });
    expect(r.aliased).toEqual(['sort (kunci penuh chart.kind.P-01.sort menang)']);
    expect(r.ignored).toEqual([]);
  });

  it('alias bernilai tidak sah -> dibuang + PARAM_IGNORED beralasan (tidak ditolak)', () => {
    const r = resolveChartParams(withParams(P01, { sort: 'acak' }), 'P-01');
    expect(r.spec.params).toEqual({});
    expect(r.ignored).toHaveLength(1);
    expect(r.ignored[0]).toMatch(/^sort \(alias chart\.kind\.P-01\.sort tidak sah: /);
    expect(issue(r, 'PARAM_IGNORED')).toMatchObject({ status: 'REPORT' });
  });

  it('alias null -> PARAM_IGNORED "(null)"', () => {
    const r = resolveChartParams(withParams(P01, { sort: null }), 'P-01');
    expect(r.ignored).toEqual(['sort (null)']);
  });

  it('kunci penuh milik kode lain -> PARAM_IGNORED "(milik kode lain)"', () => {
    expect(PARAMS_BY_KEY.has('chart.kind.P-09.actualBar')).toBe(true);
    const r = resolveChartParams(withParams(P01, { 'chart.kind.P-09.actualBar': false }), 'P-01');
    expect(r.spec.params).toEqual({});
    expect(r.ignored).toEqual(['chart.kind.P-09.actualBar (milik kode lain)']);
  });

  it('kunci asing -> PARAM_IGNORED; ignoredChartParamKeys hanya nama kunci', () => {
    const s = withParams(P01, { zz: 1, foo: 'x' });
    const r = resolveChartParams(s, 'P-01');
    expect(r.ignored).toEqual(['foo', 'zz']);
    expect(ignoredChartParamKeys(s, 'P-01')).toEqual(['foo', 'zz']);
  });

  it('alias + abaian dalam satu spec: dua temuan, urut leksikografis kunci', () => {
    const r = resolveChartParams(withParams(P01, { zz: 1, valueLabel: 'inside', sort: 'valueAsc' }), 'P-01');
    expect(r.report.checksRun).toEqual(['PARAM_ALIAS', 'PARAM_IGNORED']);
    expect(r.aliased).toEqual(['sort -> chart.kind.P-01.sort', 'valueLabel -> chart.kind.P-01.valueLabel']);
  });

  it('tidak memutasi spec masukan', () => {
    const s = withParams(P01, { sort: 'valueAsc', zz: 1, 'accent.point': 'Jaringan' });
    const before = JSON.stringify(s);
    resolveChartParams(s, 'P-01');
    expect(JSON.stringify(s)).toBe(before);
  });
});

describe('resolveChartParams: aksen dan petunjuk data', () => {
  it('accent.point dilipat ke medan accent + PARAM_ALIAS', () => {
    const r = resolveChartParams(withParams(P01, { 'accent.point': 'Jaringan' }), 'P-01');
    expect(r.spec.accent).toEqual({ point: 'Jaringan' });
    expect(r.spec.params).toEqual({});
    expect(r.aliased).toEqual(['accent.point -> accent.point']);
  });

  it('medan accent yang sudah ada menang atas accent.point', () => {
    const r = resolveChartParams(withParams(P01, { 'accent.point': 'Jaringan' }, { accent: { point: 'Sensor' } }), 'P-01');
    expect(r.spec.accent).toEqual({ point: 'Sensor' });
    expect(r.aliased).toEqual(['accent.point (medan accent.point menang)']);
  });

  it('accent.series bukan string -> PARAM_IGNORED', () => {
    const r = resolveChartParams(withParams(P01, { 'accent.series': 3 }), 'P-01');
    expect(r.ignored).toEqual(['accent.series (bukan string)']);
  });

  it('alias pendek params accentPoint diurai sekali ke accent (D-136), dilaporkan PARAM_ALIAS', () => {
    // SR-42 (D-136, IP-39a S84 #1): alias aksen diurai sekali di core/params.ts
    // (medan accent > kunci accent.* > alias); tidak lagi diteruskan apa adanya di params.
    const r = resolveChartParams(withParams(P01, { accentPoint: 'Sensor' }), 'P-01');
    expect(r.spec.params).toEqual({});
    expect(r.spec.accent).toEqual({ point: 'Sensor' });
    expect(r.aliased).toEqual(['accentPoint -> accent']);
    expect(r.report.issues).toEqual([expect.objectContaining({ checkId: 'PARAM_ALIAS', status: 'REPORT' })]);
  });

  it('petunjuk data per kode diteruskan hanya untuk kodenya (P-09 targets)', () => {
    expect(CHART_DATA_HINT_KEYS['P-09']).toContain('targets');
    const p09 = SPECS['P-09'] as unknown as StudioChartV1;
    const own = resolveChartParams(withParams(p09, { targets: [1, 2] }), 'P-09');
    expect(own.spec.params).toEqual({ targets: [1, 2] });
    const other = resolveChartParams(withParams(P01, { targets: [1, 2] }), 'P-01');
    expect(other.ignored).toEqual(['targets']);
  });
});

describe('aliasValueError: bentuk alternatif yang dibaca keluarga', () => {
  it('S-03 bandwidth: angka > 0 dan aturan bernama sah; string lain tidak', () => {
    const def = PARAMS_BY_KEY.get('chart.kind.S-03.bandwidth')!;
    expect(aliasValueError(def, 2.5)).toBeNull();
    expect(aliasValueError(def, 'silverman')).toBeNull();
    expect(aliasValueError(def, 'scott')).toBeNull();
    expect(aliasValueError(def, 'banyak')).not.toBeNull();
  });

  it('W-09 bands: rentang ATAU bilangan bulat', () => {
    const def = PARAMS_BY_KEY.get('chart.kind.W-09.bands')!;
    expect(aliasValueError(def, [2, 3])).toBeNull();
    expect(aliasValueError(def, 2)).toBeNull();
  });

  it('alias S-03 bandwidth "silverman" diterima resolver', () => {
    const s3 = SPECS['S-03'] as unknown as StudioChartV1;
    const r = resolveChartParams(withParams(s3, { bandwidth: 'silverman' }), 'S-03');
    expect(r.spec.params).toEqual({ 'chart.kind.S-03.bandwidth': 'silverman' });
  });
});

describe('renderChart: resolver dipanggil sekali, laporan REPORT bukan FAIL', () => {
  it('alias sah = kunci penuh: SVG identik, laporan PARAM_ALIAS', () => {
    const viaAlias = renderChart(withParams(P01, { sort: 'valueAsc' }));
    const viaFull = renderChart(withParams(P01, { 'chart.kind.P-01.sort': 'valueAsc' }));
    expect(viaAlias.svg).toBe(viaFull.svg);
    expect(issue(viaAlias, 'PARAM_ALIAS')?.status).toBe('REPORT');
    expect(issue(viaFull, 'PARAM_ALIAS')).toBeUndefined();
  });

  it('kunci asing tidak mengubah SVG; hanya PARAM_IGNORED REPORT', () => {
    const plain = renderChart(withParams(P01, {}));
    const junk = renderChart(withParams(P01, { zz: 1 }));
    expect(junk.svg).toBe(plain.svg);
    expect(issue(junk, 'PARAM_IGNORED')?.status).toBe('REPORT');
    expect(junk.report.issues.filter((i) => i.status === 'FAIL')).toEqual([]);
  });
});
