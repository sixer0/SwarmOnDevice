// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/seed/gf08-rev-a-role-formats.test.ts (see test/ported/README.md).
import { seedModule, useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
/**
 * GF-08 (follow-up after the C33 re-measure; verification/22 §9): the Rev A preset gets its own role formats so the
 * Table 8.2 run sizes reach the DOCX. The inherited Manual 000 role formats print fixed sizes (caption label 7 pt,
 * table header 6.5 pt, numerals 7.5 pt, mono 7 pt) and win over the `type.scale.*` pins (`engine/tokens/roles.ts`).
 *
 * Seam: the seed helper exports (`derivedPresetRoleFormats`, `ensureDerivedPreset`, `ensureDerivedTemplate`) and the
 * spec table `DERIVED_PRESET_SPECS`. The DB is an in-memory stub; the template v2 service is replaced by a fake that
 * follows the service's role-format rule (`services/templates/index.ts:948-963`, `profile.ts:583`): own roles = the
 * entries of `template.roleFormats` that differ from the base version's roles; `roleFormats` not sent = the previous
 * version's own roles are carried; stored = base roles + own roles.
 *
 * Expected values are literals from Table 8.2 (`ID:2633-2635`) rounded to the nearest DOCX half-point (`w:sz`):
 * 7.6 pt -> 15 (7.5 pt), 6.8 pt -> 14 (7.0 pt), 7.8 pt -> 16 (8.0 pt); 0.09 em x 6.8 pt = 12.24 tw -> 12. The scorer
 * uses the same nearest-half-point reading (GF-07: kicker 6.8 pt = sz 14 +-1, `expect_structure_b.ts:127`).
 */
import { beforeEach, describe, expect, it, vi } from '../_vitest';
import type { StudioTemplateV2 } from '@/lib/studio/contract';
import { canonicalVersionPayload, type ParamRecord } from '@/lib/studio/services/templates';
import { skeletonSha256, validateSkeleton } from '@/lib/studio/services/skeleton';
import manual000 from '../../../vendor/benchmark/manual000/template.json';

const calls = vi.hoisted(() => ({ create: [] as Array<{ input: Record<string, unknown> }>, version: [] as Array<{ templateId: string; input: Record<string, unknown> }> }));
const world = vi.hoisted(() => ({ current: null as null | { onCreate: (input: Record<string, unknown>) => void; onVersion: (templateId: string, input: Record<string, unknown>) => void } }));

// row42 W10: the original vi.mock of services/templates (createTemplateV2InTx/createTemplateVersionV2InTx -> recorders)
// is removed: only the Prisma-tx cases below used it, and they are skipped (P3); in bun a module mock would
// stay installed for every later suite in the process (C65/C71 isolation lesson).
// vi.mock('@/lib/studio/services/templates', async (importOriginal) => {
//   const real = await importOriginal<typeof import('@/lib/studio/services/templates')>();
//   return {
//     ...real,
//     createTemplateV2InTx: vi.fn(async (_tx: unknown, input: Record<string, unknown>) => {
//       calls.create.push({ input });
//       world.current?.onCreate(input);
//       return {};
//     }),
//     createTemplateVersionV2InTx: vi.fn(async (_tx: unknown, templateId: string, input: Record<string, unknown>) => {
//       calls.version.push({ templateId, input });
//       world.current?.onVersion(templateId, input);
//       return {};
//     }),
//   };
// });

const { DATUM_SKELETON_SLOTS, derivedPresetRoleFormats, derivedPresetStoredIssues, derivedTemplateStoredIssues, ensureDerivedPreset, ensureDerivedTemplate, presetSlotEssentials } = (await import(seedModule('seed-studio-templates'))) as any; // row42 W14
const { DERIVED_PRESET_SPECS } = (await import(seedModule('seed-derived-presets'))) as any; // row42 W14

type Roles = Record<string, Record<string, Record<string, unknown>>>;
const REV_A_SLUG = 'datum-gsp-rev-a-preset';
const EFFECTIVE = canonicalVersionPayload().resolvedParams as ParamRecord;
/** Measured Manual 000 role formats = what `datum-gsp-preset` v2 carries for these roles on DEV (probe in the report). */
const BASE_ROLES = JSON.parse(JSON.stringify((manual000 as { roleFormats: Roles }).roleFormats)) as Roles;
const GSP_PINS: ParamRecord = {
  'type.scale.tableNumerals.size': 7,
  'type.scale.tableHeader.size': 6.5,
  'type.scale.caption.size': 7.5,
  'type.scale.tableHeader.trackEm': 0.0923,
};
const TABLE_ROLES = ['caption', 'table.headerLeft', 'table.headerRight', 'controlTable.header', 'table.cellNumeralRight', 'table.cellMono'];

const revA = (): DerivedPresetSpec => {
  const s = DERIVED_PRESET_SPECS.find((x) => x.slug === REV_A_SLUG);
  if (!s) throw new Error('spec Rev A tidak ada');
  return s;
};

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const stableJson = (v: unknown): string =>
  JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, (x as Record<string, unknown>)[k]])) : x));
