// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/engine-core/bind-language.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
// S17 (DATUM Rev A, research/33 D-04..D-07): lapisan bind menerima konvensi
// bahasa. Register, Derivation, dan auditText memformat dan mengaudit angka
// register menurut bahasa dokumen (bawaan ID); satuan mata uang dari tabel
// NUMBER_CONVENTIONS. Uji bind ID lama (bind-format, bind-derivation) tetap
// tidak disunting.
import { describe, it, expect } from '../_vitest';
import type { DerivationBlock, RegisterApi, RegisterEntry } from '@/lib/studio/contract';
import {
  BIND_NUMBER_PATTERN_SOURCE,
  BindDefect,
  Derivation,
  Register,
  auditText,
  bindNumberPatternSource,
  buildDerivationBlock,
  registerForSnapshot,
} from '@/lib/studio/engine/bind';

const ENTRIES: Record<string, RegisterEntry> = {
  biaya: { v: 1250000.5, dec: 1, unit: 'Rp', mark: 'TERUKUR', src: 'RAB 2026' },
  biaya_idr: { v: 1385946000, dec: 0, unit: 'IDR', mark: 'TERUKUR', src: 'RAB 2026' },
  porsi: { v: 25, dec: 0, unit: '%', mark: 'ASUMSI', src: 'kebijakan' },
  dua_kali: { v: 2500001, dec: 0, unit: 'Rp', mark: 'DITURUNKAN', src: 'biaya x 2' },
};

describe('Register: konvensi bahasa', () => {
  it('tanpa bahasa = ID (perilaku lama)', () => {
    const r = new Register(ENTRIES);
    expect(r.language).toBe('ID');
    expect(r.format('biaya')).toBe('1.250.000,5');
    expect(r.u('biaya')).toBe('Rp 1.250.000,5');
    expect(r.u('biaya_idr')).toBe('1.385.946.000 IDR');
    expect(r.rp('biaya')).toBe('Rp 1.250.000,5');
    expect(r.pct('porsi', 0)).toBe('25 %');
  });

  it('EN: ribuan ",", desimal ".", rupiah = IDR mendahului', () => {
    const r = new Register(ENTRIES, 'EN');
    expect(r.language).toBe('EN');
    expect(r.format('biaya')).toBe('1,250,000.5');
    expect(r.format('biaya', 2)).toBe('1,250,000.50');
    expect(r.u('biaya')).toBe('IDR 1,250,000.5');
    expect(r.u('biaya_idr')).toBe('IDR 1,385,946,000');
    expect(r.rp('biaya')).toBe('IDR 1,250,000.5');
    expect(r.pct('porsi', 0)).toBe('25 %');
  });

  it('knownForms EN = bentuk EN dec 0..3, tanpa bentuk ID', () => {
    const forms = new Register({ biaya: ENTRIES.biaya }, 'EN').knownForms();
    expect([...forms].sort()).toEqual(['1,250,000', '1,250,000.5', '1,250,000.50', '1,250,000.500'].sort());
  });

  it('bahasa tak dikenal ditolak', () => {
    expect(() => new Register(ENTRIES, 'FR' as never)).toThrow(BindDefect);
  });
});

describe('registerForSnapshot: bahasa dari data dokumen saja', () => {
  it.each([
    ['EN', 'EN'],
    ['ID', 'ID'],
    [undefined, 'ID'],
  ])('meta.language %s -> Register %s', (language, want) => {
    const r = registerForSnapshot({ register: ENTRIES, doc: { meta: { language } } });
    expect(r.language).toBe(want);
  });

  it('register absen = register kosong', () => {
    const r = registerForSnapshot({ doc: { meta: { language: 'EN' } } });
    expect(r.keys()).toEqual([]);
    expect(r.language).toBe('EN');
  });
});

const BLOCK: DerivationBlock = {
  type: 'derivation',
  id: 'D-1.1',
  title: { text: 'Biaya ganda' },
  lines: [
    { label: { text: 'Biaya satuan' }, value: { registerKey: 'biaya' } },
    { label: { text: 'Faktor' }, value: { text: '2' } },
  ],
  result: { label: { text: 'Biaya ganda' }, expr: 'biaya * 2', registerKey: 'dua_kali', tol: 0.51 },
  closing: { text: 'Bila faktor berubah, biaya ikut berubah.' },
} as unknown as DerivationBlock;

