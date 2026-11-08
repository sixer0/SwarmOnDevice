// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/renderers/fixt2-toc-sections.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
/* eslint-disable @typescript-eslint/no-explicit-any -- fixture JSON kontrak dibaca bebas-bentuk di uji */
// FIX-T2 (D-342 S2; uji ulang Hermes S2): daftar isi turunan memuat entri section
// (tingkat 2) dan lampiran, masing-masing dengan penanda di judulnya + `PAGEREF \h`;
// HTML tautan jangkar setara. Kedalaman = parameter templat `toc.levels` (registri
// S03); tanpa parameter = kedalaman 2, setara medan `TOC \o "1-2"` mesin.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from '../_vitest';
import type { NormDocSnapshot, ResolvedTemplate } from '@/lib/studio/contract';
import { assembleDocxDetailed } from '@/lib/studio/engine/docx/assemble';
import { tocLevels } from '@/lib/studio/engine/docx/wrapper/toc-refs';
import { assembleHtml } from '@/lib/studio/engine/html/assemble';
import { composeV2 } from '@/lib/studio/services/compose';
import { withParams } from '../engine-core/fixtures';
import { datumSlots, defaultParams, e1, merge, skeletonInput } from '../structure/_kit';
import { benchmarkTemplate, makeCtx, parseXml, partText, unzip } from './_kit';

/** E1 + bagian P1 (bab 2) + lampiran A bawaan; bab 1, bab 2, lampiran A masing-masing punya section. */
function composeDoc(tocMode: 'static' | 'field', mutate?: (d: any) => void) {
  const d = e1();
  d.sections.content.parts = [{ id: 'P1', title: { text: 'Bagian Satu' } }];
  d.sections.content.chapters[1].partId = 'P1';
  mutate?.(d);
  const slots = datumSlots();
  const params = { ...defaultParams(), 'render.toc.mode': tocMode };
  return composeV2({ source: merge(d, undefined, { slots }).doc, skeleton: skeletonInput(slots), params }).snapshot as unknown as NormDocSnapshot;
}

async function render(snap: NormDocSnapshot, tpl: ResolvedTemplate) {
  const { ctx, logs } = makeCtx(snap, tpl);
  const detail = await assembleDocxDetailed(ctx);
  const xml = partText(unzip(detail.bytes), 'word/document.xml');
  const html = await assembleHtml(makeCtx(snap, tpl).ctx, { preview: false });
  return { xml, html, logs, bytes: detail.bytes };
}

/** Artefak opsional untuk cek PDF soffice manual (`FIXT2_OUT=<dir>`); tanpa env tidak menulis apa pun. */
function dump(name: string, bytes: Uint8Array) {
  const dir = process.env.FIXT2_OUT;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, name), bytes);
}

const paragraphsXml = (xml: string) => xml.match(/<w:p[ >][\s\S]*?<\/w:p>/g) ?? [];
const textOf = (p: string) => (p.match(/<w:t[^>]*>[^<]*<\/w:t>/g) ?? []).map((t) => t.replace(/<[^>]+>/g, '')).join('');
const pageRefs = (xml: string) => [...xml.matchAll(/<w:instrText xml:space="preserve"> PAGEREF (\S+) \\h <\/w:instrText>/g)].map((m) => m[1]);
const names = (n: number) => Array.from({ length: n }, (_, i) => `_StToc_${String(i + 1).padStart(3, '0')}`);

// Wave 165 row 165A (C188 F113-6, consequence edit): the register's sheet-zero bookmark `_StSheet0` (not a TOC target) is left out.
const withoutSheetZero = (x: string) => x.replace('<w:bookmarkStart w:id="900000" w:name="_StSheet0"/><w:bookmarkEnd w:id="900000"/>', '');
/** Penanda unik, berpasangan, nama sah Word, dan masing-masing di paragraf judul sasaran (urut). */
function assertTargets(xml: string, titles: readonly string[]) {
  xml = withoutSheetZero(xml);
  const starts = [...xml.matchAll(/<w:bookmarkStart w:id="(\d+)" w:name="([^"]+)"\/>/g)].map((m) => ({ id: m[1], name: m[2] }));
  const ends = [...xml.matchAll(/<w:bookmarkEnd w:id="(\d+)"\/>/g)].map((m) => m[1]);
  expect(starts.map((s) => s.name)).toEqual(names(titles.length));
  expect(new Set(starts.map((s) => s.id)).size).toBe(starts.length);
  expect([...ends].sort()).toEqual(starts.map((s) => s.id).sort());
  for (const [i, s] of starts.entries()) {
    expect(s.name).toMatch(/^[A-Za-z_][A-Za-z0-9_]{0,39}$/);
    const paras = paragraphsXml(xml).filter((p) => p.includes(`w:name="${s.name}"`));
    expect(paras).toHaveLength(1);
    expect(textOf(paras[0])).toBe(titles[i]);
  }
}

