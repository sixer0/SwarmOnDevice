// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/renderers/c08-c12-wrapper-opt-ins.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
/* eslint-disable @typescript-eslint/no-explicit-any -- fixture JSON kontrak dibaca bebas-bentuk di uji */
// Ronde cakupan DATUM Rev A, baris mesin pembungkus DOCX (register research/38; D-631, D-635):
//  - C08 / CS-12: `controlSheet.subtitle.enabled` (R-67) = subjudul lembar kendali dari tabel teks, sesudah judul;
//  - C09 / CS-06: `controlSheet.signatures.fillRoles` (R-68) = selalu tiga kolom tanda tangan;
//  - C11 / CV-20: `cover.title.maxWidthMm` (R-70) = jorokan kanan peran judul sampul;
//  - C12 / CV-19: `device.spine.placements` berisi "sampul belakang" = renderer sampul belakang.
// Setiap opt-in: absen = bawaan eksplisit = keluaran sekarang, byte-identik (C-3, research/35 §5).
import { describe, expect, it } from '../_vitest';
import type { NormBlock, ResolvedTemplate, StudioDocV1 } from '@/lib/studio/contract';
import { assembleDocxDetailed } from '@/lib/studio/engine/docx/assemble';
import { WRAPPER_TEXT, spineTextOf } from '@/lib/studio/engine/front/texts';
import { docxWrapper } from '@/lib/studio/engine/docx/wrapper';
import { backCoverPlaced, renderBackCover } from '@/lib/studio/engine/docx/wrapper/pages';
import { withParams } from '../engine-core/fixtures';
import { canonicalTemplate, loadFixtureDoc, makeCtx, partText, sha256, snapshotOf, unzip } from './_kit';

type Lang = 'ID' | 'EN';

function terbit(lang: Lang, mutate?: (d: any) => void): StudioDocV1 {
  const doc = JSON.parse(JSON.stringify(loadFixtureDoc('doc_terbit_report'))) as any;
  doc.meta.language = lang;
  mutate?.(doc);
  return doc as StudioDocV1;
}

async function tplWith(extra: Record<string, unknown>): Promise<ResolvedTemplate> {
  return withParams(await canonicalTemplate(), extra);
}

async function render(lang: Lang, extra: Record<string, unknown> = {}, mutate?: (d: any) => void): Promise<{ sha: string; xml: string }> {
  const detail = await assembleDocxDetailed(makeCtx(snapshotOf(terbit(lang, mutate)), await tplWith(extra)).ctx);
  return { sha: sha256(detail.bytes), xml: partText(unzip(detail.bytes), 'word/document.xml') };
}

const textOf = (xml: string): string => [...xml.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]).join('');
/** Paragraf berurutan dokumen (termasuk paragraf sel), dengan teksnya. */
const paragraphs = (xml: string): Array<{ xml: string; text: string }> =>
  [...xml.matchAll(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>|<w:p\/>/g)].map((m) => ({ xml: m[0], text: textOf(m[0]) }));

describe('C08 / CS-12: subjudul lembar kendali (controlSheet.subtitle.enabled)', () => {
  for (const lang of ['ID', 'EN'] as const) {
    it(`${lang}: opt-in mencetak subjudul tabel teks tepat sesudah judul lembar kendali`, async () => {
      const { xml } = await render(lang, { 'controlSheet.subtitle.enabled': true });
      const ps = paragraphs(xml);
      const sub = WRAPPER_TEXT.controlSubtitle[lang];
      const hits = ps.filter((p) => p.text === sub);
      expect(hits).toHaveLength(1);
      const i = ps.findIndex((p) => p.text === sub);
      // CS-02: dua paragraf tak kosong pertama lembar kendali = kicker lalu judul; subjudul sesudahnya.
      expect(ps[i - 1].text).toBe('Kendali dokumen');
      // Peran yang ada `cover.standfirst` (register §1.3): serif miring.
      expect(ps[i].xml).toMatch(/<w:i\/>/);
    });

    it(`${lang}: absen dan false byte-identik, tanpa subjudul`, async () => {
      const absent = await render(lang);
      const off = await render(lang, { 'controlSheet.subtitle.enabled': false });
      expect(off.sha).toBe(absent.sha);
      expect(textOf(absent.xml)).not.toContain(WRAPPER_TEXT.controlSubtitle[lang]);
    });
  }
});

