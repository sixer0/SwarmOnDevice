// @ts-nocheck row 165D: vitest-typed harness (test/ported/mcp) run under bun:test; checked at run time.
// Row 165D (F56-2, CP-17; decisions C188/C189): studio_file_verify delivers a Studio file under its DATUM title name
// (R10 Content-Disposition, storage/paths.ts datumFileName), e.g. `<Judul> 012-GSP-KT-XI-2026 RevA.docx`, zero
// underscores; studio_render lists that name. Path policy: a server name that is not one safe DATUM segment (traversal,
// separators, `_`, control/bidi characters, other extensions) is never used; the C51 final name is used instead.
// The title is agent-written: it is printed only inside the untrusted block.
import { useStudioEnv } from '../ported/_env'; useStudioEnv();
import path from 'node:path';
import { describe, it, expect, beforeEach } from '../ported/_vitest';
import { dispositionFileName, joinInside, safeDatumName } from '../../vendor/scripts/studio/mcp/datum-name';
import { contentDisposition } from '../../src/mcp-host/local-api/routes/files-serve';
import { DOC, FINAL, HTML, SHA } from '../ported/draft/r3-stateful-harness';
import { connect, FILE_ID, logs, memNodeFs, ROOT, studioMock } from '../ported/mcp/mcp-harness';

const TITLE_NAME = 'Pemantauan Iklim Ruang Simpan Arsip Statis Gedung B 012-GSP-KT-XI-2026 RevA.html';

beforeEach(() => {
  logs.length = 0;
});

function mock(name: string | null, downloadName: string | null = name) {
  const cd = (n: string | null) => (n === null ? {} : { 'content-disposition': contentDisposition('attachment', n) });
  return studioMock({
    ['HEAD /api/studio/files/' + FILE_ID]: () => ({ status: 200, headers: { 'x-studio-final-filename': FINAL, 'x-studio-sha256-verified': 'true', 'x-studio-sha256': SHA, ...cd(name) } }),
    ['GET /api/studio/files/' + FILE_ID]: () => ({ status: 200, headers: { 'x-studio-final-filename': FINAL, 'x-studio-sha256': SHA, ...cd(downloadName) }, bytes: HTML }),
  });
}

