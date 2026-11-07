// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/structure/pid-identity.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
// SR-44: identitas pid (register §10, KD-13, KD-22): pembentukan, pertahankan (kiriman ulang /
// sunting), pensiun (tidak dapat dipakai ulang), geser (alamat berubah, pid tetap), PID_CONFLICT,
// PID_NOT_FOUND. Seam: `mergeSubmission`, `composeV2`, `applyPidOp`, pembangkit pid murni.
import { describe, expect, it } from '../_vitest';
import { PID_PATTERN, type ChapterV2, type StudioDocV2Resolved } from '@/lib/studio/contract';
import { composeV2, defaultChapterPid, seededPidAllocator } from '@/lib/studio/services/compose';
import { applyPidOp } from '@/lib/studio/services/revisions/v2/ops';
import { chapterPidBase, crockford, randomPid, seededPid } from '@/lib/studio/services/structure/pid';
import { catchEngine, defaultParams, e1, merge, skeletonInput } from './_kit';

const GENERATED = /^p-[0-9abcdefghjkmnpqrstvwxyz]{10}$/;
const PID_RE = new RegExp(PID_PATTERN);

function chapterOf(doc: StudioDocV2Resolved, key: string): ChapterV2 {
  for (const p of Object.values(doc.sections ?? {})) {
    const hit = ((p as { chapters?: ChapterV2[] }).chapters ?? []).find((c) => c.key === key);
    if (hit) return hit;
  }
  throw new Error(`bab ${key} tidak ada`);
}
const allPids = (doc: StudioDocV2Resolved): string[] =>
  Object.values(doc.sections ?? {}).flatMap((p) =>
    ((p as { chapters?: ChapterV2[] }).chapters ?? []).flatMap((c) => [c.id!, ...(c.intro ?? []).map((b) => b.id!), ...c.sections.flatMap((s) => [s.id!, ...s.blocks.map((b) => b.id!)])]),
  );
const chapterSub = (chapter: unknown, extra: Record<string, unknown> = {}) => ({ $schema: 'studio.chapter/v2', target: { documentId: 'd1' }, chapter, ...extra });
const strip = <T,>(c: T): T => JSON.parse(JSON.stringify(c, (k, v) => (k === 'id' ? undefined : v)));

describe('pembentukan pid (§10)', () => {
  const r = merge(e1());
  it('bab: bab-<k> / lamp-<k kecil>; section dan blok: bangkitan p- + 10 base32 Crockford', () => {
    expect(chapterOf(r.doc, '1').id).toBe('bab-1');
    expect(chapterOf(r.doc, '2').id).toBe('bab-2');
    expect(chapterOf(r.doc, 'A').id).toBe('lamp-a');
    const gen = allPids(r.doc).filter((p) => !/^(bab|lamp)-/.test(p));
    expect(gen.length).toBe(7);
    for (const p of gen) expect(p).toMatch(GENERATED);
    expect(new Set(allPids(r.doc)).size).toBe(allPids(r.doc).length);
  });
  it('lingkup kiriman tercatat per bab dan slot (§9.5)', () => {
    expect(r.scopes).toEqual(expect.arrayContaining(['chapter:1', 'chapter:2', 'chapter:A', 'slot:cover', 'slot:controlSheet']));
    expect(r.changed).toBe(true);
  });
  it('defaultChapterPid: akhiran -m terkecil yang bebas (termasuk pid pensiun)', () => {
    expect(defaultChapterPid('chapter', '3', new Set())).toBe('bab-3');
    expect(defaultChapterPid('chapter', '3', new Set(['bab-3', 'bab-3-2']))).toBe('bab-3-3');
    expect(defaultChapterPid('appendix', 'B', new Set())).toBe('lamp-b');
    expect(chapterPidBase('appendix', 'C')).toBe('lamp-c');
  });
  it('pembangkit berbenih deterministik (KD-22); acak memakai alfabet C21 50 bit', () => {
    const a = seededPidAllocator('benih');
    const b = seededPidAllocator('benih');
    const seqA = [1, 2, 3].map(() => a.next('BLOCK', 'h'));
    expect([1, 2, 3].map(() => b.next('BLOCK', 'h'))).toEqual(seqA);
    expect(new Set(seqA).size).toBe(3);
    for (const p of [...seqA, seededPid('x', 0), randomPid(), randomPid()]) {
      expect(p).toMatch(GENERATED);
      expect(p).toMatch(PID_RE);
    }
    expect(crockford(new Uint8Array([0xff, 0xff]), 3)).toBe('zzz');
  });
});

