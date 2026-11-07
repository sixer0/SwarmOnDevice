// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/structure/completeness.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
// SR-44: kelengkapan `CompletenessReportV2` (register §8.1-§8.4, KD-15, D-131, PT-05).
// Seam: `computeCompleteness` (murni, I48). Harapan diturunkan dari tabel §8.1 dan templat
// teks §8.3, bukan dari kode.
import { describe, expect, it } from '../_vitest';
import { computeCompleteness, slotState, type CompletenessSlotInput } from '@/lib/studio/services/completeness';

const DOC = { docId: 'doc-1', docNumber: '001/GSP/KT/X/2026', missionFolder: '2026-10-23_uji', docKey: 'laporan' };
const row = (filled: boolean, payload: unknown = null, by = 'agen-a', at = '2026-10-23T02:05:00Z', rev = 2) => ({ filled, payload, lastFilledBy: filled ? by : null, lastFilledAt: filled ? at : null, lastFilledRevisionNo: filled ? rev : null });
const chap = (key: string, at = '2026-10-23T03:10:00Z', by = 'agen-b', rev = 3) => ({ key, pid: `bab-${key.toLowerCase()}`, by, at, revisionNo: rev });

function slot(p: Partial<CompletenessSlotInput> & Pick<CompletenessSlotInput, 'slotKey' | 'sectionType'>): CompletenessSlotInput {
  return { label: p.slotKey, required: true, repeatable: false, contentMode: 'INPUT', active: true, row: row(false), ...p };
}
const content = (chapters: ReturnType<typeof chap>[], extra: Partial<CompletenessSlotInput> = {}) =>
  slot({ slotKey: 'content', sectionType: 'chapter', label: 'Isi', repeatable: true, minItems: 1, row: row(false), chapters, ...extra });

describe('§8.1 state slot (dievaluasi berurutan)', () => {
  it.each<[string, CompletenessSlotInput, string]>([
    ['opsional tanpa baris M14 -> OMITTED', slot({ slotKey: 'references', sectionType: 'sourceRegister', required: false, row: null }), 'OMITTED'],
    ['AUTO -> AUTO_READY (walau kosong)', slot({ slotKey: 'toc', sectionType: 'toc', contentMode: 'AUTO' }), 'AUTO_READY'],
    ['MIXED kosong -> AUTO_READY', slot({ slotKey: 'cover', sectionType: 'cover', contentMode: 'MIXED' }), 'AUTO_READY'],
    ['MIXED terisi -> FILLED', slot({ slotKey: 'cover', sectionType: 'cover', contentMode: 'MIXED', row: row(true) }), 'FILLED'],
    ['tak-berulang terisi -> FILLED', slot({ slotKey: 'controlSheet', sectionType: 'controlSheet', row: row(true) }), 'FILLED'],
    ['tak-berulang INPUT kosong wajib -> EMPTY', slot({ slotKey: 'controlSheet', sectionType: 'controlSheet' }), 'EMPTY'],
    ['tak-berulang INPUT kosong opsional -> OPTIONAL_EMPTY', slot({ slotKey: 'references', sectionType: 'sourceRegister', required: false }), 'OPTIONAL_EMPTY'],
    ['berulang 0 bab wajib -> EMPTY', content([]), 'EMPTY'],
    ['berulang 0 bab opsional -> OPTIONAL_EMPTY', slot({ slotKey: 'appendices', sectionType: 'appendix', required: false, repeatable: true, chapters: [] }), 'OPTIONAL_EMPTY'],
    ['berulang, celah kunci (1,3) -> PARTIAL', content([chap('1'), chap('3')]), 'PARTIAL'],
    ['berulang, jumlah < minItems -> PARTIAL', content([chap('1')], { minItems: 2 }), 'PARTIAL'],
    ['berulang lengkap -> FILLED', content([chap('1'), chap('2')]), 'FILLED'],
  ])('%s', (_n, s, state) => {
    const r = computeCompleteness({ revisionNo: 3, slots: [s], doc: DOC });
    expect(r.slots[0].state).toBe(state);
  });
  it('slot wajib tanpa baris M14 tidak menjadi OMITTED (wajib tak dapat di-OMIT)', () => {
    expect(slotState(slot({ slotKey: 'controlSheet', sectionType: 'controlSheet', row: null }), null)).toBe('EMPTY');
  });
  it('slot tidak aktif untuk tier tidak dicantumkan', () => {
    const r = computeCompleteness({ revisionNo: 1, slots: [slot({ slotKey: 'cover', sectionType: 'cover', active: false }), content([chap('1')])], doc: DOC });
    expect(r.slots.map((s) => s.slotKey)).toEqual(['content']);
  });
});

