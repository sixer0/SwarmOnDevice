// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/engine-core/bind-derivation.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
// S71: uji unit engine/bind Register, Derivation, buildDerivationBlock,
// audit angka, dan predikat reproduksi verbatim `isVerbatimReproduction`
// (IP-31, F-042, D-91, D-98).
import { describe, it, expect } from '../_vitest';
import type { DerivationBlock, RegisterEntry } from '@/lib/studio/contract';
import {
  BENCHMARK_MARKER_KEY,
  BindDefect,
  Derivation,
  Register,
  auditRetired,
  auditText,
  buildDerivationBlock,
  checkResult,
  hasBenchmarkMarker,
  isVerbatimDerivation,
  isVerbatimReproduction,
  monoLine,
  normalizeRegisterEntry,
} from '@/lib/studio/engine/bind';
import { loadBenchmarkDoc } from './fixtures';

const ENTRIES: Record<string, RegisterEntry> = {
  'nilai basis': { v: 1250000, dec: 0, unit: 'Rp', mark: 'TERUKUR', src: 'RAB rev A' },
  'nilai skenario': { v: 1000000, dec: 0, unit: 'Rp', mark: 'ASUMSI', src: '' },
  'selisih skenario': { v: 250000, dec: 0, unit: 'Rp', mark: 'DITURUNKAN', src: '' },
  'rasio beban': { v: 0.625, dec: 2, unit: 'rasio', mark: 'DITURUNKAN', src: '' },
};
const reg = () => new Register(ENTRIES);

describe('Register: validasi entri (port Register.emit)', () => {
  it('entri sah dinormalisasi dan dibekukan', () => {
    const r = reg();
    expect(r.keys()).toEqual(Object.keys(ENTRIES));
    expect(r.u('nilai basis')).toBe('Rp 1.250.000');
    expect(r.u('rasio beban')).toBe('0,62 rasio'); // 0,625 eksak -> half-even
    expect(r.pct('rasio beban', 1)).toBe('0,6 %');
    expect(Object.isFrozen(r.get('nilai basis'))).toBe(true);
  });

  it.each([
    ['tanpa tanda', { v: 1, dec: 0, unit: 'mm', mark: undefined, src: '' }],
    ['tanda tak dikenal', { v: 1, dec: 0, unit: 'mm', mark: 'TEBAKAN', src: '' }],
    ['tanda bukan teks', { v: 1, dec: 0, unit: 'mm', mark: 7, src: '' }],
    ['satuan kosong (DATUM-09 rev B)', { v: 1, dec: 0, unit: '  ', mark: 'TERUKUR', src: '' }],
    ['nilai NaN', { v: Number.NaN, dec: 0, unit: 'mm', mark: 'TERUKUR', src: '' }],
    ['nilai string', { v: '12', dec: 0, unit: 'mm', mark: 'TERUKUR', src: '' }],
    ['dec 4 (batas E-12)', { v: 1, dec: 4, unit: 'mm', mark: 'TERUKUR', src: '' }],
    ['sumber bukan teks', { v: 1, dec: 0, unit: 'mm', mark: 'TERUKUR', src: 9 }],
  ])('%s -> BindDefect bertanda kunci', (_name, raw) => {
    try {
      normalizeRegisterEntry('k uji', raw as never);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(BindDefect);
      expect((e as BindDefect).key).toBe('k uji');
    }
  });

  it('tanda bercampur glif dan huruf kecil dinormalisasi; tuple Python diterima', () => {
    const e = normalizeRegisterEntry('x', [3.5, 1, 'mm', 'terukur', 'ukur lapangan']);
    expect(e).toEqual({ v: 3.5, dec: 1, unit: 'mm', mark: 'TERUKUR', src: 'ukur lapangan' });
  });

  it('kunci tak terdaftar -> BindDefect dengan saran kunci mirip', () => {
    expect(() => reg().get('nilai dasar')).toThrow(/tidak terdaftar.*Mirip: nilai basis, nilai skenario/);
  });

  it('kunci prototipe bukan kunci register', () => {
    const r = reg();
    expect(r.has('constructor')).toBe(false);
    expect(r.has('__proto__')).toBe(false);
    expect(() => r.get('toString')).toThrow(BindDefect);
  });

  it('unused() melacak kunci yang belum dirujuk; values() tidak menandai terpakai', () => {
    const r = reg();
    r.values();
    expect(r.unused()).toHaveLength(4);
    r.get('nilai basis');
    expect(r.unused()).not.toContain('nilai basis');
  });
});

