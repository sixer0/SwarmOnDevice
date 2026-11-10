// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/engine-core/lint-structure-language.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
// S71: uji unit engine/lint/structure (I36; S46) dan engine/lint/language
// (I37; S47). Struktur: penegakan per tier, turunan dihitung ulang (D03),
// override profil. Bahasa: butir yang tidak diimplementasi dilaporkan NOT_RUN
// jujur dengan notRunReason (KT-13), tidak pernah PASS palsu.
import { describe, it, expect, beforeAll } from '../_vitest';
import type { ResolvedTemplate, StudioTier } from '@/lib/studio/contract';
import { LINT_REGISTRY, isLintImplemented } from '@/lib/studio/registry/lint';
import { ENFORCEMENT_CHECK_ID, STRUCTURE_LINT_DEFS, lintStructure, lintStructureWith, structureCoverageGaps } from '@/lib/studio/engine/lint/structure';
import { LANGUAGE_LINT_DEFS, lintLanguage } from '@/lib/studio/engine/lint/language';
import { canonicalTemplate, makeDoc, snapshotOf, statuses, withParams } from './fixtures';

let KAN: ResolvedTemplate;
beforeAll(() => {
  KAN = canonicalTemplate();
});

const REGISTER = {
  'nilai basis': { v: 1250000, dec: 0 as const, unit: 'Rp', mark: 'TERUKUR' as const, src: 'RAB' },
  'nilai skenario': { v: 1000000, dec: 0 as const, unit: 'Rp', mark: 'ASUMSI' as const, src: '' },
  'selisih skenario': { v: 250000, dec: 0 as const, unit: 'Rp', mark: 'DITURUNKAN' as const, src: '' },
};

function derivation(expr: string) {
  return {
    type: 'derivation',
    title: { text: 'Selisih skenario' },
    lines: [
      { label: { text: 'nilai basis' }, value: { registerKey: 'nilai basis' } },
      { label: { text: 'nilai skenario' }, value: { registerKey: 'nilai skenario' } },
    ],
    result: { label: { text: 'selisih' }, expr, registerKey: 'selisih skenario' },
    closing: { text: 'Bila harga satuan naik, selisih menyempit dan skenario ditinjau ulang.' },
  };
}

describe('lintStructure: cakupan dan tier', () => {
  // SR-42 (D-178): SR-18 menambah 3 cek bermodul structure (LD-01..LD-03), 45 -> 48.
  it('semua entri registri bermodul structure terimplementasi (48, D-178)', () => {
    expect(structureCoverageGaps()).toEqual([]);
    expect(STRUCTURE_LINT_DEFS).toHaveLength(48);
  });

  it('hanya cek yang berlaku untuk tier yang dijalankan: NOTA hanya 4 cek struktur v2, D01-D03/D07 hanya SERAH', () => {
    const run = (tier: StudioTier) => lintStructure(snapshotOf(makeDoc({ tier })), KAN, tier).filter((i) => i.checkId !== 'STRUCT-XREF');
    // SR-42 (D-178/D-180): LD-01..LD-04 bertier "semua" (slot wajib kosong tidak
    // pernah rilis-PASS, termasuk NOTA); dokumen uji berisi -> keempatnya PASS.
    const nota = run('NOTA');
    expect(nota.map((i) => i.checkId).sort()).toEqual(['CONTENT_CHAPTER_GAP', 'INLINE_FORMAT_STRIPPED', 'SCHEMA_V1_ADAPTED', 'SLOT_CONTENT_MISSING']);
    expect(nota.every((i) => i.status === 'PASS')).toBe(true);
    const terbit = new Set(run('TERBIT').map((i) => i.checkId));
    const serah = new Set(run('SERAH').map((i) => i.checkId));
    for (const id of ['D01', 'D02', 'D03', 'D07']) {
      expect(terbit.has(id), `TERBIT ${id}`).toBe(false);
      expect(serah.has(id), `SERAH ${id}`).toBe(true);
    }
    for (const d of STRUCTURE_LINT_DEFS.filter((x) => x.tiers.includes('TERBIT'))) expect(terbit.has(d.id), d.id).toBe(true);
  });

  it('tidak melempar pada snapshot minim; setiap cek berlaku menghasilkan >= 1 butir beralasan', () => {
    const out = lintStructure(snapshotOf(makeDoc({ tier: 'SERAH' })), KAN, 'SERAH');
    for (const i of out.filter((x) => x.status === 'NOT_RUN')) expect((i.detail ?? '').length, i.checkId).toBeGreaterThan(0);
  });
});

describe('D03: turunan dihitung ulang terhadap register (SERAH)', () => {
  const run = (expr: string) =>
    lintStructureWith(snapshotOf(makeDoc({ tier: 'SERAH', register: REGISTER, blocks: [derivation(expr)] })), KAN, 'SERAH', { only: ['D03', 'D04'] });

  it('aritmetika cocok -> PASS', () => {
    const out = run('nilai_basis - nilai_skenario');
    expect(statuses(out, 'D03')).toEqual(['PASS']);
    expect(statuses(out, 'D04')).toEqual(['PASS']);
  });

  it('aritmetika tidak cocok -> FAIL dengan pointer /result', () => {
    const out = run('nilai_basis - nilai_skenario + 7');
    expect(statuses(out, 'D03')).toEqual(['FAIL']);
    expect(out.find((i) => i.checkId === 'D03')?.pointer).toMatch(/\/result$/);
  });

  it('ekspresi jahat -> FAIL beralasan (BindDefect), bukan crash atau eksekusi', () => {
    const out = run('require("fs").rmSync("/")');
    expect(statuses(out, 'D03')).toEqual(['FAIL']);
    expect(out.find((i) => i.checkId === 'D03')?.detail).toMatch(/tidak terdaftar|tidak diizinkan/);
  });
});

