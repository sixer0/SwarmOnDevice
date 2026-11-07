// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/structure/adapt-v1.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
/* eslint-disable @typescript-eslint/no-explicit-any -- fixture JSON kontrak dibaca bebas-bentuk di uji */
// SR-44: adaptor v1 -> v2 (register §14 AD-01..AD-16, §14.2, §14.3; D-221 pengupasan label
// SUMBER/KUNCI; D-223/D-227 medan data chart RQ-11; R-38/KD-26 kebijakan inline).
// Seam: `adaptV1` (murni) + `validateV2Against` (keluaran wajib konten murni, 0 isu skema).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from '../_vitest';
import type { StudioIngestRequest } from '@/lib/studio/contract';
import { adaptV1, countInlineFormat, effectiveInlinePolicy } from '@/lib/studio/services/adapt-v1';
import { validateV2Against } from '@/lib/studio/services/ingest/validate';
import { catchEngine } from './_kit';

const META = { title: 'Nota uji', rev: 'A', typeCode: 'KT', tier: 'NOTA', classification: 'BIASA', language: 'ID', author: 'Tim', issueDate: '2026-10-23' };
const cap = (text = 'Keterangan') => ({ inline: { text } });
const srcRuns = (...ts: string[]) => ({ inline: { runs: ts.map((t) => ({ t })) } });
const chap = (blocks: unknown[], extra: Record<string, unknown> = {}) => ({ title: { text: 'Bab' }, sections: [{ title: { text: 'S' }, blocks }], ...extra });

function req(doc: Record<string, unknown>, extra: Record<string, unknown> = {}): StudioIngestRequest {
  return { document: { $schema: 'studio.doc/v1', template: { slug: 'datum-kanonik', version: 1 }, meta: META, ...doc }, ...extra } as never;
}
function adapt(doc: Record<string, unknown>, policy: 'strip' | 'reject' | 'allow' = 'strip', trusted = false, extra = {}) {
  return adaptV1(req(doc, extra), policy, trusted);
}
const blocksOf = (r: ReturnType<typeof adapt>, ci = 0) => (r.doc.sections!.content as any).chapters[ci].sections[0].blocks as any[];
function expectContentPure(r: ReturnType<typeof adapt>) {
  expect(validateV2Against('studio.doc/v2', r.doc)).toEqual([]);
}

