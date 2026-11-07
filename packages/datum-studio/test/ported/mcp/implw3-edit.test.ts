// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/mcp/implw3-edit.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
// IMPL-W3 butir 2 + 14 (studio_edit): pencocokan samar, penargetan section/cell/occurrence, kandidat jendela unik
// >= 3 kata, find bertanda baca persis, alamat posisi pid + offset (+ expect). Laporan kerja lewat server tiruan
// berkeadaan; dokumen klien lewat fungsi murni applyClientEdits.
/* eslint-disable @typescript-eslint/no-explicit-any -- structuredContent bebas bentuk */
import { describe, it, expect, beforeEach } from '../_vitest';
import { connect, logs, reply, type Call } from './mcp-harness';
import { DOC, MD, statefulServer } from '../draft/r3-stateful-harness';
import { applyClientEdits } from '../../../vendor/scripts/studio/mcp/write-client-edit';
import type { HttpFetch } from '../../../vendor/scripts/studio/_http-client';

const AGENT = 'cod-r3-f2';
const env = { STUDIO_AGENT_ID: AGENT, STUDIO_MCP_TOOLSETS: 'write' };
const ITEMS = Array.from({ length: 20 }, (_, i) => `| T-${i + 1} | Tugas nomor ${i + 1} | done | out/${i + 1}.txt |`);
const SEED = MD({ basis: null, bab1: 'Ringkasan awal. Status proyek baik dan status tim baik.', bab3: ['Bukti awal dengan angka 1,000 unit.', '', 'Hasil “uji” kedua lulus.'], items: ITEMS });

beforeEach(() => {
  logs.length = 0;
});

function mock() {
  const s = statefulServer(SEED);
  const calls: Call[] = [];
  const f: HttpFetch = async (url, init) => {
    const c: Call = { method: init.method, url, headers: init.headers, redirect: init.redirect, body: init.body ? JSON.parse(init.body) : undefined } as any;
    calls.push(c);
    const u = new URL(url);
    const key = `${init.method} ${u.pathname}`;
    if (key === 'POST /api/studio/validate') return reply({ status: 200, body: { valid: true, issues: [] } });
    if (key === `GET /api/studio/documents/${DOC}`) return reply({ status: 200, body: { document: { id: DOC, docNumber: '040/GSP/LAP/XI/2026', createdBy: `agent:${AGENT}`, currentRevisionNo: s.rev() }, revision: { revisionNo: s.rev() } } });
    return s.f(url, init);
  };
  return { f, calls, s };
}
const posts = (calls: Call[]) => calls.filter((c: any) => c.method === 'POST' && !new URL(c.url).pathname.endsWith('/render') && !new URL(c.url).pathname.endsWith('/validate'));
const chapterText = (m: ReturnType<typeof mock>, k: string) => JSON.stringify(m.s.latest().sections.content.chapters.find((c: any) => c.key === k));

