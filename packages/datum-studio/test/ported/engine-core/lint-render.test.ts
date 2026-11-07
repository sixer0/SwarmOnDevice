// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/engine-core/lint-render.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
// S71: uji unit engine/lint/render (I35; S45). Batas render selalu finit
// (regresi F-044 / IP-32: `reduce(Math.min)` dulu menghasilkan NaN), cek R
// menghasilkan PASS/FAIL/NOT_RUN beralasan dan tidak pernah melempar.
import { describe, it, expect } from '../_vitest';
import type { LayoutMetrics, ParamMap, SvgResult } from '@/lib/studio/contract';
import {
  RENDER_CHECK_IDS,
  RENDER_LINT_DEFAULTS,
  analyseSvg,
  lintRendered,
  lintRenderedWith,
  renderLintLimitsFromParams,
  type RenderLintLimits,
} from '@/lib/studio/engine/lint/render';
import { benchmarkTemplate, canonicalTemplate, statuses } from './fixtures';

const NUMERIC: Array<keyof RenderLintLimits> = ['maxColoursPerPage', 'maxColoursPerFigure', 'minFigureTypePt', 'maxFigureHeightMm'];
const EXPECTED_CANON = { maxColoursPerPage: 5, maxColoursPerFigure: 5, measureChars: [66, 80], minFigureTypePt: 5.5, maxFigureHeightMm: 247 };

function finiteLimits(l: RenderLintLimits): void {
  for (const k of NUMERIC) {
    expect(Number.isFinite(l[k] as number), k).toBe(true);
    expect(l[k] as number, k).toBeGreaterThan(0);
  }
  expect(l.measureChars.every((n) => Number.isFinite(n) && n > 0)).toBe(true);
}

const EMPTY_METRICS: LayoutMetrics = { pageCount: 0, elements: [] };

