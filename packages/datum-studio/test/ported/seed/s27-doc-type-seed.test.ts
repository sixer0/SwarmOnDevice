// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/seed/s27-doc-type-seed.test.ts (see test/ported/README.md).
import { seedModule, useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
/**
 * S27 (blueprint 02_structured_datum_rev_a.md; AC-1, AC-2; D-595): flag seed `--doc-type-templates`.
 *
 * Seam: opsi runner `docTypeTemplateTxOptions` (dipakai `prisma/seed-studio.ts` apa adanya) + runner bersama
 * `runGuardedTemplateTx` + `ensureDerivedTemplate` (CH-06 tanpa syarat, keputusan S09 needs-review butir 1).
 * DB diganti stub dalam memori; tidak ada koneksi DB. Tambahan: pemeriksaan sumber "0 kode per slug".
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from '../_vitest';
import { CONTENT_BLOCK_TYPES } from '@/lib/studio/contract';
import { canonicalVersionPayload, type ParamRecord } from '@/lib/studio/services/templates';
const { ensureDerivedTemplate, runGuardedTemplateTx } = (await import(seedModule('seed-studio-templates'))) as any; // row42 W14
const { DOC_TYPE_LAYERS, DOC_TYPE_TEMPLATE_SPECS, docTypeTemplateTxOptions } = (await import(seedModule('seed-doc-type-templates'))) as any; // row42 W14

const REPO = path.resolve(__dirname, '..', '..', '..', 'vendor');
const EFFECTIVE = canonicalVersionPayload().resolvedParams as ParamRecord;

interface Row { slug: string; latestVersionNo: number; updatedAt: Date; contractKind: string | null; versions: bigint; paramsSha256: string; skeletonSha256: string }

/** Stub transaksi: snapshot templat lain dari `others` (dapat dimutasi `build`), section type tetap. */
function world(others: Row[], database = 'gsp_agent_hq_v21') {
  const writes: string[] = [];
  const sections = [{ key: 'cover', updatedAt: new Date('2026-01-01T00:00:00Z') }];
  const tx = {
    writes,
    others,
    sections,
    studioSectionType: { findMany: async () => sections.map((s) => ({ ...s })), count: async () => 52 },
    studioTemplate: { count: async () => others.length },
    $queryRaw: async (strings: TemplateStringsArray) => {
      const sql = strings.join('?');
      if (sql.includes('current_database')) return [{ db: database }];
      return others.map((r) => ({ ...r }));
    },
  };
  return tx;
}

const OTHERS = (): Row[] =>
  ['datum-gsp', 'datum-gsp-preset', 'laporan-kerja-agen'].map((slug) => ({ slug, latestVersionNo: 1, updatedAt: new Date('2026-01-01T00:00:00Z'), contractKind: null, versions: BigInt(1), paramsSha256: `p-${slug}`, skeletonSha256: `s-${slug}` }));

function client(tx: ReturnType<typeof world>): Parameters<typeof runGuardedTemplateTx>[0] {
  return { $transaction: async <T>(fn: (t: never) => Promise<T>) => fn(tx as never) } as never;
}

function collectLog(): { log: SeedLog; rows: Array<{ level: string; message: string; context: Record<string, unknown> }> } {
  const rows: Array<{ level: string; message: string; context: Record<string, unknown> }> = [];
  return { rows, log: (level, message, context = {}) => rows.push({ level, message, context }) };
}

const report = (s: DerivedTemplateSpec, outcome: DerivedTemplateReport['outcome']): DerivedTemplateReport => ({
  slug: s.slug,
  outcome,
  storedOk: true,
  storedIssues: [],
  contractKind: null,
  versionNo: 1,
  ch06Issues: 0,
});

const UNTOUCHED = async (): Promise<SectionTypeSeedResult> => ({ registry: 52, created: [], updated: [], unchanged: 52 });

describe('S27 --doc-type-templates: opsi runner', () => {
  it('opsi = tabel spec S26 apa adanya, section type dibekukan, DB yang diperiksa pemanggil', () => {
    const o = docTypeTemplateTxOptions('gsp_agent_hq_v21', true);
    expect(o.specs).toBe(DOC_TYPE_TEMPLATE_SPECS);
    expect(o.freezeSectionTypes).toBe(true);
    expect(o.database).toBe('gsp_agent_hq_v21');
    expect(o.dryRun).toBe(true);
    expect(o.build).toBeUndefined();
  });

  it('dry-run DB berisi: rencana 10 created, penjaga ok, 0 tulis, laporan dry-run', async () => {
    const tx = world(OTHERS());
    const { log, rows } = collectLog();
    const plan = await runGuardedTemplateTx(client(tx), { ...docTypeTemplateTxOptions('gsp_agent_hq_v21', true), build: async (_t, s) => report(s, 'created') }, { log, seedSectionTypes: UNTOUCHED });
    expect(plan.guardOk).toBe(true);
    expect(plan.templates.map((t) => t.outcome)).toEqual(Array(10).fill('created'));
    expect(plan.templates.map((t) => t.slug)).toEqual(DOC_TYPE_TEMPLATE_SPECS.map((s) => s.slug));
    expect(plan.sectionTypes).toEqual({ create: [], update: [], unchanged: 52 });
    expect(rows.map((r) => [r.level, r.message])).toEqual([
      ['info', 'Templat jenis dokumen DATUM Rev A'],
      ['info', 'Dry-run templat jenis dokumen selesai; transaksi di-rollback (0 tulis)'],
    ]);
    expect(tx.writes).toEqual([]);
  });

  it('jalan ulang tanpa perubahan: semua unchanged, penjaga ok', async () => {
    const tx = world(OTHERS());
    const { log } = collectLog();
    const plan = await runGuardedTemplateTx(client(tx), { ...docTypeTemplateTxOptions('gsp_agent_hq_v21', false), build: async (_t, s) => report(s, 'unchanged') }, { log, seedSectionTypes: UNTOUCHED });
    expect(plan.guardOk).toBe(true);
    expect(new Set(plan.templates.map((t) => t.outcome))).toEqual(new Set(['unchanged']));
  });

  it('penjaga MERAH bila templat lain berubah di dalam transaksi (rollback, log error)', async () => {
    const tx = world(OTHERS());
    const { log, rows } = collectLog();
    const build = async (_t: Tx, s: DerivedTemplateSpec) => {
      // Efek samping liar: templat lama datum-gsp mendapat versi baru.
      tx.others[0] = { ...tx.others[0], latestVersionNo: 2, paramsSha256: 'berubah' };
      return report(s, 'created');
    };
    await expect(runGuardedTemplateTx(client(tx), { ...docTypeTemplateTxOptions('gsp_agent_hq_v21', true), build }, { log, seedSectionTypes: UNTOUCHED })).rejects.toThrow(/Penjaga templat jenis dokumen gagal/);
    expect(rows[0].level).toBe('error');
    expect((rows[0].context.guard as { changedTemplates: string[] }).changedTemplates).toEqual(['datum-gsp']);
  });

  it('penjaga MERAH bila templat di luar tabel bertambah', async () => {
    const tx = world(OTHERS());
    const { log } = collectLog();
    const build = async (_t: Tx, s: DerivedTemplateSpec) => {
      if (!tx.others.some((r) => r.slug === 'templat-liar')) tx.others.push({ ...tx.others[0], slug: 'templat-liar' });
      return report(s, 'created');
    };
    await expect(runGuardedTemplateTx(client(tx), { ...docTypeTemplateTxOptions('gsp_agent_hq_v21', true), build }, { log, seedSectionTypes: UNTOUCHED })).rejects.toThrow(/Penjaga templat jenis dokumen gagal/);
  });

  it('section type dibekukan: seed section type yang menulis (create/update) = penjaga merah', async () => {
    const { log } = collectLog();
    const build = async (_t: Tx, s: DerivedTemplateSpec) => report(s, 'created');
    const touching = async (): Promise<SectionTypeSeedResult> => ({ registry: 52, created: ['baru'], updated: [], unchanged: 51 });
    await expect(runGuardedTemplateTx(client(world(OTHERS())), { ...docTypeTemplateTxOptions('gsp_agent_hq_v21', true), build }, { log, seedSectionTypes: touching })).rejects.toThrow(/Penjaga templat jenis dokumen gagal/);
    // Jalur kontrak (tanpa pembekuan) tetap menerima section type yang ditulis seed sendiri (perilaku S09).
    const plan = await runGuardedTemplateTx(client(world(OTHERS())), { ...docTypeTemplateTxOptions('gsp_agent_hq_v21', true), freezeSectionTypes: false, build }, { log, seedSectionTypes: touching });
    expect(plan.guardOk).toBe(true);
  });

  it('isi tersimpan tidak sesuai AC-2 (mis. restricted/basis) = penjaga merah', async () => {
    const { log } = collectLog();
    const build = async (_t: Tx, s: DerivedTemplateSpec) => ({ ...report(s, 'created'), storedOk: false, storedIssues: ['baseVersionId' as const] });
    await expect(runGuardedTemplateTx(client(world(OTHERS())), { ...docTypeTemplateTxOptions('gsp_agent_hq_v21', true), build }, { log, seedSectionTypes: UNTOUCHED })).rejects.toThrow(/Penjaga templat jenis dokumen gagal/);
  });

  it('DB transaksi berbeda dari DB yang diperiksa = galat sebelum apa pun', async () => {
    const { log } = collectLog();
    await expect(runGuardedTemplateTx(client(world(OTHERS(), 'gsp_agent_hq')), docTypeTemplateTxOptions('gsp_agent_hq_v21', true), { log, seedSectionTypes: UNTOUCHED })).rejects.toThrow(/DB transaksi 'gsp_agent_hq' berbeda/);
  });
});

describe('S27 CH-06 tanpa syarat (keputusan S09 needs-review butir 1)', () => {
  const record = { slotKey: 'record', sectionType: 'contractRecord', label: 'Catatan', position: 1, required: true, positionLocked: true, repeatable: false, contentMode: 'INPUT' as const, tiers: [], admits: [] };
  const content = { slotKey: 'content', sectionType: 'chapter', label: 'Isi', position: 2, required: true, positionLocked: false, repeatable: true, minItems: 1, contentMode: 'INPUT' as const, tiers: [], admits: [...CONTENT_BLOCK_TYPES] };

  it('spec non-kontrak yang memuat slot contractRecord gagal di seed sendiri sebelum tulis', async () => {
    const spec: DerivedTemplateSpec = { slug: 'uji-nonkontrak', name: 'Uji', description: 'Uji', presetSlug: 'datum-gsp-preset', slots: [record, content], layer: {}, contractKind: null, changeNote: () => 'uji' };
    const writes: string[] = [];
    const tx = {
      studioTemplate: {
        findUnique: async ({ where }: { where: { slug: string } }) => (where.slug === 'datum-gsp-preset' ? { id: 'tp', slug: 'datum-gsp-preset', isPreset: true, latestVersionNo: 2 } : null),
        create: async () => { writes.push('create'); throw new Error('stub: tulis tidak diharapkan'); },
      },
      studioTemplateVersion: { findUniqueOrThrow: async () => ({ id: 'preset-v2', templateId: 'tp', versionNo: 2, resolvedParams: EFFECTIVE }) },
    };
    await expect(ensureDerivedTemplate(tx as never, spec)).rejects.toThrow(/CH-06 uji-nonkontrak: .*templat tanpa contractKind/);
    expect(writes).toEqual([]);
  });

  it('tabel spec jenis dokumen tidak memuat slot contractRecord (CH-06 lolos untuk 10 baris)', () => {
    for (const s of DOC_TYPE_TEMPLATE_SPECS) expect(s.slots.some((x) => x.sectionType === 'contractRecord'), s.slug).toBe(false);
  });
});

describe('S27 0 kode per slug (grep sumber)', () => {
  const src = (rel: string) => readFileSync(path.join(REPO, rel), 'utf8');
  const slugs = DOC_TYPE_TEMPLATE_SPECS.map((s) => s.slug);
  const bases = DOC_TYPE_LAYERS.map((t) => t.slugBase);

  it('seed-studio.ts dan helper bersama tidak menyebut slug templat jenis dokumen mana pun', () => {
    for (const rel of ['prisma/seed-studio.ts', 'prisma/seed-studio-templates.ts']) {
      const text = src(rel);
      for (const s of [...slugs, ...bases]) expect(text.includes(`"${s}`), `${rel} memuat ${s}`).toBe(false);
    }
  });

  it('modul tabel spec: setiap slug dasar muncul tepat sekali (data lapis jenis), tanpa cabang slug/jenis', () => {
    const text = src('prisma/seed-doc-type-templates.ts');
    for (const b of bases) expect(text.split(`"${b}"`).length - 1, b).toBe(1);
    for (const s of slugs.filter((x) => x.endsWith('-en'))) expect(text.includes(`"${s}"`), s).toBe(false);
    expect(text).not.toMatch(/slug\s*===|slugBase\s*===|typeCode\s*===|\.startsWith\(|\.endsWith\(|switch\s*\(/);
  });
});
