// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/structure/params-surface.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
// SR-44: cakupan dan lapis parameter (register §13.1, §13.2, §13.5; SC-2), izin tulis per kunci
// berubah (urutan 1-7, D-134, D-163 T-1, D-165 KT-4, D-170), urutan resolusi nilai efektif
// per slot (preset -> esensial -> lanjutan -> turunan -> T), dan rantai ukuran kertas
// page.size -> pageSizeFromPaper / textBlockFromPage / figureWidthFromClass (D-172, D-169).
// Seam: registri `params`, `isScopeAllowedInSlot`, `checkTemplateWrite`, `resolveSlotParams`,
// `resolveParams`, `pageSizeFromPaper`. Murni, tanpa DB.
import { describe, expect, it } from '../_vitest';
import { PAPER_SIZE_MM, STUDIO_ERROR_HTTP, type ParamMap, type TemplateSlotDef } from '@/lib/studio/contract';
import { PARAM_SURFACES } from '@/lib/studio/contract/enums';
import { resolveParams } from '@/lib/studio/engine/tokens';
import { mmToTw } from '@/lib/studio/engine/tokens/grid';
import { pageSizeFromPaper } from '@/lib/studio/engine/tokens/paper';
import { ALL_PARAMS, PARAMS_BY_KEY } from '@/lib/studio/params';
import { isScopeAllowedInSlot, PAGE_DEVICE_SECTION_TYPES } from '@/lib/studio/registry/slots';
import { checkTemplateWrite, type ParamChange } from '@/lib/studio/services/skeleton/access';
import { resolveSlotParams, resolveSlotParamsDetailed } from '@/lib/studio/services/skeleton/resolve';
import { flattenSlotParams } from '@/lib/studio/services/skeleton/skeleton';
import { catchEngine, datumSlots } from './_kit';

const USER = { kind: 'USER_SESSION' as const };
const ADMIN = { kind: 'ADMIN_SESSION' as const };
const TPL = { isPreset: false, restricted: false, slug: 'tpl-uji' };
const change = (key: string, value: unknown, previous?: unknown, slot?: ParamChange['slot']): ParamChange =>
  ({ key, value, previous, ...(slot ? { slot } : {}) }) as ParamChange;
const CHAPTER_SLOT = { slotKey: 'content', sectionType: 'chapter', admits: ['paragraph', 'table', 'chart'] };

const resolved = (overrides: ParamMap = {}, base: ParamMap = {}) => resolveParams({ base, overrides, registry: ALL_PARAMS });

describe('register §13.1/§13.2: ParamDef kontrak = register (sumber kebenaran independen)', () => {
  const R: Array<[string, string, string, string, string, unknown]> = [
    ['R-38', 'ingest.inlineFormat', 'K', 'document', 'internal', 'strip'],
    ['R-39', 'render.draft.marker', 'B', 'document', 'internal', { text: 'DRAF', placement: 'header' }],
    ['R-40', 'render.run.symbolGlyphs', 'B', 'document', 'internal', ['■', '◈', '◇', '△']],
    ['R-41', 'slot.setup', 'B', 'slot', 'advanced', {}],
    ['R-42', 'slot.placement', 'B', 'slot', 'essential', 'inControlSheet'],
    ['R-43', 'slot.placeholderText', 'B', 'slot', 'advanced', '[{label} belum diisi]'],
    ['R-44', 'page.size', 'B', 'document', 'essential', 'A4'],
    ['R-45', 'page.orientation', 'B', 'slot', 'essential', 'portrait'],
    ['R-46', 'page.customSizeMm', 'B', 'document', 'advanced', null],
    ['R-47', 'grid.marginDensity', 'B', 'document', 'essential', 'standard'],
    ['R-48', 'doc.defaultTypeCode', 'B', 'document', 'advanced', 'KT'],
    ['R-49', 'doc.defaultTier', 'B', 'document', 'advanced', 'TERBIT'],
    ['R-50', 'chart.composite.columns', 'B', 'section:chart', 'advanced', 3],
    ['R-51', 'chart.composite.gapMm', 'B', 'section:chart', 'advanced', 4],
    ['R-52', 'render.table.columnProfiles', 'B', 'section:table', 'advanced', {}],
  ];
  it.each(R)('%s %s kelas %s cakupan %s lapis %s', (id, key, cls, scope, surface, def) => {
    const d = PARAMS_BY_KEY.get(key);
    expect(d).toBeDefined();
    expect({ id: d!.id, class: d!.class, scope: d!.scope, surface: d!.surface, default: d!.default }).toEqual({ id, class: cls, scope, surface, default: def });
  });
  it.each([
    ['PC-01', 'page.sizeMm', 'T', 'pageSizeFromPaper'],
    ['PC-02', 'grid.textColumnMm', 'T', 'textColumnFromPage'],
    ['PC-03', 'grid.innerMarginMm', 'B', 'marginsFromDensity'],
    ['PC-03', 'grid.outerMarginMm', 'B', 'marginsFromDensity'],
    ['PC-03', 'grid.topBottomMarginMm', 'B', 'marginsFromDensity'],
  ])('%s %s kelas %s derive %s lapis derived', (_id, key, cls, derive) => {
    const d = PARAMS_BY_KEY.get(key)!;
    expect({ class: d.class, derive: d.derive, surface: d.surface }).toEqual({ class: cls, derive, surface: 'derived' });
  });
  it('PC-07: color.interior.signal lapis essential; PC-06 type.scale.body.size essential', () => {
    expect(PARAMS_BY_KEY.get('color.interior.signal')!.surface).toBe('essential');
    expect(PARAMS_BY_KEY.get('type.scale.body.size')!.surface).toBe('essential');
  });
});

