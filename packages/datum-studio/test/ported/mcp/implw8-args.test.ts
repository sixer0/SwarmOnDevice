// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/mcp/implw8-args.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
// IMPL-W8 (uji Hermes ronde 11, R11B): jembatan klien Hermes kadang membungkus argumen dua kali
// (`{ arguments: {...}, name: "mcp__studio__studio_edit" }`) dan menaruh `{ meta: {...} }` sebagai butir di `edits`.
// Keduanya ditolak INVALID_ARGUMENT dan agen mengulang ~36 dtk. Kini: (A) semua alat membuka satu tingkat pembungkus
// `arguments` bila kunci lain hanya `name` yang cocok dengan alat (ARGS_UNWRAPPED, informasional); (B) studio_edit
// mengangkat butir `{ meta }` ke `meta` puncak (META_LIFTED_FROM_EDITS, informasional; bentrok nilai -> INVALID_ARGUMENT,
// 0 tulis). Validasi skema dan pagar lain tetap berjalan sesudahnya seperti biasa.
/* eslint-disable @typescript-eslint/no-explicit-any -- structuredContent bebas bentuk */
import { describe, it, expect, beforeEach } from '../_vitest';
import { connect, logs, reply, type Call } from './mcp-harness';
import { DOC, MD, statefulServer } from '../draft/r3-stateful-harness';
import { INFORMATIONAL_WARNING_CODES, unwrapToolArgs } from '../../../vendor/scripts/studio/mcp/tool-kit';
import { normalizeEditArgs } from '../../../vendor/scripts/studio/mcp/write-normalize';

const AGENT = 'cod-implw8';
const env = { STUDIO_AGENT_ID: AGENT, STUDIO_MCP_TOOLSETS: 'write' };

beforeEach(() => {
  logs.length = 0;
});

function own() {
  const s = statefulServer(MD());
  const calls: Call[] = [];
  const f = async (url: string, init: any) => {
    const u = new URL(url);
    calls.push({ method: init.method, url, headers: init.headers, redirect: init.redirect, body: init.body ? JSON.parse(init.body) : undefined });
    if (init.method === 'GET' && u.pathname === '/api/studio/documents') return reply({ status: 200, body: { documents: [{ id: DOC, createdBy: `agent:${AGENT}`, currentRevisionNo: s.rev() }] } });
    if (init.method === 'GET' && u.pathname === '/api/studio/contracts') return reply({ status: 200, body: { contracts: [{ documentId: DOC }], nextCursor: null } });
    if (init.method === 'GET' && u.pathname === `/api/studio/documents/${DOC}`) return reply({ status: 200, body: { document: { id: DOC, docNumber: '040/GSP/LAP/XI/2026', createdBy: `agent:${AGENT}`, currentRevisionNo: s.rev() }, revision: { revisionNo: s.rev(), createdBy: `agent:${AGENT}` } } });
    if (init.method === 'PATCH' && u.pathname === `/api/studio/documents/${DOC}/structure`) return reply({ status: 200, body: { document: { id: DOC }, revision: { revisionNo: s.rev() } } });
    return s.f(url, init);
  };
  const writes = () => calls.filter((c) => (c.method === 'POST' || c.method === 'PATCH' || c.method === 'PUT') && !c.url.endsWith('/validate')).length;
  return { f, calls, s, writes };
}

const codesOf = (r: any): string[] => (r.data.warnings ?? []).map((w: any) => w.code);

/** Suntingan teks nyata (find >= 3 kata dari paragraf pertama Ringkasan). */
function findEdit(m: ReturnType<typeof own>) {
  const para = m.s.chapter('1').intro?.[0] ?? m.s.chapter('1').sections[0].blocks[0];
  const text: string = para.text ?? para.runs.map((x: any) => x.t).join('');
  const find = text.split(' ').slice(0, 3).join(' ');
  return { find, replace: `${find} (implw8)` };
}

