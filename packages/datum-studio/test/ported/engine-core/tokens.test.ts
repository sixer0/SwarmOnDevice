// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/engine-core/tokens.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
// S71: uji unit engine/tokens (I01; S11). Turunan kelas T dihitung mesin,
// hak override kelas K hanya ADMIN_SESSION (KT-16), kelas T tidak dapat
// ditimpa siapa pun, kunci asing ditolak. Murni: tanpa DB/jaringan.
import { describe, it, expect } from '../_vitest';
import type { CallerKind, ParamMap } from '@/lib/studio/contract';
import { ROLE_KEYS } from '@/lib/studio/contract/enums';
import { StudioEngineError } from '@/lib/studio/contract/errors';
import { ALL_PARAMS, PARAMS_BY_KEY } from '@/lib/studio/params';
import {
  assertOverrideRights,
  checkOverrideRights,
  computeDerived,
  computeDerivedWith,
  railModeFor,
  resolveParams,
  resolveParamsWith,
  resolveRoleFormat,
  validateParamValue,
} from '@/lib/studio/engine/tokens';
import { effectiveClass } from '@/lib/studio/engine/tokens/merge';
import { canonicalTemplate } from './fixtures';

const resolve = (overrides: ParamMap = {}, base: ParamMap = {}) => resolveParams({ base, overrides, registry: ALL_PARAMS });
const NON_ADMIN: CallerKind[] = ['USER_SESSION', 'GOOGLE_SESSION', 'INTERNAL_AGENT'];

describe('registri parameter: prasyarat kelas', () => {
  // Kontrak §5.1: `derive` "wajib untuk kelas T". SR-42 (D-130, F-S71-2):
  // P9-04/38/51 kini membawa `derive` (diagramClassification,
  // diagramLatticeSnap, diagramLineSpacing), jadi daftar pengecualian kosong.
  it('setiap ParamDef kelas T memiliki derive (D-130: tanpa pengecualian)', () => {
    const tWithoutDerive = ALL_PARAMS.filter((d) => d.class === 'T' && !d.derive).map((d) => d.key).sort();
    expect(tWithoutDerive).toEqual([]);
  });

  it('3 kunci T diagram (P9-04/38/51) dihitung dari induk (bukan default katalog)', () => {
    // SR-42 (D-168): type.baselinePt (P4T-17) kini kelas T = leading badan efektif,
    // jadi induk yang ditimpa adalah type.scale.body.leading; override langsung
    // type.baselinePt ditolak PARAM_CLASS_T_READONLY.
    expect(resolve({ 'type.baselinePt': 12 } as ParamMap).errors.map((e) => [e.key, e.code])).toEqual([['type.baselinePt', 'PARAM_CLASS_T_READONLY']]);
    const { params } = resolve({ 'type.scale.body.leading': 12, 'classification.level': 'RAHASIA' } as ParamMap);
    expect(params['type.baselinePt']).toBe(12);
    expect(params['diagram.docxPlacement.exactLineSpacingPt']).toBe(12);
    expect(params['diagram.latticeSnap']).toEqual({ xMm: params['grid.latticeXMm'], yMm: params['grid.latticeYMm'] });
    expect(params['grid.latticeYMm']).toBe(4.2333);
    if (PARAMS_BY_KEY.has('classification.level')) expect(params['diagram.classification']).toBe(params['classification.level']);
  });

  it('kunci registri unik', () => {
    expect(new Set(ALL_PARAMS.map((d) => d.key)).size).toBe(ALL_PARAMS.length);
  });
});