describe('SC-2: setiap kunci tepat satu cakupan dan satu lapis', () => {
  it('kunci unik di registri', () => {
    expect(new Set(ALL_PARAMS.map((p) => p.key)).size).toBe(ALL_PARAMS.length);
  });
  // row42 DEFECT R42-D1 (kept failing, skipped as todo): row 122's R-81..R-83 have no surface (registry/essentials.ts:102-103
  // maps ids("R-", [67, 80]) only), so paramSurfaceOf() returns undefined for them. Fails today with exactly those 3 keys.
  it('[DEFECT R42-D1] cakupan sesuai tata bahasa E32 dan lapis anggota E31 (R-81..R-83 surface undefined)', () => {
    const bad = ALL_PARAMS.filter(
      (p) => typeof p.scope !== 'string' || !/^(document|slot|section:[A-Za-z]+|shared:[a-z]+)$/.test(p.scope) || !(PARAM_SURFACES as readonly string[]).includes(p.surface as string),
    );
    expect(bad.map((p) => `${p.key}:${p.scope}:${p.surface}`)).toEqual([]);
  });
});

describe('§13.5 cakupan slot (isScopeAllowedInSlot)', () => {
  it.each([
    ['slot', { sectionType: 'cover', admits: [] }, true],
    ['document', { sectionType: 'chapter', admits: ['table'] }, false],
    ['section:chapter', { sectionType: 'chapter', admits: [] }, true],
    ['section:table', { sectionType: 'chapter', admits: ['table'] }, true],
    ['section:table', { sectionType: 'chapter', admits: ['paragraph'] }, false],
    ['section:table', { sectionType: 'cover', admits: [] }, false],
    ['shared:caption', { sectionType: 'chapter', admits: ['chart'] }, true],
    ['shared:caption', { sectionType: 'chapter', admits: ['paragraph'] }, false],
    ['shared:marks', { sectionType: 'appendix', admits: ['list'] }, true],
  ] as const)('%s pada %j -> %s', (scope, slot, ok) => {
    expect(isScopeAllowedInSlot(scope as never, slot as never)).toBe(ok);
  });
  it('perangkat halaman (PAGE_DEVICE) boleh di slot mana pun', () => {
    expect(PAGE_DEVICE_SECTION_TYPES.length).toBeGreaterThan(0);
    for (const dev of PAGE_DEVICE_SECTION_TYPES) expect(isScopeAllowedInSlot(`section:${dev}` as never, { sectionType: 'cover', admits: [] }), dev).toBe(true);
  });
});

