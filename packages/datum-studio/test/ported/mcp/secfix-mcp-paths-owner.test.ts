// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/mcp/secfix-mcp-paths-owner.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
// SEC-FIX (D-501 L-2, D-502 butir 6): folder unduhan divalidasi SEBELUM jaringan dan SEBELUM folder dibuat (satu
// pembantu bersama `resolveDownloadDir`/`prepareDownloadDir` di safety.ts, dipakai studio_file_verify dan
// studio_figure_preview); satu fungsi pemilik (`checkOwnership`) dipakai doc-tools dan figure-tools.
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { describe, it, expect, beforeEach } from '../_vitest';
import { connect, FILE_ID, logs, memNodeFs, ROOT, studioMock } from './mcp-harness';
import { prepareDownloadDir, resolveDownloadDir } from '../../../vendor/scripts/studio/mcp/safety';

const FINAL = '001-GSP-KT-XI-2026_rev1_20261102T000000Z_abcdef01.docx';
const SHA = 'a'.repeat(64);
const MCP_DIR = path.resolve(__dirname, '../../../vendor/scripts/studio/mcp');

beforeEach(() => {
  logs.length = 0;
});

describe('SEC-FIX L-2: downloadDir bernama folder instruksi ditolak sebelum jaringan dan tanpa folder dibuat', () => {
  const INSTRUCTION_DIRS = ['.claude', '.github', '.hermes', '.git', path.join('kerja', '.cursor')];

  it('studio_file_verify { downloadDir: <akar>/.claude } -> PATH_PROTECTED, 0 panggilan jaringan, 0 mkdir', async () => {
    for (const d of INSTRUCTION_DIRS) {
      const m = studioMock({
        ['HEAD /api/studio/files/' + FILE_ID]: () => ({ status: 200, headers: { 'x-studio-final-filename': FINAL, 'x-studio-sha256-verified': 'true', 'x-studio-sha256': SHA } }),
        ['GET /api/studio/files/' + FILE_ID]: () => ({ status: 200, headers: { 'x-studio-final-filename': FINAL }, bytes: Buffer.from('x') }),
      });
      const mem = memNodeFs();
      const { call } = await connect({ fetch: m.f, nfs: mem.nfs });
      const r = await call('studio_file_verify', { fileId: FILE_ID, downloadDir: path.join(ROOT, d) });
      expect(r.data.error.code, d).toBe('PATH_PROTECTED');
      expect(m.calls, d).toHaveLength(0);
      expect(mem.writes, d).toEqual([]);
      expect(mem.nfs.exists(path.join(ROOT, d)), d).toBe(false);
    }
  });

  it('studio_figure_preview { downloadDir: <akar>/.claude } -> PATH_PROTECTED, 0 jaringan, 0 mkdir (pembantu yang sama)', async () => {
    const m = studioMock();
    const mem = memNodeFs();
    const { call } = await connect({ fetch: m.f, nfs: mem.nfs });
    const r = await call('studio_figure_preview', { documentId: 'cmvdoc0000000000000fig03b', pid: 'fig-chart-1', downloadDir: path.join(ROOT, '.claude') });
    expect(r.data.error.code).toBe('PATH_PROTECTED');
    expect(m.calls).toHaveLength(0);
    expect(mem.writes).toEqual([]);
  });

  it('resolveDownloadDir: folder biasa lolos; folder instruksi (basename) dan anaknya ditolak; luar akar ditolak', () => {
    const mem = memNodeFs();
    expect(resolveDownloadDir(path.join(ROOT, 'unduhan'), [ROOT], mem.nfs)).toBe(path.join(ROOT, 'unduhan'));
    expect(() => resolveDownloadDir(path.join(ROOT, '.claude'), [ROOT], mem.nfs)).toThrow(expect.objectContaining({ code: 'PATH_PROTECTED' }));
    expect(() => resolveDownloadDir(path.join(ROOT, '.CLAUDE'), [ROOT], mem.nfs)).toThrow(expect.objectContaining({ code: 'PATH_PROTECTED' }));
    expect(() => resolveDownloadDir(path.join(ROOT, '.git', 'x'), [ROOT], mem.nfs)).toThrow(expect.objectContaining({ code: 'PATH_PROTECTED' }));
    expect(() => resolveDownloadDir(path.resolve('/di-luar-akar/x'), [ROOT], mem.nfs)).toThrow(expect.objectContaining({ code: 'PATH_OUTSIDE_ROOTS' }));
    expect(mem.writes).toEqual([]);
  });

  it('prepareDownloadDir: validasi ulang tepat sebelum mkdir (folder yang berubah jadi di luar akar tidak dibuat)', () => {
    const mem = memNodeFs();
    const dir = path.join(ROOT, 'unduhan');
    prepareDownloadDir(dir, [ROOT], mem.nfs);
    expect(mem.writes).toEqual([`mkdir ${dir}`]);
    // realpath kini menunjuk ke luar akar (junction ditanam sesudah validasi awal) -> ditolak, tanpa mkdir.
    const swapped = { ...mem.nfs, realpath: (p: string) => (path.resolve(p).startsWith(dir) ? path.resolve('/di-luar-akar/x') : path.resolve(p)) };
    const before = mem.writes.length;
    expect(() => prepareDownloadDir(dir, [ROOT], swapped)).toThrow(expect.objectContaining({ code: 'PATH_OUTSIDE_ROOTS' }));
    expect(mem.writes.slice(before)).toEqual([]);
  });

  it('satu sumber: tools.ts dan figure-tools.ts memakai resolveDownloadDir + prepareDownloadDir, tanpa mkdirp langsung', () => {
    for (const f of ['tools.ts', 'figure-tools.ts']) {
      const src = readFileSync(path.join(MCP_DIR, f), 'utf8');
      expect(src, f).toContain('resolveDownloadDir(');
      expect(src, f).toContain('prepareDownloadDir(');
      expect(src, f).not.toMatch(/nfs\.mkdirp\(/);
    }
  });
});

describe('SEC-FIX review 6: satu fungsi pemilik untuk doc-tools dan figure-tools', () => {
  it('figure-tools tidak lagi menyalin aturan pemilik: memanggil checkOwnership dari doc-tools', () => {
    const src = readFileSync(path.join(MCP_DIR, 'figure-tools.ts'), 'utf8');
    expect(src).not.toMatch(/function checkFigureOwner/);
    expect(src).not.toMatch(/session\.adopt\(/);
    expect(src).toMatch(/checkOwnership\(/);
    expect(src).toMatch(/import \{[^}]*\bcheckOwnership\b[^}]*\} from "\.\/doc-tools"/);
  });
});

describe('SEC-FIX laporan pratinjau di MCP: yang dirender di samping masukan; info tidak menyuruh revisi', () => {
  const FDOC = 'cmvdoc0000000000000fig03b';
  const preview = (figure: Record<string, unknown>) => ({
    documentId: FDOC, revisionNo: 3, currentRevisionNo: 3, rendered: true,
    figure: { type: 'chart', code: 'P-02', pid: 'fig-chart-1', address: '1.1.2', label: 'Gambar 1.1', inline: false, size: { widthMm: 166, heightMm: 60, svgBytes: 3000 }, checksRun: 9, ...figure },
  });

  it('baris "dirender" memuat kode/arah/butir akhir; hanya INTENT_APPLIED (info) -> tanpa ajakan studio_figure_revise', async () => {
    const m = studioMock({
      [`POST /api/studio/documents/${FDOC}/figures/preview`]: () => ({
        status: 200,
        body: preview({
          issues: [{ checkId: 'INTENT_APPLIED', status: 'REPORT', detail: 'topN 5', suggest: null, suggestSource: null, info: true }],
          issueCount: 1,
          layoutIssueCount: 0,
          data: { shape: 'categorical', items: 12, maxLabelChars: 3 },
          rendered: { code: 'P-01', orientation: 'horizontal', shape: 'categorical', items: 6, maxLabelChars: 7 },
        }),
      }),
    });
    const { call } = await connect({ fetch: m.f, nfs: memNodeFs().nfs });
    const r = await call('studio_figure_preview', { documentId: FDOC, pid: 'fig-chart-1' });
    expect(r.isError).toBeFalsy();
    expect(r.text).toContain('data: categorical 12 butir');
    expect(r.text).toContain('dirender: P-01 horizontal, 6 butir');
    expect(r.text).toContain('0 isu tata letak (+1 info)');
    expect(r.text).not.toContain('perbaiki: studio_figure_revise');
    expect(r.data.figure.rendered).toMatchObject({ code: 'P-01', items: 6 });
  });
});
