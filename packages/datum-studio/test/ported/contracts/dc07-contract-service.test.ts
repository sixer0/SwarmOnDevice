// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/contracts/dc07-contract-service.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
// DC-07 — layanan kontrak (register 05 §5.6, §5.7, §5.8, §7.1-§7.2, §13.1-§13.2, §15 I54-I58, §17.1).
// Murni: reader tiruan untuk I55, tanpa DB. NV-01..NV-09 dicek terhadap skema (langkah 2) DAN I54
// (kecuali NV-09 DISPLAY_FIELD = skema saja); NV-05 + NV-10 = I54; NV-11/NV-12 = I55.
import { describe, expect, it } from '../_vitest';
import { STUDIO_ERROR_HTTP, StudioEngineError } from '@/lib/studio/contract/errors';
import type { ContractRecordPayloadV2 } from '@/lib/studio/contract/types/v2/contract';
import { validateV2Against } from '@/lib/studio/services/ingest/validate';
import {
  checkContractRecord,
  contractItemTextPlain,
  contractRecordTextPlain,
  projectContractRows,
  resolveContractRefs,
  type ContractRefReader,
  type ContractRefTargetDoc,
  type ContractRefTargetIdentity,
} from '@/lib/studio/services/contracts';

// ── Contoh register §5.8 (apa adanya) ───────────────────────────────────────
function payloadExample(): ContractRecordPayloadV2 {
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
    evidence: [
      { kind: 'file', ref: 'docs/2026-10-22_doc_artifact_studio/masterplan/05_document_contract_specs.md', bytes: 61234, sha256: '55d324b1' },
      { kind: 'command', ref: 'npx tsc --noEmit -p tsconfig.json', exitCode: 0 },
    ],
    items: [
      { key: 't_5943d415', title: { text: 'Kunci kosakata status dari korpus' }, status: 'done', owner: 'data-analyst', phase: 'masterplan' },
      { key: 'DC-03', title: { text: 'Protokol metrik efisiensi' }, status: 'ready', dependsOn: ['DC-02'] },
    ],
  };
}
function slotDoc(payload: unknown) {
  return {
    $schema: 'studio.slot/v2',
    target: { mission: { folder: '2026-10-30_hermes-retrial' }, docKey: 'laporan-kerja-dc02' },
    template: { slug: 'laporan-kerja-agen' },
    meta: { title: 'Laporan kerja DC-02 register document contract' },
    slot: 'record',
    payload,
  };
}

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- fixture bebas-bentuk
function mutated(fn: (p: Json) => void): ContractRecordPayloadV2 {
  const p = structuredClone(payloadExample()) as unknown as Json;
  fn(p);
  return p as unknown as ContractRecordPayloadV2;
}
const check = (p: ContractRecordPayloadV2) => checkContractRecord(p, 'agentWorkReport');

// ── Reader tiruan (baca saja) ───────────────────────────────────────────────
const TARGET: ContractRefTargetDoc = { id: 'cmvui0qun000qv11gtygb1mk9', docNumber: '003/GSP/KT/X/2026', currentRevisionNo: 3 };
const IDENTITIES: ContractRefTargetIdentity[] = [
  { documentId: TARGET.id, pid: 'p-8rj0w4aw6r', retiredRevisionNo: null },
  { documentId: TARGET.id, pid: 'p-retired001', retiredRevisionNo: 2 },
];
function fakeReader(): ContractRefReader & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async documentsByIds(ids) {
      calls.push('documentsByIds');
      return [TARGET].filter((d) => ids.includes(d.id));
    },
    async documentsByNumbers(nums) {
      calls.push('documentsByNumbers');
      return [TARGET].filter((d) => nums.includes(d.docNumber));
    },
    async identities(keys) {
      calls.push('identities');
      return IDENTITIES.filter((x) => keys.some((k) => k.documentId === x.documentId && k.pid === x.pid));
    },
  };
}
async function rejection(p: Promise<unknown>): Promise<StudioEngineError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof StudioEngineError) return e;
    throw e;
  }
  throw new Error('diharapkan melempar StudioEngineError');
}

