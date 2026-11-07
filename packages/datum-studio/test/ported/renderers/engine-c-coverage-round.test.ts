// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/renderers/engine-c-coverage-round.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
// Ronde cakupan DATUM Rev A, baris mesin C (cetak biru identification/03 C13, C14, C16, C26;
// register research/38 R-71, R-72, R-73, R-76, R-80). Setiap param opt-in: absen atau bernilai
// bawaan = byte DOCX identik dengan keluaran sekarang. Ekspektasi berupa literal dari register
// (warna BM, teks manual), bukan dihitung ulang dari kode produksi.
import { beforeAll, describe, expect, it } from '../_vitest';
import type { ParamMap, ResolvedTemplate, StudioDocV1 } from '@/lib/studio/contract';
import { assembleDocxDetailed } from '@/lib/studio/engine/docx/assemble';
import { canonicalTemplate, loadFixtureDoc, makeCtx, partText, sha256, snapshotOf, unzip, type FixtureName } from './_kit';

type Lang = 'ID' | 'EN';

interface Out {
  bytes: Uint8Array;
  parts: Record<string, Uint8Array>;
  logs: { level: string; code?: string; message: string }[];
}

let base: ResolvedTemplate;

beforeAll(async () => {
  base = await canonicalTemplate();
});

/** Peta param templat: `set` ditimpa, `drop` dihapus (kasus "absen"). */
function tplWith(set: ParamMap = {}, drop: string[] = []): ResolvedTemplate {
  const params: Record<string, ParamMap[string]> = { ...base.params, ...set };
  for (const k of drop) delete params[k];
  return { ...base, params };
}

function docOf(fixture: FixtureName, lang: Lang): StudioDocV1 {
  const doc = JSON.parse(JSON.stringify(loadFixtureDoc(fixture))) as StudioDocV1;
  doc.meta.language = lang;
  return doc;
}

async function render(fixture: FixtureName, lang: Lang, tpl: ResolvedTemplate): Promise<Out> {
  const { ctx, logs } = makeCtx(snapshotOf(docOf(fixture, lang)), tpl);
  const detail = await assembleDocxDetailed(ctx);
  return { bytes: detail.bytes, parts: unzip(detail.bytes), logs: logs as Out['logs'] };
}

const partsMatching = (o: Out, re: RegExp): string[] =>
  Object.keys(o.parts)
    .filter((p) => re.test(p))
    .sort();

/** `w:pBdr` bawah paragraf kepala halaman (header bermode runningHead = memuat tab kanan). */
function runningHeadBottomBorders(o: Out): string[] {
  return partsMatching(o, /^word\/header\d+\.xml$/)
    .map((p) => partText(o.parts, p))
    .filter((x) => x.includes('<w:tab/>'))
    .map((x) => /<w:pBdr><w:bottom ([^/]*)\/><\/w:pBdr>/.exec(x)?.[1] ?? 'none');
}

/** Garis sel tabel register (footer bertabel): [top, bottom] per sel. */
function registerCellBorders(o: Out): { top: string; bottom: string }[] {
  const out: { top: string; bottom: string }[] = [];
  for (const p of partsMatching(o, /^word\/footer\d+\.xml$/)) {
    const x = partText(o.parts, p);
    for (const m of x.matchAll(/<w:tcBorders>(.*?)<\/w:tcBorders>/g)) {
      out.push({ top: /<w:top ([^/]*)\/>/.exec(m[1])?.[1] ?? 'none', bottom: /<w:bottom ([^/]*)\/>/.exec(m[1])?.[1] ?? 'none' });
    }
  }
  return out;
}

// ── C14 / GF-22: warna garis kepala halaman (R-72) dan garis atas register (R-73) ─────────

