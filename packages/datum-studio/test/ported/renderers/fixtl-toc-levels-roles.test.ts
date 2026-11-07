// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/renderers/fixtl-toc-levels-roles.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
// FIX-TL (D-351, D-352): `toc.levels` terdaftar di katalog parameter (R-66, int 1-3,
// bawaan 2, cakupan section:toc, lapis lanjutan pola R-59/R-60) dan peran entri TOC
// `toc.section*` (indentasi tingkat 2 + 1 pt lebih kecil, turunan dari peran bab efektif)
// serta `toc.appendix*` (bawaan = peran bab; dipakai hanya bila templat menyetelnya).
// DOCX dan HTML membaca peran dari sumber yang sama (`tocEntryRoles`).
import { beforeAll, describe, expect, it } from '../_vitest';
import { ROLE_KEYS } from '@/lib/studio/contract/enums';
import type { NormDocSnapshot, ResolvedTemplate, RoleFormat } from '@/lib/studio/contract';
import { assembleDocxDetailed } from '@/lib/studio/engine/docx/assemble';
import { tocEntryRoles, tocLevels, tocOutlineRange, tocSectionIndentTw } from '@/lib/studio/engine/docx/wrapper/toc-refs';
import { assembleHtml } from '@/lib/studio/engine/html/assemble';
import { ALL_PARAM_COUNT, ALL_PARAMS, PARAMS_BY_KEY, PARAMS_RENDER, RENDER_PARAM_COUNT } from '@/lib/studio/params';
import { isScopeAllowedInSlot } from '@/lib/studio/registry/slots';
import { composeV2 } from '@/lib/studio/services/compose';
import { withParams } from '../engine-core/fixtures';
import { datumSlots, defaultParams, e1, merge, skeletonInput } from '../structure/_kit';
import { benchmarkTemplate, canonicalTemplate, makeCtx, partText, unzip } from './_kit';

/** E1 + bagian P1 (bab 2) + lampiran A; bab 1, bab 2, lampiran A masing-masing punya satu section (pola fixt2). */
function composeDoc(tocMode: 'static' | 'field') {
  const d = e1();
  d.sections.content.parts = [{ id: 'P1', title: { text: 'Bagian Satu' } }];
  d.sections.content.chapters[1].partId = 'P1';
  const slots = datumSlots();
  const params = { ...defaultParams(), 'render.toc.mode': tocMode };
  return composeV2({ source: merge(d, undefined, { slots }).doc, skeleton: skeletonInput(slots), params }).snapshot as unknown as NormDocSnapshot;
}

async function render(snap: NormDocSnapshot, tpl: ResolvedTemplate) {
  const detail = await assembleDocxDetailed(makeCtx(snap, tpl).ctx);
  const xml = partText(unzip(detail.bytes), 'word/document.xml');
  const html = await assembleHtml(makeCtx(snap, tpl).ctx, { preview: false });
  return { xml, html };
}

function withRoles(tpl: ResolvedTemplate, roles: Record<string, RoleFormat>): ResolvedTemplate {
  return { ...tpl, roleFormats: { ...tpl.roleFormats, ...roles } };
}

const textOf = (p: string) => (p.match(/<w:t[^>]*>[^<]*<\/w:t>/g) ?? []).map((t) => t.replace(/<[^>]+>/g, '')).join('');
const pageRefs = (xml: string) => [...xml.matchAll(/ PAGEREF (\S+) \\h /g)].map((m) => m[1]);

/** Baris tabel TOC statis -> sel (XML) per baris, kunci = teks label. */
function staticTocRows(xml: string): Map<string, string[]> {
  const at = xml.indexOf('PAGEREF _StToc_001');
  const tbl = xml.slice(xml.lastIndexOf('<w:tbl>', at), xml.indexOf('</w:tbl>', at));
  const out = new Map<string, string[]>();
  for (const r of tbl.match(/<w:tr[ >][\s\S]*?<\/w:tr>/g) ?? []) {
    const tcs = r.match(/<w:tc>[\s\S]*?<\/w:tc>/g) ?? [];
    out.set(textOf(tcs[0] ?? ''), tcs);
  }
  return out;
}

