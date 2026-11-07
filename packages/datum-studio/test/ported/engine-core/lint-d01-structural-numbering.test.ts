// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/engine-core/lint-d01-structural-numbering.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
// D-605 (2): D01 tidak mengaudit penomoran struktural (nomor bab/subbab, label
// keterangan Tabel/Figure n.m, nomor butir/pasal, alamat bertingkat). Pada pola
// angka EN (S16-S18) "1.1" atau "2.3.1" tampak seperti desimal; pada pola ID
// tidak pernah cocok karena "." adalah pemisah ribuan bergrup 3 digit.
import { describe, it, expect, beforeAll } from '../_vitest';
import type { ResolvedTemplate } from '@/lib/studio/contract';
import { lintStructureWith } from '@/lib/studio/engine/lint/structure';
import { Register, auditText } from '@/lib/studio/engine/bind';
import { canonicalTemplate, makeDoc, snapshotOf, statuses } from './fixtures';

/** Bentuk blok fixture (`makeDoc`): objek bebas. */
type Block = Record<string, unknown>;

let KAN: ResolvedTemplate;
beforeAll(() => {
  KAN = canonicalTemplate();
});

const REGISTER = {
  'biaya pasang': { v: 1250000.5, dec: 1 as const, unit: 'Rp', mark: 'TERUKUR' as const, src: 'RAB' },
};

function lint(language: 'ID' | 'EN', opts: { chapterTitle?: string; sectionTitle?: string; blocks: Block[] }) {
  const doc = makeDoc({ tier: 'SERAH', language, register: REGISTER, ...opts });
  return lintStructureWith(snapshotOf(doc), KAN, 'SERAH', { only: ['D01'] });
}

function d01Details(issues: ReadonlyArray<{ checkId: string; status: string; detail?: string }>): string {
  return issues.filter((i) => i.checkId === 'D01').map((i) => i.detail ?? '').join('\n');
}

const para = (text: string, role?: string): Block => ({ type: 'paragraph', text, ...(role ? { role } : {}) });

function captionedTable(caption: string): Block {
  const cell = (t: string) => ({ text: t });
  return {
    type: 'table',
    caption: { inline: { text: caption } },
    source: { inline: { text: 'Project threat register.' } },
    columns: [
      { widthMm: 96, role: 'text', align: 'left' },
      { widthMm: 32, role: 'numeral', align: 'right' },
    ],
    rows: [
      { kind: 'header', cells: [cell('Item'), cell('Count')] },
      { kind: 'body', cells: [cell('Alpha'), cell('12')] },
    ],
  };
}

describe('D01 EN: penomoran struktural tidak diaudit', () => {
  it('judul bab/subbab bernomor "1.1" dan "2.3.1" -> PASS', () => {
    const r = lint('EN', {
      chapterTitle: 'Chapter 1.1 Introduction',
      sectionTitle: '2.3.1 Background',
      blocks: [para('1.1 Background', 'subheading'), para('The scope is described below.')],
    });
    expect(statuses(r, 'D01'), d01Details(r)).toEqual(['PASS']);
  });

  it('keterangan "Table 1.2" / "Figure 3.1" dan rujukan dalam prosa -> PASS', () => {
    const r = lint('EN', {
      blocks: [
        captionedTable('Table 1.2 Threat register'),
        para('As shown in Table 1.2 and Figure 3.1, see also Section 2.3.1 and clause 4.2.'),
        para('Figure 3.1 summarises the layout.'),
      ],
    });
    expect(statuses(r, 'D01')).toEqual(['PASS']);
  });

  it('nomor butir/pasal di awal baris daftar atau paragraf -> PASS', () => {
    const r = lint('EN', {
      blocks: [
        { type: 'list', items: [{ text: '3.1 Scope of supply.' }, { text: '3.2 Exclusions apply.' }] },
        para('4.2 The contractor shall submit the drawings.'),
      ],
    });
    expect(statuses(r, 'D01')).toEqual(['PASS']);
  });

  it('angka EN tak terdaftar di prosa tetap ditandai', () => {
    const r = lint('EN', { sectionTitle: '1.1 Background', blocks: [para('Section 1.1 notes the other cost of 1,250,000.25 and a ratio of 2.75.')] });
    expect([...new Set(statuses(r, 'D01'))]).toEqual(['FAIL']);
    const det = d01Details(r);
    expect(det).toContain('"1,250,000.25"');
    expect(det).toContain('"2.75"');
    expect(det).not.toContain('"1.1"');
  });

  it('angka EN terdaftar di awal judul bukan nomor (desimal bergrup ribuan) tetap diaudit', () => {
    const r = lint('EN', { sectionTitle: '1,250,000.75 budget variance', blocks: [para('Plain prose.')] });
    expect([...new Set(statuses(r, 'D01'))]).toEqual(['FAIL']);
    expect(d01Details(r)).toContain('"1,250,000.75"');
  });
});

