// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/figures/diagram-bad-cases.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
// S73: 17 bad_cases Garis A (HS fixtures_diagram/bad_cases.json, battery mutasi DHS-RB-04)
// sebagai fixture negatif untuk engine/diagram (validateSpec S26 + build S30 + layout S27-S29).
// Kontrak HS selftest: setiap kasus DITOLAK dengan cacat yang memuat `expect`.
// Selisih yang diketahui (D-106): kasus E-17 dilempar layout-c (S29) dengan prefiks
// "DIAGRAM DEFECT: " dan kelas StudioEngineError (bukan DiagramDefect); dipatok di sini
// agar perubahan prefiks terdeteksi, bukan disembunyikan.
import { describe, it, expect } from '../_vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { StudioDiagramV1 } from '@/lib/studio/contract';
import { buildDiagramSvg } from '@/lib/studio/engine/diagram/build';
import { DiagramDefect, assertValidSpec, validateSpec } from '@/lib/studio/engine/diagram/core';
import { HS_BAD_CASES, OWN_FIXTURES, badCases, catchErr, checkIdOf, clone, hsBadCasesAvailable } from './_helpers';

type BadCase = ReturnType<typeof badCases>[number];

const DATUM33_CASE = 'DATUM-33 gambar lebih tinggi dari blok teks 247 mm';
/** Tingkat kasus DATUM-33 setelah D-242 (8 tingkat = 238,1 mm masih muat; 10 = 295,3 mm). */
const DATUM33_TIERS = 10;

/**
 * SR-42 (D-242, K-1 user): tinggi simpul dan jarak tingkat Garis A dikoreksi ke ukuran BM,
 * paritas byte Python diputus sengaja. Kasus HS DATUM-33 (5 tingkat) kini 152,4 mm < 247 mm
 * sehingga tidak lagi buruk. Salinan lokal `bad_cases.json` tetap identik byte dengan HS
 * (penjaga drift), jadi kasus itu diperpanjang di sini menjadi 10 tingkat berantai.
 */
function withD242(c: BadCase): BadCase {
  if (c.name !== DATUM33_CASE) return c;
  const spec = clone(c.spec) as Record<string, unknown> & { nodes: Array<Record<string, unknown>>; edges: Array<Record<string, unknown>> };
  const proto = spec.nodes[0];
  spec.nodes = Array.from({ length: DATUM33_TIERS }, (_, i) => ({ ...clone(proto), id: `t${i}`, label: `T${i}`, class: { tier: i } }));
  spec.edges = Array.from({ length: DATUM33_TIERS - 1 }, (_, i) => ({ from: `t${i}`, to: `t${i + 1}`, kind: 'data', label: String.fromCharCode(97 + i) }));
  return { ...c, spec };
}

const CASES = badCases().map(withD242);

/** checkId yang diharapkan per kasus (urutan fixture); tahap = spek (validateSpec) atau build. */
const EXPECTED: Record<string, { checkId: string; stage: 'spec' | 'build' }> = {
  'width_mm di antara 128 dan 166': { checkId: 'P1-width_mm', stage: 'spec' },
  'title tanpa titik akhir': { checkId: 'P1-title', stage: 'spec' },
  'DATUM-24 konektor tanpa label': { checkId: 'DATUM-24', stage: 'spec' },
  'DATUM-26 dua subjek beraksen': { checkId: 'DATUM-26', stage: 'spec' },
  'DATUM-34 glif rumah tanpa baris kunci': { checkId: 'DATUM-34', stage: 'spec' },
  'DATUM-35 dua dialek simbol dalam satu gambar': { checkId: 'DATUM-35', stage: 'spec' },
  'E-17 keluarga sld tanpa rel bus': { checkId: 'E-17', stage: 'build' },
  'keluarga tidak dikenal': { checkId: 'P1-family', stage: 'spec' },
  'sumber kosong': { checkId: 'P1-sources', stage: 'spec' },
  'konektor ke simpul tak dikenal': { checkId: 'DATUM-24', stage: 'spec' },
  'P3 keputusan tanpa keluaran berlabel': { checkId: 'P3-diamond-exits', stage: 'spec' },
  'DATUM-25 enam nilai warna dalam satu gambar': { checkId: 'DATUM-25', stage: 'build' },
  'DATUM-33 gambar lebih tinggi dari blok teks 247 mm': { checkId: 'DATUM-33', stage: 'build' },
  'DATUM-37 simpul keluar lebar lembar': { checkId: 'DATUM-37-lebar', stage: 'build' },
  'DATUM-32 konektor menembus kotak tak terkait dan detur gagal': { checkId: 'DATUM-32', stage: 'build' },
  'bentuk simpul di luar katalog P3': { checkId: 'P1-nodes+P3-shapes', stage: 'spec' },
  'jenis konektor di luar katalog P4': { checkId: 'DATUM-24', stage: 'spec' },
};

