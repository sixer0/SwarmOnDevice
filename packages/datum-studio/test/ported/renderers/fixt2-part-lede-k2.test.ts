// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/renderers/fixt2-part-lede-k2.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
// FIX-T2 perluasan (D-350; temuan FIX-R1): lede pembatas bagian (`part.lede`) adalah prosa tanpa
// chip. Pada moda rel K2 (A + `framePr`, HS rev B) paragraf itu selebar teks penuh, jadi indentasi
// kanan peran yang sama dengan cadangan rel (gutter + rel = 340 + 1814 = 2154 tw) dibuang. Pada
// `table3col` (Manual 000, BM K-22) indentasi tetap. G-RAIL-3 FIX-R1 melewati unit bagian, jadi
// uji ini menjaga unit tersebut.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from '../_vitest';
import type { NormDocSnapshot, ResolvedTemplate } from '@/lib/studio/contract';
import { assembleDocxDetailed } from '@/lib/studio/engine/docx/assemble';
import { assembleHtml } from '@/lib/studio/engine/html/assemble';
import { composeV2 } from '@/lib/studio/services/compose';
import { withParams } from '../engine-core/fixtures';
import { datumSlots, defaultParams, e1, merge, skeletonInput } from '../structure/_kit';
import { benchmarkTemplate, makeCtx, partText, unzip } from './_kit';

const LEDE = 'Bagian ini merangkum temuan lapangan.';

function composeDoc() {
  const d = e1();
  d.sections.content.parts = [{ id: 'P1', title: { text: 'Bagian Satu' }, lede: { text: LEDE } }];
  d.sections.content.chapters[1].partId = 'P1';
  const slots = datumSlots();
  return composeV2({ source: merge(d, undefined, { slots }).doc, skeleton: skeletonInput(slots), params: defaultParams() }).snapshot as unknown as NormDocSnapshot;
}

async function ledeParagraph(tpl: ResolvedTemplate): Promise<string> {
  const { ctx } = makeCtx(composeDoc(), tpl);
  const bytes = (await assembleDocxDetailed(ctx)).bytes;
  const dir = process.env.FIXT2_OUT;
  if (dir) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, `part_lede_${tpl.params['render.rail.renderer']}.docx`), bytes);
  }
  const xml = partText(unzip(bytes), 'word/document.xml');
  const paras = (xml.match(/<w:p[ >][\s\S]*?<\/w:p>/g) ?? []).filter((p) => p.includes(LEDE));
  expect(paras).toHaveLength(1);
  return paras[0];
}

let BENCH: ResolvedTemplate;
beforeAll(async () => {
  BENCH = await benchmarkTemplate();
});

describe('part.lede pada moda rel K2 (D-350)', () => {
  it('table3col (profil Manual 000): indentasi kanan peran 2154 tetap (BM K-22)', async () => {
    const tpl = withParams(BENCH, { 'render.rail.renderer': 'table3col' });
    expect(await ledeParagraph(tpl)).toMatch(/<w:ind w:right="2154"\/>/);
  }, 60_000);

  it('framePr moda A (K2 rev B): lede tanpa indentasi kanan, format lain peran tetap', async () => {
    const tpl = withParams(BENCH, { 'render.rail.renderer': 'framePr' });
    const p = await ledeParagraph(tpl);
    expect(p).not.toMatch(/<w:ind\b[^>]*w:right=/);
    // spasi peran K-22 (after 360, line 300) dan run miring tetap
    expect(p).toMatch(/<w:spacing w:before="0" w:after="360" w:line="300"/);
    expect(p).toMatch(/<w:i\/>/);
  }, 60_000);

  it('framePr dengan indentasi peran yang bukan cadangan rel: nilai templat dihormati', async () => {
    const tpl = withParams(BENCH, { 'render.rail.renderer': 'framePr' });
    const own = { ...tpl, roleFormats: { ...tpl.roleFormats, 'part.lede': { para: { indRightTw: 1134 } } } } as ResolvedTemplate;
    expect(await ledeParagraph(own)).toMatch(/<w:ind w:right="1134"\/>/);
  }, 60_000);

  it('HTML: margin kanan cadangan rel (107.7pt) dibuang pada framePr K2, tetap pada table3col', async () => {
    const ledeStyle = async (r: string) => {
      const html = await assembleHtml(makeCtx(composeDoc(), withParams(BENCH, { 'render.rail.renderer': r })).ctx, { preview: false });
      const m = html.match(/<p class="st-p st-part-lede[^"]*" style="([^"]*)"/);
      expect(m).not.toBeNull();
      return m![1];
    };
    const k2 = await ledeStyle('framePr');
    expect(k2).not.toMatch(/margin-right/);
    expect(k2).toMatch(/margin-bottom:18pt/);
    expect(await ledeStyle('table3col')).toMatch(/margin-right:107\.7pt/);
  }, 60_000);
});
