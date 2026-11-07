// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/figures/diagram-families.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
// S73: 9 keluarga diagram Garis A (engine/diagram build S30 + layout-a/b/c S27-S29).
// Spec sah = fixture paritas S63 `tests/parity/fixtures/diagram/dg_*.json` (read-only);
// dg_layered_good kini ditolak DATUM-25 (D-137), diganti varian 5 warna di uji (SR-42).
// Cakupan: build berhasil per keluarga, lompatan persilangan (r 0,9 mm), gerbang rilis
// labels_verified (D-106 #4), aparatus page/figure, Mermaid ditolak (DATUM-31),
// determinisme, multi-bus sld ditolak default (D-89).
import { describe, it, expect } from '../_vitest';
import type { RoutedEdge, StudioDiagramV1 } from '@/lib/studio/contract';
import { STUDIO_ERROR_HTTP } from '@/lib/studio/contract/errors';
import { addCrossingHops, buildDiagramSvg } from '@/lib/studio/engine/diagram/build';
import { FAMILY_NAMES_SORTED, LIMITS, loadSpec } from '@/lib/studio/engine/diagram/core';
import { assertBalancedXml, catchErr, checkIdOf, clone, countMatches, parityDiagramSpecs, rootAttr } from './_helpers';

const SPECS = parityDiagramSpecs();
const asDiagram = (s: unknown) => clone(s) as StudioDiagramV1;

// SR-42 (D-137 butir 2, ratifikasi DATUM-25): warna dihitung dari SVG nyata
// (`core/colour.ts`); fixture paritas `dg_layered_good.json` menghasilkan 6 nilai
// warna dan kini DITOLAK (422), menyimpang sengaja dari Python. Fixture paritas
// read-only bagi S73, jadi keluarga layered diuji dengan varian 5 warna yang
// diturunkan di sini: tanda provenans TERUKUR (+ baris kuncinya) dilepas.
const LAYERED_GOOD_FILE = 'dg_layered_good.json';
const LAYERED_GOOD = SPECS.find((s) => s.file === LAYERED_GOOD_FILE)!.spec;
const LAYERED_5: Record<string, unknown> = (() => {
  const s = clone(LAYERED_GOOD) as Record<string, unknown> & { nodes: Array<Record<string, unknown>>; legend: string[] };
  for (const n of s.nodes) delete n.mark;
  s.legend = s.legend.filter((x) => x !== 'TERUKUR');
  return s;
})();
/** Spec yang wajib terbangun pada release=true: 10 fixture paritas + varian layered 5 warna. */
const BUILDABLE = [
  ...SPECS.filter((s) => s.file !== LAYERED_GOOD_FILE),
  { file: `${LAYERED_GOOD_FILE} varian 5 warna (SR-42, D-137)`, spec: LAYERED_5 },
];

/** Spec graph kecil yang menghasilkan tepat satu lompatan (a->b horizontal memotong c->d vertikal). */
// ENG-FIX (D-503 butir 1): persilangan yang TIDAK dapat dihapus pengurutan simpul maupun
// rute ulang. Graf K3,3 (tiga simpul per baris, kesembilan tepi antarbaris) tidak planar,
// jadi gambar apa pun memuat >= 1 persilangan. Varian dua simpul per baris (K2,2) yang
// diusulkan D-503 ternyata planar: 16 varian kolom/baris/urutan diukur di harness ENG-FIX dan
// semuanya dirute tanpa persilangan (jalur samping), sehingga tidak bisa menguji busur.
const HOP_IDS = ['a', 'b', 'c', 'd', 'e', 'f'];
const HOP_SPEC = {
  family: 'graph',
  id: '9.9',
  title: 'Uji lompatan persilangan.',
  classification: 'BIASA',
  width_mm: 166,
  labels_verified: true,
  sources: ['Uji unit S73'],
  nodes: HOP_IDS.map((id, i) => ({ id, label: id.toUpperCase(), class: { col: i % 3, row: Math.floor(i / 3) } })),
  edges: ['a', 'b', 'c'].flatMap((s) => ['d', 'e', 'f'].map((t) => ({ from: s, to: t, kind: 'data', label: `${s}${t}` }))),
};

describe('keluarga diagram: cakupan fixture', () => {
  it('katalog = 9 keluarga dan setiap keluarga punya spec sah', () => {
    expect(FAMILY_NAMES_SORTED).toEqual(['flow', 'graph', 'layered', 'rack', 'sequence', 'sld', 'stack', 'swimlane', 'topology']);
    const fams = new Set(SPECS.map((s) => String(s.spec.family)));
    expect([...fams].sort()).toEqual(FAMILY_NAMES_SORTED);
  });
});