const indLeft = (x: string) => Number(/<w:ind\b[^>]*w:left="(\d+)"/.exec(x)?.[1] ?? 0);
const sizes = (x: string) => [...x.matchAll(/<w:sz w:val="(\d+)"\/>/g)].map((m) => Number(m[1]));
/** Isi sel tanpa teks dan tanpa penanda (format saja), untuk membandingkan gaya dua baris. */
const formatOnly = (x: string) => x.replace(/<w:t[^>]*>[^<]*<\/w:t>/g, '').replace(/ PAGEREF \S+ \\h /g, '');

/** Sel HTML per peran, berurutan. */
const htmlCells = (html: string, role: string) => [...html.matchAll(new RegExp(`<td[^>]*data-role="${role.replace('.', '\\.')}"[^>]*>([\\s\\S]*?)</td>`, 'g'))].map((m) => m[0]);

let BENCH: ResolvedTemplate;
let CANON: ResolvedTemplate;
beforeAll(async () => {
  BENCH = await benchmarkTemplate();
  // Mode TOC = kenop templat render.toc.mode (D-165 KT-11); kanonik bawaan "field", uji statis menyetelnya.
  CANON = withParams(await canonicalTemplate(), { 'render.toc.mode': 'static' });
});

describe('katalog parameter: toc.levels (R-66)', () => {
  it('ParamDef int 1-3 bawaan 2, kelas B, cakupan section:toc, lapis advanced (pola R-59/R-60)', () => {
    const d = PARAMS_BY_KEY.get('toc.levels');
    expect(d).toBeDefined();
    expect({ id: d!.id, type: d!.type, default: d!.default, range: d!.range, class: d!.class, scope: d!.scope, surface: d!.surface }).toEqual({
      id: 'R-66',
      type: 'int',
      default: 2,
      range: { min: 1, max: 3, step: 1 },
      class: 'B',
      scope: 'section:toc',
      surface: 'advanced',
    });
    // Pola kenop TOC RQ-8: kunci judul/catatan juga lanjutan bercakupan section:toc.
    for (const k of ['render.toc.title', 'render.toc.note']) expect([PARAMS_BY_KEY.get(k)!.scope, PARAMS_BY_KEY.get(k)!.surface]).toEqual(['section:toc', 'advanced']);
  });

  it('pin hitungan diperbarui (D-351/D-352; C06 ronde cakupan R-67..R-80): renderer 44 -> 45 -> 59, total 787 -> 788 -> 802', () => {
    expect(PARAMS_RENDER).toHaveLength(RENDER_PARAM_COUNT);
    // row42 ADAPT A2 (C40, row 122): R-81..R-83 appended; renderer 59 -> 62, total 802 -> 805.
    expect(RENDER_PARAM_COUNT).toBe(62);
    expect(ALL_PARAMS).toHaveLength(ALL_PARAM_COUNT);
    expect(ALL_PARAM_COUNT).toBe(805);
  });

  it('cakupan: boleh di M11 slot toc, ditolak di slot bab', () => {
    expect(isScopeAllowedInSlot('section:toc', { sectionType: 'toc' })).toBe(true);
    expect(isScopeAllowedInSlot('section:toc', { sectionType: 'chapter', admits: ['paragraph'] })).toBe(false);
  });

  it('templat tanpa setelan: nilai terselesaikan = bawaan 2', () => {
    expect(CANON.params['toc.levels']).toBe(2);
  });
});

