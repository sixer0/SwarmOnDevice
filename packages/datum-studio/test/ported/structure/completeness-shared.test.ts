// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/structure/completeness-shared.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
// FIX-V (SR-55 M6): state slot E29, urutan kunci bab, dan kunci bab yang diharapkan SATU
// SUMBER di `services/completeness`; compose (`compose/snapshot.ts`) dan R05 (state cadangan)
// mengimpornya. Harapan diturunkan dari tabel register §8.1/§8.2 (fungsi `spec81` di bawah),
// bukan dari kode, lalu dibandingkan dengan tiga pintu masuk: laporan `computeCompleteness`,
// `slotStateOf` (dipakai R05), dan `compose.slotState` (state kerangka snapshot).
import { describe, expect, it } from '../_vitest';
import {
  compareChapterKeys,
  computeCompleteness,
  expectedChapterKeys,
  isSlotPayloadFilled,
  slotStateOf,
  type CompletenessSlotInput,
} from '@/lib/studio/services/completeness';
import {
  compareChapterKeys as composeCompareChapterKeys,
  expectedChapterKeys as composeExpectedChapterKeys,
  slotState as composeSlotState,
} from '@/lib/studio/services/compose';
import type { StudioSlotContentMode, StudioSlotState, TemplateSlotDef } from '@/lib/studio/contract';

const DOC = { docId: 'doc-m6', docNumber: '009/GSP/KT/X/2026', missionFolder: null, docKey: null };
const MODES: StudioSlotContentMode[] = ['INPUT', 'MIXED', 'AUTO'];

interface Case {
  name: string;
  sectionType: string;
  repeatable: boolean;
  required: boolean;
  contentMode: StudioSlotContentMode;
  /** Tak-berulang: payload terisi. */
  filled?: boolean;
  chapterKeys?: string[];
  outline?: string[];
  minItems?: number;
}

/** Tabel §8.1 (dievaluasi berurutan) + §8.2, ditulis ulang dari register. */
function spec81(c: Case): StudioSlotState {
  const keys = c.chapterKeys ?? [];
  const filled = c.repeatable ? keys.length > 0 : c.filled === true;
  if (c.contentMode === 'AUTO') return 'AUTO_READY';
  if (c.contentMode === 'MIXED' && !filled) return 'AUTO_READY';
  if (!c.repeatable) return filled ? 'FILLED' : c.required ? 'EMPTY' : 'OPTIONAL_EMPTY';
  if (keys.length === 0) return c.required ? 'EMPTY' : 'OPTIONAL_EMPTY';
  let expected: string[];
  if (c.outline && c.outline.length > 0) expected = c.outline;
  else if (c.sectionType === 'appendix') {
    const max = Math.max(...keys.map((k) => k.charCodeAt(0) - 64));
    expected = Array.from({ length: max }, (_, i) => String.fromCharCode(65 + i));
  } else {
    const max = Math.max(...keys.map(Number));
    expected = Array.from({ length: max }, (_, i) => String(i + 1));
  }
  const missing = expected.filter((k) => !keys.includes(k));
  return missing.length > 0 || keys.length < (c.minItems ?? 0) ? 'PARTIAL' : 'FILLED';
}

function cases(): Case[] {
  const out: Case[] = [];
  for (const contentMode of MODES) {
    for (const required of [true, false]) {
      const r = required ? 'wajib' : 'opsional';
      out.push({ name: `tak-berulang ${contentMode} ${r} kosong`, sectionType: 'controlSheet', repeatable: false, required, contentMode, filled: false });
      out.push({ name: `tak-berulang ${contentMode} ${r} terisi`, sectionType: 'controlSheet', repeatable: false, required, contentMode, filled: true });
      out.push({ name: `berulang ${contentMode} ${r} 0 bab`, sectionType: 'chapter', repeatable: true, required, contentMode, chapterKeys: [] });
      out.push({ name: `berulang ${contentMode} ${r} bab 1,2`, sectionType: 'chapter', repeatable: true, required, contentMode, chapterKeys: ['2', '1'] });
      out.push({ name: `berulang ${contentMode} ${r} celah 1,3`, sectionType: 'chapter', repeatable: true, required, contentMode, chapterKeys: ['3', '1'] });
      out.push({ name: `berulang ${contentMode} ${r} < minItems`, sectionType: 'chapter', repeatable: true, required, contentMode, chapterKeys: ['1'], minItems: 2 });
      out.push({ name: `berulang ${contentMode} ${r} outline 1..3 berisi 1,2`, sectionType: 'chapter', repeatable: true, required, contentMode, chapterKeys: ['1', '2'], outline: ['1', '2', '3'] });
      out.push({ name: `berulang ${contentMode} ${r} bab di luar outline`, sectionType: 'chapter', repeatable: true, required, contentMode, chapterKeys: ['1', '9'], outline: ['1'] });
      out.push({ name: `lampiran ${contentMode} ${r} A,C`, sectionType: 'appendix', repeatable: true, required, contentMode, chapterKeys: ['C', 'A'] });
      out.push({ name: `lampiran ${contentMode} ${r} A,B`, sectionType: 'appendix', repeatable: true, required, contentMode, chapterKeys: ['A', 'B'] });
    }
  }
  return out;
}

