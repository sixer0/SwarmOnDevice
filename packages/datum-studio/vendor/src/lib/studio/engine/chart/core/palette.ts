/**
 * engine/chart/core — parameter chart dan peran warna (S32).
 *
 * Resolusi parameter: API baca tunggal `./read` (spec -> templat -> default ParamDef;
 * kunci khusus kode `chart.kind.<KODE>.<nama>`), diekspor ulang di sini untuk pemanggil lama.
 *
 * Peran warna (P7-07..P7-12, Tabel 7.5): aksen tunggal `signal`, konteks utama `ink400`,
 * konteks latar `ink200`, batas terlampaui `alert`, membaik `verd`, teks/sumbu `ink900`.
 * Palet interior dibaca dari parameter templat (`color.interior.*`); cadangan = default
 * ParamDef, yang identik dengan konstanta datumchart.py DC:43-45.
 *
 * Hitungan warna (lint 25, maks 5) memakai keluarga warna: seluruh ramp tinta
 * (paper, ink100..ink900) dihitung SATU keluarga (K-32, usulan E-16); warna lain
 * masing-masing satu keluarga.
 */
import { StudioEngineError } from "../../../contract/errors";
import type { ParamValue, ResolvedTemplate } from "../../../contract";
import { type ChartSpecLike, chartParam, kindKey, readBool, readEnum, readNum, readStr } from "./read";
import { PARAMS_BY_KEY } from "../../../params";
import { normalizeHex, resolveColorToken } from "../../tokens/color";

export type { ChartSpecLike };
export { chartParam, kindKey };

/**
 * Nama lama pembaca parameter berkunci penuh inti; implementasi tunggal di `./read`
 * (S84 #8): tipe salah -> SCHEMA_INVALID (tidak lagi diam-diam memakai cadangan).
 */
export const paramBool = readBool;
export const paramNum = readNum;
export const paramEnum = readEnum;

export function paramStr(spec: ChartSpecLike, tpl: ResolvedTemplate, key: string, fallback: string): string {
  return readStr(spec, tpl, key) ?? fallback;
}

// ── Palet ──────────────────────────────────────────────────────────────────

/** Hex "RRGGBB" huruf besar tanpa "#". */
export interface ChartPalette {
  paper: string;
  ink900: string;
  ink700: string;
  ink400: string;
  ink200: string;
  ink100: string;
  signal: string;
  alert: string;
  verd: string;
  role: {
    accent: string;
    contextMain: string;
    contextBackground: string;
    limitExceeded: string;
    improving: string;
    textAxis: string;
  };
}

const PALETTE_TOKENS = ["paper", "ink900", "ink700", "ink400", "ink200", "ink100", "signal", "alert", "verd"] as const;
type PaletteToken = (typeof PALETTE_TOKENS)[number];

/** Konstanta DC:43-45; dipakai hanya bila parameter templat dan registri sama-sama kosong. */
const DC_FALLBACK: Record<PaletteToken, string> = {
  paper: "FCFCFB",
  ink900: "101418",
  ink700: "2B3640",
  ink400: "6B7783",
  ink200: "C3CBD1",
  ink100: "EFF2F4",
  signal: "B45309",
  alert: "9B1C1C",
  verd: "2F6F6B",
};

function paletteToken(tpl: ResolvedTemplate, name: PaletteToken): string {
  const key = `color.interior.${name}`;
  return (
    resolveColorToken(tpl.params, name) ??
    normalizeHex(PARAMS_BY_KEY.get(key)?.default) ??
    DC_FALLBACK[name]
  );
}

/** Selesaikan tokenRef/hex peran chart; spec.params mendahului templat. */
export function resolveChartColor(spec: ChartSpecLike, tpl: ResolvedTemplate, key: string, fallbackHex: string): string {
  const ref = chartParam(spec, tpl, key);
  if (ref === undefined) return fallbackHex;
  const hex = resolveColorToken(tpl.params, ref) ?? resolveColorToken(DEFAULT_COLOR_PARAMS, ref);
  if (!hex) {
    throw new StudioEngineError("SCHEMA_INVALID", `parameter warna ${key} = ${JSON.stringify(ref)} tidak dapat diselesaikan ke hex`, { key });
  }
  return hex;
}

