// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/renderers/fixh4-rail-toc.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
/* eslint-disable @typescript-eslint/no-explicit-any -- fixture JSON kontrak dibaca bebas-bentuk di uji */
// FIX-H4 (D-321/D-322 H4; uji Hermes C4): rel bukti rev B dari medan `rail` paragraf v2
// dan daftar isi bernomor halaman.
//
// Sumber ekspektasi = spesifikasi HS datum-house-style (RAIL-1008 rev B, v2.3.1):
//   bentuk byte kanonis PASCA round-trip Word `<w:framePr w:w="W" w:wrap="none"
//   w:hAnchor="margin" w:x="X"/>` dengan W = lebar rel, X = kolom teks + gutter
//   (token grid, bukan konstanta A4); inang menyempit `w:ind right` = gutter + rel;
//   chip sesudah inang; `w:anchorH` dilarang (CTXWIN-1009). TOC: medan
//   `PAGEREF <penanda> \h` ke penanda pada judul sasaran (nomor dihitung pembaca).
import { beforeAll, describe, expect, it } from '../_vitest';
import type { NormDocSnapshot, ResolvedTemplate } from '@/lib/studio/contract';
import { assembleDocxDetailed } from '@/lib/studio/engine/docx/assemble';
import { assembleHtml } from '@/lib/studio/engine/html/assemble';
import { composeV2 } from '@/lib/studio/services/compose';
import { resolveRepoAssetPath, scanCanonicalAssets } from '@/lib/studio/services/templates/assets';
import { DATUM_CANONICAL_SLUG, resolveProfileInMemory } from '@/lib/studio/services/templates/profile';
import { withParams } from '../engine-core/fixtures';
import { datumSlots, defaultParams, e1, merge, skeletonInput } from '../structure/_kit';
import { benchmarkTemplate, makeCtx, parseXml, partText, REPO, unzip } from './_kit';

const mmToTw = (mm: number) => Math.round((mm * 1440) / 25.4);
const RAIL = [
  { kind: 'mark', mark: 'TERUKUR' },
  { kind: 'source', text: 'Register P-40' },
];

/** E1 + rel pada paragraf pertama bab 1 + bagian P1 (bab 2) + lampiran A bawaan. */
function composeDoc(tocMode: 'static' | 'field', mutate?: (d: any) => void) {
  const d = e1();
  d.sections.content.chapters[0].sections[0].blocks[0].rail = RAIL;
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
  return { xml, html, logs };
}

const paragraphsXml = (xml: string) => xml.match(/<w:p[ >][\s\S]*?<\/w:p>/g) ?? [];
const textOf = (p: string) => (p.match(/<w:t[^>]*>[^<]*<\/w:t>/g) ?? []).map((t) => t.replace(/<[^>]+>/g, '')).join('');
const framePrs = (xml: string) => xml.match(/<w:framePr [^>]*\/>/g) ?? [];

let BENCH: ResolvedTemplate;
let LETTER: ResolvedTemplate;
beforeAll(async () => {
  BENCH = await benchmarkTemplate();
  const ca = await scanCanonicalAssets(REPO);
  LETTER = resolveProfileInMemory(
    { base: DATUM_CANONICAL_SLUG, slug: 'fixh4-letter', kind: 'DOCUMENT', overrides: { 'page.size': 'Letter' } as never },
    { canonicalAssets: ca, resolveAssetPath: (rel: string) => resolveRepoAssetPath(rel, REPO) },
  );
});

