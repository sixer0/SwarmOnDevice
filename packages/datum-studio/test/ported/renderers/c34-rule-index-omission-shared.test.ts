// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/renderers/c34-rule-index-omission-shared.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
/* eslint-disable @typescript-eslint/no-explicit-any -- snapshot v2 dibentuk bebas di uji */
// C34 tindak lanjut #1 (D-650): satu predikat penanda AUTO + satu aturan "unit slot opsional kosong
// dihilangkan" (D-299) di `front/rule-index.ts`, dipakai perakit DOCX dan HTML. Slot `signatureBlock`
// tidak pernah dihilangkan oleh aturan ini (penempatannya milik R-42 `slot.placement`), di kedua mesin.
import { beforeAll, describe, expect, it } from '../_vitest';
import type { NormBlock, NormDocSnapshot, ResolvedTemplate, TemplateSlotDef } from '@/lib/studio/contract';
import { emptyOptionalUnitOmitted, isRuleIndexAutoMarker } from '@/lib/studio/engine/front/rule-index';
import { assembleHtml } from '@/lib/studio/engine/html/assemble';
import { composeV2 } from '@/lib/studio/services/compose';
import { withParams } from '../engine-core/fixtures';
import { datumSlots, defaultParams, e1, merge, skeletonInput } from '../structure/_kit';
import { canonicalTemplate, makeCtx } from './_kit';

const FLAG = 'render.ruleIndex.fromMarkers';
const RULE: TemplateSlotDef = {
  slotKey: 'ruleIndex', sectionType: 'ruleIndex', label: 'Indeks Aturan', position: 8, required: false,
  positionLocked: false, repeatable: false, contentMode: 'AUTO', tiers: [], admits: [], essentials: {},
};

const block = (type: string, content: unknown): NormBlock =>
  ({ blockId: `b-${type}`, address: null, ordinal: 0, unitKey: 'u', type, content, textPlain: '', contentSha256: '' }) as unknown as NormBlock;
const marker = block('ruleIndex', { mode: 'auto' });
const optional = { required: false, sectionType: 'ruleIndex' };

describe('C34 #1: predikat penanda AUTO bersama', () => {
  it('penanda mode auto tanpa entri = penanda; entri terisi, mode lain, jenis lain = bukan', () => {
    expect(isRuleIndexAutoMarker(marker)).toBe(true);
    expect(isRuleIndexAutoMarker(block('ruleIndex', { mode: 'auto', entries: [] }))).toBe(true);
    expect(isRuleIndexAutoMarker(block('ruleIndex', { mode: 'auto', entries: [{ code: 'DT-01' }] }))).toBe(false);
    expect(isRuleIndexAutoMarker(block('ruleIndex', { mode: 'manual' }))).toBe(false);
    expect(isRuleIndexAutoMarker(block('ruleIndex', null))).toBe(false);
    expect(isRuleIndexAutoMarker(block('paragraph', { mode: 'auto' }))).toBe(false);
  });
});

describe('C34 #1: aturan bersama unit slot opsional kosong (D-299)', () => {
  it('slot opsional, di luar lingkup slot itu, hanya penanda (atau tanpa blok) = dihilangkan', () => {
    expect(emptyOptionalUnitOmitted(optional, [marker], { scoped: false })).toBe(true);
    expect(emptyOptionalUnitOmitted(optional, [marker, marker], { scoped: false })).toBe(true);
    expect(emptyOptionalUnitOmitted(optional, [], { scoped: false })).toBe(true);
  });

  it('slot wajib, render lingkup slot itu, atau unit berisi blok lain = tetap dirender', () => {
    expect(emptyOptionalUnitOmitted({ ...optional, required: true }, [marker], { scoped: false })).toBe(false);
    expect(emptyOptionalUnitOmitted(optional, [marker], { scoped: true })).toBe(false);
    expect(emptyOptionalUnitOmitted(optional, [marker, block('paragraph', { text: 'x' })], { scoped: false })).toBe(false);
  });

  it('slot signatureBlock tidak pernah dihilangkan oleh aturan ini', () => {
    expect(emptyOptionalUnitOmitted({ required: false, sectionType: 'signatureBlock' }, [marker], { scoped: false })).toBe(false);
    expect(emptyOptionalUnitOmitted({ required: false, sectionType: 'signatureBlock' }, [], { scoped: false })).toBe(false);
  });
});

describe('C34 #1: HTML mengikuti aturan DOCX untuk slot signatureBlock', () => {
  let tpl: ResolvedTemplate;
  beforeAll(async () => {
    tpl = await canonicalTemplate();
  });

  it('unit slot signatureBlock opsional berisi penanda AUTO saja (R-77 true): tidak dihilangkan, baris kosong', async () => {
    const d = e1();
    const r = composeV2({ source: merge(d, undefined, { slots: [...datumSlots(), RULE] }).doc, skeleton: skeletonInput([...datumSlots(), RULE]), params: defaultParams() });
    const snap = r.snapshot as any;
    // Slot yang membawa penanda dijadikan jenis signatureBlock: aturan D-299 tidak boleh menghapusnya.
    snap.skeleton.slots = snap.skeleton.slots.map((s: any) => (s.slotKey === 'ruleIndex' ? { ...s, sectionType: 'signatureBlock' } : s));
    const { ctx, logs } = makeCtx(snap as NormDocSnapshot, withParams(tpl, { [FLAG]: true }));
    const h = await assembleHtml(ctx, { preview: false });
    const sec = /<section[^>]*data-slot-key="ruleIndex"[\s\S]*?<\/section>/.exec(h)?.[0];
    expect(sec).toContain('Dokumen ini tidak memuat kode aturan.');
    expect(logs.some((l) => l.code === 'OPTIONAL_SLOT_EMPTY_OMITTED' && l.address === 'F:ruleIndex')).toBe(false);
    expect(logs.some((l) => l.code === 'RULE_INDEX_EMPTY')).toBe(true);
  }, 60_000);
});
