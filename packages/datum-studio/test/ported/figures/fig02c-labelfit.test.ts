// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/figures/fig02c-labelfit.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
// FIG-02c: siklus 2 perbaikan label grafik — pengecualian halo (opt-in) di lint geometri,
// label nilai bertetangga (placeValueLabels), rintangan segmen (placePointLabels), saran
// REPORT konkret (P-15, satuan panjang), dan perbaikan ujung-ke-ujung berpagar cacat.
import { describe, it, expect } from '../_vitest';
import { renderChart } from '@/lib/studio/engine/chart/core';
import { type FitNote, withFit } from '@/lib/studio/engine/chart/core/fit';
import { CHART_LINT_OPTIONS, geometryIssues, hintCtxFromSpec, lintChartGeometry } from '@/lib/studio/engine/chart/core/geometry';
import { placePointLabels, placeValueLabels, segmentHitsBox } from '@/lib/studio/engine/chart/core/labelfit';
import { PARITY_CHART_DIR, chartSpecsByCode, clone, readJson } from './_helpers';
import { readdirSync } from 'node:fs';
import path from 'node:path';

const svg = (body: string, w = 100, h = 50) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}mm" height="${h}mm" viewBox="0 0 ${w} ${h}">\n${body}\n</svg>`;
const HALO = ' stroke="#FCFCFB" stroke-width="0.6" paint-order="stroke"';
const M = (x: number, y: number, s: string, extra = '') =>
  `<text x="${x}" y="${y}" font-family="IBM Plex Mono" font-size="2.2" fill="#000000" text-anchor="middle"${extra}>${s}</text>`;

describe('lintChartGeometry: pengecualian halo (FIG-02c, opt-in)', () => {
  const line = '<path data-mark="line" d="M0 19.77 L100 19.77" fill="none" stroke="#000000" stroke-width="0.4"/>';
  const area = '<path data-mark="area" d="M0 0 L100 0 L100 19.6 L0 19.6 Z" fill="#DDDDDD"/>';
  const bar = '<rect data-mark="bar" x="0" y="0" width="50" height="19.6" fill="#333333"/>';

  it('tanpa opsi: perilaku FIG-02a (teks berhalo tetap dihitung)', () => {
    const g = lintChartGeometry(svg(`${area}${line}${M(50, 20.6, '-84', HALO)}`));
    expect(g.counts.lineThroughText).toBe(1);
    expect(g.counts.textStraddleMark).toBe(1);
  });

  it('CHART_LINT_OPTIONS: teks berhalo dikecualikan dari garis dan pita area', () => {
    const g = lintChartGeometry(svg(`${area}${line}${M(50, 20.6, '-84', HALO)}`), CHART_LINT_OPTIONS);
    expect(g.score).toBe(0);
  });

  it('pengecualian hanya untuk teks berhalo, dan tidak untuk tanda isian batang', () => {
    expect(lintChartGeometry(svg(`${area}${line}${M(50, 20.6, '-84')}`), CHART_LINT_OPTIONS).score).toBe(2);
    expect(lintChartGeometry(svg(`${bar}${M(50, 20.6, '5', HALO)}`), CHART_LINT_OPTIONS).counts.textStraddleMark).toBe(1);
  });
});

