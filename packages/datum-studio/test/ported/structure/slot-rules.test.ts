// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/structure/slot-rules.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
// SR-44 / SC-4: 10 aturan SLOT_* (blueprint 05 §2.7, register §11.2) + BLOCK_TYPE_NOT_ADMITTED
// dan CHAPTER_KEY_INVALID. Seam: `validateStructure` / `mergeSubmission` (compose, murni),
// `validateSkeleton` dan `checkTemplateWrite` (skeleton, murni). Setiap kode: kasus negatif
// (kode, HTTP, details) + kasus positif pembanding. Tanpa DB.
import { describe, expect, it } from '../_vitest';
import { STUDIO_ERROR_HTTP, type StudioDocV2Resolved } from '@/lib/studio/contract';
import { mergeSubmission, seededPidAllocator, validateStructure } from '@/lib/studio/services/compose';
import { checkTemplateWrite } from '@/lib/studio/services/skeleton/access';
import { validateSkeleton } from '@/lib/studio/services/skeleton/skeleton';
import { catchEngine, DATUM_ORDER, datumSlots, e1, skeletonInput, withSlot } from './_kit';

const SKEL = skeletonInput();
const order = (...keys: string[]) => ({ structure: { order: keys } });
const without = (k: string) => DATUM_ORDER.filter((x) => x !== k);
const ch = (key: string, blocks: unknown[] = [{ type: 'paragraph', text: 'isi' }]) => ({ key, title: { text: `Bab ${key}` }, sections: [{ title: { text: 'S' }, blocks }] });

function expect422(err: ReturnType<typeof catchEngine>, code: string) {
  expect(err.code).toBe(code);
  expect(err.httpStatus).toBe(422);
  expect(err.message.length).toBeGreaterThan(10);
}

describe('baseline positif', () => {
  it('E1 lengkap + urutan kerangka sah untuk TERBIT', () => {
    const d = e1();
    expect(() => validateStructure(SKEL, 'TERBIT', { structure: { order: DATUM_ORDER }, sections: d.sections })).not.toThrow();
  });
  it('slot opsional boleh di-OMIT (references) tanpa menggeser slot terkunci (appendices)', () => {
    expect(() => validateStructure(SKEL, 'TERBIT', order(...without('references')))).not.toThrow();
  });
  it('NOTA: slot SL-01..SL-04 tidak aktif dan tidak wajib', () => {
    expect(() => validateStructure(SKEL, 'NOTA', order('content', 'references', 'appendices'))).not.toThrow();
  });
});

describe('1. SLOT_UNKNOWN (422)', () => {
  it('kunci di structure.order di luar kerangka -> pointer order/i + daftar kunci', () => {
    const e = catchEngine(() => validateStructure(SKEL, 'TERBIT', order(...DATUM_ORDER, 'lampiranX')));
    expect422(e, 'SLOT_UNKNOWN');
    expect(e.details).toMatchObject({ slotKey: 'lampiranX', pointer: '/structure/order/7', known: DATUM_ORDER });
  });
  it('isi untuk slot tak dikenal di sections -> pointer /sections/<k>', () => {
    const e = catchEngine(() => validateStructure(SKEL, 'TERBIT', { sections: { ringkasan: { type: 'toc' } } }));
    expect422(e, 'SLOT_UNKNOWN');
    expect(e.details).toMatchObject({ slotKey: 'ringkasan', pointer: '/sections/ringkasan' });
  });
  it('isi untuk slot yang di-OMIT structure -> SLOT_UNKNOWN omitted:true', () => {
    const e = catchEngine(() =>
      validateStructure(SKEL, 'TERBIT', { ...order(...without('references')), sections: { references: e1().sections.references } }),
    );
    expect422(e, 'SLOT_UNKNOWN');
    expect(e.details).toMatchObject({ slotKey: 'references', omitted: true });
  });
  it('urutan evaluasi: kunci tak dikenal dilaporkan sebelum duplikat', () => {
    const e = catchEngine(() => validateStructure(SKEL, 'TERBIT', order(...DATUM_ORDER, 'content', 'bogus')));
    expect(e.code).toBe('SLOT_UNKNOWN');
  });
});