/** Urutan entri bawaan: bab 1 + 1.1, Bagian I, bab 2 + 2.1, lampiran A + A.1. */
const ALL_TITLES = ['Lingkup Survei', '1.1   Tujuan', 'Bagian Satu', 'Temuan Utama', '2.1   Transformator Daya', 'Data Mentah', 'A.1   Log Suhu'];

let BENCH: ResolvedTemplate;
beforeAll(async () => {
  BENCH = await benchmarkTemplate();
});

describe('tocLevels (parameter templat toc.levels)', () => {
  it('absen = kedalaman 2; bilangan = kedalaman; bentuk lain (termasuk larik nama tingkat) = bawaan + invalid', () => {
    // FIX-TL (D-351/D-352): TocLevels membawa `depth` (kerangka medan "1-<depth>", R-66 int 1-3).
    // FIX-TQ (D-359, E6): satu bentuk R-66 (int); cabang larik nama tingkat dihapus, bagian/lampiran selalu dimuat.
    expect(tocLevels(undefined)).toEqual({ levels: { section: true, depth: 2 }, invalid: false });
    expect(tocLevels({ 'toc.levels': 1 }).levels).toEqual({ section: false, depth: 1 });
    expect(tocLevels({ 'toc.levels': 3 }).levels.section).toBe(true);
    expect(tocLevels({ 'toc.levels': ['bagian', 'bab', 'lampiran'] })).toEqual({ levels: { section: true, depth: 2 }, invalid: true });
    expect(tocLevels({ 'toc.levels': ['bab', 'subbagian'] })).toEqual({ levels: { section: true, depth: 2 }, invalid: true });
    expect(tocLevels({ 'toc.levels': 0 }).invalid).toBe(true);
  });
});