/** Service rule (`templates/v2.ts` `ownRoleFormats`): entries that differ from the base map. */
const own = (stored: Roles | undefined, base: Roles): Roles =>
  Object.fromEntries(Object.entries(stored ?? {}).filter(([r, f]) => stableJson(f) !== stableJson(base[r] ?? null))) as Roles;

// ── Spec table + pure plan ───────────────────────────────────────────────

describe('GF-08 Rev A role formats in the derived preset spec', () => {
  it('the spec carries role-format overrides for exactly the caption, table-header and table-numeral roles', () => {
    expect(Object.keys(revA().roleFormatOverrides ?? {}).sort()).toEqual([...TABLE_ROLES].sort());
  });

  it('plan: Table 8.2 sizes at the nearest half-point; every other attribute is the base role format', () => {
    const roles = derivedPresetRoleFormats(revA(), BASE_ROLES, { ...EFFECTIVE, ...GSP_PINS }) as Roles;
    expect(Object.keys(roles).sort()).toEqual([...TABLE_ROLES].sort());
    // Caption 7.6/11 pt Cond 400 (ID:2635): text run and identifier run both 15 (7.5 pt); leading stays 11 pt.
    expect(roles.caption.run.szHalfPt).toBe(15);
    expect(roles.caption.labelRun.szHalfPt).toBe(15);
    expect(roles.caption.para).toEqual(BASE_ROLES.caption.para);
    expect(roles.caption.para.lineTw).toBe(220);
    // Header 6.8 pt Cond 600 caps +0.09 em (ID:2634): 14 (7.0 pt), tracking 12 tw.
    for (const r of ['table.headerLeft', 'table.headerRight', 'controlTable.header']) {
      expect(roles[r].run.szHalfPt, r).toBe(14);
      expect(roles[r].run.spacingTw, r).toBe(12);
      expect(roles[r].run.caps, r).toBe(true);
      expect(roles[r].cell, r).toEqual(BASE_ROLES[r].cell);
    }
    // Numerals 7.8 pt Mono (ID:2633): 16 (8.0 pt).
    expect(roles['table.cellNumeralRight'].run.szHalfPt).toBe(16);
    expect(roles['table.cellMono'].run.szHalfPt).toBe(16);
    expect(roles['table.cellMono'].run.face).toBe('IBM Plex Mono');
    // Only szHalfPt (and the header tracking, equal to the base) differs from the base role formats.
    for (const r of TABLE_ROLES) {
      const strip = (f: Record<string, Record<string, unknown>>) =>
        Object.fromEntries(Object.entries(f).map(([k, v]) => [k, k === 'para' || k === 'cell' ? v : Object.fromEntries(Object.entries(v).filter(([a]) => a !== 'szHalfPt'))]));
      expect(strip(roles[r]), r).toEqual(strip(BASE_ROLES[r]));
    }
  });

  it('plan agrees with the pins: each patched run size equals the catalog size of the role at the preset values', () => {
    const wrong = clone(revA());
    (wrong.roleFormatOverrides as Record<string, Record<string, Record<string, unknown>>>)['table.cellMono'] = { run: { szHalfPt: 14 } };
    expect(() => derivedPresetRoleFormats(wrong, BASE_ROLES, { ...EFFECTIVE, ...GSP_PINS })).toThrow(/table\.cellMono.*szHalfPt 14.*16/);
  });

  it('plan errors: role or sub-object missing in the base, unknown role, no difference from the base', () => {
    const spec = revA();
    const noCaption = clone(BASE_ROLES);
    delete noCaption.caption;
    expect(() => derivedPresetRoleFormats(spec, noCaption, EFFECTIVE)).toThrow(/caption.*tidak ada di preset dasar/);
    const noLabel = clone(BASE_ROLES);
    delete noLabel.caption.labelRun;
    expect(() => derivedPresetRoleFormats(spec, noLabel, EFFECTIVE)).toThrow(/caption\.labelRun/);
    expect(() => derivedPresetRoleFormats({ ...spec, roleFormatOverrides: { 'tidak.ada': { run: { szHalfPt: 15 } } } }, BASE_ROLES, EFFECTIVE)).toThrow(/tidak dikenal/);
    expect(() => derivedPresetRoleFormats({ ...spec, roleFormatOverrides: { 'table.cellText': { run: { szHalfPt: 16 } } } }, BASE_ROLES, EFFECTIVE)).toThrow(/tanpa beda/);
  });

  it('no overrides = undefined (old behaviour of the helper)', () => {
    const { roleFormatOverrides: _r, ...rest } = revA();
    void _r;
    expect(derivedPresetRoleFormats(rest, BASE_ROLES, EFFECTIVE)).toBeUndefined();
  });
});

