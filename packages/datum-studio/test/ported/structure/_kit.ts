// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/structure/_kit.ts (see test/ported/README.md).
/* eslint-disable @typescript-eslint/no-explicit-any -- fixture JSON kontrak dibaca bebas-bentuk di uji */
// SR-44: perangkat bersama uji unit struktur dan permukaan (tanpa DB).
//
// Sumber kebenaran fixture = register 03_structural_sections_specs.md (§6.1 SL-01..SL-07,
// §5.1 DF-01..DF-69, §7.3 E0) dan blueprint 05 §2.4 (E1), BUKAN keluaran kode yang diuji.
import { expect } from '../_vitest';
import { CONTENT_BLOCK_TYPES, StudioEngineError, type StudioTier, type TemplateSlotDef } from '@/lib/studio/contract';
import type { SkeletonInput } from '@/lib/studio/services/compose';
import { skeletonSha256 } from '@/lib/studio/services/skeleton/skeleton';

const ALL_BLOCKS = [...CONTENT_BLOCK_TYPES] as string[];

/** Kerangka bawaan GSP DATUM (register §6.1, SL-01..SL-07) apa adanya. */
export function datumSlots(): TemplateSlotDef[] {
  return [
    { slotKey: 'cover', sectionType: 'cover', label: 'Sampul', position: 1, required: true, positionLocked: true, repeatable: false, contentMode: 'MIXED', tiers: ['TERBIT', 'SERAH'], admits: [], essentials: {} },
    { slotKey: 'controlSheet', sectionType: 'controlSheet', label: 'Lembar Kendali', position: 2, required: true, positionLocked: false, repeatable: false, contentMode: 'INPUT', tiers: ['TERBIT', 'SERAH'], admits: [], essentials: {} },
    { slotKey: 'signature', sectionType: 'signatureBlock', label: 'Tanda Tangan', position: 3, required: true, positionLocked: false, repeatable: false, contentMode: 'INPUT', tiers: ['TERBIT', 'SERAH'], admits: [], essentials: { 'slot.placement': 'inControlSheet' } },
    { slotKey: 'toc', sectionType: 'toc', label: 'Daftar Isi', position: 4, required: true, positionLocked: false, repeatable: false, contentMode: 'AUTO', tiers: ['TERBIT', 'SERAH'], admits: [], essentials: {} },
    { slotKey: 'content', sectionType: 'chapter', label: 'Isi', position: 5, required: true, positionLocked: false, repeatable: true, minItems: 1, contentMode: 'INPUT', tiers: [], admits: [...ALL_BLOCKS], essentials: {} },
    { slotKey: 'references', sectionType: 'sourceRegister', label: 'Referensi', position: 6, required: false, positionLocked: false, repeatable: false, contentMode: 'INPUT', tiers: [], admits: [], essentials: {} },
    { slotKey: 'appendices', sectionType: 'appendix', label: 'Lampiran', position: 7, required: false, positionLocked: true, repeatable: true, contentMode: 'INPUT', tiers: [], admits: [...ALL_BLOCKS], essentials: {} },
  ];
}

/** Masukan kerangka compose dari slot (bawaan: kerangka DATUM). */
export function skeletonInput(slots: TemplateSlotDef[] = datumSlots(), implicit = false): SkeletonInput {
  const skeleton = { $schema: 'studio.skeleton/v1' as const, slots };
  return { templateVersionId: 'tv-sr44', skeleton, skeletonSha256: skeletonSha256(skeleton), implicit };
}

/** Ubah satu slot kerangka DATUM (salinan baru). */
export function withSlot(slotKey: string, patch: Partial<TemplateSlotDef>): TemplateSlotDef[] {
  return datumSlots().map((s) => (s.slotKey === slotKey ? { ...s, ...patch } : s));
}

export const DATUM_ORDER = ['cover', 'controlSheet', 'signature', 'toc', 'content', 'references', 'appendices'];

const t = (text: string) => ({ text });

