// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/compose/c10-control-sheet-manual-columns.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
/* eslint-disable @typescript-eslint/no-explicit-any -- snapshot norm/v2 dibaca bebas-bentuk di uji */
// C10 (CS-11, register research/38 §3.2; spike research/35 C-5): opt-in `controlSheet.columns.form` = "manual"
// mencetak kolom lembar kendali manual (ID:29, ID:39, ID:58; EN:29, EN:38, EN:62). Absen / null / "mesin" =
// keluaran sekarang byte-identik: sha snapshot E1 = nilai yang direkam SEBELUM C10 (DC-WIRE, kode 2026-10-30),
// dan kunci tidak masuk konteks compose tersimpan (C-5 elision).
// Seam: `composeV2` (snapshot `doc.front.controlSheet`, `compose.params`), `COMPOSE_PARAM_KEYS`,
// `NORM_COMPOSE_PARAM_KEYS`. Murni, tanpa DB.
import { describe, expect, it } from '../_vitest';
import type { ParamMap } from '@/lib/studio/contract';
import { NORM_COMPOSE_PARAM_KEYS } from '@/lib/studio/contract/types/v2/norm';
import { CONTROL_SHEET_COLUMN_LABELS } from '@/lib/studio/engine/front/texts';
import { PARAMS_BY_KEY } from '@/lib/studio/params';
import { COMPOSE_PARAM_KEYS, composeV2 } from '@/lib/studio/services/compose';
import { manualControlSheetColumnHeads } from '@/lib/studio/services/compose/front';
import { defaultParams, e1, merge, skeletonInput } from '../structure/_kit';

const KEY = 'controlSheet.columns.form';
// Direkam sebelum DC-WIRE dan sebelum C10 (tests/unit/studio/compose/dcwire-snapshot-state.test.ts SHA_BEFORE.e1).
const SHA_E1_BEFORE = '265cb783fae919e7bfbc8b400ab5d4bdff7ef33e4464d29ed76629584553ee2d';

function compose(params: ParamMap, mutate?: (d: Record<string, any>) => void) {
  const d = e1();
  mutate?.(d);
  return composeV2({ source: merge(d).doc, skeleton: skeletonInput(), params });
}

const withForm = (v: unknown): ParamMap => ({ ...defaultParams(), [KEY]: v as never });
const texts = (t: any): string[][] => t.rows.map((r: any) => r.cells.map((c: any) => c.text));
const cs = (r: { snapshot: any }) => r.snapshot.doc.front.controlSheet.data;

describe('C10 bentuk kolom lembar kendali: absen / bawaan = keluaran sekarang', () => {
  it('absen: sha snapshot E1 sama dengan sebelum C10, kolom mesin, kunci tidak tersimpan', () => {
    const r = compose(defaultParams());
    expect(r.snapshotSha256).toBe(SHA_E1_BEFORE);
    expect(texts(cs(r).revisionHistory)[0]).toEqual(['Rev', 'Tanggal', 'Uraian', 'Oleh']);
    expect(r.snapshot.compose!.params).not.toHaveProperty(KEY);
  });

  it('"mesin" dan null eksplisit: snapshot byte-identik dengan absen (C-5: pick membuang bawaan)', () => {
    const base = compose(defaultParams());
    for (const v of ['mesin', null]) {
      const r = compose(withForm(v));
      expect(r.snapshotSha256, String(v)).toBe(base.snapshotSha256);
      expect(r.snapshot.compose!.params, String(v)).not.toHaveProperty(KEY);
    }
  });

  it('daftar kunci compose = daftar norm (urutan sama) dan memuat R-69', () => {
    expect([...COMPOSE_PARAM_KEYS]).toEqual([...NORM_COMPOSE_PARAM_KEYS]);
    expect(COMPOSE_PARAM_KEYS).toContain(KEY);
  });
});

