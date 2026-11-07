// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/contract/dc05-contract-delta.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
// DC-05 (D-363): delta kontrak v2 document contract.
// Sumber ekspektasi = register masterplan/05_document_contract_specs.md (literal, BUKAN keluaran kode):
// §5.3 skema, §5.4 CH-01..CH-06, §5.5 DF-72/DF-73, §5.8 contoh valid, §13.1 EC25-EC28,
// §13.3 hitungan, §14.1 C34-C57, §14.2 E44-E57, §17.1 NV-01..NV-12, AM-06.
// Seam: `validateV2Against` (ajv bersama + pemeta tunggal `classifySchemaV2Errors`). Murni, tanpa DB.
import { describe, expect, it } from '../_vitest';
import {
  AGENT_WORK_REPORT_STATUSES,
  CARD_ID_PATTERN,
  CHART_CUSTOM_MARKS,
  CHART_CUSTOM_ORIENTATIONS,
  CONTRACT_ACTOR_PATTERN,
  CONTRACT_DEFAULT_RENDER_FORMATS,
  CONTRACT_EVIDENCE_KINDS,
  CONTRACT_ITEM_STATUSES,
  CONTRACT_KEY_PATTERN,
  CONTRACT_KINDS,
  CONTRACT_LIMITS,
  CONTRACT_OUTLINE_KEYS,
  CONTRACT_QUERY_LIMITS,
  CONTRACT_REF_RELS,
  CONTRACT_REPORTED_AT_PATTERN,
  CONTRACT_SHA_PREFIX_PATTERN,
  CONTRACT_VERDICTS,
  CONTRACT_WARNING_CODES,
  DISPLAY_FIELDS_BY_LOCATION,
  DISPLAY_FIELDS_GLOBAL,
  DRAFT_ACCEPTED_SCHEMAS,
  DRAFT_BASIS_PATTERN,
  DRAFT_HEADER_KEYS,
  DRAFT_ISSUE_CODES,
  DRAFT_LIMIT_REASONS,
  DRAFT_LIMITS,
  FINAL_ARTIFACT_PREFIX,
  FINAL_DOC_NUMBER_MAX,
  FINAL_FILENAME_PATTERN,
  FINAL_NAME_MODES,
  QUOTA_BUCKETS,
  SCHEMA_V2_CHECK_IDS,
  SEARCH_LIMITS,
  SEARCH_SNIPPET_OPTIONS,
  STUDIO_ERROR_CODES,
  STUDIO_ERROR_HTTP,
  STUDIO_FINAL_FILENAME_HEADER,
  STUDIO_FTS_CONFIG,
  STUDIO_FTS_MAX_CHARS,
  STUDIO_QUOTA_BUCKET_HEADER,
  STUDIO_QUOTA_REMAINING_HEADER,
  STUDIO_ROUTES,
  type ContractRecordPayloadV2,
  type StudioSlotV2,
  type ValidationIssue,
} from '@/lib/studio/contract';
import { validateV2Against } from '@/lib/studio/services/ingest/validate';

// ── Contoh register §5.8 (apa adanya) ───────────────────────────────────────
function slotExample(): StudioSlotV2 {
  return {
    $schema: 'studio.slot/v2',
    target: { mission: { folder: '2026-10-30_hermes-retrial' }, docKey: 'laporan-kerja-dc02' },
    template: { slug: 'laporan-kerja-agen' },
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
    } satisfies ContractRecordPayloadV2,
  };
}