describe('penegakan struktur per profil templat', () => {
  it('override profil "report" mengubah FAIL -> REPORT, "off" -> satu NOT_RUN; override rusak -> STRUCT-ENFORCEMENT', () => {
    const snap = snapshotOf(makeDoc({ tier: 'SERAH', register: REGISTER, blocks: [derivation('nilai_basis')] }));
    const base = lintStructureWith(snap, KAN, 'SERAH', { only: ['D03'] });
    expect(statuses(base, 'D03')).toEqual(['FAIL']);
    const rep = lintStructureWith(snap, withParams(KAN, { 'lint.enforcementOverride': { D03: 'report' } }), 'SERAH', { only: ['D03'] });
    expect(statuses(rep, 'D03')).toEqual(['REPORT']);
    const off = lintStructureWith(snap, withParams(KAN, { 'lint.enforcementOverride': { D03: 'off', 'XX-1': 'off' } }), 'SERAH', { only: ['D03'] });
    expect(statuses(off, 'D03')).toEqual(['NOT_RUN']);
    expect(statuses(off, ENFORCEMENT_CHECK_ID)).toEqual(['REPORT']);
  });

  it('dokumen tidak dapat menurunkan FAIL struktur menjadi REPORT/off (hanya block -> release)', () => {
    const snap = snapshotOf(
      makeDoc({ tier: 'SERAH', register: REGISTER, blocks: [derivation('nilai_basis')], x: { lintEnforcement: { D03: 'off' } } }),
    );
    const out = lintStructureWith(snap, KAN, 'SERAH', { only: ['D03'] });
    expect(statuses(out, 'D03')).toEqual(['FAIL']);
    expect(out.find((i) => i.checkId === ENFORCEMENT_CHECK_ID)?.pointer).toBe('/x/lintEnforcement');
  });
});

describe('lintLanguage: NOT_RUN jujur (KT-13)', () => {
  const snapWith = (text: string, language: 'ID' | 'EN' = 'ID') => snapshotOf(makeDoc({ language, blocks: [{ type: 'paragraph', text }] }));

  it('18 butir (19 sebelum C-27 dihapus, 1.2.5); 10 tanpa implementasi -> NOT_RUN dengan notRunReason registri persis, tidak pernah PASS', () => {
    expect(LANGUAGE_LINT_DEFS).toHaveLength(18);
    const out = lintLanguage(snapWith('Kalimat netral pertama. Kalimat netral kedua.'), KAN.params);
    const unimpl = LANGUAGE_LINT_DEFS.filter((d) => !isLintImplemented(d));
    expect(unimpl).toHaveLength(10);
    for (const d of unimpl) {
      expect(out.filter((i) => i.checkId === d.id), d.id).toEqual([{ checkId: d.id, status: 'NOT_RUN', detail: d.notRunReason }]);
      expect((d.notRunReason ?? '').trim().length, d.id).toBeGreaterThan(0);
    }
  });

  it('notRunReason menyebut alat induk yang tidak tersedia (lint_mutu.py / scan_ai_footprint.py)', () => {
    const reasons = LANGUAGE_LINT_DEFS.filter((d) => !isLintImplemented(d)).map((d) => d.notRunReason ?? '');
    expect(reasons.every((r) => /lint_mutu|scan_ai_footprint|alat|tidak tersedia/i.test(r))).toBe(true);
  });

  it('setiap butir registri bahasa menghasilkan minimal satu isu', () => {
    const out = lintLanguage(snapWith('Teks.'), KAN.params);
    for (const d of LANGUAGE_LINT_DEFS) expect(out.some((i) => i.checkId === d.id), d.id).toBe(true);
  });

  it('parameter ambang tidak sah -> NOT_RUN menyebut kunci, bukan PASS palsu', () => {
    const out = lintLanguage(snapWith('Satu kalimat, dua koma, tiga koma, empat koma, lima.'), {
      ...KAN.params,
      'threshold.chainedSentencesPercent.max': 'dua puluh',
    });
    expect(statuses(out, 'C-26b')).toEqual(['NOT_RUN']);
    expect(out.find((i) => i.checkId === 'C-26b')?.detail).toContain('threshold.chainedSentencesPercent.max');
  });

  it('C-34: "kamu" dalam narasi -> FAIL; C-SG-L2-09: paragraf > 150 kata -> FAIL', () => {
    expect(statuses(lintLanguage(snapWith('Kamu wajib membaca bagian ini sebelum memasang panel.'), KAN.params), 'C-34')).toEqual(['FAIL']);
    const long = Array.from({ length: 160 }, (_, i) => `kata${i}`).join(' ') + '.';
    expect(statuses(lintLanguage(snapWith(long), KAN.params), 'C-SG-L2-09')).toEqual(['FAIL']);
  });

  it('dokumen EN: butir leksikon Indonesia (C-20, C-34) NOT_RUN beralasan', () => {
    const out = lintLanguage(snapWith('You must read this section.', 'EN'), KAN.params);
    for (const id of ['C-20', 'C-34']) {
      expect(statuses(out, id), id).toEqual(['NOT_RUN']);
      expect(out.find((i) => i.checkId === id)?.detail, id).toContain('EN');
    }
  });

  it('runner registri: jumlah butir bahasa NOT_RUN di registri = 10 dan semuanya modul language/structure ber-notRunReason', () => {
    const nr = LINT_REGISTRY.filter((d) => d.notRunReason);
    expect(nr.filter((d) => d.module === 'language')).toHaveLength(10);
    for (const d of nr) expect(['language', 'structure', 'scan', 'render'], d.id).toContain(d.module);
  });
});
