// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/renderers/fixhz2-decorative-d16.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
/* eslint-disable @typescript-eslint/no-explicit-any -- fixture JSON kontrak dibaca bebas-bentuk di uji */
// FIX-HZ2 (D-326, D-327; penutup batch Hermes).
//  1. Gambar aparatus (logo sampul, Datum Rule sampul/bab) ditandai dekoratif sesuai
//     praktik Office: `wp:docPr descr=""` + `a:extLst/a:ext uri={C183D7F6-...}` berisi
//     `adec:decorative val="1"`, nama objek bermakna (bukan "Picture n"). HTML: logo
//     `alt="" role="presentation"`. Gambar isi (figur) tetap memakai alt FIX-H8.
//  2. Lint D16: rel bukti dinilai menurut yang dirender. Templat mematikan rel
//     (`device.evidenceRail.enabled = false`) = NOT_APPLICABLE beralasan; rel menyala =
//     tetap ketat (wajib tanpa rel = FAIL).
import { beforeAll, describe, expect, it } from '../_vitest';
import type { NormDocSnapshot, ResolvedTemplate, StudioDocV1 } from '@/lib/studio/contract';
import { assembleDocxDetailed } from '@/lib/studio/engine/docx/assemble';
import { DECORATIVE_EXT_URI, decorativeDocPrXml, decorativeName, NS_ADEC } from '@/lib/studio/engine/docx/blocks/media';
import { assembleHtml } from '@/lib/studio/engine/html/assemble';
import { lintStructure } from '@/lib/studio/engine/lint/structure';
import { composeV2 } from '@/lib/studio/services/compose';
import { canonicalTemplate as canonicalSync, makeDoc, snapshotOf as engineSnapshot, withParams } from '../engine-core/fixtures';
import { datumSlots, defaultParams, e1, merge, skeletonInput } from '../structure/_kit';
import { benchmarkTemplate, findAll, makeCtx, parseFragment, parseXml, partText, unzip, type XNode } from './_kit';

const DOCPR_RE = /<wp:docPr\b[^>]*?(?:\/>|>[\s\S]*?<\/wp:docPr>)/g;
const attrOf = (tag: string, name: string) => tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];
const isDecorative = (tag: string) => tag.includes(`uri="${DECORATIVE_EXT_URI}"`) && /<adec:decorative [^>]*val="1"/.test(tag);

function composeE1(lang?: 'EN'): NormDocSnapshot {
  const d = e1();
  if (lang) d.meta.language = lang;
  const slots = datumSlots();
  return composeV2({ source: merge(d, undefined, { slots }).doc, skeleton: skeletonInput(slots), params: defaultParams() }).snapshot as unknown as NormDocSnapshot;
}

async function renderDocx(snap: NormDocSnapshot, tpl: ResolvedTemplate): Promise<string> {
  const detail = await assembleDocxDetailed(makeCtx(snap, tpl).ctx);
  return partText(unzip(detail.bytes), 'word/document.xml');
}

let BENCH: ResolvedTemplate;
beforeAll(async () => {
  BENCH = await benchmarkTemplate();
});

