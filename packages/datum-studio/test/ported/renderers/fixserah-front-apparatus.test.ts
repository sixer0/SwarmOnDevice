// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/renderers/fixserah-front-apparatus.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
/* eslint-disable @typescript-eslint/no-explicit-any -- fixture JSON kontrak dibaca bebas-bentuk di uji */
// FIX-SERAH (D-295, D-299): aparatus halaman depan milik templat (D-139).
//  1. Sampul explicit konten-saja (perangkat dibuang SR-41/D-256) menerima logo,
//     pita segel, Datum Rule, dan string punggung dari templat; lint D06/D16 menilai
//     apa yang dirender, aturan tidak dilonggarkan (perangkat yang dimatikan templat
//     tetap FAIL).
//  2. Entri daftar isi bagian memakai label bawaan yang sama dengan pembatas bagian.
//  3. Slot opsional tanpa isi (ruleIndex tanpa entri) tidak memancarkan seksi.
import { beforeAll, describe, expect, it } from '../_vitest';
import type { NormDocSnapshot, ResolvedTemplate, StudioDocV1, TemplateSlotDef } from '@/lib/studio/contract';
import { assembleDocxDetailed } from '@/lib/studio/engine/docx/assemble';
import { planUnits } from '@/lib/studio/engine/docx/assemble/units';
import { assembleHtml } from '@/lib/studio/engine/html/assemble';
import { defaultPartLabelText, explicitCoverApparatus } from '@/lib/studio/engine/front/apparatus';
import { lintStructure } from '@/lib/studio/engine/lint/structure';
import { composeV2 } from '@/lib/studio/services/compose';
import { canonicalTemplate as canonicalSync, makeDoc, snapshotOf as engineSnapshot, withParams } from '../engine-core/fixtures';
import { datumSlots, defaultParams, e1, merge, skeletonInput } from '../structure/_kit';
import { canonicalTemplate, loadFixtureDoc, makeCtx, partText, snapshotOf, unzip } from './_kit';

const DEFAULT_ORDER_BEFORE = ['pita segel', 'logo', 'Datum Rule 166 mm'];

describe('explicitCoverApparatus (engine/front/apparatus)', () => {
  it('badan tanpa perangkat: aparatus aktif dipasang menurut cover.elementOrder', () => {
    const a = explicitCoverApparatus({}, [{ type: 'paragraph', role: 'kicker', text: 'BERITA ACARA' }]);
    expect(a.before).toEqual(DEFAULT_ORDER_BEFORE);
    expect(a.after).toEqual(['string punggung']);
    expect([...a.kinds].sort()).toEqual(['datumRule', 'logo', 'sealBand', 'spineString']);
  });

  it('perangkat yang sudah dibawa badan tidak digandakan (doc.verbatim tetap)', () => {
    const body = ['sealBand', 'logo', 'datumRule', 'spineString'].map((device) => ({ type: 'device', device }));
    const a = explicitCoverApparatus({}, body);
    expect(a.before).toEqual([]);
    expect(a.after).toEqual([]);
    expect(a.kinds.size).toBe(0);
    expect(explicitCoverApparatus({}, [{ type: 'device', device: 'logo' }]).kinds.has('logo')).toBe(false);
  });

  it('parameter templat dihormati: dimatikan atau tanpa penempatan sampul = tidak dipasang', () => {
    const a = explicitCoverApparatus(
      { 'device.sealBand.enabled': false, 'device.datumRule.placements': ['atas judul bab'], 'device.spine.enabled': false },
      [],
    );
    expect([...a.kinds]).toEqual(['logo']);
    const order = explicitCoverApparatus({ 'cover.elementOrder': ['judul', 'logo'] }, []);
    expect(order.before).toEqual([]);
    expect(order.after).toEqual(['logo']);
  });

  it('label bagian bawaan dari id (angka Romawi, cadangan I)', () => {
    expect(defaultPartLabelText('P2', 'ID')).toBe('Bagian II');
    expect(defaultPartLabelText('P1', 'EN')).toBe('Part I');
    expect(defaultPartLabelText('pembuka', 'ID')).toBe('Bagian I');
  });
});

