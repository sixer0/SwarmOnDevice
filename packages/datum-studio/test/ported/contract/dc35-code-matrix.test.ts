// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/contract/dc35-code-matrix.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
// DC-35 (BA-35) — matriks kode register 05 §13 (+ §5.4, §5.5, §11.2): SETIAP kode galat, checkId,
// medan tampilan, peringatan, dan isu draf baru punya >= 1 kasus negatif yang MEMICUNYA lewat
// antarmuka publik (validator v2, I54, I55, I63, I64, I68, compose, CH-06). Varian sengaja berbeda
// dari kasus NV/DX yang sudah ada (dc05/dc07/dc21) agar matriks menambah cakupan, bukan menyalin.
// Daftar kode harapan ditulis literal dari register (sumber independen), lalu dicocokkan dua arah:
// register -> enum repo, dan register -> kasus di berkas ini. Murni: tanpa DB, tanpa jaringan.
import { describe, expect, it } from '../_vitest';
import type { ChartV2 } from '@/lib/studio/contract';
import {
  CONTRACT_WARNING_CODES,
  DRAFT_ISSUE_CODES,
  DRAFT_LIMIT_REASONS,
  SCHEMA_V2_CHECK_IDS,
  STUDIO_ERROR_CODES,
} from '@/lib/studio/contract/enums';
import { STUDIO_ERROR_HTTP, StudioEngineError } from '@/lib/studio/contract/errors';
import type { ContractRecordPayloadV2 } from '@/lib/studio/contract/types/v2/contract';
import { CHART_CUSTOM_FORM_IDS, resolveChartCustom } from '@/lib/studio/registry/charts';
import { contractRecordSkeletonIssues } from '@/lib/studio/registry/slots';
import { mapBlock, type BlockCtx } from '@/lib/studio/services/compose/blocks';
import {
  checkContractRecord,
  resolveContractRefs,
  type ContractRefReader,
  type ContractRefTargetDoc,
  type ContractRefTargetIdentity,
} from '@/lib/studio/services/contracts';
import { checkDraftLimits, draftBasisRevision, extractDraft, staleBasisIssue } from '@/lib/studio/services/draft';
import { markdownToContract } from '@/lib/studio/services/import/contract';
import { validateV2Against } from '@/lib/studio/services/ingest/validate';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- fixture bebas-bentuk

// ── Kode register (literal, sumber independen) ──────────────────────────────
const REGISTER_ERROR_CODES = {
  CONTRACT_REF_NOT_FOUND: 422, // EC25
  CONTRACT_REF_PID_NOT_FOUND: 422, // EC26
  CONTRACT_ITEM_KEY_DUPLICATE: 422, // EC27
  CHART_CUSTOM_FORM_UNSUPPORTED: 422, // EC28
} as const;
const REGISTER_CHECK_IDS = ['CONTRACT_ENUM', 'CONTRACT_PATTERN', 'CONTRACT_DATE', 'CONTRACT_REF_TARGET', 'CHART_CUSTOM_FORM', 'SKELETON_CONTRACT_RECORD'];
const REGISTER_DISPLAY_FIELDS = ['DF-72', 'DF-73'];
const REGISTER_WARNINGS = ['CONTRACT_REF_PID_RETIRED', 'CONTRACT_STATUS_UNMAPPED', 'CONTRACT_HEADING_UNMAPPED', 'CONTRACT_FIELD_UNMAPPED'];
const REGISTER_DRAFT_ISSUES = [
  'DRAFT_NO_JSON_BLOCK',
  'DRAFT_FENCE_UNCLOSED',
  'DRAFT_JSON_MALFORMED',
  'DRAFT_BLOCK_NOT_OBJECT',
  'DRAFT_SCHEMA_UNKNOWN',
  'DRAFT_HEADER_INCOMPLETE',
  'DRAFT_BASIS_INVALID',
  'DRAFT_BASIS_STALE',
];
const REGISTER_DRAFT_LIMITS = ['DRAFT_TOO_LONG', 'DRAFT_TOO_MANY_BLOCKS'];
const REGISTER_ALL = [
  ...Object.keys(REGISTER_ERROR_CODES),
  ...REGISTER_CHECK_IDS,
  ...REGISTER_DISPLAY_FIELDS,
  ...REGISTER_WARNINGS,
  ...REGISTER_DRAFT_ISSUES,
  ...REGISTER_DRAFT_LIMITS,
];