describe('C14 GF-22: warna garis kepala halaman dan garis atas blok register', () => {
  it.each(['ID', 'EN'] as const)('%s bawaan: kepala C3CBD1 sz 5, register atas 101418 sz 8 (keluaran sekarang)', async (lang) => {
    const o = await render('doc_terbit_report', lang, base);
    const heads = runningHeadBottomBorders(o);
    expect(heads.length).toBeGreaterThan(0);
    for (const b of heads) expect(b).toBe('w:val="single" w:sz="5" w:space="1" w:color="C3CBD1"');
    const cells = registerCellBorders(o);
    expect(cells.length).toBeGreaterThan(0);
    for (const c of cells) {
      expect(c.top).toBe('w:val="single" w:sz="8" w:space="0" w:color="101418"');
      expect(c.bottom).toBe('w:val="single" w:sz="5" w:space="0" w:color="C3CBD1"');
    }
  });

  it.each(['ID', 'EN'] as const)('%s opt-in 6E1420: kedua garis segel, ukuran dan garis bawah/kanan tetap', async (lang) => {
    const o = await render('doc_terbit_report', lang, tplWith({ 'runningHead.ruleColour': '6E1420', 'device.registerBlock.topRuleColour': '6E1420' }));
    const heads = runningHeadBottomBorders(o);
    expect(heads.length).toBeGreaterThan(0);
    for (const b of heads) expect(b).toBe('w:val="single" w:sz="5" w:space="1" w:color="6E1420"');
    const cells = registerCellBorders(o);
    expect(cells.length).toBeGreaterThan(0);
    for (const c of cells) {
      expect(c.top).toBe('w:val="single" w:sz="8" w:space="0" w:color="6E1420"');
      expect(c.bottom).toBe('w:val="single" w:sz="5" w:space="0" w:color="C3CBD1"');
    }
    const footers = partsMatching(o, /^word\/footer\d+\.xml$/).map((p) => partText(o.parts, p)).join('');
    expect(footers).toMatch(/<w:right w:val="single" w:sz="5" w:space="0" w:color="C3CBD1"\/>/);
  });

  it('kedua param independen: hanya garis kepala, atau hanya garis register', async () => {
    const onlyHead = await render('doc_terbit_report', 'ID', tplWith({ 'runningHead.ruleColour': '6E1420' }));
    expect(new Set(runningHeadBottomBorders(onlyHead))).toEqual(new Set(['w:val="single" w:sz="5" w:space="1" w:color="6E1420"']));
    expect(new Set(registerCellBorders(onlyHead).map((c) => c.top))).toEqual(new Set(['w:val="single" w:sz="8" w:space="0" w:color="101418"']));
    const onlyReg = await render('doc_terbit_report', 'ID', tplWith({ 'device.registerBlock.topRuleColour': '6E1420' }));
    expect(new Set(runningHeadBottomBorders(onlyReg))).toEqual(new Set(['w:val="single" w:sz="5" w:space="1" w:color="C3CBD1"']));
    expect(new Set(registerCellBorders(onlyReg).map((c) => c.top))).toEqual(new Set(['w:val="single" w:sz="8" w:space="0" w:color="6E1420"']));
  });

  it('hex dikanonikkan ("#6e1420" -> 6E1420); nilai tidak sah = bawaan', async () => {
    const lower = await render('doc_terbit_report', 'ID', tplWith({ 'runningHead.ruleColour': '#6e1420', 'device.registerBlock.topRuleColour': '#6e1420' }));
    expect(new Set(runningHeadBottomBorders(lower))).toEqual(new Set(['w:val="single" w:sz="5" w:space="1" w:color="6E1420"']));
    const bad = await render('doc_terbit_report', 'ID', tplWith({ 'runningHead.ruleColour': 'merah', 'device.registerBlock.topRuleColour': 42 }));
    const def = await render('doc_terbit_report', 'ID', base);
    expect(sha256(bad.bytes)).toBe(sha256(def.bytes));
  });

  it.each(['ID', 'EN'] as const)('%s absen = bawaan eksplisit = byte identik', async (lang) => {
    const keys = ['runningHead.ruleColour', 'device.registerBlock.topRuleColour'];
    const absent = await render('doc_terbit_report', lang, tplWith({}, keys));
    const explicit = await render('doc_terbit_report', lang, tplWith({ 'runningHead.ruleColour': 'C3CBD1', 'device.registerBlock.topRuleColour': '101418' }));
    const def = await render('doc_terbit_report', lang, base);
    expect(sha256(absent.bytes)).toBe(sha256(def.bytes));
    expect(sha256(explicit.bytes)).toBe(sha256(def.bytes));
  });
});

