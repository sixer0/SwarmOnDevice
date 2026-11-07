// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/renderers/fixr1-rail-k2.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
/* eslint-disable @typescript-eslint/no-explicit-any -- fixture JSON kontrak dibaca bebas-bentuk di uji */
// FIX-R1 (D-342 S1; uji ulang Hermes): rel K2 rev B pada perender framePr.
//
// Sumber ekspektasi = HS datum-house-style RAIL rev B (RAIL-1008, datum_docx.py
// `rail_host`: "Dipanggil hanya untuk paragraf yang benar-benar berprovenans";
// margin fisik penuh, teks lebar penuh 166 mm). Jadi: hanya inang chip yang
// menyempit `w:ind right` = gutter + rel; prosa tanpa provenans tanpa indentasi
// kanan cadangan rel. ASSERT G-RAIL-3 rev B (setara konsistensi dua arah HS pada
// tingkat paragraf) gagal keras bila paragraf tanpa chip menyempit atau chip
// tanpa inang. Moda table3col (Manual 000) tidak berubah.
import { beforeAll, describe, expect, it } from '../_vitest';
import type { NormDocSnapshot, ResolvedTemplate } from '@/lib/studio/contract';
import { assembleDocxDetailed } from '@/lib/studio/engine/docx/assemble';
import { assertRailK2, railK2ReserveOf, resolveRailLayout } from '@/lib/studio/engine/docx/blocks/rail';
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
const HOST_TEXT = 'Survei mendata kondisi peralatan 150 kV.';
const PLAIN_TEXT = 'Paragraf prosa tanpa provenans.';

/** E1 + rel pada paragraf pertama bab 1, lalu satu paragraf polos dan satu daftar tanpa rel. */
function composeDoc(mutate?: (d: any) => void) {
  const d = e1();
  const blocks = d.sections.content.chapters[0].sections[0].blocks;
  blocks[0].rail = RAIL;
  blocks.push({ type: 'paragraph', text: PLAIN_TEXT });
  blocks.push({ type: 'list', style: 'bullet', items: [{ text: 'Butir daftar satu.' }, { text: 'Butir daftar dua.' }] });
  mutate?.(d);
  const slots = datumSlots();
  return composeV2({ source: merge(d, undefined, { slots }).doc, skeleton: skeletonInput(slots), params: defaultParams() })
    .snapshot as unknown as NormDocSnapshot;
}

async function renderDocx(snap: NormDocSnapshot, tpl: ResolvedTemplate) {
  const { ctx, logs } = makeCtx(snap, tpl);
  const detail = await assembleDocxDetailed(ctx);
  return { xml: partText(unzip(detail.bytes), 'word/document.xml'), logs };
}

async function renderHtml(snap: NormDocSnapshot, tpl: ResolvedTemplate) {
  return assembleHtml(makeCtx(snap, tpl).ctx, { preview: false });
}

const paragraphsXml = (xml: string) => xml.match(/<w:p[ >][\s\S]*?<\/w:p>/g) ?? [];
const textOf = (p: string) => (p.match(/<w:t[^>]*>[^<]*<\/w:t>/g) ?? []).map((t) => t.replace(/<[^>]+>/g, '')).join('');
const rightOf = (p: string) => /<w:ind\b[^>]*\bw:right="(\d+)"/.exec(p)?.[1];

/** Paragraf menyempit `w:right=reserve` yang TIDAK diikuti chip framePr. */
function narrowedWithoutChip(xml: string, reserve: number) {
  const paras = paragraphsXml(xml);
  return paras.filter((p, i) => !p.includes('<w:framePr') && rightOf(p) === String(reserve) && !paras[i + 1]?.includes('<w:framePr'));
}

let BENCH: ResolvedTemplate;
let GSP: ResolvedTemplate;
let LETTER: ResolvedTemplate;
beforeAll(async () => {
  BENCH = await benchmarkTemplate();
  // datum-gsp v3 (D-327) = profil benchmark + perender framePr; peran badan membawa indRightTw 2154.
  GSP = withParams(BENCH, { 'render.rail.renderer': 'framePr' });
  const ca = await scanCanonicalAssets(REPO);
  LETTER = resolveProfileInMemory(
    { base: DATUM_CANONICAL_SLUG, slug: 'fixr1-letter', kind: 'DOCUMENT', overrides: { 'page.size': 'Letter' } as never },
    { canonicalAssets: ca, resolveAssetPath: (rel: string) => resolveRepoAssetPath(rel, REPO) },
  );
});

