// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/figures/fig02b-node-wrap.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
// FIG-02b (P1-10): lebar simpul berbasis label + bungkus teks simpul <tspan>, hanya saat fit.
import { describe, it, expect } from '../_vitest';
import type { DiagramNode, StudioDiagramV1 } from '@/lib/studio/contract';
import { nodeSvg, type SheetNode } from '@/lib/studio/engine/diagram/core';
import { withDiagramFit } from '@/lib/studio/engine/diagram/fit/state';
import { capWidthMm, fitTierWidth, innerWidthMm, NODE_MAX_LINES, planNodeText } from '@/lib/studio/engine/diagram/fit/text';
import { layoutLayered } from '@/lib/studio/engine/diagram/layout-a/layered';
import { layoutFlow } from '@/lib/studio/engine/diagram/layout-a/flow';
import { LATTICE_X, Sheet } from '@/lib/studio/engine/diagram/core';

const LONG = 'Dinas Pekerjaan Umum dan Penataan Ruang Kabupaten Bandung Barat';
const node = (id: string, label: string, extra: Partial<DiagramNode> = {}): DiagramNode => ({ id, label, class: { tier: 0 }, ...extra });
const fit = <T,>(fn: () => T): T => withDiagramFit({ notes: [] }, fn);

function spec(family: StudioDiagramV1['family'], nodes: DiagramNode[], extra: Record<string, unknown> = {}): StudioDiagramV1 {
  return {
    $schema: 'studio.diagram/v1', family, id: '9.9', title: 'Uji.', classification: 'BIASA', width_mm: 166,
    apparatus: 'page', labels_verified: true, sources: ['Uji'], nodes, edges: [], ...extra,
  } as unknown as StudioDiagramV1;
}

/** Teks semua <text> (tspan digabung spasi), urut — pembanding multiset teks. */
function texts(svg: string): string[] {
  return [...svg.matchAll(/<text\b[^>]*>([\s\S]*?)<\/text>/g)].map((m) => {
    const sp = [...m[1].matchAll(/<tspan\b[^>]*>([\s\S]*?)<\/tspan>/g)].map((x) => x[1]);
    return (sp.length ? sp.join(' ') : m[1]).trim();
  }).sort();
}

describe('planNodeText', () => {
  it('label pendek tidak dibungkus (pagar per unsur)', () => {
    const p = planNodeText(node('a', 'Sakelar A'), 32, 14.3);
    expect(p.wrapped).toBe(false);
    expect(p.label).toEqual(['Sakelar A']);
  });

  it('label panjang dibungkus <= 3 baris di lebar dalam, teks utuh', () => {
    const p = planNodeText(node('a', LONG), 53.33, 14.3);
    expect(p.wrapped).toBe(true);
    expect(p.label.length).toBeGreaterThan(1);
    expect(p.label.length).toBeLessThanOrEqual(NODE_MAX_LINES);
    expect(p.overflow).toBe(false);
    for (const l of p.label) expect(capWidthMm(l)).toBeLessThanOrEqual(innerWidthMm(undefined, 53.33, 14.3) + 1e-9);
    expect(p.label.join(' ')).toBe(LONG);
  });

  it('label yang tetap tidak muat 3 baris ditandai overflow (dilaporkan, tidak dipotong)', () => {
    const p = planNodeText(node('a', LONG), 21.33, 14.3);
    expect(p.overflow).toBe(true);
    expect(p.label.join(' ')).toBe(LONG);
  });
});

