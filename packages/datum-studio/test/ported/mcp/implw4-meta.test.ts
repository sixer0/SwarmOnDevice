// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/mcp/implw4-meta.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
// IMPL-W4 butir 2 (D-545): r5b W mengirim meta.status "blocked" lewat studio_write parsial (tanpa Rincian kerja), dapat
// ok:true, tetapi record lama dipertahankan (RECORD_KEPT) sehingga 3/5 laporan tetap draft. Kini medan kepala record
// dari meta SELALU diterapkan (butir record tidak disentuh), dan studio_edit punya saluran meta untuk laporan kerja dan
// dokumen klien (nomor, revisi, tanggal, judul). Hasil menggemakan medan tersimpan.
/* eslint-disable @typescript-eslint/no-explicit-any -- structuredContent bebas bentuk */
import { describe, it, expect, beforeEach } from '../_vitest';
import { connect, logs, reply, type Call } from './mcp-harness';
import { DOC, MD, statefulServer } from '../draft/r3-stateful-harness';
import { clientServer, DOCID, env as cenv } from './implw3-client-mock';
import { serverClientMeta } from '../../../vendor/scripts/studio/mcp/write-meta';

const AGENT = 'cod-r3-f2';
const MISSION = '2026-11-01_r3f2';
const DOCKEY = 'lapkerja-r3f2-uji';
const env = { STUDIO_AGENT_ID: AGENT, STUDIO_MCP_TOOLSETS: 'write' };

beforeEach(() => {
  logs.length = 0;
});

function own() {
  const s = statefulServer(MD());
  const st = { lastWriter: `agent:${AGENT}` };
  const calls: Call[] = [];
  const f = async (url: string, init: any) => {
    const u = new URL(url);
    calls.push({ method: init.method, url, headers: init.headers, redirect: init.redirect, body: init.body ? JSON.parse(init.body) : undefined });
    if (init.method === 'GET' && u.pathname === '/api/studio/documents') return reply({ status: 200, body: { documents: [{ id: DOC, createdBy: `agent:${AGENT}`, currentRevisionNo: s.rev() }] } });
    if (init.method === 'GET' && u.pathname === '/api/studio/contracts') return reply({ status: 200, body: { contracts: [{ documentId: DOC }], nextCursor: null } });
    if (init.method === 'GET' && u.pathname === `/api/studio/documents/${DOC}`) return reply({ status: 200, body: { document: { id: DOC, docNumber: '040/GSP/LAP/XI/2026', createdBy: `agent:${AGENT}`, currentRevisionNo: s.rev() }, revision: { revisionNo: s.rev(), createdBy: st.lastWriter } } });
    if (init.method === 'PATCH' && u.pathname === `/api/studio/documents/${DOC}/structure`) return reply({ status: 200, body: { document: { id: DOC }, revision: { revisionNo: s.rev() } } });
    return s.f(url, init);
  };
  return { f, calls, s };
}

