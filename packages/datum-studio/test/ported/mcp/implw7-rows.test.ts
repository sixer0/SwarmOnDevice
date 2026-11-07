// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/mcp/implw7-rows.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
// IMPL-W7 (uji Hermes ronde 10, R12B): agen menjatuhkan satu tingkat kurung tabel, jadi setiap baris tabel menjadi blok
// sendiri (larik datar teks). Dua atau lebih blok larik datar BERURUTAN dengan lebar sama (>= 2) digabung menjadi SATU
// blok tabel (baris pertama = judul kolom), untuk bagian studio_write dan blok `append` studio_edit (laporan kerja dan
// dokumen klien). Peringatan ROWS_COALESCED_TO_TABLE (IMPL-W10 L16-2: tampil di hasil ringkas). Larik datar tunggal tetap
// perilaku lama (daftar). Ringkasan verifikasi mencetak jumlah tabel tercetak.
/* eslint-disable @typescript-eslint/no-explicit-any -- structuredContent bebas bentuk */
import { describe, it, expect, beforeEach } from '../_vitest';
import { strToU8, zipSync } from 'fflate';
import { connect, logs, studioMock } from './mcp-harness';
import { DOC } from '../draft/r3-stateful-harness';
import { clientServer, DOCID, env as cenv } from './implw3-client-mock';
import { INFORMATIONAL_WARNING_CODES } from '../../../vendor/scripts/studio/mcp/tool-kit';
import { normalizeEditArgs, normalizeWriteArgs } from '../../../vendor/scripts/studio/mcp/write-normalize';
import { docxPrinted, htmlPrinted } from '../../../vendor/scripts/studio/mcp/write-verify';

const AGENT = 'cod-implw7';
const MISSION = '2026-11-04_implw7';
const env = { STUDIO_AGENT_ID: AGENT, STUDIO_MCP_TOOLSETS: 'write' };

beforeEach(() => {
  logs.length = 0;
});

// Bentuk persis kiriman Hermes R12B: tiap baris tabel = blok larik datar, lalu paragraf.
const R12B_ROWS = [
  ['judul', 'status'],
  ['R12-B1: CHECK 1-2 (rubrik, lajur)', 'berjalan'],
  ['R12-B2: CHECK 3 (sumber)', 'belum mulai'],
  ['R12-B3: CHECK 4 (angka)', 'belum mulai'],
  ['R12-B4: CHECK 5 (render)', 'belum mulai'],
];
const R12B_SECTIONS = [
  { heading: 'Ringkasan', blocks: ['Ronde 12 batch B sedang berjalan.'] },
  { heading: 'Rincian kerja', blocks: [...R12B_ROWS, 'Butir R12-B1 sedang dikerjakan; sisanya menunggu.'] },
  { heading: 'Bukti', blocks: ['out/r12b.txt 40 B'] },
  { heading: 'Risiko', blocks: ['Tidak ada.'] },
  { heading: 'Langkah berikut', blocks: ['Lanjut R12-B2.'] },
];

const codesOf = (r: any): string[] => (r.data.warnings ?? []).map((w: any) => w.code);
const editRoutes = () =>
  studioMock({ [`GET /api/studio/documents/${DOC}`]: () => ({ status: 200, body: { document: { id: DOC, docNumber: '040/GSP/LAP/XI/2026', createdBy: `agent:${AGENT}`, currentRevisionNo: 6 }, revision: { revisionNo: 6 } } }) });

describe('IMPL-W7: normalisasi baris datar -> tabel (fungsi murni)', () => {
  it('lima larik datar lebar 2 berurutan -> satu blok tabel, paragraf sesudahnya tetap, peringatan informasional', () => {
    const a: any = { mission: MISSION, docKey: 'x', sections: [{ heading: 'Rincian kerja', blocks: [...R12B_ROWS, 'paragraf'] }] };
    const w = normalizeWriteArgs(a);
    expect(a.sections[0].blocks).toEqual([R12B_ROWS, 'paragraf']);
    expect(w.map((x) => x.code)).toContain('ROWS_COALESCED_TO_TABLE');
    expect(w.map((x) => x.code)).not.toContain('ARG_MAPPED');
    // IMPL-W10 L16-2: tidak lagi informasional (baris datar dapat menjadi butir record; agen harus melihatnya).
    expect(INFORMATIONAL_WARNING_CODES.has('ROWS_COALESCED_TO_TABLE')).toBe(false);
  });

  it('larik datar TUNGGAL tetap perilaku lama: daftar (ARG_MAPPED), bukan tabel', () => {
    const a: any = { mission: MISSION, docKey: 'x', sections: [{ heading: 'Bukti', blocks: ['awal', ['vitest lulus', 'tsc 0'], 'akhir'] }] };
    const w = normalizeWriteArgs(a);
    expect(a.sections[0].blocks).toEqual(['awal', { list: ['vitest lulus', 'tsc 0'] }, 'akhir']);
    expect(w.map((x) => x.code)).toEqual(['ARG_MAPPED']);
  });

  it('dua run lebar berbeda bersebelahan -> dua tabel; larik lebar 1 dan larik bersarang tidak ikut', () => {
    const a: any = { mission: MISSION, docKey: 'x', sections: [{ heading: 'Bukti', blocks: [
      ['a', 'b'], ['1', 2],
      ['x', 'y', 'z'], ['4', '5', '6'], ['7', '8', '9'],
      ['tunggal'], ['satu'],
      [['h1', 'h2'], ['v1', 'v2']], ['p', 'q'],
    ] }] };
    normalizeWriteArgs(a);
    expect(a.sections[0].blocks).toEqual([
      [['a', 'b'], ['1', 2]],
      [['x', 'y', 'z'], ['4', '5', '6'], ['7', '8', '9']],
      { list: ['tunggal'] }, { list: ['satu'] },
      [['h1', 'h2'], ['v1', 'v2']],
      { list: ['p', 'q'] },
    ]);
  });

  it('studio_edit append dengan baris datar + paragraf -> satu tabel + paragraf', () => {
    const a: any = { documentId: DOC, edits: [{ section: 'Rincian kerja', append: [...R12B_ROWS, 'paragraf'] }] };
    const w = normalizeEditArgs(a);
    expect(a.edits[0].append).toEqual([R12B_ROWS, 'paragraf']);
    expect(w.map((x) => x.code)).toContain('ROWS_COALESCED_TO_TABLE');
  });
});