// ── Fixture: contoh slot register §5.8 ──────────────────────────────────────
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
function mutated(fn: (p: Json) => void): Json {
  const p = structuredClone(payloadExample()) as unknown as Json;
  fn(p);
  return p;
}
const slotDoc = (payload: unknown) => ({
  $schema: 'studio.slot/v2',
  target: { mission: { folder: '2026-10-30_hermes-retrial' }, docKey: 'laporan-kerja-dc02' },
  template: { slug: 'laporan-kerja-agen' },
  meta: { title: 'Laporan kerja DC-02 register document contract' },
  slot: 'record',
  payload,
});
const chapterDoc = (blocks: unknown[]) => ({
  $schema: 'studio.chapter/v2',
  target: { mission: { folder: '2026-10-30_hermes-retrial' }, docKey: 'laporan-kerja-dc02' },
  chapter: { key: '1', title: { text: 'Ringkasan' }, sections: [{ title: { text: 'Hasil' }, blocks }] },
});
const slotIssues = (p: unknown) => validateV2Against('studio.slot/v2', slotDoc(p)).map((i) => [i.checkId, i.pointer]);
const chapterIssues = (blocks: unknown[]) => validateV2Against('studio.chapter/v2', chapterDoc(blocks)).map((i) => [i.checkId, i.pointer]);
const CHART_DATA = { shape: 'categorical', points: [{ label: 'Alfa', value: 1 }, { label: 'Bravo', value: 2 }] };
const chartBlock = (extra: Json) => ({ type: 'chart', caption: { text: 'Grafik uji' }, source: { text: 'Sumber uji DC-35, 2026.' }, data: CHART_DATA, ...extra });

// ── Reader I55 tiruan (baca saja) ───────────────────────────────────────────
const TARGET: ContractRefTargetDoc = { id: 'cmvui0qun000qv11gtygb1mk9', docNumber: '003/GSP/KT/X/2026', currentRevisionNo: 5 };
const IDENTITIES: ContractRefTargetIdentity[] = [
  { documentId: TARGET.id, pid: 'p-8rj0w4aw6r', retiredRevisionNo: null },
  { documentId: TARGET.id, pid: 'p-pensiun0001', retiredRevisionNo: 4 },
];
const reader: ContractRefReader = {
  async documentsByIds(ids) {
    return [TARGET].filter((d) => ids.includes(d.id));
  },
  async documentsByNumbers(nums) {
    return [TARGET].filter((d) => nums.includes(d.docNumber));
  },
  async identities(keys) {
    return IDENTITIES.filter((x) => keys.some((k) => k.documentId === x.documentId && k.pid === x.pid));
  },
};
async function rejection(p: Promise<unknown>): Promise<StudioEngineError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof StudioEngineError) return e;
    throw e;
  }
  throw new Error('diharapkan melempar StudioEngineError, ternyata tidak');
}
function thrown(fn: () => unknown): StudioEngineError {
  try {
    fn();
  } catch (e) {
    if (e instanceof StudioEngineError) return e;
    throw e;
  }
  throw new Error('diharapkan melempar StudioEngineError, ternyata tidak');
}

// ── Fixture draf ────────────────────────────────────────────────────────────
const md = (...lines: string[]) => lines.join('\n');
const HEAD = ['# DRAF Laporan kerja DC-35', 'tujuan: matriks kode', 'langkah-berikut: kirim slot record', 'basis: baru'];
const SLOT_BLOCK = ['```json', '{ "$schema": "studio.slot/v2", "slot": "record", "payload": { "type": "contractRecord", "status": "partial", "reportedAt": "2026-10-30" } }', '```'];
const draftCodes = (s: string) => extractDraft(s).issues.map((i) => [i.code, i.severity, i.line ?? null]);
const BLOCK_CTX: BlockCtx = { glyphs: new Set<string>(), params: {}, classification: 'TERBATAS', artifactLabel: 'Gambar 1.1' };

