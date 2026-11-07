// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/figures/fig03a-compose-intent.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
/**
 * FIG-03a (D-482 butir 2, D-496): compose meneruskan medan maksud blok chart v2 ke mesin.
 * Tanpa medan -> spec tanpa `intent` (byte-identik dengan sebelum FIG-03a).
 */
import { describe, it, expect } from '../_vitest';
import type { ChartBlock, ChartV2, StudioChartV1 } from '@/lib/studio/contract';
import { renderChart } from '@/lib/studio/engine/chart/core';
import { mapBlock, type BlockCtx } from '@/lib/studio/services/compose/blocks';

const CTX: BlockCtx = { glyphs: new Set<string>(), params: {}, classification: 'TERBATAS', artifactLabel: 'Gambar 1.1' };
const runs = (t: string) => ({ runs: [{ t }] });
const points = Array.from({ length: 12 }, (_, i) => ({ label: `Kategori nomor ${i + 1}`, value: 12 - i }));
const v2 = (extra: Record<string, unknown> = {}): ChartV2 =>
  ({
    type: 'chart',
    code: 'P-01',
    data: { shape: 'categorical', points },
    caption: runs('Uji maksud.'),
    source: runs('Sumber uji FIG-03a, 2026.'),
    ...extra,
  }) as unknown as ChartV2;
const specOf = (b: ChartV2) => (mapBlock(b, 'p1', CTX) as ChartBlock).spec as StudioChartV1;

describe('FIG-03a compose: medan maksud sampai ke mesin', () => {
  it('tanpa medan: spec tanpa intent', () => {
    expect('intent' in specOf(v2())).toBe(false);
  });

  it('topN + otherLabel diteruskan dan diterapkan (8 + 1 kategori Lainnya)', () => {
    const spec = specOf(v2({ topN: 8, otherLabel: 'Sisanya' }));
    expect(spec.intent).toEqual({ topN: 8, otherLabel: 'Sisanya' });
    const svg = renderChart(spec).svg;
    expect(svg).toContain('Sisanya');
    expect(svg).not.toContain('Kategori nomor 12<');
  });

  it('sort dan labelShort diteruskan apa adanya', () => {
    const spec = specOf(v2({ sort: 'asc', labelShort: [{ label: 'Kategori nomor 1', short: 'K1' }] }));
    expect(spec.intent).toEqual({ sort: 'asc', labelShort: [{ label: 'Kategori nomor 1', short: 'K1' }] });
    expect(renderChart(spec).svg).toContain('K1');
  });
});
