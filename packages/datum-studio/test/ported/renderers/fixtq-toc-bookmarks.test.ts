// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/renderers/fixtq-toc-bookmarks.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
/* eslint-disable @typescript-eslint/no-explicit-any -- fixture JSON kontrak dibaca bebas-bentuk di uji */
// FIX-TQ (D-359; review SR-56e E2): nama penanda `_StToc_nnn` dihitung dari SATU sumber
// tingkat daftar isi (params slot daftar isi), bukan params unit. `toc.levels` yang disetel
// di slot TOC (cakupan `section:toc`, R-66) berbeda dari nilai efektif slot isi tetap membuat
// setiap PAGEREF menunjuk penanda di judulnya sendiri.
import { beforeAll, describe, expect, it } from '../_vitest';
import type { NormDocSnapshot, ResolvedSlot, ResolvedTemplate } from '@/lib/studio/contract';
import { assembleDocxDetailed } from '@/lib/studio/engine/docx/assemble';
import { assembleHtml } from '@/lib/studio/engine/html/assemble';
import { composeV2 } from '@/lib/studio/services/compose';
import { datumSlots, defaultParams, e1, merge, skeletonInput } from '../structure/_kit';
import { benchmarkTemplate, makeCtx, parseXml, partText, unzip } from './_kit';

/** E1 + bagian P1 (bab 2) + lampiran A; bab 1, bab 2, lampiran A masing-masing punya satu section. */
function composeDoc(tocMode: 'static' | 'field') {
  const d = e1();
  d.sections.content.parts = [{ id: 'P1', title: { text: 'Bagian Satu' } }];
  d.sections.content.chapters[1].partId = 'P1';
  const slots = datumSlots();
  const params = { ...defaultParams(), 'render.toc.mode': tocMode };
  return composeV2({ source: merge(d, undefined, { slots }).doc, skeleton: skeletonInput(slots), params }).snapshot as unknown as NormDocSnapshot;
}

/** Nilai efektif slot (bentuk `RenderContext.slots`): params templat + penimpa slot. */
function slotMap(tpl: ResolvedTemplate, overrides: Record<string, Record<string, unknown>>): Map<string, ResolvedSlot> {
  const m = new Map<string, ResolvedSlot>();
  for (const s of datumSlots()) {
    m.set(s.slotKey, {
      slotKey: s.slotKey,
      sectionType: s.sectionType,
      label: s.label,
      params: { ...tpl.params, ...(overrides[s.slotKey] ?? {}) } as ResolvedSlot['params'],
      roleFormats: tpl.roleFormats,
      placeholderText: '',
    });
  }
  return m;
}

async function render(snap: NormDocSnapshot, tpl: ResolvedTemplate, slots: Map<string, ResolvedSlot>) {
  const { ctx, logs } = makeCtx(snap, tpl, { slots });
  const detail = await assembleDocxDetailed(ctx);
  const xml = partText(unzip(detail.bytes), 'word/document.xml');
  const html = await assembleHtml(makeCtx(snap, tpl, { slots }).ctx, { preview: false });
  return { xml, html, logs };
}

const paragraphsXml = (xml: string) => xml.match(/<w:p[ >][\s\S]*?<\/w:p>/g) ?? [];
const textOf = (p: string) => (p.match(/<w:t[^>]*>[^<]*<\/w:t>/g) ?? []).map((t) => t.replace(/<[^>]+>/g, '')).join('');
const pageRefs = (xml: string) => [...xml.matchAll(/<w:instrText xml:space="preserve"> PAGEREF (\S+) \\h <\/w:instrText>/g)].map((m) => m[1]);
// Wave 165 row 165A (C188 F113-6, consequence edit): the register's sheet-zero bookmark `_StSheet0` (not a TOC target) is left out.
const SHEET_ZERO = '<w:bookmarkStart w:id="900000" w:name="_StSheet0"/><w:bookmarkEnd w:id="900000"/>';
const bookmarks = (xml: string) => [...xml.replace(SHEET_ZERO, '').matchAll(/<w:bookmarkStart w:id="(\d+)" w:name="([^"]+)"\/>/g)].map((m) => ({ id: m[1], name: m[2] }));

/**
 * Setiap PAGEREF (urutan baris TOC) menunjuk penanda yang ada tepat sekali, di paragraf
 * judul yang benar; tidak ada penanda yatim; id unik dan berpasangan.
 */
