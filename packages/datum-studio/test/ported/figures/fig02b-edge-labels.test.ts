// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/figures/fig02b-edge-labels.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
// FIG-02b (P1-13, P2-16, aktivasi): label tepi tanpa tabrakan, jepit label zona, render ulang
// hanya bila lint geometri diagram menemukan cacat.
import { describe, it, expect } from '../_vitest';
import type { StudioDiagramV1 } from '@/lib/studio/contract';
import { buildDiagramSvg } from '@/lib/studio/engine/diagram/build';
import { knockBox, knockWidthMm, layoutNotes, placeEdgeLabels, type EdgeLabelInput } from '@/lib/studio/engine/diagram/fit/labels';
import { lintDiagramGeometry } from '@/lib/studio/engine/diagram/fit/lint';
import { clone, parityDiagramSpecs } from './_helpers';

type Box = readonly [number, number, number, number];
const inter = (a: Box, b: Box) => Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
const edge = (label: string, points: Array<[number, number]>, orig: [number, number]): EdgeLabelInput => ({ label, kind: 'data', points, orig });
const ctx = (nodeBoxes: Box[] = [], extra: Partial<Parameters<typeof placeEdgeLabels>[1]> = {}) => ({ W: 166, yMax: 120, nodeBoxes, obstacles: [], ...extra });

describe('placeEdgeLabels', () => {
  it('lebar pita = mono 0,6 em kapital + 1,6 mm', () => {
    // evidence_rail 5,9 pt: 0,6 x 5,9 x 25,4/72 = 1,2488 mm per glif
    expect(knockWidthMm('data')).toBeCloseTo(4 * 1.2488 + 1.6, 3);
  });

  it('posisi bawaan bebas tabrakan dipertahankan', () => {
    const p = placeEdgeLabels([edge('data', [[10, 50], [90, 50]], [50, 49.58])], ctx());
    expect(p.placed[0]).toMatchObject({ mode: 'keep', x: 50, y: 49.58 });
  });

  it('dua label bawaan bertumpuk: yang pertama tetap, yang kedua pindah ke kandidat bebas', () => {
    const e1 = edge('permintaan data', [[10, 50], [90, 50]], [50, 49.58]);
    const e2 = edge('konfirmasi status', [[10, 52], [90, 52]], [50, 50.6]);
    const p = placeEdgeLabels([e1, e2], ctx());
    expect(p.placed[0].mode).toBe('keep');
    expect(p.placed[1].mode).not.toBe('keep');
    const b = p.placed.map((x) => knockBox(x.x, x.y, x.kw));
    expect(inter(b[0], b[1])).toBe(0);
  });

  it('label di dalam simpul dipindah keluar dari kotak simpul', () => {
    const node: Box = [40, 40, 70, 60];
    const p = placeEdgeLabels([edge('data', [[55, 60], [55, 100]], [55, 50])], ctx([node]));
    const b = knockBox(p.placed[0].x, p.placed[0].y, p.placed[0].kw);
    expect(p.placed[0].mode).toBe('moved');
    expect(inter(b, node)).toBe(0);
  });

  it('tanpa ruang di jalur: garis penunjuk, lalu nomor + catatan; teks tidak pernah hilang', () => {
    // konektor pendek terkurung dua simpul yang rapat
    const nodes: Box[] = [[0, 40, 60, 60], [62, 40, 166, 60]];
    const e = edge('permintaan data mentah dari sensor', [[60, 50], [62, 50]], [61, 49.58]);
    const p = placeEdgeLabels([e], ctx(nodes));
    expect(['leader', 'numbered']).toContain(p.placed[0].mode);
    if (p.placed[0].mode === 'leader') expect(p.placed[0].leader).toHaveLength(4);
    const boxed = placeEdgeLabels([e], ctx(nodes, { W: 62, yMax: 60, obstacles: [[0, 0, 62, 40]] }));
    expect(boxed.placed[0].mode).toBe('numbered');
    expect(boxed.numbered).toEqual([{ number: 1, text: 'permintaan data mentah dari sensor', kind: 'data' }]);
  });

  it('baris catatan dibungkus ke lebar lembar', () => {
    const items = Array.from({ length: 6 }, (_, i) => ({ number: i + 1, text: 'konfirmasi penerimaan paket telemetri', kind: 'data' as const }));
    const r = layoutNotes(items, 128);
    expect(r.rows).toBeGreaterThan(1);
    for (const it of r.items) expect(it.xText).toBeLessThan(128);
  });
});

/** Teks semua <text> (tspan digabung spasi), urut. */
function texts(svg: string): string[] {
  return [...svg.matchAll(/<text\b[^>]*>([\s\S]*?)<\/text>/g)].map((m) => {
    const sp = [...m[1].matchAll(/<tspan\b[^>]*>([\s\S]*?)<\/tspan>/g)].map((x) => x[1]);
    return (sp.length ? sp.join(' ') : m[1]).trim();
  }).sort();
}

describe('aktivasi tata letak otomatis buildDiagramSvg', () => {
  const specs = parityDiagramSpecs().filter(({ file }) => file !== 'dg_layered_good.json');
  const byFile = (f: string) => specs.find((s) => s.file === f)!.spec as unknown as StudioDiagramV1;

  it('render lint-bersih: tanpa report.geometry, report.issues tetap kosong', () => {
    const r = buildDiagramSvg(clone(byFile('dg_sequence.json')), { release: true });
    expect(lintDiagramGeometry(r.svg).score).toBe(0);
    expect(r.report.geometry).toBeUndefined();
    expect(r.report.issues).toEqual([]);
  });

  it('dg_topology (cacat terukur): cacat turun ke 0, label zona di dalam lembar, multiset teks sama, REPORT bersaran', () => {
    const r = buildDiagramSvg(clone(byFile('dg_topology.json')), { release: true });
    const g = lintDiagramGeometry(r.svg);
    expect(g.score).toBe(0);
    expect(g.counts.textOutside).toBe(0);
    expect(r.report.issues).toEqual([]);
    const geo = r.report.geometry ?? [];
    expect(geo[0]).toMatchObject({ checkId: 'AUTO_FIT', status: 'REPORT' });
    expect(geo.every((i) => i.status === 'REPORT' && typeof i.suggest === 'string')).toBe(true);
    expect(geo.map((i) => i.checkId)).toContain('ZONE_LABEL_CLAMP');
    const s = clone(byFile('dg_topology.json'));
    expect(texts(r.svg).filter((t) => !/^\d+$/.test(t))).toEqual(texts(buildDiagramSvg(s, { release: true }).svg));
  });

  it('deterministik: dua build spec bercacat menghasilkan SVG identik byte', () => {
    for (const f of ['dg_flow_wrapped.json', 'dg_rack.json', 'dg_sld_good.json', 'dg_topology.json']) {
      expect(buildDiagramSvg(clone(byFile(f)), { release: true }).svg).toBe(buildDiagramSvg(clone(byFile(f)), { release: true }).svg);
    }
  });

  it('cek kontrak tetap: jumlah data-mark node/link dan checksRun tidak berubah', () => {
    for (const { spec } of specs) {
      const r = buildDiagramSvg(clone(spec) as unknown as StudioDiagramV1, { release: true });
      expect((r.svg.match(/data-mark="node"/g) ?? []).length).toBe((spec.nodes as unknown[]).length);
      expect((r.svg.match(/data-mark="link"/g) ?? []).length).toBe(((spec.edges as unknown[]) ?? []).length);
      expect(r.report.checksRun).toContain('DATUM-33');
    }
  });
});
