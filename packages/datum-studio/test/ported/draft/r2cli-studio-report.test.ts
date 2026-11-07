// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/draft/r2cli-studio-report.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
// R2-01 / U-01 (D-419): CLI `scripts/studio/studio-report.ts submit|update`. Klien HTTP di-mock
// (server tiruan per route), fs di-mock/di-spy: badan kiriman hanya di memori (nol tulis berkas
// tanpa --out/--timing), timing CSV 20 kolom RFC 4180, galat code + cid + pointer, kode keluar.
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from '../_vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  csvField,
  main,
  parseCsv,
  sameContent,
  TIMING_HEADER,
  type FsLike,
  type HttpFetch,
} from '../../../vendor/scripts/studio/studio-report';

const SECRET = 'rahasia-uji-r2cli-report-jangan-tercetak';
const DOC = 'cmvvdoc0000000000000000001';
const FILE = 'cmvvfile000000000000000001';
const MISSION = { folder: '2026-10-31_r2cli' };
const HTML = Buffer.from('<html><body>laporan</body></html>', 'utf8');
const SHA = createHash('sha256').update(HTML).digest('hex');
const FINAL = `014-GSP-LAP-X-2026_rev6_20261031T053451Z_${SHA.slice(0, 8)}.html`;

const record = (status: string) => ({
  $schema: 'studio.slot/v2',
  target: { mission: MISSION, docKey: 'lap-a' },
  template: { slug: 'laporan-kerja-agen' },
  meta: { title: 'Laporan uji' },
  slot: 'record',
  payload: { type: 'contractRecord', status, reportedAt: '2026-10-31' },
});
const chapter = (key: string, text = 'Isi.') => ({
  $schema: 'studio.chapter/v2',
  agentId: 'pemilik-bab',
  target: { mission: MISSION, docKey: 'lap-a' },
  chapter: { key, title: { text: `Bab ${key}` }, sections: [{ title: { text: 'S' }, blocks: [{ type: 'paragraph', text }] }] },
});
function draftOf(blocks: unknown[]): string {
  return `# DRAF\ntujuan: t\nlangkah-berikut: l\nbasis: baru\n\n${blocks.map((b) => `\`\`\`json\n${JSON.stringify(b)}\n\`\`\`\n`).join('\n')}`;
}
const FULL = draftOf([record('partial'), ...['1', '2', '3', '4', '5'].map((k) => chapter(k))]);

interface Call {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
  redirect: string;
}
type Handler = (c: Call) => { status: number; body?: unknown; bytes?: Buffer; headers?: Record<string, string> } | undefined;

/** Server tiruan: urutan revisi naik per kiriman; override per route lewat `over`. */
function fakeServer(opts: { completeness?: string; over?: Handler; sha?: string; verified?: string } = {}) {
  const calls: Call[] = [];
  let rev = 0;
  const f: HttpFetch = async (url, init) => {
    const u = new URL(url);
    const call: Call = { method: init.method, path: u.pathname + u.search, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined, redirect: init.redirect };
    calls.push(call);
    const res = opts.over?.(call) ?? route(call);
    const h = new Map(Object.entries({ 'x-correlation-id': `cid-${calls.length}`, ...(res.headers ?? {}) }).map(([k, v]) => [k.toLowerCase(), v]));
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
  function route(c: Call): { status: number; body?: unknown; bytes?: Buffer; headers?: Record<string, string> } {
    if (c.method === 'POST' && (c.path === '/api/studio/slots' || c.path === '/api/studio/chapters')) {
      rev++;
      return { status: 201, body: { document: { id: DOC, docNumber: '014/GSP/LAP/X/2026' }, created: rev === 1, unchanged: false, revision: { revisionNo: rev } } };
    }
    if (c.method === 'GET' && c.path === `/api/studio/documents/${DOC}/completeness`) {
      return { status: 200, body: { documentId: DOC, completeness: { status: opts.completeness ?? 'COMPLETE', missingRequired: opts.completeness === 'INCOMPLETE' ? ['content:5'] : [] } } };
    }
    if (c.method === 'POST' && c.path === `/api/studio/documents/${DOC}/render`) {
      return { status: 200, body: { job: { revisionNo: rev }, outputs: [{ id: FILE, role: 'PRIMARY', format: 'HTML', scope: { kind: 'DOCUMENT' }, sha256: SHA, finalFileName: FINAL }] } };
    }
    if (c.method === 'GET' && c.path === `/api/studio/files/${FILE}`) {
      return { status: 200, bytes: HTML, headers: { 'x-studio-final-filename': FINAL, 'x-studio-sha256': opts.sha ?? SHA } };
    }
    if (c.method === 'HEAD' && c.path === `/api/studio/files/${FILE}?verify=1`) {
      return { status: 200, headers: { 'x-studio-final-filename': FINAL, 'x-studio-sha256-verified': opts.verified ?? 'true' } };
    }
    return { status: 404, body: { error: 'not found', code: 'NOT_FOUND' } };
  }
  return { f, calls };
}

/** fs tiruan: draf dibaca dari peta; semua tulis dicatat. */
function memFs(files: Record<string, string>) {
  const writes: Array<{ op: string; path: string; data?: string }> = [];
  const store = new Map(Object.entries(files));
  const fsx: FsLike = {
    existsSync: (p) => store.has(p),
    readFileSync: (p) => {
      const v = store.get(p);
      if (v === undefined) throw Object.assign(new Error(`ENOENT ${p}`), { code: 'ENOENT' });
      return v;
    },
    readFileSyncBuffer: (p) => Buffer.from(fsx.readFileSync(p, 'utf8'), 'utf8'),
    appendFileSync: (p, d) => {
      writes.push({ op: 'append', path: p, data: d });
      store.set(p, (store.get(p) ?? '') + d);
    },
    mkdirSync: (p) => {
      writes.push({ op: 'mkdir', path: p });
    },
    writeFileSync: (p, d) => {
      writes.push({ op: 'write', path: p, data: Buffer.from(d).toString('utf8') });
      store.set(p, Buffer.from(d).toString('utf8'));
    },
  };
  return { fsx, writes, store };
}

async function run(argv: string[], o: { fetch: HttpFetch; fs?: FsLike; env?: Record<string, string> }) {
  let out = '';
  let err = '';
  let t = 1_793_424_000_000;
  const code = await main(argv, {
    stdout: (s) => (out += s),
    stderr: (s) => (err += s),
    env: { INTERNAL_API_SECRET: SECRET, ...(o.env ?? {}) },
    fetchImpl: o.fetch,
    fs: o.fs,
    now: () => (t += 25),
  });
  return { code, out, err };
}

describe('submit', () => {
  it('urutan R13 -> R12 x5 -> R15 -> R17 -> R10 -> HEAD verify; target bab = documentId baru; agentId bawaan; tanpa redirect', async () => {
    const { f, calls } = fakeServer();
    const { fsx, writes } = memFs({ 'd.md': FULL });
    const r = await run(['submit', 'd.md', '--remote', 'http://127.0.0.1:9021', '--agent-id', 'cod-r2-01'], { fetch: f, fs: fsx });
    expect(r.code).toBe(0);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'POST /api/studio/slots',
      ...Array(5).fill('POST /api/studio/chapters'),
      `GET /api/studio/documents/${DOC}/completeness`,
      `POST /api/studio/documents/${DOC}/render`,
      `GET /api/studio/files/${FILE}`,
      `HEAD /api/studio/files/${FILE}?verify=1`,
    ]);
    expect(calls.every((c) => c.headers['x-internal-secret'] === SECRET && c.redirect === 'manual')).toBe(true);
    const first = calls[0].body as Record<string, unknown>;
    expect(first.target).toEqual({ mission: MISSION, docKey: 'lap-a' });
    expect(first.agentId).toBe('cod-r2-01');
    const ch = calls[1].body as Record<string, unknown>;
    expect(ch.target).toEqual({ documentId: DOC });
    expect(ch.agentId).toBe('pemilik-bab'); // medan blok menang
    expect(calls[7].body).toEqual({ agentId: 'cod-r2-01', scope: 'document' });
    expect(r.out).toContain(`documentId: ${DOC}`);
    expect(r.out).toContain('revisionNo: 6');
    expect(r.out).toContain(`sha16: ${SHA.slice(0, 16)}`);
    expect(r.out).toContain(`nama final: ${FINAL}`);
    expect(r.out).toContain('kelengkapan: COMPLETE');
    expect(writes).toEqual([]); // nol penulisan berkas tanpa --out/--timing
    expect(r.out + r.err).not.toContain(SECRET);
  });

  it('--mission mengganti folder target blok buat; --json keluaran mesin', async () => {
    const { f, calls } = fakeServer();
    const { fsx } = memFs({ 'd.md': FULL });
    const r = await run(['submit', 'd.md', '--remote', 'http://h', '--mission', 'misi-lain', '--json'], { fetch: f, fs: fsx });
    expect(r.code).toBe(0);
    expect((calls[0].body as { target: unknown }).target).toEqual({ mission: { folder: 'misi-lain' }, docKey: 'lap-a' });
    const j = JSON.parse(r.out);
    expect(j).toMatchObject({ ok: true, command: 'submit', documentId: DOC, revisionNo: 6, completeness: { status: 'COMPLETE' }, render: { finalFileName: FINAL, sha16: SHA.slice(0, 16), verified: true, savedTo: null } });
    expect(j.steps).toHaveLength(6);
  });

  it('--out menyimpan satu berkas final bernama header; --timing menambah header + baris 20 kolom (RFC 4180)', async () => {
    const { f } = fakeServer();
    const { fsx, writes, store } = memFs({ 'draf,uji "x".md': FULL });
    const r = await run(['submit', 'draf,uji "x".md', '--remote', 'http://h', '--out', 'keluar', '--timing', 't.csv', '--step', 'S1'], {
      fetch: f,
      fs: fsx,
      env: { STUDIO_TIMING_RUN_ID: 'R1B', STUDIO_TIMING_SESSION_ID: 's-1' },
    });
    expect(r.code).toBe(0);
    expect(writes.map((w) => `${w.op} ${w.path}`)).toEqual(['mkdir keluar', `write ${path.join('keluar', FINAL)}`, 'append t.csv']);
    expect(writes[1].data).toBe(HTML.toString('utf8'));
    const rows = parseCsv(store.get('t.csv') as string);
    expect(rows[0]).toEqual([...TIMING_HEADER]);
    expect(rows.slice(1).every((row) => row.length === 20)).toBe(true);
    expect(rows.slice(1).map((row) => row[5])).toEqual(rows.slice(1).map((_, i) => String(i + 1)));
    const tool = rows[rows.length - 1];
    expect(tool.slice(0, 9)).toEqual(['R1B', 'B', '-', '', 's-1', String(rows.length - 1), 'S1', 'tool', 'studio-report submit']);
    expect(tool[19]).toBe('draf,uji "x".md'); // koma + kutip selamat lewat RFC 4180
    expect(store.get('t.csv')).toContain('"draf,uji ""x"".md"');
    const dl = rows.find((row) => row[8] === 'GET /api/studio/files/{id}') as string[];
    expect(dl[17]).toBe(String(HTML.length));
    expect(dl[18]).toBe(SHA.slice(0, 16));
    expect(rows.find((row) => row[8] === 'POST /api/studio/slots')?.[11]).toBe('cid-1');
    expect(store.get('t.csv')).not.toContain(SECRET);
  });

  it('--timing kedua: seq melanjutkan run_id yang sama, header tidak diulang; header asing ditolak sebelum kiriman', async () => {
    const { fsx, store } = memFs({ 'd.md': FULL });
    await run(['submit', 'd.md', '--remote', 'http://h', '--timing', 't.csv'], { fetch: fakeServer().f, fs: fsx, env: { STUDIO_TIMING_RUN_ID: 'R9' } });
    const n = parseCsv(store.get('t.csv') as string).length - 1;
    await run(['submit', 'd.md', '--remote', 'http://h', '--timing', 't.csv'], { fetch: fakeServer().f, fs: fsx, env: { STUDIO_TIMING_RUN_ID: 'R9' } });
    const rows = parseCsv(store.get('t.csv') as string);
    expect(rows.filter((row) => row[0] === 'run_id')).toHaveLength(1);
    expect(rows[n + 1][5]).toBe(String(n + 1));
    const bad = memFs({ 'd.md': FULL, 'x.csv': 'a,b\n' });
    const s = fakeServer();
    const r = await run(['submit', 'd.md', '--remote', 'http://h', '--timing', 'x.csv'], { fetch: s.f, fs: bad.fsx });
    expect(r.code).toBe(2);
    expect(r.err).toContain('TIMING_HEADER_MISMATCH');
    expect(s.calls).toHaveLength(0);
    expect(bad.writes).toEqual([]);
  });

  it('INCOMPLETE: tanpa --require-complete render dilewati (rc 0); dengan --require-complete rc 3', async () => {
    const a = fakeServer({ completeness: 'INCOMPLETE' });
    const r = await run(['submit', 'd.md', '--remote', 'http://h'], { fetch: a.f, fs: memFs({ 'd.md': FULL }).fsx });
    expect(r.code).toBe(0);
    expect(r.out).toContain('render penuh dilewati');
    expect(a.calls.some((c) => c.path.endsWith('/render'))).toBe(false);
    const b = fakeServer({ completeness: 'INCOMPLETE' });
    const r3 = await run(['submit', 'd.md', '--remote', 'http://h', '--require-complete', '--json'], { fetch: b.f, fs: memFs({ 'd.md': FULL }).fsx });
    expect(r3.code).toBe(3);
    expect(JSON.parse(r3.out)).toMatchObject({ ok: false, exitCode: 3, fatal: { code: 'DOCUMENT_INCOMPLETE' } });
  });
});

describe('galat', () => {
  it('400 SCHEMA_INVALID pada bab: rc 1, stderr memuat code + x-correlation-id + pointer; --json fatal', async () => {
    const over: Handler = (c) =>
      c.path === '/api/studio/chapters' && (c.body as { chapter: { key: string } }).chapter.key === '3'
        ? { status: 400, body: { error: 'Request does not match', code: 'SCHEMA_INVALID', details: [{ pointer: '/chapter/sections/0/blocks/0/items', keyword: 'type', message: 'must be array' }] }, headers: { 'x-correlation-id': 'cid-bab3' } }
        : undefined;
    const r = await run(['submit', 'd.md', '--remote', 'http://h', '--json'], { fetch: fakeServer({ over }).f, fs: memFs({ 'd.md': FULL }).fsx });
    expect(r.code).toBe(1);
    expect(r.err).toContain('SCHEMA_INVALID');
    expect(r.err).toContain('x-correlation-id: cid-bab3');
    expect(r.err).toContain('pointer: /chapter/sections/0/blocks/0/items');
    expect(r.err).toContain('blok 4 (bab 3)');
    expect(JSON.parse(r.out)).toMatchObject({ ok: false, exitCode: 1, fatal: { code: 'SCHEMA_INVALID', httpStatus: 400, correlationId: 'cid-bab3', pointer: '/chapter/sections/0/blocks/0/items' } });
  });

  it('401 / 5xx / 3xx / jaringan / rahasia kosong / argumen: rc 2 tanpa mencetak rahasia', async () => {
    const at = (status: number, headers: Record<string, string> = {}): Handler => () => ({ status, body: { error: 'x', code: status === 401 ? 'UNAUTHORIZED' : 'INTERNAL' }, headers });
    for (const over of [at(401), at(500), at(302, { location: 'http://evil' })]) {
      const r = await run(['submit', 'd.md', '--remote', 'http://h'], { fetch: fakeServer({ over }).f, fs: memFs({ 'd.md': FULL }).fsx });
      expect(r.code).toBe(2);
      expect(r.out + r.err).not.toContain(SECRET);
    }
    const down: HttpFetch = async () => {
      throw new Error('ECONNREFUSED');
    };
    expect((await run(['submit', 'd.md', '--remote', 'http://h'], { fetch: down, fs: memFs({ 'd.md': FULL }).fsx })).err).toContain('REMOTE_UNREACHABLE');
    const noSecret = await run(['submit', 'd.md', '--remote', 'http://h', '--json'], { fetch: down, fs: memFs({ 'd.md': FULL }).fsx, env: { INTERNAL_API_SECRET: '' } });
    expect(noSecret.code).toBe(2);
    expect(JSON.parse(noSecret.out).fatal.code).toBe('SECRET_MISSING');
    const usage = await run(['kirim', 'd.md', '--json'], { fetch: down });
    expect(usage.code).toBe(2);
    expect(JSON.parse(usage.out).fatal.code).toBe('USAGE_ERROR');
    expect((await run(['submit', 'd.md'], { fetch: down, fs: memFs({ 'd.md': FULL }).fsx })).err).toContain('HQ_URL');
  });

  it('draf tidak lolos cek lokal: rc 1 tanpa panggilan jaringan', async () => {
    const bad = draftOf([{ ...record('selesai') }]);
    const s = fakeServer();
    const r = await run(['submit', 'd.md', '--remote', 'http://h'], { fetch: s.f, fs: memFs({ 'd.md': bad }).fsx });
    expect(r.code).toBe(1);
    expect(r.err).toContain('cek lokal');
    expect(s.calls).toHaveLength(0);
  });

  it('sha256 unduhan tidak cocok atau verify false: rc 1', async () => {
    expect((await run(['submit', 'd.md', '--remote', 'http://h'], { fetch: fakeServer({ sha: 'f'.repeat(64) }).f, fs: memFs({ 'd.md': FULL }).fsx })).code).toBe(1);
    const v = await run(['submit', 'd.md', '--remote', 'http://h'], { fetch: fakeServer({ verified: 'false' }).f, fs: memFs({ 'd.md': FULL }).fsx });
    expect(v.code).toBe(1);
    expect(v.err).toContain('VERIFY_FAILED');
  });
});

describe('update', () => {
  const BASE = {
    document: { id: DOC, docNumber: '014/GSP/LAP/X/2026' },
    revisionNo: 6,
    content: {
      sections: {
        record: { reportedAt: '2026-10-31', status: 'partial', type: 'contractRecord' },
        content: { type: 'chapter', chapters: ['1', '2', '3', '4', '5'].map((k) => ({ ...chapter(k).chapter, id: `bab-${k}`, sections: [{ id: 'p-s', title: { text: 'S' }, blocks: [{ id: `p-${k}`, type: 'paragraph', text: 'Isi.' }] }] })) },
      },
    },
  };
  const baseOver: Handler = (c) => (c.method === 'GET' && c.path === `/api/studio/documents/${DOC}/content` ? { status: 200, body: BASE } : undefined);

  it('basis R20, baseRevisionNo otomatis, target documentId; hanya record yang berubah dikirim', async () => {
    const { f, calls } = fakeServer({ over: baseOver });
    const { fsx, writes } = memFs({ 'u.md': draftOf([record('complete'), ...['1', '2', '3', '4', '5'].map((k) => chapter(k))]) });
    const r = await run(['update', DOC, 'u.md', '--remote', 'http://h', '--json'], { fetch: f, fs: fsx });
    expect(r.code).toBe(0);
    const posts = calls.filter((c) => c.method === 'POST' && !c.path.endsWith('/render'));
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toMatchObject({ target: { documentId: DOC }, baseRevisionNo: 6, payload: { status: 'complete' } });
    const j = JSON.parse(r.out);
    expect(j.steps.filter((s: { skipped: boolean }) => s.skipped)).toHaveLength(5);
    expect(j.render.verified).toBe(true);
    expect(writes).toEqual([]);
  });

  it('bab berubah dikirim; baseRevisionNo yang ditulis di blok dipertahankan; blok doc/v2 ditolak', async () => {
    const { f, calls } = fakeServer({ over: baseOver });
    const changed = { ...chapter('2', 'Isi baru.'), baseRevisionNo: 5 };
    const r = await run(['update', DOC, 'u.md', '--remote', 'http://h'], { fetch: f, fs: memFs({ 'u.md': draftOf([changed]) }).fsx });
    expect(r.code).toBe(0);
    const post = calls.find((c) => c.path === '/api/studio/chapters');
    expect(post?.body).toMatchObject({ target: { documentId: DOC }, baseRevisionNo: 5 });
    const doc = { $schema: 'studio.doc/v2', template: { slug: 'laporan-kerja-agen' }, mission: MISSION, meta: { title: 'X' } };
    const rd = await run(['update', DOC, 'u.md', '--remote', 'http://h'], { fetch: fakeServer({ over: baseOver }).f, fs: memFs({ 'u.md': draftOf([doc]) }).fsx });
    expect(rd.code).toBe(1);
    expect(rd.err).toContain('UPDATE_DOC_BLOCK_UNSUPPORTED');
  });
});

describe('nol penulisan berkas (fs nyata di-spy)', () => {
  let dir = '';
  let md = '';
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r2cli-sr-'));
    md = path.join(dir, 'draf.md');
    fs.writeFileSync(md, FULL);
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
  afterEach(() => vi.restoreAllMocks());

  it('submit + update tanpa --out/--timing: tidak ada writeFile/append/mkdir/mkdtemp/createWriteStream', async () => {
    const spies = (['writeFileSync', 'appendFileSync', 'mkdirSync', 'mkdtempSync', 'createWriteStream', 'writeFile', 'appendFile', 'copyFileSync', 'renameSync'] as const).map((k) => vi.spyOn(fs, k));
    const opens = vi.spyOn(fs, 'openSync');
    expect((await run(['submit', md, '--remote', 'http://h'], { fetch: fakeServer().f })).code).toBe(0);
    const baseOver: Handler = (c) => (c.path === `/api/studio/documents/${DOC}/content` ? { status: 200, body: { document: { id: DOC }, revisionNo: 6, content: { sections: {} } } } : undefined);
    expect((await run(['update', DOC, md, '--remote', 'http://h'], { fetch: fakeServer({ over: baseOver }).f })).code).toBe(0);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    // Satu-satunya berkas yang dibuka adalah draf, baca saja.
    // row42 W7: Node's fs.readFileSync goes through the exported fs.openSync (two read opens of the
    // draft); Bun's native readFileSync does not. Same intent: no open other than a read of the draft.
    expect(opens.mock.calls.filter((c) => !(String(c[0]) === md && c[1] === 'r'))).toEqual([]);
  });
});

describe('utilitas', () => {
  it('csvField RFC 4180 dan parseCsv pulang-pergi', () => {
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('kata "kutip"')).toBe('"kata ""kutip"""');
    expect(csvField('baris\nbaru')).toBe('"baris\nbaru"');
    expect(csvField(undefined)).toBe('');
    expect(csvField(1.5)).toBe('1.5');
    const line = ['x', 'a,b', 'kata "kutip"', 'baris\nbaru', ''].map(csvField).join(',');
    expect(parseCsv(`${line}\n`)).toEqual([['x', 'a,b', 'kata "kutip"', 'baris\nbaru', '']]);
  });

  it('sameContent mengabaikan urutan kunci dan medan id', () => {
    expect(sameContent({ a: 1, b: [{ id: 'p-1', t: 'x' }] }, { b: [{ t: 'x' }], a: 1 })).toBe(true);
    expect(sameContent({ a: 1 }, { a: 2 })).toBe(false);
    expect(sameContent([1, 2], [2, 1])).toBe(false);
  });
});
