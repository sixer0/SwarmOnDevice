/**
 * Modul engine/chart/family-h1 (I25, 01_specs.md §8.2), diisi S35.
 *
 * Kode Tabel 8.2 hubungan: H-01 scatter, H-02 bubble, H-03 heatmap (ramp berparameter,
 * KT-08), H-04 connected scatter, H-05 hexbin (binning heksagonal deterministik).
 * Gaya `datum` (default) = port pustakachart (paritas CB1/CB2, research/06 §6.2);
 * gaya `gallery` = panel Gambar 8.2. Didaftarkan ke `CHART_RENDERERS` lewat impor statis
 * dispatcher kontrak D01 (`...chartFamilyH1`); modul ini tidak mengimpor dispatcher.
 *
 * Semua renderer: SVG bersatuan mm, huruf pt fisik (helper inti S32), tanda data ber-
 * `data-mark`/`data-series`/`data-index`, sumbu `data-axis`, deterministik (tanpa acak,
 * tanpa waktu), kunci params tak dikenal diabaikan + REPORT `PARAM_IGNORED` (D-58).
 */
import type { ChartRenderer, ChartRendererMap } from "../../../contract";
import { type H1Code, prepH1 } from "./common";
import { renderHeatmap } from "./heatmap";
import { renderHexbin } from "./hexbin";
import { renderBubble, renderConnected, renderScatter } from "./scatter";

type H1Render = typeof renderScatter;

function h1(code: H1Code, render: H1Render): ChartRenderer {
  return (spec, canvas, tpl) => render(spec, canvas, tpl, prepH1(spec, tpl, code));
}

/** Kode H-01..H-05 (01_specs.md §5.3). */
export const chartFamilyH1: ChartRendererMap = {
  "H-01": h1("H-01", renderScatter),
  "H-02": h1("H-02", renderBubble),
  "H-03": h1("H-03", renderHeatmap),
  "H-04": h1("H-04", renderConnected),
  "H-05": h1("H-05", renderHexbin),
};

export { H1_REFERENCE_HEIGHT_MM, type H1Code } from "./common";
export { hexbinMpl, roundHalfEven, type HexBin, type HexGrid } from "./hexbin";
export { heatmapRampStops, rampClasses } from "./ramp";