describe('placeValueLabels (FIG-02c)', () => {
  const font = { pt: 6.5, face: 'data' as const };
  const near = (x: number) => ({ text: '+73,0', cands: [{ x, y: 20, anchor: 'middle' as const }, { x, y: 17, anchor: 'middle' as const }, { x, y: 14, anchor: 'middle' as const }] });

  it('di luar fit -> null (jalur lama byte-identik)', () => {
    expect(placeValueLabels([near(10), near(12)], font, [0, 0, 100, 50])).toBeNull();
  });

  it('di dalam fit, posisi lama semuanya bebas -> null', () => {
    const r = withFit({ widthMm: 100, notes: [] }, () => placeValueLabels([near(10), near(40)], font, [0, 0, 100, 50]));
    expect(r).toBeNull();
  });

  it('label bertumpuk berselang naik; tanpa kandidat bebas -> disembunyikan + LABEL_DROPPED', () => {
    const notes: FitNote[] = [];
    const r = withFit({ widthMm: 100, notes }, () => placeValueLabels([near(10), near(12), near(14), near(16)], font, [0, 0, 100, 50]));
    expect(r).not.toBeNull();
    const ys = r!.map((p) => p?.y ?? null);
    expect(ys.slice(0, 3)).toEqual([20, 17, 14]);
    expect(ys[3]).toBeNull();
    expect(notes.map((n) => n.checkId)).toEqual(['VALUE_LABEL_MOVED', 'LABEL_DROPPED']);
  });

  it('prioritas: label berprioritas tinggi menempati posisi lama', () => {
    const r = withFit({ widthMm: 100, notes: [] }, () => placeValueLabels([near(10), { ...near(12), priority: 1 }], font, [0, 0, 100, 50]));
    expect(r![1]!.y).toBe(20);
    expect(r![0]!.y).toBe(17);
  });
});

describe('placePointLabels: posisi pilihan + rintangan segmen (FIG-02c)', () => {
  it('segmentHitsBox: diagonal memotong, segmen di luar tidak', () => {
    expect(segmentHitsBox([0, 0, 10, 10], [4, 4, 6, 6])).toBe(true);
    expect(segmentHitsBox([0, 10, 3, 10], [4, 4, 6, 6])).toBe(false);
  });

  it('posisi pilihan dipakai bila bebas; digeser bila segmen menembusnya', () => {
    const p = { x: 50, y: 25, r: 0.6, text: 'Awal', prefer: { x: 52, y: 22, anchor: 'start' as const } };
    const free = placePointLabels([p], { pt: 6.2 }, [0, 0, 100, 50]);
    expect(free[0]).toMatchObject({ x: 52, y: 22, anchor: 'start' });
    const blocked = placePointLabels([p], { pt: 6.2 }, [0, 0, 100, 50], [], [[40, 21, 70, 21]]);
    expect(blocked[0]).not.toBeNull();
    expect(blocked[0]).not.toMatchObject({ x: 52, y: 22 });
  });
});

describe('saran REPORT konkret (FIG-02c)', () => {
  it('P-15 24 x 24: kapasitas kolom, topN, pisah tabel', () => {
    const spec = {
      kind: 'P-15',
      widthMm: 128,
      dec: 1,
      data: { shape: 'matrix', rows: Array.from({ length: 24 }, (_, i) => `Baris ${i}`), cols: Array.from({ length: 24 }, (_, i) => `K${i}`), values: Array.from({ length: 24 }, () => Array.from({ length: 24 }, () => 410)) },
    };
    const ctx = hintCtxFromSpec(spec);
    expect(ctx).toMatchObject({ nRows: 24, nCols: 24, widthMm: 128 });
    const [i] = geometryIssues({ widthMm: 128, heightMm: 50, nText: 2, counts: { textOverlap: 1, textOutside: 0, textStraddleMark: 0, lineThroughText: 0 }, defects: [{ kind: 'textOverlap', text: '410,0', other: '98,4' }], score: 1 }, ctx);
    expect(i.suggest).toMatch(/tabel 24 x 24 melebihi kapasitas pada 128 mm \(muat ~\d+ kolom angka\)/);
    expect(i.suggest).toContain('topN');
    expect(i.suggest).toContain('blok tabel dokumen');
  });

  it('satuan panjang yang menempel pada label nilai -> persingkat `unit`', () => {
    const ctx = hintCtxFromSpec({ kind: 'K-05', data: { shape: 'categorical', points: [] }, unit: '% (juta rupiah per satuan kerja)' } as never);
    const [i] = geometryIssues({ widthMm: 128, heightMm: 50, nText: 2, counts: { textOverlap: 1, textOutside: 0, textStraddleMark: 0, lineThroughText: 0 }, defects: [{ kind: 'textOverlap', text: 'pemerintah', other: '68 % (juta rupiah per satuan kerja)' }], score: 1 }, ctx);
    expect(i.suggest).toContain('persingkat `unit`');
  });
});