describe('K2 rev B: indentasi kanan hanya pada inang chip (DOCX framePr)', () => {
  it('prasyarat: profil GSP menulis indRightTw = cadangan rel pada peran badan (akar cacat Hermes S1)', () => {
    for (const role of ['body.paragraph', 'list.bullet'] as const) expect(GSP.roleFormats[role]?.para?.indRightTw).toBe(2154);
    expect(railK2ReserveOf((k) => GSP.params[k])).toBe(2154);
  });

  it('A4 GSP: inang w:right=2154 + chip; paragraf polos dan butir daftar tanpa w:right (selebar teks penuh)', async () => {
    const { xml, logs } = await renderDocx(composeDoc(), GSP);
    expect(parseXml(xml).errors).toEqual([]);
    const paras = paragraphsXml(xml);
    const host = paras.findIndex((p) => textOf(p) === HOST_TEXT);
    expect(rightOf(paras[host])).toBe('2154');
    expect(paras[host + 1]).toContain('<w:framePr w:w="1814" w:wrap="none" w:hAnchor="margin" w:x="7597"/>');
    expect(paras[host + 2]).toContain('<w:framePr ');
    const plain = paras.find((p) => textOf(p) === PLAIN_TEXT)!;
    expect(rightOf(plain)).toBeUndefined();
    for (const t of ['Butir daftar satu.', 'Butir daftar dua.']) {
      const li = paras.find((p) => textOf(p).endsWith(t))!;
      expect(rightOf(li)).toBeUndefined();
    }
    expect(narrowedWithoutChip(xml, 2154)).toEqual([]);
    expect(logs.some((l) => l.level === 'info' && /G-RAIL-3 rev B \(K2\) lulus: .*1 inang, 2 chip/.test(l.message))).toBe(true);
  }, 60_000);

  it('kertas Letter (grid turunan): cadangan dari token, prosa tanpa rel tetap tanpa indentasi kanan', async () => {
    const reserve = mmToTw(LETTER.params['grid.gutterMm'] as number) + mmToTw(LETTER.params['grid.evidenceRailMm'] as number);
    expect(railK2ReserveOf((k) => LETTER.params[k])).toBe(reserve);
    const { xml } = await renderDocx(composeDoc(), LETTER);
    const paras = paragraphsXml(xml);
    const host = paras.findIndex((p) => textOf(p) === HOST_TEXT);
    expect(rightOf(paras[host])).toBe(String(reserve));
    expect(rightOf(paras.find((p) => textOf(p) === PLAIN_TEXT)!)).toBeUndefined();
    expect(narrowedWithoutChip(xml, reserve)).toEqual([]);
  }, 60_000);

  it('ASSERT G-RAIL-3 gagal keras: format eksplisit menyempitkan paragraf tanpa chip sebesar cadangan rel', async () => {
    // Kiriman v2 konten-saja membuang `format` (D-139); format disuntik ke snapshot ternormalisasi
    // (jalur v1/impor lama yang masih membawa format eksplisit).
    const snap = composeDoc();
    const plain = (snap.blocks as any[]).find((b) => b.type === 'paragraph' && b.content?.text === PLAIN_TEXT);
    expect(plain).toBeDefined();
    plain.content = { ...plain.content, format: { indRightTw: 2154 } };
    await expect(renderDocx(snap, GSP)).rejects.toMatchObject({
      code: 'BY_CONSTRUCTION_FAILED',
      message: expect.stringMatching(/G-RAIL-3 rev B \(K2\) gagal .*1 paragraf tanpa chip menyempit w:right=2154/),
    });
  }, 60_000);

  it('Manual 000 (table3col) tidak berubah: tabel 1x3, paragraf polos tetap memakai indentasi peran, gerbang tidak berjalan', async () => {
    expect(BENCH.params['render.rail.renderer']).toBe('table3col');
    expect(railK2ReserveOf((k) => BENCH.params[k])).toBeUndefined();
    const { xml, logs } = await renderDocx(composeDoc(), BENCH);
    expect(xml).toMatch(/<w:gridCol w:w="7257"\/><w:gridCol w:w="340"\/><w:gridCol w:w="1814"\/>/);
    expect(xml).not.toContain('<w:framePr');
    expect(rightOf(paragraphsXml(xml).find((p) => textOf(p) === PLAIN_TEXT)!)).toBe('2154');
    expect(logs.some((l) => /G-RAIL-3/.test(l.message))).toBe(false);
  }, 60_000);
});

