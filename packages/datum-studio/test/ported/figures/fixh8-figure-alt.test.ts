// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/figures/fixh8-figure-alt.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
// FIX-H8 (D-322, uji Hermes E): nama objek figur DOCX (`wp:docPr` name/title/descr) dan
// alt/aria-label HTML dari nomor + caption (+ sumber), bukan "Picture n".
import { beforeAll, describe, expect, it } from '../_vitest';
import type { NormBlock, NormDocSnapshot, ResolvedTemplate } from '@/lib/studio/contract';
import { DOCX_RENDERERS, HTML_RENDERERS } from '@/lib/studio/contract/dispatch';
import { FIGURE_NAME_MAX, figureAltText, shortenAtWord, stripSourceLabel } from '@/lib/studio/engine/docx/figures';
import { canonicalTemplate, loadFixtureDoc, makeCtx, snapshotOf, unescapeXml } from '../renderers/_kit';

describe('figureAltText (murni)', () => {
  it('label + caption + sumber; nama = judul, dipendekkan di batas kata', () => {
    const long = 'Konstelasi pada dua catatan: konsep tujuh satelit di materi pemasok lawan satu objek yang dikonfirmasi registri orbit.';
    const a = figureAltText({ type: 'chart', label: 'Gambar 4.1', caption: long, source: 'Baris register W-04 dan P-40', kindHint: 'P-01' });
    expect(a.name).toBe(a.title);
    expect(a.name.startsWith('Gambar 4.1 — Konstelasi pada dua catatan')).toBe(true);
    expect(a.name.length).toBeLessThanOrEqual(FIGURE_NAME_MAX);
    expect(a.name.endsWith('…')).toBe(true);
    expect(a.name).not.toMatch(/\s…$/);
    expect(a.descr).toBe(`Gambar 4.1 — ${long} Sumber: Baris register W-04 dan P-40`);
  });

  it('caption kosong -> subjek bermakna dari jenis figur, tidak pernah "Picture"', () => {
    const cases: Array<[Parameters<typeof figureAltText>[0], string]> = [
      [{ type: 'chart', label: 'Gambar 3.1', caption: '', kindHint: 'P-01' }, 'Gambar 3.1 — Grafik P-01'],
      [{ type: 'chart', label: 'Gambar 3.1', caption: '  ', kindHint: 'composite' }, 'Gambar 3.1 — Grafik'],
      [{ type: 'diagram', label: 'Gambar 2.4', caption: '' }, 'Gambar 2.4 — Diagram'],
      [{ type: 'image', label: 'Gambar 1.2', caption: '', kindHint: 'assets/FIG-02.png' }, 'Gambar 1.2 — Gambar FIG-02'],
      [{ type: 'image', label: '', caption: '', kindHint: '881266bf4514a3e04fa4581e367a3161.png' }, 'Gambar'],
      [{ type: 'symbolSheet', label: 'Gambar 5.1', caption: '', kindHint: 'HS' }, 'Gambar 5.1 — Lembar simbol HS'],
      [{ type: 'chart', label: 'Figure 3.1', caption: '', kindHint: 'P-01', language: 'EN' }, 'Figure 3.1 — Chart P-01'],
    ];
    for (const [input, name] of cases) {
      const a = figureAltText(input);
      expect(a.name).toBe(name);
      expect(a.descr).not.toMatch(/Picture/);
    }
  });

  it('lembar ganda: akhiran (lembar i/n); EN (sheet i/n) + "Source:"', () => {
    expect(figureAltText({ type: 'symbolSheet', label: 'Gambar 5.1', caption: 'Simbol.', sheet: { index: 2, count: 3 } }).name).toBe('Gambar 5.1 — Simbol. (lembar 2/3)');
    expect(figureAltText({ type: 'diagram', label: 'Gambar 5.2', caption: 'Satu.', sheet: { index: 1, count: 1 } }).name).toBe('Gambar 5.2 — Satu.');
    const en = figureAltText({ type: 'diagram', label: 'Figure 2.1', caption: 'Flow', source: 'Field notes', language: 'EN', sheet: { index: 1, count: 2 } });
    expect(en.descr).toBe('Figure 2.1 — Flow (sheet 1/2). Source: Field notes');
  });

  it('spasi dirapatkan; label SUMBER di depan dibuang; potong tanpa batas kata', () => {
    expect(figureAltText({ type: 'diagram', label: 'Gambar\t1.1', caption: 'a\n b' }).name).toBe('Gambar 1.1 — a b');
    expect(stripSourceLabel('SUMBER  Data lapangan')).toBe('Data lapangan');
    expect(stripSourceLabel('Sumber: Data')).toBe('Data');
    expect(shortenAtWord('x'.repeat(100), 10)).toBe(`${'x'.repeat(9)}…`);
  });
});

