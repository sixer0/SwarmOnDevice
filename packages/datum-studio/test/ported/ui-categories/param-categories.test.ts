// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/ui-categories/param-categories.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
// U02 (D-626/D-627/D-630, research/39_param_categories.md): satu tabel kategori parameter
// untuk editor templat dan panel pratinjau. Uji terhadap registri HIDUP (ALL_PARAMS):
// setiap kunci tepat satu kategori, Lainnya kosong, hitungan per kategori = research/39,
// urutan stabil, pengecualian E01-E30 dan tabel R berlaku, namespace R tak dikenal -> Lainnya.
import { describe, expect, it } from '../_vitest';
import { ALL_PARAMS, PARAMS_BY_KEY } from '@/lib/studio/params';
import type { ParamDef } from '@/lib/studio/contract/types/params';
import { namespaceLabel } from '@/components/studio/template-editor/param-labels';
import {
  CATALOG_EXCEPTIONS,
  PARAM_CATEGORIES,
  R_EXACT_OVERRIDES,
  R_NAMESPACE_CATEGORY,
  R_RENDER_SEGMENT_CATEGORY,
  categoryOf,
  groupByCategory,
  subgroupKeyOf,
  subgroupLabel,
  type ParamCategoryId,
} from '@/components/studio/template-editor/param-categories';

/** research/39 "Category list": urutan dan id tampilan. */
const EXPECTED_ORDER: ParamCategoryId[] = [
  'warna',
  'tipografi',
  'halaman-grid',
  'sampul',
  'lembar-kendali',
  'kepala-kaki',
  'tabel',
  'gambar-chart',
  'diagram-simbol',
  'bukti-angka',
  'penomoran-klasifikasi',
  'bahasa',
  'lint-pemeriksaan',
  'renderer-ekspor',
  'lainnya',
];

/**
 * research/39 "Per-category counts by surface": [essential, advanced, other(derived+internal), total].
 * C06 (D-635 (1); research/38 §1.4): + 14 kunci lanjutan R-67..R-80: Lembar kendali 7 -> 10, Sampul 22 -> 24,
 * Header & footer 22 -> 25, Halaman & grid 55 -> 57, Penomoran & klasifikasi 37 -> 40, Ekspor 49 -> 50; Lainnya 0.
 */
const EXPECTED_COUNTS: Record<ParamCategoryId, [number, number, number, number]> = {
  warna: [1, 27, 8, 36],
  tipografi: [1, 69, 34, 104],
  'halaman-grid': [5, 25, 27, 57],
  // row42 ADAPT A2 (C40, row 122): R-83 (cover.*) -> sampul, R-81/R-82 (controlSheet.*) -> lembar-kendali, surface
  // 'advanced' like R-67..R-80 (registry/essentials.ts:102-103). See DEFECT R42-D1 below: today they are unmapped.
  sampul: [3, 16, 6, 25],
  'lembar-kendali': [1, 10, 1, 12],
  'kepala-kaki': [1, 14, 10, 25],
  tabel: [1, 15, 20, 36],
  // Swarm 1.2.6 row 72 (T-18/W-10): P7-37/P7-38 figure.quota.* advanced -> +2 advanced, +2 total (count pin by delta).
  'gambar-chart': [1, 155, 27, 183],
  'diagram-simbol': [1, 29, 71, 101],
  'bukti-angka': [1, 12, 53, 66],
  'penomoran-klasifikasi': [4, 11, 25, 40],
  bahasa: [1, 0, 44, 45],
  'lint-pemeriksaan': [0, 0, 26, 26],
  'renderer-ekspor': [0, 2, 48, 50],
  lainnya: [0, 0, 0, 0],
};

