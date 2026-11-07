/**
 * engine/chart/core — pencarian registri dan renderer (S32).
 *
 * `CHART_RENDERERS` (contract/dispatch, D01) dibaca HANYA di dalam badan fungsi:
 * dispatch mengimpor chart/core (chartCore) dan chart/core mengimpor dispatch; peta
 * dispatch dibangun malas saat pertama dibaca (permintaan S03, file_requests.md).
 */
import type { ChartCode, ChartDef, ChartRenderer } from "../../../contract";
import { CHART_RENDERERS } from "../../../contract/dispatch";
import { StudioEngineError, StudioNotImplemented } from "../../../contract/errors";
import { CHART_BY_CODE } from "../../../registry/charts";

/** ChartDef tergambar; kode tak dikenal -> CHART_KIND_UNKNOWN; drawn=false -> CHART_KIND_NOT_DRAWN + alternatives. */
export function drawnChartDef(kind: string): ChartDef {
  const def = CHART_BY_CODE.get(kind as ChartCode);
  if (!def) {
    throw new StudioEngineError("CHART_KIND_UNKNOWN", `jenis chart "${kind}" tidak dikenal registri`, { kind });
  }
  if (!def.drawn) {
    const alternatives = def.alternatives ?? [];
    throw new StudioEngineError(
      "CHART_KIND_NOT_DRAWN",
      `${def.code} ${def.name} tidak digambar Studio; pakai ${alternatives.join(", ") || "jenis lain"}`,
      { code: def.code, alternatives },
    );
  }
  return def;
}

/**
 * Renderer terdaftar untuk kode tergambar. Kode yang modul keluarganya belum mengisi
 * peta (S33-S43) -> `StudioNotImplemented` (galat kontrak, bukan galat masukan).
 */
export function chartRendererFor(def: ChartDef): ChartRenderer {
  const r = CHART_RENDERERS[def.code];
  if (typeof r !== "function") {
    throw new StudioNotImplemented(`engine/chart/${def.module ?? "unknown"}`, def.code);
  }
  return r;
}
