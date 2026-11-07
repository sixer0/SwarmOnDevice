// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/figures/fixf-artifact-keyrow.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
// FIX-F C6 (D-313; aturan D-288 satu aparatus, D-145/RQ-10): blok diagram dokumen yang MERUJUK artefak
// (`spec: { artifactId }`) dan membawa `keyRow` dicetak halaman dengan baris KUNCI, jadi SVG artefak tidak
// boleh menggambar baris KEY lagi (dulu hanya spec inline yang ditandai compose). Artefak mandiri / blok
// tanpa keyRow tetap menggambar KEY. Sinyal dipasang pada salinan saat build (spec artefak tidak diubah).
import { afterAll, describe, expect, it, vi } from '../_vitest';
import * as row42OrigFigures from '@/lib/studio/engine/docx/figures'; // row42 W10
import type { NormBlock, NormDocSnapshot, StudioDiagramV1 } from '@/lib/studio/contract';
import { buildDiagramSvg } from '@/lib/studio/engine/diagram/build';
import { clone, parityDiagramSpecs } from './_helpers';

// prepareFigureStore merasterisasi lewat Chromium; uji hanya memeriksa SVG yang dibangun `svgFor`.
// row42 W10: in bun a module mock stays installed for every later suite in the same process (C65/C71 lesson), so the
// mock keeps every real export and replaces prepareFigureStore only while this file runs (flag cleared in afterAll).
const row42Mock = { active: true };
afterAll(() => {
  row42Mock.active = false;
});
vi.mock('@/lib/studio/engine/docx/figures', () => {
  const real = { ...row42OrigFigures };
  return {
    ...real,
    prepareFigureStore: async (snap: { blocks: NormBlock[] }, opts: { svgFor: (b: NormBlock) => Promise<unknown> }, ...rest: unknown[]) => {
      if (!row42Mock.active) return (real.prepareFigureStore as (...a: unknown[]) => unknown)(snap, opts, ...rest);
      const out: unknown[] = [];
      for (const b of snap.blocks) out.push(await opts.svgFor(b));
      return { results: out };
    },
  };
});

const { buildFigures, diagramSpecForBlock } = await import('@/lib/studio/services/render/figures');
const { InlineSpecReader, createDetachedJob } = await import('@/lib/studio/services/render/pure/job');

const GRAPH = parityDiagramSpecs().find((s) => s.spec.family === 'graph')!.spec as unknown as StudioDiagramV1;
const ART: StudioDiagramV1 = { ...clone(GRAPH), apparatus: 'page', legend: [...((GRAPH.legend ?? []) as string[]), 'garis penuh isi'] } as StudioDiagramV1;
const KEY = { runs: [{ t: 'garis penuh isi' }] };

function block(id: string, content: Record<string, unknown>): NormBlock {
  return { blockId: id, type: 'diagram', content, address: null, unitKey: '1' } as unknown as NormBlock;
}

async function svgsOf(blocks: NormBlock[]): Promise<string[]> {
  const snapshot = { doc: { meta: { issueDate: '2026-10-23', tier: 'NOTA' } }, numbering: {}, blocks } as unknown as NormDocSnapshot;
  const r = await buildFigures({
    snapshot,
    tpl: { params: {} } as never,
    tier: 'NOTA',
    job: createDetachedJob(['HTML']) as never,
    reader: new InlineSpecReader({ 'art-1': { kind: 'DIAGRAM', spec: ART } }),
  });
  return r.svgs.map((s) => s.svg);
}

describe('FIX-F C6: keyRowOnPage untuk diagram yang merujuk artefak', () => {
  it('diagramSpecForBlock: hanya rujukan artefak + keyRow yang ditandai; spec artefak tidak dimutasi', () => {
    const marked = diagramSpecForBlock(ART, { spec: { artifactId: 'art-1' }, keyRow: KEY });
    expect(marked.keyRowOnPage).toBe(true);
    expect(ART.keyRowOnPage).toBeUndefined();
    expect(diagramSpecForBlock(ART, { spec: { artifactId: 'art-1' } })).toBe(ART);
    // spec inline: tanda milik compose (D-288), tidak ditambah di sini
    expect(diagramSpecForBlock(ART, { spec: ART, keyRow: KEY })).toBe(ART);
  });

  it('buildFigures: blok artefak dengan keyRow tidak menggambar baris KEY di SVG; tanpa keyRow tetap', async () => {
    const [withKey, without] = await svgsOf([
      block('b1', { spec: { artifactId: 'art-1' }, keyRow: KEY }),
      block('b2', { spec: { artifactId: 'art-1' } }),
    ]);
    // row42 ADAPT A8 (C40, row 124b CP-35; services/render/figures.ts:178-182 diagramApparatusOptions): buildFigures labels the
    // key row in the document language, so an ID document prints "KUNCI  " where the original printed "KEY  ".
    expect(without).toContain('KUNCI  ');
    expect(withKey).not.toContain('KUNCI  ');
    expect(withKey).not.toContain('KEY  ');
    // sama dengan spec inline yang ditandai compose
    expect(withKey).toBe(buildDiagramSvg({ ...ART, keyRowOnPage: true }, { release: false }).svg);
  });

  it('artefak mandiri (render/artifact.ts, tanpa baris KUNCI halaman) tetap menggambar KEY', () => {
    expect(buildDiagramSvg(ART, { release: false }).svg).toContain('KEY  ');
  });
});