/** Default `color.*` registri (cadangan resolusi tokenRef bila templat tidak memuatnya). */
const DEFAULT_COLOR_PARAMS: Readonly<Record<string, ParamValue>> = Object.freeze(
  Object.fromEntries([...PARAMS_BY_KEY.values()].filter((p) => p.key.startsWith("color.")).map((p) => [p.key, p.default])),
);

export function chartPalette(spec: ChartSpecLike, tpl: ResolvedTemplate): ChartPalette {
  const p = Object.fromEntries(PALETTE_TOKENS.map((t) => [t, paletteToken(tpl, t)])) as Record<PaletteToken, string>;
  return {
    ...p,
    role: {
      accent: resolveChartColor(spec, tpl, "chart.colorRole.accent", p.signal),
      contextMain: resolveChartColor(spec, tpl, "chart.colorRole.contextMain", p.ink400),
      contextBackground: resolveChartColor(spec, tpl, "chart.colorRole.contextBackground", p.ink200),
      limitExceeded: resolveChartColor(spec, tpl, "chart.colorRole.limitExceeded", p.alert),
      improving: resolveChartColor(spec, tpl, "chart.colorRole.improving", p.verd),
      textAxis: resolveChartColor(spec, tpl, "chart.colorRole.textAxis", p.ink900),
    },
  };
}

/**
 * Keluarga warna TANPA pengelompokan rona (aturan lint 25 sebelum IP-25): hanya token ramp
 * tinta + kertas + putih + hitam = "ink", setiap hex lain = keluarganya sendiri. Dipakai
 * pemilih jumlah kelas ramp H-03 (family-h1) agar keluaran keputusan D-82 (galeri k = 4)
 * tidak berubah; lint memakai `colorFamily`.
 */
export function colorFamilyExact(hex: string, pal: ChartPalette): string {
  const h = hex.replace(/^#/, "").toUpperCase();
  const ramp = [pal.paper, pal.ink100, pal.ink200, pal.ink400, pal.ink700, pal.ink900, "FFFFFF", "000000"];
  return ramp.includes(h) ? "ink" : h;
}

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Selisih kanal maksimum yang masih dianggap pembulatan rona (`tintHex` membulatkan per kanal). */
const TINT_CHANNEL_TOL = 1.5;

/**
 * `h` adalah rona antara `from` (kertas/putih) dan `to`: h = from + t (to - from), 0 < t <= 1,
 * setiap kanal dalam toleransi pembulatan. t dari kuadrat terkecil atas ketiga kanal.
 */
function isTintBetween(h: string, from: string, to: string): boolean {
  const H = rgb(h);
  const F = rgb(from);
  const T = rgb(to);
  let num = 0;
  let den = 0;
  for (let i = 0; i < 3; i++) {
    num += (H[i] - F[i]) * (T[i] - F[i]);
    den += (T[i] - F[i]) ** 2;
  }
  if (den === 0) return false;
  const t = num / den;
  if (!(t > 0 && t <= 1 + 1e-9)) return false;
  return H.every((c, i) => Math.abs(F[i] + t * (T[i] - F[i]) - c) <= TINT_CHANNEL_TOL);
}

/**
 * Keluarga warna untuk lint 25 (K-32): ramp tinta + kertas + putih + hitam = "ink";
 * warna palet lain masing-masing satu keluarga. Rona antara kertas (atau putih) dan
 * sebuah warna palet/peran dihitung sebagai keluarga warna itu (DATUM-25, IP-25), mis.
 * `tintHex(paper, alert, 40)` = keluarga alert, rona tinta = "ink". Warna di luar
 * palet = keluarganya sendiri.
 */
export function colorFamily(hex: string, pal: ChartPalette): string {
  const h = hex.replace(/^#/, "").toUpperCase();
  const inks = [pal.ink100, pal.ink200, pal.ink400, pal.ink700, pal.ink900, "000000"];
  if (h === pal.paper || h === "FFFFFF" || inks.includes(h)) return "ink";
  const hues = [...new Set([pal.signal, pal.alert, pal.verd, ...Object.values(pal.role)])].filter(
    (c) => c !== pal.paper && c !== "FFFFFF" && !inks.includes(c),
  );
  if (hues.includes(h)) return h;
  if (!/^[0-9A-F]{6}$/.test(h)) return h;
  for (const from of [pal.paper, "FFFFFF"]) {
    if (inks.some((c) => isTintBetween(h, from, c))) return "ink";
    const base = hues.find((c) => isTintBetween(h, from, c));
    if (base) return base;
  }
  return h;
}
