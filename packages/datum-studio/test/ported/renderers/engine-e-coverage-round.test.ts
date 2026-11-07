// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/renderers/engine-e-coverage-round.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
/* eslint-disable @typescript-eslint/no-explicit-any -- fixture JSON kontrak dibaca bebas-bentuk di uji */
// Ronde cakupan DATUM Rev A, baris mesin E (cetak biru identification/03 C20, C19; register
// research/38 R-75 `render.rail.reserveColumn`, R-74 `render.rhythm.snapToBaseline`).
// Setiap param opt-in: absen atau bernilai bawaan (false) = byte DOCX identik dengan keluaran
// sekarang. Ekspektasi berupa literal dari manual/register: rel 32 mm + gutter 6 mm = 2154 tw
// (EN:2731 "Full span 128 + 6 + 32 = 166 mm"), garis dasar 13,5 pt = 270 tw (ID:2680-2685).
import { beforeAll, describe, expect, it } from '../_vitest';
import type { NormDocSnapshot, ParamMap, ResolvedTemplate, StudioDocV1 } from '@/lib/studio/contract';
import { assembleDocxDetailed } from '@/lib/studio/engine/docx/assemble';
import { composeV2 } from '@/lib/studio/services/compose';
import { withParams } from '../engine-core/fixtures';
import { datumSlots, defaultParams, e1, merge, skeletonInput } from '../structure/_kit';
import { benchmarkTemplate, canonicalTemplate, loadFixtureDoc, makeCtx, parseXml, partText, sha256, snapshotOf, TABLE_FAMILY, unzip } from './_kit';

type Lang = 'ID' | 'EN';
const RESERVE = 'render.rail.reserveColumn';
/** 6 mm gutter + 32 mm rel (twip), literal register R-75 / manual EN:2731. */
const RESERVE_TW = '2154';

let CANON: ResolvedTemplate;
let GSP: ResolvedTemplate;
let BENCH: ResolvedTemplate;

beforeAll(async () => {
  CANON = await canonicalTemplate();
  BENCH = await benchmarkTemplate();
  // datum-gsp = profil benchmark + perender framePr (pola fixr1-rail-k2).
  GSP = withParams(BENCH, { 'render.rail.renderer': 'framePr' });
});

function tplWith(base: ResolvedTemplate, set: ParamMap = {}, drop: string[] = []): ResolvedTemplate {
  const params: Record<string, ParamMap[string]> = { ...base.params, ...set };
  for (const k of drop) delete params[k];
  return { ...base, params };
}

function fixtureDoc(lang: Lang): StudioDocV1 {
  const doc = JSON.parse(JSON.stringify(loadFixtureDoc('doc_terbit_report'))) as StudioDocV1;
  doc.meta.language = lang;
  return doc;
}

interface Out {
  bytes: Uint8Array;
  xml: string;
  logs: { level: string; code?: string; message: string }[];
}

async function renderSnap(snap: NormDocSnapshot, tpl: ResolvedTemplate): Promise<Out> {
  const { ctx, logs } = makeCtx(snap, tpl);
  const detail = await assembleDocxDetailed(ctx);
  return { bytes: detail.bytes, xml: partText(unzip(detail.bytes), 'word/document.xml'), logs: logs as Out['logs'] };
}

const renderFixture = (lang: Lang, tpl: ResolvedTemplate) => renderSnap(snapshotOf(fixtureDoc(lang)), tpl);

/** Dokumen v2 E1 + rel di paragraf pertama bab 1, satu paragraf polos dan satu daftar tanpa rel. */
const HOST_TEXT = 'Survei mendata kondisi peralatan 150 kV.';
const PLAIN_TEXT = 'Paragraf prosa tanpa provenans.';
function composeDoc(): NormDocSnapshot {
  const d = e1();
  const blocks = d.sections.content.chapters[0].sections[0].blocks;
  blocks[0].rail = [
    { kind: 'mark', mark: 'TERUKUR' },
    { kind: 'source', text: 'Register P-40' },
  ];
  blocks.push({ type: 'paragraph', text: PLAIN_TEXT });
  blocks.push({ type: 'list', style: 'bullet', items: [{ text: 'Butir daftar satu.' }, { text: 'Butir daftar dua.' }] });
  const slots = datumSlots();
  return composeV2({ source: merge(d, undefined, { slots }).doc, skeleton: skeletonInput(slots), params: defaultParams() }).snapshot as unknown as NormDocSnapshot;
}

