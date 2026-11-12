// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/registry/c06-coverage-round-params.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
// C06 (ronde cakupan DATUM Rev A; D-631, D-635): 14 parameter registri baru R-67..R-80 dan dua
// tambahan enum, persis seperti register nama `research/38_coverage_round_names_register.md` §1-§2
// (sumber kebenaran independen: tabel literal di bawah disalin dari register, bukan dari kode).
// Syarat M1 `research/35` §5: C-1 permukaan lanjutan dan di luar kenop esensial, C-2 kelas B tanpa
// derive, C-4 di luar awalan warna/fon/jenis chart, C-5 tidak dibaca compose (R-69 masuk daftar
// compose di C10), C-8 bawaan lolos validasi, C-11 id/namespace; plus absen = bawaan saat resolusi.
// Seam: registri `params`, `PARAM_SURFACE_LISTS`/`ESSENTIAL_KNOBS`, `validateParamValue`,
// `resolveParams`, `COMPOSE_PARAM_KEYS`. Murni, tanpa DB.
import { describe, expect, it } from '../_vitest';
import type { ParamValue } from '@/lib/studio/contract';
import { resolveParams } from '@/lib/studio/engine/tokens';
import { validateParamValue } from '@/lib/studio/engine/tokens/merge';
import { ALL_PARAM_COUNT, ALL_PARAMS, CATALOG_PARAM_COUNT, PARAMS_BY_KEY, PARAMS_RENDER, RENDER_PARAM_COUNT } from '@/lib/studio/params';
import { ESSENTIAL_KNOBS, PARAM_SURFACE_LISTS } from '@/lib/studio/registry/essentials';
import { COMPOSE_PARAM_KEYS } from '@/lib/studio/services/compose/context';

type Row = {
  id: string;
  key: string;
  type: string;
  def: ParamValue;
  enumValues?: string[];
  range?: { min: number; max: number; step: number };
  namespace: string;
  scope: string;
  /** Contoh nilai opt-in sah (nilai spesifikasi C23 bila ada). */
  optIn: ParamValue;
};

/** research/38 §1.2 tabel kunci (ID, kunci, tipe, bawaan, enum/rentang, namespace, cakupan). */
const ROWS: Row[] = [
  { id: 'R-67', key: 'controlSheet.subtitle.enabled', type: 'bool', def: false, namespace: 'controlSheet', scope: 'section:controlSheet', optIn: true },
  { id: 'R-68', key: 'controlSheet.signatures.fillRoles', type: 'bool', def: false, namespace: 'controlSheet', scope: 'section:signatureBlock', optIn: true },
  {
    id: 'R-69',
    key: 'controlSheet.columns.form',
    type: 'enum',
    def: 'mesin',
    enumValues: ['mesin', 'manual'],
    namespace: 'controlSheet',
    scope: 'section:controlSheet',
    optIn: 'manual',
  },
  {
    id: 'R-70',
    key: 'cover.title.maxWidthMm',
    type: 'mm',
    def: null,
    range: { min: 50, max: 166, step: 1 },
    namespace: 'cover',
    scope: 'section:cover',
    optIn: 150,
  },
  { id: 'R-71', key: 'render.docx.pageBackground', type: 'bool', def: false, namespace: 'render', scope: 'document', optIn: true },
  { id: 'R-72', key: 'runningHead.ruleColour', type: 'hex', def: 'C3CBD1', namespace: 'runningHead', scope: 'section:runningHead', optIn: '6E1420' },
  {
    id: 'R-73',
    key: 'device.registerBlock.topRuleColour',
    type: 'hex',
    def: '101418',
    namespace: 'device',
    scope: 'section:registerBlock',
    optIn: '6E1420',
  },
  { id: 'R-74', key: 'render.rhythm.snapToBaseline', type: 'bool', def: false, namespace: 'render', scope: 'document', optIn: true },
  { id: 'R-75', key: 'render.rail.reserveColumn', type: 'bool', def: false, namespace: 'render', scope: 'section:evidenceRail', optIn: true },
  { id: 'R-76', key: 'render.nota.classificationLine', type: 'bool', def: false, namespace: 'render', scope: 'document', optIn: true },
  { id: 'R-77', key: 'render.ruleIndex.fromMarkers', type: 'bool', def: false, namespace: 'render', scope: 'document', optIn: true },
  {
    id: 'R-78',
    key: 'naming.file.form',
    type: 'enum',
    def: 'judulNomorRevisi',
    enumValues: ['judulNomorRevisi', 'judulTanggalIso'],
    namespace: 'naming',
    scope: 'document',
    optIn: 'judulTanggalIso',
  },
  {
    id: 'R-79',
    key: 'cover.controlBlock.preparerUnit',
    type: 'string',
    def: '',
    namespace: 'cover',
    scope: 'section:cover',
    optIn: 'Divisi Engineering PT GSP',
  },
  {
    id: 'R-80',
    key: 'device.registerBlock.sheetNumbering',
    type: 'enum',
    def: 'dokumen',
    enumValues: ['dokumen', 'bab1'],
    namespace: 'device',
    scope: 'section:registerBlock',
    optIn: 'bab1',
  },
];

