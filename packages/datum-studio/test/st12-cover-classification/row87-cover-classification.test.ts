// @ts-nocheck row 87: vitest-typed kit (ported) run under bun:test; checked at run time.
// Swarm 1.3.3 row 87 (ST-12, register section 7 "Cover classification source"): the cover classification strip
// (seal band) and the colophon take the classification from ONE field, `meta.classification`, with one fallback
// when it is empty (template `classification.level`, else the registry default "Terbatas").
// Replay R12 (research/replay/R12_u3_cover, rev 36 DOCX, document.xml): strip "KLASIFIKASI · TERBATAS" while the
// author-written colophon right read "Klasifikasi BIASA · Basis: GSP Diagram Manual Multi-Domain Rev B, 16-XI-2026";
// the store row of the document (R7 document.jsonl; number replaced by a synthetic one, row 146) has classification "Terbatas".
import { useStudioEnv } from '../ported/_env'; useStudioEnv();
import { beforeAll, describe, expect, it } from 'bun:test';

const S = await import('../ported/structure/_kit');
const R = await import('../ported/renderers/_kit');
const { composeV2 } = await import('../../vendor/src/lib/studio/services/compose');
const { assembleDocxDetailed } = await import('../../vendor/src/lib/studio/engine/docx/assemble');
const { assembleHtml } = await import('../../vendor/src/lib/studio/engine/html/assemble');
const T = await import('../../vendor/src/lib/studio/engine/front/texts');

const U3_COLOPHON = {
  left: { text: 'PT Gemilang Satria Perkasa · Dokumen GSP 000/GSP/LAP/XI/2026 Rev A · 17-XI-2026' },
  right: { text: 'Klasifikasi BIASA · Basis: GSP Diagram Manual Multi-Domain Rev B, 16-XI-2026' },
};

function compose(d: Record<string, any>) {
  const slots = S.datumSlots();
  return composeV2({ source: S.merge(d, undefined, { slots }).doc, skeleton: S.skeletonInput(slots), params: S.defaultParams() }).snapshot;
}

const docxBody = (parts: Record<string, Uint8Array>) =>
  (Buffer.from(parts['word/document.xml']).toString('utf8').match(/<w:t(?:\s[^>]*)?>[^<]*<\/w:t>/g) ?? []).map((x) => x.replace(/<[^>]+>/g, '')).join('|');

interface Out { html: string; docx: string; snap: any }
async function render(d: Record<string, any>): Promise<Out> {
  const tpl = await R.canonicalTemplate();
  const snap = compose(d);
  const parts = R.unzip((await assembleDocxDetailed(R.makeCtx(snap, tpl).ctx)).bytes);
  return { snap, docx: docxBody(parts), html: await assembleHtml(R.makeCtx(snap, tpl).ctx, { preview: false }) };
}

/** Level printed in the HTML seal band (strip) and every level named in the HTML colophon. */
function htmlLevels(html: string) {
  const strip = /<span class="st-seal-left">KLASIFIKASI · ([^<]+)<\/span>/.exec(html)?.[1];
  const colophon = [...html.matchAll(/data-role="cover\.colophon(?:Left|Right)">([^<]*)</g)].map((m) => m[1]).join(' | ');
  return { strip, colophon };
}