interface MatrixCase {
  code: string;
  id: string;
  what: string;
  run: () => void | Promise<void>;
}

const CASES: MatrixCase[] = [
  // ── §13.1 kode galat HTTP ─────────────────────────────────────────────────
  {
    code: 'CONTRACT_REF_NOT_FOUND',
    id: 'EC25',
    what: 'docNumber rujukan tidak dikenal -> 422 reason DOCUMENT',
    run: async () => {
      const e = await rejection(resolveContractRefs([{ docNumber: '999/GSP/KT/X/2026', rel: 'basis' }], reader));
      expect([e.code, e.httpStatus]).toEqual(['CONTRACT_REF_NOT_FOUND', 422]);
      expect(e.details).toMatchObject({ pointer: '/payload/refs/0', reason: 'DOCUMENT' });
    },
  },
  {
    code: 'CONTRACT_REF_NOT_FOUND',
    id: 'EC25',
    what: 'revisionNo 6 > revisi terkini 5 (rujukan kedua) -> 422 reason REVISION',
    run: async () => {
      const refs = [
        { documentId: TARGET.id, rel: 'basis' as const },
        { documentId: TARGET.id, revisionNo: 6, rel: 'output' as const },
      ];
      const e = await rejection(resolveContractRefs(refs, reader));
      expect([e.code, e.httpStatus]).toEqual(['CONTRACT_REF_NOT_FOUND', 422]);
      expect(e.details).toMatchObject({ pointer: '/payload/refs/1/revisionNo', reason: 'REVISION', currentRevisionNo: 5 });
    },
  },
  {
    code: 'CONTRACT_REF_PID_NOT_FOUND',
    id: 'EC26',
    what: 'pid tak pernah ada (lewat docNumber) -> 422 berpointer /pid',
    run: async () => {
      const e = await rejection(resolveContractRefs([{ docNumber: TARGET.docNumber, pid: 'p-tidakada01', rel: 'evidence' }], reader));
      expect([e.code, e.httpStatus]).toEqual(['CONTRACT_REF_PID_NOT_FOUND', 422]);
      expect(e.details).toMatchObject({ pointer: '/payload/refs/0/pid', documentId: TARGET.id, pid: 'p-tidakada01' });
    },
  },
  {
    code: 'CONTRACT_ITEM_KEY_DUPLICATE',
    id: 'EC27',
    what: 'tiga butir, kunci butir 1 dan 3 sama -> positions [1, 3]',
    run: () => {
      const p = mutated((x) => x.items.push({ key: 't_5943d415', title: { text: 'Ulangan' }, status: 'todo' }));
      expect(slotIssues(p)).toEqual([]);
      const r = checkContractRecord(p as unknown as ContractRecordPayloadV2, 'agentWorkReport');
      expect(r.issues).toEqual([]);
      expect(r.error?.code).toBe('CONTRACT_ITEM_KEY_DUPLICATE');
      expect(r.error?.details).toMatchObject({ key: 't_5943d415', positions: [1, 3] });
    },
  },
  {
    code: 'CHART_CUSTOM_FORM_UNSUPPORTED',
    id: 'EC28',
    what: 'line horizontal x series lolos skema, ditolak compose 422 dengan supported CU-01..CU-09',
    run: () => {
      const form = { mark: 'line', orientation: 'horizontal' };
      const data = { shape: 'series', categories: ['Q1', 'Q2'], series: [{ name: 'A', values: [1, 2] }] };
      expect(chapterIssues([chartBlock({ code: 'custom', form, data })])).toEqual([]);
      expect(resolveChartCustom(form as never, 'series')).toBeNull();
      const block = { type: 'chart', code: 'custom', form, data, caption: { runs: [{ t: 'Grafik' }] }, source: { runs: [{ t: 'Sumber' }] } } as unknown as ChartV2;
      const e = thrown(() => mapBlock(block, 'p-1', BLOCK_CTX));
      expect([e.code, e.httpStatus]).toEqual(['CHART_CUSTOM_FORM_UNSUPPORTED', 422]);
      expect(e.details).toMatchObject({ dataShape: 'series', supported: [...CHART_CUSTOM_FORM_IDS] });
    },
  },
  // ── §5.4 checkId SCHEMA_INVALID ───────────────────────────────────────────
  {
    code: 'CONTRACT_ENUM',
    id: 'CH-01',
    what: 'evidence[1] = { kind "url" } (di luar E49)',
    run: () =>
      expect(slotIssues(mutated((x) => (x.evidence[1] = { kind: 'url', ref: 'https://contoh.test/a' })))).toEqual([['CONTRACT_ENUM', '/payload/evidence/1/kind']]),
  },
  {
    code: 'CONTRACT_ENUM',
    id: 'CH-01',
    what: 'verdict "PARTIAL" (sengaja tanpa alias, E47)',
    run: () => expect(slotIssues(mutated((x) => (x.verdict = 'PARTIAL')))).toEqual([['CONTRACT_ENUM', '/payload/verdict']]),
  },
  {
    code: 'CONTRACT_PATTERN',
    id: 'CH-02',
    what: 'owner berhuruf besar melanggar C36',
    run: () => expect(slotIssues(mutated((x) => (x.owner = 'Data-Analyst')))).toEqual([['CONTRACT_PATTERN', '/payload/owner']]),
  },
  {
    code: 'CONTRACT_PATTERN',
    id: 'CH-02',
    what: 'evidence[0].sha256 7 heksa melanggar C38',
    run: () => expect(slotIssues(mutated((x) => (x.evidence[0].sha256 = '55d324b')))).toEqual([['CONTRACT_PATTERN', '/payload/evidence/0/sha256']]),
  },
  {
    code: 'CONTRACT_DATE',
    id: 'CH-03',
    what: 'items[1].due bulan 13 (pola)',
    run: () => expect(slotIssues(mutated((x) => (x.items[1].due = '2026-13-01')))).toEqual([['CONTRACT_DATE', '/payload/items/1/due']]),
  },
  {
    code: 'CONTRACT_DATE',
    id: 'CH-03',
    what: 'reportedAt 2025-02-29 (bukan kabisat) lolos pola, ditolak I54',
    run: () => {
      const p = mutated((x) => (x.reportedAt = '2025-02-29T08:00+07:00'));
      expect(slotIssues(p)).toEqual([]);
      const r = checkContractRecord(p as unknown as ContractRecordPayloadV2, 'agentWorkReport');
      expect(r.issues.map((i) => [i.checkId, i.pointer])).toEqual([['CONTRACT_DATE', '/payload/reportedAt']]);
    },
  },
  {
    code: 'CONTRACT_REF_TARGET',
    id: 'CH-04',
    what: 'refs[0] hanya pid + rel (tanpa sasaran)',
    run: () => expect(slotIssues(mutated((x) => (x.refs[0] = { pid: 'p-8rj0w4aw6r', rel: 'basis' })))).toEqual([['CONTRACT_REF_TARGET', '/payload/refs/0']]),
  },
  {
    code: 'CHART_CUSTOM_FORM',
    id: 'CH-05',
    what: 'custom + artifactId -> /artifactId',
    run: () => {
      const issues = chapterIssues([chartBlock({ code: 'custom', form: { mark: 'bar' }, artifactId: 'cmvui0qun000qv11gtygb1mk9' })]);
      expect(issues).toContainEqual(['CHART_CUSTOM_FORM', '/chapter/sections/0/blocks/0/artifactId']);
      expect(issues.every(([c]) => c === 'CHART_CUSTOM_FORM')).toBe(true);
    },
  },
  {
    code: 'SKELETON_CONTRACT_RECORD',
    id: 'CH-06',
    what: 'kerangka tanpa contractKind + dua slot contractRecord + berulang -> tiga alasan',
    run: () => {
      const slots = [
        { sectionType: 'chapter', repeatable: true },
        { sectionType: 'contractRecord', repeatable: false },
        { sectionType: 'contractRecord', repeatable: true },
      ];
      const issues = contractRecordSkeletonIssues(slots, undefined);
      expect(issues.map((i) => [i.checkId, i.pointer, i.keyword])).toEqual([
        ['SKELETON_CONTRACT_RECORD', '/template/skeleton/slots/1', 'dependentRequired'],
        ['SKELETON_CONTRACT_RECORD', '/template/skeleton/slots/2', 'dependentRequired'],
        ['SKELETON_CONTRACT_RECORD', '/template/skeleton/slots/2', 'maxContains'],
        ['SKELETON_CONTRACT_RECORD', '/template/skeleton/slots/2', 'const'],
      ]);
    },
  },
  // ── §5.5 medan tampilan ───────────────────────────────────────────────────
  {
    code: 'DF-72',
    id: 'DF-72',
    what: 'payload.columns dan refs[0].heading -> DISPLAY_FIELD',
    run: () => {
      const p = mutated((x) => {
        x.columns = ['key', 'status'];
        x.refs[0].heading = 'Rujukan';
      });
      expect(slotIssues(p).sort()).toEqual([
        ['DISPLAY_FIELD', '/payload/columns'],
        ['DISPLAY_FIELD', '/payload/refs/0/heading'],
      ]);
    },
  },
  {
    code: 'DF-73',
    id: 'DF-73',
    what: 'form.width pada custom -> DISPLAY_FIELD',
    run: () =>
      expect(chapterIssues([chartBlock({ code: 'custom', form: { mark: 'area', width: 120 } })])).toEqual([
        ['DISPLAY_FIELD', '/chapter/sections/0/blocks/0/form/width'],
      ]),
  },
  // ── §13.2 peringatan kontrak ──────────────────────────────────────────────
  {
    code: 'CONTRACT_REF_PID_RETIRED',
    id: 'CW-01',
    what: 'pid pensiun di rev4 -> diterima + peringatan',
    run: async () => {
      const r = await resolveContractRefs([{ documentId: TARGET.id, pid: 'p-pensiun0001', rel: 'supersedes' }], reader);
      expect(r.resolved).toHaveLength(1);
      expect(r.warnings).toEqual([expect.objectContaining({ code: 'CONTRACT_REF_PID_RETIRED', pointer: '/payload/refs/0/pid' })]);
    },
  },
  {
    code: 'CONTRACT_STATUS_UNMAPPED',
    id: 'CW-02',
    what: 'status laporan "PARKED" (tanpa alias) + --status: peringatan scope record',
    run: () => {
      const r = markdownToContract(md('# Laporan', '', 'Status: PARKED', 'Date: 2026-10-30', '', '## Ringkasan', '', 'Isi.', ''), {
        kind: 'agentWorkReport',
        status: 'blocked',
      });
      expect(r.doc.sections!.record).toMatchObject({ status: 'blocked' });
      expect(r.report.warnings).toEqual([expect.objectContaining({ code: 'CONTRACT_STATUS_UNMAPPED', line: 3, details: expect.objectContaining({ scope: 'record' }) })]);
    },
  },
  {
    code: 'CONTRACT_HEADING_UNMAPPED',
    id: 'CW-03',
    what: 'judul "## Lampiran mentah" -> bab tambahan kunci 6',
    run: () => {
      const r = markdownToContract(md('# Laporan', '', 'Status: complete', 'Date: 2026-10-30', '', '## Lampiran mentah', '', 'Data.', ''), { kind: 'agentWorkReport' });
      expect(r.report.warnings.map((w) => [w.code, w.line])).toEqual([['CONTRACT_HEADING_UNMAPPED', 6]]);
      const chapters = (r.doc.sections!.content as Json).chapters as Json[];
      expect(chapters.map((c) => c.key)).toContain('6');
    },
  },
  {
    code: 'CONTRACT_FIELD_UNMAPPED',
    id: 'CW-04',
    what: 'kunci kepala "reviewer" -> peringatan, teks tetap',
    run: () => {
      const r = markdownToContract(md('# Laporan', '', 'Status: complete', 'Date: 2026-10-30', 'Reviewer: gsp-thinker', '', '## Ringkasan', '', 'Isi.', ''), {
        kind: 'agentWorkReport',
      });
      expect(r.report.warnings.map((w) => [w.code, w.line])).toEqual([['CONTRACT_FIELD_UNMAPPED', 5]]);
      expect(JSON.stringify(r.doc)).toContain('gsp-thinker');
    },
  },
  // ── §11.2 isu draf (E55) ──────────────────────────────────────────────────
  {
    code: 'DRAFT_NO_JSON_BLOCK',
    id: 'DR-01',
    what: 'hanya pagar ```JSON (huruf besar) -> bukan blok json',
    run: () => expect(draftCodes(md(...HEAD, '', '```JSON', '{}', '```', ''))).toEqual([['DRAFT_NO_JSON_BLOCK', 'error', null]]),
  },
  {
    code: 'DRAFT_FENCE_UNCLOSED',
    id: 'DR-02',
    what: 'blok kedua tanpa penutup sesudah blok sah -> baris pembuka 9',
    run: () => expect(draftCodes(md(...HEAD, '', ...SLOT_BLOCK, '```json', '{ "$schema": "studio.chapter/v2" }', ''))).toEqual([['DRAFT_FENCE_UNCLOSED', 'error', 9]]),
  },
  {
    code: 'DRAFT_JSON_MALFORMED',
    id: 'DR-03',
    what: 'koma ekor di baris MD ke-8',
    run: () => expect(draftCodes(md(...HEAD, '', '```json', '{ "$schema": "studio.slot/v2",', '  "slot": "record", }', '```', ''))).toEqual([['DRAFT_JSON_MALFORMED', 'error', 8]]),
  },
  {
    code: 'DRAFT_BLOCK_NOT_OBJECT',
    id: 'DR-04',
    what: 'blok berisi string JSON',
    run: () => expect(draftCodes(md(...HEAD, '', '```json', '"studio.slot/v2"', '```', ''))).toEqual([['DRAFT_BLOCK_NOT_OBJECT', 'error', 7]]),
  },
  {
    code: 'DRAFT_SCHEMA_UNKNOWN',
    id: 'DR-05',
    what: '$schema studio.doc/v1 (v1 bukan anggota C57)',
    run: () => expect(draftCodes(md(...HEAD, '', '```json', '{ "$schema": "studio.doc/v1" }', '```', ''))).toEqual([['DRAFT_SCHEMA_UNKNOWN', 'error', 6]]),
  },
  {
    code: 'DRAFT_HEADER_INCOMPLETE',
    id: 'DR-06',
    what: 'tanpa judul # dan tanpa langkah-berikut -> warning',
    run: () => {
      const ex = extractDraft(md('tujuan: t', 'basis: baru', '', ...SLOT_BLOCK, ''));
      expect(ex.issues.map((i) => [i.code, i.severity])).toEqual([['DRAFT_HEADER_INCOMPLETE', 'warning']]);
      expect(ex.issues[0].message).toMatch(/judul.*langkah-berikut/);
      expect(ex.header).toEqual({ title: null, tujuan: 't', langkahBerikut: null, basis: 'baru' });
    },
  },
  {
    code: 'DRAFT_BASIS_INVALID',
    id: 'DR-07',
    what: 'basis "@rev0" (revisi 0 di luar C56) -> warning di baris basis',
    run: () =>
      expect(draftCodes(md(HEAD[0], HEAD[1], HEAD[2], 'basis: cmvui0qun000qv11gtygb1mk9@rev0', '', ...SLOT_BLOCK, ''))).toEqual([['DRAFT_BASIS_INVALID', 'warning', 4]]),
  },
  {
    code: 'DRAFT_BASIS_STALE',
    id: 'DR-08',
    what: 'basis rev3 < revisi terkini 4 -> warning di baris basis',
    run: () => {
      const text = md(HEAD[0], HEAD[1], HEAD[2], 'basis: cmvui0qun000qv11gtygb1mk9@rev3', '', ...SLOT_BLOCK, '');
      const ex = extractDraft(text);
      const basis = draftBasisRevision(ex);
      expect(basis).toEqual({ documentId: 'cmvui0qun000qv11gtygb1mk9', revisionNo: 3 });
      expect(staleBasisIssue(text, ex, basis!, 4)).toMatchObject({ code: 'DRAFT_BASIS_STALE', severity: 'warning', line: 4 });
      expect(staleBasisIssue(text, ex, basis!, 3)).toBeNull();
    },
  },
  // ── §11.2 alasan 413 (E56) ────────────────────────────────────────────────
  {
    code: 'DRAFT_TOO_LONG',
    id: 'DR-09',
    what: 'bodyBytes 4194305 (C54 + 1)',
    run: () => {
      expect(checkDraftLimits('x', { bodyBytes: 4194305 })).toBe('DRAFT_TOO_LONG');
      expect(checkDraftLimits('x', { bodyBytes: 4194304 })).toBeNull();
    },
  },
  {
    code: 'DRAFT_TOO_MANY_BLOCKS',
    id: 'DR-10',
    what: '21 pagar json (yang terakhir tanpa penutup ikut dihitung)',
    run: () => {
      const blocks = Array.from({ length: 20 }, () => SLOT_BLOCK.join('\n'));
      expect(checkDraftLimits(md(...HEAD, '', ...blocks, ''))).toBeNull();
      expect(checkDraftLimits(md(...HEAD, '', ...blocks, '```json', '{'))).toBe('DRAFT_TOO_MANY_BLOCKS');
    },
  },
];

