// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/figures/fig03a-chart-intent.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
// FIG-03a (D-482 butir 2): medan maksud analitis chart di mesin — paritas tanpa maksud, topN
// (rekonsiliasi total, data negatif, seri), sort, orientation per keluarga, labelShort (sumbu vs
// teks lengkap), HINT_IGNORED, saran kapasitas, dan saran lint yang cocok dengan medan nyata.
import { describe, expect, it } from '../_vitest';
import type { ChartIntent, StudioChartV1 } from '@/lib/studio/contract';
import { applyChartIntent, chartIntentOf, estimateHeightMm, renderChart } from '@/lib/studio/engine/chart/core';
import { EMPTY_CHART_TEMPLATE } from '@/lib/studio/engine/chart/core/composite';
import { geometryIssues } from '@/lib/studio/engine/chart/core/geometry';
import { catchErr, chartSpecsByCode, clone } from './_helpers';

const specs = chartSpecsByCode() as unknown as Record<string, StudioChartV1>;
const T = EMPTY_CHART_TEMPLATE;
const cat = (labels: string[], values: number[], kind = 'P-02'): StudioChartV1 => ({
  $schema: 'studio.chart/v1',
  kind: kind as StudioChartV1['kind'],
  title: 'Uji maksud.',
  source: 'Uji',
  widthMm: 166,
  data: { shape: 'categorical', points: labels.map((label, i) => ({ label, value: values[i] })) },
});
const with_ = (s: StudioChartV1, intent: ChartIntent): StudioChartV1 => ({ ...clone(s), intent });
const ids = (r: { report: { issues: Array<{ checkId: string }> } }) => r.report.issues.map((i) => i.checkId);
const detail = (r: { report: { issues: Array<{ checkId: string; detail?: string }> } }, id: string) =>
  r.report.issues.filter((i) => i.checkId === id).map((i) => i.detail ?? '');
const N30 = Array.from({ length: 30 }, (_, i) => `Kategori nomor ${i + 1}`);
const V30 = Array.from({ length: 30 }, (_, i) => ((i * 37) % 23) + 1);
const points = (s: StudioChartV1) => (s.data?.shape === 'categorical' ? s.data.points : []);

describe('paritas: tanpa medan maksud = jalur lama', () => {
  it('intent {} dan orientation auto memberi SVG identik dengan spec tanpa intent (semua fixture)', () => {
    for (const [code, spec] of Object.entries(specs)) {
      const base = renderChart(clone(spec)).svg;
      expect(renderChart(with_(spec, {})).svg, code).toBe(base);
      expect(renderChart(with_(spec, { orientation: 'auto' })).svg, code).toBe(base);
    }
  });
  it('chartIntentOf: undefined tanpa medan; hanya medan maksud yang diambil', () => {
    expect(chartIntentOf({})).toBeUndefined();
    const block = { code: 'P-02', topN: 8, otherLabel: 'Lain', labelShort: [{ label: 'A', short: 'a', x: 1 }], caption: 'x' } as never;
    expect(chartIntentOf(block)).toEqual({ topN: 8, otherLabel: 'Lain', labelShort: [{ label: 'A', short: 'a' }] });
  });
});