const paragraphsXml = (xml: string) => xml.match(/<w:p[ >][\s\S]*?<\/w:p>/g) ?? [];
const textOf = (p: string) => (p.match(/<w:t[^>]*>[^<]*<\/w:t>/g) ?? []).map((t) => t.replace(/<[^>]+>/g, '')).join('');
const rightOf = (p: string) => /<w:ind\b[^>]*\bw:right="(\d+)"/.exec(p)?.[1];
/** Potongan document.xml per seksi (akhir seksi = `</w:sectPr>`). */
const sectionChunks = (xml: string) => xml.split('</w:sectPr>');
const all = (xml: string, re: RegExp) => [...xml.matchAll(re)].map((m) => m[0]);

// ── C20 / GF-24: kolom rel 32 mm dicadangkan di setiap halaman interior ──────────────────────

describe('C20 GF-24: render.rail.reserveColumn (badan 128 mm pada perender framePr)', () => {
  it.each(['ID', 'EN'] as const)('%s: absen = false = keluaran sekarang (sha256 identik)', async (lang) => {
    const absent = await renderFixture(lang, tplWith(CANON, {}, [RESERVE]));
    const off = await renderFixture(lang, tplWith(CANON, { [RESERVE]: false }));
    const now = await renderFixture(lang, CANON);
    expect(sha256(off.bytes)).toBe(sha256(absent.bytes));
    expect(sha256(now.bytes)).toBe(sha256(absent.bytes));
  }, 60_000);

  it.each(['ID', 'EN'] as const)('%s: paragraf badan tanpa rel menyempit w:right=2154; inang + chip tetap', async (lang) => {
    const on = await renderFixture(lang, tplWith(CANON, { [RESERVE]: true }));
    expect(parseXml(on.xml).errors).toEqual([]);
    const paras = paragraphsXml(on.xml);
    // Paragraf tanpa rel (fixture: identitas, pivot, aksi penutup) = badan 128 mm.
    for (const t of ['Kajian ini disusun Tim Infrastruktur', 'Penambahan satu unit pendingin 7 kW', 'Mohon manajemen operasi menyetujui']) {
      const p = paras.find((x) => textOf(x).startsWith(t));
      expect(p, t).toBeDefined();
      expect(rightOf(p!), t).toBe(RESERVE_TW);
    }
    // Inang rel tetap diikuti chip framePr di kolom rel.
    const host = paras.findIndex((x) => textOf(x).startsWith('Suhu rata-rata jam sibuk'));
    expect(rightOf(paras[host])).toBe(RESERVE_TW);
    expect(paras[host + 1]).toContain('<w:framePr w:w="1814" w:wrap="none" w:hAnchor="margin" w:x="7597"/>');
    // Kepala section juga di badan 128 mm.
    const heads = paras.filter((x) => x.includes('<w:outlineLvl w:val="1"/>'));
    expect(heads.length).toBeGreaterThan(0);
    for (const h of heads) expect(rightOf(h)).toBe(RESERVE_TW);
  }, 60_000);

  it.each(['ID', 'EN'] as const)('%s: tanpa chip = tidak ada paragraf badan di kolom rel; margin seksi, tabel dan gambar tidak berubah', async (lang) => {
    const off = await renderFixture(lang, CANON);
    const on = await renderFixture(lang, tplWith(CANON, { [RESERVE]: true }));
    // GF-02/GF-03: margin seksi tetap (register §6.3), rel dicadangkan lewat lebar paragraf.
    expect(all(on.xml, /<w:pgMar [^>]*\/>/g)).toEqual(all(off.xml, /<w:pgMar [^>]*\/>/g));
    // Penjaga lebar tabel dan gambar (G2, GF-10/GF-11): lebar tidak berubah, tidak ada yang > 166 mm.
    expect(all(on.xml, /<w:tblW [^>]*\/>/g)).toEqual(all(off.xml, /<w:tblW [^>]*\/>/g));
    expect(all(on.xml, /<w:gridCol [^>]*\/>/g)).toEqual(all(off.xml, /<w:gridCol [^>]*\/>/g));
    expect(all(on.xml, /<wp:extent [^>]*\/>/g)).toEqual(all(off.xml, /<wp:extent [^>]*\/>/g));
    for (const m of on.xml.matchAll(/<w:tblW w:w="(\d+)"/g)) expect(Number(m[1])).toBeLessThanOrEqual(9412);
    for (const m of on.xml.matchAll(/<wp:extent cx="(\d+)"/g)) expect(Number(m[1])).toBeLessThanOrEqual(166 * 36000);
    expect(on.logs.some((l) => l.code === 'BY_CONSTRUCTION_FAILED')).toBe(false);
  }, 60_000);

  it.each(['ID', 'EN'] as const)('%s: seksi pembungkus (sampul, lembar kendali, daftar isi) byte identik', async (lang) => {
    const off = sectionChunks((await renderFixture(lang, CANON)).xml);
    const on = sectionChunks((await renderFixture(lang, tplWith(CANON, { [RESERVE]: true }))).xml);
    expect(on.length).toBe(off.length);
    const firstDiff = on.findIndex((c, i) => c !== off[i]);
    expect(firstDiff).toBeGreaterThan(0);
    // Seksi berbeda pertama memuat bab (kepala section outlineLvl 1), bukan pembungkus.
    expect(on[firstDiff]).toContain('<w:outlineLvl w:val="1"/>');
    for (let i = 0; i < firstDiff; i++) expect(on[i]).not.toContain('<w:outlineLvl w:val="1"/>');
  }, 60_000);

  it('datum-gsp (v2 E1): paragraf polos dan butir daftar menyempit; gerbang G-RAIL-3 tetap lulus untuk inang + chip', async () => {
    const out = await renderSnap(composeDoc(), tplWith(GSP, { [RESERVE]: true }));
    const paras = paragraphsXml(out.xml);
    const host = paras.findIndex((p) => textOf(p) === HOST_TEXT);
    expect(rightOf(paras[host])).toBe(RESERVE_TW);
    expect(paras[host + 1]).toContain('<w:framePr ');
    expect(rightOf(paras.find((p) => textOf(p) === PLAIN_TEXT)!)).toBe(RESERVE_TW);
    for (const t of ['Butir daftar satu.', 'Butir daftar dua.']) expect(rightOf(paras.find((p) => textOf(p).endsWith(t))!)).toBe(RESERVE_TW);
    expect(out.logs.some((l) => /G-RAIL-3 rev B \(K2\) lulus/.test(l.message))).toBe(true);
  }, 60_000);

  it('perender table3col (Manual 000) dan rel dimatikan: opt-in tidak mengubah byte', async () => {
    const snap = composeDoc();
    const t3off = await renderSnap(snap, BENCH);
    const t3on = await renderSnap(snap, tplWith(BENCH, { [RESERVE]: true }));
    expect(sha256(t3on.bytes)).toBe(sha256(t3off.bytes));
    const railOff = tplWith(GSP, { 'device.evidenceRail.enabled': false });
    const bOff = await renderSnap(snap, railOff);
    const bOn = await renderSnap(snap, tplWith(railOff, { [RESERVE]: true }));
    expect(sha256(bOn.bytes)).toBe(sha256(bOff.bytes));
  }, 60_000);

  it.each(['ID', 'EN'] as const)('%s: caption, kunci dan SUMBER figur 128 mm di badan 128 mm; figur 166 mm tetap selebar figurnya', async (lang) => {
    const on = await renderFixture(lang, tplWith(CANON, { [RESERVE]: true }));
    const paras = paragraphsXml(on.xml);
    let narrow = 0;
    let wide = 0;
    paras.forEach((p, i) => {
      const cx = /<wp:extent cx="(\d+)"/.exec(p)?.[1];
      if (!cx || !/^(Gambar|Figure) \d/.test(textOf(paras[i - 1] ?? ''))) return;
      const apparatus = [paras[i - 1]];
      for (let j = i + 1; j < paras.length && /^(KUNCI|KEY|SUMBER|SOURCE)/.test(textOf(paras[j])); j++) apparatus.push(paras[j]);
      expect(apparatus.length).toBeGreaterThanOrEqual(2);
      const fits = Number(cx) <= 128 * 36000;
      if (fits) narrow += 1;
      else wide += 1;
      for (const a of apparatus) expect(rightOf(a), textOf(a)).toBe(fits ? RESERVE_TW : undefined);
    });
    expect(narrow).toBeGreaterThan(0);
    expect(wide).toBeGreaterThan(0);
  }, 60_000);

  it('caption tabel: tabel selebar kolom teks di badan 128 mm, tabel 166 mm tetap selebar tabelnya', async () => {
    const snap = snapshotOf(fixtureDoc('ID'));
    const tables = (snap.blocks as any[]).filter((b) => TABLE_FAMILY.has(b.type) && b.content?.caption);
    expect(tables.length).toBeGreaterThanOrEqual(2);
    // Tabel pertama dipaksa selebar kolom teks (128 mm = 7257 tw), kedua bentang penuh (166 mm = 9412 tw, BM);
    // kolom tanpa lebar dibagi solver.
    tables.slice(0, 2).forEach((t, i) => {
      t.content = { ...t.content, layout: { ...(t.content.layout ?? {}), widthTw: i === 0 ? 7257 : 9412 } };
      t.content.columns = t.content.columns.map((c: any) => {
        const rest = { ...c };
        delete rest.widthTw;
        delete rest.widthMm;
        return rest;
      });
    });
    const on = await renderSnap(snap, tplWith(CANON, { [RESERVE]: true }));
    const off = await renderSnap(snap, CANON);
    expect(on.xml).toContain('<w:tblW w:w="7257" w:type="dxa"/>');
    let narrow = 0;
    let wide = 0;
    for (const b of tables) {
      const text = b.content.caption.inline.text as string;
      const at = on.xml.indexOf(`<w:t>${text}</w:t>`);
      expect(at, text).toBeGreaterThan(0);
      const capPara = on.xml.slice(on.xml.lastIndexOf('<w:p>', at), on.xml.indexOf('</w:p>', at));
      const tblW = Number(/<w:tblW w:w="(\d+)"/.exec(on.xml.slice(at))?.[1]);
      const fits = tblW <= 7257 + 4;
      if (fits) narrow += 1;
      else wide += 1;
      expect(rightOf(capPara), `${text} tblW ${tblW}`).toBe(fits ? RESERVE_TW : undefined);
      const offAt = off.xml.indexOf(`<w:t>${text}</w:t>`);
      expect(rightOf(off.xml.slice(off.xml.lastIndexOf('<w:p>', offAt), offAt))).toBeUndefined();
    }
    expect(narrow).toBeGreaterThan(0);
    expect(wide).toBeGreaterThan(0);
  }, 60_000);
});

