// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/draft/r2cli-draft-check.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
// R2-01 / U-05 (D-419): draft-check ramah. (a) simulasi berurutan blok bab/slot sesudah blok
// buat-dokumen (tanpa META_REQUIRED_FOR_CREATE), satu aturan untuk CLI --remote dan R23 (AC-19);
// (b) --json selalu JSON sah termasuk galat fatal; (c) dapat dijalankan dari cwd lain; (d) --json
// tanpa payload secara bawaan, --with-payload opt-in.
import { describe, it, expect, beforeAll, afterAll } from '../_vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkDraftRemote, main, type FetchLike } from '../../../vendor/scripts/studio/draft-check';
import {
  completeDraftCheck,
  extractDraft,
  needsCreateEnvelope,
  prepareDraftCheck,
  sequentialCreateSources,
  type DraftDryRunOutcome,
} from '../../../vendor/src/lib/studio/services/draft';

const ROOT = path.resolve(__dirname, '../../../vendor');
const TSX = path.join(ROOT, 'node_modules/tsx/dist/cli.mjs');
const CLI = path.join(ROOT, 'scripts/studio/draft-check.ts');
const SECRET = 'rahasia-uji-r2cli-jangan-tercetak';
const MISSION = { folder: '2026-10-31_r2cli' };

const createBlock = (docKey?: string) => ({
  $schema: 'studio.slot/v2',
  agentId: 'cod-r2-01',
  target: { mission: MISSION, ...(docKey ? { docKey } : {}) },
  template: { slug: 'laporan-kerja-agen' },
  meta: { title: 'Laporan uji' },
  slot: 'record',
  payload: { type: 'contractRecord', status: 'draft', reportedAt: '2026-10-31' },
});
const chapterBlock = (key: string, target: Record<string, unknown>) => ({
  $schema: 'studio.chapter/v2',
  agentId: 'cod-r2-01',
  target,
  chapter: { key, title: { text: `Bab ${key}` }, sections: [{ title: { text: 'S' }, blocks: [{ type: 'paragraph', text: 'Isi.' }] }] },
});

function draftOf(blocks: unknown[]): string {
  const body = blocks.map((b) => `\`\`\`json\n${JSON.stringify(b)}\n\`\`\`\n`).join('\n');
  return `# DRAF uji\ntujuan: t\nlangkah-berikut: l\nbasis: baru\n\n${body}`;
}

const SEQ = draftOf([
  createBlock('lap-a'),
  chapterBlock('1', { mission: MISSION, docKey: 'lap-a' }),
  chapterBlock('2', { mission: MISSION, docKey: 'lain' }),
]);

/** R08 tiruan: dokumen belum ada; bab/slot tanpa template+meta.title -> META_REQUIRED_FOR_CREATE. */
function r08Outcome(value: Record<string, unknown>): DraftDryRunOutcome {
  const meta = value.meta as { title?: string } | undefined;
  if (value.template === undefined || !meta?.title) {
    return { valid: false, issues: [{ pointer: '', keyword: 'META_REQUIRED_FOR_CREATE', message: 'Dokumen belum ada', details: { missing: ['template', 'meta.title'] } }] };
  }
  return { valid: true, issues: [], submitPreview: { created: true } };
}

function fakeR08() {
  const bodies: string[] = [];
  const f: FetchLike = async (_url, init) => {
    bodies.push(init.body ?? '');
    const out = r08Outcome(JSON.parse(init.body ?? '{}'));
    return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ ...out, lint: null }) };
  };
  return { f, bodies };
}

let dir = '';
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r2cli-dc-'));
});
afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function file(name: string, content: string): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, content);
  return p;
}

describe('U-05a simulasi berurutan', () => {
  it('peta blok -> blok buat: misi+docKey sama saja; docKey kosong = docKey efektif (slug templat)', () => {
    expect([...sequentialCreateSources(extractDraft(SEQ))]).toEqual([[2, 1]]);
    const noKey = draftOf([createBlock(), chapterBlock('1', { mission: MISSION }), chapterBlock('2', { mission: MISSION, docKey: 'laporan-kerja-agen' })]);
    expect([...sequentialCreateSources(extractDraft(noKey))]).toEqual([
      [2, 1],
      [3, 1],
    ]);
    const before = draftOf([chapterBlock('1', { mission: MISSION, docKey: 'lap-a' }), createBlock('lap-a')]);
    expect(sequentialCreateSources(extractDraft(before)).size).toBe(0);
    const otherFolder = draftOf([createBlock('lap-a'), chapterBlock('1', { mission: { folder: 'misi-lain' }, docKey: 'lap-a' })]);
    expect(sequentialCreateSources(extractDraft(otherFolder)).size).toBe(0);
  });

  it('--remote: bab sesudah blok buat valid (dry-run ulang + template/meta blok buat); bab target lain tetap META_REQUIRED', async () => {
    const { f, bodies } = fakeR08();
    const r = await checkDraftRemote(SEQ, { baseUrl: 'http://h', secret: SECRET, fetchImpl: f });
    expect(r.blocks.map((b) => b.valid)).toEqual([true, true, false]);
    expect(JSON.stringify(r.blocks[2].issues)).toContain('META_REQUIRED_FOR_CREATE');
    expect(bodies).toHaveLength(4); // blok 1; blok 2 + ulang bersimulasi; blok 3 (tanpa blok buat bertarget sama: tidak diulang)
    const retried = JSON.parse(bodies[2]);
    expect(retried.template).toEqual({ slug: 'laporan-kerja-agen' });
    expect(retried.meta).toEqual({ title: 'Laporan uji' });
    expect(retried.target).toEqual({ mission: MISSION, docKey: 'lap-a' });
    expect(r.valid).toBe(false);
  });

  it('AC-19: transport R23 (nilai di proses) dan CLI (teks HTTP) menghasilkan hasil identik', async () => {
    const { f } = fakeR08();
    const viaCli = await checkDraftRemote(SEQ, { baseUrl: 'http://h', secret: SECRET, fetchImpl: f });
    const viaR23 = await completeDraftCheck(SEQ, prepareDraftCheck(SEQ), {
      currentRevisionNo: async () => null,
      dryRun: async (input) => r08Outcome(input.value),
    });
    expect(JSON.stringify(viaR23)).toBe(JSON.stringify(viaCli));
  });

  it('needsCreateEnvelope hanya untuk META_REQUIRED_FOR_CREATE', () => {
    expect(needsCreateEnvelope({ valid: false, issues: [{ keyword: 'META_REQUIRED_FOR_CREATE' }] })).toBe(true);
    expect(needsCreateEnvelope({ valid: false, issues: [{ keyword: 'SCHEMA_INVALID' }] })).toBe(false);
    expect(needsCreateEnvelope({ valid: true, issues: [] })).toBe(false);
  });
});