/** E1 (blueprint 05 §2.4): dokumen GSP DATUM tujuh bagian, konten murni. */
export function e1(): Record<string, any> {
  return {
    $schema: 'studio.doc/v2',
    template: { slug: 'datum-gsp' },
    mission: { folder: '2026-10-23_uji-sr44' },
    docKey: 'laporan-survei',
    meta: { title: 'Laporan Survei Gardu Induk Cikupa', tier: 'TERBIT', subject: 'Survei GI Cikupa' },
    sections: {
      cover: { type: 'cover', titleLines: [t('Survei Gardu Induk Cikupa'), t('Kondisi Peralatan 150 kV')], standfirst: t('Kondisi peralatan primer.') },
      controlSheet: {
        type: 'controlSheet',
        revisionHistory: [{ rev: 'A', date: '2026-10-23', what: 'Terbit pertama', by: 'Tim Survei' }],
        verificationChain: [{ layer: '1', role: 'Penyusun', name: 'A. Pratama' }],
        methodStatement: t('Pengukuran langsung di lapangan.'),
        distribution: [{ copy: '1', holder: 'Manajer Proyek' }],
      },
      signature: { type: 'signatureBlock', roles: [{ role: t('Disusun'), holder: t('A. Pratama'), date: t('2026-10-23') }] },
      toc: { type: 'toc' },
      content: {
        type: 'chapter',
        outline: [{ key: '1' }, { key: '2' }],
        chapters: [
          { key: '1', title: t('Lingkup Survei'), sections: [{ title: t('Tujuan'), blocks: [{ type: 'paragraph', text: 'Survei mendata kondisi peralatan 150 kV.' }] }] },
          {
            key: '2',
            title: t('Temuan Utama'),
            sections: [
              {
                title: t('Transformator Daya'),
                blocks: [
                  { type: 'paragraph', runs: [{ t: 'Suhu minyak TD-1 ' }, { t: 'di atas batas', strong: true }, { t: ' operasi normal.' }] },
                  {
                    type: 'table',
                    caption: t('Suhu minyak transformator'),
                    columns: [{ role: 'text' }, { role: 'numeral', unit: '°C' }],
                    rows: [{ kind: 'header', cells: [t('Unit'), t('Suhu')] }, { cells: [t('TD-1'), t('68')] }],
                    source: { text: 'Pengukuran lapangan 2026-10-20', provenance: ['TERUKUR'] },
                  },
                ],
              },
            ],
          },
        ],
      },
      references: { type: 'sourceRegister', entries: [{ id: 'r1', citation: t('SPLN T5.008:2019'), kind: 'dokumen' }] },
      appendices: { type: 'appendix', chapters: [{ key: 'A', title: t('Data Mentah'), sections: [{ title: t('Log Suhu'), blocks: [{ type: 'paragraph', text: 'Log 24 jam.' }] }] }] },
    },
  };
}

const caption = () => t('Keterangan figur');
const source = () => ({ text: 'Pengukuran lapangan', provenance: ['TERUKUR'] });

/**
 * Dokumen PROBE: E1 diperluas agar setiap lokasi DF/VF register hadir sekali.
 * Indeks blok di bab 2 section 0 (BLOCK_AT) dipakai uji DISPLAY_FIELD.
 */
export function probeDoc(): Record<string, any> {
  const d = e1();
  d.sections.cover = {
    type: 'cover',
    tagline: t('LAPORAN TEKNIS'),
    titleLines: [t('Survei Gardu Induk')],
    standfirst: t('Ringkas.'),
    scopeLine: t('Lingkup 150 kV'),
    addressLine: t('Cikupa'),
    control: [[t('No'), t('001'), t('Rev'), t('A')]],
    colophon: { left: t('GSP'), right: t('2026') },
    identityString: t('GSP-001-A'),
  };
  d.sections.toc = { type: 'toc' };
  d.sections.content.parts = [{ id: 'P1', title: t('Bagian Satu'), lede: t('Pengantar bagian.') }];
  d.sections.content.chapters[1].partId = 'P1';
  d.sections.content.chapters[1].sections[0].blocks = [
    /* 0 */ { type: 'paragraph', runs: [{ t: 'Teks ' }, { t: 'tebal', strong: true }], rail: [{ kind: 'note', text: 'Catatan rel' }] },
    /* 1 */ { type: 'list', ordered: false, items: [{ text: 'Butir satu' }, { text: 'Butir dua' }] },
    /* 2 */ { type: 'aside', variant: 'generic', label: t('Catatan'), body: [t('Isi catatan.')] },
    /* 3 */ { type: 'monoBlock', label: t('Log'), lines: [t('P-1 2,3 mm/s')] },
    /* 4 */ { type: 'assumptionInline', asmId: 'ASM-FAS-01', text: 'Jam operasi 16 jam per hari.', impact: 'Interval memendek.' },
    /* 5 */ {
      type: 'table',
      caption: t('Suhu'),
      columns: [{ role: 'text' }, { role: 'numeral', unit: '°C' }],
      rows: [{ kind: 'header', cells: [t('Unit'), t('Suhu')] }, { cells: [{ text: 'TD-1' }, { text: '68' }] }],
      source: source(),
    },
    /* 6 */ {
      type: 'derivation',
      title: t('Turunan beban'),
      lines: [{ label: t('Arus'), value: t('100 A') }],
      result: { label: t('Daya'), expr: 'V*I', registerKey: 'p1' },
      verdict: { label: t('Status'), registerKey: 'p1', limit: 10 },
      closing: t('Selesai.'),
    },
    /* 7 */ {
      type: 'chart',
      code: 'P-01',
      data: { shape: 'categorical', points: [{ label: 'A', value: 1 }, { label: 'B', value: 2 }] },
      caption: caption(),
      source: source(),
      keyRow: t('Batang = jam henti'),
      limit: { value: 55, label: 'Batas' },
    },
    /* 8 */ {
      type: 'chart',
      code: 'composite',
      panels: [{ name: 'Panel 1', code: 'P-01', data: { shape: 'categorical', points: [{ label: 'A', value: 1 }] }, limit: { value: 1 } }],
      caption: caption(),
      source: source(),
    },
    /* 9 */ {
      type: 'diagram',
      spec: { family: 'flow', nodes: [{ id: 'n1', label: 'Sumber', class: { tier: 0 } }] },
      caption: caption(),
      source: source(),
    },
    /* 10 */ { type: 'image', asset: 'foto-1', caption: caption(), source: source() },
    /* 11 */ { type: 'symbolSheet', dialect: 'iec', caption: caption(), source: source() },
  ];
  d.assets = { 'foto-1': { assetRef: `sha256:${'a'.repeat(64)}` } };
  return d;
}