const KNOWN_PREFIX_CASE = 'E-17 keluarga sld tanpa rel bus';

describe('bad_cases Garis A: fixture', () => {
  it('memuat tepat 17 kasus dengan nama unik dan peta checkId lengkap', () => {
    expect(CASES).toHaveLength(17);
    expect(new Set(CASES.map((c) => c.name)).size).toBe(17);
    expect(Object.keys(EXPECTED).sort()).toEqual(CASES.map((c) => c.name).sort());
  });

  it.skipIf(!hsBadCasesAvailable())('salinan lokal identik byte dengan acuan HS (penjaga drift)', () => {
    const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');
    expect(sha(path.join(OWN_FIXTURES, 'bad_cases.json'))).toBe(sha(HS_BAD_CASES));
  });
});

describe('bad_cases Garis A: koreksi tinggi D-242', () => {
  it('kasus HS DATUM-33 asli (5 tingkat) kini muat (< 247 mm); varian 10 tingkat > 247 mm ditolak', () => {
    const original = badCases().find((c) => c.name === DATUM33_CASE)!;
    const r = buildDiagramSvg(clone(original.spec) as unknown as StudioDiagramV1, { release: true });
    expect(r.heightMm).toBeLessThan(247);
    const e = catchErr(() => buildDiagramSvg(clone(withD242(original).spec) as unknown as StudioDiagramV1, { release: true }));
    expect(checkIdOf(e)).toBe('DATUM-33');
    expect(e.message).toMatch(/melewati blok teks 247/);
  });
});

// row42 ADAPT A7 (C40, row 124 CP-43): the "six colour values" case builds with 5 hex values outside the background on the
// patched engine (its 6th value was an unused arrow-head def; Rev A Table 9.4: at most five). It is checked separately
// below and left out of the "every case is refused" loops.
const R124_ACCEPTED = 'DATUM-25 enam nilai warna dalam satu gambar';
const REFUSED = CASES.filter((c) => c.name !== R124_ACCEPTED);