function chapterExample(blocks: unknown[] = [{ type: 'paragraph', text: 'Register 05 ditulis; empat kode galat baru.' }]) {
  return {
    $schema: 'studio.chapter/v2',
    target: { mission: { folder: '2026-10-30_hermes-retrial' }, docKey: 'laporan-kerja-dc02' },
    chapter: { key: '1', title: { text: 'Ringkasan' }, sections: [{ title: { text: 'Hasil' }, blocks }] },
  };
}

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- fixture bebas-bentuk
function mutate(fn: (payload: Json) => void): unknown {
  const doc = structuredClone(slotExample()) as unknown as Json;
  fn(doc.payload);
  return doc;
}
const slotIssues = (doc: unknown) => validateV2Against('studio.slot/v2', doc);
const withCheck = (issues: ValidationIssue[], checkId: string) => issues.filter((i) => i.checkId === checkId);

// ── §13 hitungan + EC25-EC28 ────────────────────────────────────────────────
describe('kode galat EC25-EC28 (§13.1, §13.3: 69 -> 73)', () => {
  const NEW_CODES: Record<string, number> = {
    CONTRACT_REF_NOT_FOUND: 422,
    CONTRACT_REF_PID_NOT_FOUND: 422,
    CONTRACT_ITEM_KEY_DUPLICATE: 422,
    CHART_CUSTOM_FORM_UNSUPPORTED: 422,
  };
  // row42 ADAPT A1 (C78, row 69a): Swarm adds TEMPLATE_ARCHIVED (enums.ts:349-350, errors.ts:100-101); 73 -> 74.
  // row42 ADAPT A11 (U24 B, row 158): Swarm adds FIGURE_OVER_CAPACITY (enums.ts last entry, errors.ts 422); 74 -> 75.
  it('STUDIO_ERROR_CODES dan STUDIO_ERROR_HTTP masing-masing 73 kode, himpunan sama', () => {
    expect(STUDIO_ERROR_CODES).toHaveLength(75);
    expect(Object.keys(STUDIO_ERROR_HTTP)).toHaveLength(75);
    expect([...STUDIO_ERROR_CODES].sort()).toEqual(Object.keys(STUDIO_ERROR_HTTP).sort());
    expect(new Set(STUDIO_ERROR_CODES).size).toBe(75);
    expect(STUDIO_ERROR_CODES).toContain('TEMPLATE_ARCHIVED');
    expect(STUDIO_ERROR_CODES).toContain('FIGURE_OVER_CAPACITY');
  });
  it.each(Object.entries(NEW_CODES))('%s -> HTTP %i', (code, status) => {
    expect((STUDIO_ERROR_CODES as readonly string[]).includes(code)).toBe(true);
    expect(STUDIO_ERROR_HTTP[code as keyof typeof STUDIO_ERROR_HTTP]).toBe(status);
  });
});

describe('checkId SCHEMA_INVALID (E41 8 -> 14, CH-01..CH-06)', () => {
  it('memuat 6 checkId baru berurutan sesudah 8 lama', () => {
    expect(SCHEMA_V2_CHECK_IDS).toHaveLength(14);
    expect(SCHEMA_V2_CHECK_IDS.slice(8)).toEqual([
      'CONTRACT_ENUM',
      'CONTRACT_PATTERN',
      'CONTRACT_DATE',
      'CONTRACT_REF_TARGET',
      'CHART_CUSTOM_FORM',
      'SKELETON_CONTRACT_RECORD',
    ]);
  });
});

describe('medan tampilan terlarang (C29 + C30 = 73, DF-72/DF-73)', () => {
  it('52 global + 21 per lokasi (DF-53..DF-73)', () => {
    expect(DISPLAY_FIELDS_GLOBAL.length + Object.keys(DISPLAY_FIELDS_BY_LOCATION).length).toBe(73);
    expect(Object.keys(DISPLAY_FIELDS_BY_LOCATION)).toEqual(Array.from({ length: 21 }, (_, i) => `DF-${53 + i}`));
  });
  it('DF-72 berlaku di empat objek kontrak; DF-73 di ChartCustomFormV2', () => {
    const df72 = DISPLAY_FIELDS_BY_LOCATION['DF-72'];
    expect([df72.location, ...(df72.alsoAt ?? [])].sort()).toEqual(
      ['ContractEvidenceV2', 'ContractItemV2', 'ContractRecordPayloadV2', 'ContractRefV2'],
    );
    expect(df72.fields).toEqual(['label', 'columns', 'order', 'heading']);
    expect(DISPLAY_FIELDS_BY_LOCATION['DF-73']).toMatchObject({
      location: 'ChartCustomFormV2',
      fields: ['palette', 'axis', 'max', 'width', 'height', 'legend'],
    });
  });
});

