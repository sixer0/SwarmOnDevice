// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/renderers/dc12-contract-fixture.ts (see test/ported/README.md).
/* eslint-disable @typescript-eslint/no-explicit-any -- kiriman JSON kontrak dibaca bebas-bentuk di uji */
// DC-12/DC-13: fixture laporan kerja agen register 05 §5.8 (kiriman slot `record` + bab 1)
// -> snapshot `studio.norm/v2` lewat compose murni (DC-10). Sumber kebenaran isi =
// register 05 §5.8 dan §6.3 (SL-08..SL-10), bukan keluaran perender yang diuji.
import { CONTENT_BLOCK_TYPES, type NormDocSnapshot, type StudioDocV2Resolved, type StudioTier, type TemplateSlotDef } from '@/lib/studio/contract';
import { composeV2, emptyResolvedDoc, mergeSubmission, seededPidAllocator } from '@/lib/studio/services/compose';
import { defaultParams, metaOf, skeletonInput } from '../structure/_kit';

export const CONTRACT_SLUG = 'laporan-kerja-agen';
const TARGET = { mission: { folder: '2026-10-30_hermes-retrial' }, docKey: 'laporan-kerja-dc02' };
const TIER: StudioTier = 'NOTA';

/** Register 05 §6.3 SL-08..SL-10. */
export function contractReportSlots(): TemplateSlotDef[] {
  return [
    { slotKey: 'record', sectionType: 'contractRecord', label: 'Catatan Laporan', position: 1, required: true, positionLocked: true, repeatable: false, contentMode: 'INPUT', tiers: [], admits: [], essentials: {} },
    { slotKey: 'content', sectionType: 'chapter', label: 'Isi Laporan', position: 2, required: true, positionLocked: false, repeatable: true, minItems: 1, contentMode: 'INPUT', tiers: [], admits: [...CONTENT_BLOCK_TYPES], essentials: {} },
    { slotKey: 'references', sectionType: 'sourceRegister', label: 'Referensi', position: 3, required: false, positionLocked: false, repeatable: false, contentMode: 'INPUT', tiers: [], admits: [], essentials: {} },
  ];
}

/** Register 05 §5.8 contoh 1 (kiriman slot `record`). */
export function contractSlotSubmission(): Record<string, any> {
  return {
    $schema: 'studio.slot/v2',
    target: TARGET,
    template: { slug: CONTRACT_SLUG },
    meta: { title: 'Laporan kerja DC-02 register document contract' },
    slot: 'record',
    payload: {
      type: 'contractRecord',
      status: 'complete',
      owner: 'data-analyst',
      initiator: 'controller',
      taskRef: 'DC-02',
      reportedAt: '2026-10-30T19:30+07:00',
      phase: { from: 'research', to: 'masterplan' },
      cardIds: ['t_249c6b84'],
      refs: [{ documentId: 'cmvui0qun000qv11gtygb1mk9', pid: 'p-8rj0w4aw6r', rel: 'basis' }],
      evidence: [
        { kind: 'file', ref: 'docs/2026-10-22_doc_artifact_studio/masterplan/05_document_contract_specs.md', bytes: 61234, sha256: '55d324b1' },
        { kind: 'command', ref: 'npx tsc --noEmit -p tsconfig.json', exitCode: 0 },
      ],
      items: [
        { key: 't_5943d415', title: { text: 'Kunci kosakata status dari korpus' }, status: 'done', owner: 'data-analyst', phase: 'masterplan' },
        { key: 'DC-03', title: { text: 'Protokol metrik efisiensi' }, status: 'ready', dependsOn: ['DC-02'] },
      ],
    },
  };
}

/** Register 05 §5.8 contoh 2 (kiriman bab). */
export function contractChapterSubmission(): Record<string, any> {
  return {
    $schema: 'studio.chapter/v2',
    target: TARGET,
    chapter: {
      key: '1',
      title: { text: 'Ringkasan' },
      sections: [{ title: { text: 'Hasil' }, blocks: [{ type: 'paragraph', text: 'Register 05 ditulis; empat kode galat baru.' }] }],
    },
  };
}

/** Snapshot norm/v2 laporan kerja §5.8 (pid deterministik), dikembalikan bertipe kontrak render. */
export function contractReportSnapshot(seed = 'dc12'): NormDocSnapshot {
  const skeleton = skeletonInput(contractReportSlots());
  const empty: StudioDocV2Resolved = emptyResolvedDoc({
    template: { slug: CONTRACT_SLUG, version: 1 },
    meta: { ...metaOf({ title: 'Laporan kerja DC-02 register document contract' }), tier: TIER },
    ...TARGET,
  });
  const pids = seededPidAllocator(seed);
  const merge = (cur: StudioDocV2Resolved, sub: Record<string, any>) => mergeSubmission(cur, sub as never, { skeleton, tier: TIER, pids }).doc;
  const doc = merge(merge(empty, contractSlotSubmission()), contractChapterSubmission());
  const r = composeV2({ source: doc, skeleton, tier: TIER, params: defaultParams() });
  return r.snapshot as unknown as NormDocSnapshot;
}

/** Nilai yang wajib tampil (dari kiriman §5.8 + label C58 yang diproyeksikan compose). */
export const CONTRACT_EXPECTED = {
  cardIds: ['t_249c6b84'],
  itemKeys: ['t_5943d415', 'DC-03'],
  evidenceRefs: ['docs/2026-10-22_doc_artifact_studio/masterplan/05_document_contract_specs.md', 'npx tsc --noEmit -p tsconfig.json'],
} as const;
