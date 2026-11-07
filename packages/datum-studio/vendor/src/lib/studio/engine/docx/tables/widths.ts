/**
 * Solver lebar kolom dan lantai kolom numerik (port `datumcheck.py`:
 * `num_floor_mm`, `solve_widths`, regex `_NUM_TOKEN_RE`; HS datum-house-style,
 * read-only). Pembulatan memakai `pyRound` (half-even atas nilai biner eksak)
 * agar keluaran sama dengan Python `round(x, 1)`.
 */
import type { ParamValue } from "../../../contract";
import { PARAMS_BY_KEY } from "../../../params";
import { pyRound } from "../../bind";

/** Token angka bergrup titik (335.029.109.47); satu matcher dengan build_rakit.py. */
export const NUM_TOKEN_SOURCE = "\\d{1,3}(?:\\.\\d{3})+(?:\\.\\d+)?";

/** Ukuran `type.scale.tableNumerals.size` kanonik (tokens.json table_numerals 7,8 pt). */
export const DEFAULT_NUMERALS_PT = 7.8;

/** Kunci lebar sah turunan (P4G-13): kolom teks dan rentang penuh (G2, P5-14); A4 = 128/166. */
export const OK_WIDTHS_PARAM = "grid.allowedFigureWidthsMm";

/**
 * Lebar sah (mm) TURUNAN kertas (D-158/D-245 H1): nilai efektif `grid.allowedFigureWidthsMm`,
 * lalu bawaan registri ParamDef (profil kanonik) bila pemanggil tidak membawanya.
 * Tidak terbaca = `undefined` (pemanggil melapor, tanpa cadangan literal A4).
 */
export function okWidthsMm(v?: ParamValue): number[] | undefined {
  const pick = (x: unknown): number[] | undefined => {
    if (!Array.isArray(x) || x.length === 0) return undefined;
    return x.every((w) => typeof w === "number" && Number.isFinite(w) && w > 0) ? (x as number[]) : undefined;
  };
  return pick(v) ?? pick(PARAMS_BY_KEY.get(OK_WIDTHS_PARAM)?.default);
}

export const TW_PER_MM = 1440 / 25.4;

export function mmToTw(mm: number): number {
  return Math.round(mm * TW_PER_MM);
}

export function twToMm(tw: number): number {
  return tw / TW_PER_MM;
}

/** Panjang dalam titik kode (padanan `len()` Python). */
export function pyLen(s: string): number {
  return Array.from(s).length;
}

export function numTokens(s: string): string[] {
  return s.match(new RegExp(NUM_TOKEN_SOURCE, "g")) ?? [];
}

/**
 * Lantai lebar kolom agar token angka DATUM tampil satu baris (L-01):
 * advance mono 0,60 em per karakter + 2 mm.
 */
export function numFloorMm(tok: string, numeralsPt = DEFAULT_NUMERALS_PT): number {
  const emMm = (numeralsPt / 72.0) * 25.4;
  return pyLen(tok) * 0.6 * emMm + 2.0;
}

function firstMaxIndex(w: readonly number[]): number {
  let j = 0;
  for (let k = 1; k < w.length; k++) if (w[k] > w[j]) j = k;
  return j;
}

function sum(xs: readonly number[]): number {
  let s = 0;
  for (const x of xs) s += x;
  return s;
}

/**
 * Solver lantai (port persis `solve_widths(rows, total_mm)`): tiap kolom angka
 * bergrup titik >= `numFloorMm(token terpanjang)`, sisa dibagi berbobot
 * `max(panjang maks, 4)^0,8`, hasil dibulatkan 0,1 mm dan selisih ditaruh di
 * kolom terlebar. Jumlah kolom = panjang baris pertama (sel kurang dianggap "").
 */
export function solveWidthsImpl(rows: readonly (readonly string[])[], totalMm: number, numeralsPt = DEFAULT_NUMERALS_PT): number[] {
  if (rows.length === 0 || rows[0].length === 0) return [];
  const n = rows[0].length;
  const cell = (r: readonly string[], i: number): string => (i < r.length ? String(r[i]) : "");
  const maxlen: number[] = [];
  const colToks: string[][] = [];
  for (let i = 0; i < n; i++) {
    let m = 0;
    const toks: string[] = [];
    for (const r of rows) {
      const c = cell(r, i);
      m = Math.max(m, pyLen(c));
      toks.push(...numTokens(c));
    }
    maxlen.push(m);
    colToks.push(toks);
  }
  const floorOf = (i: number): number => {
    let need = 0;
    for (const t of colToks[i]) need = Math.max(need, numFloorMm(t, numeralsPt));
    return need;
  };
  let wmin = maxlen.map((m) => Math.max(6.0, (m / 3.0 - 8) / 2.05 + 0.2));
  for (let i = 0; i < n; i++) {
    if (colToks[i].length > 0) wmin[i] = Math.max(wmin[i], floorOf(i));
  }
  if (sum(wmin) > totalMm) {
    const f = totalMm / sum(wmin);
    wmin = wmin.map((w) => w * f);
  }
  const rem = totalMm - sum(wmin);
  const wt = maxlen.map((m) => Math.pow(Math.max(m, 4), 0.8));
  const s = sum(wt) || 1.0;
  let w = wmin.map((m, i) => m + (rem * wt[i]) / s);
  w = w.map((x) => pyRound(x, 1));
  const top = firstMaxIndex(w);
  w[top] += pyRound(totalMm - sum(w), 1);
  for (let pass = 0; pass < 6; pass++) {
    let deficit = false;
    for (let i = 0; i < n; i++) {
      const need = floorOf(i);
      if (need && w[i] + 1e-9 < need) {
        const j = firstMaxIndex(w);
        if (j === i || w[j] <= wmin[j] + 0.1) break;
        const mv = Math.min(0.5, w[j] - Math.max(wmin[j], w[i] + 0.5));
        if (mv <= 0) break;
        w[j] = pyRound(w[j] - mv, 1);
        w[i] = pyRound(w[i] + mv, 1);
        deficit = true;
      }
    }
    if (!deficit) break;
  }
  return w.map((x) => pyRound(x, 1));
}

/**
 * Bagi `totalTw` ke lebar twip per kolom dari lebar mm, jumlah dijaga persis
 * `totalTw` (selisih pembulatan ke kolom terlebar).
 */
export function mmWidthsToTw(widthsMm: readonly number[], totalTw: number): number[] {
  const tw = widthsMm.map((mm) => mmToTw(mm));
  if (tw.length === 0) return tw;
  const diff = totalTw - sum(tw);
  if (diff !== 0) tw[firstMaxIndex(tw)] += diff;
  return tw;
}
