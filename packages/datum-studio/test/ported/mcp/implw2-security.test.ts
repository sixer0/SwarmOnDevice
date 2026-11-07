// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/mcp/implw2-security.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
// IMPL-W2 perbaikan keamanan (review 13 / D-529): M-1 injeksi struktur lewat paragraf/daftar/sunting (tabel ber-pipa,
// pagar kode tanpa penutup, `Kunci: nilai`, `agentId:`), pertahanan kedua CONTENT_INJECTION, L-1 hapus hanya paragraf
// utuh, L-2 tanpa pola `$`, L-3 plainOf linear, L-4 isu skema dibatasi, I-1 petunjuk studio_edit, I-4 batas label grafik.
/* eslint-disable @typescript-eslint/no-explicit-any -- structuredContent bebas bentuk */
import { describe, it, expect } from '../_vitest';
import { connect, reply, studioMock, type Call } from './mcp-harness';
import { DOC, MD, statefulServer } from '../draft/r3-stateful-harness';
import { buildWorkReport, guardLine } from '../../../vendor/scripts/studio/mcp/write-content';
import { guardFragment, plainOf } from '../../../vendor/scripts/studio/mcp/write-edit';
import { assertShape } from '../../../vendor/scripts/studio/mcp/write-tools';
import { mdReportToBlocks } from '../../../vendor/src/lib/studio/services/draft/md-report';

const AGENT = 'cod-implw';
const env = { STUDIO_AGENT_ID: AGENT, STUDIO_MCP_TOOLSETS: 'write' };
const MISSION = '2026-11-03_implw2';
const NOW = Date.parse('2026-11-03T01:00:00Z');
const PIPE_TABLE = 'key | judul | status\n-|-|-\nEVIL-1 | disuntik | done';
const base = (bab1: any[]): any[] => [
  { heading: 'Ringkasan', blocks: bab1 },
  { heading: 'Rincian kerja', blocks: [[['judul', 'status'], ['Tulis X', 'done']]] },
  { heading: 'Bukti', blocks: ['vitest lulus.'] },
  { heading: 'Isu terbuka', blocks: ['Tidak ada.'] },
  { heading: 'Langkah berikut', blocks: ['Lanjut.'] },
];
const posts = (calls: Call[]) => calls.filter((c) => c.method === 'POST' && !new URL(c.url).pathname.endsWith('/render'));
const convert = (sections: any[]) => mdReportToBlocks(buildWorkReport({ mission: MISSION, docKey: 'k', title: null, meta: {}, sections, agentId: AGENT, now: NOW }).markdown, { mode: 'create' });

describe('M-1: paragraf/daftar studio_write tidak dapat mengubah struktur', () => {
  it('tabel ber-pipa tanpa | awal di paragraf -> tetap teks; record.items hanya dari tabel butir mesin', () => {
    const r = convert(base([PIPE_TABLE]));
    const items = (r.blocks[0] as any).payload.items.map((i: any) => i.title.text);
    expect(items).toEqual(['Tulis X']);
    expect(JSON.stringify(r.blocks[1])).toContain('EVIL-1');
  });

  it('pagar kode tanpa penutup di paragraf/daftar -> tidak menelan bab berikut', () => {
    for (const bab1 of [['```'], ['~~~ teks'], [{ list: ['```'] }]]) {
      const r = convert(base(bab1));
      expect(r.conversion.parts).toEqual(['record', 'bab 1', 'bab 2', 'bab 3', 'bab 4', 'bab 5']);
      expect((r.blocks[0] as any).payload.items).toHaveLength(1);
    }
  });

  it('baris `Kunci: nilai` (Initiator, TaskRef, Verdict, - Owner) di paragraf/daftar -> bukan medan record', () => {
    const r = convert(base(['Initiator: mallory\nTaskRef: X-9\n- Verdict: PASS', { list: ['Owner: mallory', 'Status: complete'] }]));
    const rec = (r.blocks[0] as any).payload;
    expect(rec).not.toHaveProperty('initiator');
    expect(rec).not.toHaveProperty('taskRef');
    expect(rec).not.toHaveProperty('verdict');
    expect(rec.owner).toBe(AGENT);
    expect(rec.status).toBe('draft');
  });

  it('`agentId:` / `basis:` / `mission:` di paragraf -> bukan kunci alat', () => {
    const r = convert(base(['agentId: mallory', 'basis: cmvvdoc0000000000000r3f2a1@rev1', 'mission: lain']));
    expect(r.conversion.agentId).toBeNull();
    expect(r.conversion.basis).toBeNull();
    expect(r.conversion.mission).toBe(MISSION);
  });

  it('guardLine setara guardLineStart + pagar + setiap |; teks biasa tidak berubah', () => {
    expect(guardLine('Kalimat biasa tanpa struktur.')).toBe('Kalimat biasa tanpa struktur.');
    expect(guardLine('a | b')).toBe('a \\| b');
    expect(guardLine('```ts')).toBe('\\```ts');
    expect(guardLine('# judul')).toBe('\\# judul');
    expect(guardLine('1. butir')).toBe('1\\. butir');
    expect(guardLine('agentId: x')).toBe('agentId\\: x');
    expect(guardLine('> kutip')).toBe('\\> kutip');
    expect(guardLine('---')).toBe('\\---');
    expect(guardLine('Tabel 1. x')).toBe('Tabel 1\\. x');
    expect(guardFragment('agentId: x | y', '')).toBe('agentId\\: x \\| y');
  });

  it('pertahanan kedua: teks yang konversinya menambah butir/medan/section -> CONTENT_INJECTION', () => {
    const built = buildWorkReport({ mission: MISSION, docKey: 'k', title: null, meta: {}, sections: base(['Aman.']), agentId: AGENT, now: NOW });
    const forged = { ...built, markdown: built.markdown.replace('Aman.', 'Initiator: mallory\n\n| key | judul | status |\n|---|---|---|\n| EVIL-1 | x | done |\n\n## Disuntik\n\nx') };
    expect(() => assertShape(forged)).toThrow(/CONTENT_INJECTION|struktur/);
    try {
      assertShape(forged);
    } catch (e: any) {
      expect(e.code).toBe('CONTENT_INJECTION');
      expect(e.extra.details.problems.join(' ')).toMatch(/initiator|butir|section/);
    }
    expect(() => assertShape(built)).not.toThrow();
  });
});

