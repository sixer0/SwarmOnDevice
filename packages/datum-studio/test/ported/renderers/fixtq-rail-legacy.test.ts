// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/renderers/fixtq-rail-legacy.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
/* eslint-disable @typescript-eslint/no-explicit-any -- fixture JSON kontrak dibaca bebas-bentuk di uji */
// FIX-TQ (D-359; review SR-56e E5): G-RAIL-3 rev B (K2) saat merender ulang revisi LAMA.
// Satu-satunya jalur data yang dapat memicu gerbang adalah `format` eksplisit di konten,
// yang hanya sah pada kontrak v1 (snapshot `studio.norm/v1`, mis. Manual 000 rev 1).
// v1: pelanggaran dilaporkan (log warn + contoh), render dilanjutkan (D-06 revisi lama
// tetap dapat dirender ulang). v2 konten-saja (D-139): tetap gagal keras (cacat mesin).
import { beforeAll, describe, expect, it } from '../_vitest';
import type { NormDocSnapshot, ResolvedTemplate } from '@/lib/studio/contract';
import { assembleDocxDetailed } from '@/lib/studio/engine/docx/assemble';
import { composeV2 } from '@/lib/studio/services/compose';
import { withParams } from '../engine-core/fixtures';
import { datumSlots, defaultParams, e1, merge, skeletonInput } from '../structure/_kit';
import { benchmarkTemplate, loadFixtureDoc, makeCtx, partText, snapshotOf, unzip } from './_kit';

const RESERVE = 2154;

const paragraphsXml = (xml: string) => xml.match(/<w:p[ >][\s\S]*?<\/w:p>/g) ?? [];
const textOf = (p: string) => (p.match(/<w:t[^>]*>[^<]*<\/w:t>/g) ?? []).map((t) => t.replace(/<[^>]+>/g, '')).join('');
const rightOf = (p: string) => /<w:ind\b[^>]*\bw:right="(\d+)"/.exec(p)?.[1];

async function renderDocx(snap: NormDocSnapshot, tpl: ResolvedTemplate) {
  const { ctx, logs } = makeCtx(snap, tpl);
  const detail = await assembleDocxDetailed(ctx);
  return { xml: partText(unzip(detail.bytes), 'word/document.xml'), logs };
}

/** Paragraf polos pertama di unit bab (bukan inang rel) beserta teksnya. */
function firstChapterParagraph(snap: NormDocSnapshot): any {
  const chapterUnits = new Set(snap.units.filter((u) => u.kind === 'chapter').map((u) => u.key));
  const b = (snap.blocks as any[]).find((x) => x.type === 'paragraph' && chapterUnits.has(x.unitKey) && !x.content?.rail && typeof x.content?.text === 'string');
  expect(b, 'fixture punya paragraf polos di unit bab').toBeDefined();
  return b;
}

let GSP: ResolvedTemplate;
beforeAll(async () => {
  // datum-gsp v3 (D-327) = profil benchmark + perender framePr (moda K2); peran badan membawa indRightTw 2154.
  GSP = withParams(await benchmarkTemplate(), { 'render.rail.renderer': 'framePr' });
});

describe('G-RAIL-3 revisi lama (snapshot v1 berformat eksplisit)', () => {
  it('v1 tanpa format eksplisit: lulus, tanpa laporan legacy', async () => {
    const snap = snapshotOf(loadFixtureDoc('doc_terbit_report'));
    expect(snap.schema).toBe('studio.norm/v1');
    const { logs } = await renderDocx(snap, GSP);
    expect(logs.some((l) => l.code === 'RAIL_K2_LEGACY_V1')).toBe(false);
  }, 60_000);

  it('v1 + format eksplisit indRightTw = cadangan rel (pola konten lama): render TIDAK gagal, dilaporkan warn + contoh, format penulis dihormati', async () => {
    const snap = snapshotOf(loadFixtureDoc('doc_terbit_report'));
    const plain = firstChapterParagraph(snap);
    plain.content = { ...plain.content, format: { indRightTw: RESERVE } };
    const { xml, logs } = await renderDocx(snap, GSP);
    const unitWarn = logs.filter((l) => l.level === 'warn' && l.code === 'RAIL_K2_LEGACY_V1' && l.address);
    expect(unitWarn).toHaveLength(1);
    expect(unitWarn[0].message).toMatch(/G-RAIL-3 rev B \(K2\) gagal .*1 paragraf tanpa chip menyempit w:right=2154/);
    expect(unitWarn[0].message).toContain('snapshot studio.norm/v1');
    expect(unitWarn[0].message).toContain(JSON.stringify(String(plain.content.text).slice(0, 60)));
    expect(logs.some((l) => l.level === 'warn' && l.code === 'RAIL_K2_LEGACY_V1' && !l.address && /1 unit snapshot v1 dilaporkan/.test(l.message))).toBe(true);
    const para = paragraphsXml(xml).find((p) => textOf(p) === plain.content.text);
    expect(para && rightOf(para)).toBe(String(RESERVE));
  }, 60_000);

  it('v1 + indentasi kanan eksplisit selain cadangan (pola Manual 000: 1701/1134): tanpa laporan', async () => {
    const snap = snapshotOf(loadFixtureDoc('doc_terbit_report'));
    const plain = firstChapterParagraph(snap);
    plain.content = { ...plain.content, format: { indRightTw: 1701 } };
    const { logs } = await renderDocx(snap, GSP);
    expect(logs.some((l) => l.code === 'RAIL_K2_LEGACY_V1')).toBe(false);
  }, 60_000);

  it('v2 konten-saja dengan format yang sama (hanya mungkin lewat cacat mesin): tetap gagal keras BY_CONSTRUCTION_FAILED', async () => {
    const slots = datumSlots();
    const snap = composeV2({ source: merge(e1(), undefined, { slots }).doc, skeleton: skeletonInput(slots), params: defaultParams() })
      .snapshot as unknown as NormDocSnapshot;
    expect((snap as any).schema).toBe('studio.norm/v2');
    const plain = firstChapterParagraph(snap);
    plain.content = { ...plain.content, format: { indRightTw: RESERVE } };
    await expect(renderDocx(snap, GSP)).rejects.toMatchObject({
      code: 'BY_CONSTRUCTION_FAILED',
      message: expect.stringMatching(/G-RAIL-3 rev B \(K2\) gagal/),
    });
  }, 60_000);
});
