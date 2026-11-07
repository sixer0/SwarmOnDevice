// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/renderers/s06-wrapper-text-single-source.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
/* eslint-disable @typescript-eslint/no-explicit-any -- snapshot/fixture dibaca bebas-bentuk di uji */
// S06 (D-595, D-597 D-7; research/33 B-01, B-05, B-06, B-10, B-11): teks pembungkus ID satu sumber
// di `engine/front/texts.ts`. Refaktor berperilaku tetap: setiap nilai di bawah adalah keluaran ID
// sebelum refaktor (literal yang dulu tersalin di compose/front.ts, docx/wrapper/render.ts,
// docx/package/header-footer.ts, html/base/markup.ts) dan bawaan registri `params/page.ts`.
import { beforeAll, describe, expect, it } from '../_vitest';
import type { NormUnit, ResolvedTemplate } from '@/lib/studio/contract';
import { assembleDocxDetailed } from '@/lib/studio/engine/docx/assemble';
import { defaultRunningHeadLeft } from '@/lib/studio/engine/docx/package/header-footer';
import {
  CONTROL_SHEET_COLUMNS,
  REGISTER_WORDS,
  controlSheetColumnHeads,
  issueStampTextOf,
  registerWordsText,
  sealBandTextsOf,
} from '@/lib/studio/engine/front/texts';
import { registerCellParts } from '@/lib/studio/engine/html/base/markup';
import { PARAMS_BY_KEY } from '@/lib/studio/params';
import { composeV2 } from '@/lib/studio/services/compose';
import { datumSlots, defaultParams, e1, merge, skeletonInput } from '../structure/_kit';
import { canonicalTemplate, loadFixtureDoc, makeCtx, snapshotOf, unzip } from './_kit';

const META = {
  title: 'T',
  docNumber: '009/GSP/KT/X/2026',
  rev: 'A',
  typeCode: 'KT',
  tier: 'TERBIT',
  classification: 'TERBATAS',
  language: 'ID',
  author: 'Tim',
  issueDate: '2026-10-08',
} as any;

/** Semua string medan `text`/`t` di sebuah sel (bentuk Inline bebas). */
function cellText(cell: unknown): string {
  const out: string[] = [];
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        if ((k === 'text' || k === 't') && typeof x === 'string') out.push(x);
        else walk(x);
      }
    }
  };
  walk(cell);
  return out.join('');
}

function headerRow(table: any): string[] {
  const row = (table?.rows ?? []).find((r: any) => r.kind === 'header');
  return (row?.cells ?? []).map(cellText);
}

describe('S06 B-01: kepala kolom lembar kendali dari tabel teks', () => {
  it('entri ID persis keluaran sebelum refaktor (S13 menambah entri EN, research/31 §4.2)', () => {
    expect(controlSheetColumnHeads('revision', 'ID')).toEqual(['Rev', 'Tanggal', 'Uraian', 'Oleh']);
    expect(controlSheetColumnHeads('verification', 'ID')).toEqual(['Lapis', 'Peran', 'Nama', 'Tanggal']);
    expect(controlSheetColumnHeads('distribution', 'ID')).toEqual(['Salinan', 'Pemegang']);
    expect(Object.keys(CONTROL_SHEET_COLUMNS).sort()).toEqual(['distribution', 'revision', 'verification']);
    for (const entry of Object.values(CONTROL_SHEET_COLUMNS)) expect(Object.keys(entry)).toEqual(['ID', 'EN']);
  });

  it('bahasa tanpa entri memakai entri ID; EN punya entri sendiri sejak S13', () => {
    expect(controlSheetColumnHeads('revision', 'XX' as any)).toEqual(['Rev', 'Tanggal', 'Uraian', 'Oleh']);
    expect(controlSheetColumnHeads('revision', 'EN')).toEqual(['Rev', 'Date', 'Change', 'Prepared by']);
  });

  it('compose v2 daftar bertipe -> baris kepala tabel lembar kendali (ID byte-sama)', () => {
    const slots = datumSlots();
    const r = composeV2({ source: merge(e1(), undefined, { slots }).doc, skeleton: skeletonInput(slots), params: defaultParams() });
    const cs = (r.snapshot as any).doc.front.controlSheet.data;
    expect(headerRow(cs.revisionHistory)).toEqual(['Rev', 'Tanggal', 'Uraian', 'Oleh']);
    expect(headerRow(cs.verificationChain)).toEqual(['Lapis', 'Peran', 'Nama', 'Tanggal']);
    expect(headerRow(cs.distribution)).toEqual(['Salinan', 'Pemegang']);
  });
});