describe('Derivation: aritmetika diperiksa terhadap register', () => {
  it('result cocok -> build berisi baris mono dan baris terstruktur', () => {
    const d = new Derivation('D-1.1', 'Selisih skenario', reg())
      .line('nilai basis', 'nilai basis')
      .line('nilai skenario', 'nilai skenario')
      .result('selisih', 'nilai basis - nilai skenario', 'selisih skenario')
      .verdict('rasio terhadap batas', 'rasio beban', 0.7)
      .closes('Bila harga satuan naik, selisih menyempit.');
    const b = d.build();
    expect(b.label).toBe('D-1.1 · Selisih skenario');
    expect(b.rows.map((r) => r.kind)).toEqual(['line', 'line', 'result', 'verdict']);
    expect(b.rows[2].value).toBe('Rp 250.000');
    expect(b.rows[3].pass).toBe(true);
    expect(b.rows[3].tag).toBe('MEMENUHI');
    expect(b.lines[0]).toBe(monoLine('nilai basis', 'Rp 1.250.000'));
    expect(b.lines[0]).toHaveLength(54 + 18);
  });

  it('result tidak cocok -> BindDefect "jangan perbaiki tampilannya"', () => {
    const d = new Derivation('D-1.2', 'Salah', reg());
    expect(() => d.result('selisih', 'nilai basis - nilai skenario + 1', 'selisih skenario')).toThrow(/tidak cocok/);
  });

  it('toleransi bawaan 0,51 (Python result(tol=0.51))', () => {
    expect(checkResult(reg(), 'nilai basis - nilai skenario + 0.5', 'selisih skenario').ok).toBe(true);
    expect(checkResult(reg(), 'nilai basis - nilai skenario + 0.52', 'selisih skenario').ok).toBe(false);
  });

  it('turunan tanpa result() tidak dapat dibangun (aritmetika tidak pernah diuji)', () => {
    const d = new Derivation('D-1.3', 'Tanpa hasil', reg()).line('nilai basis', 'nilai basis').closes('Akibat.');
    expect(() => d.build()).toThrow(/tanpa satu pun baris result/);
  });

  it('turunan tanpa kalimat penutup tidak dapat dibangun (DATUM §8)', () => {
    const d = new Derivation('D-1.4', 'Tanpa penutup', reg()).result('selisih', 'nilai basis - nilai skenario', 'selisih skenario');
    expect(() => d.build()).toThrow(/tidak ditutup/);
  });

  it('ekspresi jahat di result menjadi BindDefect bertanda kunci, bukan eksekusi', () => {
    const d = new Derivation('D-1.5', 'Jahat', reg());
    try {
      d.result('x', 'process.exit(1)', 'selisih skenario');
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(BindDefect);
      expect((e as BindDefect).key).toBe('selisih skenario');
    }
  });

  it('verdict greaterOrEqual dan label gagal kustom', () => {
    const b = new Derivation('D-1.6', 'Vonis', reg())
      .result('selisih', 'nilai basis - nilai skenario', 'selisih skenario')
      .verdict('rasio minimum', 'rasio beban', 0.7, { direction: 'greaterOrEqual', bad: 'GAGAL' })
      .closes('Akibat.')
      .build();
    expect(b.rows[1]).toMatchObject({ kind: 'verdict', pass: false, tag: 'GAGAL' });
  });
});

describe('buildDerivationBlock: blok kontrak dibangun dan diperiksa', () => {
  const block = (over: Partial<DerivationBlock> = {}): DerivationBlock =>
    ({
      type: 'derivation',
      id: 'D-2.1',
      title: { text: 'Selisih skenario' },
      lines: [
        { label: { text: 'nilai basis' }, value: { registerKey: 'nilai basis' } },
        { label: { text: 'catatan' }, value: { text: 'harga Oktober' }, mark: 'ASUMSI' },
      ],
      result: { label: { text: 'selisih' }, expr: 'nilai_basis - nilai_skenario', registerKey: 'selisih skenario' },
      closing: { text: 'Bila asumsi harga gagal, selisih dihitung ulang.' },
      ...over,
    }) as DerivationBlock;

  it('blok sah dibangun; nilai literal ditulis apa adanya', () => {
    const b = buildDerivationBlock(block(), reg());
    expect(b.rows.map((r) => r.value)).toEqual(['Rp 1.250.000', 'harga Oktober', 'Rp 250.000']);
  });

  it('registerKey tak terdaftar, result salah, tanpa result, tanpa closing -> BindDefect', () => {
    expect(() => buildDerivationBlock(block({ lines: [{ label: { text: 'x' }, value: { registerKey: 'hilang' } }] } as never), reg())).toThrow(BindDefect);
    expect(() =>
      buildDerivationBlock(block({ result: { label: { text: 's' }, expr: 'nilai_basis', registerKey: 'selisih skenario' } }), reg()),
    ).toThrow(BindDefect);
    expect(() => buildDerivationBlock(block({ result: undefined }), reg())).toThrow(BindDefect);
    expect(() => buildDerivationBlock(block({ closing: { text: '' } }), reg())).toThrow(BindDefect);
  });
});

