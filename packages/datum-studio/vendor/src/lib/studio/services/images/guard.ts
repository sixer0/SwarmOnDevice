/**
 * `px_guard` DATUM-39 (ENH-D E-08), port dari HS `datumcheck.py` `px_guard`:
 * dpi efektif = px lebar sumber / (lebar tempel mm / 25,4); di bawah ambang
 * = cacat. Ambang 150 dpi (spesifikasi §3.7), 300 untuk chart. Rumus dan
 * urutan operasi sama dengan Python agar nilai float identik bit.
 */
import type { LintIssue } from "../../contract";
import { StudioEngineError } from "../../contract/errors";

export const PX_GUARD_CHECK_ID = "DATUM-39";
export const PX_GUARD_MIN_DPI_DEFAULT = 150;
export const PX_GUARD_MIN_DPI_CHART = 300;

/** Ambang menurut jenis figur: chart 300, lainnya 150. */
export function pxGuardMinDpi(kind: "chart" | "image" | "diagram" | string): 150 | 300 {
  return kind === "chart" ? PX_GUARD_MIN_DPI_CHART : PX_GUARD_MIN_DPI_DEFAULT;
}

/** dpi efektif = widthPx / (widthMm / 25,4) (urutan operasi = Python). */
export function effectiveDpi(widthPx: number, widthMm: number): number {
  return widthPx / (widthMm / 25.4);
}

/** Lebar piksel minimum agar lolos pada lebar tempel tertentu (dikoreksi terhadap rumus `effectiveDpi`). */
export function minWidthPxFor(widthMm: number, minDpi: number): number {
  let n = Math.max(1, Math.ceil((widthMm / 25.4) * minDpi));
  while (n > 1 && effectiveDpi(n - 1, widthMm) >= minDpi) n--;
  while (effectiveDpi(n, widthMm) < minDpi) n++;
  return n;
}

/** Pembulatan `format(x, ".0f")` Python: setengah ke genap pada nilai biner eksak. */
export function formatFixed0(x: number): string {
  const f = Math.floor(x);
  const d = x - f;
  const r = d > 0.5 ? f + 1 : d < 0.5 ? f : f % 2 === 0 ? f : f + 1;
  return String(r === 0 ? 0 : r);
}

/**
 * I43: `null` bila lolos; `LintIssue` FAIL `DATUM-39` bila dpi efektif di
 * bawah `minDpi`. Masukan non-angka / lebar <= 0 = `SCHEMA_INVALID` (bukan
 * diam-diam lolos seperti jalur "tanpa PIL" Python).
 */
export function pxGuard(widthPx: number, widthMm: number, minDpi: 150 | 300): LintIssue | null {
  if (!Number.isInteger(widthPx) || widthPx < 1) {
    throw new StudioEngineError("SCHEMA_INVALID", "pxGuard: widthPx must be a positive integer", { widthPx });
  }
  if (typeof widthMm !== "number" || !Number.isFinite(widthMm) || widthMm <= 0) {
    throw new StudioEngineError("SCHEMA_INVALID", "pxGuard: widthMm must be a positive number", { widthMm });
  }
  if (minDpi !== PX_GUARD_MIN_DPI_DEFAULT && minDpi !== PX_GUARD_MIN_DPI_CHART) {
    throw new StudioEngineError("SCHEMA_INVALID", "pxGuard: minDpi must be 150 or 300", { minDpi });
  }
  const eff = effectiveDpi(widthPx, widthMm);
  if (eff >= minDpi) return null;
  return {
    checkId: PX_GUARD_CHECK_ID,
    status: "FAIL",
    detail:
      `DATUM-39/E-08: ${widthPx}px untuk ${widthMm} mm = ${formatFixed0(eff)} dpi efektif < ${minDpi}` +
      ` (minimal ${minWidthPxFor(widthMm, minDpi)} px). Simpan 300 dpi dengan figsize dalam INCI (mm/25,4).`,
  };
}
