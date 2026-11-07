// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/renderers/gfix1-classification-caps.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
/* eslint-disable @typescript-eslint/no-explicit-any -- snapshot/fixture dibaca bebas-bentuk di uji */
// G-FIX1 butir (g) (D-606; skor pre-S36 CR-1/RB-02 `C:/tmp/pre36/out/datum-laporan_ID.md`): penandaan
// klasifikasi di pembungkus selalu kapital ("TERBATAS"; spesimen manual kapital, EG-50 menjaga penandaan
// Indonesia apa adanya) lewat SATU helper `classificationMarkText` (`engine/front/texts.ts`). Nilai meta
// tersimpan dan validasinya tidak berubah; masukan yang sudah kapital tetap byte-identik (baseline S05).
//
// Seam: helper tabel teks, compose v2 (pasangan Klasifikasi blok kendali sampul), dan keluaran DOCX/HTML
// jalur murni (kepala halaman, sel register, pita segel).
import { beforeAll, describe, expect, it } from '../_vitest';
import type { NormDocSnapshot, ResolvedTemplate } from '@/lib/studio/contract';
import { assembleDocxDetailed } from '@/lib/studio/engine/docx/assemble';
import { classificationMarkText, issueStampTextOf, sealBandTextsOf } from '@/lib/studio/engine/front/texts';
import { assembleHtml } from '@/lib/studio/engine/html/assemble';
import { registerFieldValue, runningHeadText } from '@/lib/studio/engine/html/base/markup';
import { composeV2 } from '@/lib/studio/services/compose';
import { datumSlots, defaultParams, e1, merge, skeletonInput } from '../structure/_kit';
import { canonicalTemplate, makeCtx, unzip } from './_kit';

const t = (text: string) => ({ text });

const META = {
  title: 'T',
  docNumber: '009/GSP/KT/X/2026',
  rev: 'A',
  typeCode: 'KT',
  tier: 'TERBIT',
  classification: 'Terbatas',
  language: 'ID',
  author: 'Tim',
  issueDate: '2026-10-08',
} as any;

describe('G-FIX1 (g): helper penandaan klasifikasi', () => {
  it('huruf campur -> kapital; kapital apa adanya', () => {
    expect(classificationMarkText('Terbatas')).toBe('TERBATAS');
    expect(classificationMarkText('Sangat Rahasia')).toBe('SANGAT RAHASIA');
    expect(classificationMarkText('TERBATAS')).toBe('TERBATAS');
    expect(classificationMarkText('BIASA')).toBe('BIASA');
  });

  it('pita segel ID dan EN mencetak klasifikasi kapital; masukan kapital tetap', () => {
    expect(sealBandTextsOf(META, {}, 'ID')[0]).toBe('KLASIFIKASI · TERBATAS');
    expect(sealBandTextsOf({ ...META, language: 'EN' }, {}, 'EN')[0]).toBe('CLASSIFICATION · TERBATAS');
    expect(sealBandTextsOf({ ...META, classification: 'TERBATAS' }, {}, 'ID')[0]).toBe('KLASIFIKASI · TERBATAS');
    // Pasangan templat dengan {kelas} juga lewat helper.
    expect(sealBandTextsOf(META, { 'wrapper.header': ['KELAS {kelas}', 'X'] }, 'ID')[0]).toBe('KELAS TERBATAS');
  });

  it('cap terbit tetap huruf awal kapital (tidak berubah)', () => {
    // row42 ADAPT A3 (C40, row 122 CP-14; front/texts.ts:55-61,544-545): the default stamp prints U+2014; the registry default keeps '--'.
    expect(issueStampTextOf(META, {}, 'ID')).toBe('// 20261008 ID T — TERBITAN 1');
  });

  it('HTML: kepala halaman dan sel register kapital (kode dan label)', async () => {
    const tpl = await canonicalTemplate();
    expect(runningHeadText(tpl, META).right).toBe('TERBATAS');
    expect(runningHeadText(tpl, { ...META, classification: 'T' }).right).toBe('TERBATAS');
    expect(runningHeadText(tpl, { ...META, classification: 'TERBATAS' }).right).toBe('TERBATAS');
    expect(registerFieldValue(META, 'kelas', tpl)).toBe('TERBATAS');
  });
});

/** Dokumen E1 dengan klasifikasi huruf campur dan pasangan Klasifikasi eksplisit di blok kendali sampul (bentuk klien MCP). */
function doc(classification: string, label = 'Klasifikasi', language: 'ID' | 'EN' = 'ID'): Record<string, any> {
  const d = e1();
  d.meta = { ...d.meta, classification, language };
  d.sections.cover = {
    ...d.sections.cover,
    control: [
      [t(language === 'EN' ? 'Document number' : 'Nomor dokumen'), t('009/GSP/KT/X/2026'), t(language === 'EN' ? 'Revision' : 'Revisi'), t('A')],
      [t(language === 'EN' ? 'Prepared by' : 'Penyusun'), t('Tim Survei'), t(label), t(classification)],
    ],
  };
  return d;
}

