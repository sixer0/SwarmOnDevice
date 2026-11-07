// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/renderers/s13-wrapper-text-en.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
/* eslint-disable @typescript-eslint/no-explicit-any -- snapshot/fixture dibaca bebas-bentuk di uji */
// S13-S15 (DATUM Rev A; D-595, D-597 D-2/D-3/D-5, D-598 F-2): entri EN tabel teks pembungkus
// (`engine/front/texts.ts`) dan pemilihan bahasanya. Nilai EN = register `research/31` §4.1-§4.4;
// nilai ID = keluaran sebelum ronde ini (byte-identik, juga dijaga uji S06/FIX-2 dan baseline S05).
// Aturan pemilihan pita segel / cap terbit: EN hanya bila bahasa EN DAN nilai parameter = bawaan
// registri (pola kicker bab O-1); nilai lain yang diset templat menang; copyControl menang di kanan.
import { beforeAll, describe, expect, it } from '../_vitest';
import type { NormDocSnapshot, ResolvedTemplate, TemplateSlotDef } from '@/lib/studio/contract';
import { assembleDocxDetailed } from '@/lib/studio/engine/docx/assemble';
import { Derivation, Register } from '@/lib/studio/engine/bind';
import { assembleHtml } from '@/lib/studio/engine/html/assemble';
import {
  APPARATUS_TEXT,
  CONTROL_FIELD_LABELS,
  WRAPPER_TEXT,
  apparatusText,
  appendixOpenerKickerText,
  artifactLabelText,
  chapterKickerText,
  chapterLabelText,
  controlBlockRowsText,
  controlSheetColumnHeads,
  controlSheetLabelText,
  issueStampTextOf,
  sealBandTextsOf,
  verdictTagText,
} from '@/lib/studio/engine/front/texts';
import { PARAMS_BY_KEY } from '@/lib/studio/params';
import { composeV2 } from '@/lib/studio/services/compose';
import { datumSlots, defaultParams, e1, merge, skeletonInput } from '../structure/_kit';
import { canonicalTemplate, makeCtx, unzip } from './_kit';

const META = {
  title: 'T',
  docNumber: '009/GSP/KT/X/2026',
  rev: 'A',
  typeCode: 'KT',
  tier: 'TERBIT',
  classification: 'TERBATAS',
  language: 'EN',
  author: 'Team',
  issueDate: '2026-11-03',
} as any;

