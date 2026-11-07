// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/compose/dc10-contract-record.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
/* eslint-disable @typescript-eslint/no-explicit-any -- isi blok internal dibaca bebas-bentuk di uji */
// DC-10: compose payload `contractRecord` -> unit interior norm/v2 beralamat F:record
// (register 05 §5.7, §5.8, §6.1-§6.4, BA-10; D-139 label milik registri; D-371 slot
// eksplisit pada tier NOTA). Sumber kebenaran fixture = register 05 §5.8 dan §6.3/§6.4,
// bukan keluaran kode yang diuji.
import { describe, expect, it } from '../_vitest';
import { CONTENT_BLOCK_TYPES, type StudioDocV2Resolved, type StudioTier, type TemplateSlotDef } from '@/lib/studio/contract';
import { getContractKindDef } from '@/lib/studio/registry/contracts';
import { getSectionType } from '@/lib/studio/registry/sections';
import { composeV2, emptyResolvedDoc, mergeSubmission, seededPidAllocator, slotLayout, validateStructure } from '@/lib/studio/services/compose';
import { storedComposeContext } from '@/lib/studio/services/compose/context';
import { contractItemTextPlain, contractRecordTextPlain } from '@/lib/studio/services/contracts/text';
import { validateSkeleton } from '@/lib/studio/services/skeleton/skeleton';
import { validateRows } from '@/lib/studio/services/structure/rows';
import { catchEngine, defaultParams, e1, metaOf, skeletonInput } from '../structure/_kit';

const SLUG = 'laporan-kerja-agen';
const DEF = getContractKindDef('agentWorkReport')!;

/** Register 05 §6.3 SL-08..SL-10 (tiers kosong = semua tier). */
function reportSlots(tiers: StudioTier[] = []): TemplateSlotDef[] {
  return [
    { slotKey: 'record', sectionType: 'contractRecord', label: 'Catatan Laporan', position: 1, required: true, positionLocked: true, repeatable: false, contentMode: 'INPUT', tiers, admits: [], essentials: {} },
    { slotKey: 'content', sectionType: 'chapter', label: 'Isi Laporan', position: 2, required: true, positionLocked: false, repeatable: true, minItems: 1, contentMode: 'INPUT', tiers, admits: [...CONTENT_BLOCK_TYPES], essentials: {} },
    { slotKey: 'references', sectionType: 'sourceRegister', label: 'Referensi', position: 3, required: false, positionLocked: false, repeatable: false, contentMode: 'INPUT', tiers, admits: [], essentials: {} },
  ];
}

const TARGET = { mission: { folder: '2026-10-30_hermes-retrial' }, docKey: 'laporan-kerja-dc02' };

