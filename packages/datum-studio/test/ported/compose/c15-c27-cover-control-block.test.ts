// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/compose/c15-c27-cover-control-block.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
/* eslint-disable @typescript-eslint/no-explicit-any -- meta dan snapshot norm/v2 dibaca bebas-bentuk di uji */
// C15 (CL-02 T/S, register research/38 §3.3) dan C27 (CV-15, research/38 §3.5; D-627 Q2, D-635 (3)(4)) pada blok
// kendali sampul. Nilai harapan = literal register/manual (ID:16, ID:21, ID:2487; EN:16, EN:21, EN:2558), bukan
// keluaran kode. Absen / bawaan = keluaran sekarang (baris pin O-3 di fix2-wrapper-text-parity dan sha E1 sebelum C10).
// Seam: `controlBlockRowsText` (blok auto, DOCX + HTML), `composeV2` (blok eksplisit klien MCP, snapshot `compose.params`).
import { describe, expect, it } from '../_vitest';
import type { ParamMap } from '@/lib/studio/contract';
import { controlBlockRowsText } from '@/lib/studio/engine/front/texts';
import { COMPOSE_PARAM_KEYS, composeV2 } from '@/lib/studio/services/compose';
import { defaultParams, e1, merge, skeletonInput } from '../structure/_kit';

const meta = { title: 'T', docNumber: '009/GSP/KT/X/2026', rev: 'A', typeCode: 'KT', tier: 'TERBIT', classification: 'Terbatas', language: 'ID', author: 'Tim', issueDate: '2026-10-08' } as any;
const metaEn = { ...meta, language: 'EN' };
// Daftar 8 medan yang direkomendasikan register §4 / D-635 (3): KLASIFIKASI ketiga, DASAR dikeluarkan.
const FIELDS_8 = ['NOMOR DOKUMEN', 'REVISI', 'KLASIFIKASI', 'PENYUSUN', 'KUSTODIAN', 'DITUJUKAN KEPADA', 'TIER', 'BAHASA'];
const UNIT = 'cover.controlBlock.preparerUnit';
const SHA_E1_BEFORE = '265cb783fae919e7bfbc8b400ab5d4bdff7ef33e4464d29ed76629584553ee2d';

describe('C15 KLASIFIKASI di blok kendali sampul auto', () => {
  it('bawaan (absen): tanpa baris klasifikasi, baris sama dengan pin O-3', () => {
    expect(controlBlockRowsText({ ...meta, classification: 'TERBATAS' }, {}, 'ID')).toEqual([
      ['Nomor dokumen', '009/GSP/KT/X/2026', 'Revisi', 'A · 8 Oktober 2026'],
      ['Penyusun', 'Tim', 'Tier', 'TERBIT'],
      ['Bahasa', 'Indonesia', '', ''],
    ]);
  });

  it('ID: templat mendaftar KLASIFIKASI -> baris Klasifikasi, nilai kapital, di bawah nomor', () => {
    expect(controlBlockRowsText(meta, { 'cover.controlBlock.fields': FIELDS_8 }, 'ID')).toEqual([
      ['Nomor dokumen', '009/GSP/KT/X/2026', 'Revisi', 'A · 8 Oktober 2026'],
      ['Klasifikasi', 'TERBATAS', 'Penyusun', 'Tim'],
      ['Tier', 'TERBIT', 'Bahasa', 'Indonesia'],
    ]);
  });

  it('EN: label Classification, nilai kapital', () => {
    expect(controlBlockRowsText(metaEn, { 'cover.controlBlock.fields': FIELDS_8 }, 'EN')).toEqual([
      ['Document number', '009/GSP/KT/X/2026', 'Revision', 'A · 8 October 2026'],
      ['Classification', 'TERBATAS', 'Prepared by', 'Tim'],
      ['Tier', 'TERBIT', 'Language', 'English (UK)'],
    ]);
  });

  it('klasifikasi kosong dilewati seperti medan kosong lain', () => {
    expect(controlBlockRowsText({ ...meta, classification: ' ' }, { 'cover.controlBlock.fields': ['KLASIFIKASI'] }, 'ID')).toBeUndefined();
  });
});