describe('U-05b --json selalu JSON sah', () => {
  async function runMain(argv: string[], env: Record<string, string> = {}, fetchImpl?: FetchLike) {
    let out = '';
    let err = '';
    const code = await main(argv, { stdout: (s) => (out += s), stderr: (s) => (err += s), env, fetchImpl });
    return { code, out, err };
  }

  it('galat pemakaian, berkas, rahasia, 401: stdout = { fatal: { code, message } }, rc 2', async () => {
    const md = file('ok.md', SEQ);
    const cases: Array<[string[], Record<string, string>, string, FetchLike | undefined]> = [
      [[md, '--json', '--bogus'], {}, 'USAGE_ERROR', undefined],
      [[path.join(dir, 'tidak-ada.md'), '--json'], {}, 'FILE_UNREADABLE', undefined],
      [[md, '--json', '--remote', 'http://h'], {}, 'SECRET_MISSING', undefined],
      [
        [md, '--json', '--remote', 'http://h'],
        { INTERNAL_API_SECRET: SECRET },
        'REMOTE_UNAUTHORIZED',
        async () => ({ status: 401, headers: { get: () => null }, text: async () => '{"code":"UNAUTHORIZED"}' }),
      ],
      [
        [md, '--json', '--remote', 'http://h'],
        { INTERNAL_API_SECRET: SECRET },
        'REMOTE_UNREACHABLE',
        async () => {
          throw new Error('ECONNREFUSED');
        },
      ],
    ];
    for (const [argv, env, code, f] of cases) {
      const r = await runMain(argv, env, f);
      expect(r.code).toBe(2);
      const j = JSON.parse(r.out);
      expect(j.fatal.code).toBe(code);
      expect(typeof j.fatal.message).toBe('string');
      expect(r.out + r.err).not.toContain(SECRET);
    }
  });

  it('draf tidak lolos (rc 1) tetap JSON hasil T2-70; tanpa --json tidak ada JSON fatal', async () => {
    const { f } = fakeR08();
    const md = file('seq.md', SEQ);
    const r = await runMain([md, '--json', '--remote', 'http://h'], { INTERNAL_API_SECRET: SECRET }, f);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out).valid).toBe(false);
    const plain = await runMain([md, '--bogus']);
    expect(plain.code).toBe(2);
    expect(plain.out).toBe('');
  });
});

describe('U-05d payload opt-in', () => {
  it('--json tanpa payload; --with-payload menyertakan; --with-payload tanpa --json = galat pemakaian', async () => {
    const md = file('p.md', SEQ);
    let out = '';
    await main([md, '--json'], { stdout: (s) => (out += s), stderr: () => {}, env: {} });
    expect(JSON.parse(out).blocks.every((b: object) => !('payload' in b))).toBe(true);
    out = '';
    await main([md, '--json', '--with-payload'], { stdout: (s) => (out += s), stderr: () => {}, env: {} });
    expect(JSON.parse(out).blocks[0].payload).toMatchObject({ slot: 'record' });
    let err = '';
    expect(await main([md, '--with-payload'], { stdout: () => {}, stderr: (s) => (err += s), env: {} })).toBe(2);
    expect(err).toContain('--with-payload');
  });
});

// row42 SKIP S2 (row 107 M5, row 11 M5): spawns scripts/studio/draft-check.ts as a CLI; its direct-run entry is removed in Swarm.
describe.skip('U-05c cwd mana pun (proses nyata)', () => {
  it('dijalankan dari os.tmpdir(): alias @/ terselesaikan, rc 0, JSON sah', () => {
    const md = file('cwd.md', draftOf([createBlock('lap-a')]));
    const r = spawnSync(process.execPath, [TSX, CLI, path.basename(md), '--json'], { cwd: dir, timeout: 60_000, env: { ...process.env, INTERNAL_API_SECRET: '' } });
    expect(r.stderr.toString('utf8')).not.toContain('Cannot find module');
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout.toString('utf8')).valid).toBe(true);
  });
});