describe('auditText / auditRetired', () => {
  it('angka beban keputusan tercetak wajib tertelusur ke register', () => {
    const r = reg();
    const text = 'Nilai basis Rp 1.250.000 dan rasio 0,62; angka liar 2.500.000 serta 3,14 juga. Bilangan kecil 12 tidak diaudit.';
    const f = auditText(text, r);
    expect(f.map((x) => x.text)).toEqual(['2.500.000', '3,14']);
    expect(f.every((x) => x.kind === 'unregistered')).toBe(true);
    expect(auditText(text, r, ['2.500.000', '3,14'])).toEqual([]);
  });

  // Karakterisasi paritas (temuan F-S71-3, warisan acuan): pola Python
  // datumbind.py:89 `(?![\w.])` membuat angka yang langsung diikuti titik
  // (akhir kalimat) tidak diaudit. Uji mengunci paritas, bukan menyetujuinya.
  it('paritas PAT Python: angka tepat sebelum titik akhir kalimat tidak tertangkap audit', () => {
    expect(auditText('Nilainya Rp 2.500.000 menurut tabel.', reg()).map((x) => x.text)).toEqual(['2.500.000']);
    expect(auditText('Nilainya Rp 2.500.000.', reg())).toEqual([]);
    expect(auditText('Rasio 3,14.', reg())).toEqual([]);
  });

  it('nilai pensiun ditemukan; entri kosong ditolak', () => {
    expect(auditRetired('tarif 10 % lama', ['10 %', '12 %']).map((x) => x.text)).toEqual(['10 %']);
    expect(() => auditRetired('x', [''])).toThrow(BindDefect);
  });
});

describe('isVerbatimReproduction: hanya dokumen bertanda benchmark DAN turunan verbatim murni', () => {
  const verbatim: DerivationBlock = {
    type: 'derivation',
    title: { text: 'Turunan D-4.1 · Grid A4' },
    lines: [{ label: { text: 'kolom teks' }, value: { text: '128 mm' }, mark: 'TERUKUR' }],
    closing: { text: 'Bila lebar halaman berubah, kolom diturunkan ulang.' },
  } as DerivationBlock;
  const marked = { x: { [BENCHMARK_MARKER_KEY]: { source: 'manual000' } } };

  it('penanda: true atau objek; selain itu tidak', () => {
    expect(hasBenchmarkMarker(marked)).toBe(true);
    expect(hasBenchmarkMarker({ x: { benchmark: true } })).toBe(true);
    for (const v of ['true', 1, [], null, false]) expect(hasBenchmarkMarker({ x: { benchmark: v } }), String(v)).toBe(false);
    expect(hasBenchmarkMarker({})).toBe(false);
    expect(hasBenchmarkMarker(null)).toBe(false);
    expect(hasBenchmarkMarker({ x: [] as never })).toBe(false);
  });

  it('bertanda + verbatim murni -> true', () => {
    expect(isVerbatimReproduction(marked, verbatim)).toBe(true);
  });

  it('tanpa penanda -> false (renderer wajib buildDerivationBlock)', () => {
    expect(isVerbatimReproduction({}, verbatim)).toBe(false);
    expect(isVerbatimReproduction({ x: { enforcement: 'report' } }, verbatim)).toBe(false);
  });

  it.each([
    ['memuat result', { result: { label: { text: 'r' }, expr: '1', registerKey: 'k' } }],
    ['memuat verdict', { verdict: { label: { text: 'v' }, registerKey: 'k', limit: 1 } }],
    ['nilai baris registerKey', { lines: [{ label: { text: 'l' }, value: { registerKey: 'k' } }] }],
    ['judul kosong', { title: { text: '   ' } }],
    ['penutup kosong', { closing: { runs: [] } }],
    ['lines bukan larik', { lines: undefined }],
  ])('bertanda tetapi %s -> false', (_n, over) => {
    const b = { ...verbatim, ...over } as DerivationBlock;
    expect(isVerbatimDerivation(b)).toBe(false);
    expect(isVerbatimReproduction(marked, b)).toBe(false);
  });

  it('benchmark Manual 000: setiap turunan bertanda verbatim lolos predikat; tanpa penanda tidak satu pun', () => {
    const doc = loadBenchmarkDoc();
    const ders: DerivationBlock[] = [];
    const walk = (o: unknown): void => {
      if (Array.isArray(o)) o.forEach(walk);
      else if (o && typeof o === 'object') {
        if ((o as { type?: string }).type === 'derivation') ders.push(o as DerivationBlock);
        Object.values(o).forEach(walk);
      }
    };
    walk(doc.chapters);
    walk(doc.appendices);
    expect(ders.length).toBeGreaterThan(0);
    expect(ders.filter((d) => !isVerbatimReproduction(doc, d)).map((d) => d.id)).toEqual([]);
    const noMarker: typeof doc = { ...doc };
    delete noMarker.x;
    expect(ders.filter((d) => isVerbatimReproduction(noMarker, d))).toEqual([]);
  });
});