const outlineOf = (c: Case) => (c.outline ? c.outline.map((key) => ({ key, title: { text: `Bab ${key}` } })) : undefined);

function reportState(c: Case): StudioSlotState {
  const keys = c.chapterKeys ?? [];
  const slot: CompletenessSlotInput = {
    slotKey: 's',
    sectionType: c.sectionType,
    label: 'S',
    required: c.required,
    repeatable: c.repeatable,
    minItems: c.minItems ?? null,
    contentMode: c.contentMode,
    active: true,
    row: {
      filled: c.repeatable ? keys.length > 0 : c.filled === true,
      payload: c.repeatable ? { outline: outlineOf(c) } : c.filled ? { type: c.sectionType, title: { text: 'isi' } } : null,
      lastFilledBy: null,
      lastFilledAt: null,
      lastFilledRevisionNo: null,
    },
    ...(c.repeatable ? { chapters: keys.map((key) => ({ key, pid: `bab-${key}`, by: 'agen', at: '2026-10-23T01:00:00Z', revisionNo: 2 })) } : {}),
  };
  return computeCompleteness({ revisionNo: 2, slots: [slot], doc: DOC }).slots[0].state;
}

function composeState(c: Case): StudioSlotState {
  const def: TemplateSlotDef = {
    slotKey: 's',
    sectionType: c.sectionType,
    label: 'S',
    position: 1,
    required: c.required,
    positionLocked: false,
    repeatable: c.repeatable,
    ...(c.minItems !== undefined ? { minItems: c.minItems } : {}),
    contentMode: c.contentMode,
    tiers: [],
    admits: [],
    essentials: {},
  };
  const keys = c.chapterKeys ?? [];
  const payload = c.repeatable
    ? { type: c.sectionType, chapters: keys.map((key) => ({ key, title: { text: `Bab ${key}` }, sections: [] })), ...(c.outline ? { outline: outlineOf(c) } : {}) }
    : c.filled
      ? { type: c.sectionType, title: { text: 'isi' } }
      : undefined;
  return composeSlotState(def, payload, false);
}

describe('M6: tabel §8.1 berulang x contentMode, satu sumber', () => {
  const all = cases();
  it('matriks memuat 3 mode x 2 keharusan x 10 bentuk', () => expect(all.length).toBe(60));
  it.each(all.map((c) => [c.name, c] as const))('%s', (_n, c) => {
    const want = spec81(c);
    expect(reportState(c)).toBe(want);
    expect(
      slotStateOf({
        sectionType: c.sectionType,
        required: c.required,
        repeatable: c.repeatable,
        contentMode: c.contentMode,
        minItems: c.minItems ?? null,
        omitted: false,
        filled: c.repeatable ? (c.chapterKeys ?? []).length > 0 : c.filled === true,
        ...(c.repeatable && c.outline ? { outline: outlineOf(c) } : {}),
        chapterKeys: c.chapterKeys ?? [],
      }),
    ).toBe(want);
    expect(composeState(c)).toBe(want);
  });

  it('slot opsional tanpa baris M14 = OMITTED; wajib tanpa baris tidak pernah OMITTED', () => {
    const base = { sectionType: 'controlSheet', repeatable: false, contentMode: 'INPUT' as const, omitted: true, filled: false };
    expect(slotStateOf({ ...base, required: false })).toBe('OMITTED');
    expect(slotStateOf({ ...base, required: true })).toBe('EMPTY');
  });
});

describe('M6: urutan dan kunci bab yang diharapkan satu sumber', () => {
  it('compose memakai fungsi urutan yang sama (bukan salinan)', () => {
    expect(composeCompareChapterKeys).toBe(compareChapterKeys);
    expect(['10', 'B', '2', 'A', '1'].sort(compareChapterKeys)).toEqual(['1', '2', '10', 'A', 'B']);
  });
  it.each<[string, string, { key: string }[] | undefined, string[], string[], 'outline' | 'contiguous']>([
    ['bab kontigu dari kunci terbesar', 'chapter', undefined, ['3', '1'], ['1', '2', '3'], 'contiguous'],
    ['lampiran kontigu A..huruf terbesar', 'appendix', undefined, ['C'], ['A', 'B', 'C'], 'contiguous'],
    ['0 bab = []', 'chapter', undefined, [], [], 'contiguous'],
    ['outline menang, kunci ganda dibuang', 'chapter', [{ key: '1' }, { key: '2' }, { key: '1' }], ['5'], ['1', '2'], 'outline'],
    ['outline kosong = kontigu', 'chapter', [], ['2'], ['1', '2'], 'contiguous'],
  ])('%s', (_n, sectionType, outline, present, expected, source) => {
    expect(expectedChapterKeys(sectionType, outline, present)).toEqual({ expected, source });
    expect(composeExpectedChapterKeys({ sectionType }, outline, present)).toEqual({ expected, source });
  });
  it('isSlotPayloadFilled = aturan M14.filled (medan selain type)', () => {
    expect(isSlotPayloadFilled(undefined)).toBe(false);
    expect(isSlotPayloadFilled(null)).toBe(false);
    expect(isSlotPayloadFilled({ type: 'toc' })).toBe(false);
    expect(isSlotPayloadFilled({ type: 'toc', title: { text: 'Daftar isi' } })).toBe(true);
  });
});