/** Tabel tanda tangan (tabel datar pertama yang memuat teks `marker`): teks sel per baris + jumlah kolom grid. */
function signatureTable(xml: string, marker: string): { cols: number; rows: string[][] } {
  const tbl = [...xml.matchAll(/<w:tbl>[\s\S]*?<\/w:tbl>/g)].map((m) => m[0]).find((t) => textOf(t).includes(marker));
  if (!tbl) throw new Error(`tabel tanda tangan dengan "${marker}" tidak ditemukan`);
  const rows = [...tbl.matchAll(/<w:tr(?:\s[^>]*)?>[\s\S]*?<\/w:tr>/g)].map((r) => [...r[0].matchAll(/<w:tc>[\s\S]*?<\/w:tc>/g)].map((c) => textOf(c[0])));
  return { cols: (tbl.match(/<w:gridCol /g) ?? []).length, rows };
}

const role = (r: string, holder: string, date?: string) => ({ role: { text: r }, holder: { text: holder }, ...(date ? { date: { text: date } } : {}) });

describe('C09 / CS-06: selalu tiga kolom tanda tangan (controlSheet.signatures.fillRoles)', () => {
  const FILL = { 'controlSheet.signatures.fillRoles': true };

  it('ID, 1 peran: tiga kolom, peran yang tidak dikirim berlabel bawaan dengan pemegang kosong', async () => {
    const one = (d: any) => (d.front.signature.roles = [role('Disusun', 'Penyusun laporan', '2026-10-20')]);
    const { xml } = await render('ID', FILL, one);
    const t = signatureTable(xml, 'Penyusun laporan');
    expect(t.cols).toBe(3);
    expect(t.rows[0]).toEqual(['Disusun', 'Diperiksa', 'Disetujui']);
    expect(t.rows[1]).toEqual(['', '', '']); // ruang tanda tangan tetap kosong (LB-06/TR-03)
    expect(t.rows[2]).toEqual(['Penyusun laporan', '', '']);
    expect(t.rows[3]).toEqual(['2026-10-20', '', '']);
  });

  it('ID, 2 peran tanpa pemeriksa: peran dikirim menempati kolomnya menurut label, bukan posisi', async () => {
    const two = (d: any) => (d.front.signature.roles = [role('Disusun', 'Penyusun laporan'), role('Disetujui', 'Kepala fasilitas')]);
    const { xml } = await render('ID', FILL, two);
    const t = signatureTable(xml, 'Penyusun laporan');
    expect(t.cols).toBe(3);
    expect(t.rows[0]).toEqual(['Disusun', 'Diperiksa', 'Disetujui']);
    expect(t.rows[2]).toEqual(['Penyusun laporan', '', 'Kepala fasilitas']);
    expect(t.rows).toHaveLength(3); // tanpa tanggal = tanpa baris tanggal (perilaku sekarang)
  });

  it('EN, 2 peran: label bawaan berbahasa EN dari tabel teks', async () => {
    const two = (d: any) => (d.front.signature.roles = [role('Prepared by', 'Report author'), role('Reviewed by', 'Technical reviewer')]);
    const { xml } = await render('EN', FILL, two);
    const t = signatureTable(xml, 'Report author');
    expect(t.cols).toBe(3);
    expect(t.rows[0]).toEqual(['Prepared by', 'Reviewed by', 'Approved by']);
    expect(t.rows[2]).toEqual(['Report author', 'Technical reviewer', '']);
  });

  it('EN, 1 peran berlabel tak dikenal: mengisi kolom kosong pertama, sisanya label bawaan', async () => {
    const one = (d: any) => (d.front.signature.roles = [role('Author', 'Report author')]);
    const { xml } = await render('EN', FILL, one);
    const t = signatureTable(xml, 'Report author');
    expect(t.rows[0]).toEqual(['Author', 'Reviewed by', 'Approved by']);
    expect(t.rows[2]).toEqual(['Report author', '', '']);
  });

  for (const lang of ['ID', 'EN'] as const) {
    it(`${lang}: absen dan false byte-identik; 1 peran tetap satu kolom`, async () => {
      const one = (d: any) => (d.front.signature.roles = [role('Disusun', 'Penyusun laporan')]);
      const absent = await render(lang, {}, one);
      const off = await render(lang, { 'controlSheet.signatures.fillRoles': false }, one);
      expect(off.sha).toBe(absent.sha);
      expect(signatureTable(absent.xml, 'Penyusun laporan').cols).toBe(1);
    });

    it(`${lang}: payload tiga peran, opt-in = keluaran sekarang byte-identik`, async () => {
      const absent = await render(lang);
      const on = await render(lang, FILL);
      expect(on.sha).toBe(absent.sha);
    });
  }
});

