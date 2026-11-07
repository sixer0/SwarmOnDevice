// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/renderers/rh03-rule-colour-precedence.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
// RH-03 / R-72 (lanjutan C14 GF-22, temuan C25 F1): di bawah preset `datum-gsp` garis bawah kepala
// halaman datang dari `render.section.interior.header.format.borders.bottom` preset dan menimpa
// warna R-72. Aturan presedensi: R-72 berbeda dari bawaan registri (C3CBD1) = warna garis menang;
// R-72 absen atau = bawaan = presedensi lama (garis preset menang, byte identik).
// Format seksi di bawah = salinan literal `render.section.interior` preset `datum-gsp`
// (`C:/tmp/c25/in/datum-gsp.preset.json`, sumber C25).
import { beforeAll, describe, expect, it } from '../_vitest';
import type { ParamMap, ResolvedTemplate, StudioDocV1 } from '@/lib/studio/contract';
import { assembleDocxDetailed } from '@/lib/studio/engine/docx/assemble';
import { canonicalTemplate, loadFixtureDoc, makeCtx, partText, sha256, snapshotOf, unzip } from './_kit';

type Lang = 'ID' | 'EN';

const R72 = 'runningHead.ruleColour';

/** `render.section.interior` preset `datum-gsp`, dengan warna garis bawah kepala yang bisa diganti. */
function presetInterior(headRule = 'C3CBD1'): ParamMap[string] {
  return {
    pageSizeTw: [11906, 16838],
    marginTw: { top: 1474, bottom: 1361, left: 1361, right: 1134, header: 737, footer: 737, gutter: 0 },
    cols: { num: 1, spaceTw: 720 },
    docGridLinePitch: 360,
    header: {
      mode: 'runningHead',
      format: {
        spacingBeforeTw: 0,
        spacingAfterTw: 0,
        lineTw: 180,
        lineRule: 'exact',
        tabs: [{ posTw: 9411, val: 'right' }],
        borders: { bottom: { val: 'single', sz: 5, color: headRule, space: 1 } },
      },
    },
    footer: { mode: 'registerBlock' },
  } as unknown as ParamMap[string];
}

let base: ResolvedTemplate;

beforeAll(async () => {
  base = await canonicalTemplate();
});

/** Templat kanonik + format seksi preset; `set` ditimpa, `drop` dihapus (kasus "absen"). */
function presetTpl(set: ParamMap = {}, drop: string[] = [], headRule?: string): ResolvedTemplate {
  const params: Record<string, ParamMap[string]> = { ...base.params, 'render.section.interior': presetInterior(headRule), ...set };
  for (const k of drop) delete params[k];
  return { ...base, params };
}

async function render(lang: Lang, tpl: ResolvedTemplate) {
  const doc = JSON.parse(JSON.stringify(loadFixtureDoc('doc_terbit_report'))) as StudioDocV1;
  doc.meta.language = lang;
  const { ctx } = makeCtx(snapshotOf(doc), tpl);
  const detail = await assembleDocxDetailed(ctx);
  return { bytes: detail.bytes, parts: unzip(detail.bytes) };
}

/** `w:pBdr` bawah paragraf kepala halaman (header bermode runningHead = memuat tab kanan). */
function runningHeadBottomBorders(o: { parts: Record<string, Uint8Array> }): string[] {
  return Object.keys(o.parts)
    .filter((p) => /^word\/header\d+\.xml$/.test(p))
    .sort()
    .map((p) => partText(o.parts, p))
    .filter((x) => x.includes('<w:tab/>'))
    .map((x) => /<w:pBdr><w:bottom ([^/]*)\/><\/w:pBdr>/.exec(x)?.[1] ?? 'none');
}

describe('RH-03: presedensi R-72 atas garis kepala halaman preset datum-gsp', () => {
  it.each(['ID', 'EN'] as const)('%s preset datum-gsp + R-72 6E1420: garis kepala 6E1420, ukuran preset tetap', async (lang) => {
    const o = await render(lang, presetTpl({ [R72]: '6E1420' }));
    const heads = runningHeadBottomBorders(o);
    expect(heads.length).toBeGreaterThan(0);
    expect(new Set(heads)).toEqual(new Set(['w:val="single" w:sz="5" w:space="1" w:color="6E1420"']));
  });

  it('R-72 "#6e1420" dikanonikkan ke 6E1420 juga di bawah preset', async () => {
    const o = await render('ID', presetTpl({ [R72]: '#6e1420' }));
    expect(new Set(runningHeadBottomBorders(o))).toEqual(new Set(['w:val="single" w:sz="5" w:space="1" w:color="6E1420"']));
  });

  it.each(['ID', 'EN'] as const)('%s preset datum-gsp: R-72 absen = bawaan eksplisit = byte identik, garis C3CBD1', async (lang) => {
    const absent = await render(lang, presetTpl({}, [R72]));
    const explicit = await render(lang, presetTpl({ [R72]: 'C3CBD1' }));
    const invalid = await render(lang, presetTpl({ [R72]: 'merah' }));
    expect(new Set(runningHeadBottomBorders(absent))).toEqual(new Set(['w:val="single" w:sz="5" w:space="1" w:color="C3CBD1"']));
    expect(sha256(explicit.bytes)).toBe(sha256(absent.bytes));
    expect(sha256(invalid.bytes)).toBe(sha256(absent.bytes));
  });

  it('garis preset non-bawaan tetap menang bila R-72 absen atau = bawaan (presedensi lama)', async () => {
    const absent = await render('ID', presetTpl({}, [R72], 'AABBCC'));
    const explicit = await render('ID', presetTpl({ [R72]: 'c3cbd1' }, [], 'AABBCC'));
    expect(new Set(runningHeadBottomBorders(absent))).toEqual(new Set(['w:val="single" w:sz="5" w:space="1" w:color="AABBCC"']));
    expect(sha256(explicit.bytes)).toBe(sha256(absent.bytes));
    const opted = await render('ID', presetTpl({ [R72]: '6E1420' }, [], 'AABBCC'));
    expect(new Set(runningHeadBottomBorders(opted))).toEqual(new Set(['w:val="single" w:sz="5" w:space="1" w:color="6E1420"']));
  });
});