describe('Derivation: konvensi dari Register', () => {
  it('Register EN -> baris nilai EN dengan IDR', () => {
    const b = buildDerivationBlock(BLOCK, new Register(ENTRIES, 'EN'));
    expect(b.rows.map((r) => r.value).filter(Boolean)).toEqual(['IDR 1,250,000.5', '2', 'IDR 2,500,001']);
  });

  it('Register ID (bawaan) -> baris nilai ID dengan Rp', () => {
    const b = buildDerivationBlock(BLOCK, new Register(ENTRIES));
    expect(b.rows.map((r) => r.value).filter(Boolean)).toEqual(['Rp 1.250.000,5', '2', 'Rp 2.500.001']);
  });

  it('nilai literal angka dan verdict ikut bahasa Register', () => {
    const d = new Derivation('D-1', 'Uji', new Register(ENTRIES, 'EN'));
    d.line('Literal', null, { value: 1234.5, dec: 1 });
    d.verdict('Porsi', 'porsi', 30);
    expect(d.rows.map((r) => r.value)).toEqual(['1,234.5', '25 %']);
  });

  it('RegisterApi non-Register: opsi language, bawaan ID', () => {
    const plain: RegisterApi = {
      has: (k) => k in ENTRIES,
      get: (k) => ENTRIES[k],
      format: (k) => String(ENTRIES[k].v),
      keys: () => Object.keys(ENTRIES),
    };
    expect(new Derivation('D-1', 'Uji', plain).line('a', 'biaya').rows[0].value).toBe('Rp 1.250.000,5');
    expect(new Derivation('D-1', 'Uji', plain, { language: 'EN' }).line('a', 'biaya').rows[0].value).toBe('IDR 1,250,000.5');
  });
});

describe('auditText: varian EN hanya untuk dokumen EN', () => {
  const reg = (lang?: 'ID' | 'EN') => new Register({ biaya: ENTRIES.biaya }, lang);

  it('pola ID dari pembangun = literal lama (byte-sama)', () => {
    expect(bindNumberPatternSource('ID')).toBe(BIND_NUMBER_PATTERN_SOURCE);
    expect(bindNumberPatternSource()).toBe(BIND_NUMBER_PATTERN_SOURCE);
  });

  it('dokumen EN: bentuk EN terdaftar lolos', () => {
    expect(auditText('Total cost IDR 1,250,000.5 for 2026.', reg('EN'))).toEqual([]);
    expect(auditText('Rounded: 1,250,000 IDR', reg('EN'))).toEqual([]);
  });

  it('dokumen EN: bentuk ID dari nilai yang sama ditolak', () => {
    const f = auditText('Total cost 1.250.000,5 IDR', reg('EN'));
    expect(f.map((x) => x.text)).toEqual(['1.250']);
  });

  it('dokumen EN: angka EN tak terdaftar dilaporkan', () => {
    const f = auditText('Other cost IDR 3,360,000,000 and ratio 0.77', reg('EN'));
    expect(f.map((x) => x.text)).toEqual(['0.77', '3,360,000,000']);
  });

  it('dokumen ID: bentuk EN ditolak, bentuk ID lolos (perilaku lama)', () => {
    expect(auditText('Biaya Rp 1.250.000,5 tahun 2026.', reg())).toEqual([]);
    const f = auditText('Biaya IDR 1,250,000.5', reg());
    expect(f.length).toBeGreaterThan(0);
    expect(f.map((x) => x.text)).toEqual(['1,250']);
  });

  it('bahasa audit eksplisit untuk RegisterApi non-Register', () => {
    const plain: RegisterApi = {
      has: () => true,
      get: () => ENTRIES.biaya,
      format: () => '',
      keys: () => ['biaya'],
    };
    expect(auditText('IDR 1,250,000.5', plain, [], { lang: 'EN' })).toEqual([]);
    expect(auditText('IDR 1,250,000.5', plain).map((x) => x.text)).toEqual(['1,250']);
  });
});