describe('renderChart: perbaikan siklus 2 berpagar cacat (FIG-02c)', () => {
  const fixtures = readdirSync(PARITY_CHART_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => readJson<Record<string, unknown>>(path.join(PARITY_CHART_DIR, f)));
  const fx = (kind: string, style?: string) => {
    const s = clone(fixtures.find((f) => f.kind === kind) ?? chartSpecsByCode()[kind]) as Record<string, unknown>;
    if (style) s.style = style;
    return s;
  };

  it('H-06 datum (fixture): label kontur berhalo saat fit -> lint chart bersih, deterministik', () => {
    const a = renderChart(fx('H-06', 'datum') as never);
    const b = renderChart(fx('H-06', 'datum') as never);
    expect(a.svg).toBe(b.svg);
    expect(a.report.issues.map((i) => i.checkId)).toEqual(expect.arrayContaining(['AUTO_FIT', 'LABEL_HALO']));
    expect(lintChartGeometry(a.svg, CHART_LINT_OPTIONS).score).toBe(0);
  });

  it('S-08 datum (fixture): label lingkar yang memotong baji di semua sinar disembunyikan (REPORT)', () => {
    const r = renderChart(fx('S-08', 'datum') as never);
    expect(lintChartGeometry(r.svg, CHART_LINT_OPTIONS).score).toBe(0);
    expect(r.report.issues.some((i) => i.checkId === 'LABEL_DROPPED' && i.status === 'REPORT')).toBe(true);
  });

  it('P-05 datum 20 grup: label "maks" tidak bertumpuk; tidak pernah FAIL', () => {
    const s = fx('P-05', 'datum') as Record<string, unknown> & { data: { groups: { name: string; values: number[] }[] } };
    const g0 = s.data.groups;
    s.data.groups = Array.from({ length: 20 }, (_, i) => ({ name: `Grup ${i + 1}`, values: g0[i % g0.length].values.map((v) => Math.round(v * (0.95 + (i % 5) * 0.02) * 10) / 10) }));
    const r = renderChart(clone(s) as never);
    const g = lintChartGeometry(r.svg, CHART_LINT_OPTIONS);
    expect(g.defects.filter((d) => d.kind === 'textOverlap' && d.text.startsWith('maks') && (d.other ?? '').startsWith('maks'))).toEqual([]);
    expect(r.report.issues.filter((i) => i.status === 'FAIL')).toEqual([]);
  });

  it('H-09 nama himpunan panjang: dibungkus dan tidak menutup angka irisan', () => {
    const s = fx('H-09') as Record<string, unknown> & { data: { sets: { name: string }[]; overlaps: { sets: string[] }[] } };
    const LONG = ['Dinas Pekerjaan Umum dan Penataan Ruang Kabupaten Bandung Barat', 'Sistem pemantauan suhu ruang server lantai dua gedung utama', 'Pengadaan perangkat jaringan inti dan sakelar distribusi kantor'];
    const rename = new Map(s.data.sets.map((st, i) => [st.name, LONG[i % 3]] as const));
    s.data.sets.forEach((st) => (st.name = rename.get(st.name) as string));
    s.data.overlaps.forEach((o) => (o.sets = o.sets.map((n) => rename.get(n) ?? n)));
    const r = renderChart(clone(s) as never);
    expect(r.report.issues.map((i) => i.checkId)).toContain('VENN_LABEL_WRAP');
    expect(lintChartGeometry(r.svg, CHART_LINT_OPTIONS).counts.textOverlap).toBe(0);
  });
});