describe('resolveParams: turunan kelas T dihitung dari induk (bukan disalin)', () => {
  it('profil kanonik: fullSpan 166, latticeX 128/12, latticeY 13,5 pt -> mm, figur sah [128,166], cek lebar 210', () => {
    const { params, errors } = resolve();
    expect(errors).toEqual([]);
    expect(params['grid.fullSpanMm']).toBe(166);
    expect(params['grid.latticeXMm']).toBe(10.6667);
    expect(params['grid.latticeYMm']).toBe(4.7625);
    expect(params['grid.allowedFigureWidthsMm']).toEqual([128, 166]);
    expect(params['grid.pageWidthCheck']).toBe(210);
    expect(params['vat.effectiveRatePercent']).toBe(11);
    // D-33: margin bawah = 297 - 26 - 247
    expect(params['grid.marginBottomMm']).toBe(24);
  });

  it('kolom teks turunan menggerakkan fullSpan, latticeX, allowedFigureWidths (kriteria §7 #1)', () => {
    // SR-42 (D-168, PC-02): grid.textColumnMm kini kelas T = lebar - dalam - talang
    // - rel - luar. Kolom 120 dicapai lewat induknya: margin luar 28 disematkan
    // preset (lapis base; turunan beracuan, D-165 KT-4).
    const { params, errors } = resolve({}, { 'grid.outerMarginMm': 28 });
    expect(params['grid.textColumnMm']).toBe(120);
    expect(params['grid.fullSpanMm']).toBe(158);
    expect(params['grid.latticeXMm']).toBe(10);
    expect(params['grid.allowedFigureWidthsMm']).toEqual([120, 158]);
    expect(params['grid.pageWidthCheck']).toBe(210);
    expect(errors).toEqual([]);
  });

  it('grid menutup lebar halaman by construction (P4G-15): override kolom teks ditolak, tidak membuka grid', () => {
    // SR-42 (D-168, D-158): kolom teks kelas T diturunkan dari halaman, jadi grid
    // 202 mm (uji lama) tidak lagi dapat dibentuk; override ditolak dan cek tetap 210.
    const { params, errors } = resolve({ 'grid.textColumnMm': 120 });
    expect(errors.map((e) => [e.key, e.code])).toEqual([['grid.textColumnMm', 'PARAM_CLASS_T_READONLY']]);
    expect(params['grid.textColumnMm']).toBe(128);
    expect(params['grid.pageWidthCheck']).toBe(210);
    for (const size of ['A4', 'A3', 'A5', 'Letter', 'Legal', 'F4']) {
      for (const orientation of ['portrait', 'landscape']) {
        const r = resolve({ 'page.size': size, 'page.orientation': orientation } as ParamMap);
        const tag = `${size} ${orientation}`;
        expect(r.params['grid.pageWidthCheck'], tag).toBe((r.params['page.sizeMm'] as number[])[0]);
        expect(r.errors.filter((e) => e.key === 'grid.pageWidthCheck'), tag).toEqual([]);
      }
    }
  });

  it('blok teks = tinggi - atas - bawah (D-162/D-165); base T palsu dibuang; margin terlalu besar -> galat', () => {
    // SR-42 (D-168): P4G-11 kelas T `textBlockFromPage`; margin bawah = masukan
    // beracuan (D-33/D-162). Blok 290 di base (uji lama) dihitung ulang 247.
    const fake = resolve({}, { 'grid.textBlockHeightMm': 290 });
    expect(fake.params['grid.textBlockHeightMm']).toBe(247);
    expect(fake.params['grid.marginBottomMm']).toBe(24);
    expect(fake.errors).toEqual([]);
    // D-165: A4 landscape 160 (bukan -63 seperti 247 tertulis).
    expect(resolve({ 'page.orientation': 'landscape' } as ParamMap).params['grid.textBlockHeightMm']).toBe(160);
    // SR-60: blok teks turunan <= 0 (margin bawah 280 disematkan preset) -> SCHEMA_INVALID.
    const tight = resolve({}, { 'grid.marginBottomMm': 280 });
    expect(tight.params['grid.textBlockHeightMm']).toBe(-9);
    expect(tight.errors.some((e) => e.key === 'grid.textBlockHeightMm' && e.code === 'SCHEMA_INVALID')).toBe(true);
  });

  it('halaman non-A4 (P4G-17): kolom teks diturunkan ulang dari lebar halaman, cek lebar tetap menutup', () => {
    // SR-42 (D-168, D-158): page.sizeMm kelas T (`pageSizeFromPaper`); ukuran kustom lewat page.customSizeMm.
    expect(resolve({ 'page.sizeMm': [216, 279] } as ParamMap).errors.map((e) => e.code)).toContain('PARAM_CLASS_T_READONLY');
    const { params, errors } = resolve({ 'page.customSizeMm': [216, 279] } as ParamMap);
    expect(params['page.sizeMm']).toEqual([216, 279]);
    expect(params['grid.textColumnMm']).toBe(216 - 24 - 6 - 32 - 20);
    expect(params['grid.fullSpanMm']).toBe(134 + 6 + 32);
    expect(params['grid.pageWidthCheck']).toBe(216);
    expect(errors.filter((e) => e.key === 'grid.pageWidthCheck')).toEqual([]);
  });

  it('turunan tier: NOTA melepas lint/PDF, SERAH mewajibkan rekonsiliasi dan audit', () => {
    const nota = resolve({ 'artifact.tier': 'NOTA' }).params;
    expect(nota['artifact.lint.enabled']).toBe(false);
    expect(nota['artifact.pdf.enabled']).toBe(false);
    const serah = resolve({ 'artifact.tier': 'SERAH' }).params;
    expect(serah['artifact.lint.enabled']).toBe(true);
    expect(serah['artifact.pdf.enabled']).toBe(true);
    expect(serah['artifact.pageReconciliation.enabled']).toBe(true);
    expect(serah['audit.untrackedNumbers.enabled']).toBe(true);
  });

  it('konteks dokumen: bulan Romawi dan moda rel auto diselesaikan dari sitasi', () => {
    expect(resolveParamsWith({ base: {}, overrides: {}, registry: ALL_PARAMS }, { issueDate: '2026-10-23' }).params['doc.monthRoman']).toBe('X');
    const tpl = canonicalTemplate();
    expect(railModeFor(tpl, 3)).toBe('A');
    expect(railModeFor(tpl, 0)).toBe('B');
    expect(computeDerivedWith(tpl.params, { railCitations: 0 })['layout.railMode']).toBe('B');
  });

  it('nomor dokumen bentuk berkas: garis miring menjadi tanda hubung', () => {
    expect(resolve({ 'doc.number': '000/GSP/STD/X/2026' } as ParamMap).params['doc.number.fileForm']).toBe('000-GSP-STD-X-2026');
  });

  it('computeDerived idempoten dan mengembalikan peta beku', () => {
    const once = computeDerived(resolve().params);
    const twice = computeDerived(once);
    expect(twice).toEqual(once);
    expect(Object.isFrozen(once)).toBe(true);
  });

  it('turunan menimpa nilai T palsu di profil base: base tidak dapat memalsukan fullSpan', () => {
    // base tepercaya boleh memuat kelas T, tetapi turunan dihitung ulang dari induk.
    const { params } = resolve({}, { 'grid.fullSpanMm': 999 });
    expect(params['grid.fullSpanMm']).toBe(166);
  });
});