describe('IMPL-W7: laporan kerja', () => {
  it('studio_write bentuk R12B -> satu tabel butir judul/status 4 baris, record 4 butir berstatus terpetakan, tanpa blok daftar', async () => {
    const m = studioMock();
    const { call } = await connect({ fetch: m.f, env });
    const r = await call('studio_write', { mission: MISSION, docKey: 'lap-implw7', sections: R12B_SECTIONS });
    expect(r.data.ok, r.text).toBe(true);
    const latest = m.s.latest();
    const items = latest.sections.record.items;
    expect(items.length).toBe(4);
    expect(items.map((i: any) => i.status)).toEqual(['running', 'todo', 'todo', 'todo']);
    expect(JSON.stringify(items)).toContain('R12-B1: CHECK 1-2 (rubrik, lajur)');
    const ch2 = JSON.stringify(m.s.chapter('2'));
    expect(ch2).not.toContain('"list"');
    const blocks = m.s.chapter('2').sections.flatMap((s: any) => s.blocks);
    const tables = blocks.filter((b: any) => b.type === 'table');
    expect(tables.length).toBe(1);
    expect(blocks.some((b: any) => b.type === 'list')).toBe(false);
    // IMPL-W10 L16-2: hasil ringkas menampilkan ROWS_COALESCED_TO_TABLE (mengubah struktur tersimpan).
    expect(codesOf(r)).toContain('ROWS_COALESCED_TO_TABLE');
    expect(r.text).toContain('ROWS_COALESCED_TO_TABLE');
  });

  it('detail: true menampilkan ROWS_COALESCED_TO_TABLE', async () => {
    const m = studioMock();
    const { call } = await connect({ fetch: m.f, env });
    const r = await call('studio_write', { mission: MISSION, docKey: 'lap-implw7', sections: R12B_SECTIONS, detail: true });
    expect(r.data.ok, r.text).toBe(true);
    expect(codesOf(r)).toContain('ROWS_COALESCED_TO_TABLE');
    expect(r.text).toContain('peringatan ROWS_COALESCED_TO_TABLE');
  });

  it('sesudah tulis bentuk R12B, suntingan sel status R12-B1 berhasil', async () => {
    const m = editRoutes();
    const { call } = await connect({ fetch: m.f, env });
    const w = await call('studio_write', { mission: MISSION, docKey: 'lap-implw7', sections: R12B_SECTIONS });
    expect(w.data.ok, w.text).toBe(true);
    const key = m.s.latest().sections.record.items[0].key;
    const r = await call('studio_edit', { documentId: DOC, edits: [{ cell: { row: key, column: 'status' }, value: 'selesai' }] });
    expect(r.data.ok, r.text).toBe(true);
    expect(m.s.latest().sections.record.items[0].status).toBe('done');
  });

  it('studio_edit append bentuk R12B ke section tanpa tabel -> satu tabel butir baru, butir masuk record', async () => {
    const m = editRoutes();
    const { call } = await connect({ fetch: m.f, env });
    const r = await call('studio_edit', { documentId: DOC, edits: [{ section: 'Bukti', append: [...R12B_ROWS, 'Paragraf sesudah tabel.'] }] });
    expect(r.data.ok, r.text).toBe(true);
    const blocks = m.s.chapter('3').sections.flatMap((s: any) => s.blocks);
    expect(blocks.map((b: any) => b.type).slice(-2)).toEqual(['table', 'paragraph']);
    expect(blocks.some((b: any) => b.type === 'list')).toBe(false);
    const st = Object.fromEntries(m.s.latest().sections.record.items.map((i: any) => [i.title.text, i.status]));
    expect(st['R12-B1: CHECK 1-2 (rubrik, lajur)']).toBe('running');
    expect(st['R12-B4: CHECK 5 (render)']).toBe('todo');
    expect(codesOf(r)).toContain('ROWS_COALESCED_TO_TABLE'); // IMPL-W10 L16-2
  });
});