describe('§8.2 kemajuan bab (KD-15 chapters.<slotKey>)', () => {
  it('contiguous: expected 1..max, missing = expected - ada; present urut alami', () => {
    const r = computeCompleteness({ revisionNo: 3, slots: [content([chap('10'), chap('2'), chap('1')])], doc: DOC });
    const p = r.chapters.content;
    expect(p.expectedSource).toBe('contiguous');
    expect(p.expected).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']);
    expect(p.present.map((c) => c.key)).toEqual(['1', '2', '10']);
    expect(p.missing).toEqual(['3', '4', '5', '6', '7', '8', '9']);
    expect(p.minItems).toBe(1);
  });
  it('outline: expected = kunci outline; bab di luar outline tetap di present', () => {
    const r = computeCompleteness({ revisionNo: 3, slots: [content([chap('1'), chap('9')], { row: row(false, { outline: [{ key: '1' }, { key: '2' }] }) })], doc: DOC });
    expect(r.chapters.content).toMatchObject({ expectedSource: 'outline', expected: ['1', '2'], missing: ['2'] });
    expect(r.chapters.content.present.map((c) => c.key)).toEqual(['1', '9']);
  });
  it('lampiran: contiguous huruf A..huruf terbesar', () => {
    const r = computeCompleteness({ revisionNo: 2, slots: [slot({ slotKey: 'appendices', sectionType: 'appendix', required: false, repeatable: true, chapters: [chap('C')] })], doc: DOC });
    expect(r.chapters.appendices).toMatchObject({ expected: ['A', 'B', 'C'], missing: ['A', 'B'] });
  });
  it('present membawa pid, by, at ISO UTC, revisionNo dari M15', () => {
    const r = computeCompleteness({ revisionNo: 3, slots: [content([chap('1', '2026-10-23T03:10:00.000Z', 'agen-b', 3)])], doc: DOC });
    expect(r.chapters.content.present[0]).toEqual({ key: '1', pid: 'bab-1', by: 'agen-b', at: '2026-10-23T03:10:00.000Z', revisionNo: 3 });
  });
  it('slot OMIT tidak punya entri chapters', () => {
    const r = computeCompleteness({ revisionNo: 3, slots: [content([chap('1')]), slot({ slotKey: 'appendices', sectionType: 'appendix', required: false, repeatable: true, row: null })], doc: DOC });
    expect(Object.keys(r.chapters)).toEqual(['content']);
  });
});

