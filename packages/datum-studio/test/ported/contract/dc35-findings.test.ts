// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/contract/dc35-findings.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
// DC-35 — temuan produk yang ditemukan uji (TIDAK diperbaiki di sini; kode produksi milik baris lain).
// Ditulis sebagai `it.fails`: uji menyatakan perilaku yang diharapkan register, dan saat ini GAGAL
// karena cacat produk, sehingga suite tetap hijau namun cacat terdokumentasi dan dapat direproduksi.
// Begitu cacat diperbaiki, `it.fails` berubah merah -> ganti menjadi `it` biasa.
//
// DC35-F1 — md2contract menebak nilai majemuk lewat token awal (register 05 §16.5 "dicocokkan",
// KD-42 "tidak ditebak", CW-02). `leadToken` (src/lib/studio/services/import/contract/parse.ts:139-142,
// regex /^[A-Za-z0-9_.-]+/) berhenti di "/" atau ",", sehingga `PASS/FAIL` -> PASS, `complete/blocked`
// -> complete, butir `done/blocked` -> done, `todo,blocked` -> todo; nol peringatan CW-02. Dipakai di
// src/lib/studio/services/import/contract/index.ts:196 (status), :204 (vonis), :366 (status butir).
// Reproduksi: markdownToContract(MAJEMUK, { kind: 'agentWorkReport' }) -> record.verdict = "PASS",
// record.status = "complete", items[].status = done/todo, report.warnings = [].
import { describe, expect, it } from '../_vitest';
import { markdownToContract } from '@/lib/studio/services/import/contract';

const MAJEMUK = [
  '# Laporan nilai majemuk',
  '',
  'Status: complete/blocked',
  'Verdict: PASS/FAIL',
  'Date: 2026-10-30',
  '',
  '## Changes Made',
  '',
  '| ID | Judul | Status |',
  '|---|---|---|',
  '| DC-03 | A | done/blocked |',
  '| DC-04 | B | todo,blocked |',
  '',
].join('\n');

describe('DC-35 temuan produk (it.fails = cacat terbuka)', () => {
  it('DC35-F1 vonis majemuk "PASS/FAIL" tidak ditebak: verdict kosong + CW-02 field verdict baris 4', () => {
    const r = markdownToContract(MAJEMUK, { kind: 'agentWorkReport', status: 'draft' });
    expect(r.doc.sections!.record).not.toHaveProperty('verdict');
    expect(r.report.warnings).toContainEqual(
      expect.objectContaining({ code: 'CONTRACT_STATUS_UNMAPPED', line: 4, details: expect.objectContaining({ field: 'verdict' }) }),
    );
  });

  it('DC35-F1 status majemuk "complete/blocked" tidak ditebak: memakai opsi status + CW-02 scope record baris 3', () => {
    const r = markdownToContract(MAJEMUK, { kind: 'agentWorkReport', status: 'draft' });
    expect(r.doc.sections!.record).toMatchObject({ status: 'draft' });
    expect(r.report.warnings).toContainEqual(expect.objectContaining({ code: 'CONTRACT_STATUS_UNMAPPED', line: 3 }));
  });

  it('DC35-F1 status butir majemuk "done/blocked", "todo,blocked": baris tidak masuk items[] + CW-02 scope item', () => {
    const r = markdownToContract(MAJEMUK, { kind: 'agentWorkReport', status: 'draft' });
    expect(r.doc.sections!.record).not.toHaveProperty('items');
    const itemWarnings = r.report.warnings.filter((w) => (w.details as { scope?: string } | undefined)?.scope === 'item');
    expect(itemWarnings.map((w) => w.line)).toEqual([11, 12]);
  });

  it('kontrol: nilai tunggal + keterangan berkurung tetap dipetakan (perilaku sengaja, parse.ts:138)', () => {
    const r = markdownToContract(['# L', '', 'Status: complete', 'Verdict: FAIL (satu cek gagal)', 'Date: 2026-10-30', '', '## Ringkasan', '', 'x', ''].join('\n'), {
      kind: 'agentWorkReport',
    });
    expect(r.doc.sections!.record).toMatchObject({ status: 'complete', verdict: 'FAIL' });
    expect(r.report.warnings).toEqual([]);
  });
});