describe('tocLevels 1/2/3 + rentang kerangka medan', () => {
  it.each([
    [1, false, '1-1'],
    [2, true, '1-2'],
    [3, true, '1-3'],
    [7, true, '1-3'],
  ])('toc.levels=%s: section %s, \\o "%s"', (n, section, range) => {
    const { levels, invalid } = tocLevels({ 'toc.levels': n });
    expect(invalid).toBe(false);
    expect(levels.section).toBe(section);
    expect(tocOutlineRange(levels)).toBe(range);
  });

  it('DOCX + HTML: 1 = tanpa section; 2 = bawaan (absen identik); 3 = entri sama dengan 2, medan "1-3"', async () => {
    const field = withParams(BENCH, { 'render.toc.mode': 'field' });
    const lv = async (n: number | undefined) => {
      const p: Record<string, unknown> = { ...field.params };
      if (n === undefined) delete p['toc.levels'];
      else p['toc.levels'] = n;
      return render(composeDoc('field'), { ...field, params: Object.freeze(p) as ResolvedTemplate['params'] });
    };
    const [one, two, three, absent] = [await lv(1), await lv(2), await lv(3), await lv(undefined)];
    expect(pageRefs(one.xml)).toHaveLength(4);
    expect(one.xml).toContain(' TOC \\o "1-1" \\h \\z \\u ');
    expect((one.html.match(/data-level="section"/g) ?? []).length).toBe(0);
    expect(pageRefs(two.xml)).toHaveLength(7);
    expect(two.xml).toContain(' TOC \\o "1-2" \\h \\z \\u ');
    expect((two.html.match(/data-level="section"/g) ?? []).length).toBe(3);
    expect(absent.xml).toBe(two.xml);
    expect(absent.html).toBe(two.html);
    expect(pageRefs(three.xml)).toEqual(pageRefs(two.xml));
    expect(three.xml).toContain(' TOC \\o "1-3" \\h \\z \\u ');
    expect(three.xml.replace('"1-3"', '"1-2"')).toBe(two.xml);
  }, 90_000);
});