// ── C16 / CL-02 NOTA: baris "Klasifikasi : <K>" di bawah nomor dokumen (R-76) ────────────
//
// Lokasi nomor NOTA: dokumen NOTA tidak punya sampul/blok kendali, jadi nomor dokumen hanya
// dicetak di sel register pertama ("GSP · <nomor>") pada kaki setiap halaman interior. Baris
// klasifikasi menjadi paragraf tepat di bawah baris register, rata ke tepi kiri sel bernomor
// (sel register sendiri tidak berubah: RB-02/RB-04 membaca sel 1 = "GSP · <nomor>" saja).

/** Teks paragraf tingkat atas kaki halaman (di luar tabel), urut dokumen. */
function footerParagraphsOutsideTable(xml: string): string[] {
  const outside = xml.replace(/<w:tbl>.*?<\/w:tbl>/g, '');
  return [...outside.matchAll(/<w:p>(.*?)<\/w:p>/g)].map((m) => [...m[1].matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)].map((t) => t[1]).join(''));
}

function registerFooters(o: Out): string[] {
  return partsMatching(o, /^word\/footer\d+\.xml$/)
    .map((p) => partText(o.parts, p))
    .filter((x) => x.includes('<w:tbl>'));
}

const tableOf = (xml: string): string => /<w:tbl>.*?<\/w:tbl>/.exec(xml)?.[0] ?? '';