describe('override kelas T ditolak dan tidak diterapkan', () => {
  it('resolveParams: override grid.fullSpanMm -> PARAM_CLASS_T_READONLY, nilai tetap turunan', () => {
    const { params, errors } = resolve({ 'grid.fullSpanMm': 200 });
    expect(errors.map((e) => e.code)).toContain('PARAM_CLASS_T_READONLY');
    expect(params['grid.fullSpanMm']).toBe(166);
  });

  it('checkOverrideRights: kelas T ditolak bahkan untuk ADMIN_SESSION', () => {
    const issues = checkOverrideRights({ 'grid.latticeXMm': 11 }, 'ADMIN_SESSION', ALL_PARAMS);
    expect(issues.map((i) => i.code)).toEqual(['PARAM_CLASS_T_READONLY']);
    expect(issues[0].pointer).toBe('/overrides/grid.latticeXMm');
  });

  it('kelas bersyarat "T (B hanya untuk TERBIT)": artifact.pdf.enabled boleh ditimpa hanya pada tier TERBIT', () => {
    const def = PARAMS_BY_KEY.get('artifact.pdf.enabled')!;
    expect(effectiveClass(def, true, 'TERBIT')).toBe('B');
    expect(effectiveClass(def, true, 'NOTA')).toBe('T');
    expect(checkOverrideRights({ 'artifact.pdf.enabled': true, 'artifact.tier': 'NOTA' }, 'ADMIN_SESSION', ALL_PARAMS).map((i) => i.key)).toEqual([
      'artifact.pdf.enabled',
    ]);
    const terbit = resolve({ 'artifact.pdf.enabled': true, 'artifact.tier': 'TERBIT' });
    expect(terbit.errors).toEqual([]);
    expect(terbit.params['artifact.pdf.enabled']).toBe(true);
    const nota = resolve({ 'artifact.pdf.enabled': true, 'artifact.tier': 'NOTA' });
    expect(nota.errors.map((e) => e.code)).toContain('PARAM_CLASS_T_READONLY');
    expect(nota.params['artifact.pdf.enabled']).toBe(false);
  });
});