// ── §14.2 enum + §14.1 konstanta + AM-06 ────────────────────────────────────
describe('enum E44-E57 (§14.2)', () => {
  it('nilai literal register', () => {
    expect(CONTRACT_KINDS).toEqual(['agentWorkReport']);
    expect(AGENT_WORK_REPORT_STATUSES).toEqual(['draft', 'complete', 'partial', 'blocked', 'needs-review']);
    expect(CONTRACT_ITEM_STATUSES).toEqual(['todo', 'ready', 'running', 'review', 'done', 'blocked', 'cancelled']);
    expect(CONTRACT_VERDICTS).toEqual(['PASS', 'CAUTION', 'FAIL', 'NEEDS_REVIEW']);
    expect(CONTRACT_REF_RELS).toEqual(['basis', 'evidence', 'output', 'supersedes']);
    expect(CONTRACT_EVIDENCE_KINDS).toEqual(['file', 'command', 'commit', 'correlation']);
    expect(CONTRACT_OUTLINE_KEYS).toEqual(['ringkasan', 'rincian', 'bukti', 'isu', 'lanjut']);
    expect(CHART_CUSTOM_MARKS).toEqual(['bar', 'line', 'point', 'area']);
    expect(CHART_CUSTOM_ORIENTATIONS).toEqual(['vertical', 'horizontal']);
    expect(QUOTA_BUCKETS).toEqual(['render', 'validate', 'import', 'query']);
    expect(CONTRACT_WARNING_CODES).toEqual([
      'CONTRACT_REF_PID_RETIRED',
      'CONTRACT_STATUS_UNMAPPED',
      'CONTRACT_HEADING_UNMAPPED',
      'CONTRACT_FIELD_UNMAPPED',
    ]);
    expect(DRAFT_ISSUE_CODES).toEqual([
      'DRAFT_NO_JSON_BLOCK',
      'DRAFT_FENCE_UNCLOSED',
      'DRAFT_JSON_MALFORMED',
      'DRAFT_BLOCK_NOT_OBJECT',
      'DRAFT_SCHEMA_UNKNOWN',
      'DRAFT_HEADER_INCOMPLETE',
      'DRAFT_BASIS_INVALID',
      'DRAFT_BASIS_STALE',
    ]);
    expect(DRAFT_LIMIT_REASONS).toEqual(['DRAFT_TOO_LONG', 'DRAFT_TOO_MANY_BLOCKS']);
    expect(FINAL_NAME_MODES).toEqual(['final', 'datum']);
  });
});

