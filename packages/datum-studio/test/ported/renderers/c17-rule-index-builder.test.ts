// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/renderers/c17-rule-index-builder.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
// C17 / ST-01 (research/37 R2-R6, register research/38 §3.6, D-631): pembangun indeks aturan bersama
// (isi dokumen -> entri). Murni dan deterministik; dipakai perakit DOCX dan HTML.
import { describe, expect, it } from '../_vitest';
import {
  buildRuleIndex,
  compareRuleCodes,
  ruleIndexTable,
  ruleIndexHeading,
  ruleIndexEmptyParagraph,
} from '@/lib/studio/engine/front/rule-index';

type Any = Record<string, unknown>;
const p = (text: string, extra: Any = {}) => ({ type: 'paragraph', text, ...extra });
const sec = (title: string, blocks: unknown[] = []) => ({ title: { text: title }, blocks });
const ch = (key: string, sections: unknown[], extra: Any = {}) => ({ key, title: { text: `Bab ${key}` }, sections, ...extra });

function snap(chapters: unknown[], opts: { appendices?: unknown[]; language?: 'ID' | 'EN'; outline?: Any[] } = {}) {
  return {
    schema: 'studio.norm/v2',
    doc: { meta: { language: opts.language ?? 'ID' }, chapters, appendices: opts.appendices ?? [] },
    source: { sections: { content: { type: 'chapter', outline: opts.outline ?? [] } } },
    skeleton: { slots: [{ slotKey: 'content', sectionType: 'chapter' }, { slotKey: 'appendices', sectionType: 'appendix' }] },
  } as never;
}

describe('C17 buildRuleIndex: penanda yang dikenali (M1, M2, M3)', () => {
  it('M2 paragraf: kode + tingkat di awal -> satu entri (kode, ringkas, tingkat, bab)', () => {
    const r = buildRuleIndex(snap([ch('1', [sec('Pengantar', [p('DT-01a WAJIB. Taruh di halaman hanya bukti dan aparatusnya. Kalimat kedua.')])])]));
    expect(r.entries).toEqual([
      { code: 'DT-01a', summary: 'Taruh di halaman hanya bukti dan aparatusnya', level: 'WAJIB', chapter: '1', address: '1.1.1' },
    ]);
    expect(r.duplicates).toEqual([]);
  });

  it('M1 judul section dengan nomor section di depan; ringkas = sisa judul', () => {
    const r = buildRuleIndex(snap([ch('2', [sec('1.1 DT-02 BAKU Aturan pengatur angka', [p('Isi biasa.')])])]));
    expect(r.entries).toEqual([{ code: 'DT-02', summary: 'Aturan pengatur angka', level: 'BAKU', chapter: '2', address: '2.1' }]);
  });

  it('M1 judul tanpa sisa teks: ringkas = kalimat pertama paragraf pertama section', () => {
    const r = buildRuleIndex(snap([ch('3', [sec('PK-02 WAJIB', [p('Catat setiap keputusan kerja. Lalu tinjau.')])])]));
    expect(r.entries[0]).toMatchObject({ code: 'PK-02', summary: 'Catat setiap keputusan kerja', level: 'WAJIB' });
  });

  it('M2 butir daftar sama dengan paragraf; pemisah · — : ( ) dan md-lite diterima', () => {
    const r = buildRuleIndex(
      snap([
        ch('1', [
          sec('S', [
            { type: 'list', style: 'bullet', items: [{ text: '**PK-03** · WAJIB — Catat sumber angka.' }, { text: 'butir biasa' }] },
            p('EG-58 (MANDATORY): Write an email that states the ask first.'),
            { type: 'paragraph', runs: [{ t: 'TB-04', b: true }, { t: ': ANJURAN Pakai tabel bila ada tiga baris atau lebih.' }] },
          ]),
        ]),
      ]),
    );
    expect(r.entries.map((e) => [e.code, e.level, e.summary, e.address])).toEqual([
      ['PK-03', 'WAJIB', 'Catat sumber angka', '1.1.1'],
      ['TB-04', 'ANJURAN', 'Pakai tabel bila ada tiga baris atau lebih', '1.1.3'],
      ['EG-58', 'MANDATORY', 'Write an email that states the ask first', '1.1.2'],
    ]);
  });

  it('M3 catatan rail paragraf: ringkas = kalimat pertama paragraf induk; (PK) ikut tingkat', () => {
    const host = p('Angka terhitung membawa turunannya. Bukan hanya hasil.', { rail: [{ kind: 'note', text: 'DT-13f WAJIB (PK)' }, { kind: 'source', text: 'DT-14 WAJIB' }] });
    const r = buildRuleIndex(snap([ch('4', [sec('Turunan', [host])])]));
    expect(r.entries).toEqual([
      { code: 'DT-13f', summary: 'Angka terhitung membawa turunannya', level: 'WAJIB (PK)', chapter: '4', address: '4.1.1' },
    ]);
  });

  it('spasi tak-putus (U+00A0) diperlakukan sebagai spasi', () => {
    const r = buildRuleIndex(snap([ch('1', [sec('S', [p('GA-03 WAJIB Grafik diberi judul.')])])]));
    expect(r.entries[0]).toMatchObject({ code: 'GA-03', level: 'WAJIB', summary: 'Grafik diberi judul' });
  });

  it('kode bentuk SG-L1-02, EN-L3-06, EN-C-01 dikenali', () => {
    const r = buildRuleIndex(snap([ch('1', [sec('S', [p('SG-L1-02 WAJIB Satu.'), p('EN-L3-06 MANDATORY Two.'), p('EN-C-01 ADVISORY Three.')])])]));
    expect(r.entries.map((e) => e.code)).toEqual(['SG-L1-02', 'EN-L3-06', 'EN-C-01']);
  });
});