describe('AD-01..AD-16 tingkat atas', () => {
  it('AD-01/04/05/06/07/08/16: agentId, $schema, template, mission, meta, register, x; D-247: render permintaan dibuang', () => {
    const r = adapt(
      { mission: { folder: '2026-10-23_uji' }, register: { p1: { v: 1, dec: 0, unit: 'kW', mark: 'TERUKUR', src: 'Log meter' } }, x: { note: 'n' }, chapters: [chap([{ type: 'paragraph', text: 'a' }])] },
      'strip',
      false,
      { agentId: 'agen-1', render: { formats: ['docx'], figures: ['svg'] } },
    );
    expect(r.doc).toMatchObject({
      $schema: 'studio.doc/v2',
      agentId: 'agen-1',
      template: { slug: 'datum-kanonik', version: 1 },
      mission: { folder: '2026-10-23_uji' },
      meta: META,
      register: { p1: { v: 1, dec: 0, unit: 'kW', mark: 'TERUKUR', src: 'Log meter' } },
      x: { note: 'n' },
    });
    // D-247 (menggantikan AD-03): v1 tidak build otomatis; build hanya lewat POST /documents/{id}/render.
    expect((r.doc as unknown as Record<string, unknown>).render).toBeUndefined();
    expect(r.report.stripped.render).toBe(1);
    expect(r.report.schema).toBe('studio.doc/v1');
    expectContentPure(r);
  });
  it('D-247 (menggantikan AD-15): outputs v1 dibuang dan dicatat stripped.outputs; tanpa render', () => {
    const r = adapt({ outputs: ['docx', 'pdf'], chapters: [chap([{ type: 'paragraph', text: 'a' }])] });
    expect((r.doc as unknown as Record<string, unknown>).render).toBeUndefined();
    expect(r.report.stripped.outputs).toBe(1);
    expect(r.report.renamed['outputs->render.formats']).toBeUndefined();
    expectContentPure(r);
  });
  it('D-247: render tidak dihitung sebagai format inline (reject tidak gagal karena render/outputs)', () => {
    expect(() => adapt({ outputs: ['docx'], chapters: [chap([{ type: 'paragraph', text: 'a' }])] }, 'reject', false, { render: { formats: ['pdf'] } })).not.toThrow();
  });
  it('AD-12/AD-13: key absen -> posisi 1-based dan huruf A..', () => {
    const r = adapt({ chapters: [chap([]), chap([])], appendices: [chap([]), chap([])] });
    expect((r.doc.sections!.content as any).chapters.map((c: any) => c.key)).toEqual(['1', '2']);
    expect((r.doc.sections!.appendices as any).chapters.map((c: any) => c.key)).toEqual(['A', 'B']);
  });
  it('AD-11: parts -> content.parts + ChapterV2.partId; label/body/setup/order dibuang', () => {
    const r = adapt({
      parts: [{ id: 'P1', title: { text: 'Bagian' }, lede: { text: 'L' }, chapterKeys: ['2'], label: { text: 'BAGIAN I' }, order: 1, setup: {} }],
      chapters: [chap([], { key: '1' }), chap([], { key: '2' })],
    });
    const c = r.doc.sections!.content as any;
    expect(c.parts).toEqual([{ id: 'P1', title: { text: 'Bagian' }, lede: { text: 'L' } }]);
    expect(c.chapters.map((x: any) => x.partId ?? null)).toEqual([null, 'P1']);
    expect(r.report.stripped).toMatchObject({ label: 1, order: 1, setup: 1 });
    expectContentPure(r);
  });
  it('AD-14: aset sha256 -> assetRef; dataBase64 -> {mime, dataBase64}; path dilaporkan', () => {
    const sha = 'B'.repeat(64);
    const r = adapt({
      assets: { Foto1: { kind: 'raster', mime: 'image/png', sha256: sha, path: 'a/b.png' }, img2: { kind: 'raster', mime: 'image/jpeg', sha256: 'c'.repeat(64), dataBase64: 'AAAA' } },
      chapters: [chap([{ type: 'image', asset: 'Foto1', caption: cap(), source: srcRuns('x') }])],
    });
    expect(r.doc.assets).toEqual({ foto1: { assetRef: `sha256:${'b'.repeat(64)}` }, img2: { mime: 'image/jpeg', dataBase64: 'AAAA' } });
    expect(blocksOf(r)[0].asset).toBe('foto1');
    expect(r.assetPaths).toEqual({ foto1: { path: 'a/b.png', sha256: 'b'.repeat(64), mime: 'image/png' } });
  });
});

