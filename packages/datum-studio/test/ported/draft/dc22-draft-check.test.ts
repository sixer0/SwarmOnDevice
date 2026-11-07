// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/draft/dc22-draft-check.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
// DC-22 (register 05 §11.3-§11.4): CLI `scripts/studio/draft-check.ts`. Pemeriksaan lokal (I63 +
// skema v2 R08 + langkah 6b), `--remote` dengan fetch tiruan (header rahasia, isu R08 apa adanya,
// DR-08), `--emit` byte-identik, dan kode keluar lewat proses nyata (tsx).
import { describe, it, expect, beforeAll, afterAll } from '../_vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  checkDraftLocal,
  checkDraftRemote,
  contractStructureIssues,
  main,
  type FetchLike,
} from '../../../vendor/scripts/studio/draft-check';

const ROOT = path.resolve(__dirname, '../../../vendor');
const TSX = path.join(ROOT, 'node_modules/tsx/dist/cli.mjs');
const CLI = path.join(ROOT, 'scripts/studio/draft-check.ts');
const DOC = 'cmvui0qun000qv11gtygb1mk9';
const SECRET = 'rahasia-uji-dc22-jangan-tercetak';

const EXAMPLE = [
  '# DRAF Laporan kerja DC-02',
  'tujuan: register nama document contract',
  'langkah-berikut: kirim slot record lalu bab 1-5',
  `basis: ${DOC}@rev3`,
  '',
  '```json',
  `{ "$schema": "studio.slot/v2", "target": { "documentId": "${DOC}" }, "slot": "record", "baseRevisionNo": 3,`,
  '  "payload": { "type": "contractRecord", "status": "partial", "reportedAt": "2026-10-30" } }',
  '```',
  '',
].join('\n');

const BROKEN = [
  '# DRAF rusak',
  'tujuan: uji',
  'langkah-berikut: perbaiki',
  'basis: baru',
  '',
  '```json',
  '{ "$schema": "studio.slot/v2",',
  '  "slot": "record",',
  '  "payload": { "type": "contractRecord" "status": "partial" } }',
  '```',
  '',
].join('\n');

function slotDraft(payload: Record<string, unknown>): string {
  const block = JSON.stringify({ $schema: 'studio.slot/v2', target: { documentId: DOC }, slot: 'record', payload }, null, 2);
  return `# DRAF\ntujuan: t\nlangkah-berikut: l\nbasis: baru\n\n\`\`\`json\n${block}\n\`\`\`\n`;
}

let dir = '';
function file(name: string, content: string | Buffer): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, content);
  return p;
}

function run(args: string[], env: Record<string, string> = {}): { code: number | null; out: string; err: string; outBuf: Buffer } {
  const r = spawnSync(process.execPath, [TSX, CLI, ...args], { cwd: ROOT, timeout: 60_000, env: { ...process.env, INTERNAL_API_SECRET: '', ...env } });
  return { code: r.status, out: r.stdout.toString('utf8'), err: r.stderr.toString('utf8'), outBuf: r.stdout };
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc22-'));
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('pemeriksaan lokal', () => {
  it('contoh §11.1 valid: kepala lengkap, satu blok valid tanpa isu', () => {
    const r = checkDraftLocal(EXAMPLE);
    expect(r.valid).toBe(true);
    expect(r.issues).toEqual([]);
    expect(r.header).toEqual({
      title: 'DRAF Laporan kerja DC-02',
      tujuan: 'register nama document contract',
      langkahBerikut: 'kirim slot record lalu bab 1-5',
      basis: `${DOC}@rev3`,
    });
    expect(r.blocks).toHaveLength(1);
    expect(r.blocks[0]).toMatchObject({ index: 1, line: 6, endLine: 9, schema: 'studio.slot/v2', valid: true, issues: [] });
  });

  it('skema v2 gagal: isu validator R08 (pointer) di blok, valid false', () => {
    const r = checkDraftLocal(slotDraft({ type: 'contractRecord', status: 'bukan-status', reportedAt: '2026-10-30' }));
    expect(r.valid).toBe(false);
    expect(r.issues).toEqual([]);
    expect(r.blocks[0].valid).toBe(false);
    const issues = r.blocks[0].issues as Array<{ pointer: string }>;
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.some((i) => i.pointer.startsWith('/payload/status'))).toBe(true);
  });

  it('langkah 6b: items[].key ganda -> CONTRACT_ITEM_KEY_DUPLICATE dengan posisi', () => {
    // D-375: cek lokal = I54 (payload harus sah semantik agar EC27 tercapai); posisi berbasis 1.
    const rec = (...keys: string[]) => ({ type: 'contractRecord', status: 'partial', reportedAt: '2026-10-30', items: keys.map((key) => ({ key, title: { text: key }, status: 'todo' })) });
    const value = {
      $schema: 'studio.slot/v2',
      payload: rec('a', 'b', 'a'),
    };
    expect(contractStructureIssues(value)).toEqual([
      expect.objectContaining({
        pointer: '/payload/items/2/key',
        keyword: 'CONTRACT_ITEM_KEY_DUPLICATE',
        details: { key: 'a', positions: [1, 3] },
      }),
    ]);
    expect(contractStructureIssues({ $schema: 'studio.slot/v2', payload: rec('a') })).toEqual([]);
    expect(
      contractStructureIssues({ $schema: 'studio.doc/v2', sections: { record: rec('x', 'x') } }),
    ).toEqual([expect.objectContaining({ pointer: '/sections/record/items/1/key' })]);
  });

  it('JSON rusak: DR-03 dengan baris/kolom absolut, blok tidak diperiksa skema', () => {
    const r = checkDraftLocal(BROKEN);
    expect(r.valid).toBe(false);
    expect(r.issues).toEqual([expect.objectContaining({ code: 'DRAFT_JSON_MALFORMED', severity: 'error', line: 9, column: 41, blockIndex: 1 })]);
    expect(r.blocks[0]).toMatchObject({ valid: false, issues: [], payload: null });
  });
});