const def = (key: string) => {
  const d = PARAMS_BY_KEY.get(key);
  if (!d) throw new Error(`kunci registri hilang: ${key}`);
  return d;
};

const knobKeys = new Set(ESSENTIAL_KNOBS.flatMap((k) => k.keys));

describe('C06 R-67..R-80: kontrak registri = register research/38 §1.2', () => {
  it('14 kunci, id berurutan R-67..R-80 di akhir PARAMS_RENDER', () => {
    expect(ROWS.map((r) => r.id)).toEqual(Array.from({ length: 14 }, (_, i) => `R-${67 + i}`));
    // row42 ADAPT A2 (C40, row 122 CP-05/CP-06): Swarm appends R-81..R-83 after R-80 (params/render.ts:417-436).
    expect(PARAMS_RENDER.slice(-17, -3).map((d) => [d.id, d.key])).toEqual(ROWS.map((r) => [r.id, r.key]));
    expect(PARAMS_RENDER.slice(-3).map((d) => d.id)).toEqual(['R-81', 'R-82', 'R-83']);
  });

  for (const row of ROWS) {
    it(`${row.id} ${row.key}: tipe, bawaan, enum/rentang, kelas B, namespace, cakupan, permukaan lanjutan`, () => {
      const d = def(row.key);
      expect(d.id).toBe(row.id);
      expect(d.type).toBe(row.type);
      expect(d.default).toEqual(row.def);
      expect(d.enum ? [...d.enum] : undefined).toEqual(row.enumValues);
      expect(d.range).toEqual(row.range);
      // C-2: kelas B, tanpa turunan, bukan lapis turunan.
      expect(d.class).toBe('B');
      expect(d.derive).toBeUndefined();
      // C-11: grup/asal kontrak, namespace eksplisit = segmen pertama kunci.
      expect([d.group, d.origin, d.namespace]).toEqual(['R', 'contract', row.namespace]);
      expect(d.namespace).toBe(row.key.split('.')[0]);
      expect(d.scope).toBe(row.scope);
      // C-1: lanjutan (id di daftar lanjutan), tidak di kenop esensial mana pun.
      expect(d.surface).toBe('advanced');
      expect(PARAM_SURFACE_LISTS.advanced).toContain(row.id);
      expect(knobKeys.has(row.key)).toBe(false);
      // C-4: di luar awalan yang dipancarkan sebagai variabel CSS / cabang khusus.
      expect(/^(color\.|type\.face|chart\.kind\.)/.test(row.key)).toBe(false);
      expect(typeof d.classNote === 'string' && d.classNote.length > 0).toBe(true);
    });
  }

  it('C-8: bawaan setiap kunci lolos validasi; nilai opt-in sah juga lolos; nilai di luar enum/rentang ditolak', () => {
    for (const row of ROWS) {
      const d = def(row.key);
      expect(validateParamValue(d, d.default), `${row.key} bawaan`).toBeNull();
      expect(validateParamValue(d, row.optIn), `${row.key} opt-in`).toBeNull();
    }
    expect(validateParamValue(def('controlSheet.columns.form'), 'bebas')).not.toBeNull();
    expect(validateParamValue(def('naming.file.form'), 'judul')).not.toBeNull();
    expect(validateParamValue(def('device.registerBlock.sheetNumbering'), 'bab2')).not.toBeNull();
    expect(validateParamValue(def('cover.title.maxWidthMm'), 200)).not.toBeNull();
    expect(validateParamValue(def('cover.title.maxWidthMm'), 40)).not.toBeNull();
    expect(validateParamValue(def('runningHead.ruleColour'), 'merah')).not.toBeNull();
    // null hanya sah untuk kunci berbawaan null (R-70).
    expect(validateParamValue(def('cover.title.maxWidthMm'), null)).toBeNull();
    expect(validateParamValue(def('runningHead.ruleColour'), null)).not.toBeNull();
  });

  it('absen dan bawaan eksplisit teresolusi ke nilai yang sama (seluruh peta parameter sama)', () => {
    const absent = resolveParams({ base: {}, overrides: {}, registry: ALL_PARAMS });
    const explicit = resolveParams({
      base: {},
      overrides: Object.fromEntries(ROWS.map((r) => [r.key, r.def])),
      registry: ALL_PARAMS,
    });
    expect(absent.errors).toEqual([]);
    expect(explicit.errors).toEqual([]);
    for (const row of ROWS) expect(absent.params[row.key], row.key).toEqual(row.def);
    expect(explicit.params).toEqual(absent.params);
  });

  it('C35 L-01: R-79 preparerUnit dibatasi 120 karakter tanpa karakter kontrol; bawaan "" tetap sah', () => {
    const d = def('cover.controlBlock.preparerUnit');
    expect(validateParamValue(d, '')).toBeNull();
    expect(validateParamValue(d, 'Divisi Engineering PT GSP')).toBeNull();
    expect(validateParamValue(d, 'Unit Rekayasa · Divisi Ü — é')).toBeNull();
    expect(validateParamValue(d, 'x'.repeat(120))).toBeNull();
    expect(validateParamValue(d, 'x'.repeat(121))).not.toBeNull();
    for (const c of ['\u0000', '\t', '\n', '\r', '\f', '\u001b', '\u007f']) expect(validateParamValue(d, `Unit${c}A`), JSON.stringify(c)).not.toBeNull();
  });

  it('C-5: hanya R-69 (C10) dan R-79 (C27, blok sampul eksplisit) dibaca compose, ditambahkan oleh pembacanya; kunci lain tidak', () => {
    const compose = new Set<string>(COMPOSE_PARAM_KEYS);
    const read = new Set(['controlSheet.columns.form', 'cover.controlBlock.preparerUnit']);
    for (const row of ROWS) expect(compose.has(row.key), row.key).toBe(read.has(row.key));
  });

  it('hitungan registri: renderer 45 -> 59, total 788 -> 802, katalog 722 -> 721 (C-27 dihapus, 1.2.5)', () => {
    expect(PARAMS_RENDER).toHaveLength(RENDER_PARAM_COUNT);
    // row42 ADAPT A2 (C40, row 122): renderer 59 -> 62, total 802 -> 805 (params/render.ts:439, params/index.ts:35).
    expect(RENDER_PARAM_COUNT).toBe(62);
    // Swarm 1.2.6 row 72 (T-18/W-10): + P7-37/P7-38 figure.quota.*; katalog 721 -> 723, total 804 -> 806 (count pin by delta).
    expect(CATALOG_PARAM_COUNT).toBe(723);
    expect(ALL_PARAMS).toHaveLength(ALL_PARAM_COUNT);
    expect(ALL_PARAM_COUNT).toBe(806);
    expect(new Set(ALL_PARAMS.map((d) => d.key)).size).toBe(806);
    expect(new Set(ALL_PARAMS.map((d) => d.id)).size).toBe(806);
  });
});