describe('IMPL-W8 A: buka pembungkus arguments (fungsi murni)', () => {
  it('nama cocok (bentuk pendek dan mcp__studio__) -> dibuka satu tingkat + peringatan', () => {
    for (const name of ['studio_edit', 'mcp__studio__studio_edit']) {
      const r = unwrapToolArgs('studio_edit', { arguments: { documentId: 'x', edits: [] }, name });
      expect(r.args).toEqual({ documentId: 'x', edits: [] });
      expect(r.warning?.code).toBe('ARGS_UNWRAPPED');
    }
    const noName = unwrapToolArgs('studio_edit', { arguments: { documentId: 'x' } });
    expect(noName.args).toEqual({ documentId: 'x' });
  });

  it('nama tidak cocok / kunci lain / arguments bukan objek -> tidak diubah', () => {
    const cases: any[] = [
      { arguments: { documentId: 'x' }, name: 'studio_write' },
      { arguments: { documentId: 'x' }, name: 'mcp__lain__studio_edit' },
      { arguments: { documentId: 'x' }, name: 7 },
      { arguments: { documentId: 'x' }, documentId: 'y' },
      { arguments: ['x'] },
      { arguments: '{"documentId":"x"}' },
    ];
    for (const c of cases) {
      const r = unwrapToolArgs('studio_edit', c);
      expect(r.args).toBe(c);
      expect(r.warning).toBeNull();
    }
  });

  it('ARGS_UNWRAPPED dan META_LIFTED_FROM_EDITS termasuk kelas informasional', () => {
    expect(INFORMATIONAL_WARNING_CODES.has('ARGS_UNWRAPPED')).toBe(true);
    expect(INFORMATIONAL_WARNING_CODES.has('META_LIFTED_FROM_EDITS')).toBe(true);
  });
});

describe('IMPL-W8 A: studio_edit terbungkus ganda', () => {
  it('nama cocok -> diterapkan; peringatan senyap di hasil ringkas, tampil dengan detail', async () => {
    const m = own();
    const { call } = await connect({ fetch: m.f as any, env });
    const e = findEdit(m);
    const r = await call('studio_edit', { arguments: { documentId: DOC, edits: [e] }, name: 'mcp__studio__studio_edit' });
    expect(r.data.ok, r.text).toBe(true);
    expect(JSON.stringify(m.s.chapter('1'))).toContain('(implw8)');
    expect(codesOf(r)).not.toContain('ARGS_UNWRAPPED');
    expect(r.text).not.toContain('ARGS_UNWRAPPED');

    const m2 = own();
    const c2 = await connect({ fetch: m2.f as any, env });
    const r2 = await c2.call('studio_edit', { arguments: { documentId: DOC, edits: [findEdit(m2)], detail: true }, name: 'studio_edit' });
    expect(r2.data.ok, r2.text).toBe(true);
    expect(codesOf(r2)).toContain('ARGS_UNWRAPPED');
    expect(r2.text).toContain('peringatan ARGS_UNWRAPPED');
  });

  it('nama tidak cocok -> INVALID_ARGUMENT, 0 panggilan jaringan', async () => {
    const m = own();
    const { call } = await connect({ fetch: m.f as any, env });
    const r = await call('studio_edit', { arguments: { documentId: DOC, edits: [findEdit(m)] }, name: 'mcp__studio__studio_write' });
    expect(r.data.ok).toBe(false);
    expect(r.data.error.code).toBe('INVALID_ARGUMENT');
    expect(m.calls.length).toBe(0);
  });

  it('terbungkus tiga kali -> dibuka sekali saja, lalu ditolak seperti biasa (0 jaringan)', async () => {
    const m = own();
    const { call } = await connect({ fetch: m.f as any, env });
    const inner = { arguments: { documentId: DOC, edits: [findEdit(m)] }, name: 'studio_edit' };
    const r = await call('studio_edit', { arguments: inner, name: 'studio_edit' });
    expect(r.data.ok).toBe(false);
    expect(r.data.error.code).toBe('INVALID_ARGUMENT');
    expect(m.calls.length).toBe(0);
    // Sekali buka: unwrapToolArgs sendiri tidak berulang.
    const once = unwrapToolArgs('studio_edit', { arguments: inner, name: 'studio_edit' });
    expect(once.args).toEqual(inner);
  });

  it('berlaku untuk alat lain: studio_document_get terbungkus ganda -> ok + ARGS_UNWRAPPED', async () => {
    const m = own();
    const { call } = await connect({ fetch: m.f as any, env });
    const r = await call('studio_document_get', { arguments: { documentId: DOC, view: 'summary' }, name: 'mcp__studio__studio_document_get' });
    expect(r.data.ok, r.text).toBe(true);
    expect(codesOf(r)).toContain('ARGS_UNWRAPPED');
  });
});