describe('C16 CL-02 NOTA: baris klasifikasi di bawah nomor dokumen', () => {
  it.each([
    ['ID', 'Klasifikasi : BIASA'],
    ['EN', 'Classification: BIASA'],
  ] as const)('%s bawaan: tidak ada baris klasifikasi', async (lang, line) => {
    const o = await render('doc_nota_memo', lang, base);
    const footers = registerFooters(o);
    expect(footers.length).toBeGreaterThan(0);
    for (const f of footers) expect(footerParagraphsOutsideTable(f)).not.toContain(line);
  });

  it.each([
    ['ID', 'Klasifikasi : ', 'BIASA'],
    ['EN', 'Classification: ', 'BIASA'],
  ] as const)('%s opt-in: "%s%s" tepat di bawah tabel register di setiap kaki interior', async (lang, label, value) => {
    const def = await render('doc_nota_memo', lang, base);
    const o = await render('doc_nota_memo', lang, tplWith({ 'render.nota.classificationLine': true }));
    const footers = registerFooters(o);
    expect(footers.length).toBe(registerFooters(def).length);
    footers.forEach((f, i) => {
      // Tabel register (sel nomor, revisi, lembar, klasifikasi) byte-identik dengan bawaan.
      expect(tableOf(f)).toBe(tableOf(registerFooters(def)[i]));
      const after = f.slice(f.indexOf('</w:tbl>') + '</w:tbl>'.length);
      const first = /^<w:p>(.*?)<\/w:p>/.exec(after)?.[1] ?? '';
      const runs = [...first.matchAll(/<w:r>(.*?)<\/w:r>/g)].map((m) => m[1]);
      expect(runs).toHaveLength(2);
      expect(runs[0]).toContain(`<w:t xml:space="preserve">${label}</w:t>`);
      expect(runs[0]).toContain('<w:color w:val="6B7783"/>');
      expect(runs[0]).not.toContain('<w:b/>');
      // Nilai: kapital, tebal, warna segel color.wrapper.seal (DT-28d, 6E1420).
      expect(runs[1]).toContain(`>${value}</w:t>`);
      expect(runs[1]).toContain('<w:b/>');
      expect(runs[1]).toContain('<w:color w:val="6E1420"/>');
      expect(footerParagraphsOutsideTable(f)).toContain(`${label}${value}`);
    });
  });

  it('klasifikasi ditulis kapital (classificationMarkText)', async () => {
    const doc = docOf('doc_nota_memo', 'ID');
    doc.meta.classification = 'terbatas';
    const { ctx } = makeCtx(snapshotOf(doc), tplWith({ 'render.nota.classificationLine': true }));
    const o = unzip((await assembleDocxDetailed(ctx)).bytes);
    const f = Object.keys(o).filter((p) => /^word\/footer\d+\.xml$/.test(p)).map((p) => partText(o, p)).filter((x) => x.includes('<w:tbl>'));
    expect(f.length).toBeGreaterThan(0);
    for (const x of f) expect(footerParagraphsOutsideTable(x)).toContain('Klasifikasi : TERBATAS');
  });

  it('hanya kaki bertabel register yang mendapat baris (kaki pembungkus kosong tetap)', async () => {
    const def = await render('doc_terbit_report', 'ID', base);
    const o = await render('doc_terbit_report', 'ID', tplWith({ 'render.nota.classificationLine': true }));
    for (const p of partsMatching(o, /^word\/footer\d+\.xml$/)) {
      const x = partText(o.parts, p);
      if (x.includes('<w:tbl>')) expect(footerParagraphsOutsideTable(x)).toContain('Klasifikasi : TERBATAS');
      else expect(x).toBe(partText(def.parts, p));
    }
  });

  it.each(['ID', 'EN'] as const)('%s absen = false = byte identik', async (lang) => {
    const def = await render('doc_nota_memo', lang, base);
    const absent = await render('doc_nota_memo', lang, tplWith({}, ['render.nota.classificationLine']));
    const off = await render('doc_nota_memo', lang, tplWith({ 'render.nota.classificationLine': false }));
    expect(sha256(absent.bytes)).toBe(sha256(def.bytes));
    expect(sha256(off.bytes)).toBe(sha256(def.bytes));
  });
});

// ── C26 / RB-08c: penomoran lembar mulai 1 di halaman pertama Bab 1 (R-80 = "bab1") ──────

/** sectPr dokumen berurutan, masing-masing dengan teks kepala halaman yang dirujuknya. */
function sectionsWithHeaders(o: Out): { sectPr: string; header: string }[] {
  const doc = partText(o.parts, 'word/document.xml');
  const rels = partText(o.parts, 'word/_rels/document.xml.rels');
  const target = new Map([...rels.matchAll(/<Relationship Id="([^"]+)" Type="[^"]+\/header" Target="([^"]+)"\/>/g)].map((m) => [m[1], m[2]]));
  return [...doc.matchAll(/<w:sectPr>(.*?)<\/w:sectPr>/g)].map((m) => {
    const rid = /<w:headerReference w:type="default" r:id="([^"]+)"\/>/.exec(m[1])?.[1] ?? '';
    const hdr = partText(o.parts, `word/${target.get(rid)}`);
    return { sectPr: m[1], header: [...hdr.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)].map((t) => t[1]).join('') };
  });
}