describe('C17 buildRuleIndex: yang tidak dikenali (citation, posisi, pembawa dikecualikan)', () => {
  it('tanpa tingkat, tidak di awal, prefiks dikecualikan, tingkat huruf kecil', () => {
    const r = buildRuleIndex(
      snap([
        ch('1', [
          sec('Kutipan', [
            p('DT-03 di Bab 8 mengalahkan aturan lain.'),
            p('Lihat DT-05 WAJIB untuk rinciannya.'),
            p('R-31 WAJIB putusan lama.'),
            p('E-02 WAJIB cacat mesin.'),
            p('EL-04 WAJIB pemeriksaan.'),
            p('DT-06 wajib huruf kecil.'),
            p('D-1.1 WAJIB label turunan.'),
            p('DT-07WAJIB tanpa pemisah.'),
          ]),
        ]),
      ]),
    );
    expect(r.entries).toEqual([]);
  });

  it('tabel, aside, monoBlock, derivation, caption dan SOURCE tidak dipindai', () => {
    const r = buildRuleIndex(
      snap([
        ch('1', [
          sec('Pembawa lain', [
            { type: 'ruleTable', columns: [{}], rows: [{ cells: [{ text: 'EG-02 WAJIB baris tabel' }] }], caption: { inline: { text: 'DT-20 WAJIB caption' } }, source: { inline: { text: 'DT-21 WAJIB sumber' } } },
            { type: 'aside', variant: 'generic', label: { text: 'DT-22 WAJIB' }, body: [{ text: 'DT-23 WAJIB isi aside' }] },
            { type: 'monoBlock', label: { text: 'KD-01 WAJIB' }, lines: [{ text: 'KD-02 WAJIB' }] },
            { type: 'derivation', label: { text: 'DT-24 WAJIB' } },
            p('Paragraf biasa.', { rail: [{ kind: 'source', text: 'DT-25 WAJIB' }, { kind: 'mark', text: 'DT-26 WAJIB' }] }),
          ]),
        ]),
      ]),
    );
    expect(r.entries).toEqual([]);
  });

  it('judul bab (bukan section) dan halaman depan tidak dipindai', () => {
    const s = snap([ch('1', [sec('S', [p('Biasa.')])], { title: { text: 'DT-30 WAJIB judul bab' } })]) as unknown as { doc: Any };
    s.doc.front = { cover: { mode: 'explicit', body: [p('DT-31 WAJIB sampul')] } };
    expect(buildRuleIndex(s as never).entries).toEqual([]);
  });

  it('intro bab (alamat C.0.P) ikut dipindai', () => {
    const r = buildRuleIndex(snap([ch('5', [sec('S', [])], { intro: [p('IL-01 BAKU Ilustrasi diberi sumber.')] })]));
    expect(r.entries[0]).toMatchObject({ code: 'IL-01', address: '5.0.1', chapter: '5' });
  });
});

