// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/structure/glyph-compose.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
/* eslint-disable @typescript-eslint/no-explicit-any -- fixture JSON kontrak dibaca bebas-bentuk di uji */
// SR-44 / SC-13: pemetaan glif dan penanda makna v2 -> internal (register R-40, §14.3 arah balik,
// blueprint §2.9; D-139 butir b, D-145 label aparatus). Agen tidak pernah mengirim `faceRole`;
// compose memecah run pada glif `render.run.symbolGlyphs`. Seam: `mapRun`/`mapInline`/
// `apparatusInline`/`glyphSet` dan `composeV2` (ujung ke ujung). Murni.
import { describe, expect, it } from '../_vitest';
import { adaptV1 } from '@/lib/studio/services/adapt-v1';
import { apparatusInline, composeV2, DEFAULT_SYMBOL_GLYPHS, glyphSet, mapInline, mapRun } from '@/lib/studio/services/compose';
import { defaultParams, e1, merge, skeletonInput } from './_kit';

const ctx = { glyphs: glyphSet(undefined) };

describe('glyphSet (R-40)', () => {
  it('bawaan = default registri R-40 ["■","◈","◇","△"]', () => {
    expect([...DEFAULT_SYMBOL_GLYPHS]).toEqual(['■', '◈', '◇', '△']);
    expect([...glyphSet(undefined)]).toEqual(['■', '◈', '◇', '△']);
    expect(defaultParams()['render.run.symbolGlyphs']).toEqual(['■', '◈', '◇', '△']);
  });
  it('daftar kustom dan daftar kosong dihormati; butir bukan string diabaikan', () => {
    expect([...glyphSet(['★', 5, ''])]).toEqual(['★']);
    expect(glyphSet([]).size).toBe(0);
  });
});

describe('mapRun: penanda makna + pemecahan glif', () => {
  it('run ber-glif dipecah; potongan glif = faceRole symbolGlyph; penanda makna ikut di setiap potongan', () => {
    expect(mapRun({ t: 'Status ■ aman', strong: true }, ctx)).toEqual([
      { b: true, t: 'Status ' },
      { b: true, t: '■', faceRole: 'symbolGlyph' },
      { b: true, t: ' aman' },
    ]);
  });
  it('glif berurutan dan di tepi teks', () => {
    expect(mapRun({ t: '◈◇x△' }, ctx)).toEqual([
      { t: '◈', faceRole: 'symbolGlyph' },
      { t: '◇', faceRole: 'symbolGlyph' },
      { t: 'x' },
      { t: '△', faceRole: 'symbolGlyph' },
    ]);
  });
  it('code -> faceRole mono; sup/sub -> vertAlign; em -> i', () => {
    expect(mapRun({ t: 'TRK', code: true }, ctx)).toEqual([{ faceRole: 'mono', t: 'TRK' }]);
    expect(mapRun({ t: '2', sup: true, em: true }, ctx)).toEqual([{ i: true, vertAlign: 'superscript', t: '2' }]);
    expect(mapRun({ t: 'x', sub: true }, ctx)).toEqual([{ vertAlign: 'subscript', t: 'x' }]);
  });
  it('tanpa glif: satu run; tab/br apa adanya', () => {
    expect(mapRun({ t: 'polos' }, ctx)).toEqual([{ t: 'polos' }]);
    expect(mapRun({ tab: true }, ctx)).toEqual([{ tab: true }]);
    expect(mapRun({ br: 'line' }, ctx)).toEqual([{ br: 'line' }]);
  });
  it('glif di luar BMP dipecah per titik kode (tanpa merusak pasangan surrogate)', () => {
    expect(mapRun({ t: 'a𝔸b' }, { glyphs: glyphSet(['𝔸']) })).toEqual([{ t: 'a' }, { t: '𝔸', faceRole: 'symbolGlyph' }, { t: 'b' }]);
  });
  it('daftar glif kosong: tidak ada pemecahan', () => {
    expect(mapRun({ t: 'a■b' }, { glyphs: glyphSet([]) })).toEqual([{ t: 'a■b' }]);
  });
  it('bentuk text (md-lite) tidak diubah walau memuat glif (A9)', () => {
    expect(mapInline({ text: 'Tanda ■ tetap' }, ctx)).toEqual({ text: 'Tanda ■ tetap' });
  });
});

