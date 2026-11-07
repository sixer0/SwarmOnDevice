// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/engine-core/bind-arith.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
// S71: uji unit parser turunan aman `evalArith` (engine/bind/arith.ts).
// Kontrak I02: "parser aman, tanpa eval/Function". Uji ini memeriksa
// (1) semantik subhimpunan Python, (2) masukan jahat ditolak BindDefect tanpa
// efek samping, (3) sumber modul tidak memakai evaluasi kode dinamis.
import { describe, it, expect, vi, afterEach } from '../_vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ARITH_MAX_DEPTH, ARITH_MAX_LENGTH, BindDefect, evalArith } from '@/lib/studio/engine/bind';
import { REPO } from './fixtures';

const V = { 'nilai basis': 120, 'nilai skenario': 45, a: 7, b: 2, c: -3 };

describe('evalArith: semantik Python', () => {
  it.each([
    ['1 + 2 * 3', 7],
    ['(1 + 2) * 3', 9],
    ['2 ** 3 ** 2', 512], // asosiatif kanan
    ['-2 ** 2', -4], // unary lebih lemah dari **
    ['(-2) ** 2', 4],
    ['7 // 2', 3],
    ['-7 // 2', -4], // floor, bukan trunc
    ['7 % -3', -2], // tanda mengikuti pembagi
    ['-7 % 3', 2],
    ['7 / 2', 3.5],
    ['1_000 + .5', 1000.5],
    ['1e3', 1000],
    ['abs(-4.5)', 4.5],
    ['sqrt(16)', 4],
    ['round(2.5)', 2],
    ['round(2.675, 2)', 2.67],
    ['min(3, 1, 2)', 1],
    ['max(3, 1, 2,)', 3], // koma penutup sah di Python
    ['+-+3', -3],
  ])('%s = %s', (expr, want) => {
    expect(evalArith(expr, {})).toBe(want);
  });

  it('nama register berspasi dan bentuk garis-bawahnya', () => {
    expect(evalArith('nilai basis - nilai skenario', V)).toBe(75);
    expect(evalArith('nilai_basis - nilai_skenario', V)).toBe(75);
    expect(evalArith('a * b + c', V)).toBe(11);
  });

  it('nama terpanjang dicocokkan lebih dulu, berbatas kata', () => {
    expect(evalArith('a b', { a: 1, 'a b': 2 })).toBe(2);
    expect(() => evalArith('ab', { a: 1, b: 2 })).toThrow(BindDefect);
  });

  it('nama Unicode (huruf Indonesia/aksara) didukung', () => {
    expect(evalArith('élan + 1', { élan: 2 })).toBe(3);
  });
});

describe('evalArith: galat aritmetika dilempar BindDefect, tidak pernah NaN/Infinity', () => {
  it.each([
    ['1 / 0'],
    ['1 // 0'],
    ['1 % 0'],
    ['0 ** -1'],
    ['(-8) ** 0.5'],
    ['sqrt(-1)'],
    ['10 ** 400'],
    ['1e309'],
    ['round(1, 0.5)'],
    ['abs(1, 2)'],
    ['max(1)'],
    ['min()'],
  ])('%s', (expr) => {
    expect(() => evalArith(expr, {})).toThrow(BindDefect);
  });

  it('variabel bukan bilangan hingga ditolak sebelum evaluasi', () => {
    expect(() => evalArith('x', { x: Number.NaN })).toThrow(BindDefect);
    expect(() => evalArith('x', { x: Number.POSITIVE_INFINITY })).toThrow(BindDefect);
  });

  it('ekspresi kosong / hanya spasi ditolak', () => {
    expect(() => evalArith('', {})).toThrow(BindDefect);
    expect(() => evalArith('   ', {})).toThrow(BindDefect);
  });
});

