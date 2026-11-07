// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/figures/chart-smoke.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
// S73: render asap setiap kode chart `drawn=true` di registri (58 kode) x 2 gaya
// (datum, gallery): 0 FAIL lint, deterministik, akar SVG sesuai kanvas, XML berimbang.
// Spec: fixture paritas S63 (46 kode) + salinan panel galeri S94 (13 kode, termasuk K-08
// karena fixture paritas k08.json berisi 688 unit dan ditolak penjaga K-08 > 100 ikon).
import { describe, it, expect } from '../_vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { StudioChartV1 } from '@/lib/studio/contract';
import { renderChart } from '@/lib/studio/engine/chart/core';
import {
  CHART_HINT_PARAMS_COUNT,
  CHART_CATALOG_PARAMS_COUNT,
  CHART_ENGINE_PARAMS_COUNT,
  CHART_PARAMS,
  CHART_PARAMS_COUNT,
  CHART_REGISTRY,
  CHART_REGISTRY_COUNT,
} from '@/lib/studio/registry/charts';
import { PARITY_CHART_DIR, assertBalancedXml, catchErr, checkIdOf, chartSpecsByCode, clone, rootAttr } from './_helpers';

const SPECS = chartSpecsByCode();
const DRAWN = CHART_REGISTRY.filter((d) => d.drawn);
const STYLES = ['datum', 'gallery'] as const;

describe('registri chart (registry/charts.ts)', () => {
  it('76 entri = 58 tergambar + 18 tidak; kode unik', () => {
    expect(CHART_REGISTRY).toHaveLength(CHART_REGISTRY_COUNT);
    expect(CHART_REGISTRY_COUNT).toBe(76);
    expect(DRAWN).toHaveLength(58);
    expect(new Set(CHART_REGISTRY.map((d) => d.code)).size).toBe(76);
  });

  // SR-42 (D-215, IP-41c): +31 ParamDef petunjuk tergambar `chart.kind.<KODE>.<nama>`, pin 99 -> 130.
  // SR-42 lanjutan (D-268, FIX-A): +3 `chart.kind.{P-13,P-14,S-01}.axis`, pin 130 -> 133, petunjuk 31 -> 34.
  // D-287 (FIX-A2): +3 `chart.kind.{S-02,S-03,S-04}.axis`, pin 133 -> 136, petunjuk 34 -> 37.
  it('136 ParamDef = 87 katalog + 12 mesin (D-108) + 37 petunjuk (D-215, D-268, D-287); kunci unik berawalan chart.kind.<KODE> (nama boleh bertitik)', () => {
    expect(CHART_PARAMS).toHaveLength(CHART_PARAMS_COUNT);
    expect(CHART_PARAMS_COUNT).toBe(136);
    expect(CHART_CATALOG_PARAMS_COUNT).toBe(87);
    expect(CHART_ENGINE_PARAMS_COUNT).toBe(12);
    expect(CHART_HINT_PARAMS_COUNT).toBe(37);
    expect(CHART_CATALOG_PARAMS_COUNT + CHART_ENGINE_PARAMS_COUNT + CHART_HINT_PARAMS_COUNT).toBe(136);
    expect(new Set(CHART_PARAMS.map((p) => p.key)).size).toBe(136);
    for (const code of ['P-13', 'P-14', 'S-01', 'S-02', 'S-03', 'S-04']) expect(CHART_PARAMS.map((p) => p.key), code).toContain(`chart.kind.${code}.axis`);
    const codes = new Set(DRAWN.map((d) => d.code as string));
    for (const p of CHART_PARAMS) {
      const m = /^chart\.kind\.([A-Z]-\d{2})\.[A-Za-z][A-Za-z0-9.]*$/.exec(p.key);
      expect(m, p.key).not.toBeNull();
      expect(codes.has(m![1]), p.key).toBe(true);
    }
  });

  it('setiap kode tergambar punya spec asap', () => {
    expect(DRAWN.filter((d) => !SPECS[d.code]).map((d) => d.code)).toEqual([]);
  });
});

describe('render asap 58 kode tergambar x 2 gaya', () => {
  for (const def of DRAWN) {
    for (const style of STYLES) {
      it(`${def.code} (${def.module}) gaya ${style}`, () => {
        const spec = { ...clone(SPECS[def.code]), style } as unknown as StudioChartV1;
        const a = renderChart(clone(spec));
        const b = renderChart(clone(spec));
        expect(a.svg).toBe(b.svg);
        expect(a.report).toEqual(b.report);
        expect(a.report.issues.filter((i) => i.status === 'FAIL')).toEqual([]);
        expect(a.widthMm).toBe(spec.widthMm);
        expect(a.heightMm).toBeGreaterThan(0);
        expect(a.heightMm).toBeLessThanOrEqual(247);
        expect(rootAttr(a.svg, 'width')).toBe(`${a.widthMm}mm`);
        assertBalancedXml(a.svg);
        expect(a.svg).not.toMatch(/NaN|Infinity|undefined|\[object Object\]/);
        for (const id of ['DATUM-28', 'DATUM-25', 'DATUM-33', 'G2', 'DATUM-27', 'DATUM-13', 'DATUM-26']) {
          expect(a.report.checksRun, id).toContain(id);
        }
      });
    }
  }
});

describe('penjaga icon array K-08 (D-84: satu ikon per unit, > 100 unit ditolak)', () => {
  // SR-42: fixture paritas k08.json diselaraskan (F-S73-1 ditutup; kini 58+25+13+4
  // = 100 unit), jadi spec 688 unit (nilai fixture lama 400+170+90+28) dibentuk di uji.
  const k08 = () => JSON.parse(readFileSync(path.join(PARITY_CHART_DIR, 'k08.json'), 'utf8')) as StudioChartV1;

  it('k08.json paritas (100 unit) terender tanpa FAIL', () => {
    const r = renderChart(k08());
    expect(r.report.issues.filter((i) => i.status === 'FAIL')).toEqual([]);
  });

  it('spec 688 unit -> BY_CONSTRUCTION_FAILED checkId K-08 (> 100 ikon, pakai waffle K-07)', () => {
    const spec = clone(k08()) as unknown as { data: { points: Array<{ label: string; value: number }> } };
    for (const [i, v] of [400, 170, 90, 28].entries()) spec.data.points[i].value = v;
    const e = catchErr(() => renderChart(spec as unknown as StudioChartV1));
    expect(e.code).toBe('BY_CONSTRUCTION_FAILED');
    expect(checkIdOf(e)).toBe('K-08');
    expect(e.message).toContain('688 ikon > 100');
  });
});
