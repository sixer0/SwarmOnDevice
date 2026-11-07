// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/seed/c21-derived-preset-seed.test.ts (see test/ported/README.md).
import { seedModule, useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
/**
 * C21 (ronde cakupan, GF-08 mekanisme M2; research/35 §6 M2 (a)-(e); research/38 §4.4; D-609, D-627, D-635):
 * langkah preset turunan generik di helper seed.
 *
 * Seam: ekspor modul helper `prisma/seed-studio-templates.ts` (`ensureDerivedPreset`, `runGuardedTemplateTx` opsi
 * `presets`) dan tabel spec `prisma/seed-derived-presets.ts` (`DERIVED_PRESET_SPECS`, `withDerivedPresets`, dipakai
 * `prisma/seed-studio.ts --doc-type-templates` apa adanya). DB diganti stub dalam memori; layanan templat v2 diganti
 * tiruan yang mencatat masukan dan menulis ke stub (tidak ada koneksi DB). Nilai harapan = register research/38 §4.4
 * (Tabel 8.2 `ID:2633-2635`), bukan dihitung ulang dari kode.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from '../_vitest';
import type { StudioTemplateV2, TableBlock } from '@/lib/studio/contract';
import { canonicalVersionPayload, type ParamRecord } from '@/lib/studio/services/templates';
import { skeletonSha256, validateSkeleton } from '@/lib/studio/services/skeleton';
import { tableGuards } from '@/lib/studio/engine/docx/tables';
import { solveWidthsImpl } from '@/lib/studio/engine/docx/tables/widths';
import { PARAMS_BY_KEY } from '@/lib/studio/params';
import manual000 from '../../../vendor/benchmark/manual000/template.json';

const calls = vi.hoisted(() => ({ create: [] as Array<{ input: Record<string, unknown>; caller: Record<string, unknown> }>, version: [] as Array<{ templateId: string; input: Record<string, unknown>; caller: Record<string, unknown> }> }));
const world = vi.hoisted(() => ({ current: null as null | { onCreate: (input: Record<string, unknown>) => void; onVersion: (templateId: string, input: Record<string, unknown>) => void } }));

// row42 W10: the original vi.mock of services/templates (createTemplateV2InTx/createTemplateVersionV2InTx -> recorders)
// is removed: only the Prisma-tx cases below used it, and they are skipped (P3); in bun a module mock would
// stay installed for every later suite in the process (C65/C71 isolation lesson).
// vi.mock('@/lib/studio/services/templates', async (importOriginal) => {
//   const real = await importOriginal<typeof import('@/lib/studio/services/templates')>();
//   return {
//     ...real,
//     createTemplateV2InTx: vi.fn(async (_tx: unknown, input: Record<string, unknown>, caller: Record<string, unknown>) => {
//       calls.create.push({ input, caller });
//       world.current?.onCreate(input);
//       return {};
//     }),
//     createTemplateVersionV2InTx: vi.fn(async (_tx: unknown, templateId: string, input: Record<string, unknown>, caller: Record<string, unknown>) => {
//       calls.version.push({ templateId, input, caller });
//       world.current?.onVersion(templateId, input);
//       return {};
//     }),
//   };
// });

const { DATUM_SKELETON_SLOTS, ensureDerivedPreset, presetSlotEssentials, runGuardedTemplateTx } = (await import(seedModule('seed-studio-templates'))) as any; // row42 W14
const { DERIVED_PRESET_SPECS, withDerivedPresets } = (await import(seedModule('seed-derived-presets'))) as any; // row42 W14
const { DOC_TYPE_TEMPLATE_SPECS, docTypeTemplateTxOptions } = (await import(seedModule('seed-doc-type-templates'))) as any; // row42 W14

const REPO = path.resolve(__dirname, '..', '..', '..', 'vendor');
const EFFECTIVE = canonicalVersionPayload().resolvedParams as ParamRecord;

/** Register research/38 §4.4 (Tabel 8.2 ID:2633-2635; tracking kepala tabel ID:2634, D-635). */
const REV_A_SLUG = 'datum-gsp-rev-a-preset';
const REGISTER_PINS: ParamRecord = {
  'type.scale.tableNumerals.size': 7.8,
  'type.scale.tableHeader.size': 6.8,
  'type.scale.caption.size': 7.6,
  'type.scale.tableHeader.trackEm': 0.09,
};
/** Nilai datum-gsp-preset hari ini (verification/22 baris GF-08; DEV v2). */
const GSP_PRESET_PINS: ParamRecord = {
  'type.scale.tableNumerals.size': 7,
  'type.scale.tableHeader.size': 6.5,
  'type.scale.caption.size': 7.5,
  'type.scale.tableHeader.trackEm': 0.0923,
};

const revA = (): DerivedPresetSpec => {
  const s = DERIVED_PRESET_SPECS.find((x) => x.slug === REV_A_SLUG);
  if (!s) throw new Error('spec Rev A tidak ada');
  return s;
};

// ── Tabel spec ───────────────────────────────────────────────────────────

describe('C21 tabel spec preset turunan', () => {
  it('memuat preset Rev A: nama register, basis datum-gsp-preset, sematan = register Tabel 8.2', () => {
    const s = revA();
    expect(s.name).toBe('GSP DATUM Rev A');
    expect(s.baseSlug).toBe('datum-gsp-preset');
    expect(s.pins).toEqual(REGISTER_PINS);
  });

  it('tiga ukuran adalah kunci turunan (hanya ADMIN pada preset), tracking kunci lanjutan; semua nilai sah', () => {
    for (const k of ['type.scale.tableNumerals.size', 'type.scale.tableHeader.size', 'type.scale.caption.size']) expect(PARAMS_BY_KEY.get(k)?.surface, k).toBe('derived');
    expect(PARAMS_BY_KEY.get('type.scale.tableHeader.trackEm')?.surface).toBe('advanced');
  });

  it('kerangka preset = kerangka datum-gsp-preset (7 slot tanpa kenop), slug unik dan bukan basisnya sendiri', () => {
    const s = revA();
    expect(skeletonSha256(validateSkeleton({ slots: presetSlotEssentials(s.slots, null).slots }))).toBe(
      skeletonSha256(validateSkeleton({ slots: presetSlotEssentials(DATUM_SKELETON_SLOTS, null).slots })),
    );
    const slugs = DERIVED_PRESET_SPECS.map((x) => x.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const x of DERIVED_PRESET_SPECS) expect(x.baseSlug).not.toBe(x.slug);
  });

  it('withDerivedPresets: opsi --doc-type-templates apa adanya + tabel preset sebagai sasaran tambahan', () => {
    const base = docTypeTemplateTxOptions('gsp_agent_hq_v21', true);
    const opts = withDerivedPresets(base);
    expect(opts.presets).toBe(DERIVED_PRESET_SPECS);
    expect(opts.specs).toBe(DOC_TYPE_TEMPLATE_SPECS);
    expect(opts.freezeSectionTypes).toBe(true);
    expect(opts.label).toBe(base.label);
    expect(opts.database).toBe('gsp_agent_hq_v21');
    expect(opts.dryRun).toBe(true);
  });

  it('templat jenis dokumen memakai preset Rev A (dialihkan di C23)', () => {
    for (const s of DOC_TYPE_TEMPLATE_SPECS) expect(s.presetSlug).toBe(REV_A_SLUG);
  });
});

// ── ensureDerivedPreset (stub DB + tiruan layanan) ───────────────────────

interface FT { id: string; slug: string; isPreset: boolean; latestVersionNo: number; contractKind: string | null; archived: boolean; kind: string; updatedAt: Date }
interface FV { id: string; templateId: string; versionNo: number; baseVersionId: string | null; resolvedParams: ParamRecord; overrides: ParamRecord; roleFormats?: Record<string, unknown>; skeletonSha256: string | null; paramsSha256: string }
/** GF-08: datum-gsp-preset carries the measured Manual 000 role formats (DEV v2); the Rev A preset patches six of them. */
const BASE_ROLES = (manual000 as { roleFormats: Record<string, unknown> }).roleFormats;
const ownRoles = (stored: Record<string, unknown> | undefined, base: Record<string, unknown> | undefined) =>
  Object.fromEntries(Object.entries(stored ?? {}).filter(([r, f]) => JSON.stringify(f) !== JSON.stringify(base?.[r] ?? null)));

const T0 = new Date('2026-01-01T00:00:00Z');

/** Dunia stub: datum-gsp-preset v1 dan v2 (terbaru v2), templat lain; tulis lewat tiruan layanan dicatat. */
function makeWorld(opts: { gspLatest?: number; database?: string } = {}) {
  const gspLatest = opts.gspLatest ?? 2;
  const templates: FT[] = [
    { id: 'gsp', slug: 'datum-gsp-preset', isPreset: true, latestVersionNo: gspLatest, contractKind: null, archived: false, kind: 'DOCUMENT', updatedAt: T0 },
    { id: 'dg', slug: 'datum-gsp', isPreset: false, latestVersionNo: 3, contractKind: null, archived: false, kind: 'DOCUMENT', updatedAt: T0 },
    { id: 'lka', slug: 'laporan-kerja-agen', isPreset: false, latestVersionNo: 1, contractKind: 'agentWorkReport', archived: false, kind: 'DOCUMENT', updatedAt: T0 },
  ];
  const presetSk = skeletonSha256(validateSkeleton({ slots: presetSlotEssentials(DATUM_SKELETON_SLOTS, null).slots }));
  const versions: FV[] = [];
  for (let n = 1; n <= gspLatest; n++) {
    versions.push({ id: `gsp-v${n}`, templateId: 'gsp', versionNo: n, baseVersionId: 'kanonik-v1', resolvedParams: { ...EFFECTIVE, ...GSP_PRESET_PINS }, overrides: { ...GSP_PRESET_PINS }, roleFormats: BASE_ROLES, skeletonSha256: presetSk, paramsSha256: `p-gsp-${n}` });
  }
  versions.push({ id: 'dg-v3', templateId: 'dg', versionNo: 3, baseVersionId: `gsp-v${gspLatest}`, resolvedParams: { ...EFFECTIVE }, overrides: {}, skeletonSha256: 's-dg', paramsSha256: 'p-dg' });
  versions.push({ id: 'lka-v1', templateId: 'lka', versionNo: 1, baseVersionId: `gsp-v${gspLatest}`, resolvedParams: { ...EFFECTIVE }, overrides: {}, skeletonSha256: 's-lka', paramsSha256: 'p-lka' });
  const writes: string[] = [];
  let seq = 0;

  /** Tiruan layanan v2: basis = versi preset yang dirujuk, lapis = esensial ∪ lanjutan, efektif = basis + lapis. */
  const writeVersion = (t: FT, def: StudioTemplateV2) => {
    const pt = templates.find((x) => x.slug === def.preset?.slug);
    const pv = pt ? versions.find((v) => v.templateId === pt.id && v.versionNo === def.preset?.version) : undefined;
    if (!pv) throw new Error('stub: preset/versi dasar tidak ada');
    const layer = { ...def.essentials, ...(def.advanced ?? {}) } as ParamRecord;
    const versionNo = versions.filter((v) => v.templateId === t.id).length + 1;
    // Service role rule: own = sent roles that differ from the base roles (not sent = previous own carried).
    const prev = versions.find((v) => v.templateId === t.id && v.versionNo === t.latestVersionNo);
    const own = def.roleFormats !== undefined ? ownRoles(def.roleFormats as Record<string, unknown>, pv.roleFormats) : ownRoles(prev?.roleFormats, pv.roleFormats);
    versions.push({ id: `${t.id}-v${versionNo}`, templateId: t.id, versionNo, baseVersionId: pv.id, resolvedParams: { ...pv.resolvedParams, ...layer }, overrides: layer, roleFormats: { ...(pv.roleFormats ?? {}), ...own }, skeletonSha256: skeletonSha256(validateSkeleton(def.skeleton)), paramsSha256: `p-${t.id}-${versionNo}` });
    t.latestVersionNo = versionNo;
    t.updatedAt = new Date(T0.getTime() + ++seq * 1000);
  };
  world.current = {
    onCreate: (input) => {
      writes.push(`create:${String(input.slug)}`);
      const t: FT = { id: `t-${String(input.slug)}`, slug: String(input.slug), isPreset: input.isPreset === true, latestVersionNo: 0, contractKind: null, archived: false, kind: String(input.kind), updatedAt: T0 };
      templates.push(t);
      writeVersion(t, input.template as StudioTemplateV2);
    },
    onVersion: (templateId, input) => {
      const t = templates.find((x) => x.id === templateId);
      if (!t) throw new Error('stub: templat tidak ada');
      writes.push(`version:${t.slug}`);
      writeVersion(t, input.template as StudioTemplateV2);
    },
  };
  const tx = {
    writes,
    templates,
    versions,
    studioTemplate: {
      findUnique: async ({ where }: { where: { slug: string } }) => templates.find((t) => t.slug === where.slug) ?? null,
      findUniqueOrThrow: async ({ where }: { where: { slug: string } }) => {
        const t = templates.find((x) => x.slug === where.slug);
        if (!t) throw new Error(`no template ${where.slug}`);
        return t;
      },
      count: async () => templates.length,
    },
    studioTemplateVersion: {
      findUniqueOrThrow: async ({ where }: { where: { templateId_versionNo: { templateId: string; versionNo: number } } }) => {
        const k = where.templateId_versionNo;
        const v = versions.find((x) => x.templateId === k.templateId && x.versionNo === k.versionNo);
        if (!v) throw new Error('no version');
        return v;
      },
    },
    studioSectionType: {
      findMany: async () => [{ key: 'cover', updatedAt: T0 }],
      count: async () => 52,
    },
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('?');
      if (sql.includes('current_database')) return [{ db: opts.database ?? 'gsp_agent_hq_v21' }];
      const exclude = (values[0] as string[] | undefined) ?? [];
      return templates
        .filter((t) => !exclude.includes(t.slug))
        .sort((a, b) => a.slug.localeCompare(b.slug))
        .map((t) => {
          const v = versions.find((x) => x.templateId === t.id && x.versionNo === t.latestVersionNo);
          return { slug: t.slug, latestVersionNo: t.latestVersionNo, updatedAt: t.updatedAt, contractKind: t.contractKind, versions: BigInt(versions.filter((x) => x.templateId === t.id).length), paramsSha256: v?.paramsSha256 ?? null, skeletonSha256: v?.skeletonSha256 ?? null };
        });
    },
  };
  return tx;
}

