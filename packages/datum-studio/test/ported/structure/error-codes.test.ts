// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/structure/error-codes.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
/* eslint-disable @typescript-eslint/no-explicit-any -- fixture JSON kontrak dibaca bebas-bentuk di uji */
// SR-44 / SC-4: tabel kode galat blueprint 05 §2.7 -> HTTP, dan kasus negatif untuk kode §2.7 di
// luar SLOT_* (yang ada di slot-rules / params-surface / adapt-v1 / pid-identity /
// display-field). Seam murni: `mergeSubmission`, `composeV2`, `resolveTarget*`, `assertCreatable`,
// `documentIncompleteError`, lint rilis `STRUCTURE_SLOT_CHECKS` + `inlineFormatStripped`.
// `@/lib/prisma` diganti tiruan yang MELEMPAR: uji ini tidak pernah menyentuh DB.
import { describe, expect, it, vi } from '../_vitest';

vi.mock('@/lib/prisma', () => ({
  prisma: new Proxy({}, { get: () => { throw new Error('SR-44: akses DB dilarang di uji unit'); } }),
}));

import { STUDIO_ERROR_HTTP } from '@/lib/studio/contract';
import { makeCtx } from '@/lib/studio/engine/lint/structure/context';
import { inlineFormatStripped, STRUCTURE_SLOT_CHECKS } from '@/lib/studio/engine/lint/structure/checks-slots';
import { adaptV1 } from '@/lib/studio/services/adapt-v1';
import { composeV2, mergeSubmission, seededPidAllocator } from '@/lib/studio/services/compose';
import { computeCompleteness } from '@/lib/studio/services/completeness';
import { documentIncompleteError } from '@/lib/studio/services/render/scope';
import { assertCreatable } from '@/lib/studio/services/submit/meta';
import { resolveDocTarget, resolveExistingDocTarget, resolveTarget } from '@/lib/studio/services/submit/target';
import { catchEngine, defaultParams, e1, merge, skeletonInput } from './_kit';

// Blueprint 05 §2.7 (kolom HTTP) apa adanya. ASSET_NOT_FOUND: satu status 422 (KD-24).
const TABLE_2_7: Array<[string, number]> = [
  ['SCHEMA_INVALID', 400],
  ['SLOT_UNKNOWN', 422],
  ['SLOT_REQUIRED_MISSING', 422],
  ['SLOT_DUPLICATE', 422],
  ['SLOT_POSITION_LOCKED', 422],
  ['SLOT_TYPE_MISMATCH', 422],
  ['SLOT_FORBIDDEN_FOR_TIER', 422],
  ['SLOT_INPUT_NOT_ACCEPTED', 422],
  ['SLOT_ITEMS_OUT_OF_RANGE', 422],
  ['BLOCK_TYPE_NOT_ADMITTED', 422],
  ['SLOT_USE_CHAPTER_ENDPOINT', 422],
  ['SLOT_PARAM_SCOPE_INVALID', 422],
  ['PARAM_SURFACE_FORBIDDEN', 403],
  ['PRESET_READONLY', 403],
  ['PARAM_CLASS_K_FORBIDDEN', 403],
  ['PARAM_CLASS_T_READONLY', 400],
  ['INLINE_FORMAT_REJECTED', 422],
  ['DOC_TARGET_AMBIGUOUS', 400],
  ['META_REQUIRED_FOR_CREATE', 400],
  ['META_CONFLICT', 409],
  ['TEMPLATE_MISMATCH', 409],
  ['SCOPE_CONFLICT', 409],
  ['PID_NOT_FOUND', 404],
  ['PID_CONFLICT', 422],
  ['ASSET_NOT_FOUND', 422],
  ['DOCUMENT_INCOMPLETE', 409],
];

describe('§2.7 kode -> HTTP (STUDIO_ERROR_HTTP)', () => {
  it.each(TABLE_2_7)('%s -> %i', (code, http) => {
    expect(STUDIO_ERROR_HTTP[code as keyof typeof STUDIO_ERROR_HTTP]).toBe(http);
  });
});

const chapterSub = (chapter: unknown, extra: Record<string, unknown> = {}) => ({ $schema: 'studio.chapter/v2', target: { documentId: 'd1' }, chapter, ...extra });
const newChapter = (blocks: unknown[] = [{ type: 'paragraph', text: 'a' }]) => ({ key: '3', title: { text: 'Tiga' }, sections: [{ title: { text: 'S' }, blocks }] });

