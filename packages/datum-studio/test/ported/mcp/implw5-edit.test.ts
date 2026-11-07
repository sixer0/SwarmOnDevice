// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/mcp/implw5-edit.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
// IMPL-W5 (D-557, uji Hermes ronde 6): studio_edit tanpa rantai jangkar. Laporan kerja (U-REP) dan dokumen klien
// (U-DOC): { section, append } (blok di akhir section), { section, addRow, table? } (baris tabel), alamat batch
// berurutan dengan cadangan ke isi tersimpan, terapkan sebagian untuk galat alamat (notApplied), alias status butir
// (terblokir, butuh tinjauan, ...) yang tidak pernah menolak suntingan, dan reportedAt dicap jam server.
/* eslint-disable @typescript-eslint/no-explicit-any -- structuredContent bebas bentuk */
import { describe, it, expect, beforeEach } from '../_vitest';
import { connect, logs, studioMock, type Call } from './mcp-harness';
import { DOC } from '../draft/r3-stateful-harness';
import { clientServer, DOCID, env as cenv } from './implw3-client-mock';
import { buildWorkReport, repairItemTable } from '../../../vendor/scripts/studio/mcp/write-content';

const AGENT = 'cod-implw5';
const env = { STUDIO_AGENT_ID: AGENT, STUDIO_MCP_TOOLSETS: 'write' };
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+07:00$/;

beforeEach(() => {
  logs.length = 0;
});

const editRoutes = () =>
  studioMock({ [`GET /api/studio/documents/${DOC}`]: () => ({ status: 200, body: { document: { id: DOC, docNumber: '040/GSP/LAP/XI/2026', createdBy: `agent:${AGENT}`, currentRevisionNo: 6 }, revision: { revisionNo: 6 } } }) });
const writes = (calls: Call[]) => calls.filter((c) => (c.method === 'POST' || c.method === 'PATCH') && !/\/(render|validate)$/.test(new URL(c.url).pathname));
const codes = (r: any) => [...(r.data.warnings ?? []), ...(r.warnings ?? [])].map((w: any) => w.code);
const items = (m: any) => Object.fromEntries(m.s.latest().sections.record.items.map((i: any) => [i.key, i.status]));

describe('E5: alias status butir (laporan kerja)', () => {
  it('sel status "terblokir" / "butuh tinjauan" / "needs-review" -> kode record, tanpa RECORD_ELEMENTS_DROPPED', async () => {
    const m = editRoutes();
    const { call } = await connect({ fetch: m.f, env });
    const r = await call('studio_edit', { documentId: DOC, edits: [{ cell: { row: 'R3F2-1', column: 'status' }, value: 'terblokir' }, { cell: { row: 'R3F2-2', column: 'status' }, value: 'Butuh Tinjauan' }] });
    expect(r.data.ok, r.text).toBe(true);
    expect(items(m)).toEqual({ 'R3F2-1': 'blocked', 'R3F2-2': 'review' });
    const r2 = await call('studio_edit', { documentId: DOC, edits: [{ cell: { row: 'R3F2-1', column: 'status' }, value: 'needs-review' }] });
    expect(r2.data.ok, r2.text).toBe(true);
    expect(items(m)['R3F2-1']).toBe('review');
  });

  it('status tak terpetakan: suntingan tidak ditolak, butir tetap di record dengan status sebelumnya + catatan', async () => {
    const m = editRoutes();
    const { call } = await connect({ fetch: m.f, env });
    const r = await call('studio_edit', { documentId: DOC, edits: [{ cell: { row: 'R3F2-1', column: 'status' }, value: 'setengah jadi' }, { cell: { row: 'R3F2-1', column: 'judul' }, value: 'Reproduksi temuan ulang' }] });
    expect(r.data.ok, r.text).toBe(true);
    expect(items(m)).toEqual({ 'R3F2-1': 'running', 'R3F2-2': 'done' });
    expect(JSON.stringify(m.s.latest().sections.record.items)).toContain('Reproduksi temuan ulang');
    expect(codes(r)).toContain('ITEM_STATUS_KEPT');
  });

  it('studio_write: tabel alias yang sama (aktif, menunggu, butuh tinjauan, terblokir, tuntas)', () => {
    const rows = repairItemTable([['judul', 'status'], ['A', 'aktif'], ['B', 'menunggu'], ['C', 'butuh tinjauan'], ['D', 'Terblokir'], ['E', 'tuntas'], ['F', 'to do'], ['G', 'dibatalkan']], () => undefined, 'uji', new Set());
    expect(rows.slice(1).map((r) => r[2])).toEqual(['running', 'todo', 'review', 'blocked', 'done', 'todo', 'cancelled']);
  });
});