describe('konstanta C34-C57 (§14.1; C46/C47/C58-C60 milik baris lain)', () => {
  it('nilai literal register', () => {
    expect(CARD_ID_PATTERN).toBe('^t_[0-9a-f]{8}$');
    expect(CONTRACT_KEY_PATTERN).toBe('^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$');
    expect(CONTRACT_ACTOR_PATTERN).toBe('^[a-z0-9][a-z0-9._-]{0,63}$');
    expect(CONTRACT_SHA_PREFIX_PATTERN).toBe('^[0-9a-f]{8,64}$');
    expect(CONTRACT_LIMITS).toEqual({ cardIds: 64, items: 500, dependsOn: 32, refs: 100, evidence: 200, refText: 500 });
    expect(CONTRACT_DEFAULT_RENDER_FORMATS).toEqual(['HTML']);
    expect(STUDIO_FTS_CONFIG).toBe('simple');
    expect(STUDIO_FTS_MAX_CHARS).toBe(100000);
    expect(SEARCH_LIMITS).toEqual({ qMin: 2, qMax: 200, takeDefault: 20, takeMax: 100 });
    expect(SEARCH_SNIPPET_OPTIONS).toBe('MaxWords=30, MinWords=10, ShortWord=2, MaxFragments=2, StartSel=[[, StopSel=]]');
    expect(CONTRACT_QUERY_LIMITS).toEqual({ takeDefault: 50, takeMax: 200, statusListMax: 8 });
    expect(STUDIO_QUOTA_REMAINING_HEADER).toBe('X-Studio-Quota-Remaining');
    expect(STUDIO_QUOTA_BUCKET_HEADER).toBe('X-Studio-Quota-Bucket');
    expect(STUDIO_FINAL_FILENAME_HEADER).toBe('X-Studio-Final-Filename');
    expect(FINAL_DOC_NUMBER_MAX).toBe(80);
    expect(FINAL_ARTIFACT_PREFIX).toBe('ART-');
    expect(DRAFT_LIMITS).toEqual({ bodyBytes: 4194304, maxChars: 2000000, maxBlocks: 20 });
    expect(DRAFT_HEADER_KEYS).toEqual(['tujuan', 'langkah-berikut', 'basis']);
    expect(DRAFT_ACCEPTED_SCHEMAS).toEqual(['studio.doc/v2', 'studio.chapter/v2', 'studio.slot/v2']);
  });
  it('C37 reportedAt: tanggal / waktu ber-zona diterima, waktu tanpa zona ditolak', () => {
    const re = new RegExp(CONTRACT_REPORTED_AT_PATTERN);
    for (const ok of ['2026-10-30', '2026-10-30T19:30+07:00', '2026-10-30T12:58:00Z', '2026-10-30T12:58:00.123-03:30']) expect(re.test(ok), ok).toBe(true);
    for (const bad of ['2026-10-30T19:30', '2026-13-01', '30-10-2026', '2026-10-30 19:30Z']) expect(re.test(bad), bad).toBe(false);
  });
  it('C51 nama final: contoh §10 cocok, ekstensi lain ditolak', () => {
    const re = new RegExp(FINAL_FILENAME_PATTERN);
    expect(re.exec('003-GSP-KT-X-2026_rev12_20261030T125800Z_55d324b1.html')?.slice(1)).toEqual([
      '003-GSP-KT-X-2026',
      '12',
      '20261030T125800Z',
      '55d324b1',
      'html',
    ]);
    expect(re.test('ART-cm_1_rev0_20261030T125800Z_55d324b1.svg')).toBe(false); // `_` di luar [A-Za-z0-9.-]
    expect(re.test('ART-cm1abc_rev0_20261030T125800Z_55d324b1.svg')).toBe(true);
    expect(re.test('DOC_rev1_20261030T125800Z_55d324b1.txt')).toBe(false);
  });
  it('C56 basis draf: `<id>@rev<n>` atau `baru`', () => {
    const re = new RegExp(DRAFT_BASIS_PATTERN);
    expect(re.test('cmvui0qun000qv11gtygb1mk9@rev3')).toBe(true);
    expect(re.test('baru')).toBe(true);
    expect(re.test('cmvui0qun000qv11gtygb1mk9@rev0')).toBe(false);
  });
  it('AM-06: STUDIO_ROUTES R21-R23', () => {
    expect(STUDIO_ROUTES.R21).toBe('/api/studio/contracts');
    expect(STUDIO_ROUTES.R22).toBe('/api/studio/search');
    expect(STUDIO_ROUTES.R23).toBe('/api/studio/drafts/check');
  });
});