/** research/38 §1.2 kolom "UI category": kategori setiap kunci baru C06 (sumber independen). */
const C06_KEY_CATEGORY: Array<[string, ParamCategoryId]> = [
  ['controlSheet.subtitle.enabled', 'lembar-kendali'],
  ['controlSheet.signatures.fillRoles', 'lembar-kendali'],
  ['controlSheet.columns.form', 'lembar-kendali'],
  ['cover.title.maxWidthMm', 'sampul'],
  ['render.docx.pageBackground', 'renderer-ekspor'],
  ['runningHead.ruleColour', 'kepala-kaki'],
  ['device.registerBlock.topRuleColour', 'kepala-kaki'],
  ['render.rhythm.snapToBaseline', 'halaman-grid'],
  ['render.rail.reserveColumn', 'halaman-grid'],
  ['render.nota.classificationLine', 'penomoran-klasifikasi'],
  ['render.ruleIndex.fromMarkers', 'penomoran-klasifikasi'],
  ['naming.file.form', 'penomoran-klasifikasi'],
  ['cover.controlBlock.preparerUnit', 'sampul'],
  ['device.registerBlock.sheetNumbering', 'kepala-kaki'],
];

const byCategory = () => {
  const m = new Map<ParamCategoryId, typeof ALL_PARAMS[number][]>();
  for (const d of ALL_PARAMS) {
    const c = categoryOf(d);
    m.set(c, [...(m.get(c) ?? []), d]);
  }
  return m;
};

const def = (key: string) => {
  const d = PARAMS_BY_KEY.get(key);
  if (!d) throw new Error(`kunci registri hilang: ${key}`);
  return d;
};

describe('U02 tabel kategori', () => {
  it('15 kategori dalam urutan research/39, label Indonesia dan baris bantuan terisi', () => {
    expect(PARAM_CATEGORIES.map((c) => c.id)).toEqual(EXPECTED_ORDER);
    expect(PARAM_CATEGORIES.map((c) => c.order)).toEqual(EXPECTED_ORDER.map((_, i) => i + 1));
    expect(PARAM_CATEGORIES.find((c) => c.id === 'bukti-angka')?.label).toBe('Bukti, angka & satuan');
    expect(PARAM_CATEGORIES.find((c) => c.id === 'diagram-simbol')?.label).toBe('Diagram & simbol');
    // D-632: istilah umum (header/footer) menggantikan terjemahan paksa "Kepala & kaki halaman".
    expect(PARAM_CATEGORIES.find((c) => c.id === 'kepala-kaki')?.label).toBe('Header & footer');
    for (const c of PARAM_CATEGORIES) {
      expect(c.label.trim().length).toBeGreaterThan(0);
      expect(c.help.trim().length).toBeGreaterThan(0);
    }
  });
});

