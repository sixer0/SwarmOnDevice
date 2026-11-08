// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/renderers/gfix-running-head-fit.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
// G-FIX siklus 1 (kriteria clash, verification/23 §4, G-06 / D-593): teks kiri kepala
// halaman bawaan (entitas · judul dokumen · judul bab) dipas ke lebar blok teks dikurangi
// klasifikasi rata kanan, supaya kepala halaman tetap satu baris. Judul dokumen dipendekkan
// lebih dulu dengan elipsis, lalu judul bab; entitas dan klasifikasi tidak pernah dipotong.
// Kepala yang sudah muat harus byte-identik dengan keluaran sebelum perbaikan.
// G-FIX potong-kata (gerbang DEV r2): teks yang dipendekkan dipotong di batas kata terakhir
// yang masih muat, bukan di tengah kata ("ASET PEL…"); satu kata terlalu panjang jatuh ke
// potongan per-karakter.
import { createHash } from 'node:crypto';
import { beforeAll, describe, expect, it } from '../_vitest';
import type { NormUnit, ResolvedTemplate } from '@/lib/studio/contract';
import { measureFont } from '@/lib/studio/engine/chart/core/textfit';
import { headerFooterXml } from '@/lib/studio/engine/docx/package/header-footer';
import { fitRunningHeadText } from '@/lib/studio/engine/front/running-head-fit';
import { canonicalTemplate, loadFixtureDoc, makeCtx, snapshotOf } from './_kit';

// Judul gerbang DEV S36 (C:/tmp/s36/payload/{id,en}.json, meta.title) dan judul bab payload.
const GATE_TITLE_ID = 'Kajian Desain Keamanan Sistem Informasi Manajemen Aset Pelabuhan';
const GATE_TITLE_EN = 'Security Design Study for the Port Asset Management Information System';

// Huruf kepala halaman seperti yang dirender (header5.xml BM): IBM Plex Sans Cond 6,5 pt,
// kapital, renggang 0,6 pt; klasifikasi tebal. Lebar blok teks 9411 tw.
const TRACK_MM = 0.6 * (25.4 / 72);
const LEFT_FONT = { pt: 6.5, face: 'struct' as const, caps: true, trackMm: TRACK_MM };
const RIGHT_FONT = { ...LEFT_FONT, bold: true };
const TEXT_WIDTH_MM = (9411 / 1440) * 25.4;

const unit = { kind: 'chapter', key: '1', setup: {} } as unknown as NormUnit;

function headerXml(tpl: ResolvedTemplate, o: { lang: 'ID' | 'EN'; title: string; chapter: string; classification?: string }): string {
  const doc = JSON.parse(JSON.stringify(loadFixtureDoc('doc_terbit_report')));
  doc.meta.title = o.title;
  doc.meta.language = o.lang;
  if (o.classification) doc.meta.classification = o.classification;
  // Judul bab membawa nomor sumber ("Bab 6. ..."), kicker kosong eksplisit = tanpa label "Bab n".
  doc.chapters[0].title = { text: o.chapter };
  doc.chapters[0].kicker = { text: '' };
  delete doc.chapters[0].runningHeadTitle;
  return headerFooterXml({ mode: 'runningHead' } as never, makeCtx(snapshotOf(doc), tpl).ctx, unit, 'hdr');
}

function runTexts(xml: string): string[] {
  return [...xml.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1].replace(/&amp;/g, '&'));
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