describe('bad_cases Garis A: buildDiagramSvg(release=true) menolak setiap kasus', () => {
  it('row42 A7: kasus DATUM-25 kini terbangun dengan <= 5 nilai hex di luar latar (Rev A Tabel 9.4)', () => {
    const c = CASES.find((x) => x.name === R124_ACCEPTED)!;
    const r = buildDiagramSvg(clone(c.spec) as unknown as StudioDiagramV1, { release: true });
    const hex = new Set((r.svg.match(/#[0-9A-Fa-f]{6}\b/g) ?? []).map((h) => h.toUpperCase()));
    for (const bg of ['#FCFCFB', '#FBFAF7', '#FFFFFF']) hex.delete(bg);
    expect(hex.size).toBeLessThanOrEqual(5);
  });
  for (const c of REFUSED) {
    it(`${c.name} -> memuat "${c.expect}"`, () => {
      const e = catchErr(() => buildDiagramSvg(clone(c.spec) as unknown as StudioDiagramV1, { release: true }));
      // row42 ADAPT A11 (U24 B, row 158): the two capacity cases (DATUM-33 height, DATUM-37 width) are
      // refused FIGURE_OVER_CAPACITY (still DiagramDefect, same checkId and message text); others unchanged.
      expect(e.code).toBe(/^DATUM-3[37]/.test(EXPECTED[c.name].checkId) ? 'FIGURE_OVER_CAPACITY' : 'BY_CONSTRUCTION_FAILED');
      expect(e.message).toContain(c.expect);
      expect(checkIdOf(e)).toBe(EXPECTED[c.name].checkId);
    });
  }

  it('selisih prefiks layout-c yang diketahui: hanya E-17 berprefiks "DIAGRAM DEFECT: " (D-106)', () => {
    const prefixed: string[] = [];
    for (const c of REFUSED) {
      const e = catchErr(() => buildDiagramSvg(clone(c.spec) as unknown as StudioDiagramV1, { release: true }));
      if (e.message.startsWith('DIAGRAM DEFECT: ')) prefixed.push(c.name);
      // 16 kasus lain = pesan Python persis (DiagramDefect, tanpa prefiks)
      if (c.name !== KNOWN_PREFIX_CASE) expect(e).toBeInstanceOf(DiagramDefect);
    }
    expect(prefixed).toEqual([KNOWN_PREFIX_CASE]);
  });

  it('build tidak memutasi spec masukan', () => {
    for (const c of REFUSED) {
      const spec = clone(c.spec);
      const before = JSON.stringify(spec);
      catchErr(() => buildDiagramSvg(spec as unknown as StudioDiagramV1, { release: true }));
      expect(JSON.stringify(spec)).toBe(before);
    }
  });

  it('pesan cacat deterministik (dua kali build = pesan sama)', () => {
    for (const c of REFUSED) {
      const a = catchErr(() => buildDiagramSvg(clone(c.spec) as unknown as StudioDiagramV1, { release: true }));
      const b = catchErr(() => buildDiagramSvg(clone(c.spec) as unknown as StudioDiagramV1, { release: true }));
      expect(a.message).toBe(b.message);
    }
  });
});

describe('bad_cases Garis A: tahap validasi spek (validateSpec / assertValidSpec)', () => {
  const specCases = CASES.filter((c) => EXPECTED[c.name].stage === 'spec');
  const buildCases = CASES.filter((c) => EXPECTED[c.name].stage === 'build');

  it('12 kasus tahap spek, 5 kasus tahap build', () => {
    expect(specCases).toHaveLength(12);
    expect(buildCases).toHaveLength(5);
  });

  for (const c of specCases) {
    it(`validateSpec: FAIL pertama ${EXPECTED[c.name].checkId} memuat "${c.expect}" (${c.name})`, () => {
      const issues = validateSpec(clone(c.spec) as unknown as StudioDiagramV1, { release: true });
      const first = issues.find((i) => i.status === 'FAIL');
      expect(first?.checkId).toBe(EXPECTED[c.name].checkId);
      expect(first?.detail).toContain(c.expect);
      expect(typeof first?.pointer).toBe('string');
      const e = catchErr(() => assertValidSpec(clone(c.spec) as unknown as StudioDiagramV1, { release: true }));
      expect(e).toBeInstanceOf(DiagramDefect);
      expect(e.message).toBe(first?.detail);
    });
  }

  for (const c of buildCases) {
    it(`validateSpec lolos penuh, cacat baru muncul saat build (${c.name})`, () => {
      const issues = validateSpec(clone(c.spec) as unknown as StudioDiagramV1, { release: true });
      expect(issues.filter((i) => i.status === 'FAIL')).toEqual([]);
      // 13 cek spek + gerbang rilis
      expect(assertValidSpec(clone(c.spec) as unknown as StudioDiagramV1, { release: true })).toHaveLength(14);
    });
  }
});
