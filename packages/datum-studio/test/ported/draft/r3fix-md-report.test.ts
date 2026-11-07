// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/draft/r3fix-md-report.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
// R3-F (D-439, D-440; review gateway_check/15 #1-#5, #7, #8, #10-#12): update tiga arah terhadap
// basis salinan agen (dua penulis -> BASE_CONFLICT, bagian tak bersinggungan lolos), templat
// placeholder, items/evidence tidak dihapus diam-diam, bab hilang dilaporkan jujur, kunci bab tambahan
// stabil, nilai majemuk "dan/and/&", refs + initiator lewat MD, --agent-id menang. Server dan fs di-mock.
import { describe, it, expect } from '../_vitest';
import { createHash } from 'node:crypto';
import { main, nextBasisOf, type FsLike, type HttpFetch, type StepResult } from '../../../vendor/scripts/studio/studio-report';
import { extractRefs, findPlaceholders, mdReportToBlocks, reportTemplate } from '../../../vendor/src/lib/studio/services/draft/md-report';
import { markdownToContract } from '../../../vendor/src/lib/studio/services/import/contract';
import { cleanValue, trimBackticks } from '../../../vendor/src/lib/studio/services/import/contract/parse';

const SECRET = 'rahasia-uji-r3fix-jangan-tercetak';
const DOC = 'cmvvdoc0000000000000r3fix1';
const OTHER = 'cmvvdoc0000000000000r3fix2';
const REFDOC = 'cmvwbis1d01mkv1i8x3hhgsm3';
const FILE = 'cmvvfile0000000000000r3fix';
const MISSION = '2026-10-31_r3f';
const DOC_KEY = 'lapkerja-r3f-uji';
const HTML = Buffer.from('<html><body>laporan</body></html>', 'utf8');
const SHA = createHash('sha256').update(HTML).digest('hex');
const FINAL = `031-GSP-LAP-X-2026_rev9_20261031T120000Z_${SHA.slice(0, 8)}.html`;

interface MdOpts {
  basis?: string | null;
  status?: string;
  bab3?: string;
  bab4?: boolean;
  bab5?: string;
  items?: 'table' | 'list';
  extras?: Array<[string, string]>;
  title?: string;
  head?: string[];
  refs?: string[];
}

/** Laporan MD-native: kepala (+ basis) + 5 bab outline (+ bab tambahan). */
const MD = (o: MdOpts = {}) =>
  [
    `# ${o.title ?? 'Laporan uji R3-F'}`,
    '',
    `mission: ${MISSION}`,
    `docKey: ${DOC_KEY}`,
    ...(o.basis === null ? [] : [`basis: ${o.basis ?? `${DOC}@rev8`}`]),
    `Status: ${o.status ?? 'partial'}`,
    'Owner: cod-r3-f',
    'ReportedAt: 2026-10-31T10:00+07:00',
    ...(o.head ?? []),
    '',
    '## Ringkasan',
    '',
    'Ringkasan satu.',
    '',
    '## Rincian kerja',
    '',
    ...(o.items === 'list' ? ['- t_249c6b84: Tulis bab (done)'] : ['| key | judul | status | bukti |', '|---|---|---|---|', '| t_249c6b84 | Tulis bab | done | out/bab2.json 120 B sha 55d324b1 |']),
    '',
    '## Bukti',
    '',
    o.bab3 ?? 'Bukti satu.',
    '',
    ...(o.bab4 === false ? [] : ['## Isu terbuka', '', 'Tidak ada.', '']),
    '## Langkah berikut',
    '',
    o.bab5 ?? '- Lanjut.',
    '',
    ...(o.extras ?? []).flatMap(([h, t]) => [`## ${h}`, '', t, '']),
    ...(o.refs ? ['## Rujukan', '', '| hubungan | dokumen | paragraf | revisi |', '|---|---|---|---|', ...o.refs, ''] : []),
  ].join('\n');

/** Proyeksi R20 dari laporan MD (pid `id` disisipkan; `sameContent` mengabaikannya). */
function contentOf(md: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const { blocks, conversion } = mdReportToBlocks(md.replace(/^basis: .*$/m, ''), { mode: 'create' });
  const withIds = (v: unknown, n = { i: 0 }): unknown =>
    Array.isArray(v) ? v.map((x) => withIds(x, n)) : v && typeof v === 'object' ? { ...Object.fromEntries(Object.entries(v).map(([k, x]) => [k, withIds(x, n)])), ...('type' in v || 'key' in v ? { id: `p${++n.i}` } : {}) } : v;
  const record = (blocks[0] as { payload: Record<string, unknown> }).payload;
  const chapters = blocks.filter((b) => b.$schema === 'studio.chapter/v2').map((b) => withIds((b as { chapter: unknown }).chapter));
  return { meta: { title: conversion.title }, sections: { record: { ...record, ...extra }, content: { type: 'chapter', chapters } } };
}