/** Fetch tiruan: mencatat panggilan; R05 menjawab `currentRevisionNo`, R08 menjawab `r08`. */
function fakeFetch(opts: { current?: number | null; r08?: (body: string) => { status: number; body: unknown } } = {}) {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body?: string }> = [];
  const f: FetchLike = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body });
    const respond = (status: number, body: unknown) => ({
      status,
      headers: { get: () => null },
      text: async () => JSON.stringify(body),
    });
    if (init.method === 'GET') {
      if (opts.current === null) return respond(404, { error: 'Document not found', code: 'DOCUMENT_NOT_FOUND' });
      return respond(200, { document: { id: DOC, currentRevisionNo: opts.current ?? 3 } });
    }
    const r = opts.r08 ? opts.r08(init.body ?? '') : { status: 200, body: { valid: true, issues: [], lint: null, submitPreview: { revisionNo: 4 } } };
    return respond(r.status, r.body);
  };
  return { f, calls };
}

describe('--remote (fetch tiruan)', () => {
  it('blok dikirim apa adanya ke R08 dengan x-internal-secret; previews disalin; lint tidak', async () => {
    const { f, calls } = fakeFetch({ current: 3 });
    const r = await checkDraftRemote(EXAMPLE, { baseUrl: 'http://127.0.0.1:9021/', secret: SECRET, fetchImpl: f });
    expect(r.valid).toBe(true);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `GET http://127.0.0.1:9021/api/studio/documents/${DOC}`,
      'POST http://127.0.0.1:9021/api/studio/validate',
    ]);
    for (const c of calls) expect(c.headers['x-internal-secret']).toBe(SECRET);
    const lines = EXAMPLE.split('\n');
    expect(calls[1].body).toBe(lines.slice(6, 8).join('\n'));
    expect(r.blocks[0].submitPreview).toEqual({ revisionNo: 4 });
    expect(r.blocks[0]).not.toHaveProperty('lint');
  });

  it('DR-08: basis rev3 < currentRevisionNo 10 -> peringatan di baris basis; exit tetap ditentukan blok', async () => {
    const { f } = fakeFetch({ current: 10 });
    const r = await checkDraftRemote(EXAMPLE, { baseUrl: 'http://h', secret: SECRET, fetchImpl: f });
    expect(r.issues).toEqual([expect.objectContaining({ code: 'DRAFT_BASIS_STALE', severity: 'warning', line: 4, column: 1 })]);
    expect(r.valid).toBe(true);
  });

  it('dokumen basis 404: DR-08 tidak dapat dicek (tanpa isu)', async () => {
    const { f } = fakeFetch({ current: null });
    const r = await checkDraftRemote(EXAMPLE, { baseUrl: 'http://h', secret: SECRET, fetchImpl: f });
    expect(r.issues).toEqual([]);
  });

  it('isu R08 apa adanya; valid false -> exit 1; rahasia tidak tercetak', async () => {
    const issue = { pointer: '/slot', keyword: 'SLOT_UNKNOWN', message: 'Slot "record" tidak ada', details: { slotKey: 'record' } };
    const { f } = fakeFetch({ current: 3, r08: () => ({ status: 200, body: { valid: false, issues: [issue], lint: null } }) });
    const md = file('remote-bad.md', EXAMPLE);
    let out = '';
    let err = '';
    const code = await main([md, '--remote', 'http://h', '--json'], {
      stdout: (s) => (out += s),
      stderr: (s) => (err += s),
      env: { INTERNAL_API_SECRET: SECRET },
      fetchImpl: f,
    });
    expect(code).toBe(1);
    const j = JSON.parse(out);
    expect(j.valid).toBe(false);
    expect(j.blocks[0].issues).toEqual([issue]);
    expect(out + err).not.toContain(SECRET);
  });

  it('401 dari server -> exit 2 tanpa mencetak rahasia', async () => {
    const { f } = fakeFetch({ current: 3, r08: () => ({ status: 401, body: { error: 'Unauthorized', code: 'UNAUTHORIZED' } }) });
    const md = file('remote-401.md', EXAMPLE);
    let all = '';
    const code = await main([md, '--remote', 'http://h'], { stdout: (s) => (all += s), stderr: (s) => (all += s), env: { INTERNAL_API_SECRET: SECRET }, fetchImpl: f });
    expect(code).toBe(2);
    expect(all).toContain('401');
    expect(all).not.toContain(SECRET);
  });

  it('tanpa env INTERNAL_API_SECRET -> exit 2 tanpa panggilan jaringan', async () => {
    const { f, calls } = fakeFetch();
    const md = file('remote-noenv.md', EXAMPLE);
    let err = '';
    const code = await main([md, '--remote', 'http://h'], { stdout: () => {}, stderr: (s) => (err += s), env: {}, fetchImpl: f });
    expect(code).toBe(2);
    expect(calls).toHaveLength(0);
    expect(err).toContain('INTERNAL_API_SECRET');
  });
});

