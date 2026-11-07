/**
 * Aturan ukuran asli gambar raster (K-2, keputusan USER D-242), dipakai perakit
 * DOCX (`engine/docx/figures/figure`) dan HTML (`engine/html/tables/figure`).
 * Modul netral di `engine/tokens` (turunan parameter templat, tanpa I/O): dulu di
 * `engine/docx/figures/raster-width.ts`, dipindah agar mesin HTML tidak bergantung
 * pada mesin DOCX (FIX-A2 N1, D-281). Gambar raster tidak
 * diperbesar melebihi ukuran aslinya pada resolusi templat; lebar kelas templat
 * (`image.widthMm` turunan `image.widthClass`) adalah BATAS ATAS, bukan lebar paksa.
 *
 * Resolusi templat = `image.rasterDpi` (R-65, lanjutan, bawaan 150 dpi = lantai
 * mutu raster DATUM-39; putusan D-257). Bukan `render.png.dpi` (dpi keluaran PNG
 * figur vektor, makna lain).
 *
 * Berlaku hanya bila lebar berasal dari kelas templat (snapshot `studio.norm/v2`,
 * konten tanpa medan lebar, D-139). Dokumen v1 membawa `widthMm` eksplisit di
 * konten (keputusan penulis lama), jadi tidak disentuh (DOCX v1 tetap identik).
 */
import type { NormDocSnapshot, ParamMap } from "../../contract";
import { PARAMS_BY_KEY } from "../../params";

export const RASTER_RESOLUTION_PARAM = "image.rasterDpi";

/**
 * Lantai mutu raster DATUM-39 (dpi efektif minimum gambar raster) = batas bawah rentang
 * R-65 `image.rasterDpi` (150; FIX-A2 N2): satu sumber untuk rentang parameter dan
 * pemeriksaan DATUM-39 perakit DOCX. Cadangan 150 hanya bila registri kehilangan rentang.
 */
export const RASTER_DPI_FLOOR: number = PARAMS_BY_KEY.get(RASTER_RESOLUTION_PARAM)?.range?.min ?? 150;

function positive(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;
}

/** dpi resolusi templat: nilai efektif, lalu bawaan registri R-65. */
export function rasterResolutionDpi(params: ParamMap): number | undefined {
  return positive(params[RASTER_RESOLUTION_PARAM]) ?? positive(PARAMS_BY_KEY.get(RASTER_RESOLUTION_PARAM)?.default);
}

/** Lebar asli (mm) aset raster pada resolusi `dpi`. */
export function nativeWidthMm(widthPx: number, dpi: number): number {
  return (widthPx * 25.4) / dpi;
}

/** true bila lebar figur gambar berasal dari kelas templat (snapshot v2). */
export function classDerivedWidth(snapshot: Pick<NormDocSnapshot, "schema"> | { schema?: string }): boolean {
  return (snapshot as { schema?: string }).schema === "studio.norm/v2";
}

/**
 * Kekurangan piksel yang masih dianggap "ukuran asli" (px): kerugian rasterisasi
 * < 1 px CSS (= dpi/96 px perangkat) + 1 px pembulatan, toleransi yang sama dengan
 * DATUM-39 (`rasterDpiShortfall`, F-043/D-94). Contoh: aset 300 dpi 1960 px untuk
 * 166 mm (ideal 1960,6 px) tetap 166 mm, tidak menyusut 0,05 mm.
 */
function rasterizationSlackPx(dpi: number): number {
  return dpi / 96 + 1;
}

/**
 * Lebar tempatan gambar raster: min(lebar kelas, lebar asli pada resolusi templat),
 * kecuali selisih piksel terhadap lebar kelas dalam toleransi rasterisasi.
 * Piksel atau dpi tidak diketahui = lebar kelas apa adanya (tidak ada dasar membatasi).
 */
export function rasterPlacedWidthMm(classWidthMm: number, widthPx: number | undefined, params: ParamMap): number {
  const px = positive(widthPx);
  const dpi = rasterResolutionDpi(params);
  if (px === undefined || dpi === undefined) return classWidthMm;
  const classPx = (classWidthMm / 25.4) * dpi;
  if (classPx - px <= rasterizationSlackPx(dpi)) return classWidthMm;
  return nativeWidthMm(px, dpi);
}
