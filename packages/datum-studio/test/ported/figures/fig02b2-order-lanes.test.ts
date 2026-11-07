// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/figures/fig02b2-order-lanes.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
// FIG-02b2 (P1-11, P1-12): pengurutan dalam lapis gaya Sugiyama dan urutan jalur kanal.
// Fungsi murni: tanpa SVG, tanpa jam/acak; hasil harus deterministik.
import { describe, it, expect } from '../_vitest';
import { bilayerCrossings, longestPathLayers, orderLayers, totalCrossings } from '@/lib/studio/engine/diagram/fit/order';
import { laneCost, laneOrder, lanePositions, type LaneEdge } from '@/lib/studio/engine/diagram/fit/lanes';

type E = ReadonlyArray<readonly [string, string]>;

describe('orderLayers (P1-11)', () => {
  const crossed: E = [['a', 'z'], ['b', 'y'], ['c', 'x']];

  it('menghitung persilangan dua lapis: a-z, b-y, c-x = 3', () => {
    expect(bilayerCrossings(['a', 'b', 'c'], ['x', 'y', 'z'], crossed)).toBe(3);
  });

  it('graf dikenal: persilangan turun 3 -> 0', () => {
    const r = orderLayers([['a', 'b', 'c'], ['x', 'y', 'z']], crossed);
    expect(r.before).toBe(3);
    expect(r.after).toBe(0);
    expect(r.changed).toBe(true);
    expect(totalCrossings(r.layers, crossed)).toBe(0);
    // multiset simpul per lapis tetap
    expect([...r.layers[0]].sort()).toEqual(['a', 'b', 'c']);
    expect([...r.layers[1]].sort()).toEqual(['x', 'y', 'z']);
  });

  it('tiga lapis dengan tepi lintas: tetap turun dan tidak pernah naik', () => {
    const edges: E = [['a', 'y'], ['b', 'x'], ['x', 'q'], ['y', 'p'], ['a', 'q']];
    const r = orderLayers([['a', 'b'], ['x', 'y'], ['p', 'q']], edges);
    expect(r.after).toBeLessThan(r.before);
    expect(totalCrossings(r.layers, edges)).toBe(r.after);
  });

  it('masukan tanpa silang tidak berubah (urutan agen dipertahankan)', () => {
    const edges: E = [['a', 'x'], ['b', 'y'], ['c', 'z']];
    const layers = [['a', 'b', 'c'], ['x', 'y', 'z']];
    const r = orderLayers(layers, edges);
    expect(r.changed).toBe(false);
    expect(r.layers).toEqual(layers);
  });

  it('deterministik: dua panggilan memberi hasil identik', () => {
    const edges: E = [['a', 'w'], ['a', 'y'], ['b', 'x'], ['c', 'w'], ['d', 'x'], ['d', 'z']];
    const L = [['a', 'b', 'c', 'd'], ['w', 'x', 'y', 'z']];
    expect(orderLayers(L, edges)).toEqual(orderLayers(L, edges));
  });

  it('penetapan lapis longest-path dari tepi', () => {
    const layers = longestPathLayers(['a', 'b', 'c', 'd'], [['a', 'b'], ['b', 'c'], ['a', 'd']]);
    expect(layers).toEqual([['a'], ['b', 'd'], ['c']]);
  });
});

describe('laneOrder (P1-12)', () => {
  it('dua tepi ke kanan: tepi bertujuan lebih kanan di jalur atas (biaya 0)', () => {
    const e: LaneEdge = { top: 10, bottom: 50 };
    const f: LaneEdge = { top: 20, bottom: 70 };
    expect(laneCost(e, f)).toBe(2);
    expect(laneCost(f, e)).toBe(0);
    expect(laneOrder([e, f])).toEqual([1, 0]);
  });

  it('dua tepi ke kiri: tepi bertujuan lebih kiri di jalur atas (biaya 0)', () => {
    const e: LaneEdge = { top: 50, bottom: 10 };
    const f: LaneEdge = { top: 70, bottom: 20 };
    expect(laneCost(e, f)).toBe(0);
    expect(laneOrder([e, f])).toEqual([0, 1]);
  });

  it('kipas keluar 4 tepi: urutan jalur tanpa persilangan', () => {
    const fan: LaneEdge[] = [10, 11, 12, 13].map((t, i) => ({ top: t, bottom: 20 + i * 30 }));
    const ord = laneOrder(fan);
    let cost = 0;
    for (let i = 0; i < ord.length; i++) for (let j = i + 1; j < ord.length; j++) cost += laneCost(fan[ord[i]], fan[ord[j]]);
    expect(cost).toBe(0);
  });

  it('posisi jalur berbeda, di dalam pita, berjarak >= 0,5 mm', () => {
    const ys = lanePositions(5, 30, 40, 35);
    expect(new Set(ys).size).toBe(5);
    for (const y of ys) {
      expect(y).toBeGreaterThanOrEqual(30);
      expect(y).toBeLessThanOrEqual(40);
    }
    const s = [...ys].sort((a, b) => a - b);
    for (let i = 1; i < s.length; i++) expect(s[i] - s[i - 1]).toBeGreaterThanOrEqual(0.5);
  });
});
