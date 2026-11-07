// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/engine-core/bind-format.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
// S71: uji unit engine/bind format angka DATUM (DT-30; port fmt/_withunit
// datumbind.py). Ribuan ".", desimal ",", pembulatan half-even terhadap nilai
// biner eksak (perilaku Python f"{v:,.{dec}f}"), satuan dipisah spasi,
// mata uang mendahului.
import { describe, it, expect } from '../_vitest';
import { BindDefect, DATUM_MAX_DECIMALS, fmt, pyRound, withUnit } from '@/lib/studio/engine/bind';

describe('fmt: pemisah DATUM', () => {
  it.each([
    [0, 0, '0'],
    [7, 0, '7'],
    [999, 0, '999'],
    [1000, 0, '1.000'],
    [1234567, 0, '1.234.567'],
    [1234567.891, 2, '1.234.567,89'],
    [0.5, 3, '0,500'],
    [0.001, 3, '0,001'],
    [12.3, 1, '12,3'],
    [-1234.5, 1, '-1.234,5'],
    [1e15, 0, '1.000.000.000.000.000'],
  ])('fmt(%s, %s) = %s', (v, dec, want) => {
    expect(fmt(v, dec)).toBe(want);
  });

  it('pemisah tidak pernah terbalik: tidak ada "," sebelum "." pada keluaran', () => {
    for (const v of [1234.5, 98765.4321, 1000000.01]) {
      const s = fmt(v, 2);
      expect(s.lastIndexOf('.')).toBeLessThan(s.indexOf(','));
    }
  });
});

describe('fmt: pembulatan half-even eksak (paritas Python)', () => {
  it.each([
    [0.5, 0, '0'],
    [1.5, 0, '2'],
    [2.5, 0, '2'],
    [3.5, 0, '4'],
    [-2.5, 0, '-2'],
    // 2.675 dalam biner = 2.67499999..., Python memberi 2.67 (toFixed memberi 2.68 di beberapa mesin)
    [2.675, 2, '2,67'],
    [1.005, 2, '1,00'],
    [0.125, 2, '0,12'],
    [0.375, 2, '0,38'],
  ])('fmt(%s, %s) = %s', (v, dec, want) => {
    expect(fmt(v, dec)).toBe(want);
  });

  it('nol negatif dipertahankan seperti Python ("-0")', () => {
    expect(fmt(-0, 0)).toBe('-0');
    expect(fmt(-0.4, 0)).toBe('-0');
  });
});

describe('fmt: masukan tidak sah menjadi BindDefect, bukan keluaran palsu', () => {
  it.each([[Number.NaN], [Number.POSITIVE_INFINITY], [Number.NEGATIVE_INFINITY]])('nilai %s ditolak', (v) => {
    expect(() => fmt(v)).toThrow(BindDefect);
  });

  it.each([[-1], [1.5], [DATUM_MAX_DECIMALS + 1], [Number.NaN]])('dec %s ditolak', (dec) => {
    expect(() => fmt(1, dec)).toThrow(BindDefect);
  });

  it('nilai bukan number (string) ditolak', () => {
    expect(() => fmt('12' as unknown as number)).toThrow(BindDefect);
  });

  it('dec maksimum diterima', () => {
    expect(fmt(1, DATUM_MAX_DECIMALS)).toBe('1,' + '0'.repeat(DATUM_MAX_DECIMALS));
  });
});

describe('pyRound: padanan round() Python', () => {
  it.each([
    [2.5, 0, 2],
    [3.5, 0, 4],
    [2.675, 2, 2.67],
    [1234.5, -1, 1230],
    [1250, -2, 1200],
    [-0.5, 0, -0],
  ])('round(%s, %s) = %s', (x, n, want) => {
    expect(Object.is(pyRound(x, n), want) || pyRound(x, n) === want).toBe(true);
  });

  it('tak hingga dan digit tidak sah ditolak', () => {
    expect(() => pyRound(Number.POSITIVE_INFINITY)).toThrow(BindDefect);
    expect(() => pyRound(1, 1.5)).toThrow(BindDefect);
    expect(() => pyRound(1, 400)).toThrow(BindDefect);
  });
});

describe('withUnit: satuan dipisah satu spasi, mata uang mendahului', () => {
  it.each([
    ['1.000', 'Rp', 'Rp 1.000'],
    ['12', 'USD', 'USD 12'],
    ['12,5', 'mm', '12,5 mm'],
    ['11', '%', '11 %'],
    ['3', undefined, '3'],
    ['3', null, '3'],
    ['3', '', '3'],
  ])('withUnit(%s, %s) = %s', (s, unit, want) => {
    expect(withUnit(s, unit as string | null | undefined)).toBe(want);
  });
});