describe('E6: reportedAt dicap jam server', () => {
  it('studio_write laporan baru tanpa reportedAt -> ReportedAt waktu ISO +07:00; eksplisit menang', () => {
    const now = Date.parse('2026-11-04T03:04:05Z');
    const b = buildWorkReport({ mission: '2026-11-04_x', docKey: 'lap-1', title: null, meta: {}, sections: [{ heading: 'Ringkasan', blocks: ['x'] }], agentId: AGENT, now });
    expect(b.markdown).toContain('ReportedAt: 2026-11-04T10:04:05+07:00');
    const e = buildWorkReport({ mission: '2026-11-04_x', docKey: 'lap-1', title: null, meta: { reportedAt: '2026-11-01' }, sections: [{ heading: 'Ringkasan', blocks: ['x'] }], agentId: AGENT, now });
    expect(e.markdown).toContain('ReportedAt: 2026-11-01');
  });

  it('studio_edit laporan lewat meta tanpa reportedAt -> record.reportedAt = jam server revisi itu; sunting bab saja tidak mengirim record', async () => {
    const m = editRoutes();
    const { call } = await connect({ fetch: m.f, env });
    expect(m.s.latest().sections.record.reportedAt).toBe('2026-11-01T10:00+07:00');
    const r = await call('studio_edit', { documentId: DOC, edits: [{ find: 'Ringkasan awal', replace: 'Ringkasan sesudah sunting' }] });
    expect(r.data.ok, r.text).toBe(true);
    // IMPL-W10 (review 17 #5): cap hanya bila record ikut terkirim (meta, sel tabel butir/Rujukan, medan record).
    expect(m.s.latest().sections.record.reportedAt).toBe('2026-11-01T10:00+07:00');
    const r1 = await call('studio_edit', { documentId: DOC, meta: { status: 'complete' } });
    expect(r1.data.ok, r1.text).toBe(true);
    expect(m.s.latest().sections.record.reportedAt).toMatch(STAMP);
    const r2 = await call('studio_edit', { documentId: DOC, meta: { status: 'complete', reportedAt: '2026-11-02' } });
    expect(r2.data.ok, r2.text).toBe(true);
    expect(m.s.latest().sections.record.reportedAt).toBe('2026-11-02');
  });
});

// Server laporan kerja milik pemanggil (pola implw4-meta `own`): R04 daftar, R21, R05 penulis terakhir = pemanggil.
import { MD, statefulServer } from '../draft/r3-stateful-harness';
import { reply } from './mcp-harness';
const MISSION = '2026-11-01_r3f2';
const DOCKEY = 'lapkerja-r3f2-uji';
const OWNER = 'cod-r3-f2';
const envOwn = { STUDIO_AGENT_ID: OWNER, STUDIO_MCP_TOOLSETS: 'write' };
function own() {
  const s = statefulServer(MD());
  const calls: Call[] = [];
  const f = async (url: string, init: any) => {
    const u = new URL(url);
    calls.push({ method: init.method, url, headers: init.headers, redirect: init.redirect, body: init.body ? JSON.parse(init.body) : undefined });
    if (init.method === 'GET' && u.pathname === '/api/studio/documents') return reply({ status: 200, body: { documents: [{ id: DOC, createdBy: `agent:${OWNER}`, currentRevisionNo: s.rev() }] } });
    if (init.method === 'GET' && u.pathname === '/api/studio/contracts') return reply({ status: 200, body: { contracts: [{ documentId: DOC }], nextCursor: null } });
    if (init.method === 'GET' && u.pathname === `/api/studio/documents/${DOC}`) return reply({ status: 200, body: { document: { id: DOC, docNumber: '040/GSP/LAP/XI/2026', createdBy: `agent:${OWNER}`, currentRevisionNo: s.rev() }, revision: { revisionNo: s.rev(), createdBy: `agent:${OWNER}` } } });
    if (init.method === 'PATCH' && u.pathname === `/api/studio/documents/${DOC}/structure`) return reply({ status: 200, body: { document: { id: DOC }, revision: { revisionNo: s.rev() } } });
    return s.f(url, init);
  };
  return { f, calls, s };
}