describe('S06 B-05/B-06: cadangan pita segel dan cap terbit = bawaan registri', () => {
  it('pita segel tanpa param: bawaan registri wrapper.header, {kelas} diisi', () => {
    expect(PARAMS_BY_KEY.get('wrapper.header')?.default).toEqual(['KLASIFIKASI · {kelas}', 'SALINAN INDUK · PENGGUNAAN INTERNAL GSP']);
    expect(sealBandTextsOf(META, {})).toEqual(['KLASIFIKASI · TERBATAS', 'SALINAN INDUK · PENGGUNAAN INTERNAL GSP']);
  });

  it('pita segel: copyControl menang di kanan; param templat menang atas bawaan', () => {
    expect(sealBandTextsOf({ ...META, copyControl: 'SALINAN 3' }, {})).toEqual(['KLASIFIKASI · TERBATAS', 'SALINAN 3']);
    expect(sealBandTextsOf(META, { 'wrapper.header': ['K {kelas}', 'R {kelas}'] })).toEqual(['K TERBATAS', 'R TERBATAS']);
    expect(sealBandTextsOf(META, { 'wrapper.header': ['hanya kiri'] })).toEqual(['hanya kiri', '']);
  });

  it('cap terbit tanpa param: bawaan registri device.issueStamp.format', () => {
    expect(PARAMS_BY_KEY.get('device.issueStamp.format')?.default).toBe('// {YYYYMMDD} {BAHASA} {KELAS} -- TERBITAN {n}');
    // row42 ADAPT A3 (C40, row 122 CP-14; front/texts.ts:55-61,544-545): the default stamp prints U+2014; the registry default keeps '--'.
    expect(issueStampTextOf(META, {})).toBe('// 20261008 ID T — TERBITAN 1');
    expect(issueStampTextOf(META, { 'device.issueStamp.format': 'CAP {n}', 'device.issueStamp.issueNumber': 4 })).toBe('CAP 4');
  });
});

describe('S06 B-11: kata label register LEMBAR/DARI satu tabel untuk DOCX dan HTML', () => {
  it('ID tanpa terjemahan; EN LEMBAR->SHEET, DARI->OF', () => {
    expect(REGISTER_WORDS).toEqual({ EN: { LEMBAR: 'SHEET', DARI: 'OF' } });
    expect(registerWordsText('LEMBAR {n} DARI {N}', 'ID')).toBe('LEMBAR {n} DARI {N}');
    expect(registerWordsText('LEMBAR {n} DARI {N}', 'EN')).toBe('SHEET {n} OF {N}');
    expect(registerWordsText('REV · KELAS LEMBAR', 'EN')).toBe('REV · KELAS SHEET');
  });

  it('HTML registerCellParts: sel lembar ID/EN (NBSP pemisah bawaan)', () => {
    const tpl = { params: {} } as unknown as ResolvedTemplate;
    const show = (parts: any[]) => parts.map((p) => ('field' in p ? `{${p.field}}` : p.text)).join('');
    expect(show(registerCellParts(tpl, 'ID')[2])).toBe('LEMBAR {n} DARI {N}');
    expect(show(registerCellParts(tpl, 'EN')[2])).toBe('SHEET {n} OF {N}');
  });
});

describe('S06 B-10/B-11: kepala dan kaki halaman DOCX', () => {
  let tpl: ResolvedTemplate;
  beforeAll(async () => {
    tpl = await canonicalTemplate();
  });

  const unit = (kind: NormUnit['kind'], key: string) => ({ kind, key, setup: {} }) as unknown as NormUnit;

  it('kepala halaman bawaan: "Bab n"/"Lampiran X" (ID), "Chapter n"/"Annex X" (EN, G-FIX1 LB-08)', () => {
    const doc = JSON.parse(JSON.stringify(loadFixtureDoc('doc_terbit_report')));
    const id = makeCtx(snapshotOf(doc), tpl).ctx;
    expect(defaultRunningHeadLeft(id, unit('chapter', '9'))).toContain(' · Bab 9');
    expect(defaultRunningHeadLeft(id, unit('appendix', 'Z'))).toContain(' · Lampiran Z');
    doc.meta.language = 'EN';
    const en = makeCtx(snapshotOf(doc), tpl).ctx;
    expect(defaultRunningHeadLeft(en, unit('chapter', '9'))).toContain(' · Chapter 9');
    expect(defaultRunningHeadLeft(en, unit('appendix', 'Z'))).toContain(' · Annex Z');
  });

  async function footerText(language: 'ID' | 'EN'): Promise<string> {
    const doc = JSON.parse(JSON.stringify(loadFixtureDoc('doc_terbit_report')));
    doc.meta.language = language;
    const detail = await assembleDocxDetailed(makeCtx(snapshotOf(doc), tpl).ctx);
    const parts = unzip(detail.bytes);
    return Object.keys(parts)
      .filter((p) => /^word\/footer\d+\.xml$/.test(p))
      .map((p) => (Buffer.from(parts[p]).toString('utf8').match(/<w:t[^>]*>[^<]*<\/w:t>/g) ?? []).map((t) => t.replace(/<[^>]+>/g, '')).join(''))
      .join('\n');
  }

  it('blok register kaki halaman: LEMBAR/DARI (ID), SHEET/OF (EN)', async () => {
    const id = await footerText('ID');
    expect(id).toMatch(/LEMBAR /);
    expect(id).toMatch(/ DARI /);
    const en = await footerText('EN');
    expect(en).toMatch(/SHEET /);
    expect(en).toMatch(/ OF /);
    expect(en).not.toMatch(/LEMBAR|DARI/);
  }, 120_000);
});
