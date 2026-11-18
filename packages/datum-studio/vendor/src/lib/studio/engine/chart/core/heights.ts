/**
 * engine/chart/core — tinggi kanvas acuan per kode (IP-25; paritas CB1 (d) +/- 3 mm).
 *
 * SATU tabel: tinggi `tinggi_mm` registri pustakachart (PC `canvas(W, tinggi_mm)`) yang
 * diekspor keluarga pemiliknya (P1 S33, K1 S37, H1 S35, S1 S41, W2 S40). Dipakai
 * `estimateHeightMm` bila spec tanpa `heightMm` (kedua gaya), menggantikan rasio bawaan
 * lebar x 0,5. Kode tanpa entri (keluarga yang tidak mengekspor tinggi acuan, CC) tetap
 * memakai rasio bawaan. Berkas ini hanya mengimpor konstanta (berkas common/index
 * keluarga tidak mengimpor chart/core/render), sehingga tidak membentuk siklus impor.
 */
import type { ChartCode, ResolvedTemplate, StudioChartV1 } from "../../../contract";
import { H1_REFERENCE_HEIGHT_MM } from "../family-h1/common";
import { K1_REFERENCE_HEIGHT_MM } from "../family-k1/index";
import { P1_REFERENCE_HEIGHT_MM } from "../family-p1/common";
import { S1_REFERENCE_HEIGHT_MM } from "../family-s1/common";
import { ganttContentHeightMm, ganttOverHeight } from "../family-w2/gantt";
import { W2_REFERENCE_HEIGHT_MM } from "../family-w2/index";

export const CHART_REFERENCE_HEIGHT_MM: Readonly<Partial<Record<ChartCode, number>>> = Object.freeze({
  ...P1_REFERENCE_HEIGHT_MM,
  ...K1_REFERENCE_HEIGHT_MM,
  ...H1_REFERENCE_HEIGHT_MM,
  ...S1_REFERENCE_HEIGHT_MM,
  ...W2_REFERENCE_HEIGHT_MM,
});

/** Tinggi acuan kode (mm) atau `undefined` bila kode tidak punya acuan. */
export function referenceHeightMm(code: ChartCode): number | undefined {
  return CHART_REFERENCE_HEIGHT_MM[code];
}

/**
 * Swarm 1.3.3 row 133 (ST-2): tinggi isi yang mengikuti jumlah baris (mm, tanpa kaki aparatus
 * figure) untuk kode yang punya aturannya; undefined = tinggi acuan kode. Saat ini hanya W-07:
 * jadwal di atas batas `rowsInProposal` tumbuh agar jarak baris minimum terjaga, tidak pernah
 * lebih pendek dari tinggi acuan.
 */
export function contentHeightMm(spec: StudioChartV1, tpl: ResolvedTemplate): number | undefined {
  if (spec.kind !== "W-07") return undefined;
  const need = ganttContentHeightMm(spec, tpl);
  return need === undefined ? undefined : Math.max(need, CHART_REFERENCE_HEIGHT_MM["W-07"] ?? 0);
}

/** Row 133: rincian penolakan tinggi milik kode (batas baris + tawaran pecah); undefined = pesan umum. */
export function overHeightDetail(
  spec: StudioChartV1,
  tpl: ResolvedTemplate,
  availMm: number,
): { quantity: string; unit: string; limit: number; measured: number; suggestion: string } | undefined {
  return spec.kind === "W-07" && spec.heightMm === undefined ? ganttOverHeight(spec, tpl, availMm) : undefined;
}