describe('U02 categoryOf terhadap registri hidup', () => {
  // row42 ADAPT A2 (C40, row 122): R-81..R-83 appended; 802 -> 805 keys.
  it('registri = 802 kunci; setiap kunci tepat satu kategori; Lainnya kosong', () => {
    expect(ALL_PARAMS.length).toBe(806); // 805 before 1.2.5 (P11-27 removed with C-27); 806 in 1.2.6 (row 72 figure.quota.*)
    const m = byCategory();
    const lainnya = (m.get('lainnya') ?? []).map((d) => `${d.id} ${d.key} (${d.group})`);
    expect(lainnya).toEqual([]);
    const sum = [...m.values()].reduce((n, l) => n + l.length, 0);
    expect(sum).toBe(ALL_PARAMS.length);
  });

  // row42 DEFECT R42-D1 (kept failing, skipped as todo): row 122 added R-81..R-83 (params/render.ts:417-436) but not to
  // SURFACE_BY_ID (registry/essentials.ts:102-103 still ids("R-", [67, 80])), so paramSurfaceOf() returns undefined
  // ("unmapped", essentials.ts:178-182; R03 registry reports surface "unmapped", src/mcp-host/local-api/routes/r03-registry.ts:164).
  it('[DEFECT R42-D1] hitungan per kategori dan per permukaan sama dengan research/39 (R-81..R-83 surface unmapped)', () => {
    const m = byCategory();
    const actual = Object.fromEntries(
      EXPECTED_ORDER.map((id) => {
        const l = m.get(id) ?? [];
        const ess = l.filter((d) => d.surface === 'essential').length;
        const adv = l.filter((d) => d.surface === 'advanced').length;
        return [id, [ess, adv, l.length - ess - adv, l.length]];
      }),
    );
    expect(actual).toEqual(EXPECTED_COUNTS);
    const surf = (s: string) => ALL_PARAMS.filter((d) => d.surface === s).length;
    expect([surf('essential'), surf('advanced'), surf('derived'), surf('internal')]).toEqual([21, 385, 72, 328]); // advanced 383 -> 385: row 72 (1.2.6) figure.quota.*
  });

  it('hanya membaca group dan key (chapter/namespace/surface diabaikan)', () => {
    for (const d of ALL_PARAMS) {
      const bare = { group: d.group, key: d.key };
      expect(categoryOf(bare)).toBe(categoryOf(d));
      const lie = { ...d, chapter: 'Bab 99', namespace: 'zzz', surface: 'internal' as const };
      expect(categoryOf(lie)).toBe(categoryOf(d));
    }
  });

  it('pengecualian E01-E30: setiap baris menangkap kunci; baris persis tepat satu; contoh sesuai spesifikasi', () => {
    expect(CATALOG_EXCEPTIONS.length).toBe(30);
    for (const e of CATALOG_EXCEPTIONS) {
      const hits = ALL_PARAMS.filter((d) => d.group === e.group && (e.match.endsWith('.') ? d.key.startsWith(e.match) : d.key === e.match));
      expect(hits.length, `${e.row} ${e.group} ${e.match}`).toBeGreaterThan(0);
      if (!e.match.endsWith('.')) expect(hits.length, `${e.row} persis`).toBe(1);
      expect(hits.length, `${e.row} n`).toBeGreaterThanOrEqual(e.n);
    }
    const byId = (id: string) => ALL_PARAMS.find((d) => d.id === id)!;
    expect(categoryOf(byId('P1-04'))).toBe('bukti-angka'); // E01
    expect(categoryOf(byId('P3-23'))).toBe('bahasa'); // E02
    expect(categoryOf(byId('P3-05'))).toBe('renderer-ekspor'); // E03
    expect(categoryOf(byId('P3-07'))).toBe('lint-pemeriksaan'); // E05
    expect(categoryOf(byId('P4S-01'))).toBe('halaman-grid'); // E07
    expect(categoryOf(byId('P4S-20'))).toBe('sampul'); // E09
    expect(categoryOf(byId('P4S-10'))).toBe('kepala-kaki'); // default P4S
    expect(categoryOf(byId('P4V-14'))).toBe('kepala-kaki'); // E10
    expect(categoryOf(byId('P4A-04'))).toBe('penomoran-klasifikasi'); // E11
    expect(categoryOf(byId('P5-17'))).toBe('tabel'); // E17
    expect(categoryOf(byId('P5-21'))).toBe('gambar-chart'); // E18 menang atas E17 (lebih panjang)
    expect(categoryOf(byId('P5-28'))).toBe('halaman-grid'); // E22
    expect(categoryOf(byId('P5-30'))).toBe('bukti-angka'); // default P5
    expect(categoryOf(byId('P6-09'))).toBe('penomoran-klasifikasi'); // E24
    expect(categoryOf(byId('P6-42'))).toBe('warna'); // E28
    expect(categoryOf(byId('P6-43'))).toBe('lint-pemeriksaan'); // E29
    expect(categoryOf(byId('P11-35'))).toBe('lint-pemeriksaan'); // E30
    expect(categoryOf(byId('P11-24'))).toBe('bahasa'); // D14 threshold tetap Bahasa
  });

  it('tabel R: setiap baris namespace/segmen hidup; 5 override persis tepat satu kunci', () => {
    const rKeys = ALL_PARAMS.filter((d) => d.group === 'R');
    expect(rKeys.length).toBe(83); // row42 ADAPT A2 (C40, row 122): R-81..R-83
    for (const ns of Object.keys(R_NAMESPACE_CATEGORY)) {
      expect(rKeys.some((d) => d.key.split('.')[0] === ns), `R ns ${ns}`).toBe(true);
    }
    for (const seg of Object.keys(R_RENDER_SEGMENT_CATEGORY)) {
      expect(rKeys.some((d) => d.key.startsWith(`render.${seg}.`)), `render.${seg}`).toBe(true);
    }
    expect(Object.keys(R_EXACT_OVERRIDES).sort()).toEqual(
      ['render.docx.headerFooterStyles', 'render.section.numberSeparator', 'render.section.registerBlockLayout', 'slot.placement', 'slot.setup'].sort(),
    );
    for (const k of Object.keys(R_EXACT_OVERRIDES)) expect(rKeys.filter((d) => d.key === k).length, k).toBe(1);
    expect(categoryOf(def('slot.setup'))).toBe('halaman-grid');
    expect(categoryOf(def('slot.placement'))).toBe('lembar-kendali');
    expect(categoryOf(def('render.docx.headerFooterStyles'))).toBe('kepala-kaki');
    expect(categoryOf(def('render.section.registerBlockLayout'))).toBe('kepala-kaki');
    expect(categoryOf(def('render.section.numberSeparator'))).toBe('penomoran-klasifikasi');
    expect(categoryOf(def('org.shortName'))).toBe('kepala-kaki'); // D8
    expect(categoryOf(def('toc.levels'))).toBe('penomoran-klasifikasi'); // D18
  });

  it('C06 (D-635 (1)): 7 baris R baru (namespace controlSheet/cover/device/naming, segmen render rhythm/nota/ruleIndex); 14 kunci baru = kategori register', () => {
    expect(R_NAMESPACE_CATEGORY.controlSheet).toBe('lembar-kendali');
    expect(R_NAMESPACE_CATEGORY.cover).toBe('sampul');
    expect(R_NAMESPACE_CATEGORY.device).toBe('kepala-kaki');
    expect(R_NAMESPACE_CATEGORY.naming).toBe('penomoran-klasifikasi');
    expect(R_RENDER_SEGMENT_CATEGORY.rhythm).toBe('halaman-grid');
    expect(R_RENDER_SEGMENT_CATEGORY.nota).toBe('penomoran-klasifikasi');
    expect(R_RENDER_SEGMENT_CATEGORY.ruleIndex).toBe('penomoran-klasifikasi');
    for (const [key, cat] of C06_KEY_CATEGORY) {
      expect(categoryOf(def(key)), key).toBe(cat);
      expect(def(key).surface, key).toBe('advanced');
    }
    // Kunci katalog bernamespace sama tidak terpengaruh baris R (grup katalog membaca default/pengecualian grupnya).
    expect(categoryOf(def('device.spine.placements'))).toBe('sampul'); // E09
    expect(categoryOf(def('cover.controlBlock.fields'))).toBe('sampul'); // default P4V
    expect(categoryOf(def('controlSheet.signatures.roles'))).toBe('lembar-kendali'); // default P4K
  });

  it('namespace R atau segmen render tak dikenal, dan grup tanpa default, jatuh ke Lainnya (uji gagal sampai diputuskan)', () => {
    expect(categoryOf({ group: 'R', key: 'zzzNew.thing' })).toBe('lainnya');
    expect(categoryOf({ group: 'R', key: 'render.zzzNew.thing' })).toBe('lainnya');
    expect(categoryOf({ group: 'P12', key: 'color.anything' })).toBe('lainnya');
    // Kunci katalog baru mewarisi default grupnya.
    expect(categoryOf({ group: 'P4C', key: 'color.zzzNew' })).toBe('warna');
  });
});