describe('DOCX: gambar aparatus ditandai dekoratif (praktik Office)', () => {
  it('bentuk wp:docPr dekoratif: name bermakna, descr kosong, ekstensi adec:decorative val=1', () => {
    const xml = decorativeDocPrXml(7, 'logo', 'ID');
    const { root, errors } = parseFragment(
      `<w:r xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">${xml}</w:r>`,
    );
    expect(errors).toEqual([]);
    const pr = findAll(root, 'wp:docPr')[0] as XNode;
    expect(pr.attrs).toEqual({ id: '7', name: 'Logo sampul (dekoratif)', descr: '' });
    const ext = findAll(root, 'a:ext')[0] as XNode;
    expect(ext.attrs.uri).toBe('{C183D7F6-B498-43B3-948B-1728B52AA6E4}');
    const dec = findAll(root, 'adec:decorative')[0] as XNode;
    expect(dec.attrs).toMatchObject({ 'xmlns:adec': NS_ADEC, val: '1' });
    expect(decorativeName('chapterDatumRule', 'EN')).toBe('Chapter Datum Rule (decorative)');
  });

  it('dokumen lengkap (logo sampul + Datum Rule sampul + Datum Rule bab): semua gambar aparatus dekoratif, nol "Picture n"', async () => {
    const xml = await renderDocx(composeE1(), BENCH);
    expect(parseXml(xml).errors).toEqual([]);
    const prs = xml.match(DOCPR_RE) ?? [];
    expect(prs.length).toBeGreaterThanOrEqual(3);
    const names = prs.map((p) => attrOf(p, 'name'));
    for (const p of prs) {
      expect(isDecorative(p)).toBe(true);
      expect(attrOf(p, 'descr')).toBe('');
      expect(attrOf(p, 'name')).not.toMatch(/^Picture\b/);
    }
    expect(names).toContain('Logo sampul (dekoratif)');
    expect(names).toContain('Datum Rule (dekoratif)');
    expect(names).toContain('Datum Rule bab (dekoratif)');
    // id tetap dinomori ulang 1..n oleh perakit
    expect(prs.map((p) => Number(attrOf(p, 'id')))).toEqual(prs.map((_, i) => i + 1));
  });

  it('dokumen EN: nama objek dekoratif berbahasa Inggris', async () => {
    const xml = await renderDocx(composeE1('EN'), BENCH);
    const names = (xml.match(DOCPR_RE) ?? []).map((p) => attrOf(p, 'name'));
    expect(names).toContain('Cover logo (decorative)');
    expect(names).toContain('Chapter Datum Rule (decorative)');
  });

  // row42 SKIP E2: needs the PNG assets of benchmark/manual000/doc.json in a seeded local workspace
  // (data/studio-workspace/assets, gitignored in the clone: .gitignore:81); not reproducible from the repository.
  it.skip('figur isi TIDAK ditandai dekoratif (alt FIX-H8 tetap): Manual 000 v1 memuat keduanya', async () => {
    const { loadBenchmarkDoc } = await import('../engine-core/fixtures');
    const { stubFigures } = await import('./_kit');
    const snap = engineSnapshot(loadBenchmarkDoc());
    const detail = await assembleDocxDetailed(makeCtx(snap, BENCH, { figures: stubFigures(snap) } as never).ctx);
    const xml = partText(unzip(detail.bytes), 'word/document.xml');
    const prs = xml.match(DOCPR_RE) ?? [];
    const deco = prs.filter(isDecorative);
    const content = prs.filter((p) => !isDecorative(p));
    expect(deco.length).toBeGreaterThan(0);
    expect(content.length).toBeGreaterThan(0);
    for (const p of content) {
      expect(attrOf(p, 'descr')).toBeTruthy();
      expect(attrOf(p, 'name')).not.toMatch(/\(dekoratif\)|^Picture\b/);
    }
    for (const p of deco) expect(attrOf(p, 'name')).toMatch(/\(dekoratif\)$/);
  });
});