describe('AD-09 / R-38 kebijakan ingest.inlineFormat (KD-26)', () => {
  const styled = { overrides: { 'page.size': 'A5' }, chapters: [chap([{ type: 'paragraph', runs: [{ t: 'a', color: 'FF0000', szHalfPt: 20 }], format: { spacingAfterTw: 0 } }])] };
  it('strip: format inline dibuang dan dihitung (INLINE_FORMAT_STRIPPED)', () => {
    const r = adapt(styled, 'strip');
    expect(r.report.policy).toBe('strip');
    expect(r.report.stripped).toMatchObject({ overrides: 1, color: 1, szHalfPt: 1, format: 1 });
    expect(countInlineFormat(r.report)).toBe(4);
    expect(blocksOf(r)[0]).toEqual({ type: 'paragraph', runs: [{ t: 'a' }] });
    expect(r.internal).toBeUndefined();
    expectContentPure(r);
  });
  it('reject: 422 INLINE_FORMAT_REJECTED dengan pointer per medan dan REPORT', () => {
    const e = catchEngine(() => adapt(styled, 'reject'));
    expect(e.code).toBe('INLINE_FORMAT_REJECTED');
    expect(e.httpStatus).toBe(422);
    const d = e.details as { issues: Array<{ pointer: string; checkId: string }>; report: unknown };
    expect(d.issues.map((i) => i.pointer).sort()).toEqual(
      [
        '/document/overrides',
        '/document/chapters/0/sections/0/blocks/0/runs/0/color',
        '/document/chapters/0/sections/0/blocks/0/runs/0/szHalfPt',
        '/document/chapters/0/sections/0/blocks/0/format',
      ].sort(),
    );
    expect(d.issues.every((i) => i.checkId === 'INLINE_FORMAT')).toBe(true);
  });
  it('reject tanpa format inline tidak gagal (tata letak bukan R-38)', () => {
    expect(() => adapt({ chapters: [chap([{ type: 'spacer', heightTw: 100 }, { type: 'paragraph', text: 'a' }])] }, 'reject')).not.toThrow();
  });
  it('allow tepercaya: snapshot internal = dokumen v1 asli; allow tak tepercaya = strip', () => {
    const r = adapt(styled, 'allow', true);
    expect(r.report.policy).toBe('allow');
    expect(r.internal).toEqual(req(styled).document);
    expect(effectiveInlinePolicy('allow', false)).toBe('strip');
    const u = adapt(styled, 'allow', false);
    expect(u.report.policy).toBe('strip');
    expect(u.internal).toBeUndefined();
  });
});

describe('§14.2 halaman depan', () => {
  it('cover auto: kicker -> tagline; control.rows -> control; colophon; tampilan dibuang', () => {
    const r = adapt({
      front: {
        cover: {
          mode: 'auto',
          data: {
            kicker: { text: 'KAJIAN TEKNIS' },
            titleLines: [{ text: 'Judul' }],
            control: { type: 'controlBlock', rows: [[{ text: 'No' }, { text: '1' }, { text: 'Rev' }, { text: 'A' }]], colsTw: [1, 2, 3, 4] },
            colophon: { type: 'colophon', left: { text: 'L' }, right: { text: 'R' } },
          },
        },
      },
      chapters: [chap([])],
    });
    const cover = r.doc.sections!.cover as any;
    expect(cover.tagline).toEqual({ text: 'KAJIAN TEKNIS' });
    expect(cover.kicker).toBeUndefined();
    expect(cover.control).toEqual([[{ text: 'No' }, { text: '1' }, { text: 'Rev' }, { text: 'A' }]]);
    expect(cover.colophon).toEqual({ left: { text: 'L' }, right: { text: 'R' } });
    expectContentPure(r);
  });
  it('toc statis: entries dibuang bila slot AUTO (dropped.tocEntries), dipertahankan bila MIXED', () => {
    const doc = { front: { toc: { mode: 'static', entries: [{ level: 'chapter', title: { text: 'Bab 1' }, page: '1' }], title: { text: 'DAFTAR ISI' } } }, chapters: [chap([])] };
    const auto = adapt(doc);
    expect(auto.doc.sections!.toc).toEqual({ type: 'toc' });
    expect(auto.report.dropped.tocEntries).toBe(1);
    const mixed = adaptV1(req(doc), 'strip', false, { tocMixed: true });
    expect((mixed.doc.sections!.toc as any).entries).toHaveLength(1);
  });
});

