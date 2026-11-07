// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/contract/fig03a-chart-intent-schema.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
// FIG-03a (D-482 butir 2): medan maksud analitis opsional blok chart v2 (`orientation`, `sort`,
// `topN` + `otherLabel`, `labelShort`) — skema menerima bentuk sah, menolak bentuk salah dengan
// `checkId: "CHART_INTENT"` dan pointer medan yang salah; medan tampilan murni tetap ditolak.
import { describe, expect, it } from '../_vitest';
import { validateAgainst, validateV2Against } from '@/lib/studio/services/ingest/validate';

type Json = Record<string, unknown>;

const B = '/chapter/sections/0/blocks/0';
const data = { shape: 'categorical', points: [{ label: 'Dinas Pekerjaan Umum', value: 3 }, { label: 'Dinas Kesehatan', value: 2 }] };
const chart = (extra: Json) => ({ type: 'chart', code: 'P-02', caption: { text: 'Grafik' }, source: { text: 'Sumber uji' }, data, ...extra });
const doc = (block: Json) => ({
  $schema: 'studio.chapter/v2',
  target: { mission: { folder: '2026-11-02_fig03a' }, docKey: 'fig03a-uji' },
  chapter: { key: '1', title: { text: 'Ringkasan' }, sections: [{ title: { text: 'Hasil' }, blocks: [block] }] },
});
const issues = (extra: Json) => validateV2Against('studio.chapter/v2', doc(chart(extra)));
const brief = (extra: Json) => issues(extra).map((i) => [i.checkId ?? null, i.pointer]);

describe('FIG-03a skema v2: medan maksud diterima', () => {
  it('tanpa medan maksud tetap sah (paritas)', () => {
    expect(issues({})).toEqual([]);
  });
  it('semua medan sekaligus sah', () => {
    expect(
      issues({
        orientation: 'horizontal',
        sort: 'desc',
        topN: 8,
        otherLabel: 'Dinas lain',
        labelShort: [{ label: 'Dinas Pekerjaan Umum', short: 'DPU' }],
      }),
    ).toEqual([]);
  });
  it('nilai batas: topN 3 dan 30, orientation auto, sort none/asc', () => {
    for (const extra of [{ topN: 3 }, { topN: 30 }, { orientation: 'auto' }, { orientation: 'vertical' }, { sort: 'none' }, { sort: 'asc' }]) {
      expect(issues(extra)).toEqual([]);
    }
  });
});

describe('FIG-03a skema v2: penolakan ber-pointer CHART_INTENT', () => {
  it('orientation / sort di luar enum', () => {
    expect(brief({ orientation: 'diagonal' })).toEqual([['CHART_INTENT', `${B}/orientation`]]);
    expect(brief({ sort: 'random' })).toEqual([['CHART_INTENT', `${B}/sort`]]);
    expect(issues({ sort: 'random' })[0].message).toContain('"none", "desc", "asc"');
  });
  it('topN di luar 3..30 atau bukan bilangan bulat', () => {
    for (const topN of [2, 31, 8.5, '8']) {
      expect(brief({ topN })).toEqual([['CHART_INTENT', `${B}/topN`]]);
    }
    expect(issues({ topN: 2 })[0].message).toContain('3..30');
  });
  it('otherLabel tanpa topN, atau terlalu panjang', () => {
    expect(brief({ otherLabel: 'Lain' })).toEqual([['CHART_INTENT', `${B}/otherLabel`]]);
    expect(issues({ otherLabel: 'Lain' })[0].message).toBe('otherLabel hanya diterima bersama topN');
    expect(brief({ topN: 5, otherLabel: 'x'.repeat(41) })).toEqual([['CHART_INTENT', `${B}/otherLabel`]]);
  });
  it('labelShort: bentuk pasangan salah menunjuk butir/medannya', () => {
    expect(brief({ labelShort: [{ label: 'Dinas Kesehatan' }] })).toEqual([['CHART_INTENT', `${B}/labelShort/0/short`]]);
    expect(brief({ labelShort: [{ label: 'Dinas Kesehatan', short: 'x'.repeat(33) }] })).toEqual([['CHART_INTENT', `${B}/labelShort/0/short`]]);
    expect(brief({ labelShort: [{ label: 'A', short: 'a' }, { short: 'b' }] })).toEqual([['CHART_INTENT', `${B}/labelShort/1/label`]]);
    expect(brief({ labelShort: [{ label: 'A', short: 'a', wrap: true }] })).toEqual([['CHART_INTENT', `${B}/labelShort/0`]]);
    expect(brief({ labelShort: [] })).toEqual([['CHART_INTENT', `${B}/labelShort`]]);
    expect(brief({ labelShort: { A: 'a' } })).toEqual([['CHART_INTENT', `${B}/labelShort`]]);
  });
});

describe('FIG-03a: medan tampilan murni tetap ditolak', () => {
  it('heightMm / params = DISPLAY_FIELD; labelWrap / legendPosition tidak dikenal', () => {
    expect(brief({ heightMm: 80 })).toEqual([['DISPLAY_FIELD', `${B}/heightMm`]]);
    expect(brief({ params: { 'chart.kind.P-02.valueLabel': false } })).toEqual([['DISPLAY_FIELD', `${B}/params`]]);
    for (const f of ['labelWrap', 'legendPosition', 'labelPosition', 'maxCategories']) {
      const out = issues({ [f]: true });
      expect(out.length).toBeGreaterThan(0);
      expect(out.every((i) => i.checkId !== 'CHART_INTENT')).toBe(true);
    }
  });
});

describe('FIG-03a skema v1: spec mesin membawa `intent`', () => {
  const spec = (intent?: unknown) => ({
    $schema: 'studio.chart/v1',
    kind: 'P-02',
    title: 'Uji.',
    source: 'Uji',
    widthMm: 166,
    data,
    ...(intent === undefined ? {} : { intent }),
  });
  it('intent sah diterima; tanpa intent tetap sah', () => {
    expect(validateAgainst('studio.chart/v1', spec())).toEqual([]);
    expect(validateAgainst('studio.chart/v1', spec({ orientation: 'horizontal', topN: 5, otherLabel: 'Lain', labelShort: [{ label: 'A', short: 'a' }] }))).toEqual([]);
  });
  it('intent salah ditolak (pointer /intent/...)', () => {
    expect(validateAgainst('studio.chart/v1', spec({ topN: 1 })).map((i) => i.pointer)).toContain('/intent/topN');
    expect(validateAgainst('studio.chart/v1', spec({ otherLabel: 'x' })).length).toBeGreaterThan(0);
    expect(validateAgainst('studio.chart/v1', spec({ heightMm: 3 })).length).toBeGreaterThan(0);
  });
});