describe('daftar isi per section + lampiran (DOCX)', () => {
  it('statis bawaan: entri bab, section, bagian, lampiran ber-PAGEREF ke penanda judul masing-masing (urut)', async () => {
    const snap = composeDoc('static');
    // sanity fixture: setiap bab/lampiran punya tepat satu section
    expect([...snap.doc.chapters, ...(snap.doc.appendices ?? [])].map((c) => (c.sections ?? []).length)).toEqual([1, 1, 1]);
    const { xml, logs, bytes } = await render(snap, BENCH);
    dump('fixt2_static.docx', bytes);
    expect(parseXml(xml).errors).toEqual([]);
    expect(pageRefs(xml)).toEqual(names(ALL_TITLES.length));
    assertTargets(xml, ALL_TITLES);
    expect(logs.some((l) => /daftar isi statis tanpa entries/.test(l.message))).toBe(false);
  }, 60_000);

  it('statis: baris section = label nomor section + judul + PAGEREF; sel halaman kolom ketiga', async () => {
    const { xml } = await render(composeDoc('static'), BENCH);
    const tbl = xml.slice(xml.lastIndexOf('<w:tbl>', xml.indexOf('PAGEREF _StToc_001')), xml.indexOf('</w:tbl>', xml.indexOf('PAGEREF _StToc_001')));
    const rows = tbl.match(/<w:tr[ >][\s\S]*?<\/w:tr>/g) ?? [];
    const cells = rows.map((r) => (r.match(/<w:tc>[\s\S]*?<\/w:tc>/g) ?? []).map(textOf));
    expect(cells.map((c) => c.slice(0, 2))).toEqual([
      ['Bab 1', 'Lingkup Survei'],
      ['1.1', 'Tujuan'],
      ['Bagian I', 'Bagian Satu'],
      ['Bab 2', 'Temuan Utama'],
      ['2.1', 'Transformator Daya'],
      ['Lampiran A', 'Data Mentah'],
      ['A.1', 'Log Suhu'],
    ]);
    rows.forEach((r, i) => {
      const tcs = r.match(/<w:tc>[\s\S]*?<\/w:tc>/g) ?? [];
      expect(tcs[2]).toContain(`PAGEREF ${names(7)[i]} \\h`);
    });
  }, 60_000);

  it('medan (render.toc.mode=field): TOC \\o "1-2" + PAGEREF bersarang untuk setiap entri termasuk section', async () => {
    const { xml } = await render(composeDoc('field'), withParams(BENCH, { 'render.toc.mode': 'field' }));
    expect(parseXml(xml).errors).toEqual([]);
    expect(xml).toContain('<w:instrText xml:space="preserve"> TOC \\o "1-2" \\h \\z \\u </w:instrText>');
    expect(pageRefs(xml)).toEqual(names(ALL_TITLES.length));
    assertTargets(xml, ALL_TITLES);
  }, 60_000);

  it('toc.levels = 1: tanpa section (kepala section tanpa penanda), medan \\o "1-1"', async () => {
    const titles = ['Lingkup Survei', 'Bagian Satu', 'Temuan Utama', 'Data Mentah'];
    const st = await render(composeDoc('static'), withParams(BENCH, { 'toc.levels': 1 }));
    expect(pageRefs(st.xml)).toEqual(names(4));
    assertTargets(st.xml, titles);
    const fd = await render(composeDoc('field'), withParams(BENCH, { 'render.toc.mode': 'field', 'toc.levels': 1 }));
    expect(fd.xml).toContain(' TOC \\o "1-1" \\h \\z \\u ');
    assertTargets(fd.xml, titles);
  }, 60_000);

  it('toc.levels = ["bab", "seksi"] (larik, bentuk tak terdaftar R-66; FIX-TQ E6): log warn, kedalaman bawaan 2', async () => {
    const { xml, logs } = await render(composeDoc('static'), withParams(BENCH, { 'toc.levels': ['bab', 'seksi'] }));
    expect(pageRefs(xml)).toEqual(names(ALL_TITLES.length));
    assertTargets(xml, ALL_TITLES);
    expect(logs.some((l) => l.level === 'warn' && /toc\.levels tidak dikenal/.test(l.message))).toBe(true);
  }, 60_000);

  it('toc.levels tidak dikenal: log warn, kedalaman bawaan 2 dipakai', async () => {
    const { xml, logs } = await render(composeDoc('static'), withParams(BENCH, { 'toc.levels': ['subbagian'] }));
    expect(pageRefs(xml)).toEqual(names(ALL_TITLES.length));
    expect(logs.some((l) => l.level === 'warn' && /toc\.levels tidak dikenal/.test(l.message))).toBe(true);
  }, 60_000);

  it('entri eksplisit (pola Manual 000) dan dokumen tanpa TOC: nol penanda, nol PAGEREF di kepala section', async () => {
    const snap = composeDoc('static');
    const toc = snap.blocks.find((b) => b.type === 'toc')!;
    toc.content = { ...(toc.content as object), entries: [{ level: 'chapter', label: { text: 'Bab 1' }, title: { text: 'Lingkup Survei' }, page: '5' }] } as never;
    const a = await render(snap, BENCH);
    expect(withoutSheetZero(a.xml)).not.toContain('w:bookmarkStart');
    // Row 165P consequence edit (C205, CP-05): the cover HALAMAN field is the register's formula `= NUMPAGES - PAGEREF
    // _StSheet0` (sheet count N); no other PAGEREF (no TOC marker) may appear.
    expect(a.xml.replaceAll(' PAGEREF _StSheet0 ', '')).not.toContain('PAGEREF');
    const none = composeDoc('static');
    none.blocks = none.blocks.filter((b) => b.type !== 'toc');
    const b = await render(none, BENCH);
    expect(withoutSheetZero(b.xml)).not.toContain('w:bookmarkStart');
  }, 60_000);
});

describe('daftar isi per section + lampiran (HTML)', () => {
  it('entri turunan = tautan jangkar ke kepala bab/section/bagian/lampiran yang ada; baris section data-level', async () => {
    const { html } = await render(composeDoc('static'), BENCH);
    const hrefs = [...html.matchAll(/<a class="st-toc-link" href="#([^"]+)">/g)].map((m) => m[1]);
    expect(hrefs).toEqual(['st-ch-1', 'st-sec-1-1', 'st-part-P1', 'st-ch-2', 'st-sec-2-1', 'st-app-A', 'st-sec-A-1']);
    for (const h of hrefs) expect(html.match(new RegExp(`id="${h}"`, 'g'))).toHaveLength(1);
    expect((html.match(/data-level="section"/g) ?? []).length).toBe(3);
    expect(html).not.toMatch(/href="(?!#|data:)/);
  }, 60_000);

  it('toc.levels = 1: HTML tanpa entri section (paritas DOCX)', async () => {
    const { html } = await render(composeDoc('static'), withParams(BENCH, { 'toc.levels': 1 }));
    const hrefs = [...html.matchAll(/<a class="st-toc-link" href="#([^"]+)">/g)].map((m) => m[1]);
    expect(hrefs).toEqual(['st-ch-1', 'st-part-P1', 'st-ch-2', 'st-app-A']);
  }, 60_000);
});