// ── Stub DB + fake service with the service's role-format rule ────────────

interface FT { id: string; slug: string; isPreset: boolean; latestVersionNo: number; contractKind: string | null; archived: boolean; kind: string; updatedAt: Date }
interface FV { id: string; templateId: string; versionNo: number; baseVersionId: string | null; resolvedParams: ParamRecord; overrides: ParamRecord; roleFormats: Roles; skeletonSha256: string | null; paramsSha256: string }
const T0 = new Date('2026-01-01T00:00:00Z');

function makeWorld() {
  const templates: FT[] = [{ id: 'gsp', slug: 'datum-gsp-preset', isPreset: true, latestVersionNo: 2, contractKind: null, archived: false, kind: 'DOCUMENT', updatedAt: T0 }];
  const presetSk = skeletonSha256(validateSkeleton({ slots: presetSlotEssentials(DATUM_SKELETON_SLOTS, null).slots }));
  const versions: FV[] = [1, 2].map((n) => ({
    id: `gsp-v${n}`,
    templateId: 'gsp',
    versionNo: n,
    baseVersionId: 'kanonik-v1',
    resolvedParams: { ...EFFECTIVE, ...GSP_PINS },
    overrides: { ...GSP_PINS },
    roleFormats: clone(BASE_ROLES),
    skeletonSha256: presetSk,
    paramsSha256: `p-gsp-${n}`,
  }));
  const writes: string[] = [];
  const write = (t: FT, def: StudioTemplateV2) => {
    const pt = templates.find((x) => x.slug === def.preset?.slug)!;
    const pv = versions.find((v) => v.templateId === pt.id && v.versionNo === def.preset?.version)!;
    const prev = versions.find((v) => v.templateId === t.id && v.versionNo === t.latestVersionNo);
    const ownRoles = def.roleFormats !== undefined ? own(def.roleFormats as Roles, pv.roleFormats) : own(prev?.roleFormats, pv.roleFormats);
    const layer = { ...def.essentials, ...(def.advanced ?? {}) } as ParamRecord;
    const versionNo = versions.filter((v) => v.templateId === t.id).length + 1;
    versions.push({
      id: `${t.id}-v${versionNo}`,
      templateId: t.id,
      versionNo,
      baseVersionId: pv.id,
      resolvedParams: { ...pv.resolvedParams, ...layer },
      overrides: layer,
      roleFormats: { ...pv.roleFormats, ...ownRoles },
      skeletonSha256: skeletonSha256(validateSkeleton(def.skeleton)),
      paramsSha256: `p-${t.id}-${versionNo}`,
    });
    t.latestVersionNo = versionNo;
  };
  world.current = {
    onCreate: (input) => {
      writes.push(`create:${String(input.slug)}`);
      const t: FT = { id: `t-${String(input.slug)}`, slug: String(input.slug), isPreset: input.isPreset === true, latestVersionNo: 0, contractKind: (input.contractKind as string) ?? null, archived: false, kind: 'DOCUMENT', updatedAt: T0 };
      templates.push(t);
      write(t, input.template as StudioTemplateV2);
    },
    onVersion: (templateId, input) => {
      const t = templates.find((x) => x.id === templateId)!;
      writes.push(`version:${t.slug}`);
      write(t, input.template as StudioTemplateV2);
    },
  };
  const latest = (slug: string) => {
    const t = templates.find((x) => x.slug === slug)!;
    return versions.find((v) => v.templateId === t.id && v.versionNo === t.latestVersionNo)!;
  };
  const tx = {
    writes,
    templates,
    versions,
    latest,
    studioTemplate: {
      findUnique: async ({ where }: { where: { slug: string } }) => templates.find((t) => t.slug === where.slug) ?? null,
      findUniqueOrThrow: async ({ where }: { where: { slug: string } }) => templates.find((t) => t.slug === where.slug)!,
    },
    studioTemplateVersion: {
      findUniqueOrThrow: async ({ where }: { where: { templateId_versionNo: { templateId: string; versionNo: number } } }) =>
        versions.find((x) => x.templateId === where.templateId_versionNo.templateId && x.versionNo === where.templateId_versionNo.versionNo)!,
    },
    studioTemplateSlot: {
      findMany: async () => DATUM_SKELETON_SLOTS.map((s) => ({ slotKey: s.slotKey, sectionTypeKey: s.sectionType, position: s.position, required: s.required, repeatable: s.repeatable, positionLocked: s.positionLocked, minItems: s.minItems ?? null, contentMode: s.contentMode, tiers: s.tiers, admits: s.admits })),
    },
  };
  return tx;
}