describe('§8.3 status, missingRequired, teks', () => {
  const incomplete = () =>
    computeCompleteness({
      revisionNo: 4,
      slots: [
        slot({ slotKey: 'controlSheet', sectionType: 'controlSheet', label: 'Lembar Kendali' }),
        slot({ slotKey: 'toc', sectionType: 'toc', label: 'Daftar Isi', contentMode: 'AUTO' }),
        content([chap('1'), chap('3')]),
      ],
      doc: DOC,
    });

  it('missingRequired: slotKey tak-berulang EMPTY + "<slotKey>:<kunci>" per bab hilang; status INCOMPLETE', () => {
    const r = incomplete();
    expect(r.missingRequired).toEqual(['controlSheet', 'content:2']);
    expect(r.status).toBe('INCOMPLETE');
    expect(r.fullRenderAllowed).toBe(false);
  });
  it('message INCOMPLETE menyebut nomor, misi, revisi, label slot, kunci bab', () => {
    expect(incomplete().message).toBe(
      'Dokumen 001/GSP/KT/X/2026 (misi 2026-10-23_uji, laporan) belum lengkap pada revisi 4: isi wajib belum ada untuk Lembar Kendali; bab belum ada 2. Render penuh ditolak; render bab/slot tersedia sebagai draf.',
    );
  });
  it('forwardToController (PT-05): nomor, revisi, slot hilang, bab hilang, pengisi terakhir WIB, endpoint berikut', () => {
    const f = incomplete().forwardToController!;
    expect(f).toContain('Dokumen 001/GSP/KT/X/2026 (misi 2026-10-23_uji) belum lengkap pada revisi 4.');
    expect(f).toContain('Isi wajib belum ada: Lembar Kendali.');
    expect(f).toContain('Bab belum ada: 2.');
    expect(f).toContain('Terakhir mengisi: bab 3 oleh agen-b pukul 10:10 WIB.');
    expect(f).toContain('POST /api/studio/slots');
    expect(f).toContain('POST /api/studio/chapters');
    expect(f).toMatch(/lalu minta render penuh\.$/);
  });
  it('nextSteps: kirim isi slot, kirim bab, saran outline (tanpa outline)', () => {
    expect(incomplete().nextSteps).toEqual([
      'Kirim isi Lembar Kendali: POST /api/studio/slots',
      'Kirim bab 2: POST /api/studio/chapters',
      'Opsional: tetapkan daftar bab yang direncanakan: PATCH /api/studio/documents/doc-1/structure {op: setOutline}',
    ]);
  });
  it('revisi 1 tanpa isi: "dibuat kosong pada revisi 1" tanpa bagian Terakhir mengisi; 0 bab = slotKey saja', () => {
    const r = computeCompleteness({ revisionNo: 1, slots: [content([])], doc: DOC });
    expect(r.missingRequired).toEqual(['content']);
    expect(r.forwardToController).toContain('dibuat kosong pada revisi 1.');
    expect(r.forwardToController).not.toContain('Terakhir mengisi');
    expect(r.nextSteps[0]).toBe('Kirim bab pertama: POST /api/studio/chapters');
  });
  it('lampiran wajib hilang memakai {"slot":"<slotKey>"}', () => {
    const r = computeCompleteness({ revisionNo: 2, slots: [content([chap('1')]), slot({ slotKey: 'appendices', sectionType: 'appendix', label: 'Lampiran', repeatable: true, chapters: [chap('B')] })], doc: DOC });
    expect(r.missingRequired).toEqual(['appendices:A']);
    expect(r.nextSteps).toContain('Kirim lampiran A: POST /api/studio/chapters {"slot":"appendices"}');
  });
  it('COMPLETE: missingRequired kosong, render penuh diizinkan, tanpa forwardToController', () => {
    const r = computeCompleteness({
      revisionNo: 5,
      slots: [slot({ slotKey: 'controlSheet', sectionType: 'controlSheet', row: row(true) }), content([chap('1'), chap('2')]), slot({ slotKey: 'references', sectionType: 'sourceRegister', required: false })],
      doc: DOC,
    });
    expect(r).toMatchObject({ status: 'COMPLETE', fullRenderAllowed: true, missingRequired: [] });
    expect(r.message).toBe('Dokumen 001/GSP/KT/X/2026 lengkap pada revisi 5; render penuh tersedia.');
    expect(r.nextSteps).toEqual(['Minta render penuh: POST /api/studio/documents/doc-1/render {scope: "document"}']);
    expect(r.forwardToController).toBeUndefined();
  });
  it('bentuk §8.4: setiap SlotStatusV2 memuat medan wajib', () => {
    for (const s of incomplete().slots) {
      expect(Object.keys(s).sort()).toEqual(['label', 'lastFilledAt', 'lastFilledBy', 'lastFilledRevisionNo', 'required', 'sectionType', 'slotKey', 'state']);
    }
  });
});