describe('E5/E6 pada studio_write atas laporan sendiri yang sudah ada', () => {
  it('tulis parsial (tanpa Rincian kerja, tanpa meta) -> ReportedAt dicap; ulangan identik -> tidak berubah', async () => {
    const m = own();
    const { call } = await connect({ fetch: m.f as any, env: envOwn });
    const r = await call('studio_write', { mission: MISSION, docKey: DOCKEY, sections: [{ heading: 'Ringkasan', blocks: ['Ringkasan baru IMPL-W5.'] }] });
    expect(r.data.ok, r.text).toBe(true);
    expect(m.s.latest().sections.record.reportedAt).toMatch(STAMP);
    const n = writes(m.calls).length;
    const r2 = await call('studio_write', { mission: MISSION, docKey: DOCKEY, sections: [{ heading: 'Ringkasan', blocks: ['Ringkasan baru IMPL-W5.'] }] });
    expect(r2.data.ok, r2.text).toBe(true);
    expect(writes(m.calls).length).toBe(n);
  });

  it('tulis ulang dengan Rincian kerja: status butir tak dikenal untuk butir lama -> status lama dipakai (tanpa RECORD_ELEMENTS_DROPPED)', async () => {
    const m = own();
    const { call } = await connect({ fetch: m.f as any, env: envOwn });
    const r = await call('studio_write', { mission: MISSION, docKey: DOCKEY, sections: [
      { heading: 'Ringkasan', blocks: ['Ringkasan awal.'] },
      { heading: 'Rincian kerja', blocks: [[['key', 'judul', 'status', 'bukti'], ['R3F2-1', 'Reproduksi temuan', 'separuh', 'out/probe.txt 120 B sha 55d324b1'], ['R3F2-2', 'Uji refresh', 'terblokir', 'out/uji.txt 64 B sha 0a1b2c3d']]] },
    ] });
    expect(r.data.ok, r.text).toBe(true);
    expect(items(m)).toEqual({ 'R3F2-1': 'running', 'R3F2-2': 'blocked' });
    expect(codes(r)).toContain('ITEM_STATUS_KEPT');
  });
});

describe('E1/E2: append dan addRow (laporan kerja)', () => {
  it('append: paragraf + daftar + tabel di akhir section Bukti, urut; satu revisi', async () => {
    const m = editRoutes();
    const { call } = await connect({ fetch: m.f, env });
    const r = await call('studio_edit', { documentId: DOC, edits: [{ section: 'Bukti', append: ['Paragraf tambahan pertama.', { list: ['butir a', 'butir b'] }, { table: [['uji', 'hasil'], ['vitest', '12 lulus']], caption: 'Hasil uji tambahan' }] }] });
    expect(r.data.ok, r.text).toBe(true);
    const blocks = m.s.chapter('3').sections[0].blocks;
    expect(blocks.map((b: any) => b.type).slice(-4)).toEqual(['paragraph', 'list', 'table', 'paragraph']);
    expect(JSON.stringify(blocks.slice(-4))).toContain('Paragraf tambahan pertama.');
    expect(JSON.stringify(blocks[0])).toContain('Bukti awal');
  });

  it('append string tunggal ke "bab 4" dan ke judul; append berisi sintaks struktur tetap teks', async () => {
    const m = editRoutes();
    const { call } = await connect({ fetch: m.f, env });
    const r = await call('studio_edit', { documentId: DOC, edits: [{ section: 'bab 4', append: 'Isu baru muncul.' }, { section: 'Langkah berikut', append: '## Bukan judul | a | b |' }] });
    expect(r.data.ok, r.text).toBe(true);
    expect(JSON.stringify(m.s.chapter('4'))).toContain('Isu baru muncul.');
    const ch5 = m.s.chapter('5');
    expect(ch5.sections.length).toBe(1);
    expect(ch5.sections[0].blocks.at(-1)).toEqual({ type: 'paragraph', text: '## Bukan judul | a | b |' });
  });

  it('addRow ke tabel butir: kunci stabil dibangkitkan, status alias, butir masuk record', async () => {
    const m = editRoutes();
    const { call } = await connect({ fetch: m.f, env });
    const r = await call('studio_edit', { documentId: DOC, edits: [{ section: 'Rincian kerja', addRow: [['', 'Uji tambahan W5', 'terblokir', 'out/w5.txt 10 B sha 1234abcd'], ['R3F2-9', 'Butir sembilan', 'selesai', '']] }] });
    expect(r.data.ok, r.text).toBe(true);
    const it = items(m);
    expect(it['R3F2-9']).toBe('done');
    expect(Object.entries(it).find(([k]) => k.startsWith('K-'))?.[1]).toBe('blocked');
    expect(Object.keys(it).length).toBe(4);
  });

  it('addRow lebar salah -> EDIT_INVALID dengan judul kolom di rincian, 0 tulis', async () => {
    const m = editRoutes();
    const { call } = await connect({ fetch: m.f, env });
    const r = await call('studio_edit', { documentId: DOC, edits: [{ section: 'Rincian kerja', addRow: ['x', 'y'] }] });
    expect(r.data.ok).toBe(false);
    expect(r.data.error.code).toBe('EDIT_INVALID');
    expect(r.data.error.details.expectedHeader).toEqual(['key', 'judul', 'status', 'bukti']);
    expect(writes(m.calls)).toEqual([]);
  });
});