describe('C10 bentuk manual (opt-in)', () => {
  it('ID: kolom manual riwayat revisi, rantai verifikasi, distribusi; STATUS turunan', () => {
    const r = compose(withForm('manual'));
    const d = cs(r);
    expect(texts(d.revisionHistory)).toEqual([
      ['Rev', 'Tanggal', 'Penyusun', 'Perubahan', 'Status'],
      ['A', '2026-10-23', 'Tim Survei', 'Terbit pertama', 'Berlaku'],
    ]);
    expect(texts(d.verificationChain)).toEqual([
      ['Lapis', 'Metode', 'Objek', 'Hasil'],
      // Row 207 (HB-2): documented role/name mapped onto the printed columns (was ['1', '', '', ''] = the defect).
      ['1', 'Penyusun', '', 'A. Pratama'],
    ]);
    expect(texts(d.distribution)).toEqual([
      ['Salinan', 'Pemegang', 'Media', 'Kembali'],
      ['1', 'Manajer Proyek', '', ''],
    ]);
    expect(d.revisionHistory.columns.map((c: any) => c.role)).toEqual(['id', 'text', 'text', 'text', 'text']);
    expect(r.snapshot.compose!.params[KEY]).toBe('manual');
  });

  it('EN: kepala kolom EN dan STATUS "In force"', () => {
    const d = cs(compose(withForm('manual'), (doc) => (doc.meta.language = 'EN')));
    expect(texts(d.revisionHistory)).toEqual([
      ['Rev', 'Date', 'Prepared by', 'Change', 'Status'],
      ['A', '2026-10-23', 'Tim Survei', 'Terbit pertama', 'In force'],
    ]);
    expect(texts(d.verificationChain)[0]).toEqual(['Layer', 'Method', 'Object', 'Result']);
    expect(texts(d.distribution)[0]).toEqual(['Copy', 'Holder', 'Medium', 'Return']);
  });

  it('beberapa baris revisi: baris terakhir berlaku, baris sebelumnya diganti (ID dan EN)', () => {
    const two = (doc: Record<string, any>) => {
      doc.sections.controlSheet.revisionHistory = [
        { rev: 'A', date: '2026-10-23', what: 'Terbit pertama', by: 'Tim Survei' },
        { rev: 'B', date: '2026-11-02', what: 'Revisi data', by: 'Tim Survei' },
      ];
    };
    expect(texts(cs(compose(withForm('manual'), two)).revisionHistory).map((r) => r[4])).toEqual(['Status', 'Diganti', 'Berlaku']);
    const en = (doc: Record<string, any>) => {
      two(doc);
      doc.meta.language = 'EN';
    };
    expect(texts(cs(compose(withForm('manual'), en)).revisionHistory).map((r) => r[4])).toEqual(['Status', 'Superseded', 'In force']);
  });

  it('compose ulang dari konteks tersimpan (snapshot.compose) menghasilkan sha yang sama (C-5)', () => {
    const d = e1();
    const source = merge(d).doc;
    const first = composeV2({ source, skeleton: skeletonInput(), params: withForm('manual') });
    const again = composeV2({ source, skeleton: skeletonInput(), params: first.snapshot.compose!.params as ParamMap });
    expect(again.snapshotSha256).toBe(first.snapshotSha256);
    expect(texts(cs(again).revisionHistory)[0][4]).toBe('Status');
  });

  it('pengenal kolom manual = bawaan registri controlSheet.*.columns (satu sumber, tidak menyimpang)', () => {
    const ids = {
      revision: PARAMS_BY_KEY.get('controlSheet.revisionHistory.columns')?.default as string[],
      verification: (PARAMS_BY_KEY.get('controlSheet.verificationChain')?.default as { columns: string[] }).columns,
      distribution: PARAMS_BY_KEY.get('controlSheet.distribution.columns')?.default as string[],
    };
    for (const kind of ['revision', 'verification', 'distribution'] as const) {
      for (const lang of ['ID', 'EN'] as const) {
        expect(manualControlSheetColumnHeads(kind, lang), `${kind} ${lang}`).toEqual(ids[kind].map((c) => (CONTROL_SHEET_COLUMN_LABELS as Record<string, Record<string, string>>)[c][lang]));
      }
    }
  });

  it('TableV2 kiriman agen tidak diubah oleh bentuk manual', () => {
    const tbl = { type: 'registerTable', columns: [{ role: 'id' }, { role: 'text' }], rows: [{ kind: 'header', cells: [{ text: 'X' }, { text: 'Y' }] }, { cells: [{ text: '1' }, { text: '2' }] }] };
    const d = cs(compose(withForm('manual'), (doc) => (doc.sections.controlSheet.revisionHistory = tbl)));
    expect(texts(d.revisionHistory)).toEqual([['X', 'Y'], ['1', '2']]);
  });
});
