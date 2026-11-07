/**
 * Modul engine/chart/family-g (I33, 01_specs.md §8.2), diisi S43: G-01 tile map,
 * G-02 dot map, G-03 flow map (skematis di atas grid petak, D-22 KT-12), G-04
 * flowchart (tata letak `flow` mesin diagram). Didaftarkan ke `CHART_RENDERERS`
 * lewat dispatcher kontrak D01 (`...chartFamilyG`).
 *
 * Gaya `datum` (default) dan `gallery` (panel Gambar 8.5); huruf pt fisik; aksen via
 * medan `accent` (alias `params.accentPoint`/`accentGroup`); kunci params diselesaikan
 * resolver tunggal chart/core (PARAM_ALIAS / PARAM_IGNORED, D-87). Deterministik. Grid tetap 38 provinsi + kode
 * petak terdokumentasi di `provinces.ts`.
 */
import type { ChartRendererMap } from "../../../contract";
import { renderDotMap, renderFlowMap } from "./dot-flow";
import { renderFlowchart } from "./flowchart";
import { renderTileMap } from "./tile-map";

export {
  INDONESIA_PROVINCES,
  INDONESIA_PROVINCE_COUNT,
  INDONESIA_TILE_COLS,
  INDONESIA_TILE_ROWS,
  PROVINCE_BY_CODE,
  indonesiaTiles,
  isStandardProvinceCode,
  type ProvinceTile,
} from "./provinces";

/** Kode G-01..G-04 (01_specs.md §5.3). */
export const chartFamilyG: ChartRendererMap = {
  "G-01": renderTileMap,
  "G-02": renderDotMap,
  "G-03": renderFlowMap,
  "G-04": renderFlowchart,
};
