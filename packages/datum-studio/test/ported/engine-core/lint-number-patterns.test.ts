// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/engine-core/lint-number-patterns.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
// S08 (DATUM Rev A, research/33 D-09..D-11): pola angka di lint dibangun dari
// entri ID tabel engine/bind/format.ts. Uji karakterisasi: perilaku sebelum
// dan sesudah refaktor harus sama (refaktor tanpa perubahan perilaku).
import { describe, it, expect } from '../_vitest';
import { findTerbilangPairs, parseDatumNumber } from '@/lib/studio/engine/lint/structure/text';
import { isPureNumberCell } from '@/lib/studio/engine/lint/structure/checks-a';
import { fmt as lintFmt } from '@/lib/studio/engine/lint/language/checks';

describe('parseDatumNumber (D-09)', () => {
  it.each([
    ['1.500.000', 1500000],
    ['1.250.000,5', 1250000.5],
    ['2,5', 2.5],
    ['12', 12],
    ['-1.234,56', -1234.56],
    [' 1 250 ', 1250],
    ['1.000', 1000],
  ])('%j -> %s', (s, want) => {
    expect(parseDatumNumber(s)).toBe(want);
  });

  it.each([['1,250,000.5'], ['1.25'], ['12.5'], ['1.2345'], ['abc'], [''], ['1,2,3']])('%j -> NaN', (s) => {
    expect(parseDatumNumber(s)).toBeNaN();
  });
});

describe('findTerbilangPairs (D-09)', () => {
  it('menemukan pasangan angka DATUM dengan terbilang', () => {
    const pairs = findTerbilangPairs('Nilai Rp 1.500.000 (satu juta lima ratus ribu rupiah) dan 12 (dua belas).');
    expect(pairs.map((p) => [p.numberText, p.value, p.words])).toEqual([
      ['1.500.000', 1500000, 1500000],
      ['12', 12, 12],
    ]);
  });

  it('angka berdesimal koma dikenali sebagai satu angka', () => {
    const pairs = findTerbilangPairs('sebesar 2,5 persen (dua koma lima)');
    expect(pairs.map((p) => p.numberText)).toEqual(['2,5']);
    const ok = findTerbilangPairs('1.250 (seribu dua ratus lima puluh)');
    expect(ok.map((p) => [p.numberText, p.value])).toEqual([['1.250', 1250]]);
  });

  it('konvensi EN tidak dibaca sebagai angka DATUM utuh', () => {
    const pairs = findTerbilangPairs('1,500,000 (satu juta lima ratus ribu)');
    expect(pairs.every((p) => p.numberText !== '1,500,000')).toBe(true);
  });
});

describe('isPureNumberCell (D-10)', () => {
  it.each([
    ['1.250,5', true],
    ['44', true],
    ['-1.250.000', true],
    ['1.250.000,25 %', true],
    ['12 kg', true],
    ['1234', true],
    ['maks. 3', false],
    ['teks', false],
    ['', false],
    // Perilaku sekarang (HS is_pure_number): ekor \S{0,8} menelan sisa, jadi
    // bentuk berikut ikut lolos. Dipertahankan; varian EN ditunda (D-10).
    ['1,250,000.25', true],
    ['12.5', true],
    ['1,250,000,000.25', false],
  ])('%j -> %s', (s, want) => {
    expect(isPureNumberCell(s)).toBe(want);
  });
});

describe('fmt lint bahasa (D-11): toFixed dengan desimal koma', () => {
  it.each([
    [12.345, 2, '12,35'],
    [0.5, 1, '0,5'],
    [1250000.5, 1, '1250000,5'],
    [3, 0, '3'],
  ])('fmt(%s, %s) = %s', (n, d, want) => {
    expect(lintFmt(n, d)).toBe(want);
  });

  it('digits bawaan 2', () => {
    expect(lintFmt(7)).toBe('7,00');
  });
});
