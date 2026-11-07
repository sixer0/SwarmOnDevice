/**
 * engine/chart/family-h1 — ramp warna berkelas untuk heatmap (H-03) dan hexbin (H-05) (S35).
 *
 * Ramp H-03 (KT-08, P7-27): `chart.kind.H-03.ramp` (pair, default ["white", "signal"]; juga
 * daftar atau string "paper-signal"; alias pendek `ramp` dipindah ke kunci ini oleh resolver
 * core), lalu P7-27 `chart.heatmap.ramp`
 * pada spec, lalu templat (kunci kode lalu P7-27), lalu default registri. "white" =
 * kertas interior (P7-27: "putih (kertas)"). Ramp boleh lebih dari dua henti, mis. ramp
 * abu-abu acuan ["paper", "ink200", "ink400", "ink900"] untuk paritas H-03 (F-008).
 *
 * Ramp DIKELASKAN (k kelas sama-interval, k <= 5), bukan kontinu: setiap hex unik dihitung
 * satu keluarga warna oleh lint 25 (inti S32), sehingga ramp kontinu melampaui plafon
 * P7-17. Warna kelas i = campuran ramp pada t = i/k (i = 0..k-1): kelas terendah = henti
 * pertama (kertas), kelas tertinggi = 80 % menuju henti akhir; henti akhir murni (signal)
 * tidak pernah dipakai sel, agar lint aksen 26 tidak membaca sel tergelap sebagai aksen.
 * Bila semua henti berada di ramp tinta (K-32), warna kelas dibulatkan ke token tinta
 * terdekat sehingga seluruh ramp tetap SATU keluarga.
 */
import type { ResolvedTemplate, StudioChartV1 } from "../../../contract";
import { StudioEngineError } from "../../../contract/errors";
import { PARAMS_BY_KEY } from "../../../params";
import { normalizeHex, resolveColorToken, tintHex } from "../../tokens/color";
import { fmt } from "../../bind";
import { type ChartPalette, colorFamilyExact, kindKey } from "../core/palette";
import { type SvgDoc, ptToMm, textWidthMm } from "../core/svg";

export const HEATMAP_RAMP_GLOBAL_KEY = "chart.heatmap.ramp";
export const MAX_RAMP_CLASSES = 5;

const PALETTE_NAMES = ["paper", "ink900", "ink700", "ink400", "ink200", "ink100", "signal", "alert", "verd"] as const;

function rampRaw(spec: StudioChartV1, tpl: ResolvedTemplate): unknown {
  const key = kindKey("H-03", "ramp");
  const own = spec.params?.[key];
  if (own !== undefined && own !== null) return own;
  const g = spec.params?.[HEATMAP_RAMP_GLOBAL_KEY];
  if (g !== undefined && g !== null) return g;
  for (const k of [key, HEATMAP_RAMP_GLOBAL_KEY]) {
    const t = tpl.params[k];
    if (t !== undefined && t !== null) return t;
  }
  return PARAMS_BY_KEY.get(key)?.default ?? ["white", "signal"];
}

function rampTokens(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((t): t is string => typeof t === "string" && t.trim().length > 0).map((t) => t.trim());
  if (typeof raw === "string") return raw.split(/->|→|[\s,>]+|-+/).filter((t) => t.length > 0);
  return [];
}

function resolveStop(ref: string, tpl: ResolvedTemplate, pal: ChartPalette): string | undefined {
  if (ref.toLowerCase() === "white") return pal.paper;
  if ((PALETTE_NAMES as readonly string[]).includes(ref)) return pal[ref as (typeof PALETTE_NAMES)[number]];
  return normalizeHex(ref) ?? resolveColorToken(tpl.params, ref);
}

/** Henti ramp heatmap H-03 sebagai hex "RRGGBB". */
export function heatmapRampStops(spec: StudioChartV1, tpl: ResolvedTemplate, pal: ChartPalette): string[] {
  const tokens = rampTokens(rampRaw(spec, tpl));
  if (tokens.length < 2) {
    throw new StudioEngineError("SCHEMA_INVALID", `parameter ${kindKey("H-03", "ramp")} membutuhkan sedikitnya dua henti warna`, {
      key: kindKey("H-03", "ramp"),
    });
  }
  return tokens.map((t) => {
    const hex = resolveStop(t, tpl, pal);
    if (!hex) {
      throw new StudioEngineError("SCHEMA_INVALID", `henti ramp "${t}" tidak dapat diselesaikan ke hex`, { key: kindKey("H-03", "ramp") });
    }
    return hex;
  });
}