describe('HTML: logo sampul dekoratif', () => {
  it('img logo alt="" + role="presentation"; tidak ada alt="logo"', async () => {
    const html = await assembleHtml(makeCtx(composeE1(), BENCH).ctx, { preview: false });
    const imgs = html.match(/<img\b[^>]*>/g) ?? [];
    const logos = imgs.filter((i) => !/\salt="[^"]+"/.test(i));
    expect(logos.length).toBeGreaterThanOrEqual(1);
    for (const i of logos) expect(i).toMatch(/\salt="" role="presentation"/);
    expect(html).not.toContain('alt="logo"');
    // Datum Rule SVG tetap tersembunyi dari pembaca layar
    for (const s of html.match(/<svg class="[^"]*"[^>]*>/g) ?? []) if (/datum/i.test(s)) expect(s).toContain('aria-hidden="true"');
  });
});

describe('lint D16: rel bukti memperhatikan device.evidenceRail.enabled templat', () => {
  let KAN: ResolvedTemplate;
  beforeAll(() => {
    KAN = canonicalSync();
  });

  /** Templat dengan rencana SERAH yang mewajibkan/terlarang rel (isolasi aturan F5). */
  function planTpl(entry: { required: string[]; forbidden: string[] }, params: Record<string, unknown> = {}): ResolvedTemplate {
    const base = withParams(KAN, params);
    const sectionPlan = { ...(base.sectionPlan as any), SERAH: { required: entry.required, optional: [], forbidden: entry.forbidden } };
    return { ...base, sectionPlan } as ResolvedTemplate;
  }
  function serahDoc(withRail: boolean): NormDocSnapshot {
    const doc = makeDoc({ tier: 'SERAH' }) as any;
    if (withRail) {
      const para = doc.chapters[0].blocks?.find((b: any) => b.type === 'paragraph') ?? doc.chapters[0].sections?.[0]?.blocks?.find((b: any) => b.type === 'paragraph');
      para.rail = [{ kind: 'mark', mark: 'TERUKUR' }];
    }
    return engineSnapshot(doc as StudioDocV1);
  }
  const d16 = (snap: NormDocSnapshot, tpl: ResolvedTemplate) => lintStructure(snap, tpl, 'SERAH').filter((i) => i.checkId === 'D16');
  const railFails = (issues: ReturnType<typeof d16>) => issues.filter((i) => i.status === 'FAIL' && /"evidenceRail"/.test(i.detail ?? ''));

  it('rel menyala (bawaan) + wajib + konten tanpa rel = FAIL (tetap ketat)', () => {
    const issues = d16(serahDoc(false), planTpl({ required: ['chapter', 'evidenceRail'], forbidden: [] }));
    expect(railFails(issues)).toHaveLength(1);
  });

  it('rel menyala eksplisit + wajib + konten memuat rel = PASS', () => {
    const issues = d16(serahDoc(true), planTpl({ required: ['chapter', 'evidenceRail'], forbidden: [] }, { 'device.evidenceRail.enabled': true }));
    expect(issues.map((i) => i.status)).toEqual(['PASS']);
    expect(issues[0].detail).not.toContain('NOT_APPLICABLE');
  });

  it('templat mematikan rel + wajib + konten tanpa rel = PASS dengan NOT_APPLICABLE beralasan', () => {
    const issues = d16(serahDoc(false), planTpl({ required: ['chapter', 'evidenceRail'], forbidden: [] }, { 'device.evidenceRail.enabled': false }));
    expect(issues.map((i) => i.status)).toEqual(['PASS']);
    expect(issues[0].detail).toMatch(/^1 section wajib tier SERAH ada/);
    expect(issues[0].detail).toContain('evidenceRail NOT_APPLICABLE');
    expect(issues[0].detail).toContain('device.evidenceRail.enabled = false');
  });

  it('rel terlarang: konten memuat rel = FAIL bila menyala, NOT_APPLICABLE bila templat mematikannya (tidak dirender)', () => {
    const on = d16(serahDoc(true), planTpl({ required: ['chapter'], forbidden: ['evidenceRail'] }));
    expect(on.filter((i) => i.status === 'FAIL' && /"evidenceRail" terlarang/.test(i.detail ?? ''))).toHaveLength(1);
    const off = d16(serahDoc(true), planTpl({ required: ['chapter'], forbidden: ['evidenceRail'] }, { 'device.evidenceRail.enabled': false }));
    expect(off.map((i) => i.status)).toEqual(['PASS']);
    expect(off[0].detail).toContain('evidenceRail NOT_APPLICABLE');
  });

  it('rencana tanpa rel: detail PASS tidak berubah walau templat mematikan rel', () => {
    const a = d16(serahDoc(false), planTpl({ required: ['chapter'], forbidden: [] }));
    const b = d16(serahDoc(false), planTpl({ required: ['chapter'], forbidden: [] }, { 'device.evidenceRail.enabled': false }));
    expect(b).toEqual(a);
  });

  it('perangkat lain yang dimatikan templat tetap FAIL (pengecualian hanya rel bukti)', () => {
    const issues = d16(serahDoc(false), planTpl({ required: ['chapter', 'sealBand'], forbidden: [] }, { 'device.sealBand.enabled': false, 'device.evidenceRail.enabled': false }));
    expect(issues.filter((i) => i.status === 'FAIL' && /"sealBand"/.test(i.detail ?? ''))).toHaveLength(1);
  });
});