/** SVG 6 warna kromatik, teks 4 pt, setinggi 260 mm (kasus bukti INT-O). */
function badSvg(): SvgResult {
  const colours = ['#E11D48', '#2563EB', '#16A34A', '#F59E0B', '#9333EA', '#0891B2'];
  const rects = colours.map((c, i) => `<rect x="${i * 10}" y="0" width="8" height="8" fill="${c}"/>`).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="128mm" height="260mm" viewBox="0 0 128 260">${rects}<text x="1" y="20" font-size="${(4 * 25.4) / 72}">label kecil</text></svg>`;
  return { svg, widthMm: 128, heightMm: 260, report: { checksRun: [], issues: [] } };
}

function goodSvg(): SvgResult {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="128mm" height="60mm" viewBox="0 0 128 60">' +
    '<rect x="0" y="0" width="20" height="10" fill="#B45309"/><rect x="30" y="0" width="20" height="10" fill="#101418"/>' +
    `<text x="1" y="30" font-size="${(7 * 25.4) / 72}">label cukup</text></svg>`;
  return { svg, widthMm: 128, heightMm: 60, report: { checksRun: [], issues: [] } };
}

describe('renderLintLimitsFromParams: batas selalu finit (regresi F-044)', () => {
  it('profil kanonik dan benchmark -> {5, 5, [66,80], 5,5 pt, 247 mm}', async () => {
    for (const tpl of [canonicalTemplate(), await benchmarkTemplate()]) {
      const l = renderLintLimitsFromParams(tpl.params);
      finiteLimits(l);
      expect(l).toMatchObject(EXPECTED_CANON);
    }
  });

  it('dua kunci berlaku: yang lebih ketat menang (warna/tinggi minimum, huruf maksimum)', () => {
    const l = renderLintLimitsFromParams({
      'chart.maxColors': 4,
      'diagram.maxColors': 3,
      'chart.minFontPt': 6,
      'diagram.minFontPt': 5.5,
      'diagram.maxHeightMm': 200,
      'grid.textBlockHeightMm': 247,
    });
    expect(l.maxColoursPerFigure).toBe(3);
    expect(l.minFigureTypePt).toBe(6);
    expect(l.maxFigureHeightMm).toBe(200);
  });

  it('string angka diterima', () => {
    expect(renderLintLimitsFromParams({ 'color.maxValuesPerPage': ' 4 ' } as ParamMap).maxColoursPerPage).toBe(4);
  });

  const JUNK: unknown[] = [Number.NaN, Number.POSITIVE_INFINITY, -1, 0, '', 'lima', '1e400', [5], { v: 5 }, null, true, '0x10'];
  it.each(JUNK.map((v) => [v]))('nilai sampah %j -> default katalog, tidak pernah NaN', (v) => {
    const p = {
      'color.maxValuesPerPage': v,
      'chart.maxColors': v,
      'diagram.maxColors': v,
      'chart.minFontPt': v,
      'diagram.minFontPt': v,
      'diagram.maxHeightMm': v,
      'grid.textBlockHeightMm': v,
      'type.body.measureChars': [v, v],
    } as unknown as ParamMap;
    const l = renderLintLimitsFromParams(p);
    finiteLimits(l);
    expect(l).toMatchObject(EXPECTED_CANON);
  });

  it('satu kunci sah + satu sampah: kunci sah dipakai (tidak ter-NaN oleh tetangganya)', () => {
    const l = renderLintLimitsFromParams({ 'chart.maxColors': 4, 'diagram.maxColors': Number.NaN } as ParamMap);
    expect(l.maxColoursPerFigure).toBe(4);
  });

  it('base rusak (NaN) jatuh ke default katalog', () => {
    const base = { ...RENDER_LINT_DEFAULTS, maxColoursPerPage: Number.NaN, maxFigureHeightMm: -5 };
    const l = renderLintLimitsFromParams({}, base);
    expect(l.maxColoursPerPage).toBe(5);
    expect(l.maxFigureHeightMm).toBe(247);
  });

  it('rentang ukuran baris terbalik ditolak ke default', () => {
    expect(renderLintLimitsFromParams({ 'type.body.measureChars': [80, 66] }).measureChars).toEqual([66, 80]);
    expect(renderLintLimitsFromParams({ 'type.body.measureChars': [60, 70] }).measureChars).toEqual([60, 70]);
  });
});

describe('lintRendered: cek R', () => {
  it('SVG 6 warna / 4 pt / 260 mm -> FAIL DATUM-25, 28, 33 (bukti INT-O)', () => {
    const out = lintRenderedWith({ svgs: [badSvg()], metrics: EMPTY_METRICS }, renderLintLimitsFromParams(canonicalTemplate().params));
    expect(statuses(out, 'DATUM-25')).toEqual(['FAIL']);
    expect(statuses(out, 'DATUM-28')).toEqual(['FAIL']);
    expect(statuses(out, 'DATUM-33')).toEqual(['FAIL']);
  });

  it('SVG sah -> PASS 25, 28, 33', () => {
    const out = lintRendered({ svgs: [goodSvg()], metrics: EMPTY_METRICS });
    for (const id of ['DATUM-25', 'DATUM-28', 'DATUM-33']) expect(statuses(out, id), id).toEqual(['PASS']);
  });

  it('setiap cek R menghasilkan minimal satu butir; tanpa metrik -> 14/15/37 NOT_RUN beralasan', () => {
    const out = lintRendered({ svgs: [], metrics: EMPTY_METRICS });
    for (const id of RENDER_CHECK_IDS) expect(out.some((i) => i.checkId === id), id).toBe(true);
    for (const id of ['DATUM-14', 'DATUM-15', 'DATUM-37']) {
      expect(statuses(out, id), id).toEqual(['NOT_RUN']);
      expect((out.find((i) => i.checkId === id)?.detail ?? '').length, id).toBeGreaterThan(0);
    }
  });

  it('metrik halaman: > 5 nilai warna -> FAIL 14; luapan -> FAIL 37; ramp tinta dihitung satu keluarga', () => {
    const metrics = {
      pageCount: 2,
      elements: [
        { kind: 'page', page: 1, colors: ['#E11D48', '#2563EB', '#16A34A', '#F59E0B', '#9333EA', '#0891B2'] },
        { kind: 'page', page: 2, colors: ['#101418', '#2B3640', '#6B7783', '#C3CBD1', '#B45309'] },
        { kind: 'overflow', page: 2, overflowMm: 3.2, axis: 'right', label: 'tabel lebar' },
      ],
    } as unknown as LayoutMetrics;
    const out = lintRendered({ svgs: [], metrics });
    expect(statuses(out, 'DATUM-14')).toEqual(['FAIL']);
    expect(out.find((i) => i.checkId === 'DATUM-14')?.detail).toContain('halaman 1');
    expect(statuses(out, 'DATUM-37')).toEqual(['FAIL']);
  });

  it('metrik terpotong (truncated) tidak pernah PASS diam-diam untuk 14/37', () => {
    const metrics = { pageCount: 1, truncated: true, elements: [{ kind: 'page', page: 1, colors: ['#101418'] }] } as unknown as LayoutMetrics;
    const out = lintRendered({ svgs: [], metrics });
    expect(statuses(out, 'DATUM-14')).toEqual(['NOT_RUN']);
    expect(statuses(out, 'DATUM-37')).toEqual(['NOT_RUN']);
  });

  it.each([
    ['bukan SVG', '<html>bukan svg</html>'],
    ['SVG terpotong', '<svg xmlns="http://www.w3.org/2000/svg" width="10mm"'],
    ['entitas aneh', '<svg xmlns="http://www.w3.org/2000/svg"><!ENTITY x "y"><text font-size="NaN">&x;</text></svg>'],
    ['skrip', '<svg xmlns="http://www.w3.org/2000/svg"><script>globalThis.__s71_svg=1</script></svg>'],
  ])('SVG rusak (%s): tidak melempar, tidak mengeksekusi skrip', (_n, svg) => {
    const out = lintRendered({ svgs: [{ svg, widthMm: 128, heightMm: 50, report: { checksRun: [], issues: [] } }], metrics: EMPTY_METRICS });
    for (const id of RENDER_CHECK_IDS) expect(out.some((i) => i.checkId === id), id).toBe(true);
    expect((globalThis as Record<string, unknown>).__s71_svg).toBeUndefined();
  });

  it('masukan null/rusak tidak melempar', () => {
    expect(() => lintRendered(null as never)).not.toThrow();
    expect(() => lintRendered({ svgs: null as never, metrics: null as never })).not.toThrow();
    expect(() => lintRendered({ svgs: [null as never], metrics: { pageCount: 1, elements: [null, 5, 'x'] } as never })).not.toThrow();
  });

  it('HTML cadangan: SVG inline diurai bila tidak ada SVG mesin', () => {
    const html = `<html><body>${badSvg().svg}</body></html>`;
    const out = lintRendered({ html, svgs: [], metrics: EMPTY_METRICS });
    expect(statuses(out, 'DATUM-25')).toEqual(['FAIL']);
  });

  it('analyseSvg: ukuran huruf dihitung setelah skala viewBox (mm -> pt)', () => {
    const a = analyseSvg(goodSvg().svg, { widthMm: 128, heightMm: 60 });
    expect(a.texts[0].sizePt).toBeCloseTo(7, 2);
    expect(a.widthMm).toBeCloseTo(128, 3);
  });
});
