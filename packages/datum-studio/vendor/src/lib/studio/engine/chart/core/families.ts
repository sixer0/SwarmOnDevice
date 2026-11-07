/**
 * engine/chart/core — renderer kode inti P-01 (bar), P-02 (column), P-11 (threshold),
 * W-02 (column waktu) (01_specs.md §5.3). `spec.style` "datum" (default) = port DC
 * kelas paritas CA; "gallery" = gaya panel Gambar 8.1/8.4.
 *
 * Berkas ini TIDAK mengimpor contract/dispatch, sehingga keluarga S33-S43 boleh
 * mengimpor helper inti tanpa ikut siklus impor dispatch.
 */
import type { ChartRenderer, ChartRendererMap, StudioChartV1 } from "../../../contract";
import { datumHeightMm, dcHeightMm, renderDatum } from "./datum";
import { renderGallery } from "./gallery";
import { CORE_FAMILY, type CoreCode, accentHintSeries, isCoreCode, prepareCore } from "./prepare";

/**
 * Renderer kode inti. Kunci params sudah diselesaikan resolver tunggal (`./params`,
 * PARAM_ALIAS / PARAM_IGNORED dilaporkan oleh renderChart/komposit). Petunjuk aksen
 * tingkat seri tidak berlaku pada kode inti (satu seri): REPORT `ACCENT_HINT`.
 */
function coreRenderer(code: CoreCode): ChartRenderer {
  return (spec, canvas, tpl) => {
    const prep = prepareCore(spec, tpl, code);
    const res = (spec.style ?? "datum") === "gallery" ? renderGallery(spec, canvas, tpl, prep) : renderDatum(spec, canvas, tpl, prep);
    const series = accentHintSeries(spec);
    if (series === undefined) return res;
    return {
      ...res,
      report: {
        checksRun: [...res.report.checksRun, "ACCENT_HINT"],
        issues: [
          ...res.report.issues,
          { checkId: "ACCENT_HINT", status: "REPORT", detail: `petunjuk aksen seri "${series}" diabaikan: ${code} satu seri; pakai accent.point` },
        ],
      },
    };
  };
}

/** P-01, P-02, P-11, W-02. */
export const chartCore: ChartRendererMap = {
  "P-01": coreRenderer("P-01"),
  "P-02": coreRenderer("P-02"),
  "P-11": coreRenderer("P-11"),
  "W-02": coreRenderer("W-02"),
};

/**
 * Tinggi kanvas kode inti (mm). Gaya datum = `tinggi()` DC (spec.heightMm diabaikan
 * demi paritas CA, dilaporkan REPORT bila berbeda) dengan badan minimum keluarga batang
 * untuk n <= 3 kategori (FIX-H8, `datumHeightMm`); gaya gallery = spec.heightMm atau
 * taksiran DC tanpa batas bawah (tidak berubah).
 */
export function coreHeightMm(spec: StudioChartV1, code: CoreCode): number {
  if ((spec.style ?? "datum") === "gallery") return spec.heightMm ?? dcHeightMm(spec, CORE_FAMILY[code]);
  return datumHeightMm(spec, CORE_FAMILY[code]);
}

export { isCoreCode };