describe('§14.3 bab, section, blok, run', () => {
  it('blockId -> id (dinormalisasi ke pola pid); Section.number/headingFormat dibuang', () => {
    const r = adapt({ chapters: [{ key: '1', blockId: 'BabSatu', title: { text: 'B' }, sections: [{ blockId: 'sec-1-1', number: '1.1', title: { text: 'S' }, blocks: [{ type: 'paragraph', blockId: 'p_1', text: 'a' }] }] }] });
    const c = (r.doc.sections!.content as any).chapters[0];
    expect(c.id).toBe('bab-satu');
    expect(c.sections[0].id).toBe('sec-1-1');
    expect(c.sections[0].blocks[0].id).toBe('p-1');
    expect(r.report.stripped.number).toBe(1);
  });
  it('run: b/i -> strong/em; vertAlign -> sup/sub; faceRole mono -> code; symbolGlyph & field dibuang', () => {
    const r = adapt({
      chapters: [chap([{ type: 'paragraph', runs: [{ t: 'B', b: true }, { t: 'I', i: true }, { t: '2', vertAlign: 'superscript' }, { t: 'x', vertAlign: 'subscript' }, { t: 'TRK-01', faceRole: 'mono' }, { t: '■', faceRole: 'symbolGlyph' }, { field: 'PAGE' }] }])],
    });
    expect(blocksOf(r)[0].runs).toEqual([{ t: 'B', strong: true }, { t: 'I', em: true }, { t: '2', sup: true }, { t: 'x', sub: true }, { t: 'TRK-01', code: true }, { t: '■' }]);
    expect(r.report.dropped).toMatchObject({ symbolGlyphRuns: 1, fieldRuns: 1 });
    expect(r.report.renamed).toMatchObject({ 'b->strong': 1, 'i->em': 1, 'faceRole:mono->code': 1 });
    expectContentPure(r);
  });
  it('spacer/device dibuang dan dihitung; peran halaman depan (DF-61) -> body', () => {
    const r = adapt({ chapters: [chap([{ type: 'spacer' }, { type: 'device', device: 'datumRule' }, { type: 'paragraph', role: 'pageTitle', text: 'Judul' }])] });
    expect(r.report.dropped).toMatchObject({ spacer: 1, device: 1 });
    expect(blocksOf(r)).toEqual([{ type: 'paragraph', text: 'Judul' }]);
    expect(r.report.renamed['paragraph.role:pageTitle->body']).toBe(1);
  });
  it('list.style number -> ordered true; marker dibuang; tabel: widthTw/align/repeatHeader dibuang', () => {
    const r = adapt({
      chapters: [
        chap([
          { type: 'list', style: 'number', items: [{ text: 'a', marker: '1)' }] },
          { type: 'table', layout: {}, columns: [{ role: 'text', widthTw: 100, align: 'right' }], rows: [{ cells: [{ text: 'a', shading: 'EEE' }], repeatHeader: true }], caption: cap('T'), source: srcRuns('x') },
        ]),
      ],
    });
    const [list, table] = blocksOf(r);
    expect(list).toEqual({ type: 'list', ordered: true, items: [{ text: 'a' }] });
    expect(table.columns).toEqual([{ role: 'text' }]);
    expect(table.rows).toEqual([{ cells: [{ text: 'a' }] }]);
    expect(r.report.stripped).toMatchObject({ marker: 1, widthTw: 1, align: 1, repeatHeader: 1, shading: 1, layout: 1 });
    expectContentPure(r);
  });
});