describe('rel bukti rev B (framePr) dari medan rail paragraf v2', () => {
  it('A4 profil GSP DATUM + perender framePr: chip bentuk kanonis HS, satu framePr per baris rel, sesudah inang', async () => {
    const tpl = withParams(BENCH, { 'render.rail.renderer': 'framePr' });
    const { xml } = await render(composeDoc('static'), tpl);
    expect(parseXml(xml).errors).toEqual([]);
    const fp = framePrs(xml);
    // G-RAIL-1 (sisi mesin): jumlah framePr badan == jumlah baris rel yang dipindah.
    expect(fp).toHaveLength(RAIL.length);
    for (const f of fp) expect(f).toBe('<w:framePr w:w="1814" w:wrap="none" w:hAnchor="margin" w:x="7597"/>');
    expect(xml).not.toContain('w:anchorH');
    const paras = paragraphsXml(xml);
    const host = paras.findIndex((p) => textOf(p) === 'Survei mendata kondisi peralatan 150 kV.');
    expect(host).toBeGreaterThan(0);
    // inang menyempit gutter + rel (6 + 32 mm = 2154 tw) tanpa bingkai; chip berurutan langsung sesudahnya.
    expect(paras[host]).toContain('<w:ind w:right="2154"/>');
    expect(paras[host]).not.toContain('framePr');
    expect(paras[host + 1]).toContain('<w:framePr ');
    expect(textOf(paras[host + 1])).toContain('TERUKUR');
    expect(paras[host + 2]).toContain('<w:framePr ');
    expect(textOf(paras[host + 2])).toBe('Register P-40');
    // tidak ada tabel 1x3 rel (perender table3col) untuk paragraf ini
    expect(xml).not.toMatch(/<w:gridCol w:w="7257"\/><w:gridCol w:w="340"\/><w:gridCol w:w="1814"\/>/);
  }, 60_000);

  it('kertas Letter (grid turunan D-245): lebar dan posisi chip dari token, bukan konstanta A4', async () => {
    const text = LETTER.params['grid.textColumnMm'] as number;
    const gutter = LETTER.params['grid.gutterMm'] as number;
    const rail = LETTER.params['grid.evidenceRailMm'] as number;
    expect(text).not.toBe(128);
    const { xml } = await render(composeDoc('static'), LETTER);
    const fp = framePrs(xml);
    expect(fp).toHaveLength(RAIL.length);
    const want = `<w:framePr w:w="${mmToTw(rail)}" w:wrap="none" w:hAnchor="margin" w:x="${mmToTw(text) + mmToTw(gutter)}"/>`;
    for (const f of fp) expect(f).toBe(want);
    expect(want).not.toContain('w:x="7597"');
  }, 60_000);

  it('profil Manual 000 (table3col) tetap tabel 1x3 tanpa framePr (regresi benchmark)', async () => {
    expect(BENCH.params['render.rail.renderer']).toBe('table3col');
    const { xml } = await render(composeDoc('static'), BENCH);
    expect(framePrs(xml)).toHaveLength(0);
    expect(xml).toMatch(/<w:gridCol w:w="7257"\/><w:gridCol w:w="340"\/><w:gridCol w:w="1814"\/>/);
  }, 60_000);

  it('templat mematikan rel (device.evidenceRail.enabled=false): moda B jelas di DOCX dan HTML, baris tetap tertulis, log warn', async () => {
    const tpl = withParams(BENCH, { 'render.rail.renderer': 'framePr', 'device.evidenceRail.enabled': false });
    const { xml, html, logs } = await render(composeDoc('static'), tpl);
    expect(framePrs(xml)).toHaveLength(0);
    expect(xml).not.toMatch(/<w:gridCol w:w="7257"\/><w:gridCol w:w="340"\/><w:gridCol w:w="1814"\/>/);
    const paras = paragraphsXml(xml).map(textOf);
    const host = paras.indexOf('Survei mendata kondisi peralatan 150 kV.');
    expect(paras[host + 1]).toContain('TERUKUR');
    expect(paras[host + 2]).toBe('Register P-40');
    expect(logs.some((l) => l.level === 'warn' && /device\.evidenceRail\.enabled = false/.test(l.message))).toBe(true);
    expect(html).toMatch(/<body[^>]*class="[^"]*st-rail-b/);
  }, 60_000);

  it('HTML: rel = elemen kolom margin (st-railhost + st-rail) pada moda A', async () => {
    const tpl = withParams(BENCH, { 'render.rail.renderer': 'framePr' });
    const { html } = await render(composeDoc('static'), tpl);
    expect(html).toMatch(/<body[^>]*class="[^"]*st-rail-a/);
    expect(html).toMatch(/<div class="st-railhost"[^>]*><div class="st-railhost-main">[\s\S]*?Survei mendata[\s\S]*?<\/div><div class="st-rail" role="note">[\s\S]*?TERUKUR[\s\S]*?Register P-40/);
  }, 60_000);
});