describe('assertRailK2 (G-RAIL-3 rev B) atas XML sintetis', () => {
  const K2 = resolveRailLayout((k) => ({ 'render.rail.colsTw': [7257, 340, 1814] } as Record<string, any>)[k], () => 0);
  const host = '<w:p><w:pPr><w:ind w:right="2154"/></w:pPr><w:r><w:t>Inang</w:t></w:r></w:p>';
  const chip = '<w:p><w:pPr><w:framePr w:w="1814" w:wrap="none" w:hAnchor="margin" w:x="7597"/></w:pPr><w:r><w:t>TERUKUR</w:t></w:r></w:p>';
  const plain = '<w:p><w:pPr><w:jc w:val="both"/></w:pPr><w:r><w:t>Prosa</w:t></w:r></w:p>';
  const narrow = '<w:p><w:pPr><w:ind w:right="2154"/></w:pPr><w:r><w:t>Prosa sempit</w:t></w:r></w:p>';

  it('inang + dua chip + prosa penuh = lulus dengan hitungan', () => {
    expect(assertRailK2(plain + host + chip + chip + plain + '<w:p/>', K2, 'uji')).toEqual({ hosts: 1, chips: 2 });
  });

  it('paragraf menyempit tanpa chip = BY_CONSTRUCTION_FAILED', () => {
    expect(() => assertRailK2(plain + narrow + plain, K2, 'bab:1')).toThrow(/G-RAIL-3 rev B \(K2\) gagal pada bab:1: 1 paragraf tanpa chip menyempit w:right=2154/);
  });

  it('chip tanpa inang = BY_CONSTRUCTION_FAILED', () => {
    expect(() => assertRailK2(plain + chip, K2, 'bab:2')).toThrow(/1 chip w:framePr tanpa paragraf inang/);
  });

  it('di luar moda K2 (table3col, moda B, rel dimatikan) tidak memeriksa', () => {
    const t3 = resolveRailLayout((k) => ({ 'render.rail.renderer': 'table3col', 'render.rail.colsTw': [7257, 340, 1814] } as Record<string, any>)[k], () => 0);
    const b = resolveRailLayout((k) => ({ 'layout.railMode': 'B' } as Record<string, any>)[k], () => 128);
    const off = resolveRailLayout((k) => ({ 'device.evidenceRail.enabled': false } as Record<string, any>)[k], () => 128);
    for (const lay of [t3, b, off]) expect(assertRailK2(narrow + chip, lay, 'x')).toBeUndefined();
  });
});

describe('K2 rev B padanan HTML', () => {
  it('GSP framePr: body st-rail-k2 + aturan lebar penuh; paragraf badan tanpa margin-right cadangan rel', async () => {
    const html = await renderHtml(composeDoc(), GSP);
    expect(html).toMatch(/<body[^>]*class="[^"]*st-rail-a st-rail-k2/);
    expect(html).toContain('body.st-rail-k2.st-rail-a :is(.st-p,.st-list,.st-aside,.st-monoblock,.st-asm,.st-section-heading):not(.st-railhost *){max-width:none}');
    // 2154 tw = 107.7 pt: tidak ada pada prosa polos maupun inang (inang menyempit lewat grid st-railhost).
    expect(html).not.toContain('margin-right:107.7pt');
    expect(html).toMatch(/<div class="st-railhost"[^>]*><div class="st-railhost-main">[\s\S]*?Survei mendata[\s\S]*?<div class="st-rail" role="note">/);
  }, 60_000);

  it('Manual 000 (table3col): tanpa st-rail-k2, margin peran tetap (tidak berubah)', async () => {
    const html = await renderHtml(composeDoc(), BENCH);
    expect(html).not.toContain('st-rail-k2');
    expect(html).toContain('margin-right:107.7pt');
  }, 60_000);
});
