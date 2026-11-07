// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/mcp/implw10-final.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
// IMPL-W10 (gerbang akhir loop, D-577): perbaikan temuan review keamanan 16 (M16-1, L16-1, L16-2) dan review kode 17
// (High contoh addRow how-to; Medium append bersub-judul; Medium cap ReportedAt membuat record selalu terkirim).
// M16-2 diterima sebagai risiko tercatat (tidak diubah di sini).
/* eslint-disable @typescript-eslint/no-explicit-any -- structuredContent bebas bentuk */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeEach } from '../_vitest';
import { connect, logs, reply, type Call } from './mcp-harness';
import { DOC, DOC_KEY, MD, MISSION, statefulServer } from '../draft/r3-stateful-harness';
import { buildWorkReport, stableKey } from '../../../vendor/scripts/studio/mcp/write-content';
import { INFORMATIONAL_WARNING_CODES } from '../../../vendor/scripts/studio/mcp/tool-kit';

const AGENT = 'cod-implw10';
const env = { STUDIO_AGENT_ID: AGENT, STUDIO_MCP_TOOLSETS: 'write' };
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+07:00$/;
/** Penulis seed server berkeadaan (semua bagian ditulis A): studio_write menulis ulang laporan sendiri. */
const SEED_AGENT = 'cod-r3-f2';
const envSeed = { STUDIO_AGENT_ID: SEED_AGENT, STUDIO_MCP_TOOLSETS: 'write' };

beforeEach(() => {
  logs.length = 0;
});

/** Laporan milik pemanggil di server berkeadaan (R04/R05 = pemanggil; studio_write menulis ulang dokumen yang sama). */
function mock(seed = MD(), owner = AGENT, fresh = false) {
  const s = statefulServer(seed);
  /** fresh: laporan belum ada untuk mission+docKey (studio_write membuat baru) sampai tulisan pertama. */
  let exists = !fresh;
  const calls: Call[] = [];
  /** Untuk uji konkurensi: GET isi menjawab revisi ini (pembacaan basis lama), bukan revisi terkini. */
  let staleRev: number | null = null;
  const f = async (url: string, init: any) => {
    const u = new URL(url);
    calls.push({ method: init.method, url, headers: init.headers, redirect: init.redirect, body: init.body ? JSON.parse(init.body) : undefined });
    if (init.method === 'POST' && u.pathname === '/api/studio/validate') return reply({ status: 200, body: { valid: true, issues: [] } });
    if (init.method === 'POST' && (u.pathname === '/api/studio/slots' || u.pathname === '/api/studio/chapters')) exists = true;
    if (init.method === 'GET' && u.pathname === '/api/studio/documents') return reply({ status: 200, body: { documents: exists ? [{ id: DOC, createdBy: `agent:${owner}`, currentRevisionNo: s.rev() }] : [], nextCursor: null } });
    if (init.method === 'GET' && u.pathname === '/api/studio/contracts') return reply({ status: 200, body: { contracts: [{ documentId: DOC }], nextCursor: null } });
    if (init.method === 'GET' && u.pathname === `/api/studio/documents/${DOC}`) return reply({ status: 200, body: { document: { id: DOC, docNumber: '040/GSP/LAP/XI/2026', createdBy: `agent:${owner}`, currentRevisionNo: s.rev() }, revision: { revisionNo: s.rev(), createdBy: `agent:${owner}` } } });
    if (init.method === 'PATCH' && u.pathname === `/api/studio/documents/${DOC}/structure`) return reply({ status: 200, body: { document: { id: DOC }, revision: { revisionNo: s.rev() } } });
    if (staleRev !== null && init.method === 'GET' && u.pathname === `/api/studio/documents/${DOC}/content` && !u.searchParams.has('rev')) {
      const n = staleRev;
      staleRev = null;
      return s.f(`${url}${url.includes('?') ? '&' : '?'}rev=${n}`, init);
    }
    return s.f(url, init);
  };
  return { f, calls, s, readStale: (rev: number) => (staleRev = rev) };
}
const writes = (calls: Call[]) => calls.filter((c) => (c.method === 'POST' || c.method === 'PATCH') && !/\/(render|validate)$/.test(new URL(c.url).pathname));
const codes = (r: any): string[] => [...(r.data.warnings ?? []), ...(r.warnings ?? [])].map((w: any) => w.code);
const blocksOf = (m: ReturnType<typeof mock>, key: string) => m.s.chapter(key).sections.flatMap((x: any) => x.blocks);
const textOf = (b: any): string => (typeof b.text === 'string' ? b.text : JSON.stringify(b));