/** Warna ramp kontinu pada t in [0, 1] (henti dibagi rata). */
export function rampAt(stops: readonly string[], t: number): string {
  const n = stops.length - 1;
  const u = Math.min(1, Math.max(0, t)) * n;
  const i = Math.min(n - 1, Math.floor(u));
  return tintHex(stops[i], stops[i + 1], (u - i) * 100);
}

function channels(hex: string): number[] {
  return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
}

/** Token tinta terdekat (jarak RGB kuadrat; seri diputus urutan ramp). */
function snapInk(hex: string, pal: ChartPalette): string {
  const ladder = [pal.paper, pal.ink100, pal.ink200, pal.ink400, pal.ink700, pal.ink900];
  const c = channels(hex);
  let best = ladder[0];
  let bestD = Infinity;
  for (const l of ladder) {
    const d = channels(l).reduce((s, v, i) => s + (v - c[i]) ** 2, 0);
    if (d < bestD) {
      bestD = d;
      best = l;
    }
  }
  return best;
}

export function isInkRamp(stops: readonly string[], pal: ChartPalette): boolean {
  return stops.every((s) => colorFamilyExact(s, pal) === "ink");
}

/** k warna kelas (lihat kepala berkas). */
export function rampClasses(stops: readonly string[], k: number, pal: ChartPalette): string[] {
  const ink = isInkRamp(stops, pal);
  return Array.from({ length: k }, (_, i) => {
    const c = rampAt(stops, i / k);
    return ink ? snapInk(c, pal) : c;
  });
}

/** Kelas sama-interval nilai v pada [lo, hi]. */
export function classOf(v: number, lo: number, hi: number, k: number): number {
  if (!(hi > lo)) return k - 1;
  return Math.min(k - 1, Math.max(0, Math.floor(((v - lo) / (hi - lo)) * k + 1e-9)));
}

export const SCALE_SWATCH_MM = 2.4;
export const SCALE_PT = 6.0;

/** Lebar pita skala warna (petak + label batas + jarak dari plot), mm. */
export function scaleBandMm(bounds: readonly string[], title?: string): number {
  const lw = Math.max(...bounds.map((b) => textWidthMm(b, SCALE_PT, "data")));
  const tw = title ? textWidthMm(title, SCALE_PT) : 0;
  return 2.0 + Math.max(SCALE_SWATCH_MM + 0.8 + lw, tw) + 0.4;
}

/**
 * Skala warna vertikal berkelas di sisi kanan (dekorasi, `data-key="scale"`): kelas
 * terendah di bawah, label batas Plex Mono. `title` (satuan) di atas pita.
 */
export function drawScale(
  doc: SvgDoc,
  x: number,
  yTop: number,
  yBottom: number,
  colors: readonly string[],
  bounds: readonly string[],
  pal: ChartPalette,
  title?: string,
): void {
  const k = colors.length;
  const top = title ? yTop + ptToMm(SCALE_PT) + 0.8 : yTop;
  const h = (yBottom - top) / k;
  doc.open('data-key="scale"');
  if (title) doc.text(x, yTop + ptToMm(SCALE_PT) * 0.75, title, { sizePt: SCALE_PT, fill: pal.ink400 });
  colors.forEach((c, i) => {
    doc.rect(x, yBottom - (i + 1) * h, SCALE_SWATCH_MM, h, c, { stroke: pal.ink400, strokeWidthMm: 0.18 });
  });
  bounds.forEach((b, i) => {
    doc.text(x + SCALE_SWATCH_MM + 0.8, yBottom - i * h + ptToMm(SCALE_PT) * 0.35, b, {
      face: "data",
      sizePt: SCALE_PT,
      fill: pal.ink400,
    });
  });
  doc.close();
}

/** Label batas kelas lo + i (hi - lo)/k, i = 0..k. */
export function classBounds(lo: number, hi: number, k: number, dec: number): string[] {
  return Array.from({ length: k + 1 }, (_, i) => fmt(lo + ((hi - lo) * i) / k, dec));
}
