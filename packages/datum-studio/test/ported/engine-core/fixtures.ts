// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/engine-core/fixtures.ts (see test/ported/README.md).
// S71: fixture bersama uji unit mesin inti (token, bind, lint).
// Murni lokal: tanpa DB, tanpa jaringan, tanpa menulis berkas. Berkas ini
// bukan *.test.ts sehingga tidak dikumpulkan vitest sebagai suite.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { NormDocSnapshot, ResolvedTemplate, StudioDocV1, StudioTier } from '@/lib/studio/contract';
import { normalizeDocument } from '@/lib/studio/services/ingest/normalize';
import { loadResolvedProfileFile } from '@/lib/studio/services/templates/import';
import { DATUM_CANONICAL_SLUG, resolveProfileInMemory } from '@/lib/studio/services/templates/profile';
import { resolveRepoAssetPath } from '@/lib/studio/services/templates/assets'; // row42 ADAPT A4

export const REPO = path.resolve(__dirname, '..', '..', '..', 'vendor');
export const BENCHMARK_DOC = path.join(__dirname, '..', '_fixtures', 'benchmark', 'manual000', 'doc.json');
export const BENCHMARK_PROFILE = path.join(REPO, 'benchmark', 'manual000', 'template.json');

/** Profil DATUM-kanonik tanpa aset (resolusi di memori, tanpa DB). */
export function canonicalTemplate(): ResolvedTemplate {
  // row42 ADAPT A4 (row 107 M3, row 11 M3): resolveProfileInMemory has no unconfined default resolver any more
  // (services/templates/profile.ts:801-803); pass the confined repo resolver, as renderers/_kit.ts does.
  return resolveProfileInMemory({ base: DATUM_CANONICAL_SLUG, slug: DATUM_CANONICAL_SLUG, kind: 'DOCUMENT', overrides: {} } as Parameters<
    typeof resolveProfileInMemory
  >[0], { resolveAssetPath: (rel: string) => resolveRepoAssetPath(rel, REPO) });
}

/** Profil benchmark Manual 000 (templat TERBATAS: melepas DATUM-04, DATUM-09, G3). */
export async function benchmarkTemplate(): Promise<ResolvedTemplate> {
  const r = await loadResolvedProfileFile(BENCHMARK_PROFILE, { repoRoot: REPO, withCanonicalAssets: false });
  return r.template;
}

/** Templat dengan parameter tambahan (mis. `lint.enforcementOverride`). */
export function withParams(tpl: ResolvedTemplate, extra: Record<string, unknown>): ResolvedTemplate {
  return { ...tpl, params: Object.freeze({ ...tpl.params, ...extra }) as ResolvedTemplate['params'] };
}

export function loadBenchmarkDoc(): StudioDocV1 {
  return JSON.parse(readFileSync(BENCHMARK_DOC, 'utf8')) as StudioDocV1;
}

type Block = Record<string, unknown>;

/** Dokumen minimal yang lolos normalisasi: satu bab, satu seksi, blok bebas. */
export function makeDoc(opts: {
  tier?: StudioTier;
  sectionTitle?: string;
  chapterTitle?: string;
  blocks?: Block[];
  register?: StudioDocV1['register'];
  x?: Record<string, unknown>;
  language?: 'ID' | 'EN';
  docNumber?: string;
  assets?: StudioDocV1['assets'];
} = {}): StudioDocV1 {
  const doc: Record<string, unknown> = {
    $schema: 'studio.doc/v1',
    template: { slug: DATUM_CANONICAL_SLUG },
    meta: {
      title: 'Dokumen Uji Mesin',
      rev: 'A',
      typeCode: 'STD',
      tier: opts.tier ?? 'TERBIT',
      classification: 'TERBATAS',
      language: opts.language ?? 'ID',
      author: 'Divisi Engineering PT GSP',
      issueDate: '2026-10-23',
      ...(opts.docNumber ? { docNumber: opts.docNumber } : {}),
    },
    chapters: [
      {
        title: { text: opts.chapterTitle ?? 'Ruang lingkup pengujian' },
        sections: [
          {
            title: { text: opts.sectionTitle ?? 'Batas pengujian mesin' },
            blocks: opts.blocks ?? [{ type: 'paragraph', text: 'Paragraf uji yang netral dan pendek.' }],
          },
        ],
      },
    ],
  };
  if (opts.register) doc.register = opts.register;
  if (opts.x) doc.x = opts.x;
  if (opts.assets) doc.assets = opts.assets;
  return doc as unknown as StudioDocV1;
}

/** Snapshot ternormalisasi murni; melempar bila normalisasi melapor isu. */
export function snapshotOf(doc: StudioDocV1): NormDocSnapshot {
  const r = normalizeDocument(doc);
  if (r.issues.length > 0) throw new Error(`fixture tidak ternormalisasi: ${JSON.stringify(r.issues)}`);
  return r.snapshot;
}

/** Tabel data 2 kolom bercaption + sumber; `badRow` = baris dengan sel kurang (G1). */
export function dataTable(opts: { badRow?: boolean } = {}): Block {
  const cell = (t: string) => ({ text: t });
  return {
    type: 'table',
    caption: { inline: { text: 'Ringkasan uji.' } },
    source: { inline: { text: 'SUMBER uji internal.' } },
    columns: [
      { widthMm: 96, role: 'text', align: 'left' },
      { widthMm: 32, role: 'numeral', align: 'right' },
    ],
    rows: [
      { kind: 'header', cells: [cell('Butir'), cell('Nilai')] },
      { kind: 'body', cells: opts.badRow ? [cell('Hanya satu sel')] : [cell('Alpha'), cell('12')] },
    ],
  };
}

export function statuses(issues: ReadonlyArray<{ checkId: string; status: string }>, id: string): string[] {
  return issues.filter((i) => i.checkId === id).map((i) => i.status);
}
