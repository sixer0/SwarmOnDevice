// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/structure/dc09-contract-rows.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
/* eslint-disable @typescript-eslint/no-explicit-any -- payload kontrak disunting bebas-bentuk di uji */
// DC-09: baris M17 kontrak (register 05 §5.7, KD-34): `F:record` contractRecord + `F:record/<n>`
// contractItem per butir, textPlain = I57/I58, identitas butir per `key` lintas revisi.
// Fixture = register 05 §5.8 dan §6.3, bukan keluaran kode yang diuji.
import { describe, expect, it } from '../_vitest';
import { CONTENT_BLOCK_TYPES, type StudioDocV2Resolved, type TemplateSlotDef } from '@/lib/studio/contract';
import { composeV2, emptyResolvedDoc, mergeSubmission, seededPidAllocator } from '@/lib/studio/services/compose';
import { contractItemTextPlain, contractRecordTextPlain } from '@/lib/studio/services/contracts/text';
import { inheritItemPids, rowsFromSource, validateRows } from '@/lib/studio/services/structure/rows';
import { skeletonContractKind, writeContractRows } from '@/lib/studio/services/structure/contract';
import type { StructureRows } from '@/lib/studio/services/structure/types';
import { defaultParams, metaOf, skeletonInput } from './_kit';

const SLUG = 'laporan-kerja-agen';
const TARGET = { mission: { folder: '2026-10-30_hermes-retrial' }, docKey: 'laporan-kerja-dc02' };

function reportSlots(): TemplateSlotDef[] {
  return [
    { slotKey: 'record', sectionType: 'contractRecord', label: 'Catatan Laporan', position: 1, required: true, positionLocked: true, repeatable: false, contentMode: 'INPUT', tiers: [], admits: [], essentials: {} },
    { slotKey: 'content', sectionType: 'chapter', label: 'Isi Laporan', position: 2, required: true, positionLocked: false, repeatable: true, minItems: 1, contentMode: 'INPUT', tiers: [], admits: [...CONTENT_BLOCK_TYPES], essentials: {} },
    { slotKey: 'references', sectionType: 'sourceRegister', label: 'Referensi', position: 3, required: false, positionLocked: false, repeatable: false, contentMode: 'INPUT', tiers: [], admits: [], essentials: {} },
  ];
}

function payload58(): Record<string, any> {
  return {
    type: 'contractRecord',
    status: 'complete',
    owner: 'data-analyst',
    initiator: 'controller',
    taskRef: 'DC-02',
    reportedAt: '2026-10-30T19:30+07:00',
    phase: { from: 'research', to: 'masterplan' },
    cardIds: ['t_249c6b84'],
    refs: [{ documentId: 'cmvui0qun000qv11gtygb1mk9', pid: 'p-8rj0w4aw6r', rel: 'basis' }],
    evidence: [{ kind: 'command', ref: 'npx tsc --noEmit -p tsconfig.json', exitCode: 0 }],
    items: [
      { key: 't_5943d415', title: { text: 'Kunci kosakata status dari korpus' }, status: 'done', owner: 'data-analyst', phase: 'masterplan' },
      { key: 'DC-03', title: { text: 'Protokol metrik efisiensi' }, status: 'ready', dependsOn: ['DC-02'] },
    ],
  };
}

const skeleton = skeletonInput(reportSlots());

function reportDoc(payload: Record<string, any>): StudioDocV2Resolved {
  const empty = emptyResolvedDoc({ template: { slug: SLUG, version: 1 }, meta: { ...metaOf({ title: 'Laporan kerja DC-02' }), tier: 'NOTA' }, ...TARGET });
  const pids = seededPidAllocator('dc09');
  const withSlot = mergeSubmission(empty, { $schema: 'studio.slot/v2', target: TARGET, slot: 'record', payload } as never, { skeleton, tier: 'NOTA', pids }).doc;
  const chapter = { $schema: 'studio.chapter/v2', target: TARGET, chapter: { key: '1', title: { text: 'Ringkasan' }, sections: [{ title: { text: 'Hasil' }, blocks: [{ type: 'paragraph', text: 'Register 05 ditulis.' }] }] } };
  return mergeSubmission(withSlot, chapter as never, { skeleton, tier: 'NOTA', pids }).doc;
}