describe('topN: N terbesar + "Lainnya (k)" = jumlah sisa (tidak pernah diam-diam)', () => {
  it('kategoris: 30 -> 8 + Lainnya (22), urutan agen, total tetap, REPORT INTENT_APPLIED', () => {
    const spec = with_(cat(N30, V30), { topN: 8 });
    const a = applyChartIntent(spec, T);
    const pts = points(a.spec);
    expect(pts).toHaveLength(9);
    expect(pts[8].label).toBe('Lainnya (22)');
    const total = V30.reduce((x, v) => x + v, 0);
    expect(pts.reduce((x, p) => x + p.value, 0)).toBeCloseTo(total, 9);
    const top8 = [...V30].sort((x, y) => y - x).slice(0, 8);
    expect(pts.slice(0, 8).map((p) => p.value).sort((x, y) => y - x)).toEqual(top8);
    const idx = pts.slice(0, 8).map((p) => N30.indexOf(p.label));
    expect(idx).toEqual([...idx].sort((x, y) => x - y));
    const r = renderChart(spec);
    expect(detail(r, 'INTENT_APPLIED').join(' ')).toMatch(/topN 8: 30 kategori -> 8 terbesar .*"Lainnya \(22\)" = \d+ .*total 347 tetap/);
    expect(r.svg).toContain('Lainnya (22)');
    expect(r.heightMm).toBeLessThan(renderChart(cat(N30, V30)).heightMm);
    // P-01 (tinggi bergantung jumlah baris): taksiran ikut jumlah kategori sesudah topN.
    expect(estimateHeightMm(with_(cat(N30, V30, 'P-01'), { topN: 8 }))).toBeLessThan(estimateHeightMm(cat(N30, V30, 'P-01')));
  });
  it('tanpa topN tidak ada agregasi (30 kategori tetap 30)', () => {
    expect(renderChart(cat(N30, V30)).svg).not.toContain('Lainnya');
  });
  it('data negatif: peringkat menurut |nilai|, Lainnya = jumlah bertanda', () => {
    const v = [5, -40, 3, 2, -1, 30, 4];
    const a = applyChartIntent(with_(cat(['a', 'b', 'c', 'd', 'e', 'f', 'g'], v), { topN: 3, otherLabel: 'Sisa' }), T);
    expect(points(a.spec).map((p) => [p.label, p.value])).toEqual([['a', 5], ['b', -40], ['f', 30], ['Sisa (4)', 3 + 2 - 1 + 4]]);
  });
  it('seri (K-01): jumlah per seri, null dilewati, semua null -> null', () => {
    const s: StudioChartV1 = {
      ...clone(specs['K-01']),
      data: {
        shape: 'series',
        categories: ['A', 'B', 'C', 'D', 'E', 'F'],
        series: [
          { name: 'S1', values: [10, 1, 2, 30, 3, null] },
          { name: 'S2', values: [1, null, null, 1, null, null] },
        ],
      },
    };
    const a = applyChartIntent(with_(s, { topN: 3 }), T);
    const d = a.spec.data as Extract<StudioChartV1['data'], { shape: 'series' }>;
    expect(d.categories).toEqual(['A', 'D', 'E', 'Lainnya (3)']);
    expect(d.series[0].values).toEqual([10, 30, 3, 1 + 2]);
    expect(d.series[1].values).toEqual([1, 1, null, null]);
    expect(renderChart(with_(s, { topN: 3 })).svg).toContain('Lainnya (3)');
  });
  it('HINT_IGNORED: kode tak aditif (P-10), sisa < 2, bentuk tanpa kategori', () => {
    expect(detail(renderChart(with_(specs['P-10'], { topN: 3 })), 'HINT_IGNORED').join(' ')).toContain('topN diabaikan: P-10');
    const five = cat(['a', 'b', 'c', 'd', 'e'], [5, 4, 3, 2, 1]);
    const r = renderChart(with_(five, { topN: 4 }));
    expect(detail(r, 'HINT_IGNORED').join(' ')).toContain('topN 4 diabaikan: 5 kategori');
    expect(r.svg).toBe(renderChart(five).svg);
    expect(detail(renderChart(with_(specs['H-01'], { topN: 5, sort: 'desc' })), 'HINT_IGNORED')).toHaveLength(2);
  });
});

describe('sort', () => {
  it('kategoris P-02 desc/asc stabil; none = urutan agen', () => {
    const s = cat(['a', 'b', 'c', 'd'], [2, 9, 2, 5]);
    expect(points(applyChartIntent(with_(s, { sort: 'desc' }), T).spec).map((p) => p.label)).toEqual(['b', 'd', 'a', 'c']);
    expect(points(applyChartIntent(with_(s, { sort: 'asc' }), T).spec).map((p) => p.label)).toEqual(['a', 'c', 'd', 'b']);
    expect(renderChart(with_(s, { sort: 'none' })).svg).toBe(renderChart(s).svg);
  });
  it('seri P-03: menurut jumlah semua seri', () => {
    const a = applyChartIntent(with_(specs['P-03'], { sort: 'asc' }), T);
    const d = a.spec.data as Extract<StudioChartV1['data'], { shape: 'series' }>;
    const tot = d.categories.map((_, i) => d.series.reduce((x, s) => x + (s.values[i] ?? 0), 0));
    expect(tot).toEqual([...tot].sort((x, y) => x - y));
  });
  it('P-01: sort none -> sort=natural (urutan agen, bukan valueDesc templat); topN tanpa sort -> valueDesc + Lainnya terakhir', () => {
    const s = cat(['a', 'b', 'c', 'd', 'e', 'f'], [1, 9, 3, 8, 2, 7], 'P-01');
    const none = applyChartIntent(with_(s, { sort: 'none' }), T).spec;
    expect(none.params?.['chart.kind.P-01.sort']).toBe('natural');
    const top = applyChartIntent(with_(s, { topN: 3 }), T).spec;
    expect(points(top).map((p) => p.label)).toEqual(['b', 'd', 'f', 'Lainnya (3)']);
    expect(top.params?.['chart.kind.P-01.sort']).toBe('natural');
  });
  it('urutan bermakna (W-01 waktu) -> HINT_IGNORED', () => {
    expect(detail(renderChart(with_(specs['W-01'], { sort: 'desc' })), 'HINT_IGNORED').join(' ')).toContain('sort diabaikan: urutan kategori W-01');
  });
});

