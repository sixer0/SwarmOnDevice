// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/compose/dcwire-snapshot-state.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
/* eslint-disable @typescript-eslint/no-explicit-any -- snapshot norm/v2 dibaca bebas-bentuk di uji */
// DC-WIRE (D-386, register 05 §6.5): compose meneruskan `slotKey` + `contractKind` ke `slotStateOf`.
// Dokumen non-kontrak: state dan `snapshotSha256` IDENTIK dengan sebelum DC-WIRE (nilai sha di bawah
// direkam dari kode SEBELUM perubahan, bukan dari kode yang diuji). Dokumen kontrak tanpa bab CO 2..5:
// slot `content` PARTIAL (sebelumnya FILLED) -> sha dokumen kontrak boleh berubah.
import { describe, expect, it } from '../_vitest';
import { CONTENT_BLOCK_TYPES, type TemplateSlotDef } from '@/lib/studio/contract';
import { composeV2, emptyResolvedDoc, mergeSubmission, seededPidAllocator, slotState } from '@/lib/studio/services/compose';
import { defaultParams, e1, merge, metaOf, probeDoc, skeletonInput } from '../structure/_kit';

// Direkam sebelum DC-WIRE (kode v2.1 2026-10-30, sebelum suntingan snapshot.ts).
const SHA_BEFORE = {
  e1: '265cb783fae919e7bfbc8b400ab5d4bdff7ef33e4464d29ed76629584553ee2d',
  probe: '664c5576cabe44225a3453de3f4566da3b820f69b6b222407e2c96064ea4838f',
  contract: 'f661e3085248de3f3504b67fbb11e2dfc004503be363657fbb5905d8b5f712d6',
};

const states = (r: { snapshot: any }) => r.snapshot.skeleton.slots.map((s: any) => [s.slotKey, s.state]);

const reportSlots: TemplateSlotDef[] = [
  { slotKey: 'record', sectionType: 'contractRecord', label: 'Catatan Laporan', position: 1, required: true, positionLocked: true, repeatable: false, contentMode: 'INPUT', tiers: [], admits: [], essentials: {} },
  { slotKey: 'content', sectionType: 'chapter', label: 'Isi Laporan', position: 2, required: true, positionLocked: false, repeatable: true, minItems: 1, contentMode: 'INPUT', tiers: [], admits: [...CONTENT_BLOCK_TYPES], essentials: {} },
];

function contractCompose(keys: string[], contractKind?: string) {
  const sk = skeletonInput(reportSlots);
  const TARGET = { mission: { folder: '2026-10-30_x' }, docKey: 'lk' };
  let src = emptyResolvedDoc({ template: { slug: 'laporan-kerja-agen', version: 1 }, meta: { ...metaOf({ title: 'LK' }), tier: 'NOTA' }, ...TARGET });
  const pids = seededPidAllocator('w');
  for (const key of keys) {
    const ch = { $schema: 'studio.chapter/v2', target: TARGET, chapter: { key, title: { text: 'R' }, sections: [{ title: { text: 'H' }, blocks: [{ type: 'paragraph', text: 'x' }] }] } };
    src = mergeSubmission(src, ch as never, { skeleton: sk, tier: 'NOTA', pids }).doc;
  }
  return composeV2({ source: src, skeleton: sk, tier: 'NOTA', params: defaultParams(), ...(contractKind ? { contractKind } : {}) });
}

describe('DC-WIRE compose: dokumen non-kontrak tidak berubah', () => {
  it('E1 DATUM: snapshotSha256 identik dengan sebelum DC-WIRE', () => {
    const r = composeV2({ source: merge(e1()).doc, skeleton: skeletonInput(), params: defaultParams() });
    expect(r.snapshotSha256).toBe(SHA_BEFORE.e1);
    expect(states(r)).toEqual([
      ['cover', 'FILLED'], ['controlSheet', 'FILLED'], ['signature', 'FILLED'], ['toc', 'AUTO_READY'],
      ['content', 'FILLED'], ['references', 'FILLED'], ['appendices', 'FILLED'],
    ]);
  });

  it('dokumen probe DATUM: snapshotSha256 identik dengan sebelum DC-WIRE', () => {
    const r = composeV2({ source: merge(probeDoc()).doc, skeleton: skeletonInput(), params: defaultParams() });
    expect(r.snapshotSha256).toBe(SHA_BEFORE.probe);
  });

  it('slotState tanpa contractKind = perilaku lama (kunci bab berurutan)', () => {
    const slot = reportSlots[1];
    const payload = { type: 'chapter', chapters: [{ key: '1' }] };
    expect(slotState(slot, payload, false)).toBe('FILLED');
    expect(slotState(slot, payload, false, undefined)).toBe('FILLED');
  });
});

describe('DC-WIRE compose: dokumen ber-contractKind (05 §6.5)', () => {
  it('laporan kerja hanya bab 1: content PARTIAL, sha berubah dari nilai sebelum DC-WIRE', () => {
    const r = contractCompose(['1'], 'agentWorkReport');
    expect(states(r)).toEqual([['record', 'EMPTY'], ['content', 'PARTIAL']]);
    expect(r.snapshotSha256).not.toBe(SHA_BEFORE.contract);
  });

  it('bab 1..5 lengkap: content FILLED', () => {
    expect(states(contractCompose(['1', '2', '3', '4', '5'], 'agentWorkReport'))).toEqual([['record', 'EMPTY'], ['content', 'FILLED']]);
  });

  it('tanpa bab 3: content PARTIAL', () => {
    expect(states(contractCompose(['1', '2', '4', '5'], 'agentWorkReport'))[1]).toEqual(['content', 'PARTIAL']);
  });

  it('slotState: contractKind meneruskan slotKey (slot berulang lain di luar kerangka jenis tetap aturan lama)', () => {
    const payload = { type: 'chapter', chapters: [{ key: '1' }] };
    expect(slotState(reportSlots[1], payload, false, 'agentWorkReport')).toBe('PARTIAL');
    expect(slotState({ ...reportSlots[1], slotKey: 'lain' }, payload, false, 'agentWorkReport')).toBe('FILLED');
  });
});
