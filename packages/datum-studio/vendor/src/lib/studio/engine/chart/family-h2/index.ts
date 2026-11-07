/**
 * Modul engine/chart/family-h2 (I26, 01_specs.md §8.2), diisi S36.
 *
 * H-06 contour (marching squares), H-07 network (posisi dari data atau BFS bertingkat),
 * H-08 arc diagram, H-09 Venn/Euler (luas proporsional sederhana). Didaftarkan ke
 * `CHART_RENDERERS` oleh dispatcher kontrak (D01: `...chartFamilyH2`). Gaya `datum` (default)
 * dan `gallery`; params tak dikenal diabaikan + REPORT `PARAM_IGNORED` (D-58); deterministik.
 *
 * Modul ini TIDAK mengimpor contract/dispatch (hanya helper `../core/*`), sehingga aman dari
 * siklus impor dispatch.
 */
import type { ChartRendererMap } from "../../../contract";
import { renderArc } from "./arc";
import { renderContour } from "./contour";
import { renderNetwork } from "./network";
import { renderVenn } from "./venn";

/** Kode H-06..H-09 (01_specs.md §5.3). */
export const chartFamilyH2: ChartRendererMap = {
  "H-06": renderContour,
  "H-07": renderNetwork,
  "H-08": renderArc,
  "H-09": renderVenn,
};
