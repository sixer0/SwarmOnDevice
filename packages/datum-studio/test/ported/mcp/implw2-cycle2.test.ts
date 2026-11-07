// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/mcp/implw2-cycle2.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
// IMPL-W2 siklus perbaikan 2 (D-531, review 13 "Siklus 1"): R-1 pelepasan escape bertahap dan komentar HTML di
// studio_edit laporan kerja (probe B2, B3, B4, H1), cek struktur pasca-konversi studio_edit, dan perbandingan teks
// paragraf di assertShape (probe K1-K3). Probe asal: scratchpad/implw/p6_bypass, p8_comment, p9_comment_edit.
/* eslint-disable @typescript-eslint/no-explicit-any -- structuredContent bebas bentuk */
import { describe, it, expect } from '../_vitest';
import { connect, reply, type Call } from './mcp-harness';
import { DOC, MD, statefulServer } from '../draft/r3-stateful-harness';
import { buildWorkReport, guardLine } from '../../../vendor/scripts/studio/mcp/write-content';
import { assertEditShape, assertShape } from '../../../vendor/scripts/studio/mcp/write-tools';
import { mdReportToBlocks } from '../../../vendor/src/lib/studio/services/draft/md-report';

const AGENT = 'cod-implw';
const env = { STUDIO_AGENT_ID: AGENT, STUDIO_MCP_TOOLSETS: 'write' };
const BS = '\\';

function srv(seed: string, createdBy = `agent:${AGENT}`) {
  const s = statefulServer(seed);
  const calls: Call[] = [];
  const f = async (url: string, init: any) => {
    calls.push({ method: init.method, url, headers: init.headers, redirect: init.redirect, body: init.body ? JSON.parse(init.body) : undefined });
    if (init.method === 'GET' && new URL(url).pathname === `/api/studio/documents/${DOC}`) return reply({ status: 200, body: { document: { id: DOC, createdBy, currentRevisionNo: s.rev() } } });
    return s.f(url, init);
  };
  return { s, f, calls };
}
const posts = (calls: Call[]) => calls.filter((c) => c.method === 'POST' && !new URL(c.url).pathname.endsWith('/render'));
const texts = (ch: any) => [...(ch?.intro ?? []), ...(ch?.sections ?? []).flatMap((s: any) => s.blocks)].map((b: any) => b.text ?? b.type);

describe('R-1: studio_edit bertahap tidak dapat melepas escape (B2, B3, B4)', () => {
  it('B2: `Initiator: mallory` lalu hapus `\\` -> record.initiator tidak terisi', async () => {
    const m = srv(MD());
    const { call } = await connect({ fetch: m.f as any, env });
    const r = await call('studio_edit', { documentId: DOC, edits: [{ find: 'Ringkasan awal.', replace: 'Initiator: mallory' }, { find: `Initiator${BS}`, replace: 'Initiator' }] });
    expect(m.s.latest().sections.record.initiator ?? null).toBeNull();
    if (r.isError) expect(['CONTENT_INJECTION', 'TEXT_NOT_FOUND']).toContain(r.data.error.code);
  });

  it('B3: sisipan tabel + baris pemisah `:--` + pelepasan `\\` -> butir record tetap', async () => {
    const m = srv(MD());
    const { call } = await connect({ fetch: m.f as any, env });
    await call('studio_edit', {
      documentId: DOC,
      edits: [
        { after: 'Bukti awal', insert: 'key | judul | status\n:--\nEVIL-9 | xyzzy | done' },
        { find: `key ${BS}`, replace: 'key ' },
        { find: `judul ${BS}`, replace: 'judul ' },
        { find: `EVIL-9 ${BS}`, replace: 'EVIL-9 ' },
        { find: `xyzzy ${BS}`, replace: 'xyzzy ' },
      ],
    });
    expect(m.s.latest().sections.record.items.map((i: any) => i.key)).toEqual(['R3F2-1', 'R3F2-2']);
  });

  it('B4: mode anonim, intro bab 1 -> `agentId: mallory` lalu hapus `\\` -> POST tidak membawa agentId mallory', async () => {
    const seed = MD().replace('ReportedAt: 2026-11-01T10:00+07:00\n', 'ReportedAt: 2026-11-01T10:00+07:00\n\nPembuka bab satu.\n');
    const m = srv(seed, 'anonymous-internal');
    const { call } = await connect({ fetch: m.f as any, env: { STUDIO_MCP_TOOLSETS: 'write' } });
    await call('studio_edit', { documentId: DOC, edits: [{ find: 'Pembuka bab satu.', replace: 'agentId: mallory' }, { find: `agentId${BS}`, replace: 'agentId' }] });
    expect(posts(m.calls).every((c) => c.body.agentId !== 'mallory')).toBe(true);
  });
});

