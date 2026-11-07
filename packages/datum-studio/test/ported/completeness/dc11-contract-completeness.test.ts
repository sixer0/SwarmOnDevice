// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/completeness/dc11-contract-completeness.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
// DC-11: kelengkapan dokumen ber-contractKind (register 05 §6.5, KD-31, BA-11).
// Seam: `computeCompleteness` (murni, I48). Harapan dari §6.5 dan registri C58 (CO-01..CO-05),
// bukan dari kode: SL-08 `record` wajib, SL-09 `content` expected = CO wajib + outline dokumen.
import { describe, expect, it } from '../_vitest';
import {
  computeCompleteness,
  contractRequiredChapterKeys,
  slotStateOf,
  type CompletenessInput,
  type CompletenessSlotInput,
} from '@/lib/studio/services/completeness';

const DOC = { docId: 'doc-lap', docNumber: '001/GSP/LAP/X/2026', missionFolder: '2026-10-30_uji', docKey: 'laporan-dc11' };
const KIND = 'agentWorkReport';
const row = (filled: boolean, payload: unknown = null) => ({
  filled,
  payload,
  lastFilledBy: filled ? 'coder-execution' : null,
  lastFilledAt: filled ? '2026-10-30T12:30:00Z' : null,
  lastFilledRevisionNo: filled ? 1 : null,
});
const chap = (key: string) => ({ key, pid: `bab-${key}`, by: 'coder-execution', at: '2026-10-30T12:30:00Z', revisionNo: 1 });

// Kerangka SL-08..SL-10 (§6.3).
function record(filled = true): CompletenessSlotInput {
  return { slotKey: 'record', sectionType: 'contractRecord', label: 'Catatan Laporan', required: true, repeatable: false, contentMode: 'INPUT', active: true, row: filled ? row(true, { status: 'complete' }) : row(false) };
}
function content(keys: string[], outline?: unknown): CompletenessSlotInput {
  return {
    slotKey: 'content', sectionType: 'chapter', label: 'Isi Laporan', required: true, repeatable: true, minItems: 1, contentMode: 'INPUT', active: true,
    row: row(keys.length > 0, outline !== undefined ? { outline } : null),
    chapters: keys.map(chap),
  };
}
const references = (): CompletenessSlotInput => ({ slotKey: 'references', sectionType: 'sourceRegister', label: 'Referensi', required: false, repeatable: false, contentMode: 'INPUT', active: true, row: null });
const input = (slots: CompletenessSlotInput[], contractKind: string | null = KIND): CompletenessInput => ({ revisionNo: 1, slots, doc: DOC, ...(contractKind !== null ? { contractKind } : {}) });
const ALL = ['1', '2', '3', '4', '5'];

