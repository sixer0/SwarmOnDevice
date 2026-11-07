// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/draft/r2fix-cli.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
// R2-F2 (D-425, D-426; review 14 #5, #6, #8, #9): CLI studio-report + draft-check.
// #5 kiriman terputus melaporkan documentId + revisionNo terakhir + langkah gagal (teks dan --json),
//    kode keluar penyebab tetap, kirim ulang idempoten; #6 klien HTTP bersama (peta galat, cid,
//    timeout, kebijakan redirect per CLI dipertahankan); #8 sel CSV formula dinetralkan; #9 --out
//    hanya untuk nama yang lolos FINAL_FILENAME_PATTERN; D-427 penjaga target contoh registri.
import { describe, it, expect } from '../_vitest';
import { createHash } from 'node:crypto';
import { csvField, csvNeutralize, main, parseCsv, registryExampleTargets, safeFinalName, type FsLike, type HttpFetch } from '../../../vendor/scripts/studio/studio-report';
import { CONTRACT_KIND_DEFS } from '../../../vendor/src/lib/studio/registry/contracts';
import { main as draftCheckMain, type FetchLike } from '../../../vendor/scripts/studio/draft-check';
import { httpFailureOf, STUDIO_HTTP_TIMEOUT_MS, studioRequest, type HttpReply } from '../../../vendor/scripts/studio/_http-client';

const SECRET = 'rahasia-uji-r2fix-jangan-tercetak';
const DOC = 'cmvvdoc0000000000000000002';
const FILE = 'cmvvfile000000000000000002';
const MISSION = { folder: '2026-10-31_r2_f2' };
const HTML = Buffer.from('<html><body>r2fix</body></html>', 'utf8');
const SHA = createHash('sha256').update(HTML).digest('hex');
const FINAL = `017-GSP-LAP-X-2026_rev6_20261031T053451Z_${SHA.slice(0, 8)}.html`;