describe('IMPL-W7: dokumen klien', () => {
  it('studio_write klien: dua larik datar lebar sama -> tabel (bukan daftar)', async () => {
    const m = clientServer();
    const { call } = await connect({ fetch: m.f as any, env: cenv });
    const META = { title: 'Kajian W7', number: 'GSP-W7-001', author: 'Tim Kajian GSP', checker: 'B. Santoso', rev: 'A', date: '2026-11-04', classification: 'Terbatas', source: 'Rekap internal GSP' };
    const r = await call('studio_write', { mission: '2026-11-03_implw2', docKey: 'klien-w7', template: 'latest', meta: META, sections: [
      { heading: 'Pendahuluan', blocks: ['Pembuka.', ['Gardu', 'Status'], ['Cikupa', 'siap'], 'Penutup.'] },
    ] });
    expect(r.data.ok, r.text).toBe(true);
    const ch = m.content().sections.content.chapters[0];
    const blocks = [...(ch.intro ?? []), ...(ch.sections ?? []).flatMap((s: any) => s.blocks)];
    expect(blocks.map((b: any) => b.type)).toEqual(['paragraph', 'table', 'paragraph']);
    const t = blocks[1];
    expect(t.rows.map((x: any) => x.cells.map((c: any) => c.text))).toEqual([['Gardu', 'Status'], ['Cikupa', 'siap']]);
  });

  it('studio_edit append klien: baris datar + paragraf diperlakukan PERSIS seperti blok tabel kanonik (gerbang sumber sama)', async () => {
    // Jalur append klien tidak membawa meta.source (perilaku IMPL-W5): tabel bercaption tanpa sumber -> SOURCE_MISSING,
    // 0 tulis. Hasil gabungan baris datar harus sama dengan kiriman kanonik [[...],[...]] dan BUKAN daftar yang lolos diam-diam.
    const ROWS = [['Butir', 'Status'], ['Survei', 'selesai'], ['Analisis', 'berjalan']];
    const run = async (append: unknown[]) => {
      const m = clientServer({ exists: true });
      const { call } = await connect({ fetch: m.f as any, env: cenv });
      const r = await call('studio_edit', { documentId: DOCID, edits: [{ section: 'Pendahuluan', append }] });
      return { r, writes: m.calls.filter((c) => (c.method === 'POST' || c.method === 'PATCH') && !c.url.endsWith('/validate')).length };
    };
    const flat = await run([...ROWS, 'Catatan sesudah tabel.']);
    const canon = await run([ROWS, 'Catatan sesudah tabel.']);
    expect(flat.r.data.ok).toBe(false);
    expect(flat.r.data.error.code).toBe('SOURCE_MISSING');
    expect(canon.r.data.error.code).toBe('SOURCE_MISSING');
    expect(flat.r.data.error.message).toBe(canon.r.data.error.message);
    expect([flat.writes, canon.writes]).toEqual([0, 0]);
  });
});

describe('IMPL-W7: ringkasan verifikasi menghitung tabel tercetak', () => {
  it('htmlPrinted: jumlah tabel total dan per judul', () => {
    const html = '<h2>1. Ringkasan</h2><p>x</p><h2>2. Rincian kerja</h2><table><caption>Butir</caption><tr><td>a</td></tr></table><h2>3. Bukti</h2><table><tr><td>b</td></tr></table><table><tr><td>c</td></tr></table>';
    const p = htmlPrinted(Buffer.from(html, 'utf8'));
    expect(p.tables).toBe(3);
    expect(p.headings.map((h) => h.tb ?? 0)).toEqual([0, 1, 2]);
  });

  it('docxPrinted: <w:tbl> dihitung, tabel sebelum judul pertama hanya masuk total', () => {
    const h = (t: string) => `<w:p><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:r><w:t>${t}</w:t></w:r></w:p>`;
    const tbl = '<w:tbl><w:tblPr/><w:tr><w:tc><w:p><w:r><w:t>sel</w:t></w:r></w:p></w:tc></w:tr></w:tbl>';
    const xml = `<w:document><w:body>${tbl}${h('Pendahuluan')}<w:p><w:r><w:t>x</w:t></w:r></w:p>${h('Kinerja')}${tbl}${tbl}</w:body></w:document>`;
    const p = docxPrinted(zipSync({ 'word/document.xml': strToU8(xml) }));
    expect(p.tables).toBe(3);
    expect(p.headings.map((x) => [x.t, x.tb ?? 0])).toEqual([['Pendahuluan', 0], ['Kinerja', 2]]);
  });

  it('studio_write laporan: structuredContent verify.tableCount dan baris ringkasan "N tabel"', async () => {
    const m = studioMock();
    const { call } = await connect({ fetch: m.f, env });
    const r = await call('studio_write', { mission: MISSION, docKey: 'lap-implw7', sections: R12B_SECTIONS });
    expect(r.data.ok, r.text).toBe(true);
    expect(typeof r.data.verify.tableCount).toBe('number');
    expect(r.text).toMatch(/\d+ tabel/);
  });
});