describe('izin tulis per kunci berubah (urutan 1-7)', () => {
  it('1. PRESET_READONLY 403: USER menulis versi preset (juga tanpa perubahan parameter)', () => {
    const e = catchEngine(() => checkTemplateWrite(USER, { ...TPL, isPreset: true }, []));
    expect(e.code).toBe('PRESET_READONLY');
    expect(e.httpStatus).toBe(403);
    expect(e.details).toEqual({ templateSlug: 'tpl-uji' });
  });
  it('2. FORBIDDEN 403: templat terbatas D-98 oleh USER', () => {
    const e = catchEngine(() => checkTemplateWrite(USER, { ...TPL, restricted: true }, [change('page.size', 'A5')]));
    expect(e.code).toBe('FORBIDDEN');
    expect(e.details).toMatchObject({ reason: 'TEMPLATE_RESTRICTED' });
  });
  it('3. PARAM_UNKNOWN_KEY 422', () => {
    const e = catchEngine(() => checkTemplateWrite(ADMIN, TPL, [change('page.bogus', 1)]));
    expect(e.code).toBe('PARAM_UNKNOWN_KEY');
    expect(e.httpStatus).toBe(422);
  });
  it('4. PARAM_CLASS_T_READONLY 400: kelas T (page.sizeMm) ditolak bahkan untuk ADMIN', () => {
    const e = catchEngine(() => checkTemplateWrite(ADMIN, TPL, [change('page.sizeMm', [100, 200])]));
    expect(e.code).toBe('PARAM_CLASS_T_READONLY');
    expect(e.httpStatus).toBe(400);
    expect(e.details).toMatchObject({ keys: ['page.sizeMm'] });
  });
  it('4. PARAM_CLASS_T_READONLY 400: lapis turunan (grid.innerMarginMm) oleh USER (D-165 KT-4)', () => {
    const e = catchEngine(() => checkTemplateWrite(USER, TPL, [change('grid.innerMarginMm', 30)]));
    expect(e.code).toBe('PARAM_CLASS_T_READONLY');
    expect((e.details as { failures: Array<{ surface?: string }> }).failures[0].surface).toBe('derived');
  });
  it('4. positif: ADMIN menyematkan turunan pada preset', () => {
    expect(() => checkTemplateWrite(ADMIN, { ...TPL, isPreset: true }, [change('grid.innerMarginMm', 30)])).not.toThrow();
  });
  it('4. slot.setup.pageSizeTw (R-41) -> 400 berpointer /pageSizeTw', () => {
    const e = catchEngine(() => checkTemplateWrite(ADMIN, TPL, [change('slot.setup', { pageSizeTw: [1, 2] }, undefined, CHAPTER_SLOT)]));
    expect(e.code).toBe('PARAM_CLASS_T_READONLY');
    expect((e.details as { failures: Array<{ pointer?: string }> }).failures[0].pointer).toBe('/pageSizeTw');
  });
  it('6. PARAM_CLASS_K_FORBIDDEN 403: USER mengubah ingest.inlineFormat (kelas K)', () => {
    const e = catchEngine(() => checkTemplateWrite(USER, TPL, [change('ingest.inlineFormat', 'reject')]));
    expect(e.code).toBe('PARAM_CLASS_K_FORBIDDEN');
    expect(e.httpStatus).toBe(403);
  });
  it('7. PARAM_SURFACE_FORBIDDEN 403: USER mengubah kunci lanjutan (doc.defaultTier)', () => {
    const e = catchEngine(() => checkTemplateWrite(USER, TPL, [change('doc.defaultTier', 'NOTA')]));
    expect(e.code).toBe('PARAM_SURFACE_FORBIDDEN');
    expect(e.httpStatus).toBe(403);
    expect(e.details).toMatchObject({ surface: 'advanced', keys: ['doc.defaultTier'] });
  });
  it('7. D-163 T-1: expertMode TIDAK membuka lanjutan bagi USER (dicatat expertModeIgnored)', () => {
    const e = catchEngine(() => checkTemplateWrite(USER, TPL, [change('doc.defaultTier', 'NOTA')], { expertMode: true }));
    expect(e.code).toBe('PARAM_SURFACE_FORBIDDEN');
    expect(e.details).toMatchObject({ expertModeIgnored: true });
  });
  it('7. lapis internal (render.draft.marker, kelas B) oleh USER -> 403 surface internal', () => {
    const e = catchEngine(() => checkTemplateWrite(USER, TPL, [change('render.draft.marker', { text: 'X', placement: 'footer' })]));
    expect(e.code).toBe('PARAM_SURFACE_FORBIDDEN');
    expect(e.details).toMatchObject({ surface: 'internal' });
  });
  it('7. per kenop D-170: USER boleh slot.setup.startOnNewPage; medan setup lain 403 dengan fields', () => {
    expect(() => checkTemplateWrite(USER, TPL, [change('slot.setup', { startOnNewPage: true }, undefined, CHAPTER_SLOT)])).not.toThrow();
    const e = catchEngine(() => checkTemplateWrite(USER, TPL, [change('slot.setup', { startOnNewPage: true, titlePage: true }, undefined, CHAPTER_SLOT)]));
    expect(e.code).toBe('PARAM_SURFACE_FORBIDDEN');
    expect((e.details as { failures: Array<{ fields?: string[] }> }).failures[0].fields).toEqual(['titlePage']);
  });
  it('positif: USER mengubah kunci esensial; ADMIN mengubah lanjutan', () => {
    expect(() => checkTemplateWrite(USER, TPL, [change('page.size', 'A5'), change('grid.marginDensity', 'compact')])).not.toThrow();
    expect(() => checkTemplateWrite(ADMIN, TPL, [change('doc.defaultTier', 'NOTA')])).not.toThrow();
  });
  it('urutan: kelas T dilaporkan sebelum kelas K dan lapis', () => {
    const e = catchEngine(() => checkTemplateWrite(USER, TPL, [change('ingest.inlineFormat', 'reject'), change('doc.defaultTier', 'NOTA'), change('page.sizeMm', [1, 1])]));
    expect(e.code).toBe('PARAM_CLASS_T_READONLY');
  });
  it('HTTP register: K 403, T 400, SURFACE 403, PRESET 403, SCOPE 422', () => {
    expect([STUDIO_ERROR_HTTP.PARAM_CLASS_K_FORBIDDEN, STUDIO_ERROR_HTTP.PARAM_CLASS_T_READONLY, STUDIO_ERROR_HTTP.PARAM_SURFACE_FORBIDDEN, STUDIO_ERROR_HTTP.PRESET_READONLY, STUDIO_ERROR_HTTP.SLOT_PARAM_SCOPE_INVALID]).toEqual([403, 400, 403, 403, 422]);
  });
});