describe('TEMPLATE_MISMATCH (409) / META_CONFLICT (409)', () => {
  const cur = merge(e1()).doc;
  it('kiriman bertemplat lain dari templat terpatok dokumen', () => {
    const e = catchEngine(() => merge(chapterSub(newChapter(), { template: { slug: 'datum-kanonik' } }), cur));
    expect(e.code).toBe('TEMPLATE_MISMATCH');
    expect(e.httpStatus).toBe(409);
    expect(e.details).toEqual({ pinned: { slug: 'datum-gsp', versionNo: 1 }, sent: { slug: 'datum-kanonik' } });
  });
  it('versi templat berbeda juga TEMPLATE_MISMATCH; slug+versi sama diterima', () => {
    expect(catchEngine(() => merge(chapterSub(newChapter(), { template: { slug: 'datum-gsp', version: 2 } }), cur)).code).toBe('TEMPLATE_MISMATCH');
    expect(() => merge(chapterSub(newChapter(), { template: { slug: 'datum-gsp', version: 1 } }), cur)).not.toThrow();
  });
  it('meta kiriman berbeda dari meta dokumen -> details.fields per medan', () => {
    const e = catchEngine(() => merge(chapterSub(newChapter(), { meta: { title: 'Judul lain' } }), cur));
    expect(e.code).toBe('META_CONFLICT');
    expect(e.httpStatus).toBe(409);
    expect(e.details).toEqual({ fields: { title: { current: 'Laporan Survei Gardu Induk Cikupa', sent: 'Judul lain' } } });
    expect(e.message).toContain('setMeta');
  });
  it('meta sama persis diterima', () => {
    expect(() => merge(chapterSub(newChapter(), { meta: { title: 'Laporan Survei Gardu Induk Cikupa' } }), cur)).not.toThrow();
  });
});

describe('ASSET_NOT_FOUND (422)', () => {
  const cur = merge(e1()).doc;
  const img = (asset: string) => ({ type: 'image', asset, caption: { text: 'c' }, source: { text: 's' } });
  const opts = (extra = {}) => ({ skeleton: skeletonInput(), tier: 'TERBIT' as const, pids: seededPidAllocator('a'), ...extra });
  it('blok gambar merujuk kunci aset yang tidak ada di assets -> pointer /chapter/.../asset', () => {
    const e = catchEngine(() => mergeSubmission(cur, chapterSub(newChapter([img('foto-x')])) as never, opts()));
    expect(e.code).toBe('ASSET_NOT_FOUND');
    expect(e.httpStatus).toBe(422);
    expect(e.details).toEqual({ asset: 'foto-x', pointer: '/chapter/sections/0/blocks/0/asset' });
  });
  it('aset base64 tanpa penyimpan (resolveAsset) -> 422 pointer /assets/<k>', () => {
    const sub = chapterSub(newChapter([img('foto-1')]), { assets: { 'foto-1': { mime: 'image/png', dataBase64: 'AAAA' } } });
    const e = catchEngine(() => mergeSubmission(cur, sub as never, opts()));
    expect(e.code).toBe('ASSET_NOT_FOUND');
    expect(e.details).toEqual({ asset: 'foto-1', pointer: '/assets/foto-1' });
  });
  it('assetRef tidak dikenal M13 (knownAssetSha) -> 422', () => {
    const sub = chapterSub(newChapter([img('foto-1')]), { assets: { 'foto-1': { assetRef: `sha256:${'c'.repeat(64)}` } } });
    expect(catchEngine(() => mergeSubmission(cur, sub as never, opts({ knownAssetSha: new Set(['d'.repeat(64)]) }))).code).toBe('ASSET_NOT_FOUND');
    expect(() => mergeSubmission(cur, sub as never, opts({ knownAssetSha: new Set(['c'.repeat(64)]) }))).not.toThrow();
  });
  it('compose: gambar dengan kunci aset tanpa entri assets -> ASSET_NOT_FOUND', () => {
    const src = structuredClone(cur);
    (src.sections!.content as any).chapters[0].sections[0].blocks.push({ ...img('hilang'), id: 'p-gambar-01' });
    const e = catchEngine(() => composeV2({ source: src, skeleton: skeletonInput(), params: defaultParams() }));
    expect(e.code).toBe('ASSET_NOT_FOUND');
  });
});