describe('E3/E4: batch berurutan, cadangan isi tersimpan, terapkan sebagian', () => {
  it('sel dengan kunci baris yang diubah suntingan sebelumnya -> dipetakan dari isi tersimpan', async () => {
    const m = editRoutes();
    const { call } = await connect({ fetch: m.f, env });
    const r = await call('studio_edit', { documentId: DOC, edits: [
      { cell: { row: 'Reproduksi temuan', column: 'judul' }, value: 'Replikasi ulang' },
      { cell: { row: 'Reproduksi temuan', column: 'status' }, value: 'done' },
    ] });
    expect(r.data.ok, r.text).toBe(true);
    expect(items(m)['R3F2-1']).toBe('done');
    expect(codes(r)).toContain('ADDRESS_FROM_STORED');
  });

  it('jangkar after pada paragraf yang diganti sebelumnya + jangkar pada teks hasil suntingan sebelumnya', async () => {
    const m = editRoutes();
    const { call } = await connect({ fetch: m.f, env });
    const r = await call('studio_edit', { documentId: DOC, edits: [
      { find: 'Ringkasan awal.', replace: 'Ringkasan diganti seed 909 atas byte yang sama.' },
      { after: 'seed 909 atas byte yang sama.', insert: 'Sisipan A.' },
      { after: 'Ringkasan awal.', insert: 'Sisipan B.' },
    ] });
    expect(r.data.ok, r.text).toBe(true);
    const t = JSON.stringify(m.s.chapter('1'));
    expect(t.indexOf('seed 909')).toBeLessThan(t.indexOf('Sisipan'));
    expect(t).toContain('Sisipan A.');
    expect(t).toContain('Sisipan B.');
  });

  it('sebagian gagal alamat -> suntingan lain tersimpan, notApplied + kandidat di blok, bukan isError', async () => {
    const m = editRoutes();
    const { call } = await connect({ fetch: m.f, env });
    const r = await call('studio_edit', { documentId: DOC, edits: [
      { find: 'Ringkasan awal.', replace: 'Ringkasan baru.' },
      { after: 'teks yang tidak ada di mana pun', insert: 'X.' },
      { section: 'Bab Fiktif', append: 'Y.' },
    ] });
    expect(r.isError).toBeFalsy();
    expect(r.data.ok, r.text).toBe(true);
    expect(JSON.stringify(m.s.chapter('1'))).toContain('Ringkasan baru.');
    expect(r.data.notApplied.map((x: any) => [x.edit, x.code, x.seenState])).toEqual([[2, 'TEXT_NOT_FOUND', 'sesudah-suntingan-sebelumnya'], [3, 'TEXT_NOT_FOUND', 'sesudah-suntingan-sebelumnya']]);
    expect(r.data.untrustedFields).toContain('notApplied');
    expect(r.text).toContain('tidak diterapkan: edit 2 TEXT_NOT_FOUND, edit 3 TEXT_NOT_FOUND');
    expect(new Set(writes(m.calls).map((c) => c.body.baseRevisionNo))).toEqual(new Set([6]));
  });

  it('semua gagal alamat -> ok:false seperti dulu, 0 tulis; galat non-alamat menolak seluruh batch', async () => {
    const m = editRoutes();
    const { call } = await connect({ fetch: m.f, env });
    const r = await call('studio_edit', { documentId: DOC, edits: [{ after: 'tidak ada sama sekali', insert: 'X.' }] });
    expect(r.data.ok).toBe(false);
    expect(r.data.error.code).toBe('TEXT_NOT_FOUND');
    const r2 = await call('studio_edit', { documentId: DOC, edits: [{ find: 'Ringkasan awal.', replace: 'Ringkasan baru.' }, { find: 'Bukti awal', replace: '' }] });
    expect(r2.data.ok).toBe(false);
    expect(r2.data.error.code).toBe('EDIT_INVALID');
    expect(writes(m.calls)).toEqual([]);
  });
});