beforeEach(() => {
  calls.create.length = 0;
  calls.version.length = 0;
  world.current = null;
});

// row42 SKIP P3 "Prisma (row 109 cut)": the cases marked it.skip below run the seed helpers (prisma/seed-studio-templates.ts,
// build-time input of the row 110 export only, spec §1.1) against an in-memory Prisma tx stub and the Prisma template
// service; Swarm's services/templates is the row 66 TemplateSource twin over the store.
describe('C21 ensureDerivedPreset', () => {
  it.skip('DB tanpa preset Rev A: dibuat isPreset, basis = versi TERBARU datum-gsp-preset, pemanggil ADMIN, sematan di lapis', async () => {
    const tx = makeWorld({ gspLatest: 3 });
    const r = await ensureDerivedPreset(tx as never, revA());
    expect(calls.create).toHaveLength(1);
    const { input, caller } = calls.create[0];
    expect(input.slug).toBe(REV_A_SLUG);
    expect(input.isPreset).toBe(true);
    expect((input.template as StudioTemplateV2).preset).toEqual({ slug: 'datum-gsp-preset', version: 3 });
    const tpl = input.template as StudioTemplateV2;
    expect({ ...tpl.essentials, ...(tpl.advanced ?? {}) }).toEqual(REGISTER_PINS);
    expect(caller.kind).toBe('ADMIN_SESSION');
    expect(r.outcome).toBe('created');
    expect(r.storedOk).toBe(true);
    expect(r.storedIssues).toEqual([]);
    expect(r.base).toEqual({ slug: 'datum-gsp-preset', versionNo: 3, versionId: 'gsp-v3' });
    expect(r.pins).toEqual(REGISTER_PINS);
    expect(r.basePins).toEqual(GSP_PRESET_PINS);
  });

  it.skip('jalan ulang tanpa perubahan = unchanged, 0 tulis', async () => {
    const tx = makeWorld();
    await ensureDerivedPreset(tx as never, revA());
    const before = tx.writes.length;
    const r = await ensureDerivedPreset(tx as never, revA());
    expect(r.outcome).toBe('unchanged');
    expect(r.storedOk).toBe(true);
    expect(tx.writes.length).toBe(before);
  });

  it.skip('versi datum-gsp-preset baru = versi baru preset Rev A di atas versi terbaru itu', async () => {
    const tx = makeWorld();
    await ensureDerivedPreset(tx as never, revA());
    const gsp = tx.templates.find((t) => t.slug === 'datum-gsp-preset')!;
    tx.versions.push({ ...tx.versions.find((v) => v.id === 'gsp-v2')!, id: 'gsp-v3', versionNo: 3 });
    gsp.latestVersionNo = 3;
    const r = await ensureDerivedPreset(tx as never, revA());
    expect(r.outcome).toBe('new-version');
    expect((calls.version[0].input.template as StudioTemplateV2).preset).toEqual({ slug: 'datum-gsp-preset', version: 3 });
    expect(calls.version[0].caller.kind).toBe('ADMIN_SESSION');
    expect(r.base.versionId).toBe('gsp-v3');
    expect(r.storedOk).toBe(true);
  });

  it('basis tidak ada / bukan preset, slug dipakai templat non-preset, atau sematan tidak sah = galat sebelum tulis', async () => {
    const spec = revA();
    await expect(ensureDerivedPreset(makeWorld() as never, { ...spec, baseSlug: 'tidak-ada' })).rejects.toThrow(/Preset dasar tidak-ada tidak ada atau bukan preset/);
    await expect(ensureDerivedPreset(makeWorld() as never, { ...spec, baseSlug: 'datum-gsp' })).rejects.toThrow(/bukan preset/);
    await expect(ensureDerivedPreset(makeWorld() as never, { ...spec, slug: 'datum-gsp' })).rejects.toThrow(/non-preset/);
    await expect(ensureDerivedPreset(makeWorld() as never, { ...spec, pins: { 'tidak.ada.kunci': 1 } })).rejects.toThrow(/tidak dikenal/);
    await expect(ensureDerivedPreset(makeWorld() as never, { ...spec, pins: { 'type.scale.tableNumerals.size': 'besar' } })).rejects.toThrow(/tidak sah/);
    await expect(ensureDerivedPreset(makeWorld() as never, { ...spec, pins: {} })).rejects.toThrow(/tanpa sematan/);
    await expect(ensureDerivedPreset(makeWorld() as never, { ...spec, slug: spec.baseSlug })).rejects.toThrow(/basisnya sendiri/);
    expect(calls.create).toHaveLength(0);
    expect(calls.version).toHaveLength(0);
  });

  it.skip('sematan tidak bertahan di nilai efektif tersimpan = storedOk false (temuan pins)', async () => {
    const tx = makeWorld();
    await ensureDerivedPreset(tx as never, revA());
    const v = tx.versions.find((x) => x.templateId === `t-${REV_A_SLUG}`)!;
    v.resolvedParams = { ...v.resolvedParams, 'type.scale.tableNumerals.size': 7 };
    const r = await ensureDerivedPreset(tx as never, revA());
    expect(r.storedOk).toBe(false);
    expect(r.storedIssues).toContain('pins');
  });
});