describe('C26 RB-08c: nomor lembar mulai 1 di Bab 1', () => {
  // row42 ADAPT A6 (C40, row 122 CP-11; sheetNumberingFromChapter1(params, language)): an ID document now always
  // restarts at Bab 1 (Rev A ID p.48); EN keeps counting from the cover unless R-80 = "bab1". The "no restart by
  // default" claim is therefore checked on EN, and ID default is checked to carry exactly one restart.
  it('bawaan "dokumen": tanpa w:pgNumType', async () => {
    const o = await render('doc_terbit_report', 'EN', base);
    expect(partText(o.parts, 'word/document.xml')).not.toContain('w:pgNumType');
    const id = await render('doc_terbit_report', 'ID', base);
    expect(partText(id.parts, 'word/document.xml').match(/<w:pgNumType [^>]*\/>/g)).toEqual(['<w:pgNumType w:start="1"/>']);
  });

  it.each([
    ['ID', 'Bab 1 ·'],
    ['EN', 'Chapter 1 ·'],
  ] as const)('%s "bab1": satu pgNumType start=1 tepat di seksi Bab 1, urutan CT_SectPr (pgMar < pgNumType < cols)', async (lang, chapterLabel) => {
    const o = await render('doc_terbit_report', lang, tplWith({ 'device.registerBlock.sheetNumbering': 'bab1' }));
    const doc = partText(o.parts, 'word/document.xml');
    expect(doc.match(/<w:pgNumType [^>]*\/>/g)).toEqual(['<w:pgNumType w:start="1"/>']);
    const secs = sectionsWithHeaders(o);
    const withStart = secs.filter((s) => s.sectPr.includes('w:pgNumType'));
    expect(withStart).toHaveLength(1);
    expect(withStart[0].header.toUpperCase()).toContain(chapterLabel.toUpperCase());
    // Seksi sebelumnya (sampul, lembar kendali, daftar isi) tanpa nomor lembar: tidak ada kepala bab.
    const idx = secs.indexOf(withStart[0]);
    expect(idx).toBeGreaterThan(0);
    for (const s of secs.slice(0, idx)) expect(s.header.toUpperCase()).not.toContain(chapterLabel.toUpperCase());
    expect(withStart[0].sectPr).toMatch(/<w:pgMar [^>]*\/><w:pgNumType w:start="1"\/><w:cols /);
  });

  it('kaki halaman tidak berubah: sel 3 tetap PAGE lalu NUMPAGES (CR-4), seksi pembungkus tetap tanpa medan', async () => {
    // row42 ADAPT A6 (C40, row 122 CP-11): compared on EN, where the default still has no restart (see above).
    const def = await render('doc_terbit_report', 'EN', base);
    const o = await render('doc_terbit_report', 'EN', tplWith({ 'device.registerBlock.sheetNumbering': 'bab1' }));
    const footers = partsMatching(o, /^word\/(?:footer|header)\d+\.xml$/);
    expect(footers).toEqual(partsMatching(def, /^word\/(?:footer|header)\d+\.xml$/));
    for (const p of footers) expect(partText(o.parts, p)).toBe(partText(def.parts, p));
    const reg = registerFooters(o)[0];
    const fields = [...reg.matchAll(/w:instr=" (\w+) "/g)].map((m) => m[1]);
    expect(fields).toEqual(['PAGE', 'NUMPAGES']);
    // Selain sisipan pgNumType, document.xml sama persis.
    expect(partText(o.parts, 'word/document.xml').replace('<w:pgNumType w:start="1"/>', '')).toBe(partText(def.parts, 'word/document.xml'));
  });

  it('NOTA (tanpa pembungkus): Bab 1 = seksi pertama', async () => {
    const o = await render('doc_nota_memo', 'ID', tplWith({ 'device.registerBlock.sheetNumbering': 'bab1' }));
    const secs = sectionsWithHeaders(o);
    expect(secs[0].sectPr).toContain('<w:pgNumType w:start="1"/>');
    expect(secs.filter((s) => s.sectPr.includes('w:pgNumType'))).toHaveLength(1);
  });

  it.each(['ID', 'EN'] as const)('%s absen = "dokumen" = nilai tak dikenal = byte identik', async (lang) => {
    const def = await render('doc_terbit_report', lang, base);
    const absent = await render('doc_terbit_report', lang, tplWith({}, ['device.registerBlock.sheetNumbering']));
    const doc = await render('doc_terbit_report', lang, tplWith({ 'device.registerBlock.sheetNumbering': 'dokumen' }));
    const odd = await render('doc_terbit_report', lang, tplWith({ 'device.registerBlock.sheetNumbering': 'bab2' }));
    for (const x of [absent, doc, odd]) expect(sha256(x.bytes)).toBe(sha256(def.bytes));
  });
});