describe('pertahankan (KD-13, §9.3)', () => {
  const first = merge(e1());
  it('kiriman ulang identik TANPA id: changed=false, pid lama tetap', () => {
    const again = merge(e1(), first.doc);
    expect(again.changed).toBe(false);
    expect(again.scopes).toEqual([]);
    expect(allPids(again.doc)).toEqual(allPids(first.doc));
  });
  it('sunting isi blok: pid posisi dipertahankan, hanya lingkup bab itu berubah', () => {
    const c2 = strip(chapterOf(first.doc, '2'));
    c2.sections[0].blocks[0] = { type: 'paragraph', text: 'Suhu minyak TD-1 kini normal.' };
    const r = merge(chapterSub(c2), first.doc);
    expect(r.scopes).toEqual(['chapter:2']);
    expect(chapterOf(r.doc, '2').sections[0].blocks[0].id).toBe(chapterOf(first.doc, '2').sections[0].blocks[0].id);
    expect(chapterOf(r.doc, '1')).toEqual(chapterOf(first.doc, '1'));
  });
  it('blok berganti tipe tetap mewarisi pid posisi (tanpa memandang tipe, §10 butir 3)', () => {
    const c2 = strip(chapterOf(first.doc, '2'));
    c2.sections[0].blocks[1] = { type: 'paragraph', text: 'Tabel diganti uraian.' };
    const r = merge(chapterSub(c2), first.doc);
    expect(chapterOf(r.doc, '2').sections[0].blocks[1].id).toBe(chapterOf(first.doc, '2').sections[0].blocks[1].id);
  });
});

describe('geser: alamat berubah, pid tetap', () => {
  it('sisipan di depan dengan id klien untuk blok lama: pid pindah bersama isi; alamat bergeser', () => {
    const first = merge(e1());
    const old = chapterOf(first.doc, '2');
    const [b0, b1] = old.sections[0].blocks;
    const next = structuredClone(old);
    next.sections[0].blocks = [{ type: 'paragraph', text: 'Paragraf baru di depan.' } as never, b0, b1];
    const r = merge(chapterSub(next), first.doc);
    const blocks = chapterOf(r.doc, '2').sections[0].blocks;
    expect(blocks[1].id).toBe(b0.id);
    expect(blocks[2].id).toBe(b1.id);
    expect(blocks[0].id).toMatch(GENERATED);
    expect([b0.id, b1.id]).not.toContain(blocks[0].id);

    const params = defaultParams();
    const before = composeV2({ source: first.doc, skeleton: skeletonInput(), params });
    const after = composeV2({ source: r.doc, skeleton: skeletonInput(), params });
    const addr = (snap: typeof before, pid: string) => snap.snapshot.blocks.find((b) => b.pid === pid)?.address;
    expect(addr(before, b0.id!)).toBe('2.1.1');
    expect(addr(after, b0.id!)).toBe('2.1.2');
    // Label artefak per kunci bab mengikuti pid (Tabel 2.1 tetap milik tabel yang sama).
    expect(after.snapshot.numbering[b1.id!]).toBe('Tabel 2.1');
  });
  it('sisipan di depan TANPA id: pewarisan posisional (blok ke-j mewarisi pid ke-j lama), sisa dibangkitkan', () => {
    const first = merge(e1());
    const old = chapterOf(first.doc, '2').sections[0].blocks;
    const next = strip(chapterOf(first.doc, '2'));
    next.sections[0].blocks.unshift({ type: 'paragraph', text: 'Baru.' } as never);
    const blocks = chapterOf(merge(chapterSub(next), first.doc).doc, '2').sections[0].blocks;
    expect(blocks.slice(0, 2).map((b) => b.id)).toEqual(old.map((b) => b.id));
    expect(blocks[2].id).toMatch(GENERATED);
  });
});

describe('pensiun', () => {
  it('blok yang dihapus hilang dari pid aktif; pid pensiun tidak dapat dipakai ulang (422 PID_CONFLICT)', () => {
    const first = merge(e1());
    const c2 = strip(chapterOf(first.doc, '2'));
    const removed = chapterOf(first.doc, '2').sections[0].blocks[1].id!;
    c2.sections[0].blocks.pop();
    const r = merge(chapterSub(c2), first.doc);
    const retired = allPids(first.doc).filter((p) => !allPids(r.doc).includes(p));
    expect(retired).toEqual([removed]);

    const reuse = strip(chapterOf(r.doc, '2'));
    reuse.sections[0].blocks.push({ type: 'paragraph', id: removed, text: 'pakai ulang' } as never);
    const e = catchEngine(() => merge(chapterSub(reuse), r.doc, { retired: new Set(retired) }));
    expect(e.code).toBe('PID_CONFLICT');
    expect(e.httpStatus).toBe(422);
    expect(e.details).toEqual({ pid: removed, ownerScope: 'retired' });
  });
  it('pid bab pensiun tidak dipakai ulang: bab 3 baru setelah bab-3 pensiun -> bab-3-2', () => {
    const first = merge(e1());
    const r = merge(chapterSub({ key: '3', title: { text: 'Tiga' }, sections: [] }), first.doc, { retired: new Set(['bab-3']) });
    expect(chapterOf(r.doc, '3').id).toBe('bab-3-2');
  });
});

