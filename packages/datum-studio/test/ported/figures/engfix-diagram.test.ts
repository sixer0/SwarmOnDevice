// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/figures/engfix-diagram.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
// ENG-FIX (D-503 butir 3): render diagram hasil adaptasi kapasitas hanya dipakai bila lint tanpa
// teks bertumpuk dan persilangan + segmen berimpit <= 3; selain itu penolakan lama (kode sama)
// dengan saran aksi konkret. Juga: primitif lint bersama chart/diagram (temuan #5).
import { describe, it, expect } from '../_vitest';
import type { StudioDiagramV1 } from '@/lib/studio/contract';
import { buildDiagramSvg } from '@/lib/studio/engine/diagram/build';
import { CAPACITY_MAX_ROUTE_DEFECTS, capacityAcceptable } from '@/lib/studio/engine/diagram/build/capacity';
import { lintDiagramGeometry, type DiagramGeomLint } from '@/lib/studio/engine/diagram/fit/lint';
import { lintChartGeometry } from '@/lib/studio/engine/chart/core/geometry';
import { unescXml } from '@/lib/studio/engine/chart/core/svgscan';
import { catchErr, checkIdOf, clone } from './_helpers';

const base = (family: string, extra: Record<string, unknown>): StudioDiagramV1 =>
  ({ $schema: 'studio.diagram/v1', family, id: '9.1', title: 'Uji.', classification: 'BIASA', width_mm: 166, apparatus: 'page', labels_verified: true, sources: ['Uji'], ...extra }) as unknown as StudioDiagramV1;
const build = (s: StudioDiagramV1) => buildDiagramSvg(clone(s), { release: true });

const counts = (c: Partial<DiagramGeomLint['counts']>): DiagramGeomLint =>
  ({ widthMm: 0, heightMm: 0, defects: [], score: 0, counts: { textOverlap: 0, textOutside: 0, lineThroughText: 0, textOverNode: 0, textExceedsNode: 0, edgeCross: 0, edgeCollinear: 0, edgeThroughNode: 0, ...c } }) as DiagramGeomLint;

describe('capacityAcceptable (D-503 butir 3)', () => {
  it('ambang: tanpa teks bertumpuk dan persilangan + berimpit <= 3', () => {
    expect(CAPACITY_MAX_ROUTE_DEFECTS).toBe(3);
    expect(capacityAcceptable(counts({}))).toBe(true);
    expect(capacityAcceptable(counts({ edgeCross: 2, edgeCollinear: 1 }))).toBe(true);
    expect(capacityAcceptable(counts({ edgeCross: 3, edgeCollinear: 1 }))).toBe(false);
    expect(capacityAcceptable(counts({ textOverlap: 1 }))).toBe(false);
    // cacat lain tidak menggugurkan (dilaporkan sebagai GEOM_*)
    expect(capacityAcceptable(counts({ lineThroughText: 2, textExceedsNode: 1 }))).toBe(true);
  });

  it('swimlane rantai 15 langkah (adaptasi masih 28 persilangan) -> penolakan DATUM-37 lama + saran aksi', () => {
    const lanes = ['Pemohon', 'Auditor', 'Pengelola fasilitas', 'Pemohon', 'Teknisi', 'Teknisi', 'Pengelola fasilitas', 'Auditor', 'Auditor', 'Teknisi', 'Teknisi', 'Teknisi', 'Auditor', 'Pemohon', 'Pengelola fasilitas'];
    const chain = lanes.slice(1).map((_, i) => ({ from: `n${i}`, to: `n${i + 1}`, kind: i % 3 === 0 ? 'control' : 'data', label: 'data' }));
    const skip = [0, 4, 8].map((i) => ({ from: `n${i}`, to: `n${i + 4}`, kind: 'control', label: 'status' }));
    const s = base('swimlane', {
      legend: ['solid data', 'dashed perintah'],
      nodes: lanes.map((lane, i) => ({ id: `n${i}`, label: `Simpul ${i + 1}`, shape: 'box', class: { lane } })),
      edges: [...chain, ...skip],
    });
    const e = catchErr(() => build(s));
    expect(checkIdOf(e)).toMatch(/^DATUM-37/);
    expect(e.message).toMatch(/saran: kurangi simpul per lajur, bagi lajur, atau pecah menjadi 2 diagram/);
  });

  it('swimlane 6 langkah: adaptasi bersih tetap dirender (CAPACITY_ADAPT)', () => {
    const s = base('swimlane', {
      nodes: [0, 1, 2, 3, 4, 5].map((i) => ({ id: `n${i}`, label: `Langkah ${i + 1}`, class: { lane: i < 5 ? 'Pemohon' : 'Teknisi' } })),
      edges: [0, 1, 2, 3, 4].map((i) => ({ from: `n${i}`, to: `n${i + 1}`, kind: 'data', label: 'lanjut' })),
    });
    const r = build(s);
    expect((r.report.geometry ?? []).map((g) => g.checkId)).toContain('CAPACITY_ADAPT');
    expect(capacityAcceptable(lintDiagramGeometry(r.svg))).toBe(true);
  });
});

describe('primitif lint bersama (temuan #5)', () => {
  it('unescXml: entitas bernama/numerik sekali lintas + spasi seperti peramban', () => {
    expect(unescXml('A &amp;  B')).toBe('A & B');
    expect(unescXml('&amp;lt;')).toBe('&lt;');
    expect(unescXml('&#39;x&apos; &#x41;')).toBe("'x' A");
    expect(unescXml('  a\n\tb  ')).toBe('a b');
  });

  it('chart dan diagram mengukur teks berspasi ganda sama (tanpa drift)', () => {
    const t = (s: string) => `<text x="10" y="10" font-family="IBM Plex Sans Condensed" font-size="2.4" fill="#000000" text-anchor="start">${s}</text>`;
    const svgOf = (s: string) => `<svg viewBox="0 0 30 20">${t(s)}</svg>`;
    // Peramban meringkas spasi: 'SUMBER    data dinas' tampil selebar 'SUMBER data dinas'
    // (19,1 mm dari x=10, muat di 30 mm). Sebelum ENG-FIX lint chart mengukur 4 spasi (20,7 mm)
    // sehingga melaporkan textOutside palsu, sedangkan lint diagram tidak.
    for (const lint of [lintChartGeometry, lintDiagramGeometry]) {
      expect(lint(svgOf('SUMBER data dinas')).counts.textOutside).toBe(0);
      expect(lint(svgOf('SUMBER    data dinas')).counts.textOutside).toBe(0);
    }
  });
});
