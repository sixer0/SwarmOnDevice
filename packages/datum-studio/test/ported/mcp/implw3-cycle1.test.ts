// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/mcp/implw3-cycle1.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
// IMPL-W3 siklus perbaikan 1 (D-539, review 13 bagian IMPL-W3): probe p13-p16 dan D8 sebagai uji.
// W3-M1 tulis ulang tak lengkap tidak menghapus record; W3-L1 posisi tepat pada pid; W3-L2 surrogate; W3-L3 jenis blok
// per bab (juga S2-1); W3-L4/S2-2/L-5 penulis terakhir per bagian; W3-I2 salinan depan samar; W3-I1 pembatas ulang.
/* eslint-disable @typescript-eslint/no-explicit-any -- structuredContent bebas bentuk */
import { describe, it, expect, beforeEach } from '../_vitest';
import { connect, logs, reply, type Call } from './mcp-harness';
import { DOC, MD, statefulServer } from '../draft/r3-stateful-harness';
import { applyClientEdits } from '../../../vendor/scripts/studio/mcp/write-client-edit';
import { clientServer, DOCID, env as cenv, WRITE_ARGS } from './implw3-client-mock';

const AGENT = 'cod-r3-f2';
const MISSION = '2026-11-01_r3f2';
const DOCKEY = 'lapkerja-r3f2-uji';
const env = { STUDIO_AGENT_ID: AGENT, STUDIO_MCP_TOOLSETS: 'write' };
const FIVE = [
  { heading: 'Ringkasan', blocks: ['Ringkasan awal.'] },
  { heading: 'Rincian kerja', blocks: [[['key', 'judul', 'status', 'bukti'], ['R3F2-1', 'Reproduksi temuan', 'running', 'out/probe.txt 120 B sha 55d324b1'], ['R3F2-2', 'Uji refresh', 'done', 'out/uji.txt 64 B sha 0a1b2c3d']]] },
  { heading: 'Bukti', blocks: ['Bukti awal.'] },
  { heading: 'Isu terbuka', blocks: ['Tidak ada.'] },
  { heading: 'Langkah berikut', blocks: ['Lanjut.'] },
];

beforeEach(() => {
  logs.length = 0;
});

