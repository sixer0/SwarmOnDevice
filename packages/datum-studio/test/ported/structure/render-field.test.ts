// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/structure/render-field.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
// SR-44 lanjutan (D-247, D-261): build HANYA lewat POST /api/studio/documents/{id}/render.
// Medan `render` di badan kiriman dokumen/bab/slot v2 (R04/R12/R13) dan sunting PATCH pid/
// struktur (R16/R14) ditolak 400 SCHEMA_INVALID dengan issue `checkId: "RENDER_FIELD"`
// berpointer `/render` dan pesan yang menunjuk endpoint render. Seam: `validateV2Against`,
// `parsePatchPidBody`, `parsePatchStructureBody`, `schemaInvalidMessage`. Murni, tanpa DB.
import { describe, expect, it } from '../_vitest';
import { STUDIO_ERROR_HTTP } from '@/lib/studio/contract';
import { RENDER_ENDPOINT, RENDER_FIELD_MESSAGE, schemaInvalidMessage } from '@/lib/studio/contract/schema/v2/forbidden';
import { validateV2Against } from '@/lib/studio/services/ingest/validate';
import { parsePatchPidBody, parsePatchStructureBody } from '@/lib/studio/services/revisions/v2/body';
import { BLOCK_AT, catchEngine, e1, probeDoc, setAt } from './_kit';

const CHANGE = { what: 'ubah', why: 'alasan', impact: 'dampak' };
const RENDER = { scope: 'document', formats: ['docx', 'pdf'] };
const chapterBody = () => ({
  $schema: 'studio.chapter/v2',
  target: { documentId: 'doc-1' },
  chapter: { key: '3', title: { text: 'Tiga' }, sections: [{ title: { text: 'S' }, blocks: [{ type: 'paragraph', text: 'a' }] }] },
});
const slotBody = () => ({ $schema: 'studio.slot/v2', target: { documentId: 'doc-1' }, slot: 'controlSheet', payload: e1().sections.controlSheet });

function expectRenderField(issues: Array<{ pointer: string; checkId?: string; message: string }>, pointer = '/render') {
  const hits = issues.filter((i) => i.checkId === 'RENDER_FIELD');
  expect(hits.map((h) => h.pointer)).toEqual([pointer]);
  expect(hits[0].message).toBe(RENDER_FIELD_MESSAGE);
  expect(issues.some((i) => i.checkId === 'DISPLAY_FIELD' || i.checkId === 'V1_FIELD')).toBe(false);
}

describe('pesan RENDER_FIELD', () => {
  it('menunjuk endpoint render dan syarat fullRenderAllowed', () => {
    expect(RENDER_ENDPOINT).toBe('POST /api/studio/documents/{id}/render');
    expect(RENDER_FIELD_MESSAGE).toContain(RENDER_ENDPOINT);
    expect(RENDER_FIELD_MESSAGE).toContain('fullRenderAllowed');
    expect(STUDIO_ERROR_HTTP.SCHEMA_INVALID).toBe(400);
  });
  it('schemaInvalidMessage memakai pesan RENDER_FIELD bila ada issue itu, selain itu fallback', () => {
    expect(schemaInvalidMessage([{ pointer: '/render', keyword: 'additionalProperties', checkId: 'RENDER_FIELD', message: 'x' }], 'fb')).toBe(RENDER_FIELD_MESSAGE);
    expect(schemaInvalidMessage([{ pointer: '/a', keyword: 'type', message: 'x' }], 'fb')).toBe('fb');
  });
});

describe('kiriman v2 (R04/R12/R13): render di akar badan -> RENDER_FIELD', () => {
  it('positif: badan dokumen/bab/slot tanpa render sah', () => {
    expect(validateV2Against('studio.doc/v2', e1())).toEqual([]);
    expect(validateV2Against('studio.chapter/v2', chapterBody())).toEqual([]);
    expect(validateV2Against('studio.slot/v2', slotBody())).toEqual([]);
  });
  it('studio.doc/v2 + render', () => {
    expectRenderField(validateV2Against('studio.doc/v2', { ...e1(), render: RENDER }));
  });
  it('studio.chapter/v2 + render', () => {
    expectRenderField(validateV2Against('studio.chapter/v2', { ...chapterBody(), render: { scope: 'chapter', key: '3' } }));
  });
  it('studio.slot/v2 + render', () => {
    expectRenderField(validateV2Against('studio.slot/v2', { ...slotBody(), render: { scope: 'slot', key: 'controlSheet' } }));
  });
  it('render objek kosong pun ditolak', () => {
    expectRenderField(validateV2Against('studio.doc/v2', { ...e1(), render: {} }));
  });
  it('prefix pointer badan diteruskan (mis. dokumen bersarang /document)', () => {
    expectRenderField(validateV2Against('studio.doc/v2', { ...e1(), render: RENDER }, '/document'), '/document/render');
  });
  it('`render` di dalam objek lain (bukan akar kiriman) bukan RENDER_FIELD (galat skema biasa)', () => {
    const doc = probeDoc();
    setAt(doc, `${BLOCK_AT(0)}/render`, RENDER);
    const issues = validateV2Against('studio.doc/v2', doc);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.some((i) => i.checkId === 'RENDER_FIELD')).toBe(false);
  });
});

describe('sunting (R16 PATCH pid, R14 PATCH struktur): render -> RENDER_FIELD', () => {
  it('positif: badan PATCH pid tanpa render sah', () => {
    expect(() => parsePatchPidBody({ op: 'delete', baseRevisionNo: 2, change: CHANGE })).not.toThrow();
  });
  it('PATCH pid + render -> 400 SCHEMA_INVALID, issue /render, pesan RENDER_FIELD', () => {
    const e = catchEngine(() => parsePatchPidBody({ op: 'delete', baseRevisionNo: 2, change: CHANGE, render: RENDER }));
    expect(e.code).toBe('SCHEMA_INVALID');
    expect(e.httpStatus).toBe(400);
    expect(e.message).toBe(RENDER_FIELD_MESSAGE);
    expectRenderField(e.details as never);
  });
  it('positif: badan PATCH struktur tanpa render sah', () => {
    expect(() => parsePatchStructureBody({ op: 'omitSlot', slot: 'references', baseRevisionNo: 2, change: CHANGE })).not.toThrow();
  });
  it('PATCH struktur + render -> 400 SCHEMA_INVALID RENDER_FIELD', () => {
    const e = catchEngine(() => parsePatchStructureBody({ op: 'omitSlot', slot: 'references', baseRevisionNo: 2, change: CHANGE, render: RENDER }));
    expect(e.code).toBe('SCHEMA_INVALID');
    expect(e.message).toBe(RENDER_FIELD_MESSAGE);
    expectRenderField(e.details as never);
  });
});
