// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/import/dc25-md2contract-cli.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
// DC-25 (D-377): CLI `scripts/studio/md2contract.ts` (register masterplan/05_document_contract_specs.md
// §16.6, BA-25, KD-42) dijalankan sebagai proses nyata (tsx). Kode keluar 0/1/2/3, stdout = studio.doc/v2
// byte-identik antar-run, `--strict`, `--out`, serta keunikan kunci butir lewat I54 (D-375).
import { describe, it, expect, beforeAll, afterAll } from '../_vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { markdownToContract } from '@/lib/studio/services/import/contract';

const ROOT = path.resolve(__dirname, '../../../vendor');
const TSX = path.join(ROOT, 'node_modules/tsx/dist/cli.mjs');
const CLI = path.join(ROOT, 'scripts/studio/md2contract.ts');
const KIND = ['--kind', 'agentWorkReport'];

// Laporan bersih: kepala lengkap, semua judul beralias -> nol peringatan.
const CLEAN = [
  '# Laporan kerja DC-25 CLI',
  '',
  'Status: complete',
  'Date: 2026-10-30T19:30+07:00',
  '',
  '## Ringkasan',
  '',
  'CLI selesai.',
  '',
].join('\n');
// Tanpa waktu laporan, judul tanpa alias -> peringatan + kode 3 tanpa --reported-at.
const NOTIME = ['# Laporan tanpa waktu', '', 'Status: complete', '', '## Ringkasan', '', 'Isi.', '', '## Catatan pribadi', '', 'Tidak beralias.', ''].join('\n');
const DUPKEYS = [
  '# Laporan butir ganda',
  '',
  'Status: complete',
  'Date: 2026-10-30',
  '',
  '## Changes Made',
  '',
  '| ID | Judul | Status |',
  '|---|---|---|',
  '| DC-03 | Pertama | done |',
  '| DC-04 | Kedua | ready |',
  '| DC-03 | Ulangan | blocked |',
  '',
].join('\n');

let dir = '';
const file = (name: string, text: string): string => {
  const p = path.join(dir, name);
  fs.writeFileSync(p, text, 'utf8');
  return p;
};

function run(args: string[]): { code: number | null; out: string; err: string } {
  const r = spawnSync(process.execPath, [TSX, CLI, ...args], { cwd: ROOT, encoding: 'utf8', timeout: 60_000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc25-'));
});
afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

// row42 SKIP S1: spawns scripts/studio/md2contract.ts, which is not in the vendored file set (vendor/provenance.json).
describe.skip('md2contract CLI: sukses dan keluaran', () => {
  it('stdout = JSON studio.doc/v2 sama byte dengan markdownToContract; dua run byte-identik; exit 0', () => {
    const f = file('clean.md', CLEAN);
    const a = run([f, ...KIND]);
    const b = run([f, ...KIND]);
    expect(a.code).toBe(0);
    expect(a.out).toBe(b.out);
    expect(a.out).toBe(`${JSON.stringify(markdownToContract(CLEAN, { kind: 'agentWorkReport' }).doc, null, 2)}\n`);
    expect(JSON.parse(a.out).$schema).toBe('studio.doc/v2');
    expect(a.err).toContain('md2contract md2contract/v1: valid=true');
  });

  it('opsi --mission/--doc-key/--doc-number/--doc-title diteruskan ke dokumen', () => {
    const r = run([file('clean.md', CLEAN), ...KIND, '--mission', '2026-10-30_uji', '--doc-key', 'laporan-1', '--doc-number', 'LK-001', '--doc-title', 'Judul Uji']);
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.out);
    expect(doc.mission).toEqual({ folder: '2026-10-30_uji' });
    expect(doc.docKey).toBe('laporan-1');
    expect(doc.meta).toEqual({ title: 'Judul Uji', docNumber: 'LK-001' });
  });

  it('--out menulis dokumen ke berkas (stdout kosong) dengan isi sama byte', () => {
    const out = path.join(dir, 'hasil.json');
    const r = run([file('clean.md', CLEAN), ...KIND, '--out', out]);
    expect(r.code).toBe(0);
    expect(r.out).toBe('');
    expect(fs.readFileSync(out, 'utf8')).toBe(run([file('clean.md', CLEAN), ...KIND]).out);
  });
});