describe('C11 / CV-20: lebar maksimum judul sampul (cover.title.maxWidthMm)', () => {
  const TITLE = ['Kajian pemantauan', 'suhu ruang server'];
  const titleParas = (xml: string) => paragraphs(xml).filter((p) => TITLE.includes(p.text));

  for (const lang of ['ID', 'EN'] as const) {
    it(`${lang}: 150 mm = jorokan kanan 907 tw (166 - 150 = 16 mm) pada kedua peran judul`, async () => {
      const { xml } = await render(lang, { 'cover.title.maxWidthMm': 150 });
      const ps = titleParas(xml);
      expect(ps).toHaveLength(2); // cover.titleFirst + cover.titleLast
      for (const p of ps) expect(p.xml).toMatch(/<w:ind\s[^>]*w:right="907"/);
    });

    it(`${lang}: absen dan null byte-identik, judul tanpa jorokan kanan`, async () => {
      const absent = await render(lang);
      const nul = await render(lang, { 'cover.title.maxWidthMm': null });
      expect(nul.sha).toBe(absent.sha);
      for (const p of titleParas(absent.xml)) expect(p.xml).not.toMatch(/w:right=/);
    });
  }

  it('lebar mengikuti grid.fullSpanMm: 120 mm pada bentang 166 = 46 mm = 2608 tw', async () => {
    const { xml } = await render('ID', { 'cover.title.maxWidthMm': 120 });
    for (const p of titleParas(xml)) expect(p.xml).toMatch(/<w:ind\s[^>]*w:right="2608"/);
  });
});

describe('C12 / CV-19: sampul belakang dengan string punggung (device.spine.placements "sampul belakang")', () => {
  const PLACED = { 'device.spine.placements': ['margin luar sampul', 'pembatas', 'sampul belakang'] };

  it('predikat backCoverPlaced: hanya dengan nilai enum baru dan string punggung aktif', () => {
    expect(backCoverPlaced({})).toBe(false); // bawaan registri: dua tempat
    expect(backCoverPlaced({ 'device.spine.placements': ['margin luar sampul', 'pembatas'] })).toBe(false);
    expect(backCoverPlaced(PLACED)).toBe(true);
    expect(backCoverPlaced({ 'device.spine.placements': ['sampul belakang'] })).toBe(true);
    expect(backCoverPlaced({ ...PLACED, 'device.spine.enabled': false })).toBe(false);
  });

  it('renderer terdaftar di peta pembungkus DOCX dengan kunci "backCover"', () => {
    expect(typeof renderBackCover).toBe('function');
    expect(docxWrapper.backCover).toBe(renderBackCover);
  });

  async function renderBack(lang: Lang, extra: Record<string, unknown>) {
    const snap = snapshotOf(terbit(lang));
    const tpl = await tplWith(extra);
    const { ctx, logs } = makeCtx(snap, tpl);
    const block: NormBlock = {
      blockId: 'F:backCover:auto:0',
      address: 'F:backCover',
      ordinal: 999,
      unitKey: 'F:backCover',
      type: 'backCover',
      content: { mode: 'auto' },
      textPlain: '',
      contentSha256: '',
    };
    return { xml: renderBackCover(block, ctx).xml, spine: spineTextOf(snap.doc.meta, tpl.params), logs };
  }

  for (const lang of ['ID', 'EN'] as const) {
    it(`${lang}: halaman hanya memuat string punggung berputar yang sama dengan sampul, tanpa teks lain`, async () => {
      const { xml, spine } = await renderBack(lang, PLACED);
      expect(spine).toContain(lang); // medan bahasa string punggung
      expect((xml.match(/<w:textDirection w:val="tbRl"\/>/g) ?? []).length).toBe(1);
      expect(textOf(xml)).toBe(spine); // register §3.4: tanpa teks sampul belakang lain
      expect(xml).toMatch(/<w:caps\/>/);
      // RB-07/RB-08: tanpa PAGE/NUMPAGES; batas seksi milik perakit.
      expect(xml).not.toMatch(/PAGE|NUMPAGES|<w:sectPr/);
      // Tabel mengambang diikuti paragraf jangkar (sampul belakang = unit terakhir, sebelum sectPr badan).
      expect(xml.endsWith('</w:p>') || xml.endsWith('<w:p/>')).toBe(true);
    });
  }

  it('tanpa nilai "sampul belakang": renderer tidak memasang string punggung dan mencatat peringatan', async () => {
    const { xml, logs } = await renderBack('ID', {});
    expect(xml).not.toMatch(/tbRl/);
    expect(logs.some((l) => l.level === 'warn' && /sampul belakang/.test(l.message))).toBe(true);
  });

  it('dokumen penuh tanpa opt-in: tidak ada blok sampul belakang, keluaran = bawaan eksplisit', async () => {
    const absent = await render('ID');
    const explicitDefault = await render('ID', { 'device.spine.placements': ['margin luar sampul', 'pembatas'] });
    expect(explicitDefault.sha).toBe(absent.sha);
  });
});
