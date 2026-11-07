// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/figures/fig02b2-layout.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
// FIG-02b2 (P1-11, P1-12, P1-14, P2-15): persilangan, pemisahan jalur, kapasitas yang membantu,
// caption berbungkus. Render ulang hanya bila lint geometri mengukur cacat (atau render pertama
// ditolak kapasitas); hasil kedua dipakai hanya bila lebih baik.
import { describe, it, expect } from '../_vitest';
import type { StudioDiagramV1 } from '@/lib/studio/contract';
import { buildDiagramSvg } from '@/lib/studio/engine/diagram/build';
import { lintDiagramGeometry } from '@/lib/studio/engine/diagram/fit/lint';
import { catchErr, checkIdOf, clone, parityDiagramSpecs } from './_helpers';

const base = (family: string, extra: Record<string, unknown>): StudioDiagramV1 =>
  ({ $schema: 'studio.diagram/v1', family, id: '9.1', title: 'Uji.', classification: 'BIASA', width_mm: 166, apparatus: 'page', labels_verified: true, sources: ['Uji'], ...extra }) as unknown as StudioDiagramV1;
const build = (s: StudioDiagramV1) => buildDiagramSvg(clone(s), { release: true });
const ids = (r: ReturnType<typeof build>) => (r.report.geometry ?? []).map((g) => g.checkId);
const textOf = (svg: string) =>
  [...svg.matchAll(/<text\b[^>]*>([\s\S]*?)<\/text>/g)]
    .map((m) => m[1].replace(/<title>[\s\S]*?<\/title>/g, '').replace(/<[^>]+>/g, ' '))
    .join(' ')
    .replace(/\s+/g, ' ');

const CROSS = base('layered', {
  nodes: [['a', 0], ['b', 0], ['c', 0], ['x', 1], ['y', 1], ['z', 1]].map(([id, t]) => ({ id, label: `Simpul ${id}`, class: { tier: t } })),
  edges: [['a', 'z'], ['b', 'y'], ['c', 'x']].map(([f, t]) => ({ from: f, to: t, kind: 'data', label: 'data' })),
});
const FAN = base('graph', {
  nodes: [{ id: 's', label: 'Sumber', class: { col: 0, row: 0 } }, ...[0, 1, 2, 3].map((i) => ({ id: `t${i}`, label: `Tujuan ${i}`, class: { col: i, row: 1 } }))],
  edges: [0, 1, 2, 3].map((i) => ({ from: 's', to: `t${i}`, kind: 'data', label: `d${i}` })),
});

describe('P1-11 persilangan', () => {
  it('graf layered dikenal: persilangan turun ke 0, urutan baru dilaporkan', () => {
    const r = build(CROSS);
    const g = lintDiagramGeometry(r.svg);
    expect(g.counts.edgeCross).toBe(0);
    expect(ids(r)).toContain('AUTO_FIT');
    const ord = (r.report.geometry ?? []).find((x) => x.checkId === 'NODE_ORDER');
    expect(ord?.status).toBe('REPORT');
    expect(ord?.suggest).toMatch(/urutan/);
  });

  it('deterministik: dua rakitan memberi SVG identik', () => {
    expect(build(CROSS).svg).toBe(build(CROSS).svg);
    expect(build(FAN).svg).toBe(build(FAN).svg);
  });
});

describe('P1-12 pemisahan jalur', () => {
  it('kipas keluar graph: tanpa segmen berimpit, persilangan tidak bertambah', () => {
    const r = build(FAN);
    const g = lintDiagramGeometry(r.svg);
    expect(g.counts.edgeCollinear).toBe(0);
    expect(g.counts.edgeCross).toBeLessThanOrEqual(2);
  });

  it('fixture sld: rute "ke beban" tidak lagi menembus baris SUMBER', () => {
    const sld = parityDiagramSpecs().find((x) => x.file === 'dg_sld_good.json')!.spec as unknown as StudioDiagramV1;
    const g = lintDiagramGeometry(build(sld).svg);
    expect(g.counts.lineThroughText).toBe(0);
  });

  it('rak: konektor antarperangkat dirute di samping badan rak, tidak menembus label perangkat', () => {
    const rack = base('rack', {
      nodes: Array.from({ length: 8 }, (_, i) => ({ id: `n${i}`, label: `Perangkat ${i + 1}`, u: 1 + (i % 2), class: { row: i } })),
      edges: [{ from: 'n1', to: 'n2', kind: 'data', label: 'data' }, { from: 'n0', to: 'n5', kind: 'data', label: 'perintah' }],
    });
    const g = lintDiagramGeometry(build(rack).svg);
    expect(g.counts.lineThroughText).toBe(0);
    expect(g.counts.textOverlap).toBe(0);
  });
});

