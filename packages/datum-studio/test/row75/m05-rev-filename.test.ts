// @ts-nocheck row 75: vitest-typed harness (test/ported/mcp) run under bun:test; checked at run time.
// Swarm 1.2.6 row 75 (M-05, decision U15, register N-053/N-054): the delivered DATUM name always carries the numeric
// revision after the letter revision, `<Judul> <nomor> Rev<X> rev<N>.<ext>` (e.g. `... RevD rev256.pdf`), so two
// numeric revisions of one letter revision no longer collide in a download folder (no OUT_EXISTS, E-21 unchanged).
// DATUM_FILENAME_PATTERN accepts names with and without ` rev<N>` (files delivered before 1.2.6 stay valid).
import { useStudioEnv } from '../ported/_env'; useStudioEnv();
import path from 'node:path';
import { createHash } from 'node:crypto';
import { describe, it, expect } from '../ported/_vitest';
import { datumFileName, datumFileNameByForm } from '../../vendor/src/lib/studio/services/storage/paths';
import { DATUM_FILENAME_PATTERN } from '../../vendor/src/lib/studio/contract/env';
import { contentDisposition } from '../../src/mcp-host/local-api/routes/files-serve';
import { connect, FILE_ID, memNodeFs, ROOT, studioMock } from '../ported/mcp/mcp-harness';

const DATUM = new RegExp(DATUM_FILENAME_PATTERN);
const TITLE = 'Laporan Uji Lapangan';
const NUM = '012/GSP/KT/XI/2026';

describe('row 75 M-05: datumFileName always adds rev<N> after Rev<X> (N-053, U15)', () => {
  it('builds `<Judul> <nomor> Rev<X> rev<N>.<ext>`; two numeric revisions give two names', () => {
    expect(datumFileName(TITLE, NUM, 'D', 'pdf', 255)).toBe('Laporan Uji Lapangan 012-GSP-KT-XI-2026 RevD rev255.pdf');
    expect(datumFileName(TITLE, NUM, 'D', 'pdf', 256)).toBe('Laporan Uji Lapangan 012-GSP-KT-XI-2026 RevD rev256.pdf');
    expect(datumFileName(TITLE, NUM, 'RevA', 'docx', 1)).toBe('Laporan Uji Lapangan 012-GSP-KT-XI-2026 RevA rev1.docx');
  });

  it('datumFileNameByForm passes the numeric revision through (default form); the date form is unchanged', () => {
    const i = { title: TITLE, docNumber: NUM, rev: 'D', issueDate: '2026-11-12', revisionNo: 256 };
    expect(datumFileNameByForm(undefined, i, 'pdf')).toBe('Laporan Uji Lapangan 012-GSP-KT-XI-2026 RevD rev256.pdf');
    expect(datumFileNameByForm('judulTanggalIso', i, 'pdf')).toBe('Laporan Uji Lapangan 2026-11-12.pdf');
  });

  it('a long title is clipped, never the number or either revision', () => {
    const name = datumFileName('Panjang '.repeat(40), NUM, 'D', 'pdf', 256);
    expect(name.endsWith(' 012-GSP-KT-XI-2026 RevD rev256.pdf')).toBe(true);
    expect(name.length - '.pdf'.length).toBeLessThanOrEqual(120);
    expect(DATUM.test(name)).toBe(true);
  });

  it('refuses a revision number that is not a whole number in 0..999999', () => {
    for (const bad of [-1, 1.5, 1_000_000, Number.NaN]) {
      expect(() => datumFileName(TITLE, NUM, 'D', 'pdf', bad)).toThrow();
    }
  });
});

describe('row 75 M-05: DATUM_FILENAME_PATTERN accepts ` rev<N>` (N-054); old names stay valid', () => {
  it('accepts names with and without ` rev<N>`, with or without the store sha suffix', () => {
    for (const ok of [
      'Laporan Uji Lapangan 012-GSP-KT-XI-2026 RevD rev256.pdf',
      'Laporan Uji Lapangan 012-GSP-KT-XI-2026 RevD rev0.docx',
      'Laporan Uji Lapangan 012-GSP-KT-XI-2026 RevD rev999999.html',
      'Laporan Uji Lapangan 012-GSP-KT-XI-2026 RevD rev256 0123abcd.pdf',
      'Laporan Uji Lapangan 012-GSP-KT-XI-2026 RevD.pdf',
      'Laporan Uji Lapangan 012-GSP-KT-XI-2026 RevD 0123abcd.pdf',
      'Nota uji 2026-11-08.docx',
    ]) expect({ ok, pass: DATUM.test(ok) }).toEqual({ ok, pass: true });
  });

  it('refuses malformed numeric revisions and keeps the old refusals', () => {
    for (const bad of [
      'Laporan 012-GSP-KT-XI-2026 RevD rev0256.pdf',
      'Laporan 012-GSP-KT-XI-2026 RevD rev1234567.pdf',
      'Laporan 012-GSP-KT-XI-2026 RevD rev.pdf',
      'Laporan 012-GSP-KT-XI-2026 RevD_rev256.pdf',
      'Laporan 012-GSP-KT-XI-2026 RevD rev256.sh',
      '../x 012-GSP-KT-XI-2026 RevD rev256.pdf',
    ]) expect({ bad, pass: DATUM.test(bad) }).toEqual({ bad, pass: false });
  });
});

describe('row 75 M-05: downloading rev255 then rev256 of one letter revision never raises OUT_EXISTS', () => {
  function revFile(revisionNo: number) {
    const bytes = Buffer.from(`<html><body>laporan revisi ${revisionNo}</body></html>`, 'utf8');
    const sha = createHash('sha256').update(bytes).digest('hex');
    const final = `012-GSP-KT-XI-2026_rev${revisionNo}_20261112T120000Z_${sha.slice(0, 8)}.html`;
    const name = datumFileName(TITLE, NUM, 'D', 'html', revisionNo);
    const headers = { 'x-studio-final-filename': final, 'x-studio-sha256': sha, 'content-disposition': contentDisposition('attachment', name) };
    const m = studioMock({
      ['HEAD /api/studio/files/' + FILE_ID]: () => ({ status: 200, headers: { ...headers, 'x-studio-sha256-verified': 'true' } }),
      ['GET /api/studio/files/' + FILE_ID]: () => ({ status: 200, headers, bytes }),
    });
    return { m, bytes, sha, name };
  }

  it('both revisions land side by side under their own DATUM names', async () => {
    const dir = path.join(ROOT, 'docs', 'misi-m05');
    const mem = memNodeFs({}, [ROOT, path.join(ROOT, 'docs')]);
    const saved: string[] = [];
    for (const n of [255, 256]) {
      const f = revFile(n);
      const { call } = await connect({ fetch: f.m.f, nfs: mem.nfs });
      const r = await call('studio_file_verify', { fileId: FILE_ID, downloadDir: dir, expectedSha256: f.sha });
      expect({ n, error: r.data?.error?.code ?? null }).toEqual({ n, error: null });
      expect(r.data.deliveredFileName).toBe(f.name);
      expect(mem.read(path.join(dir, f.name))).toBe(f.bytes.toString('utf8'));
      saved.push(r.data.savedTo);
    }
    expect(saved).toEqual([
      path.join(dir, 'Laporan Uji Lapangan 012-GSP-KT-XI-2026 RevD rev255.html'),
      path.join(dir, 'Laporan Uji Lapangan 012-GSP-KT-XI-2026 RevD rev256.html'),
    ]);
  });
});