function compose(payload: Record<string, any>, prevRows?: StructureRows, seed = 'rev') {
  const used = (prevRows?.blocks ?? []).map((b) => b.pid);
  return composeV2({ source: reportDoc(payload), skeleton, tier: 'NOTA', params: defaultParams(), contractKind: 'agentWorkReport', ...(prevRows ? { prevRows, pids: seededPidAllocator(seed, new Set(used)) } : {}) });
}

const recordRows = (rows: StructureRows) => rows.blocks.filter((b) => b.slotKey === 'record');

describe('DC-09 baris M17 kontrak (register 05 §5.7)', () => {
  const r1 = compose(payload58());

  it('F:record contractRecord + F:record/<n> contractItem, isi butir = butir payload', () => {
    expect(recordRows(r1.rows).map((b) => [b.address, b.type])).toEqual([
      ['F:record', 'contractRecord'],
      ['F:record/1', 'contractItem'],
      ['F:record/2', 'contractItem'],
    ]);
    expect(recordRows(r1.rows)[2].content).toEqual(payload58().items[1]);
    expect(validateRows(r1.rows)).toEqual([]);
  });

  it('textPlain M17 = I57 / I58 (bukan teks generik payload)', () => {
    const [rec, i1, i2] = recordRows(r1.rows);
    expect(rec.textPlain).toBe(contractRecordTextPlain(payload58() as never));
    expect(rec.textPlain).toContain('2026-10-30T12:30:00.000Z');
    expect(i1.textPlain).toBe(contractItemTextPlain(payload58().items[0]));
    expect(i2.textPlain).toBe('DC-03 ready Protokol metrik efisiensi DC-02');
  });

  it('compose (DC-10) memakai pid baris: blok contractItem snapshot = pid M17', () => {
    const rowPid = new Map(recordRows(r1.rows).map((b) => [b.address, b.pid]));
    for (const b of r1.snapshot.blocks.filter((x) => x.slotKey === 'record')) expect(b.pid).toBe(rowPid.get(b.address!));
    const rec = r1.snapshot.blocks.find((b) => b.address === 'F:record')!.content as any;
    expect(rec.itemPids).toEqual([rowPid.get('F:record/1'), rowPid.get('F:record/2')]);
  });

  it('KD-34: revisi kedua mewarisi pid per key, butir baru pid bangkitan, butir hilang tidak terbawa', () => {
    const p2 = payload58();
    // DC-03 pindah ke posisi 1, t_5943d415 hilang, DC-04 baru di posisi 2.
    p2.items = [p2.items[1], { key: 'DC-04', title: { text: 'Butir baru' }, status: 'ready' }];
    const r2 = compose(p2, r1.rows, 'rev2');
    const old = new Map(recordRows(r1.rows).filter((b) => b.type === 'contractItem').map((b) => [(b.content as any).key, b.pid]));
    const items2 = recordRows(r2.rows).filter((b) => b.type === 'contractItem');
    expect(items2.map((b) => [(b.content as any).key, b.address])).toEqual([['DC-03', 'F:record/1'], ['DC-04', 'F:record/2']]);
    expect(items2[0].pid).toBe(old.get('DC-03'));
    expect([...old.values()]).not.toContain(items2[1].pid);
    expect(items2.map((b) => b.pid)).not.toContain(old.get('t_5943d415'));
    expect(recordRows(r2.rows)[0].pid).toBe(recordRows(r1.rows)[0].pid);
    expect(validateRows(r2.rows)).toEqual([]);
    const snapItems = r2.snapshot.blocks.filter((b) => b.type === 'contractItem').map((b) => b.pid);
    expect(snapItems).toEqual(items2.map((b) => b.pid));
  });

  it('allocator deterministik berbasis alamat tidak menggandakan pid warisan', () => {
    const prev = compose(payload58()).rows; // pid butir slot-record-1, slot-record-2 (tanpa allocator)
    const p2 = payload58();
    p2.items = [{ key: 'NEW-1', title: { text: 'Baru' }, status: 'ready' }, p2.items[0]];
    const src = reportDoc(p2);
    const det = { next: (_k: string, hint: string) => (hint.startsWith('F:record/') ? `slot-record-${hint.split('/')[1]}` : hint.startsWith('F:') ? `slot-${hint.slice(2).toLowerCase()}` : 'p-fallback000') };
    const slots = reportSlots().map((s, i) => ({ slotKey: s.slotKey, sectionTypeKey: s.sectionType, templateSlotId: null, position: i + 1 }));
    const rows = rowsFromSource({ source: src, slots, allocator: det as never, prev });
    const items = rows.blocks.filter((b) => b.type === 'contractItem');
    expect(items[1].pid).toBe('slot-record-1'); // t_5943d415 mewarisi
    expect(items[0].pid).toBe('p-fallback000');
    expect(validateRows(rows)).toEqual([]);
  });

  it('inheritItemPids: key ganda hanya mewarisi sekali; butir tanpa key = baru', () => {
    const prev = compose(payload58()).rows;
    const pid1 = recordRows(prev)[1].pid;
    expect(inheritItemPids([{ key: 't_5943d415' }, { key: 't_5943d415' }, {}], prev, 'record')).toEqual([pid1, null, null]);
    expect(inheritItemPids([{ key: 't_5943d415' }], prev, 'other')).toEqual([null]);
  });

  it('slot record kosong: tanpa baris F:record', () => {
    const empty = emptyResolvedDoc({ template: { slug: SLUG, version: 1 }, meta: { ...metaOf({ title: 'x' }), tier: 'NOTA' }, ...TARGET });
    const slots = reportSlots().map((s, i) => ({ slotKey: s.slotKey, sectionTypeKey: s.sectionType, templateSlotId: null, position: i + 1 }));
    const rows = rowsFromSource({ source: empty, slots, allocator: seededPidAllocator('e') });
    expect(rows.blocks.filter((b) => b.slotKey === 'record')).toEqual([]);
    expect(rows.sections.find((s) => s.slotKey === 'record')?.filled).toBe(false);
  });
});

