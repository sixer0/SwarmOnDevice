/**
 * Modul engine/chart/family-s2 (I32, 01_specs.md §8.2), diisi S42.
 *
 * Kode S-05..S-08 (01_specs.md §5.3): ridgeline, strip/jitter, beeswarm, radial
 * histogram. Peta didaftarkan ke `CHART_RENDERERS` oleh dispatcher kontrak (D01,
 * `contract/dispatch.ts` sudah menyebar `chartFamilyS2`). Lint keluaran tingkat atas
 * (`finalizeChart`) dan lint panel komposit dijalankan pemanggil (chart/core).
 *
 * Gaya: `datum` (default; resep pustakachart bila ada acuan) dan `gallery` (panel
 * Gambar 8.5). Rincian per kode di berkas renderer; konvensi bersama di common.ts.
 */
import type { ChartCanvas, ChartRendererMap, ResolvedTemplate, StudioChartV1, SvgResult } from "../../../contract";
import { renderBeeswarm } from "./beeswarm";
import { type S2Code, type S2Ctx, beginS2, endS2 } from "./common";
import { renderRadial } from "./radial";
import { renderRidgeline } from "./ridgeline";
import { renderStrip } from "./strip";

function wrap(code: S2Code, body: (ctx: S2Ctx) => void) {
  return (spec: StudioChartV1, canvas: ChartCanvas, tpl: ResolvedTemplate): SvgResult => {
    const ctx = beginS2(code, spec, canvas, tpl);
    body(ctx);
    return endS2(ctx);
  };
}

/** Kode S-05..S-08 (01_specs.md §5.3). */
export const chartFamilyS2: ChartRendererMap = {
  "S-05": wrap("S-05", renderRidgeline),
  "S-06": wrap("S-06", renderStrip),
  "S-07": wrap("S-07", renderBeeswarm),
  "S-08": wrap("S-08", renderRadial),
};
