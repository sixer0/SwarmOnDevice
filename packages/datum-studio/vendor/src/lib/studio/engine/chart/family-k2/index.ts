/**
 * Modul engine/chart/family-k2 (I28, 01_specs.md §8.2), diisi S38.
 *
 * Ekspor kontrak: `chartFamilyK2` (K-07..K-12, 01_specs.md §5.3), didaftarkan ke
 * `CHART_RENDERERS` oleh dispatcher kontrak D01 (`contract/dispatch.ts`, §8.3). Berkas
 * keluarga tidak mengimpor dispatch (siklus impor); helper inti diimpor per berkas core.
 */
import type { ChartRendererMap } from "../../../contract";
import { renderFunnel } from "./funnel";
import { renderIconArray } from "./icon-array";
import { renderMarimekko } from "./marimekko";
import { renderSankey } from "./sankey";
import { renderTreemap } from "./treemap";
import { renderWaffle } from "./waffle";

/** Kode K-07..K-12 (01_specs.md §5.3). */
export const chartFamilyK2: ChartRendererMap = {
  "K-07": renderWaffle,
  "K-08": renderIconArray,
  "K-09": renderTreemap,
  "K-10": renderFunnel,
  "K-11": renderSankey,
  "K-12": renderMarimekko,
};

export { squarify, sliceBoxes, type Box } from "./treemap";