describe('2. SLOT_DUPLICATE (422)', () => {
  it('kunci ganda di structure.order -> posisi 1-based', () => {
    const e = catchEngine(() => validateStructure(SKEL, 'TERBIT', order(...DATUM_ORDER, 'references')));
    expect422(e, 'SLOT_DUPLICATE');
    expect(e.details).toEqual({ slotKey: 'references', positions: [6, 8] });
  });
  it('slotKey ganda di kerangka templat (validateSkeleton) -> SLOT_DUPLICATE', () => {
    const slots = datumSlots();
    slots[5] = { ...slots[5], slotKey: 'content' };
    const e = catchEngine(() => validateSkeleton({ slots }));
    expect422(e, 'SLOT_DUPLICATE');
    expect(e.details).toMatchObject({ slotKey: 'content', positions: [5, 6] });
  });
});

describe('3. SLOT_FORBIDDEN_FOR_TIER (422)', () => {
  it('slot TERBIT/SERAH disebut di structure.order dokumen NOTA', () => {
    const e = catchEngine(() => validateStructure(SKEL, 'NOTA', order('cover', 'content')));
    expect422(e, 'SLOT_FORBIDDEN_FOR_TIER');
    expect(e.details).toEqual({ slotKey: 'cover', tier: 'NOTA', activeTiers: ['TERBIT', 'SERAH'] });
  });
  it('isi slot tidak aktif untuk tier (sections.controlSheet pada NOTA)', () => {
    const e = catchEngine(() => validateStructure(SKEL, 'NOTA', { sections: { controlSheet: e1().sections.controlSheet } }));
    expect422(e, 'SLOT_FORBIDDEN_FOR_TIER');
    expect(e.details).toMatchObject({ slotKey: 'controlSheet', tier: 'NOTA' });
  });
});

describe('4. SLOT_REQUIRED_MISSING (422)', () => {
  it('structure tanpa slot wajib aktif -> missing + label di pesan', () => {
    const e = catchEngine(() => validateStructure(SKEL, 'TERBIT', order(...without('toc'))));
    expect422(e, 'SLOT_REQUIRED_MISSING');
    expect(e.details).toEqual({ missing: ['toc'] });
    expect(e.message).toContain('Daftar Isi');
  });
  it('isi kosong BUKAN galat (INCOMPLETE): sections tanpa content tetap sah', () => {
    expect(() => validateStructure(SKEL, 'TERBIT', { structure: { order: DATUM_ORDER }, sections: {} })).not.toThrow();
  });
});

describe('5. SLOT_POSITION_LOCKED (422)', () => {
  it('appendices (terkunci) dipindah sebelum references', () => {
    const e = catchEngine(() => validateStructure(SKEL, 'TERBIT', order('cover', 'controlSheet', 'signature', 'toc', 'content', 'appendices', 'references')));
    expect422(e, 'SLOT_POSITION_LOCKED');
    expect(e.details).toMatchObject({ slotKey: 'appendices' });
  });
  it('cover (terkunci) dipindah setelah controlSheet', () => {
    const e = catchEngine(() => validateStructure(SKEL, 'TERBIT', order('controlSheet', 'cover', 'signature', 'toc', 'content', 'references', 'appendices')));
    expect422(e, 'SLOT_POSITION_LOCKED');
    expect(e.details).toMatchObject({ slotKey: 'cover', expectedBefore: [], actualBefore: ['controlSheet'] });
  });
  it('positif: slot tidak terkunci (signature) boleh dipindah', () => {
    expect(() => validateStructure(SKEL, 'TERBIT', order('cover', 'signature', 'controlSheet', 'toc', 'content', 'references', 'appendices'))).not.toThrow();
  });
});