describe('urutan resolusi nilai efektif per slot (§13.5 langkah 1-8)', () => {
  const tplEmpty = { params: {}, roleFormats: {} } as never;
  const slot = (patch: Partial<TemplateSlotDef> = {}): TemplateSlotDef => ({ ...datumSlots()[4], ...patch });

  it('(1) default registri bila tidak ada lapis', () => {
    const r = resolveSlotParams(tplEmpty, slot(), undefined, { layers: { preset: {}, template: {} } });
    expect(r.params['slot.placeholderText']).toBe('[{label} belum diisi]');
    expect(r.placeholderText).toBe('[Isi belum diisi]');
  });
  it('(2)<(3/4)<(5/6): preset < templat < slot untuk kunci yang sama', () => {
    const k = 'slot.placeholderText';
    const at = (preset: ParamMap, template: ParamMap, s: Partial<TemplateSlotDef>) => resolveSlotParams(tplEmpty, slot(s), undefined, { layers: { preset, template } }).params[k];
    expect(at({ [k]: 'P' }, {}, {})).toBe('P');
    expect(at({ [k]: 'P' }, { [k]: 'T' }, {})).toBe('T');
    expect(at({ [k]: 'P' }, { [k]: 'T' }, { advanced: { [k]: 'S' } })).toBe('S');
  });
  it('(5)<(6): lanjutan slot menang atas esensial slot; objek digabung dangkal', () => {
    const flat = flattenSlotParams({ essentials: { 'slot.setup': { startOnNewPage: true, runningHead: 'a' } }, advanced: { 'slot.setup': { runningHead: 'b' }, 'slot.placeholderText': 'x' } });
    expect(flat).toEqual({ 'slot.setup': { startOnNewPage: true, runningHead: 'b' }, 'slot.placeholderText': 'x' });
  });
  it('(7) turunan dihitung ulang dari kenop: kerapatan compact -> margin x0,75 dibulatkan 0,5', () => {
    const r = resolveSlotParams(tplEmpty, slot(), undefined, { layers: { preset: {}, template: { 'grid.marginDensity': 'compact' } } });
    expect(r.params['grid.innerMarginMm']).toBe(18);
    expect(r.params['grid.outerMarginMm']).toBe(15);
    expect(r.params['grid.topBottomMarginMm']).toBe(19.5);
  });
  it('(7) sematan preset: reference (bawaan D-169) menskalakan dari sematan; absolute tidak dihitung ulang', () => {
    const layers = { preset: { 'grid.innerMarginMm': 30 }, template: { 'grid.marginDensity': 'compact' } };
    expect(resolveSlotParams(tplEmpty, slot(), undefined, { layers }).params['grid.innerMarginMm']).toBe(22.5);
    expect(resolveSlotParams(tplEmpty, slot(), undefined, { layers, pinPolicy: 'absolute' }).params['grid.innerMarginMm']).toBe(30);
  });
  it('(8) kelas T dihitung ulang: override page.sizeMm diabaikan dan dilaporkan', () => {
    const r = resolveSlotParamsDetailed(tplEmpty, slot(), undefined, { layers: { preset: {}, template: { 'page.sizeMm': [100, 100] } } });
    expect(r.slot.params['page.sizeMm']).toEqual([210, 297]);
    expect(r.issues.some((i) => i.code === 'PARAM_CLASS_T_READONLY' && i.key === 'page.sizeMm')).toBe(true);
  });
  it('orientasi per slot (cakupan slot): lampiran landscape -> page.sizeMm ditukar, kolom teks dari W = 297', () => {
    const base = resolved().params;
    const r = resolveSlotParams({ params: base, roleFormats: {} } as never, slot({ slotKey: 'appendices', essentials: { 'page.orientation': 'landscape' } }));
    expect(r.params['page.sizeMm']).toEqual([297, 210]);
    expect(r.params['grid.textColumnMm']).toBe(Number(base['grid.textColumnMm']) + 87);
  });
});