describe('label aparatus dibangkitkan dari jenis medan (D-145)', () => {
  it('source -> run label "SUMBER  " + isi; keyRow -> "KUNCI  "; teks agen tidak dipindai', () => {
    expect(apparatusInline({ text: 'Pengukuran' }, 'source', ctx)).toEqual({ runs: [{ t: 'SUMBER  ' }, { t: 'Pengukuran' }] });
    expect(apparatusInline({ runs: [{ t: 'Batang ■' }] }, 'key', ctx)).toEqual({ runs: [{ t: 'KUNCI  ' }, { t: 'Batang ' }, { t: '■', faceRole: 'symbolGlyph' }] });
  });
});

describe('ujung ke ujung: composeV2', () => {
  function composedRuns(runs: unknown[], params = defaultParams()) {
    const d = e1();
    d.sections.content.chapters[0].sections[0].blocks = [{ type: 'paragraph', runs }];
    const r = composeV2({ source: merge(d).doc, skeleton: skeletonInput(), params });
    const ch = r.snapshot.doc.chapters.find((c) => c.key === '1')!;
    return (ch.sections[0].blocks[0] as { runs: unknown[] }).runs;
  }
  it('glif dari parameter templat dipecah tanpa faceRole dari agen', () => {
    expect(composedRuns([{ t: 'Nilai ■ ', strong: true }, { t: 'akhir' }])).toEqual([
      { b: true, t: 'Nilai ' },
      { b: true, t: '■', faceRole: 'symbolGlyph' },
      { b: true, t: ' ' },
      { t: 'akhir' },
    ]);
  });
  it('parameter render.run.symbolGlyphs kustom mengubah himpunan glif', () => {
    expect(composedRuns([{ t: 'a★■' }], { ...defaultParams(), 'render.run.symbolGlyphs': ['★'] })).toEqual([{ t: 'a' }, { t: '★', faceRole: 'symbolGlyph' }, { t: '■' }]);
  });
  it('pulang-pergi v1: faceRole symbolGlyph dibuang adaptor lalu dideteksi ulang compose', () => {
    const v1 = {
      document: {
        $schema: 'studio.doc/v1',
        template: { slug: 'datum-gsp', version: 1 },
        meta: { title: 'T', rev: 'A', typeCode: 'KT', tier: 'TERBIT', classification: 'BIASA', language: 'ID', author: 'a', issueDate: '2026-10-23' },
        chapters: [{ key: '1', title: { text: 'B' }, sections: [{ title: { text: 'S' }, blocks: [{ type: 'paragraph', runs: [{ t: 'x' }, { t: '◇', faceRole: 'symbolGlyph' }] }] }] }],
      },
    };
    const a = adaptV1(v1 as never, 'strip', false);
    expect((a.doc.sections!.content as any).chapters[0].sections[0].blocks[0].runs).toEqual([{ t: 'x' }, { t: '◇' }]);
    expect(a.report.dropped.symbolGlyphRuns).toBe(1);
    const doc = merge({ ...a.doc, meta: { title: 'T', tier: 'TERBIT' } }).doc;
    const r = composeV2({ source: doc, skeleton: skeletonInput(), params: defaultParams(), tier: 'TERBIT' });
    expect((r.snapshot.doc.chapters[0].sections[0].blocks[0] as { runs: unknown[] }).runs).toEqual([{ t: 'x' }, { t: '◇', faceRole: 'symbolGlyph' }]);
  });
});