describe('P1-14 kapasitas yang membantu', () => {
  const SWIM = base('swimlane', {
    nodes: [0, 1, 2, 3, 4, 5].map((i) => ({ id: `n${i}`, label: `Langkah ${i + 1}`, class: { lane: i < 5 ? 'Pemohon' : 'Teknisi' } })),
    edges: [0, 1, 2, 3, 4].map((i) => ({ from: `n${i}`, to: `n${i + 1}`, kind: 'data', label: 'lanjut' })),
  });

  it('swimlane 5 simpul selajur: dibungkus ke baris kedua, bukan DATUM-37', () => {
    const r = build(SWIM);
    expect(ids(r)).toContain('CAPACITY_ADAPT');
    const t = textOf(r.svg);
    for (let i = 1; i <= 6; i++) expect(t).toContain(`Langkah ${i}`);
    const g = lintDiagramGeometry(r.svg);
    expect(g.counts.textOverlap + g.counts.textOutside + g.counts.edgeThroughNode).toBe(0);
  });

  it('graph 5 kolom: pitch dipadatkan, bukan ditolak', () => {
    const g5 = base('graph', {
      nodes: [0, 1, 2, 3, 4].map((i) => ({ id: `g${i}`, label: `Simpul ${i}`, class: { col: i, row: 0 } })),
      edges: [0, 1, 2, 3].map((i) => ({ from: `g${i}`, to: `g${i + 1}`, kind: 'data', label: 'data' })),
    });
    const r = build(g5);
    expect(ids(r)).toContain('CAPACITY_ADAPT');
    expect(r.widthMm).toBe(166);
  });

  it('graph 7 kolom tetap ditolak dengan aksi konkret', () => {
    const g7 = base('graph', {
      nodes: [0, 1, 2, 3, 4, 5, 6].map((i) => ({ id: `g${i}`, label: `Simpul ${i}`, class: { col: i, row: 0 } })),
      edges: [0, 1, 2, 3, 4, 5].map((i) => ({ from: `g${i}`, to: `g${i + 1}`, kind: 'data', label: 'data' })),
    });
    const e = catchErr(() => build(g7));
    expect(checkIdOf(e)).toMatch(/^DATUM-37/);
    expect(e.message).toMatch(/maks \d+ kolom pada 166 mm/);
    expect(e.message).toMatch(/bagi menjadi dua gambar/);
  });
});

describe('P2-15 caption/SUMBER berbungkus', () => {
  it('caption diagram panjang dibungkus di dalam lembar; teks utuh', () => {
    const title = 'Arsitektur integrasi sistem pemantauan lingkungan ruang server menghubungkan sensor lapangan, gerbang data, dan dasbor pemerintah daerah melalui jaringan cadangan.';
    const r = build({ ...CROSS, apparatus: 'figure', title } as StudioDiagramV1);
    const g = lintDiagramGeometry(r.svg);
    expect(g.counts.textOutside).toBe(0);
    const t = textOf(r.svg);
    for (const w of title.split(' ')) expect(t).toContain(w);
    expect(t).toContain('SUMBER');
  });

  it('render lint-bersih tidak membawa medan geometry (jalur lama utuh)', () => {
    const fx = parityDiagramSpecs().find((x) => x.file === 'dg_swimlane.json')!.spec as unknown as StudioDiagramV1;
    expect(build(fx).report.geometry).toBeUndefined();
  });
});