/** A doc-type template on the Rev A preset (spec shape of `seed-doc-type-templates.ts`, empty layer). */
const TEMPLATE: DerivedTemplateSpec = { slug: 'uji-laporan', name: 'Uji', description: 'Uji', presetSlug: REV_A_SLUG, slots: DATUM_SKELETON_SLOTS, layer: {}, contractKind: null, changeNote: () => 'uji' };
const sz = (roles: Roles, r: string, sub = 'run') => roles[r]?.[sub]?.szHalfPt;

beforeEach(() => {
  calls.create.length = 0;
  calls.version.length = 0;
  world.current = null;
});

// row42 SKIP P3 "Prisma (row 109 cut)": the cases marked it.skip below run the seed helpers (prisma/seed-studio-templates.ts,
// build-time input of the row 110 export only, spec §1.1) against an in-memory Prisma tx stub and the Prisma template
// service; Swarm's services/templates is the row 66 TemplateSource twin over the store.
describe('GF-08 ensureDerivedPreset with role-format overrides', () => {
  it.skip('created: the stored role formats carry the Table 8.2 sizes; every other role equals the base', async () => {
    const tx = makeWorld();
    const r = await ensureDerivedPreset(tx as never, revA());
    expect(r.outcome).toBe('created');
    expect(r.storedOk).toBe(true);
    const roles = tx.latest(REV_A_SLUG).roleFormats;
    expect([sz(roles, 'caption'), sz(roles, 'caption', 'labelRun'), sz(roles, 'table.headerLeft'), sz(roles, 'table.headerRight'), sz(roles, 'controlTable.header'), sz(roles, 'table.cellNumeralRight'), sz(roles, 'table.cellMono')]).toEqual([15, 15, 14, 14, 14, 16, 16]);
    expect(Object.keys(own(roles, BASE_ROLES)).sort()).toEqual([...TABLE_ROLES].sort());
    expect(r.roleFormatOverrides).toEqual([...TABLE_ROLES].sort());
  });

  it.skip('re-run = unchanged with 0 writes (role formats compared)', async () => {
    const tx = makeWorld();
    await ensureDerivedPreset(tx as never, revA());
    const before = tx.writes.length;
    const r = await ensureDerivedPreset(tx as never, revA());
    expect(r.outcome).toBe('unchanged');
    expect(tx.writes.length).toBe(before);
  });

  it.skip('an existing preset version WITHOUT the role formats (DEV v1 today) = new-version, not unchanged', async () => {
    const tx = makeWorld();
    const { roleFormatOverrides: _r, ...v1 } = revA();
    void _r;
    await ensureDerivedPreset(tx as never, v1);
    expect(tx.latest(REV_A_SLUG).versionNo).toBe(1);
    const r = await ensureDerivedPreset(tx as never, revA());
    expect(r.outcome).toBe('new-version');
    expect(r.versionNo).toBe(2);
    expect(r.storedOk).toBe(true);
    expect(sz(tx.latest(REV_A_SLUG).roleFormats, 'table.headerLeft')).toBe(14);
  });

  it.skip('a stored version whose role formats drifted from the spec = new-version that restores them', async () => {
    const tx = makeWorld();
    await ensureDerivedPreset(tx as never, revA());
    const v = tx.latest(REV_A_SLUG);
    v.roleFormats = { ...v.roleFormats, 'table.cellMono': clone(BASE_ROLES['table.cellMono']) };
    const r = await ensureDerivedPreset(tx as never, revA());
    expect(r.outcome).toBe('new-version');
    expect(r.storedOk).toBe(true);
    expect(sz(tx.latest(REV_A_SLUG).roleFormats, 'table.cellMono')).toBe(16);
  });

  it('stored-row check: own role formats different from the plan = issue roleFormats (guard input)', () => {
    const planned = derivedPresetRoleFormats(revA(), BASE_ROLES, EFFECTIVE)!;
    const ok = { ...BASE_ROLES, ...planned };
    const row = { template: { isPreset: true, archived: false }, version: { skeletonSha256: 's', baseVersionId: 'b', resolvedParams: { ...EFFECTIVE, ...revA().pins } }, computedSkeletonSha256: 's', pins: revA().pins, baseVersionId: 'b' };
    expect(derivedPresetStoredIssues({ ...row, roleFormats: { stored: ok, base: BASE_ROLES, planned } })).toEqual([]);
    expect(derivedPresetStoredIssues({ ...row, roleFormats: { stored: BASE_ROLES, base: BASE_ROLES, planned } })).toEqual(['roleFormats']);
    expect(derivedPresetStoredIssues({ ...row, roleFormats: { stored: { ...ok, 'table.cellText': { run: { szHalfPt: 99 } } }, base: BASE_ROLES, planned } })).toEqual(['roleFormats']);
  });

  it.skip('datum-gsp-preset (the base) is not written', async () => {
    const tx = makeWorld();
    await ensureDerivedPreset(tx as never, revA());
    expect(tx.writes).toEqual([`create:${REV_A_SLUG}`]);
    expect(tx.latest('datum-gsp-preset').roleFormats).toEqual(BASE_ROLES);
  });
});