// row42 SKIP S2 (row 107 M5, row 11 M5): the direct-run entry of scripts/studio/draft-check.ts is removed in Swarm; spawning it as a CLI (via the clone's node_modules/tsx) is not a shipped path.
describe.skip('CLI (proses nyata)', () => {
  it('contoh §11.1 -> exit 0, laporan berbahasa Indonesia', () => {
    const r = run([file('contoh.md', EXAMPLE)]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('blok 1 (baris 6-9) studio.slot/v2: valid');
    expect(r.out).toContain('hasil: LOLOS');
  });

  it('draf rusak -> exit 1 dengan nomor baris', () => {
    const r = run([file('rusak.md', BROKEN)]);
    expect(r.code).toBe(1);
    expect(r.out).toContain('[galat] baris 9 kolom 41 DRAFT_JSON_MALFORMED');
    expect(r.out).toContain('hasil: TIDAK LOLOS');
  });

  it('--json -> bentuk T2-70', () => {
    const r = run([file('contoh-json.md', EXAMPLE), '--json']);
    expect(r.code).toBe(0);
    const j = JSON.parse(r.out);
    expect(Object.keys(j)).toEqual(['valid', 'header', 'issues', 'blocks']);
    // U-05d (D-419): --json tanpa payload secara bawaan; --with-payload = bentuk R23.
    expect(Object.keys(j.blocks[0])).toEqual(['index', 'line', 'endLine', 'schema', 'valid', 'issues']);
  });

  it('--emit 1 byte-identik dengan isi blok (CRLF dan UTF-8 dipertahankan)', () => {
    const body = '{ "$schema": "studio.slot/v2",\r\n  "slot": "record", "catatan": "ringkasan — é" }';
    const md = Buffer.from(`# DRAF\r\ntujuan: t\r\nlangkah-berikut: l\r\nbasis: baru\r\n\r\n\`\`\`json\r\n${body}\r\n\`\`\`\r\n`, 'utf8');
    const r = run([file('crlf.md', md), '--emit', '1']);
    expect(Buffer.compare(r.outBuf, Buffer.from(body, 'utf8'))).toBe(0);
    // Blok tidak sah skema -> catatan + exit 1, teks tetap tercetak utuh.
    expect(r.code).toBe(1);
    expect(r.err).toContain('tidak valid secara lokal');
  });

  it('--emit blok yang tidak ada / galat pemakaian -> exit 2', () => {
    const md = file('contoh-emit.md', EXAMPLE);
    expect(run([md, '--emit', '2']).code).toBe(2);
    expect(run([md, '--emit', '0']).code).toBe(2);
    expect(run([md, '--emit', '1', '--json']).code).toBe(2);
    expect(run([md, '--bogus']).code).toBe(2);
    expect(run([]).code).toBe(2);
    expect(run([path.join(dir, 'tidak-ada.md')]).code).toBe(2);
  });

  it('blok > C54.maxBlocks -> exit 1 DRAFT_TOO_MANY_BLOCKS', () => {
    const blocks = Array.from({ length: 21 }, () => '```json\n{}\n```\n').join('\n');
    const r = run([file('banyak.md', `# DRAF\n\n${blocks}`), '--json']);
    expect(r.code).toBe(1);
    // U-05b (D-419): galat fatal --json = { fatal: { code, message, details } }.
    expect(JSON.parse(r.out)).toMatchObject({ fatal: { code: 'PAYLOAD_TOO_LARGE', details: { reason: 'DRAFT_TOO_MANY_BLOCKS' } } });
  });
});