describe('orientation per keluarga', () => {
  const longLabels = Array.from({ length: 6 }, (_, i) => `Dinas Pekerjaan Umum dan Penataan Ruang ${i + 1}`);
  it('P-02 horizontal -> P-01 (urutan data) = SVG P-01 natural', () => {
    const s = cat(['a', 'b', 'c'], [1, 3, 2]);
    const r = renderChart(with_(s, { orientation: 'horizontal' }));
    const p01 = renderChart({ ...s, kind: 'P-01', params: { 'chart.kind.P-01.sort': 'natural' } });
    expect(r.svg).toBe(p01.svg);
    expect(detail(r, 'INTENT_APPLIED').join(' ')).toContain('P-02 -> P-01');
  });
  it('P-01 vertical -> P-02; W-02 horizontal -> P-01', () => {
    expect(applyChartIntent(with_(specs['P-01'], { orientation: 'vertical' }), T).spec.kind).toBe('P-02');
    const w = applyChartIntent(with_(specs['W-02'], { orientation: 'horizontal' }), T).spec;
    expect(w.kind).toBe('P-01');
    expect(Object.keys(w.params ?? {}).some((k) => k.startsWith('chart.kind.W-02.'))).toBe(false);
  });
  it('P-02 vertical mematikan AUTO_ORIENT (label panjang tetap kolom)', () => {
    const s = cat(longLabels, [4, 6, 2, 8, 5, 3]);
    expect(ids(renderChart(s))).toContain('AUTO_ORIENT');
    const r = renderChart(with_(s, { orientation: 'vertical' }));
    expect(ids(r)).not.toContain('AUTO_ORIENT');
    expect(ids(r)).not.toContain('HINT_IGNORED');
  });
  it('tanpa varian: P-03 horizontal, K-01 vertical, K-05 -> HINT_IGNORED; arah bawaan = tanpa laporan', () => {
    const cases: Array<[string, 'horizontal' | 'vertical']> = [['P-03', 'horizontal'], ['K-01', 'vertical'], ['K-05', 'horizontal']];
    for (const [code, dir] of cases) {
      const r = renderChart(with_(specs[code], { orientation: dir }));
      expect(detail(r, 'HINT_IGNORED').join(' '), code).toContain(`orientation "${dir}" diabaikan: ${code}`);
      expect(r.svg, code).toBe(renderChart(clone(specs[code])).svg);
    }
    expect(ids(renderChart(with_(specs['P-03'], { orientation: 'vertical' })))).not.toContain('HINT_IGNORED');
  });
});