// ── Runner berpenjaga dengan sasaran preset ──────────────────────────────

function collectLog(): { log: SeedLog; rows: Array<{ level: string; message: string; context: Record<string, unknown> }> } {
  const rows: Array<{ level: string; message: string; context: Record<string, unknown> }> = [];
  return { rows, log: (level, message, context = {}) => rows.push({ level, message, context }) };
}

function client(tx: ReturnType<typeof makeWorld>): Parameters<typeof runGuardedTemplateTx>[0] {
  return { $transaction: async <T>(fn: (t: never) => Promise<T>) => fn(tx as never) } as never;
}

const UNTOUCHED = async (): Promise<SectionTypeSeedResult> => ({ registry: 52, created: [], updated: [], unchanged: 52 });
const TEMPLATE_SPEC: DerivedTemplateSpec = {
  slug: 'uji-templat',
  name: 'Uji',
  description: 'Uji',
  presetSlug: 'datum-gsp-preset',
  slots: DATUM_SKELETON_SLOTS,
  layer: {},
  contractKind: null,
  changeNote: () => 'uji',
};
const templateReport = (s: DerivedTemplateSpec): DerivedTemplateReport => ({ slug: s.slug, outcome: 'unchanged', storedOk: true, storedIssues: [], contractKind: null, versionNo: 1, ch06Issues: 0 });
const BASE_OPTS = {
  label: 'Templat uji',
  guardFailMessage: 'Penjaga uji gagal',
  dryRunDoneMessage: 'Dry-run uji selesai',
  database: 'gsp_agent_hq_v21',
  freezeSectionTypes: true,
  specs: [TEMPLATE_SPEC],
  build: async (_tx: unknown, s: DerivedTemplateSpec) => templateReport(s),
  counts: async () => ({ templates: 0 }),
};