describe('C27 unit penyusun sampul (blok auto)', () => {
  it('absen, kosong, atau spasi: PENYUSUN = meta.author', () => {
    for (const p of [{}, { [UNIT]: '' }, { [UNIT]: '  ' }, { [UNIT]: null }] as ParamMap[]) {
      expect(controlBlockRowsText(meta, p, 'ID')?.[1].slice(0, 2), JSON.stringify(p)).toEqual(['Penyusun', 'Tim']);
    }
  });

  it('ID: nilai unit templat dicetak di sebelah Penyusun (ID:16, ID:2487)', () => {
    const rows = controlBlockRowsText(meta, { 'cover.controlBlock.fields': FIELDS_8, [UNIT]: 'Divisi Engineering PT GSP' }, 'ID');
    expect(rows?.[1]).toEqual(['Klasifikasi', 'TERBATAS', 'Penyusun', 'Divisi Engineering PT GSP']);
  });

  it('EN: nilai unit templat dicetak di sebelah Prepared by (EN:16, EN:2558)', () => {
    const rows = controlBlockRowsText(metaEn, { [UNIT]: 'Engineering Division, PT GSP' }, 'EN');
    expect(rows?.[1].slice(0, 2)).toEqual(['Prepared by', 'Engineering Division, PT GSP']);
  });
});

describe('C27 unit penyusun sampul (blok eksplisit klien MCP, compose)', () => {
  const t = (text: string) => ({ text });
  const explicit = (labelAuthor: string) => [
    [t('Nomor dokumen'), t('009/GSP/KT/X/2026'), t('Revisi'), t('A · 2026-10-23')],
    [t(labelAuthor), t('A. Pratama'), t('Klasifikasi'), t('terbatas')],
  ];
  function compose(params: ParamMap, labelAuthor = 'Penyusun', language?: 'EN') {
    const d = e1();
    d.sections.cover.control = explicit(labelAuthor);
    if (language) d.meta.language = language;
    return composeV2({ source: merge(d).doc, skeleton: skeletonInput(), params });
  }
  const control = (r: { snapshot: any }) => r.snapshot.doc.front.cover.data.control.rows.map((row: any[]) => row.map((c) => c.text));
  const withUnit = (v: unknown): ParamMap => ({ ...defaultParams(), [UNIT]: v as never });

  it('absen / kosong: nilai penyusun eksplisit apa adanya; snapshot byte-identik; kunci tidak tersimpan', () => {
    const base = compose(defaultParams());
    expect(control(base)[1]).toEqual(['Penyusun', 'A. Pratama', 'Klasifikasi', 'TERBATAS']);
    for (const v of ['', null]) {
      const r = compose(withUnit(v));
      expect(r.snapshotSha256, String(v)).toBe(base.snapshotSha256);
      expect(r.snapshot.compose!.params, String(v)).not.toHaveProperty(UNIT);
    }
    // E1 tanpa blok eksplisit: sha sama dengan sebelum C10/C27.
    expect(composeV2({ source: merge(e1()).doc, skeleton: skeletonInput(), params: defaultParams() }).snapshotSha256).toBe(SHA_E1_BEFORE);
  });

  it('ID: nilai di sebelah Penyusun diganti unit templat; tanda tangan dan riwayat revisi tetap nama penyusun', () => {
    const r = compose(withUnit('Divisi Engineering PT GSP'));
    expect(control(r)[1]).toEqual(['Penyusun', 'Divisi Engineering PT GSP', 'Klasifikasi', 'TERBATAS']);
    expect(control(r)[0]).toEqual(['Nomor dokumen', '009/GSP/KT/X/2026', 'Revisi', 'A · 2026-10-23']);
    expect(r.snapshot.compose!.params[UNIT]).toBe('Divisi Engineering PT GSP');
    const snap: any = r.snapshot;
    const sig = snap.blocks.find((b: any) => b.type === 'signatureBlock');
    expect(sig.content.roles[0].holder.text).toBe('A. Pratama');
    expect(snap.doc.front.controlSheet.data.revisionHistory.rows[1].cells.map((c: any) => c.text)).toContain('Tim Survei');
    // Muatan tersimpan (source) tidak diubah: klien MCP membaca balik meta.author dari sana (write-meta serverClientMeta).
    expect(snap.source.sections.cover.control[1][1].text).toBe('A. Pratama');
  });

  it('EN: label Prepared by diganti unit EN; compose ulang dari konteks tersimpan sama', () => {
    const r = compose(withUnit('Engineering Division, PT GSP'), 'Prepared by', 'EN');
    expect(control(r)[1].slice(0, 2)).toEqual(['Prepared by', 'Engineering Division, PT GSP']);
    const again = composeV2({ source: r.snapshot.source, skeleton: skeletonInput(), params: r.snapshot.compose!.params as ParamMap });
    expect(again.snapshotSha256).toBe(r.snapshotSha256);
  });

  it('label lain (mis. Disusun) tidak disentuh; kunci compose memuat R-79', () => {
    expect(control(compose(withUnit('Divisi Engineering PT GSP'), 'Disusun'))[1].slice(0, 2)).toEqual(['Disusun', 'A. Pratama']);
    expect(COMPOSE_PARAM_KEYS).toContain(UNIT);
  });
});