describe('rantai ukuran kertas (DV-01..DV-02, D-169, D-172)', () => {
  it.each(Object.entries(PAPER_SIZE_MM))('pageSizeFromPaper %s portrait/landscape', (size, [w, h]) => {
    expect(pageSizeFromPaper({ 'page.size': size })).toEqual([w, h]);
    expect(pageSizeFromPaper({ 'page.size': size, 'page.orientation': 'landscape' })).toEqual([h, w]);
  });
  it('page.customSizeMm menimpa page.size; tanpa kenop sah -> undefined (tanpa fallback A4, KD-25)', () => {
    expect(pageSizeFromPaper({ 'page.size': 'A4', 'page.customSizeMm': [300, 200] })).toEqual([200, 300]);
    expect(pageSizeFromPaper({ 'page.size': 'B9' })).toBeUndefined();
    expect(pageSizeFromPaper({ 'page.customSizeMm': [0, 10] })).toBeUndefined();
  });
  it('invarian A4 portrait standard: sizeMm, twip 11906x16838, kolom 128, lebar figur [128,166], blok 247', () => {
    const p = resolved().params;
    expect(p['page.sizeMm']).toEqual([210, 297]);
    expect([mmToTw(210), mmToTw(297)]).toEqual([11906, 16838]);
    expect((p['render.section.wrapper'] as { pageSizeTw?: number[] }).pageSizeTw).toEqual([11906, 16838]);
    expect(p['grid.textColumnMm']).toBe(128);
    expect(p['grid.allowedFigureWidthsMm']).toEqual([128, 166]);
    expect(p['grid.textBlockHeightMm']).toBe(247);
  });
  it('D-169: kolom teks SELALU moda A (W - dalam - luar - gutter - rel), juga untuk layout.railMode B', () => {
    expect(resolved({ 'layout.railMode': 'B' }).params['grid.textColumnMm']).toBe(128);
  });
  it('textBlockFromPage: A4 landscape blok 160 (D-169; margin tetap dalam mm)', () => {
    expect(resolved({ 'page.orientation': 'landscape' }).params['grid.textBlockHeightMm']).toBe(160);
  });
  it('Letter: [215,9, 279,4] mm = 12240 x 15840 twip; kolom teks +5,9 mm dari A4', () => {
    const p = resolved({ 'page.size': 'Letter' }).params;
    expect(p['page.sizeMm']).toEqual([215.9, 279.4]);
    expect((p['render.section.wrapper'] as { pageSizeTw?: number[] }).pageSizeTw).toEqual([12240, 15840]);
    expect(p['grid.textColumnMm']).toBeCloseTo(133.9, 6);
  });
  it('figureWidthFromClass: chart.widthClass text -> kolom teks, full -> bentang penuh', () => {
    const t = resolved({ 'chart.widthClass': 'text' }).params;
    const f = resolved({ 'chart.widthClass': 'full' }).params;
    expect(t['chart.output.widthMm']).toBe(t['grid.textColumnMm']);
    expect(f['chart.output.widthMm']).toBe(f['grid.fullSpanMm']);
    expect(f['chart.output.widthMm']).toBe(166);
  });
});