interface Call {
  method: string;
  path: string;
  body: unknown;
}

/** Server tiruan berrevisi: GET content = terkini, `?rev=n` = revisi n; POST = revisi baru. */
function fakeServer(history: Record<number, unknown>) {
  const calls: Call[] = [];
  let rev = Math.max(...Object.keys(history).map(Number));
  const f: HttpFetch = async (url, init) => {
    const u = new URL(url);
    const c: Call = { method: init.method, path: u.pathname + u.search, body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(c);
    let res: { status: number; body?: unknown; bytes?: Buffer; headers?: Record<string, string> } = { status: 404, body: { error: 'x', code: 'NOT_FOUND' } };
    if (c.method === 'POST' && (u.pathname === '/api/studio/slots' || u.pathname === '/api/studio/chapters')) {
      rev++;
      res = { status: 201, body: { document: { id: DOC, docNumber: '031/GSP/LAP/X/2026' }, created: rev === 1, unchanged: false, revision: { revisionNo: rev } } };
    } else if (c.method === 'GET' && u.pathname === `/api/studio/documents/${DOC}/content`) {
      const want = u.searchParams.get('rev');
      const n = want === null ? Math.max(...Object.keys(history).map(Number)) : Number(want);
      res = history[n] === undefined ? { status: 404, body: { error: 'x', code: 'REVISION_NOT_FOUND' } } : { status: 200, body: { document: { id: DOC, docNumber: '031/GSP/LAP/X/2026' }, revisionNo: n, content: history[n] } };
    } else if (u.pathname === `/api/studio/documents/${DOC}/completeness`) {
      res = { status: 200, body: { completeness: { status: 'COMPLETE', missingRequired: [] } } };
    } else if (u.pathname === `/api/studio/documents/${DOC}/render`) {
      res = { status: 200, body: { job: { revisionNo: rev }, outputs: [{ id: FILE, role: 'PRIMARY', format: 'HTML', scope: { kind: 'DOCUMENT' }, sha256: SHA, finalFileName: FINAL }] } };
    } else if (c.method === 'GET' && u.pathname === `/api/studio/files/${FILE}`) {
      res = { status: 200, bytes: HTML, headers: { 'x-studio-final-filename': FINAL, 'x-studio-sha256': SHA } };
    } else if (c.method === 'HEAD') {
      res = { status: 200, headers: { 'x-studio-final-filename': FINAL, 'x-studio-sha256-verified': 'true' } };
    }
    const h = new Map(Object.entries({ 'x-correlation-id': `cid-${calls.length}`, ...(res.headers ?? {}) }));
    return {
      status: res.status,
      headers: { get: (n: string) => h.get(n.toLowerCase()) ?? null },
      text: async () => (res.body === undefined ? '' : JSON.stringify(res.body)),
      arrayBuffer: async () => {
        const b = res.bytes ?? Buffer.alloc(0);
        return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
      },
    };
  };
  return { f, calls, posts: () => calls.filter((c) => c.method === 'POST' && !c.path.endsWith('/render')) };
}

function memFs(files: Record<string, string>) {
  const writes: string[] = [];
  const appended: string[] = [];
  const fsx: FsLike = {
    existsSync: (p) => p in files,
    readFileSync: (p) => {
      if (!(p in files)) throw Object.assign(new Error(`ENOENT ${p}`), { code: 'ENOENT' });
      return files[p];
    },
    readFileSyncBuffer: (p) => Buffer.from(fsx.readFileSync(p, 'utf8'), 'utf8'),
    appendFileSync: (p, d) => void appended.push(d),
    mkdirSync: (p) => void writes.push(`mkdir ${p}`),
    writeFileSync: (p) => void writes.push(`write ${p}`),
  };
  return { fsx, writes, appended };
}

async function run(argv: string[], o: { fetch?: HttpFetch; fs?: FsLike } = {}) {
  let out = '';
  let err = '';
  let t = 1_793_424_000_000;
  const code = await main(argv, {
    stdout: (s) => (out += s),
    stderr: (s) => (err += s),
    env: { INTERNAL_API_SECRET: SECRET },
    fetchImpl: o.fetch ?? (async () => Promise.reject(new Error('tidak boleh dipanggil'))),
    fs: o.fs,
    now: () => (t += 25),
  });
  return { code, out, err };
}

const keyOf = (c: Call) => (c.body as { chapter?: { key: string }; slot?: string }).chapter?.key ?? (c.body as { slot?: string }).slot;

/** Riwayat: rev8 = salinan A dan B; rev9 = B mengubah bab 3 (penulis kedua). */
const REV8 = contentOf(MD());
const REV9 = contentOf(MD({ bab3: 'PENULIS-B menambah bukti.' }));

describe('#1 lost update: update tiga arah terhadap basis salinan agen', () => {
  it('reproduksi review P5: A (salinan rev8) mengubah bab 5 saja sesudah B mengubah bab 3 -> hanya bab 5 dikirim (baseRevisionNo 8), suntingan B tetap, isi terkini bab 3 dicetak', async () => {
    const s = fakeServer({ 8: REV8, 9: REV9 });
    const r = await run(['update', DOC, 'a.md', '--remote', 'http://h', '--agent-id', 'cod-r3-f', '--json'], { fetch: s.f, fs: memFs({ 'a.md': MD({ bab5: '- Lanjut oleh A.' }) }).fsx });
    expect(r.code).toBe(0);
    expect(s.posts().map(keyOf)).toEqual(['5']);
    expect(s.posts()[0].body).toMatchObject({ baseRevisionNo: 8, target: { documentId: DOC } });
    expect(s.calls.map((c) => c.path).slice(0, 2)).toEqual([`/api/studio/documents/${DOC}/content`, `/api/studio/documents/${DOC}/content?rev=8`]);
    const j = JSON.parse(r.out);
    expect(j.delta).toMatchObject({ sent: ['bab 5'], stale: ['bab 3'] });
    expect(j.basis).toMatchObject({ mode: 'basis', revisionNo: 8, source: 'kepala', latestRevisionNo: 9 });
    expect(j.refresh[0].part).toBe('bab 3');
    expect(j.refresh[0].markdown.join('\n')).toContain('PENULIS-B');
    expect(j.nextBasis).toBeNull(); // salinan A tertinggal untuk bab 3
    expect(j.nextBasisNote).toContain('bab 3');
    const h = await run(['update', DOC, 'a.md', '--remote', 'http://h'], { fetch: fakeServer({ 8: REV8, 9: REV9 }).f, fs: memFs({ 'a.md': MD({ bab5: '- Lanjut oleh A.' }) }).fsx });
    expect(h.out).toContain('isi terkini bab 3');
    expect(h.out).toContain('basis berikutnya: belum dapat dipakai');
  });

  it('A juga mengubah bab 3 (bentrok dengan B) -> BASE_CONFLICT rc 1, TIDAK ada kiriman, isi terkini + petunjuk segarkan + --section untuk bagian tak bersinggungan', async () => {
    const s = fakeServer({ 8: REV8, 9: REV9 });
    const md = MD({ bab3: 'Bukti satu diperluas A.', bab5: '- Lanjut oleh A.' });
    const r = await run(['update', DOC, 'a.md', '--remote', 'http://h', '--json'], { fetch: s.f, fs: memFs({ 'a.md': md }).fsx });
    expect(r.code).toBe(1);
    expect(s.posts()).toHaveLength(0);
    const j = JSON.parse(r.out);
    expect(j.fatal).toMatchObject({ code: 'BASE_CONFLICT', details: { basisRevisionNo: 8, latestRevisionNo: 9, conflicts: ['bab 3'], sendable: ['bab 5'] } });
    expect(r.err).toContain(`basis: ${DOC}@rev9`);
    expect(r.err).toContain('--section 5');
    expect(r.err).toContain('PENULIS-B');
    // Bagian tak bersinggungan lolos lewat --section.
    const s2 = fakeServer({ 8: REV8, 9: REV9 });
    const r2 = await run(['update', DOC, 'a.md', '--remote', 'http://h', '--section', '5', '--json'], { fetch: s2.f, fs: memFs({ 'a.md': md }).fsx });
    expect(r2.code).toBe(0);
    expect(s2.posts().map(keyOf)).toEqual(['5']);
    // bab 3 Anda (belum terkirim, di luar --section) masih berbeda dari dokumen: basis baru belum aman.
    expect(JSON.parse(r2.out)).toMatchObject({ nextBasis: null, nextBasisNote: expect.stringContaining('bab 3') });
    // --section pada bagian bentrok tetap ditolak.
    const s3 = fakeServer({ 8: REV8, 9: REV9 });
    expect((await run(['update', DOC, 'a.md', '--remote', 'http://h', '--section', '3'], { fetch: s3.f, fs: memFs({ 'a.md': md }).fsx })).code).toBe(1);
    expect(s3.posts()).toHaveLength(0);
  });

  it('sesudah menyegarkan (isi bab 3 = terkini, basis rev9): suntingan A dikirim, basis berikutnya dicetak', async () => {
    const s = fakeServer({ 8: REV8, 9: REV9 });
    const md = MD({ basis: `${DOC}@rev9`, bab3: 'PENULIS-B menambah bukti. Ditambah A.' });
    const r = await run(['update', DOC, 'a.md', '--remote', 'http://h', '--json'], { fetch: s.f, fs: memFs({ 'a.md': md }).fsx });
    expect(r.code).toBe(0);
    expect(s.posts().map(keyOf)).toEqual(['3']);
    expect(s.posts()[0].body).toMatchObject({ baseRevisionNo: 9 });
    expect(JSON.parse(r.out).nextBasis).toBe(`basis: ${DOC}@rev10`);
    expect(s.calls.filter((c) => c.path.includes('?rev='))).toHaveLength(0); // basis = terkini: satu baca R20
  });

  it('tanpa basis -> BASIS_MISSING rc 1 tanpa panggilan; basis dokumen lain -> BASIS_DOCUMENT_MISMATCH rc 2; basis > terkini -> BASIS_INVALID', async () => {
    const r = await run(['update', DOC, 'a.md', '--remote', 'http://h'], { fs: memFs({ 'a.md': MD({ basis: null }) }).fsx });
    expect(r.code).toBe(1);
    expect(r.err).toContain('BASIS_MISSING');
    expect(r.err).toContain(`basis: ${DOC}@rev<n>`);
    const m = await run(['update', DOC, 'a.md', '--remote', 'http://h'], { fs: memFs({ 'a.md': MD({ basis: `${OTHER}@rev3` }) }).fsx });
    expect(m.code).toBe(2);
    expect(m.err).toContain('BASIS_DOCUMENT_MISMATCH');
    const s = fakeServer({ 8: REV8, 9: REV9 });
    const big = await run(['update', DOC, 'a.md', '--remote', 'http://h'], { fetch: s.f, fs: memFs({ 'a.md': MD({ basis: `${DOC}@rev12` }) }).fsx });
    expect(big.code).toBe(1);
    expect(big.err).toContain('BASIS_INVALID');
    expect(s.posts()).toHaveLength(0);
    const bad = await run(['update', DOC, 'a.md', '--remote', 'http://h'], { fs: memFs({ 'a.md': MD({ basis: 'rev8' }) }).fsx });
    expect(bad.code).toBe(1);
    expect(bad.err).toContain('baris basis tidak sah');
  });

  it('--base-rev menang atas kepala (pemberitahuan); --force-latest tercatat di hasil dan timing; keduanya bersama = galat pemakaian', async () => {
    const s = fakeServer({ 8: REV8, 9: REV9 });
    const r = await run(['update', DOC, 'a.md', '--remote', 'http://h', '--base-rev', '9', '--json'], { fetch: s.f, fs: memFs({ 'a.md': MD({ basis: `${DOC}@rev8`, bab3: 'PENULIS-B menambah bukti.' }) }).fsx });
    expect(r.code).toBe(0);
    const j = JSON.parse(r.out);
    expect(j.basis).toMatchObject({ source: '--base-rev', revisionNo: 9 });
    expect(j.notices.join('\n')).toContain('--base-rev 9 menggantikan baris basis kepala rev8');
    const { fsx, appended } = memFs({ 'a.md': MD({ basis: null, bab5: '- Lanjut.' }) });
    const f = await run(['update', DOC, 'a.md', '--remote', 'http://h', '--force-latest', '--timing', 't.csv', '--json'], { fetch: fakeServer({ 8: REV8, 9: REV9 }).f, fs: fsx });
    expect(f.code).toBe(0);
    expect(JSON.parse(f.out).basis.mode).toBe('force-latest');
    expect(appended.join('')).toContain('a.md force-latest');
    expect((await run(['update', DOC, 'a.md', '--base-rev', '3', '--force-latest'])).code).toBe(2);
    expect((await run(['submit', 'a.md', '--force-latest'])).code).toBe(2);
  });

  it('submit mencetak baris basis berikutnya; nextBasisOf menolak bila ada penulis lain di sela kiriman', async () => {
    const s = fakeServer({ 0: null });
    const r = await run(['submit', 'a.md', '--remote', 'http://h'], { fetch: s.f, fs: memFs({ 'a.md': MD({ basis: null }) }).fsx });
    expect(r.code).toBe(0);
    expect(r.out).toContain(`basis: ${DOC}@rev6`);
    const step = (revisionNo: number): StepResult => ({ block: 1, schema: 's', part: 'bab 1', route: 'POST', status: 201, revisionNo, created: false, unchanged: false, skipped: false, correlationId: null });
    expect(nextBasisOf(DOC, [step(10), step(11)], 9, []).line).toBe(`basis: ${DOC}@rev11`);
    expect(nextBasisOf(DOC, [step(10), step(12)], 9, []).line).toBeNull();
  });
});

describe('#2 templat placeholder (D-439)', () => {
  it('templat apa adanya dengan --mission/--doc-key -> TEMPLATE_PLACEHOLDER rc 1 tanpa kiriman; sebagian diisi tetap ditolak', async () => {
    const t = reportTemplate({ format: 'md', mission: MISSION, docKey: DOC_KEY });
    expect(t).toMatch(/Status: <isi: draft atau complete/);
    expect(t).not.toMatch(/PSIKOTES|gsp-document-writer|2026-10-31T16:40/); // tanpa fakta contoh
    const s = fakeServer({ 0: null });
    const r = await run(['submit', 't.md', '--remote', 'http://h'], { fetch: s.f, fs: memFs({ 't.md': t }).fsx });
    expect(r.code).toBe(1);
    expect(r.err).toContain('TEMPLATE_PLACEHOLDER');
    expect(s.calls).toHaveLength(0);
    const partial = t.replace(/^Status: .*$/m, 'Status: complete').replace(/^ReportedAt: .*$/m, 'ReportedAt: 2026-10-31');
    const p = await run(['submit', 't.md', '--remote', 'http://h'], { fetch: s.f, fs: memFs({ 't.md': partial }).fsx });
    expect(p.code).toBe(1);
    expect(p.err).toContain('TEMPLATE_PLACEHOLDER');
    expect(s.calls).toHaveLength(0);
    // KD-42 berlapis: bahkan tanpa pemeriksa placeholder, status/ReportedAt placeholder tidak punya alias.
    expect(() => markdownToContract(t.replace(/<isi:/g, '<x:'), { kind: 'agentWorkReport', extraAliases: { headerKeys: { reportedat: 'reportedAt' } } })).toThrow(/status, reportedAt/);
  });

  it('templat json juga ditolak sampai diisi', async () => {
    const t = reportTemplate({ format: 'json', mission: MISSION, docKey: DOC_KEY });
    expect(findPlaceholders(t).length).toBeGreaterThan(0);
    const s = fakeServer({ 0: null });
    const r = await run(['submit', 't.md', '--remote', 'http://h'], { fetch: s.f, fs: memFs({ 't.md': t }).fsx });
    expect(r.code).toBe(1);
    expect(r.err).toContain('TEMPLATE_PLACEHOLDER');
    expect(s.calls).toHaveLength(0);
  });
});

describe('#3 butir kerja sebagai daftar: items/evidence tidak dihapus diam-diam', () => {
  it('update: basis punya items+evidence, laporan menulis butir sebagai daftar -> RECORD_FIELDS_DROPPED rc 1, tidak ada kiriman', async () => {
    const base = contentOf(MD());
    // row42 W6: bun 1.3.14 toMatchObject with asymmetric matchers overwrites the received values with the
    // matcher objects (probe: [1,2] -> {} after the call); assert on a clone so `base` reaches the server intact.
    expect(structuredClone((base.sections as { record: { items?: unknown; evidence?: unknown } }).record)).toMatchObject({ items: expect.any(Array), evidence: expect.any(Array) });
    const s = fakeServer({ 8: base });
    const r = await run(['update', DOC, 'a.md', '--remote', 'http://h', '--json'], { fetch: s.f, fs: memFs({ 'a.md': MD({ items: 'list' }) }).fsx });
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out).fatal).toMatchObject({ code: 'RECORD_FIELDS_DROPPED', details: { lost: ['evidence', 'items'] } });
    expect(r.err).toContain('tabel');
    expect(s.posts()).toHaveLength(0);
  });

  it('medan yang tidak dapat ditulis lewat MD (due, phase) juga dijaga; submit butir daftar -> peringatan MD_REPORT_ITEMS_AS_LIST', async () => {
    const s = fakeServer({ 8: contentOf(MD(), { due: '2026-11-03' }) });
    const r = await run(['update', DOC, 'a.md', '--remote', 'http://h'], { fetch: s.f, fs: memFs({ 'a.md': MD({ status: 'complete' }) }).fsx });
    expect(r.code).toBe(1);
    expect(r.err).toContain('due');
    expect(s.posts()).toHaveLength(0);
    const sub = await run(['submit', 'a.md', '--remote', 'http://h'], { fetch: fakeServer({ 0: null }).f, fs: memFs({ 'a.md': MD({ basis: null, items: 'list' }) }).fsx });
    expect(sub.code).toBe(0);
    expect(sub.out).toContain('MD_REPORT_ITEMS_AS_LIST');
  });
});

