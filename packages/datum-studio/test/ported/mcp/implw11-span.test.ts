// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/mcp/implw11-span.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
// IMPL-W11 (cek ulang review 17, R1 + R3): rentang section/sub-judul untuk append dan addRow, serta pelonggaran addRow
// n-1 pada tabel butir berkolom key yang tidak berlaku bila sel pertama tampak seperti kunci.
// Aturan: rentang sub-judul berakhir di judul berikutnya bertingkat sama atau lebih tinggi; rentang `##` berakhir di `##`
// berikutnya. addRow tanpa `table` ke induk = tabel terakhir SEBELUM sub-judul pertama; induk tanpa tabel sendiri tetapi
// sub-judulnya bertabel -> TEXT_AMBIGUOUS + daftar tabel (pilih dengan `table`).
/* eslint-disable @typescript-eslint/no-explicit-any -- structuredContent bebas bentuk */
import { describe, it, expect, beforeEach } from '../_vitest';
import { connect, logs, reply, type Call } from './mcp-harness';
import { DOC, MD, statefulServer } from '../draft/r3-stateful-harness';
import { applyEdits, type EditOp, type EditPart } from '../../../vendor/scripts/studio/mcp/write-edit';
import { McpToolError } from '../../../vendor/scripts/studio/mcp/safety';

const AGENT = 'cod-implw11';
const env = { STUDIO_AGENT_ID: AGENT, STUDIO_MCP_TOOLSETS: 'write' };

beforeEach(() => {
  logs.length = 0;
});

/** Probe Q1 review 17: `## Bukti` (T0) / `### Sub A` (TA) / `### Sub B` (TB) / `## Lain`; semua tabel 2 kolom. */
const PROBE = (ownTable = true): string[] => [
  '## Bukti',
  '',
  ...(ownTable ? ['| uji | hasil |', '|---|---|', '| a | 1 |', ''] : ['Pembuka bukti.', '']),
  '### Sub A',
  '',
  'isi A',
  '',
  '| ka | kb |',
  '|---|---|',
  '| x | y |',
  '',
  '### Sub B',
  '',
  'isi B',
  '',
  '| kc | kd |',
  '|---|---|',
  '| p | q |',
  '',
  '## Lain',
  '',
  'isi lain',
];
const partsOf = (body: string[]): EditPart[] => [{ part: 'bab 3', md: { header: [], intro: [], tail: [], body: [...body] } }];
function run(edits: EditOp[], body = PROBE()) {
  const parts = partsOf(body);
  const warns: string[] = [];
  applyEdits(parts, edits, (w) => warns.push(w.code), {});
  return { lines: parts[0].md.body.filter((l) => l.trim() !== ''), warns };
}
function fails(edits: EditOp[], body = PROBE()): McpToolError {
  try {
    applyEdits(partsOf(body), edits, () => undefined, {});
  } catch (e) {
    if (e instanceof McpToolError) return e;
    throw e;
  }
  throw new Error('applyEdits tidak menolak');
}
const after = (lines: string[], anchor: string) => lines[lines.indexOf(anchor) + 1];

describe('R1: append mengikuti rentang sasaran', () => {
  it('append ke "Sub A" mendarat di akhir isi Sub A (sebelum ### Sub B)', () => {
    const { lines } = run([{ section: 'Sub A', append: ['BARU'] }]);
    expect(after(lines, '| x | y |')).toBe('BARU');
    expect(after(lines, 'BARU')).toBe('### Sub B');
  });

  it('append ke "Bukti" (induk) tetap di akhir seluruh section, sesudah isi Sub B (perbaikan IMPL-W10 dipertahankan)', () => {
    const { lines } = run([{ section: 'Bukti', append: ['BARU'] }]);
    expect(after(lines, '| p | q |')).toBe('BARU');
    expect(after(lines, 'BARU')).toBe('## Lain');
  });

  it('append ke sub-judul terakhir = akhir section induk; sub-sub-judul (####) ikut dalam rentang ###', () => {
    expect(after(run([{ section: 'Sub B', append: ['BARU'] }]).lines, '| p | q |')).toBe('BARU');
    const nested = PROBE().flatMap((l) => (l === '### Sub B' ? ['#### Sub A1', '', 'isi A1', '', l] : [l]));
    const { lines } = run([{ section: 'Sub A', append: ['BARU'] }], nested);
    expect(after(lines, 'isi A1')).toBe('BARU');
    expect(after(lines, 'BARU')).toBe('### Sub B');
    // Sasaran #### berakhir di ### berikutnya.
    const r2 = run([{ section: 'Sub A1', append: ['BARU1'] }], nested);
    expect(after(r2.lines, 'isi A1')).toBe('BARU1');
  });
});

