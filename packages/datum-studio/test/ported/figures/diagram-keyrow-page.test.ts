// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/figures/diagram-keyrow-page.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
/**
 * D-288 (FIX-B2 lanjutan; satu aparatus, D-145/RQ-10): bila compose mencetak
 * baris KUNCI halaman (blok punya `keyRow`), mesin diagram TIDAK menggambar
 * baris KEY di dalam SVG; tanpa keyRow halaman, legenda tetap digambar.
 */
import { describe, expect, it } from '../_vitest';
import type { DiagramBlock, DiagramV2, StudioDiagramV1 } from '@/lib/studio/contract';
import { DIAGRAM_LAYOUTS } from '@/lib/studio/contract/dispatch';
import { buildDiagramSvg } from '@/lib/studio/engine/diagram/build';
import { LATTICE_Y, drawsSvgKeyRow, estimate, footLines } from '@/lib/studio/engine/diagram/core';
import { mapBlock, type BlockCtx } from '@/lib/studio/services/compose/blocks';
import { clone, parityDiagramSpecs } from './_helpers';

const GRAPH = parityDiagramSpecs().find((s) => s.spec.family === 'graph')!.spec as unknown as StudioDiagramV1;
// Legenda fixture dipertahankan (memuat glif rumah untuk DATUM-34) + satu butir.
const LEGEND = [...((GRAPH.legend ?? []) as string[]), 'garis penuh isi'];
const withLegend = (extra: Record<string, unknown> = {}): StudioDiagramV1 =>
  ({ ...clone(GRAPH), apparatus: 'page', legend: LEGEND, ...extra }) as StudioDiagramV1;

const CTX: BlockCtx = { glyphs: new Set<string>(), params: {}, classification: 'TERBATAS', artifactLabel: 'Gambar 3.1' };
const runs = (t: string) => ({ runs: [{ t }] });

function diagramBlockV2(keyRow: boolean): DiagramV2 {
  const s = withLegend();
  const v2 = {
    type: 'diagram',
    caption: runs('Urutan membangun dokumen.'),
    source: runs('Sumber uji.'),
    spec: { family: s.family, nodes: s.nodes, edges: s.edges, legend: s.legend, labels_verified: true },
    ...(keyRow ? { keyRow: runs('garis penuh isi · merah jalur tolak') } : {}),
  };
  return v2 as unknown as DiagramV2;
}

describe('D-288 baris KUNCI satu aparatus', () => {
  it('compose: blok diagram dengan keyRow menandai spec keyRowOnPage; tanpa keyRow tidak', () => {
    const withKey = mapBlock(diagramBlockV2(true), 'p1', CTX) as DiagramBlock;
    const without = mapBlock(diagramBlockV2(false), 'p2', CTX) as DiagramBlock;
    expect(withKey.keyRow).toBeDefined();
    expect((withKey.spec as { keyRowOnPage?: boolean }).keyRowOnPage).toBe(true);
    expect((without.spec as { keyRowOnPage?: boolean }).keyRowOnPage).toBeUndefined();
    // legenda tetap di spec (DATUM-34 membaca legend)
    expect((withKey.spec as StudioDiagramV1).legend).toEqual(LEGEND);
  });

  it('mesin: tanpa keyRow halaman, legenda tetap digambar sebagai baris KEY di SVG', () => {
    const r = buildDiagramSvg(withLegend(), { release: true });
    expect(r.svg).toContain('KEY  ');
    expect(drawsSvgKeyRow(withLegend())).toBe(true);
    expect(footLines(withLegend())).toBe(1);
  });

  it('mesin: dengan keyRow halaman, baris KEY tidak digambar dan tinggi berkurang satu baris', () => {
    const plain = buildDiagramSvg(withLegend(), { release: true });
    const page = buildDiagramSvg(withLegend({ keyRowOnPage: true }), { release: true });
    expect(page.svg).not.toContain('KEY  ');
    expect(page.svg).toContain('DATUM-APPARATUS-REQUIRED');
    expect(plain.heightMm - page.heightMm).toBeCloseTo(LATTICE_Y, 6);
    expect(footLines(withLegend({ keyRowOnPage: true }))).toBe(0);
  });

  it('estimate = build untuk spec bertanda keyRowOnPage (tinggi dan warna; keluarga tanpa penyesuaian D-290)', () => {
    const topo = parityDiagramSpecs().find((x) => x.spec.family === 'topology')!.spec as unknown as StudioDiagramV1;
    const s = { ...clone(topo), apparatus: 'page', legend: [...((topo.legend ?? []) as string[]), 'garis penuh isi'], keyRowOnPage: true } as StudioDiagramV1;
    const b = buildDiagramSvg(s, { release: true });
    const e = estimate(s, DIAGRAM_LAYOUTS[s.family]);
    expect(e.heightMm).toBeCloseTo(b.heightMm, 6);
    expect(e.colourValues).toEqual(b.report.colourValues);
  });

  it('apparatus figure dengan keyRow halaman: caption dan SUMBER tetap, KEY tidak digambar', () => {
    const r = buildDiagramSvg(withLegend({ apparatus: 'figure', keyRowOnPage: true }), { release: true });
    expect(r.svg).toContain('SUMBER  ');
    expect(r.svg).not.toContain('KEY  ');
  });
});

describe('D-290 lembar graph = kotak pembatas semua unsur + 1 baseline', () => {
  const numAttr = (svg: string, re: RegExp) => [...svg.matchAll(re)].map((m) => Number(m[1]));

  it('tepi atas = 1 baseline di atas simpul teratas; tinggi akar = kertas', () => {
    const r = buildDiagramSvg(withLegend({ keyRowOnPage: true }), { release: true });
    const nodeTops = numAttr(r.svg, /<rect x="[\d.]+" y="([\d.]+)"[^>]*data-mark="node"/g);
    expect(Math.min(...nodeTops)).toBeCloseTo(LATTICE_Y, 2);
    expect(r.svg).toContain(`height="${r.heightMm.toFixed(3).replace(/0+$/, '').replace(/\.$/, '.0')}mm"`);
  });

  it('zona kepercayaan di baris teratas ikut kotak pembatas (tidak keluar lembar)', () => {
    const s = withLegend() as StudioDiagramV1 & { zones?: unknown };
    const first = s.nodes[0].id;
    (s as { zones: unknown }).zones = [{ id: 'z1', label: 'zona uji', members: [first] }];
    const r = buildDiagramSvg(s, { release: true });
    const dashed = numAttr(r.svg, /<rect x="-?[\d.]+" y="(-?[\d.]+)"[^>]*stroke-dasharray/g);
    expect(dashed.length).toBe(1);
    expect(dashed[0]).toBeGreaterThanOrEqual(0);
    expect(dashed[0]).toBeLessThanOrEqual(LATTICE_Y + 1e-6);
  });

  it('keluarga lain tidak disesuaikan (tepi Garis A 2 kisi tetap)', () => {
    const topo = parityDiagramSpecs().find((x) => x.spec.family === 'topology')!.spec as unknown as StudioDiagramV1;
    const r = buildDiagramSvg(clone(topo), { release: false });
    const tops = numAttr(r.svg, /<rect x="[\d.]+" y="([\d.]+)"[^>]*data-mark="node"/g);
    expect(Math.min(...tops)).toBeCloseTo(LATTICE_Y * 2, 2);
  });
});