describe('U02 groupByCategory', () => {
  it('urutan kategori tetap, tanpa kategori kosong, tidak bergantung urutan masukan', () => {
    const g = groupByCategory(ALL_PARAMS);
    expect(g.map((c) => c.category.id)).toEqual(EXPECTED_ORDER.filter((id) => id !== 'lainnya'));
    const rev = groupByCategory([...ALL_PARAMS].reverse());
    expect(rev.map((c) => c.category.id)).toEqual(g.map((c) => c.category.id));
    expect(rev.map((c) => c.subgroups.map((s) => s.key))).toEqual(g.map((c) => c.subgroups.map((s) => s.key)));
    expect(g.reduce((n, c) => n + c.total, 0)).toBe(806); // 805 -> 804 in 1.2.5 (C-27 removed); 806 in 1.2.6 (row 72); row42 ADAPT A2 (C40, row 122)
  });

  it('permukaan lanjutan menyembunyikan kategori kosong (Bahasa, Lint)', () => {
    const adv = groupByCategory(ALL_PARAMS.filter((d) => d.surface === 'advanced'));
    const ids = adv.map((c) => c.category.id);
    expect(ids).not.toContain('bahasa');
    expect(ids).not.toContain('lint-pemeriksaan');
    expect(ids).not.toContain('lainnya');
    expect(adv.reduce((n, c) => n + c.total, 0)).toBe(385); // row122c (C96 R42-D1): + R-81..R-83 advanced; + 2 row 72 (1.2.6) figure.quota.*
    expect(groupByCategory([])).toEqual([]);
  });

  it('id open-state cat:<id> dan ns:<kategori>:<subkelompok>; parameter berurutan registri di dalam subkelompok', () => {
    const g = groupByCategory(ALL_PARAMS);
    const order = new Map(ALL_PARAMS.map((d, i) => [d.key, i]));
    for (const c of g) {
      expect(c.id).toBe(`cat:${c.category.id}`);
      expect(c.total).toBe(c.subgroups.reduce((n, s) => n + s.defs.length, 0));
      for (const s of c.subgroups) {
        expect(s.id).toBe(`ns:${c.category.id}:${s.key}`);
        const idx = s.defs.map((d) => order.get(d.key)!);
        expect(idx).toEqual([...idx].sort((a, b) => a - b));
        for (const d of s.defs) expect(subgroupKeyOf(d)).toBe(s.key);
      }
    }
  });

  it('S1: chart.kind dan type.scale dipisah dari chart/type; subkelompok lain = namespace', () => {
    expect(subgroupKeyOf({ key: 'chart.kind.P-01.sort' })).toBe('chart.kind');
    expect(subgroupKeyOf({ key: 'chart.engine' })).toBe('chart');
    expect(subgroupKeyOf({ key: 'type.scale.body.size' })).toBe('type.scale');
    expect(subgroupKeyOf({ key: 'type.bodyFamily' })).toBe('type');
    expect(subgroupKeyOf({ key: 'grid.textColumnMm' })).toBe('grid');
    const g = groupByCategory(ALL_PARAMS);
    const sub = (cat: ParamCategoryId) => Object.fromEntries(g.find((c) => c.category.id === cat)!.subgroups.map((s) => [s.key, s.defs.length]));
    expect(sub('gambar-chart')).toEqual({ chart: 41, 'chart.kind': 136, caption: 1, image: 3, figure: 2 }); // figure: row 72 (1.2.6)
    expect(sub('tipografi')).toEqual({ type: 21, 'type.scale': 78, render: 5 });
    // Untuk semua kunci selain S1, subkelompok = namespace registri.
    for (const d of ALL_PARAMS as readonly ParamDef[]) {
      if (!/^(chart\.kind|type\.scale)\./.test(d.key)) expect(subgroupKeyOf(d)).toBe(d.namespace);
    }
  });

  it('label subkelompok bergantung kategori, jatuh ke namespaceLabel', () => {
    expect(subgroupLabel('halaman-grid', 'rules')).toBe('Tebal dan warna garis');
    expect(subgroupLabel('lint-pemeriksaan', 'rules')).toBe('Daftar aturan');
    expect(subgroupLabel('gambar-chart', 'chart.kind')).toBe('Pengaturan per jenis chart');
    expect(subgroupLabel('gambar-chart', 'chart')).toBe('Aturan umum chart');
    expect(subgroupLabel('tipografi', 'type.scale')).toBe('Gaya teks per elemen');
    expect(subgroupLabel('tipografi', 'type')).toBe('Font dan ketebalan');
    expect(subgroupLabel('warna', 'grid')).toBe(namespaceLabel('grid'));
    expect(subgroupLabel('warna', 'zzz')).toBe('zzz');
    // Temuan 8d: bukan perbandingan diri sendiri; tidak ada subkelompok hidup yang jatuh ke kunci mentah.
    const g = groupByCategory(ALL_PARAMS);
    for (const c of g) for (const s of c.subgroups) expect(s.label, `${c.category.id}/${s.key}`).not.toBe(s.key);
  });

  it('hitungan subkelompok mode preset = tabel "Sub-group labels" research/39 (dengan S1)', () => {
    const g = groupByCategory(ALL_PARAMS);
    const sub = (cat: ParamCategoryId) => Object.fromEntries(g.find((c) => c.category.id === cat)!.subgroups.map((s) => [s.key, s.defs.length]));
    expect(sub('warna')).toEqual({ color: 34, page: 2 });
    // C06: render +2 (rhythm, rail), cover +2, controlSheet +3, runningHead +1, device +2 (research/38 §1.4).
    expect(sub('halaman-grid')).toEqual({ page: 4, grid: 17, layout: 1, device: 9, chapter: 1, rules: 15, aside: 2, slot: 1, render: 7 });
    // row42 ADAPT A2 (C40, row 122): cover +1 (R-83), controlSheet +2 (R-81, R-82).
    expect(sub('sampul')).toEqual({ cover: 16, device: 6, org: 2, render: 1 });
    expect(sub('lembar-kendali')).toEqual({ controlSheet: 11, slot: 1 });
    expect(sub('kepala-kaki')).toEqual({ runningHead: 5, wrapper: 1, device: 14, registerBlock: 1, org: 1, render: 3 });
    expect(sub('tabel')).toEqual({ table: 19, caption: 5, source: 4, artifact: 1, specTable: 2, render: 5 });
    expect(sub('diagram-simbol')).toEqual({
      diagram: 56, symbol: 13, symbolSheet: 2, sheet: 5, designation: 2, iec: 2, isa: 2, mil: 4, iso5807: 2, bpmn: 1, c4: 1,
      archimate: 1, topology: 2, lineWeight: 2, lineType: 1, rack: 2, labels: 1, iso7010: 1, fire: 1,
    });
    expect(sub('bukti-angka')).toEqual({
      marks: 13, content: 1, admiralty: 5, icd203: 2, confidence: 1, numbers: 1, register: 2, derivation: 6, render: 2, audit: 2,
      serah: 2, assumptionRegister: 1, assumption: 2, requirement: 2, sourceRegister: 1, numerals: 2, units: 5, uncertainty: 1,
      conventions: 1, time: 1, currency: 1, vat: 4, ahs: 4, hps: 1, boq: 1, terbilang: 1, stampDuty: 1,
    });
    // C06: naming +1, render +2 (nota, ruleIndex); Ekspor render +1 (docx.pageBackground).
    expect(sub('penomoran-klasifikasi')).toEqual({ doc: 9, artifact: 4, classification: 8, naming: 9, numbering: 1, chapter: 1, appendix: 1, toc: 1, render: 6 });
    expect(sub('bahasa')).toEqual({ doc: 11, prose: 4, sentence: 1, paragraph: 1, list: 1, letter: 12, lexicon: 3, glossary: 1, normativeQuote: 1, threshold: 10 });
    expect(sub('lint-pemeriksaan')).toEqual({ gate: 8, lint: 1, artifact: 2, jury: 6, checklist: 1, photocopy: 1, compliance: 3, rules: 1, governance: 3 });
    expect(sub('renderer-ekspor')).toEqual({ render: 15, artifact: 2, ingest: 1, slot: 1, workbook: 18, brief: 13 });
  });

  it('urutan subkelompok mengikuti tabel research/39 (contoh Halaman & grid dan Kepala & kaki)', () => {
    const g = groupByCategory(ALL_PARAMS);
    const keys = (cat: ParamCategoryId) => g.find((c) => c.category.id === cat)!.subgroups.map((s) => s.key);
    expect(keys('halaman-grid')).toEqual(['page', 'grid', 'layout', 'device', 'chapter', 'rules', 'aside', 'slot', 'render']);
    expect(keys('kepala-kaki')).toEqual(['runningHead', 'wrapper', 'device', 'registerBlock', 'org', 'render']);
    expect(keys('gambar-chart')).toEqual(['chart', 'chart.kind', 'caption', 'image', 'figure']); // figure: row 72 (1.2.6)
  });
});