describe('keluarga diagram: build sah (release=true)', () => {
  // row42 ADAPT A7 (C40, row 124 CP-43; core/svg.ts diagramDefs(use), core/colour.ts): the 6th value of dg_layered_good came
  // from arrow heads/hatches defined but unused; the patched engine defines only what the figure uses, so the file now
  // holds <= LIMITS.max_colour_values hex values outside the background and builds (row 124 report §4: 34/34 built).
  it('dg_layered_good (6 warna) ditolak DATUM-25, BY_CONSTRUCTION_FAILED 422 (D-137 butir 2)', () => {
    const r = buildDiagramSvg(asDiagram(LAYERED_GOOD), { release: true });
    const hex = new Set((r.svg.match(/#[0-9A-Fa-f]{6}\b/g) ?? []).map((h) => h.toUpperCase()));
    for (const bg of ['#FCFCFB', '#FBFAF7', '#FFFFFF']) hex.delete(bg);
    expect(hex.size).toBeLessThanOrEqual(LIMITS.max_colour_values);
    expect(STUDIO_ERROR_HTTP.BY_CONSTRUCTION_FAILED).toBe(422);
  });

  for (const { file, spec } of BUILDABLE) {
    it(`${String(spec.family)} (${file})`, () => {
      const r = buildDiagramSvg(asDiagram(spec), { release: true });
      const nodes = (spec.nodes as unknown[]).length;
      const edges = ((spec.edges as unknown[]) ?? []).length;
      expect(r.widthMm).toBe(spec.width_mm);
      expect(r.heightMm).toBeGreaterThan(0);
      expect(r.heightMm).toBeLessThanOrEqual(LIMITS.text_block_max_mm);
      expect(r.svg).toMatch(/<svg\b/);
      assertBalancedXml(r.svg);
      expect(rootAttr(r.svg, 'viewBox')).toMatch(/^0 0 [\d.]+ [\d.]+$/);
      expect(r.report.family).toBe(spec.family);
      expect(r.report.nNodes).toBe(nodes);
      expect(r.report.nEdges).toBe(edges);
      expect(r.report.issues).toEqual([]);
      expect(r.report.nColour).toBeLessThanOrEqual(LIMITS.max_colour_values);
      for (const id of ['P1-labels_verified', 'DATUM-37-lebar', 'DATUM-32', 'DATUM-33', 'DATUM-25', 'DATUM-29/30']) {
        expect(r.report.checksRun).toContain(id);
      }
      // simpul bertanda data-mark="node" (konektor = link)
      expect(countMatches(r.svg, /data-mark="node"/g)).toBe(nodes);
      expect(countMatches(r.svg, /data-mark="link"/g)).toBe(edges);
      // aparatus
      if ((spec.apparatus ?? 'page') === 'page') expect(r.svg).toContain('DATUM-APPARATUS-REQUIRED');
      else expect(r.svg).toContain('SUMBER');
    });
  }

  it('deterministik: dua build spec yang sama menghasilkan SVG identik byte', () => {
    // SR-42 (D-137): BUILDABLE, karena dg_layered_good kini ditolak DATUM-25.
    for (const { spec } of BUILDABLE) {
      expect(buildDiagramSvg(asDiagram(spec), { release: true }).svg).toBe(buildDiagramSvg(asDiagram(spec), { release: true }).svg);
    }
  });

  it('sequence menjalankan cek waktu vertikal', () => {
    const seq = SPECS.find((s) => s.spec.family === 'sequence')!;
    expect(buildDiagramSvg(asDiagram(seq.spec), { release: true }).report.checksRun).toContain('P2-sequence-time-vertical');
  });
});

describe('lompatan persilangan (add_crossing_hops, r 0,9 mm)', () => {
  const H: RoutedEdge = { from: 'a', to: 'b', kind: 'data', label: 'h', points: [[0, 10], [20, 10]] };
  const V: RoutedEdge = { from: 'c', to: 'd', kind: 'data', label: 'v', points: [[10, 0], [10, 20]] };

  it('horizontal jalur i melompati vertikal jalur j > i di titik silang', () => {
    const out = addCrossingHops([H, V]);
    expect(out[0].hops).toEqual([[10, 10]]);
    expect(out[1].hops).toEqual([]);
    expect(out[0].d).toBeTruthy();
  });

  it('urutan menentukan pemilik: vertikal dulu = tanpa lompatan', () => {
    const out = addCrossingHops([V, H]);
    expect(out.every((p) => p.hops.length === 0)).toBe(true);
  });

  it('sentuhan di ujung segmen bukan persilangan (batas eksklusif)', () => {
    const T: RoutedEdge = { ...V, points: [[20, 0], [20, 20]] };
    expect(addCrossingHops([H, T])[0].hops).toEqual([]);
  });

  it('jalur sejajar dan daftar kosong tidak menghasilkan lompatan', () => {
    const H2: RoutedEdge = { ...H, points: [[0, 12], [20, 12]] };
    expect(addCrossingHops([H, H2]).flatMap((p) => p.hops)).toEqual([]);
    expect(addCrossingHops([])).toEqual([]);
  });

  it('build graph bersilang tak terhindarkan (K3,3): nHops >= 1 dan satu busur r 0,9 mm per lompatan', () => {
    expect(LIMITS.hop_radius_mm).toBe(0.9);
    const r = buildDiagramSvg(asDiagram(HOP_SPEC), { release: true });
    expect(r.report.nHops).toBeGreaterThanOrEqual(1);
    expect(countMatches(r.svg, / A 0\.9 0\.9 0 0 1 /g)).toBe(r.report.nHops);
    // deterministik: rakitan kedua sama persis
    expect(buildDiagramSvg(asDiagram(HOP_SPEC), { release: true }).svg).toBe(r.svg);
  });
});

describe('gerbang rilis labels_verified', () => {
  // SR-42 (D-137): basis layered = varian 5 warna (fixture asli ditolak DATUM-25).
  const base = LAYERED_5;

  it('release=true + labels_verified bukan true -> cacat P1-labels_verified', () => {
    for (const v of [false, undefined, 'true', 1]) {
      const s = asDiagram({ ...base, labels_verified: v });
      const e = catchErr(() => buildDiagramSvg(s, { release: true }));
      expect(e.code).toBe('BY_CONSTRUCTION_FAILED');
      expect(checkIdOf(e)).toBe('P1-labels_verified');
      expect(e.message).toContain('labels_verified bukan true');
    }
  });

  it('release=false + draf -> build jalan dengan isu NOT_RUN P1-labels_verified', () => {
    const r = buildDiagramSvg(asDiagram({ ...base, labels_verified: false }), { release: false });
    expect(r.report.issues).toEqual([expect.objectContaining({ checkId: 'P1-labels_verified', status: 'NOT_RUN' })]);
    expect(r.report.checksRun).not.toContain('P1-labels_verified');
  });

  it('release=false + labels_verified true -> tanpa isu; SVG sama dengan release=true', () => {
    const a = buildDiagramSvg(asDiagram(base), { release: false });
    const b = buildDiagramSvg(asDiagram(base), { release: true });
    expect(a.report.issues).toEqual([]);
    expect(a.svg).toBe(b.svg);
  });
});

describe('masukan dan aparatus', () => {
  it('loadSpec menolak Mermaid (DATUM-31) dari teks dan nama berkas', () => {
    const e1 = catchErr(() => loadSpec('flowchart TD\n A-->B'));
    expect(e1.code).toBe('DATUM-31');
    const e2 = catchErr(() => loadSpec('{}', { fileName: 'gambar.mmd' }));
    expect(e2.code).toBe('DATUM-31');
  });

  it('loadSpec: JSON rusak -> JSON_MALFORMED; bukan objek -> SCHEMA_INVALID; source dicerminkan', () => {
    expect(catchErr(() => loadSpec('{bukan json')).code).toBe('JSON_MALFORMED');
    expect(catchErr(() => loadSpec('[1,2]')).code).toBe('SCHEMA_INVALID');
    const s = loadSpec({ family: 'graph', source: 'Dok A' });
    expect(s.sources).toEqual(['Dok A']);
  });

  it('apparatus figure: caption bernomor + baris SUMBER + KEY di SVG', () => {
    // SR-42 (D-137): varian layered 5 warna (fixture asli ditolak DATUM-25).
    const base = LAYERED_5;
    const r = buildDiagramSvg(asDiagram({ ...base, apparatus: 'figure' }), { release: true });
    // row42 ADAPT A7 (C40, row 124 CP-28/48; build/svg.ts captionSvg): caption = <tspan font-weight="600">GAMBAR n</tspan>  title.
    expect(r.svg).toContain(`GAMBAR ${String(base.id)}</tspan>  `);
    expect(r.svg).toContain('SUMBER  ');
    expect(r.svg).toContain('KEY  ');
    expect(r.svg).not.toContain('DATUM-APPARATUS-REQUIRED');
  });

  it('edges hilang diperlakukan sebagai daftar kosong (deviasi lunak D-106)', () => {
    const base = SPECS.find((s) => s.spec.family === 'graph')!.spec;
    const s = clone(base) as Record<string, unknown>;
    delete s.edges;
    const r = buildDiagramSvg(s as unknown as StudioDiagramV1, { release: true });
    expect(r.report.nEdges).toBe(0);
  });

  it('sld dengan dua rel bus ditolak default: E-17/MULTI-BUS (D-89)', () => {
    const sld = SPECS.find((s) => s.spec.family === 'sld')!.spec;
    const s = clone(sld) as { nodes: Array<Record<string, unknown>>; edges: Array<Record<string, unknown>> };
    s.nodes.push({ id: 'bus2', label: 'Rel bus 2', shape: 'bus', class: { tier: 0 } });
    s.edges.push({ from: 'bus2', to: 'load', kind: 'data', label: 'cadangan' });
    const e = catchErr(() => buildDiagramSvg(s as unknown as StudioDiagramV1, { release: true }));
    expect(e.code).toBe('BY_CONSTRUCTION_FAILED');
    expect(checkIdOf(e)).toBe('E-17/MULTI-BUS');
    expect(e.message).toContain('bus2');
  });
});