describe('#4 bab dihapus dari MD / #10 judul', () => {
  it('bab 4 tidak ada di laporan: tidak ada klaim "belum lengkap" palsu; dilaporkan "ada di dokumen, tidak ada di laporan" dan TIDAK dihapus; judul berbeda diberitahukan', async () => {
    const s = fakeServer({ 8: REV8 });
    const r = await run(['update', DOC, 'a.md', '--remote', 'http://h'], { fetch: s.f, fs: memFs({ 'a.md': MD({ bab4: false, title: 'Judul baru' }) }).fsx });
    expect(r.code).toBe(0);
    expect(r.out).not.toContain('belum lengkap');
    expect(r.out).toContain('ada di dokumen, tidak ada di laporan: bab 4 (Isu terbuka) -> TIDAK dihapus');
    expect(r.out).toContain('kelengkapan: COMPLETE');
    expect(r.out).toContain('update TIDAK memperbarui judul');
    expect(s.posts()).toHaveLength(0);
  });
});

describe('#5 kunci bab tambahan stabil (dicocokkan menurut judul)', () => {
  it('reproduksi review P7: Catatan A dihapus, Catatan B disunting -> dikirim ke bab 7 (bukan 6); judul baru -> bab 8', async () => {
    const base = contentOf(MD({ extras: [['Catatan A', 'Isi A.'], ['Catatan B', 'Isi B.']] }));
    const s = fakeServer({ 8: base });
    const r = await run(['update', DOC, 'a.md', '--remote', 'http://h', '--json'], { fetch: s.f, fs: memFs({ 'a.md': MD({ extras: [['Catatan B', 'Isi B disunting.'], ['Catatan C', 'Baru.']] }) }).fsx });
    expect(r.code).toBe(0);
    expect(s.posts().map((c) => [keyOf(c), (c.body as { chapter: { title: { text: string } } }).chapter.title.text])).toEqual([
      ['7', 'Catatan B'],
      ['8', 'Catatan C'],
    ]);
    expect(JSON.parse(r.out).notInReport).toEqual(['bab 6 (Catatan A)']);
  });
});