describe('DC-35 daftar kode register = enum repo', () => {
  it('EC25-EC28 ada di STUDIO_ERROR_CODES dengan HTTP register', () => {
    for (const [code, http] of Object.entries(REGISTER_ERROR_CODES)) {
      expect(STUDIO_ERROR_CODES as readonly string[]).toContain(code);
      expect(STUDIO_ERROR_HTTP[code as keyof typeof STUDIO_ERROR_HTTP]).toBe(http);
    }
  });
  it('CH-01..CH-06 = 6 checkId terakhir E41', () => {
    expect(SCHEMA_V2_CHECK_IDS.slice(-6)).toEqual(REGISTER_CHECK_IDS);
  });
  it('E54 = CW-01..CW-04; E55 = DR-01..DR-08; E56 = DR-09, DR-10', () => {
    expect([...CONTRACT_WARNING_CODES]).toEqual(REGISTER_WARNINGS);
    expect([...DRAFT_ISSUE_CODES]).toEqual(REGISTER_DRAFT_ISSUES);
    expect([...DRAFT_LIMIT_REASONS]).toEqual(REGISTER_DRAFT_LIMITS);
  });
});

describe('DC-35 matriks: setiap kode register punya >= 1 kasus negatif', () => {
  it(`${REGISTER_ALL.length} kode register tercakup, tanpa kasus berkode asing`, () => {
    const covered = new Set(CASES.map((c) => c.code));
    expect(REGISTER_ALL.filter((c) => !covered.has(c))).toEqual([]);
    expect([...covered].filter((c) => !REGISTER_ALL.includes(c))).toEqual([]);
    expect(REGISTER_ALL).toHaveLength(26);
  });
  for (const c of CASES) {
    it(`${c.id} ${c.code}: ${c.what}`, c.run);
  }
});