// ── C19 / GF-21: irama vertikal dikunci ke garis dasar 13,5 pt (270 tw) ──────────────────────

const SNAP = 'render.rhythm.snapToBaseline';
const BASE = 270;
const spacingOf = (p: string) => {
  const m = /<w:spacing ([^>]*)\/>/.exec(p.replace(/<w:rPr>[\s\S]*?<\/w:rPr>/g, ''))?.[1] ?? '';
  const a = (k: string) => {
    const hit = new RegExp('w:' + k + '="([0-9]+)"').exec(m);
    return hit ? Number(hit[1]) : undefined;
  };
  return { before: a('before'), after: a('after'), line: a('line'), rule: /w:lineRule="(\w+)"/.exec(m)?.[1] };
};
const onGrid = (v: number | undefined) => v === undefined || v % BASE === 0;
/** Tinggi gambar (twip) dari `wp:extent cy` (EMU; 635 EMU = 1 tw). */
const drawingTw = (p: string) => Math.round(Number(/<wp:extent cx="\d+" cy="(\d+)"/.exec(p)![1]) / 635);
/** Selisih ke kelipatan 270 terdekat (toleransi pembulatan mm -> EMU/tw = 1 tw). */
const gridOff = (v: number) => Math.min(v % BASE, BASE - (v % BASE));