describe('IMPL-W8 B: butir { meta } di edits studio_edit', () => {
  it('normalisasi murni: butir meta diangkat ke meta puncak, edits sisanya tetap', () => {
    const a: any = { documentId: DOC, edits: [{ find: 'satu dua tiga', replace: 'x' }, { meta: { status: 'complete' } }], meta: { verdict: 'pass' } };
    const w = normalizeEditArgs(a);
    expect(a.meta).toEqual({ verdict: 'pass', status: 'complete' });
    expect(a.edits).toEqual([{ find: 'satu dua tiga', replace: 'x' }]);
    expect(w.map((x) => x.code)).toContain('META_LIFTED_FROM_EDITS');
  });

  it('butir meta dengan kunci lain atau nilai bukan objek -> tidak diangkat (ditolak skema seperti biasa)', () => {
    const a: any = { documentId: DOC, edits: [{ meta: { status: 'complete' }, find: 'a b c' }, { meta: 'complete' }] };
    const w = normalizeEditArgs(a);
    expect(a.meta).toBeUndefined();
    expect(w.map((x) => x.code)).not.toContain('META_LIFTED_FROM_EDITS');
  });

  it('bentuk R11B (terbungkus ganda + meta di edits) -> diterapkan, status tersimpan', async () => {
    const m = own();
    const { call } = await connect({ fetch: m.f as any, env });
    const r = await call('studio_edit', { arguments: { documentId: DOC, edits: [findEdit(m), { meta: { status: 'complete' } }] }, name: 'mcp__studio__studio_edit' });
    expect(r.data.ok, r.text).toBe(true);
    expect(m.s.latest().sections.record.status).toBe('complete');
    expect(JSON.stringify(m.s.chapter('1'))).toContain('(implw8)');
    expect(codesOf(r)).not.toContain('META_LIFTED_FROM_EDITS');
  });

  it('meta puncak bentrok dengan butir meta -> INVALID_ARGUMENT, 0 jaringan/0 tulis', async () => {
    const m = own();
    const { call } = await connect({ fetch: m.f as any, env });
    const r = await call('studio_edit', { documentId: DOC, edits: [findEdit(m), { meta: { status: 'complete' } }], meta: { status: 'blocked' } });
    expect(r.data.ok).toBe(false);
    expect(r.data.error.code).toBe('INVALID_ARGUMENT');
    expect(r.data.error.message).toContain('status');
    expect(m.calls.length).toBe(0);
    expect(m.writes()).toBe(0);
  });

  it('meta puncak sama nilainya -> bukan bentrok', async () => {
    const m = own();
    const { call } = await connect({ fetch: m.f as any, env });
    const r = await call('studio_edit', { documentId: DOC, edits: [{ meta: { status: 'complete' } }], meta: { status: 'complete' } });
    expect(r.data.ok, r.text).toBe(true);
    expect(m.s.latest().sections.record.status).toBe('complete');
  });

  it('edits hanya butir meta -> suntingan meta saja (saluran meta), detail menampilkan peringatan', async () => {
    const m = own();
    const rec0 = structuredClone(m.s.latest().sections.record);
    const { call } = await connect({ fetch: m.f as any, env });
    const r = await call('studio_edit', { documentId: DOC, edits: [{ meta: { status: 'complete', verdict: 'pass' } }], detail: true });
    expect(r.data.ok, r.text).toBe(true);
    const rec1 = m.s.latest().sections.record;
    expect(rec1.status).toBe('complete');
    expect(rec1.verdict).toBe('PASS');
    expect(rec1.items).toEqual(rec0.items);
    expect(codesOf(r)).toContain('META_LIFTED_FROM_EDITS');
  });
});