describe('DOC_TARGET_AMBIGUOUS (400)', () => {
  it.each([
    ['tanpa target', undefined, []],
    ['dua cara (documentId + docNumber)', { documentId: 'd1', docNumber: '001' }, ['documentId', 'docNumber']],
    ['tiga cara', { documentId: 'd1', docNumber: '001', mission: { folder: 'f' } }, ['documentId', 'docNumber', 'mission']],
  ])('kiriman bab/slot: %s', (_n, target, given) => {
    const e = catchEngine(() => resolveTarget(target as never, 'datum-gsp'));
    expect(e.code).toBe('DOC_TARGET_AMBIGUOUS');
    expect(e.httpStatus).toBe(400);
    expect(e.details).toEqual({ given });
  });
  it('docKey tanpa mission.folder', () => {
    const e = catchEngine(() => resolveTarget({ documentId: 'd1', docKey: 'k' } as never, undefined));
    expect(e.details).toEqual({ given: ['documentId', 'docKey'] });
    expect(catchEngine(() => resolveDocTarget(undefined, 'laporan', 'datum-gsp')).code).toBe('DOC_TARGET_AMBIGUOUS');
  });
  it('studio.doc/v2 bertarget: medan asing, target ganda dengan mission tingkat atas, target kosong', () => {
    expect(catchEngine(() => resolveExistingDocTarget({ documentId: 'd1', docNumber: '001' } as never, {})).details).toEqual({ given: ['documentId', 'docNumber'] });
    expect(catchEngine(() => resolveExistingDocTarget({ documentId: 'd1' } as never, { mission: { folder: 'f' } })).details).toEqual({ given: ['documentId', 'mission'] });
    expect(catchEngine(() => resolveExistingDocTarget({} as never, {})).code).toBe('DOC_TARGET_AMBIGUOUS');
  });
  it('positif: tepat satu cara; docKey bawaan = slug templat', () => {
    expect(resolveTarget({ mission: { folder: 'f' } } as never, 'datum-gsp')).toMatchObject({ kind: 'mission', folder: 'f', docKey: 'datum-gsp' });
    expect(resolveExistingDocTarget({ documentId: 'd1' } as never, {})).toEqual({ kind: 'documentId', documentId: 'd1' });
  });
});

describe('META_REQUIRED_FOR_CREATE (400)', () => {
  it.each([
    ['template absen', undefined, { title: 'T' }, ['template']],
    ['meta.title absen', { slug: 'datum-gsp' }, {}, ['meta.title']],
    ['meta.title kosong', { slug: 'datum-gsp' }, { title: '   ' }, ['meta.title']],
    ['keduanya absen', undefined, undefined, ['template', 'meta.title']],
  ])('%s', (_n, tpl, meta, missing) => {
    const e = catchEngine(() => assertCreatable(tpl as never, meta as never));
    expect(e.code).toBe('META_REQUIRED_FOR_CREATE');
    expect(e.httpStatus).toBe(400);
    expect(e.details).toEqual({ missing });
  });
  it('positif: template + meta.title', () => {
    expect(() => assertCreatable({ slug: 'datum-gsp' }, { title: 'T' })).not.toThrow();
  });
});

describe('DOCUMENT_INCOMPLETE (409, KD-27)', () => {
  it('render penuh pada INCOMPLETE: details memuat completeness, allowedScopes chapter/slot, forwardToController', () => {
    const c = computeCompleteness({
      revisionNo: 2,
      slots: [{ slotKey: 'content', sectionType: 'chapter', label: 'Isi', required: true, repeatable: true, minItems: 1, contentMode: 'INPUT', active: true, row: null, chapters: [] }],
      doc: { docId: 'doc-1', docNumber: '001/GSP/KT/X/2026', missionFolder: 'f' },
    });
    expect(c.status).toBe('INCOMPLETE');
    const e = documentIncompleteError(c);
    expect(e.code).toBe('DOCUMENT_INCOMPLETE');
    expect(e.httpStatus).toBe(409);
    const d = e.details as { allowedScopes: string[]; forwardToController: string; completeness: unknown };
    expect(d.allowedScopes).toEqual(['chapter', 'slot']);
    expect(d.forwardToController).toBe(c.forwardToController);
    expect(d.completeness).toBe(c);
  });
});

describe('SCOPE_CONFLICT (409): hanya jalur DB', () => {
  it('kode terdaftar 409; perilaku cek dasar per lingkup ada di pipeline DB (submit/pipeline.ts checkBase, revisions/v2/service.ts) -> diuji SR-45/SR-49', () => {
    expect(STUDIO_ERROR_HTTP.SCOPE_CONFLICT).toBe(409);
  });
});