describe('M16-1: append tidak pernah membuat ulang bab yang ada di server (tak terserialisasi)', () => {
  /** Probe P1 review 16: bab 3 server = dua paragraf penulis lain + bentuk yang tidak dapat diwakili Markdown. */
  function seeded(variant: 'tab' | 'chart' | 'kontrol') {
    const m = mock(MD({ bab3: ['Bukti awal milik penulis B.', '', 'Paragraf kedua penulis B (data penting).'] }));
    const ch3 = m.s.latest().sections.content.chapters.find((c: any) => c.key === '3');
    const blocks = ch3.sections[0].blocks;
    if (variant === 'tab') blocks[0].text = String(blocks[0].text).replace('awal', 'awal\tkolom');
    if (variant === 'chart') blocks.push({ type: 'chart', code: 'K-01', data: { categories: ['a'], series: [{ name: 'x', values: [1] }] } });
    return { m, before: JSON.stringify(ch3) };
  }

  it.each(['tab', 'chart'] as const)('varian %s: EDIT_UNSAFE yang menyebut bab itu, 0 tulis, bab 3 utuh', async (variant) => {
    const { m, before } = seeded(variant);
    const rev0 = m.s.rev();
    const { call } = await connect({ fetch: m.f as any, env });
    const r = await call('studio_edit', { documentId: DOC, edits: [{ section: 'Bukti', append: ['Tambahan agen.'] }] });
    expect(r.data.ok, r.text).toBe(false);
    expect(r.data.error.code).toBe('EDIT_UNSAFE');
    expect(r.data.error.message).toContain('Bukti');
    expect(r.data.error.message).toContain('bab-3');
    expect(writes(m.calls)).toEqual([]);
    expect(m.s.rev()).toBe(rev0);
    expect(JSON.stringify(m.s.chapter('3'))).toBe(before);
    // Batch campuran: suntingan sah lain ikut tidak ditulis (galat ini bukan galat alamat).
    const r2 = await call('studio_edit', { documentId: DOC, edits: [{ find: 'Ringkasan awal.', replace: 'Ringkasan baru.' }, { section: 'Bukti', append: ['Tambahan agen.'] }] });
    expect(r2.data.ok, r2.text).toBe(false);
    expect(r2.data.error.code).toBe('EDIT_UNSAFE');
    expect(writes(m.calls)).toEqual([]);
  });

  it('kontrol (bab terserialisasi): append tetap menambah paragraf tanpa kehilangan isi', async () => {
    const { m } = seeded('kontrol');
    const { call } = await connect({ fetch: m.f as any, env });
    const r = await call('studio_edit', { documentId: DOC, edits: [{ section: 'Bukti', append: ['Tambahan agen.'] }] });
    expect(r.data.ok, r.text).toBe(true);
    expect(blocksOf(m, '3').map(textOf)).toEqual(['Bukti awal milik penulis B.', 'Paragraf kedua penulis B (data penting).', 'Tambahan agen.']);
  });

  it('bab baku yang benar-benar belum ada tetap dibuat (perilaku IMPL-W9)', async () => {
    const m = mock(MD().replace('## Isu terbuka\n\nTidak ada.\n\n', ''));
    const { call } = await connect({ fetch: m.f as any, env });
    const r = await call('studio_edit', { documentId: DOC, detail: true, edits: [{ section: 'Isu terbuka', append: ['Isu baru.'] }] });
    expect(r.data.ok, r.text).toBe(true);
    expect(codes(r)).toContain('SECTION_CREATED');
    expect(JSON.stringify(m.s.chapter('4'))).toContain('Isu baru.');
  });
});

