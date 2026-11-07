// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/figures/chart-key-label-en.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
// Legenda chart EN: label baris KUNCI di dalam gambar chart mengikuti bahasa dokumen ("KEY" untuk EN),
// sedangkan ID (dan pemanggil tanpa bahasa) tetap "KUNCI" byte-identik dengan perilaku lama.
import { describe, it, expect } from '../_vitest';
import type { StudioChartV1 } from '@/lib/studio/contract';
import { EMPTY_CHART_TEMPLATE, keyLabelText, withChartLang } from '@/lib/studio/engine/chart/core';
import { pureChartSvg } from '@/lib/studio/services/render/pure/chart';
import { CHART_REGISTRY } from '@/lib/studio/registry/charts';
import { chartSpecsByCode, clone } from './_helpers';

const SPECS = chartSpecsByCode();
const DRAWN = CHART_REGISTRY.filter((d) => d.drawn && SPECS[d.code]);
const STYLES = ['datum', 'gallery'] as const;

const specFor = (code: string, style: (typeof STYLES)[number]) => ({ ...clone(SPECS[code]), style }) as unknown as StudioChartV1;

describe('label baris KUNCI chart mengikuti bahasa dokumen', () => {
  it('keyLabelText: ID bawaan, EN di dalam withChartLang, status dipulihkan', () => {
    expect(keyLabelText()).toBe('KUNCI');
    expect(withChartLang('EN', () => keyLabelText())).toBe('KEY');
    expect(withChartLang('ID', () => keyLabelText())).toBe('KUNCI');
    expect(withChartLang(undefined, () => keyLabelText())).toBe('KUNCI');
    expect(() => withChartLang('EN', () => { throw new Error('x'); })).toThrow('x');
    expect(keyLabelText()).toBe('KUNCI');
  });

  const withKey: string[] = [];
  for (const def of DRAWN) {
    for (const style of STYLES) {
      it(`${def.code} gaya ${style}: ID = tanpa bahasa (byte-identik); EN tanpa KUNCI`, () => {
        const base = pureChartSvg(specFor(def.code, style), EMPTY_CHART_TEMPLATE).svg;
        const id = pureChartSvg(specFor(def.code, style), EMPTY_CHART_TEMPLATE, 'ID').svg;
        const en = pureChartSvg(specFor(def.code, style), EMPTY_CHART_TEMPLATE, 'EN').svg;
        expect(id).toBe(base);
        expect(en).not.toContain('>KUNCI<');
        if (base.includes('>KUNCI<')) {
          withKey.push(`${def.code}/${style}`);
          expect(en).toContain('>KEY<');
        } else {
          expect(en).toBe(base);
        }
      });
    }
  }

  it('fixture benar-benar menggambar baris KUNCI (uji tidak kosong)', () => {
    expect(withKey.length).toBeGreaterThan(0);
  });
});
