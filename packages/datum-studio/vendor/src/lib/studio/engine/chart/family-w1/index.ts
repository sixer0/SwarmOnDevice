/**
 * Modul engine/chart/family-w1 (I29, 01_specs.md §8.2), diisi S39.
 *
 * Kode W-01 line, W-03 step line, W-04 area, W-05 stacked area (§5.3; W-02 column waktu
 * milik inti S32). Gaya `datum` (default, port pustakachart) dan `gallery` (panel
 * Gambar 8.4). Helper diimpor dari berkas inti (`../core/svg`, `../core/palette`, ...),
 * bukan dari `../core` (indeks inti mengimpor contract/dispatch).
 */
import type { ChartRendererMap } from "../../../contract";
import { W1_RENDERERS } from "./render";

export { MONTHS_ID_SHORT, buildXAxis, formatTanggalSingkat, type XAxisModel, type XKind } from "./timeaxis";
export { accentRequest, type W1Code } from "./params";

/** Kode W-01, W-03..W-05 (01_specs.md §5.3). */
export const chartFamilyW1: ChartRendererMap = { ...W1_RENDERERS };
