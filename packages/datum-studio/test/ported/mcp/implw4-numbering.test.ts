// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/mcp/implw4-numbering.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
// IMPL-W4 butir 1 (D-544/D-547, UD-2 r5/r5b): judul bernomor sumber dicetak PERSIS. r5 mencetak Introduction sebagai
// "CHAPTER 4" dan "4.1 1.1"; r5b menyarangkan FM.1-FM.3 ke bab 1 sehingga 1.1-1.4 tercetak 1.4-1.7. Kini: kunci
// internal berurutan, judul apa adanya, outline berlabel (Tabel/Gambar = nomor bab sumber), FM tetap bagian sendiri.
/* eslint-disable @typescript-eslint/no-explicit-any -- payload bebas bentuk */
import { describe, it, expect } from '../_vitest';
import { buildClient, sourceLabelOf } from '../../../vendor/scripts/studio/mcp/write-client';

const META = { title: 'NearLink Research Report', author: 'Tim Riset GSP', source: 'contract.md' };
const build = (sections: any[]) => buildClient({ meta: META, title: null, sections, today: '2026-11-03' });
const text = (h: any): string => (typeof h?.text === 'string' ? h.text : (h?.runs ?? []).map((r: any) => r.t).join(''));
const codes = (b: { warnings: Array<{ code: string }> }) => b.warnings.map((w) => w.code);

/** Bentuk round-5b (doc_ud2b/source): FM.1-FM.3, Chapter 1 (1.1-1.4), Chapter 6 (6.1-6.5 + tabel + grafik), Chapter 10. */
const R5B = () => [
  { heading: 'FM.1 Document control block', blocks: [{ table: [['Field', 'Value'], ['Mission', 'NEARLINK-1019']], caption: 'Document control block', source: 'contract.md' }] },
  { heading: 'FM.2 Executive summary', blocks: ['Summary paragraph.'] },
  { heading: 'FM.3 Notation, provenance glyphs, and reading guide', blocks: ['Notation paragraph.'] },
  { heading: 'Chapter 1. Introduction', blocks: [{ subheading: '1.1 Product concept and use cases' }, 'a', { subheading: '1.2 Mission scope and boundaries' }, 'b', { subheading: '1.3 Constraints carried by the brief' }, 'c', { subheading: '1.4 How this document is structured and how its evidence works' }, 'd'] },
  {
    heading: 'Chapter 6. Security and Privacy Design',
    blocks: [
      'Intro.',
      { subheading: '6.1 Trust model: parties, assets, trust boundaries, the relay\'s exact status' }, 'e',
      { subheading: '6.2 Threat matrix SEC-01 to SEC-21 and severity rollup' },
      { table: [['SEC', 'Impact', 'Likelihood'], ['SEC-01', 'Medium', 'High']], caption: 'Threat register', source: 'masterplan/02 section 3' },
      { chart: { caption: 'Jumlah ancaman per tingkat Likelihood dan Impact (Table 6.1)', source: 'Table 6.1, bab 6 dokumen ini', categories: ['High', 'Medium-High'], series: [{ name: 'Critical', values: [0, 0] }, { name: 'High', values: [1, 0] }], stacked: true } },
      { subheading: '6.3 End-to-end encryption design SD-01 to SD-08' }, 'f',
      { subheading: '6.4 Privacy and user controls' }, 'g',
      { subheading: '6.5 Mitigation-to-architecture traceability' }, 'h',
    ],
  },
  { heading: 'Chapter 10. Conclusions and Implications', blocks: ['i', { subheading: '10.1 What the evidence supports today' }, 'j', { subheading: '10.2 What remains contingent on validation' }, 'k', { subheading: '10.3 Go / no-go logic for Phase 3 prototyping' }, 'l'] },
];

describe('IMPL-W4 butir 1: penomoran sumber', () => {
  it('label dari judul bab sumber', () => {
    expect(sourceLabelOf('Chapter 1. Introduction')).toBe('1');
    expect(sourceLabelOf('Chapter 10. Conclusions')).toBe('10');
    expect(sourceLabelOf('FM.1 Document control block')).toBe('FM');
    expect(sourceLabelOf('Bab IV Hasil')).toBe('IV');
    expect(sourceLabelOf('4. Konsep Produk')).toBe('4');
    expect(sourceLabelOf('Ringkasan Eksekutif')).toBeNull();
    expect(sourceLabelOf('2024 Results')).toBeNull();
  });

  it('r5b: 6 bagian -> 6 bab berurutan, FM tidak disarangkan, judul persis, tanpa nomor ganda', () => {
    const b = build(R5B());
    expect(b.chapters.map((c: any) => c.key)).toEqual(['1', '2', '3', '4', '5', '6']);
    expect(b.chapters.map((c: any) => text(c.title))).toEqual([
      'FM.1 Document control block',
      'FM.2 Executive summary',
      'FM.3 Notation, provenance glyphs, and reading guide',
      'Chapter 1. Introduction',
      'Chapter 6. Security and Privacy Design',
      'Chapter 10. Conclusions and Implications',
    ]);
    const ch1 = b.chapters[3] as any;
    expect(ch1.sections.map((s: any) => text(s.title))).toEqual([
      '1.1 Product concept and use cases',
      '1.2 Mission scope and boundaries',
      '1.3 Constraints carried by the brief',
      '1.4 How this document is structured and how its evidence works',
    ]);
    expect((b.chapters[5] as any).sections.map((s: any) => text(s.title).split(' ')[0])).toEqual(['10.1', '10.2', '10.3']);
    for (const c of ['SECTION_NESTED', 'SUBHEADING_NUMBER_STRIPPED', 'CHAPTER_RENUMBERED']) expect(codes(b)).not.toContain(c);
  });

  it('outline berlabel: Tabel/Gambar mengikuti nomor bab sumber (FM, 1, 6, 10)', () => {
    const b = build(R5B());
    expect(b.outline?.map((o) => [o.key, o.label])).toEqual([['1', 'FM'], ['2', 'FM'], ['3', 'FM'], ['4', '1'], ['5', '6'], ['6', '10']]);
    expect(b.outline?.map((o) => text(o.title))[4]).toBe('Chapter 6. Security and Privacy Design');
  });

  it('bab tanpa nomor di dokumen bernomor: judul persis, label dari sub-judul atau bab sebelumnya', () => {
    const b = build([
      { heading: 'Ringkasan', blocks: [{ subheading: '0.1 Latar' }, 'x'] },
      { heading: '1. Pendahuluan', blocks: ['y'] },
      { heading: 'Catatan Penutup', blocks: ['z'] },
    ]);
    expect(b.chapters.map((c: any) => text(c.title))).toEqual(['Ringkasan', '1. Pendahuluan', 'Catatan Penutup']);
    expect(b.outline?.map((o) => o.label)).toEqual(['0', '1', '1']);
  });

  it('dokumen tanpa nomor sama sekali: penomoran mesin (outline null, perilaku lama)', () => {
    const b = build([
      { heading: 'Pendahuluan', blocks: [{ subheading: 'Latar' }, 'x'] },
      { heading: 'Analisis', blocks: ['y'] },
    ]);
    expect(b.outline).toBeNull();
    expect(b.chapters.map((c: any) => c.key)).toEqual(['1', '2']);
    expect(text((b.chapters[0] as any).sections[0].title)).toBe('Latar');
  });
});