describe('R1: addRow memilih tabel milik sasaran', () => {
  it('addRow ke "Sub A" masuk TA; ke "Sub B" masuk TB (lebar sama, salah sasaran tidak akan galat)', () => {
    const a = run([{ section: 'Sub A', addRow: [['n1', 'n2']] }]).lines;
    expect(after(a, '| x | y |')).toBe('| n1 | n2 |');
    expect(after(a, '| n1 | n2 |')).toBe('### Sub B');
    const b = run([{ section: 'Sub B', addRow: [['n1', 'n2']] }]).lines;
    expect(after(b, '| p | q |')).toBe('| n1 | n2 |');
    expect(after(b, '| n1 | n2 |')).toBe('## Lain');
  });

  it('addRow ke "Bukti" (induk) tanpa table = tabel terakhir sebelum sub-judul pertama (T0)', () => {
    const l = run([{ section: 'Bukti', addRow: [['n1', 'n2']] }]).lines;
    expect(after(l, '| a | 1 |')).toBe('| n1 | n2 |');
    expect(after(l, '| n1 | n2 |')).toBe('### Sub A');
    expect(l.filter((x) => x === '| n1 | n2 |')).toHaveLength(1);
  });

  it('nomor table pada induk mencakup tabel sub-judul (1 = T0, 2 = TA, 3 = TB)', () => {
    expect(after(run([{ section: 'Bukti', addRow: [['n1', 'n2']], table: 2 }]).lines, '| x | y |')).toBe('| n1 | n2 |');
    expect(after(run([{ section: 'Bukti', addRow: [['n1', 'n2']], table: 3 }]).lines, '| p | q |')).toBe('| n1 | n2 |');
    expect(after(run([{ section: 'Bukti', addRow: [['n1', 'n2']], table: 'kc' }]).lines, '| p | q |')).toBe('| n1 | n2 |');
  });

  it('induk tanpa tabel sendiri, sub-judul bertabel -> TEXT_AMBIGUOUS + daftar kandidat; table memilih', () => {
    const e = fails([{ section: 'Bukti', addRow: [['n1', 'n2']] }], PROBE(false));
    expect(e.code).toBe('TEXT_AMBIGUOUS');
    expect(e.message).toContain('table');
    const tables = (e.extra.details as any).tables;
    expect(tables.map((t: any) => t.header)).toEqual(['ka | kb', 'kc | kd']);
    const l = run([{ section: 'Bukti', addRow: [['n1', 'n2']], table: 1 }], PROBE(false)).lines;
    expect(after(l, '| x | y |')).toBe('| n1 | n2 |');
    // Satu kandidat di sub-judul pun tidak dipilih diam-diam.
    const single = ['## Bukti', '', 'Pembuka bukti.', '', '### Sub A', '', '| ka | kb |', '|---|---|', '| x | y |', '', '## Lain', '', 'isi lain'];
    expect(fails([{ section: 'Bukti', addRow: [['n1', 'n2']] }], single).code).toBe('TEXT_AMBIGUOUS');
  });

  it('section tanpa sub-judul dan tanpa tabel tetap TEXT_NOT_FOUND; tanpa sub-judul tetap tabel terakhir', () => {
    expect(fails([{ section: 'Lain', addRow: [['n1', 'n2']] }]).code).toBe('TEXT_NOT_FOUND');
    const flat = ['## Bukti', '', '| a | b |', '|---|---|', '| 1 | 2 |', '', 'antara', '', '| c | d |', '|---|---|', '| 3 | 4 |'];
    expect(after(run([{ section: 'Bukti', addRow: [['n1', 'n2']] }], flat).lines, '| 3 | 4 |')).toBe('| n1 | n2 |');
  });

  it('R4 (didokumentasikan): find dengan section induk hanya mencakup teks section itu sendiri, bukan sub-judul', () => {
    expect(fails([{ find: 'isi A', replace: 'ISI A', section: 'Bukti' }]).code).toBe('TEXT_NOT_FOUND');
    expect(run([{ find: 'isi A', replace: 'ISI A', section: 'Sub A' }]).lines).toContain('ISI A');
  });
});

/** Server berkeadaan, laporan milik pemanggil. */
function mock(seed: string) {
  const s = statefulServer(seed);
  const calls: Call[] = [];
  const f = async (url: string, init: any) => {
    const u = new URL(url);
    calls.push({ method: init.method, url, headers: init.headers, redirect: init.redirect, body: init.body ? JSON.parse(init.body) : undefined });
    if (init.method === 'POST' && u.pathname === '/api/studio/validate') return reply({ status: 200, body: { valid: true, issues: [] } });
    if (init.method === 'GET' && u.pathname === '/api/studio/documents') return reply({ status: 200, body: { documents: [{ id: DOC, createdBy: `agent:${AGENT}`, currentRevisionNo: s.rev() }], nextCursor: null } });
    if (init.method === 'GET' && u.pathname === '/api/studio/contracts') return reply({ status: 200, body: { contracts: [{ documentId: DOC }], nextCursor: null } });
    if (init.method === 'GET' && u.pathname === `/api/studio/documents/${DOC}`) return reply({ status: 200, body: { document: { id: DOC, docNumber: '040/GSP/LAP/XI/2026', createdBy: `agent:${AGENT}`, currentRevisionNo: s.rev() }, revision: { revisionNo: s.rev(), createdBy: `agent:${AGENT}` } } });
    if (init.method === 'PATCH' && u.pathname === `/api/studio/documents/${DOC}/structure`) return reply({ status: 200, body: { document: { id: DOC }, revision: { revisionNo: s.rev() } } });
    return s.f(url, init);
  };
  return { f, calls, s };
}
const blocksOf = (m: ReturnType<typeof mock>, key: string) => m.s.chapter(key).sections.flatMap((x: any) => x.blocks);
const labelOf = (b: any): string => (b.role === 'subheading' ? `### ${b.text}` : b.type === 'table' ? `T:${JSON.stringify(b.rows?.[0] ?? b.header ?? b).slice(0, 40)}` : b.type === 'paragraph' ? b.text : b.type);
/** Bab 3 (Bukti) berisi dua sub-judul bertabel, tanpa tabel sendiri sebelum Sub A selain T0. */
const SUBS = MD({ bab3: ['| uji | hasil |', '|---|---|', '| a | 1 |', '', '### Sub A', '', 'isi A', '', '| ka | kb |', '|---|---|', '| x | y |', '', '### Sub B', '', 'isi B', '', '| kc | kd |', '|---|---|', '| p | q |'] });