describe('lint D06/D16 sampul explicit konten-saja (SERAH)', () => {
  let KAN: ResolvedTemplate;
  beforeAll(() => {
    KAN = canonicalSync();
  });

  function serahDoc(body: unknown[]): StudioDocV1 {
    const doc = makeDoc({ tier: 'SERAH' }) as any;
    doc.front = { cover: { mode: 'explicit', body } };
    return doc as StudioDocV1;
  }
  const apparatusFails = (issues: ReadonlyArray<{ checkId: string; status: string; detail?: string }>) =>
    issues.filter((i) => i.checkId === 'D16' && i.status === 'FAIL' && /"(datumRule|sealBand|spineString)"/.test(i.detail ?? '')).map((i) => i.detail);
  const body = [
    { type: 'paragraph', role: 'kicker', text: 'BERITA ACARA SERAH TERIMA' },
    { type: 'paragraph', role: 'title', text: 'Paket serah terima' },
  ];

  it('badan tanpa perangkat: D06 PASS (logo templat) dan D16 tanpa FAIL aparatus', () => {
    const issues = lintStructure(engineSnapshot(serahDoc(body)), KAN, 'SERAH');
    const d06 = issues.filter((i) => i.checkId === 'D06');
    expect(d06.map((i) => i.status)).toEqual(['PASS']);
    expect(d06[0].detail).toContain('templat menempatkan logo pada sampul explicit');
    expect(apparatusFails(issues)).toEqual([]);
  });

  it('aturan tidak dilonggarkan: templat mematikan perangkat = D16 tetap FAIL', () => {
    const off = withParams(KAN, { 'device.sealBand.enabled': false, 'device.spine.enabled': false, 'device.datumRule.enabled': false });
    const issues = lintStructure(engineSnapshot(serahDoc(body)), off, 'SERAH');
    expect(apparatusFails(issues)).toHaveLength(3);
  });

  it('logo di badan dihitung sekali; templat tidak menambah logo kedua', () => {
    const issues = lintStructure(engineSnapshot(serahDoc([{ type: 'device', device: 'logo' }, ...body])), KAN, 'SERAH');
    const d06 = issues.filter((i) => i.checkId === 'D06');
    expect(d06.map((i) => i.status)).toEqual(['PASS']);
    expect(d06[0].detail).toMatch(/^logo 1 kali/);
    expect(d06[0].detail).not.toContain('templat menempatkan');
  });
});