// row42 SKIP P3 "Prisma (row 109 cut)": the cases marked it.skip below run the seed helpers (prisma/seed-studio-templates.ts,
// build-time input of the row 110 export only, spec §1.1) against an in-memory Prisma tx stub and the Prisma template
// service; Swarm's services/templates is the row 66 TemplateSource twin over the store.
describe('C21 runGuardedTemplateTx dengan sasaran preset', () => {
  it.skip('dry-run: preset dibuat SEBELUM templat, templat lain tidak berubah, penjaga ok, rencana dilaporkan, rollback', async () => {
    const tx = makeWorld();
    const order: string[] = [];
    const { log, rows } = collectLog();
    const plan = await runGuardedTemplateTx(
      client(tx),
      {
        ...BASE_OPTS,
        dryRun: true,
        presets: DERIVED_PRESET_SPECS,
        buildPreset: async (t, s) => {
          order.push(`preset:${s.slug}`);
          return ensureDerivedPreset(t, s);
        },
        build: async (_t, s) => {
          order.push(`templat:${s.slug}`);
          return templateReport(s);
        },
      },
      { log, seedSectionTypes: UNTOUCHED },
    );
    expect(order).toEqual([`preset:${REV_A_SLUG}`, 'templat:uji-templat']);
    expect(plan.guardOk).toBe(true);
    expect(plan.presets).toEqual([{ slug: REV_A_SLUG, outcome: 'created', versionNo: 1, base: { slug: 'datum-gsp-preset', versionNo: 2 } }]);
    expect(plan.templates).toEqual([{ slug: 'uji-templat', outcome: 'unchanged', versionNo: 1, contractKind: null }]);
    const report = rows.find((r) => r.message === 'Templat uji')!;
    const guard = report.context.guard as Record<string, unknown>;
    expect(guard.ok).toBe(true);
    expect(guard.changedTemplates).toEqual([]);
    expect(guard.addedTemplates).toEqual([]);
    expect(guard.targets).toEqual([REV_A_SLUG, 'uji-templat']);
    expect(guard.otherTemplates).toBe(3);
    // Laporan templat (dibaca uji-run.mjs C24) tetap hanya templat; preset di medan sendiri.
    expect((report.context.templates as Array<{ slug: string }>).map((t) => t.slug)).toEqual(['uji-templat']);
    expect((report.context.presets as DerivedPresetReport[]).map((p) => p.slug)).toEqual([REV_A_SLUG]);
    expect(rows.at(-1)?.message).toBe('Dry-run uji selesai');
  });

  it.skip('penjaga MERAH bila templat lain (mis. datum-gsp-preset, basis preset) berubah di dalam transaksi', async () => {
    const tx = makeWorld();
    const { log, rows } = collectLog();
    const build = async (_t: unknown, s: DerivedTemplateSpec) => {
      const gsp = tx.templates.find((t) => t.slug === 'datum-gsp-preset')!;
      gsp.updatedAt = new Date('2026-02-02T00:00:00Z');
      return templateReport(s);
    };
    await expect(runGuardedTemplateTx(client(tx), { ...BASE_OPTS, dryRun: true, presets: DERIVED_PRESET_SPECS, build }, { log, seedSectionTypes: UNTOUCHED })).rejects.toThrow('Penjaga uji gagal');
    const guard = rows[0].context.guard as Record<string, unknown>;
    expect(rows[0].level).toBe('error');
    expect(guard.changedTemplates).toEqual(['datum-gsp-preset']);
  });

  it.skip('penjaga MERAH bila preset ditulis tanpa terdaftar sebagai sasaran (addedTemplates)', async () => {
    const tx = makeWorld();
    const { log, rows } = collectLog();
    const build = async (t: unknown, s: DerivedTemplateSpec) => {
      await ensureDerivedPreset(t as never, revA());
      return templateReport(s);
    };
    await expect(runGuardedTemplateTx(client(tx), { ...BASE_OPTS, dryRun: true, build }, { log, seedSectionTypes: UNTOUCHED })).rejects.toThrow('Penjaga uji gagal');
    expect((rows[0].context.guard as Record<string, unknown>).addedTemplates).toEqual([REV_A_SLUG]);
  });

  it.skip('penjaga MERAH bila isi tersimpan preset tidak sesuai (storedOk false)', async () => {
    const tx = makeWorld();
    const { log } = collectLog();
    const buildPreset = async (t: unknown, s: DerivedPresetSpec) => ({ ...(await ensureDerivedPreset(t as never, s)), storedOk: false, storedIssues: ['pins' as const] });
    await expect(runGuardedTemplateTx(client(tx), { ...BASE_OPTS, dryRun: true, presets: DERIVED_PRESET_SPECS, buildPreset }, { log, seedSectionTypes: UNTOUCHED })).rejects.toThrow('Penjaga uji gagal');
  });

  it.skip('section type dibekukan tetap berlaku dengan sasaran preset', async () => {
    const tx = makeWorld();
    const { log } = collectLog();
    const touching = async (): Promise<SectionTypeSeedResult> => ({ registry: 52, created: ['baru'], updated: [], unchanged: 51 });
    await expect(runGuardedTemplateTx(client(tx), { ...BASE_OPTS, dryRun: true, presets: DERIVED_PRESET_SPECS }, { log, seedSectionTypes: touching })).rejects.toThrow('Penjaga uji gagal');
  });

  it('slug sasaran ganda (preset = templat) = galat sebelum tulis', async () => {
    const tx = makeWorld();
    const { log } = collectLog();
    await expect(
      runGuardedTemplateTx(client(tx), { ...BASE_OPTS, dryRun: true, presets: DERIVED_PRESET_SPECS, specs: [{ ...TEMPLATE_SPEC, slug: REV_A_SLUG }] }, { log, seedSectionTypes: UNTOUCHED }),
    ).rejects.toThrow(/sasaran ganda/);
    expect(tx.writes).toEqual([]);
  });

  it('tanpa opsi presets: ringkasan tanpa medan presets (perilaku jalur kontrak/S27 tetap)', async () => {
    const tx = makeWorld();
    const { log } = collectLog();
    const plan = await runGuardedTemplateTx(client(tx), { ...BASE_OPTS, dryRun: true }, { log, seedSectionTypes: UNTOUCHED });
    expect(plan).toEqual({ sectionTypes: { create: [], update: [], unchanged: 52 }, templates: [{ slug: 'uji-templat', outcome: 'unchanged', versionNo: 1, contractKind: null }], counts: { templates: 0 }, guardOk: true });
    expect('presets' in plan).toBe(false);
  });
});