describe('C06 tambahan enum (research/38 §2; C-6)', () => {
  it('device.spine.placements: enum + "sampul belakang", bawaan tidak berubah', () => {
    const d = def('device.spine.placements');
    expect(d.enum).toEqual(['margin luar sampul', 'pembatas', 'sampul belakang']);
    expect(d.default).toEqual(['margin luar sampul', 'pembatas']);
    expect(validateParamValue(d, ['margin luar sampul', 'pembatas', 'sampul belakang'])).toBeNull();
    expect(validateParamValue(d, ['sampul belakang'])).toBeNull();
  });

  it('cover.controlBlock.fields: enum + "KLASIFIKASI" lewat konstanta terpisah, bawaan 8 medan tidak berubah', () => {
    const d = def('cover.controlBlock.fields');
    const DEFAULT_8 = ['NOMOR DOKUMEN', 'REVISI', 'PENYUSUN', 'KUSTODIAN', 'DITUJUKAN KEPADA', 'TIER', 'DASAR', 'BAHASA'];
    expect(d.default).toEqual(DEFAULT_8);
    // row42 ADAPT A2 (C40, row 122 CP-05): enum + HALAMAN, DATUM GEODETIK, VERIFIKASI (params/page.ts:383).
    expect(d.enum).toEqual([...DEFAULT_8, 'KLASIFIKASI', 'HALAMAN', 'DATUM GEODETIK', 'VERIFIKASI']);
    // Konstanta dipisah: bawaan dan enum bukan objek yang sama (tambahan enum tidak bocor ke bawaan).
    expect(d.enum).not.toBe(d.default);
    // Daftar spesifikasi C23 (8 medan, research/38 §4.1) sah terhadap enum baru.
    expect(
      validateParamValue(d, ['NOMOR DOKUMEN', 'REVISI', 'KLASIFIKASI', 'PENYUSUN', 'KUSTODIAN', 'DITUJUKAN KEPADA', 'TIER', 'BAHASA']),
    ).toBeNull();
    expect(validateParamValue(d, ['NOMOR DOKUMEN', 'SIFAT'])).not.toBeNull();
  });
});