// row42 SKIP P3 "Prisma (row 109 cut)": the cases marked it.skip below run the seed helpers (prisma/seed-studio-templates.ts,
// build-time input of the row 110 export only, spec §1.1) against an in-memory Prisma tx stub and the Prisma template
// service; Swarm's services/templates is the row 66 TemplateSource twin over the store.
describe('GF-08 derived templates follow the new preset role formats (no stale carry)', () => {
  it.skip('preset v1 (no overrides) -> template v1; preset v2 (overrides) -> template v2 stores the preset sizes, no own roles', async () => {
    const tx = makeWorld();
    const { roleFormatOverrides: _r, ...v1 } = revA();
    void _r;
    await ensureDerivedPreset(tx as never, v1);
    expect((await ensureDerivedTemplate(tx as never, TEMPLATE)).outcome).toBe('created');
    await ensureDerivedPreset(tx as never, revA());
    const r = await ensureDerivedTemplate(tx as never, TEMPLATE);
    expect(r.outcome).toBe('new-version');
    expect(r.storedOk).toBe(true);
    const tRoles = tx.latest(TEMPLATE.slug).roleFormats;
    expect(sz(tRoles, 'table.headerLeft')).toBe(14);
    expect(sz(tRoles, 'caption', 'labelRun')).toBe(15);
    expect(own(tRoles, tx.latest(REV_A_SLUG).roleFormats)).toEqual({});
    expect(await ensureDerivedTemplate(tx as never, TEMPLATE).then((x) => x.outcome)).toBe('unchanged');
  });

  it.skip('a template version with own (stale) role formats = new-version on re-run, and storedOk checks role formats', async () => {
    const tx = makeWorld();
    await ensureDerivedPreset(tx as never, revA());
    await ensureDerivedTemplate(tx as never, TEMPLATE);
    const v = tx.latest(TEMPLATE.slug);
    v.roleFormats = { ...v.roleFormats, 'table.headerLeft': clone(BASE_ROLES['table.headerLeft']) };
    const r = await ensureDerivedTemplate(tx as never, TEMPLATE);
    expect(r.outcome).toBe('new-version');
    expect(sz(tx.latest(TEMPLATE.slug).roleFormats, 'table.headerLeft')).toBe(14);
    expect(r.storedOk).toBe(true);
  });

  it('stored-row check: a template version with own role formats = issue roleFormats; absent input = not checked', () => {
    const row = {
      template: { contractKind: null, archived: false },
      version: { skeletonSha256: 's', baseVersionId: 'p', resolvedParams: EFFECTIVE },
      computedSkeletonSha256: 's',
      storedSlots: [],
      specSlots: [],
      layer: {},
      contractKind: null,
      presetVersionId: 'p',
    };
    const presetRoles = { ...BASE_ROLES, ...derivedPresetRoleFormats(revA(), BASE_ROLES, EFFECTIVE) };
    expect(derivedTemplateStoredIssues({ ...row, roleFormats: { stored: presetRoles, preset: presetRoles } })).toEqual([]);
    expect(derivedTemplateStoredIssues({ ...row, roleFormats: { stored: BASE_ROLES, preset: presetRoles } })).toEqual(['roleFormats']);
    expect(derivedTemplateStoredIssues(row)).toEqual([]);
  });
});