describe('laporan kerja: penargetan', () => {
  it('status yang muncul 20 kali: { cell: { row, column } } mengubah tepat satu sel (record ikut)', async () => {
    const m = mock();
    const { call } = await connect({ fetch: m.f, env });
    const r = await call('studio_edit', { documentId: DOC, edits: [{ cell: { row: 'T-7', column: 'status' }, value: 'running' }] });
    expect(r.isError, r.text).toBeFalsy();
    expect(r.data.ok).toBe(true);
    const items = m.s.latest().sections.record.items;
    expect(items.filter((i: any) => i.status === 'running').map((i: any) => i.key)).toEqual(['T-7']);
    expect(items.filter((i: any) => i.status === 'done')).toHaveLength(19);
  });

  it('kata tunggal ambigu 20 kali -> hasil normal ok:false TEXT_AMBIGUOUS, kandidat membawa alamat cell siap salin', async () => {
    const m = mock();
    const { call } = await connect({ fetch: m.f, env });
    const r = await call('studio_edit', { documentId: DOC, edits: [{ find: 'done', replace: 'running' }] });
    expect(r.isError).toBeFalsy();
    expect(r.data).toMatchObject({ ok: false, code: 'TEXT_AMBIGUOUS', untrusted: true });
    const c = r.data.error.details.candidates;
    expect(c.length).toBeGreaterThan(1);
    expect(c[0].cell).toMatchObject({ column: 'status' });
    expect(c[0].cell.row).toMatch(/^T-\d+$/);
    expect(posts(m.calls)).toEqual([]);
  });

  it('kata ambigu di paragraf -> kandidat find = jendela unik >= 3 kata; satu ulangan dengan jendela itu berhasil', async () => {
    const m = mock();
    const { call } = await connect({ fetch: m.f, env });
    const r = await call('studio_edit', { documentId: DOC, edits: [{ find: 'baik', replace: 'sangat baik' }] });
    expect(r.data.code).toBe('TEXT_AMBIGUOUS');
    const wins: string[] = r.data.error.details.candidates.map((x: any) => x.find);
    expect(wins).toHaveLength(2);
    for (const w of wins) expect(w.split(/\s+/).length).toBeGreaterThanOrEqual(3);
    expect(new Set(wins).size).toBe(2);
    const ok = await call('studio_edit', { documentId: DOC, edits: [{ find: wins[1], replace: wins[1].replace('baik', 'sangat baik') }] });
    expect(ok.data.ok, ok.text).toBe(true);
    expect(chapterText(m, '1')).toContain('status tim sangat baik');
    expect(chapterText(m, '1')).toContain('proyek baik dan');
  });

  it('section membatasi kecocokan; occurrence "all" mengganti semua secara eksplisit', async () => {
    const m = mock();
    const { call } = await connect({ fetch: m.f, env });
    const a = await call('studio_edit', { documentId: DOC, edits: [{ find: 'awal', replace: 'pertama', section: 'Bukti' }] });
    expect(a.data.ok, a.text).toBe(true);
    expect(chapterText(m, '3')).toContain('Bukti pertama');
    expect(chapterText(m, '1')).toContain('Ringkasan awal');
    const b = await call('studio_edit', { documentId: DOC, edits: [{ find: 'baik', replace: 'prima', occurrence: 'all' }] });
    expect(b.data.ok, b.text).toBe(true);
    expect(chapterText(m, '1')).toContain('proyek prima dan status tim prima');
  });

  it('samar: huruf besar/kecil dan angka 1000 = 1,000 -> diterapkan dengan peringatan FUZZY_MATCH', async () => {
    const m = mock();
    const { call } = await connect({ fetch: m.f, env });
    const r = await call('studio_edit', { documentId: DOC, edits: [{ find: 'ANGKA 1000 UNIT', replace: 'angka 1.200 unit' }] });
    expect(r.data.ok, r.text).toBe(true);
    expect(r.data.warnings.map((w: any) => w.code)).toContain('FUZZY_MATCH');
    expect(chapterText(m, '3')).toContain('angka 1.200 unit');
  });

  it('find bertanda baca dicocokkan persis: "awal. Status" -> "awal; Status"; kutip lurus vs pintar TIDAK disamakan', async () => {
    const m = mock();
    const { call } = await connect({ fetch: m.f, env });
    const ok = await call('studio_edit', { documentId: DOC, edits: [{ find: 'awal. Status', replace: 'awal; Status' }] });
    expect(ok.data.ok, ok.text).toBe(true);
    expect(chapterText(m, '1')).toContain('Ringkasan awal; Status');
    const nf = await call('studio_edit', { documentId: DOC, edits: [{ find: 'Hasil "uji" kedua', replace: 'x' }] });
    expect(nf.isError).toBeFalsy();
    expect(nf.data.code).toBe('TEXT_NOT_FOUND');
  });

  it('alamat posisi pid + at + expect; expect berbeda -> POSITION_MISMATCH (hasil normal, 0 tulis)', async () => {
    const m = mock();
    const p = m.s.latest().sections.content.chapters.find((c: any) => c.key === '1');
    const para = (p.intro ?? []).concat(...p.sections.map((s: any) => s.blocks)).find((b: any) => b.type === 'paragraph');
    para.id = 'p-ringkas-1';
    const text: string = para.text ?? para.runs.map((r: any) => r.t).join('');
    const at = text.indexOf('. Status');
    const { call } = await connect({ fetch: m.f, env });
    const bad = await call('studio_edit', { documentId: DOC, edits: [{ pid: 'p-ringkas-1', at, length: 1, replace: ';', expect: ',' }] });
    expect(bad.isError).toBeFalsy();
    expect(bad.data.code).toBe('POSITION_MISMATCH');
    expect(posts(m.calls)).toEqual([]);
    const good = await call('studio_edit', { documentId: DOC, edits: [{ pid: 'p-ringkas-1', at, length: 1, replace: ';', expect: '.' }] });
    expect(good.data.ok, good.text).toBe(true);
    expect(chapterText(m, '1')).toContain('Ringkasan awal; Status proyek');
  });

  it('view=paragraphs: pid + teks polos per paragraf', async () => {
    const m = mock();
    const ch = m.s.latest().sections.content.chapters.find((c: any) => c.key === '3');
    ch.sections[0].blocks.forEach((b: any, i: number) => b.type === 'paragraph' && (b.id = `p-bukti-${i}`));
    const { call } = await connect({ fetch: m.f, env });
    const r = await call('studio_document_get', { id: DOC, view: 'text', chapter: 3 });
    expect(r.isError, r.text).toBeFalsy();
    expect(r.data.paragraphs.map((x: any) => x.pid)).toEqual(['p-bukti-0', 'p-bukti-1']);
    expect(r.data.paragraphs[0]).toMatchObject({ chapter: '3', text: 'Bukti awal dengan angka 1,000 unit.' });
    expect(r.data.untrusted).toBe(true);
  });
});