describe('S13: entri EN tabel teks (register research/31 §4)', () => {
  it('kepala kolom lembar kendali EN (§4.2); ID tetap', () => {
    expect(controlSheetColumnHeads('revision', 'EN')).toEqual(['Rev', 'Date', 'Change', 'Prepared by']);
    expect(controlSheetColumnHeads('verification', 'EN')).toEqual(['Layer', 'Role', 'Name', 'Date']);
    expect(controlSheetColumnHeads('distribution', 'EN')).toEqual(['Copy', 'Holder']);
    expect(controlSheetColumnHeads('revision', 'ID')).toEqual(['Rev', 'Tanggal', 'Uraian', 'Oleh']);
  });

  it('G-FIX1 (D-606) LB-08: kata lampiran EN = "Annex" (EN:223-247, EN:4326, EN:4441) di label daftar isi, kicker, kepala halaman; ID tetap "Lampiran"', () => {
    expect(WRAPPER_TEXT.appendix).toEqual({ ID: 'Lampiran', EN: 'Annex' });
    expect(chapterLabelText('A', true, 'EN')).toBe('Annex A');
    expect(appendixOpenerKickerText('B', 'EN')).toBe('Annex B');
    expect(chapterKickerText(undefined, undefined, 'C', true, 'EN')).toBe('Annex C');
    expect(chapterLabelText('A', true, 'ID')).toBe('Lampiran A');
    expect(appendixOpenerKickerText('B', 'ID')).toBe('Lampiran B');
  });

  it('G-FIX1 (D-606) LB-07: nilai BAHASA blok kendali dokumen EN = "English (UK)" (EN:18, EN:883); dokumen ID tetap', () => {
    const fields = { 'cover.controlBlock.fields': ['BAHASA'] };
    expect(controlBlockRowsText(META, fields, 'EN')).toEqual([['Language', 'English (UK)', '', '']]);
    expect(controlBlockRowsText({ ...META, language: 'ID' }, fields, 'ID')).toEqual([['Bahasa', 'Indonesia', '', '']]);
    expect(controlBlockRowsText({ ...META, language: 'ID' }, fields, 'EN')).toEqual([['Language', 'Indonesian', '', '']]);
    expect(controlBlockRowsText(META, fields, 'ID')).toEqual([['Bahasa', 'Inggris', '', '']]);
  });

  it('label PENYUSUN blok kendali sampul EN = "Prepared by" (§4.1, D-590); ID tetap', () => {
    expect(CONTROL_FIELD_LABELS.PENYUSUN).toEqual({ ID: 'Penyusun', EN: 'Prepared by' });
  });

  it('pita segel EN bila param = bawaan registri; bawaan registri page.ts tidak berubah', () => {
    expect(PARAMS_BY_KEY.get('wrapper.header')?.default).toEqual(['KLASIFIKASI · {kelas}', 'SALINAN INDUK · PENGGUNAAN INTERNAL GSP']);
    const reg = PARAMS_BY_KEY.get('wrapper.header')?.default as string[];
    expect(sealBandTextsOf(META, {}, 'EN')).toEqual(['CLASSIFICATION · TERBATAS', 'MASTER COPY · GSP INTERNAL USE']);
    expect(sealBandTextsOf(META, { 'wrapper.header': reg }, 'EN')).toEqual(['CLASSIFICATION · TERBATAS', 'MASTER COPY · GSP INTERNAL USE']);
    expect(sealBandTextsOf({ ...META, language: 'ID' }, {}, 'ID')).toEqual(['KLASIFIKASI · TERBATAS', 'SALINAN INDUK · PENGGUNAAN INTERNAL GSP']);
  });

  it('pita segel: pasangan templat menang di bahasa apa pun; copyControl tetap menang di kanan', () => {
    expect(sealBandTextsOf(META, { 'wrapper.header': ['K {kelas}', 'R'] }, 'EN')).toEqual(['K TERBATAS', 'R']);
    expect(sealBandTextsOf({ ...META, copyControl: 'COPY 3' }, {}, 'EN')).toEqual(['CLASSIFICATION · TERBATAS', 'COPY 3']);
  });

  it('pita segel tanpa argumen bahasa = bahasa meta', () => {
    expect(sealBandTextsOf(META, {})).toEqual(['CLASSIFICATION · TERBATAS', 'MASTER COPY · GSP INTERNAL USE']);
  });

  it('cap terbit EN bila format = bawaan registri; format templat menang; ID tetap', () => {
    expect(PARAMS_BY_KEY.get('device.issueStamp.format')?.default).toBe('// {YYYYMMDD} {BAHASA} {KELAS} -- TERBITAN {n}');
    // row42 ADAPT A3 (C40, row 122 CP-14; front/texts.ts:55-61,544-545): the default stamp prints U+2014; the registry default keeps '--'.
    expect(issueStampTextOf(META, {})).toBe('// 20261103 EN T — ISSUE 1');
    expect(issueStampTextOf(META, { 'device.issueStamp.format': PARAMS_BY_KEY.get('device.issueStamp.format')?.default as string })).toBe('// 20261103 EN T — ISSUE 1');
    expect(issueStampTextOf(META, { 'device.issueStamp.format': 'STAMP {n}' })).toBe('STAMP 1');
    expect(issueStampTextOf({ ...META, language: 'ID' }, {})).toBe('// 20261103 ID T — TERBITAN 1');
  });

  it('label slot lembar kendali: bawaan ID diterjemahkan untuk EN, label lain menang', () => {
    expect(controlSheetLabelText('Lembar Kendali', 'EN')).toBe('Control Sheet');
    expect(controlSheetLabelText('Lembar Kendali', 'ID')).toBe('Lembar Kendali');
    expect(controlSheetLabelText('Document Control', 'EN')).toBe('Document Control');
  });

  it('label aparatus satu tabel: HTML (huruf campur) dan DOCX (kapital) dari entri yang sama', () => {
    expect(apparatusText('ID')).toMatchObject({ source: 'Sumber', provenance: 'Provenans', key: 'Kunci', derivation: 'Turunan' });
    expect(apparatusText('EN')).toMatchObject({ source: 'Source', provenance: 'Provenance', key: 'Key', derivation: 'Derivation' });
    expect(APPARATUS_TEXT.source.ID.toUpperCase()).toBe('SUMBER');
  });

  it('label artefak tampilan: EN menerjemahkan kata depan, ID dan alamat apa adanya', () => {
    expect(artifactLabelText('Tabel 3.1', 'EN')).toBe('Table 3.1');
    expect(artifactLabelText('Gambar FM.2', 'EN')).toBe('Figure FM.2');
    expect(artifactLabelText('Turunan D-3.1a', 'EN')).toBe('Derivation D-3.1a');
    expect(artifactLabelText('Tabel 3.1', 'ID')).toBe('Tabel 3.1');
    expect(artifactLabelText('Custom 1', 'EN')).toBe('Custom 1');
  });

  it('vonis bawaan ID diterjemahkan untuk EN; vonis kiriman apa adanya', () => {
    expect(verdictTagText('MEMENUHI', 'EN')).toBe('COMPLIES');
    expect(verdictTagText('TIDAK MEMENUHI', 'EN')).toBe('DOES NOT COMPLY');
    expect(verdictTagText('MEMENUHI', 'ID')).toBe('MEMENUHI');
    expect(verdictTagText('OK', 'EN')).toBe('OK');
  });

  it('pembangun turunan: tag vonis bawaan berbahasa register (tabel yang sama); ID tetap; tag kiriman menang', () => {
    const entries = { p: { v: 5, dec: 1, unit: 'kW', mark: 'TERUKUR', src: 'log' } } as any;
    const tags = (lang: 'ID' | 'EN', opts?: { ok?: string }) => {
      const d = new Derivation('D-1', 'T', new Register(entries, lang));
      d.verdict('a', 'p', 10, opts).verdict('b', 'p', 1);
      return d.rows.map((r: any) => r.tag);
    };
    expect(tags('ID')).toEqual(['MEMENUHI', 'TIDAK MEMENUHI']);
    expect(tags('EN')).toEqual(['COMPLIES', 'DOES NOT COMPLY']);
    expect(tags('EN', { ok: 'PASS' })[0]).toBe('PASS');
  });
});