describe('#7 KD-42 nilai majemuk dan/and/&', () => {
  const conv = (head: string) => mdReportToBlocks(MD({ basis: null }).replace('Owner: cod-r3-f', head), { mode: 'create' });
  it('status "complete dan blocked" / "complete and blocked" / "complete & blocked" -> ditolak (tidak dipotong)', () => {
    for (const v of ['complete dan blocked', 'complete and blocked', 'complete & blocked', 'complete serta blocked']) {
      expect(() => mdReportToBlocks(MD({ basis: null, status: v }), { mode: 'create' }), v).toThrow(/status/);
    }
  });
  it('owner/taskRef majemuk -> CW-04, tidak diisi token pertama', () => {
    const o = conv('Owner: cod-a dan cod-b\nTaskRef: R3-01 & R3-02');
    const rec = (o.blocks[0] as { payload: Record<string, unknown> }).payload;
    expect(rec.owner).toBeUndefined();
    expect(rec.taskRef).toBeUndefined();
    expect(o.conversion.warnings.filter((w) => w.code === 'CONTRACT_FIELD_UNMAPPED').map((w) => (w.details as { reason: string }).reason)).toEqual(['compound', 'compound']);
    // Nilai tunggal tetap terbaca.
    expect((conv('Owner: cod-a').blocks[0] as { payload: { owner: string } }).payload.owner).toBe('cod-a');
  });
});