describe('hak override kelas K: hanya ADMIN_SESSION (KT-16)', () => {
  const K_OVERRIDE: ParamMap = { 'vat.nominalRatePercent': 10, 'lint.enforcementOverride': { 'DATUM-04': 'release' } };

  it('kelas K dari pemanggil non-admin -> PARAM_CLASS_K_FORBIDDEN per kunci', () => {
    for (const caller of NON_ADMIN) {
      const issues = checkOverrideRights(K_OVERRIDE, caller, ALL_PARAMS);
      expect(issues.map((i) => [i.key, i.code]), caller).toEqual([
        ['lint.enforcementOverride', 'PARAM_CLASS_K_FORBIDDEN'],
        ['vat.nominalRatePercent', 'PARAM_CLASS_K_FORBIDDEN'],
      ]);
    }
  });

  it('kelas K dari ADMIN_SESSION diterima', () => {
    expect(checkOverrideRights(K_OVERRIDE, 'ADMIN_SESSION', ALL_PARAMS)).toEqual([]);
  });

  it('kelas bersyarat "B (>= 0,18: K)": rules.primaryMm di bawah ambang butuh hak K', () => {
    expect(checkOverrideRights({ 'rules.primaryMm': 0.3 }, 'USER_SESSION', ALL_PARAMS)).toEqual([]);
    expect(checkOverrideRights({ 'rules.primaryMm': 0.18 }, 'USER_SESSION', ALL_PARAMS)).toEqual([]);
    expect(checkOverrideRights({ 'rules.primaryMm': 0.1 }, 'USER_SESSION', ALL_PARAMS).map((i) => i.code)).toEqual(['PARAM_CLASS_K_FORBIDDEN']);
    expect(checkOverrideRights({ 'rules.primaryMm': 0.1 }, 'ADMIN_SESSION', ALL_PARAMS)).toEqual([]);
  });

  it('kelas B biasa diterima untuk semua pemanggil', () => {
    for (const caller of [...NON_ADMIN, 'ADMIN_SESSION' as CallerKind]) {
      // SR-42 (D-168): grid.textColumnMm kini kelas T; kunci B murni pengganti = grid.gutterMm.
      expect(checkOverrideRights({ 'grid.gutterMm': 5, 'artifact.tier': 'SERAH' }, caller, ALL_PARAMS), caller).toEqual([]);
    }
  });

  it('kunci tidak dikenal -> PARAM_UNKNOWN_KEY dengan pointer RFC 6901 ter-escape', () => {
    const issues = checkOverrideRights({ 'a/b~c': 1 }, 'ADMIN_SESSION', ALL_PARAMS);
    expect(issues).toEqual([expect.objectContaining({ code: 'PARAM_UNKNOWN_KEY', pointer: '/overrides/a~1b~0c' })]);
  });

  it('kunci prototipe (__proto__, constructor) diperlakukan kunci asing, bukan lolos', () => {
    const o = JSON.parse('{"__proto__": 1, "constructor": 2, "toString": 3}') as ParamMap;
    const codes = checkOverrideRights(o, 'ADMIN_SESSION', ALL_PARAMS).map((i) => [i.key, i.code]);
    expect(codes).toEqual([
      ['__proto__', 'PARAM_UNKNOWN_KEY'],
      ['constructor', 'PARAM_UNKNOWN_KEY'],
      ['toString', 'PARAM_UNKNOWN_KEY'],
    ]);
  });

  it('assertOverrideRights melempar StudioEngineError dengan kode prioritas K > T > kunci asing', () => {
    let err: unknown;
    try {
      assertOverrideRights({ zzz: 1, 'grid.fullSpanMm': 1, 'vat.nominalRatePercent': 10 }, 'USER_SESSION', ALL_PARAMS);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(StudioEngineError);
    expect((err as StudioEngineError).code).toBe('PARAM_CLASS_K_FORBIDDEN');
    // SR-42 (D-168): kunci B pengganti grid.textColumnMm (kini T).
    expect(() => assertOverrideRights({ 'grid.gutterMm': 5 }, 'USER_SESSION', ALL_PARAMS)).not.toThrow();
  });
});

describe('validasi nilai override (mergeLayers)', () => {
  it('tipe salah, di luar rentang, enum asing -> SCHEMA_INVALID, nilai kanonik dipertahankan', () => {
    // SR-42 (D-168): grid.textColumnMm kini kelas T (ditolak sebagai T, bukan
    // divalidasi nilainya); tipe salah diuji pada kunci B grid.outerMarginMm.
    const { params, errors } = resolve({
      'grid.outerMarginMm': 'lebar' as unknown as number,
      'grid.subcolumns': 2.5,
      'artifact.tier': 'RAHASIA',
      'grid.gutterMm': -1,
    });
    const bad = errors.filter((e) => e.code === 'SCHEMA_INVALID').map((e) => e.key).sort();
    expect(bad).toEqual(['artifact.tier', 'grid.gutterMm', 'grid.outerMarginMm', 'grid.subcolumns']);
    expect(params['grid.outerMarginMm']).toBe(20);
    expect(params['grid.textColumnMm']).toBe(128);
    expect(params['grid.subcolumns']).toBe(12);
    expect(params['artifact.tier']).toBe('NOTA');
    expect(params['grid.gutterMm']).toBe(6);
  });

  it('NaN/Infinity ditolak sebagai angka', () => {
    const def = PARAMS_BY_KEY.get('grid.textColumnMm')!;
    expect(validateParamValue(def, Number.NaN)).not.toBeNull();
    expect(validateParamValue(def, Number.POSITIVE_INFINITY)).not.toBeNull();
    expect(validateParamValue(def, 120)).toBeNull();
  });

  it('rasio menerima "11/12" dan angka, menolak teks lain', () => {
    const def = PARAMS_BY_KEY.get('vat.dppFactor')!;
    expect(validateParamValue(def, '11/12')).toBeNull();
    expect(validateParamValue(def, 0.9)).toBeNull();
    expect(validateParamValue(def, '11/12; drop table')).not.toBeNull();
  });

  it('override tidak memutasi peta base', () => {
    const base = Object.freeze({ 'grid.textColumnMm': 128 }) as ParamMap;
    resolve({ 'grid.textColumnMm': 120, 'grid.outerMarginMm': 28 }, base);
    expect(base['grid.textColumnMm']).toBe(128);
  });
});

describe('resolveRoleFormat: roleFormats templat menimpa turunan katalog per medan', () => {
  it('medan eksplisit menang, medan lain dari katalog tetap', () => {
    const tpl = canonicalTemplate();
    const role = ROLE_KEYS.find((r) => {
      const f = resolveRoleFormat(tpl, r);
      return f.run !== undefined && f.para !== undefined;
    });
    expect(role, 'ada peran dengan run + para dari katalog').toBeDefined();
    const catalog = resolveRoleFormat(tpl, role!);
    const custom = { ...tpl, roleFormats: { [role!]: { run: { b: true } } } } as typeof tpl;
    const merged = resolveRoleFormat(custom, role!);
    expect(merged.run).toEqual({ b: true });
    expect(merged.para).toEqual(catalog.para);
  });
});