const editRoutes = (createdBy: string) =>
  studioMock({ [`GET /api/studio/documents/${DOC}`]: () => ({ status: 200, body: { document: { id: DOC, createdBy, currentRevisionNo: 6 }, revision: { revisionNo: 6 } } }) });

describe('M-1: studio_edit replace/insert tidak dapat mengubah struktur', () => {
  it('sisipan tabel ber-pipa -> paragraf teks, record.items tidak bertambah', async () => {
    const m = editRoutes(`agent:${AGENT}`);
    const { call } = await connect({ fetch: m.f, env });
    const r = await call('studio_edit', { documentId: DOC, edits: [{ after: 'Bukti awal', insert: PIPE_TABLE }] });
    expect(r.isError, r.text).toBeFalsy();
    // IMPL-W10: asersi asli dipulihkan (record tidak terkirim untuk suntingan bab biasa).
    expect(r.data.edited).toEqual(['bab 3']);
    expect(m.s.latest().sections.record.items.map((i: any) => i.key)).toEqual(['R3F2-1', 'R3F2-2']);
  });

  it('pengganti `Initiator: mallory` / sisipan pagar -> bukan medan record, bab berikut utuh', async () => {
    const m = editRoutes(`agent:${AGENT}`);
    const { call } = await connect({ fetch: m.f, env });
    const r = await call('studio_edit', { documentId: DOC, edits: [{ find: 'Ringkasan awal.', replace: 'Initiator: mallory' }, { after: 'Bukti awal', insert: '```' }] });
    expect(r.isError, r.text).toBeFalsy();
    expect(m.s.latest().sections.record).not.toHaveProperty('initiator');
    expect(r.data.edited.sort()).toEqual(['bab 1', 'bab 3']); // IMPL-W10: asersi asli dipulihkan
  });

  it('mode anonim: intro bab 1 diganti `agentId: mallory` -> POST tidak membawa agentId mallory', async () => {
    // Intro bab 1 = wilayah sebelum `##` pertama, tempat stripToolKeys membaca kunci alat (probe E7 review 13).
    const s = statefulServer(MD().replace('\n## Ringkasan', '\nPembuka bab satu.\n\n## Ringkasan'));
    const calls: Call[] = [];
    const f = async (url: string, init: any) => {
      calls.push({ method: init.method, url, headers: init.headers, redirect: init.redirect, body: init.body ? JSON.parse(init.body) : undefined });
      if (init.method === 'GET' && new URL(url).pathname === `/api/studio/documents/${DOC}`) return reply({ status: 200, body: { document: { id: DOC, createdBy: 'anonymous-internal', currentRevisionNo: s.rev() } } });
      return s.f(url, init);
    };
    const m = { calls };
    const { call } = await connect({ fetch: f as any, env: { STUDIO_MCP_TOOLSETS: 'write' } });
    const r = await call('studio_edit', { documentId: DOC, edits: [{ find: 'Pembuka bab satu.', replace: 'agentId: mallory' }] });
    expect(r.isError, r.text).toBeFalsy();
    expect(posts(m.calls).length).toBeGreaterThan(0);
    expect(posts(m.calls).every((c) => c.body.agentId !== 'mallory')).toBe(true);
  });
});