describe('D01 ID: perilaku tidak berubah', () => {
  it('judul "1.1", keterangan "Tabel 1.2" -> PASS (seperti sebelumnya)', () => {
    const r = lint('ID', {
      sectionTitle: '1.1 Latar belakang',
      blocks: [captionedTable('Tabel 1.2 Register ancaman'), para('Lihat Gambar 3.1 dan Bagian 2.3.1.')],
    });
    expect(statuses(r, 'D01')).toEqual(['PASS']);
  });

  it('angka ID tak terdaftar, termasuk di awal judul/baris, tetap ditandai', () => {
    const r = lint('ID', {
      sectionTitle: '1.250 Kepala keluarga',
      blocks: [para('1.500 Orang menerima bantuan senilai Rp 2.750.000,5 tunai.'), para('Tabel 1.250 bukan nomor tabel.')],
    });
    expect([...new Set(statuses(r, 'D01'))]).toEqual(['FAIL']);
    const det = d01Details(r);
    for (const s of ['"1.250"', '"1.500"', '"2.750.000,5"']) expect(det).toContain(s);
  });

  it('auditText ID dengan konteks = tanpa konteks (port Python) untuk korpus judul/prosa/keterangan', () => {
    const id = new Register(REGISTER);
    const corpus = [
      '1.1 Latar belakang',
      '2.3.1 Ruang lingkup',
      'Bab 1.250 Anggaran',
      '1.250 Kepala keluarga',
      '1.250.000 Penduduk terdampak',
      'Tabel 1.2 Register ancaman; Gambar 3.1 dan Pasal 4.1-4.3.',
      'Tabel 1.250 dan Pasal 12.500,75 serta 3,5 persen.',
      '4.2 Kontraktor wajib menyerahkan Rp 1.250.000,5 dan 2.750.000,25 tunai.',
      'Nilai 1,250,000.5 (bentuk EN) dan 0,77 serta 12,5%.',
      '§2.3 dan §1.250 pada butir 1.2.345.',
    ];
    for (const text of corpus) {
      const plain = auditText(text, id);
      for (const context of ['heading', 'body'] as const) expect(auditText(text, id, [], { context }), `${context}: ${text}`).toEqual(plain);
    }
  });

  it('auditText tanpa opsi konteks = port Python apa adanya (EN)', () => {
    const en = new Register(REGISTER, 'EN');
    expect(auditText('Table 1.2 and 2.75', en).map((f) => f.text)).toEqual(['1.2', '2.75']);
  });
});

describe('auditText EN berkonteks: alamat bertingkat dan bentuk ID', () => {
  const en = () => new Register(REGISTER, 'EN');

  it('"2.3.1" dan "4.10.2" di prosa tidak menghasilkan potongan "2.3"/"4.10"', () => {
    expect(auditText('see 2.3.1 and 4.10.2; growth 2.5.', en(), [], { context: 'body' }).map((f) => f.text)).toEqual(['2.5']);
  });

  it('bentuk ID "1.250.000,5" di dokumen EN tetap ditandai', () => {
    expect(auditText('Total cost 1.250.000,5 IDR', en(), [], { context: 'body' }).map((f) => f.text)).toEqual(['1.250']);
  });

  it('awal baris prosa: desimal diikuti satuan/kata kecil tetap diaudit', () => {
    expect(auditText('2.75 tonnes were shipped.\n3.25 MW installed.', en(), [], { context: 'body' }).map((f) => f.text)).toEqual(['2.75', '3.25']);
  });
});