describe('butir 2: laporan kerja, medan kepala record selalu diterapkan', () => {
  it('studio_write parsial (tanpa Rincian kerja) + meta.status blocked -> status tersimpan blocked, butir tetap', async () => {
    const m = own();
    const rec0 = structuredClone(m.s.latest().sections.record);
    expect(rec0.status).not.toBe('blocked');
    const ch2 = JSON.stringify(m.s.chapter('2'));
    const { call } = await connect({ fetch: m.f as any, env });
    const r = await call('studio_write', { mission: MISSION, docKey: DOCKEY, meta: { status: 'blocked', verdict: 'caution' }, sections: [{ heading: 'Ringkasan', blocks: ['Terhambat akses data.'] }] });
    expect(r.data.ok, r.text).toBe(true);
    const rec1 = m.s.latest().sections.record;
    expect(rec1.status).toBe('blocked');
    expect(rec1.verdict).toBe('CAUTION');
    expect(rec1.items).toEqual(rec0.items);
    expect(rec1.evidence ?? []).toEqual(rec0.evidence ?? []);
    expect(JSON.stringify(m.s.chapter('2'))).toBe(ch2);
    expect(r.data.verify?.record?.status).toBe('blocked');
  });

  it('studio_write parsial tanpa meta.status: status tersimpan tidak diubah ke draft', async () => {
    const m = own();
    const before = m.s.latest().sections.record.status;
    const { call } = await connect({ fetch: m.f as any, env });
    const r = await call('studio_write', { mission: MISSION, docKey: DOCKEY, sections: [{ heading: 'Ringkasan', blocks: ['Ringkasan lain.'] }] });
    expect(r.data.ok, r.text).toBe(true);
    expect(m.s.latest().sections.record.status).toBe(before);
  });

  it('studio_edit { meta } saja: status + verdict diterapkan, butir tetap, hasil menggemakan status', async () => {
    const m = own();
    const rec0 = structuredClone(m.s.latest().sections.record);
    const { call } = await connect({ fetch: m.f as any, env });
    const r = await call('studio_edit', { documentId: DOC, meta: { status: 'complete', verdict: 'pass' } });
    expect(r.data.ok, r.text).toBe(true);
    const rec1 = m.s.latest().sections.record;
    expect(rec1.status).toBe('complete');
    expect(rec1.verdict).toBe('PASS');
    expect(rec1.items).toEqual(rec0.items);
    expect(r.data.edited).toContain('record');
    expect(r.data.verify?.record?.status).toBe('complete');
  });

  it('studio_edit { edits, meta } sekaligus', async () => {
    const m = own();
    const { call } = await connect({ fetch: m.f as any, env });
    const para = m.s.chapter('1').intro?.[0] ?? m.s.chapter('1').sections[0].blocks[0];
    const text: string = para.text ?? para.runs.map((x: any) => x.t).join('');
    const find = text.split(' ').slice(0, 3).join(' ');
    const r = await call('studio_edit', { documentId: DOC, edits: [{ find, replace: `${find} (diperbarui)` }], meta: { status: 'needs-review' } });
    expect(r.data.ok, r.text).toBe(true);
    expect(m.s.latest().sections.record.status).toBe('needs-review');
    expect(JSON.stringify(m.s.chapter('1'))).toContain('(diperbarui)');
  });

  it('studio_edit tanpa edits dan meta -> INVALID_ARGUMENT, 0 tulis; status tak dikenal -> tidak diubah + peringatan', async () => {
    const m = own();
    const { call } = await connect({ fetch: m.f as any, env });
    const r0 = await call('studio_edit', { documentId: DOC });
    expect(r0.data.ok).toBe(false);
    expect(r0.data.error.code).toBe('INVALID_ARGUMENT');
    const before = m.s.latest().sections.record.status;
    const r1 = await call('studio_edit', { documentId: DOC, meta: { status: 'setengah-jadi' } });
    expect(r1.data.ok, r1.text).toBe(true);
    expect(m.s.latest().sections.record.status).toBe(before);
    expect((r1.data.warnings ?? r1.warnings ?? []).map((w: any) => w.code).join(',') + r1.text).toContain('STATUS_NOT_APPLIED');
  });
});

describe('butir 2: dokumen klien, saluran meta studio_edit', () => {
  it('serverClientMeta membaca nomor tampilan, revisi, tanggal dari slot depan', () => {
    const m = clientServer({ exists: true });
    expect(serverClientMeta(m.content())).toMatchObject({ title: 'Kajian Lama', author: 'Tim Kajian GSP', number: 'GSP-W2-001', rev: 'A', date: '2026-11-03' });
  });

  it('meta { rev, number, revisionNote }: sampul + lembar kendali, riwayat revisi MENAMBAH baris, gema meta', async () => {
    const m = clientServer({ exists: true });
    const { call } = await connect({ fetch: m.f as any, env: cenv });
    const r = await call('studio_edit', { documentId: DOCID, meta: { rev: 'Rev 1', number: 'GSP-W2-002', revisionNote: 'Sesuai revisi.md' } });
    expect(r.data.ok, r.text).toBe(true);
    const s = m.content().sections;
    expect(JSON.stringify(s.cover.control)).toContain('GSP-W2-002');
    expect(JSON.stringify(s.cover.control)).toContain('Rev 1');
    expect(s.controlSheet.title.text).toContain('GSP-W2-002');
    expect(s.controlSheet.revisionHistory.map((x: any) => x.rev)).toEqual(['A', 'Rev 1']);
    expect(s.controlSheet.revisionHistory[1].what).toContain('Sesuai revisi.md');
    expect(r.data.meta?.number).toBe('GSP-W2-002');
  });

  it('meta { title } -> setMeta judul; tanpa perubahan -> tidak ada tulisan', async () => {
    const m = clientServer({ exists: true });
    const { call } = await connect({ fetch: m.f as any, env: cenv });
    const r = await call('studio_edit', { documentId: DOCID, meta: { title: 'Kajian Baru' } });
    expect(r.data.ok, r.text).toBe(true);
    expect(m.content().meta.title).toBe('Kajian Baru');
    const n = m.calls.length;
    const r2 = await call('studio_edit', { documentId: DOCID, meta: { title: 'Kajian Baru' } });
    expect(r2.data.state).toBe('tidak berubah');
    expect(m.calls.slice(n).filter((c) => c.method === 'POST' || c.method === 'PATCH').filter((c) => !c.url.endsWith('/validate'))).toEqual([]);
  });
});