describe('fitTierWidth', () => {
  it('tingkat berlabel pendek: lebar bawaan dipertahankan', () => {
    expect(fitTierWidth([node('a', 'A'), node('b', 'B')], 32, 74.67, 10.6667, 14.3)).toEqual({ w: 32, changed: false });
  });

  it('label panjang: lebar kelipatan kisi terkecil yang memuat <= 3 baris, tidak melewati wMax', () => {
    const r = fitTierWidth([node('a', LONG), node('b', 'B')], 2 * LATTICE_X, 7 * LATTICE_X, LATTICE_X, 14.3);
    expect(r.changed).toBe(true);
    expect(r.w).toBeLessThanOrEqual(7 * LATTICE_X + 1e-6);
    expect(Math.abs(r.w / LATTICE_X - Math.round(r.w / LATTICE_X))).toBeLessThan(1e-6);
    expect(planNodeText(node('a', LONG), r.w, 14.3).overflow).toBe(false);
  });
});

describe('layout layered/flow saat fit', () => {
  const nodes = [node('a', LONG), node('b', 'Pendek'), node('c', 'Sistem pemantauan suhu ruang server lantai dua gedung utama'), node('d', 'X')];

  it('di luar fit: keluaran tata letak sama persis dengan sebelum FIG-02b (lebar seragam)', () => {
    const a = layoutLayered(spec('layered', nodes), new Sheet(166));
    const b = layoutLayered(spec('layered', nodes), new Sheet(166));
    expect(a).toEqual(b);
    expect(new Set(Object.values(a.nodes).map((n) => n.w)).size).toBe(1);
  });

  it('fit: tinggi simpul tidak pernah turun, lebar tingkat tidak melewati lembar', () => {
    const a = layoutLayered(spec('layered', nodes), new Sheet(166));
    const b = fit(() => layoutLayered(spec('layered', nodes), new Sheet(166)));
    for (const id of Object.keys(a.nodes)) expect(b.nodes[id].h).toBeGreaterThanOrEqual(a.nodes[id].h);
    const xs = Object.values(b.nodes);
    expect(Math.max(...xs.map((n) => n.x + n.w))).toBeLessThanOrEqual(166 + 1e-6);
  });

  it('flow per_row: label > 3 baris menumbuhkan tinggi simpul', () => {
    const many = Array.from({ length: 4 }, (_, i) => node(`n${i}`, `${LONG} ${LONG}`, { class: { row: i } }));
    const a = layoutFlow(spec('flow', many, { per_row: 4 }), new Sheet(166));
    const b = fit(() => layoutFlow(spec('flow', many, { per_row: 4 }), new Sheet(166)));
    expect(b.nodes.n0.h).toBeGreaterThan(a.nodes.n0.h);
    expect(b.nodes.n0.w).toBe(a.nodes.n0.w);
  });
});

describe('nodeSvg: bungkus <tspan> dalam satu <text>', () => {
  const sn = (label: string, w = 32, h = 19.05): SheetNode => ({ id: 'a', spec: node('a', label), x: 10, y: 10, w, h });

  it('label muat: keluaran identik di dalam dan di luar fit', () => {
    expect(fit(() => nodeSvg(sn('Sakelar A')))).toEqual(nodeSvg(sn('Sakelar A')));
  });

  it('label panjang: satu <text> bertspan, multiset teks tetap', () => {
    const plain = nodeSvg(sn(LONG)).join('\n');
    const svg = fit(() => nodeSvg(sn(LONG))).join('\n');
    expect(svg).toMatch(/<tspan x="26" dy="0">/);
    expect((svg.match(/<text\b/g) ?? []).length).toBe((plain.match(/<text\b/g) ?? []).length);
    expect(texts(svg)).toEqual(texts(plain));
  });

  it('rel bus: label dipindah ke atas batang', () => {
    const bus: SheetNode = { id: 'bus', spec: node('bus', 'Rel bus 380 V', { shape: 'bus' }), x: 0, y: 9.52, w: 166, h: 14.29 };
    const y = (s: string) => Number(/<text x="[^"]+" y="([^"]+)"/.exec(s)![1]);
    const before = y(nodeSvg(bus).join(''));
    const after = y(fit(() => nodeSvg(bus)).join(''));
    expect(after).toBeLessThan(9.52 + 14.29 / 2 - 0.6);
    expect(after).toBeLessThan(before);
  });
});