describe('6. SLOT_TYPE_MISMATCH (422)', () => {
  it('payload type != sectionType slot', () => {
    const e = catchEngine(() => validateStructure(SKEL, 'TERBIT', { sections: { controlSheet: { type: 'toc' } } }));
    expect422(e, 'SLOT_TYPE_MISMATCH');
    expect(e.details).toEqual({ slotKey: 'controlSheet', expected: 'controlSheet', actual: 'toc' });
  });
  it('kiriman bab ke slot tak-berulang', () => {
    const e = catchEngine(() => validateStructure(SKEL, 'TERBIT', { chapter: { slot: 'controlSheet', chapter: ch('3') as never } }));
    expect422(e, 'SLOT_TYPE_MISMATCH');
    expect(e.details).toMatchObject({ slotKey: 'controlSheet', actual: 'chapter' });
  });
});

describe('7. SLOT_INPUT_NOT_ACCEPTED (422)', () => {
  it('isi entries ke slot toc AUTO', () => {
    const e = catchEngine(() =>
      validateStructure(SKEL, 'TERBIT', { sections: { toc: { type: 'toc', entries: [{ level: 'chapter', title: { text: 'x' }, page: '1' }] } } }),
    );
    expect422(e, 'SLOT_INPUT_NOT_ACCEPTED');
    expect(e.details).toEqual({ slotKey: 'toc', contentMode: 'AUTO', fields: ['entries'] });
  });
  it('positif: toc MIXED menerima entries statis', () => {
    const skel = skeletonInput(withSlot('toc', { contentMode: 'MIXED' }));
    expect(() =>
      validateStructure(skel, 'TERBIT', { sections: { toc: { type: 'toc', entries: [{ level: 'chapter', title: { text: 'x' }, page: '1' }] } } }),
    ).not.toThrow();
  });
});

describe('8. SLOT_ITEMS_OUT_OF_RANGE (422)', () => {
  it('jumlah bab melebihi maxItems', () => {
    const skel = skeletonInput(withSlot('content', { maxItems: 1 }));
    const e = catchEngine(() => validateStructure(skel, 'TERBIT', { sections: { content: { type: 'chapter', chapters: [ch('1'), ch('2')] } } }));
    expect422(e, 'SLOT_ITEMS_OUT_OF_RANGE');
    expect(e.details).toEqual({ slotKey: 'content', maxItems: 1, count: 2 });
  });
  it('jumlah SESUDAH penggabungan (bab baru ke dokumen yang sudah penuh) lewat mergeSubmission', () => {
    const skel = skeletonInput(withSlot('content', { maxItems: 1 }));
    const current: StudioDocV2Resolved = {
      $schema: 'studio.doc/v2',
      template: { slug: 'datum-gsp', version: 1 },
      meta: { title: 'T', rev: 'A', typeCode: 'KT', tier: 'TERBIT', classification: 'BIASA', language: 'ID', author: 'a', issueDate: '2026-10-23' },
      sections: { content: { type: 'chapter', chapters: [{ ...ch('1'), id: 'bab-1' } as never] } },
    };
    const e = catchEngine(() =>
      mergeSubmission(current, { $schema: 'studio.chapter/v2', target: { documentId: 'd' }, chapter: ch('2') } as never, {
        skeleton: skel,
        tier: 'TERBIT',
        pids: seededPidAllocator('t'),
      }),
    );
    expect422(e, 'SLOT_ITEMS_OUT_OF_RANGE');
    expect(e.details).toMatchObject({ count: 2, maxItems: 1 });
  });
});

describe('9. SLOT_USE_CHAPTER_ENDPOINT (422)', () => {
  it('kiriman slot (/slots) ke slot berulang', () => {
    const e = catchEngine(() => validateStructure(SKEL, 'TERBIT', { slot: { slot: 'content', payload: { type: 'chapter', chapters: [] } as never } }));
    expect422(e, 'SLOT_USE_CHAPTER_ENDPOINT');
    expect(e.details).toEqual({ slotKey: 'content', use: 'POST /api/studio/chapters' });
  });
});