describe('L16-1: vonis bersyarat/negasi tidak dinaikkan menjadi enum', () => {
  const header = (verdict: string) => {
    const b = buildWorkReport({ mission: '2026-11-04_x', docKey: 'lap-1', title: null, meta: { verdict }, sections: [{ heading: 'Ringkasan', blocks: ['x'] }], agentId: AGENT, now: 0 });
    return { line: /^Verdict: (.*)$/m.exec(b.markdown)?.[1] ?? null, codes: b.warnings.map((w) => w.code) };
  };

  it('kualifikasi atau negasi sesudah token awal -> VERDICT_DROPPED (tidak ditulis)', () => {
    for (const raw of [
      'PASS WITH ISSUES', 'pass with conditions', 'PASS kecuali cek 3 gagal', 'pass but tests not run', 'lulus bersyarat', 'OK tapi 2 gagal',
      'not pass', 'PASS? belum diverifikasi', 'PASS?', 'PASS (kecuali cek 3)', 'PASS: sebagian cek belum jalan', 'lulus - tapi 2 cek gagal',
      'PASS (partial)', 'pass: conditional', 'PASS, except check 4', 'lulus sebagian, 2 cek gagal', 'PASS (2 cek fail)', 'GAGAL 2 dari 8',
    ]) {
      const h = header(raw);
      expect(h.line, raw).toBeNull();
      expect(h.codes, raw).toContain('VERDICT_DROPPED');
      expect(h.codes, raw).not.toContain('VERDICT_NORMALIZED');
    }
  });

  it('token awal + akhir teks, tanda baca saja, atau rincian netral -> enum + VERDICT_NORMALIZED', () => {
    const cases: Array<[string, string]> = [
      ['PASS (CHECK 1-8)', 'PASS'], ['PASS.', 'PASS'], ['pass: semua lulus', 'PASS'], ['LULUS - cek 1-8', 'PASS'], ['WASPADA (kuota)', 'CAUTION'],
      ['gagal: 2 cek', 'FAIL'], ['FAIL (2 cek gagal)', 'FAIL'], ['needs review (2 temuan)', 'NEEDS_REVIEW'], ['Butuh tinjauan: data', 'NEEDS_REVIEW'],
    ];
    for (const [raw, want] of cases) {
      const h = header(raw);
      expect(h.line, raw).toBe(want);
      expect(h.codes, raw).toContain('VERDICT_NORMALIZED');
    }
  });

  it('nilai persis/alias penuh tetap tanpa peringatan ("tidak lulus" = alias FAIL sejak IMPL-W3, bukan PASS)', () => {
    for (const [raw, want] of [['PASS', 'PASS'], ['lulus dengan catatan', 'CAUTION'], ['tidak lulus', 'FAIL'], ['needs-review', 'NEEDS_REVIEW']]) {
      const h = header(raw);
      expect(h.line, raw).toBe(want);
      expect(h.codes, raw).not.toContain('VERDICT_NORMALIZED');
      expect(h.codes, raw).not.toContain('VERDICT_DROPPED');
    }
  });

  it('studio_edit meta: vonis bersyarat tidak menimpa vonis tersimpan; VERDICT_DROPPED tampil di hasil ringkas', async () => {
    const m = mock();
    const { call } = await connect({ fetch: m.f as any, env });
    const r1 = await call('studio_edit', { documentId: DOC, meta: { verdict: 'FAIL' } });
    expect(r1.data.ok, r1.text).toBe(true);
    const r = await call('studio_edit', { documentId: DOC, meta: { verdict: 'PASS kecuali cek 3 gagal' } });
    expect(codes(r)).toContain('VERDICT_DROPPED');
    expect(r.text).toContain('VERDICT_DROPPED');
    expect(m.s.latest().sections.record.verdict).toBe('FAIL');
  });
});

describe('L16-2: peringatan yang mengubah isi tersimpan tampil di hasil ringkas', () => {
  it('SECTION_CREATED, ROWS_COALESCED_TO_TABLE, VERDICT_NORMALIZED bukan informasional; ITEM_KEY_*/ARGS_UNWRAPPED/META_LIFTED_FROM_EDITS tetap', () => {
    for (const c of ['SECTION_CREATED', 'ROWS_COALESCED_TO_TABLE', 'VERDICT_NORMALIZED']) expect(INFORMATIONAL_WARNING_CODES.has(c), c).toBe(false);
    for (const c of ['ITEM_KEY_COLUMN_ADDED', 'ITEM_KEY_GENERATED', 'ARGS_UNWRAPPED', 'META_LIFTED_FROM_EDITS']) expect(INFORMATIONAL_WARNING_CODES.has(c), c).toBe(true);
  });

  it('studio_edit ringkas (tanpa detail): SECTION_CREATED dan VERDICT_NORMALIZED terlihat', async () => {
    const m = mock(MD().replace('## Isu terbuka\n\nTidak ada.\n\n', ''));
    const { call } = await connect({ fetch: m.f as any, env });
    const r = await call('studio_edit', { documentId: DOC, edits: [{ section: 'Isu terbuka', append: ['Isu baru.'] }], meta: { verdict: 'PASS (CHECK 1-8)' } });
    expect(r.data.ok, r.text).toBe(true);
    expect(codes(r)).toEqual(expect.arrayContaining(['SECTION_CREATED', 'VERDICT_NORMALIZED']));
    expect(r.text).toContain('SECTION_CREATED');
    expect(r.text).toContain('VERDICT_NORMALIZED');
  });
});

