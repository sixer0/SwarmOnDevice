// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/engine-core/bind-number-conventions.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
// S07 (DATUM Rev A, research/33 D-01..D-03): konvensi angka sebagai tabel per
// bahasa di engine/bind/format.ts. Ronde ini hanya entri ID, sama persis
// dengan konstanta lama; fmt(v, dec) dan withUnit tidak berubah perilaku.
import { describe, it, expect } from '../_vitest';
import {
  DATUM_DECIMAL_SEPARATOR,
  DATUM_LEADING_UNITS,
  DATUM_THOUSANDS_SEPARATOR,
  DEFAULT_NUMBER_LANGUAGE,
  NUMBER_CONVENTIONS,
  fmt,
  fmtFixed,
  numberConvention,
  numberPatternSources,
  withUnit,
} from '@/lib/studio/engine/bind/format';

describe('NUMBER_CONVENTIONS: tabel per bahasa (ID bawaan)', () => {
  it('berisi entri ID dan EN (EN ditambah baris S16, diuji di bind-number-conventions-en)', () => {
    expect(Object.keys(NUMBER_CONVENTIONS)).toEqual(['ID', 'EN']);
    expect(DEFAULT_NUMBER_LANGUAGE).toBe('ID');
  });

  it('entri ID = konvensi DATUM DT-30 / P6-39', () => {
    expect(NUMBER_CONVENTIONS.ID).toEqual({
      thousandsSeparator: '.',
      decimalSeparator: ',',
      leadingUnits: ['Rp', 'USD', 'EUR', 'SGD'],
      currencyUnit: 'Rp',
      unitAliases: {},
    });
  });

  it('numberConvention() tanpa argumen dan dengan "ID" memberi entri ID', () => {
    expect(numberConvention()).toBe(NUMBER_CONVENTIONS.ID);
    expect(numberConvention('ID')).toBe(NUMBER_CONVENTIONS.ID);
  });

  it('ekspor lama tetap ada sebagai alias entri ID', () => {
    expect(DATUM_THOUSANDS_SEPARATOR).toBe('.');
    expect(DATUM_DECIMAL_SEPARATOR).toBe(',');
    expect(DATUM_LEADING_UNITS).toEqual(['Rp', 'USD', 'EUR', 'SGD']);
  });

  it('tabel tidak dapat diubah saat runtime', () => {
    expect(Object.isFrozen(NUMBER_CONVENTIONS)).toBe(true);
    expect(Object.isFrozen(NUMBER_CONVENTIONS.ID)).toBe(true);
    expect(Object.isFrozen(NUMBER_CONVENTIONS.ID.leadingUnits)).toBe(true);
  });
});

describe('fmt / withUnit: keluaran ID terkunci', () => {
  it.each([
    [1250000.5, 1, '1.250.000,5'],
    [1250000.5, 0, '1.250.000'],
    [1250000.5, 2, '1.250.000,50'],
    [-1250000.5, 1, '-1.250.000,5'],
    [12, 0, '12'],
  ])('fmt(%s, %s) = %s', (v, dec, want) => {
    expect(fmt(v, dec)).toBe(want);
  });

  it.each([
    ['Rp', 'Rp 1.250.000,5'],
    ['USD', 'USD 1.250.000,5'],
    ['EUR', 'EUR 1.250.000,5'],
    ['SGD', 'SGD 1.250.000,5'],
    ['IDR', '1.250.000,5 IDR'],
    ['%', '1.250.000,5 %'],
    ['m2', '1.250.000,5 m2'],
  ])('withUnit(fmt(1250000.5, 1), %s) = %s', (unit, want) => {
    expect(withUnit(fmt(1250000.5, 1), unit)).toBe(want);
  });
});

describe('fmtFixed: semantik toFixed untuk pesan diagnosis lint, desimal ID', () => {
  it.each([
    [12.345, 2, '12,35'],
    [0.5, 1, '0,5'],
    [1234.5, 1, '1234,5'],
    [3, 0, '3'],
    [-1.25, 3, '-1,250'],
  ])('fmtFixed(%s, %s) = %s', (n, digits, want) => {
    expect(fmtFixed(n, digits)).toBe(want);
  });

  it('digits bawaan 2', () => {
    expect(fmtFixed(1.5)).toBe('1,50');
  });

  it('tidak mengelompokkan ribuan (perilaku lama toFixed + replace)', () => {
    expect(fmtFixed(1250000.5, 1)).toBe('1250000,5');
  });
});

describe('numberPatternSources: potongan regex angka dari entri tabel', () => {
  it('entri ID memberi pola yang sama dengan literal lint lama', () => {
    const p = numberPatternSources();
    expect(p.thousands).toBe('\\.');
    expect(p.decimal).toBe(',');
    expect(p.grouped).toBe('\\d{1,3}(?:\\.\\d{3})+(?:,\\d+)?');
    expect(p.plain).toBe('\\d+(?:,\\d+)?');
  });

  it('pola grouped mengenali angka DATUM dan menolak pemisah terbalik', () => {
    const re = new RegExp(`^${numberPatternSources().grouped}$`);
    expect(re.test('1.250.000,5')).toBe(true);
    expect(re.test('1.250')).toBe(true);
    expect(re.test('1,250,000.5')).toBe(false);
    expect(re.test('1250')).toBe(false);
  });
});