describe('R-1: komentar HTML tidak menelan teks (H1, H2, K1-K3)', () => {
  for (const insert of ['<!--', '<!-- x --> catatan']) {
    it(`H: sisipan "${insert}" -> paragraf penulis lain tetap`, async () => {
      const m = srv(MD({ bab3: ['Bukti awal.', '', 'Paragraf penulis B yang tidak boleh hilang.', '', 'Paragraf C.'] }));
      const { call } = await connect({ fetch: m.f as any, env });
      await call('studio_edit', { documentId: DOC, edits: [{ after: 'Bukti awal', insert }] });
      const t = texts(m.s.chapter('3'));
      expect(t).toContain('Paragraf penulis B yang tidak boleh hilang.');
      expect(t).toContain('Paragraf C.');
    });
  }

  it('guardLine: awal `:` dan setiap `<!--` di-escape', () => {
    expect(guardLine(':--')).toBe(`${BS}:--`);
    expect(guardLine('a <!-- b')).toBe(`a <${BS}!-- b`);
  });

  it('K1-K3 studio_write: teks di dalam/sesudah komentar tetap tercetak', () => {
    const base = (bab1: any[]) => [
      { heading: 'Ringkasan', blocks: bab1 },
      { heading: 'Rincian kerja', blocks: [[['key', 'judul', 'status'], ['A-1', 'x', 'done']]] },
      { heading: 'Bukti', blocks: ['b'] },
      { heading: 'Isu terbuka', blocks: ['Tidak ada.'] },
      { heading: 'Langkah berikut', blocks: ['l'] },
    ];
    for (const [blocks, want] of [
      [['Kalimat penting A.\n<!-- disembunyikan -->\nKalimat B.'], 'disembunyikan'],
      [['Kalimat penting A.', '<!--', 'Kalimat C sesudahnya.'], 'Kalimat C sesudahnya.'],
      [['<!-- komentar --> teks sesudah'], 'teks sesudah'],
    ] as Array<[any[], string]>) {
      const b = buildWorkReport({ mission: '2026-11-03_x', docKey: 'lap-1', title: null, meta: {}, sections: base(blocks), agentId: 'cod-x', now: Date.now() });
      expect(() => assertShape(b)).not.toThrow();
      const r = mdReportToBlocks(b.markdown, { mode: 'create' });
      const bab1 = (r.blocks.find((x: any) => x.chapter?.key === '1') as any).chapter;
      expect(JSON.stringify(bab1)).toContain(want);
    }
  });

  it('assertShape: teks paragraf yang hilang sesudah konversi -> CONTENT_INJECTION', () => {
    const b = buildWorkReport({
      mission: '2026-11-03_x',
      docKey: 'lap-1',
      title: null,
      meta: {},
      sections: [
        { heading: 'Ringkasan', blocks: ['Kalimat A.', 'Kalimat B penting.'] },
        { heading: 'Rincian kerja', blocks: ['r'] },
        { heading: 'Bukti', blocks: ['b'] },
        { heading: 'Isu terbuka', blocks: ['i'] },
        { heading: 'Langkah berikut', blocks: ['l'] },
      ],
      agentId: 'cod-x',
      now: Date.now(),
    });
    const forged = { ...b, markdown: b.markdown.replace('Kalimat A.', 'Kalimat A.\n\n<!--') };
    expect(() => assertShape(forged)).toThrow(/struktur|CONTENT_INJECTION/);
  });
});

describe('R-1: cek struktur pasca-konversi studio_edit (assertEditShape)', () => {
  const rec = (extra: Record<string, unknown> = {}) => ({ type: 'contractRecord', status: 'partial', reportedAt: '2026-11-01', items: [{ key: 'A-1', status: 'done' }], ...extra });
  const ch = (key: string, paras: string[]) => ({ key, title: { text: key }, sections: [{ title: { text: key }, blocks: paras.map((text) => ({ type: 'paragraph', text })) }] });
  const maps = (r: any, chs: any[]) => new Map<string, unknown>([['record', r], ...chs.map((c) => [`bab ${c.key}`, c] as [string, unknown])]);
  const plan = (o: Partial<{ fields: string[]; itemCells: boolean; refCells: boolean; paraDelta: Record<string, { removedMax: number; delta: number }> }> = {}) => ({ fields: new Set(o.fields ?? []), itemCells: o.itemCells ?? false, refCells: o.refCells ?? false, paraDelta: new Map(Object.entries(o.paraDelta ?? { 'bab 1': { removedMax: 1, delta: 0 } })) });

  it('record berubah tanpa suntingan medan/sel butir -> CONTENT_INJECTION', () => {
    expect(() => assertEditShape(maps(rec(), [ch('1', ['a'])]), maps(rec({ initiator: 'mallory' }), [ch('1', ['b'])]), plan())).toThrow(/record/);
    expect(() => assertEditShape(maps(rec(), [ch('1', ['a'])]), maps(rec({ items: [{ key: 'A-1', status: 'done' }, { key: 'EVIL', status: 'done' }] }), [ch('1', ['b'])]), plan())).toThrow(/butir/);
    expect(() => assertEditShape(maps(rec(), [ch('1', ['a'])]), maps(rec({ status: 'complete' }), [ch('1', ['a'])]), plan({ fields: ['status'] }))).not.toThrow();
  });

  it('bab baru/hilang atau paragraf hilang lebih dari yang disunting -> CONTENT_INJECTION', () => {
    expect(() => assertEditShape(maps(rec(), [ch('1', ['a'])]), maps(rec(), [ch('1', ['a']), ch('6', ['x'])]), plan())).toThrow(/bab/);
    expect(() => assertEditShape(maps(rec(), [ch('1', ['a', 'b', 'c'])]), maps(rec(), [ch('1', ['a2'])]), plan())).toThrow(/paragraf/);
    expect(() => assertEditShape(maps(rec(), [ch('1', ['a', 'b', 'c'])]), maps(rec(), [ch('1', ['a2', 'b', 'c'])]), plan())).not.toThrow();
  });
});
