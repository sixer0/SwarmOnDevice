// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/compose/s29-usage-parity.test.ts (see test/ported/README.md).
import { seedModule, useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
/**
 * S29 (U3 usage parity; blueprint 02_structured_datum_rev_a.md §1 butir 6, AC-9; register research/31 §9; D-594,
 * D-598 F-8, D-602): satu JSON isi kajian identik (sampel `docs/STUDIO-HOWTO-DOCUMENT.md` §2, tanpa `number`)
 * dikirim lewat jalur klien MCP yang sama ke `datum-gsp` dan ke 10 templat jenis dokumen (tabel spec S26).
 *
 * Seam (tanpa DB, seperti uji murni lain): templat diresolusi dalam memori = preset (profil visual GSP DATUM dari
 * `benchmark/manual000/template.json` tanpa pelepas penegakan lint, seperti `datum-gsp-preset`) + lapis templat
 * hasil `derivedTemplatePlan` seed; lalu jalur klien (`buildClient`, bahasa label dari templat, slot depan per tier
 * D-1) dan jalur server murni yang dipakai ingest (`defaultMeta`, P3-20, skema doc/v2, `mergeSubmission`,
 * `composeV2`, kelengkapan, gerbang by-construction).
 *
 * Pembanding: `datum-gsp` dengan meta yang SAMA dengan bawaan templat yang berbeda dari datum-gsp: `meta.tier`
 * (blueprint §1 butir 6 untuk NOTA; juga SERAH) dan `meta.language` (EN). Dengan begitu uji membuktikan "bawaan
 * templat = meta yang setara" (U3). Selisih terhadap datum-gsp polos (TERBIT, ID) diuji terpisah dan hanya boleh
 * berupa temuan milik tier/bahasa yang tercatat sebagai risiko.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from '../_vitest';
import type { NormDocSnapshot, ParamMap, ResolvedTemplate, StudioTier, TemplateSlotDef } from '@/lib/studio/contract';
import { assembleDocxDetailed } from '@/lib/studio/engine/docx/assemble';
import { resolveParams } from '@/lib/studio/engine/tokens';
import { ALL_PARAMS } from '@/lib/studio/params';
import { composeV2, defaultMeta, emptyResolvedDoc, mergeSubmission, seededPidAllocator, type SkeletonInput } from '@/lib/studio/services/compose';
import { computeCompleteness } from '@/lib/studio/services/completeness';
import { completenessInputOf, docNumberPattern, evaluateByConstruction, formatDocNumber, stableStringify, typeCodeIssue, validateV2Against } from '@/lib/studio/services/ingest';
import { resolveSkeletonSlots, resolveSlotParams, skeletonSha256, validateSkeleton } from '@/lib/studio/services/skeleton';
import { loadResolvedProfileFile, type ParamRecord } from '@/lib/studio/services/templates';
import { buildClient, labelLangOf, type ClientSection } from '../../../vendor/scripts/studio/mcp/write-client';
import { frontSlotsForTier, type TemplateShape } from '../../../vendor/scripts/studio/mcp/write-client-run';
const { DATUM_SKELETON_SLOTS, derivedTemplatePlan } = (await import(seedModule('seed-studio-templates'))) as any; // row42 W14
const { DERIVED_PRESET_SPECS } = (await import(seedModule('seed-derived-presets'))) as any; // row42 W14
const { DOC_TYPE_TEMPLATE_SPECS } = (await import(seedModule('seed-doc-type-templates'))) as any; // row42 W14
import { makeCtx, parseXml, partText, unzip } from '../renderers/_kit';

const REPO = path.resolve(__dirname, '..', '..', '..', 'vendor');
const TODAY = '2026-11-04';

type Payload = { meta: Record<string, string>; sections: ClientSection[] };

/** Sampel §2 how-to apa adanya (blok ```json pertama), lalu tanpa `meta.number` (D-598 F-8). */
function howtoSample(): Payload {
  const md = readFileSync(path.join(__dirname, '..', '_fixtures', 'docs', 'STUDIO-HOWTO-DOCUMENT.md'), 'utf8'); // row42 W4: doc copied as test data
  const m = /## 2\.[\s\S]*?```json\n([\s\S]*?)```/.exec(md);
  if (!m) throw new Error('blok JSON sampel §2 tidak ditemukan di STUDIO-HOWTO-DOCUMENT.md');
  const body = JSON.parse(m[1]) as Payload;
  delete body.meta.number;
  return { meta: body.meta, sections: body.sections };
}

/** datum-gsp = preset + esensial global + kerangka 7 slot (jalur `--presets-and-skeletons`), tanpa lapis jenis. */
const DATUM_GSP: DerivedTemplateSpec = {
  slug: 'datum-gsp',
  name: 'DATUM GSP',
  description: 'pembanding',
  presetSlug: 'datum-gsp-preset',
  slots: DATUM_SKELETON_SLOTS,
  layer: {},
  contractKind: null,
  changeNote: () => 'pembanding',
};

/** research/31 §6: daftar inti AC-6 (kritis CR-4). */
const AC6_CORE = ['Lembar Kendali', 'KLASIFIKASI', 'SALINAN INDUK', 'TERBITAN', 'Tanggal', 'Uraian', 'Oleh', 'Pemegang', 'LEMBAR', 'Penyusun', 'Rp'];
const wordHit = (text: string, token: string) => new RegExp(`(?<![\\p{L}\\p{N}])${token.replace(/ /g, '[ \\u00A0]')}(?![\\p{L}\\p{N}])`, 'u').test(text);
const FRONT = new Set(['cover', 'controlSheet', 'signature']);

let PRESET: ResolvedTemplate;

beforeAll(async () => {
  const r = await loadResolvedProfileFile(path.join(REPO, 'benchmark', 'manual000', 'template.json'), { repoRoot: REPO, withCanonicalAssets: true });
  // datum-gsp-preset = profil yang sama tanpa pelepas penegakan lint (seed-studio.ts DATUM_GSP_DROPPED_OVERRIDE_PREFIX).
  const params = Object.fromEntries(Object.entries(r.template.params).filter(([k]) => !k.startsWith('lint.enforcement'))) as ParamMap;
  PRESET = { ...r.template, params };
});

interface Outcome {
  slug: string;
  issues: {
    layerErrors: unknown[];
    clientWarnings: string[];
    schemaIssues: unknown[];
    typeCodeIssue: unknown;
    composeWarnings: string[];
    completeness: string;
    missingRequired: unknown;
    blocking: unknown[];
    /** Temuan lint yang dilaporkan (FAIL/WARN/REPORT); NOT_RUN = cek tidak berlaku, bukan temuan. */
    findings: string[];
    releaseStatus: string;
  };
  notRun: string[];
  frontOmitted: string[];
  frontSent: string[];
  meta: { typeCode: string; tier: string; language: string; docNumber: string; author: string };
  labels: string[];
  coverKicker: unknown;
  entity: unknown;
  snapshot: Record<string, unknown>;
  contentSha: string;
  /** Bahan render murni (templat terresolusi, kerangka berkenop, tier efektif). */
  tpl: ResolvedTemplate;
  slotDefs: TemplateSlotDef[];
  tier: StudioTier;
}

/**
 * Nilai efektif preset basis spec: profil GSP DATUM (datum-gsp-preset), ditambah sematan preset turunan C21 bila
 * `presetSlug` adalah baris `DERIVED_PRESET_SPECS` di atas datum-gsp-preset (C23: 10 templat di atas preset Rev A,
 * Tabel 8.2). Pencarian data, bukan cabang slug.
 */
function presetParamsOf(spec: DerivedTemplateSpec): ParamMap {
  const derived = DERIVED_PRESET_SPECS.find((p) => p.slug === spec.presetSlug && p.baseSlug === DATUM_GSP.presetSlug);
  return (derived ? { ...PRESET.params, ...derived.pins } : PRESET.params) as ParamMap;
}

/** Satu templat: jalur klien + jalur server murni dengan muatan yang sama. */
function run(spec: DerivedTemplateSpec, payload: Payload, presetOverride?: ParamMap): Outcome {
  const base = presetOverride ?? presetParamsOf(spec);
  const plan = derivedTemplatePlan(spec, base as ParamRecord);
  const resolved = resolveParams({ base, overrides: plan.overrides, registry: ALL_PARAMS });
  const P = resolved.params;
  const tpl: ResolvedTemplate = { ...PRESET, templateId: `tpl-${spec.slug}`, versionId: `tv-${spec.slug}`, versionNo: 1, params: P };
  const slots: TemplateSlotDef[] = plan.slots;
  const skeleton = validateSkeleton({ slots });
  const skel: SkeletonInput = { templateVersionId: tpl.versionId, skeleton, skeletonSha256: skeletonSha256(skeleton), implicit: false };

  // ── Klien MCP (write-client-run.ts writeClient, cabang dokumen baru) ──
  const shape: TemplateShape = {
    slots: slots.map((s) => ({ slotKey: s.slotKey, tiers: [...s.tiers] })),
    defaultTier: typeof P['doc.defaultTier'] === 'string' ? (P['doc.defaultTier'] as string) : 'TERBIT',
    language: typeof P['doc.language'] === 'string' ? labelLangOf(P['doc.language'] as string) : null,
  };
  const input = { meta: payload.meta, title: null, sections: payload.sections, today: TODAY };
  let built = buildClient(input);
  if (built.meta.language === undefined && shape.language != null && shape.language !== built.language) built = buildClient({ ...input, language: shape.language });
  const tier = (typeof built.docMeta.tier === 'string' ? built.docMeta.tier : shape.defaultTier) as StudioTier;
  const front = frontSlotsForTier(built.slots, shape, tier);
  const content: Record<string, unknown> = { type: 'chapter', chapters: built.chapters };
  if (built.outline !== null) content.outline = built.outline;
  const sub = { $schema: 'studio.doc/v2', template: { slug: spec.slug }, mission: { folder: '2026-11-04_uji-s29' }, docKey: 'kajian-s29', meta: built.docMeta, sections: { ...front.send, content } };

  // ── Server murni (ingest v2 runPipeline) ──
  const schemaIssues = validateV2Against('studio.doc/v2', sub);
  const meta0 = defaultMeta(built.docMeta as never, P, { author: 'agen-uji', issueDate: TODAY });
  const meta = { ...meta0, docNumber: formatDocNumber(docNumberPattern(P), 1, meta0.typeCode, TODAY) };
  const empty = emptyResolvedDoc({ template: { slug: spec.slug, version: 1 }, meta, mission: sub.mission, docKey: sub.docKey });
  const merged = mergeSubmission(empty, { ...sub, template: { slug: spec.slug, version: 1 } } as never, { skeleton: skel, tier, pids: seededPidAllocator('s29') });
  const slotParams = Object.fromEntries(slots.map((s) => [s.slotKey, resolveSlotParams(tpl, s).params]));
  const composed = composeV2({ source: merged.doc, skeleton: skel, tier, params: P, slotParams });
  const completeness = computeCompleteness(completenessInputOf(skel, composed.snapshot, composed.rows, { docId: '', docNumber: meta.docNumber, missionFolder: sub.mission.folder, docKey: sub.docKey }, 1));
  const gate = evaluateByConstruction({ snapshot: composed.snapshot, tpl, tier, complete: completeness.status === 'COMPLETE', correlationId: 's29' });
  return {
    slug: spec.slug,
    issues: {
      layerErrors: resolved.errors.filter((e) => e.pointer?.startsWith('/overrides/')),
      clientWarnings: built.warnings.map((w) => w.code).sort(),
      schemaIssues,
      typeCodeIssue: typeCodeIssue(meta, spec.slug, tpl, ''),
      composeWarnings: composed.warnings.map((w) => w.code).sort(),
      completeness: completeness.status,
      missingRequired: completeness.missingRequired,
      blocking: gate.blocking.map((b) => `${b.checkId ?? b.keyword}:${b.message}`),
      findings: gate.lint.checks.filter((c) => c.status !== 'PASS' && c.status !== 'NOT_RUN').map((c) => `${c.checkId}:${c.status}:${c.detail ?? ''}`).sort(),
      releaseStatus: gate.lint.releaseStatus,
    },
    notRun: gate.lint.checks.filter((c) => c.status === 'NOT_RUN').map((c) => c.checkId).sort(),
    frontOmitted: front.omitted,
    frontSent: Object.keys(front.send),
    meta: { typeCode: meta.typeCode, tier: meta.tier, language: meta.language, docNumber: meta.docNumber, author: meta.author },
    labels: slots.map((s) => s.label),
    coverKicker: slotParams.cover?.['cover.kicker.text'],
    entity: P['org.entityName'],
    snapshot: composed.snapshot as unknown as Record<string, unknown>,
    contentSha: stableStringify((merged.doc.sections as Record<string, unknown>).content ?? null),
    tpl,
    slotDefs: slots,
    tier,
  };
}

/** Render DOCX murni (perakit yang sama dengan render revisi) dari hasil `run`. */
async function renderDocx(o: Outcome) {
  const slots = resolveSkeletonSlots(o.tpl, o.slotDefs, undefined, { tier: o.tier }).slots;
  const { ctx, logs } = makeCtx(o.snapshot as unknown as NormDocSnapshot, o.tpl, { slots });
  const detail = await assembleDocxDetailed(ctx);
  const parts = unzip(detail.bytes);
  const xml = partText(parts, 'word/document.xml');
  return { xml, parse: parseXml(xml), logs: logs.filter((l) => l.level !== 'info').map((l) => `${l.level}:${l.code ?? ''}:${l.message}`).sort() };
}

/** Warna run teks pita segel (sel pertama tabel berisian seal) di document.xml. */
function sealBandTextColor(xml: string): string | null {
  const tbl = (xml.match(/<w:tbl>[\s\S]*?<\/w:tbl>/g) ?? []).find((t) => /w:fill="6E1420"/.test(t));
  return tbl ? (/<w:r>[\s\S]*?<w:color w:val="([0-9A-F]{6})"/.exec(tbl)?.[1] ?? null) : null;
}

/** Jalur daun JSON yang berbeda antara dua nilai. */
function diffPaths(a: unknown, b: unknown, p = ''): string[] {
  if (stableStringify(a ?? null) === stableStringify(b ?? null)) return [];
  const obj = (v: unknown) => v !== null && typeof v === 'object';
  if (!obj(a) || !obj(b) || Array.isArray(a) !== Array.isArray(b)) return [p || '/'];
  const keys = new Set([...Object.keys(a as object), ...Object.keys(b as object)]);
  return [...keys].flatMap((k) => diffPaths((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${p}/${k}`));
}

const at = (v: unknown, p: string): unknown => p.split('/').slice(1).reduce((n: unknown, k) => (n as Record<string, unknown> | undefined)?.[k], v);

/** Jalur snapshot milik templat (kode jenis, tier, bahasa, nomor, kerangka/label/kicker, slot depan berlabel, slot AUTO tambahan). */
const TEMPLATE_OWNED: readonly RegExp[] = [
  /^\/(doc|source)\/template\/slug$/,
  /^\/(doc|source)\/meta\/(typeCode|tier|language|docNumber)$/,
  /^\/(compose\/)?skeleton\/(templateVersionId|skeletonSha256)$/,
  /^\/(compose\/skeleton\/)?skeleton\/slots\/\d+(\/.*)?$/,
  /^\/skeleton\/slots\/\d+(\/.*)?$/,
  /^\/compose\/tier$/,
  /^\/compose\/slotParams\/(ruleIndex|cover\/cover\.kicker\.text)$/,
  // C23: parameter templat yang dibaca compose (C-5, `COMPOSE_PARAM_KEYS`, D-639 (2)) tersimpan di snapshot compose
  // bila berbeda dari bawaan: bentuk kolom lembar kendali manual (R-69) dan unit penyusun sampul (R-79).
  /^\/compose\/(params|slotParams\/[A-Za-z]+)\/(controlSheet\.columns\.form|cover\.controlBlock\.preparerUnit)$/,
  /^\/doc\/front\/(cover|controlSheet|signature)\//,
  /^\/source\/sections\/(cover|controlSheet|signature)\//,
];

/** Selisih snapshot yang BUKAN milik templat (harus kosong). */
function foreignDiffs(cmp: Outcome, o: Outcome): string[] {
  const slotKeys = (x: Outcome) => new Set((x.snapshot.skeleton as { slots: Array<{ slotKey: string }> }).slots.map((sl) => sl.slotKey));
  const cmpSlots = slotKeys(cmp);
  return diffPaths(cmp.snapshot, o.snapshot).filter((p) => {
    if (TEMPLATE_OWNED.some((re) => re.test(p))) return false;
    const m = /^\/(units|blocks)\/(\d+)(\/.*)?$/.exec(p);
    if (m) {
      const mine = at(o.snapshot, `/${m[1]}/${m[2]}`) as { slotKey?: string } | undefined;
      const theirs = at(cmp.snapshot, `/${m[1]}/${m[2]}`) as { slotKey?: string } | undefined;
      // Unit/blok slot tambahan kerangka (mis. ruleIndex AUTO STD) yang tidak ada di kerangka pembanding.
      if (theirs === undefined && mine?.slotKey !== undefined && !cmpSlots.has(mine.slotKey)) return false;
      // Blok slot depan yang sama (label per bahasa).
      if (mine?.slotKey !== undefined && FRONT.has(mine.slotKey) && theirs?.slotKey === mine.slotKey) return false;
    }
    return true;
  });
}

const defaultTierOf = (s: DerivedTemplateSpec) => s.layer['doc.defaultTier'] as StudioTier;

/** Meta setara bawaan templat yang berbeda dari datum-gsp (tier selain TERBIT, bahasa selain ID). */
function equivalentMeta(s: DerivedTemplateSpec): Record<string, string> {
  const m: Record<string, string> = {};
  if (defaultTierOf(s) !== 'TERBIT') m.tier = String(s.layer['doc.defaultTier']);
  if (s.layer['doc.language'] !== 'ID') m.language = String(s.layer['doc.language']);
  return m;
}

describe('S29 paritas pemakaian (U3): satu JSON kajian ke datum-gsp dan 10 templat', () => {
  it('sampel how-to apa adanya (tanpa number) VALID untuk datum-gsp (D-605 (3): sampel memuat author dan source tabel)', () => {
    // D-605 (3): sampel how-to §2 kini memuat `meta.author` dan `source` tabel; dulu ditolak klien (META_MISSING author).
    const o = run(DATUM_GSP, howtoSample());
    expect(o.meta.author).toBe('Tim Kajian');
    expect(o.issues.clientWarnings).not.toContain('SOURCE_MISSING');
    expect(o.issues.layerErrors).toEqual([]);
    expect(o.issues.schemaIssues).toEqual([]);
    expect(o.issues.typeCodeIssue).toBeNull();
    expect(o.issues.blocking).toEqual([]);
    expect(o.issues.completeness).toBe('COMPLETE');
  });

  describe('sampel how-to apa adanya (author + source tabel, D-605 (3)), sama untuk ke-11 templat', () => {
    let BASE: Record<StudioTier, Outcome>;
    let OUT: Map<string, Outcome>;
    /** Pembanding per templat: datum-gsp + meta setara bawaan templat. */
    let CMP: Map<string, Outcome>;

    beforeAll(() => {
      const p = howtoSample();
      BASE = {
        TERBIT: run(DATUM_GSP, p),
        NOTA: run(DATUM_GSP, { ...p, meta: { ...p.meta, tier: 'NOTA' } }),
        SERAH: run(DATUM_GSP, { ...p, meta: { ...p.meta, tier: 'SERAH' } }),
      };
      OUT = new Map(DOC_TYPE_TEMPLATE_SPECS.map((s) => [s.slug, run(s, p)]));
      CMP = new Map(DOC_TYPE_TEMPLATE_SPECS.map((s) => [s.slug, run(DATUM_GSP, { ...p, meta: { ...p.meta, ...equivalentMeta(s) } })]));
    });

    it('datum-gsp (pembanding) valid: tanpa isu skema/P3-20/penahan, lengkap', () => {
      for (const b of Object.values(BASE)) {
        expect(b.issues.layerErrors).toEqual([]);
        expect(b.issues.schemaIssues).toEqual([]);
        expect(b.issues.typeCodeIssue).toBeNull();
        expect(b.issues.blocking).toEqual([]);
        expect(b.issues.completeness).toBe('COMPLETE');
      }
    });

    it('10 templat valid dengan isu, peringatan, dan temuan lint yang SAMA dengan pembandingnya', () => {
      for (const s of DOC_TYPE_TEMPLATE_SPECS) {
        const o = OUT.get(s.slug)!;
        const cmp = CMP.get(s.slug)!;
        expect(o.issues.blocking, s.slug).toEqual([]);
        expect(o.issues.completeness, s.slug).toBe('COMPLETE');
        expect(o.issues, s.slug).toEqual(cmp.issues);
      }
    });

    it('kontrol detektor: perubahan isi bab di snapshot = selisih bukan milik templat', () => {
      const o = OUT.get('datum-laporan')!;
      const tampered = structuredClone(o);
      const blocks = tampered.snapshot.blocks as Array<{ slotKey?: string; textPlain?: string }>;
      const i = blocks.findIndex((b) => b.slotKey === 'content');
      blocks[i] = { ...blocks[i], textPlain: `${blocks[i].textPlain ?? ''} diubah` };
      expect(foreignDiffs(CMP.get('datum-laporan')!, tampered)).toEqual([`/blocks/${i}/textPlain`]);
    });

    it('isi (bab, blok, tabel, grafik) byte-identik; selisih snapshot hanya keluaran milik templat', () => {
      for (const s of DOC_TYPE_TEMPLATE_SPECS) {
        const o = OUT.get(s.slug)!;
        const cmp = CMP.get(s.slug)!;
        expect(o.contentSha, s.slug).toBe(cmp.contentSha);
        expect(o.contentSha, s.slug).toBe(BASE.TERBIT.contentSha);
        expect(foreignDiffs(cmp, o), s.slug).toEqual([]);
        expect(o.frontSent, s.slug).toEqual(cmp.frontSent);
        expect(o.frontOmitted, s.slug).toEqual(cmp.frontOmitted);
      }
    });

    it('keluaran milik templat = register (kode jenis, tier, bahasa, nomor, kicker, label, entitas D-602)', () => {
      for (const s of DOC_TYPE_TEMPLATE_SPECS) {
        const o = OUT.get(s.slug)!;
        expect(o.meta.typeCode, s.slug).toBe(s.layer['doc.defaultTypeCode']);
        expect(o.meta.tier, s.slug).toBe(s.layer['doc.defaultTier']);
        expect(o.meta.language, s.slug).toBe(s.layer['doc.language']);
        expect(o.meta.docNumber, s.slug).toBe(`001/GSP/${String(s.layer['doc.defaultTypeCode'])}/XI/2026`);
        expect(o.coverKicker, s.slug).toBe(s.slotOverrides!.cover['cover.kicker.text']);
        expect(o.labels, s.slug).toEqual(s.slots.map((x) => x.label));
        expect(o.entity, s.slug).toBe('PT GEMILANG SATRIA PERKASA');
        // C23 (GF-08): basis preset Rev A, Tabel 8.2 (ID:2633-2635) sampai ke templat terresolusi.
        expect(o.tpl.params['type.scale.tableNumerals.size'], s.slug).toBe(7.8);
        // C23 (research/38 §4.1, §4.3): opt-in compose milik templat tersimpan di snapshot compose.
        const composeParams = at(o.snapshot, '/compose/params') as Record<string, unknown>;
        expect(composeParams['controlSheet.columns.form'], s.slug).toBe('manual');
        expect(composeParams['cover.controlBlock.preparerUnit'], s.slug).toBe(s.layer['doc.language'] === 'ID' ? 'Divisi Engineering PT GSP' : 'Engineering Division, PT GSP');
      }
      // Pembanding datum-gsp tetap di atas datum-gsp-preset (7 pt) tanpa kunci compose opt-in (C-5: bawaan tidak disimpan).
      expect(BASE.TERBIT.tpl.params['type.scale.tableNumerals.size']).toBe(7);
      expect(Object.keys(at(BASE.TERBIT.snapshot, '/compose/params') as object)).not.toContain('controlSheet.columns.form');
      // Pembanding membawa nilai preset (huruf campur): override D-602 memang berbeda dari preset, dan tetap tanpa isu baru.
      expect(BASE.TERBIT.entity).toBe('PT Gemilang Satria Perkasa');
    });

    it('slot depan dokumen EN bebas string inti AC-6 (label klien mengikuti bahasa templat, F-1)', () => {
      for (const s of DOC_TYPE_TEMPLATE_SPECS.filter((x) => x.layer['doc.language'] === 'EN')) {
        const front = JSON.stringify((OUT.get(s.slug)!.snapshot.doc as { front?: unknown }).front ?? {});
        const hits = AC6_CORE.filter((t) => wordHit(front, t));
        expect(hits, s.slug).toEqual([]);
      }
      // Kontrol: pembanding ID memang memuat label ID.
      expect(AC6_CORE.filter((t) => wordHit(JSON.stringify((BASE.TERBIT.snapshot.doc as { front?: unknown }).front), t)).length).toBeGreaterThan(0);
    });

    it('NOTA: slot depan tidak dikirim, sama dengan datum-gsp + meta.tier NOTA (tanpa input baru)', () => {
      for (const slug of ['datum-nota', 'datum-nota-en']) {
        expect(OUT.get(slug)!.frontOmitted, slug).toEqual(['cover', 'controlSheet', 'signature']);
        expect(OUT.get(slug)!.frontOmitted, slug).toEqual(BASE.NOTA.frontOmitted);
      }
    });

    it('terhadap datum-gsp polos (TERBIT/NOTA, ID): 8 templat tanpa temuan baru; PT hanya temuan milik tier SERAH/bahasa (risiko tercatat)', () => {
      for (const s of DOC_TYPE_TEMPLATE_SPECS) {
        const o = OUT.get(s.slug)!;
        const plain = BASE[defaultTierOf(s) === 'NOTA' ? 'NOTA' : 'TERBIT'];
        const extra = o.issues.findings.filter((f) => !plain.issues.findings.includes(f));
        const missing = plain.issues.findings.filter((f) => !o.issues.findings.includes(f));
        expect(o.issues.blocking, s.slug).toEqual([]);
        expect({ ...o.issues, findings: [], releaseStatus: '' }, s.slug).toEqual({ ...plain.issues, findings: [], releaseStatus: '' });
        if (defaultTierOf(s) !== 'SERAH') {
          expect(extra, s.slug).toEqual([]);
          expect(missing, s.slug).toEqual([]);
          continue;
        }
        // R-S29-1: tier SERAH menambah D16 "seksi wajib tier SERAH" (non-penahan). R-S29-2 (D01 EN menandai nomor
        // subjudul "1.1") ditutup D-605 (2): penomoran struktural tidak diaudit, jadi tidak ada temuan D01 tambahan.
        expect(extra.length, s.slug).toBeGreaterThan(0);
        for (const f of extra) expect(f.startsWith('D16:FAIL:') && f.includes('SERAH'), `${s.slug}: ${f}`).toBe(true);
        expect(o.issues.findings.filter((f) => f.startsWith('D01:') && f.includes('"1.1"')), s.slug).toEqual([]);
        expect(missing.every((f) => f.startsWith('D16:FAIL:')), s.slug).toBe(true);
      }
    });
  });

  describe('meta yang dikirim agen tetap menang atas bawaan templat', () => {
    it('datum-nota-en + meta.language ID dan meta.tier TERBIT: dokumen ID TERBIT, slot depan dikirim dengan label ID', () => {
      const p = howtoSample();
      const o = run(DOC_TYPE_TEMPLATE_SPECS.find((s) => s.slug === 'datum-nota-en')!, { ...p, meta: { ...p.meta, language: 'ID', tier: 'TERBIT' } });
      const base = run(DATUM_GSP, { ...p, meta: { ...p.meta, language: 'ID', tier: 'TERBIT' } });
      expect(o.meta).toMatchObject({ language: 'ID', tier: 'TERBIT', typeCode: 'NOT' });
      expect(o.frontSent).toEqual(['cover', 'controlSheet', 'signature']);
      expect(o.frontOmitted).toEqual([]);
      expect(JSON.stringify((o.snapshot.doc as { front?: unknown }).front)).toContain('Penyusun');
      expect(o.issues).toEqual(base.issues);
    });

    it('datum-laporan + meta.tier SERAH dan meta.author: tier dan penyusun dari meta', () => {
      const p = howtoSample();
      const o = run(DOC_TYPE_TEMPLATE_SPECS.find((s) => s.slug === 'datum-laporan')!, { ...p, meta: { ...p.meta, tier: 'SERAH' } });
      expect(o.meta.tier).toBe('SERAH');
      expect(o.meta.author).toBe('Tim Kajian');
      expect(o.issues).toEqual(BASE_SERAH_OF(p).issues);
    });

    it('datum-gsp + meta.language EN: label EN walau bawaan templat ID', () => {
      const p = howtoSample();
      const o = run(DATUM_GSP, { ...p, meta: { ...p.meta, language: 'EN' } });
      expect(o.meta.language).toBe('EN');
      expect(AC6_CORE.filter((t) => wordHit(JSON.stringify((o.snapshot.doc as { front?: unknown }).front), t))).toEqual([]);
    });
  });
});

describe('D-602 lapis bersama: render DOCX murni sampel TERBIT', () => {
  it('render.toc.mode field (kenop slot toc): DOCX valid dengan medan TOC, tanpa log peringatan/galat baru', async () => {
    const p = howtoSample();
    for (const slug of ['datum-laporan', 'datum-laporan-en']) {
      const spec = DOC_TYPE_TEMPLATE_SPECS.find((s) => s.slug === slug)!;
      const o = run(spec, p);
      const cmp = run(DATUM_GSP, { ...p, meta: { ...p.meta, ...equivalentMeta(spec) } });
      const r = await renderDocx(o);
      const base = await renderDocx(cmp);
      expect(r.parse.errors, slug).toEqual([]);
      expect(r.xml, slug).toMatch(/<w:instrText xml:space="preserve"> TOC \\o "1-\d" \\h \\z \\u <\/w:instrText>/);
      // Pembanding (preset GSP DATUM, toc static) = tabel tanpa medan TOC.
      expect(base.xml, slug).not.toContain(' TOC \\o ');
      expect(r.logs, slug).toEqual(base.logs);
      expect(o.issues, slug).toEqual(cmp.issues);
    }
  });

  it('color.wrapper.cream TIDAK dipakai: roleFormat preset wrapper.sealBand.run.color F6E9E9 menang atas parameter (tetap penyimpangan SB-02)', async () => {
    const p = howtoSample();
    const spec = DOC_TYPE_TEMPLATE_SPECS.find((s) => s.slug === 'datum-laporan')!;
    const withCream = run({ ...spec, layer: { ...spec.layer, 'color.wrapper.cream': 'F4F5F6' } }, p);
    expect(withCream.tpl.params['color.wrapper.cream']).toBe('F4F5F6');
    expect(sealBandTextColor((await renderDocx(withCream)).xml)).toBe('F6E9E9');
    // Kontrol: tanpa roleFormat preset untuk peran itu, parameter memang mengendalikan warna.
    const roles = { ...(withCream.tpl.roleFormats as Record<string, unknown>) };
    delete roles['wrapper.sealBand'];
    expect(sealBandTextColor((await renderDocx({ ...withCream, tpl: { ...withCream.tpl, roleFormats: roles as never } })).xml)).toBe('F4F5F6');
  });
});

function BASE_SERAH_OF(p: Payload): Outcome {
  return run(DATUM_GSP, { ...p, meta: { ...p.meta, tier: 'SERAH' } });
}