describe('daftar isi bernomor halaman', () => {
  // FIX-T2: kedalaman 1 (bab/bagian/lampiran) dipatok; entri section bawaan (kedalaman 2) diuji fixt2-toc-sections.
  const TOC1 = () => withParams(BENCH, { 'toc.levels': 1 });
  const NAMES = ['_StToc_001', '_StToc_002', '_StToc_003', '_StToc_004'];
  const TITLES = ['Lingkup Survei', 'Bagian Satu', 'Temuan Utama', 'Data Mentah'];

  function bookmarks(xml: string) {
    const starts = [...xml.matchAll(/<w:bookmarkStart w:id="(\d+)" w:name="([^"]+)"\/>/g)].map((m) => ({ id: m[1], name: m[2] }));
    const ends = [...xml.matchAll(/<w:bookmarkEnd w:id="(\d+)"\/>/g)].map((m) => m[1]);
    return { starts, ends };
  }

  function assertTargets(xml: string) {
    const { starts, ends } = bookmarks(xml);
    expect(starts.map((s) => s.name)).toEqual(NAMES);
    expect(new Set(starts.map((s) => s.id)).size).toBe(starts.length);
    expect([...ends].sort()).toEqual(starts.map((s) => s.id).sort());
    // penanda berada di paragraf judul sasaran (bab 1, bagian, bab 2, lampiran) dan nama sah Word
    for (const [i, s] of starts.entries()) {
      expect(s.name).toMatch(/^[A-Za-z_][A-Za-z0-9_]{0,39}$/);
      const para = paragraphsXml(xml).find((p) => p.includes(`w:name="${s.name}"`))!;
      expect(textOf(para)).toBe(TITLES[i]);
    }
  }

  it('statis (profil GSP DATUM): kolom halaman = medan PAGEREF ke penanda judul, urut entri', async () => {
    const { xml, logs } = await render(composeDoc('static'), TOC1());
    expect(parseXml(xml).errors).toEqual([]);
    const refs = [...xml.matchAll(/<w:instrText xml:space="preserve"> PAGEREF (\S+) \\h <\/w:instrText>/g)].map((m) => m[1]);
    expect(refs).toEqual(NAMES);
    assertTargets(xml);
    // medan kompleks lengkap begin/separate/end per entri
    expect((xml.match(/w:fldCharType="begin"/g) ?? []).length).toBeGreaterThanOrEqual(NAMES.length);
    expect(logs.some((l) => /daftar isi statis tanpa entries/.test(l.message))).toBe(false);
  }, 60_000);

  it('medan (render.toc.mode=field): TOC \\o \\h \\z \\u + PAGEREF bersarang, tab label kiri + halaman kanan', async () => {
    const { xml } = await render(composeDoc('field'), withParams(BENCH, { 'render.toc.mode': 'field', 'toc.levels': 1 }));
    expect(parseXml(xml).errors).toEqual([]);
    // FIX-T2: rentang kerangka medan ikut toc.levels (1 -> "1-1"; bawaan 2 -> "1-2", diuji fixt2).
    expect(xml).toContain('<w:instrText xml:space="preserve"> TOC \\o "1-1" \\h \\z \\u </w:instrText>');
    const refs = [...xml.matchAll(/ PAGEREF (\S+) \\h /g)].map((m) => m[1]);
    expect(refs).toEqual(NAMES);
    assertTargets(xml);
    const entry = paragraphsXml(xml).find((p) => p.includes('PAGEREF _StToc_001'))!;
    expect(entry).toMatch(/<w:tabs><w:tab w:val="left"[^>]*\/><w:tab w:val="right"[^>]*\/><\/w:tabs>/);
  }, 60_000);

  it('entri eksplisit berhalaman literal (pola Manual 000): tanpa penanda dan tanpa PAGEREF', async () => {
    const snap = composeDoc('static');
    const toc = snap.blocks.find((b) => b.type === 'toc')!;
    toc.content = { ...(toc.content as object), entries: [{ level: 'chapter', label: { text: 'Bab 1' }, title: { text: 'Lingkup Survei' }, page: '5' }] } as never;
    const { xml } = await render(snap, TOC1());
    expect(xml).not.toContain('w:bookmarkStart');
    expect(xml).not.toContain('PAGEREF');
    expect(paragraphsXml(xml).map(textOf)).toContain('5');
  }, 60_000);

  it('dokumen tanpa TOC: judul bab tanpa penanda (keluaran tak berubah)', async () => {
    const snap = composeDoc('static');
    snap.blocks = snap.blocks.filter((b) => b.type !== 'toc');
    const { xml } = await render(snap, TOC1());
    expect(xml).not.toContain('w:bookmarkStart');
  }, 60_000);

  it('HTML: entri turunan = tautan jangkar internal ke kepala bab/bagian/lampiran yang ada', async () => {
    const { html } = await render(composeDoc('static'), TOC1());
    const hrefs = [...html.matchAll(/<a class="st-toc-link" href="#([^"]+)">/g)].map((m) => m[1]);
    expect(hrefs).toEqual(['st-ch-1', 'st-part-P1', 'st-ch-2', 'st-app-A']);
    for (const h of hrefs) expect(html).toContain(`id="${h}"`);
    expect(html).not.toMatch(/href="(?!#|data:)/);
  }, 60_000);
});