describe('peran entri TOC per tingkat (sumber bersama DOCX + HTML)', () => {
  it('ROLE_KEYS +6 (U71-U76); tocEntryRoles: section selalu toc.section*, lampiran toc.appendix* hanya bila disetel', () => {
    expect(ROLE_KEYS).toHaveLength(76);
    for (const r of ['toc.sectionLabel', 'toc.sectionTitle', 'toc.sectionPage', 'toc.appendixLabel', 'toc.appendixTitle', 'toc.appendixPage']) {
      expect(ROLE_KEYS).toContain(r);
    }
    expect(tocEntryRoles('section', {})).toEqual(['toc.sectionLabel', 'toc.sectionTitle', 'toc.sectionPage']);
    expect(tocEntryRoles('appendix', {})).toEqual(['toc.chapterLabel', 'toc.chapterTitle', 'toc.chapterPage']);
    expect(tocEntryRoles('appendix', { 'toc.appendixTitle': { run: { b: true } } })).toEqual(['toc.chapterLabel', 'toc.appendixTitle', 'toc.chapterPage']);
    expect(tocEntryRoles('part', {})).toEqual(['toc.partLabel', 'toc.partTitle', 'toc.partPage']);
    expect(tocSectionIndentTw({ 'type.scale.tableBody.size': 8.2 })).toBe(328);
    expect(tocSectionIndentTw({})).toBe(328);
  });

  it.each([
    ['kanonik (tanpa roleFormats)', 'canon'],
    ['profil Manual 000 (roleFormats bab terukur)', 'bench'],
  ])('DOCX statis %s: baris section menjorok tingkat 2 dan 1 pt lebih kecil dari baris bab; lampiran = gaya bab', async (_n, which) => {
    const tpl = which === 'canon' ? CANON : BENCH;
    const indent = tocSectionIndentTw(tpl.params);
    const rows = staticTocRows((await render(composeDoc('static'), tpl)).xml);
    const ch = rows.get('Bab 1')!;
    const sec = rows.get('1.1')!;
    // label + judul menjorok, halaman tidak
    expect([indLeft(sec[0]) - indLeft(ch[0]), indLeft(sec[1]) - indLeft(ch[1]), indLeft(sec[2]) - indLeft(ch[2])]).toEqual([indent, indent, 0]);
    // setiap sel: ukuran run section = ukuran bab - 2 setengah-poin
    for (let i = 0; i < 3; i++) {
      const cs = sizes(ch[i]);
      expect(cs.length).toBeGreaterThan(0);
      expect(sizes(sec[i])).toEqual(cs.map((s) => s - 2));
    }
    // lampiran tanpa peran toc.appendix* di templat: format sel identik dengan bab
    const app = rows.get('Lampiran A')!;
    for (let i = 1; i < 3; i++) expect(formatOnly(app[i])).toBe(formatOnly(ch[i]));
  }, 90_000);

  it('DOCX medan: paragraf section ber-w:ind left = indentasi, tab judul bergeser sama; paragraf bab tidak berubah', async () => {
    const tpl = withParams(CANON, { 'render.toc.mode': 'field' });
    const { xml } = await render(composeDoc('field'), tpl);
    const paras = xml.match(/<w:p[ >][\s\S]*?<\/w:p>/g) ?? [];
    const sec = paras.find((p) => p.includes('PAGEREF _StToc_002'))!;
    const ch = paras.find((p) => p.includes('PAGEREF _StToc_001'))!;
    const indent = tocSectionIndentTw(tpl.params);
    expect(indLeft(sec)).toBe(indent);
    expect(indLeft(ch)).toBe(0);
    const tabs = (p: string) => [...p.matchAll(/<w:tab w:val="(\w+)"[^>]*w:pos="(\d+)"/g)].map((m) => [m[1], Number(m[2])] as const);
    expect(tabs(sec)[0][1] - tabs(ch)[0][1]).toBe(indent);
    expect(tabs(sec)[1]).toEqual(tabs(ch)[1]);
  }, 60_000);

  it('templat menyetel toc.sectionTitle.run / toc.appendixTitle.run: sub-objek templat menang, indentasi turunan tetap', async () => {
    const tpl = withRoles(CANON, {
      'toc.sectionTitle': { run: { faceRole: 'serif', szHalfPt: 30, color: '112233' } },
      'toc.appendixTitle': { run: { faceRole: 'serif', szHalfPt: 26, color: '445566' } },
    });
    const { xml, html } = await render(composeDoc('static'), tpl);
    const rows = staticTocRows(xml);
    expect(sizes(rows.get('1.1')![1])).toEqual([30]);
    expect(rows.get('1.1')![1]).toContain('<w:color w:val="112233"/>');
    expect(indLeft(rows.get('1.1')![1])).toBe(tocSectionIndentTw(tpl.params));
    expect(sizes(rows.get('Lampiran A')![1])).toEqual([26]);
    expect(rows.get('Lampiran A')![1]).toContain('<w:color w:val="445566"/>');
    // HTML: peran yang sama dipakai
    expect(htmlCells(html, 'toc.appendixTitle')).toHaveLength(1);
    expect(htmlCells(html, 'toc.appendixTitle')[0]).toContain('font-size:13pt');
    expect(htmlCells(html, 'toc.sectionTitle')[0]).toContain('font-size:15pt');
  }, 60_000);

  it('HTML: baris section memakai data-role toc.section* (label/judul menjorok, 1 pt lebih kecil); bab dan lampiran = peran bab', async () => {
    const canon = (await render(composeDoc('static'), CANON)).html;
    const pad = `padding-left:${tocSectionIndentTw(CANON.params) / 20}pt`;
    expect(htmlCells(canon, 'toc.sectionLabel')).toHaveLength(3);
    expect(htmlCells(canon, 'toc.sectionTitle')).toHaveLength(3);
    expect(htmlCells(canon, 'toc.sectionPage')).toHaveLength(3);
    for (const c of [...htmlCells(canon, 'toc.sectionLabel'), ...htmlCells(canon, 'toc.sectionTitle')]) expect(c).toContain(pad);
    for (const c of htmlCells(canon, 'toc.sectionPage')) expect(c).not.toContain('padding-left');
    // kanonik (ENG-01, D-463): ukuran bab efektif = benchmark/katalog seperti DOCX -> section = ukuran bab - 1 pt
    const canonChSz = /font-size:([\d.]+)pt/.exec(htmlCells(canon, 'toc.chapterTitle')[0])?.[1];
    expect(canonChSz).toBeDefined();
    for (const c of htmlCells(canon, 'toc.sectionTitle')) expect(c).toContain(`font-size:${Number(canonChSz) - 1}pt`);
    // bab 2 + lampiran A memakai peran bab (lampiran tanpa peran templat sendiri)
    expect(htmlCells(canon, 'toc.chapterLabel')).toHaveLength(3);
    expect(htmlCells(canon, 'toc.appendixLabel')).toHaveLength(0);
    // profil Manual 000: ukuran bab eksplisit -> section = ukuran bab - 1 pt
    const bench = (await render(composeDoc('static'), BENCH)).html;
    const chSz = /font-size:([\d.]+)pt/.exec(htmlCells(bench, 'toc.chapterTitle')[0])?.[1];
    expect(chSz).toBeDefined();
    expect(htmlCells(bench, 'toc.sectionTitle')[0]).toContain(`font-size:${Number(chSz) - 1}pt`);
  }, 90_000);
});