/**
 * Baris tabel keluarga Tabel (tabel tingkat atas tepat sesudah caption "Tabel n"/"Table n"),
 * tanpa baris tabel bersarang di sel.
 */
function captionedTableRows(xml: string): string[] {
  const rows: string[] = [];
  const re = /<w:tbl>|<\/w:tbl>|<w:tr>/g;
  let depth = 0;
  let captioned = false;
  for (const m of xml.matchAll(re)) {
    if (m[0] === '<w:tbl>') {
      depth += 1;
      if (depth === 1) {
        const before = xml.slice(0, m.index!);
        captioned = /^(Tabel|Table) [0-9A-Z]/.test(textOf(before.slice(before.lastIndexOf('<w:p>'))));
      }
    } else if (m[0] === '</w:tbl>') depth -= 1;
    else if (depth === 1 && captioned) rows.push(xml.slice(m.index!, m.index! + 400));
  }
  return rows;
}

describe('C19 GF-21: render.rhythm.snapToBaseline (judul, baris tabel, blok gambar pada kelipatan 13,5 pt)', () => {
  it.each(['ID', 'EN'] as const)('%s: absen = false = keluaran sekarang (sha256 identik)', async (lang) => {
    const absent = await renderFixture(lang, tplWith(CANON, {}, [SNAP]));
    const off = await renderFixture(lang, tplWith(CANON, { [SNAP]: false }));
    expect(sha256(off.bytes)).toBe(sha256(absent.bytes));
    expect(sha256((await renderFixture(lang, CANON)).bytes)).toBe(sha256(absent.bytes));
  }, 60_000);

  it.each(['ID', 'EN'] as const)('%s: jarak dan tinggi baris judul bab dan section = kelipatan 270 tw', async (lang) => {
    const on = await renderFixture(lang, tplWith(CANON, { [SNAP]: true }));
    expect(parseXml(on.xml).errors).toEqual([]);
    const paras = paragraphsXml(on.xml);
    // Judul bab mesin blok = outlineLvl 0 sesudah kicker "BAB n"/"CHAPTER n" + paragraf Datum Rule
    // (pembatas bagian dan pembuka lampiran milik mesin wrapper, di luar baris ini).
    const titles = paras.map((p, i) => i).filter((i) => paras[i].includes('<w:outlineLvl w:val="0"/>') && /^(BAB|CHAPTER) \d/.test(textOf(paras[i - 2] ?? '')));
    const sections = paras.filter((p) => p.includes('<w:outlineLvl w:val="1"/>'));
    expect(titles.length).toBe(3);
    expect(sections.length).toBeGreaterThan(3);
    for (const h of [...titles.map((i) => paras[i]), ...sections]) {
      const s = spacingOf(h);
      expect([s.before, s.after, s.line].every(onGrid), `${textOf(h)} ${JSON.stringify(s)}`).toBe(true);
      expect(s.rule).not.toBe('auto');
    }
    // Kicker bab dan paragraf Datum Rule: blok judul bab berakhir pada garis dasar.
    for (const i of titles) {
      const rule = paras[i - 1];
      expect(rule).toContain('<w:drawing>');
      expect(gridOff(drawingTw(rule) + (spacingOf(rule).after ?? 0) + (spacingOf(rule).before ?? 0)) <= 1, textOf(paras[i])).toBe(true);
      const kicker = spacingOf(paras[i - 2]);
      expect([kicker.before, kicker.after, kicker.line].every(onGrid)).toBe(true);
    }
  }, 60_000);

  it.each(['ID', 'EN'] as const)('%s: setiap baris tabel tingkat atas bertinggi minimum kelipatan 270 tw; isi sel tidak berubah', async (lang) => {
    const off = await renderFixture(lang, CANON);
    const on = await renderFixture(lang, tplWith(CANON, { [SNAP]: true }));
    const rows = captionedTableRows(on.xml);
    expect(rows.length).toBeGreaterThan(10);
    for (const r of rows) {
      const h = /<w:trHeight w:val="(\d+)" w:hRule="atLeast"\/>/.exec(r);
      expect(h, r.slice(0, 120)).not.toBeNull();
      expect(Number(h![1]) % BASE).toBe(0);
      expect(Number(h![1])).toBeGreaterThanOrEqual(BASE);
    }
    // Hanya trPr yang berubah: sel (tcPr, paragraf) identik dengan keluaran sekarang.
    const strip = (x: string) => x.replace(/<w:trHeight w:val="[0-9]+" w:hRule="atLeast"\/>/g, '').replace(/<w:trPr><\/w:trPr>/g, '');
    const tbls = (x: string) => x.match(/<w:tbl>[\s\S]*?<\/w:tbl>/g) ?? [];
    expect(tbls(strip(on.xml))).toEqual(tbls(off.xml));
  }, 60_000);

  // GF-21 (a) follow-up: caption/KEY/SOURCE keep their own leading (Table 8.2 caption "7,6 / 11 pt", ID:2635);
  // before on the grid and the one-line block (before + line + after) ends on the grid.
  const apparatusOnGrid = (s: ReturnType<typeof spacingOf>) => onGrid(s.before) && s.rule === 'exact' && ((s.before ?? 0) + (s.line ?? 0) + (s.after ?? 0)) % BASE === 0;
  it.each(['ID', 'EN'] as const)('%s: blok gambar: caption dan SUMBER berakhir pada kisi (leading tetap), tinggi gambar + jarak sesudah = kelipatan 270 tw', async (lang) => {
    const on = await renderFixture(lang, tplWith(CANON, { [SNAP]: true }));
    const offParas = paragraphsXml((await renderFixture(lang, CANON)).xml);
    const lineOff = (p: string) => spacingOf(offParas.find((x) => textOf(x) === textOf(p))!).line;
    const paras = paragraphsXml(on.xml);
    let figures = 0;
    paras.forEach((p, i) => {
      if (!p.includes('<wp:extent') || !/^(Gambar|Figure) \d/.test(textOf(paras[i - 1] ?? ''))) return;
      figures += 1;
      const cap = spacingOf(paras[i - 1]);
      expect(apparatusOnGrid(cap), `${textOf(paras[i - 1])} ${JSON.stringify(cap)}`).toBe(true);
      expect(cap.line).toBe(lineOff(paras[i - 1]));
      expect(gridOff(drawingTw(p) + (spacingOf(p).after ?? 0) + (spacingOf(p).before ?? 0)) <= 1, textOf(paras[i - 1])).toBe(true);
      for (let j = i + 1; j < paras.length && /^(KUNCI|KEY|SUMBER|SOURCE)/.test(textOf(paras[j])); j++) {
        const s = spacingOf(paras[j]);
        expect(apparatusOnGrid(s), textOf(paras[j])).toBe(true);
        expect(s.line, textOf(paras[j])).toBe(lineOff(paras[j]));
      }
    });
    expect(figures).toBeGreaterThanOrEqual(4);
  }, 60_000);

  it.each(['ID', 'EN'] as const)('%s: badan tetap 9,5/13,5 pt dan tidak disentuh (GF-06)', async (lang) => {
    const off = paragraphsXml((await renderFixture(lang, CANON)).xml);
    const on = paragraphsXml((await renderFixture(lang, tplWith(CANON, { [SNAP]: true }))).xml);
    for (const t of ['Kajian ini disusun Tim Infrastruktur', 'Suhu rata-rata jam sibuk', 'Mohon manajemen operasi menyetujui']) {
      const p = on.find((x) => textOf(x).startsWith(t))!;
      expect(p, t).toBe(off.find((x) => textOf(x).startsWith(t)));
      // Profil kanonik: badan menulis line 270 exact; ukuran 9,5 pt dari gaya Normal (sz 19).
      expect(spacingOf(p)).toMatchObject({ line: 270, rule: 'exact' });
    }
  }, 60_000);

  it('C19 + C20 bersama: kepala section menyempit 2154 dan jaraknya pada kisi', async () => {
    const on = await renderFixture('ID', tplWith(CANON, { [SNAP]: true, [RESERVE]: true }));
    const heads = paragraphsXml(on.xml).filter((p) => p.includes('<w:outlineLvl w:val="1"/>'));
    expect(heads.length).toBeGreaterThan(0);
    for (const h of heads) {
      expect(rightOf(h)).toBe(RESERVE_TW);
      const s = spacingOf(h);
      expect([s.before, s.after, s.line].every(onGrid)).toBe(true);
    }
  }, 60_000);
});