// ── §5.8 contoh valid lolos ajv ─────────────────────────────────────────────
describe('contoh register §5.8 lolos ajv (strict, discriminator)', () => {
  it('slot record contractRecord: 0 isu', () => {
    expect(slotIssues(slotExample())).toEqual([]);
  });
  it('bab 1 studio.chapter/v2: 0 isu', () => {
    expect(validateV2Against('studio.chapter/v2', chapterExample())).toEqual([]);
  });
  it('payload minimal (type, status, reportedAt tanggal saja): 0 isu', () => {
    const doc = slotExample() as unknown as Json;
    doc.payload = { type: 'contractRecord', status: 'partial', reportedAt: '2026-10-30' };
    expect(slotIssues(doc)).toEqual([]);
  });
  it('KD-30: medan `kind` di payload ditolak (additionalProperties, tanpa checkId kontrak)', () => {
    const issues = slotIssues(mutate((p) => (p.kind = 'agentWorkReport')));
    expect(issues.map((i) => [i.pointer, i.keyword, i.checkId])).toEqual([['/payload', 'additionalProperties', undefined]]);
  });
});

// ── §5.5 varian bermedan tampilan -> DISPLAY_FIELD ──────────────────────────
describe('DF-72 di payload, butir, bukti, rujukan -> DISPLAY_FIELD berpointer tepat', () => {
  const parents: Array<[string, (p: Json) => Json]> = [
    ['/payload', (p) => p],
    ['/payload/items/0', (p) => p.items[0]],
    ['/payload/evidence/0', (p) => p.evidence[0]],
    ['/payload/refs/0', (p) => p.refs[0]],
  ];
  const rows = parents.flatMap(([ptr, get]) => ['label', 'columns', 'order', 'heading'].map((f) => [ptr, f, get] as const));
  it.each(rows)('%s/%s', (ptr, field, get) => {
    const issues = slotIssues(mutate((p) => (get(p)[field] = field === 'columns' ? ['a'] : 'x')));
    expect(withCheck(issues, 'DISPLAY_FIELD').map((i) => i.pointer)).toEqual([`${ptr}/${field}`]);
    expect(issues.every((i) => i.checkId === 'DISPLAY_FIELD')).toBe(true);
  });
  it('DF global (color DF-04, style DF-47) tetap berlaku di objek kontrak', () => {
    const issues = slotIssues(mutate((p) => { p.color = 'red'; p.items[1].style = 'x'; }));
    expect(withCheck(issues, 'DISPLAY_FIELD').map((i) => i.pointer).sort()).toEqual(['/payload/color', '/payload/items/1/style']);
  });
});