// ── §5.8 contoh valid ───────────────────────────────────────────────────────
describe('§5.8 contoh valid', () => {
  it('lolos skema dan I54 tanpa isu maupun galat', () => {
    expect(validateV2Against('studio.slot/v2', slotDoc(payloadExample()))).toEqual([]);
    expect(check(payloadExample())).toEqual({ issues: [] });
  });
  it('I55 meresolusi rujukan contoh tanpa peringatan', async () => {
    const r = await resolveContractRefs(payloadExample().refs!, fakeReader());
    expect(r).toEqual({
      resolved: [{ position: 1, targetDocumentId: TARGET.id, targetPid: 'p-8rj0w4aw6r', targetRevisionNo: null, rel: 'basis' }],
      warnings: [],
    });
  });
});

// ── §17.1 NV-01..NV-12 ──────────────────────────────────────────────────────
describe('§17.1 NV-01..NV-12', () => {
  const SCHEMA_AND_SERVICE: Array<[string, (p: Json) => void, string, string]> = [
    ['NV-01', (p) => (p.status = 'running'), 'CONTRACT_ENUM', '/payload/status'],
    ['NV-02', (p) => (p.items[0].status = 'berjalan'), 'CONTRACT_ENUM', '/payload/items/0/status'],
    ['NV-03', (p) => (p.cardIds[0] = 't_249c6b8'), 'CONTRACT_PATTERN', '/payload/cardIds/0'],
    ['NV-04', (p) => (p.items[1].key = 'DC 03'), 'CONTRACT_PATTERN', '/payload/items/1/key'],
    ['NV-06', (p) => (p.due = '2026-11-02T10:00Z'), 'CONTRACT_DATE', '/payload/due'],
    ['NV-07', (p) => (p.refs[0].docNumber = '003/GSP/KT/X/2026'), 'CONTRACT_REF_TARGET', '/payload/refs/0'],
    ['NV-08', (p) => (p.refs[0].rel = 'cites'), 'CONTRACT_ENUM', '/payload/refs/0/rel'],
  ];
  it.each(SCHEMA_AND_SERVICE)('%s -> 400 SCHEMA_INVALID %s %s (skema dan I54 sepakat)', (_id, fn, checkId, pointer) => {
    const p = mutated(fn);
    expect(validateV2Against('studio.slot/v2', slotDoc(p)).map((i) => [i.checkId, i.pointer])).toEqual([[checkId, pointer]]);
    const r = check(p);
    expect(r.issues.map((i) => [i.checkId, i.pointer])).toEqual([[checkId, pointer]]);
    expect(r.error).toBeUndefined();
    expect(STUDIO_ERROR_HTTP.SCHEMA_INVALID).toBe(400);
  });

  it('NV-05 reportedAt 2026-02-30 -> lolos skema, I54 CONTRACT_DATE /payload/reportedAt', () => {
    const p = mutated((x) => (x.reportedAt = '2026-02-30'));
    expect(validateV2Against('studio.slot/v2', slotDoc(p))).toEqual([]);
    expect(check(p).issues.map((i) => [i.checkId, i.pointer])).toEqual([['CONTRACT_DATE', '/payload/reportedAt']]);
  });

  it('NV-09 items[0].label -> DISPLAY_FIELD /payload/items/0/label (skema; I54 tidak menambah isu)', () => {
    const p = mutated((x) => (x.items[0].label = 'Kunci'));
    expect(validateV2Against('studio.slot/v2', slotDoc(p)).map((i) => [i.checkId, i.pointer])).toEqual([['DISPLAY_FIELD', '/payload/items/0/label']]);
    expect(check(p)).toEqual({ issues: [] });
  });

  it('NV-10 kunci butir ganda -> 422 CONTRACT_ITEM_KEY_DUPLICATE positions [1, 2]', () => {
    const p = mutated((x) => (x.items[1].key = 't_5943d415'));
    expect(validateV2Against('studio.slot/v2', slotDoc(p))).toEqual([]);
    const r = check(p);
    expect(r.issues).toEqual([]);
    expect(r.error).toEqual({
      code: 'CONTRACT_ITEM_KEY_DUPLICATE',
      details: { pointer: '/payload/items/1/key', key: 't_5943d415', positions: [1, 2] },
    });
    expect(STUDIO_ERROR_HTTP.CONTRACT_ITEM_KEY_DUPLICATE).toBe(422);
  });

  it('NV-11 documentId tidak ada -> 422 CONTRACT_REF_NOT_FOUND reason DOCUMENT', async () => {
    const p = mutated((x) => (x.refs[0].documentId = 'cmzzzzzzzzzzzzzzzzzzzzzzz'));
    expect(check(p)).toEqual({ issues: [] });
    const e = await rejection(resolveContractRefs(p.refs!, fakeReader()));
    expect(e.code).toBe('CONTRACT_REF_NOT_FOUND');
    expect(e.httpStatus).toBe(422);
    expect(e.details).toEqual({ pointer: '/payload/refs/0', documentId: 'cmzzzzzzzzzzzzzzzzzzzzzzz', reason: 'DOCUMENT' });
  });

  it('NV-12 pid tidak pernah ada -> 422 CONTRACT_REF_PID_NOT_FOUND', async () => {
    const p = mutated((x) => (x.refs[0].pid = 'p-zzzzzzzzzz'));
    expect(check(p)).toEqual({ issues: [] });
    const e = await rejection(resolveContractRefs(p.refs!, fakeReader()));
    expect(e.code).toBe('CONTRACT_REF_PID_NOT_FOUND');
    expect(e.httpStatus).toBe(422);
    expect(e.details).toEqual({ pointer: '/payload/refs/0/pid', documentId: TARGET.id, pid: 'p-zzzzzzzzzz' });
  });
});