function compose(d: Record<string, any>) {
  const slots = datumSlots();
  return composeV2({ source: merge(d, undefined, { slots }).doc, skeleton: skeletonInput(slots), params: defaultParams() }).snapshot as unknown as NormDocSnapshot;
}

const coverRows = (s: NormDocSnapshot): any[][] => (s as any).doc.front.cover.data.control.rows;

describe('G-FIX1 (g): compose pasangan Klasifikasi blok kendali sampul', () => {
  it('nilai di sebelah label klasifikasi (ID/EN, tabel teks) dicetak kapital', () => {
    expect(coverRows(compose(doc('Terbatas')))[1][3]).toEqual({ text: 'TERBATAS' });
    expect(coverRows(compose(doc('Terbatas', 'Classification', 'EN')))[1][3]).toEqual({ text: 'TERBATAS' });
  });

  it('masukan kapital apa adanya; sel lain dan label bukan klasifikasi tidak disentuh', () => {
    expect(coverRows(compose(doc('TERBATAS')))[1][3]).toEqual({ text: 'TERBATAS' });
    const rows = coverRows(compose(doc('Terbatas', 'Kustodian')));
    expect(rows[1][3]).toEqual({ text: 'Terbatas' });
    expect(rows[1][1]).toEqual({ text: 'Tim Survei' });
  });
});

/** Teks run per bagian DOCX. */
function partsText(bytes: Uint8Array, re: RegExp): string {
  const parts = unzip(bytes);
  return Object.keys(parts)
    .filter((p) => re.test(p))
    .map((p) => (Buffer.from(parts[p]).toString('utf8').match(/<w:t(?:\s[^>]*)?>[^<]*<\/w:t>/g) ?? []).map((x) => x.replace(/<[^>]+>/g, '')).join(''))
    .join('\n');
}

function htmlText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/g, ' ')
    .replace(/<script[\s\S]*?<\/script>/g, ' ')
    .replace(/<meta[^>]*>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#160;|&nbsp;/g, ' ');
}

describe('G-FIX1 (g): keluaran DOCX dan HTML, klasifikasi huruf campur', () => {
  let tpl: ResolvedTemplate;
  const out: Record<string, { header: string; footer: string; body: string; html: string }> = {};
  beforeAll(async () => {
    tpl = await canonicalTemplate();
    for (const [k, cls, lang] of [
      ['mixed', 'Terbatas', 'ID'],
      ['caps', 'TERBATAS', 'ID'],
      ['mixedEn', 'Terbatas', 'EN'],
    ] as const) {
      const snap = compose(doc(cls, lang === 'EN' ? 'Classification' : 'Klasifikasi', lang));
      const bytes = (await assembleDocxDetailed(makeCtx(snap, tpl).ctx)).bytes;
      out[k] = {
        header: partsText(bytes, /^word\/header\d+\.xml$/),
        footer: partsText(bytes, /^word\/footer\d+\.xml$/),
        body: partsText(bytes, /^word\/document\.xml$/),
        html: htmlText(await assembleHtml(makeCtx(snap, tpl).ctx, { preview: false })),
      };
    }
  }, 180_000);

  it('DOCX: kepala halaman, sel register, pita segel, dan blok kendali sampul kapital; tanpa "Terbatas"', () => {
    for (const k of ['mixed', 'mixedEn']) {
      const o = out[k];
      expect(o.header, k).toContain('TERBATAS');
      expect(o.footer, k).toContain('TERBATAS');
      expect(`${o.header}\n${o.footer}\n${o.body}`, k).not.toContain('Terbatas');
    }
    expect(`${out.mixed.header}\n${out.mixed.body}`).toContain('KLASIFIKASI · TERBATAS');
    expect(`${out.mixedEn.header}\n${out.mixedEn.body}`).toContain('CLASSIFICATION · TERBATAS');
  });

  it('HTML: tanpa "Terbatas" di teks tampak; penandaan kapital ada', () => {
    for (const k of ['mixed', 'mixedEn']) {
      expect(out[k].html, k).toContain('TERBATAS');
      expect(out[k].html, k).not.toContain('Terbatas');
    }
  });

  it('masukan kapital: keluaran DOCX dan HTML sama persis dengan masukan huruf campur (helper idempoten)', () => {
    expect(out.caps).toEqual(out.mixed);
  });
});