/** Pointer bab 2 section 0 blok ke-i pada probeDoc. */
export const BLOCK_AT = (i: number) => `/sections/content/chapters/1/sections/0/blocks/${i}`;

/** Tangkap StudioEngineError dari fn; gagal bila tidak melempar atau melempar galat lain. */
export function catchEngine(fn: () => unknown): StudioEngineError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(StudioEngineError);
    return e as StudioEngineError;
  }
  throw new Error('diharapkan StudioEngineError, tetapi fungsi tidak melempar');
}

export async function catchEngineAsync(fn: () => Promise<unknown>): Promise<StudioEngineError> {
  try {
    await fn();
  } catch (e) {
    expect(e).toBeInstanceOf(StudioEngineError);
    return e as StudioEngineError;
  }
  throw new Error('diharapkan StudioEngineError, tetapi fungsi tidak melempar');
}

export const TIER_TERBIT: StudioTier = 'TERBIT';

/** Set nilai pada pointer JSON (membuat objek antara bila perlu). */
export function setAt(obj: any, pointer: string, value: unknown): void {
  const segs = pointer.split('/').slice(1).map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
  let node = obj;
  for (const s of segs.slice(0, -1)) {
    if (node[s] === undefined) node[s] = {};
    node = node[s];
  }
  node[segs[segs.length - 1]] = value;
}

export function getAt(obj: any, pointer: string): any {
  let node = obj;
  for (const s of pointer.split('/').slice(1)) node = node?.[s];
  return node;
}

// ── Pembantu compose (murni) ─────────────────────────────────────────────────────
import type { DocMeta, ParamMap, StudioDocV2Resolved } from '@/lib/studio/contract';
import { resolveParams } from '@/lib/studio/engine/tokens';
import { ALL_PARAMS } from '@/lib/studio/params';
import { defaultMeta, emptyResolvedDoc, mergeSubmission, seededPidAllocator } from '@/lib/studio/services/compose';

let cachedParams: ParamMap | null = null;
/** Nilai efektif default registri (tanpa preset/templat). */
export function defaultParams(): ParamMap {
  cachedParams ??= resolveParams({ base: {}, overrides: {}, registry: ALL_PARAMS }).params;
  return cachedParams;
}

/** Meta lengkap dokumen dari meta kiriman (register §7.2). */
export function metaOf(sent: { title: string } & Record<string, unknown>): DocMeta {
  return defaultMeta(sent as never, defaultParams(), { author: 'agen-uji', issueDate: '2026-10-23', docNumber: '001/GSP/KT/X/2026' });
}

/** Dokumen kosong berkerangka (§7) untuk kiriman `sub`. */
export function emptyFor(sub: Record<string, any>): StudioDocV2Resolved {
  return emptyResolvedDoc({ template: { slug: 'datum-gsp', version: 1 }, meta: metaOf(sub.meta), mission: sub.mission, docKey: sub.docKey });
}

/** Gabung kiriman ke dokumen (bawaan: dokumen kosong) dengan pid berbenih. */
export function merge(sub: Record<string, any>, current?: StudioDocV2Resolved, opts: { seed?: string; retired?: Set<string>; slots?: TemplateSlotDef[]; tier?: StudioTier } = {}) {
  return mergeSubmission(current ?? emptyFor(sub), sub as never, {
    skeleton: skeletonInput(opts.slots),
    tier: opts.tier ?? 'TERBIT',
    pids: seededPidAllocator(opts.seed ?? 'sr44'),
    ...(opts.retired ? { retiredPids: opts.retired } : {}),
  });
}
