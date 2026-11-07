// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/seed/s09-seed-template-helpers.test.ts (see test/ported/README.md).
import { seedModule, useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
/**
 * S09 (blueprint 02_structured_datum_rev_a.md; research/33 C-01..C-06; D-595): helper bersama seed
 * templat turunan-preset di `prisma/seed-studio-templates.ts`, diekstrak dari jalur `--contract-templates`.
 *
 * Seam: fungsi ekspor modul helper (dipanggil `prisma/seed-studio.ts`). DB diganti stub dalam memori
 * yang hanya menjawab kueri yang dipakai helper; tidak ada koneksi DB.
 */
import { describe, expect, it } from '../_vitest';
import { CONTENT_BLOCK_TYPES, type TemplateSlotDef } from '@/lib/studio/contract';
import { canonicalVersionPayload, type ParamRecord } from '@/lib/studio/services/templates';
import { skeletonSha256, validateSkeleton } from '@/lib/studio/services/skeleton';
const { derivedTemplatePlan, derivedTemplateStoredIssues, ensureDerivedTemplate, presetSlotEssentials, runGuardedTemplateTx } = (await import(seedModule('seed-studio-templates'))) as any; // row42 W14

type SlotShape = Omit<TemplateSlotDef, 'essentials'>;

const COVER: SlotShape = { slotKey: 'cover', sectionType: 'cover', label: 'Sampul', position: 1, required: true, positionLocked: true, repeatable: false, contentMode: 'MIXED', tiers: ['TERBIT', 'SERAH'], admits: [] };
const CONTENT: SlotShape = { slotKey: 'content', sectionType: 'chapter', label: 'Isi', position: 2, required: true, positionLocked: false, repeatable: true, minItems: 1, contentMode: 'INPUT', tiers: [], admits: [...CONTENT_BLOCK_TYPES] };
const RECORD: SlotShape = { slotKey: 'record', sectionType: 'contractRecord', label: 'Catatan Laporan', position: 1, required: true, positionLocked: true, repeatable: false, contentMode: 'INPUT', tiers: [], admits: [] };

/** Nilai efektif registri bawaan: sumber nilai kenop yang sah untuk semua kunci. */
const EFFECTIVE = canonicalVersionPayload().resolvedParams as ParamRecord;

describe('S09 presetSlotEssentials', () => {
  it('membaca kenop slot dari nilai efektif preset (cover.kicker.text ikut lingkup cover)', () => {
    const { slots, skipped } = presetSlotEssentials([COVER, CONTENT], EFFECTIVE);
    expect(slots.map((s) => s.slotKey)).toEqual(['cover', 'content']);
    expect(slots[0].essentials['cover.kicker.text']).toEqual(EFFECTIVE['cover.kicker.text']);
    expect(Object.keys(slots[1].essentials)).not.toContain('cover.kicker.text');
    expect(skipped).toEqual({});
  });

  it('tanpa nilai efektif (kerangka preset) = esensial kosong; larik disalin, bukan dibagi', () => {
    const { slots } = presetSlotEssentials([COVER, CONTENT], null);
    expect(slots.map((s) => s.essentials)).toEqual([{}, {}]);
    expect(slots[1].admits).toEqual(CONTENT.admits);
    expect(slots[1].admits).not.toBe(CONTENT.admits);
    expect(slots[0].tiers).not.toBe(COVER.tiers);
  });

  it('override per slot menimpa nilai preset hanya di slot itu', () => {
    const { slots } = presetSlotEssentials([COVER, CONTENT], EFFECTIVE, { cover: { 'cover.kicker.text': 'LAPORAN' } });
    expect(slots[0].essentials['cover.kicker.text']).toBe('LAPORAN');
    expect(slots[1].essentials['cover.kicker.text']).toBeUndefined();
  });

  it('override di luar lingkup slot, kunci tak dikenal, atau slot tak ada = galat', () => {
    expect(() => presetSlotEssentials([COVER, CONTENT], EFFECTIVE, { content: { 'cover.kicker.text': 'X' } })).toThrow(/lingkup/);
    expect(() => presetSlotEssentials([COVER], EFFECTIVE, { cover: { 'tidak.ada.kunci': 'X' } })).toThrow(/tidak dikenal/);
    expect(() => presetSlotEssentials([COVER], EFFECTIVE, { appendices: { 'cover.kicker.text': 'X' } })).toThrow(/slot/);
  });
});

// ── Cek baris tersimpan generik (C-06 + AC-2) ─────────────────────────────

const LAYER: ParamRecord = { 'doc.defaultTier': 'NOTA', 'doc.defaultTypeCode': 'LAP' };
function storedInput(over: Partial<Parameters<typeof derivedTemplateStoredIssues>[0]> = {}): Parameters<typeof derivedTemplateStoredIssues>[0] {
  return {
    template: { contractKind: null, archived: false },
    version: { skeletonSha256: 'sk1', baseVersionId: 'preset-v2', resolvedParams: { ...LAYER } },
    computedSkeletonSha256: 'sk1',
    storedSlots: [{ slotKey: 'cover', sectionTypeKey: 'cover', position: 1 }, { slotKey: 'content', sectionTypeKey: 'chapter', position: 2 }],
    specSlots: [COVER, CONTENT],
    layer: LAYER,
    contractKind: null,
    presetVersionId: 'preset-v2',
    ...over,
  };
}

describe('S09 derivedTemplateStoredIssues', () => {
  it('baris sesuai spec = tanpa temuan (contractKind null === null)', () => {
    expect(derivedTemplateStoredIssues(storedInput())).toEqual([]);
  });

  it('contractKind dibandingkan dari data (null lawan nilai, nilai lawan nilai)', () => {
    expect(derivedTemplateStoredIssues(storedInput({ template: { contractKind: 'agentWorkReport', archived: false } }))).toEqual(['contractKind']);
    expect(derivedTemplateStoredIssues(storedInput({ template: { contractKind: 'agentWorkReport', archived: false }, contractKind: 'agentWorkReport' }))).toEqual([]);
  });

  it('AC-2: templat terbatas, terarsip, atau basis bukan versi preset terbaru = temuan', () => {
    expect(derivedTemplateStoredIssues(storedInput({ template: { contractKind: null, archived: true } }))).toEqual(['archived']);
    expect(derivedTemplateStoredIssues(storedInput({ version: { skeletonSha256: 'sk1', baseVersionId: 'preset-v1', resolvedParams: { ...LAYER } } }))).toEqual(['baseVersionId']);
    const restricted = { ...LAYER, 'lint.enforcementOverride': { 'DATUM-04': 'report' } };
    expect(derivedTemplateStoredIssues(storedInput({ version: { skeletonSha256: 'sk1', baseVersionId: 'preset-v2', resolvedParams: restricted } }))).toEqual(['restricted']);
  });

  it('sidik kerangka, slot, dan nilai lapis tersimpan diperiksa', () => {
    expect(derivedTemplateStoredIssues(storedInput({ computedSkeletonSha256: 'sk2' }))).toEqual(['skeletonSha256']);
    expect(derivedTemplateStoredIssues(storedInput({ storedSlots: [{ slotKey: 'cover', sectionTypeKey: 'cover', position: 1 }] }))).toEqual(['slots']);
    expect(derivedTemplateStoredIssues(storedInput({ version: { skeletonSha256: 'sk1', baseVersionId: 'preset-v2', resolvedParams: { ...LAYER, 'doc.defaultTier': 'TERBIT' } } }))).toEqual(['layer']);
  });
});

// ── Stub DB dalam memori ──────────────────────────────────────────────────

interface FakeTemplate { id: string; slug: string; isPreset: boolean; latestVersionNo: number; contractKind: string | null; archived: boolean; kind: string }
interface FakeVersion { id: string; templateId: string; versionNo: number; baseVersionId: string | null; resolvedParams: ParamRecord; overrides: ParamRecord; skeletonSha256: string | null; paramsSha256: string }

function fakeTx(templates: FakeTemplate[], versions: FakeVersion[], slots: Array<{ templateVersionId: string; slotKey: string; sectionTypeKey: string; position: number }>, database = 'gsp_agent_hq_v21') {
  const writes: string[] = [];
  const tx = {
    writes,
    studioTemplate: {
      findUnique: async ({ where }: { where: { slug: string } }) => templates.find((t) => t.slug === where.slug) ?? null,
      findUniqueOrThrow: async ({ where }: { where: { slug: string } }) => {
        const t = templates.find((x) => x.slug === where.slug);
        if (!t) throw new Error(`no template ${where.slug}`);
        return t;
      },
      count: async () => templates.length,
      create: async () => { writes.push('studioTemplate.create'); throw new Error('stub: tulis tidak diharapkan'); },
    },
    studioTemplateVersion: {
      findUniqueOrThrow: async ({ where }: { where: { templateId_versionNo: { templateId: string; versionNo: number } } }) => {
        const k = where.templateId_versionNo;
        const v = versions.find((x) => x.templateId === k.templateId && x.versionNo === k.versionNo);
        if (!v) throw new Error('no version');
        return v;
      },
    },
    studioTemplateSlot: {
      findMany: async ({ where }: { where: { templateVersionId: string } }) =>
        slots.filter((s) => s.templateVersionId === where.templateVersionId).map((s) => ({ ...s, required: true, repeatable: false, positionLocked: false, minItems: null, contentMode: 'INPUT', tiers: [], admits: [] })),
    },
    studioSectionType: {
      findMany: async () => [{ key: 'cover', updatedAt: new Date('2026-01-01T00:00:00Z') }],
    },
    $queryRaw: async (strings: TemplateStringsArray) => {
      const sql = strings.join('?');
      if (sql.includes('current_database')) return [{ db: database }];
      return templates.map((t) => ({ slug: t.slug, latestVersionNo: t.latestVersionNo, updatedAt: new Date('2026-01-01T00:00:00Z'), contractKind: t.contractKind, versions: BigInt(1), paramsSha256: 'p', skeletonSha256: 's' }));
    },
  };
  return tx;
}

/** Templat turunan yang sudah tersimpan persis seperti spec (jalur `unchanged`). */
async function seededWorld(spec: DerivedTemplateSpec) {
  const preset: FakeTemplate = { id: 'tp', slug: spec.presetSlug, isPreset: true, latestVersionNo: 2, contractKind: null, archived: false, kind: 'DOCUMENT' };
  const presetV: FakeVersion = { id: 'preset-v2', templateId: 'tp', versionNo: 2, baseVersionId: null, resolvedParams: EFFECTIVE, overrides: {}, skeletonSha256: 'x', paramsSha256: 'pp' };
  // Dunia "sudah ter-seed": baris versi memuat lapis dan sidik kerangka rencana helper (stub tidak menulis).
  const plan = derivedTemplatePlan(spec, EFFECTIVE);
  const t: FakeTemplate = { id: 'tt', slug: spec.slug, isPreset: false, latestVersionNo: 1, contractKind: spec.contractKind, archived: false, kind: 'DOCUMENT' };
  const v: FakeVersion = { id: 'tt-v1', templateId: 'tt', versionNo: 1, baseVersionId: 'preset-v2', resolvedParams: { ...EFFECTIVE, ...spec.layer }, overrides: plan.overrides, skeletonSha256: skeletonSha256(validateSkeleton({ slots: plan.slots })), paramsSha256: 'tp1' };
  const slotRows = spec.slots.map((s) => ({ templateVersionId: 'tt-v1', slotKey: s.slotKey, sectionTypeKey: s.sectionType, position: s.position }));
  return fakeTx([preset, t], [presetV, v], slotRows);
}

const NOTE = () => 'uji';

describe('S09 ensureDerivedTemplate', () => {
  it('templat tanpa contractKind: tanpa CH-06, unchanged, storedOk, 0 tulis', async () => {
    const spec: DerivedTemplateSpec = { slug: 'uji-turunan', name: 'Uji', description: 'Uji', presetSlug: 'datum-gsp-preset', slots: [COVER, CONTENT], layer: LAYER, contractKind: null, changeNote: NOTE };
    const tx = await seededWorld(spec);
    const r = await ensureDerivedTemplate(tx as never, spec);
    expect(r.outcome).toBe('unchanged');
    expect(r.storedOk).toBe(true);
    expect(r.storedIssues).toEqual([]);
    expect(r.ch06Issues).toBe(0);
    expect(r.contractKind).toBeNull();
    expect(tx.writes).toEqual([]);
  });

  it('CH-06 dijalankan karena contractKind terisi (data), bukan karena slug', async () => {
    // Slug templat dokumen biasa, tetapi spec membawa contractKind: slot record berulang ditolak CH-06 sebelum tulis.
    const spec: DerivedTemplateSpec = {
      slug: 'uji-turunan',
      name: 'Uji',
      description: 'Uji',
      presetSlug: 'datum-gsp-preset',
      slots: [{ ...RECORD, repeatable: true }, { ...CONTENT, position: 2 }],
      layer: LAYER,
      contractKind: 'agentWorkReport',
      changeNote: NOTE,
    };
    const tx = await seededWorld({ ...spec, slots: [RECORD, { ...CONTENT, position: 2 }] });
    await expect(ensureDerivedTemplate(tx as never, spec)).rejects.toThrow(/CH-06 uji-turunan: .*repeatable = false/);
    expect(tx.writes).toEqual([]);
  });

  it('kerangka kontrak yang sah lolos CH-06 dengan slug apa pun', async () => {
    const spec: DerivedTemplateSpec = {
      slug: 'slug-bebas',
      name: 'Uji',
      description: 'Uji',
      presetSlug: 'datum-gsp-preset',
      slots: [RECORD, { ...CONTENT, position: 2 }],
      layer: LAYER,
      contractKind: 'agentWorkReport',
      changeNote: NOTE,
    };
    const tx = await seededWorld(spec);
    const r = await ensureDerivedTemplate(tx as never, spec);
    expect(r.ch06Issues).toBe(0);
    expect(r.storedOk).toBe(true);
    expect(r.contractKind).toBe('agentWorkReport');
  });

  it('preset tidak ada = galat jelas', async () => {
    const spec: DerivedTemplateSpec = { slug: 'uji', name: 'Uji', description: 'Uji', presetSlug: 'tidak-ada-preset', slots: [COVER], layer: LAYER, contractKind: null, changeNote: NOTE };
    await expect(ensureDerivedTemplate(fakeTx([], [], []) as never, spec)).rejects.toThrow(/Preset tidak-ada-preset tidak ada/);
  });
});

// ── Runner transaksi berpenjaga (C-04) ────────────────────────────────────

function collectLog(): { log: SeedLog; rows: Array<{ level: string; message: string; context: Record<string, unknown> }> } {
  const rows: Array<{ level: string; message: string; context: Record<string, unknown> }> = [];
  return { rows, log: (level, message, context = {}) => rows.push({ level, message, context }) };
}

function fakeClient(tx: ReturnType<typeof fakeTx>): Parameters<typeof runGuardedTemplateTx>[0] {
  return { $transaction: async <T>(fn: (t: never) => Promise<T>) => fn(tx as never) } as never;
}

const SECTION_TYPES = async () => ({ registry: 52, created: [] as string[], updated: [] as string[], unchanged: 52 });

describe('S09 runGuardedTemplateTx', () => {
  const spec: DerivedTemplateSpec = { slug: 'uji-turunan', name: 'Uji', description: 'Uji', presetSlug: 'datum-gsp-preset', slots: [COVER, CONTENT], layer: LAYER, contractKind: null, changeNote: NOTE };
  const base = {
    label: 'Templat uji',
    guardFailMessage: 'Penjaga uji gagal',
    dryRunDoneMessage: 'Dry-run uji selesai',
    specs: [spec],
    build: (t: Tx, s: DerivedTemplateSpec) => ensureDerivedTemplate(t, s),
    counts: async () => ({ templates: 2 }),
  };

  it('dry-run: penjaga dihitung, transaksi di-rollback lewat sinyal, rencana dilaporkan, 0 tulis', async () => {
    const tx = await seededWorld(spec);
    const { log, rows } = collectLog();
    const plan = await runGuardedTemplateTx(fakeClient(tx), { ...base, database: 'gsp_agent_hq_v21', dryRun: true }, { log, seedSectionTypes: SECTION_TYPES });
    expect(plan).toEqual({
      sectionTypes: { create: [], update: [], unchanged: 52 },
      templates: [{ slug: 'uji-turunan', outcome: 'unchanged', versionNo: 1, contractKind: null }],
      counts: { templates: 2 },
      guardOk: true,
    });
    expect(rows.map((r) => [r.level, r.message])).toEqual([
      ['info', 'Templat uji'],
      ['info', 'Dry-run uji selesai'],
    ]);
    expect(tx.writes).toEqual([]);
  });

  it('DB transaksi berbeda dari DB yang diperiksa = galat sebelum apa pun', async () => {
    const tx = await seededWorld(spec);
    const { log } = collectLog();
    await expect(runGuardedTemplateTx(fakeClient(tx), { ...base, database: 'gsp_agent_hq', dryRun: true }, { log, seedSectionTypes: SECTION_TYPES })).rejects.toThrow(
      /DB transaksi 'gsp_agent_hq_v21' berbeda dari DB yang diperiksa 'gsp_agent_hq'/,
    );
  });

  it('isi tersimpan tidak sesuai (AC-2) = penjaga gagal, galat (rollback), log error', async () => {
    const tx = await seededWorld(spec);
    (tx.studioTemplate as unknown as { findUniqueOrThrow: unknown }).findUniqueOrThrow = async ({ where }: { where: { slug: string } }) => ({
      id: where.slug === spec.slug ? 'tt' : 'tp',
      slug: where.slug,
      isPreset: where.slug !== spec.slug,
      latestVersionNo: where.slug === spec.slug ? 1 : 2,
      contractKind: null,
      archived: where.slug === spec.slug,
      kind: 'DOCUMENT',
    });
    const { log, rows } = collectLog();
    await expect(runGuardedTemplateTx(fakeClient(tx), { ...base, database: 'gsp_agent_hq_v21', dryRun: true }, { log, seedSectionTypes: SECTION_TYPES })).rejects.toThrow('Penjaga uji gagal');
    expect(rows[0].level).toBe('error');
  });
});
