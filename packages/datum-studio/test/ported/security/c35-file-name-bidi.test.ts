// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/security/c35-file-name-bidi.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
// C35 L-02 (CWE-451): kontrol bidi (U+200E/F, U+202A-202E, U+2066-2069) dibuang dari nama berkas DATUM
// agar nama tidak bisa tampil terbalik (mis. "...cod.exe" tampil sebagai "...exe.doc"). Nama tanpa kontrol bidi
// tetap sama persis.
import { describe, expect, it } from '../_vitest';
import { datumClean, datumDateFileName, datumFileName } from '@/lib/studio/services/storage/paths';

const BIDI = ['\u200E', '\u200F', '\u202A', '\u202B', '\u202C', '\u202D', '\u202E', '\u2066', '\u2067', '\u2068', '\u2069'];
const BIDI_RE = /[\u200E\u200F\u202A-\u202E\u2066-\u2069]/;

describe('C35 L-02 datumClean: kontrol bidi dibuang', () => {
  it('setiap kontrol bidi dibuang dari datumClean', () => {
    for (const c of BIDI) expect(datumClean(`Nota${c} Uji`), JSON.stringify(c)).toBe('Nota Uji');
  });

  it('nama berkas dari judul dengan RLO tidak memuat kontrol bidi', () => {
    const t = 'Laporan \u202Excod.exe\u202C Akhir';
    expect(datumDateFileName(t, '2026-11-05', 'docx')).toBe('Laporan xcod.exe Akhir 2026-11-05.docx');
    expect(datumFileName(t, '001/GSP/KT/XI/2026', 'A', 'pdf')).toBe('Laporan xcod.exe Akhir 001-GSP-KT-XI-2026 RevA.pdf');
    expect(datumDateFileName(`\u2067${t}\u2069`, '2026-11-05', 'md')).not.toMatch(BIDI_RE);
  });

  it('nama tanpa kontrol bidi tetap sama persis (huruf non-Latin, aksen, ZWJ tidak disentuh)', () => {
    expect(datumFileName('Manual Komprehensif DATUM GSP', '000/GSP/STD/X/2026', 'A', 'docx')).toBe('Manual Komprehensif DATUM GSP 000-GSP-STD-X-2026 RevA.docx');
    expect(datumDateFileName('Nota Rencana Uji', '2026-11-02', 'md')).toBe('Nota Rencana Uji 2026-11-02.md');
    expect(datumClean('Rapat Ü é — العربية עברית')).toBe('Rapat Ü é — العربية עברית');
    expect(datumClean('a\u200Db')).toBe('a\u200Db');
  });
});
