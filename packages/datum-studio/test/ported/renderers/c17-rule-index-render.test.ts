// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/renderers/c17-rule-index-render.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
/* eslint-disable @typescript-eslint/no-explicit-any -- dokumen kiriman v2 dibentuk bebas di uji */
// C17 / ST-01 (research/37 R5/R7, D-631): indeks aturan STD dari penanda isi, DOCX dan HTML lewat satu
// pembangun bersama. Opt-in `render.ruleIndex.fromMarkers` (R-77); absen/false = keluaran hari ini.
import { beforeAll, describe, expect, it } from '../_vitest';
import type { NormDocSnapshot, RenderLogEntry, ResolvedTemplate, TemplateSlotDef } from '@/lib/studio/contract';
import { assembleDocxDetailed } from '@/lib/studio/engine/docx/assemble';
import { planUnits } from '@/lib/studio/engine/docx/assemble/units';
import { assembleHtml } from '@/lib/studio/engine/html/assemble';
import { composeV2 } from '@/lib/studio/services/compose';
import { withParams } from '../engine-core/fixtures';
import { datumSlots, defaultParams, e1, merge, skeletonInput } from '../structure/_kit';
import { canonicalTemplate, makeCtx, partText, unzip } from './_kit';

const FLAG = 'render.ruleIndex.fromMarkers';
const RULE: TemplateSlotDef = {
  slotKey: 'ruleIndex', sectionType: 'ruleIndex', label: 'Indeks Aturan', position: 8, required: false,
  positionLocked: false, repeatable: false, contentMode: 'AUTO', tiers: [], admits: [], essentials: {},
};

function withMarkers(d: any, lang?: 'EN'): void {
  if (lang) d.meta.language = lang;
  const ch1 = d.sections.content.chapters[0];
  ch1.sections[0].blocks.push(
    { type: 'paragraph', text: 'DT-01a WAJIB. Taruh di halaman hanya bukti dan aparatusnya.' },
    { type: 'paragraph', text: 'PK-02 · WAJIB — Catat setiap keputusan kerja.' },
    { type: 'paragraph', text: 'DT-01a ANJURAN Penanda ganda.' },
  );
  d.sections.appendices.chapters[0].sections[0].blocks.push({ type: 'paragraph', text: 'BP-01 ANJURAN Simpan log mentah.' });
}

function compose(slots: TemplateSlotDef[], mutate?: (d: any) => void) {
  const d = e1();
  mutate?.(d);
  return composeV2({ source: merge(d, undefined, { slots }).doc, skeleton: skeletonInput(slots), params: defaultParams() });
}

function paragraphs(xml: string): string[] {
  return (xml.match(/<w:p[ >][\s\S]*?<\/w:p>/g) ?? []).map((p) =>
    (p.match(/<w:t[^>]*>[^<]*<\/w:t>|<w:tab\/>/g) ?? []).map((t) => (t === '<w:tab/>' ? ' ' : t.replace(/<[^>]+>/g, ''))).join(''),
  );
}