describe('D-440 refs, initiator, --agent-id', () => {
  it('bagian Rujukan (tabel) -> record.refs; Initiator/Pemberi tugas -> record.initiator', () => {
    const md = MD({ basis: null, head: ['Pemberi tugas: gsp-master01'], refs: [`| basis | ${REFDOC} | p-tadha0rs05 | 8 |`, `| bukti | ${REFDOC} |  |  |`] });
    const { blocks, conversion } = mdReportToBlocks(md, { mode: 'create' });
    const rec = (blocks[0] as { payload: Record<string, unknown> }).payload;
    expect(rec.initiator).toBe('gsp-master01');
    expect(rec.refs).toEqual([
      { documentId: REFDOC, pid: 'p-tadha0rs05', revisionNo: 8, rel: 'basis' },
      { documentId: REFDOC, rel: 'evidence' },
    ]);
    expect(conversion.refs).toBe(2);
    expect(conversion.warnings).toEqual([]);
    expect(conversion.parts).not.toContain('bab 6'); // Rujukan bukan bab tambahan
  });

  it('baris rujukan tidak sah -> MD_REPORT_INVALID (tidak dibuang diam-diam)', () => {
    expect(() => extractRefs(['## Rujukan', '', '| hubungan | dokumen |', '|---|---|', '| dikutip | bukan-id |'].join('\n'))).toThrow(/hubungan "dikutip"[\s\S]*bukan documentId/);
    expect(() => extractRefs(['## Rujukan', '', 'lihat dokumen X', ''].join('\n'))).toThrow(/di luar tabel/);
  });

  it('--agent-id menang atas agentId: kepala + pemberitahuan', async () => {
    const s = fakeServer({ 0: null });
    const r = await run(['submit', 'a.md', '--remote', 'http://h', '--agent-id', 'cod-r3-f-b'], { fetch: s.f, fs: memFs({ 'a.md': MD({ basis: null, head: ['agentId: cod-r3-f'] }) }).fsx });
    expect(r.code).toBe(0);
    expect(s.posts().every((c) => (c.body as { agentId: string }).agentId === 'cod-r3-f-b')).toBe(true);
    expect(r.out).toContain('AGENT_ID_OVERRIDDEN');
  });
});