describe('D-221 (RQ-10): run label aparatus SUMBER/KUNCI dikupas, konten tidak', () => {
  const fig = (source: unknown, keyRow?: unknown) => ({ type: 'image', asset: 'img', caption: cap(), source, ...(keyRow ? { keyRow } : {}) });
  const asset = { assets: { img: { kind: 'raster', mime: 'image/png', sha256: 'a'.repeat(64) } } };
  const run = (source: unknown, keyRow?: unknown) => adapt({ ...asset, chapters: [chap([fig(source, keyRow)])] });

  it('run pertama "SUMBER  " + pemisah spasi dibuang; dihitung source.labelRun', () => {
    const r = run(srcRuns('SUMBER  ', ' ', 'Pengukuran lapangan'));
    expect(blocksOf(r)[0].source).toEqual({ runs: [{ t: 'Pengukuran lapangan' }] });
    expect(r.report.stripped['source.labelRun']).toBe(1);
  });
  it('varian "SUMBER:" dan "KUNCI" di keyRow', () => {
    const r = run(srcRuns('SUMBER:', 'Data'), { runs: [{ t: 'KUNCI  ' }, { t: 'Batang = jam' }] });
    expect(blocksOf(r)[0].source).toEqual({ runs: [{ t: 'Data' }] });
    expect(blocksOf(r)[0].keyRow).toEqual({ runs: [{ t: 'Batang = jam' }] });
    expect(r.report.stripped['keyRow.labelRun']).toBe(1);
  });
  it.each([
    ['bentuk text tidak disentuh', { inline: { text: 'SUMBER  Data' } }, { text: 'SUMBER  Data' }],
    ['huruf kecil tidak disentuh', srcRuns('sumber ', 'Data'), { runs: [{ t: 'sumber ' }, { t: 'Data' }] }],
    ['kata label di tengah kalimat tidak disentuh', srcRuns('Data SUMBER lain'), { runs: [{ t: 'Data SUMBER lain' }] }],
    ['PROVENANS tidak dibuang', srcRuns('PROVENANS ', 'Data'), { runs: [{ t: 'PROVENANS ' }, { t: 'Data' }] }],
    ['label tanpa konten tersisa tidak dibuang', srcRuns('SUMBER  '), { runs: [{ t: 'SUMBER  ' }] }],
    ['KUNCI di medan source tidak dibuang', srcRuns('KUNCI  ', 'Data'), { runs: [{ t: 'KUNCI  ' }, { t: 'Data' }] }],
  ])('%s', (_n, source, expected) => {
    const r = run(source);
    expect(blocksOf(r)[0].source).toEqual(expected);
    expect(r.report.stripped['source.labelRun']).toBeUndefined();
  });
});