describe('renderer figur DOCX + HTML (fixture doc_terbit_report)', () => {
  let tpl: ResolvedTemplate;
  let snap: NormDocSnapshot;
  let figs: NormBlock[];
  beforeAll(async () => {
    tpl = await canonicalTemplate();
    snap = snapshotOf(loadFixtureDoc('doc_terbit_report'));
    figs = snap.blocks.filter((b) => ['chart', 'diagram', 'symbolSheet'].includes(b.type));
  }, 60_000);

  function docPrs(xml: string): Array<Record<string, string>> {
    return [...xml.matchAll(/<wp:docPr\b([^>]*)\/>/g)].map((m) => Object.fromEntries([...m[1].matchAll(/(\w+)="([^"]*)"/g)].map((a) => [a[1], unescapeXml(a[2])])));
  }

  it('wp:docPr name/title/descr bermakna untuk setiap figur; tanpa "Picture"', () => {
    expect(figs.length).toBeGreaterThan(0);
    const { ctx } = makeCtx(snap, tpl);
    for (const b of figs) {
      const xml = DOCX_RENDERERS[b.type]!(b, ctx).xml;
      const prs = docPrs(xml);
      expect(prs.length).toBeGreaterThan(0);
      const label = b.artifactLabel ?? snap.numbering[b.blockId];
      for (const p of prs) {
        expect(p.name).not.toMatch(/^Picture\b/);
        expect(p.name.startsWith(`${label} — `)).toBe(true);
        expect(p.title).toBe(p.name);
        expect(p.descr.startsWith(`${label} — `)).toBe(true);
        expect(p.descr).toMatch(/Sumber: \S/);
      }
    }
  });

  it('HTML alt/aria-label = descr DOCX yang sama (satu sumber)', () => {
    const { ctx } = makeCtx(snap, tpl);
    for (const b of figs) {
      const docx = docPrs(DOCX_RENDERERS[b.type]!(b, ctx).xml)[0];
      const html = HTML_RENDERERS[b.type]!(b, ctx);
      const alt = /\b(?:alt|aria-label)="([^"]*)"/.exec(html);
      expect(alt, b.blockId).not.toBeNull();
      const text = unescapeXml(alt![1]);
      if (b.type === 'symbolSheet') expect(text.startsWith(docx.descr.split(' Sumber:')[0].replace(/\.$/, ''))).toBe(true);
      else expect(text).toBe(docx.descr);
    }
  });

  it('caption kosong pada DOCX: label + jenis figur', () => {
    const { ctx } = makeCtx(snap, tpl);
    const chart = figs.find((b) => b.type === 'chart')!;
    const content = { ...(chart.content as object), caption: { ...(chart.content as { caption: object }).caption, inline: { text: '' } } };
    const xml = DOCX_RENDERERS.chart!({ ...chart, content } as NormBlock, ctx).xml;
    const p = docPrs(xml)[0];
    const label = chart.artifactLabel ?? snap.numbering[chart.blockId];
    expect(p.name).toMatch(new RegExp(`^${label.replace('.', '\.')} — Grafik`));
  });
});