describe('labelShort: teks sumbu singkat, label lengkap di <title> dan data', () => {
  const full = 'Dinas Pekerjaan Umum dan Penataan Ruang';
  const s = cat([full, 'Dinas Kesehatan', 'Dinas Pendidikan'], [5, 3, 4]);
  it('sumbu memakai label singkat; <title> memuat label lengkap; masukan tidak dimutasi', () => {
    const input = with_(s, { labelShort: [{ label: full, short: 'DPUPR' }] });
    const before = JSON.stringify(input);
    const r = renderChart(input);
    expect(JSON.stringify(input)).toBe(before);
    expect(r.svg).toMatch(/<g data-label-short="1"><title>Dinas Pekerjaan Umum dan Penataan Ruang<\/title><text[^>]*>DPUPR<\/text><\/g>/);
    expect(r.svg).not.toMatch(/<text[^>]*>Dinas Pekerjaan Umum dan Penataan Ruang<\/text>/i);
    // Label kolom inti ditulis kapital; label tanpa singkatan tetap teks lengkap tanpa pembungkus.
    expect(r.svg).toMatch(/<text[^>]*>DINAS KESEHATAN<\/text>/);
    expect(r.svg).not.toContain('<title>Dinas Kesehatan</title>');
    expect(detail(r, 'INTENT_APPLIED').join(' ')).toContain('labelShort: 1 label sumbu disingkat');
  });
  it('seri (P-03): kategori diganti di sumbu, nama seri tidak', () => {
    const r = renderChart(with_(specs['P-03'], { labelShort: [{ label: 'Kamera', short: 'Kam.' }] }));
    expect(r.svg).toContain('<title>Kamera</title>');
    expect(r.svg).toContain('Penawaran A');
  });
  it('label tidak dikenal / ganda / singkatan bertabrakan -> SCHEMA_INVALID ber-pointer', () => {
    const e1 = catchErr(() => renderChart(with_(s, { labelShort: [{ label: full, short: 'D' }, { label: 'Dinas Sosial', short: 'DS' }] })));
    expect(e1.code).toBe('SCHEMA_INVALID');
    expect(e1.details).toMatchObject({ pointer: '/labelShort/1/label', checkId: 'CHART_INTENT' });
    const e2 = catchErr(() => renderChart(with_(s, { labelShort: [{ label: full, short: 'D' }, { label: full, short: 'E' }] })));
    expect(e2.details).toMatchObject({ pointer: '/labelShort/1/label' });
    const e3 = catchErr(() => renderChart(with_(s, { labelShort: [{ label: full, short: 'Dinas Kesehatan' }] })));
    expect(e3.details).toMatchObject({ pointer: '/labelShort/0/short' });
  });
  it('bentuk tanpa sumbu kategori (H-01 xy) -> HINT_IGNORED, SVG tidak berubah', () => {
    const r = renderChart(with_(specs['H-01'], { labelShort: [{ label: 'x', short: 'y' }] }));
    expect(detail(r, 'HINT_IGNORED').join(' ')).toContain('labelShort diabaikan: H-01');
    expect(r.svg).toBe(renderChart(clone(specs['H-01'])).svg);
  });
});

describe('komposit, penolakan kapasitas, dan saran lint', () => {
  it('komposit + intent -> HINT_IGNORED, SVG tetap', () => {
    const comp = Object.values(specs).find((s) => s.kind === 'composite');
    if (!comp) return;
    const r = renderChart(with_(comp, { topN: 5 }));
    expect(ids(r)).toContain('HINT_IGNORED');
    expect(r.svg).toBe(renderChart(clone(comp)).svg);
  });
  it('pie 9 bagian tetap ditolak; pesan menyarankan topN 4; topN 4 lalu lolos', () => {
    const pie = cat(N30.slice(0, 9), V30.slice(0, 9), 'K-05');
    const e = catchErr(() => renderChart(pie));
    expect(e.message).toContain('`topN: 4`');
    expect(e.message).toContain('pisah menjadi dua gambar');
    expect(renderChart(with_(pie, { topN: 4 })).svg).toContain('Lainnya (5)');
  });
  it('saran lint memakai nama/bentuk medan nyata dan hanya untuk kode yang menerapkannya', () => {
    const g = {
      widthMm: 166,
      heightMm: 50,
      nText: 2,
      counts: { textOverlap: 1, textOutside: 0, textStraddleMark: 0, lineThroughText: 0 },
      defects: [{ kind: 'textOverlap' as const, text: 'a', other: 'b' }],
      score: 1,
    };
    const p02 = geometryIssues(g, { code: 'P-02', nCategories: 20, maxLabelChars: 60, maxSeriesChars: 0 })[0].suggest;
    expect(p02).toContain('`orientation: "horizontal"` (P-02 -> P-01)');
    expect(p02).toContain('`topN: 8`');
    expect(p02).toContain('`labelShort: [{ "label":');
    const s02 = geometryIssues(g, { code: 'S-02', nCategories: 20, maxLabelChars: 60, maxSeriesChars: 0 })[0].suggest;
    expect(s02).not.toContain('orientation:');
    expect(s02).not.toContain('topN:');
    expect(s02).not.toContain('labelShort');
  });
});