describe('10. SLOT_PARAM_SCOPE_INVALID (422)', () => {
  it('validateSkeleton: kunci cakupan document di parameter slot cover', () => {
    const e = catchEngine(() => validateSkeleton({ slots: withSlot('cover', { essentials: { 'page.size': 'A4' } }) }));
    expect422(e, 'SLOT_PARAM_SCOPE_INVALID');
    expect(e.details).toMatchObject({ slotKey: 'cover', paramKey: 'page.size', scope: 'document' });
  });
  it('checkTemplateWrite: perubahan kunci slot di luar cakupan', () => {
    const e = catchEngine(() =>
      checkTemplateWrite({ kind: 'ADMIN_SESSION' }, { isPreset: false, restricted: false }, [
        { key: 'page.size', value: 'A5', previous: undefined, slot: { slotKey: 'cover', sectionType: 'cover', admits: [] } },
      ]),
    );
    expect422(e, 'SLOT_PARAM_SCOPE_INVALID');
    expect(e.details).toMatchObject({ keys: ['page.size'], slotKey: 'cover' });
  });
  it('positif: page.orientation (cakupan slot) di slot lampiran diterima', () => {
    expect(() => validateSkeleton({ slots: withSlot('appendices', { essentials: { 'page.orientation': 'landscape' } }) })).not.toThrow();
  });
});

describe('BLOCK_TYPE_NOT_ADMITTED (422)', () => {
  it('jenis blok di luar admits slot -> pointer blok', () => {
    const skel = skeletonInput(withSlot('content', { admits: ['paragraph'] }));
    const table = { type: 'table', columns: [{ role: 'text' }], rows: [{ cells: [{ text: 'a' }] }] };
    const e = catchEngine(() => validateStructure(skel, 'TERBIT', { sections: { content: { type: 'chapter', chapters: [ch('1', [{ type: 'paragraph', text: 'a' }, table])] } } }));
    expect422(e, 'BLOCK_TYPE_NOT_ADMITTED');
    expect(e.details).toEqual({ slotKey: 'content', pointer: '/sections/content/chapters/0/sections/0/blocks/1', type: 'table' });
  });
  it('juga di intro bab', () => {
    const skel = skeletonInput(withSlot('content', { admits: ['paragraph'] }));
    const c = { ...ch('1'), intro: [{ type: 'list', items: [{ text: 'a' }] }] };
    const e = catchEngine(() => validateStructure(skel, 'TERBIT', { sections: { content: { type: 'chapter', chapters: [c] } } }));
    expect(e.code).toBe('BLOCK_TYPE_NOT_ADMITTED');
    expect(e.details).toMatchObject({ pointer: '/sections/content/chapters/0/intro/0' });
  });
});

describe('CHAPTER_KEY_INVALID (422)', () => {
  it.each([
    ['content', '01', 'chapter'],
    ['content', 'A', 'chapter'],
    ['appendices', '1', 'appendix'],
    ['appendices', 'aa', 'appendix'],
  ])('slot %s kunci %s ditolak', (slotKey, key, type) => {
    const e = catchEngine(() => validateStructure(SKEL, 'TERBIT', { sections: { [slotKey]: { type, chapters: [ch(key)] } } }));
    expect422(e, 'CHAPTER_KEY_INVALID');
    expect(e.details).toMatchObject({ slotKey, key, pointer: `/sections/${slotKey}/chapters/0/key` });
  });
  it('kunci ganda dalam slot', () => {
    const e = catchEngine(() => validateStructure(SKEL, 'TERBIT', { sections: { content: { type: 'chapter', chapters: [ch('2'), ch('2')] } } }));
    expect(e.code).toBe('CHAPTER_KEY_INVALID');
  });
  it('HTTP 422 untuk seluruh 12 kode struktur', () => {
    for (const c of [
      'SLOT_UNKNOWN', 'SLOT_REQUIRED_MISSING', 'SLOT_DUPLICATE', 'SLOT_POSITION_LOCKED', 'SLOT_TYPE_MISMATCH', 'SLOT_FORBIDDEN_FOR_TIER',
      'SLOT_INPUT_NOT_ACCEPTED', 'SLOT_ITEMS_OUT_OF_RANGE', 'SLOT_USE_CHAPTER_ENDPOINT', 'SLOT_PARAM_SCOPE_INVALID', 'BLOCK_TYPE_NOT_ADMITTED', 'CHAPTER_KEY_INVALID',
    ] as const) {
      expect(STUDIO_ERROR_HTTP[c], c).toBe(422);
    }
  });
});