// ── §17.1 NV-01..NV-12 ──────────────────────────────────────────────────────
describe('NV-01..NV-12 (§17.1): kasus yang dapat dicek skema memberi checkId + pointer register', () => {
  const SCHEMA_CASES: Array<[string, (p: Json) => void, string, string]> = [
    ['NV-01', (p) => (p.status = 'running'), 'CONTRACT_ENUM', '/payload/status'],
    ['NV-02', (p) => (p.items[0].status = 'berjalan'), 'CONTRACT_ENUM', '/payload/items/0/status'],
    ['NV-03', (p) => (p.cardIds[0] = 't_249c6b8'), 'CONTRACT_PATTERN', '/payload/cardIds/0'],
    ['NV-04', (p) => (p.items[1].key = 'DC 03'), 'CONTRACT_PATTERN', '/payload/items/1/key'],
    ['NV-06', (p) => (p.due = '2026-11-02T10:00Z'), 'CONTRACT_DATE', '/payload/due'],
    ['NV-07', (p) => (p.refs[0].docNumber = '003/GSP/KT/X/2026'), 'CONTRACT_REF_TARGET', '/payload/refs/0'],
    ['NV-08', (p) => (p.refs[0].rel = 'cites'), 'CONTRACT_ENUM', '/payload/refs/0/rel'],
    ['NV-09', (p) => (p.items[0].label = 'Kunci'), 'DISPLAY_FIELD', '/payload/items/0/label'],
  ];
  it.each(SCHEMA_CASES)('%s -> 400 SCHEMA_INVALID %s di pointer tepat (satu isu)', (_id, fn, checkId, pointer) => {
    const issues = slotIssues(mutate(fn));
    expect(issues.map((i) => [i.checkId, i.pointer])).toEqual([[checkId, pointer]]);
    expect(STUDIO_ERROR_HTTP.SCHEMA_INVALID).toBe(400);
  });

  // NV-05 (kalender pasca-ajv, I54 DC-07) dan NV-10..NV-12 (422 layanan: EC27 langkah 6b, EC25/EC26
  // langkah 9a) lolos skema menurut desain §5.6; kode 422-nya terdaftar di atas.
  const SERVICE_CASES: Array<[string, (p: Json) => void, string]> = [
    ['NV-05', (p) => (p.reportedAt = '2026-02-30'), 'pemeriksaan kalender I54'],
    ['NV-10', (p) => (p.items[1].key = 't_5943d415'), 'CONTRACT_ITEM_KEY_DUPLICATE'],
    ['NV-11', (p) => (p.refs[0].documentId = 'cmzzzzzzzzzzzzzzzzzzzzzzz'), 'CONTRACT_REF_NOT_FOUND'],
    ['NV-12', (p) => (p.refs[0].pid = 'p-zzzzzzzzzz'), 'CONTRACT_REF_PID_NOT_FOUND'],
  ];
  it.each(SERVICE_CASES)('%s lolos skema (ditolak layanan: %s)', (_id, fn) => {
    expect(slotIssues(mutate(fn))).toEqual([]);
  });
});

describe('CH-01..CH-04 tambahan', () => {
  it('ref tanpa documentId maupun docNumber -> satu CONTRACT_REF_TARGET di /payload/refs/0', () => {
    const issues = slotIssues(mutate((p) => delete p.refs[0].documentId));
    expect(issues.map((i) => [i.checkId, i.pointer])).toEqual([['CONTRACT_REF_TARGET', '/payload/refs/0']]);
  });
  it('line pada bukti command dan exitCode pada bukti file -> CONTRACT_REF_TARGET di medan itu', () => {
    const issues = slotIssues(mutate((p) => { p.evidence[1].line = 3; p.evidence[0].exitCode = 1; }));
    expect(issues.map((i) => [i.checkId, i.pointer]).sort()).toEqual([
      ['CONTRACT_REF_TARGET', '/payload/evidence/0/exitCode'],
      ['CONTRACT_REF_TARGET', '/payload/evidence/1/line'],
    ]);
  });
  it('enum verdict/kind, pola owner/sha256/pid/documentId, tanggal reportedAt', () => {
    const issues = slotIssues(
      mutate((p) => {
        p.verdict = 'SETUJU';
        p.evidence[0].kind = 'url';
        p.owner = 'Data Analyst';
        p.evidence[0].sha256 = 'XYZ';
        p.refs[0].pid = 'P!';
        p.refs[0].documentId = 'CM-1';
        p.reportedAt = '2026-10-30T19:30';
      }),
    );
    expect(issues.map((i) => [i.checkId, i.pointer]).sort()).toEqual([
      ['CONTRACT_DATE', '/payload/reportedAt'],
      ['CONTRACT_ENUM', '/payload/evidence/0/kind'],
      ['CONTRACT_ENUM', '/payload/verdict'],
      ['CONTRACT_PATTERN', '/payload/evidence/0/sha256'],
      ['CONTRACT_PATTERN', '/payload/owner'],
      ['CONTRACT_PATTERN', '/payload/refs/0/documentId'],
      ['CONTRACT_PATTERN', '/payload/refs/0/pid'],
    ]);
  });
  it('batas larik C39 dan cardIds unik ditegakkan skema', () => {
    const many = slotIssues(mutate((p) => (p.cardIds = Array.from({ length: 65 }, (_, i) => `t_${i.toString(16).padStart(8, '0')}`))));
    expect(many.map((i) => [i.pointer, i.keyword])).toEqual([['/payload/cardIds', 'maxItems']]);
    const dup = slotIssues(mutate((p) => (p.cardIds = ['t_249c6b84', 't_249c6b84'])));
    expect(dup.map((i) => [i.pointer, i.keyword])).toEqual([['/payload/cardIds', 'uniqueItems']]);
  });
});

