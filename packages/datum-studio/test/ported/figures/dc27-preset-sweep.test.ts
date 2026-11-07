// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/figures/dc27-preset-sweep.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
// DC-27 (D-368): sapuan paritas chart PRESET. Setiap kode tergambar x 2 gaya dirender dua
// kali (deterministik); sidik sha256 (SVG + tinggi + laporan, atau kode galat) ditulis ke
// berkas bila `DC27_SWEEP_OUT` diset, agar sapuan sebelum/sesudah perubahan mesin dapat
// dibandingkan byte demi byte. Murni lokal: fixture repo, tanpa DB/jaringan.
import { describe, it, expect } from '../_vitest';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import type { StudioChartV1 } from '@/lib/studio/contract';
import { estimateHeightMm, renderChart } from '@/lib/studio/engine/chart/core';
import { CHART_REGISTRY } from '@/lib/studio/registry/charts';
import { chartSpecsByCode, clone } from './_helpers';

const SPECS = chartSpecsByCode();
const DRAWN = CHART_REGISTRY.filter((d) => d.drawn);

function fingerprint(code: string, style: 'datum' | 'gallery'): string {
  const spec = clone(SPECS[code]) as unknown as StudioChartV1;
  spec.style = style;
  let v: string;
  try {
    const r = renderChart(spec);
    v = JSON.stringify({ svg: r.svg, h: estimateHeightMm(clone(spec)), report: r.report });
  } catch (e) {
    v = `ERR:${String((e as { code?: string }).code)}:${(e as Error).message}`;
  }
  return createHash('sha256').update(v).digest('hex');
}

describe('DC-27 sapuan paritas preset', () => {
  it('58 kode tergambar x 2 gaya: sidik deterministik', () => {
    const out: Record<string, string> = {};
    for (const def of DRAWN) {
      for (const style of ['datum', 'gallery'] as const) {
        const a = fingerprint(def.code, style);
        expect(fingerprint(def.code, style), `${def.code}/${style}`).toBe(a);
        out[`${def.code}/${style}`] = a;
      }
    }
    expect(Object.keys(out)).toHaveLength(116);
    const file = process.env.DC27_SWEEP_OUT;
    if (file) writeFileSync(file, `${JSON.stringify(out, null, 1)}\n`);
  });
});