// ── Penjaga lebar tabel G1-G3 pada numeral 7,8 pt (render.ts:188) ─────────

describe('C21 penjaga lebar tabel G1-G3 dengan numeral 7,8 pt', () => {
  const cell = (text: string) => ({ text });
  const table: TableBlock = {
    type: 'table',
    columns: [{ align: 'left' }, { align: 'left' }, { align: 'right', role: 'numeral' }, { align: 'right', role: 'numeral' }],
    rows: [
      { kind: 'header', cells: [cell('No'), cell('Uraian'), cell('Volume'), cell('Jumlah (Rp)')] },
      { cells: [cell('1'), cell('Pekerjaan persiapan dan mobilisasi peralatan'), cell('1.250'), cell('335.029.109.47')] },
      { cells: [cell('2'), cell('Pekerjaan struktur beton bertulang lantai dasar'), cell('12.480.500'), cell('1.204.775.300.00')] },
    ],
  } as unknown as TableBlock;
  const matrix = table.rows.map((r) => r.cells.map((c) => (c as { text: string }).text));

  it('G1, G2, G3 (+G4) PASS pada lebar kolom teks dan rentang penuh dengan numeral 7,8 pt', () => {
    for (const totalMm of [128, 166]) {
      const issues = tableGuards(table, { totalMm, numeralsPt: 7.8 });
      expect(issues.filter((i) => i.status === 'FAIL'), `total ${totalMm}`).toEqual([]);
      expect(issues.map((i) => i.checkId).sort()).toEqual(['G1', 'G2', 'G3']);
    }
  });

  it('7,8 pt = ukuran yang dipakai penjaga untuk lebar solver, jadi lebar render dan lebar penjaga sama', () => {
    for (const totalMm of [128, 166]) expect(solveWidthsImpl(matrix, totalMm, 7.8)).toEqual(solveWidthsImpl(matrix, totalMm));
  });

  it('lantai G4 per kolom angka terpenuhi oleh lebar solver pada 7,8 pt', () => {
    const w = solveWidthsImpl(matrix, 128, 7.8);
    const emMm = (7.8 / 72) * 25.4;
    expect(w[3]).toBeGreaterThanOrEqual('1.204.775.300.00'.length * 0.6 * emMm + 2);
    expect(w[2]).toBeGreaterThanOrEqual('12.480.500'.length * 0.6 * emMm + 2);
  });
});

// ── 0 cabang slug (grep sumber) ──────────────────────────────────────────

describe('C21 0 cabang slug', () => {
  const src = (rel: string) => readFileSync(path.join(REPO, rel), 'utf8');

  it('slug preset Rev A hanya ada di tabel spec (sekali), tidak di seed-studio.ts maupun helper', () => {
    expect(src('prisma/seed-derived-presets.ts').split(`"${REV_A_SLUG}"`).length - 1).toBe(1);
    for (const rel of ['prisma/seed-studio.ts', 'prisma/seed-studio-templates.ts']) expect(src(rel).includes(REV_A_SLUG), rel).toBe(false);
  });

  it('helper dan tabel spec tanpa cabang slug', () => {
    for (const rel of ['prisma/seed-derived-presets.ts', 'prisma/seed-studio-templates.ts']) {
      expect(src(rel), rel).not.toMatch(/slug\s*===\s*["']|baseSlug\s*===\s*["']|switch\s*\(/);
    }
  });
});
