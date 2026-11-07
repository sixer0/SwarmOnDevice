// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/renderers/c34b-rhythm-min-baseline.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
// Review C34 follow-up #5 (decision D-650): under R-74 `render.rhythm.snapToBaseline` a NON-ZERO spacing never
// rounds to 0. Rule: spacing goes to the nearest multiple of the baseline (13.5 pt = 270 tw), with a minimum of one
// baseline; 0 stays 0 and an absent value stays absent. Blocks whose end is padded to the grid (caption / KEY /
// SOURCE with an exact line, drawing paragraphs) keep their own trailing spacing and pad it up to the next grid line,
// so the trailing gap is never smaller than authored and the block still ends on the grid (GF-21 intent).
//
// Expected values are worked examples of that rule from the review's measurements (verification/34 #5,
// coder_execution_engine_e.md): section heading after 80 -> 270 (was 0, heading flush on the body), caption
// 120/48/220 -> 270/50/220 (was 0/50/220), kicker after 80 -> 270 (was 0).
import { beforeAll, describe, expect, it } from '../_vitest';
import type { NormDocSnapshot, ParamMap, ResolvedTemplate, StudioDocV1 } from '@/lib/studio/contract';
import { assembleDocxDetailed } from '@/lib/studio/engine/docx/assemble';
import { snapApparatusPara, snapDrawingPara, snapParaToBaseline } from '@/lib/studio/engine/docx/blocks/rhythm';
import { assembleHtml } from '@/lib/studio/engine/html/assemble';
import { withParams } from '../engine-core/fixtures';
import { benchmarkTemplate, loadFixtureDoc, makeCtx, partText, snapshotOf, unzip } from './_kit';

const SNAP = 'render.rhythm.snapToBaseline';
const BASE = 270;

describe('rhythm rule: non-zero spacing never rounds to 0 (pure functions)', () => {
  it('heading-style paragraph: small gaps become one baseline, larger gaps go to the nearest multiple', () => {
    expect(snapParaToBaseline({ spacingBeforeTw: 0, spacingAfterTw: 80, lineTw: 180, lineRule: 'exact' }, BASE)).toEqual({
      spacingBeforeTw: 0,
      spacingAfterTw: 270,
      lineTw: 270,
      lineRule: 'exact',
    });
    expect(snapParaToBaseline({ spacingBeforeTw: 1, spacingAfterTw: 134 }, BASE)).toEqual({ spacingBeforeTw: 270, spacingAfterTw: 270 });
    // Nearest multiple above one baseline (not rounded up): 300 -> 270, 404 -> 270, 405 -> 540, 410 -> 540.
    expect(snapParaToBaseline({ spacingBeforeTw: 300, spacingAfterTw: 404 }, BASE)).toEqual({ spacingBeforeTw: 270, spacingAfterTw: 270 });
    expect(snapParaToBaseline({ spacingBeforeTw: 405, spacingAfterTw: 410 }, BASE)).toEqual({ spacingBeforeTw: 540, spacingAfterTw: 540 });
  });

  it('zero stays zero, absent stays absent, auto lines are untouched', () => {
    expect(snapParaToBaseline({ spacingBeforeTw: 0, spacingAfterTw: 0 }, BASE)).toEqual({ spacingBeforeTw: 0, spacingAfterTw: 0 });
    expect(snapParaToBaseline({ lineTw: 240, lineRule: 'auto' }, BASE)).toEqual({ lineTw: 240, lineRule: 'auto' });
    expect(snapParaToBaseline({}, BASE)).toEqual({});
  });

  it('apparatus (exact line): before at least one baseline, line kept, after = authored gap padded to the grid', () => {
    // Caption Table 8.2: 120/48/220 -> 270/50/220; block 270 + 220 + 50 = 540 = 2 baselines.
    expect(snapApparatusPara({ spacingBeforeTw: 120, spacingAfterTw: 48, lineTw: 220, lineRule: 'exact' }, BASE)).toEqual({
      spacingBeforeTw: 270,
      spacingAfterTw: 50,
      lineTw: 220,
      lineRule: 'exact',
    });
    // Zero before stays zero; an absent after is padded from 0.
    expect(snapApparatusPara({ spacingBeforeTw: 0, lineTw: 220, lineRule: 'exact' }, BASE)).toEqual({ spacingBeforeTw: 0, spacingAfterTw: 50, lineTw: 220, lineRule: 'exact' });
    // A larger authored after is padded, not rounded first: 0 + 220 + 200 = 420 -> 540, after 320 (>= 200).
    expect(snapApparatusPara({ spacingBeforeTw: 0, spacingAfterTw: 200, lineTw: 220, lineRule: 'exact' }, BASE)).toEqual({
      spacingBeforeTw: 0,
      spacingAfterTw: 320,
      lineTw: 220,
      lineRule: 'exact',
    });
  });

  it('drawing paragraph: before at least one baseline, after = authored gap padded so the block ends on the grid', () => {
    // Datum Rule paragraph (engine E): 137 tw image, after 80 -> 133 (block 270), unchanged by the new rule.
    expect(snapDrawingPara({ spacingAfterTw: 80 }, 137, BASE)).toEqual({ spacingAfterTw: 133 });
    // before 60 -> 270; 270 + 1100 + 200 = 1570 -> 1620 (6 baselines), after 250 (not 270 + pad = 520).
    expect(snapDrawingPara({ spacingBeforeTw: 60, spacingAfterTw: 200 }, 1100, BASE)).toEqual({ spacingBeforeTw: 270, spacingAfterTw: 250 });
  });
});