function assertRefsHitTitles(xml: string, titles: readonly string[]) {
  const refs = pageRefs(xml);
  const starts = bookmarks(xml);
  const ends = [...xml.replace(SHEET_ZERO, '').matchAll(/<w:bookmarkEnd w:id="(\d+)"\/>/g)].map((m) => m[1]);
  expect(refs).toHaveLength(titles.length);
  expect([...starts.map((s) => s.name)].sort()).toEqual([...refs].sort());
  expect(new Set(starts.map((s) => s.id)).size).toBe(starts.length);
  expect([...ends].sort()).toEqual(starts.map((s) => s.id).sort());
  refs.forEach((name, i) => {
    const paras = paragraphsXml(xml).filter((p) => p.includes(`w:name="${name}"`));
    expect(paras, `penanda ${name}`).toHaveLength(1);
    expect(textOf(paras[0]), `PAGEREF ${name} (baris ${i + 1})`).toBe(titles[i]);
  });
}

const CHAPTER_TITLES = ['Lingkup Survei', 'Bagian Satu', 'Temuan Utama', 'Data Mentah'];
const ALL_TITLES = ['Lingkup Survei', '1.1   Tujuan', 'Bagian Satu', 'Temuan Utama', '2.1   Transformator Daya', 'Data Mentah', 'A.1   Log Suhu'];

let BENCH: ResolvedTemplate;
beforeAll(async () => {
  BENCH = await benchmarkTemplate();
});

describe('E2: penanda TOC satu sumber (toc.levels di slot TOC berbeda dari slot isi)', () => {
  it('sanity: blok TOC turunan berada di slot "toc"', () => {
    const snap = composeDoc('static');
    const toc = snap.blocks.find((b) => b.type === 'toc') as any;
    expect(toc?.slotKey).toBe('toc');
  });

  it('statis: slot TOC toc.levels=1, slot isi/lampiran 2 -> setiap PAGEREF ke judulnya sendiri, kepala section tanpa penanda', async () => {
    const slots = slotMap(BENCH, { toc: { 'toc.levels': 1 }, content: { 'toc.levels': 2 }, appendices: { 'toc.levels': 2 } });
    const { xml } = await render(composeDoc('static'), BENCH, slots);
    expect(parseXml(xml).errors).toEqual([]);
    assertRefsHitTitles(xml, CHAPTER_TITLES);
  }, 60_000);

  it('medan: slot TOC toc.levels=1, slot isi 2 -> \\o "1-1" dan PAGEREF bersarang tepat sasaran', async () => {
    const slots = slotMap(BENCH, { toc: { 'toc.levels': 1, 'render.toc.mode': 'field' }, content: { 'toc.levels': 2 }, appendices: { 'toc.levels': 2 } });
    const { xml } = await render(composeDoc('field'), BENCH, slots);
    expect(xml).toContain(' TOC \\o "1-1" \\h \\z \\u ');
    assertRefsHitTitles(xml, CHAPTER_TITLES);
  }, 60_000);

  it('kebalikan: slot TOC toc.levels=2, slot isi/lampiran 1 -> section tetap ber-penanda (tidak ada PAGEREF menggantung)', async () => {
    const slots = slotMap(BENCH, { toc: { 'toc.levels': 2 }, content: { 'toc.levels': 1 }, appendices: { 'toc.levels': 1 } });
    const { xml } = await render(composeDoc('static'), BENCH, slots);
    assertRefsHitTitles(xml, ALL_TITLES);
  }, 60_000);

  it('HTML: baris TOC mengikuti slot TOC (toc.levels=1 -> tanpa entri section), jangkar ada', async () => {
    const slots = slotMap(BENCH, { toc: { 'toc.levels': 1 }, content: { 'toc.levels': 2 }, appendices: { 'toc.levels': 2 } });
    const { html } = await render(composeDoc('static'), BENCH, slots);
    const hrefs = [...html.matchAll(/class="st-toc-link"[^>]*href="#([^"]+)"|href="#([^"]+)"[^>]*class="st-toc-link"/g)].map((m) => m[1] ?? m[2]);
    expect(hrefs.length).toBe(4);
    expect(hrefs.some((h) => h.startsWith('st-sec-'))).toBe(false);
    for (const h of hrefs) expect(html).toContain(`id="${h}"`);
  }, 60_000);
});
