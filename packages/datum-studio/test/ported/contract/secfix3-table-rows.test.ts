// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/contract/secfix3-table-rows.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
// SEC-FIX3 (D-508) N-4: P-15 `params.tableRows` x `tableHead` dihitung sebagai sel matriks di cek kapasitas (batas sama
// dengan `data.matrix`: baris <= items, sel <= matrixCells), di spec tunggal maupun panel komposit.
import { describe, expect, it } from '../_vitest';
import { chartCapacityIssues, FIGURE_LIMITS } from '@/lib/studio/services/render/figure-limits';

const L = FIGURE_LIMITS;
const head = (c: number) => Array.from({ length: c }, (_, j) => `K${j}`);
const rows = (r: number, c: number) => Array.from({ length: r }, (_, i) => [`B${i}`, ...Array.from({ length: c - 1 }, (_, j) => (i * j) % 97)]);
const p15 = (r: number, c: number) => ({
  $schema: 'studio.chart/v1',
  kind: 'P-15',
  title: 'Tabel.',
  source: 'Uji',
  widthMm: 166,
  params: { tableHead: head(c), tableRows: rows(r, c) },
});

describe('SEC-FIX3 N-4: sel tableRows P-15 di cek kapasitas', () => {
  it('170x170 lewat tableRows ditolak cepat (sebelumnya lolos, render 56,7 s)', () => {
    const t0 = performance.now();
    const issues = chartCapacityIssues(p15(170, 170));
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(issues.some((i) => i.pointer === '/params/tableRows' && i.limit === L.matrixCells && i.actual === 170 * 170)).toBe(true);
  });

  it('baris tableRows > items ditolak walau sel di bawah batas', () => {
    const issues = chartCapacityIssues(p15(L.items + 1, 2));
    expect(issues.some((i) => i.pointer === '/params/tableRows' && i.limit === L.items)).toBe(true);
  });

  it('tabel sah pada batas lolos (50x100 = 5000 sel; 20x5)', () => {
    expect(chartCapacityIssues(p15(50, 100))).toEqual([]);
    expect(chartCapacityIssues(p15(20, 5))).toEqual([]);
  });

  it('tableHead lebar x sedikit baris dihitung dari kepala (sel = baris x maks(kolom kepala, isi baris))', () => {
    const s = p15(30, 2);
    s.params.tableHead = head(200);
    expect(chartCapacityIssues(s).some((i) => i.pointer === '/params/tableRows' && i.actual === 30 * 200)).toBe(true);
  });

  it('panel komposit dengan tableRows juga dihitung', () => {
    const spec = {
      $schema: 'studio.chart/v1',
      kind: 'composite',
      title: 'K.',
      source: 'Uji',
      widthMm: 166,
      composite: { columns: 2, panels: [{ name: 'a', code: 'P-15', spec: { kind: 'P-15', params: { tableHead: head(100), tableRows: rows(100, 100) } } }] },
    };
    expect(chartCapacityIssues(spec).some((i) => i.pointer === '/composite/panels/0/spec/params/tableRows' && i.limit === L.matrixCells)).toBe(true);
  });
});