describe('evalArith: masukan jahat ditolak tanpa eksekusi kode', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete (globalThis as Record<string, unknown>).__s71_pwned;
  });

  const MALICIOUS = [
    'constructor',
    'constructor.constructor("return process")()',
    '__proto__',
    'toString',
    'valueOf()',
    'process.exit(1)',
    'require("child_process").execSync("calc")',
    'globalThis.__s71_pwned = 1',
    'this',
    'eval("1+1")',
    'Function("return 1")()',
    'new Function("return 1")',
    'import("fs")',
    '`${1+1}`',
    '1; 2',
    '1, 2',
    'a = 3',
    'a.b',
    '[1, 2]',
    '{a: 1}',
    'x => x',
    '1 && 2',
    '1 | 2',
    '1 << 2',
    '!1',
    '~1',
    'abs',
    'abs(1',
    'abs 1',
    'pow(2, 3)',
    '__import__("os").system("calc")',
    '"12"',
    '1__0',
    '1.2.3',
    '0x10',
    '\u0000',
    'a​b',
  ];

  it.each(MALICIOUS.map((m) => [m]))('%j -> BindDefect', (expr) => {
    expect(() => evalArith(expr, { a: 1, b: 2 })).toThrow(BindDefect);
  });

  it('tidak memanggil eval global maupun membuat efek samping', () => {
    const evalSpy = vi.spyOn(globalThis, 'eval');
    for (const expr of MALICIOUS) {
      try {
        evalArith(expr, { a: 1 });
      } catch {
        /* diharapkan */
      }
    }
    expect(evalSpy).not.toHaveBeenCalled();
    expect((globalThis as Record<string, unknown>).__s71_pwned).toBeUndefined();
  });

  it('kunci variabel bernama prototipe hanya dibaca sebagai data milik sendiri', () => {
    const vars = JSON.parse('{"__proto__": 5, "constructor": 6}') as Record<string, number>;
    expect(evalArith('__proto__ + constructor', vars)).toBe(11);
    // Tanpa kunci milik sendiri, nama prototipe bukan variabel.
    expect(() => evalArith('constructor', {})).toThrow(BindDefect);
    expect(() => evalArith('hasOwnProperty', {})).toThrow(BindDefect);
  });

  it(`kedalaman bersarang > ${ARITH_MAX_DEPTH} ditolak (tanpa stack overflow)`, () => {
    const ok = '('.repeat(ARITH_MAX_DEPTH - 2) + '1' + ')'.repeat(ARITH_MAX_DEPTH - 2);
    expect(evalArith(ok, {})).toBe(1);
    const deep = '('.repeat(ARITH_MAX_DEPTH + 5) + '1' + ')'.repeat(ARITH_MAX_DEPTH + 5);
    expect(() => evalArith(deep, {})).toThrow(BindDefect);
    expect(() => evalArith('-'.repeat(5000) + '1', {})).toThrow(BindDefect);
    expect(() => evalArith('2' + '**2'.repeat(500), {})).toThrow(BindDefect);
  });

  it(`panjang > ${ARITH_MAX_LENGTH} karakter ditolak`, () => {
    expect(() => evalArith('1+'.repeat(ARITH_MAX_LENGTH) + '1', {})).toThrow(BindDefect);
  });

  it('pesan galat tidak menggemakan nilai variabel lain dan menyebut ekspresi', () => {
    try {
      evalArith('rahasia_tak_terdaftar + 1', { 'kunci lain': 42 });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(BindDefect);
      expect((e as Error).message).toContain('rahasia_tak_terdaftar');
      expect((e as Error).message).not.toContain('42');
    }
  });
});

describe('sumber engine/bind: tanpa evaluasi kode dinamis (larangan keras driver_rules)', () => {
  const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

  it.each([['arith.ts'], ['derivation.ts'], ['format.ts'], ['register.ts'], ['audit.ts'], ['reproduction.ts']])('%s', (f) => {
    const src = stripComments(readFileSync(path.join(REPO, 'src', 'lib', 'studio', 'engine', 'bind', f), 'utf8'));
    expect(src).not.toMatch(/\beval\s*\(/);
    expect(src).not.toMatch(/\bnew\s+Function\b/);
    expect(src).not.toMatch(/\bFunction\s*\(/);
    expect(src).not.toMatch(/\bvm\b\s*\.\s*(run|Script)/);
    expect(src).not.toMatch(/child_process/);
  });
});
