// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/render/c18-file-name-form.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
// C18 / TR-07 (register research/38 R-78 `naming.file.form`; manual Tabel 2.3 ID:487-493 "Nota Rencana Uji
// 2026-11-02.md", EN:518-523 "Test Plan Note 2026-11-02.md"): bentuk nama berkas opt-in "judul + tanggal ISO".
// Absen / "judulNomorRevisi" = bentuk hari ini `<Judul> <nomor-berkas> Rev<X>` (datumFileName, tidak berubah).
import { beforeAll, describe, expect, it } from '../_vitest';
import type { ResolvedTemplate } from '@/lib/studio/contract';
import { renderSnapshot } from '@/lib/studio/services/render/pure/render';
import { datumFileName, datumFileNameByForm } from '@/lib/studio/services/storage/paths';
import { withParams } from '../engine-core/fixtures';
import { canonicalTemplate, loadFixtureDoc, snapshotOf } from '../renderers/_kit';

const NOTA = { title: 'Nota Rencana Uji', docNumber: '001/GSP/KT/XI/2026', rev: 'A', issueDate: '2026-11-02' };

describe('C18 datumFileNameByForm (storage/paths)', () => {
  it('judulTanggalIso = "<judul> <YYYY-MM-DD>.<ext>" seperti Tabel 2.3', () => {
    expect(datumFileNameByForm('judulTanggalIso', NOTA, 'md')).toBe('Nota Rencana Uji 2026-11-02.md');
    expect(datumFileNameByForm('judulTanggalIso', { ...NOTA, title: 'Test Plan Note' }, 'docx')).toBe('Test Plan Note 2026-11-02.docx');
  });

  it('absen, bawaan, atau nilai lain = bentuk hari ini, sama persis dengan datumFileName', () => {
    const today = datumFileName(NOTA.title, NOTA.docNumber, NOTA.rev, 'pdf');
    expect(today).toBe('Nota Rencana Uji 001-GSP-KT-XI-2026 RevA.pdf');
    expect(datumFileNameByForm(undefined, NOTA, 'pdf')).toBe(today);
    expect(datumFileNameByForm('judulNomorRevisi', NOTA, 'pdf')).toBe(today);
    expect(datumFileNameByForm('lain', NOTA, 'pdf')).toBe(today);
  });

  it('karakter tidak aman dibuang dengan aturan datumClean; garis bawah jadi spasi', () => {
    expect(datumFileNameByForm('judulTanggalIso', { ...NOTA, title: 'Nota: uji/rencana_A? "x" <y> |z*' }, 'html')).toBe('Nota ujirencana A x y z 2026-11-02.html');
    expect(datumFileNameByForm('judulTanggalIso', { ...NOTA, title: '..\\..\\etc' }, 'html')).toBe('....etc 2026-11-02.html');
  });

  it('judul panjang dipotong, tanggal utuh, batang maks 120 karakter', () => {
    const name = datumFileNameByForm('judulTanggalIso', { ...NOTA, title: 'Panjang '.repeat(30) }, 'docx');
    expect(name.endsWith(' 2026-11-02.docx')).toBe(true);
    expect(name.length - '.docx'.length).toBeLessThanOrEqual(120);
  });

  it('judul kosong = tanggal saja; tanggal bukan ISO ditolak', () => {
    expect(datumFileNameByForm('judulTanggalIso', { ...NOTA, title: '' }, 'docx')).toBe('2026-11-02.docx');
    expect(() => datumFileNameByForm('judulTanggalIso', { ...NOTA, issueDate: '2-11-2026' }, 'docx')).toThrow();
    expect(() => datumFileNameByForm('judulTanggalIso', { ...NOTA, issueDate: '2026-11-02/../x' }, 'docx')).toThrow();
  });
});

describe('C18 renderSnapshot: nama berkas dari parameter templat (bukan slug/tipe)', () => {
  let tpl: ResolvedTemplate;
  beforeAll(async () => {
    tpl = await canonicalTemplate();
  });

  async function primaryName(t: ResolvedTemplate): Promise<{ name: string; title: string; issueDate: string; docNumber: string }> {
    const snap = snapshotOf(loadFixtureDoc('doc_nota_memo'));
    const res = await renderSnapshot(snap, t, { formats: ['HTML'], measureLayout: false, registerLog: false });
    const file = res.files.find((f) => f.role === 'PRIMARY' && f.format === 'HTML');
    const meta = snap.doc.meta;
    return { name: file?.fileName ?? '', title: meta.title, issueDate: meta.issueDate, docNumber: String(meta.docNumber) };
  }

  // row42 SKIP E1: renderSnapshot rasterises the fixture's figures through the Electron render bridge (row 108
  // engine/browser twin); no bridge exists in a bun unit run (log: BROWSER_UNAVAILABLE "DATUM_RENDER_SOCKET/TOKEN not
  // set"), so every format fails. The original skipped Chromium-only cases the same way. File naming itself is
  // covered by the datumFileNameByForm cases above.
  it.skip('judulTanggalIso: "<judul> <meta.issueDate>.html"; absen: bentuk hari ini', async () => {
    const iso = await primaryName(withParams(tpl, { 'naming.file.form': 'judulTanggalIso' }));
    expect(iso.issueDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(iso.name).toBe(`${iso.title} ${iso.issueDate}.html`);
    const absent = await primaryName({ ...tpl, params: Object.fromEntries(Object.entries(tpl.params).filter(([k]) => k !== 'naming.file.form')) } as ResolvedTemplate);
    expect(absent.name).toBe(datumFileName(absent.title, absent.docNumber, 'A', 'html'));
    const dflt = await primaryName(withParams(tpl, { 'naming.file.form': 'judulNomorRevisi' }));
    expect(dflt.name).toBe(absent.name);
  }, 120_000);
});
