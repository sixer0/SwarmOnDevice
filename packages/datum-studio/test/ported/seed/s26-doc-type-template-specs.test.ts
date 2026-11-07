// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/seed/s26-doc-type-template-specs.test.ts (see test/ported/README.md).
import { seedModule, useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
/**
 * S26 (blueprint 02_structured_datum_rev_a.md; register research/31 §1-§3; D-594, D-595, D-598 F-3/F-6):
 * tabel spec 10 templat jenis dokumen DATUM Rev A (ID + EN) di `prisma/seed-doc-type-templates.ts`.
 *
 * Seam: ekspor modul tabel spec (data murni, tanpa DB) yang diiterasi `--doc-type-templates` (S27).
 * Nilai harapan = register S01 (`research/31` §1, §3.1, §3.3, §3.5, §6), ditulis literal di sini sebagai
 * sumber independen, bukan dihitung ulang dari modul.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from '../_vitest';
import { validateParamValue } from '@/lib/studio/engine/tokens';
import { PARAMS_BY_KEY } from '@/lib/studio/params';
import { contractRecordSkeletonIssues } from '@/lib/studio/registry/slots';
import { validateSkeleton } from '@/lib/studio/services/skeleton';
import { checkTemplateWrite } from '@/lib/studio/services/skeleton/access';
import { canonicalVersionPayload, loadResolvedProfileFile, type ParamRecord } from '@/lib/studio/services/templates';
import type { ParamValue } from '@/lib/studio/contract';
const { ADMIN_CALLER, DATUM_SKELETON_SLOTS, derivedTemplatePlan } = (await import(seedModule('seed-studio-templates'))) as any; // row42 W14
const { DERIVED_PRESET_SPECS } = (await import(seedModule('seed-derived-presets'))) as any; // row42 W14
const { DOC_TYPE_LAYERS, DOC_TYPE_PRESET_SLUG, DOC_TYPE_TEMPLATE_SPECS, ENGINE_E_LAYOUT_OPT_INS, LANGUAGE_LAYERS, docTypeTemplateSpecJson } = (await import(seedModule('seed-doc-type-templates'))) as any; // row42 W14

/** research/31 §1: slug, nama, bahasa, kode, tier bawaan, kicker. */
const REGISTER = [
  ['datum-proposal-teknis', 'Proposal Teknis (DATUM Rev A)', 'ID', 'PT', 'SERAH', 'PROPOSAL TEKNIS'],
  ['datum-proposal-teknis-en', 'Technical Proposal (DATUM Rev A, EN)', 'EN', 'PT', 'SERAH', 'TECHNICAL PROPOSAL'],
  ['datum-laporan', 'Laporan (DATUM Rev A)', 'ID', 'LAP', 'TERBIT', 'LAPORAN'],
  ['datum-laporan-en', 'Report (DATUM Rev A, EN)', 'EN', 'LAP', 'TERBIT', 'REPORT'],
  ['datum-laporan-verifikasi', 'Laporan Verifikasi dan Uji (DATUM Rev A)', 'ID', 'VER', 'TERBIT', 'LAPORAN VERIFIKASI'],
  ['datum-laporan-verifikasi-en', 'Verification and Test Report (DATUM Rev A, EN)', 'EN', 'VER', 'TERBIT', 'VERIFICATION REPORT'],
  ['datum-standar', 'Standar (DATUM Rev A)', 'ID', 'STD', 'TERBIT', 'STANDAR'],
  ['datum-standar-en', 'Standard (DATUM Rev A, EN)', 'EN', 'STD', 'TERBIT', 'STANDARD'],
  ['datum-nota', 'Nota Internal (DATUM Rev A)', 'ID', 'NOT', 'NOTA', 'NOTA INTERNAL'],
  ['datum-nota-en', 'Internal Note (DATUM Rev A, EN)', 'EN', 'NOT', 'NOTA', 'INTERNAL NOTE'],
] as const;

/** research/31 §3.1: daftar tertutup Rev A (Tabel 3.1 kolom kiri lalu kanan), tanpa DS, dengan NDA. */
const REV_A_TYPE_CODES = ['PT', 'KT', 'RAB', 'SPH', 'SP', 'BA', 'NDA', 'DEK', 'LAP', 'MAT', 'STD', 'NOT', 'MOD', 'VER'];

/** C23: basis 10 templat = preset Rev A (research/38 §4.4 GF-08, M2; preset dibuat C21). */
const REV_A_PRESET = 'datum-gsp-rev-a-preset';

/**
 * C23 lapis bersama (research/38 §4.1; D-635 (3) blok kendali 8 medan tanpa DASAR), ditulis literal dari register.
 * Termasuk lapis bersama lama S26/D-602/D-606.
 */
const SHARED_EXPECTED = {
  'doc.typeCode': REV_A_TYPE_CODES,
  'org.entityName': 'PT GEMILANG SATRIA PERKASA',
  'layout.railMode': 'A',
  'table.zebra.minRows': 1000,
  'runningHead.ruleColour': '6E1420',
  'device.registerBlock.topRuleColour': '6E1420',
  'render.docx.pageBackground': true,
  'render.rhythm.snapToBaseline': true,
  'render.rail.reserveColumn': true,
  'controlSheet.subtitle.enabled': true,
  'controlSheet.signatures.fillRoles': true,
  'controlSheet.columns.form': 'manual',
  'cover.title.maxWidthMm': 150,
  'cover.controlBlock.fields': ['NOMOR DOKUMEN', 'REVISI', 'KLASIFIKASI', 'PENYUSUN', 'KUSTODIAN', 'DITUJUKAN KEPADA', 'TIER', 'BAHASA'],
  'device.spine.placements': ['margin luar sampul', 'pembatas', 'sampul belakang'],
} as const;

/** research/38 §4.2: lapis jenis (NOT dan STD saja; PT, LAP, VER tanpa nilai). */
const TYPE_EXPECTED: Record<string, Record<string, unknown>> = {
  PT: {},
  LAP: {},
  VER: {},
  STD: { 'render.ruleIndex.fromMarkers': true },
  NOT: { 'render.nota.classificationLine': true, 'naming.file.form': 'judulTanggalIso' },
};

/** research/38 §4.3 + D-627 Q2/Q4, D-639 (1): lapis bahasa; penomoran lembar Bab 1 hanya ID. */
const LANG_EXPECTED: Record<'ID' | 'EN', Record<string, unknown>> = {
  ID: { 'cover.controlBlock.preparerUnit': 'Divisi Engineering PT GSP' },
  EN: { 'cover.controlBlock.preparerUnit': 'Engineering Division, PT GSP' },
};

/** Kunci yang disaklar SATU konstanta controller (laporan mesin E C19/C20). */
const ENGINE_E_KEYS = ['render.rhythm.snapToBaseline', 'render.rail.reserveColumn'];

/**
 * Kunci lapis bersama yang SENGAJA sama dengan nilai preset GSP DATUM (D-606 (b), G-FIX1): tuntutan manual jadi data
 * templat sendiri, tidak bergantung versi preset. Selain dua ini, tidak ada nilai lapis yang menyalin preset/bawaan.
 */
const D606_KEPT_EQUAL_TO_PRESET = ['layout.railMode', 'table.zebra.minRows'];

/** research/31 §3.3 + `seed-studio.ts` kerangka datum-gsp: label slot per bahasa. */
const LABELS = {
  ID: { cover: 'Sampul', controlSheet: 'Lembar Kendali', signature: 'Tanda Tangan', toc: 'Daftar Isi', content: 'Isi', references: 'Referensi', ruleIndex: 'Indeks Aturan', appendices: 'Lampiran' },
  EN: { cover: 'Cover', controlSheet: 'Control Sheet', signature: 'Signatures', toc: 'Contents', content: 'Content', references: 'References', ruleIndex: 'Rule Index', appendices: 'Appendices' },
} as const;

/** research/31 §6: daftar inti AC-6 (kritis CR-4). */
const AC6_CORE = ['Lembar Kendali', 'KLASIFIKASI', 'SALINAN INDUK', 'TERBITAN', 'Tanggal', 'Uraian', 'Oleh', 'Pemegang', 'LEMBAR', 'Penyusun', 'Rp'];

const DATUM_SECTION_TYPES = ['cover', 'controlSheet', 'signatureBlock', 'toc', 'chapter', 'sourceRegister', 'appendix'];
const STD_SECTION_TYPES = ['cover', 'controlSheet', 'signatureBlock', 'toc', 'chapter', 'sourceRegister', 'ruleIndex', 'appendix'];

const EFFECTIVE = canonicalVersionPayload().resolvedParams as ParamRecord;

/** Semua string di dalam nilai (rekursif). */
function stringsOf(v: unknown): string[] {
  if (typeof v === 'string') return [v];
  if (Array.isArray(v)) return v.flatMap(stringsOf);
  if (v !== null && typeof v === 'object') return Object.values(v).flatMap(stringsOf);
  return [];
}

/**
 * Nilai lapis yang dapat tercetak: nilai parameter ber-enum (mis. pengenal medan `KLASIFIKASI` di
 * `cover.controlBlock.fields`) adalah kosakata mesin, bukan teks; labelnya dicetak per bahasa dari tabel teks
 * (`CONTROL_FIELD_LABELS`, `engine/front/texts.ts`). Bawaan registri yang sama sudah berlaku di templat EN.
 */
function printedLayer(layer: ParamRecord): ParamRecord {
  return Object.fromEntries(Object.entries(layer).filter(([k]) => !PARAMS_BY_KEY.get(k)?.enum));
}

const withoutLabelPosition = (o: object) => Object.fromEntries(Object.entries(o).filter(([k]) => k !== 'label' && k !== 'position'));

const wordHit = (text: string, token: string) => new RegExp(`(?<![\\p{L}\\p{N}])${token.replace(/ /g, '[ \\u00A0]')}(?![\\p{L}\\p{N}])`, 'u').test(text);

describe('S26 tabel spec templat jenis dokumen DATUM Rev A', () => {
  it('10 slug unik, urutan dan nilai = register research/31 §1', () => {
    const slugs = DOC_TYPE_TEMPLATE_SPECS.map((s) => s.slug);
    expect(new Set(slugs).size).toBe(10);
    expect(slugs).toEqual(REGISTER.map((r) => r[0]));
    for (const [slug, name, lang, code, tier, kicker] of REGISTER) {
      const s = DOC_TYPE_TEMPLATE_SPECS.find((x) => x.slug === slug)!;
      expect(s.name, slug).toBe(name);
      // C23 (GF-08, M2): basis = preset Rev A (bukan datum-gsp-preset).
      expect(s.presetSlug, slug).toBe(REV_A_PRESET);
      expect(s.contractKind, slug).toBeNull();
      // D-602: entitas kolofon kapital (ID:20, CV-16) = parameter templat `org.entityName`, lapis bersama.
      // G-FIX1 (D-606): rel bukti 32 mm selalu tampil (GF-24, EN:2764, ID:2711 "Rel yang kosong itu benar") dan
      // zebra tidak pernah menyala (GF-17, DT-11b ID:2749-2754 "tanpa zebra"): parameter templat yang sudah ada.
      // C23: nilai opt-in register research/38 §4.1-§4.3 (bersama + jenis + bahasa).
      expect(s.layer, slug).toEqual({
        ...SHARED_EXPECTED,
        ...TYPE_EXPECTED[code],
        ...LANG_EXPECTED[lang],
        'doc.defaultTypeCode': code,
        'doc.defaultTier': tier,
        'doc.language': lang,
      });
      // D-602 adendum 2 (kalibrasi S25 TR-03/TR-08): daftar isi = medan TOC Word, kenop slot toc bersama.
      expect(s.slotOverrides, slug).toEqual({ toc: { 'render.toc.mode': 'field' }, cover: { 'cover.kicker.text': kicker } });
    }
  });

  it('disusun dari 5 lapis jenis x 2 lapis bahasa (bukan 10 salinan tertulis)', () => {
    expect(DOC_TYPE_LAYERS).toHaveLength(5);
    expect(LANGUAGE_LAYERS.map((l) => l.language)).toEqual(['ID', 'EN']);
    expect(DOC_TYPE_TEMPLATE_SPECS).toHaveLength(DOC_TYPE_LAYERS.length * LANGUAGE_LAYERS.length);
    for (const l of LANGUAGE_LAYERS) expect(DOC_TYPE_TEMPLATE_SPECS.filter((s) => s.layer['doc.language'] === l.language)).toHaveLength(5);
  });

  it('pita segel, cap terbit, judul daftar isi, dan kicker bab tidak ditimpa templat (research/31 §3.4, F-6)', () => {
    for (const s of DOC_TYPE_TEMPLATE_SPECS) {
      const keys = [...Object.keys(s.layer), ...Object.values(s.slotOverrides ?? {}).flatMap((o) => Object.keys(o))];
      for (const k of ['wrapper.header', 'device.issueStamp.format', 'render.toc.title', 'chapter.kicker.pattern', 'device.registerBlock.cells']) expect(keys, s.slug).not.toContain(k);
    }
  });

  it('jenis slot = kerangka datum-gsp; STD + ruleIndex AUTO opsional sebelum lampiran; posisi 1..n', () => {
    for (const s of DOC_TYPE_TEMPLATE_SPECS) {
      const isStd = s.layer['doc.defaultTypeCode'] === 'STD';
      expect(s.slots.map((x) => x.sectionType), s.slug).toEqual(isStd ? STD_SECTION_TYPES : DATUM_SECTION_TYPES);
      expect(s.slots.map((x) => x.position), s.slug).toEqual(s.slots.map((_, i) => i + 1));
      // Selain label dan posisi, slot kerangka = slot datum-gsp apa adanya.
      for (const base of DATUM_SKELETON_SLOTS) {
        const slot = s.slots.find((x) => x.slotKey === base.slotKey)!;
        expect(withoutLabelPosition(slot), `${s.slug}/${base.slotKey}`).toEqual(withoutLabelPosition(base));
      }
      if (isStd) {
        const ri = s.slots.find((x) => x.slotKey === 'ruleIndex')!;
        expect(ri).toMatchObject({ sectionType: 'ruleIndex', required: false, positionLocked: false, repeatable: false, contentMode: 'AUTO', tiers: [], admits: [] });
      } else expect(s.slots.some((x) => x.slotKey === 'ruleIndex'), s.slug).toBe(false);
    }
  });

  it('label slot per bahasa = register §3.3', () => {
    for (const s of DOC_TYPE_TEMPLATE_SPECS) {
      const lang = s.layer['doc.language'] as 'ID' | 'EN';
      for (const slot of s.slots) expect(slot.label, `${s.slug}/${slot.slotKey}`).toBe(LABELS[lang][slot.slotKey as keyof (typeof LABELS)['ID']]);
    }
  });

  it('lapis EN bebas string inti AC-6 (nama, deskripsi, label, kicker, nilai lapis)', () => {
    const en = DOC_TYPE_TEMPLATE_SPECS.filter((s) => s.layer['doc.language'] === 'EN');
    expect(en).toHaveLength(5);
    for (const s of en) {
      const texts = stringsOf({ name: s.name, description: s.description, labels: s.slots.map((x) => x.label), layer: printedLayer(s.layer), over: s.slotOverrides, note: s.changeNote({ presetVersionNo: 2, slotCount: s.slots.length }) });
      for (const t of texts) for (const token of AC6_CORE) expect(wordHit(t, token), `${s.slug}: "${t}" memuat ${token}`).toBe(false);
    }
    // Kontrol detektor: label ID memang tertangkap.
    expect(wordHit('Lembar Kendali', 'Lembar Kendali')).toBe(true);
  });

  it('nilai lapis dan override sah menurut registri (NDA diterima, S11); tidak ada kunci baru', () => {
    for (const s of DOC_TYPE_TEMPLATE_SPECS) {
      for (const [k, v] of [...Object.entries(s.layer), ...Object.values(s.slotOverrides ?? {}).flatMap((o) => Object.entries(o))]) {
        const def = PARAMS_BY_KEY.get(k);
        expect(def, `${s.slug}: ${k}`).toBeDefined();
        expect(validateParamValue(def!, v as ParamValue), `${s.slug}: ${k}`).toBeNull();
      }
    }
  });

  it('rencana seed murni lolos validasi kerangka dan CH-06; kicker masuk kenop slot cover', () => {
    for (const s of DOC_TYPE_TEMPLATE_SPECS) {
      const plan = derivedTemplatePlan(s, EFFECTIVE);
      expect(() => validateSkeleton({ slots: plan.slots }), s.slug).not.toThrow();
      expect(contractRecordSkeletonIssues(plan.slots, s.contractKind), s.slug).toEqual([]);
      expect(plan.slots.find((x) => x.slotKey === 'cover')!.essentials['cover.kicker.text'], s.slug).toBe(s.slotOverrides!.cover['cover.kicker.text']);
      expect(plan.slots.find((x) => x.slotKey === 'toc')!.essentials['render.toc.mode'], s.slug).toBe('field');
      for (const [k, v] of Object.entries(s.layer)) expect(plan.overrides[k], `${s.slug}: ${k}`).toEqual(v);
    }
  });

  it('G-FIX1 (D-606): rel A dan ambang zebra = parameter yang sudah ada; seed ADMIN boleh menulisnya, USER tidak (zebra kelas K)', () => {
    const target = { isPreset: false, restricted: false, slug: 'datum-laporan' };
    const change = (key: string) => ({ key, value: DOC_TYPE_TEMPLATE_SPECS[0].layer[key] as ParamValue, previous: undefined });
    for (const key of ['layout.railMode', 'table.zebra.minRows']) {
      expect(PARAMS_BY_KEY.get(key), key).toBeDefined();
      expect(() => checkTemplateWrite(ADMIN_CALLER, target, [change(key)]), key).not.toThrow();
    }
    expect(PARAMS_BY_KEY.get('table.zebra.minRows')!.class).toBe('K');
    expect(() => checkTemplateWrite({ kind: 'USER_SESSION' }, target, [change('table.zebra.minRows')])).toThrow(/kelas K|ADMINISTRATOR/);
    // Bawaan registri tidak berubah (templat lama tetap auto dan zebra di atas 12 baris).
    expect(PARAMS_BY_KEY.get('layout.railMode')!.default).toBe('auto');
    expect(PARAMS_BY_KEY.get('table.zebra.minRows')!.default).toBe(12);
  });

  it('ekspor JSON --spec NU-03 (bentuk benchmark/datum_conformance/rules/language.ts): 10 baris = register', () => {
    const j = docTypeTemplateSpecJson();
    expect(j.schema).toBe('datum-template-spec/v1');
    expect(j.templates.map((t) => t.slug)).toEqual(REGISTER.map((r) => r[0]));
    for (const [slug, , lang, code, tier, kicker] of REGISTER) {
      expect(j.templates.find((t) => t.slug === slug)!.params).toEqual({
        'doc.typeCode': REV_A_TYPE_CODES,
        'doc.defaultTypeCode': code,
        'doc.defaultTier': tier,
        'doc.language': lang,
        'cover.kicker.text': kicker,
      });
    }
    // JSON murni (dapat ditulis ke berkas --spec apa adanya).
    expect(JSON.parse(JSON.stringify(j))).toEqual(j);
  });
});

/**
 * C23 (ronde cakupan, blueprint 03_structured_datum_coverage_round.md; register research/38 §4; D-627, D-635, D-639,
 * D-640): nilai opt-in di lapis bersama, jenis, dan bahasa; basis preset Rev A. Data saja, tanpa cabang slug/jenis.
 */
describe('C23 nilai opt-in ronde cakupan (research/38 §4)', () => {
  const REPO = path.resolve(__dirname, '..', '..', '..', 'vendor');
  /** Nilai efektif preset Rev A tanpa lapis templat: profil GSP DATUM (seperti datum-gsp-preset) + sematan C21. */
  let REV_A_EFFECTIVE: ParamRecord;

  beforeAll(async () => {
    const r = await loadResolvedProfileFile(path.join(REPO, 'benchmark', 'manual000', 'template.json'), { repoRoot: REPO, withCanonicalAssets: true });
    const gsp = Object.fromEntries(Object.entries(r.template.params).filter(([k]) => !k.startsWith('lint.enforcement'))) as ParamRecord;
    const revA = DERIVED_PRESET_SPECS.find((p) => p.slug === REV_A_PRESET)!;
    REV_A_EFFECTIVE = { ...gsp, ...revA.pins };
  });

  it('basis preset = baris tabel preset turunan C21 (Rev A di atas datum-gsp-preset), dipilih sebagai data', () => {
    expect(DOC_TYPE_PRESET_SLUG).toBe(REV_A_PRESET);
    const revA = DERIVED_PRESET_SPECS.find((p) => p.slug === REV_A_PRESET);
    expect(revA?.baseSlug).toBe('datum-gsp-preset');
    for (const s of DOC_TYPE_TEMPLATE_SPECS) expect(s.presetSlug, s.slug).toBe(DOC_TYPE_PRESET_SLUG);
  });

  it('lingkup: NOTA (NOT) saja baris klasifikasi + nama berkas ISO; STD saja indeks aturan; Bab 1 tidak diaktifkan (D-650)', () => {
    const owners = (key: string) => DOC_TYPE_TEMPLATE_SPECS.filter((s) => key in s.layer).map((s) => s.slug);
    expect(owners('render.nota.classificationLine')).toEqual(['datum-nota', 'datum-nota-en']);
    expect(owners('naming.file.form')).toEqual(['datum-nota', 'datum-nota-en']);
    expect(owners('render.ruleIndex.fromMarkers')).toEqual(['datum-standar', 'datum-standar-en']);
    expect(owners('device.registerBlock.sheetNumbering')).toEqual([]); // D-650: restart Bab 1 dimatikan
    expect(owners('cover.controlBlock.preparerUnit')).toHaveLength(10);
    for (const k of Object.keys(SHARED_EXPECTED)) expect(owners(k), k).toHaveLength(10);
  });

  it('nilai jenis/bahasa ada di medan data lapis (DocTypeLayer.layer, LanguageLayer.layer); tiap kunci di satu lapis saja', () => {
    expect(Object.fromEntries(DOC_TYPE_LAYERS.map((t) => [t.typeCode, t.layer ?? {}]))).toEqual(TYPE_EXPECTED);
    expect(Object.fromEntries(LANGUAGE_LAYERS.map((l) => [l.language, l.layer ?? {}]))).toEqual(LANG_EXPECTED);
    const keysOf = [Object.keys(SHARED_EXPECTED), ...DOC_TYPE_LAYERS.map((t) => Object.keys(t.layer ?? {})), ...LANGUAGE_LAYERS.map((l) => Object.keys(l.layer ?? {}))];
    const typeKeys = new Set(DOC_TYPE_LAYERS.flatMap((t) => Object.keys(t.layer ?? {})));
    const langKeys = new Set(LANGUAGE_LAYERS.flatMap((l) => Object.keys(l.layer ?? {})));
    for (const k of Object.keys(SHARED_EXPECTED)) expect(typeKeys.has(k) || langKeys.has(k), k).toBe(false);
    for (const k of typeKeys) expect(langKeys.has(k), k).toBe(false);
    expect(keysOf.flat().length).toBeGreaterThan(0);
  });

  it('kunci tata letak mesin E (C19/C20) disaklar SATU konstanta bernama: menyala = keduanya true', () => {
    expect(ENGINE_E_LAYOUT_OPT_INS).toBe(true);
    for (const s of DOC_TYPE_TEMPLATE_SPECS) for (const k of ENGINE_E_KEYS) expect(s.layer[k], `${s.slug}: ${k}`).toBe(true);
    const text = readFileSync(path.join(REPO, 'prisma', 'seed-doc-type-templates.ts'), 'utf8');
    // Dua kunci itu ditulis satu kali, di cabang konstanta (bukan per templat).
    for (const k of ENGINE_E_KEYS) expect(text.split(`"${k}"`).length - 1, k).toBe(1);
    expect(text).toMatch(/\.\.\.\(ENGINE_E_LAYOUT_OPT_INS \?/);
  });

  it('tanpa nilai lapis yang menyalin preset Rev A atau bawaan registri (kecuali dua kunci D-606 yang disengaja)', () => {
    // Identitas jenis/bahasa per templat (bukti NU-03, `docTypeTemplateSpecJson`) tetap ditulis walau sama dengan bawaan.
    const IDENTITY = ['doc.defaultTypeCode', 'doc.defaultTier', 'doc.language'];
    for (const s of DOC_TYPE_TEMPLATE_SPECS) {
      for (const [k, v] of Object.entries(s.layer).filter(([key]) => !IDENTITY.includes(key))) {
        const without = k in REV_A_EFFECTIVE ? REV_A_EFFECTIVE[k] : PARAMS_BY_KEY.get(k)!.default;
        const same = JSON.stringify(without ?? null) === JSON.stringify(v);
        expect(same, `${s.slug}: ${k} = ${JSON.stringify(v)} sama dengan nilai tanpa lapis`).toBe(D606_KEPT_EQUAL_TO_PRESET.includes(k));
      }
    }
  });

  it('opt-in register = nilai tersimpan rencana seed (lapis lanjutan), tidak hilang di pemisahan permukaan', () => {
    for (const s of DOC_TYPE_TEMPLATE_SPECS) {
      const plan = derivedTemplatePlan(s, REV_A_EFFECTIVE);
      for (const [k, v] of Object.entries({ ...SHARED_EXPECTED, ...LANG_EXPECTED[s.layer['doc.language'] as 'ID' | 'EN'] })) expect(plan.overrides[k], `${s.slug}: ${k}`).toEqual(v);
    }
  });
});