// ── C13 / GF-19: latar halaman DOCX dari color.interior.paper (R-71) ──────────────────────
//
// research/36: LibreOffice 24.2 menghormati `w:background` (document.xml, sebelum `w:body`) hanya
// bersama `w:displayBackgroundShape` (settings.xml, sesudah `w:zoom`); satu warna per dokumen.

describe('C13 GF-19: latar halaman DOCX', () => {
  it.each(['ID', 'EN'] as const)('%s bawaan: tanpa w:background dan tanpa w:displayBackgroundShape', async (lang) => {
    const o = await render('doc_terbit_report', lang, base);
    expect(partText(o.parts, 'word/document.xml')).not.toContain('w:background');
    expect(partText(o.parts, 'word/settings.xml')).not.toContain('displayBackgroundShape');
  });

  it.each(['ID', 'EN'] as const)('%s opt-in: w:background FCFCFB tepat sebelum w:body + displayBackgroundShape sesudah w:zoom', async (lang) => {
    const def = await render('doc_terbit_report', lang, base);
    const o = await render('doc_terbit_report', lang, tplWith({ 'render.docx.pageBackground': true }));
    const doc = partText(o.parts, 'word/document.xml');
    expect(doc.match(/<w:background [^>]*\/>/g)).toEqual(['<w:background w:color="FCFCFB"/>']);
    expect(doc).toContain('<w:background w:color="FCFCFB"/><w:body>');
    expect(doc.replace('<w:background w:color="FCFCFB"/>', '')).toBe(partText(def.parts, 'word/document.xml'));
    const settings = partText(o.parts, 'word/settings.xml');
    expect(settings).toContain('<w:zoom w:val="bestFit"/><w:displayBackgroundShape/>');
    expect(settings.replace('<w:displayBackgroundShape/>', '')).toBe(partText(def.parts, 'word/settings.xml'));
  });

  it('warna = color.interior.paper efektif (satu warna untuk seluruh dokumen)', async () => {
    const o = await render('doc_nota_memo', 'ID', tplWith({ 'render.docx.pageBackground': true, 'color.interior.paper': 'FFE0E0' }));
    expect(partText(o.parts, 'word/document.xml').match(/<w:background [^>]*\/>/g)).toEqual(['<w:background w:color="FFE0E0"/>']);
  });

  it('warna kertas tidak terbaca: tidak ada latar dan tidak ada displayBackgroundShape (keduanya atau tidak sama sekali)', async () => {
    const def = await render('doc_nota_memo', 'ID', tplWith({ 'color.interior.paper': 'bukan-hex' }));
    const o = await render('doc_nota_memo', 'ID', tplWith({ 'render.docx.pageBackground': true, 'color.interior.paper': 'bukan-hex' }));
    expect(sha256(o.bytes)).toBe(sha256(def.bytes));
  });

  it.each(['ID', 'EN'] as const)('%s absen = false = byte identik', async (lang) => {
    const def = await render('doc_terbit_report', lang, base);
    const absent = await render('doc_terbit_report', lang, tplWith({}, ['render.docx.pageBackground']));
    const off = await render('doc_terbit_report', lang, tplWith({ 'render.docx.pageBackground': false }));
    expect(sha256(absent.bytes)).toBe(sha256(def.bytes));
    expect(sha256(off.bytes)).toBe(sha256(def.bytes));
  });
});