describe('row 165D: studio_file_verify delivers the DATUM title name', () => {
  it('saves under the DATUM name from Content-Disposition (zero underscores), not the C51 store name', async () => {
    const m = mock(TITLE_NAME);
    const dir = path.join(ROOT, 'docs', 'misi-a');
    const mem = memNodeFs({}, [ROOT, path.join(ROOT, 'docs')]);
    const { call } = await connect({ fetch: m.f, nfs: mem.nfs });
    const r = await call('studio_file_verify', { fileId: FILE_ID, downloadDir: dir, expectedSha256: SHA });
    expect(r.isError).toBeFalsy();
    expect(r.data.savedTo).toBe(path.join(dir, TITLE_NAME));
    expect(r.data.deliveredFileName).toBe(TITLE_NAME);
    expect(r.data.fileName).toBe(TITLE_NAME);
    expect(r.data.finalFileName).toBe(FINAL);
    expect(path.basename(r.data.savedTo)).not.toContain('_');
    expect(mem.read(path.join(dir, TITLE_NAME))).toBe(HTML.toString('utf8'));
    expect(mem.read(path.join(dir, FINAL))).toBeNull();
    // the agent-written title is printed only inside the untrusted block, and marked untrusted in structuredContent
    const open = r.text.indexOf('<data-tak-tepercaya');
    expect(open).toBeGreaterThan(-1);
    expect(r.text.slice(0, open)).not.toContain('Pemantauan');
    expect(r.data.untrustedFields).toEqual(expect.arrayContaining(['fileName', 'deliveredFileName', 'savedTo']));
  });

  it('unsafe or non-DATUM server names are never used as a path; the C51 name is used instead', async () => {
    for (const bad of ['../../jahat 012-GSP-KT-XI-2026 RevA.html', 'a/b 012-GSP-KT-XI-2026 RevA.html', 'Laporan_akhir 012-GSP-KT-XI-2026 RevA.html', '.claude 012-GSP-KT-XI-2026 RevA.html', 'Laporan 012-GSP-KT-XI-2026 RevA.sh', 'Laporan‮ 012-GSP-KT-XI-2026 RevA.html']) {
      const m = mock(bad);
      const dir = path.join(ROOT, 'dl');
      const mem = memNodeFs({}, [ROOT]);
      const { call } = await connect({ fetch: m.f, nfs: mem.nfs });
      const r = await call('studio_file_verify', { fileId: FILE_ID, downloadDir: dir });
      expect({ bad, savedTo: r.data.savedTo }).toEqual({ bad, savedTo: path.join(dir, FINAL) });
      expect(r.data.fileName).toBeNull();
      expect(mem.writes.every((w) => w.endsWith(FINAL) || w.startsWith('mkdir'))).toBe(true);
    }
  });

  it('a DATUM name that differs between verification and download is refused (nothing written)', async () => {
    const m = mock(TITLE_NAME, 'Lain 012-GSP-KT-XI-2026 RevA.html');
    const mem = memNodeFs({}, [ROOT]);
    const { call } = await connect({ fetch: m.f, nfs: mem.nfs });
    const r = await call('studio_file_verify', { fileId: FILE_ID, downloadDir: path.join(ROOT, 'dl') });
    expect(r.data.error.code).toBe('VERIFY_FAILED');
    expect(mem.writes.filter((w) => !w.startsWith('mkdir'))).toEqual([]);
  });

  it('studio_render lists the DATUM name as outputs[].fileName (untrusted field); unsafe -> null', async () => {
    const m = studioMock({
      ['POST /api/studio/documents/' + DOC + '/render']: () => ({ status: 200, body: { outputs: [{ id: FILE_ID, role: 'PRIMARY', format: 'HTML', sha256: SHA, finalFileName: FINAL, fileName: TITLE_NAME }, { id: 'cmvvfile0000000000000r3f2b', role: 'PRIMARY', format: 'PDF', sha256: SHA, finalFileName: FINAL, fileName: '../x 012 RevA.pdf' }] } }),
    });
    const { call } = await connect({ fetch: m.f });
    const r = await call('studio_render', { documentId: DOC });
    expect(r.isError).toBeFalsy();
    expect(r.data.outputs.map((o) => o.fileName)).toEqual([TITLE_NAME, null]);
    expect(r.data.untrustedFields).toContain('outputs[].fileName');
  });
});

describe('row 165D: datum-name helpers', () => {
  it('dispositionFileName reads filename* first, then filename; malformed -> null', () => {
    expect(dispositionFileName(contentDisposition('attachment', TITLE_NAME))).toBe(TITLE_NAME);
    expect(dispositionFileName('attachment; filename="a 012 RevA.pdf"')).toBe('a 012 RevA.pdf');
    expect(dispositionFileName("attachment; filename*=UTF-8''%E0%A4%A")).toBeNull();
    expect(dispositionFileName(null)).toBeNull();
  });
  it('safeDatumName and joinInside keep one segment inside the folder', () => {
    expect(safeDatumName(TITLE_NAME)).toBe(true);
    expect(safeDatumName('Nota uji 2026-11-08.docx')).toBe(true);
    expect(safeDatumName('..')).toBe(false);
    expect(safeDatumName('x/../y 012 RevA.pdf')).toBe(false);
    expect(safeDatumName('Café 012 RevA.pdf')).toBe(false); // not NFC
    expect(joinInside('/r/dl', TITLE_NAME)).toBe(`/r/dl/${TITLE_NAME}`);
    expect(joinInside('/r/dl', '../x')).toBeNull();
  });
});