describe('PID_CONFLICT / PID_NOT_FOUND', () => {
  const first = merge(e1());
  it('pid klien milik bab lain -> 422 PID_CONFLICT ownerScope chapter:<k>', () => {
    const foreign = chapterOf(first.doc, '1').sections[0].blocks[0].id!;
    const c2 = strip(chapterOf(first.doc, '2'));
    c2.sections[0].blocks[0] = { type: 'paragraph', text: 'isi berubah', id: foreign } as never;
    const e = catchEngine(() => merge(chapterSub(c2), first.doc));
    expect(e.code).toBe('PID_CONFLICT');
    expect(e.details).toEqual({ pid: foreign, ownerScope: 'chapter:1' });
  });
  it('D-261 (O-1 ditutup): isi IDENTIK dengan pid klien milik bab lain tetap 422 PID_CONFLICT (klaim sebelum idempoten)', () => {
    const foreign = chapterOf(first.doc, '1').sections[0].blocks[0].id!;
    const c2 = strip(chapterOf(first.doc, '2'));
    c2.sections[0].blocks[0] = { ...c2.sections[0].blocks[0], id: foreign };
    const e = catchEngine(() => merge(chapterSub(c2), first.doc));
    expect(e.code).toBe('PID_CONFLICT');
    expect(e.details).toEqual({ pid: foreign, ownerScope: 'chapter:1' });
  });
  it('kiriman ulang identik dengan pid MILIKNYA sendiri (dari R20) tetap unchanged (KD-13)', () => {
    const again = merge(chapterSub(structuredClone(chapterOf(first.doc, '2'))), first.doc);
    expect(again.changed).toBe(false);
  });
  it('pid klien ganda dalam satu bab -> PID_CONFLICT', () => {
    const c = { key: '4', title: { text: 'Empat' }, sections: [{ title: { text: 'S' }, blocks: [{ type: 'paragraph', id: 'p-sama-01', text: 'a' }, { type: 'paragraph', id: 'p-sama-01', text: 'b' }] }] };
    const e = catchEngine(() => merge(chapterSub(c), first.doc));
    expect(e.code).toBe('PID_CONFLICT');
    expect(e.details).toMatchObject({ pid: 'p-sama-01', ownerScope: 'chapter:4' });
  });
  const ctx = { identities: new Map(), ownerOf: () => null, alloc: seededPidAllocator('ops') };
  it('PATCH move berjangkar pid tak dikenal -> 404 PID_NOT_FOUND berpointer', () => {
    const doc = structuredClone(first.doc);
    const pid = chapterOf(doc, '2').sections[0].blocks[0].id!;
    const e = catchEngine(() => applyPidOp(doc, pid, 'BLOCK', { op: 'move', to: { before: 'p-tidakada1' }, change: { what: 'a', why: 'b', impact: 'c' } } as never, ctx));
    expect(e.code).toBe('PID_NOT_FOUND');
    expect(e.httpStatus).toBe(404);
    expect(e.details).toEqual({ pid: 'p-tidakada1', pointer: '/to/before' });
  });
  it('PATCH bab pada pid yang tidak ada -> 404 PID_NOT_FOUND', () => {
    const e = catchEngine(() => applyPidOp(structuredClone(first.doc), 'bab-99', 'CHAPTER', { op: 'delete', change: { what: 'a', why: 'b', impact: 'c' } } as never, ctx));
    expect(e.code).toBe('PID_NOT_FOUND');
  });
  it('PATCH sisipan dengan id klien pensiun -> 422 PID_CONFLICT retiredRevisionNo', () => {
    const doc = structuredClone(first.doc);
    const pid = chapterOf(doc, '2').sections[0].blocks[0].id!;
    const c = { ...ctx, identities: new Map([['p-lama-0001', { retiredRevisionNo: 3 }]]) };
    const e = catchEngine(() => applyPidOp(doc, pid, 'BLOCK', { op: 'insertAfter', block: { type: 'paragraph', id: 'p-lama-0001', text: 'x' }, change: { what: 'a', why: 'b', impact: 'c' } } as never, c));
    expect(e.code).toBe('PID_CONFLICT');
    expect(e.details).toMatchObject({ pid: 'p-lama-0001', retiredRevisionNo: 3 });
  });
});