// ── Lint rilis (blueprint §2.7 baris terakhir; LD-01..LD-04; tidak menahan berkas) ─────────
describe('lint rilis LD-01..LD-04', () => {
  const tpl = { params: defaultParams(), templateId: 'tpl-uji', versionNo: 1, sectionPlan: {} } as never;
  function snapshotOf(mut: (d: Record<string, any>) => void, tier: 'TERBIT' | 'NOTA' = 'TERBIT') {
    const d = e1();
    d.meta.tier = tier;
    mut(d);
    if (tier === 'NOTA') for (const k of ['cover', 'controlSheet', 'signature', 'toc']) delete d.sections[k];
    return composeV2({ source: merge(d, undefined, { tier }).doc, skeleton: skeletonInput(), params: defaultParams(), tier }).snapshot;
  }
  const gapDoc = (d: Record<string, any>) => {
    d.sections.content.outline = [{ key: '1' }, { key: '2' }, { key: '3' }];
    d.sections.content.chapters = [d.sections.content.chapters[0], { ...d.sections.content.chapters[1], key: '3' }];
  };

  it('SLOT_CONTENT_MISSING: FAIL untuk slot wajib EMPTY (controlSheet) dan PARTIAL (content celah bab)', () => {
    const snap = snapshotOf((d) => {
      delete d.sections.controlSheet;
      gapDoc(d);
    });
    const out = STRUCTURE_SLOT_CHECKS.SLOT_CONTENT_MISSING(makeCtx(snap, tpl, 'TERBIT'));
    expect(out.kind).toBe('findings');
    const details = (out as { findings: Array<{ detail: string }> }).findings.map((f) => f.detail);
    expect(details.some((x) => x.includes('(controlSheet) EMPTY'))).toBe(true);
    expect(details.some((x) => x.includes('(content) PARTIAL') && x.includes('bab belum ada 2'))).toBe(true);
  });
  it('SLOT_CONTENT_MISSING: lulus (0 temuan) untuk E1 lengkap', () => {
    const out = STRUCTURE_SLOT_CHECKS.SLOT_CONTENT_MISSING(makeCtx(snapshotOf(() => {}), tpl, 'TERBIT'));
    expect(out).toMatchObject({ kind: 'findings', findings: [] });
  });
  it('CONTENT_CHAPTER_GAP: FAIL pada TERBIT, REPORT pada NOTA', () => {
    const terbit = STRUCTURE_SLOT_CHECKS.CONTENT_CHAPTER_GAP(makeCtx(snapshotOf(gapDoc), tpl, 'TERBIT')) as { findings: Array<{ status: string; detail: string }> };
    expect(terbit.findings).toHaveLength(1);
    expect(terbit.findings[0].status).toBe('FAIL');
    expect(terbit.findings[0].detail).toContain('bab belum ada 2');
    const nota = STRUCTURE_SLOT_CHECKS.CONTENT_CHAPTER_GAP(makeCtx(snapshotOf(gapDoc, 'NOTA'), tpl, 'NOTA')) as { findings: Array<{ status: string }> };
    expect(nota.findings.map((f) => f.status)).toEqual(['REPORT']);
  });
  it('SCHEMA_V1_ADAPTED dan INLINE_FORMAT_STRIPPED: REPORT dari AdaptReportV1', () => {
    const a = adaptV1(
      { document: { $schema: 'studio.doc/v1', template: { slug: 'datum-gsp', version: 1 }, meta: { title: 'T', rev: 'A', typeCode: 'KT', tier: 'TERBIT', classification: 'B', language: 'ID', author: 'a', issueDate: '2026-10-23' }, chapters: [{ title: { text: 'B' }, sections: [{ title: { text: 'S' }, blocks: [{ type: 'spacer' }, { type: 'paragraph', runs: [{ t: 'x', color: 'F00' }] }] }] }] } } as never,
      'strip',
      false,
    );
    const ctx = makeCtx(snapshotOf(() => {}), tpl, 'TERBIT', { adaptReport: a.report });
    const v1 = STRUCTURE_SLOT_CHECKS.SCHEMA_V1_ADAPTED(ctx) as { findings: Array<{ status: string; detail: string }> };
    expect(v1.findings).toHaveLength(1);
    expect(v1.findings[0].status).toBe('REPORT');
    expect(v1.findings[0].detail).toContain('spacer 1');
    const strip = inlineFormatStripped(ctx) as { findings: Array<{ status: string; detail: string }> };
    expect(strip.findings[0]).toMatchObject({ status: 'REPORT' });
    expect(strip.findings[0].detail).toContain('color 1');
  });
  it('kiriman v2 asli: SCHEMA_V1_ADAPTED / INLINE_FORMAT_STRIPPED tanpa temuan', () => {
    const ctx = makeCtx(snapshotOf(() => {}), tpl, 'TERBIT');
    expect(STRUCTURE_SLOT_CHECKS.SCHEMA_V1_ADAPTED(ctx)).toMatchObject({ kind: 'findings', findings: [] });
    expect(inlineFormatStripped(ctx)).toMatchObject({ kind: 'findings', findings: [] });
  });
});
