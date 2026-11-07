/**
 * Modul engine/chart/family-p1 (I23, 01_specs.md §8.2), diisi S33.
 *
 * Renderer P-03 grouped column, P-04 lollipop, P-05 dot plot, P-06 dumbbell, P-07 range
 * plot, P-08 slope (§5.3), gaya `datum` (default, resep pustakachart kelas CB1/CB2) dan
 * `gallery` (panel Gambar 8.1). Registrasi: peta `chartFamilyP1` disebar ke
 * `CHART_RENDERERS` oleh dispatcher kontrak D01 (§8.3); modul ini tidak mengimpor dispatch.
 *
 * Kanvas dari pemanggil (`renderChart`/komposit): renderer membaca `canvas.widthMm` dan
 * `canvas.heightMm`; lint keluaran tingkat atas dilakukan `finalizeChart` chart/core.
 * Galat: bentuk data salah -> SCHEMA_INVALID; penjaga by-construction -> BY_CONSTRUCTION_FAILED
 * dengan `details.checkId` (DC-G1, DATUM-26, CH-01, chart.kind.P-03.maxSeries, P-08.periods).
 */
import type { ChartRenderer, ChartRendererMap } from "../../../contract";
import { type P1Code, type P1Ctx, P1_REFERENCE_HEIGHT_MM, beginChart, endChart } from "./common";
import { renderDotPlot } from "./dot-plot";
import { renderDumbbell } from "./dumbbell";
import { renderGroupedColumn } from "./grouped-column";
import { renderLollipop } from "./lollipop";
import { renderRangePlot } from "./range-plot";
import { renderSlope } from "./slope";

function familyRenderer(code: P1Code, draw: (ctx: P1Ctx) => void): ChartRenderer {
  return (spec, canvas, tpl) => {
    const ctx = beginChart(code, spec, canvas, tpl);
    draw(ctx);
    return endChart(ctx);
  };
}

/** Kode P-03..P-08 (01_specs.md §5.3). */
export const chartFamilyP1: ChartRendererMap = {
  "P-03": familyRenderer("P-03", renderGroupedColumn),
  "P-04": familyRenderer("P-04", renderLollipop),
  "P-05": familyRenderer("P-05", renderDotPlot),
  "P-06": familyRenderer("P-06", renderDumbbell),
  "P-07": familyRenderer("P-07", renderRangePlot),
  "P-08": familyRenderer("P-08", renderSlope),
};

export { P1_REFERENCE_HEIGHT_MM };