/** Laporan kerja sendiri yang sudah ada (pemilik + penulis terakhir dinamis); onPost dapat menyela kiriman. */
function own(seed = MD(), o: { onPost?: (c: Call, s: any, st: any) => any } = {}) {
  const s = statefulServer(seed);
  const st = { lastWriter: `agent:${AGENT}`, metaSet: 0 };
  const calls: Call[] = [];
  const f = async (url: string, init: any) => {
    const u = new URL(url);
    const c: Call = { method: init.method, url, headers: init.headers, redirect: init.redirect, body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(c);
    if (init.method === 'GET' && u.pathname === '/api/studio/documents') return reply({ status: 200, body: { documents: [{ id: DOC, createdBy: `agent:${AGENT}`, currentRevisionNo: s.rev() }] } });
    if (init.method === 'GET' && u.pathname === '/api/studio/contracts') return reply({ status: 200, body: { contracts: [{ documentId: DOC }], nextCursor: null } });
    if (init.method === 'GET' && u.pathname === `/api/studio/documents/${DOC}`) return reply({ status: 200, body: { document: { id: DOC, docNumber: '040/GSP/LAP/XI/2026', createdBy: `agent:${AGENT}`, currentRevisionNo: s.rev() }, revision: { revisionNo: s.rev(), createdBy: st.lastWriter } } });
    if (init.method === 'PATCH' && u.pathname === `/api/studio/documents/${DOC}/structure`) {
      st.lastWriter = `agent:${c.body?.agentId}`;
      st.metaSet++;
      return reply({ status: 200, body: { document: { id: DOC }, revision: { revisionNo: s.rev() } } });
    }
    if (init.method === 'POST' && o.onPost) {
      const r = await o.onPost(c, s, st);
      if (r) return r;
    }
    const res = await s.f(url, init);
    if (init.method === 'POST' && c.body?.agentId) st.lastWriter = `agent:${c.body.agentId}`;
    return res;
  };
  return { f, calls, s, st };
}
const posts = (calls: Call[]) => calls.filter((c: any) => c.method === 'POST' && !new URL(c.url).pathname.endsWith('/validate') && !new URL(c.url).pathname.endsWith('/render'));

describe('W3-M1: tulis ulang tak lengkap atas laporan sendiri yang lengkap', () => {
  it.each([
    ['N1 hanya Ringkasan', [{ heading: 'Ringkasan', blocks: ['Ringkasan baru.'] }]],
    ['N2 semua kecuali Rincian kerja', [{ heading: 'Ringkasan', blocks: ['R.'] }, { heading: 'Bukti', blocks: ['B.'] }, { heading: 'Isu terbuka', blocks: ['I.'] }, { heading: 'Langkah berikut', blocks: ['L.'] }]],
  ])('%s: butir + bukti record tetap, bab yang tidak ditulis tetap, missing dihitung dari server', async (_n, sections) => {
    const m = own();
    const rec0 = structuredClone(m.s.latest().sections.record);
    const ch2 = JSON.stringify(m.s.chapter('2'));
    const { call } = await connect({ fetch: m.f as any, env });
    const r = await call('studio_write', { mission: MISSION, docKey: DOCKEY, meta: { status: 'partial' }, sections });
    expect(r.isError, r.text).toBeFalsy();
    expect(r.data.ok, r.text).toBe(true);
    const rec1 = m.s.latest().sections.record;
    expect(rec1.items?.length).toBe(rec0.items.length);
    expect(rec1.evidence?.length ?? 0).toBe(rec0.evidence?.length ?? 0);
    expect(JSON.stringify(m.s.chapter('2'))).toBe(ch2);
    expect(r.data.missing ?? []).toEqual([]);
    expect(r.data.state).not.toBe('INCOMPLETE');
    // IMPL-W5 E6: record boleh terkirim hanya untuk cap ReportedAt (jam server); butir/bukti tetap (asersi di atas).
    expect(rec1.reportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+07:00$/);
    expect(JSON.stringify(m.s.chapter('1'))).toContain(sections[0].blocks[0]);
  });
});

describe('W3-L1 / W3-L2: posisi', () => {
  function srv(bab3: string[]) {
    const s = statefulServer(MD({ bab3 }));
    s.chapter('3').sections[0].blocks.forEach((b: any, i: number) => (b.id = `p-pos${i}`));
    const f = async (url: string, init: any) => {
      if (init.method === 'GET' && new URL(url).pathname === `/api/studio/documents/${DOC}`) return reply({ status: 200, body: { document: { id: DOC, createdBy: `agent:${AGENT}`, currentRevisionNo: s.rev() } } });
      return s.f(url, init);
    };
    return { s, f };
  }
  const texts = (s: any) => s.chapter('3').sections[0].blocks.map((b: any) => b.text ?? (b.runs ?? []).map((r: any) => r.t).join(''));

  it('Q5: paragraf ber-pid bermarkah vs kembar polos -> yang berubah paragraf pid itu', async () => {
    const m = srv(['Hasil uji **lulus** semua kasus.', '', 'Hasil uji lulus semua kasus.']);
    const { call } = await connect({ fetch: m.f as any, env });
    const r = await call('studio_edit', { documentId: DOC, edits: [{ pid: 'p-pos0', at: 10, length: 5, replace: 'gagal', expect: 'lulus' }] });
    expect(r.data.ok, r.text).toBe(true);
    expect(texts(m.s)).toEqual(['Hasil uji gagal semua kasus.', 'Hasil uji lulus semua kasus.']);
  });

  it('Q1: offset memotong pasangan surrogate -> POSITION_INVALID (hasil normal, 0 tulis)', async () => {
    const m = srv(['Bukti 😀 awal sekali.']);
    const { call } = await connect({ fetch: m.f as any, env });
    const r = await call('studio_edit', { documentId: DOC, edits: [{ pid: 'p-pos0', at: 7, length: 0, replace: 'X' }] });
    expect(r.isError).toBeFalsy();
    expect(r.data.code).toBe('POSITION_INVALID');
    expect(texts(m.s)).toEqual(['Bukti 😀 awal sekali.']);
  });

  it('Q7 (klien): length memotong surrogate -> POSITION_INVALID', () => {
    const c: any = { meta: {}, sections: { content: { chapters: [{ key: '1', title: { text: 'A' }, intro: [{ type: 'paragraph', id: 'p-1', text: 'Paragraf 😀 lama.' }], sections: [] }] } } };
    expect(() => applyClientEdits(c, [{ pid: 'p-1', at: 9, length: 1, replace: 'X' }] as any, () => undefined)).toThrow(expect.objectContaining({ code: 'POSITION_INVALID' }));
  });
});

describe('W3-L3 / S2-1: jenis blok per bab', () => {
  const T3 = '`'.repeat(3);
  const bab3 = ['Paragraf sebelum.', '', `${T3}text Keluaran uji`, 'Test Files  25 passed (25)', 'baris kedua kode', T3, '', 'Paragraf sesudah.'];
  const kinds = (s: any) => s.chapter('3').sections[0].blocks.map((b: any) => b.type);

  it('K2: find tingkat polos (backtick) ke blok kode tidak meratakan kode menjadi paragraf', async () => {
    const m = own(MD({ bab3 }));
    const before = kinds(m.s);
    const { call } = await connect({ fetch: m.f as any, env });
    const r = await call('studio_edit', { documentId: DOC, edits: [{ find: '`baris kedua` kode', replace: 'baris kedua kode diubah' }] });
    expect(r.isError).toBeFalsy();
    expect(kinds(m.s)).toEqual(before);
  });

  it('S2-1: dua suntingan yang mengubah paragraf menjadi daftar -> CONTENT_INJECTION, 0 tulis', async () => {
    const m = own();
    const { call } = await connect({ fetch: m.f as any, env });
    const r = await call('studio_edit', { documentId: DOC, edits: [{ find: 'Bukti awal.', replace: 'ZQX- butir palsu' }, { find: 'ZQX', replace: ' ' }] });
    expect(r.isError).toBeFalsy();
    expect(r.data.code).toBe('CONTENT_INJECTION');
    expect(posts(m.calls)).toEqual([]);
  });
});

describe('W3-L4 / S2-2 / L-5: penulis terakhir per bagian', () => {
  it('T1: pihak lain menulis bab 3 di sela kiriman -> tulisannya tetap', async () => {
    let first = true;
    const m = own(MD(), {
      onPost: async (c: Call, s: any, st: any) => {
        if (first) {
          first = false;
          const ch = structuredClone(s.chapter('3'));
          ch.sections[0].blocks = [{ type: 'paragraph', text: 'Ditulis agen lain.' }];
          await s.f('http://127.0.0.1:9021/api/studio/chapters', { method: 'POST', headers: {}, redirect: 'manual', body: JSON.stringify({ $schema: 'studio.chapter/v2', agentId: 'cod-lain', target: { documentId: DOC }, chapter: ch }) });
          st.lastWriter = 'agent:cod-lain';
          return reply({ status: 409, body: { error: 'meta berbeda', code: 'META_CONFLICT', details: { fields: { title: { current: 'Laporan uji R3-F2', submitted: 'Judul baru' } } } } });
        }
        return null;
      },
    });
    const { call } = await connect({ fetch: m.f as any, env });
    const r = await call('studio_write', { mission: MISSION, docKey: DOCKEY, title: 'Judul baru', sections: FIVE.map((x) => (x.heading === 'Bukti' ? { heading: 'Bukti', blocks: ['Bukti versi saya.'] } : x)) });
    expect(r.isError).toBeFalsy();
    expect(JSON.stringify(m.s.chapter('3'))).toContain('Ditulis agen lain.');
  });

  it('laporan: bab yang terakhir ditulis pihak lain -> PART_CHANGED_BY_OTHER (hasil normal), 0 tulis', async () => {
    const m = own();
    const ch = structuredClone(m.s.chapter('3'));
    ch.sections[0].blocks = [{ type: 'paragraph', text: 'Ditulis agen lain.' }];
    await m.s.f('http://127.0.0.1:9021/api/studio/chapters', { method: 'POST', headers: {}, redirect: 'manual', body: JSON.stringify({ $schema: 'studio.chapter/v2', agentId: 'cod-lain', target: { documentId: DOC }, chapter: ch }) });
    const ch1 = structuredClone(m.s.chapter('1'));
    ch1.sections[0].blocks = [{ type: 'paragraph', text: 'Ringkasan saya.' }];
    await m.s.f('http://127.0.0.1:9021/api/studio/chapters', { method: 'POST', headers: {}, redirect: 'manual', body: JSON.stringify({ $schema: 'studio.chapter/v2', agentId: AGENT, target: { documentId: DOC }, chapter: ch1 }) });
    const n0 = posts(m.calls).length;
    const { call } = await connect({ fetch: m.f as any, env });
    const r = await call('studio_write', { mission: MISSION, docKey: DOCKEY, sections: FIVE });
    expect(r.isError).toBeFalsy();
    expect(r.data.code).toBe('PART_CHANGED_BY_OTHER');
    expect(r.data.error.details.parts).toContain('bab 3');
    expect(posts(m.calls).length).toBe(n0);
    expect(JSON.stringify(m.s.chapter('3'))).toContain('Ditulis agen lain.');
  });

  it('D8 (klien): sel milik pihak lain yang lebih lama tidak tertimpa tulis ulang utuh', async () => {
    const m = clientServer({ exists: true });
    const { call } = await connect({ fetch: m.f as any, env: cenv });
    m.other('chapter:2', (c: any) => (c.sections.content.chapters[1].intro[0].rows[1].cells[1] = { text: '99' }));
    const e = await call('studio_edit', { documentId: DOCID, edits: [{ find: 'Paragraf pembuka lama.', replace: 'Paragraf saya.' }] });
    expect(e.data.ok, e.text).toBe(true);
    const w = await call('studio_write', { ...WRITE_ARGS });
    expect(w.isError).toBeFalsy();
    expect(w.data.code).toBe('PART_CHANGED_BY_OTHER');
    const tbl = m.content().sections.content.chapters.find((c: any) => c.key === '2');
    expect(JSON.stringify(tbl)).toContain('"99"');
  });
});

describe('W3-I2: salinan depan klien lewat samar', () => {
  it('samar yang mengenai > 1 medan depan -> TEXT_AMBIGUOUS tanpa occurrence all; persis tetap diganti bersama', () => {
    const c = () => ({ meta: { title: 'Kajian Tim Riset', author: 'TIM RISET' }, sections: {} });
    expect(() => applyClientEdits(c() as any, [{ find: 'tim riset', replace: 'Tim Baru' }] as any, () => undefined)).toThrow(expect.objectContaining({ code: 'TEXT_AMBIGUOUS' }));
    const ok: any = c();
    applyClientEdits(ok, [{ find: 'tim riset', replace: 'Tim Baru', occurrence: 'all' }] as any, () => undefined);
    expect(ok.meta).toEqual({ title: 'Kajian Tim Baru', author: 'Tim Baru' });
    const same: any = { meta: { title: 'X', author: 'Tim A' }, sections: { signature: { type: 'signatureBlock', roles: [{ role: { text: 'Disusun' }, holder: { text: 'Tim A' } }] } } };
    applyClientEdits(same, [{ find: 'Tim A', replace: 'Tim B' }] as any, () => undefined);
    expect(JSON.stringify(same)).not.toContain('Tim A');
  });
});

describe('W3-I1: pembatas ulang di sesi', () => {
  it('penolakan identik ke-3 berturut-turut -> hint berhenti mengulang; 429 membawa retryAfterSec; tidak isError', async () => {
    const m = own();
    const { call } = await connect({ fetch: m.f as any, env });
    const rs = [];
    for (let i = 0; i < 3; i++) rs.push(await call('studio_edit', { documentId: DOC, edits: [{ find: 'tidak ada di dokumen ini xyz', replace: 'a' }] }));
    expect(rs.map((r) => r.isError ?? false)).toEqual([false, false, false]);
    expect(rs[1].data.hint).not.toContain('berhenti mengulang');
    expect(rs[2].data.hint).toContain('berhenti mengulang; ubah isi atau tanya controller');
    let n = 0;
    const lim = async (url: string, init: any) => (++n > 0 && new URL(url).pathname === `/api/studio/documents/${DOC}` ? reply({ status: 429, body: { error: 'lambat', code: 'RATE_LIMITED' }, headers: { 'retry-after': '12' } }) : m.f(url, init));
    const b = await connect({ fetch: lim as any, env });
    const q = await b.call('studio_edit', { documentId: DOC, edits: [{ find: 'a', replace: 'b' }] });
    expect(q.isError).toBeFalsy();
    expect(q.data.retryAfterSec).toBe(12);
  });
});
