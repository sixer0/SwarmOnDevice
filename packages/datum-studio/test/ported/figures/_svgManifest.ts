// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/figures/_svgManifest.ts (see test/ported/README.md).
// ENG-FIX #3 (review ronde 4 #3): penjaga byte-identik di repo. Render fixture paritas chart
// (`tests/parity/fixtures/chart`, gaya datum + gallery) dan diagram (`tests/parity/fixtures/diagram`
// + `garis_a`, rilis + draf). Render "bersih" = render pertama yang lint-bersih dan dikembalikan apa
// adanya (chart: tanpa isu AUTO_FIT/GEOM_*; diagram: tanpa `report.geometry`). Sidik sha256 render
// bersih dikunci di `__fixtures__/clean-svg-manifest.json`. Murni lokal dan deterministik.
import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import type { StudioDiagramV1 } from '@/lib/studio/contract';
import { renderChart } from '@/lib/studio/engine/chart/core';
import { buildDiagramSvg } from '@/lib/studio/engine/diagram/build';
import { PARITY_CHART_DIR, PARITY_DIAGRAM_DIR, clone, readJson } from './_helpers';

export const CLEAN_SVG_MANIFEST = path.join(__dirname, '__fixtures__', 'clean-svg-manifest.json');

export interface ParityRender {
  id: string;
  svg: string;
  clean: boolean;
}

export interface CleanSvgManifest {
  note: string;
  /** Render lint-bersih: wajib byte-identik. */
  renders: Record<string, string>;
  /** Render fit (render pertama bercacat): terkunci; perubahan sah memperbarui manifest. */
  fitted: Record<string, string>;
}

export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

const jsonFiles = (dir: string): string[] =>
  readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort();

/** Semua render fixture paritas yang berhasil dirakit (penolakan dilewati), urutan tetap. */
export function parityRenders(): ParityRender[] {
  const out: ParityRender[] = [];
  for (const f of jsonFiles(PARITY_CHART_DIR)) {
    const spec = readJson<Record<string, unknown>>(path.join(PARITY_CHART_DIR, f));
    for (const style of ['datum', 'gallery']) {
      let r: ReturnType<typeof renderChart>;
      try {
        r = renderChart({ ...clone(spec), style } as never);
      } catch {
        continue;
      }
      const clean = !r.report.issues.some((i) => i.checkId === 'AUTO_FIT' || i.checkId.startsWith('GEOM_'));
      out.push({ id: `chart/${f}@${style}`, svg: r.svg, clean });
    }
  }
  const dgFiles = [...jsonFiles(PARITY_DIAGRAM_DIR), ...jsonFiles(path.join(PARITY_DIAGRAM_DIR, 'garis_a')).map((f) => `garis_a/${f}`)];
  for (const f of dgFiles) {
    const spec = readJson<StudioDiagramV1>(path.join(PARITY_DIAGRAM_DIR, f));
    for (const release of [true, false]) {
      let r: ReturnType<typeof buildDiagramSvg>;
      try {
        r = buildDiagramSvg(clone(spec), { release });
      } catch {
        continue;
      }
      out.push({ id: `diagram/${f}@${release ? 'rel' : 'draft'}`, svg: r.svg, clean: (r.report.geometry ?? []).length === 0 });
    }
  }
  return out;
}
