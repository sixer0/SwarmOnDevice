// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/structure/skeleton-reconstruction.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
/* eslint-disable @typescript-eslint/no-explicit-any -- fixture JSON kontrak dibaca bebas-bentuk di uji */
// SR-44: kerangka implisit (register §6.3, I44), sidik kerangka kanonik (MX02), dan sha
// rekonstruksi (§4.6, SC-5): baris M14-M17 -> rebuildSource -> compose ulang -> sha snapshot
// sama dengan `snapshotSha256` saat tulis. Jalur murni (tanpa DB): baris dan snapshot
// dilewatkan pulang-pergi JSON seperti kolom Json Prisma. Seam: `implicitSkeleton`,
// `skeletonSha256`, `validateSkeleton`, `composeV2`, `rebuildSource`, `storedComposeContext`,
// `canonicalSha256`.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from '../_vitest';
import { CONTENT_BLOCK_TYPES, type StudioDocV2Resolved } from '@/lib/studio/contract';
import { SECTION_REGISTRY } from '@/lib/studio/registry/sections';
import { adaptV1 } from '@/lib/studio/services/adapt-v1';
import { composeV2, storedComposeContext, type ComposeResult } from '@/lib/studio/services/compose';
import { canonicalSha256 } from '@/lib/studio/services/revisions/canonical';
import { implicitSkeleton, skeletonSha256, slotConfigSha256, validateSkeleton } from '@/lib/studio/services/skeleton/skeleton';
import { computeStructureSha256, rebuildSource } from '@/lib/studio/services/structure/rows';
import type { StructureRows } from '@/lib/studio/services/structure/types';
import { datumSlots, defaultParams, e1, merge, probeDoc, skeletonInput } from './_kit';

const NAME = new Map(SECTION_REGISTRY.map((s) => [s.key, s.name]));
const json = <T,>(v: T): T => JSON.parse(JSON.stringify(v));

describe('kerangka implisit §6.3 (versi templat lama, skeletonSha256 = null)', () => {
  const plan = {
    TERBIT: {
      required: ['cover', 'controlSheet', 'toc', 'chapter', 'runningHead'],
      optional: ['appendix', 'sourceRegister', 'signatureBlock'],
      forbidden: ['ruleIndex'],
      order: ['cover', 'controlSheet', 'signatureBlock', 'toc', 'chapter', 'sourceRegister', 'appendix'],
    },
    NOTA: { required: ['chapter'], optional: ['appendix'], forbidden: ['cover', 'controlSheet', 'toc'] },
  };

  it('TERBIT: slotKey registri (signatureBlock->signature, chapter->content, appendix->appendices, sourceRegister->references)', () => {
    const s = implicitSkeleton(plan as never, 'TERBIT');
    expect(s.$schema).toBe('studio.skeleton/v1');
    expect(s.slots.map((x) => [x.position, x.slotKey, x.sectionType, x.required])).toEqual([
      [1, 'cover', 'cover', true],
      [2, 'controlSheet', 'controlSheet', true],
      [3, 'signature', 'signatureBlock', false],
      [4, 'toc', 'toc', true],
      [5, 'content', 'chapter', true],
      [6, 'references', 'sourceRegister', false],
      [7, 'appendices', 'appendix', false],
    ]);
  });
  it('contentMode bawaan: cover MIXED, toc AUTO, lainnya INPUT; tiers = []; positionLocked false; label = nama registri', () => {
    const s = implicitSkeleton(plan as never, 'TERBIT');
    const by = new Map(s.slots.map((x) => [x.slotKey, x]));
    expect(by.get('cover')!.contentMode).toBe('MIXED');
    expect(by.get('toc')!.contentMode).toBe('AUTO');
    for (const k of ['controlSheet', 'signature', 'content', 'references', 'appendices']) expect(by.get(k)!.contentMode, k).toBe('INPUT');
    for (const x of s.slots) {
      expect(x.tiers).toEqual([]);
      expect(x.positionLocked).toBe(false);
      expect(x.label).toBe(NAME.get(x.sectionType));
    }
  });
  it('chapter berulang minItems 1; appendix berulang tanpa minItems; admits = 21 jenis blok isi', () => {
    const s = implicitSkeleton(plan as never, 'TERBIT');
    const content = s.slots.find((x) => x.slotKey === 'content')!;
    const app = s.slots.find((x) => x.slotKey === 'appendices')!;
    expect([content.repeatable, content.minItems]).toEqual([true, 1]);
    expect([app.repeatable, app.minItems]).toEqual([true, undefined]);
    expect(content.admits).toEqual([...CONTENT_BLOCK_TYPES]);
    expect(content.admits).toHaveLength(21);
  });
  it('kunci forbidden dan kunci di luar C33 (runningHead) tidak menjadi slot', () => {
    const keys = implicitSkeleton(plan as never, 'TERBIT').slots.map((x) => x.sectionType);
    expect(keys).not.toContain('ruleIndex');
    expect(keys).not.toContain('runningHead');
  });
  it('per tier: NOTA hanya content + appendices; tier tanpa rencana = 0 slot', () => {
    expect(implicitSkeleton(plan as never, 'NOTA').slots.map((x) => x.slotKey)).toEqual(['content', 'appendices']);
    expect(implicitSkeleton(plan as never, 'SERAH').slots).toEqual([]);
  });
  it('kerangka implisit lolos validateSkeleton dan dapat dikompos (snapshot.skeleton.implicit = true)', () => {
    const s = implicitSkeleton(plan as never, 'TERBIT');
    expect(() => validateSkeleton(s)).not.toThrow();
    const r = composeV2({ source: merge(e1(), undefined, { slots: s.slots }).doc, skeleton: skeletonInput(s.slots, true), params: defaultParams() });
    expect(r.snapshot.skeleton.implicit).toBe(true);
    expect(r.snapshot.skeleton.slots.map((x) => x.slotKey)).toEqual(s.slots.map((x) => x.slotKey));
  });
});