const record = () => ({
  $schema: 'studio.slot/v2',
  agentId: 'cod-r2-f2',
  target: { mission: MISSION, docKey: 'r2fix' },
  template: { slug: 'laporan-kerja-agen' },
  meta: { title: 'Laporan uji R2-F2' },
  slot: 'record',
  payload: { type: 'contractRecord', status: 'partial', reportedAt: '2026-10-31' },
});
const chapter = (key: string) => ({
  $schema: 'studio.chapter/v2',
  agentId: 'cod-r2-f2',
  target: { mission: MISSION, docKey: 'r2fix' },
  chapter: { key, title: { text: `Bab ${key}` }, sections: [{ title: { text: 'S' }, blocks: [{ type: 'paragraph', text: 'Isi.' }] }] },
});
const draftOf = (blocks: unknown[]) => `# DRAF\ntujuan: t\nlangkah-berikut: l\nbasis: baru\n\n${blocks.map((b) => `\`\`\`json\n${JSON.stringify(b)}\n\`\`\`\n`).join('\n')}`;
const FULL = draftOf([record(), ...['1', '2', '3', '4', '5'].map(chapter)]);

interface Call {
  method: string;
  path: string;
  body: Record<string, unknown> | undefined;
  redirect: string;
}
type Reply = { status: number; body?: unknown; bytes?: Buffer; headers?: Record<string, string> };

/**
 * Server tiruan dengan status per kunci misi+docKey (idempoten seperti server: kiriman isi sama =
 * `unchanged`); `fail(call)` mengembalikan jawaban galat untuk menyuntik kegagalan di tengah.
 */
function fakeServer(opts: { fail?: (c: Call) => Reply | undefined; finalName?: string } = {}) {
  const calls: Call[] = [];
  const stored = new Map<string, string>();
  let rev = 0;
  const f: HttpFetch = async (url, init) => {
    const u = new URL(url);
    const call: Call = { method: init.method, path: u.pathname + u.search, body: init.body ? JSON.parse(init.body) : undefined, redirect: init.redirect };
    calls.push(call);
    const res = opts.fail?.(call) ?? route(call);
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
  function route(c: Call): Reply {
    if (c.method === 'POST' && (c.path === '/api/studio/slots' || c.path === '/api/studio/chapters')) {
      const b = c.body ?? {};
      const key = String(b.slot ?? (b.chapter as { key?: string } | undefined)?.key);
      const content = JSON.stringify(b.payload ?? b.chapter);
      const created = rev === 0;
      const unchanged = stored.get(key) === content;
      if (!unchanged) {
        rev++;
        stored.set(key, content);
      }
      return { status: 201, body: { document: { id: DOC, docNumber: '017/GSP/LAP/X/2026' }, created, unchanged, revision: { revisionNo: rev } } };
    }
    if (c.method === 'GET' && c.path === `/api/studio/documents/${DOC}/completeness`) {
      return { status: 200, body: { documentId: DOC, completeness: { status: 'COMPLETE', missingRequired: [], revisionNo: rev } } };
    }
    if (c.method === 'POST' && c.path === `/api/studio/documents/${DOC}/render`) {
      return { status: 200, body: { job: { revisionNo: rev }, outputs: [{ id: FILE, role: 'PRIMARY', format: 'HTML', scope: { kind: 'DOCUMENT' }, sha256: SHA, finalFileName: opts.finalName ?? FINAL }] } };
    }
    if (c.method === 'GET' && c.path === `/api/studio/files/${FILE}`) {
      return { status: 200, bytes: HTML, headers: { 'x-studio-final-filename': opts.finalName ?? FINAL, 'x-studio-sha256': SHA } };
    }
    if (c.method === 'HEAD' && c.path === `/api/studio/files/${FILE}?verify=1`) {
      return { status: 200, headers: { 'x-studio-final-filename': opts.finalName ?? FINAL, 'x-studio-sha256-verified': 'true' } };
    }
    return { status: 404, body: { error: 'not found', code: 'NOT_FOUND' } };
  }
  return { f, calls };
}

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

async function run(argv: string[], o: { fetch: HttpFetch; fs: FsLike; env?: Record<string, string> }) {
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

const isChapter = (k: string) => (c: Call) => c.method === 'POST' && c.path === '/api/studio/chapters' && (c.body?.chapter as { key?: string } | undefined)?.key === k;

describe('#5 kiriman terputus melaporkan kemajuan', () => {
  it('bab 3 ditolak 400 sesudah record + bab 1-2 tersimpan: rc 1, stderr + fatal.progress memuat documentId, revisionNo, langkah', async () => {
    const s = fakeServer({ fail: (c) => (isChapter('3')(c) ? { status: 400, body: { error: 'BY_CONSTRUCTION_FAILED: daftar kosong', code: 'BY_CONSTRUCTION_FAILED', details: [{ pointer: '/chapter/sections/0' }] } } : undefined) });
    const r = await run(['submit', 'd.md', '--remote', 'http://h', '--json'], { fetch: s.f, fs: memFs({ 'd.md': FULL }).fsx });
    expect(r.code).toBe(1);
    expect(r.err).toContain(`dokumen: ${DOC} (017/GSP/LAP/X/2026), revisionNo terakhir: 3`);
    expect(r.err).toContain('sudah tersimpan: blok 1 (record), blok 2 (bab 1), blok 3 (bab 2)');
    expect(r.err).toContain('langkah gagal: blok 4 (bab 3)');
    expect(r.err).toContain(`update ${DOC} d.md`);
    expect(r.err).toContain('x-correlation-id: cid-4');
    const j = JSON.parse(r.out);
    expect(j).toMatchObject({
      ok: false,
      exitCode: 1,
      fatal: {
        code: 'BY_CONSTRUCTION_FAILED',
        httpStatus: 400,
        correlationId: 'cid-4',
        step: 'blok 4 (bab 3)',
        details: [{ pointer: '/chapter/sections/0' }],
        progress: {
          documentId: DOC,
          docNumber: '017/GSP/LAP/X/2026',
          revisionNo: 3,
          completedSteps: ['blok 1 (record)', 'blok 2 (bab 1)', 'blok 3 (bab 2)'],
          failedStep: 'blok 4 (bab 3)',
          allBlocksSent: false,
        },
      },
    });
    expect(r.out + r.err).not.toContain(SECRET);
  });

  it('galat lingkungan di tengah (503) tetap rc 2 dengan progress; kirim ulang idempoten menuntaskan dokumen yang sama', async () => {
    let down = true;
    const s = fakeServer({ fail: (c) => (down && isChapter('2')(c) ? { status: 503, body: { error: 'sibuk', code: 'SERVICE_UNAVAILABLE' } } : undefined) });
    const fsx = memFs({ 'd.md': FULL }).fsx;
    const r1 = await run(['submit', 'd.md', '--remote', 'http://h', '--json'], { fetch: s.f, fs: fsx });
    expect(r1.code).toBe(2);
    expect(JSON.parse(r1.out).fatal).toMatchObject({ code: 'SERVICE_UNAVAILABLE', progress: { documentId: DOC, revisionNo: 2, failedStep: 'blok 3 (bab 2)' } });
    down = false;
    const r2 = await run(['submit', 'd.md', '--remote', 'http://h', '--json'], { fetch: s.f, fs: fsx });
    expect(r2.code).toBe(0);
    const ok = JSON.parse(r2.out);
    expect(ok.documentId).toBe(DOC);
    expect(ok.steps.slice(0, 2).map((x: { unchanged: boolean }) => x.unchanged)).toEqual([true, true]);
    expect(ok.steps.slice(2).every((x: { unchanged: boolean }) => !x.unchanged)).toBe(true);
    expect(ok.revisionNo).toBe(6);
  });

  it('kegagalan blok pertama: tanpa progress (belum ada yang tersimpan)', async () => {
    const s = fakeServer({ fail: (c) => (c.path === '/api/studio/slots' ? { status: 409, body: { error: 'konflik', code: 'META_CONFLICT' } } : undefined) });
    const r = await run(['submit', 'd.md', '--remote', 'http://h', '--json'], { fetch: s.f, fs: memFs({ 'd.md': FULL }).fsx });
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out).fatal.progress).toBeUndefined();
    expect(r.err).not.toContain('sudah tersimpan');
  });

  it('galat sesudah semua blok terkirim (render 500): rc 2, progress.allBlocksSent true', async () => {
    const s = fakeServer({ fail: (c) => (c.path.endsWith('/render') ? { status: 500, body: { error: 'gagal render', code: 'RENDER_FAILED' } } : undefined) });
    const r = await run(['submit', 'd.md', '--remote', 'http://h', '--json'], { fetch: s.f, fs: memFs({ 'd.md': FULL }).fsx });
    expect(r.code).toBe(2);
    expect(JSON.parse(r.out).fatal.progress).toMatchObject({ documentId: DOC, revisionNo: 6, failedStep: 'render R17', allBlocksSent: true });
    expect(JSON.parse(r.out).fatal.progress.completedSteps).toHaveLength(6);
  });
});

describe('#6 klien HTTP bersama', () => {
  const reply = (status: number, body: unknown, headers: Record<string, string> = {}): HttpReply => {
    const h = new Map(Object.entries(headers));
    const b = body as { code?: string } | null;
    return { status, ok: false, headers: { get: (n) => h.get(n) ?? null }, body, correlationId: headers['x-correlation-id'], serverCode: b?.code };
  };

  it('peta galat seragam: 3xx/401/429/5xx lingkungan, 4xx lain isi; code server + cid', () => {
    expect(httpFailureOf(reply(307, null), 'GET /x')).toMatchObject({ code: 'REMOTE_REDIRECT', environmental: true });
    expect(httpFailureOf(reply(401, null), 'GET /x')).toMatchObject({ code: 'REMOTE_UNAUTHORIZED', environmental: true });
    expect(httpFailureOf(reply(429, { code: 'RATE_LIMITED' }, { 'retry-after': '7' }), 'GET /x')).toMatchObject({ code: 'RATE_LIMITED', retryAfter: '7', environmental: true });
    expect(httpFailureOf(reply(502, null), 'GET /x')).toMatchObject({ code: 'HTTP_502', environmental: true });
    expect(httpFailureOf(reply(400, { error: 'e', code: 'SCHEMA_INVALID', details: [1] }, { 'x-correlation-id': 'c1' }), 'GET /x')).toMatchObject({
      code: 'SCHEMA_INVALID',
      serverCode: 'SCHEMA_INVALID',
      correlationId: 'c1',
      details: [1],
      environmental: false,
      message: 'e',
    });
    expect(STUDIO_HTTP_TIMEOUT_MS).toBe(60_000);
  });

  it('rahasia hanya di header; cid cadangan dari badan; kegagalan transport -> REMOTE_UNREACHABLE', async () => {
    let seen: Parameters<HttpFetch>[1] | undefined;
    const r = await studioRequest({ baseUrl: 'http://h', secret: SECRET, redirect: 'manual', fetchImpl: async (_u, init) => {
      seen = init;
      return { status: 400, headers: { get: () => null }, text: async () => JSON.stringify({ error: 'x', code: 'C', correlationId: 'cid-badan' }) };
    } }, 'POST', '/api/studio/validate', { body: '{}' });
    expect(seen?.headers['x-internal-secret']).toBe(SECRET);
    expect(seen?.redirect).toBe('manual');
    expect(r).toMatchObject({ ok: false, serverCode: 'C', correlationId: 'cid-badan' });
    await expect(studioRequest({ baseUrl: 'http://h', secret: SECRET, redirect: 'follow', fetchImpl: async () => { throw new Error('ECONNREFUSED'); } }, 'GET', '/x')).rejects.toMatchObject({ code: 'REMOTE_UNREACHABLE' });
  });

  it('studio-report: redirect manual -> REMOTE_REDIRECT rc 2, tidak ada permintaan ke tujuan; 401 -> REMOTE_UNAUTHORIZED', async () => {
    const s = fakeServer({ fail: (c) => (c.path === '/api/studio/slots' ? { status: 307, headers: { location: 'http://evil/x' } } : undefined) });
    const r = await run(['submit', 'd.md', '--remote', 'http://h', '--json'], { fetch: s.f, fs: memFs({ 'd.md': FULL }).fsx });
    expect(r.code).toBe(2);
    expect(JSON.parse(r.out).fatal.code).toBe('REMOTE_REDIRECT');
    expect(s.calls).toHaveLength(1);
    expect(s.calls.every((c) => c.redirect === 'manual')).toBe(true);
    const u = fakeServer({ fail: () => ({ status: 401, body: { error: 'Unauthorized' } }) });
    const r401 = await run(['submit', 'd.md', '--remote', 'http://h', '--json'], { fetch: u.f, fs: memFs({ 'd.md': FULL }).fsx });
    expect(r401.code).toBe(2);
    expect(JSON.parse(r401.out).fatal.code).toBe('REMOTE_UNAUTHORIZED');
  });

  it('draft-check: perilaku redirect lama dipertahankan (follow, D-402 M-2); 401/5xx memakai peta bersama + details cid', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r2fix-dc-'));
    try {
      const md = path.join(dir, 'd.md');
      fs.writeFileSync(md, draftOf([record()]));
      const redirects: string[] = [];
      const at = (status: number): FetchLike => async (_u, init) => {
        redirects.push(init.redirect);
        return { status, headers: { get: (n) => (n === 'x-correlation-id' ? 'cid-dc' : null) }, text: async () => JSON.stringify({ error: 'x', code: 'SRV' }) };
      };
      for (const [status, code] of [[401, 'REMOTE_UNAUTHORIZED'], [503, 'REMOTE_ERROR']] as const) {
        let out = '';
        const rc = await draftCheckMain([md, '--remote', 'http://h', '--json'], { stdout: (s) => (out += s), stderr: () => {}, env: { INTERNAL_API_SECRET: SECRET }, fetchImpl: at(status) });
        expect(rc).toBe(2);
        expect(JSON.parse(out).fatal).toMatchObject({ code, details: { httpStatus: status, serverCode: 'SRV', correlationId: 'cid-dc' } });
        expect(out).not.toContain(SECRET);
      }
      expect(redirects.every((r) => r === 'follow')).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('#8 sel CSV formula dinetralkan', () => {
  it('awalan = + - @ tab CR diberi kutip tunggal; angka negatif dan penanda "-" tidak', () => {
    expect(csvField('=HYPERLINK("http://evil")')).toBe(`"'=HYPERLINK(""http://evil"")"`);
    expect(csvField('+1+1')).toBe("'+1+1");
    expect(csvField('-2+3')).toBe("'-2+3");
    expect(csvField('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvField('\tx')).toBe("'\tx");
    expect(csvField('\rx')).toBe(`"'\rx"`);
    expect(csvField('-')).toBe('-');
    expect(csvField('-1.5')).toBe('-1.5');
    expect(csvField('BY_CONSTRUCTION_FAILED')).toBe('BY_CONSTRUCTION_FAILED');
    expect(csvNeutralize('a=b')).toBe('a=b');
  });

  it('timing.csv: err_code dan corr_id dari server yang berawalan formula tertulis ternetralisasi; seq run_id tetap berlanjut', async () => {
    const evil = fakeServer({ fail: (c) => (c.path === '/api/studio/slots' ? { status: 400, body: { error: 'x', code: '=cmd|calc' }, headers: { 'x-correlation-id': '@evil' } } : undefined) });
    const m = memFs({ 'd.md': FULL });
    const env = { STUDIO_TIMING_RUN_ID: '=run' };
    await run(['submit', 'd.md', '--remote', 'http://h', '--timing', 't.csv'], { fetch: evil.f, fs: m.fsx, env });
    await run(['submit', 'd.md', '--remote', 'http://h', '--timing', 't.csv'], { fetch: evil.f, fs: m.fsx, env });
    const rows = parseCsv(m.store.get('t.csv') ?? '');
    const api = rows.filter((r) => r[7] === 'api');
    expect(api[0][16]).toBe("'=cmd|calc");
    expect(api[0][11]).toBe("'@evil");
    expect(rows.slice(1).every((r) => r[0] === "'=run")).toBe(true);
    expect(rows.slice(1).map((r) => r[5])).toEqual(['1', '2', '3', '4']);
  });
});

describe('#9 --out hanya nama FINAL_FILENAME_PATTERN', () => {
  it('safeFinalName = pola C51 + nama tunggal', () => {
    expect(safeFinalName(FINAL)).toBe(true);
    for (const bad of ['CON.html', '...', 'laporan.html', `../${FINAL}`, `${FINAL}.exe`, `sub/${FINAL}`]) expect(safeFinalName(bad)).toBe(false);
  });

  it('nama dari header tidak cocok -> OUT_NAME_UNSAFE rc 2, tidak ada berkas ditulis', async () => {
    const s = fakeServer({ finalName: 'CON.html' });
    const m = memFs({ 'd.md': FULL });
    const r = await run(['submit', 'd.md', '--remote', 'http://h', '--out', 'keluar', '--json'], { fetch: s.f, fs: m.fsx });
    expect(r.code).toBe(2);
    expect(JSON.parse(r.out).fatal).toMatchObject({ code: 'OUT_NAME_UNSAFE', step: 'simpan', progress: { documentId: DOC, allBlocksSent: true } });
    expect(r.err).toContain('pola nama final C51');
    expect(m.writes.filter((w) => w.op === 'write' || w.op === 'mkdir')).toEqual([]);
  });

  it('nama cocok -> disimpan', async () => {
    const m = memFs({ 'd.md': FULL });
    const r = await run(['submit', 'd.md', '--remote', 'http://h', '--out', 'keluar', '--json'], { fetch: fakeServer().f, fs: m.fsx });
    expect(r.code).toBe(0);
    expect(m.writes.filter((w) => w.op === 'write').map((w) => w.path.replace(/\\/g, '/'))).toEqual([`keluar/${FINAL}`]);
  });
});

describe('D-427 penjaga target contoh registri', () => {
  const ex = CONTRACT_KIND_DEFS[0].examples;
  const exTarget = ex.record.target as { mission: { folder: string }; docKey: string };
  const EXAMPLE = draftOf([ex.record, ...Object.values(ex.chapters)]);
  const withTarget = (target: unknown) => draftOf([{ ...ex.record, target }, ...Object.values(ex.chapters).map((c) => ({ ...c, target }))]);

  it('nilai dibaca dari CONTRACT_KIND_DEFS (bukan salinan)', () => {
    const t = registryExampleTargets();
    expect(t.folders.has(exTarget.mission.folder)).toBe(true);
    expect(t.docKeys.has(exTarget.docKey)).toBe(true);
  });

  it('draf contoh apa adanya: EXAMPLE_TARGET rc 2 tanpa satu pun panggilan jaringan', async () => {
    const s = fakeServer();
    const r = await run(['submit', 'd.md', '--remote', 'http://h', '--json'], { fetch: s.f, fs: memFs({ 'd.md': EXAMPLE }).fsx });
    expect(r.code).toBe(2);
    expect(JSON.parse(r.out).fatal).toMatchObject({ code: 'EXAMPLE_TARGET', step: 'blok 1' });
    expect(r.err).toContain('--allow-example');
    expect(s.calls).toHaveLength(0);
  });

  it('misi saja atau docKey saja yang sama tetap ditolak; --mission tidak menghapus docKey contoh; update juga dijaga', async () => {
    const onlyFolder = withTarget({ mission: exTarget.mission, docKey: 'milik-saya' });
    const onlyKey = withTarget({ mission: MISSION, docKey: exTarget.docKey });
    for (const [md, extra] of [[onlyFolder, []], [onlyKey, []], [EXAMPLE, ['--mission', '2026-10-31_r2_f2']]] as const) {
      const s = fakeServer();
      const r = await run(['submit', 'd.md', '--remote', 'http://h', '--json', ...extra], { fetch: s.f, fs: memFs({ 'd.md': md }).fsx });
      expect(JSON.parse(r.out).fatal.code).toBe('EXAMPLE_TARGET');
      expect(s.calls).toHaveLength(0);
    }
    // --mission menimpa folder contoh -> lolos bila docKey bukan milik contoh.
    const okMission = await run(['submit', 'd.md', '--remote', 'http://h', '--json', '--mission', '2026-10-31_r2_f2'], { fetch: fakeServer().f, fs: memFs({ 'd.md': onlyFolder }).fsx });
    expect(okMission.code).toBe(0);
    const upd = fakeServer();
    const ru = await run(['update', DOC, 'd.md', '--remote', 'http://h', '--json'], { fetch: upd.f, fs: memFs({ 'd.md': onlyKey }).fsx });
    expect(JSON.parse(ru.out).fatal.code).toBe('EXAMPLE_TARGET');
    expect(upd.calls).toHaveLength(0);
  });

  it('--allow-example: dikirim seperti biasa', async () => {
    const s = fakeServer();
    const r = await run(['submit', 'd.md', '--remote', 'http://h', '--json', '--allow-example'], { fetch: s.f, fs: memFs({ 'd.md': EXAMPLE }).fsx });
    expect(r.code).toBe(0);
    expect(s.calls[0].body?.target).toEqual(exTarget);
  });
});