// ── I54 tambahan ────────────────────────────────────────────────────────────
describe('I54 checkContractRecord: aturan tambahan', () => {
  it('owner/initiator pola aktor, verdict set jenis, tanggal butir kalender, dependsOn pola', () => {
    const p = mutated((x) => {
      x.owner = 'Data-Analyst';
      x.initiator = '-user';
      x.verdict = 'OK';
      x.items[0].due = '2026-13-01';
      x.items[1].dependsOn = ['DC 02'];
      x.items[1].owner = 'X';
    });
    expect(check(p).issues.map((i) => [i.checkId, i.pointer])).toEqual([
      ['CONTRACT_ENUM', '/payload/verdict'],
      ['CONTRACT_PATTERN', '/payload/owner'],
      ['CONTRACT_PATTERN', '/payload/initiator'],
      ['CONTRACT_DATE', '/payload/items/0/due'],
      ['CONTRACT_PATTERN', '/payload/items/1/owner'],
      ['CONTRACT_PATTERN', '/payload/items/1/dependsOn/0'],
    ]);
  });
  it('29 Februari: sah di tahun kabisat, CONTRACT_DATE di tahun biasa', () => {
    expect(check(mutated((x) => (x.due = '2028-02-29'))).issues).toEqual([]);
    expect(check(mutated((x) => (x.due = '2027-02-29'))).issues.map((i) => i.pointer)).toEqual(['/payload/due']);
    expect(check(mutated((x) => (x.reportedAt = '2027-02-29T10:00Z'))).issues.map((i) => i.pointer)).toEqual(['/payload/reportedAt']);
  });
  it('bukti: line pada command / exitCode pada file -> CONTRACT_REF_TARGET di medan; sha256 pola', () => {
    const p = mutated((x) => {
      x.evidence[1].line = 3;
      x.evidence[0].exitCode = 1;
      x.evidence[0].sha256 = 'XYZ';
    });
    expect(check(p).issues.map((i) => [i.checkId, i.pointer])).toEqual([
      ['CONTRACT_REF_TARGET', '/payload/evidence/0/exitCode'],
      ['CONTRACT_PATTERN', '/payload/evidence/0/sha256'],
      ['CONTRACT_REF_TARGET', '/payload/evidence/1/line'],
    ]);
  });
  it('opsi pointer mengganti awalan (bentuk studio.doc/v2)', () => {
    const r = checkContractRecord(mutated((x) => (x.status = 'x')), 'agentWorkReport', { pointer: '/sections/record' });
    expect(r.issues.map((i) => i.pointer)).toEqual(['/sections/record/status']);
  });
});