describe('DC-09 writeContractRows: dokumen non-kontrak tanpa perubahan', () => {
  it('contractKind null/undefined: mirror null, tanpa akses DB', async () => {
    const tx = new Proxy({}, { get: (_t, k) => { throw new Error(`akses DB tak terduga: ${String(k)}`); } }) as never;
    const rows = compose(payload58()).rows;
    for (const contractKind of [null, undefined]) {
      const r = await writeContractRows(tx, { documentId: 'd', revisionId: 'r', revisionNo: 2, contractKind, rows });
      expect(r).toEqual({ mirror: null, counts: { records: 0, items: 0, refs: 0 }, warnings: [] });
    }
  });
});

describe('DC-09 skeletonContractKind: kerangka tanpa slot contractRecord = tanpa kueri (D-382)', () => {
  it('null tanpa akses DB', async () => {
    const tx = new Proxy({}, { get: (_t, k) => { throw new Error(`akses DB tak terduga: ${String(k)}`); } }) as never;
    expect(await skeletonContractKind(tx, 'v1', [{ sectionType: 'cover' }, { sectionType: 'chapter' }])).toBeNull();
  });
  // row42 SKIP P2 "Prisma (row 109 cut)": the stub is a Prisma client (studioTemplateVersion.findUnique); the row 109
  // patch of services/structure/contract.ts:77-78 reads MX08 with SQL over the store tx (db.get).
  it.skip('slot contractRecord ada: membaca MX08 templat', async () => {
    const tx = { studioTemplateVersion: { findUnique: async () => ({ template: { contractKind: 'agentWorkReport' } }) } } as never;
    expect(await skeletonContractKind(tx, 'v1', [{ sectionType: 'contractRecord' }])).toBe('agentWorkReport');
  });
});