// row42 SKIP S1: spawns scripts/studio/md2contract.ts, which is not in the vendored file set (vendor/provenance.json).
describe.skip('md2contract CLI: kode keluar', () => {
  it('3: waktu laporan hilang tanpa --reported-at, pesan menyebut opsinya (KD-42); stdout kosong', () => {
    const r = run([file('notime.md', NOTIME), ...KIND]);
    expect(r.code).toBe(3);
    expect(r.out).toBe('');
    expect(r.err).toContain('--reported-at');
    expect(r.err).toContain('CONTRACT_HEADING_UNMAPPED');
  });

  it('0: --reported-at menutup nilai wajib; peringatan tanpa --strict tidak menggagalkan', () => {
    const r = run([file('notime.md', NOTIME), ...KIND, '--reported-at', '2026-10-30T00:00:00Z']);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).sections.record.reportedAt).toBe('2026-10-30T00:00:00Z');
    expect(r.err).toContain('CONTRACT_HEADING_UNMAPPED');
  });

  it('1: --strict dengan peringatan; stdout tetap memuat dokumen', () => {
    const r = run([file('notime.md', NOTIME), ...KIND, '--reported-at', '2026-10-30T00:00:00Z', '--strict']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('--strict');
    expect(JSON.parse(r.out).$schema).toBe('studio.doc/v2');
  });

  it('0: --strict tanpa peringatan', () => {
    expect(run([file('clean.md', CLEAN), ...KIND, '--strict']).code).toBe(0);
  });

  it.each([
    ['tanpa --kind', (f: string) => [f]],
    ['--kind tak dikenal', (f: string) => [f, '--kind', 'lain']],
    ['opsi tak dikenal', (f: string) => [f, ...KIND, '--zzz']],
    ['--doc-key tanpa --mission', (f: string) => [f, ...KIND, '--doc-key', 'k']],
    ['--entry tak sah', (f: string) => [f, ...KIND, '--entry', '0']],
    ['--status tanpa alias (bila dipakai)', (f: string) => [f, ...KIND, '--status', 'zzz']],
    ['--reported-at tak sah', (f: string) => [f, ...KIND, '--reported-at', 'kemarin']],
  ])('2: galat pemakaian: %s', (_n, args) => {
    // NOTIME tanpa status beralias agar --status dan --reported-at benar-benar dipakai
    const f = file('nostatus.md', ['# Laporan', '', '## Ringkasan', '', 'Isi.', ''].join('\n'));
    const a = args(f);
    if (a.includes('--status') && !a.includes('--reported-at')) a.push('--reported-at', '2026-10-30');
    const r = run(a);
    expect(r.code).toBe(2);
    expect(r.err).toContain('pemakaian:');
  });

  it('2: berkas tidak ada', () => {
    const r = run([path.join(dir, 'tidak-ada.md'), ...KIND]);
    expect(r.code).toBe(2);
    expect(r.err).toContain('tidak dapat membaca');
  });

  it('--help: exit 0, teks bantuan berbahasa Indonesia di stdout', () => {
    const r = run(['--help']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('--strict');
    expect(r.out).toContain('Kode keluar');
  });
});

describe('keunikan kunci butir lewat I54 (D-375)', () => {
  it('kunci ulang: baris pertama dipertahankan, catatan ITEM_KEY_DUPLICATE', () => {
    const r = markdownToContract(DUPKEYS, { kind: 'agentWorkReport' });
    const items = (r.doc.sections!.record as unknown as { items: Array<{ key: string; status: string }> }).items;
    expect(items.map((i) => `${i.key}:${i.status}`)).toEqual(['DC-03:done', 'DC-04:ready']);
    expect(r.report.mapping.notes.filter((n) => n.code === 'ITEM_KEY_DUPLICATE').map((n) => n.line)).toEqual([12]);
    expect(r.validation.valid).toBe(true);
  });
});