// ── I55 tambahan ────────────────────────────────────────────────────────────
describe('I55 resolveContractRefs: docNumber, revisi, pid pensiun, batch', () => {
  it('docNumber + revisionNo sah + pid pensiun -> resolved + CW-01', async () => {
    const reader = fakeReader();
    const r = await resolveContractRefs(
      [
        { documentId: TARGET.id, rel: 'basis' },
        { docNumber: TARGET.docNumber, pid: 'p-retired001', revisionNo: 2, rel: 'evidence' },
      ],
      reader,
    );
    expect(r.resolved).toEqual([
      { position: 1, targetDocumentId: TARGET.id, targetPid: null, targetRevisionNo: null, rel: 'basis' },
      { position: 2, targetDocumentId: TARGET.id, targetPid: 'p-retired001', targetRevisionNo: 2, rel: 'evidence' },
    ]);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatchObject({ code: 'CONTRACT_REF_PID_RETIRED', pointer: '/payload/refs/1/pid', details: { retiredRevisionNo: 2 } });
    expect(reader.calls.sort()).toEqual(['documentsByIds', 'documentsByNumbers', 'identities']);
  });
  it('revisionNo > revisi terkini -> EC25 reason REVISION', async () => {
    const e = await rejection(resolveContractRefs([{ documentId: TARGET.id, revisionNo: 4, rel: 'basis' }], fakeReader()));
    expect(e.code).toBe('CONTRACT_REF_NOT_FOUND');
    expect(e.details).toMatchObject({ pointer: '/payload/refs/0/revisionNo', reason: 'REVISION', currentRevisionNo: 3 });
  });
  it('docNumber tidak ada -> EC25 reason DOCUMENT dengan docNumber', async () => {
    const e = await rejection(resolveContractRefs([{ docNumber: 'TIDAK/ADA', rel: 'output' }], fakeReader()));
    expect(e.details).toEqual({ pointer: '/payload/refs/0', docNumber: 'TIDAK/ADA', reason: 'DOCUMENT' });
  });
  it('refs kosong -> tanpa panggilan reader', async () => {
    const reader = fakeReader();
    expect(await resolveContractRefs([], reader)).toEqual({ resolved: [], warnings: [] });
    expect(reader.calls).toEqual([]);
  });
});

