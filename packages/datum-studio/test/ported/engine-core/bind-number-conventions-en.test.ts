// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/engine-core/bind-number-conventions-en.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
// S16 (DATUM Rev A, research/31 §5, research/33 D-01..D-03): entri konvensi
// angka EN di tabel per bahasa engine/bind/format.ts. EN = ribuan ",", desimal
// ".", rupiah ditulis IDR (Rp dipetakan ke IDR), satuan mendahului
// ["IDR", "USD", "EUR", "SGD"]. Jalur ID (bawaan) tidak berubah.
import { describe, it, expect } from '../_vitest';
import {
  BindDefect,
} from '@/lib/studio/engine/bind';
import {
  NUMBER_CONVENTIONS,
  fmt,
  fmtFixed,
  numberConvention,
  numberLanguageOf,
  numberPatternSources,
  withUnit,
} from '@/lib/studio/engine/bind/format';

describe('NUMBER_CONVENTIONS: entri EN', () => {
  it('entri EN = register S01 §5 (ribuan ",", desimal ".", IDR menggantikan Rp)', () => {
    expect(NUMBER_CONVENTIONS.EN).toEqual({
      thousandsSeparator: ',',
      decimalSeparator: '.',
      leadingUnits: ['IDR', 'USD', 'EUR', 'SGD'],
      currencyUnit: 'IDR',
      unitAliases: { Rp: 'IDR' },
    });
    expect(numberConvention('EN')).toBe(NUMBER_CONVENTIONS.EN);
  });

  it('entri EN beku', () => {
    expect(Object.isFrozen(NUMBER_CONVENTIONS.EN)).toBe(true);
    expect(Object.isFrozen(NUMBER_CONVENTIONS.EN.leadingUnits)).toBe(true);
    expect(Object.isFrozen(NUMBER_CONVENTIONS.EN.unitAliases)).toBe(true);
  });

  it('bahasa tak dikenal ditolak dengan BindDefect, bukan undefined diam-diam', () => {
    expect(() => numberConvention('FR' as never)).toThrow(BindDefect);
  });
});

describe('numberLanguageOf: bahasa dokumen -> konvensi (sama dengan resolusi render)', () => {
  it.each([
    ['EN', 'EN'],
    ['ID', 'ID'],
    [undefined, 'ID'],
    [null, 'ID'],
    ['en', 'ID'],
    ['FR', 'ID'],
    [42, 'ID'],
  ])('numberLanguageOf(%s) = %s', (lang, want) => {
    expect(numberLanguageOf(lang)).toBe(want);
  });
});

describe('fmt(v, dec, "EN")', () => {
  it.each([
    [1250000.5, 1, '1,250,000.5'],
    [1250000.5, 0, '1,250,000'],
    [1250000.5, 2, '1,250,000.50'],
    [-1250000.5, 1, '-1,250,000.5'],
    [1385946000, 0, '1,385,946,000'],
    [12, 0, '12'],
    [0.125, 2, '0.12'],
    [2.5, 0, '2'],
  ])('fmt(%s, %s, EN) = %s', (v, dec, want) => {
    expect(fmt(v, dec, 'EN')).toBe(want);
  });

  it('tanpa argumen bahasa dan dengan "ID" tetap konvensi ID', () => {
    expect(fmt(1250000.5, 1)).toBe('1.250.000,5');
    expect(fmt(1250000.5, 1, 'ID')).toBe('1.250.000,5');
  });

  it('dec tidak sah tetap ditolak pada EN', () => {
    expect(() => fmt(1, 21, 'EN')).toThrow(BindDefect);
  });
});

describe('withUnit(s, unit, "EN")', () => {
  it.each([
    ['IDR', 'IDR 1,250,000.5'],
    ['Rp', 'IDR 1,250,000.5'],
    ['USD', 'USD 1,250,000.5'],
    ['EUR', 'EUR 1,250,000.5'],
    ['SGD', 'SGD 1,250,000.5'],
    ['%', '1,250,000.5 %'],
    ['kW', '1,250,000.5 kW'],
  ])('withUnit(fmt(1250000.5, 1, EN), %s, EN) = %s', (unit, want) => {
    expect(withUnit(fmt(1250000.5, 1, 'EN'), unit, 'EN')).toBe(want);
  });

  it('satuan kosong = angka saja', () => {
    expect(withUnit('1,250', null, 'EN')).toBe('1,250');
    expect(withUnit('1,250', '', 'EN')).toBe('1,250');
  });

  it('ID: IDR tetap menyusul dan Rp mendahului (tanpa alias)', () => {
    expect(withUnit('1.250.000,5', 'IDR', 'ID')).toBe('1.250.000,5 IDR');
    expect(withUnit('1.250.000,5', 'Rp', 'ID')).toBe('Rp 1.250.000,5');
  });
});

describe('fmtFixed / numberPatternSources dengan entri EN', () => {
  it('fmtFixed memakai desimal "."', () => {
    expect(fmtFixed(12.345, 2, NUMBER_CONVENTIONS.EN)).toBe('12.35');
  });

  it('pola angka berpemisah EN mengenali 1,250,000.5', () => {
    const src = numberPatternSources(NUMBER_CONVENTIONS.EN);
    expect(new RegExp(`^${src.grouped}$`).test('1,250,000.5')).toBe(true);
    expect(new RegExp(`^${src.grouped}$`).test('1.250.000,5')).toBe(false);
  });
});
