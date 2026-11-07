// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/mcp/implw3-builder.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
// IMPL-W3 butir 4, 6, 7, 13 (laporan kerja, murni): kepala record dinormalkan sebelum konversi (tidak ada positif palsu
// CONTENT_INJECTION "pembuka bab 1 di luar section"), urutan bagian bebas, bab wajib kurang = INCOMPLETE (bukan galat),
// status Indonesia, rujukan terstruktur, teks ter-wrap keras digabung.
/* eslint-disable @typescript-eslint/no-explicit-any -- hasil bebas bentuk */
import { describe, it, expect } from '../_vitest';
import { buildWorkReport } from '../../../vendor/scripts/studio/mcp/write-content';
import { assertShape } from '../../../vendor/scripts/studio/mcp/write-tools';

const NOW = Date.parse('2026-11-03T01:00:00Z');
const FIVE = [
  { heading: 'Ringkasan', blocks: ['Teks ringkas.'] },
  { heading: 'Rincian kerja', blocks: [[['judul', 'status'], ['Bab 2', 'done']]] },
  { heading: 'Bukti', blocks: ['b'] },
  { heading: 'Isu terbuka', blocks: ['Tidak ada.'] },
  { heading: 'Langkah berikut', blocks: ['x'] },
];
const build = (meta: Record<string, string>, sections: any[] = FIVE) => buildWorkReport({ mission: '2026-11-03_implw3', docKey: 'k', title: null, meta, sections, agentId: 'hermes', now: NOW });
const codes = (b: { warnings: Array<{ code: string }> }) => b.warnings.map((w) => w.code);

describe('butir 4: kepala record dinormalkan (positif palsu CONTENT_INJECTION r5)', () => {
  it.each([
    [{ status: 'complete', verdict: 'lulus dengan catatan' }, 'Verdict: CAUTION'],
    [{ status: 'complete', verdict: 'lulus' }, 'Verdict: PASS'],
    [{ status: 'complete', taskRef: 'IMPL W3 baris 4' }, 'TaskRef: IMPL-W3-baris-4'],
    [{ status: 'complete', initiator: 'Pak Budi' }, 'Initiator: pak-budi'],
    [{ status: 'complete', cardIds: 'abc, t_0123abcd' }, 'CardIds: t_0123abcd'],
  ])('%j -> %s, assertShape lolos', (meta, line) => {
    const b = build(meta);
    expect(b.markdown).toContain(line);
    expect(() => assertShape(b)).not.toThrow();
  });

  it('vonis tak dikenal dibuang dengan peringatan (tidak menjadi pembuka bab 1)', () => {
    const b = build({ status: 'complete', verdict: 'mantap sekali' });
    expect(b.markdown).not.toContain('Verdict:');
    expect(codes(b)).toContain('VERDICT_DROPPED');
    expect(() => assertShape(b)).not.toThrow();
  });

  it('urutan bagian bebas: bab tambahan di depan, bab tertukar', () => {
    expect(() => assertShape(build({ status: 'complete' }, [{ heading: 'Latar belakang', blocks: ['L'] }, ...FIVE]))).not.toThrow();
    expect(() => assertShape(build({ status: 'complete' }, [FIVE[1], FIVE[0], ...FIVE.slice(2)]))).not.toThrow();
  });

  it('injeksi nyata tetap tertangkap: paragraf yang hilang sesudah konversi', () => {
    const b = build({ status: 'complete' });
    b.paragraphs[0] = ['teks yang tidak pernah ditulis'];
    expect(() => assertShape(b)).toThrow(/CONTENT_INJECTION|berbeda sesudah konversi/);
  });
});

describe('butir 6: bab wajib kurang -> INCOMPLETE, bukan galat', () => {
  it('missing menyebut SEMUA bab yang kurang sekaligus; tidak ada isi dikarang', () => {
    const b = build({ status: 'draft' }, FIVE.slice(0, 2));
    expect(b.missing).toEqual(['Bukti', 'Isu terbuka', 'Langkah berikut']);
    expect(b.markdown).not.toContain('## Bukti');
    expect(() => assertShape(b)).not.toThrow();
  });
});

describe('butir 7: status Indonesia, rujukan', () => {
  it('status laporan dan status butir berbahasa Indonesia', () => {
    expect(build({ status: 'terblokir' }).markdown).toContain('Status: blocked');
    expect(build({ status: 'perlu-tinjauan' }).markdown).toContain('Status: needs-review');
    const b = build({ status: 'selesai' }, [FIVE[0], { heading: 'Rincian kerja', blocks: [[['judul', 'status'], ['A', 'terblokir'], ['B', 'perlu tinjauan'], ['C', 'belum mulai']]] }, ...FIVE.slice(2)]);
    expect(b.markdown).toMatch(/\| A \| blocked \|/);
    expect(b.markdown).toMatch(/\| B \| review \|/);
    expect(b.markdown).toMatch(/\| C \| todo \|/);
    expect(codes(b)).not.toContain('ITEM_STATUS_UNKNOWN');
  });

  it('blok {ref} -> tabel Rujukan; teks di bagian Rujukan dipindah, tidak ditolak', () => {
    const doc = 'abcdefghij0123456789abcd';
    const b = build({ status: 'complete' }, [...FIVE.slice(0, 3), { heading: 'Isu terbuka', blocks: ['Tidak ada.', { ref: { rel: 'menggantikan', documentId: doc } }] }, FIVE[4], { heading: 'Rujukan', blocks: ['Catatan pengantar rujukan.', [['dokumen', 'hubungan'], [doc, 'basis']]] }]);
    expect(b.markdown).toMatch(/## Rujukan[\s\S]*\| hubungan \| dokumen \|[\s\S]*\| supersedes \| abcdefghij0123456789abcd \|/);
    expect(b.markdown).toContain('Catatan pengantar rujukan.');
    expect(codes(b)).toContain('REFS_TEXT_MOVED');
    expect(() => assertShape(b)).not.toThrow();
  });
});

describe('butir 13: teks ter-wrap keras', () => {
  it('baris tunggal digabung spasi; baris kosong = paragraf baru', () => {
    const b = build({ status: 'complete' }, [{ heading: 'Ringkasan', blocks: ['baris satu yang\nter-wrap keras\n\nparagraf dua'] }, ...FIVE.slice(1)]);
    expect(b.markdown).toContain('baris satu yang ter-wrap keras\n\nparagraf dua');
    expect(() => assertShape(b)).not.toThrow();
  });

  it('subheading di laporan kerja menjadi paragraf (bukan INVALID_ARGUMENT)', () => {
    const b = build({ status: 'complete' }, [{ heading: 'Ringkasan', blocks: [{ subheading: 'Konteks' }, 'isi'] }, ...FIVE.slice(1)]);
    expect(b.markdown).toContain('Konteks');
    expect(() => assertShape(b)).not.toThrow();
  });
});