describe('R1 lewat studio_edit: pagar bentuk (CONTENT_INJECTION) mengikuti posisi append di tengah section', () => {
  it('append daftar ke Sub A (Sub B bertabel) -> ok, daftar di akhir Sub A, tanpa CONTENT_INJECTION palsu', async () => {
    const m = mock(SUBS);
    const { call } = await connect({ fetch: m.f as any, env });
    const r = await call('studio_edit', { documentId: DOC, edits: [{ section: 'Sub A', append: [{ list: ['satu', 'dua'] }] }] });
    expect(r.data.ok, r.text).toBe(true);
    const seq = blocksOf(m, '3').map((b: any) => (b.role === 'subheading' ? 'sub' : b.type));
    expect(seq).toEqual(['table', 'sub', 'paragraph', 'table', 'list', 'sub', 'paragraph', 'table']);
  });

  it('addRow ke Sub A dan ke Bukti (satu batch) -> baris di TA dan T0, TB tidak berubah', async () => {
    const m = mock(SUBS);
    const { call } = await connect({ fetch: m.f as any, env });
    const r = await call('studio_edit', { documentId: DOC, edits: [{ section: 'Sub A', addRow: ['n1', 'n2'] }, { section: 'Bukti', addRow: ['m1', 'm2'] }] });
    expect(r.data.ok, r.text).toBe(true);
    const tables = blocksOf(m, '3').filter((b: any) => b.type === 'table').map((b: any) => JSON.stringify(b));
    expect(tables).toHaveLength(3);
    expect(tables[0]).toContain('m1');
    expect(tables[1]).toContain('n1');
    expect(tables[2]).not.toContain('n1');
    expect(tables[2]).not.toContain('m1');
    expect(blocksOf(m, '3').map(labelOf).filter((x: string) => x.startsWith('###'))).toEqual(['### Sub A', '### Sub B']);
  });
});

describe('R3: baris n-1 pada tabel butir berkolom key hanya tanpa-kunci bila sel pertama bukan kunci', () => {
  const ITEMS = ['## Rincian kerja', '', '| key | judul | status | bukti |', '|---|---|---|---|', '| R3F2-1 | Satu | done | out/a |', '| K-0a1b2c3d | Dua | done | out/b |'];
  const prev = { prevItemStatus: new Map([['r3f2-1', 'done'], ['k-0a1b2c3d', 'done']]) };
  const tryAdd = (row: string[]) => {
    const parts = [{ part: 'bab 2', md: { header: [], intro: [], tail: [], body: [...ITEMS] } }];
    try {
      applyEdits(parts, [{ section: 'Rincian kerja', addRow: [row] }], () => undefined, prev);
      return { ok: true as const, last: parts[0].md.body.at(-1) as string };
    } catch (e) {
      if (!(e instanceof McpToolError)) throw e;
      return { ok: false as const, code: e.code, details: e.extra.details as any, message: e.message };
    }
  };

  it.each([
    ['probe Q3: bentuk kunci tabel ini (R3F2-<angka>)', ['R3F2-9', 'Sembilan', 'selesai']],
    ['kunci yang sudah ada', ['R3F2-1', 'Satu lagi', 'selesai']],
    ['kunci K-heksa', ['K-deadbeef', 'Tiga', 'selesai']],
    ['kunci K-heksa berakhiran bentrok', ['K-deadbeef-2', 'Tiga', 'selesai']],
  ])('%s -> EDIT_INVALID dengan judul kolom', (_n, row) => {
    const r = tryAdd(row);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('EDIT_INVALID');
    expect(r.details.expectedHeader).toEqual(['key', 'judul', 'status', 'bukti']);
    expect(r.message).toContain('kunci');
  });

  it('judul biasa (bentuk how-to) tetap diterima tanpa kunci; kunci dibangkitkan', () => {
    const r = tryAdd(['X-B5: tugas lima', 'berjalan', 'out/c']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Status dinormalkan ke kode registri (berjalan -> running) oleh normalizeItemStatuses.
    expect(r.last).toMatch(/^\| K-[0-9a-f]{8} \| X-B5: tugas lima \| running \| out\/c \|$/);
  });
});
