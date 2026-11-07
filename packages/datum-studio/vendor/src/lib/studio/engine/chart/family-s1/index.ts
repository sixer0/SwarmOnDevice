/**
 * Modul engine/chart/family-s1 (I31, 01_specs.md §8.2), diisi S41: S-01 histogram,
 * S-02 box plot, S-03 density, S-04 violin (§5.3). Didaftarkan ke `CHART_RENDERERS`
 * lewat dispatcher kontrak D01 (`...chartFamilyS1`).
 *
 * Gaya `datum` (default, resep pustakachart) dan `gallery` (panel Gambar 8.5); aksen
 * tingkat spec (D-58); params tak dikenal diabaikan + REPORT `PARAM_IGNORED`; ukuran
 * huruf pt fisik; deterministik (tanpa acak/waktu). Metode statistik: stats.ts.
 */
import type { ChartRendererMap } from "../../../contract";
import { renderBox } from "./box";
import { renderDensity } from "./density";
import { renderHistogram } from "./histogram";
import { renderViolin } from "./violin";

/** Kode S-01..S-04 (01_specs.md §5.3). */
export const chartFamilyS1: ChartRendererMap = {
  "S-01": renderHistogram,
  "S-02": renderBox,
  "S-03": renderDensity,
  "S-04": renderViolin,
};