describe('row 87: u3 cover (R12) prints one classification in strip and colophon', () => {
  let o: Out;
  beforeAll(async () => {
    const d = S.e1();
    d.meta.classification = 'Terbatas';
    d.sections.cover = { ...d.sections.cover, colophon: U3_COLOPHON };
    o = await render(d);
  }, 180_000);

  it('HTML: strip TERBATAS and the written colophon names TERBATAS, never BIASA', () => {
    const l = htmlLevels(o.html);
    expect(l.strip).toBe('TERBATAS');
    expect(l.colophon).toContain('Klasifikasi TERBATAS · Basis: GSP Diagram Manual Multi-Domain Rev B, 16-XI-2026');
    // visible text only: the embedded font data (base64 in <style>) can hold the letters "BIASA" by chance.
    expect(o.html.replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<meta[^>]*>/g, ' ')).not.toContain('BIASA');
  });

  it('DOCX: strip and colophon both TERBATAS, never BIASA', () => {
    expect(o.docx).toContain('KLASIFIKASI · TERBATAS');
    expect(o.docx).toContain('Klasifikasi TERBATAS · Basis: GSP Diagram Manual Multi-Domain Rev B, 16-XI-2026');
    expect(o.docx).not.toContain('BIASA');
  });

  it('the author text around the classification is kept (left untouched)', () => {
    expect(o.docx).toContain(U3_COLOPHON.left.text);
    expect(o.snap.doc.front.cover.data.colophon.left).toEqual(U3_COLOPHON.left);
  });
});

describe('row 87: auto colophon prints its "klasifikasi" field from the same field as the strip', () => {
  let o: Out;
  beforeAll(async () => {
    const d = S.e1();
    d.meta.classification = 'Rahasia';
    o = await render(d);
  }, 180_000);

  it('HTML: strip RAHASIA and colophon "Klasifikasi : RAHASIA"', () => {
    const l = htmlLevels(o.html);
    expect(l.strip).toBe('RAHASIA');
    expect(l.colophon).toContain('Klasifikasi : RAHASIA');
  });

  it('DOCX: strip RAHASIA and colophon "Klasifikasi : RAHASIA"', () => {
    expect(o.docx).toContain('KLASIFIKASI · RAHASIA');
    expect(o.docx).toContain('Klasifikasi : RAHASIA');
  });
});

describe('row 87: no classification prints the same fallback in strip and colophon', () => {
  it('render path: classification absent -> both TERBATAS (registry default via classification.level)', async () => {
    const d = S.e1();
    expect(d.meta).not.toHaveProperty('classification');
    const o = await render(d);
    expect(htmlLevels(o.html)).toEqual({ strip: 'TERBATAS', colophon: expect.stringContaining('Klasifikasi : TERBATAS') });
    expect(o.docx).toContain('KLASIFIKASI · TERBATAS');
    expect(o.docx).toContain('Klasifikasi : TERBATAS');
  }, 180_000);

  const meta = (classification: string) => ({ ...S.e1().meta, classification, language: 'ID', issueDate: '2026-11-17', rev: 'A' });

  it('texts: empty field, no template level -> strip and colophon both the registry default', () => {
    expect(T.coverClassificationOf(meta('  '), {})).toBe(T.COVER_CLASSIFICATION_FALLBACK);
    expect(T.sealBandTextsOf(meta(''), {})[0]).toBe('KLASIFIKASI · TERBATAS');
    expect(T.colophonTexts(meta(''), {}).left).toContain('Klasifikasi : TERBATAS');
  });

  it('texts: empty field, template level "Biasa" -> strip and colophon both BIASA', () => {
    const p = { 'classification.level': 'Biasa' };
    expect(T.sealBandTextsOf(meta(''), p)[0]).toBe('KLASIFIKASI · BIASA');
    expect(T.colophonTexts(meta(''), p).left).toContain('Klasifikasi : BIASA');
  });

  it('texts: a written colophon mention is re-derived from the field; text without one is unchanged', () => {
    const m = meta('Terbatas');
    expect(T.colophonClassificationText('Klasifikasi BIASA · Basis: X', m, {})).toBe('Klasifikasi TERBATAS · Basis: X');
    expect(T.colophonClassificationText('klasifikasi: Sangat Rahasia', m, {})).toBe('klasifikasi: TERBATAS');
    expect(T.colophonClassificationText('Classification: RESTRICTED', { ...m, classification: 'Rahasia' }, {})).toBe('Classification: RAHASIA');
    expect(T.colophonClassificationText('Basis: dokumen biasa', m, {})).toBe('Basis: dokumen biasa');
  });
});