describe('DOCX: sampul explicit fixture SERAH v1 dan TOC/ruleIndex v2', () => {
  let tpl: ResolvedTemplate;
  beforeAll(async () => {
    tpl = await canonicalTemplate();
  });

  /** Teks per paragraf `word/document.xml` (w:t; w:tab = spasi). */
  function paragraphs(xml: string): string[] {
    return (xml.match(/<w:p[ >][\s\S]*?<\/w:p>/g) ?? []).map((p) =>
      (p.match(/<w:t[^>]*>[^<]*<\/w:t>|<w:tab\/>/g) ?? []).map((t) => (t === '<w:tab/>' ? ' ' : t.replace(/<[^>]+>/g, ''))).join(''),
    );
  }

  it('SERAH v1 explicit: logo + Datum Rule (2 gambar) dan isi badan di seksi sampul', async () => {
    const doc = loadFixtureDoc('doc_serah_handover');
    // Prasyarat: badan sampul konten-saja tanpa perangkat (SR-41/D-256).
    expect(((doc.front?.cover as any)?.body ?? []).filter((b: any) => b.type === 'device')).toEqual([]);
    const { ctx } = makeCtx(snapshotOf(doc), tpl);
    const detail = await assembleDocxDetailed(ctx);
    const xml = partText(unzip(detail.bytes), 'word/document.xml');
    const coverXml = xml.slice(0, xml.indexOf('<w:sectPr'));
    expect((coverXml.match(/<w:drawing>/g) ?? []).length).toBe(2);
    const coverText = paragraphs(coverXml).join('\n');
    expect(coverText).toContain('BERITA ACARA SERAH TERIMA');
    expect(coverText).toContain('004/GSP/BA/X/2026');
  }, 60_000);

  function composeE1(slots: TemplateSlotDef[], mutate?: (d: any) => void) {
    const d = e1();
    mutate?.(d);
    return composeV2({ source: merge(d, undefined, { slots }).doc, skeleton: skeletonInput(slots), params: defaultParams() });
  }

  it('TOC v2 turunan memuat label "Bagian I" yang sama dengan pembatas bagian', async () => {
    const r = composeE1(datumSlots(), (d) => {
      d.sections.content.parts = [{ id: 'P1', title: { text: 'Bagian Satu' } }];
      d.sections.content.chapters[1].partId = 'P1';
    });
    const { ctx } = makeCtx(r.snapshot as unknown as NormDocSnapshot, tpl);
    const detail = await assembleDocxDetailed(ctx);
    const paras = paragraphs(partText(unzip(detail.bytes), 'word/document.xml'));
    expect(paras.some((p) => /^Bagian I\s+Bagian Satu/.test(p))).toBe(true);
    expect(paras).toContain('Bagian I');
    // HTML: sel label entri bagian dan kicker pembatas bagian sama-sama "Bagian I".
    const html = await assembleHtml(makeCtx(r.snapshot as unknown as NormDocSnapshot, tpl).ctx, { preview: false });
    // ENG-01 (D-463): sel dan kicker kini membawa kelas/gaya peran (fallback benchmark seperti DOCX).
    expect(html).toMatch(/data-level="part"><td class="st-toc-label[^"]*"(?: style="[^"]*")? data-role="toc.partLabel">Bagian I<\/td>/);
    expect(html).toMatch(/st-part-kicker[^"]*"(?: style="[^"]*")? data-role="wrapper.kicker">Bagian I<\/p>/);
  }, 60_000);

  const RULE: TemplateSlotDef = {
    slotKey: 'ruleIndex', sectionType: 'ruleIndex', label: 'Indeks Aturan', position: 8, required: false,
    positionLocked: false, repeatable: false, contentMode: 'AUTO', tiers: [], admits: [], essentials: {},
  };

  it('ruleIndex opsional tanpa entri: blok compose tetap ada, unit/seksi tidak dirender', () => {
    const r = composeE1([...datumSlots(), RULE]);
    expect(r.snapshot.blocks.some((b) => b.type === 'ruleIndex')).toBe(true);
    const keys = planUnits(r.snapshot as never, { params: defaultParams() }).map((p) => p.slotKey);
    expect(keys).not.toContain('ruleIndex');
    expect(keys).toContain('content');
  });

  it('ruleIndex wajib dan render lingkup slot ruleIndex tetap dirender', () => {
    const req = composeE1([...datumSlots(), { ...RULE, required: true }]);
    expect(planUnits(req.snapshot as never, { params: defaultParams() }).map((p) => p.slotKey)).toContain('ruleIndex');
    const opt = composeE1([...datumSlots(), RULE]);
    const scoped = planUnits(opt.snapshot as never, { params: defaultParams(), draft: true, scope: { kind: 'SLOT', key: 'ruleIndex' } });
    expect(scoped.map((p) => p.slotKey)).toContain('ruleIndex');
  });

  it('DOCX v2 dengan ruleIndex opsional kosong: jumlah seksi sama dengan tanpa slot ruleIndex', async () => {
    const count = async (slots: TemplateSlotDef[]) => {
      const r = composeE1(slots);
      const { ctx } = makeCtx(r.snapshot as unknown as NormDocSnapshot, tpl);
      const xml = partText(unzip((await assembleDocxDetailed(ctx)).bytes), 'word/document.xml');
      return (xml.match(/<w:sectPr/g) ?? []).length;
    };
    expect(await count([...datumSlots(), RULE])).toBe(await count(datumSlots()));
  }, 60_000);
});
