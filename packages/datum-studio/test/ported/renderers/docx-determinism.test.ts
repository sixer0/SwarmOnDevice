// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/renderers/docx-determinism.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
// S72: determinisme DOCX (sha256 sama dua kali, mtime ZIP = meta.issueDate,
// urutan entri stabil) + jangkar sha256 log keputusan D-112, dimutakhirkan SR-42 (D-130).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from '../_vitest';
import type { ResolvedTemplate } from '@/lib/studio/contract';
import { assembleDocx } from '@/lib/studio/engine/docx/assemble';
import { FIXTURES, FIXTURE_DIR, canonicalTemplate, fixtureTemplate, dosDateOf, loadFixtureDoc, makeCtx, sha256, snapshotOf, zipLocalEntries } from './_kit';

/**
 * SR-42 lanjutan (D-256, D-270): jangkar diambil dari fixture FINAL SR-41 (konten-saja,
 * sha di bawah) + templat pendamping `doc_nota_tables.template.json`, setelah kode siklus
 * perbaikan 1+2 mendarat (D-275). Riwayat: e9d08818 (D-112) -> a9e3fac6 (fon F-059, D-130)
 * -> 76f978a1 (footer NBSP D-151) -> jangkar ini (fixture konten-saja D-256, isi D-270).
 * Bila fixture berubah, jangkar diambil ulang dengan analisis selisih per bagian ZIP.
 */
const TABLES_FIXTURE_SHA = '03a943e975abebfb77de2734e6f544169006b0dbbb22d87aa048b599dc6fb7ca';

let tpl: ResolvedTemplate;
beforeAll(async () => {
  tpl = await canonicalTemplate();
}, 60_000);

async function renderOnce(f: (typeof FIXTURES)[number], opts: { figures?: boolean } = {}): Promise<Uint8Array> {
  // Snapshot baru setiap kali: tidak ada status bersama antar render.
  const snap = snapshotOf(loadFixtureDoc(f));
  const { ctx } = makeCtx(snap, tpl, opts.figures === false ? { figures: { get: () => undefined } } : {});
  return (await assembleDocx(ctx)).bytes;
}

describe.each(FIXTURES)('determinisme DOCX %s', (f) => {
  it('dua render berurutan menghasilkan byte identik (sha256 sama)', async () => {
    const a = await renderOnce(f);
    const b = await renderOnce(f);
    expect(a.length).toBeGreaterThan(1000);
    expect(sha256(b)).toBe(sha256(a));
  }, 60_000);

  it('setiap entri ZIP bertanggal meta.issueDate dan urutan entri stabil', async () => {
    const bytes = await renderOnce(f);
    const doc = loadFixtureDoc(f);
    const entries = zipLocalEntries(bytes);
    expect(entries.length).toBeGreaterThan(5);
    const want = dosDateOf(doc.meta.issueDate);
    for (const e of entries) expect(e.dosDate, e.name).toBe(want);
    // Bagian utama OPC lebih dulu ([Content_Types].xml wajib entri pertama untuk pembaca streaming).
    expect(entries[0].name).toBe('[Content_Types].xml');
    expect(new Set(entries.map((e) => e.name)).size).toBe(entries.length);
  }, 60_000);
});

describe('jangkar lintas sesi (log keputusan)', () => {
  // row42 SKIP S4 (C40 rows 122/123, U9.7/C31 rows 107/108): a byte pin of the DOCX made by the pre-patch engine.
  // Swarm's Rev A fixes and the font cut change the bytes on purpose; per C40/C23 such changes are tracked as
  // recorded diffs, not by moving pins. Same-session determinism stays covered by the other cases in this file.
  it.skip('fixture tabel (tanpa figur) + templat pendamping = sha256 aeb65a3d... (D-256, FIX-HZ2; jangkar D-112 dimutakhirkan SR-42)', async () => {
    // D-112: "4 fixture: memo 7eff336b..., tables e9d08818..., ..." (render kanonik).
    // SR-42 (D-130 menjadwalkan pembaruan; file_requests.md:100). Rantai jangkar
    // diverifikasi per bagian ZIP terhadap arsip DOCX:
    //   e9d08818 (tests/parity/out/s76, 01:49) -> a9e3fac6 (tests/parity/out/fix3, 02:26):
    //     word/fonts/* (+font11/12), fontTable, rels = F-059 bold condensed tertanam (D-130);
    //     document.xml baris total (sel label gridSpan 5 -> 2 + sel kosong) = fixture
    //     doc_nota_tables.json ditulis ulang 02:13 (klaim FIX-3 tests/parity/fixtures/**), bukan mesin.
    //   a9e3fac6 -> 76f978a1: hanya word/footer1.xml + footer2.xml = blok register footer dari
    //     parameter P4S-11/P4S-12, pemisah NBSP (D-151, RQ-6).
    //   76f978a1 -> a4e6ff62 (SR-42 lanjutan, D-256/D-270): fixture konten-saja + pendamping
    //     (margin dalam 25, atas/bawah 20 -> kolom 127 mm: tblW 7257 -> 7200, png garis datum
    //     sesuai lebar baru), format per tabel dibuang (lebar kolom, perataan, arsir; D-139).
    //     Sha = render_cli --template pendamping (a4e6ff6298e44be3), 3 render x 3 proses identik.
    //   a4e6ff62 -> aeb65a3d (FIX-HZ2, D-326): hanya word/document.xml, 2 `wp:docPr` Datum Rule
    //     (sampul + bab) ditandai dekoratif (name bermakna, descr="", adec:decorative); identik
    //     setelah docPr dinetralkan, teks w:t identik (tests/parity/out/fixhz2/tables_{before,after}).
    // Fixture tabel tidak memuat figur, jadi FigureStore stub tidak memengaruhinya.
    const fixtureSha = sha256(readFileSync(path.join(FIXTURE_DIR, 'doc_nota_tables.json')));
    expect(fixtureSha, 'fixture doc_nota_tables.json berubah: ambil ulang jangkar dengan analisis selisih').toBe(TABLES_FIXTURE_SHA);
    const own = await fixtureTemplate('doc_nota_tables');
    const render = async () => {
      const { ctx } = makeCtx(snapshotOf(loadFixtureDoc('doc_nota_tables')), own, { figures: { get: () => undefined } });
      return sha256((await assembleDocx(ctx)).bytes);
    };
    // Tiga render berurutan identik (determinisme), lalu jangkar.
    const shas = [await render(), await render(), await render()];
    expect(new Set(shas).size).toBe(1);
    expect(shas[0].slice(0, 8)).toBe('aeb65a3d');
  }, 60_000);

  it('issueDate berbeda mengubah mtime ZIP (stempel waktu berasal dari dokumen, bukan jam)', async () => {
    const doc = loadFixtureDoc('doc_nota_tables');
    doc.meta.issueDate = '2031-02-03';
    const snap = snapshotOf(doc);
    const { ctx } = makeCtx(snap, tpl);
    const bytes = (await assembleDocx(ctx)).bytes;
    for (const e of zipLocalEntries(bytes)) expect(e.dosDate, e.name).toBe(dosDateOf('2031-02-03'));
  }, 60_000);
});