describe('C17 buildRuleIndex: ringkas, bab, urutan, duplikat', () => {
  it('ringkas dipotong 12 kata dengan "…" hanya bila terpotong', () => {
    const r = buildRuleIndex(
      snap([ch('1', [sec('S', [p('DT-08 WAJIB satu dua tiga empat lima enam tujuh delapan sembilan sepuluh sebelas dua-belas tiga-belas.'), p('DT-09 WAJIB pendek saja')])])]),
    );
    expect(r.entries[0].summary).toBe('satu dua tiga empat lima enam tujuh delapan sembilan sepuluh sebelas dua-belas…');
    expect(r.entries[1].summary).toBe('pendek saja');
  });

  it('lampiran = "Lampiran A" (ID) / "Annex A" (EN); label outline bab dipakai bila penomoran sumber', () => {
    const appendix = ch('A', [sec('S', [p('BP-01 ANJURAN Praktik baik.')])]);
    const id = buildRuleIndex(snap([ch('6', [sec('S', [p('CH-01 WAJIB Grafik.')])])], { appendices: [appendix], outline: [{ key: '6', label: 'FM' }] }));
    expect(id.entries.map((e) => e.chapter)).toEqual(['FM', 'Lampiran A']);
    const en = buildRuleIndex(snap([ch('6', [sec('S', [p('CH-01 MANDATORY Chart.')])])], { appendices: [appendix], language: 'EN' }));
    expect(en.entries.map((e) => e.chapter)).toEqual(['6', 'Annex A']);
  });

  it('urutan menurut kode: keluarga manual, angka per bagian, akhiran huruf sesudah angka polos', () => {
    const codes = ['EN-C-01', 'BP-02', 'IL-01', 'SM-01', 'CH-01', 'KD-01', 'EN-L2-01', 'EN-L1-10', 'SG-L2-01', 'SG-L1-02', 'GA-01', 'EG-01', 'TB-01', 'PK-02', 'PK-01', 'DT-13f', 'DT-13', 'DT-13a', 'DT-02'];
    const r = buildRuleIndex(snap([ch('1', [sec('S', codes.map((c) => p(`${c} WAJIB Teks.`)))])]));
    expect(r.entries.map((e) => e.code)).toEqual([
      'DT-02', 'DT-13', 'DT-13a', 'DT-13f', 'PK-01', 'PK-02', 'TB-01', 'EG-01', 'GA-01', 'SG-L1-02', 'SG-L2-01', 'EN-L1-10', 'EN-L2-01', 'KD-01', 'CH-01', 'SM-01', 'IL-01', 'BP-02', 'EN-C-01',
    ]);
    expect(compareRuleCodes('DT-13', 'DT-13a')).toBeLessThan(0);
    expect(compareRuleCodes('SG-L1-02', 'SG-L1-10')).toBeLessThan(0);
  });

  it('kode ganda: kemunculan pertama menang, satu peringatan per tambahan dengan kedua alamat dan tingkat', () => {
    const r = buildRuleIndex(
      snap([ch('1', [sec('S', [p('DT-10 WAJIB Pertama.'), p('DT-10 ANJURAN Kedua.')])]), ch('2', [sec('DT-10 BAKU Ketiga', [])])]),
    );
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0]).toMatchObject({ summary: 'Pertama', level: 'WAJIB', address: '1.1.1' });
    expect(r.duplicates).toEqual([
      { code: 'DT-10', address: '1.1.2', level: 'ANJURAN', firstAddress: '1.1.1', firstLevel: 'WAJIB' },
      { code: 'DT-10', address: '2.1', level: 'BAKU', firstAddress: '1.1.1', firstLevel: 'WAJIB' },
    ]);
  });

  it('kosong: tanpa penanda -> 0 entri, 0 duplikat; deterministik', () => {
    const s = snap([ch('1', [sec('S', [p('Tanpa kode aturan.')])])]);
    expect(buildRuleIndex(s)).toEqual({ entries: [], duplicates: [] });
    const m = snap([ch('1', [sec('S', [p('DT-01 WAJIB A.'), p('PK-01 WAJIB B.')])])]);
    expect(JSON.stringify(buildRuleIndex(m))).toBe(JSON.stringify(buildRuleIndex(m)));
  });
});

describe('C17 konten keluaran bersama (tabel, judul, baris kosong) ID/EN', () => {
  const entries = [{ code: 'DT-01a', summary: 'Halaman hanya bukti', level: 'WAJIB', chapter: '1', address: '1.1.1' }];

  it('tabel ruleIndex: kolom id/text/text/text, kepala dari tabel teks, SOURCE dari tabel teks', () => {
    expect(ruleIndexTable(entries, 'ID')).toEqual({
      type: 'ruleIndex',
      columns: [{ role: 'id' }, { role: 'text' }, { role: 'text' }, { role: 'text' }],
      rows: [
        { kind: 'header', cells: [{ text: 'Kode' }, { text: 'Ringkas' }, { text: 'Tingkat' }, { text: 'Bab' }] },
        { cells: [{ text: 'DT-01a' }, { text: 'Halaman hanya bukti' }, { text: 'WAJIB' }, { text: '1' }] },
      ],
      source: { inline: { text: 'Blok aturan dokumen ini' } },
    });
    const en = ruleIndexTable(entries, 'EN');
    expect(en.rows[0].cells.map((c) => c.text)).toEqual(['Code', 'Summary', 'Level', 'Ch']);
    expect(en.source).toEqual({ inline: { text: 'Rule blocks of this document' } });
    expect(en).not.toHaveProperty('caption');
  });

  it('judul seksi dan baris kosong per bahasa', () => {
    expect(ruleIndexHeading('ID')).toEqual({ title: { text: 'Indeks aturan' }, number: '' });
    expect(ruleIndexHeading('EN')).toEqual({ title: { text: 'Rule index' }, number: '' });
    expect(ruleIndexEmptyParagraph('ID')).toEqual({ type: 'paragraph', text: 'Dokumen ini tidak memuat kode aturan.' });
    expect(ruleIndexEmptyParagraph('EN')).toEqual({ type: 'paragraph', text: 'This document states no rule codes.' });
  });
});
