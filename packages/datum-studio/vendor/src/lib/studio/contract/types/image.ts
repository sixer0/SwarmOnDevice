/**
 * `studio.image/v1` (01_specs.md §3.7). `px_guard`: dpi efektif =
 * lebarPx / (widthMm / 25,4) >= 150 (300 untuk chart); gagal -> 422 `DATUM-39`.
 */
import type { AssetRef } from "./doc";

export interface StudioImageV1 {
  $schema: "studio.image/v1";
  id?: string;
  title: string;
  source: string;
  asset: AssetRef;
  widthMm: number;
  heightMm?: number;
  dpiMin?: 150 | 300;
}