describe('sidik kerangka kanonik (MX02 skeletonSha256, M10 configSha256)', () => {
  it('tidak bergantung urutan larik slot; berubah bila isi slot berubah', () => {
    const a = datumSlots();
    const b = [...datumSlots()].reverse();
    expect(skeletonSha256({ slots: b })).toBe(skeletonSha256({ slots: a }));
    const c = datumSlots();
    c[5] = { ...c[5], label: 'Daftar Rujukan' };
    expect(skeletonSha256({ slots: c })).not.toBe(skeletonSha256({ slots: a }));
    expect(slotConfigSha256(c[5])).not.toBe(slotConfigSha256(a[5]));
    expect(skeletonSha256({ slots: a })).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ── sha rekonstruksi ───────────────────────────────────────────────────────────────
function reconstruct(stored: ComposeResult['snapshot'], rows: StructureRows) {
  const ctx = storedComposeContext(stored);
  expect(ctx, 'snapshot menyimpan konteks compose').toBeDefined();
  const envelope = { ...(stored.source as StudioDocV2Resolved) };
  const emptySections = envelope.sections !== undefined ? 'object' : 'omit';
  delete (envelope as { sections?: unknown }).sections;
  const source = rebuildSource(envelope, rows, { emptySections });
  const again = composeV2({
    source,
    skeleton: ctx!.skeleton,
    tier: ctx!.tier,
    params: ctx!.params,
    ...(ctx!.slotParams ? { slotParams: ctx!.slotParams } : {}),
    ...(ctx!.assets ? { assets: ctx!.assets } : {}),
    prevRows: rows,
  });
  return { source, again, sha: canonicalSha256(again.snapshot) };
}

describe('SC-5: rekonstruksi M14-M17 -> compose ulang -> sha sama', () => {
  const docs: Array<[string, () => StudioDocV2Resolved]> = [
    ['E1 (7 slot)', () => merge(e1()).doc],
    ['probe (semua jenis blok, bagian, aset)', () => merge(probeDoc()).doc],
  ];
  it.each(docs)('%s', (_n, build) => {
    const src = build();
    const written = composeV2({ source: src, skeleton: skeletonInput(), params: defaultParams(), assets: { ['a'.repeat(64)]: { mime: 'image/png', widthPx: 10, heightPx: 10 } } });
    const stored = json(written.snapshot);
    const rows = json(written.rows);
    expect(canonicalSha256(stored)).toBe(written.snapshotSha256);
    const r = reconstruct(stored, rows);
    expect(r.source).toEqual(json(src));
    expect(r.sha).toBe(written.snapshotSha256);
    expect(computeStructureSha256(r.again.snapshot.skeleton, r.again.rows)).toBe(written.structureSha256);
  });
  it('dokumen v1 (fixture paritas) lewat adaptor lalu compose: rekonstruksi sha sama', () => {
    const v1 = JSON.parse(readFileSync(path.resolve(__dirname, '../_fixtures/tests/parity/fixtures/doc/doc_terbit_report.json'), 'utf8'));
    v1.template = { slug: 'datum-gsp', version: 1 };
    const a = adaptV1({ document: v1 } as never, 'strip', false);
    // Aset base64 disimpan SR-19 lebih dulu (di luar unit ini): ganti dengan assetRef sha isinya.
    const refs: Record<string, { assetRef: string }> = {};
    const assets: Record<string, { mime: 'image/png' | 'image/jpeg' }> = {};
    for (const [k, x] of Object.entries(a.doc.assets ?? {}) as Array<[string, any]>) {
      const sha = x.assetRef ? String(x.assetRef).slice(7) : createHash('sha256').update(Buffer.from(x.dataBase64, 'base64')).digest('hex');
      refs[k] = { assetRef: `sha256:${sha}` };
      assets[sha] = { mime: x.mime ?? 'image/png' };
    }
    const src = merge({ ...a.doc, assets: refs }, undefined, { tier: 'TERBIT' }).doc;
    const written = composeV2({ source: src, skeleton: skeletonInput(), params: defaultParams(), tier: 'TERBIT', assets });
    const r = reconstruct(json(written.snapshot), json(written.rows));
    expect(r.sha).toBe(written.snapshotSha256);
  });
  it('negatif: baris M17 dirusak (isi blok berubah) -> sha berbeda', () => {
    const written = composeV2({ source: merge(e1()).doc, skeleton: skeletonInput(), params: defaultParams() });
    const rows = json(written.rows);
    const target = rows.blocks.find((b) => b.chapterKey === '2')!;
    (target.content as { text?: string; runs?: unknown }).runs = [{ t: 'diubah diam-diam' }];
    expect(reconstruct(json(written.snapshot), rows).sha).not.toBe(written.snapshotSha256);
  });
  it('negatif: pid baris dirusak -> sha berbeda', () => {
    const written = composeV2({ source: merge(e1()).doc, skeleton: skeletonInput(), params: defaultParams() });
    const rows = json(written.rows);
    rows.blocks.find((b) => b.chapterKey === '1')!.pid = 'p-0000000000';
    expect(reconstruct(json(written.snapshot), rows).sha).not.toBe(written.snapshotSha256);
  });
  it('compose deterministik: dua kali compose sumber sama -> sha sama', () => {
    const src = merge(e1()).doc;
    const a = composeV2({ source: src, skeleton: skeletonInput(), params: defaultParams() });
    const b = composeV2({ source: json(src), skeleton: skeletonInput(), params: defaultParams() });
    expect(b.snapshotSha256).toBe(a.snapshotSha256);
  });
});