describe('C17 DOCX: indeks aturan dari penanda (R-77)', () => {
  let tpl: ResolvedTemplate;
  beforeAll(async () => {
    tpl = await canonicalTemplate();
  });

  async function docx(slots: TemplateSlotDef[], params: Record<string, unknown> | undefined, mutate?: (d: any) => void, extra: Record<string, unknown> = {}) {
    const r = compose(slots, mutate);
    const t = params ? withParams(tpl, params) : tpl;
    const { ctx, logs } = makeCtx(r.snapshot as unknown as NormDocSnapshot, t, extra);
    const detail = await assembleDocxDetailed(ctx);
    const xml = partText(unzip(detail.bytes), 'word/document.xml');
    return { detail, xml, logs, sections: (xml.match(/<w:sectPr/g) ?? []).length };
  }

  it('R-77 true + penanda: seksi indeks dengan judul, kepala kolom, entri terurut, SOURCE; ganda dicatat', async () => {
    const on = await docx([...datumSlots(), RULE], { [FLAG]: true }, (d) => withMarkers(d));
    const base = await docx(datumSlots(), { [FLAG]: true }, (d) => withMarkers(d));
    expect(on.sections).toBe(base.sections + 1);
    const paras = paragraphs(on.xml);
    const start = paras.indexOf('Indeks aturan');
    expect(start).toBeGreaterThan(-1);
    const after = paras.slice(start, start + 20);
    expect(after.slice(1, 5)).toEqual(['Kode', 'Ringkas', 'Tingkat', 'Bab']);
    expect(after.slice(5, 17)).toEqual([
      'DT-01a', 'Taruh di halaman hanya bukti dan aparatusnya', 'WAJIB', '1',
      'PK-02', 'Catat setiap keputusan kerja', 'WAJIB', '1',
      'BP-01', 'Simpan log mentah', 'ANJURAN', 'Lampiran A',
    ]);
    expect(after[17]).toMatch(/^SUMBER\s+Blok aturan dokumen ini$/);
    expect(on.logs.some((l) => l.code === 'RULE_INDEX_DUPLICATE_CODE' && l.address === '1.1.4' && /1\.1\.2/.test(l.message) && /ANJURAN/.test(l.message) && /WAJIB/.test(l.message))).toBe(true);
    expect(on.logs.some((l) => l.code === 'RULE_INDEX_MARKER_ONLY')).toBe(false);
    expect(on.detail.units.map((u) => u.slotKey)).toContain('ruleIndex');
  }, 60_000);

  it('dokumen EN: "Rule index", kepala EN, lampiran "Annex A", tanpa kata pembungkus ID', async () => {
    const en = await docx([...datumSlots(), RULE], { [FLAG]: true }, (d) => withMarkers(d, 'EN'));
    const paras = paragraphs(en.xml);
    const start = paras.indexOf('Rule index');
    expect(start).toBeGreaterThan(-1);
    expect(paras.slice(start + 1, start + 5)).toEqual(['Code', 'Summary', 'Level', 'Ch']);
    expect(paras.slice(start, start + 20)).toContain('Annex A');
    expect(paras).not.toContain('Indeks aturan');
    expect(paras.some((p) => /Blok aturan dokumen ini/.test(p))).toBe(false);
  }, 60_000);

  it('R-77 true tanpa penanda: slot opsional tetap dihilangkan (D-299), tanpa baris kosong', async () => {
    const on = await docx([...datumSlots(), RULE], { [FLAG]: true });
    const base = await docx(datumSlots(), { [FLAG]: true });
    expect(on.sections).toBe(base.sections);
    expect(on.logs.some((l) => l.code === 'OPTIONAL_SLOT_EMPTY_OMITTED' && l.address === 'F:ruleIndex')).toBe(true);
    expect(on.logs.some((l) => l.code === 'RULE_INDEX_EMPTY')).toBe(false);
    expect(on.xml).not.toContain('Indeks aturan');
  }, 60_000);

  it('R-77 true tanpa penanda, unit dipaksa (render lingkup slot / slot wajib): baris kosong + RULE_INDEX_EMPTY', () => {
    const logs: RenderLogEntry[] = [];
    const params = { ...defaultParams(), [FLAG]: true };
    const opt = compose([...datumSlots(), RULE]);
    const scoped = planUnits(opt.snapshot as never, { params, draft: true, scope: { kind: 'SLOT', key: 'ruleIndex' }, log: (e) => logs.push(e) });
    const unit = scoped.find((p) => p.slotKey === 'ruleIndex');
    expect(unit?.blocks.map((b) => [b.type, (b.content as any).text])).toEqual([['paragraph', 'Dokumen ini tidak memuat kode aturan.']]);
    expect(logs.some((l) => l.code === 'RULE_INDEX_EMPTY')).toBe(true);
    const req = compose([...datumSlots(), { ...RULE, required: true }]);
    const kept = planUnits(req.snapshot as never, { params }).find((p) => p.slotKey === 'ruleIndex');
    expect(kept?.blocks.map((b) => b.type)).toEqual(['paragraph']);
  });

  it('R-77 absen atau false: penanda di isi tidak membangun indeks; DOCX byte-identik antara absen dan false', async () => {
    const absentTpl = { ...tpl, params: Object.fromEntries(Object.entries(tpl.params).filter(([k]) => k !== FLAG)) } as ResolvedTemplate;
    const r = compose([...datumSlots(), RULE], (d) => withMarkers(d));
    const run = async (t: ResolvedTemplate) => {
      const { ctx, logs } = makeCtx(r.snapshot as unknown as NormDocSnapshot, t);
      return { bytes: (await assembleDocxDetailed(ctx)).bytes, logs };
    };
    const absent = await run(absentTpl);
    const off = await run(withParams(tpl, { [FLAG]: false }));
    expect(Buffer.from(off.bytes).equals(Buffer.from(absent.bytes))).toBe(true);
    expect(partText(unzip(off.bytes), 'word/document.xml')).not.toContain('Indeks aturan');
    expect(off.logs.some((l) => l.code === 'OPTIONAL_SLOT_EMPTY_OMITTED' && l.address === 'F:ruleIndex')).toBe(true);
    expect(off.logs.some((l) => /^RULE_INDEX_(DUPLICATE_CODE|EMPTY)$/.test(String(l.code)))).toBe(false);
  }, 60_000);
});