describe('dokumen klien (murni): cell, posisi, sisipan dengan kode inline', () => {
  const content = () => ({
    meta: { title: 'K' },
    sections: {
      content: {
        chapters: [
          {
            key: '2',
            title: { text: 'Kinerja' },
            sections: [
              {
                title: { text: 'Status gardu' },
                blocks: [
                  { type: 'paragraph', id: 'p-kin-1', text: 'Kata ,lalu kata.Kata berikut.' },
                  { type: 'table', id: 't-1', caption: { text: 'Status' }, rows: [{ kind: 'header', cells: [{ text: 'Gardu' }, { text: 'Status' }] }, { kind: 'body', cells: [{ text: 'A' }, { text: 'complete' }] }, { kind: 'body', cells: [{ text: 'B' }, { text: 'complete' }] }] },
                ],
              },
            ],
          },
        ],
      },
    },
  });

  it('cell row B / column Status; posisi dengan expect; sisipan `kode` -> run kode', () => {
    const c: any = content();
    const w: any[] = [];
    const at = 'Kata ,lalu kata'.indexOf(',') - 1;
    const r = applyClientEdits(c, [{ cell: { row: 'B', column: 'status' }, value: 'blocked' }, { pid: 'p-kin-1', at, length: 2, replace: ', ', expect: ' ,' }, { after: 'berikut', insert: 'Jalankan `npm test` lagi.' }] as any, (x) => w.push(x));
    const blocks = c.sections.content.chapters[0].sections[0].blocks;
    expect(blocks[2].rows[2].cells[1].text).toBe('blocked');
    expect(blocks[2].rows[1].cells[1].text).toBe('complete');
    expect(blocks[0].text).toBe('Kata, lalu kata.Kata berikut.');
    expect(blocks[1].runs.some((x: any) => x.code === true && x.t === 'npm test')).toBe(true);
    expect(r.touched.map((t: any) => t.key)).toEqual(['2']);
  });

  it('kata ambigu di sel klien -> TEXT_AMBIGUOUS dengan alamat cell', () => {
    expect(() => applyClientEdits(content() as any, [{ find: 'complete', replace: 'x' }] as any, () => undefined)).toThrow(expect.objectContaining({ code: 'TEXT_AMBIGUOUS' }));
    try {
      applyClientEdits(content() as any, [{ find: 'complete', replace: 'x' }] as any, () => undefined);
    } catch (e: any) {
      expect(e.extra.details.candidates[0].cell).toMatchObject({ row: 'A', column: 'Status' });
    }
  });
});

describe('rentang persis membawa escape Markdown di depannya', () => {
  it('find ": b" atas teks "a \\: b" -> rentang mulai di backslash (tidak ada escape yatim)', async () => {
    const { findText } = await import('../../../vendor/scripts/studio/mcp/write-match');
    const { hits } = findText(': b', [{ text: 'a \\: b', section: 's', part: 'bab 1', kind: 'paragraph' }], {}, 'edit 1');
    expect(hits[0].spans).toEqual([[2, 6]]);
  });
});