describe('Low: #8 ReDoS, #11 batas bab, #12 kunci ganda', () => {
  it('#8 pemangkasan backtick linear', () => {
    const v = `x${'`'.repeat(200_000)}x`;
    const t0 = performance.now();
    expect(cleanValue(v)).toBe(v);
    expect(trimBackticks('``a`b``')).toBe('a`b');
    expect(performance.now() - t0).toBeLessThan(200);
  });
  it('#11 terlalu banyak bab tambahan -> MD_REPORT_TOO_LARGE dengan pesan MD', () => {
    const extras = Array.from({ length: 16 }, (_, i): [string, string] => [`Catatan ${String.fromCharCode(65 + i)}`, 'Isi.']);
    expect(() => mdReportToBlocks(MD({ basis: null, extras }), { mode: 'create' })).toThrow(/gabungkan judul ## tambahan/);
  });
  it('#12 kunci alat ganda berbeda -> pemberitahuan, nilai pertama dipakai', () => {
    const { conversion } = mdReportToBlocks(MD({ basis: null }).replace(`docKey: ${DOC_KEY}`, `docKey: ${DOC_KEY}\nmission: lain`), { mode: 'create' });
    expect(conversion.mission).toBe(MISSION);
    expect(conversion.notices.map((n) => n.code)).toContain('MD_REPORT_TOOL_KEY_DUPLICATE');
  });
});

describe('D-441 check: hanya periksa, tanpa create/submit/update/tulis berkas', () => {
  /** Server tiruan: R08 dry-run (valid kecuali `invalidPart`), R05 untuk DR-08; panggilan lain = 404. */
  function validateServer(o: { invalidChapter?: string; status?: number } = {}) {
    const calls: Call[] = [];
    const f: HttpFetch = async (url, init) => {
      const u = new URL(url);
      const body = init.body ? JSON.parse(init.body) : undefined;
      calls.push({ method: init.method, path: u.pathname + u.search, body });
      let res: { status: number; body: unknown } = { status: 404, body: { error: 'x', code: 'NOT_FOUND' } };
      if (o.status !== undefined) res = { status: o.status, body: { error: 'x', code: 'UNAUTHORIZED' } };
      else if (init.method === 'POST' && u.pathname === '/api/studio/validate') {
        const bad = o.invalidChapter !== undefined && body?.chapter?.key === o.invalidChapter;
        res = { status: 200, body: bad ? { valid: false, issues: [{ pointer: '/chapter/sections/0', keyword: 'CHAPTER_INVALID', message: 'bab ditolak server' }] } : { valid: true, issues: [] } };
      } else if (init.method === 'GET' && u.pathname === `/api/studio/documents/${DOC}`) res = { status: 200, body: { document: { id: DOC, currentRevisionNo: 9 } } };
      return {
        status: res.status,
        headers: { get: (n: string) => (n.toLowerCase() === 'x-correlation-id' ? `cid-${calls.length}` : null) },
        text: async () => JSON.stringify(res.body),
        arrayBuffer: async () => new ArrayBuffer(0),
      };
    };
    return { f, calls };
  }

  it('laporan valid + --remote: hanya POST R08 dry-run (dan GET R05 untuk basis), 0 kiriman lain, 0 tulis berkas, keluar 0', async () => {
    const s = validateServer();
    const { fsx, writes, appended } = memFs({ 'a.md': MD({ basis: null }) });
    const r = await run(['check', 'a.md', '--remote', 'http://h', '--json'], { fetch: s.f, fs: fsx });
    expect(r.code).toBe(0);
    const posts = s.calls.filter((c) => c.method === 'POST');
    expect(posts.length).toBe(6); // record + 5 bab, semuanya dry-run
    expect(posts.every((c) => c.path === '/api/studio/validate')).toBe(true);
    expect(s.calls.filter((c) => c.method !== 'POST' && c.method !== 'GET')).toHaveLength(0);
    expect([...writes, ...appended]).toEqual([]);
    const j = JSON.parse(r.out);
    expect(j).toMatchObject({ ok: true, command: 'check', format: 'md', mode: 'create', exitCode: 0, issues: [] });
    expect(r.out).not.toContain(SECRET);
    // Baris basis -> mode update (target documentId), GET R05 untuk DR-08 (basis rev8 < rev9 = peringatan).
    const u = validateServer();
    const ru = await run(['check', 'a.md', '--remote', 'http://h', '--json'], { fetch: u.f, fs: memFs({ 'a.md': MD() }).fsx });
    expect(ru.code).toBe(0);
    expect(u.calls.filter((c) => c.method === 'POST').every((c) => c.path === '/api/studio/validate' && (c.body as { target: unknown }).target !== undefined)).toBe(true);
    expect((u.calls.find((c) => c.method === 'POST')?.body as { target: unknown }).target).toEqual({ documentId: DOC });
    const ju = JSON.parse(ru.out);
    expect(ju).toMatchObject({ mode: 'update', documentId: DOC });
    expect(ju.notices.join('\n')).toContain('DRAFT_BASIS_STALE');
  });

  it('isu dry-run -> keluar 1 dengan isu per bagian; templat belum diisi -> keluar 1 tanpa panggilan; tanpa --remote -> tanpa jaringan; 401 -> keluar 2', async () => {
    const bad = validateServer({ invalidChapter: '3' });
    const r = await run(['check', 'a.md', '--remote', 'http://h'], { fetch: bad.f, fs: memFs({ 'a.md': MD({ basis: null }) }).fsx });
    expect(r.code).toBe(1);
    expect(r.out).toContain('isu bab 3: /chapter/sections/0 CHAPTER_INVALID');
    const t = await run(['check', 't.md', '--remote', 'http://h'], { fetch: validateServer().f, fs: memFs({ 't.md': reportTemplate({ format: 'md', mission: MISSION, docKey: DOC_KEY }) }).fsx });
    expect(t.code).toBe(1);
    expect(t.err).toContain('TEMPLATE_PLACEHOLDER');
    const local = await run(['check', 'a.md'], { fs: memFs({ 'a.md': MD({ basis: null }) }).fsx }); // fetch bawaan run() melempar bila dipanggil
    expect(local.code).toBe(0);
    expect(local.out).toContain('dry-run R08: tidak dijalankan');
    const unauth = await run(['check', 'a.md', '--remote', 'http://h'], { fetch: validateServer({ status: 401 }).f, fs: memFs({ 'a.md': MD({ basis: null }) }).fsx });
    expect(unauth.code).toBe(2);
    expect((await run(['check', 'a.md', '--out', 'x'])).code).toBe(2);
  });
});