describe('C17 HTML: indeks aturan dari penanda (R-77, D-631)', () => {
  let tpl: ResolvedTemplate;
  beforeAll(async () => {
    tpl = await canonicalTemplate();
  });

  async function html(slots: TemplateSlotDef[], t: ResolvedTemplate, mutate?: (d: any) => void, extra: Record<string, unknown> = {}) {
    const r = compose(slots, mutate);
    const { ctx, logs } = makeCtx(r.snapshot as unknown as NormDocSnapshot, t, extra);
    return { html: await assembleHtml(ctx, { preview: false }), logs };
  }
  const ruleSection = (h: string) => /<section[^>]*data-slot-key="ruleIndex"[\s\S]*?<\/section>/.exec(h)?.[0];

  it('R-77 true + penanda: seksi slot berisi judul dan tabel indeks dari pembangun yang sama', async () => {
    const { html: h } = await html([...datumSlots(), RULE], withParams(tpl, { [FLAG]: true }), (d) => withMarkers(d));
    const sec = ruleSection(h);
    expect(sec).toBeDefined();
    expect(sec).toMatch(/<h3[^>]*>[\s\S]*Indeks aturan[\s\S]*<\/h3>/);
    const cells = [...(sec as string).matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)].map((m) => m[1].replace(/<[^>]+>/g, '').trim());
    expect(cells.slice(0, 16)).toEqual([
      'Kode', 'Ringkas', 'Tingkat', 'Bab',
      'DT-01a', 'Taruh di halaman hanya bukti dan aparatusnya', 'WAJIB', '1',
      'PK-02', 'Catat setiap keputusan kerja', 'WAJIB', '1',
      'BP-01', 'Simpan log mentah', 'ANJURAN', 'Lampiran A',
    ]);
    expect(sec).toContain('Blok aturan dokumen ini');
    expect(sec).not.toContain('st-invalid');
  }, 60_000);

  it('R-77 true tanpa penanda: unit slot opsional tidak dipancarkan (sama dengan DOCX)', async () => {
    const { html: h, logs } = await html([...datumSlots(), RULE], withParams(tpl, { [FLAG]: true }));
    expect(ruleSection(h)).toBeUndefined();
    expect(h).not.toContain('data-unit="orphan"');
    expect(logs.some((l) => l.code === 'OPTIONAL_SLOT_EMPTY_OMITTED' && l.address === 'F:ruleIndex')).toBe(true);
  }, 60_000);

  it('R-77 true tanpa penanda, render lingkup slot: baris kosong', async () => {
    const { html: h } = await html([...datumSlots(), RULE], withParams(tpl, { [FLAG]: true }), undefined, { scope: { kind: 'SLOT', key: 'ruleIndex' }, draft: true });
    expect(ruleSection(h)).toContain('Dokumen ini tidak memuat kode aturan.');
  }, 60_000);

  it('R-77 absen atau false: HTML byte-identik antara absen dan false, keluaran lama (penanda tabel tidak sah)', async () => {
    const absentTpl = { ...tpl, params: Object.fromEntries(Object.entries(tpl.params).filter(([k]) => k !== FLAG)) } as ResolvedTemplate;
    const absent = await html([...datumSlots(), RULE], absentTpl, (d) => withMarkers(d));
    const off = await html([...datumSlots(), RULE], withParams(tpl, { [FLAG]: false }), (d) => withMarkers(d));
    expect(off.html).toBe(absent.html);
    expect(ruleSection(off.html)).toContain('st-invalid');
    expect(off.html).not.toContain('Indeks aturan');
  }, 60_000);
});