/** Register 05 §5.8 contoh 1 (kiriman slot). */
function slotSubmission(): Record<string, any> {
  return {
    $schema: 'studio.slot/v2',
    target: TARGET,
    template: { slug: SLUG },
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
function chapterSubmission(): Record<string, any> {
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

function emptyReport(slug = SLUG): StudioDocV2Resolved {
  return emptyResolvedDoc({ template: { slug, version: 1 }, meta: { ...metaOf({ title: 'Laporan kerja DC-02 register document contract' }), tier: 'NOTA' }, ...TARGET });
}

function buildReport(opts: { tiers?: StudioTier[]; slug?: string; seed?: string } = {}) {
  const skeleton = skeletonInput(reportSlots(opts.tiers));
  const merge = (cur: StudioDocV2Resolved, sub: Record<string, any>) =>
    mergeSubmission(cur, { ...sub, ...(sub.template ? { template: { slug: opts.slug ?? SLUG } } : {}) } as never, { skeleton, tier: 'NOTA', pids: seededPidAllocator(opts.seed ?? 'dc10') }).doc;
  const doc = merge(merge(emptyReport(opts.slug), slotSubmission()), chapterSubmission());
  return { skeleton, doc };
}

const cellText = (c: any): string => (typeof c.text === 'string' ? c.text : (c.runs ?? []).map((r: any) => r.t ?? '').join(''));
const headerOf = (t: any): string[] => t.rows[0].cells.map(cellText);

describe('D-371: slot record eksplisit bertipe contractRecord pada tier NOTA diterima', () => {
  it('prasyarat: registri S30 contractRecord ber-activeTiers kosong (D-371 a)', () => {
    expect(getSectionType('contractRecord')?.activeTiers).toEqual([]);
  });
  for (const tiers of [[], ['NOTA']] as StudioTier[][]) {
    const label = tiers.length === 0 ? 'tiers kosong (semua)' : 'tiers [NOTA]';
    it(`kerangka eksplisit ${label}: validateSkeleton, validateStructure, slotLayout, composeV2 menerima`, () => {
      const skel = skeletonInput(reportSlots(tiers));
      expect(() => validateSkeleton(skel.skeleton, { tier: 'NOTA' })).not.toThrow();
      const sub = slotSubmission();
      expect(() => validateStructure(skel, 'NOTA', { slot: { slot: 'record', payload: sub.payload } })).not.toThrow();
      expect(() => validateStructure(skel, 'NOTA', { structure: { order: ['record', 'content', 'references'] } })).not.toThrow();
      expect(slotLayout(skel, 'NOTA').ordered.map((s) => s.slotKey)).toEqual(['record', 'content', 'references']);
      const { skeleton, doc } = buildReport({ tiers });
      const r = composeV2({ source: doc, skeleton, tier: 'NOTA', params: defaultParams() });
      const rec = r.snapshot.skeleton.slots.find((s) => s.slotKey === 'record')!;
      expect(rec).toMatchObject({ sectionType: 'contractRecord', active: true, omitted: false, state: 'FILLED' });
    });
  }
});

describe('asap register 05 §5.8 -> snapshot norm/v2 dengan unit contractRecord F:record', () => {
  const { skeleton, doc } = buildReport();
  const r = composeV2({ source: doc, skeleton, tier: 'NOTA', params: defaultParams() });
  const snap = r.snapshot;
  const recordBlock = snap.blocks.find((b) => b.address === 'F:record')!;
  const content = recordBlock.content as any;

  it('snapshot norm/v2; unit interior slot F:record sebelum bab 1', () => {
    expect(snap.schema).toBe('studio.norm/v2');
    expect(snap.units.map((u) => u.key)).toEqual(['F:record', '1']);
    expect(snap.units[0]).toMatchObject({ kind: 'slot', key: 'F:record', slotKey: 'record', sectionType: 'contractRecord' });
  });

  it('blok F:record bertipe contractRecord + butir F:record/<n> bertipe contractItem (§5.7)', () => {
    const fBlocks = snap.blocks.filter((b) => b.slotKey === 'record');
    expect(fBlocks.map((b) => [b.address, b.type, b.unitKey])).toEqual([
      ['F:record', 'contractRecord', 'F:record'],
      ['F:record/1', 'contractItem', 'F:record'],
      ['F:record/2', 'contractItem', 'F:record'],
    ]);
    expect(content.kind).toBe('agentWorkReport');
    expect(content.itemPids).toEqual(fBlocks.slice(1).map((b) => b.pid));
    expect(new Set(fBlocks.map((b) => b.pid)).size).toBe(3);
    expect((fBlocks[1].content as any)).toMatchObject({ key: 't_5943d415', status: 'done', statusLabel: 'Selesai' });
    expect((fBlocks[2].content as any)).toMatchObject({ key: 'DC-03', status: 'ready', statusLabel: 'Siap', dependsOn: ['DC-02'] });
  });

  it('tabel fakta: label dari registri C58, nilai status berlabel, waktu dinormalkan UTC', () => {
    const rows = content.facts.rows.map((row: any) => row.cells.map(cellText));
    const L = DEF.labels.fields;
    expect(rows).toEqual([
      [L.status, 'Selesai'],
      [L.owner, 'data-analyst'],
      [L.initiator, 'controller'],
      [L.taskRef, 'DC-02'],
      [L.reportedAt, '2026-10-30 12:30 UTC'],
      [L.phase, 'research → masterplan'],
      [L.cardIds, 't_249c6b84'],
    ]);
  });

  it('tabel butir/bukti/rujukan: kepala = kolom registri (urutan tetap, kolom kosong dibuang)', () => {
    const keep = (cols: readonly string[], drop: string[]) => cols.filter((c) => !drop.includes(c));
    expect(headerOf(content.items)).toEqual(keep(DEF.labels.itemColumns, ['Tenggat']));
    expect(headerOf(content.evidence)).toEqual(keep(DEF.labels.evidenceColumns, ['Baris', 'Butir', 'Catatan']));
    expect(headerOf(content.refs)).toEqual(keep(DEF.labels.refColumns, ['Revisi']));
    expect(content.items.rows.slice(1).map((row: any) => row.cells.map(cellText))).toEqual([
      ['t_5943d415', 'Kunci kosakata status dari korpus', 'Selesai', 'data-analyst', 'masterplan', ''],
      ['DC-03', 'Protokol metrik efisiensi', 'Siap', '', '', 'DC-02'],
    ]);
    expect(content.refs.rows[1].cells.map(cellText)).toEqual(['basis', 'cmvui0qun000qv11gtygb1mk9', 'p-8rj0w4aw6r']);
  });

  it('nilai agen = run harfiah (path bergaris-bawah tidak diurai md-lite)', () => {
    const refCell = content.evidence.rows[1].cells[1];
    expect(refCell.text).toBeUndefined();
    expect(refCell.runs).toEqual([{ t: 'docs/2026-10-22_doc_artifact_studio/masterplan/05_document_contract_specs.md', faceRole: 'mono' }]);
  });

  it('agen tidak mengirim label: payload sumber tetap tanpa medan label; label hanya di isi internal', () => {
    const src = (snap as any).source.sections.record;
    expect(src).toEqual(slotSubmission().payload);
    expect(JSON.stringify(src)).not.toContain('Penanggung jawab');
  });

  it('textPlain = proyeksi §5.7 (I57/I58)', () => {
    const p = slotSubmission().payload;
    expect(recordBlock.textPlain).toBe(contractRecordTextPlain(p));
    expect(recordBlock.textPlain).toContain('2026-10-30T12:30:00.000Z');
    expect(snap.blocks.find((b) => b.address === 'F:record/2')!.textPlain).toBe(contractItemTextPlain(p.items[1]));
  });

  it('baris M14-M17 sah; baris F:record membawa isi internal record', () => {
    expect(validateRows(r.rows)).toEqual([]);
    const row = r.rows.blocks.find((b) => b.address === 'F:record')!;
    expect(row.pid).toBe(recordBlock.pid);
    expect((row as any).internal).toMatchObject({ type: 'contractRecord', content: recordBlock.content, textPlain: recordBlock.textPlain });
  });
});

describe('determinisme', () => {
  it('compose dua kali dan dua penggabungan terpisah -> snapshotSha256 dan structureSha256 sama', () => {
    const a = buildReport();
    const b = buildReport();
    const params = defaultParams();
    const r1 = composeV2({ source: a.doc, skeleton: a.skeleton, tier: 'NOTA', params });
    const r2 = composeV2({ source: a.doc, skeleton: a.skeleton, tier: 'NOTA', params });
    const r3 = composeV2({ source: b.doc, skeleton: b.skeleton, tier: 'NOTA', params });
    expect(r2.snapshotSha256).toBe(r1.snapshotSha256);
    expect(r3.snapshotSha256).toBe(r1.snapshotSha256);
    expect(r3.structureSha256).toBe(r1.structureSha256);
  });
});

describe('jenis kontrak, placeholder, konteks', () => {
  it('slug templat tanpa entri C58 dan tanpa contractKind -> 422 BY_CONSTRUCTION_FAILED; contractKind eksplisit -> label sama', () => {
    const { skeleton, doc } = buildReport({ slug: 'laporan-salinan' });
    const err = catchEngine(() => composeV2({ source: doc, skeleton, tier: 'NOTA', params: defaultParams() }));
    expect(err.code).toBe('BY_CONSTRUCTION_FAILED');
    expect(err.details).toMatchObject({ checkId: 'CONTRACT_KIND', templateSlug: 'laporan-salinan' });
    const r = composeV2({ source: doc, skeleton, tier: 'NOTA', params: defaultParams(), contractKind: 'agentWorkReport' });
    expect((r.snapshot.blocks[0].content as any).facts.rows[0].cells[0].text).toBe(DEF.labels.fields.status);
    expect(storedComposeContext(r.snapshot)?.contractKind).toBe('agentWorkReport');
  });

  it('slot record kosong: render draf -> placeholder; snapshot tersimpan -> tanpa unit record', () => {
    const skeleton = skeletonInput(reportSlots());
    const doc = mergeSubmission(emptyReport(), chapterSubmission() as never, { skeleton, tier: 'NOTA', pids: seededPidAllocator('dc10') }).doc;
    const draft = composeV2({ source: doc, skeleton, tier: 'NOTA', params: defaultParams(), draft: true });
    expect(draft.snapshot.units[0]).toMatchObject({ key: 'F:record', placeholder: true, sectionType: 'contractRecord' });
    expect(draft.snapshot.blocks[0]).toMatchObject({ type: 'slotPlaceholder', address: null });
    const stored = composeV2({ source: doc, skeleton, tier: 'NOTA', params: defaultParams() });
    expect(stored.snapshot.units.map((u) => u.key)).toEqual(['1']);
    expect(stored.snapshot.skeleton.slots[0].state).toBe('EMPTY');
  });

  it('dokumen non-kontrak (E1 DATUM) tidak membawa blok kontrak maupun contractKind di konteks', () => {
    const skeleton = skeletonInput();
    const doc = mergeSubmission(
      emptyResolvedDoc({ template: { slug: 'datum-gsp', version: 1 }, meta: metaOf(e1().meta), mission: e1().mission, docKey: e1().docKey }),
      e1() as never,
      { skeleton, tier: 'TERBIT', pids: seededPidAllocator('dc10') },
    ).doc;
    const r = composeV2({ source: doc, skeleton, tier: 'TERBIT', params: defaultParams() });
    expect(r.snapshot.blocks.some((b) => b.type === 'contractRecord' || b.type === 'contractItem')).toBe(false);
    expect(Object.keys(storedComposeContext(r.snapshot)!)).not.toContain('contractKind');
  });
});