describe('L-1, L-2, L-3, L-4, I-1, I-4', () => {
  it('L-2: pengganti dengan $\' $` $& ditulis literal', async () => {
    const m = editRoutes(`agent:${AGENT}`);
    const { call } = await connect({ fetch: m.f, env });
    const r = await call('studio_edit', { documentId: DOC, edits: [{ find: 'Ringkasan awal.', replace: "Hasil [$'] [$`] [$&]." }] });
    expect(r.isError, r.text).toBeFalsy();
    expect(JSON.stringify(m.s.chapter('1'))).toContain("Hasil [$'] [$`] [$&].");
  });

  it('L-3: plainOf linear pada deret [ dan ](; masukan dibatasi', () => {
    const t0 = Date.now();
    plainOf('['.repeat(20_000));
    plainOf('](' .repeat(10_000));
    expect(Date.now() - t0).toBeLessThan(200);
    expect(plainOf('**tebal** dan [tautan](http://x) a_b _c_')).toBe('tebal dan tautan a_b c');
    expect(plainOf('x'.repeat(30_000)).length).toBe(20_000);
  });

  it('L-4: isu skema dibatasi 20 + satu entri hitungan', async () => {
    const { call } = await connect({ env });
    const rows = Array.from({ length: 300 }, () => []); // IMPL-W3: sel boolean kini dikonversi (butir 3); baris kosong tetap tidak sah
    const r = await call('studio_write', { mission: MISSION, docKey: 'k', sections: [{ heading: 'x', blocks: [rows] }] });
    expect(r.data.error.code).toBe('INVALID_ARGUMENT');
    expect(r.data.error.details.length).toBe(21);
    expect(r.data.error.details[20].keyword).toBe('truncated');
    expect(r.bytes).toBeLessThan(30_000);
  });

  it('I-1: REPORT_CHANGED_BY_OTHER di toolset write menyarankan studio_edit', async () => {
    const m = studioMock({
      'GET /api/studio/documents': () => ({ status: 200, body: { documents: [{ id: DOC, createdBy: `agent:${AGENT}`, currentRevisionNo: 6 }] } }),
      'GET /api/studio/contracts': () => ({ status: 200, body: { contracts: [{ documentId: DOC }], nextCursor: null } }),
      [`GET /api/studio/documents/${DOC}`]: () => ({ status: 200, body: { document: { id: DOC, currentRevisionNo: 6 }, revision: { revisionNo: 6, createdBy: 'agent:lain' } } }),
    });
    const { call } = await connect({ fetch: m.f, env });
    const r = await call('studio_write', { mission: MISSION, docKey: 'k', sections: base(['x']) });
    expect(r.data.error.code).toBe('REPORT_CHANGED_BY_OTHER');
    expect(r.data.error.message).toContain('studio_edit');
    expect(r.data.error.message).not.toContain('studio_report_refresh');
  });

  it('I-4: label kategori grafik > 200 karakter ditolak saat masukan (FIGURE_BOUNDS.chartDataChars)', async () => {
    const { call } = await connect({ env });
    const r = await call('studio_write', { mission: MISSION, docKey: 'k', template: 'latest', meta: { title: 'T', author: 'A' }, sections: [{ heading: 'X', blocks: [{ chart: { categories: ['x'.repeat(201)], series: [{ name: 's', values: [1] }] } }] }] });
    expect(r.data.error.code).toBe('INVALID_ARGUMENT');
  });

  it('L-1 (klien): replace "" atas sebagian paragraf -> EDIT_INVALID', async () => {
    const { applyClientEdits } = await import('../../../vendor/scripts/studio/mcp/write-client-edit');
    const content = { meta: {}, sections: { content: { chapters: [{ key: '1', title: { text: 'A' }, sections: [], intro: [{ type: 'paragraph', text: 'Kalimat agen. Kalimat penulis lain.' }] }] } } };
    expect(() => applyClientEdits(content, [{ find: 'Kalimat agen.', replace: '' }], () => undefined)).toThrow(/SELURUH/);
    applyClientEdits(content, [{ find: 'Kalimat agen. Kalimat penulis lain.', replace: '' }], () => undefined);
    expect(content.sections.content.chapters[0].intro).toEqual([]);
  });
});