// ── High review 17: payload how-to laporan dijalankan apa adanya (S1 studio_write, S2 studio_edit) ──

const HOWTO = readFileSync(path.resolve(__dirname, '../_fixtures/docs/STUDIO-HOWTO-REPORT.md'), 'utf8');
const BUKTI_S1 = 'Berkas out/a.txt berukuran 12 B dengan sha 0a1b2c3d.';
/** Placeholder how-to -> nilai konkret; placeholder lain -> teks unik bernomor (bentuk JSON tidak diubah). */
function fill(json: string): string {
  const fixed: Record<string, string> = {
    misi: MISSION, kunci: 'r3f2-uji', owner: SEED_AGENT, initiator: 'ctl-implw10', label: 'IMPL-W10', kartu: 't_0123abcd',
    bukti: BUKTI_S1, 'SELURUH kalimat lama': BUKTI_S1, 'kalimat baru utuh': 'Berkas out/a.txt berukuran 12 B dengan sha 0a1b2c3d, diverifikasi ulang.',
  };
  let n = 0;
  return json.replace(/<([^<>"]+)>/g, (_, name: string) => fixed[name] ?? `Isi ${name} nomor ${++n}.`);
}
function howtoS1(): Record<string, unknown> {
  const m = /## 3\.[\s\S]*?```json\n([\s\S]*?)```/.exec(HOWTO);
  if (m === null) throw new Error('blok JSON §3 how-to tidak ditemukan');
  return JSON.parse(fill(m[1]));
}
function howtoS2(): { edits: unknown[]; meta: Record<string, unknown> } {
  const s4 = /## 4\.[\s\S]*?(?=\n## 5\.)/.exec(HOWTO)?.[0] ?? '';
  const edits = [1, 2, 3, 4].map((k) => {
    const line = new RegExp(`^${k}\\. .*?\`(\\{.*?\\})\``, 'm').exec(s4);
    if (line === null) throw new Error(`butir ${k} §4 how-to tanpa JSON`);
    return JSON.parse(fill(line[1]));
  });
  const meta = /^5\. .*?"meta":(\{[^}]*\})/m.exec(s4);
  if (meta === null) throw new Error('butir 5 §4 how-to tanpa meta');
  return { edits, meta: JSON.parse(meta[1]) };
}

describe('High review 17: addRow 2 sel pada tabel butir buatan studio_write (kolom key otomatis)', () => {
  it('how-to apa adanya: S1 studio_write lalu S2 studio_edit (cell, addRow 2 sel, append, find/replace, meta) -> ok, satu batch', async () => {
    const m = mock(MD(), SEED_AGENT, true);
    const { call } = await connect({ fetch: m.f as any, env: envSeed });
    const s1 = howtoS1();
    const r1 = await call('studio_write', s1);
    expect(r1.data.ok, r1.text).toBe(true);
    const rinci = JSON.stringify(m.s.chapter('2'));
    expect(rinci).toContain('X-B1');
    const s2 = howtoS2();
    expect(s2.edits[1]).toEqual({ section: 'Rincian kerja', addRow: [expect.stringMatching(/^X-B5: /), 'berjalan'] });
    const r2 = await call('studio_edit', { documentId: r1.data.documentId, edits: s2.edits, meta: s2.meta });
    expect(r2.data.ok, r2.text).toBe(true);
    expect(r2.data.notApplied ?? []).toEqual([]);
    const rec = m.s.latest().sections.record;
    expect(rec.status).toBe('complete');
    const b5 = rec.items.find((i: any) => JSON.stringify(i).includes('X-B5'));
    expect(b5, JSON.stringify(rec.items)).toBeDefined();
    expect(b5.key).toMatch(/^K-[0-9a-f]{8}$/);
    expect(b5.status).toBe('running');
    expect(rec.items.find((i: any) => JSON.stringify(i).includes('X-B1')).status).toBe('done');
    expect(rec.items.length).toBe(3);
    const bukti = JSON.stringify(m.s.chapter('3'));
    expect(bukti).toContain('diverifikasi ulang');
    expect(bukti).toContain('Isi paragraf nomor');
  });

  it('kunci baris addRow 2 sel = kunci stabil yang sama dengan studio_write untuk judul yang sama', async () => {
    const sec = (rows: string[][]) => ({ mission: MISSION, docKey: DOC_KEY, meta: { status: 'draft' }, sections: [{ heading: 'Rincian kerja', blocks: [[['judul', 'status'], ...rows]] }] });
    const key9Of = (m: ReturnType<typeof mock>) => m.s.latest().sections.record.items.find((i: any) => JSON.stringify(i).includes('X-B9')).key;
    const m1 = mock(MD(), SEED_AGENT, true);
    const c1 = await connect({ fetch: m1.f as any, env: envSeed });
    const w1 = await c1.call('studio_write', sec([['X-B1: satu', 'berjalan'], ['X-B9: sembilan', 'selesai']]));
    expect(w1.data.ok, w1.text).toBe(true);
    const m2 = mock(MD(), SEED_AGENT, true);
    const c2 = await connect({ fetch: m2.f as any, env: envSeed });
    const w2 = await c2.call('studio_write', sec([['X-B1: satu', 'berjalan']]));
    expect(w2.data.ok, w2.text).toBe(true);
    const r = await c2.call('studio_edit', { documentId: DOC, edits: [{ section: 'Rincian kerja', addRow: ['X-B9: sembilan', 'selesai'] }] });
    expect(r.data.ok, r.text).toBe(true);
    expect(key9Of(m2)).toBe(key9Of(m1));
    expect(key9Of(m2)).toBe(stableKey('X-B9: sembilan'));
    expect(m2.s.latest().sections.record.items.find((i: any) => i.key === key9Of(m2)).status).toBe('done');
  });

  it('lebar penuh tetap jalan; lebar lain tetap EDIT_INVALID dengan judul kolom; tabel tanpa kolom key otomatis tidak dilonggarkan', async () => {
    const m = mock(MD(), SEED_AGENT);
    const { call } = await connect({ fetch: m.f as any, env: envSeed });
    // Tabel seed: | key | judul | status | bukti | (4 kolom, key di kolom pertama).
    const ok3 = await call('studio_edit', { documentId: DOC, edits: [{ section: 'Rincian kerja', addRow: ['Uji tiga sel', 'selesai', 'out/x.txt'] }] });
    expect(ok3.data.ok, ok3.text).toBe(true);
    const ok4 = await call('studio_edit', { documentId: DOC, edits: [{ section: 'Rincian kerja', addRow: ['R3F2-7', 'Uji empat sel', 'selesai', ''] }] });
    expect(ok4.data.ok, ok4.text).toBe(true);
    const n = writes(m.calls).length;
    const bad = await call('studio_edit', { documentId: DOC, edits: [{ section: 'Rincian kerja', addRow: ['x', 'y'] }] });
    expect(bad.data.ok).toBe(false);
    expect(bad.data.error.code).toBe('EDIT_INVALID');
    expect(bad.data.error.details.expectedHeader).toEqual(['key', 'judul', 'status', 'bukti']);
    expect(writes(m.calls).length).toBe(n);
    // Tabel biasa (bukan tabel butir): lebar n-1 tetap ditolak.
    const m2 = mock(MD({ bab3: ['| uji | hasil |', '|---|---|', '| vitest | lulus |'] }));
    const c2 = await connect({ fetch: m2.f as any, env });
    const r = await c2.call('studio_edit', { documentId: DOC, edits: [{ section: 'Bukti', addRow: ['satu'] }] });
    expect(r.data.ok).toBe(false);
    expect(r.data.error.code).toBe('EDIT_INVALID');
  });
});

describe('Medium review 17: append ke section bersub-judul mendarat di akhir section', () => {
  const SUB = MD({ bab3: ['Bukti awal.', '', '### Detail uji', '', 'Isi detail.'] });

  it('paragraf append = blok terakhir bab (sesudah isi sub-judul)', async () => {
    const m = mock(SUB);
    const { call } = await connect({ fetch: m.f as any, env });
    const r = await call('studio_edit', { documentId: DOC, edits: [{ section: 'Bukti', append: ['Tambahan di akhir.'] }] });
    expect(r.data.ok, r.text).toBe(true);
    const bl = blocksOf(m, '3');
    expect(bl.at(-1)).toEqual({ type: 'paragraph', text: 'Tambahan di akhir.' });
    expect(bl.map((b: any) => b.role ?? b.type)).toEqual(['paragraph', 'subheading', 'paragraph', 'paragraph']);
  });

  it('tabel append ke section bersub-judul: tanpa CONTENT_INJECTION palsu, tabel di akhir', async () => {
    const m = mock(SUB);
    const { call } = await connect({ fetch: m.f as any, env });
    const r = await call('studio_edit', { documentId: DOC, edits: [{ section: 'Bukti', append: [[['uji', 'hasil'], ['vitest', 'lulus']]] }] });
    expect(r.data.ok, r.text).toBe(true);
    expect(blocksOf(m, '3').at(-1).type).toBe('table');
  });

  it('append dengan sasaran judul sub-judul juga mendarat di akhir section induk; find dengan section sub-judul tetap jalan', async () => {
    const m = mock(SUB);
    const { call } = await connect({ fetch: m.f as any, env });
    const r = await call('studio_edit', { documentId: DOC, edits: [{ section: 'Detail uji', append: ['Tambahan detail.'] }, { find: 'Isi detail.', replace: 'Isi detail diperbarui.', section: 'Detail uji' }] });
    expect(r.data.ok, r.text).toBe(true);
    const bl = blocksOf(m, '3');
    expect(bl.map(textOf).slice(-2)).toEqual(['Isi detail diperbarui.', 'Tambahan detail.']);
  });
});

describe('Medium review 17: cap ReportedAt tidak membuat suntingan bab biasa mengirim record', () => {
  it('sunting teks bab saja -> hanya bab itu terkirim, ReportedAt tersimpan tidak berubah', async () => {
    const m = mock();
    const { call } = await connect({ fetch: m.f as any, env });
    const r = await call('studio_edit', { documentId: DOC, edits: [{ find: 'Ringkasan awal.', replace: 'Ringkasan sesudah sunting.' }] });
    expect(r.data.ok, r.text).toBe(true);
    expect(r.data.edited).toEqual(['bab 1']);
    expect(writes(m.calls).some((c) => c.body?.slot === 'record')).toBe(false);
    expect(m.s.latest().sections.record.reportedAt).toBe('2026-11-01T10:00+07:00');
  });

  it('saluran meta dan suntingan tabel butir tetap dicap jam server', async () => {
    const m = mock();
    const { call } = await connect({ fetch: m.f as any, env });
    const r = await call('studio_edit', { documentId: DOC, meta: { status: 'complete' } });
    expect(r.data.ok, r.text).toBe(true);
    expect(m.s.latest().sections.record.reportedAt).toMatch(STAMP);
    const m2 = mock();
    const c2 = await connect({ fetch: m2.f as any, env });
    const r2 = await c2.call('studio_edit', { documentId: DOC, edits: [{ cell: { row: 'R3F2-1', column: 'status' }, value: 'done' }] });
    expect(r2.data.ok, r2.text).toBe(true);
    expect(r2.data.edited).toContain('record');
    expect(m2.s.latest().sections.record.reportedAt).toMatch(STAMP);
  });

  it('dua agen menyunting bab berbeda dari basis yang sama -> tidak ada konflik dari record', async () => {
    const m = mock(MD(), 'cod-implw10');
    const a = await connect({ fetch: m.f as any, env });
    const b = await connect({ fetch: m.f as any, env: { ...env, STUDIO_AGENT_ID: 'cod-implw10-b' } });
    const base = m.s.rev();
    const ra = await a.call('studio_edit', { documentId: DOC, edits: [{ find: 'Ringkasan awal.', replace: 'Ringkasan agen A.' }] });
    expect(ra.data.ok, ra.text).toBe(true);
    // Agen B membaca basis lama (sebelum tulisan A) lalu menyunting bab 3.
    m.readStale(base);
    const rb = await b.call('studio_edit', { documentId: DOC, adoptExisting: true, edits: [{ find: 'Bukti awal.', replace: 'Bukti agen B.' }] });
    expect(rb.data.ok, rb.text).toBe(true);
    expect(rb.data.basisRevisionNo).toBe(base);
    expect(JSON.stringify(m.s.chapter('1'))).toContain('Ringkasan agen A.');
    expect(JSON.stringify(m.s.chapter('3'))).toContain('Bukti agen B.');
  });
});
