// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/renderers/c12-back-cover-planner.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
// C12 / CV-19 planner wiring (addendum controller sesudah C17/C18; renderer + predikat dari engine A,
// delegation_progress/coder_execution_engine_a.md): `device.spine.placements` berisi "sampul belakang" DAN
// rencana memuat unit sampul non-placeholder DAN lingkup DOCUMENT = unit terakhir `F:backCover` jenis `cover`
// dengan tepat satu blok `backCover`. Tanpa sampul (mis. NOTA) tanpa halaman belakang; absen = rencana sama.
import { beforeAll, describe, expect, it } from '../_vitest';
import type { NormDocSnapshot, ParamMap, ResolvedTemplate, TemplateSlotDef } from '@/lib/studio/contract';
import { planUnits } from '@/lib/studio/engine/docx/assemble/units';
import { spineTextOf } from '@/lib/studio/engine/front/texts';
import { composeV2 } from '@/lib/studio/services/compose';
import { renderSnapshot } from '@/lib/studio/services/render/pure/render';
import { withParams } from '../engine-core/fixtures';
import { datumSlots, defaultParams, e1, merge, skeletonInput } from '../structure/_kit';
import { canonicalTemplate, partText, sha256, unzip } from './_kit';

const PLACED = { 'device.spine.placements': ['margin luar sampul', 'pembatas', 'sampul belakang'] };
const DEFAULT_LIST = { 'device.spine.placements': ['margin luar sampul', 'pembatas'] };

function compose(slots: TemplateSlotDef[]) {
  const d = e1();
  // Kerangka tanpa slot sampul (bentuk NOTA): kiriman juga tanpa isi sampul.
  if (!slots.some((s) => s.sectionType === 'cover')) delete d.sections.cover;
  return composeV2({ source: merge(d, undefined, { slots }).doc, skeleton: skeletonInput(slots), params: defaultParams() });
}
const noCover = () => datumSlots().filter((s) => s.sectionType !== 'cover');
const textOf = (xml: string): string => [...xml.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]).join('');

describe('C12 planner: unit sampul belakang', () => {
  it('opt-in + unit sampul + DOCUMENT: unit terakhir F:backCover jenis cover, satu blok backCover', () => {
    const r = compose(datumSlots());
    const plans = planUnits(r.snapshot as never, { params: { ...defaultParams(), ...PLACED } });
    const last = plans[plans.length - 1];
    expect(last.unit).toMatchObject({ kind: 'cover', key: 'F:backCover' });
    expect(last.blocks.map((b) => b.type)).toEqual(['backCover']);
    expect(plans.filter((p) => p.unit.key === 'F:backCover')).toHaveLength(1);
  });

  it('tanpa unit sampul (NOTA), lingkup bukan DOCUMENT, atau opt-in absen/bawaan: rencana tanpa F:backCover', () => {
    const keys = (slots: TemplateSlotDef[], params: ParamMap, extra: Record<string, unknown> = {}) =>
      planUnits(compose(slots).snapshot as never, { params: { ...defaultParams(), ...params }, ...extra }).map((p) => p.unit.key);
    expect(keys(noCover(), PLACED)).not.toContain('F:backCover');
    expect(keys(datumSlots(), PLACED, { draft: true, scope: { kind: 'SLOT', key: 'cover' } })).not.toContain('F:backCover');
    expect(keys(datumSlots(), PLACED, { draft: true, scope: { kind: 'CHAPTER', key: '1' } })).not.toContain('F:backCover');
    const absent = keys(datumSlots(), {});
    expect(absent).not.toContain('F:backCover');
    expect(keys(datumSlots(), DEFAULT_LIST)).toEqual(absent);
  });
});

describe('C12 render DOCX murni: halaman sampul belakang', () => {
  let tpl: ResolvedTemplate;
  beforeAll(async () => {
    tpl = await canonicalTemplate();
  });

  async function docx(slots: TemplateSlotDef[], t: ResolvedTemplate) {
    const snap = compose(slots).snapshot as unknown as NormDocSnapshot;
    const res = await renderSnapshot(snap, t, { formats: ['DOCX'], measureLayout: false, registerLog: false });
    const file = res.files.find((f) => f.role === 'PRIMARY' && f.format === 'DOCX');
    expect(file, JSON.stringify(res.errors)).toBeDefined();
    const bytes = file?.data as Uint8Array;
    return { bytes, parts: unzip(bytes), snap, tpl: res.tpl };
  }

  /** Seksi terakhir badan: isi sesudah sectPr seksi sebelumnya, beserta sectPr akhir badan. */
  function lastSection(xml: string): { body: string; sectPr: string } {
    const body = xml.slice(xml.indexOf('<w:body>') + '<w:body>'.length, xml.lastIndexOf('</w:body>'));
    const finalAt = body.lastIndexOf('<w:sectPr');
    const prevEnd = body.lastIndexOf('</w:sectPr>', finalAt);
    return { body: body.slice(prevEnd < 0 ? 0 : prevEnd, finalAt), sectPr: body.slice(finalAt) };
  }

  it('opt-in: dokumen berakhir dengan seksi sampul belakang berisi string punggung berputar; kepala/kaki tanpa PAGE/NUMPAGES', async () => {
    const r = await docx(datumSlots(), withParams(tpl, PLACED));
    const xml = partText(r.parts, 'word/document.xml');
    const base = await docx(datumSlots(), tpl);
    const baseXml = partText(base.parts, 'word/document.xml');
    expect((xml.match(/<w:sectPr/g) ?? []).length).toBe((baseXml.match(/<w:sectPr/g) ?? []).length + 1);
    const last = lastSection(xml);
    expect((last.body.match(/<w:textDirection w:val="tbRl"\/>/g) ?? []).length).toBe(1);
    expect(textOf(last.body)).toBe(spineTextOf(r.snap.doc.meta, r.tpl.params));
    const rels = partText(r.parts, 'word/_rels/document.xml.rels');
    const ids = [...last.sectPr.matchAll(/<w:(?:header|footer)Reference [^>]*r:id="([^"]+)"/g)].map((m) => m[1]);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      const target = new RegExp(`Id="${id}"[^>]*Target="([^"]+)"`).exec(rels)?.[1] ?? new RegExp(`Target="([^"]+)"[^>]*Id="${id}"`).exec(rels)?.[1];
      expect(target).toBeDefined();
      expect(partText(r.parts, `word/${target}`)).not.toMatch(/PAGE|NUMPAGES/);
    }
    expect(last.body + last.sectPr).not.toMatch(/PAGE|NUMPAGES/);
  }, 120_000);

  it('NOTA (tanpa slot sampul) dengan opt-in: tanpa halaman belakang, byte-identik dengan tanpa opt-in', async () => {
    const on = await docx(noCover(), withParams(tpl, PLACED));
    const off = await docx(noCover(), tpl);
    expect(sha256(on.bytes)).toBe(sha256(off.bytes));
  }, 120_000);

  it('absen = daftar bawaan eksplisit: DOCX byte-identik', async () => {
    const absentTpl = { ...tpl, params: Object.fromEntries(Object.entries(tpl.params).filter(([k]) => k !== 'device.spine.placements')) } as ResolvedTemplate;
    const absent = await docx(datumSlots(), absentTpl);
    const dflt = await docx(datumSlots(), withParams(tpl, DEFAULT_LIST));
    expect(sha256(dflt.bytes)).toBe(sha256(absent.bytes));
  }, 120_000);
});
