// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/mcp/implw4-lows.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
// IMPL-W4 butir 6: sisa Low review 13.
// S2-2r: bagian yang sudah ada di server dengan penulis R15 null/tidak tercatat dan isi berbeda -> PART_CHANGED_BY_OTHER,
//        kecuali sesi MCP ini sendiri yang menulisnya.
// W3-L1r: pemetaan pid -> satuan tidak menghitung butir daftar.
// Petunjuk ulang untuk galat nyata server menyebut server sebagai penyebab.
/* eslint-disable @typescript-eslint/no-explicit-any -- structuredContent bebas bentuk */
import { describe, it, expect, beforeEach } from '../_vitest';
import { connect, logs, reply } from './mcp-harness';
import { DOC, MD, statefulServer } from '../draft/r3-stateful-harness';
import { clientServer, DOCID, env, WRITE_ARGS, writes } from './implw3-client-mock';

beforeEach(() => {
  logs.length = 0;
});

/** Server klien yang melaporkan penulis slot `cover` = null (seperti data lama / DEV untuk cover). */
function nullCoverWriter(m: ReturnType<typeof clientServer>) {
  return async (url: string, init: any) => {
    const res = await m.f(url, init);
    if (new URL(url).pathname !== `/api/studio/documents/${DOCID}/completeness`) return res;
    const body = JSON.parse(await res.text());
    for (const s of body.completeness.slots) if (s.slotKey === 'cover') s.lastFilledBy = null;
    return reply({ status: 200, body });
  };
}

describe('S2-2r: penulis bagian tidak tercatat', () => {
  it('sesi lain: cover (penulis null) berbeda dari server -> PART_CHANGED_BY_OTHER, 0 tulis', async () => {
    const m = clientServer({ exists: true });
    const f = nullCoverWriter(m);
    const { call } = await connect({ fetch: f as any, env });
    const n = m.calls.length;
    const r = await call('studio_write', { ...WRITE_ARGS, meta: { ...WRITE_ARGS.meta, number: 'GSP-W4-777' } });
    expect(r.data.ok, r.text).toBe(false);
    expect(r.data.error.code).toBe('PART_CHANGED_BY_OTHER');
    expect(writes(m.calls.slice(n))).toEqual([]);
  });

  it('sesi yang sama menulis cover lebih dulu -> tulis ulang diizinkan walau penulis R15 null', async () => {
    const m = clientServer();
    const f = nullCoverWriter(m);
    const { call } = await connect({ fetch: f as any, env });
    const r1 = await call('studio_write', WRITE_ARGS);
    expect(r1.data.ok, r1.text).toBe(true);
    const r2 = await call('studio_write', { ...WRITE_ARGS, meta: { ...WRITE_ARGS.meta, number: 'GSP-W4-778' } });
    expect(r2.data.ok, r2.text).toBe(true);
    expect(JSON.stringify(m.content().sections.cover)).toContain('GSP-W4-778');
  });
});

describe('W3-L1r: butir daftar tidak menggeser pemetaan pid', () => {
  it('review 13 Q1: paragraf berteks "- ..." kembar dengan butir daftar sebelumnya -> yang berubah paragraf ber-pid, bukan butir', async () => {
    const s = statefulServer(MD({ bab3: ['- Hasil uji sama persis.', '', '\\- Hasil uji sama persis.'] }));
    const blocks = s.chapter('3').sections[0].blocks;
    blocks.forEach((b: any, i: number) => (b.id = `p-pos${i}`));
    const para = blocks.find((b: any) => b.type === 'paragraph');
    expect(para?.text ?? (para?.runs ?? []).map((x: any) => x.t).join('')).toBe('- Hasil uji sama persis.');
    const f = async (url: string, init: any) => {
      if (init.method === 'GET' && new URL(url).pathname === `/api/studio/documents/${DOC}`) return reply({ status: 200, body: { document: { id: DOC, createdBy: 'agent:cod-r3-f2', currentRevisionNo: s.rev() } } });
      return s.f(url, init);
    };
    const { call } = await connect({ fetch: f as any, env: { STUDIO_AGENT_ID: 'cod-r3-f2', STUDIO_MCP_TOOLSETS: 'write' } });
    const r = await call('studio_edit', { documentId: DOC, edits: [{ pid: para.id, at: 12, length: 4, replace: 'beda', expect: 'sama' }] });
    expect(r.data.ok, r.text).toBe(true);
    const after = s.chapter('3').sections[0].blocks;
    const text = (b: any) => b.text ?? (b.runs ?? []).map((x: any) => x.t).join('');
    expect(text(after.find((b: any) => b.type === 'paragraph'))).toBe('- Hasil uji beda persis.');
    expect(JSON.stringify(after.find((b: any) => b.type === 'list'))).toContain('Hasil uji sama persis.');
  });
});

describe('petunjuk ulang galat server', () => {
  it('galat 500 identik ke-3 -> petunjuk menyebut server, bukan "ubah isi"', async () => {
    const f = async (url: string) => (new URL(url).pathname === `/api/studio/documents/${DOC}` ? reply({ status: 500, body: { error: 'boom', code: 'INTERNAL_ERROR' } }) : reply({ status: 404, body: { code: 'ROUTE_NOT_FOUND' } }));
    const { call } = await connect({ fetch: f as any, env: { STUDIO_AGENT_ID: 'cod-r3-f2', STUDIO_MCP_TOOLSETS: 'write' } });
    const rs = [];
    for (let i = 0; i < 3; i++) rs.push(await call('studio_edit', { documentId: DOC, edits: [{ find: 'satu dua tiga', replace: 'x' }] }));
    expect(rs[2].data.hint).toContain('server bermasalah; tunggu lalu coba lagi');
    expect(rs[2].data.hint).not.toContain('ubah isi');
  });
});

describe('smoke r5b RV-4: suntingan data grafik mempertahankan bentuk', () => {
  it('K-01 bertumpuk + data 3 seri baru tanpa stacked/type -> tetap K-01 (bukan P-03 berkelompok)', async () => {
    const { applyClientEdits } = await import('../../../vendor/scripts/studio/mcp/write-client-edit');
    const chart = { type: 'chart', id: 'p-fig', code: 'K-01', data: { shape: 'series', categories: ['High', 'Medium'], series: [{ name: 'Critical', values: [0, 1] }, { name: 'High', values: [1, 5] }, { name: 'Medium', values: [3, 3] }] }, caption: { text: 'Jumlah ancaman' }, source: { text: 'Table 6.1' } };
    const content: any = { meta: { title: 'X' }, sections: { content: { type: 'chapter', chapters: [{ key: '1', id: 'bab-1', title: { text: 'A' }, sections: [], intro: [chart] }] } } };
    const res = applyClientEdits(content, [{ figure: 'Jumlah ancaman', chart: { categories: ['High', 'Medium-High', 'Medium'], series: [{ name: 'Critical', values: [0, 0, 1] }, { name: 'High', values: [1, 0, 5] }, { name: 'Medium', values: [3, 1, 2] }] } } as any], () => undefined);
    expect(res.charts[0].patch.code).toBe('K-01');
    expect(content.sections.content.chapters[0].intro[0].data.categories).toEqual(['High', 'Medium-High', 'Medium']);
  });
});