// ── Jalur murni: compose v2 -> DOCX dan HTML, dokumen EN ──────────────────

const t = (text: string) => ({ text });

/** Dokumen E1 versi EN: isi agen berbahasa Inggris agar setiap token ID yang muncul berasal dari mesin. */
function enDoc(): Record<string, any> {
  const d = e1();
  d.meta = { ...d.meta, language: 'EN', title: 'Cikupa Substation Survey', subject: 'Cikupa survey' };
  d.register = { p1: { v: 5, dec: 1, unit: 'kW', mark: 'DITURUNKAN', src: 'Meter log' } };
  d.sections.cover = { type: 'cover', titleLines: [t('Cikupa Substation Survey')], standfirst: t('Primary equipment condition.') };
  d.sections.controlSheet = {
    type: 'controlSheet',
    revisionHistory: [{ rev: 'A', date: '2026-11-03', what: 'First issue', by: 'Survey team' }],
    verificationChain: [{ layer: '1', role: 'Prepared by', name: 'A. Pratama' }],
    methodStatement: t('Direct field measurement.'),
    distribution: [{ copy: '1', holder: 'Project manager' }],
  };
  d.sections.signature = { type: 'signatureBlock', roles: [{ role: t('Prepared by'), holder: t('A. Pratama'), date: t('2026-11-03') }] };
  d.sections.content.chapters = [
    { key: '1', title: t('Survey scope'), sections: [{ title: t('Purpose'), blocks: [{ type: 'paragraph', text: 'The survey records 150 kV equipment.' }] }] },
    {
      key: '2',
      title: t('Main findings'),
      sections: [
        {
          title: t('Power transformer'),
          blocks: [
            { type: 'paragraph', text: 'Oil temperature of TD-1 is above the normal limit.' },
            {
              type: 'table',
              caption: t('Transformer oil temperature'),
              columns: [{ role: 'text' }, { role: 'numeral', unit: '°C' }],
              rows: [{ kind: 'header', cells: [t('Unit'), t('Temperature')] }, { cells: [t('TD-1'), t('68')] }],
              source: { text: 'Field measurement 2026-10-20', provenance: ['TERUKUR'] },
            },
            {
              type: 'chart',
              code: 'P-01',
              data: { shape: 'categorical', points: [{ label: 'A', value: 1 }, { label: 'B', value: 2 }] },
              caption: t('Outage hours per unit'),
              source: { text: 'Field log', provenance: ['TERUKUR'] },
              keyRow: t('Bar = outage hours'),
            },
            {
              type: 'derivation',
              title: t('Load check'),
              lines: [{ label: t('Current'), value: t('100 A') }],
              result: { label: t('Power'), expr: 'p1', registerKey: 'p1' },
              verdict: { label: t('Status'), registerKey: 'p1', limit: 10 },
              closing: t('If the current changes, recompute the power.'),
            },
          ],
        },
      ],
    },
  ];
  d.sections.references = { type: 'sourceRegister', entries: [{ id: 'r1', citation: t('SPLN T5.008:2019'), kind: 'document' }] };
  d.sections.appendices = { type: 'appendix', chapters: [{ key: 'A', title: t('Raw data'), sections: [{ title: t('Temperature log'), blocks: [{ type: 'paragraph', text: 'A 24-hour log.' }] }] }] };
  return d;
}