describe('DC-11 §6.5 kelengkapan laporan kerja agen', () => {
  it('laporan lengkap (record + bab 1..5) -> COMPLETE, render penuh diizinkan', () => {
    const r = computeCompleteness(input([record(), content(ALL), references()]));
    expect(r.status).toBe('COMPLETE');
    expect(r.fullRenderAllowed).toBe(true);
    expect(r.missingRequired).toEqual([]);
    expect(r.chapters.content).toMatchObject({ expected: ALL, expectedSource: 'outline', missing: [] });
    expect(r.slots.map((s) => [s.slotKey, s.state])).toEqual([['record', 'FILLED'], ['content', 'FILLED'], ['references', 'OMITTED']]);
  });

  it('SL-08: tanpa record terisi -> EMPTY + missingRequired `record`', () => {
    const r = computeCompleteness(input([record(false), content(ALL)]));
    expect(r.slots.find((s) => s.slotKey === 'record')?.state).toBe('EMPTY');
    expect(r.missingRequired).toEqual(['record']);
    expect(r.status).toBe('INCOMPLETE');
  });

  it('SL-08: tanpa baris M14 sama sekali (wajib tak dapat di-OMIT) -> EMPTY + `record`', () => {
    const r = computeCompleteness(input([{ ...record(), row: null }, content(ALL)]));
    expect(r.slots.find((s) => s.slotKey === 'record')?.state).toBe('EMPTY');
    expect(r.missingRequired).toEqual(['record']);
  });

  it('asap: laporan tanpa bab 3 -> INCOMPLETE dengan `content:3` (render penuh ditolak)', () => {
    const r = computeCompleteness(input([record(), content(['1', '2', '4', '5'])]));
    expect(r.status).toBe('INCOMPLETE');
    expect(r.fullRenderAllowed).toBe(false);
    expect(r.missingRequired).toEqual(['content:3']);
    expect(r.chapters.content).toMatchObject({ expected: ALL, expectedSource: 'outline', missing: ['3'] });
    expect(r.slots.find((s) => s.slotKey === 'content')?.state).toBe('PARTIAL');
  });

  it('kontras non-kontrak: kerangka sama tanpa contractKind -> contiguous; tanpa bab 5 COMPLETE, dengan kontrak tidak', () => {
    const a = computeCompleteness(input([record(), content(['1', '2', '4', '5'])], null));
    expect(a.chapters.content.expectedSource).toBe('contiguous');
    const b = computeCompleteness(input([record(), content(['1', '2', '3', '4'])], null));
    expect(b.status).toBe('COMPLETE');
    const c = computeCompleteness(input([record(), content(['1', '2', '3', '4'])]));
    expect(c.status).toBe('INCOMPLETE');
    expect(c.missingRequired).toEqual(['content:5']);
  });

  it('outline dokumen (R14 setOutline) ikut expected: CO 1..5 + {6, 7}', () => {
    const outline = [{ key: '1' }, { key: '7' }, { key: '6' }];
    const r = computeCompleteness(input([record(), content([...ALL, '6'], outline)]));
    expect(r.chapters.content).toMatchObject({ expected: ['1', '2', '3', '4', '5', '6', '7'], expectedSource: 'outline', missing: ['7'] });
    expect(r.missingRequired).toEqual(['content:7']);
    const done = computeCompleteness(input([record(), content([...ALL, '6', '7'], outline)]));
    expect(done.status).toBe('COMPLETE');
  });

  it('setOutline null (outline absen/null/kosong) tetap menuntut CO 1..5', () => {
    for (const outline of [undefined, null, []]) {
      const r = computeCompleteness(input([record(), content(['1', '2'], outline)]));
      expect(r.chapters.content).toMatchObject({ expected: ALL, expectedSource: 'outline', missing: ['3', '4', '5'] });
      expect(r.missingRequired).toEqual(['content:3', 'content:4', 'content:5']);
      expect(r.status).toBe('INCOMPLETE');
    }
  });

  it('bab di luar CO (kunci 6+) diterima dan tercantum di present tanpa menjadi wajib', () => {
    const r = computeCompleteness(input([record(), content([...ALL, '9'])]));
    expect(r.status).toBe('COMPLETE');
    expect(r.chapters.content.present.map((c) => c.key)).toEqual([...ALL, '9']);
  });

  it('0 bab: content EMPTY, missingRequired memuat content:1..5', () => {
    const r = computeCompleteness(input([record(), content([])]));
    expect(r.slots.find((s) => s.slotKey === 'content')?.state).toBe('EMPTY');
    expect(r.missingRequired).toEqual(ALL.map((k) => `content:${k}`));
  });

  it('contractKind null / jenis tak terdaftar -> perilaku non-kontrak', () => {
    for (const kind of [null, 'jenisLain']) {
      const r = computeCompleteness(input([record(), content(['1', '2'])], kind));
      expect(r.chapters.content.expectedSource).toBe('contiguous');
      expect(r.status).toBe('COMPLETE');
    }
  });

  it('CO hanya berlaku untuk slot berulang kerangka jenis (slotKey + sectionType C58)', () => {
    expect(contractRequiredChapterKeys(KIND, 'content', 'chapter')).toEqual(ALL);
    expect(contractRequiredChapterKeys(KIND, 'body', 'chapter')).toBeNull();
    expect(contractRequiredChapterKeys(KIND, 'record', 'contractRecord')).toBeNull();
    expect(contractRequiredChapterKeys(undefined, 'content', 'chapter')).toBeNull();
    const other = { ...content(['1']), slotKey: 'body' };
    expect(computeCompleteness(input([record(), other])).chapters.body.expectedSource).toBe('contiguous');
  });

  it('slotStateOf (state cadangan R05/compose) membaca contractKind yang sama', () => {
    const base = { sectionType: 'chapter', required: true, repeatable: true, contentMode: 'INPUT' as const, minItems: 1, omitted: false, filled: true, chapterKeys: ['1', '2'] };
    expect(slotStateOf(base)).toBe('FILLED');
    expect(slotStateOf({ ...base, slotKey: 'content', contractKind: KIND })).toBe('PARTIAL');
    expect(slotStateOf({ ...base, slotKey: 'content', contractKind: KIND, chapterKeys: ALL })).toBe('FILLED');
  });
});