// ── §12 / AM-03 chart.custom (CH-05, DF-73) ─────────────────────────────────
describe('chart.custom: form berbatas (CH-05, DF-73)', () => {
  const B = '/chapter/sections/0/blocks/0';
  const data = { shape: 'categorical', points: [{ label: 'A', value: 1 }] };
  const chart = (extra: Json) => ({ type: 'chart', caption: { text: 'Grafik' }, source: { text: 'Sumber uji' }, ...extra });
  const chIssues = (block: Json) => validateV2Against('studio.chapter/v2', chapterExample([block]));

  it('custom + form + data diterima; orientasi/tumpuk opsional', () => {
    expect(chIssues(chart({ code: 'custom', form: { mark: 'bar' }, data }))).toEqual([]);
    expect(chIssues(chart({ code: 'custom', form: { mark: 'bar', orientation: 'horizontal', stacked: true }, data }))).toEqual([]);
  });
  it('kode preset tanpa form tetap diterima (paritas lama)', () => {
    expect(chIssues(chart({ code: 'P-02', data }))).toEqual([]);
  });
  it('custom tanpa form -> CHART_CUSTOM_FORM /form', () => {
    expect(chIssues(chart({ code: 'custom', data })).map((i) => [i.checkId, i.pointer])).toEqual([['CHART_CUSTOM_FORM', `${B}/form`]]);
  });
  it('form pada kode preset -> CHART_CUSTOM_FORM /form', () => {
    expect(chIssues(chart({ code: 'P-02', form: { mark: 'bar' }, data })).map((i) => [i.checkId, i.pointer])).toEqual([
      ['CHART_CUSTOM_FORM', `${B}/form`],
    ]);
  });
  it('custom + panels (tanpa data) -> CHART_CUSTOM_FORM /panels dan /data', () => {
    const panels = [{ name: 'a', code: 'P-02', data }];
    const issues = chIssues(chart({ code: 'custom', form: { mark: 'bar' }, panels }));
    expect(issues.map((i) => [i.checkId, i.pointer]).sort()).toEqual([
      ['CHART_CUSTOM_FORM', `${B}/data`],
      ['CHART_CUSTOM_FORM', `${B}/panels`],
    ]);
  });
  it('custom di panel komposit -> CHART_CUSTOM_FORM di panels/0/code', () => {
    const issues = chIssues(chart({ code: 'composite', panels: [{ name: 'a', code: 'custom', data }] }));
    expect(issues.map((i) => [i.checkId, i.pointer])).toEqual([['CHART_CUSTOM_FORM', `${B}/panels/0/code`]]);
  });
  it('mark di luar E51 -> CHART_CUSTOM_FORM /form/mark', () => {
    expect(chIssues(chart({ code: 'custom', form: { mark: 'pie' }, data })).map((i) => [i.checkId, i.pointer])).toEqual([
      ['CHART_CUSTOM_FORM', `${B}/form/mark`],
    ]);
  });
  it.each(['palette', 'axis', 'max', 'width', 'height', 'legend'])('DF-73 form.%s -> DISPLAY_FIELD', (field) => {
    const issues = chIssues(chart({ code: 'custom', form: { mark: 'line', [field]: 1 }, data }));
    expect(issues.map((i) => [i.checkId, i.pointer])).toEqual([['DISPLAY_FIELD', `${B}/form/${field}`]]);
  });
});