describe('D-223/D-227 (RQ-11): params chart pembawa DATA -> data; tampilan dibuang', () => {
  const chart = (spec: Record<string, unknown>) => ({ type: 'chart', spec: { $schema: 'studio.chart/v1', title: 'Judul.', ...spec }, caption: cap(), source: srcRuns('Data') });
  const one = (spec: Record<string, unknown>) => {
    const r = adapt({ chapters: [chap([chart(spec)])] });
    return { r, b: blocksOf(r)[0] };
  };
  const cat = { shape: 'categorical', points: [{ label: 'A', value: 1 }, { label: 'B', value: 2 }] };

  it('P-09 targets[] -> points[].target; axis/max/belowTargetColour dibuang dan dihitung params', () => {
    const { r, b } = one({ kind: 'P-09', data: cat, params: { targets: [5, null], axis: { min: 0 }, max: 10, belowTargetColour: 'red' } });
    expect(b.data.points).toEqual([{ label: 'A', value: 1, target: 5 }, { label: 'B', value: 2 }]);
    expect(b.axis ?? b.max ?? b.data.axis ?? b.data.max).toBeUndefined();
    expect(r.report.stripped.params).toBe(1);
    expect(r.report.renamed['params.targets->data.points.target']).toBe(1);
    expectContentPure(r);
  });
  it('P-09 target tunggal berlaku ke semua titik', () => {
    const { b } = one({ kind: 'P-09', data: cat, params: { target: 3 } });
    expect(b.data.points.map((p: any) => p.target)).toEqual([3, 3]);
  });
  it('P-13 divider -> data.divider; compassLabels/medianLabel dibuang', () => {
    const { r, b } = one({ kind: 'P-13', data: { shape: 'xy', points: [{ x: 1, y: 2 }] }, params: { divider: { x: 1.5 }, compassLabels: ['N'], medianLabel: 'm' } });
    expect(b.data.divider).toEqual({ x: 1.5 });
    expect(r.report.stripped.params).toBe(1);
    expectContentPure(r);
  });
  it('S-01 binEdges -> data.binEdges', () => {
    const { b, r } = one({ kind: 'S-01', data: { shape: 'distribution', groups: [{ name: 'g', values: [1, 12] }] }, params: { binEdges: [0, 10, 20] } });
    expect(b.data.binEdges).toEqual([0, 10, 20]);
    expect(r.report.stripped.params).toBeUndefined();
  });
  it('S-08 sectors -> data.sectors; accentSectorDeg -> highlight indeks sektor', () => {
    const { b } = one({ kind: 'S-08', data: { shape: 'distribution', groups: [{ name: 'g', values: [10, 100] }] }, params: { sectors: 8, accentSectorDeg: 95 } });
    expect(b.data.sectors).toBe(8);
    expect(b.highlight).toEqual([2]);
  });
  it('P-14 accentCategory -> highlight bila belum ada sorotan dari accent', () => {
    expect(one({ kind: 'P-14', data: cat, params: { accentCategory: 'B' } }).b.highlight).toEqual(['B']);
    const withAccent = one({ kind: 'P-14', data: { shape: 'categorical', points: [{ label: 'A', value: 1, accent: true }, { label: 'B', value: 2 }] }, params: { accentCategory: 'B' } });
    expect(withAccent.b.highlight).toEqual(['A']);
  });
  it('accent:true per titik -> highlight label; data tanpa accent (VF-12)', () => {
    const { b, r } = one({ kind: 'P-01', data: { shape: 'categorical', points: [{ label: 'A', value: 1, accent: true }, { label: 'B', value: 2 }] } });
    expect(b.highlight).toEqual(['A']);
    expect(b.data.points[0].accent).toBeUndefined();
    expectContentPure(r);
  });
  it('limit/limitLabel -> limit {value, label}; widthMm/apparatus/style dibuang', () => {
    const { b, r } = one({ kind: 'P-01', data: cat, limit: 55, limitLabel: 'Batas', widthMm: 128, apparatus: 'figure', style: {} });
    expect(b.limit).toEqual({ value: 55, label: 'Batas' });
    expect(r.report.stripped).toMatchObject({ widthMm: 1, apparatus: 1, style: 1 });
  });
  it('komposit: panels[].spec -> panels[] dengan data, limit panel (D-223), columns/gapMm dibuang', () => {
    const { b, r } = one({
      kind: 'composite',
      composite: {
        columns: 3,
        gapMm: 4.3,
        panels: [
          { name: 'P1', code: 'P-09', caption: 'c', spec: { kind: 'P-09', data: cat, limit: 55, limitLabel: 'Ambang', params: { targets: [1, 2] } } },
          { name: 'P2', code: 'P-01', spec: { kind: 'P-01' } },
        ],
      },
    });
    expect(b.code).toBe('composite');
    expect(b.panels).toHaveLength(1);
    expect(b.panels[0]).toMatchObject({ name: 'P1', code: 'P-09', caption: 'c', limit: { value: 55, label: 'Ambang' } });
    expect(b.panels[0].data.points.map((p: any) => p.target)).toEqual([1, 2]);
    expect(r.report.stripped).toMatchObject({ columns: 1, gapMm: 1, 'panel(noData)': 1 });
    expectContentPure(r);
  });
});

describe('fixture paritas v1 (tests/parity/fixtures/doc): adaptasi -> konten murni v2', () => {
  const dir = path.resolve(__dirname, '../_fixtures/tests/parity/fixtures/doc');
  it.each(['doc_nota_memo', 'doc_nota_tables', 'doc_serah_handover', 'doc_terbit_report'])('%s lolos studio.doc/v2 dengan 0 isu dan deterministik', (name) => {
    const doc = JSON.parse(readFileSync(path.join(dir, `${name}.json`), 'utf8'));
    const a = adaptV1({ document: doc } as never, 'strip', false);
    const b = adaptV1({ document: doc } as never, 'strip', false);
    expect(validateV2Against('studio.doc/v2', a.doc)).toEqual([]);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.report.schema).toBe('studio.doc/v1');
  });
});