// ── Rendered DOCX and HTML (datum-gsp family: measured Manual 000 profile + framePr rail) ────────────────

let GSP: ResolvedTemplate;
beforeAll(async () => {
  GSP = withParams(await benchmarkTemplate(), { 'render.rail.renderer': 'framePr' });
});

const tplOn = (): ResolvedTemplate => ({ ...GSP, params: { ...GSP.params, [SNAP]: true } as ParamMap });
const snapOf = (lang: 'ID' | 'EN'): NormDocSnapshot => {
  const doc = JSON.parse(JSON.stringify(loadFixtureDoc('doc_terbit_report'))) as StudioDocV1;
  doc.meta.language = lang;
  return snapshotOf(doc);
};
const paragraphs = (xml: string) => xml.match(/<w:p[ >][\s\S]*?<\/w:p>/g) ?? [];
const textOf = (p: string) => (p.match(/<w:t[^>]*>[^<]*<\/w:t>/g) ?? []).map((t) => t.replace(/<[^>]+>/g, '')).join('');
const spacingOf = (p: string) => {
  const m = /<w:spacing ([^>]*)\/>/.exec(p.replace(/<w:rPr>[\s\S]*?<\/w:rPr>/g, ''))?.[1] ?? '';
  const a = (k: string) => {
    const hit = new RegExp('w:' + k + '="([0-9]+)"').exec(m);
    return hit ? Number(hit[1]) : undefined;
  };
  return { before: a('before'), after: a('after'), line: a('line'), rule: /w:lineRule="(\w+)"/.exec(m)?.[1] };
};

describe('rendered DOCX under R-74: no heading or caption gap collapses to 0', () => {
  it.each(['ID', 'EN'] as const)('%s: section headings sit one baseline above the body (after 80 -> 270)', async (lang) => {
    const { ctx } = makeCtx(snapOf(lang), tplOn());
    const xml = partText(unzip((await assembleDocxDetailed(ctx)).bytes), 'word/document.xml');
    const sections = paragraphs(xml).filter((p) => p.includes('<w:outlineLvl w:val="1"/>'));
    expect(sections.length).toBeGreaterThan(3);
    for (const h of sections) expect(spacingOf(h), textOf(h)).toEqual({ before: 270, after: 270, line: 270, rule: 'exact' });
  }, 60_000);

  it.each(['ID', 'EN'] as const)('%s: table captions 120/48/220 -> 270/50/220', async (lang) => {
    const { ctx } = makeCtx(snapOf(lang), tplOn());
    const paras = paragraphs(partText(unzip((await assembleDocxDetailed(ctx)).bytes), 'word/document.xml'));
    const captions = paras.filter((p) => /^(Tabel|Table) [0-9A-Z]/.test(textOf(p)) && /<w:spacing [^>]*w:line="220"/.test(p));
    expect(captions.length).toBeGreaterThan(0);
    for (const c of captions) expect(spacingOf(c), textOf(c)).toEqual({ before: 270, after: 50, line: 220, rule: 'exact' });
  }, 60_000);
});

const styleOf = (h: string, cls: string): string => new RegExp(`<[a-z0-9]+ class="[^"]*\\b${cls}\\b[^"]*"[^>]*style="([^"]*)"`).exec(h)?.[1] ?? '';
const paraPart = (style: string): string => style.split(';').filter((d) => /^(margin-top|margin-bottom|line-height):/.test(d)).join(';');

describe('HTML preview follows the same rule', () => {
  it.each(['ID', 'EN'] as const)('%s: kicker and section heading keep one baseline below; caption one baseline above', async (lang) => {
    const { ctx } = makeCtx(snapOf(lang), tplOn());
    const h = await assembleHtml(ctx, { preview: false });
    expect(paraPart(styleOf(h, 'st-chapter-kicker'))).toBe('margin-top:0pt;margin-bottom:13.5pt;line-height:13.5pt');
    expect(paraPart(styleOf(h, 'st-section-heading'))).toBe('margin-top:13.5pt;margin-bottom:13.5pt;line-height:13.5pt');
    expect(paraPart(styleOf(h, 'st-caption'))).toBe('margin-top:13.5pt;margin-bottom:2.5pt;line-height:11pt');
  }, 60_000);
});