describe('E1/E2/E3/E4: dokumen klien', () => {
  it('addRow ke tabel terakhir + append paragraf + tabel bersumber ke bab Kinerja; bab lain tidak dikirim', async () => {
    const m = clientServer({ exists: true });
    const { call } = await connect({ fetch: m.f as any, env: cenv });
    const r = await call('studio_edit', { documentId: DOCID, edits: [
      { section: 'Kinerja', addRow: ['D', '71'] },
      { section: 'Kinerja', append: ['Catatan kinerja tambahan.', { table: [['Gardu', 'Beban (MW)'], ['A', 12]], caption: 'Beban per gardu', source: 'SCADA' }] },
    ] });
    expect(r.data.ok, r.text).toBe(true);
    const ch2 = m.content().sections.content.chapters.find((c: any) => c.key === '2');
    expect(ch2.intro[0].rows.map((x: any) => x.cells[0].text)).toEqual(['Gardu', 'C', 'D']);
    expect(ch2.intro.map((b: any) => b.type)).toEqual(['table', 'paragraph', 'table']);
    expect(r.data.edited).toEqual(['bab 2']);
  });

  it('append tabel angka tanpa sumber -> galat isi (bukan alamat) menolak batch, 0 tulis', async () => {
    const m = clientServer({ exists: true });
    const { call } = await connect({ fetch: m.f as any, env: cenv });
    const r = await call('studio_edit', { documentId: DOCID, edits: [{ find: 'Paragraf pembuka lama.', replace: 'Paragraf pembuka baru.' }, { section: 'Kinerja', append: [{ table: [['Gardu', 'Beban (MW)'], ['A', 12]], caption: 'Beban' }] }] });
    expect(r.data.ok).toBe(false);
    expect(r.data.error.code).toBe('SOURCE_MISSING');
    expect(m.calls.filter((c) => (c.method === 'POST' || c.method === 'PATCH') && !c.url.endsWith('/validate'))).toEqual([]);
  });

  it('sel dengan kunci baris yang diubah sebelumnya (cadangan) + sebagian gagal -> notApplied', async () => {
    const m = clientServer({ exists: true });
    const { call } = await connect({ fetch: m.f as any, env: cenv });
    const r = await call('studio_edit', { documentId: DOCID, edits: [
      { cell: { row: 'C', column: 'Gardu' }, value: 'C2' },
      { cell: { row: 'C', column: 'Indeks' }, value: '66' },
      { after: 'tidak ada teks ini', insert: 'X.' },
    ] });
    expect(r.data.ok, r.text).toBe(true);
    const ch2 = m.content().sections.content.chapters.find((c: any) => c.key === '2');
    expect(ch2.intro[0].rows[1].cells.map((c: any) => c.text)).toEqual(['C2', '66']);
    expect(r.data.notApplied.map((x: any) => x.edit)).toEqual([3]);
  });
});