// ── I56 proyeksi + I57/I58 teks ─────────────────────────────────────────────
describe('I56 projectContractRows (§7.1 M19-M21, §7.2 MX09)', () => {
  const ctx = (resolvedRefs: Awaited<ReturnType<typeof resolveContractRefs>>['resolved']) => ({
    documentId: 'cmdoc00000000000000000001',
    revisionNo: 2,
    revisionId: 'cmrev00000000000000000001',
    docSectionId: 'cmsec00000000000000000001',
    kind: 'agentWorkReport' as const,
    itemPids: ['p-item000001', 'p-item000002'],
    resolvedRefs,
  });

  it('baris M19/M20/M21 + cermin sesuai register, deterministik', async () => {
    const p = { ...payloadExample(), due: '2026-11-02' };
    const { resolved } = await resolveContractRefs(p.refs!, fakeReader());
    const a = projectContractRows(p, ctx(resolved));
    const b = projectContractRows(structuredClone(p), ctx(structuredClone(resolved)));
    expect(b).toEqual(a);

    expect(a.record).toEqual({
      revisionId: 'cmrev00000000000000000001',
      docSectionId: 'cmsec00000000000000000001',
      documentId: 'cmdoc00000000000000000001',
      revisionNo: 2,
      contractKind: 'agentWorkReport',
      status: 'complete',
      verdict: null,
      owner: 'data-analyst',
      initiator: 'controller',
      taskRef: 'DC-02',
      reportedAt: new Date('2026-10-30T12:30:00.000Z'),
      dueOn: new Date('2026-11-02T00:00:00.000Z'),
      phaseFrom: 'research',
      phaseTo: 'masterplan',
      cardIds: ['t_249c6b84'],
      itemCount: 2,
    });
    expect(a.items).toEqual([
      {
        documentId: 'cmdoc00000000000000000001', revisionNo: 2, itemKey: 't_5943d415', position: 1, pid: 'p-item000001',
        status: 'done', owner: 'data-analyst', phase: 'masterplan', dueOn: null, dependsOn: [], titlePlain: 'Kunci kosakata status dari korpus',
      },
      {
        documentId: 'cmdoc00000000000000000001', revisionNo: 2, itemKey: 'DC-03', position: 2, pid: 'p-item000002',
        status: 'ready', owner: null, phase: null, dueOn: null, dependsOn: ['DC-02'], titlePlain: 'Protokol metrik efisiensi',
      },
    ]);
    expect(a.refs).toEqual([
      {
        fromDocumentId: 'cmdoc00000000000000000001', revisionNo: 2, position: 1, rel: 'basis',
        targetDocumentId: TARGET.id, targetPid: 'p-8rj0w4aw6r', targetRevisionNo: null,
      },
    ]);
    // MX09: contractCardIds = gabungan terurut unik cardIds ∪ items[].key yang cocok C34 ('DC-03' tidak).
    expect(a.mirror).toEqual({
      contractKind: 'agentWorkReport',
      contractStatus: 'complete',
      contractOwner: 'data-analyst',
      contractTaskRef: 'DC-02',
      contractDueOn: new Date('2026-11-02T00:00:00.000Z'),
      contractCardIds: ['t_249c6b84', 't_5943d415'],
    });
  });

  it('payload minimum: tanpa butir/rujukan, reportedAt tanggal saja = tengah malam UTC', () => {
    const p: ContractRecordPayloadV2 = { type: 'contractRecord', status: 'draft', reportedAt: '2026-10-30' };
    const r = projectContractRows(p, { ...ctx([]), itemPids: [] });
    expect(r.record.reportedAt.toISOString()).toBe('2026-10-30T00:00:00.000Z');
    expect(r.record.itemCount).toBe(0);
    expect(r.items).toEqual([]);
    expect(r.refs).toEqual([]);
    expect(r.mirror).toEqual({ contractKind: 'agentWorkReport', contractStatus: 'draft', contractOwner: null, contractTaskRef: null, contractDueOn: null, contractCardIds: [] });
  });

  it('itemPids tidak sepadan jumlah butir -> melempar', () => {
    expect(() => projectContractRows(payloadExample(), { ...ctx([]), itemPids: ['p-only00001'] })).toThrow(/itemPids/);
  });
});

describe('I57/I58 teks polos (§5.7)', () => {
  it('I57 catatan: urutan tetap, UTC, ref rel target#pid@rev, bukti kind ref sha', () => {
    const p = { ...payloadExample(), refs: [...payloadExample().refs!, { docNumber: '003/GSP/KT/X/2026', revisionNo: 2, rel: 'evidence' as const }] };
    expect(contractRecordTextPlain(p)).toBe(
      [
        'complete data-analyst controller DC-02 2026-10-30T12:30:00.000Z research->masterplan t_249c6b84',
        'basis cmvui0qun000qv11gtygb1mk9#p-8rj0w4aw6r',
        'evidence 003/GSP/KT/X/2026@2',
        'file docs/2026-10-22_doc_artifact_studio/masterplan/05_document_contract_specs.md 55d324b1',
        'command npx tsc --noEmit -p tsconfig.json',
      ].join(' '),
    );
  });
  it('I57 phase tanpa from = to saja', () => {
    expect(contractRecordTextPlain({ type: 'contractRecord', status: 'blocked', reportedAt: '2026-10-30', phase: { to: 'impl' } })).toBe(
      'blocked 2026-10-30T00:00:00.000Z impl',
    );
  });
  it('I58 butir: key status title owner phase due dependsOn', () => {
    const [i0, i1] = payloadExample().items!;
    expect(contractItemTextPlain(i0)).toBe('t_5943d415 done Kunci kosakata status dari korpus data-analyst masterplan');
    expect(contractItemTextPlain({ ...i1, due: '2026-11-02' })).toBe('DC-03 ready Protokol metrik efisiensi 2026-11-02 DC-02');
    expect(contractItemTextPlain({ key: 'K1', status: 'todo', title: { runs: [{ t: 'Satu ' }, { t: 'dua', strong: true }] } })).toBe('K1 todo Satu dua');
  });
});