function composeEn(slots: TemplateSlotDef[] = datumSlots()) {
  return composeV2({ source: merge(enDoc(), undefined, { slots }).doc, skeleton: skeletonInput(slots), params: defaultParams() });
}

/** AC-6 inti (tanpa `Rp`, milik baris angka) + label aparatus F-2/D-2/D-3. */
const FORBIDDEN = [
  'Lembar Kendali',
  'KLASIFIKASI',
  'SALINAN INDUK',
  'TERBITAN',
  'Tanggal',
  'Uraian',
  'Oleh',
  'Pemegang',
  'LEMBAR',
  'Penyusun',
  'Tabel',
  'Gambar',
  'SUMBER',
  'KUNCI',
  'PROVENANS',
  'MEMENUHI',
  'Turunan',
];

/** Token ditemukan bila cocok kata utuh pada teks sumber ATAU bentuk kapitalnya (research/31 §6 butir 2). */
function leaks(text: string): string[] {
  const upper = text.toUpperCase();
  return FORBIDDEN.filter((tok) => {
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${tok.replace(' ', '[ \\u00a0]')}(?![\\p{L}\\p{N}])`, 'u');
    return re.test(text) || (tok === tok.toUpperCase() && re.test(upper));
  });
}

function docxText(bytes: Uint8Array): string {
  const parts = unzip(bytes);
  return Object.keys(parts)
    .filter((p) => /^word\/(document|header\d*|footer\d*)\.xml$/.test(p))
    .map((p) =>
      Buffer.from(parts[p])
        .toString('utf8')
        .split(/<\/w:p>/)
        .map((para) => (para.match(/<w:t(?:\s[^>]*)?>[^<]*<\/w:t>/g) ?? []).map((x) => x.replace(/<[^>]+>/g, '')).join(''))
        .join('\n'),
    )
    .join('\n')
    .replace(/&amp;/g, '&');
}

function htmlText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/g, ' ')
    .replace(/<script[\s\S]*?<\/script>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#160;|&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#9;/g, '\t');
}

describe('S14: compose lembar kendali mengikuti meta.language', () => {
  it('EN: kicker, judul bawaan, dan kepala kolom berbahasa Inggris', () => {
    const cs = (composeEn().snapshot as any).doc.front.controlSheet.data;
    expect(cs.kicker).toEqual({ text: 'Control Sheet' });
    expect(cs.title).toEqual({ text: 'Control Sheet' });
    // Isi agen di sel badan berbahasa Inggris, jadi token ini hanya bisa datang dari kepala kolom mesin.
    expect(JSON.stringify(cs.revisionHistory)).toContain('Prepared by');
    expect(JSON.stringify(cs.revisionHistory)).not.toMatch(/Tanggal|Uraian|Oleh/);
    expect(JSON.stringify(cs.distribution)).toContain('Holder');
    expect(JSON.stringify(cs.distribution)).not.toMatch(/Salinan|Pemegang/);
    expect(JSON.stringify(cs.verificationChain)).toContain('Layer');
  });

  it('EN: label slot bukan bawaan ID (templat EN / agen) dipakai apa adanya', () => {
    const slots = datumSlots().map((s) => (s.slotKey === 'controlSheet' ? { ...s, label: 'Document Control' } : s));
    const cs = (composeEn(slots).snapshot as any).doc.front.controlSheet.data;
    expect(cs.kicker).toEqual({ text: 'Document Control' });
  });
});

describe('S13-S15 + F-2: dokumen EN jalur murni tanpa teks pembungkus Indonesia', () => {
  let tpl: ResolvedTemplate;
  let docx: string;
  let html: string;
  beforeAll(async () => {
    tpl = await canonicalTemplate();
    const snap = composeEn().snapshot as unknown as NormDocSnapshot;
    docx = docxText((await assembleDocxDetailed(makeCtx(snap, tpl).ctx)).bytes);
    html = htmlText(await assembleHtml(makeCtx(snap, tpl).ctx, { preview: false }));
  }, 120_000);

  it('DOCX: tidak memuat token AC-6 maupun label aparatus ID', () => {
    expect(leaks(docx)).toEqual([]);
  });

  // G-FIX1 (g): klasifikasi pita segel kapital lewat helper penandaan (meta 'Terbatas' -> TERBATAS).
  it('DOCX: memuat string EN register (pita segel, cap terbit, lembar kendali, aparatus)', () => {
    for (const s of ['CLASSIFICATION · TERBATAS', 'MASTER COPY · GSP INTERNAL USE', '— ISSUE 1', /* // row42 ADAPT A3 (C40, row 122 CP-14; front/texts.ts:55-61,544-545): the default stamp prints U+2014; the registry default keeps '--'. */ 'Control Sheet', 'Prepared by', 'Change', 'Holder', 'Table 2.1', 'Figure 2.1', 'SOURCE', 'PROVENANCE', 'KEY', 'Derivation D-2.1', 'COMPLIES']) {
      expect(docx, s).toContain(s);
    }
  });

  it('HTML: tidak memuat token AC-6 maupun label aparatus ID', () => {
    expect(leaks(html)).toEqual([]);
  });

  it('HTML: memuat string EN register (pita segel, lembar kendali, aparatus)', () => {
    for (const s of ['CLASSIFICATION · TERBATAS', 'MASTER COPY · GSP INTERNAL USE', 'Control Sheet', 'Prepared by', 'Holder', 'Table 2.1', 'Figure 2.1', 'Source', 'Provenance', 'KEY', 'Derivation D-2.1', 'COMPLIES']) {
      expect(html, s).toContain(s);
    }
  });
});
