// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/renderers/en-provenance-mark-labels.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
/* eslint-disable @typescript-eslint/no-explicit-any -- snapshot/fixture dibaca bebas-bentuk di uji */
// EN-PROV (2026-11-05): label tampilan tanda provenans per bahasa dokumen, DATUM Rev A Tabel 7.1
// (EN manual_en.txt:2114-2124 MEASURED/DERIVED/VENDOR/ASSUMED; ID manual_id.txt:2040-2051
// TERUKUR/DITURUNKAN/PEMASOK/ASUMSI). Kode tanda di konten/API tidak berubah; hanya label tercetak.
// Seam: jalur render murni (composeV2 -> assembleDocxDetailed / assembleHtml) + tabel teks mesin.
import { beforeAll, describe, expect, it } from '../_vitest';
import type { NormDocSnapshot, ResolvedTemplate } from '@/lib/studio/contract';
import { PROVENANCE_MARKS } from '@/lib/studio/contract/enums';
import { assembleDocxDetailed } from '@/lib/studio/engine/docx/assemble';
import { assembleHtml } from '@/lib/studio/engine/html/assemble';
import { PROVENANCE_MARK_TEXT, provenanceMarkLabelText } from '@/lib/studio/engine/front/texts';
import { composeV2 } from '@/lib/studio/services/compose';
import { datumSlots, defaultParams, e1, merge, skeletonInput } from '../structure/_kit';
import { canonicalTemplate, makeCtx, unzip } from './_kit';

const ID_LABELS = ['TERUKUR', 'DITURUNKAN', 'PEMASOK', 'ASUMSI'];
const EN_LABELS = ['MEASURED', 'DERIVED', 'VENDOR', 'ASSUMED'];

const t = (text: string) => ({ text });

/** Dokumen yang membawa keempat tanda di rel, assumptionInline, baris SUMBER tabel/figur, dan turunan. */
function provDoc(lang: 'ID' | 'EN'): Record<string, any> {
  const d = e1();
  d.meta = { ...d.meta, language: lang };
  d.register = { p1: { v: 5, dec: 1, unit: 'kW', mark: 'DITURUNKAN', src: 'Meter log' } };
  d.sections.content.chapters[1].sections[0].blocks = [
    { type: 'paragraph', text: 'Oil temperature of TD-1 is above the normal limit.', rail: [{ kind: 'mark', mark: 'TERUKUR' }] },
    // Keempat tanda di rel: HTML assumptionInline tidak mencetak label tanda (hanya DOCX), jadi ASUMSI HTML datang dari sini.
    { type: 'paragraph', text: 'The rail lists every mark.', rail: PROVENANCE_MARKS.map((mark) => ({ kind: 'mark', mark })) },
    { type: 'assumptionInline', asmId: 'ASM-FAS-01', text: 'Sixteen operating hours per day.', impact: 'The interval shortens.' },
    {
      type: 'table',
      caption: t('Transformer oil temperature'),
      columns: [{ role: 'text' }, { role: 'numeral', unit: '°C' }],
      rows: [{ kind: 'header', cells: [t('Unit'), t('Temperature')] }, { cells: [t('TD-1'), t('68')] }],
      source: { text: 'Field measurement 2026-10-20', provenance: ['TERUKUR', 'PEMASOK'] },
    },
    {
      type: 'chart',
      code: 'P-01',
      data: { shape: 'categorical', points: [{ label: 'A', value: 1 }, { label: 'B', value: 2 }] },
      caption: t('Outage hours per unit'),
      source: { text: 'Field log', provenance: ['DITURUNKAN'] },
    },
    {
      type: 'derivation',
      title: t('Load check'),
      lines: [{ label: t('Current'), value: t('100 A'), mark: 'TERUKUR' }],
      result: { label: t('Power'), expr: 'p1', registerKey: 'p1' },
      verdict: { label: t('Status'), registerKey: 'p1', limit: 10 },
      closing: t('If the current changes, recompute the power.'),
    },
  ];
  return d;
}

function compose(lang: 'ID' | 'EN') {
  const slots = datumSlots();
  return composeV2({ source: merge(provDoc(lang), undefined, { slots }).doc, skeleton: skeletonInput(slots), params: defaultParams() });
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
    .join('\n');
}

function htmlText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/g, ' ')
    .replace(/<script[\s\S]*?<\/script>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#160;|&nbsp;/g, ' ');
}

/** Label yang muncul sebagai kata utuh kapital pada teks tercetak. */
const present = (text: string, labels: readonly string[]) => labels.filter((l) => new RegExp(`(?<![\\p{L}\\p{N}])${l}(?![\\p{L}\\p{N}])`, 'u').test(text));

describe('EN-PROV: tabel label tanda provenans (Tabel 7.1)', () => {
  it('satu entri per kode tanda kontrak; ID = kode itu sendiri, EN = label manual EN', () => {
    expect(Object.keys(PROVENANCE_MARK_TEXT)).toEqual([...PROVENANCE_MARKS]);
    expect(PROVENANCE_MARKS.map((m) => provenanceMarkLabelText(m, 'ID'))).toEqual(ID_LABELS);
    expect(PROVENANCE_MARKS.map((m) => provenanceMarkLabelText(m, 'EN'))).toEqual(EN_LABELS);
  });

  it('kode di luar enum keluar apa adanya (tidak ada label karangan)', () => {
    expect(provenanceMarkLabelText('LAIN', 'EN')).toBe('LAIN');
  });
});

describe('EN-PROV: render murni mencetak label menurut bahasa dokumen', () => {
  let tpl: ResolvedTemplate;
  const out: Record<'ID' | 'EN', { docx: string; html: string }> = {} as never;
  beforeAll(async () => {
    tpl = await canonicalTemplate();
    for (const lang of ['ID', 'EN'] as const) {
      const snap = compose(lang).snapshot as unknown as NormDocSnapshot;
      out[lang] = {
        docx: docxText((await assembleDocxDetailed(makeCtx(snap, tpl).ctx)).bytes),
        html: htmlText(await assembleHtml(makeCtx(snap, tpl).ctx, { preview: false })),
      };
    }
  }, 120_000);

  it('kode tanda di snapshot tetap kode kontrak (EN tidak menerjemahkan data)', () => {
    const json = JSON.stringify(compose('EN').snapshot);
    for (const m of ['TERUKUR', 'PEMASOK', 'DITURUNKAN', 'ASUMSI']) expect(json).toContain(`"${m}"`);
    expect(present(json, EN_LABELS)).toEqual([]);
  });

  it('DOCX EN: MEASURED/DERIVED/VENDOR/ASSUMED, tanpa label tanda Indonesia', () => {
    expect(present(out.EN.docx, EN_LABELS)).toEqual(EN_LABELS);
    expect(present(out.EN.docx, ID_LABELS)).toEqual([]);
  });

  it('HTML EN: MEASURED/DERIVED/VENDOR/ASSUMED, tanpa label tanda Indonesia', () => {
    expect(present(out.EN.html, EN_LABELS)).toEqual(EN_LABELS);
    expect(present(out.EN.html, ID_LABELS)).toEqual([]);
  });

  it('DOCX ID dan HTML ID tetap TERUKUR/DITURUNKAN/PEMASOK/ASUMSI, tanpa label EN', () => {
    for (const text of [out.ID.docx, out.ID.html]) {
      expect(present(text, ID_LABELS)).toEqual(ID_LABELS);
      expect(present(text, EN_LABELS)).toEqual([]);
    }
  });
});