describe('G-FIX: kepala halaman DOCX bawaan muat satu baris', () => {
  let tpl: ResolvedTemplate;
  beforeAll(async () => {
    tpl = await canonicalTemplate();
  });

  function expectFits(xml: string, classification: string): { left: string; right: string } {
    const [left, right] = runTexts(xml);
    expect(right).toBe(classification);
    const used = measureFont(left, LEFT_FONT) + measureFont(right, RIGHT_FONT);
    expect(used).toBeLessThanOrEqual(TEXT_WIDTH_MM - 1);
    return { left, right };
  }

  it.each([
    ['ID', GATE_TITLE_ID, 'Bab 1. Pendahuluan'],
    ['ID', GATE_TITLE_ID, 'Bab 6. Desain Keamanan'],
    ['EN', GATE_TITLE_EN, 'Chapter 1. Introduction'],
    ['EN', GATE_TITLE_EN, 'Chapter 6. Security Design'],
  ] as const)('%s judul gerbang + "%s": judul dokumen berelipsis, entitas dan judul bab utuh', (lang, title, chapter) => {
    const { left } = expectFits(headerXml(tpl, { lang, title, chapter }), 'TERBATAS');
    const segs = left.split(' · ');
    expect(segs).toHaveLength(3);
    expect(segs[0]).toBe('PT GEMILANG SATRIA PERKASA');
    expect(segs[1].endsWith('…')).toBe(true);
    expect(title.startsWith(segs[1].slice(0, -1))).toBe(true);
    expect(segs[2]).toBe(chapter);
  });

  // Bagian judul dokumen (segmen tengah) tanpa elipsis, dan apakah potongannya jatuh di batas kata.
  function titleCut(left: string, title: string): { kept: string; atWordBoundary: boolean; nextWord: string } {
    const seg = left.split(' · ')[1];
    expect(seg.endsWith('…')).toBe(true);
    const kept = seg.slice(0, -1);
    expect(title.startsWith(kept)).toBe(true);
    const rest = title.slice(kept.length);
    return { kept, atWordBoundary: rest.length === 0 || /^\s/.test(rest), nextWord: rest.trim().split(/\s+/)[0] };
  }

  it.each([
    ['ID', GATE_TITLE_ID, 'Bab 1. Pendahuluan'],
    ['ID', GATE_TITLE_ID, 'Bab 6. Desain Keamanan'],
    ['EN', GATE_TITLE_EN, 'Chapter 1. Introduction'],
    ['EN', GATE_TITLE_EN, 'Chapter 6. Security Design'],
  ] as const)('%s judul gerbang + "%s": dipotong di batas kata terakhir yang masih muat', (lang, title, chapter) => {
    const { left } = expectFits(headerXml(tpl, { lang, title, chapter }), 'TERBATAS');
    const { kept, atWordBoundary, nextWord } = titleCut(left, title);
    expect(atWordBoundary).toBe(true);
    expect(kept).not.toMatch(/\s$/);
    // Kata berikutnya tidak muat: kepala dengan kata itu melebihi anggaran (lebar teks - klasifikasi - jarak 4 mm).
    const longer = ['PT GEMILANG SATRIA PERKASA', `${kept} ${nextWord}…`, chapter].join(' · ');
    expect(measureFont(longer, LEFT_FONT) + measureFont('TERBATAS', RIGHT_FONT)).toBeGreaterThan(TEXT_WIDTH_MM - 4);
  });

  it('judul dokumen satu kata sangat panjang: jatuh ke potongan per-karakter', () => {
    const title = 'Pneumonoultramicroscopicsilicovolcanoconiosisdanseterusnyayangpanjang';
    const { left } = expectFits(headerXml(tpl, { lang: 'ID', title, chapter: 'Bab 6. Desain Keamanan' }), 'TERBATAS');
    const seg = left.split(' · ')[1];
    expect(seg.endsWith('…')).toBe(true);
    const kept = seg.slice(0, -1);
    expect(title.startsWith(kept)).toBe(true);
    expect(kept.length).toBeGreaterThanOrEqual(3);
    expect(kept.length).toBeLessThan(title.length);
  });

  describe('fitRunningHeadText langsung', () => {
    const ENTITY = 'PT GEMILANG';
    const widthOf = (text: string) => measureFont(text, LEFT_FONT);
    const fit = (title: string, maxMm: number) =>
      fitRunningHeadText([{ text: ENTITY }, { text: title, shrinkOrder: 1 }], maxMm, LEFT_FONT);

    it('teks yang sudah muat dikembalikan persis apa adanya', () => {
      const title = 'Kajian Keamanan Aset';
      const full = `${ENTITY} · ${title}`;
      expect(fit(title, widthOf(full))).toBe(full);
      expect(fit(title, widthOf(full) + 10)).toBe(full);
    });

    it('pemisah dan spasi di ujung dibuang sebelum elipsis', () => {
      // "Alpha Beta, Gamma" tidak muat; potongan per-karakter akan jatuh di "Alpha Beta, Gam…".
      expect(fit('Alpha Beta, Gamma Delta Epsilon', widthOf(`${ENTITY} · Alpha Beta, Gamma…`) - 0.01)).toBe(`${ENTITY} · Alpha Beta…`);
      expect(fit('Alpha Beta - Gamma Delta Epsilon', widthOf(`${ENTITY} · Alpha Beta - Gamma…`) - 0.01)).toBe(`${ENTITY} · Alpha Beta…`);
      expect(fit('Alpha Beta: Gamma Delta Epsilon', widthOf(`${ENTITY} · Alpha Beta: Gamma…`) - 0.01)).toBe(`${ENTITY} · Alpha Beta…`);
    });

    it('kata utuh tidak muat sama sekali: potongan per-karakter, bukan segmen dibuang', () => {
      const word = 'Supercalifragilisticexpialidocious';
      const out = fit(word, widthOf(`${ENTITY} · Supercalif…`));
      const seg = out.split(' · ')[1];
      expect(seg.endsWith('…')).toBe(true);
      expect(word.startsWith(seg.slice(0, -1))).toBe(true);
      expect(seg.length - 1).toBeGreaterThanOrEqual(3);
      expect(widthOf(out)).toBeLessThanOrEqual(widthOf(`${ENTITY} · Supercalif…`) + 1e-9);
    });

    it('kata pertama saja yang muat tetapi lebih pendek dari 3 glif: potongan per-karakter', () => {
      // Kata utuh "Di" (2 glif) bukan potongan bermakna; jatuh ke per-karakter ("Di A…").
      const out = fit('Di Atasnya Pelabuhan', widthOf(`${ENTITY} · Di Ata…`));
      expect(out).toMatch(/^PT GEMILANG · Di A/);
      expect(out.endsWith('…')).toBe(true);
    });
  });

  it('judul bab yang juga sangat panjang dipendekkan sesudah judul dokumen; entitas utuh', () => {
    const chapter = 'Bab 6. Desain Keamanan Berlapis untuk Seluruh Aset Pelabuhan, Dermaga, Gudang, dan Jaringan Operasional Terpadu';
    const { left } = expectFits(headerXml(tpl, { lang: 'ID', title: GATE_TITLE_ID, chapter }), 'TERBATAS');
    expect(left.startsWith('PT GEMILANG SATRIA PERKASA · ')).toBe(true);
    expect(left.endsWith('…')).toBe(true);
    expect(left).toContain('Bab 6. Desain');
  });

  it('klasifikasi tidak pernah dipotong (klasifikasi panjang + judul panjang)', () => {
    for (const lang of ['ID', 'EN'] as const) {
      const xml = headerXml(tpl, { lang, title: lang === 'ID' ? GATE_TITLE_ID : GATE_TITLE_EN, chapter: 'Bab 6. Desain Keamanan', classification: 'SANGAT RAHASIA' });
      const { left, right } = expectFits(xml, 'SANGAT RAHASIA');
      expect(right).not.toContain('…');
      expect(left.split(' · ')[1].endsWith('…')).toBe(true);
    }
  });

  it('kepala yang sudah muat byte-identik dengan keluaran sebelum perbaikan', () => {
    // sha256 keluaran headerFooterXml sebelum G-FIX (kode v2.1 2026-11-04, sebelum perubahan ini).
    // row49a ADAPT (C104 H1, Rev A DT-28d): the classification run is now seal 6E1420 (was ink900 101418); the only
    // `<w:color>` element with 6E1420 in this header is that run (borders carry w:color as an attribute), so mapping it
    // back must give the pre-G-FIX bytes: G-FIX still leaves a fitting head untouched.
    // Row 165P consequence edit (C205, CP-08/CP-12): the head rule is now seal w:sz 6 (was ink200 C3CBD1 w:sz 5); the
    // border is mapped back as well, so the text bytes are still compared with the pre-G-FIX output.
    const preH1 = (xml: string): string => {
      expect(xml).toContain('<w:color w:val="6E1420"/>');
      expect(xml).toContain('<w:bottom w:val="single" w:sz="6" w:space="1" w:color="6E1420"/>');
      return xml
        .replaceAll('<w:color w:val="6E1420"/>', '<w:color w:val="101418"/>')
        .replace('<w:bottom w:val="single" w:sz="6" w:space="1" w:color="6E1420"/>', '<w:bottom w:val="single" w:sz="5" w:space="1" w:color="C3CBD1"/>');
    };
    expect(sha(preH1(headerXml(tpl, { lang: 'ID', title: 'Kajian Keamanan Aset Pelabuhan', chapter: 'Bab 6. Desain Keamanan' })))).toBe(
      '5e2c6f8e9861bef6aaf754f1a1e82b9892ce01b33b37d6962c5247efc18616e7',
    );
    expect(sha(preH1(headerXml(tpl, { lang: 'EN', title: 'Port Asset Security Study', chapter: 'Chapter 6. Security Design' })))).toBe(
      'ad03a9053546576fb925c0f35d332e42a223321468e2134c2838bc1a343cf56e',
    );
  });
});
