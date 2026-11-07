// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/structure/fixh2-overwrite-pure.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
/* eslint-disable @typescript-eslint/no-explicit-any -- fixture konten v2 bebas-bentuk di uji */
// FIX-H2 (D-321/D-322, Hermes C2): pembantu murni aturan "kiriman tidak menimpa suntingan PATCH".
// `@/lib/prisma` diganti tiruan yang MELEMPAR: uji ini tidak pernah menyentuh DB.
import { describe, expect, it, vi } from '../_vitest';

vi.mock('@/lib/prisma', () => ({
  prisma: new Proxy({}, { get: () => { throw new Error('FIX-H2: akses DB dilarang di uji unit'); } }),
}));

import {
  changedChapterPids,
  isSubmissionRevision,
  lastPidEdits,
  overwriteForwardText,
  parseScopes,
  referenceRevision,
  type RevisionScopeRow,
} from '@/lib/studio/services/submit/overwrite';

const rev = (revisionNo: number, changeScope: string | null, createdBy = 'agent:a'): RevisionScopeRow => ({ revisionNo, changeScope, createdBy, parentRevisionNo: revisionNo - 1 });

// Riwayat uji Hermes: rev 1-2 kiriman bab, rev 3-7 slot, rev 8 PATCH pid bab 4.
const HERMES: RevisionScopeRow[] = [
  rev(1, 'create;chapter:3'),
  rev(2, 'chapter:4'),
  rev(3, 'structure:setOutline', 'agent:h'),
  rev(4, 'slot:cover'),
  rev(5, 'slot:controlSheet'),
  rev(6, 'slot:signature'),
  rev(7, 'slot:references'),
  rev(8, 'pid:p-m1m7wa9k3s', 'agent:hermes'),
];

function doc(chapters: any[]): any {
  return { $schema: 'studio.doc/v2', template: { slug: 't', version: 1 }, meta: {}, sections: { content: { type: 'chapter', chapters } } };
}
function ch(key: string, texts: string[], ids: string[]): any {
  return { id: `bab-${key}`, key, title: { text: `Bab ${key}` }, sections: [{ id: `s-${key}`, title: { text: 'Bagian' }, blocks: texts.map((t, j) => ({ id: ids[j], type: 'paragraph', text: t })) }] };
}

describe('klasifikasi revisi dan acuan lingkup', () => {
  it('parseScopes / isSubmissionRevision: pid:/structure:/meta = sunting; chapter/slot/create/document/null = kiriman', () => {
    expect(parseScopes('document;chapter:1;slot:cover')).toEqual(['document', 'chapter:1', 'slot:cover']);
    expect(parseScopes(null)).toEqual([]);
    for (const s of ['create;chapter:3', 'chapter:4', 'slot:cover', 'document;chapter:1', null]) expect(isSubmissionRevision(s)).toBe(true);
    for (const s of ['pid:p-1', 'pid:p-1;pid:p-2', 'structure:setOutline', 'structure:renumberChapters', 'meta']) expect(isSubmissionRevision(s)).toBe(false);
  });

  it('referenceRevision = kiriman terakhir lingkup itu (bukan kiriman lingkup lain sesudahnya); ingest utuh tanpa changeScope berlaku untuk semua', () => {
    expect(referenceRevision(HERMES, 'chapter:4', 8)).toBe(2);
    expect(referenceRevision(HERMES, 'chapter:3', 8)).toBe(1);
    expect(referenceRevision(HERMES, 'slot:cover', 8)).toBe(4);
    expect(referenceRevision(HERMES, 'chapter:9', 8)).toBe(0);
    expect(referenceRevision([rev(1, null), rev(2, 'pid:p-x')], 'chapter:1', 2)).toBe(1);
    // batas n dihormati
    expect(referenceRevision([...HERMES, rev(9, 'chapter:4')], 'chapter:4', 8)).toBe(2);
  });

  it('lastPidEdits: revisi sunting terakhir per pid (pid baru sisipan ikut), revisi kiriman diabaikan', () => {
    const m = lastPidEdits([...HERMES, rev(9, 'pid:p-a;pid:p-new'), rev(10, 'pid:p-m1m7wa9k3s', 'agent:b'), rev(11, 'chapter:4')], 11);
    expect(m.get('p-m1m7wa9k3s')).toMatchObject({ rev: 10, by: 'agent:b', parent: 9 });
    expect(m.get('p-new')).toMatchObject({ rev: 9 });
    expect(m.has('chapter:4')).toBe(false);
    expect(lastPidEdits(HERMES, 7).size).toBe(0);
  });
});

describe('changedChapterPids: pid yang keadaannya diubah kiriman', () => {
  const current = doc([ch('4', ['satu', '93 menit', 'tiga'], ['p-1', 'p-2', 'p-3']), ch('5', ['x'], ['p-9'])]);

  it('kiriman lama (94 menit) mengubah p-2 saja; bab lain tidak dihitung', () => {
    const merged = doc([ch('4', ['satu', '94 menit', 'tiga'], ['p-1', 'p-2', 'p-3']), ch('5', ['y'], ['p-9'])]);
    expect([...changedChapterPids(current, merged, new Set(['4']))]).toEqual([['p-2', '4']]);
  });

  it('isi sama (suntingan sudah digabung) -> tidak ada pid berubah', () => {
    expect(changedChapterPids(current, doc([ch('4', ['satu', '93 menit', 'tiga'], ['p-1', 'p-2', 'p-3'])]), new Set(['4'])).size).toBe(0);
  });

  it('pid hilang dan pindah posisi dihitung berubah; judul section dan bab ikut', () => {
    const moved = doc([ch('4', ['tiga', '93 menit'], ['p-3', 'p-2'])]);
    const r = changedChapterPids(current, moved, new Set(['4']));
    expect([...r.keys()].sort()).toEqual(['p-1', 'p-3']);
    const retitled = structuredClone(current);
    retitled.sections.content.chapters[0].title = { text: 'Judul baru' };
    retitled.sections.content.chapters[0].sections[0].title = { text: 'Bagian baru' };
    expect([...changedChapterPids(current, retitled, new Set(['4'])).keys()].sort()).toEqual(['bab-4', 's-4']);
  });
});

describe('teks awam forwardToController', () => {
  it('menyebut jumlah, alamat, GET /content, dan baseRevisionNo terbaru', () => {
    const t = overwriteForwardText('doc-1', [{ pid: 'p-2', address: '4.3.1', editedInRevision: 8, editedBy: 'agent:hermes', scope: 'chapter:4', referenceRevisionNo: 2 }], 8);
    expect(t).toContain('1 paragraf (4.3.1)');
    expect(t).toContain('GET /api/studio/documents/doc-1/content');
    expect(t).toContain('baseRevisionNo 8');
  });
});
